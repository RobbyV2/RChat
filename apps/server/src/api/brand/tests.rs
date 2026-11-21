use std::net::SocketAddr;

use axum::Json;
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use serde_json::{Value, json};
use sqlx::Row;

use super::{
    Asset, IMAGE_MAX_BYTES, Link, Stored, Suggestion, SuggestionMode, Suggestions, check_image,
    clean_links, clean_suggestions, clean_text, delete_asset, etag_of, get_brand, parse_links,
    parse_suggestions, png_size, put_asset,
};
use crate::api::test_util::{done, each_db, mem_user, profanity_on, temp_state};
use crate::api::{ApiError, Authed, ReasonKind};
use crate::state::AppState;
use crate::ws::WsEvent;

/// The start of a PNG of `width` by `height` pixels, padded to `len` bytes.
pub(crate) fn png(width: u32, height: u32, len: usize) -> Vec<u8> {
    let mut bytes = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13];
    bytes.extend_from_slice(b"IHDR");
    bytes.extend_from_slice(&width.to_be_bytes());
    bytes.extend_from_slice(&height.to_be_bytes());
    bytes.extend_from_slice(&[8, 6, 0, 0, 0, 0, 0, 0, 0]);
    bytes.resize(bytes.len().max(len), 0);
    bytes
}

fn root() -> Authed {
    Authed(mem_user("root", true))
}

fn says(e: ApiError) -> (StatusCode, String) {
    let ApiError(status, error, _) = e;
    (status, error)
}

async fn count(state: &AppState, sql: &str) -> i64 {
    sqlx::query(sqlx::AssertSqlSafe(sql.to_string()))
        .fetch_one(&state.db)
        .await
        .expect(sql)
        .try_get(0)
        .expect("count")
}

async fn upload(
    state: &AppState,
    who: Authed,
    kind: &str,
    bytes: Vec<u8>,
) -> Result<Value, ApiError> {
    put_asset(
        State(state.clone()),
        who,
        Path(kind.to_string()),
        Bytes::from(bytes),
    )
    .await
    .map(|Json(brand)| serde_json::to_value(brand).expect("json"))
}

async fn patch(state: &AppState, body: Value) -> Result<(), ApiError> {
    let req = serde_json::from_value(body).expect("patch");
    crate::api::admin::patch_settings(State(state.clone()), root(), Json(req))
        .await
        .map(|_| ())
}

#[test]
fn only_a_png_of_the_right_size_is_an_image() {
    assert_eq!(png_size(&png(512, 512, 0)), Some((512, 512)));
    assert_eq!(png_size(&png(2048, 1024, 0)), Some((2048, 1024)));
    assert_eq!(
        png_size(b"\xff\xd8\xff\xe0\x00\x10JFIF\x00\x01"),
        None,
        "a JPEG"
    );
    assert_eq!(
        png_size(b"<svg xmlns=\"http://www.w3.org/2000/svg\"><script>alert(1)</script></svg>"),
        None,
        "an SVG"
    );
    assert_eq!(png_size(b"GIF89a\x01\x00\x01\x00"), None);
    assert_eq!(png_size(&png(512, 512, 0)[..20]), None, "cut short");
    let mut renamed = png(512, 512, 0);
    renamed[12..16].copy_from_slice(b"tEXt");
    assert_eq!(
        png_size(&renamed),
        None,
        "the first chunk is not the header"
    );
    assert_eq!(png_size(&[]), None);

    for (kind, width, height, fits) in [
        (Asset::Logo, 2048, 1024, true),
        (Asset::Logo, 1, 1, true),
        (Asset::Logo, 2049, 10, false),
        (Asset::Logo, 10, 1025, false),
        (Asset::Logo, 0, 10, false),
        (Asset::Mark32, 32, 32, true),
        (Asset::Mark32, 33, 32, false),
        (Asset::Mark180, 180, 180, true),
        (Asset::Mark192, 192, 192, true),
        (Asset::Mark192, 512, 512, false),
        (Asset::Mark512, 512, 512, true),
        (Asset::Mark512, 512, 511, false),
        (Asset::MarkMaskable, 512, 512, true),
        (Asset::MarkMaskable, 1024, 1024, false),
    ] {
        assert_eq!(kind.fits(width, height), fits, "{kind:?} {width}x{height}");
        assert_eq!(check_image(kind, &png(width, height, 0)).is_ok(), fits);
    }
    let Err(ApiError(status, error, reason)) =
        check_image(Asset::Logo, &png(10, 10, IMAGE_MAX_BYTES + 1))
    else {
        panic!("took an image over the cap");
    };
    assert_eq!(
        (status, error.as_str()),
        (StatusCode::PAYLOAD_TOO_LARGE, "The image is over 1 MiB")
    );
    assert_eq!(reason.expect("reason").kind, ReasonKind::Limit);
    assert!(check_image(Asset::Logo, &png(10, 10, IMAGE_MAX_BYTES)).is_ok());
    let wrong = check_image(Asset::Mark32, &png(64, 64, 0)).map_err(says);
    assert_eq!(
        wrong,
        Err((
            StatusCode::BAD_REQUEST,
            "The image must be 32 by 32 pixels".to_string()
        ))
    );
    let jpeg = check_image(Asset::Logo, b"\xff\xd8\xff\xe0").map_err(says);
    assert_eq!(
        jpeg,
        Err((
            StatusCode::BAD_REQUEST,
            "The image must be a PNG".to_string()
        ))
    );
    assert_eq!(Asset::parse("mark-maskable"), Some(Asset::MarkMaskable));
    assert_eq!(Asset::parse("logo.svg"), None);
    assert_eq!(Asset::parse("LOGO"), None);
    assert_eq!(etag_of(b"abc"), "ba7816bf8f01cfea");
}

