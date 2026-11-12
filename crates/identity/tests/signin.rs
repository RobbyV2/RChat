use rchat_identity::signin::{
    ACCOUNT_DAY_FAILS, ACR_1, ACR_2, ACR_2_PROVIDER, ACR_VALUES_SUPPORTED, Answer, CodeAsk,
    CodeLimits, DAY_FAILS, First, HOUR_FAILS, Kind, Limit, LoginAccount, Method, NEVER_ONE_SIGN_IN,
    PENDING_SECS, PENDING_TRIES, Pending, Proof, Purpose, Sso, SsoMode, StepAnswer, StepInput,
    StepKind, USED_TEXT, Verdict, acr_for, acr_of, amr_of, enough, kinds, login, notifies_others,
    reauth_ok, sso_trusted, step,
};

use Proof::{Device, Phrase, Pwd, RecoveryCode, Totp};

const T: i64 = 1_800_000_000;

fn base() -> LoginAccount {
    LoginAccount {
        uid: 1,
        totp_on: true,
        phrase_set: false,
        password_ok: true,
        device_ok: false,
        code: None,
    }
}

fn pending() -> Pending {
    Pending {
        username: "alice".to_string(),
        uid: 1,
        first: First::Pwd,
        sso: None,
        tries: PENDING_TRIES,
        expires_at: T + 300,
    }
}

fn sso(mode: SsoMode, amr: &[&str]) -> Sso {
    Sso {
        mode,
        amr: amr.iter().map(|s| s.to_string()).collect(),
    }
}

fn input(kind: StepKind, verdict: Verdict) -> StepInput {
    StepInput { kind, verdict }
}

#[test]
fn without_codes_today() {
    assert!(enough(false, &[Pwd], None));
    assert!(enough(false, &[Phrase], None));
    assert!(enough(
        false,
        &[Proof::Sso],
        Some(&sso(SsoMode::Rchat, &[]))
    ));
    assert!(!enough(false, &[], None));
    assert!(!enough(false, &[Totp], None));
}

#[test]
fn with_codes() {
    assert!(!enough(true, &[Pwd], None));
    assert!(enough(true, &[Pwd, Totp], None));
    assert!(enough(true, &[Pwd, RecoveryCode], None));
    assert!(enough(true, &[Pwd, Phrase], None));
    assert!(enough(true, &[Phrase, Totp], None));
    assert!(enough(true, &[RecoveryCode, Totp], None));
    assert!(enough(true, &[Pwd, Device], None));
    assert!(!enough(true, &[Phrase, Device], None));
}

#[test]
fn the_backup_kit_alone_is_one_kind_and_refused() {
    assert!(!enough(true, &[Phrase, RecoveryCode], None));
    assert_eq!(kinds(&[Phrase, RecoveryCode], None).len(), 1);
    assert!(kinds(&[Phrase, RecoveryCode], None).contains(&Kind::Stored));
    let p = Pending {
        first: First::Phrase,
        ..pending()
    };
    let (answer, kept) = step(
        Some(p.clone()),
        "alice",
        input(StepKind::RecoveryCode, Verdict::Ok),
        &mut CodeLimits::new(),
        "g1",
        T,
    );
    assert_eq!(answer, StepAnswer::SameKind);
    assert_eq!(answer.status(), 400);
    assert_eq!(
        answer.error(),
        Some("Use your authenticator app or your password with this")
    );
    assert_eq!(kept, Some(p));
}

#[test]
fn a_provider_sign_in_is_one_proof_unless_the_operator_marked_the_provider() {
    let one = [Proof::Sso];
    assert!(!enough(true, &one, Some(&sso(SsoMode::Rchat, &["mfa"]))));
    assert!(!enough(true, &one, Some(&sso(SsoMode::Amr, &["pwd"]))));
    assert!(enough(
        true,
        &one,
        Some(&sso(SsoMode::Amr, &["pwd", "mfa"]))
    ));
    assert!(enough(true, &one, Some(&sso(SsoMode::Provider, &[]))));
    assert!(enough(
        true,
        &[Proof::Sso, Totp],
        Some(&sso(SsoMode::Rchat, &[]))
    ));
    assert!(!sso_trusted(Some(&sso(SsoMode::Rchat, &["mfa"]))));
    assert!(!sso_trusted(None));
    assert!(!enough(true, &one, None));
}

