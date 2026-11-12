use url::Url;

use crate::util::is_space;

pub const MAX_LEN: usize = 512;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ClientType {
    Public,
    Confidential,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RedirectKind {
    Web,
    Loopback,
    PrivateScheme,
}

impl RedirectKind {
    pub fn name(self) -> &'static str {
        match self {
            RedirectKind::Web => "web",
            RedirectKind::Loopback => "loopback",
            RedirectKind::PrivateScheme => "private_scheme",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RedirectError {
    TooLong,
    Forbidden,
    NotAUrl,
    UserInfo,
    LocalName,
    LoopbackWithSecret,
    NotHttps,
    SchemeWithSecret,
    Scheme,
}

impl RedirectError {
    pub fn text(self) -> &'static str {
        match self {
            RedirectError::TooLong => "Redirect URIs are at most 512 characters",
            RedirectError::Forbidden => "Redirect URIs can not hold spaces, fragments or wildcards",
            RedirectError::NotAUrl => "Not a URL",
            RedirectError::UserInfo => "Redirect URIs can not hold a user name or password",
            RedirectError::LocalName => "Use http://127.0.0.1 for local apps",
            RedirectError::LoopbackWithSecret => "Loopback redirects are for apps without a secret",
            RedirectError::NotHttps => "Redirect URIs must use https",
            RedirectError::SchemeWithSecret => "Custom schemes are for apps without a secret",
            RedirectError::Scheme => {
                "Use https, http://127.0.0.1, or a reverse domain scheme such as com.example.app"
            }
        }
    }
}

const LOOPBACK_HOSTS: [&str; 2] = ["127.0.0.1", "[::1]"];
const NEVER_SCHEMES: [&str; 4] = ["javascript", "data", "file", "vbscript"];

fn private_scheme(scheme: &str) -> bool {
    let mut bytes = scheme.bytes();
    let first = bytes.next().is_some_and(|b| b.is_ascii_lowercase());
    let rest = bytes
        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'+' | b'.' | b'-'));
    first && rest && scheme.contains('.') && !NEVER_SCHEMES.contains(&scheme)
}

pub fn check_redirect(raw: &str, client: ClientType) -> Result<RedirectKind, RedirectError> {
    if raw.encode_utf16().count() > MAX_LEN {
        return Err(RedirectError::TooLong);
    }
    if raw.chars().any(|c| is_space(c) || c == '#' || c == '*') {
        return Err(RedirectError::Forbidden);
    }
    let url = Url::parse(raw).map_err(|_| RedirectError::NotAUrl)?;
    if !url.username().is_empty() || url.password().is_some() {
        return Err(RedirectError::UserInfo);
    }
    let host = url.host_str().unwrap_or("");
    let public = client == ClientType::Public;
    match url.scheme() {
        "https" => match host == "localhost" || host.ends_with(".localhost") {
            true => Err(RedirectError::LocalName),
            false => Ok(RedirectKind::Web),
        },
        "http" => match (LOOPBACK_HOSTS.contains(&host), host == "localhost", public) {
            (true, _, true) => Ok(RedirectKind::Loopback),
            (true, _, false) => Err(RedirectError::LoopbackWithSecret),
            (false, true, _) => Err(RedirectError::LocalName),
            (false, false, _) => Err(RedirectError::NotHttps),
        },
        scheme => match (private_scheme(scheme), public) {
            (true, true) => Ok(RedirectKind::PrivateScheme),
            (true, false) => Err(RedirectError::SchemeWithSecret),
            (false, _) => Err(RedirectError::Scheme),
        },
    }
}

fn portless(uri: &str) -> String {
    for head in ["http://127.0.0.1", "http://[::1]"] {
        let Some(rest) = uri.strip_prefix(head) else {
            continue;
        };
        let after = match rest.strip_prefix(':') {
            Some(port) => {
                let digits = port.bytes().take_while(u8::is_ascii_digit).count();
                match digits {
                    0 => rest,
                    _ => port.get(digits..).unwrap_or(""),
                }
            }
            None => rest,
        };
        if after.is_empty() || after.starts_with('/') || after.starts_with('?') {
            return format!("{head}{after}");
        }
        break;
    }
    uri.to_string()
}

pub fn redirect_matches<S: AsRef<str>>(registered: &[S], asked: &str) -> bool {
    if registered.iter().any(|r| r.as_ref() == asked) {
        return true;
    }
    let Ok(url) = Url::parse(asked) else {
        return false;
    };
    let loopback =
        url.scheme() == "http" && url.host_str().is_some_and(|h| LOOPBACK_HOSTS.contains(&h));
    loopback && {
        let asked = portless(asked);
        registered.iter().any(|r| portless(r.as_ref()) == asked)
    }
}
