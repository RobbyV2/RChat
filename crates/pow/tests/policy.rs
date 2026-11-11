use std::net::IpAddr;

use rchat_pow::policy::{
    Action, FIELD_MAX, Gate, POLICY_MAX, Policy, PolicyError, Request, Verdict, Who,
};

const EXAMPLE: &str = include_str!("../examples/pow-policy.example.yaml");
const BROWSER: &str = "Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0";
const ENGLISH: &[(&str, &str)] = &[("Accept-Language", "en-GB,en;q=0.8")];
const NONE: &[(&str, &str)] = &[];

fn request<'a>(
    gate: Gate,
    ua: &'a str,
    headers: &'a [(&'a str, &'a str)],
    ip: &str,
) -> Request<'a> {
    Request {
        gate,
        method: "GET",
        path: "/",
        user_agent: ua,
        headers,
        remote: ip.parse::<IpAddr>().unwrap(),
    }
}

fn outcome<'a>(v: Verdict<'a>) -> (Option<Action>, Option<&'a str>, i32) {
    (v.action, v.rule, v.weight)
}

fn parse(yaml: &str) -> Policy {
    match Policy::parse(yaml) {
        Ok(p) => p,
        Err(e) => panic!("{e}"),
    }
}

fn refused(yaml: &str) -> PolicyError {
    match Policy::parse(yaml) {
        Ok(_) => panic!("parsed: {yaml}"),
        Err(e) => e,
    }
}

#[test]
fn the_example_file_parses_and_decides() {
    let p = parse(EXAMPLE);
    assert_eq!(
        p.names().collect::<Vec<_>>(),
        [
            "office-network",
            "known-ai-crawlers",
            "no-accept-language",
            "datacenter-ranges",
            "browsers"
        ]
    );
    let guest = Gate::Api(Who::Guest);
    for (gate, ua, headers, ip, want) in [
        (
            Gate::Pages,
            BROWSER,
            ENGLISH,
            "192.0.2.1",
            (Some(Action::Challenge), Some("browsers"), 0),
        ),
        (
            Gate::Pages,
            "GPTBot/1.2",
            ENGLISH,
            "192.0.2.1",
            (Some(Action::Deny), Some("known-ai-crawlers"), 0),
        ),
        (
            Gate::Pages,
            "GPTBot/1.2",
            ENGLISH,
            "203.0.113.200",
            (Some(Action::Allow), Some("office-network"), 0),
        ),
        (
            Gate::Pages,
            "curl/8.9",
            ENGLISH,
            "192.0.2.1",
            (None, None, 0),
        ),
        (
            Gate::Pages,
            BROWSER,
            NONE,
            "198.51.103.255",
            (Some(Action::Challenge), Some("browsers"), 16),
        ),
        (guest, BROWSER, ENGLISH, "192.0.2.1", (None, None, 0)),
        (guest, "GPTBot/1.2", ENGLISH, "192.0.2.1", (None, None, 0)),
        (
            guest,
            "curl/8.9",
            NONE,
            "2001:db8:42:7::1",
            (Some(Action::Allow), Some("office-network"), 0),
        ),
        (guest, "curl/8.9", NONE, "198.51.104.0", (None, None, 8)),
        (guest, "curl/8.9", NONE, "198.51.100.1", (None, None, 16)),
    ] {
        assert_eq!(
            outcome(p.eval(&request(gate, ua, headers, ip))),
            want,
            "{gate:?} {ua} {ip}"
        );
    }
}

#[test]
fn the_built_in_default_challenges_browsers_on_pages_only() {
    let p = Policy::builtin();
    assert_eq!(p.names().collect::<Vec<_>>(), ["browsers"]);
    let on = |gate, ua| outcome(p.eval(&request(gate, ua, &[], "192.0.2.1")));
    let challenge = (Some(Action::Challenge), Some("browsers"), 0);
    assert_eq!(on(Gate::Pages, BROWSER), challenge);
    assert_eq!(on(Gate::Pages, "Opera/9.80 (Windows NT 6.1)"), challenge);
    assert_eq!(on(Gate::Pages, "curl/8.9"), (None, None, 0));
    assert_eq!(on(Gate::Api(Who::Guest), BROWSER), (None, None, 0));
    assert_eq!(on(Gate::Api(Who::Account), BROWSER), (None, None, 0));
}

