use std::collections::{BTreeSet, HashMap};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Proof {
    Pwd,
    Totp,
    RecoveryCode,
    Phrase,
    Device,
    Sso,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Kind {
    Knowledge,
    Possession,
    Stored,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SsoMode {
    Rchat,
    Amr,
    Provider,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Sso {
    pub mode: SsoMode,
    pub amr: Vec<String>,
}

pub const MFA_AMR: [&str; 4] = ["mfa", "otp", "hwk", "swk"];

pub(crate) fn trusted_mode(mode: SsoMode, amr: &[String]) -> bool {
    match mode {
        SsoMode::Provider => true,
        SsoMode::Amr => amr.iter().any(|v| MFA_AMR.contains(&v.as_str())),
        SsoMode::Rchat => false,
    }
}

pub fn sso_trusted(sso: Option<&Sso>) -> bool {
    sso.is_some_and(|s| trusted_mode(s.mode, &s.amr))
}

pub fn kinds(proofs: &[Proof], sso: Option<&Sso>) -> BTreeSet<Kind> {
    let mut out = BTreeSet::new();
    for p in proofs {
        match p {
            Proof::Pwd => out.insert(Kind::Knowledge),
            Proof::Totp | Proof::Device => out.insert(Kind::Possession),
            Proof::Phrase | Proof::RecoveryCode => out.insert(Kind::Stored),
            Proof::Sso => {
                if sso_trusted(sso) {
                    out.insert(Kind::Possession);
                }
                out.insert(Kind::Knowledge)
            }
        };
    }
    out
}

pub fn enough(totp_on: bool, proofs: &[Proof], sso: Option<&Sso>) -> bool {
    if proofs.is_empty() {
        return false;
    }
    if proofs.contains(&Proof::Device) && !proofs.contains(&Proof::Pwd) {
        return false;
    }
    match totp_on {
        false => proofs
            .iter()
            .any(|p| matches!(p, Proof::Pwd | Proof::Phrase | Proof::Sso)),
        true => kinds(proofs, sso).len() >= 2,
    }
}

pub const REGISTERED_AMR: [&str; 21] = [
    "face", "fpt", "geo", "hwk", "iris", "kba", "mca", "mfa", "otp", "pin", "pop", "pwd", "rba",
    "retina", "sc", "sms", "swk", "tel", "user", "vbm", "wia",
];

pub fn amr_of(proofs: &[Proof], sso: Option<&Sso>) -> Vec<String> {
    let mut out: BTreeSet<&str> = BTreeSet::new();
    for p in proofs {
        match (p, sso) {
            (Proof::Pwd, _) => {
                out.insert("pwd");
            }
            (Proof::Totp | Proof::RecoveryCode, _) => {
                out.insert("otp");
            }
            (Proof::Phrase, _) => {
                out.insert("swk");
            }
            (Proof::Sso, Some(s)) => {
                let trusted = sso_trusted(Some(s));
                let known = REGISTERED_AMR
                    .iter()
                    .filter(|v| trusted || !MFA_AMR.contains(v))
                    .filter(|v| s.amr.iter().any(|a| a == *v));
                out.extend(known);
            }
            (Proof::Sso, None) | (Proof::Device, _) => {}
        }
    }
    let now: Vec<Proof> = proofs
        .iter()
        .copied()
        .filter(|p| *p != Proof::Device)
        .collect();
    match kinds(&now, sso).len() >= 2 {
        true => out.insert("mfa"),
        false => out.remove("mfa"),
    };
    out.into_iter().map(str::to_string).collect()
}

pub const ACR_1: &str = "urn:rchat:acr:1fa";
pub const ACR_2: &str = "urn:rchat:acr:2fa";
pub const ACR_2_PROVIDER: &str = "urn:rchat:acr:2fa-provider";
pub const ACR_VALUES_SUPPORTED: [&str; 3] = [ACR_1, ACR_2, ACR_2_PROVIDER];

fn has_mfa(amr: &[String]) -> bool {
    amr.iter().any(|v| v == "mfa")
}

pub fn acr_of(amr: &[String]) -> &'static str {
    match has_mfa(amr) {
        true => ACR_2,
        false => ACR_1,
    }
}

pub fn acr_for(proofs: &[Proof], sso: Option<&Sso>) -> &'static str {
    if !has_mfa(&amr_of(proofs, sso)) {
        return ACR_1;
    }
    let Some(Sso {
        mode: SsoMode::Provider,
        amr,
    }) = sso
    else {
        return ACR_2;
    };
    let unmarked = Sso {
        mode: SsoMode::Rchat,
        amr: amr.clone(),
    };
    match has_mfa(&amr_of(proofs, Some(&unmarked))) {
        true => ACR_2,
        false => ACR_2_PROVIDER,
    }
}

pub fn notifies_others(proofs: &[Proof]) -> bool {
    proofs.contains(&Proof::Phrase) || proofs.contains(&Proof::RecoveryCode)
}

pub const PENDING_SECS: i64 = 300;
pub const PENDING_TRIES: u32 = 5;
pub const HOUR_FAILS: u32 = 10;
pub const DAY_FAILS: u32 = 20;
pub const ACCOUNT_DAY_FAILS: u32 = 30;
const ACCOUNT_ROW: &str = "*";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Counter {
    hour_start: i64,
    hour: u32,
    day: i64,
    day_count: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Limit {
    Ok,
    Hour,
    Day,
    Account,
}

impl Limit {
    pub fn name(self) -> &'static str {
        match self {
            Limit::Ok => "ok",
            Limit::Hour => "hour",
            Limit::Day => "day",
            Limit::Account => "account",
        }
    }
}

#[derive(Clone, Debug, Default)]
pub struct CodeLimits {
    rows: HashMap<(i64, String), Counter>,
}

impl CodeLimits {
    pub fn new() -> CodeLimits {
        CodeLimits::default()
    }

    fn fresh(&self, uid: i64, grp: &str, now: i64) -> Counter {
        let day = now.div_euclid(86400);
        let base = self
            .rows
            .get(&(uid, grp.to_string()))
            .copied()
            .unwrap_or(Counter {
                hour_start: now,
                hour: 0,
                day,
                day_count: 0,
            });
        let new_hour = now.saturating_sub(base.hour_start) >= 3600;
        Counter {
            hour_start: match new_hour {
                true => now,
                false => base.hour_start,
            },
            hour: match new_hour {
                true => 0,
                false => base.hour,
            },
            day,
            day_count: match base.day == day {
                true => base.day_count,
                false => 0,
            },
        }
    }

    pub fn state(&self, uid: i64, grp: &str, now: i64) -> Limit {
        let net = self.fresh(uid, grp, now);
        let all = self.fresh(uid, ACCOUNT_ROW, now);
        if all.day_count >= ACCOUNT_DAY_FAILS {
            return Limit::Account;
        }
        if net.day_count >= DAY_FAILS {
            return Limit::Day;
        }
        if net.hour >= HOUR_FAILS {
            return Limit::Hour;
        }
        Limit::Ok
    }

    pub fn reserve(&mut self, uid: i64, grp: &str, now: i64) -> Limit {
        let state = self.state(uid, grp, now);
        if state != Limit::Ok {
            return state;
        }
        for g in [grp, ACCOUNT_ROW] {
            let c = self.fresh(uid, g, now);
            self.rows.insert(
                (uid, g.to_string()),
                Counter {
                    hour: c.hour.saturating_add(1),
                    day_count: c.day_count.saturating_add(1),
                    ..c
                },
            );
        }
        Limit::Ok
    }

    pub fn refund(&mut self, uid: i64, grp: &str, now: i64) {
        for g in [grp, ACCOUNT_ROW] {
            let c = self.fresh(uid, g, now);
            self.rows.insert(
                (uid, g.to_string()),
                Counter {
                    hour: c.hour.saturating_sub(1),
                    day_count: c.day_count.saturating_sub(1),
                    ..c
                },
            );
        }
    }

    pub fn clear(&mut self, uid: i64) {
        self.rows.retain(|(u, _), _| *u != uid);
    }

    pub fn count(&self, uid: i64, grp: &str, now: i64) -> u32 {
        self.fresh(uid, grp, now).day_count
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Verdict {
    Ok,
    Wrong,
    Used,
    Malformed,
}

pub const USED_TEXT: &str = "That code was just used. Wait for the next one.";
const LOCKED_TEXT: &str = "Too many wrong codes. Try again later";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LoginAccount {
    pub uid: i64,
    pub totp_on: bool,
    pub phrase_set: bool,
    pub password_ok: bool,
    pub device_ok: bool,
    pub code: Option<Verdict>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Method {
    Totp,
    RecoveryCode,
    Phrase,
}

impl Method {
    pub fn name(self) -> &'static str {
        match self {
            Method::Totp => "totp",
            Method::RecoveryCode => "recovery_code",
            Method::Phrase => "phrase",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CodeAsk {
    Enter,
    Wrong,
    Used,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Answer {
    Session { proofs: Vec<Proof> },
    InvalidCredentials,
    SecondFactor { ask: CodeAsk, methods: Vec<Method> },
    Locked { limit: Limit, methods: Vec<Method> },
    NotACode,
}

impl Answer {
    pub fn status(&self) -> u16 {
        match self {
            Answer::Session { .. } => 200,
            Answer::InvalidCredentials | Answer::SecondFactor { .. } => 401,
            Answer::Locked { .. } => 423,
            Answer::NotACode => 400,
        }
    }

    pub fn error(&self) -> Option<&'static str> {
        match self {
            Answer::Session { .. } => None,
            Answer::InvalidCredentials => Some("Invalid credentials"),
            Answer::SecondFactor {
                ask: CodeAsk::Enter,
                ..
            } => Some("Enter the code from your authenticator app"),
            Answer::SecondFactor {
                ask: CodeAsk::Wrong,
                ..
            } => Some("Wrong code"),
            Answer::SecondFactor {
                ask: CodeAsk::Used, ..
            } => Some(USED_TEXT),
            Answer::Locked { .. } => Some(LOCKED_TEXT),
            Answer::NotACode => Some("That is not a code"),
        }
    }
}

fn methods(a: &LoginAccount, codes_open: bool) -> Vec<Method> {
    let mut out = Vec::new();
    if codes_open {
        out.extend([Method::Totp, Method::RecoveryCode]);
    }
    if a.phrase_set {
        out.push(Method::Phrase);
    }
    out
}

pub fn login(a: &LoginAccount, lim: &mut CodeLimits, grp: &str, now: i64) -> Answer {
    if !a.password_ok {
        return Answer::InvalidCredentials;
    }
    if !a.totp_on {
        return Answer::Session {
            proofs: vec![Proof::Pwd],
        };
    }
    if a.device_ok {
        return Answer::Session {
            proofs: vec![Proof::Pwd, Proof::Device],
        };
    }
    let open = lim.state(a.uid, grp, now) == Limit::Ok;
    let verdict = match a.code {
        None => {
            return Answer::SecondFactor {
                ask: CodeAsk::Enter,
                methods: methods(a, open),
            };
        }
        Some(Verdict::Malformed) => return Answer::NotACode,
        Some(verdict) => verdict,
    };
    let reserved = lim.reserve(a.uid, grp, now);
    if reserved != Limit::Ok {
        return Answer::Locked {
            limit: reserved,
            methods: methods(a, false),
        };
    }
    match verdict {
        Verdict::Ok => {
            lim.refund(a.uid, grp, now);
            Answer::Session {
                proofs: vec![Proof::Pwd, Proof::Totp],
            }
        }
        Verdict::Used | Verdict::Malformed => {
            lim.refund(a.uid, grp, now);
            Answer::SecondFactor {
                ask: CodeAsk::Used,
                methods: methods(a, true),
            }
        }
        Verdict::Wrong => Answer::SecondFactor {
            ask: CodeAsk::Wrong,
            methods: methods(a, lim.state(a.uid, grp, now) == Limit::Ok),
        },
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum First {
    Pwd,
    Phrase,
    Sso,
}

impl First {
    fn proof(self) -> Proof {
        match self {
            First::Pwd => Proof::Pwd,
            First::Phrase => Proof::Phrase,
            First::Sso => Proof::Sso,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Pending {
    pub username: String,
    pub uid: i64,
    pub first: First,
    pub sso: Option<Sso>,
    pub tries: u32,
    pub expires_at: i64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StepKind {
    Totp,
    RecoveryCode,
    Phrase,
}

impl StepKind {
    fn proof(self) -> Proof {
        match self {
            StepKind::Totp => Proof::Totp,
            StepKind::RecoveryCode => Proof::RecoveryCode,
            StepKind::Phrase => Proof::Phrase,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct StepInput {
    pub kind: StepKind,
    pub verdict: Verdict,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum StepAnswer {
    Session { proofs: Vec<Proof> },
    Expired,
    SameKind,
    Wrong { tries_left: u32 },
    Used { tries_left: u32 },
    Locked { limit: Limit },
}

impl StepAnswer {
    pub fn status(&self) -> u16 {
        match self {
            StepAnswer::Session { .. } => 200,
            StepAnswer::Expired | StepAnswer::SameKind => 400,
            StepAnswer::Wrong { .. } | StepAnswer::Used { .. } => 401,
            StepAnswer::Locked { .. } => 423,
        }
    }

    pub fn error(&self) -> Option<&'static str> {
        match self {
            StepAnswer::Session { .. } => None,
            StepAnswer::Expired => Some("Sign-in expired. Try again"),
            StepAnswer::SameKind => Some("Use your authenticator app or your password with this"),
            StepAnswer::Wrong { .. } => Some("Wrong code"),
            StepAnswer::Used { .. } => Some(USED_TEXT),
            StepAnswer::Locked { .. } => Some(LOCKED_TEXT),
        }
    }
}

pub fn step(
    pending: Option<Pending>,
    username: &str,
    input: StepInput,
    lim: &mut CodeLimits,
    grp: &str,
    now: i64,
) -> (StepAnswer, Option<Pending>) {
    let live = pending.filter(|p| p.username == username && now < p.expires_at && p.tries > 0);
    let Some(p) = live else {
        return (StepAnswer::Expired, None);
    };
    let proofs = vec![p.first.proof(), input.kind.proof()];
    if !enough(true, &proofs, p.sso.as_ref()) {
        return (StepAnswer::SameKind, Some(p));
    }
    let guessable = input.kind != StepKind::Phrase;
    if guessable {
        let reserved = lim.reserve(p.uid, grp, now);
        if reserved != Limit::Ok {
            return (StepAnswer::Locked { limit: reserved }, Some(p));
        }
    }
    match input.verdict {
        Verdict::Ok => {
            if guessable {
                lim.refund(p.uid, grp, now);
            }
            (StepAnswer::Session { proofs }, None)
        }
        Verdict::Used | Verdict::Malformed => {
            if guessable {
                lim.refund(p.uid, grp, now);
            }
            (
                StepAnswer::Used {
                    tries_left: p.tries,
                },
                Some(p),
            )
        }
        Verdict::Wrong => {
            let left = p.tries.saturating_sub(1);
            let kept = (left > 0).then_some(Pending { tries: left, ..p });
            (StepAnswer::Wrong { tries_left: left }, kept)
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Purpose {
    SetPhrase,
    RemovePhrase,
    TotpOn,
    TotpOff,
    NewRecoveryCodes,
    PersonalToken,
    ApplicationSecret,
    ApproveDeviceSignIn,
    ApplicationConsentStrong,
    AdminResetTwoFactor,
    SiteAdmins,
    LinkIdp,
    SetPassword,
    PasswordChange,
}

pub const NEVER_ONE_SIGN_IN: [Purpose; 4] = [
    Purpose::TotpOff,
    Purpose::LinkIdp,
    Purpose::SetPassword,
    Purpose::PasswordChange,
];

fn single(proofs: &[Proof]) -> bool {
    matches!(proofs, [Proof::Pwd | Proof::Phrase | Proof::Sso])
}

pub fn reauth_ok(totp_on: bool, purpose: Purpose, proofs: &[Proof], sso: Option<&Sso>) -> bool {
    let repeated = proofs
        .iter()
        .enumerate()
        .any(|(i, p)| proofs.iter().skip(i + 1).any(|q| q == p));
    if proofs.is_empty() || proofs.contains(&Proof::Device) || repeated {
        return false;
    }
    if purpose == Purpose::TotpOn {
        return !totp_on && single(proofs);
    }
    if !totp_on {
        return single(proofs);
    }
    match proofs {
        [Proof::Sso] => sso_trusted(sso) && !NEVER_ONE_SIGN_IN.contains(&purpose),
        [_, _] => {
            let unmarked = Sso {
                mode: SsoMode::Rchat,
                amr: Vec::new(),
            };
            let as_one = proofs.contains(&Proof::Sso).then_some(&unmarked);
            kinds(proofs, as_one).len() >= 2
        }
        _ => false,
    }
}
