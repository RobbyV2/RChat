use axum::Json;
use axum::body::to_bytes;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use serde_json::json;
use sqlx::Row;

use super::super::s3_stub::Stub;
use super::super::{Charge, MEDIA_CHUNK, NEUTRAL_MIME, download_media, s3_key, save_within};
use super::{Place, sealed_key, sweep, upload_key};
use crate::api::messages::{send_channel_message, send_dm_message};
use crate::api::test_util::{add_member, each_db_keyed, mem_user};
use crate::api::{ApiError, Authed, Message};
use crate::crypt::media::{chunks, object_len};
use crate::db::{Db, now};
use crate::state::AppState;

const SIZES: [usize; 4] = [0, 1, MEDIA_CHUNK, MEDIA_CHUNK + 1];

fn bytes(n: usize) -> Vec<u8> {
    (0..n).map(|i| (i * 13 % 251) as u8).collect()
}

/// alice manages the default server, bob and carol are members; the id of its first channel.
async fn setup(db: &Db) -> i64 {
    for name in ["alice", "bob", "carol"] {
        crate::db::NewUser::plain(name).hash("x").add(db).await;
    }
    add_member(db, "rchat", "alice", 1, 0, 1).await;
    add_member(db, "rchat", "bob", 0, 0, 1).await;
    for name in ["alice", "bob"] {
        sqlx::query(
            "INSERT INTO tokens(token, username, created_at, last_used_at) VALUES($1, $2, $3, $3)",
        )
        .bind(crate::db::secret_key(&format!("token-{name}")))
        .bind(name)
        .bind(now())
        .execute(db)
        .await
        .expect("token");
    }
    sqlx::query_scalar("SELECT id FROM channels WHERE server = 'rchat' ORDER BY id LIMIT 1")
        .fetch_one(db)
        .await
        .expect("channel")
}

async fn switch(state: &AppState, on: bool) {
    crate::api::servers::update_server(
        State(state.clone()),
        Authed(mem_user("alice", false)),
        Path("rchat".to_string()),
        Json(serde_json::from_value(json!({"seal": on})).expect("patch")),
    )
    .await
    .map(|_| ())
    .expect("switch");
}

async fn key_for(state: &AppState, who: &str, place: Place) -> Result<bool, ApiError> {
    let user = crate::db::get_user(&state.db, who)
        .await
        .expect("load")
        .expect("user");
    upload_key(&state.db, &user, place)
        .await
        .map(|k| k.is_some())
}

async fn upload(state: &AppState, place: Option<Place>, name: &str, data: &[u8]) -> String {
    let user = crate::db::get_user(&state.db, "alice")
        .await
        .expect("load")
        .expect("alice");
    let key = match place {
        Some(place) => upload_key(&state.db, &user, place).await.expect("place"),
        None => None,
    };
    let charge = Charge::own("alice");
    save_within(
        state,
        name,
        "image/png",
        data,
        "alice",
        charge,
        0,
        key.as_ref(),
    )
    .await
    .expect("upload")
    .0
}

async fn post(state: &AppState, cid: i64, media: &str) -> Message {
    send_channel_message(
        State(state.clone()),
        Path(cid),
        Authed(mem_user("alice", false)),
        Json(serde_json::from_value(json!({"content": "", "media_id": media})).expect("request")),
    )
    .await
    .expect("send")
    .0
}

/// A download of file `id`: its content type, disposition, length and bytes (or why the body
/// stopped).
type Got = (String, String, Option<String>, Result<Vec<u8>, String>);

async fn download(state: &AppState, id: &str, token: Option<&str>) -> Result<Got, ApiError> {
    let mut headers = HeaderMap::new();
    if let Some(token) = token {
        let value = HeaderValue::from_str(&format!("Bearer {token}")).expect("header");
        headers.insert(header::AUTHORIZATION, value);
    }
    let res = download_media(
        State(state.clone()),
        axum::http::Method::GET,
        headers,
        Path(id.to_string()),
    )
    .await?;
    let read = |name| {
        res.headers()
            .get(name)
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned)
    };
    let kind = read(header::CONTENT_TYPE).unwrap_or_default();
    let disposition = read(header::CONTENT_DISPOSITION).unwrap_or_default();
    let length = read(header::CONTENT_LENGTH);
    let body = to_bytes(res.into_body(), usize::MAX)
        .await
        .map(|b| b.to_vec())
        .map_err(|e| e.to_string());
    Ok((kind, disposition, length, body))
}