#[test]
fn rules_run_top_down_and_the_first_terminal_action_decides() {
    let p = parse(
        r#"
bots:
  - name: a
    path_regex: ^/
    action: WEIGH
    weight:
      adjust: 4
  - name: b
    path_regex: ^/
    action: WEIGH
    weight:
      adjust: -6
  - name: other-path
    path_regex: ^/elsewhere
    action: DENY
  - name: c
    path_regex: ^/
    action: CHALLENGE
  - name: d
    path_regex: ^/
    action: WEIGH
    weight:
      adjust: 32
  - name: e
    path_regex: ^/
    action: ALLOW
"#,
    );
    let at = |path| {
        outcome(p.eval(&Request {
            path,
            ..request(Gate::Pages, "x", &[], "192.0.2.1")
        }))
    };
    assert_eq!(at("/"), (Some(Action::Challenge), Some("c"), -2));
    assert_eq!(
        at("/elsewhere"),
        (Some(Action::Deny), Some("other-path"), -2)
    );
    let weights = parse(
        r#"
bots:
  - name: a
    path_regex: ^/
    action: WEIGH
    weight: { adjust: 64 }
  - name: b
    user_agent_regex: x
    action: WEIGH
    weight: { adjust: -64 }
  - name: c
    methods: [GET]
    action: WEIGH
    weight: { adjust: 5 }
"#,
    );
    let all = outcome(weights.eval(&request(Gate::Pages, "x", &[], "192.0.2.1")));
    assert_eq!(all, (None, None, 5), "no terminal rule: every WEIGH counts");
}

#[test]
fn a_pages_allow_never_exempts_an_api_request() {
    let p = parse(
        r#"
bots:
  - name: pages-by-default
    user_agent_regex: ^friendly
    action: ALLOW
  - name: pages
    scope: pages
    user_agent_regex: ^paged
    action: ALLOW
  - name: api
    scope: api
    user_agent_regex: ^script
    action: ALLOW
  - name: both
    scope: both
    user_agent_regex: ^office
    action: ALLOW
"#,
    );
    let on = |gate, ua| p.eval(&request(gate, ua, &[], "192.0.2.1")).action;
    let api = Gate::Api(Who::Account);
    assert_eq!(on(Gate::Pages, "friendly"), Some(Action::Allow));
    assert_eq!(on(api, "friendly"), None);
    assert_eq!(on(Gate::Pages, "paged"), Some(Action::Allow));
    assert_eq!(on(api, "paged"), None);
    assert_eq!(on(Gate::Pages, "script"), None);
    assert_eq!(on(api, "script"), Some(Action::Allow));
    assert_eq!(on(Gate::Pages, "office"), Some(Action::Allow));
    assert_eq!(on(api, "office"), Some(Action::Allow));
}

#[test]
fn every_matcher_of_a_rule_must_match() {
    let p = parse(
        r#"
bots:
  - name: all
    scope: api
    path_regex: ^/api/v1/servers$
    user_agent_regex: bot
    headers_regex:
      X-Kind: ^batch$
      Accept: json
    remote_addresses: ["10.0.0.0/8", "::ffff:192.0.2.0/120", "2001:db8::1"]
    methods: [post, PUT]
    who: guest
    action: DENY
"#,
    );
    let headers = [("x-kind", "batch"), ("ACCEPT", "application/json")];
    let full = Request {
        gate: Gate::Api(Who::Guest),
        method: "POST",
        path: "/api/v1/servers",
        user_agent: "a bot",
        headers: &headers,
        remote: "10.9.8.7".parse().unwrap(),
    };
    let denied = |r: Request| p.eval(&r).action == Some(Action::Deny);
    assert!(denied(full));
    assert!(denied(Request {
        method: "put",
        ..full
    }));
    for ip in [
        "192.0.2.77",
        "::ffff:192.0.2.77",
        "2001:db8::1",
        "::ffff:10.1.1.1",
    ] {
        assert!(
            denied(Request {
                remote: ip.parse().unwrap(),
                ..full
            }),
            "{ip}"
        );
    }
    assert!(!denied(Request {
        gate: Gate::Api(Who::Account),
        ..full
    }));
    assert!(!denied(Request {
        gate: Gate::Pages,
        ..full
    }));
    assert!(!denied(Request {
        method: "GET",
        ..full
    }));
    assert!(!denied(Request {
        path: "/api/v1/servers/x",
        ..full
    }));
    assert!(!denied(Request {
        user_agent: "a person",
        ..full
    }));
    assert!(!denied(Request {
        headers: &headers[..1],
        ..full
    }));
    assert!(!denied(Request {
        headers: &[("X-Kind", "batches"), headers[1]],
        ..full
    }));
    for ip in ["11.0.0.1", "192.0.3.1", "2001:db8::2"] {
        assert!(
            !denied(Request {
                remote: ip.parse().unwrap(),
                ..full
            }),
            "{ip}"
        );
    }
}

