use std::collections::{BTreeMap, BTreeSet};

use proptest::prelude::*;

use rchat_identity::application_device::{DeviceKind, DeviceRow, GrantUse, sweep};
use rchat_identity::cimd::{CachedDoc, client_id_url_ok, evict};
use rchat_identity::codes::{
    RECOVERY_ALPHABET, SecretKind, TokenKind, USER_CODE_ALPHABET, clean_recovery, clean_user_code,
    new_secret, recovery_code_from, recovery_key, recovery_key_matches, secret_kind_of,
    user_code_from, user_code_key,
};
use rchat_identity::device::{Approver, DeviceRequest, card};
use rchat_identity::events::event_allowed;
use rchat_identity::forward::{
    Preset, ProxyApplication, Routed, Separator, go_key, header_value, host_allowed, list_value,
    normalize, proxy_path, safe_return, spellings, stripped_by,
};
use rchat_identity::owners::{
    Application, ApplicationMember, Change, MemberState, Role, Status, lapse,
};
use rchat_identity::pkce::{challenge_of, challenge_shape, verifier_ok, verifier_shape};
use rchat_identity::protections::{
    Account, Controls, GraceRow, Key, PasswordChange, Scope, Session, Temp, Via,
    allowed_while_restricted, evaluate,
};
use rchat_identity::redirect::{ClientType, check_redirect, redirect_matches};
use rchat_identity::scopes::{
    Level, PickedRoles, TokenAnswer, Use, all_scopes, group_values, is_never, personal_allowed,
    required_for, scope_token_ok, token_route,
};
use rchat_identity::signin::{CodeLimits, Limit};
use url::Url;

use rchat_identity::totp::{
    Algo, Verdict, base32_decode, base32_encode, clean_code, grouped_key, hotp, issuer_label,
    otpauth_uri, step_at, totp, verify,
};

fn text() -> impl Strategy<Value = String> {
    prop_oneof![
        any::<String>(),
        "[ -~]{0,80}",
        "[a-zA-Z0-9:/?#@._~%\\\\ \t\r\n*\\[\\]-]{0,80}",
        "(https?|com\\.example\\.app|javascript)://?[a-z0-9.:\\[\\]@-]{0,30}(/[a-z0-9./?#%-]{0,30})?",
        "/[a-z_]{0,12}(/[a-z0-9_]{0,12}){0,5}/?",
    ]
}

fn method() -> impl Strategy<Value = String> {
    prop_oneof![
        Just("GET".to_string()),
        Just("POST".to_string()),
        Just("PUT".to_string()),
        Just("PATCH".to_string()),
        Just("DELETE".to_string()),
        Just("HEAD".to_string()),
        any::<String>(),
    ]
}

fn route() -> impl Strategy<Value = String> {
    let seg = prop_oneof![
        Just("me".to_string()),
        Just("admin".to_string()),
        Just("auth".to_string()),
        Just("applications".to_string()),
        Just("oauth".to_string()),
        Just("e2ee".to_string()),
        Just("servers".to_string()),
        Just("messages".to_string()),
        Just("users".to_string()),
        Just("application_devices".to_string()),
        Just("devices".to_string()),
        Just("password".to_string()),
        Just("two_factor".to_string()),
        Just("5".to_string()),
        Just("".to_string()),
        "[a-z_]{1,10}",
    ];
    prop_oneof![
        prop::collection::vec(seg, 0..6).prop_map(|segs| format!("/{}", segs.join("/"))),
        text(),
    ]
}

fn everything() -> BTreeSet<String> {
    all_scopes().into_iter().map(str::to_string).collect()
}

fn unpercent(text: &str) -> Vec<u8> {
    let bytes = text.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap();
            out.push(u8::from_str_radix(hex, 16).unwrap());
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    out
}

