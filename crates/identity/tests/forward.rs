use rchat_identity::forward::{
    ALL_HEADERS, Account, BROWSER_PATHS, CheckAnswer, CheckRequest, Claim, FLOW_COOKIE, Flow,
    HostRegistry, Identity, NO_ACCOUNT, Page, Preset, Proto, ProxyApplication, ProxyControl,
    ProxyCookie, ProxyKind, Routed, RuleEntry, START, STRIP_PREFIXES, Separator, caddy_prefixes,
    callback_ok, canonical_host, check, cookie, entry_label, go_key, header_value, headers,
    host_allowed, list_value, matches, may_create_proxy, normalize, pick_account, proxy_path,
    rule_summary, safe_return, spellings, stripped_by, traefik_keys, under_domain,
};

fn application() -> ProxyApplication {
    ProxyApplication {
        id: "p1".to_string(),
        hosts: vec!["wiki.example.com".to_string()],
        cookie_domain: None,
        preset: Preset::Rchat,
        paused: false,
        needs_two_factor: false,
    }
}

fn domain_level() -> ProxyApplication {
    ProxyApplication {
        id: "p2".to_string(),
        hosts: vec!["a.example.org".to_string(), "b.example.org".to_string()],
        cookie_domain: Some("example.org".to_string()),
        preset: Preset::Authelia,
        paused: false,
        needs_two_factor: false,
    }
}

fn identity() -> Identity {
    Identity {
        username: "zoë".to_string(),
        display: "Zoë (ops)".to_string(),
        sub: "S".to_string(),
        groups: vec!["lobby".to_string(), "lobby:Staff".to_string()],
        avatar: "https://chat.example.com/api/v1/avatars/k.png".to_string(),
        assertion: "eyJ".to_string(),
    }
}

fn session(application_id: &str, host: &str, two_kinds: bool) -> Option<ProxyCookie> {
    Some(ProxyCookie {
        application_id: application_id.to_string(),
        host: host.to_string(),
        live: true,
        two_kinds,
    })
}

fn req() -> CheckRequest {
    CheckRequest {
        kind: ProxyKind::Traefik,
        application_param: Some("p1".to_string()),
        host: "wiki.example.com".to_string(),
        uri: "/page?x=1".to_string(),
        proto: Proto::Https,
        wants_json: false,
        cookie: session("p1", "wiki.example.com", false),
        allowed: Some(true),
    }
}

fn signed_out() -> CheckRequest {
    CheckRequest {
        cookie: None,
        allowed: None,
        ..req()
    }
}

fn refused(page: Page) -> CheckAnswer {
    CheckAnswer::Refused { page }
}

#[test]
fn site_admins_only() {
    assert!(may_create_proxy(ProxyControl::Admins, true));
    assert!(!may_create_proxy(ProxyControl::Admins, false));
    assert!(!may_create_proxy(ProxyControl::Off, true));
}

#[test]
fn hosts_come_from_the_operator_list_and_belong_to_one_application() {
    let list = ["wiki.example.com", ".example.org"];
    assert!(host_allowed("wiki.example.com", &list));
    assert!(host_allowed("WIKI.example.com:8443", &list));
    assert!(host_allowed("a.example.org", &list));
    assert!(!host_allowed("example.org", &list));
    assert!(!host_allowed("admin.example.com", &list));
    assert!(!host_allowed("evil.com\\@wiki.example.com", &list));
    assert!(!host_allowed(".example.org", &list));
    assert!(!host_allowed("a..example.org", &list));
    assert!(!host_allowed("wiki.example.com:123456", &list));
    assert!(!host_allowed("wiki.example.com:", &list));
    assert!(!host_allowed("", &list));
    assert!(host_allowed("wiki.example.com", &["wiki.example.com:443"]));
    let mut reg = HostRegistry::new();
    assert_eq!(reg.claim("real", "wiki.example.com", &list), Claim::Ok);
    assert_eq!(reg.claim("real", "wiki.example.com", &list), Claim::Ok);
    assert_eq!(reg.claim("squat", "WIKI.example.com", &list), Claim::Taken);
    assert_eq!(
        reg.claim("squat", "admin.example.com", &list),
        Claim::NotListed
    );
    assert_eq!(reg.application_for("Wiki.Example.com"), Some("real"));
    assert_eq!(reg.application_for("a.example.org"), None);
}

