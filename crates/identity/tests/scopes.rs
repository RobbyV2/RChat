use std::collections::{BTreeMap, BTreeSet};

use rchat_identity::scopes::{
    A_SITE_ADMIN, ACTIVITY_PER_APPLICATION, ACTIVITY_PER_GRANT, ActivityKeep, ApplicationScopes,
    Ask, AuditRow, Diff, FORBIDDEN_CLAIMS, Grant, Level, MediaPlace, Need, Outcome, PersonView,
    Pick, PickedRoles, Proof, Required, SCOPES, SECURITY_CONTROLS, ServerFact, Servers,
    TokenAnswer, Use, UsePlace, Visibility, activity_keep, admin_patch_allowed, all_scopes,
    as_person, audit_for_token, clean_picks, consent_order, covers, default_picks, default_ticked,
    diff, granted, group_values, is_never, is_optional, media_ok, normalize_ticks, not_offered,
    per_server, personal_allowed, proof_counts, received, report_evidence_shown, required_for,
    scope_def, scope_for, scope_token_ok, search_servers, token_route, uniform_404,
};

fn set(items: &[&str]) -> BTreeSet<String> {
    items.iter().map(|s| s.to_string()).collect()
}

fn list(items: &[&str]) -> Vec<String> {
    items.iter().map(|s| s.to_string()).collect()
}

fn everything() -> BTreeSet<String> {
    set(&all_scopes())
}

fn plain() -> Use {
    Use::default()
}

fn own(own_target: bool) -> Use {
    Use {
        own_target,
        ..Use::default()
    }
}

fn dm() -> Use {
    Use {
        place: Some(UsePlace::Dm),
        ..Use::default()
    }
}

fn logs(logs_content: bool) -> Use {
    Use {
        logs_content,
        ..Use::default()
    }
}

