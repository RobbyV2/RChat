use std::collections::{BTreeMap, BTreeSet};

use rchat_identity::protections::{
    ALL_PERMS, Account, AdminFacts, Controls, ControlsRefusal, Evaluation, GraceRow, Key, KeyState,
    MOD_PERMS, Member, NO_ADMIN_LEFT, PasswordChange, REQUIREMENTS, Reason, Scope, ServerPerms,
    ServerRule, Session, State, Temp, Via, allowed_while_restricted, check_controls,
    clear_protections, evaluate, instance_requires, mask_reason, may_change_server_rule,
    met_by_account, met_by_session, only_protection_keys, reason_text, required, requirement,
    restriction_text, server_perms, sso_covers, unenforceable, usable_admin,
};
use rchat_identity::signin::SsoMode;

const H: i64 = 3600;

fn acct() -> Account {
    Account {
        uid: 1,
        is_site_admin: false,
        totp_on: false,
        phrase_set: false,
        temp: None,
        passwordless: false,
        sso: None,
    }
}

fn admin() -> Account {
    Account {
        is_site_admin: true,
        ..acct()
    }
}

fn temp(expires_at: Option<i64>) -> Account {
    Account {
        temp: Some(Temp { expires_at }),
        ..acct()
    }
}

fn ctl() -> Controls {
    Controls::default()
}

fn refused(field: &'static str, text: &'static str) -> Option<ControlsRefusal> {
    Some(ControlsRefusal { field, text })
}

fn totp(scope: Scope) -> Controls {
    Controls {
        protection_totp: scope,
        ..ctl()
    }
}

fn pw() -> Session {
    Session {
        via: Via::Password,
        amr: vec!["pwd".to_string()],
    }
}

fn sso_session(via: Via, amr: &[&str]) -> Session {
    Session {
        via,
        amr: amr.iter().map(|s| s.to_string()).collect(),
    }
}

fn none() -> BTreeMap<Key, GraceRow> {
    BTreeMap::new()
}

fn row(required_since: i64, grace_until: Option<i64>) -> BTreeMap<Key, GraceRow> {
    BTreeMap::from([(
        Key::Totp,
        GraceRow {
            required_since,
            grace_until,
        },
    )])
}

fn judge(c: &Controls, a: &Account, now: i64, rows: &BTreeMap<Key, GraceRow>) -> Evaluation {
    evaluate(c, a, &pw(), now, rows, &[])
}

#[test]
fn the_registry() {
    let keys: Vec<&str> = REQUIREMENTS.iter().map(|r| r.key.name()).collect();
    assert_eq!(
        keys,
        [
            "new_password",
            "totp",
            "backup_phrase",
            "passkey",
            "password_rules"
        ]
    );
    let built: Vec<bool> = REQUIREMENTS.iter().map(|r| r.built).collect();
    assert_eq!(built, [true, true, true, false, false]);
    let orders: Vec<u8> = REQUIREMENTS.iter().map(|r| r.order).collect();
    assert_eq!(orders, [0, 1, 2, 3, 4]);
    let t = requirement(Key::Totp);
    assert_eq!(t.label, "Authenticator codes");
    assert_eq!(t.step, "Set up an authenticator app");
    assert_eq!(t.control, "protection_totp");
    assert_eq!(t.grace_control, Some("protection_totp_grace_hours"));
    assert_eq!(t.feature, Some("two_factor"));
    assert_eq!(requirement(Key::NewPassword).grace_control, None);
    assert_eq!(requirement(Key::NewPassword).control, "password_change");
    assert!(REQUIREMENTS.iter().all(|r| r.self_setup));
    for r in &REQUIREMENTS {
        assert_eq!(Key::parse(r.key.name()), Some(r.key));
    }
    assert_eq!(Key::parse("email"), None);
    assert_eq!(reason_text(Key::Totp), "This instance requires it.");
}

#[test]
fn scopes() {
    assert!(instance_requires(&totp(Scope::Admins), Key::Totp, &admin()));
    assert!(!instance_requires(&totp(Scope::Admins), Key::Totp, &acct()));
    assert!(instance_requires(
        &totp(Scope::Everyone),
        Key::Totp,
        &acct()
    ));
    assert!(!instance_requires(&ctl(), Key::Totp, &admin()));
    let phrase_off = Controls {
        protection_backup_phrase: Scope::Everyone,
        backup_phrase: false,
        ..ctl()
    };
    assert!(!instance_requires(&phrase_off, Key::BackupPhrase, &acct()));
    assert!(instance_requires(&ctl(), Key::NewPassword, &temp(None)));
    assert!(!instance_requires(
        &totp(Scope::Everyone),
        Key::Passkey,
        &acct()
    ));
}