#[test]
fn a_host_is_one_host_whatever_its_case_default_port_or_trailing_dot() {
    for spelling in [
        "wiki.example.com",
        "WIKI.Example.com",
        "wiki.example.com:443",
        "wiki.example.com:80",
        "wiki.example.com.",
        "Wiki.example.com.:443",
    ] {
        assert_eq!(canonical_host(spelling), "wiki.example.com", "{spelling}");
    }
    assert_eq!(
        canonical_host("wiki.example.com:8443"),
        "wiki.example.com:8443"
    );
    assert_eq!(canonical_host("[::1]:8080"), "[::1]:8080");
    assert_eq!(canonical_host("[::1]"), "[::1]");
    assert_eq!(canonical_host(""), "");
    let list = ["wiki.example.com"];
    let mut reg = HostRegistry::new();
    assert_eq!(reg.claim("real", "wiki.example.com", &list), Claim::Ok);
    for spelling in [
        "wiki.example.com:443",
        "WIKI.example.com.",
        "wiki.example.com:80",
    ] {
        assert_eq!(
            reg.claim("squat", spelling, &list),
            Claim::Taken,
            "{spelling}"
        );
        assert_eq!(reg.application_for(spelling), Some("real"));
    }
    for spelling in [
        "wiki.example.com:443:443",
        "wiki.example.com:80:443",
        "wiki.example.com:",
    ] {
        assert_eq!(
            reg.claim("squat", spelling, &list),
            Claim::NotListed,
            "{spelling}"
        );
        assert_eq!(reg.application_for(spelling), None, "{spelling}");
    }
    assert_eq!(
        canonical_host("wiki.example.com:443:443"),
        "wiki.example.com:443:443"
    );
    assert_eq!(
        reg.claim("other", "wiki.example.com:8443", &list),
        Claim::Ok
    );
    assert_eq!(reg.application_for("wiki.example.com:8443"), Some("other"));
    let spelled = CheckRequest {
        host: "WIKI.example.com.:443".to_string(),
        ..req()
    };
    assert_eq!(check(&[application()], &spelled, identity).status(), 200);
    let CheckAnswer::Redirect { location } = check(
        &[application()],
        &CheckRequest {
            host: "wiki.example.com:443".to_string(),
            ..signed_out()
        },
        identity,
    ) else {
        panic!("no redirect");
    };
    assert!(location.starts_with("https://wiki.example.com/_rchat/proxy/start?"));
}

#[test]
fn the_check_is_bound_to_the_application_the_config_names() {
    let squat = ProxyApplication {
        id: "evil".to_string(),
        ..application()
    };
    let both = [squat, application()];
    let foreign_cookie = CheckRequest {
        cookie: session("evil", "wiki.example.com", false),
        ..req()
    };
    assert!(matches!(
        check(&both, &foreign_cookie, identity),
        CheckAnswer::Redirect { .. }
    ));
    let unnamed = CheckRequest {
        application_param: None,
        ..req()
    };
    assert_eq!(check(&both, &unnamed, identity), refused(Page::NotSetUp));
    let other_host = CheckRequest {
        host: "other.example.com".to_string(),
        ..req()
    };
    assert_eq!(
        check(&[application()], &other_host, identity),
        refused(Page::NotSetUp)
    );
    let unknown = CheckRequest {
        application_param: Some("b".to_string()),
        ..signed_out()
    };
    let answer = check(&[application()], &unknown, identity);
    assert_eq!(answer.status(), 403);
}

#[test]
fn signed_in_and_allowed() {
    let answer = check(&[application()], &req(), identity);
    assert_eq!(answer.status(), 200);
    let CheckAnswer::Ok { headers } = answer else {
        panic!("not allowed");
    };
    assert_eq!(headers[0], ("X-RChat-User", "zo%C3%AB".to_string()));
    let upper = CheckRequest {
        host: "WIKI.example.com".to_string(),
        ..req()
    };
    assert_eq!(check(&[application()], &upper, identity).status(), 200);
}

