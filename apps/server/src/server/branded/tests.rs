use std::net::SocketAddr;
use std::sync::Arc;

use axum::Router;
use axum::http::{HeaderMap, StatusCode, header};
use axum::routing::get;
use serde_json::{Value, json};

use super::{escape_html, manifest, retitled_html};
use crate::api::brand::Stored;
use crate::api::test_util::{done, temp_state};
use crate::config::AppConfig;
use crate::server::route_builder::{Frontend, register_routes};
use crate::state::AppState;

const PAGE: &str = "<!DOCTYPE html><html><head><meta charSet=\"utf-8\"/><title>RChat</title><meta name=\"apple-mobile-web-app-title\" content=\"RChat\"/><link rel=\"manifest\" href=\"/manifest.webmanifest\"/></head><body><p>RChat</p><script>self.__next_f.push([1,\"<title>RChat</title>\"])</script></body></html>";
const GZIPPED: [u8; 12] = [0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 3, 0xff, 0x00];

/// A stand-in for the web app's own server.
async fn frontend() -> String {
    let page = |headers: HeaderMap| async move {
        let encoding = headers
            .get(header::ACCEPT_ENCODING)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("none")
            .to_string();
        let conditional = headers.contains_key(header::IF_NONE_MATCH);
        (
            [
                (header::CONTENT_TYPE, "text/html; charset=utf-8".to_string()),
                (header::ETAG, "\"built\"".to_string()),
                (
                    header::HeaderName::from_static("x-asked-encoding"),
                    encoding,
                ),
                (
                    header::HeaderName::from_static("x-asked-conditional"),
                    conditional.to_string(),
                ),
            ],
            PAGE,
        )
    };
    let app = Router::new()
        .route("/", get(page))
        .route("/login/", get(page))
        .route(
            "/packed/",
            get(|| async {
                (
                    [
                        (header::CONTENT_TYPE, "text/html; charset=utf-8"),
                        (header::CONTENT_ENCODING, "gzip"),
                    ],
                    GZIPPED.to_vec(),
                )
            }),
        )
        .route(
            "/app.js",
            get(|| async { ([(header::CONTENT_TYPE, "text/javascript")], PAGE) }),
        )
        .route(
            "/manifest.webmanifest",
            get(|| async {
                (
                    [(header::CONTENT_TYPE, "application/manifest+json")],
                    "{\"name\":\"RChat\"}",
                )
            }),
        )
        .route(
            "/streamed/",
            get(|| async {
                let (head, tail) = PAGE.split_at(40);
                let parts = [head, tail].map(|part| Ok::<_, std::io::Error>(part.to_string()));
                (
                    [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
                    axum::body::Body::from_stream(futures_util::stream::iter(parts)),
                )
            }),
        )
        .route("/favicon.ico", get(|| async { "built-ico" }))
        .route("/rchat_r.png", get(|| async { "built-r" }))
        .route("/icons/icon_192.png", get(|| async { "built-192" }))
        .route("/icons/icon_512.png", get(|| async { "built-512" }))
        .route(
            "/missing/",
            get(|| async {
                (
                    StatusCode::NOT_FOUND,
                    [(header::CONTENT_TYPE, "text/html")],
                    PAGE,
                )
            }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let url = format!("http://{}", listener.local_addr().expect("addr"));
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    url
}

async fn serve(state: &AppState, frontend: &str) -> String {
    let app = register_routes(
        Some(Frontend::Proxy(Arc::from(frontend))),
        None,
        &AppConfig::defaults(),
        state.clone(),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let base = format!("http://{}", listener.local_addr().expect("addr"));
    tokio::spawn(async move {
        let _ = axum::serve(
            listener,
            app.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await;
    });
    base
}

struct Answer {
    status: StatusCode,
    headers: HeaderMap,
    body: Vec<u8>,
}

impl Answer {
    fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).to_string()
    }

    fn header(&self, name: &str) -> Option<&str> {
        self.headers.get(name).and_then(|v| v.to_str().ok())
    }
}

/// What `base` answers a browser that asks for `path` as a page.
async fn page(base: &str, path: &str) -> Answer {
    let res = reqwest::Client::new()
        .get(format!("{base}{path}"))
        .header("accept", "text/html,application/xhtml+xml")
        .header("accept-encoding", "gzip, br")
        .header("if-none-match", "\"built\"")
        .send()
        .await
        .expect("request");
    Answer {
        status: res.status(),
        headers: res.headers().clone(),
        body: res.bytes().await.expect("body").to_vec(),
    }
}

async fn set(state: &AppState, key: &str, value: &str) {
    sqlx::query("INSERT INTO settings(key, value) VALUES($1, $2) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .bind(key)
        .bind(value)
        .execute(&state.db)
        .await
        .expect("setting");
    crate::api::policy::Policy::forget(&state.db);
}

async fn image(state: &AppState, kind: &str, bytes: &[u8]) {
    sqlx::query("INSERT INTO brand_assets(kind, bytes, etag, updated_at) VALUES($1, $2, $3, 1)")
        .bind(kind)
        .bind(bytes.to_vec())
        .bind(crate::api::brand::etag_of(bytes))
        .execute(&state.db)
        .await
        .expect("image");
    crate::api::policy::Policy::forget(&state.db);
}

const PATHS: [&str; 10] = [
    "/",
    "/login/",
    "/streamed/",
    "/packed/",
    "/app.js",
    "/manifest.webmanifest",
    "/favicon.ico",
    "/rchat_r.png",
    "/icons/icon_192.png",
    "/missing/",
];

#[tokio::test]
async fn an_instance_without_a_brand_serves_the_web_app_as_it_is() {
    let (state, path) = temp_state("branded_plain").await;
    let frontend = frontend().await;
    let base = serve(&state, &frontend).await;
    for target in PATHS {
        let direct = page(&frontend, target).await;
        let through = page(&base, target).await;
        assert_eq!(through.status, direct.status, "{target}");
        assert_eq!(through.body, direct.body, "{target}: the same bytes");
        for name in [
            "content-type",
            "content-encoding",
            "etag",
            "x-asked-encoding",
            "x-asked-conditional",
        ] {
            assert_eq!(through.header(name), direct.header(name), "{target} {name}");
        }
    }
    let home = page(&base, "/").await;
    assert_eq!(home.header("x-asked-encoding"), Some("gzip, br"));
    assert_eq!(home.header("x-asked-conditional"), Some("true"));
    done(state, path).await;
}

#[tokio::test]
async fn a_brand_names_the_pages_and_serves_its_manifest_and_mark() {
    let (state, path) = temp_state("branded_pages").await;
    let frontend = frontend().await;
    let base = serve(&state, &frontend).await;
    set(&state, "instance_name", "Tom & <Jerry> \"chat\"").await;
    let home = page(&base, "/").await;
    assert_eq!(home.status, StatusCode::OK);
    let name = "Tom &amp; &lt;Jerry&gt; &quot;chat&quot;";
    assert_eq!(
        home.text(),
        PAGE.replacen("<title>RChat</title>", &format!("<title>{name}</title>"), 1)
            .replacen("content=\"RChat\"", &format!("content=\"{name}\""), 1),
        "only the two titles change, and the name can not add markup"
    );
    assert!(home.text().contains("<p>RChat</p>"));
    assert!(
        home.text()
            .contains("self.__next_f.push([1,\"<title>RChat</title>\"])")
    );
    assert_eq!(
        home.header("content-length"),
        Some(home.body.len().to_string().as_str())
    );
    assert_eq!(
        home.header("etag"),
        None,
        "the changed page is not the built one"
    );
    assert_eq!(
        home.header("x-asked-encoding"),
        Some("none"),
        "asked for a plain body"
    );
    assert_eq!(home.header("x-asked-conditional"), Some("false"));
    assert!(
        page(&base, "/login/")
            .await
            .text()
            .contains(&format!("<title>{name}</title>"))
    );

    let streamed = page(&base, "/streamed/").await;
    assert_eq!(streamed.status, StatusCode::OK);
    assert_eq!(
        streamed.text(),
        home.text(),
        "a page the frontend sends in pieces is changed the same way"
    );
    assert_eq!(
        streamed.header("content-length"),
        Some(streamed.body.len().to_string().as_str())
    );
    assert_eq!(streamed.header("transfer-encoding"), None);
    let packed = page(&base, "/packed/").await;
    assert_eq!(packed.body, GZIPPED, "an encoded body passes untouched");
    assert_eq!(packed.header("content-encoding"), Some("gzip"));
    assert_eq!(
        page(&base, "/app.js").await.text(),
        PAGE,
        "only pages are changed"
    );
    let missing = page(&base, "/missing/").await;
    assert_eq!(
        (missing.status, missing.text().as_str()),
        (StatusCode::NOT_FOUND, PAGE)
    );
    let script = reqwest::Client::new()
        .get(format!("{base}/"))
        .header("accept", "*/*")
        .header("accept-encoding", "gzip")
        .send()
        .await
        .expect("fetch");
    assert_eq!(
        script
            .headers()
            .get("x-asked-encoding")
            .and_then(|v| v.to_str().ok()),
        Some("gzip"),
        "a request that is not for a page keeps its encodings"
    );

    let shown = page(&base, "/manifest.webmanifest").await;
    assert_eq!(
        shown.header("content-type"),
        Some("application/manifest+json")
    );
    assert_eq!(shown.header("cache-control"), Some("no-cache"));
    assert_eq!(
        serde_json::from_slice::<Value>(&shown.body).expect("manifest"),
        json!({
            "name": "Tom & <Jerry> \"chat\"",
            "short_name": "Tom & <Jerry> \"c",
            "share_target": {
                "action": "/share-target/",
                "method": "POST",
                "enctype": "multipart/form-data",
                "params": {"title": "title", "text": "text", "url": "url",
                           "files": [{"name": "files", "accept": ["*/*"]}]}
            },
            "start_url": "/",
            "display": "standalone",
            "theme_color": "#141218",
            "background_color": "#141218",
            "icons": [
                {"src": "/icons/icon_192.png", "sizes": "192x192", "type": "image/png", "purpose": "any"},
                {"src": "/icons/icon_512.png", "sizes": "512x512", "type": "image/png", "purpose": "any"},
                {"src": "/icons/icon_maskable_512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable"},
            ],
        })
    );
    for (target, built) in [
        ("/favicon.ico", "built-ico"),
        ("/rchat_r.png", "built-r"),
        ("/icons/icon_192.png", "built-192"),
    ] {
        assert_eq!(
            page(&base, target).await.text(),
            built,
            "{target}: no mark uploaded"
        );
    }

    image(&state, "mark-32", b"mark32").await;
    image(&state, "mark-192", b"mark192").await;
    for (target, mark) in [
        ("/favicon.ico", "mark32"),
        ("/rchat_r.png", "mark192"),
        ("/icons/icon_192.png", "mark192"),
    ] {
        let icon = page(&base, target).await;
        assert_eq!(icon.text(), mark, "{target}");
        assert_eq!(icon.header("content-type"), Some("image/png"));
        assert_eq!(icon.header("x-content-type-options"), Some("nosniff"));
        assert_eq!(icon.header("cache-control"), Some("no-cache"));
    }
    assert_eq!(
        page(&base, "/icons/icon_512.png").await.text(),
        "built-512",
        "a size that was not uploaded"
    );
    let shown = page(&base, "/manifest.webmanifest").await;
    let shown: Value = serde_json::from_slice(&shown.body).expect("manifest");
    assert_eq!(
        shown["icons"][0]["src"],
        format!(
            "/brand/mark-192.png?v={}",
            crate::api::brand::etag_of(b"mark192")
        )
    );
    assert_eq!(shown["icons"][1]["src"], "/icons/icon_512.png");

    set(&state, "instance_name", "RChat").await;
    let home = page(&base, "/").await;
    assert_eq!(home.text(), PAGE, "a mark alone leaves the titles");
    assert_eq!(home.header("x-asked-encoding"), Some("gzip, br"));
    assert_eq!(page(&base, "/favicon.ico").await.text(), "mark32");
    done(state, path).await;
}

#[test]
fn names_are_escaped_and_the_manifest_takes_the_brand() {
    assert_eq!(escape_html("a<b>&\"c'"), "a&lt;b&gt;&amp;&quot;c&#x27;");
    assert_eq!(escape_html("Example Chat"), "Example Chat");
    assert_eq!(retitled_html("<p>no titles</p>", "X"), None);
    assert_eq!(
        retitled_html(
            "<title>RChat</title><title>RChat</title>",
            "</title><script>"
        )
        .as_deref(),
        Some("<title>&lt;/title&gt;&lt;script&gt;</title><title>RChat</title>")
    );
    let brand = Stored {
        instance_name: "Example Chat".to_string(),
        short_name: "Example".to_string(),
        about: "Run by the Example team.\nBe kind.".to_string(),
        ..Stored::default()
    };
    let shown = manifest(&brand);
    assert_eq!(
        (&shown["name"], &shown["short_name"], &shown["description"]),
        (
            &json!("Example Chat"),
            &json!("Example"),
            &json!("Run by the Example team.")
        )
    );
    assert!(manifest(&Stored::default()).get("description").is_none());
}

#[tokio::test]
async fn a_large_streamed_page_passes_through_in_full() {
    use axum::body::{Body, Bytes, to_bytes};
    use axum::response::Response;
    let chunks = [
        Bytes::from_static(PAGE.as_bytes()),
        Bytes::from(vec![b'x'; super::PAGE_MAX]),
        Bytes::from_static(b"end"),
    ];
    let expected = chunks.concat();
    let body = Body::from_stream(futures_util::stream::iter(
        chunks.map(Ok::<_, std::io::Error>),
    ));
    let res = Response::builder()
        .header(header::CONTENT_TYPE, "text/html")
        .header(header::ETAG, "\"source\"")
        .body(body)
        .unwrap();
    let res = super::retitled(res, "Example").await;
    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(res.headers()[header::ETAG], "\"source\"");
    assert_eq!(
        to_bytes(res.into_body(), expected.len())
            .await
            .unwrap()
            .as_ref(),
        expected
    );
}