#[test]
fn a_missing_header_is_matched_as_empty() {
    let p = parse(
        r#"
bots:
  - name: no-language
    headers_regex:
      Accept-Language: ^$
    action: DENY
"#,
    );
    let with = |headers| {
        p.eval(&request(Gate::Pages, "x", headers, "192.0.2.1"))
            .action
    };
    assert_eq!(with(&[]), Some(Action::Deny));
    assert_eq!(with(&[("Accept", "text/html")]), Some(Action::Deny));
    assert_eq!(with(&[("accept-language", "")]), Some(Action::Deny));
    assert_eq!(with(&[("accept-language", "en")]), None);
    assert_eq!(
        with(&[("ACCEPT-LANGUAGE", "en"), ("Accept-Language", "")]),
        None,
        "the first value"
    );
}

#[test]
fn who_is_only_for_the_api_scope() {
    let rule = |scope: &str| {
        format!(
            "bots:\n  - name: guests\n{scope}    who: guest\n    action: WEIGH\n    weight:\n      adjust: 8\n"
        )
    };
    for scope in ["", "    scope: pages\n", "    scope: both\n"] {
        let e = refused(&rule(scope));
        assert_eq!(e.line, Some(2), "{e}");
        assert!(e.reason.contains("who needs scope: api"), "{e}");
    }
    let p = parse(&rule("    scope: api\n"));
    let weight = |gate| p.eval(&request(gate, "x", &[], "192.0.2.1")).weight;
    assert_eq!(weight(Gate::Api(Who::Guest)), 8);
    assert_eq!(weight(Gate::Api(Who::Account)), 0);
    assert_eq!(weight(Gate::Pages), 0);
    let e = refused("bots:\n  - name: x\n    scope: api\n    who: admin\n    action: DENY\n");
    assert_eq!(e.line, Some(4), "{e}");
}

