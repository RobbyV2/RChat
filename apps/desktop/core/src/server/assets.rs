// The bundled web app, served by the app's own server to browsers. The files come through a
// resolver, so the shell can hand over its embedded ones.

use axum::Router;
use axum::body::Body;
use axum::http::header::{
    ALLOW, CACHE_CONTROL, CONTENT_SECURITY_POLICY, CONTENT_TYPE, REFERRER_POLICY,
    X_CONTENT_TYPE_OPTIONS,
};
use axum::http::{Method, StatusCode, Uri};
use axum::response::Response;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

pub struct Asset {
    pub bytes: Vec<u8>,
    pub mime: String,
    // The policy the file was built for, when it has its own.
    pub csp: Option<String>,
}

// The file at a path such as `/login/index.html`, or None.
pub type Resolver = Arc<dyn Fn(&str) -> Option<Asset> + Send + Sync>;

const INDEX: &str = "/index.html";
const STATIC: &str = "/_next/static/";
const FOREVER: &str = "public, max-age=31536000, immutable";

// The shell's own policy without its `ipc:` sources: a browser has no shell to call.
pub const CSP: &str = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https: http://localhost:* http://127.0.0.1:*; media-src 'self' data: blob: mediastream: https: http://localhost:* http://127.0.0.1:*; font-src 'self' data:; connect-src 'self' https: wss: http://localhost:* ws://localhost:* http://127.0.0.1:* ws://127.0.0.1:*; worker-src 'self' blob:; manifest-src 'self'; frame-src 'none'; frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'none'";

const SHELL_ONLY: [&str; 2] = ["ipc:", "http://ipc.localhost"];

pub fn without_ipc(csp: &str) -> String {
    csp.split(';')
        .map(|directive| {
            directive
                .split_whitespace()
                .filter(|source| !SHELL_ONLY.contains(source))
                .collect::<Vec<_>>()
                .join(" ")
        })
        .filter(|directive| !directive.is_empty())
        .collect::<Vec<_>>()
        .join("; ")
}

fn hex(byte: u8) -> Option<u8> {
    char::from(byte).to_digit(16).map(|digit| digit as u8)
}

fn decoded(path: &str) -> Option<String> {
    let mut bytes = Vec::with_capacity(path.len());
    let mut rest = path.bytes();
    while let Some(byte) = rest.next() {
        bytes.push(match byte {
            b'%' => hex(rest.next()?)? * 16 + hex(rest.next()?)?,
            other => other,
        });
    }
    String::from_utf8(bytes).ok()
}

// The decoded path, when it stays inside the app's files.
fn inside(path: &str) -> Option<String> {
    let path = decoded(path)?;
    let climbs = path.split('/').any(|part| part == "..");
    let safe = path.starts_with('/') && !climbs && !path.contains(['\\', '\0']);
    safe.then_some(path)
}

fn names_a_file(path: &str) -> bool {
    !path.ends_with('/')
        && path
            .rsplit('/')
            .next()
            .is_some_and(|last| last.contains('.'))
}

// The file a request path leads to, with the path it was found at: the file itself, the
// `index.html` of that folder, or the app's start page for a path that names no file.
pub fn lookup(resolver: &Resolver, path: &str) -> Option<(String, Asset)> {
    let path = inside(path)?;
    let folder = path.trim_end_matches('/');
    let index = format!("{folder}{INDEX}");
    let exact = (!path.ends_with('/')).then(|| path.clone());
    let start = (!names_a_file(&path)).then(|| INDEX.to_string());
    exact
        .into_iter()
        .chain([index])
        .chain(start)
        .find_map(|at| resolver(&at).map(|asset| (at, asset)))
}