#[test]
fn rfc_8176_values_2fa_only_for_two_kinds_proven_now() {
    assert_eq!(amr_of(&[Pwd], None), ["pwd"]);
    assert_eq!(amr_of(&[Pwd, Totp], None), ["mfa", "otp", "pwd"]);
    assert_eq!(amr_of(&[Pwd, Phrase], None), ["mfa", "pwd", "swk"]);
    assert_eq!(amr_of(&[Pwd, Device], None), ["pwd"]);
    assert_eq!(acr_of(&amr_of(&[Phrase, RecoveryCode], None)), ACR_1);
    assert_eq!(acr_of(&amr_of(&[Pwd, Totp], None)), ACR_2);
    assert_eq!(
        amr_of(
            &[Proof::Sso],
            Some(&sso(SsoMode::Amr, &["pwd", "mfa", "made-up"]))
        ),
        ["mfa", "pwd"]
    );
    assert_eq!(
        amr_of(&[Proof::Sso], Some(&sso(SsoMode::Rchat, &["pwd", "mfa"]))),
        ["pwd"]
    );
    assert_eq!(amr_of(&[], None), [] as [&str; 0]);
}

#[test]
fn an_unmarked_providers_own_second_factor_claims_never_reach_the_session() {
    let claims = ["pwd", "otp", "hwk", "swk", "mfa", "pin"];
    let unmarked = sso(SsoMode::Rchat, &claims);
    assert_eq!(amr_of(&[Proof::Sso], Some(&unmarked)), ["pin", "pwd"]);
    assert_eq!(acr_for(&[Proof::Sso], Some(&unmarked)), ACR_1);
    assert_eq!(
        amr_of(&[Proof::Sso, Totp], Some(&unmarked)),
        ["mfa", "otp", "pin", "pwd"]
    );
    let untrusted = sso(SsoMode::Amr, &["pwd", "pin"]);
    assert_eq!(amr_of(&[Proof::Sso], Some(&untrusted)), ["pin", "pwd"]);
    let trusted = sso(SsoMode::Amr, &claims);
    assert_eq!(
        amr_of(&[Proof::Sso], Some(&trusted)),
        ["hwk", "mfa", "otp", "pin", "pwd", "swk"]
    );
    let marked = sso(SsoMode::Provider, &["pwd", "otp"]);
    assert_eq!(amr_of(&[Proof::Sso], Some(&marked)), ["mfa", "otp", "pwd"]);
}

#[test]
fn the_acr_says_when_the_second_kind_rests_on_the_provider() {
    let provider = sso(SsoMode::Provider, &[]);
    assert_eq!(acr_for(&[Pwd], None), ACR_1);
    assert_eq!(acr_for(&[Pwd, Totp], None), ACR_2);
    assert_eq!(acr_for(&[Proof::Sso], Some(&provider)), ACR_2_PROVIDER);
    assert_eq!(acr_for(&[Proof::Sso, Totp], Some(&provider)), ACR_2);
    assert_eq!(
        acr_for(&[Proof::Sso], Some(&sso(SsoMode::Amr, &["pwd", "mfa"]))),
        ACR_2
    );
    assert_eq!(
        acr_for(&[Proof::Sso], Some(&sso(SsoMode::Rchat, &["mfa"]))),
        ACR_1
    );
    assert_eq!(
        ACR_VALUES_SUPPORTED,
        [
            "urn:rchat:acr:1fa",
            "urn:rchat:acr:2fa",
            "urn:rchat:acr:2fa-provider"
        ]
    );
}