fn needs(scopes: &[&'static str]) -> Option<Required> {
    Some(Required::Scopes(scopes.to_vec()))
}

fn ok(grant: &[&str], method: &str, path: &str, ctx: &Use) -> bool {
    token_route(&set(grant), method, path, ctx) == TokenAnswer::Ok
}

fn outcome(status: u16, body: &str) -> Outcome {
    Outcome {
        status,
        body: body.to_string(),
    }
}

#[test]
fn part_1_is_the_simple_list_part_2_the_api_in_plain_words() {
    let part = |n: u8| -> Vec<&str> {
        SCOPES
            .iter()
            .filter(|s| s.part == n)
            .map(|s| s.scope)
            .collect()
    };
    assert_eq!(
        part(1),
        [
            "openid",
            "profile",
            "servers",
            "servers.members.read",
            "servers.join",
            "webhook.incoming",
            "offline_access"
        ]
    );
    assert_eq!(
        part(2),
        [
            "admin",
            "encrypted.read",
            "encrypted.send",
            "messages.send",
            "dms.send",
            "moderation",
            "dms.read",
            "messages.read",
            "servers.read",
            "servers.manage",
            "friends",
            "files",
            "calls",
            "realtime",
            "account",
        ]
    );
    for s in &SCOPES {
        assert!(s.line.bytes().all(|b| (0x20..=0x7e).contains(&b)));
        assert!(!s.line.contains("RChat"));
        assert!(s.line.len() <= 70);
        assert!(scope_token_ok(s.scope));
    }
    assert_eq!(all_scopes().len(), 22);
    assert_eq!(
        per_server(),
        [
            "servers.members.read",
            "messages.send",
            "moderation",
            "messages.read",
            "servers.read",
            "servers.manage",
            "calls"
        ]
    );
    assert_eq!(scope_def("servers").unwrap().servers, Servers::Pick);
    assert_eq!(scope_def("servers.join").unwrap().servers, Servers::Join);
    assert_eq!(
        scope_def("webhook.incoming").unwrap().servers,
        Servers::Channel
    );
    assert_eq!(scope_def("encrypted.read").unwrap().servers, Servers::Chats);
    assert!(scope_def("encrypted.send").unwrap().from_client);
    assert!(!scope_def("admin").unwrap().from_client);
    assert_eq!(scope_def("friends").unwrap().servers, Servers::None);
    assert!(scope_def("email").is_none());
}

#[test]
fn no_email_no_bots() {
    for bad in ["email", "bot", "applications.commands"] {
        assert!(!all_scopes().contains(&bad));
    }
    assert_eq!(not_offered("bot"), Some("RChat has no bots"));
    assert_eq!(not_offered("email"), Some("RChat has no email"));
    assert_eq!(not_offered("openid"), None);
}

#[test]
fn the_strongest_come_first_admin_is_shown_only_on_a_site_admins_own_screen() {
    let asked = [
        "openid",
        "profile",
        "messages.read",
        "dms.send",
        "admin",
        "servers",
    ];
    let admin = consent_order(&asked, true);
    assert_eq!(admin[0].group, "Strongest");
    let lines = |i: usize, admin: bool| -> Vec<&str> {
        consent_order(&asked, admin)[i]
            .lines
            .iter()
            .map(|l| l.scope)
            .collect()
    };
    assert_eq!(lines(0, true), ["admin", "dms.send"]);
    assert_eq!(lines(0, false), ["dms.send"]);
    let groups: Vec<&str> = admin.iter().map(|g| g.group).collect();
    assert_eq!(groups, ["Strongest", "You", "Servers", "Messages"]);
    for s in ["admin", "encrypted.read", "encrypted.send"] {
        assert!(scope_def(s).unwrap().step_up);
    }
    assert!(!scope_def("dms.send").unwrap().step_up);
    assert_eq!(
        scope_def("admin").unwrap().line,
        "Run this site as its admin. This tells the app you are one"
    );
    assert!(consent_order(&[] as &[&str], true).is_empty());
}

#[test]
fn the_join_line_says_it_leaves_too() {
    assert_eq!(
        scope_def("servers.join").unwrap().line,
        "Join and leave servers for you"
    );
}

#[test]
fn openid_and_profile_are_always_required_admin_is_always_optional() {
    let application = ApplicationScopes {
        allowed: list(&["openid", "profile", "servers", "messages.read", "admin"]),
        optional: list(&["servers", "profile"]),
    };
    assert!(is_optional(&application, "servers"));
    assert!(!is_optional(&application, "profile"));
    assert!(!is_optional(&application, "messages.read"));
    assert!(is_optional(&application, "admin"));
}

#[test]
fn scope_tokens_are_checked_for_syntax_first() {
    assert!(scope_token_ok("servers.join"));
    assert!(!scope_token_ok("zoë"));
    assert!(!scope_token_ok("a\"b"));
    assert!(!scope_token_ok("a\\b"));
    assert!(!scope_token_ok("a b"));
    assert!(!scope_token_ok(""));
    assert!(scope_token_ok(&"a".repeat(64)));
    assert!(!scope_token_ok(&"a".repeat(65)));
    assert!(scope_token_ok("!#[]~"));
}

#[test]
fn the_strongest_optional_permissions_start_unticked_admin_never_ticked() {
    for s in &SCOPES {
        assert_eq!(default_ticked(s.scope), !s.strong);
    }
    assert!(!default_ticked("admin"));
    assert!(default_ticked("servers"));
}

#[test]
fn any_per_server_permission_ticks_servers_so_names_are_shown_only_under_it() {
    assert!(
        granted(&["openid", "profile", "messages.read"], false, false, false)
            .contains(&"servers".to_string())
    );
    assert!(
        !granted(&["openid", "profile", "friends"], false, false, false)
            .contains(&"servers".to_string())
    );
    assert_eq!(
        normalize_ticks(&["openid", "calls", "openid"]),
        ["openid", "calls", "servers"]
    );
    assert_eq!(normalize_ticks(&["servers", "calls"]), ["servers", "calls"]);
}

#[test]
fn admin_is_granted_only_to_a_site_admin_for_a_marked_application_with_the_control_on() {
    let t = ["openid", "profile", "admin"];
    assert!(granted(&t, true, true, true).contains(&"admin".to_string()));
    assert_eq!(granted(&t, false, true, true), ["openid", "profile"]);
    assert_eq!(granted(&t, true, false, true), ["openid", "profile"]);
    assert_eq!(granted(&t, true, true, false), ["openid", "profile"]);
}

#[test]
fn the_activity_trail_is_capped_per_grant_and_per_application() {
    assert_eq!(activity_keep(0, 0), ActivityKeep::Detail);
    assert_eq!(
        activity_keep(ACTIVITY_PER_GRANT, 0),
        ActivityKeep::FoldOldest
    );
    assert_eq!(
        activity_keep(5, ACTIVITY_PER_APPLICATION),
        ActivityKeep::CountsOnly
    );
    assert_eq!(
        (ACTIVITY_PER_GRANT, ACTIVITY_PER_APPLICATION),
        (10_000, 1_000_000)
    );
}

const NEVER_ROUTES: [(&str, &str); 38] = [
    ("POST", "/me/password"),
    ("PUT", "/me/recovery"),
    ("POST", "/me/two_factor/totp"),
    ("DELETE", "/me/two_factor"),
    ("GET", "/me/sessions"),
    ("DELETE", "/me/trusted_devices"),
    ("GET", "/me/grants"),
    ("DELETE", "/me/grants/3"),
    ("POST", "/me/tokens"),
    ("GET", "/me/protections"),
    ("POST", "/me/sso/link"),
    ("POST", "/auth/login"),
    ("POST", "/auth/logout"),
    ("POST", "/applications"),
    ("POST", "/oauth/register"),
    ("POST", "/oauth/device"),
    ("POST", "/identity/p2p_binding"),
    ("PUT", "/me/p2p_backup/x"),
    ("POST", "/config_shares"),
    ("PUT", "/e2ee/me/identity"),
    ("POST", "/e2ee/devices"),
    ("POST", "/e2ee/application_devices"),
    ("PUT", "/e2ee/application_devices/d1/chats"),
    ("POST", "/e2ee/devices/d1/approve"),
    ("POST", "/e2ee/groups/g1/history"),
    ("GET", "/e2ee/backup"),
    ("POST", "/admin/users"),
    ("POST", "/admin/users/batch"),
    ("POST", "/admin/users/bob/temp_password"),
    ("POST", "/admin/users/bob/two_factor/reset"),
    ("DELETE", "/admin/users/bob/recovery"),
    ("DELETE", "/admin/users/bob/protections"),
    ("POST", "/admin/users/bob/sign_out"),
    ("POST", "/admin/site_admins"),
    ("GET", "/admin/e2ee/compliance/export"),
    ("GET", "/admin/export"),
    ("POST", "/admin/oauth/keys"),
    ("PATCH", "/admin/applications/a1"),
];

#[test]
fn no_permission_alone_or_all_together_reaches_any_never_route() {
    for (m, p) in NEVER_ROUTES {
        assert!(is_never(m, p), "{m} {p}");
        assert_eq!(scope_for(m, p, &plain()), Some(Need::Never), "{m} {p}");
        assert_eq!(
            token_route(&everything(), m, p, &plain()),
            TokenAnswer::InsufficientScope
        );
        for s in all_scopes() {
            assert!(!ok(&[s], m, p, &plain()), "{s} {m} {p}");
        }
    }
    for (m, p) in [
        ("GET", "/admin/exports/3"),
        ("GET", "/admin/brand"),
        ("PATCH", "/admin/users/bob/policy"),
        ("GET", "/oauth/requests/h1"),
        ("POST", "/oauth/par"),
        ("GET", "/applications/a1/audit"),
        ("DELETE", "/e2ee/application_devices/d1"),
        ("POST", "/e2ee/devices/d1/revoke"),
        ("POST", "/e2ee/devices/d1/bind"),
        ("DELETE", "/me/delete"),
    ] {
        assert!(is_never(m, p), "{m} {p}");
    }
    for (m, p) in [
        ("GET", "/admin/users"),
        ("GET", "/e2ee/devices"),
        ("GET", "/e2ee/groups/g1/history"),
        ("GET", "/me"),
        ("GET", "/me/passwords"),
        ("POST", "/oauth/device_authorization"),
        ("GET", "/authx/"),
        ("GET", "/application"),
    ] {
        assert!(!is_never(m, p), "{m} {p}");
    }
    assert_eq!(
        TokenAnswer::InsufficientScope.status(),
        Some((403, "insufficient_scope"))
    );
    assert_eq!(TokenAnswer::Ok.status(), None);
}

#[test]
fn no_claim_ever_tells_who_is_a_site_admin_or_carries_an_email() {
    let r = received(&all_scopes());
    for c in FORBIDDEN_CLAIMS {
        assert!(!r.claims.contains(&c));
    }
    assert_eq!(
        r.claims,
        [
            "sub",
            "preferred_username",
            "name",
            "picture",
            "updated_at",
            "rchat_instance",
            "groups",
            "rchat_servers"
        ]
    );
    assert!(r.refresh);
    let small = received(&["openid", "profile"]);
    assert_eq!(small.scope, "openid profile");
    assert!(!small.refresh);
    assert_eq!(received(&[] as &[&str]).claims, [] as [&str; 0]);
}

fn hidden_view() -> PersonView {
    PersonView {
        plain: uniform_404(),
        staff: outcome(200, "server detail"),
    }
}

#[test]
fn without_admin_a_token_gets_the_plain_member_answer_whoever_the_person_is() {
    let view = hidden_view();
    assert_eq!(
        as_person(&view, &set(&["servers.read"]), true, Some("hidden"), None),
        uniform_404()
    );
    assert_eq!(
        as_person(
            &view,
            &set(&["servers.read", "admin"]),
            true,
            Some("hidden"),
            None
        )
        .status,
        200
    );
    assert_eq!(
        uniform_404(),
        outcome(404, "Server not found or wrong password")
    );
}

#[test]
fn narrowing_is_the_persons_choice_a_missing_permission_is_403() {
    let open = PersonView {
        plain: outcome(200, "ok"),
        staff: outcome(200, "ok"),
    };
    assert_eq!(
        as_person(
            &open,
            &set(&["servers.read"]),
            true,
            Some("eng"),
            Some(&set(&["lobby"]))
        ),
        uniform_404()
    );
    assert_eq!(
        as_person(
            &open,
            &set(&["servers.read"]),
            true,
            Some("lobby"),
            Some(&set(&["lobby"]))
        ),
        outcome(200, "ok")
    );
    assert_eq!(
        as_person(&hidden_view(), &set(&[]), false, None, None),
        outcome(403, "insufficient_scope")
    );
}

#[test]
fn declared_routes_map_to_their_permission_undeclared_ones_are_refused() {
    let one = |m, p| scope_for(m, p, &plain());
    assert_eq!(one("GET", "/me"), Some(Need::Scope("account")));
    assert_eq!(
        one("POST", "/channels/12/messages"),
        Some(Need::Scope("messages.send"))
    );
    assert_eq!(
        one("POST", "/servers/lobby/join"),
        Some(Need::Scope("servers.join"))
    );
    assert_eq!(
        one("POST", "/servers/lobby/leave"),
        Some(Need::Scope("servers.join"))
    );
    assert_eq!(one("GET", "/ws"), Some(Need::Scope("realtime")));
    assert_eq!(one("DELETE", "/unknown/route"), None);
    assert!(!ok(&all_scopes(), "DELETE", "/unknown/route", &plain()));
    assert_eq!(one("GET", "/oauth/servers"), Some(Need::Scope("servers")));
    assert_eq!(
        one("GET", "/oauth/servers/lobby/member"),
        Some(Need::Scope("servers.members.read"))
    );
    assert_eq!(one("GET", "/me/servers"), Some(Need::Scope("servers")));
    for path in [
        "/servers/lobby",
        "/servers/lobby/members",
        "/servers/lobby/channels",
        "/servers/lobby/roles",
        "/servers/lobby/interacted",
        "/users/bob/profile",
        "/users/bob/card",
    ] {
        assert_eq!(
            one("GET", path),
            Some(Need::Scope("servers.read")),
            "{path}"
        );
    }
    assert_eq!(one("GET", "/servers/lobby/secrets"), None);
    assert_eq!(one("GET", "/servers/"), None);
    assert_eq!(one("POST", "/servers"), Some(Need::Scope("servers.manage")));
    assert_eq!(
        one("PATCH", "/servers/lobby"),
        Some(Need::Scope("servers.manage"))
    );
    for path in [
        "/servers/lobby/channels",
        "/servers/lobby/roles",
        "/servers/lobby/webhooks",
    ] {
        assert_eq!(one("POST", path), Some(Need::Scope("servers.manage")));
    }
    for path in [
        "/servers/lobby/kick",
        "/servers/lobby/bans",
        "/servers/lobby/timeouts",
        "/messages/bulk_delete",
    ] {
        assert_eq!(one("POST", path), Some(Need::Scope("moderation")));
    }
    assert_eq!(
        one("GET", "/servers/lobby/reports"),
        Some(Need::Scope("moderation"))
    );
    assert_eq!(
        one("GET", "/servers/lobby/reports/12"),
        Some(Need::Scope("moderation"))
    );
    assert_eq!(one("GET", "/servers/lobby/reports/x"), None);
    for path in ["/channels/1/messages", "/search", "/inbox", "/media/abc"] {
        assert_eq!(one("GET", path), Some(Need::Scope("messages.read")));
    }
    assert_eq!(one("GET", "/channels/x/messages"), None);
    assert_eq!(
        one("PUT", "/messages/5/reactions/x"),
        Some(Need::Scope("messages.send"))
    );
    assert_eq!(one("GET", "/dms"), Some(Need::Scope("dms.read")));
    assert_eq!(one("GET", "/dms/4/messages"), Some(Need::Scope("dms.read")));
    assert_eq!(one("POST", "/dms"), Some(Need::Scope("dms.send")));
    assert_eq!(
        one("POST", "/dms/4/messages"),
        Some(Need::Scope("dms.send"))
    );
    assert_eq!(one("GET", "/dms/4"), None);
    assert_eq!(one("GET", "/friends"), Some(Need::Scope("friends")));
    assert_eq!(one("GET", "/friends/summary"), Some(Need::Scope("friends")));
    assert_eq!(
        one("POST", "/friends/requests"),
        Some(Need::Scope("friends"))
    );
    assert_eq!(one("POST", "/blocks"), Some(Need::Scope("friends")));
    assert_eq!(one("POST", "/media"), Some(Need::Scope("files")));
    assert_eq!(one("GET", "/p2p/ice"), Some(Need::Scope("calls")));
    for path in [
        "/admin/users",
        "/admin/servers",
        "/admin/overview",
        "/admin/audit",
        "/admin/config",
        "/admin/protections",
    ] {
        assert_eq!(one("GET", path), Some(Need::Scope("admin")));
    }
    assert_eq!(one("PATCH", "/admin/settings"), Some(Need::Scope("admin")));
    assert_eq!(
        one("DELETE", "/admin/servers/lobby"),
        Some(Need::Scope("admin"))
    );
    assert_eq!(
        one("DELETE", "/admin/messages/9"),
        Some(Need::Scope("admin"))
    );
    assert_eq!(one("DELETE", "/admin/messages/x"), None);
    assert_eq!(one("POST", "/admin/ban"), Some(Need::Scope("admin")));
    assert_eq!(one("get", "/me"), None);
}

#[test]
fn two_uses_two_permissions_own_deletes_are_messages_send_others_are_moderation() {
    let rf = required_for;
    assert_eq!(
        rf("DELETE", "/messages/5", &own(true)),
        needs(&["messages.send"])
    );
    assert_eq!(
        rf("DELETE", "/messages/5", &own(false)),
        needs(&["moderation"])
    );
    assert_eq!(
        rf("PATCH", "/messages/5", &own(false)),
        Some(Required::Never)
    );
    assert_eq!(
        rf("PATCH", "/messages/5", &own(true)),
        needs(&["messages.send"])
    );
    assert_eq!(
        rf("PUT", "/messages/5/pin", &plain()),
        needs(&["moderation"])
    );
    assert_eq!(
        rf("DELETE", "/messages/5/pin", &plain()),
        needs(&["moderation"])
    );
    assert_eq!(rf("PUT", "/messages/5/pin", &dm()), needs(&["dms.send"]));
    assert_eq!(
        rf("DELETE", "/messages/5/reactions/x/bob", &own(false)),
        needs(&["moderation"])
    );
    assert_eq!(
        rf("DELETE", "/messages/5/reactions/x/alice", &own(true)),
        needs(&["messages.send"])
    );
    assert_eq!(
        rf("DELETE", "/messages/5/embeds/0", &own(true)),
        needs(&["messages.send"])
    );
    assert_eq!(
        rf("DELETE", "/messages/5/embeds/0", &own(false)),
        needs(&["moderation"])
    );
    let own_dm = Use {
        own_target: true,
        place: Some(UsePlace::Dm),
        logs_content: false,
    };
    assert_eq!(rf("DELETE", "/messages/5", &own_dm), needs(&["dms.send"]));
    assert_eq!(rf("DELETE", "/messages/5", &dm()), Some(Required::Never));
    assert_eq!(rf("PATCH", "/messages/5", &own_dm), needs(&["dms.send"]));
    assert_eq!(rf("DELETE", "/messages/x", &own(true)), None);
    let server = Use {
        place: Some(UsePlace::Server),
        ..own(true)
    };
    assert_eq!(
        rf("DELETE", "/messages/5", &server),
        needs(&["messages.send"])
    );
}

#[test]
fn copying_content_out_needs_the_matching_read_permission() {
    let rf = required_for;
    assert_eq!(
        rf("POST", "/servers/lobby/outgoing_webhooks", &plain()),
        needs(&["servers.manage", "messages.read"])
    );
    assert_eq!(
        rf("DELETE", "/servers/lobby/outgoing_webhooks/3", &plain()),
        needs(&["servers.manage", "messages.read"])
    );
    assert_eq!(
        rf("GET", "/servers/lobby/outgoing_webhooks", &plain()),
        None
    );
    assert_eq!(
        rf("POST", "/servers/lobby/automations", &logs(true)),
        needs(&["servers.manage", "messages.read"])
    );
    assert_eq!(
        rf("POST", "/servers/lobby/automations", &logs(false)),
        needs(&["servers.manage"])
    );
    assert!(!ok(
        &["servers.manage"],
        "POST",
        "/servers/lobby/outgoing_webhooks",
        &plain()
    ));
    assert!(ok(
        &["servers.manage", "messages.read"],
        "POST",
        "/servers/lobby/outgoing_webhooks",
        &plain()
    ));
    assert!(!ok(
        &["servers.manage"],
        "POST",
        "/servers/lobby/automations",
        &logs(true)
    ));
    assert_eq!(
        rf("GET", "/bulk/servers/lobby/messages", &plain()),
        needs(&["messages.read"])
    );
    assert_eq!(
        rf("GET", "/bulk/dms/4/messages", &plain()),
        needs(&["dms.read"])
    );
}

#[test]
fn the_application_devices_own_routes_sit_under_encrypted_read() {
    for (m, p) in [
        ("POST", "/e2ee/devices/abc/keypackages"),
        ("GET", "/e2ee/users/bob/devices"),
        ("GET", "/e2ee/groups/g1"),
        ("GET", "/e2ee/groups/g1/group_info"),
        ("GET", "/e2ee/groups/g1/handshakes"),
        ("GET", "/e2ee/groups/g1/tree"),
        ("GET", "/e2ee/groups/g1/history"),
        ("GET", "/e2ee/groups/g1/members"),
        ("GET", "/e2ee/welcomes"),
        ("DELETE", "/e2ee/welcomes/w1"),
        ("GET", "/e2ee/spaces/s1"),
        ("GET", "/e2ee/spaces/s1/notices"),
        ("GET", "/e2ee/spaces/s1/groups"),
        ("POST", "/e2ee/groups/g1/external_commit"),
        ("POST", "/e2ee/groups/g1/self_update"),
        ("POST", "/e2ee/groups/g1/commit"),
        ("POST", "/e2ee/groups/g1/leave"),
        ("POST", "/e2ee/groups/g1/rejoin"),
        ("POST", "/e2ee/groups/g1/problem"),
    ] {
        assert_eq!(
            scope_for(m, p, &plain()),
            Some(Need::Scope("encrypted.read")),
            "{m} {p}"
        );
    }
}

#[test]
fn the_simple_list_then_the_whole_api_in_plain_words_the_never_list_holds() {
    assert_eq!(SCOPES.iter().filter(|s| s.part == 1).count(), 7);
    assert_eq!(SCOPES.iter().filter(|s| s.part == 2).count(), 15);
    assert!(!ok(&all_scopes(), "POST", "/me/password", &plain()));
    assert_eq!(
        scope_for("POST", "/channels/1/messages", &plain()),
        Some(Need::Scope("messages.send"))
    );
    assert!(!personal_allowed(
        "GET",
        "/oauth/servers",
        Level::Write,
        false
    ));
}

type Route = (&'static str, String, Use);

fn routes(server: &str) -> Vec<Route> {
    vec![
        ("GET", format!("/servers/{server}"), plain()),
        ("GET", format!("/servers/{server}/members"), plain()),
        ("GET", format!("/servers/{server}/channels"), plain()),
        ("GET", "/channels/1/messages".to_string(), plain()),
        ("POST", format!("/servers/{server}/bans"), plain()),
        ("DELETE", "/messages/9".to_string(), own(false)),
        ("POST", format!("/servers/{server}/join"), plain()),
    ]
}

const SERVERS: [(&str, bool); 3] = [("lobby", false), ("hidden", true), ("eng", false)];

fn view(route: &str, server: &str, password: bool, member_of: &[&str]) -> PersonView {
    let member = member_of.contains(&server);
    PersonView {
        plain: match member && !password {
            true => outcome(200, &format!("{route} as member of {server}")),
            false => uniform_404(),
        },
        staff: outcome(200, &format!("{route} with staff powers in {server}")),
    }
}

fn walk(
    is_site_admin: bool,
    grant: &BTreeSet<String>,
    member_of: &[&str],
    picked: Option<&BTreeSet<String>>,
) -> Vec<Outcome> {
    let mut out = Vec::new();
    for (server, password) in SERVERS {
        for (method, path, ctx) in routes(server) {
            let route_ok = token_route(grant, method, &path, &ctx) == TokenAnswer::Ok;
            let v = view(&format!("{method} {path}"), server, password, member_of);
            let own_session = match is_site_admin {
                true => v,
                false => PersonView {
                    staff: v.plain.clone(),
                    plain: v.plain,
                },
            };
            out.push(as_person(
                &own_session,
                grant,
                route_ok,
                Some(server),
                picked,
            ));
        }
    }
    out
}

#[test]
fn a_site_admins_token_and_a_non_admins_with_identical_memberships_answer_the_same() {
    let grant: BTreeSet<String> = everything().into_iter().filter(|s| s != "admin").collect();
    let lobby = set(&["lobby"]);
    for picked in [None, Some(&lobby)] {
        let admin = walk(true, &grant, &["lobby"], picked);
        assert_eq!(admin, walk(false, &grant, &["lobby"], picked));
        assert_eq!(admin.len(), 21);
        assert!(admin.iter().any(|o| o.status == 200));
        assert!(admin.iter().any(|o| *o == uniform_404()));
    }
    let with_admin = walk(true, &everything(), &["lobby"], None);
    assert_ne!(with_admin, walk(false, &everything(), &["lobby"], None));
}

#[test]
fn servers_read_on_a_password_protected_server_the_uniform_404_for_an_admins_token_too() {
    let v = view("GET /servers/hidden", "hidden", true, &["lobby"]);
    assert_eq!(
        as_person(&v, &set(&["servers.read"]), true, Some("hidden"), None),
        uniform_404()
    );
}

#[test]
fn moderation_reaches_staff_moderation_only_with_admin_which_only_an_admins_grant_holds() {
    let v = view("POST /servers/eng/bans", "eng", false, &["lobby"]);
    assert_eq!(
        as_person(&v, &set(&["moderation"]), true, Some("eng"), None),
        uniform_404()
    );
    assert!(!granted(&["moderation", "admin"], false, true, true).contains(&"admin".to_string()));
}

#[test]
fn admin_is_indistinguishable_when_a_non_admin_ticks_it_or_an_admin_unticks_it() {
    let non_admin = granted(
        &["openid", "profile", "servers", "admin"],
        false,
        true,
        true,
    );
    let unticked = granted(&["openid", "profile", "servers"], true, true, true);
    assert_eq!(non_admin, unticked);
    assert_eq!(received(&non_admin), received(&unticked));
    let as_set = |v: &[String]| v.iter().cloned().collect::<BTreeSet<String>>();
    for (m, p) in [
        ("GET", "/admin/users"),
        ("GET", "/admin/audit"),
        ("PATCH", "/admin/settings"),
    ] {
        assert_eq!(
            token_route(&as_set(&non_admin), m, p, &plain()),
            token_route(&as_set(&unticked), m, p, &plain())
        );
        assert_eq!(
            token_route(&as_set(&non_admin), m, p, &plain()),
            TokenAnswer::InsufficientScope
        );
    }
}

fn audit(
    actor: Option<&str>,
    action: &str,
    target: Option<&str>,
    detail: &[(&str, &str)],
) -> AuditRow {
    AuditRow {
        actor: actor.map(str::to_string),
        action: action.to_string(),
        target: target.map(str::to_string),
        detail: detail
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect::<BTreeMap<String, String>>(),
    }
}

#[test]
fn the_audit_shows_other_admins_actions_without_their_names_settings_refuse_security_keys() {
    let admins = set(&["alice", "root"]);
    let rows = [
        audit(Some("alice"), "server.delete", None, &[]),
        audit(Some("root"), "user.ban", None, &[]),
        audit(None, "job", None, &[]),
    ];
    assert_eq!(
        audit_for_token(&rows, "alice", &admins),
        [
            audit(Some("alice"), "server.delete", None, &[]),
            audit(Some(A_SITE_ADMIN), "user.ban", None, &[]),
            audit(None, "job", None, &[]),
        ]
    );
    assert_eq!(A_SITE_ADMIN, "a site admin");
    assert!(admin_patch_allowed(&["site_name", "max_upload_mb"]));
    for k in [
        "two_factor",
        "password_login",
        "protection_totp",
        "oauth_provider",
        "application_admin_scope",
        "application_encrypted_access",
        "device_sign_in",
        "e2ee_compliance",
    ] {
        assert!(!admin_patch_allowed(&["site_name", k]), "{k}");
    }
    assert_eq!(SECURITY_CONTROLS.len(), 24);
    for k in SECURITY_CONTROLS {
        assert!(!admin_patch_allowed(&[k]));
        assert!(!k.contains("app_") && !k.ends_with("_apps"), "{k}");
    }
    assert!(admin_patch_allowed(&[] as &[&str]));
}

#[test]
fn the_audit_through_admin_hides_other_admins_in_targets_and_details_and_drops_site_admin_changes()
{
    let admins = set(&["alice", "root", "carol"]);
    let rows = [
        audit(
            Some("root"),
            "site_admin.grant",
            Some("carol"),
            &[("by", "root")],
        ),
        audit(
            Some("root"),
            "user.two_factor_reset",
            Some("carol"),
            &[("by", "root"), ("via", "page")],
        ),
        audit(
            Some("root"),
            "user.ban",
            Some("mallory"),
            &[("reason", "spam")],
        ),
        audit(
            Some("alice"),
            "user.two_factor_reset",
            Some("root"),
            &[("by", "alice")],
        ),
        audit(
            None,
            "user.clear_protections",
            Some("alice"),
            &[("via", "console")],
        ),
        audit(Some("alice"), "site_admin.revoke", Some("root"), &[]),
    ];
    assert_eq!(
        audit_for_token(&rows, "alice", &admins),
        [
            audit(
                Some(A_SITE_ADMIN),
                "user.two_factor_reset",
                Some(A_SITE_ADMIN),
                &[("by", A_SITE_ADMIN), ("via", "page")]
            ),
            audit(
                Some(A_SITE_ADMIN),
                "user.ban",
                Some("mallory"),
                &[("reason", "spam")]
            ),
            audit(
                Some("alice"),
                "user.two_factor_reset",
                Some(A_SITE_ADMIN),
                &[("by", "alice")]
            ),
            audit(
                None,
                "user.clear_protections",
                Some("alice"),
                &[("via", "console")]
            ),
        ]
    );
    assert_eq!(audit_for_token(&[], "alice", &admins), []);
}

#[test]
fn the_audit_through_admin_hides_another_admins_name_wherever_it_appears_inside_a_value() {
    let admins = set(&[
        "alice", "root", "carol", "admin", "al", "dev ops", "7f3a", "Émile", "ørjan",
    ]);
    let row = |target: &str, note: &str| {
        audit(Some("alice"), "user.note", Some(target), &[("note", note)])
    };
    let shown = |target: &str, note: &str| audit_for_token(&[row(target, note)], "alice", &admins);
    let cases = [
        ("by root", "by a site admin"),
        ("Asked by ROOT.", "Asked by a site admin."),
        ("carol,root", "a site admin,a site admin"),
        ("alice and root", "alice and a site admin"),
        ("rooted, rootkit, groot", "rooted, rootkit, groot"),
        ("normal deal", "normal deal"),
        ("by dev ops today", "by a site admin today"),
        ("uid 7f3a", "uid a site admin"),
        ("root", "a site admin"),
        ("(root)", "(a site admin)"),
        ("", ""),
        ("zoë root", "zoë a site admin"),
        ("éroot", "éroot"),
        (
            "by ÉMILE, émile and ØRJAN.",
            "by a site admin, a site admin and a site admin.",
        ),
        ("émiles", "émiles"),
        (
            "by_root, root-admin, john.root, root.cfg",
            "by_root, root-admin, john.root, root.cfg",
        ),
        (
            "Asked by root. Done by carol.",
            "Asked by a site admin. Done by a site admin.",
        ),
        ("(asked by root.)", "(asked by a site admin.)"),
        ("\"by root.\"", "\"by a site admin.\""),
        ("by root...", "by a site admin..."),
        ("by root.]", "by a site admin.]"),
    ];
    for (value, masked) in cases {
        assert_eq!(
            shown(value, value),
            [audit(
                Some("alice"),
                "user.note",
                Some(masked),
                &[("note", masked)]
            )],
            "{value}"
        );
    }
    let with_empty = set(&["", "root"]);
    assert_eq!(
        audit_for_token(&[row("by root", "x")], "alice", &with_empty),
        [audit(
            Some("alice"),
            "user.note",
            Some("by a site admin"),
            &[("note", "x")]
        )]
    );
}

#[test]
fn one_route_two_uses_two_permissions() {
    assert!(!ok(
        &["messages.send"],
        "DELETE",
        "/messages/5",
        &own(false)
    ));
    assert!(ok(&["moderation"], "DELETE", "/messages/5", &own(false)));
    assert!(ok(&["messages.send"], "DELETE", "/messages/5", &own(true)));
    assert!(!ok(&all_scopes(), "PATCH", "/messages/5", &own(false)));
    assert!(!ok(&["messages.send"], "PUT", "/messages/5/pin", &plain()));
}

#[test]
fn report_evidence_of_an_encrypted_message() {
    assert!(!report_evidence_shown(true, &set(&["moderation"]), true));
    assert!(!report_evidence_shown(
        true,
        &set(&["moderation", "encrypted.read"]),
        false
    ));
    assert!(report_evidence_shown(
        true,
        &set(&["moderation", "encrypted.read"]),
        true
    ));
    assert!(report_evidence_shown(false, &set(&["moderation"]), false));
}

#[test]
fn proofs_only_from_picked_servers_friends_with_friends_dm_peers_with_dms_read() {
    let picked = set(&["lobby"]);
    let read = set(&["servers.read"]);
    let server = |name: &str| Proof::Server(name.to_string());
    assert!(!proof_counts(&server("eng"), &read, Some(&picked)));
    assert!(proof_counts(&server("lobby"), &read, Some(&picked)));
    assert!(proof_counts(&server("eng"), &read, None));
    assert!(!proof_counts(&Proof::Friend, &read, Some(&picked)));
    assert!(proof_counts(
        &Proof::Friend,
        &set(&["friends"]),
        Some(&picked)
    ));
    assert!(proof_counts(&Proof::Dm, &set(&["dms.read"]), Some(&picked)));
    assert!(!proof_counts(&Proof::Dm, &read, Some(&picked)));
    for p in [Proof::Own, Proof::Everyone, Proof::Badge] {
        assert!(proof_counts(&p, &set(&[]), Some(&picked)));
    }
}

#[test]
fn media_by_its_messages_place_search_over_picked_servers() {
    let picked = set(&["lobby"]);
    let read = set(&["messages.read"]);
    let none = BTreeSet::new();
    let server = |name: &str, encrypted: bool| MediaPlace::Server {
        server: name.to_string(),
        encrypted,
    };
    assert!(!media_ok(
        &server("eng", false),
        &read,
        Some(&picked),
        &none,
        ""
    ));
    assert!(media_ok(
        &server("lobby", false),
        &read,
        Some(&picked),
        &none,
        ""
    ));
    assert!(media_ok(&server("eng", false), &read, None, &none, ""));
    assert!(!media_ok(
        &MediaPlace::Dm { encrypted: false },
        &read,
        Some(&picked),
        &none,
        ""
    ));
    assert!(media_ok(
        &MediaPlace::Dm { encrypted: false },
        &set(&["dms.read"]),
        Some(&picked),
        &none,
        ""
    ));
    assert!(!media_ok(
        &server("lobby", true),
        &read,
        Some(&picked),
        &none,
        ""
    ));
    let chats = set(&["g1"]);
    let encrypted = set(&["encrypted.read"]);
    assert!(media_ok(
        &server("lobby", true),
        &encrypted,
        Some(&picked),
        &chats,
        "g1"
    ));
    assert!(!media_ok(
        &server("lobby", true),
        &encrypted,
        Some(&picked),
        &chats,
        "g2"
    ));
    assert!(!media_ok(
        &MediaPlace::Dm { encrypted: true },
        &set(&["dms.read"]),
        None,
        &chats,
        "g1"
    ));
    assert_eq!(search_servers(&["lobby", "eng"], Some(&picked)), ["lobby"]);
    assert_eq!(search_servers(&["lobby", "eng"], None), ["lobby", "eng"]);
}

#[test]
fn public_ticked_private_only_when_ticked_encrypted_never_in_part_1() {
    let fact = |key: &str, visibility| ServerFact {
        key: key.to_string(),
        visibility,
    };
    let mine = [
        fact("lobby", Visibility::Public),
        fact("team", Visibility::Private),
        fact("vault", Visibility::Encrypted),
    ];
    let pick = |key: &str, ticked, disabled| Pick {
        key: key.to_string(),
        ticked,
        disabled,
    };
    assert_eq!(
        default_picks(&mine),
        [
            pick("lobby", true, false),
            pick("team", false, false),
            pick("vault", false, true),
        ]
    );
    assert_eq!(
        clean_picks(&mine, &["lobby", "team", "vault", "lobby", "elsewhere"]),
        ["lobby", "team"]
    );
}

fn grant() -> Grant {
    Grant {
        scopes: set(&["openid", "profile", "servers", "messages.read"]),
        servers: Some(set(&["lobby"])),
        joins: BTreeSet::new(),
        hosts: set(&["pixel.example.com"]),
        application_rev: 3,
        revoked: false,
    }
}

fn ask() -> Ask {
    Ask {
        scopes: list(&["openid", "profile"]),
        servers: vec![],
        joins: vec![],
        host: "pixel.example.com".to_string(),
        application_rev: 3,
        webhook: false,
        from_client: false,
    }
}

#[test]
fn remembered_grants_cover() {
    let g = grant();
    assert!(covers(Some(&g), &ask()));
    assert!(!covers(None, &ask()));
    let other_server = Ask {
        scopes: list(&["messages.read"]),
        servers: list(&["team"]),
        ..ask()
    };
    assert!(!covers(Some(&g), &other_server));
    let same_server = Ask {
        servers: list(&["lobby"]),
        ..other_server.clone()
    };
    assert!(covers(Some(&g), &same_server));
    let any_server = Grant {
        servers: None,
        ..grant()
    };
    assert!(covers(Some(&any_server), &other_server));
    assert!(!covers(
        Some(&g),
        &Ask {
            application_rev: 4,
            ..ask()
        }
    ));
    assert!(!covers(
        Some(&g),
        &Ask {
            host: "pixel2.example.com".to_string(),
            ..ask()
        }
    ));
    assert!(!covers(
        Some(&g),
        &Ask {
            webhook: true,
            ..ask()
        }
    ));
    assert!(!covers(
        Some(&g),
        &Ask {
            from_client: true,
            ..ask()
        }
    ));
    assert!(!covers(
        Some(&g),
        &Ask {
            joins: list(&["lobby"]),
            ..ask()
        }
    ));
    assert!(!covers(
        Some(&Grant {
            revoked: true,
            ..grant()
        }),
        &ask()
    ));
    let mut with_admin = grant();
    with_admin.scopes.insert("admin".to_string());
    assert!(!covers(
        Some(&with_admin),
        &Ask {
            scopes: list(&["admin"]),
            ..ask()
        }
    ));
}

#[test]
fn an_application_asking_admin_gets_the_same_consent_path_from_an_admin_and_a_non_admin() {
    let asked = Ask {
        scopes: list(&["openid", "profile", "admin"]),
        host: "a.example".to_string(),
        application_rev: 1,
        ..ask()
    };
    let held = |is_site_admin: bool| Grant {
        scopes: granted(&["openid", "profile", "admin"], is_site_admin, true, true)
            .into_iter()
            .collect(),
        servers: Some(BTreeSet::new()),
        joins: BTreeSet::new(),
        hosts: set(&["a.example"]),
        application_rev: 1,
        revoked: false,
    };
    assert!(held(true).scopes.contains("admin"));
    assert!(!held(false).scopes.contains("admin"));
    assert_eq!(
        covers(Some(&held(false)), &asked),
        covers(Some(&held(true)), &asked)
    );
    assert!(!covers(Some(&held(true)), &asked));
}

#[test]
fn re_ask_shows_only_what_is_new() {
    let again = Ask {
        scopes: list(&["openid", "dms.read"]),
        ..ask()
    };
    assert_eq!(
        diff(Some(&grant()), &again),
        Diff {
            added: list(&["dms.read"]),
            kept: list(&["openid"])
        }
    );
    assert_eq!(
        diff(None, &again),
        Diff {
            added: list(&["openid", "dms.read"]),
            kept: vec![]
        }
    );
    let renamed = Ask {
        application_rev: 4,
        ..again
    };
    assert_eq!(diff(Some(&grant()), &renamed).kept, [] as [&str; 0]);
}

#[test]
fn group_values_encode_their_separators() {
    let picked = [PickedRoles {
        server: "lobby".to_string(),
        roles: list(&["Staff", "a:b,c"]),
    }];
    assert_eq!(
        group_values(&picked),
        ["lobby", "lobby:Staff", "lobby:a%3Ab%2Cc"]
    );
    let odd = [PickedRoles {
        server: "50%|x".to_string(),
        roles: vec![],
    }];
    assert_eq!(group_values(&odd), ["50%25%7Cx"]);
}

#[test]
fn personal_tokens_never_security_never_applications_never_site_administration() {
    use Level::{Read, Write};
    assert!(personal_allowed("GET", "/channels/1/messages", Read, false));
    assert!(personal_allowed(
        "HEAD",
        "/channels/1/messages",
        Read,
        false
    ));
    assert!(!personal_allowed(
        "POST",
        "/channels/1/messages",
        Read,
        false
    ));
    assert!(personal_allowed(
        "POST",
        "/channels/1/messages",
        Write,
        false
    ));
    assert!(!personal_allowed("POST", "/me/password", Write, false));
    assert!(!personal_allowed("GET", "/admin/users", Write, false));
    assert!(!personal_allowed("GET", "/admin", Write, false));
    assert!(!personal_allowed("POST", "/oauth/token", Write, false));
    assert!(!personal_allowed("POST", "/me/tokens", Write, false));
    assert!(!personal_allowed("POST", "/oauth/register", Write, false));
    assert!(personal_allowed("POST", "/oauth/register", Read, true));
    assert!(!personal_allowed("GET", "/applications", Write, false));
    assert!(!personal_allowed("GET", "/me/p2p_backup", Write, false));
    assert!(!personal_allowed("GET", "/e2ee/me", Write, false));
    assert!(!personal_allowed("POST", "/config_shares", Write, false));
    assert!(!personal_allowed(
        "POST",
        "/identity/p2p_binding",
        Write,
        false
    ));
    assert!(!personal_allowed("POST", "/auth/logout", Write, false));
    assert!(personal_allowed("GET", "/me", Read, false));
}

#[test]
fn personal_tokens_never_touch_the_accounts_encryption_identity() {
    for (m, p) in [
        ("POST", "/e2ee/devices"),
        ("POST", "/e2ee/application_devices"),
        ("PUT", "/e2ee/application_devices/d1/chats"),
        ("DELETE", "/e2ee/application_devices/d1"),
        ("POST", "/e2ee/devices/d1/approve"),
        ("POST", "/e2ee/devices/d1/revoke"),
        ("POST", "/e2ee/devices/d1/bind"),
        ("POST", "/e2ee/groups/g1/history"),
        ("GET", "/e2ee/backup"),
        ("PUT", "/e2ee/backup/1"),
        ("PUT", "/e2ee/me/identity"),
    ] {
        assert!(!personal_allowed(m, p, Level::Write, true), "{m} {p}");
    }
    for (m, p) in NEVER_ROUTES {
        let register = (m, p) == ("POST", "/oauth/register");
        assert_eq!(
            personal_allowed(m, p, Level::Write, true),
            register,
            "{m} {p}"
        );
        assert!(!personal_allowed(m, p, Level::Write, false), "{m} {p}");
    }
    assert!(personal_allowed(
        "GET",
        "/e2ee/groups/g1/history",
        Level::Read,
        false
    ));
    assert!(personal_allowed("GET", "/e2ee/devices", Level::Read, false));
}
