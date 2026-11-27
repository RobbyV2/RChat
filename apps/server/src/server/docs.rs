use std::convert::Infallible;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use axum::Router;
use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::{HeaderValue, StatusCode, Uri, header};
use axum::response::{IntoResponse, Redirect, Response};
use axum::routing::get;
use tower_http::services::ServeDir;
use tower_service::Service;

use crate::api::Settings;
use crate::api::features::Feature;
use crate::state::AppState;

/// The path the site is served under.
pub const BASE: &str = "/docs";

/// Where the built site is when `DOCS_DIR` is unset, from the folder the server starts in.
pub const DIR: &str = "docs/dist";

/// The file of a built site that lists the hashes of its inline scripts, one `sha256-...` per
/// line (`bun run build:docs` writes it).
pub const SCRIPT_HASHES: &str = "script-hashes.txt";

/// What the pages of the site may load: their own files, and inline scripts only when the build
/// listed their hashes. Search runs WebAssembly. Every answer carries the whole policy, so a page
/// revalidated with a 304 (which has no content type) keeps its scripts.
const POLICY: &str = "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; script-src 'self' 'wasm-unsafe-eval'";

/// The policy of the pages that say the site is unavailable: no scripts, their own styles.
const CLOSED_POLICY: &str = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/// The documentation site: the static build in its folder, at `/docs` while the `docs` switch
/// is on.
#[derive(Clone)]
pub(crate) struct Docs {
    dir: Arc<Path>,
    files: ServeDir,
    state: AppState,
}

/// Why `/docs` has no site to show.
#[derive(Debug, PartialEq, Eq)]
enum Closed {
    /// The `docs` switch is off.
    Off,
    /// The folder holds no built site.
    NotBuilt,
}

/// The site while it may be served: the switch is on and the build is there. Only `Docs::open`
/// makes one.
struct Site<'a> {
    docs: &'a Docs,
}

impl Docs {
    fn new(dir: PathBuf, state: AppState) -> Docs {
        let files = ServeDir::new(&dir)
            .append_index_html_on_directories(true)
            .redirect_path_prefix(BASE)
            .precompressed_br()
            .precompressed_gzip();
        Docs {
            dir: Arc::from(dir),
            files,
            state,
        }
    }

    async fn open(&self, settings: &Settings) -> Result<Site<'_>, Closed> {
        if !settings.on(Feature::Docs) {
            return Err(Closed::Off);
        }
        match tokio::fs::metadata(self.dir.join("index.html")).await {
            Ok(meta) if meta.is_file() => Ok(Site { docs: self }),
            Ok(_) | Err(_) => Err(Closed::NotBuilt),
        }
    }
}

impl Site<'_> {
    async fn serve(self, req: Request) -> Response {
        let Some(rest) = req.uri().path().strip_prefix(BASE).map(str::to_string) else {
            return StatusCode::NOT_FOUND.into_response();
        };
        if rest.is_empty() {
            let to = match req.uri().query() {
                Some(query) => format!("{BASE}/?{query}"),
                None => format!("{BASE}/"),
            };
            return Redirect::permanent(&to).into_response();
        }
        let hashed = rest.starts_with("/_astro/");
        let path_query = match req.uri().query() {
            Some(query) => format!("{rest}?{query}"),
            None => rest,
        };
        let Ok(uri) = path_query.parse::<Uri>() else {
            return self.missing().await;
        };
        let (mut parts, body) = req.into_parts();
        parts.uri = uri;
        let mut files = self.docs.files.clone();
        let answer: Result<_, Infallible> = files.call(Request::from_parts(parts, body)).await;
        let Ok(answer) = answer;
        let mut answer = match answer.status() {
            StatusCode::NOT_FOUND => self.missing().await,
            _ => answer.map(Body::new),
        };
        let kept =
            hashed && (answer.status().is_success() || answer.status() == StatusCode::NOT_MODIFIED);
        let scripts = hashes(&self.docs.dir).await;
        let headers = answer.headers_mut();
        headers.insert(
            header::CONTENT_SECURITY_POLICY,
            HeaderValue::from_str(&policy(&scripts)).unwrap_or(HeaderValue::from_static(POLICY)),
        );
        headers.insert(
            header::X_CONTENT_TYPE_OPTIONS,
            HeaderValue::from_static("nosniff"),
        );
        headers.insert(
            header::REFERRER_POLICY,
            HeaderValue::from_static("no-referrer"),
        );
        headers.insert(
            header::CACHE_CONTROL,
            HeaderValue::from_static(match kept {
                true => "public, max-age=31536000, immutable",
                false => "no-cache",
            }),
        );
        answer
    }

    /// The site's own 404 page, read whole whatever the request asked to revalidate or range.
    async fn missing(&self) -> Response {
        match tokio::fs::read(self.docs.dir.join("404.html")).await {
            Ok(page) => (
                StatusCode::NOT_FOUND,
                [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
                page,
            )
                .into_response(),
            Err(_) => StatusCode::NOT_FOUND.into_response(),
        }
    }
}