#[test]
fn the_phrase_or_a_recovery_code_tells_the_other_sessions() {
    assert!(notifies_others(&[Pwd, Phrase]));
    assert!(notifies_others(&[Pwd, RecoveryCode]));
    assert!(!notifies_others(&[Pwd, Totp]));
}

#[test]
fn login_answers() {
    let mut lim = CodeLimits::new();
    let mut ask = |a: LoginAccount| login(&a, &mut lim, "g", T);
    let wrong_password = ask(LoginAccount {
        password_ok: false,
        ..base()
    });
    assert_eq!(wrong_password, Answer::InvalidCredentials);
    assert_eq!(wrong_password.status(), 401);
    assert_eq!(wrong_password.error(), Some("Invalid credentials"));
    let no_codes = ask(LoginAccount {
        totp_on: false,
        ..base()
    });
    assert_eq!(no_codes, Answer::Session { proofs: vec![Pwd] });
    assert_eq!((no_codes.status(), no_codes.error()), (200, None));
    let code_needed = ask(base());
    assert_eq!(
        code_needed,
        Answer::SecondFactor {
            ask: CodeAsk::Enter,
            methods: vec![Method::Totp, Method::RecoveryCode]
        }
    );
    assert_eq!(code_needed.status(), 401);
    assert_eq!(
        code_needed.error(),
        Some("Enter the code from your authenticator app")
    );
    assert_eq!(
        ask(LoginAccount {
            phrase_set: true,
            ..base()
        }),
        Answer::SecondFactor {
            ask: CodeAsk::Enter,
            methods: vec![Method::Totp, Method::RecoveryCode, Method::Phrase]
        }
    );
    assert_eq!(
        ask(LoginAccount {
            code: Some(Verdict::Ok),
            ..base()
        }),
        Answer::Session {
            proofs: vec![Pwd, Totp]
        }
    );
    let wrong = ask(LoginAccount {
        code: Some(Verdict::Wrong),
        ..base()
    });
    assert_eq!((wrong.status(), wrong.error()), (401, Some("Wrong code")));
    let malformed = ask(LoginAccount {
        code: Some(Verdict::Malformed),
        ..base()
    });
    assert_eq!(malformed, Answer::NotACode);
    assert_eq!(
        (malformed.status(), malformed.error()),
        (400, Some("That is not a code"))
    );
    assert_eq!(
        ask(LoginAccount {
            device_ok: true,
            ..base()
        }),
        Answer::Session {
            proofs: vec![Pwd, Device]
        }
    );
    assert_eq!(
        [Method::Totp, Method::RecoveryCode, Method::Phrase].map(Method::name),
        ["totp", "recovery_code", "phrase"]
    );
}

#[test]
fn a_wrong_password_never_reveals_that_the_account_has_codes() {
    let mut lim = CodeLimits::new();
    let with = login(
        &LoginAccount {
            password_ok: false,
            totp_on: true,
            ..base()
        },
        &mut lim,
        "g",
        T,
    );
    let without = login(
        &LoginAccount {
            password_ok: false,
            totp_on: false,
            ..base()
        },
        &mut lim,
        "g",
        T,
    );
    assert_eq!(with, without);
}

#[test]
fn a_just_used_code_is_already_used_not_wrong_and_costs_nothing() {
    let mut lim = CodeLimits::new();
    let (answer, kept) = step(
        Some(pending()),
        "alice",
        input(StepKind::Totp, Verdict::Used),
        &mut lim,
        "g",
        T,
    );
    assert_eq!(
        answer,
        StepAnswer::Used {
            tries_left: PENDING_TRIES
        }
    );
    assert_eq!((answer.status(), answer.error()), (401, Some(USED_TEXT)));
    assert_eq!(kept, Some(pending()));
    assert_eq!(lim.count(1, "g", T), 0);
    let again = login(
        &LoginAccount {
            code: Some(Verdict::Used),
            ..base()
        },
        &mut lim,
        "g",
        T,
    );
    assert_eq!(again.error(), Some(USED_TEXT));
    assert_eq!(lim.count(1, "g", T), 0);
    assert_eq!(USED_TEXT, "That code was just used. Wait for the next one.");
}

