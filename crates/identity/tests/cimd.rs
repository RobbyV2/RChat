use rchat_identity::cimd::{
    CACHE_MAX, CACHE_SECS, CachedDoc, DOCUMENT, FetchPolicy, JWKS, LOGO, UNADOPTED_DAYS,
    client_id_url_ok, evict, usable,
};

fn doc(url: &str, fetched_at: i64, adopted_by: Option<i64>) -> CachedDoc {
    CachedDoc {
        url: url.to_string(),
        fetched_at,
        adopted_by,
    }
}

#[test]
fn fetch_policy_small_quick_no_redirects() {
    assert_eq!(
        DOCUMENT,
        FetchPolicy {
            max_bytes: 5120,
            timeout_ms: 3000,
            redirects: false
        }
    );
    assert_eq!(JWKS.max_bytes, 64 * 1024);
    assert_eq!(LOGO.max_bytes, 256 * 1024);
    for policy in [DOCUMENT, JWKS, LOGO] {
        assert_eq!((policy.timeout_ms, policy.redirects), (3000, false));
    }
}

#[test]
fn client_id_urls() {
    assert!(client_id_url_ok(
        "https://service.example/oauth/client.json"
    ));
    assert!(!client_id_url_ok("https://service.example/"));
    assert!(!client_id_url_ok("https://service.example"));
    assert!(!client_id_url_ok("http://service.example/c.json"));
    assert!(!client_id_url_ok("https://u@service.example/c.json"));
    assert!(!client_id_url_ok("https://u:p@service.example/c.json"));
    assert!(!client_id_url_ok("https://service.example/c.json#x"));
    assert!(!client_id_url_ok("https://service.example/c.json#"));
    assert!(!client_id_url_ok("https://service.example/a/./c.json"));
    assert!(!client_id_url_ok("https://service.example/a/../c.json"));
    for dotted in [
        "https://good.example/a/%2e%2e/b",
        "https://good.example/a/%2E%2E/b",
        "https://good.example/a/.%2e/b",
        "https://good.example/a/%2E/b",
        "https://good.example/a/b/..",
        "https://good.example/a/b/.",
        "https://good.example\\a\\..\\b",
        "https://good.example/a\\b.json",
        "https://GOOD.example/c.json",
        "https://good.example:443/c.json",
        "https://good.example/a b.json",
    ] {
        assert!(!client_id_url_ok(dotted), "{dotted}");
    }
    assert!(client_id_url_ok("https://good.example:8443/c.json"));
    assert!(client_id_url_ok("https://good.example/~alice/c.json?v=1"));
    assert!(!client_id_url_ok("not a url"));
    assert!(!client_id_url_ok(""));
    let long = format!("https://service.example/{}", "a".repeat(489));
    assert_eq!(long.len(), 513);
    assert!(!client_id_url_ok(&long));
    assert!(client_id_url_ok(&long[..512]));
}

#[test]
fn only_an_adopted_document_signs_anyone_in_the_cache_is_bounded() {
    assert!(!usable(true, Some(&doc("u", 0, None))));
    assert!(usable(true, Some(&doc("u", 0, Some(7)))));
    assert!(!usable(false, Some(&doc("u", 0, Some(7)))));
    assert!(!usable(true, None));
    let many: Vec<CachedDoc> = (0..CACHE_MAX as i64 + 50)
        .map(|i| doc(&format!("u{i}"), i, None))
        .collect();
    let kept = evict(&many, CACHE_MAX as i64 + 50);
    assert_eq!(kept.len(), CACHE_MAX);
    assert_eq!(kept[0].url, "u50");
    assert_eq!(
        evict(&[doc("old", 0, None), doc("mine", 0, Some(1))], CACHE_SECS),
        [doc("mine", 0, Some(1))]
    );
    assert_eq!(
        evict(&[doc("fresh", 1, None)], CACHE_SECS),
        [doc("fresh", 1, None)]
    );
    assert_eq!(evict(&[doc("far", i64::MIN, None)], i64::MAX), []);
    assert_eq!((CACHE_MAX, CACHE_SECS, UNADOPTED_DAYS), (1000, 86400, 90));
}