#[test]
fn not_signed_in_nginx_401_others_redirect_with_the_application_named_json_401() {
    let nginx = CheckRequest {
        kind: ProxyKind::Nginx,
        ..signed_out()
    };
    assert_eq!(
        check(&[application()], &nginx, identity),
        CheckAnswer::Unauthorized
    );
    let answer = check(&[application()], &signed_out(), identity);
    assert_eq!(
        answer,
        CheckAnswer::Redirect {
            location: "https://wiki.example.com/_rchat/proxy/start?application=p1&rd=https%3A%2F%2Fwiki.example.com%2Fpage%3Fx%3D1".to_string()
        }
    );
    assert_eq!(answer.status(), 302);
    let json = CheckRequest {
        wants_json: true,
        ..signed_out()
    };
    let answer = check(&[application()], &json, identity);
    assert_eq!(answer, CheckAnswer::Unauthorized);
    assert_eq!(answer.status(), 401);
    let dead = CheckRequest {
        cookie: Some(ProxyCookie {
            live: false,
            ..session("p1", "wiki.example.com", false).unwrap()
        }),
        ..req()
    };
    assert_eq!(check(&[application()], &dead, identity).status(), 302);
    let other_host_cookie = CheckRequest {
        cookie: session("p1", "elsewhere.example.com", false),
        ..req()
    };
    assert_eq!(
        check(&[application()], &other_host_cookie, identity).status(),
        302
    );
    let plain = CheckRequest {
        proto: Proto::Http,
        ..signed_out()
    };
    let CheckAnswer::Redirect { location } = check(&[application()], &plain, identity) else {
        panic!("no redirect");
    };
    assert!(location.starts_with("http://wiki.example.com/_rchat/proxy/start?"));
    assert_eq!(START, "/_rchat/proxy/start");
    assert_eq!(Proto::parse("https"), Some(Proto::Https));
    assert_eq!(Proto::parse("http"), Some(Proto::Http));
    assert_eq!(Proto::parse("https\r\nX: 1"), None);
}

#[test]
fn refusals_and_the_two_factor_option() {
    let denied = CheckRequest {
        allowed: Some(false),
        ..req()
    };
    assert_eq!(
        check(&[application()], &denied, identity),
        refused(Page::NotAllowed)
    );
    let paused = ProxyApplication {
        paused: true,
        ..application()
    };
    assert_eq!(check(&[paused], &req(), identity), refused(Page::Paused));
    let strict = ProxyApplication {
        needs_two_factor: true,
        ..application()
    };
    assert_eq!(
        check(std::slice::from_ref(&strict), &req(), identity),
        refused(Page::NeedsTwoFactor)
    );
    let two = CheckRequest {
        cookie: session("p1", "wiki.example.com", true),
        ..req()
    };
    assert_eq!(check(&[strict], &two, identity).status(), 200);
    assert_eq!(
        [
            Page::NotAllowed,
            Page::NotSetUp,
            Page::Paused,
            Page::NeedsTwoFactor
        ]
        .map(Page::name),
        ["not_allowed", "not_set_up", "paused", "needs_two_factor"]
    );
}

#[test]
fn one_sign_in_for_every_host_under_the_domain() {
    let r = CheckRequest {
        application_param: Some("p2".to_string()),
        host: "b.example.org".to_string(),
        cookie: session("p2", "a.example.org", false),
        ..req()
    };
    let answer = check(&[domain_level()], &r, identity);
    let CheckAnswer::Ok { headers } = answer else {
        panic!("not allowed");
    };
    let names: Vec<&str> = headers.iter().map(|(name, _)| *name).collect();
    assert_eq!(names, ["Remote-User", "Remote-Name", "Remote-Groups"]);
    assert!(under_domain("example.org", "example.org"));
    assert!(under_domain("a.example.org", "example.org"));
    assert!(!under_domain("badexample.org", "example.org"));
}