impl Closed {
    fn page(&self) -> Response {
        let (title, line) = match self {
            Closed::Off => (
                "Documentation is turned off",
                "Documentation is turned off on this site.",
            ),
            Closed::NotBuilt => (
                "Documentation is not available",
                "This site has no documentation build.",
            ),
        };
        let page = format!(
            "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><meta name=\"color-scheme\" content=\"light dark\"><title>{title}</title><style>body{{margin:0;min-height:100vh;display:grid;place-items:center;font-family:system-ui,sans-serif;background:#fef7ff;color:#1d1b20}}main{{max-width:32rem;padding:1.5rem}}h1{{font-size:1.375rem;margin:0 0 .5rem}}p{{margin:0;color:#49454f;line-height:1.5}}@media (prefers-color-scheme:dark){{body{{background:#141218;color:#e6e0e9}}p{{color:#cac4d0}}}}</style></head><body><main><h1>{title}</h1><p>{line}</p></main></body></html>"
        );
        (
            StatusCode::NOT_FOUND,
            [
                (header::CONTENT_TYPE, "text/html; charset=utf-8"),
                (header::CONTENT_SECURITY_POLICY, CLOSED_POLICY),
                (header::CACHE_CONTROL, "no-cache"),
                (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
            ],
            page,
        )
            .into_response()
    }
}

/// Whether `line` is one hash the build listed: `sha256-` and base64.
fn is_hash(line: &str) -> bool {
    line.strip_prefix("sha256-").is_some_and(|b64| {
        b64.len() == 44
            && b64.ends_with('=')
            && b64[..43]
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'/')
    })
}

/// The hashes of the inline scripts the built site in `dir` listed. A missing list, and lines
/// that aren't hashes, add none.
async fn hashes(dir: &Path) -> Vec<String> {
    let Ok(text) = tokio::fs::read_to_string(dir.join(SCRIPT_HASHES)).await else {
        return Vec::new();
    };
    text.lines()
        .map(str::trim)
        .filter(|line| is_hash(line))
        .map(str::to_string)
        .collect()
}

/// The policy of the site's pages, with `scripts` allowed inline.
fn policy(scripts: &[String]) -> String {
    let mut out = POLICY.to_string();
    for hash in scripts {
        out.push_str(" '");
        out.push_str(hash);
        out.push('\'');
    }
    out
}

async fn answer(State(docs): State<Docs>, req: Request) -> Response {
    let settings = Settings::cached(&docs.state.db).await;
    match docs.open(&settings).await {
        Ok(site) => site.serve(req).await,
        Err(closed) => closed.page(),
    }
}

/// The site in `dir` at `/docs`, for GET and HEAD.
pub(crate) fn routes(dir: PathBuf, state: AppState) -> Router {
    Router::new()
        .route(BASE, get(answer))
        .route("/docs/", get(answer))
        .route("/docs/{*rest}", get(answer))
        .with_state(Docs::new(dir, state))
}

#[cfg(test)]
mod tests;