#[test]
fn errors_name_the_line() {
    let ok = "bots:\n  - name: first\n    path_regex: ^/a\n    action: ALLOW\n";
    for (more, line, reason) in [
        (
            "  - name: second\n    path_regex: (\n    action: DENY\n",
            6,
            "path_regex",
        ),
        (
            "  - name: second\n    user_agent_regex: \"[z-a]\"\n    action: DENY\n",
            6,
            "user_agent_regex",
        ),
        (
            "  - name: second\n    headers_regex:\n      Accept: \"*\"\n    action: DENY\n",
            7,
            "Accept",
        ),
        (
            "  - name: second\n    action: BLOCK\n",
            6,
            "ALLOW, DENY, CHALLENGE or WEIGH",
        ),
        (
            "  - name: second\n    scope: site\n    action: DENY\n",
            6,
            "pages, api or both",
        ),
        (
            "  - name: second\n    remote_addresses: [\"10.0.0.0/8\", \"10.0.0.0/33\"]\n    action: DENY\n",
            6,
            "10.0.0.0/33",
        ),
        (
            "  - name: second\n    remote_addresses: [chat.example.com]\n    action: DENY\n",
            6,
            "chat.example.com",
        ),
        ("  - path_regex: ^/b\n    action: DENY\n", 5, "name"),
        ("  - name: second\n    path_regex: ^/b\n", 5, "action"),
        (
            "  - name: first\n    path_regex: ^/b\n    action: DENY\n",
            5,
            "first",
        ),
        ("  - name: \"\"\n    action: DENY\n", 5, "name"),
        ("  - name: second\n    action: WEIGH\n", 5, "weight.adjust"),
        (
            "  - name: second\n    action: WEIGH\n    weight:\n      adjust: 65\n",
            5,
            "-64 to 64",
        ),
        (
            "  - name: second\n    action: WEIGH\n    weight:\n      adjust: -65\n",
            5,
            "-64 to 64",
        ),
        (
            "  - name: second\n    action: DENY\n    weight:\n      adjust: 1\n",
            5,
            "only for WEIGH",
        ),
        (
            "  - name: second\n    action: DENY\n    expression: true\n",
            7,
            "expression",
        ),
        (
            "  - name: second\n    remote_addresses: [\"10.0.0.0/8\"\n    action: DENY\n",
            7,
            "did not find expected ',' or ']'",
        ),
        ("  - name: second\n\taction: DENY\n", 6, "tab character"),
        (
            "  - name: second\n    path_regex: ^/b\n    action: DENY\n  name: third\n",
            8,
            "did not find expected '-' indicator",
        ),
        (
            "  - name: second\n    action: DENY\n    action: ALLOW\n",
            5,
            "duplicate field `action`",
        ),
        (
            "  - name: second\n    weight: 4\n    action: WEIGH\n",
            6,
            "weight",
        ),
        (
            "  - name: second\n    methods: GET\n    action: DENY\n",
            6,
            "a list of methods",
        ),
        (
            "  - name: second\n    headers_regex: x\n    action: DENY\n",
            6,
            "header names with a regex each",
        ),
        ("  - second\n", 5, "expected a rule"),
        (
            "  - import: (data)/bots/ai-robots-txt.yaml\n",
            5,
            "imports are not supported; copy the rules in",
        ),
        (
            "  - name: second\n    import: (data)/crawlers/googlebot.yaml\n    action: ALLOW\n",
            5,
            "imports are not supported; copy the rules in",
        ),
    ] {
        let e = refused(&format!("{ok}{more}"));
        assert_eq!(e.line, Some(line), "{more:?}: {e}");
        assert!(e.reason.contains(reason), "{more:?}: {e}");
        assert_eq!(e.to_string(), format!("line {line}: {}", e.reason));
        assert!(!e.reason.contains(" at line "), "{e}");
    }
    for (yaml, line, reason) in [
        ("", 1, "missing field `bots`"),
        ("rules: []\n", 1, "unknown field `rules`"),
        ("bots:\n  name: x\n", 2, "expected a list of rules"),
        ("bots: 7\n", 1, "expected a list of rules"),
        ("- name: x\n", 1, "invalid type: sequence"),
        (
            "bots:\n  - name: a\n    path_regex: ^/\n    action: DENY\nthresholds: []\n",
            5,
            "unknown field `thresholds`",
        ),
    ] {
        let e = refused(yaml);
        assert_eq!(e.line, Some(line), "{yaml:?}: {e}");
        assert!(e.reason.contains(reason), "{yaml:?}: {e}");
    }
    for empty in ["bots: []\n", "bots:\n", "# nothing yet\nbots:\n"] {
        let e = refused(empty);
        assert!(
            e.reason.contains("the policy has no rules"),
            "{empty:?}: {e}"
        );
    }
}

#[test]
fn a_matcher_that_is_present_but_empty_is_refused() {
    for (field, written) in [
        ("remote_addresses", "    remote_addresses: []\n"),
        ("remote_addresses", "    remote_addresses:\n"),
        ("methods", "    methods: []\n"),
        ("methods", "    methods: [GET, \"\"]\n"),
        ("headers_regex", "    headers_regex: {}\n"),
        ("headers_regex", "    headers_regex:\n"),
        (
            "headers_regex.Accept",
            "    headers_regex:\n      Accept: \"\"\n",
        ),
        ("headers_regex", "    headers_regex:\n      \"\": json\n"),
        ("path_regex", "    path_regex: \"\"\n"),
        ("user_agent_regex", "    user_agent_regex: ''\n"),
    ] {
        for (scope, action) in [("both", "ALLOW"), ("pages", "DENY"), ("api", "CHALLENGE")] {
            for extra in ["", "    path_regex: ^/s/\n"] {
                let extra = match field {
                    "path_regex" => "",
                    _ => extra,
                };
                let yaml = format!(
                    "bots:\n  - name: other\n    path_regex: ^/x\n    action: DENY\n  - name: office\n    scope: {scope}\n{written}{extra}    action: {action}\n"
                );
                let e = refused(&yaml);
                assert_eq!(e.line, Some(5), "{written:?}: {e}");
                assert!(e.reason.contains("rule office"), "{written:?}: {e}");
                assert!(
                    e.reason.contains(&format!("{field} is empty")),
                    "{written:?}: {e}"
                );
            }
        }
    }
    let weigh = "bots:\n  - name: light\n    scope: both\n    remote_addresses: []\n    action: WEIGH\n    weight:\n      adjust: -64\n";
    assert!(refused(weigh).reason.contains("remote_addresses is empty"));
}