/// The row of file `id`: its plain name, whether it is sealed (a key and a sealed name), and
/// its chunks in order.
async fn row(db: &Db, id: &str) -> (String, bool, Vec<Vec<u8>>) {
    let r = sqlx::query("SELECT filename, seal_key IS NOT NULL AND name_sealed IS NOT NULL FROM media WHERE id = $1")
        .bind(id)
        .fetch_one(db)
        .await
        .expect("row");
    let sealed = match crate::db::is_sqlite(db) {
        true => r.try_get::<i64, _>(1).expect("sealed") != 0,
        false => r.try_get::<bool, _>(1).expect("sealed"),
    };
    let parts: Vec<Vec<u8>> =
        sqlx::query_scalar("SELECT data FROM media_chunks WHERE media_id = $1 ORDER BY seq")
            .bind(id)
            .fetch_all(db)
            .await
            .expect("chunks");
    (r.try_get(0).expect("name"), sealed, parts)
}

async fn opens_as(state: &AppState, id: &str, data: &[u8]) {
    let (kind, disposition, length, body) = download(state, id, None).await.expect("download");
    assert_eq!(kind, "image/png", "the real type");
    assert!(disposition.contains("photo.png"), "{disposition}");
    assert_eq!(length, Some(data.len().to_string()));
    assert_eq!(body.expect("body"), data, "{} bytes", data.len());
}

#[test]
fn places_parse_strictly() {
    assert_eq!(Place::parse("c:12"), Some(Place::Channel(12)));
    assert_eq!(Place::parse("d:3"), Some(Place::Dm(3)));
    for bad in [
        "c:0",
        "c:-3",
        "c:",
        "x:1",
        "c12",
        "",
        "d:1.5",
        "c:99999999999999999999",
    ] {
        assert_eq!(Place::parse(bad), None, "{bad}");
    }
}

/// The placeholder columns of file `id`.
async fn plain_placeholder(db: &Db, id: &str) -> Option<(String, i64, i64)> {
    let (hash, w, h): (Option<String>, Option<i64>, Option<i64>) =
        sqlx::query_as("SELECT thumbhash, width, height FROM media WHERE id = $1")
            .bind(id)
            .fetch_one(db)
            .await
            .expect("row");
    Some((hash?, w?, h?))
}

#[tokio::test]
async fn an_image_keeps_its_placeholder_plain_or_sealed() {
    for (state, temp) in each_db_keyed("media_placeholders").await {
        let db = &state.db;
        let cid = setup(db).await;
        let image = rchat_avatar::samples::png(&rchat_avatar::samples::halves(120, 80));
        let plain = upload(&state, None, "cat.png", &image).await;
        let (hash, w, h) = plain_placeholder(db, &plain).await.expect("a placeholder");
        assert_eq!((w, h), (120, 80));
        assert!(rchat_avatar::placeholder_ok(&hash));
        let text = upload(&state, None, "notes.txt", b"just words").await;
        assert_eq!(
            plain_placeholder(db, &text).await,
            None,
            "only images have one"
        );

        let sent = post(&state, cid, &plain).await;
        let shown = sent.media.as_ref().and_then(|m| m.placeholder.clone());
        assert_eq!(
            shown
                .as_ref()
                .map(|p| (p.width, p.height, p.thumbhash.as_str())),
            Some((120, 80, hash.as_str())),
            "the message carries it"
        );

        switch(&state, true).await;
        let sealed = upload(&state, Some(Place::Channel(cid)), "cat.png", &image).await;
        assert_eq!(
            plain_placeholder(db, &sealed).await,
            None,
            "a sealed file keeps it in its sealed facts only"
        );
        let posted = post(&state, cid, &sealed).await;
        assert_eq!(
            posted.media.as_ref().and_then(|m| m.placeholder.clone()),
            shown,
            "opened from the facts"
        );
        let later = upload(&state, None, "cat.png", &image).await;
        assert!(plain_placeholder(db, &later).await.is_some());
        post(&state, cid, &later).await;
        assert_eq!(
            plain_placeholder(db, &later).await,
            None,
            "sealed on posting: the plain columns are blanked"
        );
        temp.done(state).await;
    }
}

