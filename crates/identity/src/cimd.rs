use url::Url;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FetchPolicy {
    pub max_bytes: usize,
    pub timeout_ms: u64,
    pub redirects: bool,
}

const fn policy(max_bytes: usize) -> FetchPolicy {
    FetchPolicy {
        max_bytes,
        timeout_ms: 3000,
        redirects: false,
    }
}

pub const DOCUMENT: FetchPolicy = policy(5 * 1024);
pub const JWKS: FetchPolicy = policy(64 * 1024);
pub const LOGO: FetchPolicy = policy(256 * 1024);

pub const CLIENT_ID_MAX_LEN: usize = 512;
pub const CACHE_MAX: usize = 1000;
pub const CACHE_SECS: i64 = 24 * 3600;
pub const UNADOPTED_DAYS: i64 = 90;

pub fn client_id_url_ok(raw: &str) -> bool {
    let Ok(url) = Url::parse(raw) else {
        return false;
    };
    url.scheme() == "https"
        && url.fragment().is_none()
        && url.username().is_empty()
        && url.password().is_none()
        && url.path() != "/"
        && url.as_str() == raw
        && raw.encode_utf16().count() <= CLIENT_ID_MAX_LEN
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CachedDoc {
    pub url: String,
    pub fetched_at: i64,
    pub adopted_by: Option<i64>,
}

pub fn evict(docs: &[CachedDoc], now: i64) -> Vec<CachedDoc> {
    let fresh: Vec<&CachedDoc> = docs
        .iter()
        .filter(|d| d.adopted_by.is_some() || now.saturating_sub(d.fetched_at) < CACHE_SECS)
        .collect();
    let mut unadopted: Vec<&CachedDoc> = fresh
        .iter()
        .copied()
        .filter(|d| d.adopted_by.is_none())
        .collect();
    unadopted.sort_by_key(|d| std::cmp::Reverse(d.fetched_at));
    unadopted.truncate(CACHE_MAX);
    fresh
        .into_iter()
        .filter(|d| d.adopted_by.is_some() || unadopted.iter().any(|keep| keep.url == d.url))
        .cloned()
        .collect()
}

pub fn usable(control: bool, doc: Option<&CachedDoc>) -> bool {
    control && doc.is_some_and(|d| d.adopted_by.is_some())
}