#[test]
fn an_allow_rule_with_an_empty_list_exempts_nobody() {
    let office = |addresses: &str| {
        format!(
            "bots:\n  - name: office\n    scope: both\n    remote_addresses: {addresses}\n    action: ALLOW\n  - name: browsers\n    user_agent_regex: Mozilla\n    action: CHALLENGE\n"
        )
    };
    let e = refused(&office("[]"));
    assert_eq!(
        e.to_string(),
        "line 2: bots[0]: rule office: remote_addresses is empty; a matcher must say what it matches"
    );
    let p = parse(&office("[\"203.0.113.0/24\"]"));
    let from = |gate, ip| p.eval(&request(gate, BROWSER, NONE, ip)).action;
    assert_eq!(
        from(Gate::Api(Who::Guest), "203.0.113.7"),
        Some(Action::Allow)
    );
    assert_eq!(from(Gate::Api(Who::Guest), "192.0.2.1"), None);
    assert_eq!(from(Gate::Pages, "192.0.2.1"), Some(Action::Challenge));
}

#[test]
fn a_rule_must_say_what_it_matches() {
    for action in [
        "ALLOW",
        "DENY",
        "CHALLENGE",
        "WEIGH\n    weight:\n      adjust: 8",
    ] {
        for scope in ["", "    scope: both\n", "    scope: api\n"] {
            let e = refused(&format!(
                "bots:\n  - name: everyone\n{scope}    action: {action}\n"
            ));
            assert_eq!(e.line, Some(2), "{e}");
            assert!(e.reason.contains("rule everyone: no matcher"), "{e}");
        }
    }
    for matcher in [
        "path_regex: ^/",
        "user_agent_regex: .",
        "headers_regex:\n      Accept: .",
        "remote_addresses: [\"0.0.0.0/0\", \"::/0\"]",
        "methods: [GET]",
        "scope: api\n    who: guest",
    ] {
        parse(&format!(
            "bots:\n  - name: everyone\n    {matcher}\n    action: DENY\n"
        ));
    }
}

#[test]
fn a_weight_is_minus_64_to_64_in_every_build() {
    let rule = |adjust: &str| {
        format!(
            "bots:\n  - name: w\n    path_regex: ^/\n    action: WEIGH\n    weight:\n      adjust: {adjust}\n"
        )
    };
    for ok in [-64, -1, 0, 1, 64] {
        let p = parse(&rule(&ok.to_string()));
        assert_eq!(
            p.eval(&request(Gate::Pages, "x", NONE, "192.0.2.1")).weight,
            ok
        );
    }
    for bad in ["-2147483648", "2147483647", "-65", "65", "-2147483647"] {
        let e = refused(&rule(bad));
        assert_eq!(e.line, Some(2), "{bad}: {e}");
        assert!(
            e.reason.contains("weight.adjust is -64 to 64"),
            "{bad}: {e}"
        );
    }
    for not_a_weight in [
        "-2147483649",
        "2147483648",
        "18446744073709551616",
        "1.5",
        "many",
        "\"\"",
    ] {
        let e = refused(&rule(not_a_weight));
        assert!(
            e.line.is_some() && e.reason.contains("weight"),
            "{not_a_weight}: {e}"
        );
    }
}