#[tokio::test]
async fn files_follow_their_place_in_the_database() {
    for (state, temp) in each_db_keyed("media_sealed_db").await {
        let db = &state.db;
        let cid = setup(db).await;
        switch(&state, true).await;
        for size in SIZES {
            let data = bytes(size);
            let id = upload(&state, Some(Place::Channel(cid)), "photo.png", &data).await;
            let (name, sealed, parts) = row(db, &id).await;
            assert_eq!(
                (name.as_str(), sealed),
                ("", true),
                "{size}: sealed from the first byte"
            );
            assert_eq!(parts.len() as u64, chunks(size as u64));
            for (part, plain) in parts.iter().zip(data.chunks(MEDIA_CHUNK)) {
                assert_eq!(&part[..2], [0x52, 0x01]);
                assert_eq!(part.len(), plain.len() + crate::crypt::OVERHEAD);
            }
            post(&state, cid, &id).await;
            opens_as(&state, &id, &data).await;
        }

        let data = bytes(MEDIA_CHUNK + 1);
        let plain = upload(&state, None, "photo.png", &data).await;
        let (name, sealed, parts) = row(db, &plain).await;
        assert_eq!((name.as_str(), sealed), ("photo.png", false));
        assert_eq!(parts.concat(), data);
        let sent = post(&state, cid, &plain).await;
        assert_eq!(
            sent.media.as_ref().map(|m| m.filename.as_str()),
            Some("photo.png")
        );
        let (name, sealed, parts) = row(db, &plain).await;
        assert_eq!(
            (name.as_str(), sealed),
            ("", true),
            "sealed when it is posted in a place that seals"
        );
        assert!(parts.iter().all(|p| p[..2] == [0x52, 0x01]));
        opens_as(&state, &plain, &data).await;

        sqlx::query("UPDATE media_chunks SET seq = seq + 10 WHERE media_id = $1")
            .bind(&plain)
            .execute(db)
            .await
            .expect("move");
        sqlx::query(
            "UPDATE media_chunks SET seq = CASE seq WHEN 10 THEN 1 ELSE 0 END WHERE media_id = $1",
        )
        .bind(&plain)
        .execute(db)
        .await
        .expect("swap");
        let (_, _, _, body) = download(&state, &plain, None).await.expect("download");
        assert!(body.is_err(), "chunks in each other's places do not open");

        switch(&state, false).await;
        let later = upload(&state, Some(Place::Channel(cid)), "photo.png", &data).await;
        post(&state, cid, &later).await;
        let (name, sealed, parts) = row(db, &later).await;
        assert_eq!((name.as_str(), sealed), ("photo.png", false), "off: plain");
        assert_eq!(parts.concat(), data);
        opens_as(&state, &later, &data).await;
        temp.done(state).await;
    }
}

#[tokio::test]
async fn files_follow_their_place_in_s3() {
    for (state, temp) in each_db_keyed("media_sealed_s3").await {
        let (stub, bucket) = Stub::start().await;
        let mut state = state;
        state.s3 = Some(bucket);
        let db = &state.db;
        let cid = setup(db).await;
        switch(&state, true).await;
        for size in SIZES {
            let data = bytes(size);
            let id = upload(&state, Some(Place::Channel(cid)), "photo.png", &data).await;
            let (kind, object) = stub.object(&sealed_key(&id)).expect("sealed object");
            assert_eq!(kind, NEUTRAL_MIME, "{size}: stored as bytes of no type");
            assert_eq!(object.len() as u64, object_len(size as u64));
            assert_eq!(&object[..2], [0x52, 0x03]);
            assert!(stub.object(&s3_key(&id)).is_none(), "no plain object");
            assert!(row(db, &id).await.2.is_empty(), "no chunks in the database");
            post(&state, cid, &id).await;
            opens_as(&state, &id, &data).await;
        }

        let data = bytes(MEDIA_CHUNK + 1);
        let plain = upload(&state, None, "photo.png", &data).await;
        assert_eq!(
            stub.object(&s3_key(&plain)).map(|(kind, _)| kind),
            Some("image/png".to_string())
        );
        post(&state, cid, &plain).await;
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(10);
        while stub.object(&s3_key(&plain)).is_some() || !row(db, &plain).await.1 {
            assert!(
                tokio::time::Instant::now() < deadline,
                "a posted plain object is sealed in the background"
            );
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        assert!(stub.object(&sealed_key(&plain)).is_some());
        opens_as(&state, &plain, &data).await;

        let (kind, object) = stub.object(&sealed_key(&plain)).expect("object");
        stub.put(
            &sealed_key(&plain),
            (kind, object[..object.len() - 1].to_vec()),
        );
        let (_, _, _, body) = download(&state, &plain, None).await.expect("download");
        assert!(body.is_err(), "a cut object does not open");
        temp.done(state).await;
    }
}

/// The status, `Content-Range` and bytes of a download of `id` with `Range: <range>`.
async fn ranged(state: &AppState, id: &str, range: &str) -> (StatusCode, Option<String>, Vec<u8>) {
    let mut headers = HeaderMap::new();
    headers.insert(header::RANGE, HeaderValue::from_str(range).expect("range"));
    let res = download_media(
        State(state.clone()),
        axum::http::Method::GET,
        headers,
        Path(id.to_string()),
    )
    .await
    .expect("download");
    let status = res.status();
    let window = res
        .headers()
        .get(header::CONTENT_RANGE)
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned);
    let body = to_bytes(res.into_body(), usize::MAX).await.expect("body");
    (status, window, body.to_vec())
}

