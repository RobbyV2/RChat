use axum::body::to_bytes;
use axum::extract::{Query, State};
use axum::response::IntoResponse;

use super::*;
use crate::api::preview_images::fake::{response, upstream};
use crate::api::test_util::{done, mem_user, temp_state};
use serde_json::json;

const KLIPY: &str = r#"{"results":[{"id":"7","title":"","content_description":"A cat waves","media_formats":{"gif":{"url":"https://static.example/7.gif","dims":[480,360]},"tinygif":{"url":"https://static.example/7s.gif","dims":[220,165]}}},{"id":8,"title":"No file","media_formats":{}},{"id":"9","title":"Not a web link","media_formats":{"gif":{"url":"javascript:alert(1)","dims":[1,1]}}}],"next":"24"}"#;

const GIPHY: &str = r#"{"data":[{"id":"ab","title":"Dance","images":{"original":{"url":"https://media.example/ab.gif","width":"500","height":"400"},"fixed_width":{"url":"https://media.example/ab_s.gif","width":"200","height":"160"}}}],"pagination":{"offset":0,"count":1,"total_count":3}}"#;

fn query<T: serde::de::DeserializeOwned>(pairs: serde_json::Value) -> Query<T> {
    Query(serde_json::from_value(pairs).expect("query"))
}

async fn switch(state: &AppState, on: bool) {
    sqlx::query("INSERT INTO settings(key, value) VALUES('gifs', $1) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .bind(if on { "1" } else { "0" })
        .execute(&state.db)
        .await
        .expect("switch");
    Settings::forget(&state.db);
}

#[test]
fn provider_answers_become_pages_with_signed_previews() {
    let pepper = b"pepper";
    let page = page_of(Provider::Klipy, pepper, KLIPY.as_bytes()).expect("klipy");
    assert_eq!(page.next.as_deref(), Some("24"));
    assert_eq!(
        page.items.len(),
        1,
        "items without a usable file are left out"
    );
    let gif = &page.items[0];
    assert_eq!(
        (
            gif.id.as_str(),
            gif.title.as_str(),
            gif.url.as_str(),
            gif.width,
            gif.height
        ),
        ("7", "A cat waves", "https://static.example/7.gif", 220, 165)
    );
    let preview = Url::parse(&format!("http://x{}", gif.preview)).expect("preview");
    let pairs: std::collections::HashMap<_, _> = preview.query_pairs().into_owned().collect();
    assert_eq!(pairs["u"], "https://static.example/7s.gif");
    assert_eq!(pairs["s"], sign(pepper, "https://static.example/7s.gif"));
    let page = page_of(Provider::Giphy, pepper, GIPHY.as_bytes()).expect("giphy");
    assert_eq!(page.next.as_deref(), Some("1"));
    assert_eq!(page.items[0].url, "https://media.example/ab.gif");
    assert_eq!((page.items[0].width, page.items[0].height), (200, 160));
    assert!(page_of(Provider::Giphy, pepper, b"<html>").is_err());
}

#[test]
fn requests_carry_the_key_rating_and_place_only() {
    let config = GifConfig::new(Provider::Klipy, "k1".into(), "pg".into());
    let url = request(&config, Some("cat waves"), Some("24")).expect("url");
    assert_eq!(url.path(), "/v2/search");
    let pairs: Vec<(String, String)> = url.query_pairs().into_owned().collect();
    for (k, v) in [
        ("key", "k1"),
        ("q", "cat waves"),
        ("pos", "24"),
        ("contentfilter", "medium"),
    ] {
        assert!(pairs.contains(&(k.into(), v.into())), "{k}");
    }
    let config = GifConfig::new(Provider::Giphy, "k2".into(), "pg-13".into());
    let url = request(&config, None, Some("x")).expect("url");
    assert_eq!(url.path(), "/v1/gifs/trending");
    assert!(
        !url.query().unwrap_or("").contains("offset"),
        "a bad offset is dropped"
    );
}

#[tokio::test]
async fn searches_go_through_this_server_and_files_need_their_signature() {
    let (state, path) = temp_state("gifs").await;
    let alice = || Authed(mem_user("alice", false));
    let api = upstream(response(
        "200 OK",
        &[("content-type", "application/json".to_string())],
        KLIPY.as_bytes(),
    ))
    .await;
    configure(Some(
        GifConfig::new(Provider::Klipy, "key".into(), "pg-13".into())
            .at(&api.url(""), api.policy()),
    ));
    let off = search_gifs(State(state.clone()), alice(), query(json!({"q": "cat"}))).await;
    assert_eq!(
        off.err().map(|e| (e.0.as_u16(), e.1)),
        Some((404, "GIFs are turned off on this site".to_string()))
    );
    switch(&state, true).await;
    let blank = search_gifs(State(state.clone()), alice(), query(json!({"q": "  "}))).await;
    assert_eq!(blank.err().map(|e| e.0.as_u16()), Some(400));
    let found = search_gifs(State(state.clone()), alice(), query(json!({"q": "cat"})))
        .await
        .unwrap_or_else(|e| panic!("search: {}", e.1))
        .0;
    assert_eq!(found.items.len(), 1);
    assert_eq!(api.hits(), 1);
    let trending = trending_gifs(State(state.clone()), alice(), query(json!({})))
        .await
        .expect("trending")
        .0;
    assert_eq!(trending.items.len(), 1);

    let forged = gif_file(
        State(state.clone()),
        query(json!({"u": "http://127.0.0.1:1/private", "s": "00"})),
    )
    .await
    .map(IntoResponse::into_response);
    assert_eq!(
        forged.err().map(|e| e.0.as_u16()),
        Some(404),
        "a signature that does not match"
    );

    let gif = b"GIF89a\x01\x00\x01\x00\x80\x00\x00\x00\x00\x00\xff\xff\xff!\xf9\x04\x01\x00\x00\x00\x00,\x00\x00\x00\x00\x01\x00\x01\x00\x00\x02\x02D\x01\x00;";
    let file = upstream(response(
        "200 OK",
        &[("content-type", "image/gif".to_string())],
        gif,
    ))
    .await;
    configure(Some(
        GifConfig::new(Provider::Klipy, "key".into(), "pg-13".into())
            .at(&api.url(""), file.policy()),
    ));
    let pepper = crate::db::pepper(&state.db).await.expect("pepper");
    let at = file.url("/f.gif");
    let served = gif_file(
        State(state.clone()),
        query(json!({"u": at, "s": sign(&pepper, &at)})),
    )
    .await
    .unwrap_or_else(|e| panic!("file: {}", e.1));
    assert_eq!(served.headers()[header::CONTENT_TYPE], "image/gif");
    let body = to_bytes(served.into_body(), usize::MAX)
        .await
        .expect("body");
    assert_eq!(&body[..], &gif[..]);
    switch(&state, false).await;
    configure(None);
    done(state, path).await;
}