#[test]
fn controls_that_contradict_a_switch_are_refused() {
    let no_codes = Controls {
        two_factor: false,
        ..totp(Scope::Everyone)
    };
    assert_eq!(
        check_controls(&no_codes, None),
        refused("protection_totp", "Turn on authenticator codes first")
    );
    let no_phrase = Controls {
        protection_backup_phrase: Scope::Admins,
        backup_phrase: false,
        ..ctl()
    };
    assert_eq!(
        check_controls(&no_phrase, None),
        refused("protection_backup_phrase", "Turn on backup phrases first")
    );
    for hours in [721, -1, i64::MAX, i64::MIN] {
        let grace = Controls {
            protection_totp_grace_hours: hours,
            ..ctl()
        };
        assert_eq!(
            check_controls(&grace, None),
            refused(
                "protection_totp_grace_hours",
                "Grace must be 0 to 720 hours"
            )
        );
    }
    let phrase_grace = Controls {
        protection_backup_phrase_grace_hours: 721,
        ..ctl()
    };
    assert_eq!(
        check_controls(&phrase_grace, None),
        refused(
            "protection_backup_phrase_grace_hours",
            "Grace must be 0 to 720 hours"
        )
    );
    assert_eq!(check_controls(&ctl(), None), None);
}

#[test]
fn turning_a_feature_off_while_its_requirement_is_on_says_turn_off_the_requirement_first() {
    let on = Controls {
        protection_backup_phrase: Scope::Everyone,
        ..totp(Scope::Everyone)
    };
    let codes_off = Controls {
        two_factor: false,
        ..on
    };
    assert_eq!(
        check_controls(&codes_off, Some((&on, &[]))),
        refused("two_factor", "Turn off the requirement first")
    );
    let phrases_off = Controls {
        backup_phrase: false,
        ..on
    };
    assert_eq!(
        check_controls(&phrases_off, Some((&on, &[]))),
        refused("backup_phrase", "Turn off the requirement first")
    );
    let was_off = Controls {
        two_factor: false,
        ..ctl()
    };
    assert_eq!(
        check_controls(&codes_off, Some((&was_off, &[]))),
        refused("protection_totp", "Turn on authenticator codes first")
    );
    let phrases_were_off = Controls {
        backup_phrase: false,
        ..ctl()
    };
    assert_eq!(
        check_controls(&phrases_off, Some((&phrases_were_off, &[]))),
        refused("protection_backup_phrase", "Turn on backup phrases first")
    );
    assert_eq!(
        check_controls(
            &Controls {
                two_factor: false,
                ..ctl()
            },
            Some((&ctl(), &[]))
        ),
        None
    );
}

#[test]
fn profiles_add_never_remove() {
    assert_eq!(required(&ctl(), &acct(), &[Key::Totp]), [Key::Totp]);
    assert_eq!(required(&totp(Scope::Everyone), &acct(), &[]), [Key::Totp]);
    let phrase_off = Controls {
        backup_phrase: false,
        ..ctl()
    };
    assert_eq!(required(&phrase_off, &acct(), &[Key::BackupPhrase]), []);
    assert_eq!(required(&ctl(), &acct(), &[Key::NewPassword]), []);
    assert_eq!(required(&ctl(), &acct(), &[Key::Passkey]), []);
    let both = Controls {
        protection_backup_phrase: Scope::Everyone,
        ..totp(Scope::Everyone)
    };
    assert_eq!(
        required(&both, &temp(Some(9)), &[]),
        [Key::NewPassword, Key::Totp, Key::BackupPhrase]
    );
}

#[test]
fn sso_modes() {
    let sso = |mode: SsoMode, amr: &[&str]| {
        let a = Account {
            sso: Some(mode),
            ..acct()
        };
        met_by_session(Key::Totp, &a, &sso_session(Via::Sso, amr))
    };
    assert!(sso(SsoMode::Provider, &[]));
    assert!(!sso(SsoMode::Amr, &["pwd"]));
    assert!(sso(SsoMode::Amr, &["pwd", "mfa"]));
    assert!(!sso(SsoMode::Rchat, &["mfa"]));
    let provider = Account {
        sso: Some(SsoMode::Provider),
        ..acct()
    };
    assert!(!met_by_session(Key::Totp, &provider, &pw()));
    assert!(sso_covers(Some(SsoMode::Amr), &["hwk".to_string()]));
    assert!(!sso_covers(None, &["mfa".to_string()]));
}