#[test]
fn the_reservation_is_atomic_so_the_eleventh_guess_in_an_hour_is_refused() {
    let mut lim = CodeLimits::new();
    let results: Vec<Limit> = (0..=HOUR_FAILS).map(|_| lim.reserve(1, "g", T)).collect();
    assert_eq!(
        results.iter().filter(|r| **r == Limit::Ok).count(),
        HOUR_FAILS as usize
    );
    assert_eq!(results[HOUR_FAILS as usize], Limit::Hour);
    assert_eq!(lim.count(1, "g", T), HOUR_FAILS);
    assert_eq!(lim.state(1, "g", T + 3600), Limit::Ok);
}

#[test]
fn a_right_code_refunds_its_try() {
    let mut lim = CodeLimits::new();
    let (answer, kept) = step(
        Some(pending()),
        "alice",
        input(StepKind::Totp, Verdict::Ok),
        &mut lim,
        "g",
        T,
    );
    assert_eq!(
        answer,
        StepAnswer::Session {
            proofs: vec![Pwd, Totp]
        }
    );
    assert_eq!(kept, None);
    assert_eq!(lim.count(1, "g", T), 0);
}

#[test]
fn guesses_from_another_network_never_lock_this_one_until_the_account_cap() {
    let mut lim = CodeLimits::new();
    for h in 0..2 {
        for _ in 0..HOUR_FAILS {
            lim.reserve(1, "attacker", T + h * 3600);
        }
    }
    let later = T + 7200;
    assert_eq!(lim.state(1, "attacker", later), Limit::Day);
    assert_eq!(lim.state(1, "home", later), Limit::Ok);
    assert_eq!(DAY_FAILS, 20);
    for i in 0..(ACCOUNT_DAY_FAILS - DAY_FAILS) {
        lim.reserve(1, &format!("n{i}"), later);
    }
    assert_eq!(lim.state(1, "home", later), Limit::Account);
    assert_eq!(lim.state(2, "home", later), Limit::Ok);
    let device = login(
        &LoginAccount {
            device_ok: true,
            ..base()
        },
        &mut lim,
        "home",
        later,
    );
    assert_eq!(device.status(), 200);
    let phrase = step(
        Some(Pending {
            expires_at: T + 8000,
            ..pending()
        }),
        "alice",
        input(StepKind::Phrase, Verdict::Ok),
        &mut lim,
        "home",
        later,
    );
    assert_eq!(phrase.0.status(), 200);
    let locked = login(
        &LoginAccount {
            code: Some(Verdict::Ok),
            phrase_set: true,
            ..base()
        },
        &mut lim,
        "home",
        later,
    );
    assert_eq!(
        locked,
        Answer::Locked {
            limit: Limit::Account,
            methods: vec![Method::Phrase]
        }
    );
    assert_eq!(
        (locked.status(), locked.error()),
        (423, Some("Too many wrong codes. Try again later"))
    );
    let asked = login(&base(), &mut lim, "home", later);
    assert_eq!(
        asked,
        Answer::SecondFactor {
            ask: CodeAsk::Enter,
            methods: vec![]
        }
    );
    let step_locked = step(
        Some(pending()),
        "alice",
        input(StepKind::Totp, Verdict::Ok),
        &mut lim,
        "home",
        T + 100,
    );
    assert_eq!(
        step_locked.0,
        StepAnswer::Locked {
            limit: Limit::Account
        }
    );
    assert_eq!(step_locked.1, Some(pending()));
}