#[tokio::test]
async fn ranges_of_encrypted_files_are_cut_from_what_opens() {
    for (state, temp) in each_db_keyed("media_sealed_ranges").await {
        let (_stub, bucket) = Stub::start().await;
        let cid = setup(&state.db).await;
        switch(&state, true).await;
        let data = bytes(2 * MEDIA_CHUNK + 5);
        let size = data.len();
        let mut s3 = state.clone();
        s3.s3 = Some(bucket);
        for state in [&state, &s3] {
            let id = upload(state, Some(Place::Channel(cid)), "photo.png", &data).await;
            post(state, cid, &id).await;
            assert!(row(&state.db, &id).await.1, "stored encrypted");
            let edge = MEDIA_CHUNK - 3;
            for (range, from, to) in [
                ("bytes=0-9".to_string(), 0, 9),
                (format!("bytes={edge}-{}", edge + 5), edge, edge + 5),
                (
                    format!("bytes={}-", 2 * MEDIA_CHUNK),
                    2 * MEDIA_CHUNK,
                    size - 1,
                ),
                ("bytes=-4".to_string(), size - 4, size - 1),
            ] {
                let (status, window, body) = ranged(state, &id, &range).await;
                assert_eq!(status, StatusCode::PARTIAL_CONTENT, "{range}");
                assert_eq!(window, Some(format!("bytes {from}-{to}/{size}")), "{range}");
                assert_eq!(body, data[from..=to], "{range}");
            }
            let (status, window, body) = ranged(state, &id, &format!("bytes={size}-")).await;
            assert_eq!(status, StatusCode::RANGE_NOT_SATISFIABLE);
            assert_eq!(window, Some(format!("bytes */{size}")));
            assert!(body.is_empty());
            opens_as(state, &id, &data).await;
        }
        temp.done(state).await;
    }
}

#[tokio::test]
async fn files_of_a_dm_follow_the_dm() {
    for (state, temp) in each_db_keyed("media_sealed_dm").await {
        let db = &state.db;
        setup(db).await;
        let dm: i64 = sqlx::query_scalar(
            "INSERT INTO dms(user_a, user_b) VALUES('alice', 'bob') RETURNING id",
        )
        .fetch_one(db)
        .await
        .expect("dm");
        assert!(!key_for(&state, "alice", Place::Dm(dm)).await.expect("off"));
        crate::api::seal::put_dm_seal(
            State(state.clone()),
            Authed(mem_user("bob", false)),
            Path(dm),
            Json(crate::api::seal::SealReq { on: true }),
        )
        .await
        .map(|_| ())
        .expect("dm switch");
        assert!(key_for(&state, "alice", Place::Dm(dm)).await.expect("on"));
        assert_eq!(
            key_for(&state, "carol", Place::Dm(dm))
                .await
                .map_err(|e| e.0),
            Err(StatusCode::NOT_FOUND),
            "a DM someone is not in is not found"
        );
        let data = bytes(3);
        let id = upload(&state, Some(Place::Dm(dm)), "photo.png", &data).await;
        assert!(row(db, &id).await.1);
        send_dm_message(
            State(state.clone()),
            Path(dm),
            Authed(mem_user("alice", false)),
            Json(serde_json::from_value(json!({"content": "", "media_id": id})).expect("request")),
        )
        .await
        .map(|_| ())
        .expect("send");
        for token in ["token-alice", "token-bob"] {
            let (_, _, _, body) = download(&state, &id, Some(token)).await.expect("download");
            assert_eq!(body.expect("body"), data, "{token}");
        }
        temp.done(state).await;
    }
}