#[test]
fn a_provider_session_of_an_account_with_codes_meets_it_only_with_a_code_proven_now() {
    let a = Account {
        sso: Some(SsoMode::Amr),
        totp_on: true,
        ..acct()
    };
    assert!(!met_by_session(
        Key::Totp,
        &a,
        &sso_session(Via::Sso, &["pwd"])
    ));
    assert!(met_by_session(
        Key::Totp,
        &a,
        &sso_session(Via::Sso, &["otp", "pwd"])
    ));
    let rchat = Account {
        sso: Some(SsoMode::Rchat),
        totp_on: true,
        ..acct()
    };
    assert!(!met_by_session(
        Key::Totp,
        &rchat,
        &sso_session(Via::Forward, &[])
    ));
    let codes = Account {
        totp_on: true,
        ..acct()
    };
    assert!(met_by_session(Key::Totp, &codes, &pw()));
}

#[test]
fn an_unmarked_providers_otp_claim_does_not_meet_the_requirement() {
    use rchat_identity::signin::{Proof, Sso, amr_of};
    let a = Account {
        sso: Some(SsoMode::Rchat),
        totp_on: true,
        ..acct()
    };
    let upstream = Sso {
        mode: SsoMode::Rchat,
        amr: vec!["pwd".to_string(), "otp".to_string()],
    };
    let session = Session {
        via: Via::Sso,
        amr: amr_of(&[Proof::Sso], Some(&upstream)),
    };
    assert!(!met_by_session(Key::Totp, &a, &session));
    let with_own_code = Session {
        via: Via::Sso,
        amr: amr_of(&[Proof::Sso, Proof::Totp], Some(&upstream)),
    };
    assert!(met_by_session(Key::Totp, &a, &with_own_code));
}

#[test]
fn per_account_for_the_admin_page() {
    let managed = Account {
        passwordless: true,
        sso: Some(SsoMode::Provider),
        ..acct()
    };
    assert!(met_by_account(Key::Totp, &managed));
    let linked = Account {
        sso: Some(SsoMode::Provider),
        ..acct()
    };
    assert!(!met_by_account(Key::Totp, &linked));
    let phrase = Account {
        phrase_set: true,
        ..acct()
    };
    assert!(met_by_account(Key::BackupPhrase, &phrase));
    assert!(met_by_account(Key::NewPassword, &acct()));
    assert!(!met_by_account(Key::NewPassword, &temp(None)));
    assert!(met_by_account(Key::Passkey, &acct()));
}

#[test]
fn first_time_required_a_grace_row_is_created_nothing_restricted() {
    let e = judge(&totp(Scope::Everyone), &acct(), 1000, &none());
    assert_eq!(e.insert, [Key::Totp]);
    assert_eq!(
        e.states,
        [KeyState {
            key: Key::Totp,
            state: State::Grace {
                deadline: Some(1000 + 72 * H)
            }
        }]
    );
    assert!(!e.restricted);
    assert_eq!(e.next, Some(Key::Totp));
    assert_eq!(e.reason, None);
}

#[test]
fn the_grace_counts_from_the_row_with_the_current_hours() {
    let c = totp(Scope::Everyone);
    let rows = row(0, None);
    assert!(!judge(&c, &acct(), 72 * H - 1, &rows).restricted);
    let e = judge(&c, &acct(), 72 * H, &rows);
    assert!(e.restricted);
    assert_eq!(e.reason, Some(Reason::Setup));
    assert_eq!(e.insert, []);
    let longer = Controls {
        protection_totp_grace_hours: 100,
        ..c
    };
    assert!(!judge(&longer, &acct(), 72 * H, &rows).restricted);
}

#[test]
fn an_admin_extension_wins_over_the_hours() {
    let rows = row(0, Some(500 * H));
    assert!(!judge(&totp(Scope::Everyone), &acct(), 400 * H, &rows).restricted);
    assert!(judge(&totp(Scope::Everyone), &acct(), 500 * H, &rows).restricted);
}

#[test]
fn grace_0_restricts_at_once() {
    let c = Controls {
        protection_totp_grace_hours: 0,
        ..totp(Scope::Everyone)
    };
    assert!(judge(&c, &acct(), 5, &none()).restricted);
}