proptest! {
    #![proptest_config(ProptestConfig {
        failure_persistence: None,
        ..ProptestConfig::default()
    })]

    #[test]
    fn base32_round_trips_and_decoding_never_panics(bytes in prop::collection::vec(any::<u8>(), 0..64), junk in text()) {
        let encoded = base32_encode(&bytes);
        prop_assert!(encoded.bytes().all(|b| b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".contains(&b)));
        prop_assert_eq!(base32_decode(&encoded), Some(bytes.clone()));
        prop_assert_eq!(base32_decode(&encoded.to_lowercase()), Some(bytes.clone()));
        let grouped = grouped_key(&bytes);
        prop_assert_eq!(base32_decode(&grouped), Some(bytes));
        if let Some(decoded) = base32_decode(&junk) {
            prop_assert!(decoded.len() <= junk.len());
        }
    }

    #[test]
    fn codes_people_type_clean_to_six_digits_or_nothing(input in text()) {
        if let Some(code) = clean_code(&input) {
            prop_assert_eq!(code.len(), 6);
            prop_assert!(code.bytes().all(|b| b.is_ascii_digit()));
            prop_assert_eq!(clean_code(&code), Some(code));
        }
    }

    #[test]
    fn verify_never_panics_and_only_accepts_a_newer_step_in_the_window(
        secret in prop::collection::vec(any::<u8>(), 0..40),
        input in prop_oneof![text(), "[0-9]{6}", "[0-9 ]{0,9}"],
        t in any::<i64>(),
        last in any::<i64>(),
        enrolling in any::<bool>(),
    ) {
        match verify(&secret, &input, t, last, enrolling) {
            Verdict::Ok { step } => {
                prop_assert!(step > last);
                prop_assert!((step - step_at(t)).abs() <= 1);
                prop_assert!(step >= 0);
            }
            Verdict::Clock => prop_assert!(enrolling),
            Verdict::Malformed => prop_assert!(clean_code(&input).is_none()),
            Verdict::Wrong | Verdict::Used => {}
        }
    }

    #[test]
    fn a_right_code_is_accepted_once(secret in prop::collection::vec(any::<u8>(), 1..40), t in 0i64..4_000_000_000) {
        let step = step_at(t);
        let code = hotp(&secret, step as u64, 6, Algo::Sha1);
        prop_assert_eq!(totp(&secret, t, 6, Algo::Sha1), Some(code.clone()));
        let Verdict::Ok { step: accepted } = verify(&secret, &code, t, -1, false) else {
            return Err(TestCaseError::fail("a right code was refused"));
        };
        prop_assert_eq!(verify(&secret, &code, t, accepted, false), Verdict::Used);
    }

    #[test]
    fn hotp_is_digits_of_the_asked_width(secret in prop::collection::vec(any::<u8>(), 0..80), counter in any::<u64>(), digits in any::<u32>()) {
        for algo in [Algo::Sha1, Algo::Sha256, Algo::Sha512] {
            let code = hotp(&secret, counter, digits, algo);
            prop_assert_eq!(code.len() as u32, digits.clamp(1, 9));
            prop_assert!(code.bytes().all(|b| b.is_ascii_digit()));
        }
    }

    #[test]
    fn the_otpauth_uri_never_leaks_a_separator(issuer in text(), account in text(), secret in prop::collection::vec(any::<u8>(), 0..32)) {
        let uri = otpauth_uri(&issuer, &account, &secret);
        prop_assert!(uri.is_ascii());
        prop_assert_eq!(uri.matches('?').count(), 1);
        prop_assert_eq!(uri.matches('&').count(), 4);
        prop_assert!(!uri.contains(' ') && !uri.contains('#'));
        let _ = issuer_label(&issuer, &account);
    }

    #[test]
    fn recovery_and_user_codes_clean_to_their_alphabets_or_nothing(input in prop_oneof![text(), "[2-9a-zA-Z -]{8,14}", "[B-Zb-z -]{6,12}"]) {
        if let Some(code) = clean_recovery(&input) {
            prop_assert_eq!(code.len(), 10);
            prop_assert!(code.chars().all(|c| RECOVERY_ALPHABET.contains(c)));
            prop_assert_eq!(clean_recovery(&code), Some(code));
        }
        if let Some(code) = clean_user_code(&input) {
            prop_assert_eq!(code.len(), 8);
            prop_assert!(code.chars().all(|c| USER_CODE_ALPHABET.contains(c)));
            prop_assert_eq!(clean_user_code(&code), Some(code));
        }
    }

    #[test]
    fn generated_codes_have_their_shape_whatever_the_random_source_gives(seed in prop::collection::vec(any::<u8>(), 1..64)) {
        let fill = |buf: &mut [u8]| {
            for (i, b) in buf.iter_mut().enumerate() {
                *b = seed[i % seed.len()];
            }
        };
        let recovery = recovery_code_from(fill);
        let user = user_code_from(fill);
        if let Some(clean) = clean_recovery(&recovery) {
            prop_assert_eq!(recovery.len(), 11);
            prop_assert_eq!(clean, recovery.replace('-', ""));
        }
        if let Some(clean) = clean_user_code(&user) {
            prop_assert_eq!(user.len(), 9);
            prop_assert_eq!(clean, user.replace('-', ""));
        }
    }

    #[test]
    fn code_keys_match_only_their_own_code(pepper in prop::collection::vec(any::<u8>(), 0..48), uid in any::<i64>(), a in text(), b in text()) {
        let key = recovery_key(&pepper, uid, &a);
        prop_assert!(recovery_key_matches(&key, &pepper, uid, &a));
        prop_assert_eq!(recovery_key_matches(&key, &pepper, uid, &b), a == b);
        prop_assert!(!recovery_key_matches(&b, &pepper, uid, &a));
        prop_assert_eq!(user_code_key(&pepper, &a) == user_code_key(&pepper, &b), a == b);
    }

    #[test]
    fn a_token_names_its_kind_or_nothing(token in prop_oneof![text(), "[0-9a-f]{64}", "rc[a-z]_[A-Za-z0-9_-]{40,46}"]) {
        match secret_kind_of(&token) {
            Some(TokenKind::Session) => prop_assert_eq!(token.len(), 64),
            Some(TokenKind::Secret(kind)) => {
                prop_assert!(token.starts_with(kind.prefix()));
                prop_assert_eq!(token.len(), 47);
            }
            None => {}
        }
        for kind in SecretKind::ALL {
            prop_assert_eq!(secret_kind_of(&new_secret(kind)), Some(TokenKind::Secret(kind)));
        }
    }

    #[test]
    fn pkce_accepts_only_the_challenge_of_a_well_shaped_verifier(verifier in prop_oneof![text(), "[A-Za-z0-9._~-]{43,128}"], challenge in text()) {
        let own = challenge_of(&verifier);
        prop_assert!(challenge_shape(&own));
        prop_assert_eq!(verifier_ok(&verifier, &own), verifier_shape(&verifier));
        if verifier_ok(&verifier, &challenge) {
            prop_assert_eq!(challenge, own);
        }
    }

    #[test]
    fn redirect_rules_never_panic_and_refuse_what_they_say(raw in text(), other in text()) {
        for client in [ClientType::Public, ClientType::Confidential] {
            if check_redirect(&raw, client).is_ok() {
                prop_assert!(!raw.contains(['#', '*', ' ', '\t', '\n']));
                prop_assert!(raw.encode_utf16().count() <= 512);
                let url = Url::parse(&raw).expect("an accepted redirect parses");
                prop_assert!(url.username().is_empty() && url.password().is_none());
                prop_assert!(url.fragment().is_none());
            }
        }
        let registered = [raw.clone()];
        prop_assert!(redirect_matches(&registered, &raw));
        if redirect_matches(&registered, &other) && other != raw {
            prop_assert!(other.starts_with("http://127.0.0.1") || other.starts_with("http://[::1]"));
            prop_assert!(raw.starts_with("http://127.0.0.1") || raw.starts_with("http://[::1]"));
        }
    }

    #[test]
    fn header_values_are_one_line_of_visible_ascii_and_decode_back(value in text(), items in prop::collection::vec(text(), 0..5)) {
        let encoded = header_value(&value);
        prop_assert!(encoded.bytes().all(|b| (0x20..=0x7e).contains(&b)));
        prop_assert_eq!(unpercent(&encoded), value.as_bytes());
        for (sep, mark) in [(Separator::Comma, ','), (Separator::Pipe, '|')] {
            let list = list_value(&items, sep);
            prop_assert!(list.bytes().all(|b| (0x20..=0x7e).contains(&b)));
            prop_assert_eq!(list.matches(mark).count(), items.len().saturating_sub(1));
            let back: Vec<Vec<u8>> = list.split(mark).map(unpercent).collect();
            let want: Vec<Vec<u8>> = items.iter().map(|i| i.as_bytes().to_vec()).collect();
            if !items.is_empty() {
                prop_assert_eq!(back, want);
            }
        }
    }

    #[test]
    fn return_addresses_stay_on_the_applications_hosts(rd in prop_oneof![text(), "https://(wiki|evil)\\.example\\.com(:[0-9]{1,5})?/[a-z?&=./\\\\@]{0,20}"]) {
        let application = ProxyApplication {
            id: "p".to_string(),
            hosts: vec!["wiki.example.com".to_string()],
            cookie_domain: Some("example.com".to_string()),
            preset: Preset::Rchat,
            paused: false,
            needs_two_factor: false,
        };
        let back = safe_return(&application, Some(&rd));
        prop_assert!(back == "/" || back.starts_with("https://wiki.example.com/"), "{}", back);
    }

    #[test]
    fn header_names_and_hosts_never_panic(name in text(), list in prop::collection::vec(text(), 0..4)) {
        let normal = normalize(&name);
        prop_assert!(!normal.contains('_'));
        if name.is_ascii() {
            prop_assert_eq!(stripped_by(&name), stripped_by(&name.to_ascii_uppercase()));
            prop_assert_eq!(stripped_by(&name), stripped_by(&name.replace('-', "_")));
        }
        for spelling in spellings(&name) {
            prop_assert_eq!(normalize(&spelling), normal.clone());
        }
        let _ = go_key(&name);
        if host_allowed(&name, &list) {
            prop_assert!(name.to_lowercase().bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b".-:".contains(&b)));
            prop_assert!(!list.is_empty());
        }
        if proxy_path(&name, &name, &list) == Routed::Serve {
            prop_assert!(name.starts_with("/_rchat/proxy/"));
        }
    }

    #[test]
    fn client_id_urls_are_https_with_a_path(raw in text()) {
        if client_id_url_ok(&raw) {
            prop_assert!(raw.trim_start().to_lowercase().starts_with("https:"));
            prop_assert!(!raw.contains('#'));
        }
    }

    #[test]
    fn route_tables_never_panic_and_never_routes_stay_closed(method in method(), path in route(), own in any::<bool>(), logs in any::<bool>()) {
        let ctx = Use { own_target: own, place: None, logs_content: logs };
        let grant = everything();
        let answer = token_route(&grant, &method, &path, &ctx);
        if is_never(&method, &path) {
            prop_assert_eq!(answer, TokenAnswer::InsufficientScope);
        }
        if required_for(&method, &path, &ctx).is_none() {
            prop_assert_eq!(answer, TokenAnswer::InsufficientScope);
        }
        prop_assert_eq!(token_route(&BTreeSet::new(), &method, &path, &ctx), TokenAnswer::InsufficientScope);
        let _ = personal_allowed(&method, &path, Level::Write, own);
        if personal_allowed(&method, &path, Level::Read, false) {
            prop_assert!(method == "GET" || method == "HEAD");
        }
        let _ = allowed_while_restricted(&method, &path, own, logs);
        let _ = event_allowed(&path, &grant, None, Some(&method), own);
    }

    #[test]
    fn scope_tokens_are_plain_ascii_without_quotes(token in text(), picked in prop::collection::vec((text(), prop::collection::vec(text(), 0..3)), 0..3)) {
        if scope_token_ok(&token) {
            prop_assert!(token.bytes().all(|b| b.is_ascii_graphic() && b != b'"' && b != b'\\'));
            prop_assert!(token.len() <= 64);
        }
        let roles: Vec<PickedRoles> = picked.into_iter().map(|(server, roles)| PickedRoles { server, roles }).collect();
        for value in group_values(&roles) {
            prop_assert!(value.matches(':').count() <= 1);
            prop_assert!(!value.contains(',') && !value.contains('|'));
        }
    }

    #[test]
    fn requirements_never_panic_at_any_time(
        now in any::<i64>(),
        since in any::<i64>(),
        until in prop::option::of(any::<i64>()),
        hours in any::<i64>(),
        expires in prop::option::of(any::<i64>()),
        temp in any::<bool>(),
        strict in any::<bool>(),
    ) {
        let controls = Controls {
            protection_totp: Scope::Everyone,
            protection_backup_phrase: Scope::Everyone,
            protection_totp_grace_hours: hours,
            protection_backup_phrase_grace_hours: hours,
            password_change: match strict { true => PasswordChange::Required, false => PasswordChange::Encouraged },
            ..Controls::default()
        };
        let account = Account {
            uid: 1,
            is_site_admin: false,
            totp_on: false,
            phrase_set: false,
            temp: temp.then_some(Temp { expires_at: expires }),
            passwordless: false,
            sso: None,
        };
        let session = Session { via: Via::Password, amr: vec![] };
        let rows = BTreeMap::from([(Key::Totp, GraceRow { required_since: since, grace_until: until })]);
        let e = evaluate(&controls, &account, &session, now, &rows, &[]);
        prop_assert_eq!(e.restricted, e.reason.is_some());
        prop_assert_eq!(e.insert, vec![Key::BackupPhrase]);
        prop_assert!(e.remove.is_empty());
        prop_assert_eq!(e.states.len(), 2 + usize::from(temp));
    }

    #[test]
    fn code_limits_never_panic_and_never_pass_more_than_the_caps(times in prop::collection::vec(any::<i64>(), 1..60), uid in any::<i64>()) {
        let mut lim = CodeLimits::new();
        for now in &times {
            if lim.reserve(uid, "g", *now) == Limit::Ok {
                prop_assert!(lim.count(uid, "g", *now) <= 20);
                prop_assert!(lim.count(uid, "*", *now) <= 30);
            }
            lim.refund(uid, "other", *now);
        }
        lim.clear(uid);
        prop_assert_eq!(lim.state(uid, "g", times[0]), Limit::Ok);
    }

    #[test]
    fn owner_rules_never_panic_at_any_time(now in any::<i64>(), since in any::<i64>(), created in any::<i64>(), active_since in any::<i64>(), managers in prop::collection::vec(0i64..4, 0..3)) {
        let member = |uid, state, inactive_since| ApplicationMember { uid, role: Role::Owner, state, seat: None, inactive_since };
        let ms = lapse(&[member(1, MemberState::Active, None), member(2, MemberState::Inactive, Some(since))], now);
        let application = Application::with_managers(&ms, &managers);
        let _ = application.orphan_state(Some(since), now);
        for change in [Change::Name, Change::OwnerAdd, Change::RedirectAdd, Change::Delete] {
            if let Ok(p) = application.propose(1, change, created, 1, None) {
                let settled = application.settle(p.clone(), now, active_since);
                prop_assert!(settled.status != Status::Stale);
                let _ = application.vote(&p, 2, true, now, active_since);
                let _ = application.seat_vote(&p, "server:lobby", 3, true, now, active_since);
            }
        }
        let _ = application.propose(1, Change::OwnerRemove, created, 2, Some(2));
    }

    #[test]
    fn sweeps_caches_and_cards_never_panic_at_any_time(now in any::<i64>(), seen in any::<i64>(), idle in any::<i64>(), used in any::<i64>(), live in any::<bool>(), grant in any::<bool>()) {
        let row = DeviceRow {
            id: "d".to_string(),
            kind: DeviceKind::Device,
            session: None,
            application_grant: grant.then(|| "g".to_string()),
            last_seen_at: seen,
            cert_version: 2,
        };
        let _ = sweep(&row, now, idle, Some(GrantUse { live, last_used_at: used }));
        let _ = sweep(&row, now, idle, None);
        let docs = [CachedDoc { url: "u".to_string(), fetched_at: seen, adopted_by: None }];
        prop_assert!(evict(&docs, now).len() <= 1);
        let request = DeviceRequest { client: "rchat".to_string(), label: String::new(), address_hint: String::new(), group: "g".to_string(), started_at: seen };
        let approver = Approver { signed_in: true, group: "g".to_string(), typed_code: true, step_up: true, is_site_admin: false };
        let _ = card(&request, &approver, now);
    }
}