#[test]
fn brand_texts_links_and_suggestions_are_bounded() {
    assert_eq!(
        clean_text("  Example Chat \r\n", 1, 64, false).as_deref(),
        Ok("Example Chat")
    );
    assert_eq!(clean_text("", 0, 64, false).as_deref(), Ok(""));
    assert_eq!(
        clean_text(" ", 1, 64, false),
        Err("expected 1 to 64 characters".to_string())
    );
    assert_eq!(
        clean_text(&"x".repeat(65), 0, 64, false),
        Err("expected up to 64 characters".to_string())
    );
    assert_eq!(
        clean_text(&"é".repeat(64), 1, 64, false).map(|s| s.chars().count()),
        Ok(64)
    );
    assert_eq!(
        clean_text("a\nb", 0, 64, false),
        Err("expected one line without control characters".to_string())
    );
    assert_eq!(clean_text("a\r\nb", 0, 64, true).as_deref(), Ok("a\nb"));
    assert!(clean_text("a\u{0}b", 0, 64, true).is_err());
    assert!(clean_text("a\u{1b}[0m", 0, 64, true).is_err());

    let link = |label: &str, url: &str| Link {
        label: label.to_string(),
        url: url.to_string(),
    };
    assert_eq!(
        clean_links(vec![link(" Help ", "https://help.example.com")]).as_deref(),
        Ok(r#"[{"label":"Help","url":"https://help.example.com/"}]"#)
    );
    assert_eq!(clean_links(Vec::new()).as_deref(), Ok("[]"));
    for bad in [
        vec![link("Help", "http://help.example.com")],
        vec![link("Help", "javascript:alert(1)")],
        vec![link("Help", "data:text/html,<script>alert(1)</script>")],
        vec![link("Help", "https://user:pw@example.com")],
        vec![link("Help", "/relative")],
        vec![link("", "https://example.com")],
        vec![link(&"x".repeat(33), "https://example.com")],
        vec![link(
            "Help",
            &format!("https://example.com/{}", "a".repeat(500)),
        )],
        vec![link("a", "https://a.example"); 5],
    ] {
        assert!(clean_links(bad.clone()).is_err(), "{bad:?}");
    }
    assert_eq!(parse_links(" ").as_deref(), Ok("[]"));
    assert!(parse_links("{\"label\":1}").is_err());
    assert!(parse_links(r#"[{"label":"Terms","url":"https://example.com/terms"}]"#).is_ok());

    let suggestion = |url: &str, label: &str| Suggestion {
        url: url.to_string(),
        label: label.to_string(),
    };
    let stored = clean_suggestions(Suggestions {
        mode: SuggestionMode::Replace,
        list: vec![
            suggestion("https://chat.example.com/some/path?x=1", "Example"),
            suggestion("https://CHAT.example.com", "Again"),
            suggestion("http://10.0.0.5:3000", ""),
        ],
    })
    .expect("suggestions");
    assert_eq!(
        stored,
        r#"{"mode":"replace","list":[{"url":"https://chat.example.com","label":"Example"},{"url":"http://10.0.0.5:3000","label":""}]}"#,
        "each address is kept as its origin, once"
    );
    assert_eq!(
        parse_suggestions("").as_deref(),
        Ok(r#"{"mode":"add","list":[]}"#)
    );
    assert!(parse_suggestions(r#"{"mode":"only"}"#).is_err());
    assert!(parse_suggestions(r#"{"list":[{"url":"ftp://example.com"}]}"#).is_err());
    assert!(
        clean_suggestions(Suggestions {
            mode: SuggestionMode::Add,
            list: vec![suggestion("https://a.example", ""); 21],
        })
        .is_err()
    );
    assert!(
        clean_suggestions(Suggestions {
            mode: SuggestionMode::Add,
            list: vec![suggestion("https://a.example", &"x".repeat(33))],
        })
        .is_err()
    );
}

#[test]
fn the_app_name_follows_the_instance_name_until_it_has_its_own() {
    let plain = Stored::default();
    assert!(!plain.is_set());
    assert_eq!((plain.app(), plain.short().as_str()), ("RChat", "RChat"));
    let named = Stored {
        instance_name: "A very long instance name".to_string(),
        ..Stored::default()
    };
    assert!(named.is_set());
    assert_eq!(named.app(), "A very long instance name");
    assert_eq!(named.short(), "A very long inst");
    let own = Stored {
        app_name: "Example Chat".to_string(),
        short_name: "Example".to_string(),
        ..named
    };
    let view = own.view();
    assert_eq!(
        (
            view.instance_name.as_str(),
            view.app_name.as_str(),
            view.short_name.as_str()
        ),
        ("A very long instance name", "Example Chat", "Example")
    );
    assert!(view.assets.is_empty());
}

#[tokio::test]
async fn the_brand_is_changed_by_the_admin_and_read_by_everyone() {
    for (state, db) in each_db("brand_store").await {
        let Json(before) = get_brand(State(state.clone())).await;
        assert_eq!(
            serde_json::to_value(&before).expect("json"),
            json!({
                "instance_name": "RChat", "app_name": "RChat", "short_name": "RChat", "about": "",
                "links": [], "login_note": "", "suggestions": {"mode": "add", "list": []}, "assets": {}
            })
        );
        let mut rx = state.hub.subscribe();
        patch(
            &state,
            json!({
                "instance_name": " Example Chat ",
                "app_short_name": "Example",
                "brand_about": "Run by the Example team.\r\nBe kind.",
                "brand_links": [{"label": "Help", "url": "https://help.example.com"}],
                "login_note": "Ask IT for an account.",
                "instance_suggestions": {"mode": "replace", "list": [{"url": "https://other.example.com/x", "label": "Other"}]},
            }),
        )
        .await
        .expect("patch");
        let mut announced = Vec::new();
        while let Ok(ev) = rx.try_recv() {
            if let WsEvent::BrandChanged { brand } = ev {
                announced.push(brand);
            }
        }
        assert_eq!(announced.len(), 1, "one event for the whole change");
        let Json(after) = get_brand(State(state.clone())).await;
        assert_eq!(announced[0], after);
        assert_eq!(
            serde_json::to_value(&after).expect("json"),
            json!({
                "instance_name": "Example Chat", "app_name": "Example Chat", "short_name": "Example",
                "about": "Run by the Example team.\nBe kind.",
                "links": [{"label": "Help", "url": "https://help.example.com/"}],
                "login_note": "Ask IT for an account.",
                "suggestions": {"mode": "replace", "list": [{"url": "https://other.example.com", "label": "Other"}]},
                "assets": {}
            })
        );
        let audit: Vec<(String, String, String)> =
            sqlx::query("SELECT action, target, detail FROM instance_audit ORDER BY target")
                .fetch_all(&state.db)
                .await
                .expect("audit")
                .iter()
                .map(|r| {
                    (
                        r.try_get(0).expect("action"),
                        r.try_get(1).expect("target"),
                        r.try_get(2).expect("detail"),
                    )
                })
                .collect();
        assert_eq!(
            audit
                .iter()
                .map(|(a, t, _)| (a.as_str(), t.as_str()))
                .collect::<Vec<_>>(),
            [
                ("branding.change", "app_short_name"),
                ("branding.change", "brand_about"),
                ("branding.change", "brand_links"),
                ("branding.change", "instance_name"),
                ("branding.change", "instance_suggestions"),
                ("branding.change", "login_note"),
            ]
        );
        assert!(
            audit
                .iter()
                .all(|(_, target, detail)| *detail == format!("{{\"key\":\"{target}\"}}")),
            "the log names the control, not its text: {audit:?}"
        );
        patch(
            &state,
            json!({"app_name": "Example App", "instance_name": "Example Chat"}),
        )
        .await
        .expect("app name");
        let Json(named) = get_brand(State(state.clone())).await;
        assert_eq!(
            (named.instance_name.as_str(), named.app_name.as_str()),
            ("Example Chat", "Example App")
        );
        assert_eq!(
            count(
                &state,
                "SELECT COUNT(*) FROM instance_audit WHERE target = 'instance_name'"
            )
            .await,
            1,
            "a value that stays is not a change"
        );

        let bad = |body: Value| {
            let state = state.clone();
            async move { patch(&state, body).await.map_err(says) }
        };
        let invalid = |msg: &str| Err((StatusCode::BAD_REQUEST, msg.to_string()));
        assert_eq!(
            bad(json!({"instance_name": " "})).await,
            invalid("instance_name: expected 1 to 64 characters")
        );
        assert_eq!(
            bad(json!({"app_name": "x".repeat(65)})).await,
            invalid("app_name: expected up to 64 characters")
        );
        assert_eq!(
            bad(json!({"app_short_name": "x".repeat(17)})).await,
            invalid("app_short_name: expected up to 16 characters")
        );
        assert_eq!(
            bad(json!({"brand_about": "x".repeat(1001)})).await,
            invalid("brand_about: expected up to 1000 characters")
        );
        assert_eq!(
            bad(json!({"login_note": "x".repeat(301)})).await,
            invalid("login_note: expected up to 300 characters")
        );
        assert_eq!(
            bad(json!({"app_name": "two\nlines"})).await,
            invalid("app_name: expected one line without control characters")
        );
        assert!(
            bad(json!({"brand_links": [{"label": "x", "url": "http://plain.example.com"}]}))
                .await
                .is_err()
        );
        assert!(
            bad(json!({"instance_suggestions": {"mode": "add", "list": [{"url": "nope"}]}}))
                .await
                .is_err()
        );
        profanity_on(&state.db).await;
        for body in [
            json!({"instance_name": "fuckface chat"}),
            json!({"brand_about": "run by fuckface"}),
            json!({"brand_links": [{"label": "fuckface", "url": "https://example.com"}]}),
            json!({"instance_suggestions": {"list": [{"url": "https://example.com", "label": "fuckface"}]}}),
        ] {
            assert_eq!(
                bad(body.clone()).await,
                invalid("Content blocked by profanity filter"),
                "{body}"
            );
        }
        let Json(kept) = get_brand(State(state.clone())).await;
        assert_eq!(kept, named, "a refused change changes nothing");
        let hidden = crate::api::admin::patch_settings(
            State(state.clone()),
            Authed(mem_user("bob", false)),
            Json(serde_json::from_value(json!({"instance_name": "Mine"})).expect("patch")),
        )
        .await
        .map(|_| ())
        .map_err(says);
        assert_eq!(
            hidden,
            Err((StatusCode::NOT_FOUND, "Not found".to_string()))
        );
        db.done(state).await;
    }
}

async fn serve(state: &AppState) -> SocketAddr {
    let config = crate::config::AppConfig::from_map(&[] as &[(&str, &str)]).expect("config");
    let app = crate::server::route_builder::resolve_versions(
        crate::server::route_builder::api_router(&config, state.clone()),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let addr = listener.local_addr().expect("addr");
    tokio::spawn(async move {
        let _ = axum::serve(
            listener,
            app.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await;
    });
    addr
}

#[tokio::test]
async fn brand_images_are_stored_once_per_kind_and_served_as_pngs() {
    for (state, db) in each_db("brand_images").await {
        let mut rx = state.hub.subscribe();
        let logo = png(600, 200, 4000);
        let brand = upload(&state, root(), "logo", logo.clone())
            .await
            .expect("logo");
        let version = etag_of(&logo);
        assert_eq!(
            brand["assets"],
            json!({"logo": format!("/brand/logo.png?v={version}")})
        );
        assert!(
            matches!(rx.try_recv(), Ok(WsEvent::BrandChanged { brand }) if brand.assets.len() == 1)
        );
        for (kind, side) in [
            ("mark-32", 32),
            ("mark-180", 180),
            ("mark-192", 192),
            ("mark-512", 512),
            ("mark-maskable", 512),
        ] {
            upload(&state, root(), kind, png(side, side, 100))
                .await
                .expect(kind);
        }
        let smaller = png(300, 100, 2000);
        upload(&state, root(), "logo", smaller.clone())
            .await
            .expect("replace");
        assert_eq!(
            count(&state, "SELECT COUNT(*) FROM brand_assets").await,
            6,
            "one row per kind, whatever is uploaded"
        );
        assert_eq!(
            count(&state, "SELECT COUNT(*) FROM instance_audit WHERE action = 'branding.change' AND actor = 'root' AND target = 'logo' AND detail = '{\"key\":\"logo\"}'").await,
            2
        );

        for (kind, bytes, status) in [
            (
                "logo",
                b"<svg xmlns=\"http://www.w3.org/2000/svg\" onload=\"alert(1)\"/>".to_vec(),
                StatusCode::BAD_REQUEST,
            ),
            (
                "logo",
                b"\xff\xd8\xff\xe0\x00\x10JFIF".to_vec(),
                StatusCode::BAD_REQUEST,
            ),
            ("logo", png(4000, 10, 0), StatusCode::BAD_REQUEST),
            ("mark-32", png(512, 512, 0), StatusCode::BAD_REQUEST),
            (
                "logo",
                png(10, 10, IMAGE_MAX_BYTES + 1),
                StatusCode::PAYLOAD_TOO_LARGE,
            ),
            ("banner", png(10, 10, 0), StatusCode::NOT_FOUND),
            ("logo.svg", png(10, 10, 0), StatusCode::NOT_FOUND),
        ] {
            let refused = upload(&state, root(), kind, bytes)
                .await
                .map_err(|e| says(e).0);
            assert_eq!(refused, Err(status), "{kind}");
        }
        let hidden = upload(
            &state,
            Authed(mem_user("bob", false)),
            "logo",
            png(10, 10, 0),
        )
        .await
        .map_err(says);
        assert_eq!(
            hidden,
            Err((StatusCode::NOT_FOUND, "Not found".to_string()))
        );
        let hidden = delete_asset(
            State(state.clone()),
            Authed(mem_user("bob", false)),
            Path("logo".to_string()),
        )
        .await
        .map(|_| ())
        .map_err(says);
        assert_eq!(
            hidden,
            Err((StatusCode::NOT_FOUND, "Not found".to_string()))
        );
        assert_eq!(count(&state, "SELECT COUNT(*) FROM brand_assets").await, 6);

        let addr = serve(&state).await;
        let client = reqwest::Client::new();
        let version = etag_of(&smaller);
        let res = client
            .get(format!("http://{addr}/brand/logo.png?v={version}"))
            .send()
            .await
            .expect("logo");
        assert_eq!(res.status(), StatusCode::OK);
        let header = |res: &reqwest::Response, name: &str| {
            res.headers()
                .get(name)
                .and_then(|v| v.to_str().ok())
                .map(str::to_string)
        };
        assert_eq!(header(&res, "content-type").as_deref(), Some("image/png"));
        assert_eq!(
            header(&res, "x-content-type-options").as_deref(),
            Some("nosniff")
        );
        assert_eq!(
            header(&res, "cache-control").as_deref(),
            Some("public, max-age=31536000, immutable")
        );
        assert_eq!(header(&res, "etag"), Some(format!("\"{version}\"")));
        assert_eq!(res.bytes().await.expect("bytes").to_vec(), smaller);
        for stale in ["/brand/logo.png", "/brand/logo.png?v=0000000000000000"] {
            let res = client
                .get(format!("http://{addr}{stale}"))
                .send()
                .await
                .expect("stale");
            assert_eq!(res.status(), StatusCode::OK);
            assert_eq!(
                header(&res, "cache-control").as_deref(),
                Some("no-cache"),
                "{stale}"
            );
            assert_eq!(header(&res, "content-type").as_deref(), Some("image/png"));
        }
        for missing in [
            "/brand/banner.png",
            "/brand/logo.svg",
            "/brand/logo",
            "/brand/mark-32.png.html",
        ] {
            let res = client
                .get(format!("http://{addr}{missing}"))
                .send()
                .await
                .expect("missing");
            assert_eq!(res.status(), StatusCode::NOT_FOUND, "{missing}");
        }
        let res = client
            .get(format!("http://{addr}/api/v1/brand"))
            .send()
            .await
            .expect("brand");
        assert_eq!(res.status(), StatusCode::OK, "no sign-in needed");
        let public: Value = serde_json::from_str(&res.text().await.expect("body")).expect("json");
        assert_eq!(public["assets"].as_object().expect("assets").len(), 6);
        let res = client
            .get(format!("http://{addr}/api/v1/instance"))
            .send()
            .await
            .expect("instance");
        let info: Value = serde_json::from_str(&res.text().await.expect("body")).expect("json");
        let mark = info["mark_url"].as_str().expect("mark_url");
        assert!(
            mark.starts_with("http://") && mark.contains("/brand/mark-192.png?v="),
            "{mark}"
        );
        assert_eq!(
            client.get(mark).send().await.expect("mark").status(),
            StatusCode::OK
        );

        let _ = delete_asset(State(state.clone()), root(), Path("logo".to_string()))
            .await
            .expect("delete");
        let _ = delete_asset(State(state.clone()), root(), Path("logo".to_string()))
            .await
            .expect("delete again");
        assert_eq!(
            count(
                &state,
                "SELECT COUNT(*) FROM brand_assets WHERE kind = 'logo'"
            )
            .await,
            0
        );
        assert_eq!(
            count(&state, "SELECT COUNT(*) FROM instance_audit WHERE action = 'branding.change' AND target = 'logo'").await,
            3,
            "removing what is not there is not logged"
        );
        let Json(brand) = get_brand(State(state.clone())).await;
        assert!(!brand.assets.contains_key("logo"));
        let res = client
            .get(format!("http://{addr}/brand/logo.png?v={version}"))
            .send()
            .await
            .expect("gone");
        assert_eq!(res.status(), StatusCode::NOT_FOUND);
        db.done(state).await;
    }
}

#[tokio::test]
async fn the_instance_document_names_the_instance_as_it_is_now() {
    let (state, path) = temp_state("brand_live_name").await;
    let addr = serve(&state).await;
    let client = reqwest::Client::new();
    let name = || async {
        let res = client
            .get(format!("http://{addr}/.well-known/rchat"))
            .send()
            .await
            .expect("discovery");
        let info: Value = serde_json::from_str(&res.text().await.expect("body")).expect("json");
        (
            info["name"].as_str().expect("name").to_string(),
            info.get("mark_url").cloned(),
        )
    };
    assert_eq!(name().await, ("RChat".to_string(), None));
    patch(&state, json!({"instance_name": "Example Chat"}))
        .await
        .expect("rename");
    assert_eq!(
        name().await,
        ("Example Chat".to_string(), None),
        "without a restart"
    );
    done(state, path).await;
}