#[test]
fn met_or_no_longer_required_the_row_goes_and_the_restriction_with_it() {
    let rows = row(0, None);
    let codes = Account {
        totp_on: true,
        ..acct()
    };
    let met = judge(&totp(Scope::Everyone), &codes, 999 * H, &rows);
    assert_eq!(met.remove, [Key::Totp]);
    assert!(!met.restricted);
    assert_eq!(met.next, None);
    let off = judge(&ctl(), &acct(), 999 * H, &rows);
    assert_eq!(off.remove, [Key::Totp]);
    assert_eq!(off.states, []);
}

#[test]
fn temporary_passwords_follow_design_c() {
    let t = temp(Some(100 * H));
    let strict = judge(&ctl(), &t, 0, &none());
    assert!(strict.restricted);
    assert_eq!(strict.reason, Some(Reason::PasswordChange));
    assert_eq!(strict.next, Some(Key::NewPassword));
    assert_eq!(strict.insert, []);
    let encouraged = Controls {
        password_change: PasswordChange::Encouraged,
        ..ctl()
    };
    let soft = judge(&encouraged, &t, 0, &none());
    assert!(!soft.restricted);
    assert_eq!(
        soft.states,
        [KeyState {
            key: Key::NewPassword,
            state: State::Grace {
                deadline: Some(100 * H)
            }
        }]
    );
    assert!(judge(&encouraged, &t, 100 * H, &none()).restricted);
    assert!(evaluate(&encouraged, &t, &pw(), 0, &none(), &[Key::NewPassword]).restricted);
    let open = judge(&encouraged, &temp(None), 9_000_000_000, &none());
    assert!(!open.restricted);
    assert_eq!(
        open.states,
        [KeyState {
            key: Key::NewPassword,
            state: State::Grace { deadline: None }
        }]
    );
}

#[test]
fn the_password_comes_first_then_the_authenticator_then_the_phrase() {
    let all = Controls {
        protection_totp: Scope::Everyone,
        protection_backup_phrase: Scope::Everyone,
        protection_totp_grace_hours: 0,
        protection_backup_phrase_grace_hours: 0,
        ..ctl()
    };
    let e = judge(&all, &temp(None), 0, &none());
    let keys: Vec<Key> = e.states.iter().map(|s| s.key).collect();
    assert_eq!(keys, [Key::NewPassword, Key::Totp, Key::BackupPhrase]);
    assert_eq!(e.reason, Some(Reason::PasswordChange));
    assert_eq!(judge(&all, &acct(), 0, &none()).next, Some(Key::Totp));
    let codes = Account {
        totp_on: true,
        ..acct()
    };
    assert_eq!(
        judge(&all, &codes, 0, &none()).next,
        Some(Key::BackupPhrase)
    );
    assert_eq!(
        restriction_text(Reason::PasswordChange),
        "Change your password first"
    );
    assert_eq!(
        restriction_text(Reason::Setup),
        "Finish setting up your account first"
    );
}

#[test]
fn deadlines_at_the_ends_of_time_never_overflow() {
    let c = totp(Scope::Everyone);
    let e = judge(&c, &acct(), i64::MAX, &none());
    assert!(e.restricted);
    let far = row(i64::MAX, None);
    assert!(!judge(&c, &acct(), 0, &far).restricted);
    let past = row(i64::MIN, Some(i64::MIN));
    assert!(judge(&c, &acct(), i64::MIN, &past).restricted);
}

#[test]
fn setup_and_session_paths_open_the_rest_closed() {
    let open = |method, path| allowed_while_restricted(method, path, false, false);
    assert!(open("PUT", "/me/two_factor/totp"));
    assert!(open("POST", "/me/two_factor/totp"));
    assert!(open("POST", "/me/password"));
    assert!(open("GET", "/me/policy"));
    assert!(open("GET", "/me/sessions"));
    assert!(open("DELETE", "/me/sessions/abc"));
    assert!(open("POST", "/me/sessions/sign_out_others"));
    assert!(open("GET", "/auth/words/alice"));
    assert!(open("POST", "/auth/recovery/challenge"));
    for path in [
        "/me",
        "/me/protections",
        "/settings",
        "/instance",
        "/brand",
        "/me/two_factor",
        "/me/recovery",
    ] {
        assert!(open("GET", path), "{path}");
    }
    assert!(open("PUT", "/me/recovery"));
    assert!(open("POST", "/auth/logout"));
    assert!(!open("POST", "/auth/reauth/challenge"));
    assert!(!open("POST", "/channels/1/messages"));
    assert!(!open("DELETE", "/me/two_factor"));
    assert!(!open("DELETE", "/me/sessions"));
    assert!(!open("DELETE", "/me/sessions/a/b"));
    assert!(!open("GET", "/auth/words/"));
    assert!(!open("GET", "/me/"));
    assert!(!open("get", "/me"));
    assert!(!open("GET", ""));
}