pub fn respond(resolver: &Resolver, method: &Method, path: &str) -> Response {
    let guarded = Response::builder()
        .header(X_CONTENT_TYPE_OPTIONS, "nosniff")
        .header(REFERRER_POLICY, "no-referrer");
    let read = [Method::GET, Method::HEAD].contains(method);
    let built = match (read, lookup(resolver, path)) {
        (false, _) => guarded
            .status(StatusCode::METHOD_NOT_ALLOWED)
            .header(ALLOW, "GET, HEAD")
            .header(CONTENT_SECURITY_POLICY, CSP)
            .body(Body::empty()),
        (true, None) => guarded
            .status(StatusCode::NOT_FOUND)
            .header(CONTENT_SECURITY_POLICY, CSP)
            .body(Body::empty()),
        (true, Some((at, asset))) => {
            let Asset { bytes, mime, csp } = asset;
            let policy = csp.map_or_else(|| CSP.to_string(), |own| without_ipc(&own));
            let cache = if at.starts_with(STATIC) {
                FOREVER
            } else {
                "no-cache"
            };
            let body = if method == Method::HEAD {
                Body::empty()
            } else {
                Body::from(bytes)
            };
            guarded
                .header(CONTENT_TYPE, mime)
                .header(CACHE_CONTROL, cache)
                .header(CONTENT_SECURITY_POLICY, policy)
                .body(body)
        }
    };
    built.unwrap_or_else(|_| {
        let mut failed = Response::new(Body::empty());
        *failed.status_mut() = StatusCode::INTERNAL_SERVER_ERROR;
        failed
    })
}

pub fn router(resolver: Resolver) -> Router {
    Router::new().fallback(move |method: Method, uri: Uri| {
        let resolver = resolver.clone();
        async move { respond(&resolver, &method, uri.path()) }
    })
}

const HTML: &str = "text/html";
const SCRIPTS: &str = "script-src 'self'";
const INLINE_SCRIPTS: &str = "script-src 'self' 'unsafe-inline'";

fn mime(path: &str) -> &'static str {
    match path.rsplit_once('.').map(|(_, extension)| extension) {
        Some("html") => HTML,
        Some("js" | "mjs") => "text/javascript",
        Some("css") => "text/css",
        Some("json" | "map") => "application/json",
        Some("webmanifest") => "application/manifest+json",
        Some("wasm") => "application/wasm",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("webp") => "image/webp",
        Some("ico") => "image/x-icon",
        Some("woff2") => "font/woff2",
        Some("txt") => "text/plain",
        _ => "application/octet-stream",
    }
}

