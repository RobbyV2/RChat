use rchat_identity::redirect::{
    ClientType, RedirectError, RedirectKind, check_redirect, redirect_matches,
};

use ClientType::{Confidential, Public};

#[test]
fn kinds() {
    assert_eq!(
        check_redirect("https://app.example.com/cb", Confidential),
        Ok(RedirectKind::Web)
    );
    assert_eq!(
        check_redirect("http://127.0.0.1/cb", Public),
        Ok(RedirectKind::Loopback)
    );
    assert_eq!(
        check_redirect("http://[::1]:8080/cb", Public),
        Ok(RedirectKind::Loopback)
    );
    assert_eq!(
        check_redirect("com.example.app:/cb", Public),
        Ok(RedirectKind::PrivateScheme)
    );
    assert_eq!(RedirectKind::Web.name(), "web");
    assert_eq!(RedirectKind::Loopback.name(), "loopback");
    assert_eq!(RedirectKind::PrivateScheme.name(), "private_scheme");
}

#[test]
fn refusals() {
    let text = |raw: &str, client| check_redirect(raw, client).unwrap_err().text();
    assert_eq!(
        text("http://app.example.com/cb", Confidential),
        "Redirect URIs must use https"
    );
    assert_eq!(
        text("http://localhost/cb", Public),
        "Use http://127.0.0.1 for local apps"
    );
    assert_eq!(
        text("https://localhost/cb", Public),
        "Use http://127.0.0.1 for local apps"
    );
    assert_eq!(
        text("https://app.localhost/cb", Public),
        "Use http://127.0.0.1 for local apps"
    );
    assert!(text("https://app.example.com/cb#x", Public).contains("fragments"));
    assert!(text("https://*.example.com/cb", Public).contains("wildcards"));
    assert!(text("https://app.example.com/a b", Public).contains("spaces"));
    assert_eq!(
        text("http://127.0.0.1/cb", Confidential),
        "Loopback redirects are for apps without a secret"
    );
    assert_eq!(
        text("com.example.app:/cb", Confidential),
        "Custom schemes are for apps without a secret"
    );
    assert!(text("myapp:/cb", Public).contains("reverse domain"));
    assert!(text("javascript:alert(1)", Public).contains("reverse domain"));
    assert!(text("https://u:p@app.example.com/", Public).contains("user name"));
    assert_eq!(text("not a url", Public), RedirectError::Forbidden.text());
    assert_eq!(text("nothing", Public), "Not a URL");
    assert_eq!(
        text(&format!("https://a.example/{}", "a".repeat(500)), Public),
        "Redirect URIs are at most 512 characters"
    );
}

#[test]
fn exact_with_only_the_loopback_port_free() {
    let reg = [
        "https://app.example.com/cb",
        "http://127.0.0.1/cb",
        "http://[::1]/cb",
    ];
    assert!(redirect_matches(&reg, "https://app.example.com/cb"));
    assert!(!redirect_matches(&reg, "https://app.example.com/cb/"));
    assert!(!redirect_matches(&reg, "https://APP.example.com/cb"));
    assert!(!redirect_matches(&reg, "https://app.example.com/cb?x=1"));
    assert!(!redirect_matches(&reg, "https://app.example.com:443/cb"));
    assert!(redirect_matches(&reg, "http://127.0.0.1:51234/cb"));
    assert!(redirect_matches(&reg, "http://[::1]:9/cb"));
    assert!(!redirect_matches(&reg, "http://127.0.0.1:51234/other"));
    assert!(!redirect_matches(&reg, "http://127.0.0.2:51234/cb"));
    assert!(!redirect_matches(
        &reg,
        "https://app.example.com.evil.com/cb"
    ));
}

#[test]
fn the_port_is_only_free_in_the_plain_loopback_spelling() {
    let reg = ["http://127.0.0.1/cb", "http://127.0.0.1:7000/fixed"];
    assert!(redirect_matches(&reg, "http://127.0.0.1:1/fixed"));
    assert!(!redirect_matches(&reg, "http://127.0.0.1:99999/cb"));
    assert!(!redirect_matches(&reg, "http://127.0.0.1:80x/cb"));
    assert!(!redirect_matches(&reg, "http://127.0.0.1:/cb"));
    assert!(!redirect_matches(&reg, "HTTP://127.0.0.1:5000/cb"));
    assert!(!redirect_matches(&reg, "http://127.1:5000/cb"));
    assert!(!redirect_matches(&reg, "http://127.0.0.1.evil.example/cb"));
    assert!(!redirect_matches(
        &reg,
        "http://127.0.0.1:5000@evil.example/cb"
    ));
    assert!(!redirect_matches(&reg, ""));
    assert!(!redirect_matches(&[] as &[&str], "http://127.0.0.1/cb"));
    let query = ["http://[::1]?x=1"];
    assert!(redirect_matches(&query, "http://[::1]:8080?x=1"));
}