#[test]
fn an_overdue_admin_keeps_no_admin_power_unless_no_usable_admin_is_left() {
    assert!(!allowed_while_restricted(
        "PATCH",
        "/admin/settings",
        true,
        false
    ));
    assert!(!allowed_while_restricted(
        "GET",
        "/admin/users",
        true,
        false
    ));
    assert!(allowed_while_restricted(
        "PATCH",
        "/admin/settings",
        true,
        true
    ));
    assert!(allowed_while_restricted("GET", "/admin/config", true, true));
    assert!(allowed_while_restricted(
        "GET",
        "/admin/protections",
        true,
        true
    ));
    assert!(!allowed_while_restricted("GET", "/admin/users", true, true));
    assert!(!allowed_while_restricted(
        "PATCH",
        "/admin/settings",
        false,
        true
    ));
    assert!(only_protection_keys(&["protection_totp"]));
    assert!(!only_protection_keys(&["protection_totp", "registration"]));
    assert!(only_protection_keys(&[] as &[&str]));
}

#[test]
fn turning_a_floor_on_is_refused_while_no_admin_meets_it() {
    let facts = [AdminFacts {
        account: admin(),
        can_sign_in: true,
    }];
    let before = ctl();
    assert_eq!(
        check_controls(&totp(Scope::Admins), Some((&before, &facts))),
        refused("protection_totp", NO_ADMIN_LEFT)
    );
    assert_eq!(
        check_controls(&totp(Scope::Everyone), Some((&before, &facts))),
        refused("protection_totp", NO_ADMIN_LEFT)
    );
    let phrase = Controls {
        protection_backup_phrase: Scope::Admins,
        ..ctl()
    };
    assert_eq!(
        check_controls(&phrase, Some((&before, &facts))),
        refused("protection_backup_phrase", NO_ADMIN_LEFT)
    );
    let codes_off = Controls {
        two_factor: false,
        ..totp(Scope::Admins)
    };
    assert_eq!(
        check_controls(&totp(Scope::Admins), Some((&codes_off, &facts))),
        refused("two_factor", NO_ADMIN_LEFT)
    );
    let with_codes = AdminFacts {
        account: Account {
            totp_on: true,
            ..admin()
        },
        can_sign_in: true,
    };
    assert_eq!(
        check_controls(
            &totp(Scope::Admins),
            Some((&before, std::slice::from_ref(&with_codes)))
        ),
        None
    );
    let second = AdminFacts {
        account: Account {
            uid: 2,
            totp_on: true,
            ..admin()
        },
        can_sign_in: true,
    };
    let two = [facts[0].clone(), second];
    assert_eq!(
        check_controls(&totp(Scope::Admins), Some((&before, &two))),
        None
    );
    assert_eq!(
        check_controls(&totp(Scope::Admins), Some((&before, &[]))),
        None
    );
    assert_eq!(
        NO_ADMIN_LEFT,
        "This would leave no site admin who can sign in and meet the required protections. Set them up on an admin account first."
    );
}

fn roles() -> BTreeMap<i64, u32> {
    BTreeMap::from([(10, 4), (11, 32)])
}

fn rule(mod_totp: bool, totp_roles: &[i64]) -> ServerRule {
    ServerRule {
        mod_totp,
        totp_roles: totp_roles.iter().copied().collect::<BTreeSet<i64>>(),
    }
}

#[test]
fn a_role_that_needs_codes_is_inactive_without_them() {
    let m = Member {
        is_admin: false,
        perms: 0,
        roles: roles(),
    };
    assert_eq!(
        server_perms(&m, &rule(false, &[10]), false),
        ServerPerms {
            perms: 32,
            inactive_roles: vec![10],
            masked: 0
        }
    );
    assert_eq!(server_perms(&m, &rule(false, &[10]), true).perms, 36);
}