#[test]
fn a_request_with_a_field_over_8_kib_is_denied_unread() {
    let p = parse(
        r#"
bots:
  - name: office
    scope: both
    remote_addresses: ["203.0.113.0/24"]
    action: ALLOW
  - name: allow-path
    path_regex: ^/public/[a-z]*$
    action: ALLOW
  - name: allow-agent
    user_agent_regex: ^friendly
    action: ALLOW
  - name: lighter
    scope: both
    user_agent_regex: friendly
    action: WEIGH
    weight:
      adjust: -8
  - name: challenge-header
    scope: both
    headers_regex:
      X-Kind: ^browser$
    action: CHALLENGE
  - name: deny-private
    scope: both
    path_regex: ^/private
    action: DENY
"#,
    );
    let plain = request(Gate::Pages, "x", NONE, "192.0.2.1");
    let read = |r: Request| {
        let v = p.eval(&r);
        (v.action, v.rule, v.weight, v.cut)
    };
    let denied = (Some(Action::Deny), None, 0, true);
    let fits = format!("friendly{}", "a".repeat(FIELD_MAX - 8));
    assert_eq!(fits.len(), FIELD_MAX);
    assert_eq!(
        read(Request {
            user_agent: &fits,
            ..plain
        }),
        (Some(Action::Allow), Some("allow-agent"), 0, false),
        "a field of exactly 8 KiB is read whole"
    );
    let long = format!("friendly{}", "a".repeat(FIELD_MAX));
    assert_eq!(
        read(Request {
            user_agent: &long,
            ..plain
        }),
        denied,
        "padding wins no ALLOW and no negative weight"
    );
    let padded = format!("/public/{}/../private", "a".repeat(FIELD_MAX));
    assert_eq!(
        read(Request {
            path: &padded,
            ..plain
        }),
        denied,
        "an anchored ALLOW never sees a cut field"
    );
    assert_eq!(
        read(Request {
            path: "/public/abc",
            ..plain
        }),
        (Some(Action::Allow), Some("allow-path"), 0, false)
    );
    let kind = [("X-Kind", long.as_str())];
    assert_eq!(
        read(Request {
            path: "/private/keys",
            headers: &kind,
            ..plain
        }),
        denied,
        "a CHALLENGE rule before a DENY rule can't be padded into answering first"
    );
    assert_eq!(
        read(Request {
            path: "/private/keys",
            headers: &[("x-kind", "browser")],
            ..plain
        }),
        (Some(Action::Challenge), Some("challenge-header"), 0, false),
        "read whole, the rules run in their order"
    );
    let split = format!("{}\u{e9}", "a".repeat(FIELD_MAX - 1));
    assert_eq!(
        read(Request {
            user_agent: &split,
            ..plain
        }),
        denied
    );
    assert_eq!(
        read(Request {
            remote: "203.0.113.7".parse().unwrap(),
            user_agent: &long,
            ..plain
        }),
        denied,
        "whoever sends it"
    );
    let api = request(Gate::Api(Who::Account), "x", &kind, "192.0.2.1");
    assert_eq!(read(api), denied);
    assert_eq!(
        read(Request {
            headers: &[("X-Unread", long.as_str()), ("x-kind", "browser")],
            ..plain
        }),
        (Some(Action::Challenge), Some("challenge-header"), 0, false),
        "a header no rule reads may be any length"
    );
    let unread = parse("bots:\n  - name: paths\n    path_regex: ^/x\n    action: DENY\n");
    let v = unread.eval(&Request {
        user_agent: &long,
        headers: &kind,
        ..plain
    });
    assert_eq!(
        (v.action, v.cut),
        (None, false),
        "this policy reads only the path"
    );
}

#[test]
fn a_file_over_1_mib_is_refused_before_it_is_read() {
    let rule = "bots:\n  - name: a\n    path_regex: ^/\n    action: DENY\n";
    let padded = |bytes: usize| format!("{rule}#{}\n", "x".repeat(bytes - rule.len() - 2));
    assert_eq!(padded(POLICY_MAX).len(), POLICY_MAX);
    assert_eq!(parse(&padded(POLICY_MAX)).names().count(), 1);
    let e = refused(&padded(POLICY_MAX + 1));
    assert_eq!(
        (e.line, e.reason.as_str()),
        (None, "the policy file is over 1 MiB")
    );
    let started = std::time::Instant::now();
    let e = refused(&"[".repeat(4 * POLICY_MAX));
    assert_eq!(e.reason, "the policy file is over 1 MiB");
    assert!(started.elapsed().as_secs() < 2);
}

#[test]
fn a_regex_over_1000_characters_is_refused() {
    let rule = |n: usize| {
        format!(
            "bots:\n  - name: long\n    path_regex: {}\n    action: DENY\n",
            "a".repeat(n)
        )
    };
    parse(&rule(1000));
    let e = refused(&rule(1001));
    assert_eq!(e.line, Some(3), "{e}");
    assert!(e.reason.contains("1000 characters"), "{e}");
    let header = |n: usize| {
        format!(
            "bots:\n  - name: long\n    headers_regex:\n      X-Long: {}\n    action: DENY\n",
            "a".repeat(n)
        )
    };
    parse(&header(1000));
    assert_eq!(refused(&header(1001)).line, Some(4));
}