/// A plain message carrying `media`, as a copy of an older build stores it in a place that seals:
/// old enough for the sweep to take.
async fn plain_post(db: &Db, cid: i64, media: &str) -> i64 {
    sqlx::query_scalar("INSERT INTO messages(channel_id, author, content, media_id, media_filename, media_kind, created_at) VALUES($1, 'alice', 'from an older copy', $2, 'photo.png', 'server', $3) RETURNING id")
        .bind(cid)
        .bind(media)
        .bind(now() - 3600)
        .fetch_one(db)
        .await
        .expect("message")
}

#[tokio::test]
async fn an_older_copys_plain_file_is_sealed_with_its_message() {
    for (state, temp) in each_db_keyed("media_sealed_sweep").await {
        let db = &state.db;
        let cid = setup(db).await;
        let data = bytes(MEDIA_CHUNK + 1);
        let plain = upload(&state, None, "photo.png", &data).await;
        switch(&state, true).await;
        let id = plain_post(db, cid, &plain).await;
        assert!(!row(db, &plain).await.1);
        assert!(crate::api::seal::sweep(db).await.expect("sweep") >= 1);
        let sealed: Option<Vec<u8>> = sqlx::query_scalar("SELECT body FROM messages WHERE id = $1")
            .bind(id)
            .fetch_one(db)
            .await
            .expect("body");
        assert!(sealed.is_some(), "the message is sealed");
        assert!(row(db, &plain).await.1, "and its file with it");
        opens_as(&state, &plain, &data).await;
        temp.done(state).await;
    }
}

#[tokio::test]
async fn s3_files_marked_for_sealing_are_finished_by_the_sweep() {
    for (state, temp) in each_db_keyed("media_sealed_marks").await {
        let (stub, bucket) = Stub::start().await;
        let mut state = state;
        state.s3 = Some(bucket);
        let db = &state.db;
        setup(db).await;
        switch(&state, true).await;
        let data = bytes(MEDIA_CHUNK + 1);
        let plain = upload(&state, None, "photo.png", &data).await;
        let marked = |db: Db, id: String| async move {
            sqlx::query_scalar::<_, Option<i64>>("SELECT plain_object FROM media WHERE id = $1")
                .bind(id)
                .fetch_one(&db)
                .await
                .expect("mark")
                .is_some()
        };
        let mut tx = db.begin().await.expect("tx");
        let later = super::seal_file_on(db, &mut tx, &plain)
            .await
            .expect("mark");
        tx.commit().await.expect("commit");
        assert_eq!(
            later.as_deref(),
            Some(plain.as_str()),
            "kept in S3: marked, left for later"
        );
        assert!(marked(db.clone(), plain.clone()).await);
        assert!(!row(db, &plain).await.1);

        assert_eq!(
            sweep(&state).await.expect("sweep"),
            1,
            "the sweep seals what was left"
        );
        assert!(row(db, &plain).await.1);
        assert!(!marked(db.clone(), plain.clone()).await);
        assert!(stub.object(&s3_key(&plain)).is_none());
        let (_, _, _, body) = download(&state, &plain, Some("token-alice"))
            .await
            .expect("download");
        assert_eq!(body.expect("body"), data, "the uploader opens it");

        stub.put(&s3_key(&plain), ("image/png".to_string(), data.clone()));
        sqlx::query("UPDATE media SET plain_object = 1 WHERE id = $1")
            .bind(&plain)
            .execute(db)
            .await
            .expect("as a failed delete leaves it");
        assert_eq!(sweep(&state).await.expect("sweep"), 1);
        assert!(
            stub.object(&s3_key(&plain)).is_none(),
            "the plain object left is deleted"
        );
        assert!(!marked(db.clone(), plain.clone()).await);
        assert_eq!(sweep(&state).await.expect("again"), 0);
        temp.done(state).await;
    }
}

