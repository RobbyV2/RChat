use std::net::SocketAddr;
use std::path::{Path, PathBuf};

use axum::http::StatusCode;

use super::*;
use crate::api::test_util::{done, site_sets, temp_state, temp_state_env};

const INLINE: &str = "sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=";

/// A built site in a new folder: two pages, an asset, a 404 page and the script hashes.
fn site(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("rchat-docs-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    for (file, text) in [
        ("index.html", "<!doctype html><title>Start</title>"),
        (
            "guides/install/index.html",
            "<!doctype html><title>Install</title>",
        ),
        ("_astro/page.js", "export {}"),
        ("pagefind/pagefind.js", "export {}"),
        ("404.html", "<!doctype html><title>Missing</title>"),
        ("reference/index.html", "plain"),
        ("reference/index.html.gz", "packed"),
        (
            SCRIPT_HASHES,
            &format!("{INLINE}\nsha256-short=\n'; script-src *\n"),
        ),
    ] {
        let path = dir.join(file);
        std::fs::create_dir_all(path.parent().expect("parent")).expect("dir");
        std::fs::write(path, text).expect("write");
    }
    dir
}

async fn serve(router: Router) -> (String, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let base = format!("http://{}", listener.local_addr().expect("addr"));
    let server = tokio::spawn(async move {
        let _ = axum::serve(
            listener,
            router.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await;
    });
    (base, server)
}

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .expect("client")
}

fn header<'a>(res: &'a reqwest::Response, name: &str) -> &'a str {
    res.headers()
        .get(name)
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
}

async fn get(base: &str, path: &str) -> (StatusCode, String, reqwest::Response) {
    let res = client()
        .get(format!("{base}{path}"))
        .send()
        .await
        .expect("get");
    let status = res.status();
    let location = header(&res, "location").to_string();
    (status, location, res)
}

/// The answer to a GET of `target` exactly as written, without the client's normalization.
async fn raw(base: &str, target: &str) -> String {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let addr = base.trim_start_matches("http://");
    let mut socket = tokio::net::TcpStream::connect(addr).await.expect("connect");
    let request = format!("GET {target} HTTP/1.1\r\nHost: {addr}\r\nConnection: close\r\n\r\n");
    socket.write_all(request.as_bytes()).await.expect("write");
    let mut answer = String::new();
    socket.read_to_string(&mut answer).await.expect("read");
    answer
}

fn cleanup(dir: &Path) {
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn the_built_site_is_served_under_docs_with_its_policy() {
    let (state, path) = temp_state("docs_site").await;
    let dir = site("served");
    let (base, server) = serve(routes(dir.clone(), state.clone())).await;

    let (status, location, _) = get(&base, "/docs").await;
    assert_eq!(
        (status, location.as_str()),
        (StatusCode::PERMANENT_REDIRECT, "/docs/")
    );
    let (status, location, _) = get(&base, "/docs?q=x").await;
    assert_eq!(
        (status, location.as_str()),
        (StatusCode::PERMANENT_REDIRECT, "/docs/?q=x")
    );

    let (status, _, res) = get(&base, "/docs/").await;
    assert_eq!(status, StatusCode::OK);
    let policy = header(&res, "content-security-policy").to_string();
    assert_eq!(header(&res, "x-content-type-options"), "nosniff");
    assert_eq!(header(&res, "cache-control"), "no-cache");
    assert_eq!(
        res.text().await.expect("body"),
        "<!doctype html><title>Start</title>"
    );
    assert!(
        policy.contains(&format!("script-src 'self' 'wasm-unsafe-eval' '{INLINE}'")),
        "{policy}"
    );
    assert!(policy.contains("frame-ancestors 'none'"), "{policy}");
    assert!(policy.contains("connect-src 'self'"), "{policy}");
    assert!(!policy.contains("sha256-short"), "{policy}");
    assert!(!policy.contains("script-src *"), "{policy}");
    assert_eq!(policy.matches("script-src").count(), 1, "{policy}");

    let (status, location, _) = get(&base, "/docs/guides/install").await;
    assert!(status.is_redirection(), "{status}");
    assert_eq!(location, "/docs/guides/install/");
    let (status, _, res) = get(&base, "/docs/guides/install/").await;
    assert_eq!(status, StatusCode::OK);
    assert!(res.text().await.expect("body").contains("Install"));

    let (status, _, res) = get(&base, "/docs/_astro/page.js").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        header(&res, "cache-control"),
        "public, max-age=31536000, immutable"
    );
    assert_eq!(header(&res, "content-security-policy"), policy);

    let first = client()
        .get(format!("{base}/docs/"))
        .send()
        .await
        .expect("get");
    let etag = header(&first, "etag").to_string();
    assert!(!etag.is_empty());
    let again = client()
        .get(format!("{base}/docs/"))
        .header("if-none-match", &etag)
        .send()
        .await
        .expect("revalidate");
    assert_eq!(again.status(), StatusCode::NOT_MODIFIED);
    assert_eq!(
        header(&again, "content-security-policy"),
        policy,
        "a 304 keeps the scripts"
    );
    let (status, _, res) = get(&base, "/docs/pagefind/pagefind.js").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(header(&res, "cache-control"), "no-cache");

    for missing in [
        "/docs/nothing/",
        "/docs/guides/none.html",
        "/docs/_astro/gone.js",
    ] {
        let (status, _, res) = get(&base, missing).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{missing}");
        assert_eq!(header(&res, "cache-control"), "no-cache", "{missing}");
        assert_eq!(header(&res, "content-security-policy"), policy, "{missing}");
        assert!(
            res.text().await.expect("body").contains("Missing"),
            "{missing}"
        );
    }
    let asked = client()
        .get(format!("{base}/docs/nothing/"))
        .header("if-none-match", "*")
        .header("range", "bytes=0-0")
        .send()
        .await
        .expect("get");
    assert_eq!(asked.status(), StatusCode::NOT_FOUND);
    assert_eq!(header(&asked, "content-range"), "");
    assert!(asked.text().await.expect("body").contains("Missing"));

    let packed = client()
        .get(format!("{base}/docs/reference/"))
        .header("accept-encoding", "gzip")
        .send()
        .await
        .expect("get");
    assert_eq!(header(&packed, "content-encoding"), "gzip");
    assert_eq!(packed.text().await.expect("body"), "packed");
    let (_, _, plain) = get(&base, "/docs/reference/").await;
    assert_eq!(header(&plain, "content-encoding"), "");
    assert_eq!(plain.text().await.expect("body"), "plain");

    for (target, want) in [
        ("/docs/../Cargo.toml", "404 not found"),
        ("/docs/%2e%2e/Cargo.toml", "404 not found"),
        ("/docs/guides/..%2f..%2fCargo.toml", "404 not found"),
        (
            "http://elsewhere.example/docs/guides/install",
            "location: /docs/guides/install/",
        ),
    ] {
        let answer = raw(&base, target).await;
        assert!(
            answer.to_ascii_lowercase().contains(want),
            "{target}: {answer}"
        );
        assert!(!answer.contains("[package]"), "{target}");
        assert!(!answer.contains("elsewhere.example"), "{target}");
    }
    let head = client()
        .head(format!("{base}/docs/"))
        .send()
        .await
        .expect("head");
    assert_eq!(head.status(), StatusCode::OK);
    let post = client()
        .post(format!("{base}/docs/"))
        .send()
        .await
        .expect("post");
    assert_eq!(post.status(), StatusCode::METHOD_NOT_ALLOWED);

    server.abort();
    cleanup(&dir);
    done(state, path).await;
}