#[test]
fn all_moderation_permissions_need_codes() {
    let m = Member {
        is_admin: true,
        perms: 0,
        roles: BTreeMap::new(),
    };
    let r = server_perms(&m, &rule(true, &[]), false);
    assert_eq!(r.perms, ALL_PERMS & !MOD_PERMS);
    assert_eq!(r.masked, MOD_PERMS);
    let some = Member {
        is_admin: true,
        perms: 4 | 32 | 4096,
        roles: roles(),
    };
    assert_eq!(server_perms(&some, &rule(false, &[]), false).perms, 36);
    assert_eq!(server_perms(&some, &rule(true, &[]), true).perms, 36);
}

#[test]
fn the_refusal_is_the_servers_own_setting() {
    assert_eq!(mask_reason(false).kind, "off_server");
    assert_eq!(mask_reason(false).control, "mod_totp");
    assert_eq!(mask_reason(true).control, "role.requires_totp");
}

#[test]
fn who_may_change_the_rule() {
    assert!(!may_change_server_rule(true, false, true, false));
    assert!(may_change_server_rule(true, true, true, false));
    assert!(may_change_server_rule(false, false, false, true));
    assert!(!may_change_server_rule(false, true, false, false));
}

#[test]
fn only_admins_who_can_sign_in_and_already_meet_every_requirement_count() {
    let c = totp(Scope::Admins);
    let facts = |account: Account, can_sign_in: bool| AdminFacts {
        account,
        can_sign_in,
    };
    let codes = Account {
        totp_on: true,
        ..admin()
    };
    assert!(!usable_admin(&c, &facts(admin(), true), &[]));
    assert!(usable_admin(&c, &facts(codes.clone(), true), &[]));
    assert!(!usable_admin(&c, &facts(codes.clone(), false), &[]));
    assert!(usable_admin(&ctl(), &facts(admin(), true), &[]));
    let temporary = Account {
        temp: Some(Temp { expires_at: None }),
        ..admin()
    };
    assert!(!usable_admin(&ctl(), &facts(temporary, true), &[]));
    let phrase_off = Controls {
        backup_phrase: false,
        ..ctl()
    };
    assert!(usable_admin(
        &phrase_off,
        &facts(admin(), true),
        &[Key::BackupPhrase]
    ));
    let not_admin = Account {
        is_site_admin: false,
        ..codes
    };
    assert!(!usable_admin(&c, &facts(not_admin, true), &[]));
}

#[test]
fn a_requirement_whose_feature_is_off_is_not_enforced() {
    let no_codes = Controls {
        two_factor: false,
        ..ctl()
    };
    assert_eq!(
        unenforceable(&no_codes, Key::Totp),
        Some("Can't be required: authenticator codes are off")
    );
    assert_eq!(unenforceable(&ctl(), Key::Totp), None);
    let phrase_off = Controls {
        backup_phrase: false,
        ..ctl()
    };
    assert_eq!(
        unenforceable(&phrase_off, Key::BackupPhrase),
        Some("Can't be required: backup phrases are off")
    );
    assert_eq!(required(&phrase_off, &acct(), &[Key::BackupPhrase]), []);
}

#[test]
fn clearing_protections_starts_a_new_grace_instead_of_restricting() {
    let c = Controls {
        protection_totp: Scope::Everyone,
        protection_totp_grace_hours: 24,
        protection_backup_phrase: Scope::Everyone,
        ..ctl()
    };
    let before = Account {
        totp_on: true,
        phrase_set: true,
        ..acct()
    };
    let r = clear_protections(&before, 1000, false);
    assert_eq!(r.cleared, [Key::Totp]);
    assert!(!r.account.totp_on && r.account.phrase_set);
    let e = judge(&c, &r.account, 1000, &r.rows);
    assert!(!e.restricted);
    assert_eq!(
        e.states,
        [
            KeyState {
                key: Key::Totp,
                state: State::Grace {
                    deadline: Some(1000 + 24 * H)
                }
            },
            KeyState {
                key: Key::BackupPhrase,
                state: State::Met
            },
        ]
    );
    assert_eq!(r.audit, "user.clear_protections");
    let all = clear_protections(&before, 1000, true);
    assert_eq!(all.cleared, [Key::Totp, Key::BackupPhrase]);
    assert!(!all.account.totp_on && !all.account.phrase_set);
    assert!(!judge(&c, &all.account, 1000, &all.rows).restricted);
}
