use std::collections::{BTreeMap, BTreeSet};

use crate::util::path_matches;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Servers {
    None,
    Pick,
    Join,
    Channel,
    Chats,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ScopeDef {
    pub scope: &'static str,
    pub line: &'static str,
    pub part: u8,
    pub group: &'static str,
    pub strong: bool,
    pub required: bool,
    pub servers: Servers,
    pub from_client: bool,
    pub step_up: bool,
}

const fn def(
    scope: &'static str,
    line: &'static str,
    part: u8,
    group: &'static str,
    servers: Servers,
) -> ScopeDef {
    ScopeDef {
        scope,
        line,
        part,
        group,
        strong: false,
        required: false,
        servers,
        from_client: false,
        step_up: false,
    }
}

const fn required(d: ScopeDef) -> ScopeDef {
    ScopeDef {
        required: true,
        ..d
    }
}

const fn strong(d: ScopeDef, from_client: bool, step_up: bool) -> ScopeDef {
    ScopeDef {
        strong: true,
        from_client,
        step_up,
        ..d
    }
}

const STRONGEST: &str = "Strongest";
const YOU: &str = "You";
const SERVERS: &str = "Servers";
const MESSAGES: &str = "Messages";
const CHANNELS: &str = "Servers and channels";
const PEOPLE: &str = "People";
const FILES: &str = "Files and calls";
const ACCOUNT: &str = "Account";

pub const GROUPS: [&str; 8] = [
    STRONGEST, YOU, SERVERS, MESSAGES, CHANNELS, PEOPLE, FILES, ACCOUNT,
];

pub const SCOPES: [ScopeDef; 22] = [
    required(def("openid", "Know it is you", 1, YOU, Servers::None)),
    required(def(
        "profile",
        "See your username, display name and avatar",
        1,
        YOU,
        Servers::None,
    )),
    def(
        "servers",
        "See the servers you pick",
        1,
        SERVERS,
        Servers::Pick,
    ),
    def(
        "servers.members.read",
        "See your roles and join date in those servers",
        1,
        SERVERS,
        Servers::Pick,
    ),
    def(
        "servers.join",
        "Join and leave servers for you",
        1,
        SERVERS,
        Servers::Join,
    ),
    def(
        "webhook.incoming",
        "Post in a channel you manage",
        1,
        SERVERS,
        Servers::Channel,
    ),
    def(
        "offline_access",
        "Stay signed in when you are away",
        1,
        YOU,
        Servers::None,
    ),
    strong(
        def(
            "admin",
            "Run this site as its admin. This tells the app you are one",
            2,
            STRONGEST,
            Servers::None,
        ),
        false,
        true,
    ),
    strong(
        def(
            "encrypted.read",
            "Read the encrypted chats you pick",
            2,
            STRONGEST,
            Servers::Chats,
        ),
        true,
        true,
    ),
    strong(
        def(
            "encrypted.send",
            "Send in the encrypted chats you pick, as you",
            2,
            STRONGEST,
            Servers::Chats,
        ),
        true,
        true,
    ),
    strong(
        def(
            "messages.send",
            "Send, edit and delete your own messages and reactions",
            2,
            STRONGEST,
            Servers::Pick,
        ),
        false,
        false,
    ),
    strong(
        def(
            "dms.send",
            "Send direct messages as you",
            2,
            STRONGEST,
            Servers::None,
        ),
        false,
        false,
    ),
    strong(
        def(
            "moderation",
            "Kick, ban, time out, pin and remove others' messages as you",
            2,
            STRONGEST,
            Servers::Pick,
        ),
        false,
        false,
    ),
    strong(
        def(
            "dms.read",
            "Read your direct messages",
            2,
            STRONGEST,
            Servers::None,
        ),
        false,
        false,
    ),
    def(
        "messages.read",
        "Read messages and your notifications, other people's messages too",
        2,
        MESSAGES,
        Servers::Pick,
    ),
    def(
        "servers.read",
        "See channels, members and the profiles you can see",
        2,
        CHANNELS,
        Servers::Pick,
    ),
    def(
        "servers.manage",
        "Create and change servers, channels, roles and webhooks as you",
        2,
        CHANNELS,
        Servers::Pick,
    ),
    def(
        "friends",
        "See and manage your friends, requests and blocks",
        2,
        PEOPLE,
        Servers::None,
    ),
    def("files", "Upload files as you", 2, FILES, Servers::None),
    def(
        "calls",
        "Join voice channels and calls as you",
        2,
        FILES,
        Servers::Pick,
    ),
    def(
        "realtime",
        "Get live updates of what it can see",
        2,
        FILES,
        Servers::None,
    ),
    def(
        "account",
        "Change your profile, status and privacy settings",
        2,
        ACCOUNT,
        Servers::None,
    ),
];

pub fn scope_def(scope: &str) -> Option<&'static ScopeDef> {
    SCOPES.iter().find(|d| d.scope == scope)
}