#[test]
fn more_than_1000_rules_are_refused() {
    let rules = |n: usize| {
        (0..n).fold(String::from("bots:\n"), |mut out, i| {
            out.push_str(&format!(
                "  - name: r{i}\n    path_regex: ^/{i}$\n    action: DENY\n"
            ));
            out
        })
    };
    let p = parse(&rules(1000));
    assert_eq!(p.names().count(), 1000);
    let last = Request {
        path: "/999",
        ..request(Gate::Pages, "x", &[], "192.0.2.1")
    };
    assert_eq!(
        outcome(p.eval(&last)),
        (Some(Action::Deny), Some("r999"), 0)
    );
    let e = refused(&rules(1001));
    assert_eq!(e.line, Some(3002), "{e}");
    assert!(e.reason.contains("1000 rules"), "{e}");
}

struct Lcg(u64);

impl Lcg {
    fn next(&mut self, below: usize) -> usize {
        self.0 = self
            .0
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        ((self.0 >> 33) as usize) % below
    }

    fn pick<'a>(&mut self, pool: &[&'a str]) -> &'a str {
        pool[self.next(pool.len())]
    }
}

struct Plain {
    name: String,
    scope: &'static str,
    path: Option<&'static str>,
    ua: Option<&'static str>,
    header: Option<(&'static str, &'static str)>,
    net: Option<&'static str>,
    method: Option<&'static str>,
    who: Option<&'static str>,
    action: &'static str,
    adjust: i32,
}

impl Plain {
    fn yaml(&self) -> String {
        let mut out = format!("  - name: {}\n    scope: {}\n", self.name, self.scope);
        if let Some(p) = self.path {
            out.push_str(&format!("    path_regex: '{p}'\n"));
        }
        if let Some(u) = self.ua {
            out.push_str(&format!("    user_agent_regex: '{u}'\n"));
        }
        if let Some((h, r)) = self.header {
            out.push_str(&format!("    headers_regex:\n      {h}: '{r}'\n"));
        }
        if let Some(n) = self.net {
            out.push_str(&format!("    remote_addresses: ['{n}']\n"));
        }
        if let Some(m) = self.method {
            out.push_str(&format!("    methods: [{m}]\n"));
        }
        if let Some(w) = self.who {
            out.push_str(&format!("    who: {w}\n"));
        }
        out.push_str(&format!("    action: {}\n", self.action));
        if self.action == "WEIGH" {
            out.push_str(&format!("    weight:\n      adjust: {}\n", self.adjust));
        }
        out
    }

    fn matches(&self, r: &Request) -> bool {
        let re = |src: &str, text: &str| regex::Regex::new(src).unwrap().is_match(text);
        let scope = match (r.gate, self.scope) {
            (Gate::Pages, "pages" | "both") | (Gate::Api(_), "api" | "both") => true,
            (_, _) => false,
        };
        let who = match (self.who, r.gate) {
            (None, _) => true,
            (Some("guest"), Gate::Api(Who::Guest)) => true,
            (Some("account"), Gate::Api(Who::Account)) => true,
            (Some(_), _) => false,
        };
        let net = self.net.is_none_or(|n| {
            let (addr, bits) = n.split_once('/').unwrap();
            let (IpAddr::V4(net), IpAddr::V4(ip)) = (addr.parse().unwrap(), r.remote) else {
                return false;
            };
            let shift = 32 - bits.parse::<u32>().unwrap();
            u64::from(u32::from(net)) >> shift == u64::from(u32::from(ip)) >> shift
        });
        scope
            && who
            && net
            && self.path.is_none_or(|p| re(p, r.path))
            && self.ua.is_none_or(|u| re(u, r.user_agent))
            && self.header.is_none_or(|(h, src)| {
                let value = r
                    .headers
                    .iter()
                    .find(|(name, _)| name.eq_ignore_ascii_case(h))
                    .map_or("", |(_, v)| v);
                re(src, value)
            })
            && self.method.is_none_or(|m| m.eq_ignore_ascii_case(r.method))
    }
}

fn rule_by_rule<'a>(rules: &'a [Plain], r: &Request) -> (Option<Action>, Option<&'a str>, i32) {
    let mut weight = 0;
    for rule in rules.iter().filter(|rule| rule.matches(r)) {
        let action = match rule.action {
            "ALLOW" => Action::Allow,
            "DENY" => Action::Deny,
            "CHALLENGE" => Action::Challenge,
            _ => {
                weight += rule.adjust;
                continue;
            }
        };
        return (Some(action), Some(rule.name.as_str()), weight);
    }
    (None, None, weight)
}