// The files of a folder such as a static export of the web app. Its pages keep their inline
// scripts, which no build step has listed in a policy.
pub fn folder(dir: PathBuf) -> Resolver {
    Arc::new(move |path: &str| {
        let under = Path::new(path.trim_start_matches('/'));
        let inside = under
            .components()
            .all(|part| matches!(part, Component::Normal(_)));
        let file = inside.then(|| dir.join(under))?;
        let bytes = file
            .is_file()
            .then(|| std::fs::read(&file).ok())
            .flatten()?;
        let mime = mime(path);
        let csp = (mime == HTML).then(|| CSP.replace(SCRIPTS, INLINE_SCRIPTS));
        Some(Asset {
            bytes,
            mime: mime.to_string(),
            csp,
        })
    })
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::collections::HashMap;

    pub(crate) const HOME: &str = "<!doctype html><title>home</title>";

    pub(crate) fn site() -> Resolver {
        let files: HashMap<&str, (&str, &str, Option<&str>)> = [
            ("/index.html", (HOME, "text/html", None)),
            ("/login/index.html", ("<p>login</p>", "text/html", None)),
            (
                "/built/index.html",
                (
                    "<p>built</p>",
                    "text/html",
                    Some(
                        "default-src 'self'; connect-src ipc: http://ipc.localhost 'self' https:; script-src 'self' 'nonce-abc'",
                    ),
                ),
            ),
            ("/_next/static/chunks/app.js", ("let a", "text/javascript", None)),
            ("/icon.png", ("png", "image/png", None)),
            ("/a b/c.txt", ("spaced", "text/plain", None)),
        ]
        .into_iter()
        .collect();
        Arc::new(move |path: &str| {
            files.get(path).map(|(body, mime, csp)| Asset {
                bytes: body.as_bytes().to_vec(),
                mime: mime.to_string(),
                csp: csp.map(str::to_string),
            })
        })
    }

    struct Got {
        status: StatusCode,
        body: String,
        response: axum::http::response::Parts,
    }

    impl Got {
        fn header(&self, name: axum::http::HeaderName) -> &str {
            self.response
                .headers
                .get(name)
                .map_or("", |v| v.to_str().expect("text"))
        }
    }

    fn ask(method: Method, path: &str) -> Got {
        let (response, body) = respond(&site(), &method, path).into_parts();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .build()
            .expect("runtime");
        let bytes = runtime
            .block_on(axum::body::to_bytes(body, usize::MAX))
            .expect("body");
        Got {
            status: response.status,
            body: String::from_utf8(bytes.to_vec()).expect("text"),
            response,
        }
    }

    fn get(path: &str) -> Got {
        ask(Method::GET, path)
    }

    #[test]
    fn the_root_is_the_start_page() {
        let got = get("/");
        assert_eq!((got.status, got.body.as_str()), (StatusCode::OK, HOME));
        assert_eq!(got.header(CONTENT_TYPE), "text/html");
    }

    #[test]
    fn a_folder_answers_with_its_index() {
        for path in ["/login/", "/login", "/login/index.html"] {
            let got = get(path);
            assert_eq!(
                (got.status, got.body.as_str()),
                (StatusCode::OK, "<p>login</p>"),
                "{path}"
            );
        }
    }

    #[test]
    fn a_path_that_names_no_file_gets_the_start_page() {
        for path in ["/s/a/b/", "/s/a/b", "/invite/abc", "/u/name.with.dots/"] {
            let got = get(path);
            assert_eq!(
                (got.status, got.body.as_str()),
                (StatusCode::OK, HOME),
                "{path}"
            );
            assert_eq!(got.header(CACHE_CONTROL), "no-cache", "{path}");
        }
    }

    #[test]
    fn a_missing_file_is_not_found() {
        for path in ["/x.png", "/_next/static/chunks/gone.js", "/login/x.css"] {
            let got = get(path);
            assert_eq!(got.status, StatusCode::NOT_FOUND, "{path}");
            assert_eq!(got.body, "", "{path}");
            assert_eq!(got.header(X_CONTENT_TYPE_OPTIONS), "nosniff", "{path}");
        }
    }

    #[test]
    fn paths_that_climb_out_are_refused() {
        for path in [
            "/../x",
            "/..",
            "/login/../index.html",
            "/%2e%2e/x",
            "/%2E%2E/index.html",
            "/login/%2e%2e/",
            "/..%2fx",
            "/a%5c..%5cindex.html",
            "/a\\b",
            "/%00",
            "/%ff",
            "login",
        ] {
            assert_eq!(get(path).status, StatusCode::NOT_FOUND, "{path}");
        }
    }

    #[test]
    fn encoded_paths_are_decoded_once() {
        assert_eq!(get("/a%20b/c.txt").body, "spaced");
        assert_eq!(get("/a%2520b/c.txt").status, StatusCode::NOT_FOUND);
    }

    #[test]
    fn hashed_files_are_cached_for_a_year_and_the_rest_is_checked_again() {
        assert_eq!(
            get("/_next/static/chunks/app.js").header(CACHE_CONTROL),
            "public, max-age=31536000, immutable"
        );
        for path in ["/", "/login/", "/icon.png"] {
            assert_eq!(get(path).header(CACHE_CONTROL), "no-cache", "{path}");
        }
    }

    #[test]
    fn every_answer_carries_the_safety_headers() {
        for path in ["/", "/icon.png", "/_next/static/chunks/app.js", "/x.png"] {
            let got = get(path);
            assert_eq!(got.header(X_CONTENT_TYPE_OPTIONS), "nosniff", "{path}");
            assert_eq!(got.header(REFERRER_POLICY), "no-referrer", "{path}");
            assert_eq!(got.header(CONTENT_SECURITY_POLICY), CSP, "{path}");
        }
    }

    #[test]
    fn a_page_built_with_its_own_policy_keeps_it_without_the_shell_sources() {
        assert_eq!(
            get("/built/").header(CONTENT_SECURITY_POLICY),
            "default-src 'self'; connect-src 'self' https:; script-src 'self' 'nonce-abc'"
        );
    }

    #[test]
    fn the_policy_is_the_shell_policy_without_ipc() {
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../../../src-tauri/tauri.conf.json"))
                .expect("config");
        let shell = conf["app"]["security"]["csp"].as_object().expect("policy");
        let expected: Vec<String> = shell
            .iter()
            .map(|(name, sources)| {
                format!("{name} {}", without_ipc(sources.as_str().expect("sources")))
            })
            .collect();
        let mut ours: Vec<&str> = CSP.split("; ").collect();
        let mut expected: Vec<&str> = expected.iter().map(String::as_str).collect();
        ours.sort_unstable();
        expected.sort_unstable();
        assert_eq!(ours, expected);
        assert!(!CSP.contains("ipc"));
        assert!(
            shell["connect-src"]
                .as_str()
                .expect("sources")
                .contains("ipc:")
        );
    }

    #[test]
    fn only_reads_are_answered() {
        let head = ask(Method::HEAD, "/");
        assert_eq!((head.status, head.body.as_str()), (StatusCode::OK, ""));
        assert_eq!(head.header(CONTENT_TYPE), "text/html");
        for method in [Method::POST, Method::PUT, Method::DELETE] {
            let got = ask(method, "/");
            assert_eq!(got.status, StatusCode::METHOD_NOT_ALLOWED);
            assert_eq!(got.header(ALLOW), "GET, HEAD");
        }
    }

    #[test]
    fn a_folder_on_disk_serves_its_files() {
        let dir = crate::server::dirs::tests::temp("web folder");
        std::fs::create_dir_all(dir.join("login")).expect("folder");
        std::fs::write(dir.join("index.html"), HOME).expect("file");
        std::fs::write(dir.join("login/index.html"), "<p>login</p>").expect("file");
        std::fs::write(dir.join("app.js"), "let a").expect("file");
        std::fs::write(dir.join("pow.wasm"), "wasm").expect("file");
        let resolver = folder(dir.clone());
        let (path, home) = lookup(&resolver, "/s/a/").expect("start page");
        assert_eq!(
            (path.as_str(), home.mime.as_str()),
            ("/index.html", "text/html")
        );
        assert_eq!(home.bytes, HOME.as_bytes());
        let policy = home.csp.expect("policy");
        assert!(
            policy.contains("script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'"),
            "{policy}"
        );
        assert_eq!(policy.replace(" 'unsafe-inline' 'wasm", " 'wasm"), CSP);
        assert_eq!(
            lookup(&resolver, "/login").expect("login").0,
            "/login/index.html"
        );
        assert_eq!(
            lookup(&resolver, "/app.js").expect("js").1.mime,
            "text/javascript"
        );
        assert_eq!(
            lookup(&resolver, "/pow.wasm").expect("wasm").1.mime,
            "application/wasm"
        );
        assert!(lookup(&resolver, "/gone.js").is_none());
        // A folder is not a file.
        assert!(resolver("/login").is_none());
        std::fs::remove_dir_all(dir).expect("clean");
    }

    #[test]
    fn a_folder_on_disk_serves_nothing_outside_it() {
        let top = crate::server::dirs::tests::temp("web folder outside");
        let dir = top.join("web");
        std::fs::create_dir_all(&dir).expect("folder");
        std::fs::write(dir.join("index.html"), HOME).expect("file");
        let outside = top.join("outside.txt");
        std::fs::write(&outside, "secret").expect("file");
        let resolver = folder(dir);
        let full = outside.display().to_string().replace('\\', "/");
        let full = format!("/{}", full.trim_start_matches('/'));
        for path in ["/../outside.txt", "/./../outside.txt", full.as_str()] {
            assert!(resolver(path).is_none(), "{path}");
            assert!(lookup(&resolver, path).is_none(), "{path}");
        }
        assert!(resolver("/index.html").is_some());
        std::fs::remove_dir_all(top).expect("clean");
    }
}
