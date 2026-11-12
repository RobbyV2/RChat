use std::collections::HashMap;
use std::fmt;

use url::Url;

use crate::util::{ct_eq, encode_component, push_percent};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProxyKind {
    Nginx,
    Traefik,
    Caddy,
    Envoy,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Preset {
    Rchat,
    Authelia,
    Authentik,
    Oauth2Proxy,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProxyApplication {
    pub id: String,
    pub hosts: Vec<String>,
    pub cookie_domain: Option<String>,
    pub preset: Preset,
    pub paused: bool,
    pub needs_two_factor: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProxyControl {
    Admins,
    Off,
}

pub fn may_create_proxy(control: ProxyControl, is_site_admin: bool) -> bool {
    control == ProxyControl::Admins && is_site_admin
}

const MAX_PORT_DIGITS: usize = 5;

// A name (or a bracketed address) and at most one port of up to five digits.
fn split_port(host: &str) -> Option<(&str, Option<&str>)> {
    let end = match host.starts_with('[') {
        true => host.find(']').map_or(host.len(), |i| i + 1),
        false => host.find(':').unwrap_or(host.len()),
    };
    let (name, rest) = host.split_at(end);
    let port = match rest.strip_prefix(':') {
        None if rest.is_empty() => None,
        Some(port)
            if (1..=MAX_PORT_DIGITS).contains(&port.len())
                && port.bytes().all(|b| b.is_ascii_digit()) =>
        {
            Some(port)
        }
        Some(_) | None => return None,
    };
    (!name.is_empty()).then_some((name, port))
}

const DEFAULT_PORTS: [&str; 2] = ["443", "80"];

fn bare_name(host: &str) -> Option<String> {
    let host = host.to_lowercase();
    split_port(&host).map(|(name, _)| name.trim_end_matches('.').to_string())
}

// One spelling per host: lowercase, no trailing dot, no default port.
pub fn canonical_host(host: &str) -> String {
    let host = host.to_lowercase();
    let Some((name, port)) = split_port(&host) else {
        return host;
    };
    let name = name.trim_end_matches('.');
    let port = port
        .map(|p| p.trim_start_matches('0'))
        .filter(|p| !DEFAULT_PORTS.contains(p));
    match port {
        Some("") => format!("{name}:0"),
        Some(port) => format!("{name}:{port}"),
        None => name.to_string(),
    }
}

pub fn host_allowed<S: AsRef<str>>(host: &str, operator_list: &[S]) -> bool {
    let host = host.to_lowercase();
    let Some((name, _)) = split_port(&host) else {
        return false;
    };
    let shaped = name
        .bytes()
        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'.' | b'-'))
        && !host.starts_with('.')
        && !host.contains("..");
    shaped
        && operator_list
            .iter()
            .map(|e| e.as_ref())
            .any(|entry| match entry.starts_with('.') {
                true => name.ends_with(entry) && name.len() > entry.len(),
                false => split_port(entry).is_some_and(|(e, _)| e == name),
            })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Claim {
    Ok,
    NotListed,
    Taken,
}

#[derive(Clone, Debug, Default)]
pub struct HostRegistry {
    owner: HashMap<String, String>,
}

impl HostRegistry {
    pub fn new() -> HostRegistry {
        HostRegistry::default()
    }

    pub fn claim<S: AsRef<str>>(
        &mut self,
        application: &str,
        host: &str,
        operator_list: &[S],
    ) -> Claim {
        let host = canonical_host(host);
        if !host_allowed(&host, operator_list) {
            return Claim::NotListed;
        }
        match self.owner.get(&host) {
            Some(current) if current != application => Claim::Taken,
            Some(_) | None => {
                self.owner.insert(host, application.to_string());
                Claim::Ok
            }
        }
    }

    pub fn application_for(&self, host: &str) -> Option<&str> {
        self.owner.get(&canonical_host(host)).map(String::as_str)
    }
}

#[derive(Clone, PartialEq, Eq)]
pub struct Identity {
    pub username: String,
    pub display: String,
    pub sub: String,
    pub groups: Vec<String>,
    pub avatar: String,
    pub assertion: String,
}

impl fmt::Debug for Identity {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let Identity {
            username,
            display,
            sub,
            groups,
            avatar,
            assertion: _,
        } = self;
        f.debug_struct("Identity")
            .field("username", username)
            .field("display", display)
            .field("sub", sub)
            .field("groups", groups)
            .field("avatar", avatar)
            .finish_non_exhaustive()
    }
}

pub fn header_value(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for b in text.bytes() {
        match b {
            0x20..=0x24 | 0x26..=0x7e => out.push(char::from(b)),
            _ => push_percent(&mut out, b),
        }
    }
    out
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Separator {
    Comma,
    Pipe,
}

pub fn list_value<S: AsRef<str>>(items: &[S], sep: Separator) -> String {
    let (sep, encoded) = match sep {
        Separator::Comma => (",", "%2C"),
        Separator::Pipe => ("|", "%7C"),
    };
    let values: Vec<String> = items
        .iter()
        .map(|item| header_value(item.as_ref()).replace(sep, encoded))
        .collect();
    values.join(sep)
}

pub const ALL_HEADERS: [&str; 20] = [
    "X-RChat-User",
    "X-RChat-Name",
    "X-RChat-Subject",
    "X-RChat-Groups",
    "X-RChat-Avatar",
    "X-RChat-Assertion",
    "Remote-User",
    "Remote-Name",
    "Remote-Groups",
    "Remote-Email",
    "X-authentik-username",
    "X-authentik-name",
    "X-authentik-uid",
    "X-authentik-groups",
    "X-authentik-email",
    "X-authentik-meta-app",
    "X-Auth-Request-User",
    "X-Auth-Request-Preferred-Username",
    "X-Auth-Request-Groups",
    "X-Auth-Request-Email",
];

pub const STRIP_PREFIXES: [&str; 4] = ["x-rchat-", "remote-", "x-authentik-", "x-auth-request-"];
const MAX_SEPARATORS: usize = 16;

pub fn normalize(name: &str) -> String {
    name.to_lowercase().replace('_', "-")
}

pub fn stripped_by(name: &str) -> bool {
    let name = normalize(name);
    STRIP_PREFIXES.iter().any(|p| name.starts_with(p))
}

pub fn spellings(name: &str) -> Vec<String> {
    let parts: Vec<&str> = name.split(['-', '_']).collect();
    let separators = parts.len().saturating_sub(1);
    if separators > MAX_SEPARATORS {
        return Vec::new();
    }
    (0..1usize << separators)
        .map(|mask| {
            let mut out = String::with_capacity(name.len());
            for (i, part) in parts.iter().enumerate() {
                if i > 0 {
                    out.push(match (mask >> (i - 1)) & 1 {
                        1 => '_',
                        _ => '-',
                    });
                }
                out.push_str(part);
            }
            out
        })
        .collect()
}

pub fn go_key(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    let mut start = true;
    for c in name.to_lowercase().chars() {
        out.push(match start {
            true => c.to_ascii_uppercase(),
            false => c,
        });
        start = c == '-';
    }
    out
}

fn unique(names: impl Iterator<Item = String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for name in names {
        if !out.contains(&name) {
            out.push(name);
        }
    }
    out
}

pub fn caddy_prefixes() -> Vec<String> {
    unique(STRIP_PREFIXES.iter().flat_map(|prefix| {
        spellings(prefix.trim_end_matches('-'))
            .into_iter()
            .flat_map(|s| [go_key(&format!("{s}-")), go_key(&format!("{s}_"))])
    }))
}

pub fn traefik_keys() -> Vec<String> {
    unique(
        ALL_HEADERS
            .iter()
            .flat_map(|h| spellings(h).into_iter().map(|s| go_key(&s))),
    )
}

pub fn headers(
    preset: Preset,
    id: &Identity,
    application: &ProxyApplication,
) -> Vec<(&'static str, String)> {
    let user = header_value(&id.username);
    let name = header_value(&id.display);
    let commas = list_value(&id.groups, Separator::Comma);
    match preset {
        Preset::Rchat => vec![
            ("X-RChat-User", user),
            ("X-RChat-Name", name),
            ("X-RChat-Subject", id.sub.clone()),
            ("X-RChat-Groups", commas),
            ("X-RChat-Avatar", header_value(&id.avatar)),
            ("X-RChat-Assertion", id.assertion.clone()),
        ],
        Preset::Authelia => vec![
            ("Remote-User", user),
            ("Remote-Name", name),
            ("Remote-Groups", commas),
        ],
        Preset::Authentik => vec![
            ("X-authentik-username", user),
            ("X-authentik-name", name),
            ("X-authentik-uid", id.sub.clone()),
            (
                "X-authentik-groups",
                list_value(&id.groups, Separator::Pipe),
            ),
            ("X-authentik-meta-app", application.id.clone()),
        ],
        Preset::Oauth2Proxy => vec![
            ("X-Auth-Request-User", id.sub.clone()),
            ("X-Auth-Request-Preferred-Username", user),
            ("X-Auth-Request-Groups", commas),
        ],
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Proto {
    Http,
    Https,
}

impl Proto {
    pub fn parse(text: &str) -> Option<Proto> {
        match text {
            "http" => Some(Proto::Http),
            "https" => Some(Proto::Https),
            _ => None,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Proto::Http => "http",
            Proto::Https => "https",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProxyCookie {
    pub application_id: String,
    pub host: String,
    pub live: bool,
    pub two_kinds: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CheckRequest {
    pub kind: ProxyKind,
    pub application_param: Option<String>,
    pub host: String,
    pub uri: String,
    pub proto: Proto,
    pub wants_json: bool,
    pub cookie: Option<ProxyCookie>,
    pub allowed: Option<bool>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Page {
    NotAllowed,
    NotSetUp,
    Paused,
    NeedsTwoFactor,
}

impl Page {
    pub fn name(self) -> &'static str {
        match self {
            Page::NotAllowed => "not_allowed",
            Page::NotSetUp => "not_set_up",
            Page::Paused => "paused",
            Page::NeedsTwoFactor => "needs_two_factor",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CheckAnswer {
    Ok {
        headers: Vec<(&'static str, String)>,
    },
    Unauthorized,
    Redirect {
        location: String,
    },
    Refused {
        page: Page,
    },
}

impl CheckAnswer {
    pub fn status(&self) -> u16 {
        match self {
            CheckAnswer::Ok { .. } => 200,
            CheckAnswer::Unauthorized => 401,
            CheckAnswer::Redirect { .. } => 302,
            CheckAnswer::Refused { .. } => 403,
        }
    }
}

pub const START: &str = "/_rchat/proxy/start";

pub fn under_domain(host: &str, domain: &str) -> bool {
    host == domain
        || host
            .strip_suffix(domain)
            .is_some_and(|rest| rest.ends_with('.'))
}

pub fn check(
    applications: &[ProxyApplication],
    r: &CheckRequest,
    id: impl FnOnce() -> Identity,
) -> CheckAnswer {
    let host = canonical_host(&r.host);
    let named = applications
        .iter()
        .find(|a| Some(&a.id) == r.application_param.as_ref())
        .filter(|a| a.hosts.contains(&host));
    let Some(application) = named else {
        return CheckAnswer::Refused {
            page: Page::NotSetUp,
        };
    };
    if application.paused {
        return CheckAnswer::Refused { page: Page::Paused };
    }
    let session = r.cookie.as_ref().filter(|c| {
        c.live
            && c.application_id == application.id
            && match &application.cookie_domain {
                Some(domain) => under_domain(&host, domain),
                None => c.host == host,
            }
    });
    let (Some(session), Some(allowed)) = (session, r.allowed) else {
        if r.kind == ProxyKind::Nginx || r.wants_json {
            return CheckAnswer::Unauthorized;
        }
        let proto = r.proto.name();
        let back = encode_component(&format!("{proto}://{host}{}", r.uri));
        return CheckAnswer::Redirect {
            location: format!(
                "{proto}://{host}{START}?application={}&rd={back}",
                application.id
            ),
        };
    };
    if !allowed {
        return CheckAnswer::Refused {
            page: Page::NotAllowed,
        };
    }
    if application.needs_two_factor && !session.two_kinds {
        return CheckAnswer::Refused {
            page: Page::NeedsTwoFactor,
        };
    }
    CheckAnswer::Ok {
        headers: headers(application.preset, &id(), application),
    }
}

const MAX_RETURN_BYTES: usize = 2048;
const LOOPBACK_HOSTS: [&str; 2] = ["127.0.0.1", "[::1]"];

pub fn safe_return(application: &ProxyApplication, rd: Option<&str>) -> String {
    let home = || "/".to_string();
    let Some(rd) = rd.filter(|rd| {
        !rd.is_empty()
            && rd.len() <= MAX_RETURN_BYTES
            && !rd.chars().any(|c| c <= '\u{1f}' || c == '\\')
    }) else {
        return home();
    };
    let Ok(url) = Url::parse(rd) else {
        return home();
    };
    let name = url.host_str().unwrap_or("");
    let host = match url.port() {
        Some(port) => format!("{name}:{port}"),
        None => name.to_string(),
    };
    let own = application.hosts.contains(&host.to_lowercase())
        && url.username().is_empty()
        && url.password().is_none();
    let safe = match url.scheme() {
        "https" => true,
        "http" => LOOPBACK_HOSTS.contains(&name),
        _ => false,
    };
    match own && safe {
        true => url.to_string(),
        false => home(),
    }
}

pub fn cookie(application: &ProxyApplication, value: &str, max_age: i64) -> String {
    let id = &application.id;
    let rest = format!("Path=/; Max-Age={max_age}; Secure; HttpOnly; SameSite=Lax");
    match &application.cookie_domain {
        Some(domain) => format!("rchat_proxy_{id}={value}; Domain={domain}; {rest}"),
        None => format!("__Host-rchat_proxy_{id}={value}; {rest}"),
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Flow {
    pub application: String,
    pub host: String,
    pub binding: String,
    pub expires_at: i64,
}

pub const FLOW_COOKIE: &str = "__Host-rchat_proxy_flow";

pub fn callback_ok(
    flow: Option<&Flow>,
    application: &str,
    host: &str,
    cookie_hash: Option<&str>,
    now: i64,
) -> bool {
    match (flow, cookie_hash) {
        (Some(flow), Some(hash)) => {
            flow.application == application
                && flow.host == host
                && now < flow.expires_at
                && ct_eq(hash.as_bytes(), flow.binding.as_bytes())
        }
        (_, _) => false,
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RuleEntry {
    pub uid: i64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Account {
    pub uid: i64,
    pub username: String,
    pub deleted: bool,
}

pub const NO_ACCOUNT: &str = "No account with that name";
const DELETED_ACCOUNT: &str = "Deleted account";

pub fn pick_account(accounts: &[Account], name: &str) -> Option<RuleEntry> {
    let name = name.to_lowercase();
    accounts
        .iter()
        .find(|a| !a.deleted && a.username == name)
        .map(|a| RuleEntry { uid: a.uid })
}

pub fn matches(entries: &[RuleEntry], uid: i64) -> bool {
    entries.iter().any(|e| e.uid == uid)
}

pub fn entry_label(entry: &RuleEntry, accounts: &[Account]) -> String {
    match accounts.iter().find(|a| a.uid == entry.uid) {
        Some(a) if !a.deleted => a.username.clone(),
        Some(_) | None => DELETED_ACCOUNT.to_string(),
    }
}

pub fn rule_summary(entries: &[RuleEntry]) -> String {
    let noun = match entries.len() {
        1 => "person",
        _ => "people",
    };
    format!("{} {noun} listed", entries.len())
}

pub const BROWSER_PATHS: [&str; 5] = [
    "start",
    "callback",
    "sign_out",
    "denied",
    "needs_two_factor",
];
const PROXY_ROOT: &str = "/_rchat/proxy/";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Routed {
    Serve,
    Refuse,
}

pub fn proxy_path<S: AsRef<str>>(path: &str, host: &str, protected_hosts: &[S]) -> Routed {
    let word = |s: &str, extra: &[u8]| {
        !s.is_empty()
            && s.bytes()
                .all(|b| b.is_ascii_lowercase() || extra.contains(&b))
    };
    let Some(rest) = path.strip_prefix(PROXY_ROOT) else {
        return Routed::Refuse;
    };
    let (page, sub) = match rest.split_once('/') {
        Some((page, sub)) => (page, Some(sub)),
        None => (rest, None),
    };
    if !word(page, b"_") || !sub.is_none_or(|s| word(s, b"")) {
        return Routed::Refuse;
    }
    let serve = match (page, bare_name(host)) {
        ("auth", Some(name)) => !protected_hosts
            .iter()
            .any(|h| bare_name(h.as_ref()).as_ref() == Some(&name)),
        ("auth", None) => false,
        (_, _) => BROWSER_PATHS.contains(&page) && sub.is_none(),
    };
    match serve {
        true => Routed::Serve,
        false => Routed::Refuse,
    }
}