#[tokio::test]
async fn a_forward_into_an_encrypted_place_seals_its_file() {
    for (state, temp) in each_db_keyed("media_sealed_forward").await {
        let db = &state.db;
        let cid = setup(db).await;
        let dm: i64 = sqlx::query_scalar(
            "INSERT INTO dms(user_a, user_b) VALUES('alice', 'bob') RETURNING id",
        )
        .fetch_one(db)
        .await
        .expect("dm");
        let data = bytes(5);
        let file = upload(&state, None, "photo.png", &data).await;
        let first = send_dm_message(
            State(state.clone()),
            Path(dm),
            Authed(mem_user("alice", false)),
            Json(
                serde_json::from_value(json!({"content": "", "media_id": file})).expect("request"),
            ),
        )
        .await
        .expect("send")
        .0;
        assert!(!row(db, &file).await.1, "a plain DM keeps it plain");
        switch(&state, true).await;
        send_channel_message(
            State(state.clone()),
            Path(cid),
            Authed(mem_user("alice", false)),
            Json(
                serde_json::from_value(json!({"content": "", "forward_of": first.id}))
                    .expect("request"),
            ),
        )
        .await
        .map(|_| ())
        .expect("forward");
        assert!(
            row(db, &file).await.1,
            "forwarded into a place that seals: sealed"
        );
        let (_, _, _, body) = download(&state, &file, Some("token-bob"))
            .await
            .expect("download");
        assert_eq!(body.expect("body"), data, "and still opens in the DM");
        temp.done(state).await;
    }
}

#[tokio::test]
async fn an_older_inline_copy_is_sealed_at_send() {
    for (state, temp) in each_db_keyed("media_sealed_inline").await {
        let db = &state.db;
        let cid = setup(db).await;
        switch(&state, true).await;
        let data = bytes(7);
        sqlx::query("INSERT INTO media(id, filename, mime, size, data, uploader, uploaded_at) VALUES('00000000000000000000000000000001', 'photo.png', 'image/png', 7, $1, 'alice', $2)")
            .bind(&data)
            .bind(now())
            .execute(db)
            .await
            .expect("an inline copy");
        let id = "00000000000000000000000000000001";
        post(&state, cid, id).await;
        let (name, sealed, parts) = row(db, id).await;
        assert_eq!((name.as_str(), sealed, parts.len()), ("", true, 1));
        let inline: Option<Vec<u8>> = sqlx::query_scalar("SELECT data FROM media WHERE id = $1")
            .bind(id)
            .fetch_one(db)
            .await
            .expect("data");
        assert_eq!(inline, None, "no plain copy left inline");
        opens_as(&state, id, &data).await;
        temp.done(state).await;
    }
}

#[tokio::test]
async fn a_file_that_does_not_open_is_refused_or_cut() {
    for (state, temp) in each_db_keyed("media_sealed_broken").await {
        let db = &state.db;
        let cid = setup(db).await;
        switch(&state, true).await;
        assert_eq!(
            key_for(&state, "alice", Place::Channel(999_999))
                .await
                .map_err(|e| e.0),
            Err(StatusCode::NOT_FOUND),
            "a channel that is not there is not found"
        );
        let data = bytes(MEDIA_CHUNK + 1);
        let cut = upload(&state, Some(Place::Channel(cid)), "photo.png", &data).await;
        post(&state, cid, &cut).await;
        sqlx::query("DELETE FROM media_chunks WHERE media_id = $1 AND seq = 1")
            .bind(&cut)
            .execute(db)
            .await
            .expect("drop the last chunk");
        let (_, _, _, body) = download(&state, &cut, None).await.expect("download");
        assert!(body.is_err(), "a file missing its last chunk ends early");

        let lost = upload(&state, Some(Place::Channel(cid)), "photo.png", &data).await;
        post(&state, cid, &lost).await;
        sqlx::query("UPDATE media SET seal_key = 999999 WHERE id = $1")
            .bind(&lost)
            .execute(db)
            .await
            .expect("a key that is not held");
        assert_eq!(
            download(&state, &lost, None)
                .await
                .map(|_| ())
                .map_err(|e| (e.0, e.1)),
            Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                super::UNREADABLE.to_string()
            ))
        );
        temp.done(state).await;
    }
}