pub fn all_scopes() -> Vec<&'static str> {
    SCOPES.iter().map(|d| d.scope).collect()
}

pub fn per_server() -> Vec<&'static str> {
    SCOPES
        .iter()
        .filter(|d| d.servers == Servers::Pick && d.scope != "servers")
        .map(|d| d.scope)
        .collect()
}

pub const NOT_OFFERED: [(&str, &str); 5] = [
    ("email", "RChat has no email"),
    ("bot", "RChat has no bots"),
    ("applications.commands", "RChat has no bots"),
    ("connections", "RChat has no linked accounts to show"),
    (
        "gdm.join",
        "RChat has no group DMs (0.8.0 Letters may add one)",
    ),
];

pub fn not_offered(scope: &str) -> Option<&'static str> {
    NOT_OFFERED
        .iter()
        .find(|(name, _)| *name == scope)
        .map(|(_, why)| *why)
}

pub fn scope_token_ok(token: &str) -> bool {
    (1..=64).contains(&token.len())
        && token
            .bytes()
            .all(|b| matches!(b, 0x21 | 0x23..=0x5b | 0x5d..=0x7e))
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ApplicationScopes {
    pub allowed: Vec<String>,
    pub optional: Vec<String>,
}

pub fn is_optional(application: &ApplicationScopes, scope: &str) -> bool {
    scope == "admin"
        || (!scope_def(scope).is_some_and(|d| d.required)
            && application.optional.iter().any(|s| s == scope))
}

pub fn default_ticked(scope: &str) -> bool {
    !scope_def(scope).is_some_and(|d| d.strong)
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConsentGroup {
    pub group: &'static str,
    pub lines: Vec<&'static ScopeDef>,
}

pub fn consent_order<S: AsRef<str>>(asked: &[S], is_site_admin: bool) -> Vec<ConsentGroup> {
    let shown = |d: &&ScopeDef| {
        asked.iter().any(|s| s.as_ref() == d.scope) && (d.scope != "admin" || is_site_admin)
    };
    GROUPS
        .iter()
        .map(|group| ConsentGroup {
            group,
            lines: SCOPES
                .iter()
                .filter(shown)
                .filter(|d| d.group == *group)
                .collect(),
        })
        .filter(|g| !g.lines.is_empty())
        .collect()
}

pub fn normalize_ticks<S: AsRef<str>>(ticked: &[S]) -> Vec<String> {
    let mut out: Vec<String> = Vec::with_capacity(ticked.len() + 1);
    for scope in ticked.iter().map(|s| s.as_ref()) {
        if !out.iter().any(|have| have == scope) {
            out.push(scope.to_string());
        }
    }
    let per_server = per_server();
    let needs_servers = out.iter().any(|s| per_server.contains(&s.as_str()));
    if needs_servers && !out.iter().any(|s| s == "servers") {
        out.push("servers".to_string());
    }
    out
}

pub fn granted<S: AsRef<str>>(
    ticked: &[S],
    is_site_admin: bool,
    application_may_ask_admin: bool,
    admin_control: bool,
) -> Vec<String> {
    let admin = is_site_admin && application_may_ask_admin && admin_control;
    normalize_ticks(ticked)
        .into_iter()
        .filter(|s| s != "admin" || admin)
        .collect()
}

const ANY: &str = "*";

const NEVER: [(&str, &str); 22] = [
    (ANY, "/auth/"),
    (
        ANY,
        "/me/{password|recovery|two_factor|sessions|trusted_devices|grants|tokens|protections|policy|sso|delete}/**",
    ),
    (ANY, "/applications/**"),
    (ANY, "/oauth/{authorize|par|register|requests|device}/**"),
    (ANY, "/identity/"),
    (ANY, "/me/p2p_backup/**"),
    (ANY, "/config_shares/**"),
    (ANY, "/e2ee/me/**"),
    (ANY, "/e2ee/devices/{}/{approve|revoke|bind}"),
    ("POST", "/e2ee/{devices|application_devices}"),
    (ANY, "/e2ee/application_devices/{}/**"),
    ("POST", "/e2ee/groups/{}/history"),
    (ANY, "/e2ee/backup/**"),
    ("POST", "/admin/users"),
    ("POST", "/admin/users/batch"),
    (
        ANY,
        "/admin/users/{}/{temp_password|two_factor|protections|sign_out|recovery|policy}/**",
    ),
    (ANY, "/admin/site_admins/**"),
    (ANY, "/admin/e2ee/**"),
    (ANY, "/admin/oauth/**"),
    (ANY, "/admin/applications/**"),
    (ANY, "/admin/{export|exports}/**"),
    (ANY, "/admin/brand/**"),
];

pub fn is_never(method: &str, path: &str) -> bool {
    NEVER
        .iter()
        .any(|(m, pattern)| (*m == ANY || *m == method) && path_matches(pattern, path))
}

pub const SECURITY_CONTROLS: [&str; 24] = [
    "registration",
    "password_login",
    "two_factor",
    "two_factor_remember_days",
    "protection_totp",
    "protection_totp_grace_hours",
    "protection_backup_phrase",
    "protection_backup_phrase_grace_hours",
    "password_change",
    "temp_password_hours",
    "oauth_provider",
    "application_registration",
    "application_registrants",
    "application_admin_scope",
    "application_encrypted_access",
    "proxy_applications",
    "personal_tokens",
    "personal_tokens_never_expire",
    "device_sign_in",
    "application_metadata_documents",
    "backup_phrase",
    "e2ee",
    "e2ee_compliance",
    "pow",
];

pub fn admin_patch_allowed<S: AsRef<str>>(keys: &[S]) -> bool {
    keys.iter()
        .all(|k| !SECURITY_CONTROLS.contains(&k.as_ref()))
}

pub const A_SITE_ADMIN: &str = "a site admin";
const SITE_ADMIN_ACTIONS: &str = "site_admin.";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AuditRow {
    pub actor: Option<String>,
    pub action: String,
    pub target: Option<String>,
    pub detail: BTreeMap<String, String>,
}

fn strip_name<'v>(text: &'v str, name: &str) -> Option<&'v str> {
    let mut rest = text.chars();
    name.chars()
        .all(|n| {
            rest.next()
                .is_some_and(|t| t.to_lowercase().eq(n.to_lowercase()))
        })
        .then_some(rest.as_str())
}