#[test]
fn a_callback_without_the_starting_browsers_cookie_signs_nobody_in() {
    let flow = Flow {
        application: "p1".to_string(),
        host: "wiki.example.com".to_string(),
        binding: "h1".to_string(),
        expires_at: 100,
    };
    let ok = |application: &str, host: &str, hash: Option<&str>, now: i64| {
        callback_ok(Some(&flow), application, host, hash, now)
    };
    assert!(ok("p1", "wiki.example.com", Some("h1"), 50));
    assert!(!ok("p1", "wiki.example.com", None, 50));
    assert!(!ok("p1", "wiki.example.com", Some("h2"), 50));
    assert!(!ok("p1", "wiki.example.com", Some("h1"), 100));
    assert!(!ok("p2", "wiki.example.com", Some("h1"), 50));
    assert!(!ok("p1", "other.example.com", Some("h1"), 50));
    assert!(!callback_ok(None, "p1", "wiki.example.com", Some("h1"), 50));
    assert!(FLOW_COOKIE.starts_with("__Host-"));
}

#[test]
fn encoding() {
    assert_eq!(header_value("alice"), "alice");
    assert_eq!(header_value("100%"), "100%25");
    assert_eq!(header_value("a\r\nX-Evil: 1"), "a%0D%0AX-Evil: 1");
    assert_eq!(header_value("\u{7f}\u{0}"), "%7F%00");
    assert_eq!(list_value(&["a,b", "c"], Separator::Comma), "a%2Cb,c");
    assert_eq!(list_value(&["a|b", "c,d"], Separator::Pipe), "a%7Cb|c,d");
    assert_eq!(list_value(&[] as &[&str], Separator::Comma), "");
}

#[test]
fn presets_set_only_listed_headers_never_an_email() {
    for preset in [
        Preset::Rchat,
        Preset::Authelia,
        Preset::Authentik,
        Preset::Oauth2Proxy,
    ] {
        let set = headers(preset, &identity(), &application());
        assert!(!set.is_empty());
        for (name, value) in &set {
            assert!(ALL_HEADERS.contains(name), "{name}");
            assert!(!name.to_lowercase().contains("email"));
            assert!(stripped_by(name));
            assert!(value.bytes().all(|b| (0x20..=0x7e).contains(&b)));
        }
    }
    let names = |preset| -> Vec<&'static str> {
        headers(preset, &identity(), &application())
            .into_iter()
            .map(|(name, _)| name)
            .collect()
    };
    assert_eq!(
        names(Preset::Rchat),
        [
            "X-RChat-User",
            "X-RChat-Name",
            "X-RChat-Subject",
            "X-RChat-Groups",
            "X-RChat-Avatar",
            "X-RChat-Assertion"
        ]
    );
    assert_eq!(
        names(Preset::Authentik),
        [
            "X-authentik-username",
            "X-authentik-name",
            "X-authentik-uid",
            "X-authentik-groups",
            "X-authentik-meta-app"
        ]
    );
    assert_eq!(
        names(Preset::Oauth2Proxy),
        [
            "X-Auth-Request-User",
            "X-Auth-Request-Preferred-Username",
            "X-Auth-Request-Groups"
        ]
    );
    let authentik = headers(Preset::Authentik, &identity(), &application());
    assert_eq!(authentik[3].1, "lobby|lobby:Staff");
    assert_eq!(authentik[4].1, "p1");
    assert_eq!(authentik[2].1, "S");
    let rchat = headers(Preset::Rchat, &identity(), &application());
    assert_eq!(rchat[1].1, "Zo%C3%AB (ops)");
    assert_eq!(rchat[3].1, "lobby,lobby:Staff");
    assert_eq!(rchat[5].1, "eyJ");
    let oauth2 = headers(Preset::Oauth2Proxy, &identity(), &application());
    assert_eq!(oauth2[0].1, "S");
    assert_eq!(oauth2[1].1, "zo%C3%AB");
}

