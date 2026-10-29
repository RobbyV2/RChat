use url::Url;

pub const SCHEME: &str = "rchat";
const MAX_LEN: usize = 4096;

// An `rchat://host/path` link the app may route, or None. Only the host and path are used later;
// credentials, other schemes and oversized links are dropped here.
pub fn deep_link(raw: &str) -> Option<String> {
    if raw.len() > MAX_LEN {
        return None;
    }
    let url = Url::parse(raw.trim()).ok()?;
    let host = url.host_str().unwrap_or_default();
    match (url.scheme(), host, url.username(), url.password()) {
        (SCHEME, host, "", None) if !host.is_empty() => Some(url.into()),
        _ => None,
    }
}

// Pages the webview may show itself: the bundled app, or the dev server while developing.
pub fn is_app_url(url: &Url, dev: Option<&Url>) -> bool {
    match (url.scheme(), url.host_str()) {
        ("tauri", Some("localhost")) => true,
        ("http" | "https", Some("tauri.localhost")) => true,
        _ => dev.is_some_and(|dev| dev.origin() == url.origin()),
    }
}

// Links the system may open in the browser or mail app.
pub fn is_external(url: &Url) -> bool {
    match url.scheme() {
        "http" | "https" => url.host_str().is_some_and(|h| !h.is_empty()),
        "mailto" => true,
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    #[test]
    fn deep_links_keep_host_and_path() {
        assert_eq!(
            deep_link("rchat://chat.example.com/invite/lobby/#password=x").as_deref(),
            Some("rchat://chat.example.com/invite/lobby/#password=x")
        );
        assert_eq!(
            deep_link(" rchat://localhost:3000/s/main/4/ ").as_deref(),
            Some("rchat://localhost:3000/s/main/4/")
        );
    }

    #[test]
    fn deep_links_reject_other_shapes() {
        assert_eq!(deep_link("https://chat.example.com/invite/x/"), None);
        assert_eq!(deep_link("rchat:invite"), None);
        assert_eq!(deep_link("rchat:///invite/x/"), None);
        assert_eq!(deep_link("rchat://me:pw@chat.example.com/"), None);
        assert_eq!(deep_link("rchat://user@chat.example.com/"), None);
        assert_eq!(deep_link("not a url"), None);
        let long = format!("rchat://a.com/{}", "x".repeat(MAX_LEN));
        assert_eq!(deep_link(&long), None);
    }

    #[test]
    fn app_urls() {
        let dev = url("http://127.0.0.1:1430");
        assert!(is_app_url(&url("tauri://localhost/s/main/1/"), None));
        assert!(is_app_url(&url("http://tauri.localhost/login/"), None));
        assert!(is_app_url(&url("https://tauri.localhost/"), None));
        assert!(is_app_url(&url("http://127.0.0.1:1430/login/"), Some(&dev)));
        assert!(!is_app_url(&url("http://127.0.0.1:1431/"), Some(&dev)));
        assert!(!is_app_url(&url("http://127.0.0.1:1430/"), None));
        assert!(!is_app_url(&url("https://chat.example.com/"), Some(&dev)));
        assert!(!is_app_url(&url("tauri://evil.com/"), None));
    }

    #[test]
    fn external_urls() {
        assert!(is_external(&url("https://example.com/a")));
        assert!(is_external(&url("http://localhost:3000/")));
        assert!(is_external(&url("mailto:someone@example.com")));
        assert!(!is_external(&url("file:///etc/passwd")));
        assert!(!is_external(&url("javascript:alert(1)")));
        assert!(!is_external(&url("rchat://chat.example.com/")));
        assert!(!is_external(&url("data:text/html,hi")));
    }
}