#[tokio::test]
async fn the_site_switch_turns_the_site_off_with_a_page_that_says_so() {
    let (state, path) = temp_state("docs_switch").await;
    assert!(Settings::cached(&state.db).await.docs, "on by default");
    let dir = site("switch");
    let (base, server) = serve(routes(dir.clone(), state.clone())).await;

    site_sets(&state, serde_json::json!({ "docs": false })).await;
    for asked in [
        "/docs",
        "/docs/",
        "/docs/guides/install/",
        "/docs/_astro/page.js",
    ] {
        let (status, _, res) = get(&base, asked).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{asked}");
        assert_eq!(header(&res, "content-type"), "text/html; charset=utf-8");
        let policy = header(&res, "content-security-policy").to_string();
        assert!(policy.starts_with("default-src 'none'"), "{policy}");
        let body = res.text().await.expect("body");
        assert!(
            body.contains("Documentation is turned off on this site."),
            "{body}"
        );
        assert!(!body.contains("Install"), "{body}");
    }

    site_sets(&state, serde_json::json!({ "docs": true })).await;
    let (status, _, _) = get(&base, "/docs/").await;
    assert_eq!(status, StatusCode::OK);

    server.abort();
    cleanup(&dir);
    done(state, path).await;
}

#[tokio::test]
async fn the_env_switch_seeds_the_site_off() {
    let (state, path) = temp_state_env("docs_env", &[("FEATURE_DOCS", "off")]).await;
    let settings = Settings::cached(&state.db).await;
    assert!(!settings.on(Feature::Docs));
    let dir = site("env");
    let docs = Docs::new(dir.clone(), state.clone());
    assert!(matches!(docs.open(&settings).await, Err(Closed::Off)));
    cleanup(&dir);
    done(state, path).await;
}

#[tokio::test]
async fn a_folder_without_a_build_answers_a_page_that_says_so() {
    let (state, path) = temp_state("docs_missing").await;
    let dir = std::env::temp_dir().join(format!("rchat-docs-none-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("guides")).expect("dir");
    std::fs::write(dir.join("guides/page.html"), "kept").expect("write");
    let (base, server) = serve(routes(dir.clone(), state.clone())).await;
    for asked in ["/docs/", "/docs/guides/page.html"] {
        let (status, _, res) = get(&base, asked).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{asked}");
        let body = res.text().await.expect("body");
        assert!(
            body.contains("This site has no documentation build."),
            "{body}"
        );
    }
    server.abort();
    let elsewhere = routes(PathBuf::from("/nonexistent/rchat-docs"), state.clone());
    let (base, server) = serve(elsewhere).await;
    let (status, _, res) = get(&base, "/docs/").await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert!(
        res.text()
            .await
            .expect("body")
            .contains("no documentation build")
    );
    server.abort();
    cleanup(&dir);
    done(state, path).await;
}

#[test]
fn only_listed_hashes_reach_the_policy() {
    assert!(is_hash(INLINE));
    for bad in [
        "sha256-short=",
        "sha384-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=",
        "sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSu'U=",
        "'unsafe-inline'",
        "",
    ] {
        assert!(!is_hash(bad), "{bad}");
    }
    assert_eq!(
        policy(&[INLINE.to_string()]),
        format!("{POLICY} '{INLINE}'")
    );
    assert_eq!(policy(&[]), POLICY);
    assert!(POLICY.ends_with("script-src 'self' 'wasm-unsafe-eval'"));
}