#[test]
fn every_spelling_mixed_ones_too_is_stripped_by_its_normalized_name() {
    let traefik = traefik_keys();
    for header in ALL_HEADERS {
        for variant in spellings(header) {
            assert!(stripped_by(&variant));
            assert!(stripped_by(&variant.to_uppercase()));
            assert!(traefik.contains(&go_key(&variant)), "{variant}");
        }
    }
    for header in [
        "X-RChat_User",
        "X_RChat-User",
        "X-Auth_Request-User",
        "x_aUTH-request_GROUPS",
    ] {
        assert!(stripped_by(header));
    }
    assert!(!stripped_by("X-Forwarded-For"));
    assert!(!stripped_by("Remoteuser"));
    assert_eq!(STRIP_PREFIXES.len(), 4);
    assert_eq!(ALL_HEADERS.len(), 20);
    assert_eq!(spellings("X-Auth-Request-User").len(), 8);
    assert_eq!(spellings("Remote"), ["Remote"]);
    assert_eq!(spellings("a-b_c"), ["a-b-c", "a_b-c", "a-b_c", "a_b_c"]);
    assert!(spellings(&"a-".repeat(64)).is_empty());
    let caddy = caddy_prefixes();
    assert!(caddy.contains(&"X_auth-Request_".to_string()));
    assert_eq!(caddy.len(), 2 * (2 + 1 + 2 + 4));
    assert_eq!(traefik.len(), 100);
    assert_eq!(normalize("X_RChat-User"), "x-rchat-user");
    assert_eq!(go_key("x-auth_request-USER"), "X-Auth_request-User");
    assert_eq!(go_key(""), "");
}

#[test]
fn only_back_to_the_applications_own_hosts() {
    let app = application();
    let dom = domain_level();
    assert_eq!(
        safe_return(&app, Some("https://wiki.example.com/x?y")),
        "https://wiki.example.com/x?y"
    );
    assert_eq!(safe_return(&app, Some("https://evil.example.com/")), "/");
    assert_eq!(safe_return(&app, Some("http://wiki.example.com/")), "/");
    assert_eq!(safe_return(&app, Some("//evil.com")), "/");
    assert_eq!(
        safe_return(&dom, Some("https://uploads.example.org/x")),
        "/"
    );
    assert_eq!(
        safe_return(&dom, Some("https://b.example.org/x")),
        "https://b.example.org/x"
    );
    assert_eq!(safe_return(&app, None), "/");
    assert_eq!(safe_return(&app, Some("")), "/");
    assert_eq!(
        safe_return(&app, Some("https://u:p@wiki.example.com/")),
        "/"
    );
    assert_eq!(
        safe_return(&app, Some("https://wiki.example.com\\@evil.example/")),
        "/"
    );
    assert_eq!(safe_return(&app, Some("https://wiki.example.com/\tx")), "/");
    assert_eq!(
        safe_return(&app, Some("https://wiki.example.com:8443/x")),
        "/"
    );
    let long = format!("https://wiki.example.com/{}", "a".repeat(2048));
    assert_eq!(safe_return(&app, Some(&long)), "/");
    let local = ProxyApplication {
        hosts: vec!["127.0.0.1:8080".to_string()],
        ..application()
    };
    assert_eq!(
        safe_return(&local, Some("http://127.0.0.1:8080/x")),
        "http://127.0.0.1:8080/x"
    );
}

#[test]
fn one_cookie_name_per_application() {
    assert_eq!(
        cookie(&application(), "v", 60),
        "__Host-rchat_proxy_p1=v; Path=/; Max-Age=60; Secure; HttpOnly; SameSite=Lax"
    );
    assert_eq!(
        cookie(&domain_level(), "v", 60),
        "rchat_proxy_p2=v; Domain=example.org; Path=/; Max-Age=60; Secure; HttpOnly; SameSite=Lax"
    );
}

fn accounts() -> Vec<Account> {
    let account = |uid, username: &str, deleted| Account {
        uid,
        username: username.to_string(),
        deleted,
    };
    vec![
        account(7, "alice", false),
        account(8, "dana", true),
        account(12, "dana", false),
    ]
}

#[test]
fn only_existing_accounts_can_be_listed_matching_is_by_uid_only() {
    let accounts = accounts();
    assert_eq!(pick_account(&accounts, "Alice"), Some(RuleEntry { uid: 7 }));
    assert_eq!(pick_account(&accounts, "nobody"), None);
    assert_eq!(pick_account(&accounts, "dana"), Some(RuleEntry { uid: 12 }));
    assert_eq!(pick_account(&accounts[..2], "dana"), None);
    assert_eq!(NO_ACCOUNT, "No account with that name");
    let entries = [RuleEntry { uid: 7 }, RuleEntry { uid: 8 }];
    assert_eq!(rule_summary(&entries), "2 people listed");
    assert_eq!(rule_summary(&entries[..1]), "1 person listed");
    assert_eq!(rule_summary(&[]), "0 people listed");
    assert!(matches(&entries, 7));
    assert!(!matches(&entries, 12));
    assert_eq!(
        entry_label(&RuleEntry { uid: 8 }, &accounts),
        "Deleted account"
    );
    assert_eq!(
        entry_label(&RuleEntry { uid: 99 }, &accounts),
        "Deleted account"
    );
    assert_eq!(entry_label(&RuleEntry { uid: 7 }, &accounts), "alice");
}