#[test]
fn the_regex_sets_decide_like_rule_by_rule_matching() {
    const PATHS: &[&str] = &[
        "^/$",
        "^/s/",
        "/admin",
        "\\.php$",
        "^/api/v1/(servers|dms)",
        "[0-9]{3}",
    ];
    const UAS: &[&str] = &["Mozilla|Opera", "(?i)bot", "^curl/", "Firefox/[0-9]+", "^$"];
    const HEADERS: &[(&str, &str)] = &[
        ("Accept-Language", "^$"),
        ("Accept-Language", "^en"),
        ("Accept", "text/html"),
        ("X-Requested-With", "."),
    ];
    const NETS: &[&str] = &[
        "10.0.0.0/8",
        "10.1.0.0/16",
        "192.0.2.0/24",
        "198.51.100.7/32",
        "0.0.0.0/0",
    ];
    const METHODS: &[&str] = &["GET", "POST", "DELETE"];
    const ACTIONS: &[&str] = &[
        "WEIGH",
        "WEIGH",
        "WEIGH",
        "WEIGH",
        "WEIGH",
        "WEIGH",
        "ALLOW",
        "DENY",
        "CHALLENGE",
    ];
    let mut rng = Lcg(7);
    let rules: Vec<Plain> = (0..40)
        .map(|i| {
            let scope = rng.pick(&["pages", "api", "both"]);
            let must = rng.next(4);
            let mut field = |n: usize, pool: &[&'static str]| {
                (n == must || rng.next(4) == 0).then(|| pool[rng.next(pool.len())])
            };
            let (path, ua, net) = (field(0, PATHS), field(1, UAS), field(2, NETS));
            let method = field(9, METHODS);
            let who = match scope {
                "api" => field(9, &["guest", "account"]),
                _ => None,
            };
            Plain {
                name: format!("r{i}"),
                scope,
                path,
                ua,
                header: (must == 3 || rng.next(4) == 0).then(|| HEADERS[rng.next(HEADERS.len())]),
                net,
                method,
                who,
                action: rng.pick(ACTIONS),
                adjust: rng.next(129) as i32 - 64,
            }
        })
        .collect();
    let yaml = rules
        .iter()
        .fold(String::from("bots:\n"), |out, r| out + &r.yaml());
    let policy = parse(&yaml);

    const REQ_PATHS: &[&str] = &[
        "/",
        "/s/lobby/",
        "/admin/login.php",
        "/api/v1/servers",
        "/api/v1/dms/404",
        "/x",
    ];
    const REQ_UAS: &[&str] = &[BROWSER, "Opera/9.80", "GPTBot/1.2", "curl/8.9", "", "robot"];
    const REQ_LANGS: &[&str] = &["", "en-GB", "de"];
    const REQ_IPS: &[&str] = &[
        "10.1.2.3",
        "10.200.0.1",
        "192.0.2.9",
        "198.51.100.7",
        "203.0.113.1",
        "2001:db8::1",
    ];
    const REQ_METHODS: &[&str] = &["GET", "POST", "DELETE", "PATCH"];
    let (mut terminal, mut weighed) = (0, 0);
    for i in 0..1000 {
        let lang = rng.pick(REQ_LANGS);
        let mut headers = Vec::new();
        if rng.next(2) == 0 {
            headers.push(("accept-language", lang));
        }
        if rng.next(2) == 0 {
            headers.push(("Accept", "text/html,application/xhtml+xml"));
        }
        if rng.next(4) == 0 {
            headers.push(("X-Requested-With", "XMLHttpRequest"));
        }
        let r = Request {
            gate: [Gate::Pages, Gate::Api(Who::Guest), Gate::Api(Who::Account)][rng.next(3)],
            method: rng.pick(REQ_METHODS),
            path: rng.pick(REQ_PATHS),
            user_agent: rng.pick(REQ_UAS),
            headers: &headers,
            remote: rng.pick(REQ_IPS).parse().unwrap(),
        };
        let want = rule_by_rule(&rules, &r);
        assert_eq!(outcome(policy.eval(&r)), want, "request {i}: {r:?}");
        terminal += usize::from(want.0.is_some());
        weighed += usize::from(want.2 != 0);
    }
    assert!(
        terminal > 100 && terminal < 1000 && weighed > 100,
        "{terminal} {weighed}"
    );
}