fn name_char(c: char) -> bool {
    c.is_alphanumeric() || matches!(c, '_' | '-' | '.')
}

fn ends_word(tail: &str) -> bool {
    let mut next = tail.chars();
    match next.next() {
        None => true,
        Some('.') => next
            .next()
            .is_none_or(|c| !(c.is_alphanumeric() || matches!(c, '_' | '-'))),
        Some(c) => !name_char(c),
    }
}

// Every other admin's name where it stands as a whole word in the value, longest first; one
// pass, so a replacement is never matched again.
fn mask_names(value: &str, hidden: &[&str]) -> String {
    let mut out = String::with_capacity(value.len());
    let mut rest = value;
    let mut prev: Option<char> = None;
    while let Some(c) = rest.chars().next() {
        let found = match prev.is_some_and(name_char) {
            true => None,
            false => hidden.iter().find_map(|name| {
                strip_name(rest, name)
                    .filter(|tail| ends_word(tail))
                    .map(|tail| (*name, tail))
            }),
        };
        match found {
            Some((name, tail)) => {
                out.push_str(A_SITE_ADMIN);
                prev = name.chars().last();
                rest = tail;
            }
            None => {
                out.push(c);
                prev = Some(c);
                rest = rest.get(c.len_utf8()..).unwrap_or("");
            }
        }
    }
    out
}