#[test]
fn a_password_change_clears_the_counters() {
    let mut lim = CodeLimits::new();
    for _ in 0..HOUR_FAILS {
        lim.reserve(1, "g", T);
        lim.reserve(11, "g", T);
    }
    lim.clear(1);
    assert_eq!(lim.state(1, "g", T), Limit::Ok);
    assert_eq!(lim.state(11, "g", T), Limit::Hour);
}

#[test]
fn counters_reset_by_the_hour_and_the_utc_day_and_never_underflow() {
    let mut lim = CodeLimits::new();
    let day_start = 86400 * 20_000;
    for _ in 0..HOUR_FAILS {
        lim.reserve(1, "g", day_start + 80_000);
    }
    assert_eq!(lim.state(1, "g", day_start + 80_000 + 3599), Limit::Hour);
    assert_eq!(lim.state(1, "g", day_start + 80_000 + 3600), Limit::Ok);
    assert_eq!(lim.count(1, "g", day_start + 86399), HOUR_FAILS);
    assert_eq!(lim.count(1, "g", day_start + 86400), 0);
    let mut fresh = CodeLimits::new();
    fresh.refund(1, "g", T);
    assert_eq!(fresh.count(1, "g", T), 0);
    for now in [i64::MIN, i64::MAX] {
        assert_eq!(fresh.reserve(7, "g", now), Limit::Ok);
        fresh.refund(7, "g", now);
    }
}

#[test]
fn tries_run_out_and_the_pending_dies() {
    let mut cur = Some(pending());
    let mut lim = CodeLimits::new();
    for left in (0..PENDING_TRIES).rev() {
        let (answer, next) = step(
            cur,
            "alice",
            input(StepKind::Totp, Verdict::Wrong),
            &mut lim,
            "g",
            T,
        );
        assert_eq!(answer, StepAnswer::Wrong { tries_left: left });
        assert_eq!((answer.status(), answer.error()), (401, Some("Wrong code")));
        cur = next;
    }
    assert_eq!(cur, None);
    let gone = step(
        cur,
        "alice",
        input(StepKind::Totp, Verdict::Ok),
        &mut lim,
        "g",
        T,
    );
    assert_eq!(gone.0, StepAnswer::Expired);
    assert_eq!(
        (gone.0.status(), gone.0.error()),
        (400, Some("Sign-in expired. Try again"))
    );
}

#[test]
fn expired_wrong_name_after_the_phrase_only_the_authenticator() {
    let mut lim = CodeLimits::new();
    let ok = input(StepKind::Totp, Verdict::Ok);
    assert_eq!(PENDING_SECS, 300);
    assert_eq!(
        step(Some(pending()), "alice", ok, &mut lim, "g", T + 300).0,
        StepAnswer::Expired
    );
    assert_eq!(
        step(Some(pending()), "bob", ok, &mut lim, "g", T).0,
        StepAnswer::Expired
    );
    let spent = Pending {
        tries: 0,
        ..pending()
    };
    assert_eq!(
        step(Some(spent), "alice", ok, &mut lim, "g", T),
        (StepAnswer::Expired, None)
    );
    let after_phrase = Pending {
        first: First::Phrase,
        ..pending()
    };
    assert_eq!(
        step(
            Some(after_phrase.clone()),
            "alice",
            input(StepKind::Phrase, Verdict::Ok),
            &mut lim,
            "g",
            T
        )
        .0
        .status(),
        400
    );
    assert_eq!(
        step(Some(after_phrase), "alice", ok, &mut lim, "g", T).0,
        StepAnswer::Session {
            proofs: vec![Phrase, Totp]
        }
    );
}

#[test]
fn an_untrusted_provider_sign_in_continues_with_the_account_code() {
    let mut lim = CodeLimits::new();
    let p = Pending {
        first: First::Sso,
        sso: Some(sso(SsoMode::Rchat, &[])),
        ..pending()
    };
    assert_eq!(
        step(
            Some(p),
            "alice",
            input(StepKind::Totp, Verdict::Ok),
            &mut lim,
            "g",
            T
        )
        .0,
        StepAnswer::Session {
            proofs: vec![Proof::Sso, Totp]
        }
    );
}