#[test]
fn the_protected_host_routes_only_the_browser_pages_a_check_with_its_host_is_refused() {
    let hosts = ["wiki.example.com"];
    for page in BROWSER_PATHS {
        assert_eq!(
            proxy_path(&format!("/_rchat/proxy/{page}"), "wiki.example.com", &hosts),
            Routed::Serve
        );
    }
    assert_eq!(
        BROWSER_PATHS,
        [
            "start",
            "callback",
            "sign_out",
            "denied",
            "needs_two_factor"
        ]
    );
    let path = |p: &str, host: &str| proxy_path(p, host, &hosts);
    assert_eq!(
        path("/_rchat/proxy/auth/nginx", "wiki.example.com"),
        Routed::Refuse
    );
    assert_eq!(
        path("/_rchat/proxy/auth/nginx", "WIKI.example.com"),
        Routed::Refuse
    );
    assert_eq!(
        path("/_rchat/proxy/auth/nginx", "rchat:3000"),
        Routed::Serve
    );
    assert_eq!(
        path("/_rchat/proxy/other", "wiki.example.com"),
        Routed::Refuse
    );
    assert_eq!(
        path("/_rchat/proxy/start/x", "wiki.example.com"),
        Routed::Refuse
    );
    assert_eq!(path("/_rchat/proxy/", "rchat:3000"), Routed::Refuse);
    assert_eq!(
        path("/_rchat/proxy/auth/nginx/x", "rchat:3000"),
        Routed::Refuse
    );
    assert_eq!(
        path("/_rchat/proxy/auth/Nginx", "rchat:3000"),
        Routed::Refuse
    );
    assert_eq!(path("/_rchat/proxy/auth/", "rchat:3000"), Routed::Refuse);
    assert_eq!(path("/elsewhere", "rchat:3000"), Routed::Refuse);
    for spelling in [
        "wiki.example.com:443",
        "wiki.example.com:8443",
        "wiki.example.com.",
        "WIKI.example.com.:80",
        "wiki.example.com:443:443",
        "wiki.example.com:8443:443",
        "WIKI.EXAMPLE.COM.:443:8443",
        "wiki.example.com:",
        "wiki.example.com:abc",
        "wiki.example.com:443x",
    ] {
        assert_eq!(
            path("/_rchat/proxy/auth/nginx", spelling),
            Routed::Refuse,
            "{spelling}"
        );
    }
    for internal in [
        "rchat",
        "10.0.0.5:3000",
        "[fd00::1]:3000",
        "[::1]",
        "rchat_web:3000",
    ] {
        assert_eq!(
            path("/_rchat/proxy/auth/nginx", internal),
            Routed::Serve,
            "{internal}"
        );
    }
    for odd in [
        "rchat:3000:3000",
        "",
        ":3000",
        "[::1]x",
        "[::1]:",
        "rchat:123456",
    ] {
        assert_eq!(
            path("/_rchat/proxy/auth/nginx", odd),
            Routed::Refuse,
            "{odd}"
        );
    }
    let ported = ["wiki.example.com:8443"];
    assert_eq!(
        proxy_path("/_rchat/proxy/auth/nginx", "wiki.example.com", &ported),
        Routed::Refuse
    );
    assert_eq!(
        proxy_path("/_rchat/proxy/auth/nginx", "rchat:8443", &ported),
        Routed::Serve
    );
    assert_eq!(
        proxy_path("/_rchat/proxy/auth/nginx", "notwiki.example.com", &hosts),
        Routed::Serve
    );
}

#[test]
fn the_assertion_is_never_printed() {
    let shown = format!("{:?}", identity());
    assert!(!shown.contains("eyJ"));
    assert!(shown.contains("zoë"));
}