pub fn audit_for_token(rows: &[AuditRow], own: &str, admins: &BTreeSet<String>) -> Vec<AuditRow> {
    let mut hidden: Vec<&str> = admins
        .iter()
        .map(String::as_str)
        .filter(|name| !name.is_empty() && *name != own)
        .collect();
    hidden.sort_by_key(|name| std::cmp::Reverse(name.chars().count()));
    let masked = |value: &String| mask_names(value, &hidden);
    rows.iter()
        .filter(|row| !row.action.starts_with(SITE_ADMIN_ACTIONS))
        .map(|row| AuditRow {
            actor: row.actor.as_ref().map(|actor| match actor == own {
                true => actor.clone(),
                false => A_SITE_ADMIN.to_string(),
            }),
            action: row.action.clone(),
            target: row.target.as_ref().map(masked),
            detail: row
                .detail
                .iter()
                .map(|(k, v)| (k.clone(), masked(v)))
                .collect(),
        })
        .collect()
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UsePlace {
    Server,
    Dm,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Use {
    pub own_target: bool,
    pub place: Option<UsePlace>,
    pub logs_content: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Required {
    Never,
    Scopes(Vec<&'static str>),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Need {
    Never,
    Scope(&'static str),
}

const RULES: [(&str, &str, &str); 48] = [
    ("GET", "/oauth/servers", "servers"),
    ("GET", "/oauth/servers/{}/member", "servers.members.read"),
    ("GET", "/me", "account"),
    ("PATCH", "/me", "account"),
    ("GET", "/me/servers", "servers"),
    ("GET", "/servers/{}", "servers.read"),
    (
        "GET",
        "/servers/{}/{members|channels|roles|interacted}",
        "servers.read",
    ),
    ("GET", "/users/{}/{profile|card}", "servers.read"),
    ("POST", "/servers", "servers.manage"),
    ("PATCH", "/servers/{}", "servers.manage"),
    (
        "POST",
        "/servers/{}/{channels|roles|webhooks}",
        "servers.manage",
    ),
    ("POST", "/servers/{}/join", "servers.join"),
    ("POST", "/servers/{}/leave", "servers.join"),
    ("POST", "/servers/{}/{kick|bans|timeouts}", "moderation"),
    ("POST", "/messages/bulk_delete", "moderation"),
    ("GET", "/servers/{}/reports", "moderation"),
    ("GET", "/servers/{}/reports/{#}", "moderation"),
    ("GET", "/channels/{#}/messages", "messages.read"),
    ("POST", "/channels/{#}/messages", "messages.send"),
    ("GET", "/search", "messages.read"),
    ("GET", "/inbox", "messages.read"),
    ("GET", "/media/{}", "messages.read"),
    ("PUT", "/messages/{#}/reactions/{}", "messages.send"),
    ("GET", "/dms", "dms.read"),
    ("GET", "/dms/{#}/messages", "dms.read"),
    ("POST", "/dms", "dms.send"),
    ("POST", "/dms/{#}/messages", "dms.send"),
    ("GET", "/friends", "friends"),
    ("GET", "/friends/summary", "friends"),
    ("POST", "/friends/requests", "friends"),
    ("POST", "/blocks", "friends"),
    ("POST", "/media", "files"),
    ("GET", "/p2p/ice", "calls"),
    ("GET", "/ws", "realtime"),
    (
        "GET",
        "/admin/{users|servers|overview|audit|config|protections}",
        "admin",
    ),
    ("PATCH", "/admin/settings", "admin"),
    ("DELETE", "/admin/servers/{}", "admin"),
    ("DELETE", "/admin/messages/{#}", "admin"),
    ("POST", "/admin/ban", "admin"),
    ("POST", "/e2ee/devices/{}/keypackages", "encrypted.read"),
    ("GET", "/e2ee/users/{}/devices", "encrypted.read"),
    ("GET", "/e2ee/groups/{}", "encrypted.read"),
    (
        "GET",
        "/e2ee/groups/{}/{handshakes|group_info|tree|history|members}",
        "encrypted.read",
    ),
    ("GET", "/e2ee/welcomes", "encrypted.read"),
    ("GET", "/e2ee/spaces/{}", "encrypted.read"),
    ("GET", "/e2ee/spaces/{}/{notices|groups}", "encrypted.read"),
    ("DELETE", "/e2ee/welcomes/{}", "encrypted.read"),
    (
        "POST",
        "/e2ee/groups/{}/{self_update|commit|external_commit|leave|rejoin|problem}",
        "encrypted.read",
    ),
];

pub fn required_for(method: &str, path: &str, ctx: &Use) -> Option<Required> {
    if is_never(method, path) {
        return Some(Required::Never);
    }
    let own = ctx.own_target;
    let dm = ctx.place == Some(UsePlace::Dm);
    let is = |pattern: &str| path_matches(pattern, path);
    let scopes = |list: &[&'static str]| Some(Required::Scopes(list.to_vec()));
    let own_or_moderation = match own {
        true => scopes(&["messages.send"]),
        false => scopes(&["moderation"]),
    };
    let own_send = match dm {
        true => scopes(&["dms.send"]),
        false => scopes(&["messages.send"]),
    };
    match method {
        "DELETE" if is("/messages/{#}") => {
            return match (dm, own) {
                (true, false) => Some(Required::Never),
                (true, true) => own_send,
                (false, _) => own_or_moderation,
            };
        }
        "PUT" | "DELETE" if is("/messages/{#}/pin") => {
            return match dm {
                true => scopes(&["dms.send"]),
                false => scopes(&["moderation"]),
            };
        }
        "DELETE" if is("/messages/{#}/reactions/{}/{}") || is("/messages/{#}/embeds/{#}") => {
            return own_or_moderation;
        }
        "PATCH" if is("/messages/{#}") => {
            return match own {
                true => own_send,
                false => Some(Required::Never),
            };
        }
        _ => {}
    }
    if method != "GET" && is("/servers/{}/outgoing_webhooks/**") {
        return scopes(&["servers.manage", "messages.read"]);
    }
    if method != "GET" && is("/servers/{}/automations/**") {
        return match ctx.logs_content {
            true => scopes(&["servers.manage", "messages.read"]),
            false => scopes(&["servers.manage"]),
        };
    }
    if is("/bulk/servers/") {
        return scopes(&["messages.read"]);
    }
    if is("/bulk/dms/") {
        return scopes(&["dms.read"]);
    }
    RULES
        .iter()
        .find(|(m, pattern, _)| *m == method && is(pattern))
        .map(|(_, _, scope)| Required::Scopes(vec![scope]))
}

pub fn scope_for(method: &str, path: &str, ctx: &Use) -> Option<Need> {
    match required_for(method, path, ctx)? {
        Required::Never => Some(Need::Never),
        Required::Scopes(list) => list.first().map(|s| Need::Scope(s)),
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TokenAnswer {
    Ok,
    InsufficientScope,
}

impl TokenAnswer {
    pub fn status(self) -> Option<(u16, &'static str)> {
        match self {
            TokenAnswer::Ok => None,
            TokenAnswer::InsufficientScope => Some((403, "insufficient_scope")),
        }
    }
}

pub fn token_route(grant: &BTreeSet<String>, method: &str, path: &str, ctx: &Use) -> TokenAnswer {
    match required_for(method, path, ctx) {
        Some(Required::Scopes(list)) if list.iter().all(|s| grant.contains(*s)) => TokenAnswer::Ok,
        Some(Required::Scopes(_) | Required::Never) | None => TokenAnswer::InsufficientScope,
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Outcome {
    pub status: u16,
    pub body: String,
}

pub fn uniform_404() -> Outcome {
    Outcome {
        status: 404,
        body: "Server not found or wrong password".to_string(),
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PersonView {
    pub plain: Outcome,
    pub staff: Outcome,
}

pub fn as_person(
    view: &PersonView,
    grant: &BTreeSet<String>,
    route_ok: bool,
    server: Option<&str>,
    picked: Option<&BTreeSet<String>>,
) -> Outcome {
    if !route_ok {
        return Outcome {
            status: 403,
            body: "insufficient_scope".to_string(),
        };
    }
    let outside = match (server, picked) {
        (Some(server), Some(picked)) => !picked.contains(server),
        (_, _) => false,
    };
    match (outside, grant.contains("admin")) {
        (true, _) => uniform_404(),
        (false, true) => view.staff.clone(),
        (false, false) => view.plain.clone(),
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Proof {
    Own,
    Everyone,
    Server(String),
    Friend,
    Dm,
    Badge,
}

pub fn proof_counts(
    proof: &Proof,
    grant: &BTreeSet<String>,
    picked: Option<&BTreeSet<String>>,
) -> bool {
    match proof {
        Proof::Own | Proof::Everyone | Proof::Badge => true,
        Proof::Server(server) => picked.is_none_or(|p| p.contains(server)),
        Proof::Friend => grant.contains("friends"),
        Proof::Dm => grant.contains("dms.read"),
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MediaPlace {
    Server { server: String, encrypted: bool },
    Dm { encrypted: bool },
}

pub fn media_ok(
    place: &MediaPlace,
    grant: &BTreeSet<String>,
    picked: Option<&BTreeSet<String>>,
    encrypted_chats: &BTreeSet<String>,
    chat: &str,
) -> bool {
    match place {
        MediaPlace::Server {
            encrypted: true, ..
        }
        | MediaPlace::Dm { encrypted: true } => {
            grant.contains("encrypted.read") && encrypted_chats.contains(chat)
        }
        MediaPlace::Dm { encrypted: false } => grant.contains("dms.read"),
        MediaPlace::Server {
            server,
            encrypted: false,
        } => grant.contains("messages.read") && picked.is_none_or(|p| p.contains(server)),
    }
}

pub fn search_servers<S: AsRef<str>>(
    member_of: &[S],
    picked: Option<&BTreeSet<String>>,
) -> Vec<String> {
    member_of
        .iter()
        .map(|s| s.as_ref())
        .filter(|s| picked.is_none_or(|p| p.contains(*s)))
        .map(str::to_string)
        .collect()
}

pub fn report_evidence_shown(encrypted: bool, grant: &BTreeSet<String>, chat_picked: bool) -> bool {
    !encrypted || (grant.contains("encrypted.read") && chat_picked)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Visibility {
    Public,
    Private,
    Encrypted,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ServerFact {
    pub key: String,
    pub visibility: Visibility,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Pick {
    pub key: String,
    pub ticked: bool,
    pub disabled: bool,
}

pub fn default_picks(servers: &[ServerFact]) -> Vec<Pick> {
    servers
        .iter()
        .map(|s| Pick {
            key: s.key.clone(),
            ticked: s.visibility == Visibility::Public,
            disabled: s.visibility == Visibility::Encrypted,
        })
        .collect()
}

pub fn clean_picks<S: AsRef<str>>(servers: &[ServerFact], picked: &[S]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for key in picked.iter().map(|k| k.as_ref()) {
        let pickable = servers
            .iter()
            .any(|s| s.key == key && s.visibility != Visibility::Encrypted);
        if pickable && !out.iter().any(|have| have == key) {
            out.push(key.to_string());
        }
    }
    out
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Grant {
    pub scopes: BTreeSet<String>,
    pub servers: Option<BTreeSet<String>>,
    pub joins: BTreeSet<String>,
    pub hosts: BTreeSet<String>,
    pub application_rev: i64,
    pub revoked: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Ask {
    pub scopes: Vec<String>,
    pub servers: Vec<String>,
    pub joins: Vec<String>,
    pub host: String,
    pub application_rev: i64,
    pub webhook: bool,
    pub from_client: bool,
}

fn live<'a>(grant: Option<&'a Grant>, ask: &Ask) -> Option<&'a Grant> {
    grant.filter(|g| {
        !g.revoked && g.application_rev == ask.application_rev && g.hosts.contains(&ask.host)
    })
}

pub fn covers(grant: Option<&Grant>, ask: &Ask) -> bool {
    let always_asks = ask.webhook || ask.from_client || ask.scopes.iter().any(|s| s == "admin");
    !always_asks
        && live(grant, ask).is_some_and(|g| {
            ask.scopes.iter().all(|s| g.scopes.contains(s))
                && g.servers
                    .as_ref()
                    .is_none_or(|have| ask.servers.iter().all(|s| have.contains(s)))
                && ask.joins.iter().all(|s| g.joins.contains(s))
        })
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Diff {
    pub added: Vec<String>,
    pub kept: Vec<String>,
}

pub fn diff(grant: Option<&Grant>, ask: &Ask) -> Diff {
    let had = |s: &&String| live(grant, ask).is_some_and(|g| g.scopes.contains(*s));
    Diff {
        added: ask.scopes.iter().filter(|s| !had(s)).cloned().collect(),
        kept: ask.scopes.iter().filter(had).cloned().collect(),
    }
}

pub const FORBIDDEN_CLAIMS: [&str; 7] = [
    "email",
    "email_verified",
    "phone_number",
    "address",
    "is_site_admin",
    "site_admin",
    "admin",
];

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PickedRoles {
    pub server: String,
    pub roles: Vec<String>,
}

fn group_part(text: &str) -> String {
    text.replace('%', "%25")
        .replace(':', "%3A")
        .replace(',', "%2C")
        .replace('|', "%7C")
}

pub fn group_values(picked: &[PickedRoles]) -> Vec<String> {
    picked
        .iter()
        .flat_map(|p| {
            let server = group_part(&p.server);
            let roles: Vec<String> = p
                .roles
                .iter()
                .map(|r| format!("{server}:{}", group_part(r)))
                .collect();
            std::iter::once(server).chain(roles)
        })
        .collect()
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Received {
    pub scope: String,
    pub claims: Vec<&'static str>,
    pub refresh: bool,
}

pub fn received<S: AsRef<str>>(granted: &[S]) -> Received {
    let has = |scope: &str| granted.iter().any(|s| s.as_ref() == scope);
    let mut claims = Vec::new();
    if has("openid") {
        claims.push("sub");
    }
    if has("profile") {
        claims.extend([
            "preferred_username",
            "name",
            "picture",
            "updated_at",
            "rchat_instance",
        ]);
    }
    if has("servers.members.read") {
        claims.extend(["groups", "rchat_servers"]);
    }
    let scopes: Vec<&str> = granted.iter().map(|s| s.as_ref()).collect();
    Received {
        scope: scopes.join(" "),
        claims,
        refresh: has("offline_access"),
    }
}

pub const ACTIVITY_PER_GRANT: u64 = 10_000;
pub const ACTIVITY_PER_APPLICATION: u64 = 1_000_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ActivityKeep {
    Detail,
    FoldOldest,
    CountsOnly,
}

pub fn activity_keep(grant_rows: u64, application_rows: u64) -> ActivityKeep {
    match (
        application_rows >= ACTIVITY_PER_APPLICATION,
        grant_rows >= ACTIVITY_PER_GRANT,
    ) {
        (true, _) => ActivityKeep::CountsOnly,
        (false, true) => ActivityKeep::FoldOldest,
        (false, false) => ActivityKeep::Detail,
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Level {
    Read,
    Write,
}

const PERSONAL_NEVER: [&str; 8] = [
    "/admin/**",
    "/auth/",
    "/me/{password|recovery|two_factor|sessions|trusted_devices|grants|tokens|protections|policy|p2p_backup|sso|delete}/**",
    "/applications/**",
    "/identity/",
    "/e2ee/me/**",
    "/config_shares/**",
    "/oauth/",
];

pub fn personal_allowed(
    method: &str,
    path: &str,
    level: Level,
    register_applications: bool,
) -> bool {
    if method == "POST" && path == "/oauth/register" {
        return register_applications;
    }
    if is_never(method, path) || PERSONAL_NEVER.iter().any(|p| path_matches(p, path)) {
        return false;
    }
    match level {
        Level::Read => matches!(method, "GET" | "HEAD"),
        Level::Write => true,
    }
}