#[test]
fn a_malformed_code_at_the_step_costs_nothing() {
    let mut lim = CodeLimits::new();
    let (answer, kept) = step(
        Some(pending()),
        "alice",
        input(StepKind::RecoveryCode, Verdict::Malformed),
        &mut lim,
        "g",
        T,
    );
    assert_eq!(
        answer,
        StepAnswer::Used {
            tries_left: PENDING_TRIES
        }
    );
    assert_eq!(kept, Some(pending()));
    assert_eq!(lim.count(1, "g", T), 0);
}

#[test]
fn reauth_without_codes_one_proof_as_today() {
    assert!(reauth_ok(false, Purpose::SetPhrase, &[Pwd], None));
    assert!(!reauth_ok(false, Purpose::SetPhrase, &[Pwd, Totp], None));
    assert!(!reauth_ok(false, Purpose::SetPhrase, &[], None));
    assert!(!reauth_ok(false, Purpose::SetPhrase, &[Device], None));
}

#[test]
fn reauth_with_codes_two_kinds() {
    assert!(!reauth_ok(true, Purpose::SetPhrase, &[Pwd], None));
    assert!(reauth_ok(true, Purpose::SetPhrase, &[Pwd, Totp], None));
    assert!(reauth_ok(true, Purpose::TotpOff, &[Phrase, Totp], None));
    assert!(!reauth_ok(
        true,
        Purpose::TotpOff,
        &[Phrase, RecoveryCode],
        None
    ));
    assert!(!reauth_ok(true, Purpose::TotpOff, &[Pwd, Device], None));
    assert!(!reauth_ok(true, Purpose::TotpOff, &[Pwd, Pwd], None));
    assert!(reauth_ok(false, Purpose::TotpOn, &[Pwd], None));
    assert!(!reauth_ok(false, Purpose::TotpOn, &[Totp], None));
    assert!(!reauth_ok(true, Purpose::TotpOn, &[Pwd], None));
    assert!(!reauth_ok(
        true,
        Purpose::SetPhrase,
        &[Pwd, Totp, Phrase],
        None
    ));
    assert!(reauth_ok(
        true,
        Purpose::ApplicationConsentStrong,
        &[Pwd, Totp],
        None
    ));
    assert!(!reauth_ok(
        true,
        Purpose::ApplicationConsentStrong,
        &[Pwd],
        None
    ));
}

#[test]
fn no_one_sign_in_turns_codes_off_links_a_provider_or_changes_the_password() {
    let trusted = sso(SsoMode::Provider, &[]);
    let one = [Proof::Sso];
    assert!(!reauth_ok(true, Purpose::TotpOff, &one, Some(&trusted)));
    assert!(!reauth_ok(true, Purpose::LinkIdp, &one, Some(&trusted)));
    assert!(!reauth_ok(true, Purpose::SetPassword, &one, Some(&trusted)));
    assert!(!reauth_ok(true, Purpose::PasswordChange, &[Pwd], None));
    assert!(reauth_ok(true, Purpose::PasswordChange, &[Pwd, Totp], None));
    assert!(reauth_ok(true, Purpose::TotpOff, &[Proof::Sso, Totp], None));
    assert!(!reauth_ok(true, Purpose::TotpOff, &[Proof::Sso, Pwd], None));
    assert!(reauth_ok(true, Purpose::SetPhrase, &one, Some(&trusted)));
    assert!(!reauth_ok(
        true,
        Purpose::SetPhrase,
        &one,
        Some(&sso(SsoMode::Amr, &["pwd"]))
    ));
    assert_eq!(
        NEVER_ONE_SIGN_IN,
        [
            Purpose::TotpOff,
            Purpose::LinkIdp,
            Purpose::SetPassword,
            Purpose::PasswordChange
        ]
    );
}
