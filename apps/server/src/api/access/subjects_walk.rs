//! Every route that takes a name, an id, a server or a search text answers about an account and
//! a server the caller has no relationship with exactly as about a name and a server that don't
//! exist, and carries nothing of them. The routes come from
//! `openapi::tests::registered_routes`, so a new route is walked on its first run.

use std::collections::BTreeMap;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use sqlx::Row;
use utoipa::OpenApi;

use crate::api::access::subjects::checks_run;
use crate::api::openapi::ApiDoc;
use crate::api::openapi::tests::registered_routes;
use crate::api::reports::{ReportKind, Target, TargetKind};
use crate::api::test_util::{add_member, done, temp_state, test_grant};
use crate::db::{Db, NewUser, secret_key};
use crate::limits::Limits;
use crate::state::AppState;

/// What only zed's own records hold: none of it may reach a caller without a relationship.
const MARKERS: [&str; 8] = [
    "ZedMark",
    "zed-bio-7f3a",
    "#7f3a11",
    "1234567",
    "zedrole",
    "HushMark",
    "zed-nick-5c2e",
    "zed-sbio-5c2e",
];

/// Routes the walk leaves out, with the reason (`subjects_allowlist.json`).
const ALLOWLIST: &str = include_str!("subjects_allowlist.json");

/// Body and query fields that name an account, a server or a search text.
const USER_FIELDS: [&str; 5] = ["username", "user", "target", "member", "recipient"];
const USERS_FIELDS: [&str; 2] = ["usernames", "users"];
const SERVER_FIELDS: [&str; 2] = ["server", "name"];

/// The route whose body names its subject in `target`, by the fields its `kind` takes.
const REPORTS: &str = "post /api/v1/reports";

/// How the walk fills a route's body: as sampled, or as a report to `to` about a target of
/// `kind`.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Fill {
    Sampled,
    Report { to: ReportKind, kind: TargetKind },
}

/// The target fields a report takes: `id`, `server` and `username`.
struct Takes {
    id: bool,
    server: bool,
    username: bool,
}

/// The target fields a report of `kind` takes.
fn takes(kind: TargetKind) -> Takes {
    let nothing = Takes {
        id: false,
        server: false,
        username: false,
    };
    match kind {
        TargetKind::Message => Takes {
            id: true,
            ..nothing
        },
        TargetKind::Member => Takes {
            server: true,
            username: true,
            ..nothing
        },
        TargetKind::Account => Takes {
            username: true,
            ..nothing
        },
        TargetKind::Server => Takes {
            server: true,
            ..nothing
        },
        TargetKind::None => nothing,
    }
}

/// Whether a report of `kind` names something: a message, an account or a server.
fn names_something(kind: TargetKind) -> bool {
    let Takes {
        id,
        server,
        username,
    } = takes(kind);
    id || server || username
}

/// The target of a report of `kind` about `side`: the fields the kind takes, from the side. It
/// is built as a `Target`, so every field of one is filled or left out here.
fn report_target(kind: TargetKind, side: &Side) -> Value {
    let Takes {
        id,
        server,
        username,
    } = takes(kind);
    let target = Target {
        kind,
        id: id.then_some(side.message),
        server: server.then(|| side.server.to_string()),
        username: username.then(|| side.user.to_string()),
    };
    let Target {
        kind,
        id,
        server,
        username,
    } = target;
    json!({ "kind": kind, "id": id, "server": server, "username": username })
}

/// The values of the enum `schema` is, or wraps.
fn enum_values(doc: &Value, schema: &Value) -> Vec<Value> {
    let schema = resolve(doc, schema);
    if let Some(values) = schema["enum"].as_array() {
        return values.clone();
    }
    ["allOf", "oneOf", "anyOf"]
        .iter()
        .filter_map(|key| schema[key].as_array())
        .flatten()
        .flat_map(|part| enum_values(doc, part))
        .collect()
}

/// A report fill for every recipient and target kind the body of `op` lists.
fn report_fills(doc: &Value, op: &Value) -> Vec<Fill> {
    let body = resolve(
        doc,
        &op["requestBody"]["content"]["application/json"]["schema"],
    );
    let target = resolve(doc, &body["properties"]["target"]);
    let tos = enum_values(doc, &body["properties"]["to"]);
    let kinds = enum_values(doc, &target["properties"]["kind"]);
    assert!(
        !tos.is_empty() && !kinds.is_empty(),
        "{REPORTS} lists its recipients and target kinds"
    );
    let mut fills = Vec::new();
    for to in &tos {
        for kind in &kinds {
            fills.push(Fill::Report {
                to: serde_json::from_value(to.clone()).expect("a recipient"),
                kind: serde_json::from_value(kind.clone()).expect("a target kind"),
            });
        }
    }
    fills
}

/// A walked route: whether it names an account, whether it takes `q`, and how its body is
/// filled.
#[derive(Clone, Debug, PartialEq)]
struct Route {
    method: String,
    path: String,
    by_user: bool,
    has_q: bool,
    fill: Fill,
}

/// One side of the comparison: zed and the things only zed's server holds, or a name, a server
/// and ids that don't exist.
#[derive(Clone, Copy, Debug)]
struct Side {
    user: &'static str,
    server: &'static str,
    texts: [&'static str; 4],
    message: i64,
    dm: i64,
    channel: i64,
    category: i64,
    role: i64,
}

/// Who asks: alice's token, a guest holding a live grant for another password server, or
/// nobody at all.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Who {
    Alice,
    Guest,
    Anonymous,
}

/// One answer, as the comparison reads it.
#[derive(Clone, Debug, PartialEq)]
struct Answer {
    status: u16,
    body: String,
    next: bool,
    checks: Vec<&'static str>,
}

struct Walk {
    base: String,
    client: reqwest::Client,
    doc: Value,
    n: usize,
    alice: String,
}

/// The routes the allowlist leaves out, as `method path`, each with its reason.
fn allowlisted() -> BTreeMap<String, String> {
    let list: Vec<Value> = serde_json::from_str(ALLOWLIST).expect("allowlist");
    list.iter()
        .map(|entry| {
            let route = entry["route"].as_str().expect("route").to_string();
            let reason = entry["reason"].as_str().expect("reason").to_string();
            assert!(!reason.trim().is_empty(), "{route} needs a reason");
            (route, reason)
        })
        .collect()
}

fn resolve<'a>(doc: &'a Value, schema: &'a Value) -> &'a Value {
    match schema["$ref"].as_str() {
        Some(at) => {
            let name = at.rsplit('/').next().expect("ref");
            resolve(doc, &doc["components"]["schemas"][name])
        }
        None => schema,
    }
}

impl Side {
    fn user_value(&self, field: &str) -> Option<Value> {
        match field {
            f if USER_FIELDS.contains(&f) => Some(json!(self.user)),
            f if USERS_FIELDS.contains(&f) => Some(json!([self.user])),
            f if SERVER_FIELDS.contains(&f) => Some(json!(self.server)),
            "subject" => Some(json!(format!("u:{}", self.user))),
            "message_id" => Some(json!(self.message)),
            "ids" | "message_ids" => Some(json!([self.message])),
            "channel_id" => Some(json!(self.channel)),
            "dm_id" => Some(json!(self.dm)),
            "allow" => Some(json!(rchat_perms::masks::VIEW)),
            "deny" => Some(json!(0)),
            "can_view" | "can_send" | "can_read_history" => Some(Value::Null),
            _ => None,
        }
    }

    /// A value for `schema`: the side's name, server or id for the fields that take one, a
    /// plain value of the right type for every other.
    fn sample(&self, doc: &Value, schema: &Value, text: &str, depth: usize) -> Value {
        let schema = resolve(doc, schema);
        if depth > 4 {
            return Value::Null;
        }
        for key in ["oneOf", "anyOf"] {
            if let Some(list) = schema[key].as_array() {
                let pick = list
                    .iter()
                    .find(|s| resolve(doc, s)["type"] != "null")
                    .unwrap_or(&Value::Null);
                return self.sample(doc, pick, text, depth + 1);
            }
        }
        if let Some(list) = schema["allOf"].as_array() {
            let mut out = serde_json::Map::new();
            for part in list {
                if let Value::Object(map) = self.sample(doc, part, text, depth + 1) {
                    out.extend(map);
                }
            }
            return Value::Object(out);
        }
        if let Some(first) = schema["enum"].as_array().and_then(|e| e.first()) {
            return first.clone();
        }
        let kind = match &schema["type"] {
            Value::Array(kinds) => kinds
                .iter()
                .find(|k| *k != "null")
                .and_then(Value::as_str)
                .unwrap_or("null"),
            Value::String(kind) => kind.as_str(),
            _ if schema["properties"].is_object() => "object",
            _ => "null",
        };
        match kind {
            "string" => json!("x"),
            "integer" | "number" => json!(1),
            "boolean" => json!(false),
            "array" => json!([]),
            "object" => {
                let mut out = serde_json::Map::new();
                if let Some(props) = schema["properties"].as_object() {
                    for (name, prop) in props {
                        let value = match name.as_str() {
                            "q" => Some(json!(text)),
                            other => self.user_value(other),
                        };
                        out.insert(
                            name.clone(),
                            value.unwrap_or_else(|| self.sample(doc, prop, text, depth + 1)),
                        );
                    }
                }
                Value::Object(out)
            }
            _ => Value::Null,
        }
    }
}

/// Whether a route takes something the walk names: an account, a server, an id or a search text.
fn takes_subject(doc: &Value, op: &Value, path: &str) -> (bool, bool, bool) {
    let in_path = |p: &str| path.contains(&format!("{{{p}}}"));
    let mut names = Vec::new();
    if let Some(params) = op["parameters"].as_array() {
        for p in params {
            if p["in"] == "query" {
                names.push(p["name"].as_str().unwrap_or_default().to_string());
            }
        }
    }
    if let Some(schema) = op["requestBody"]["content"]["application/json"]["schema"].as_object() {
        let schema = resolve(doc, &Value::Object(schema.clone())).clone();
        if let Some(props) = schema["properties"].as_object() {
            names.extend(props.keys().cloned());
        }
    }
    let by_user = in_path("username")
        || in_path("subject")
        || names.iter().any(|n| {
            USER_FIELDS.contains(&n.as_str())
                || USERS_FIELDS.contains(&n.as_str())
                || n == "subject"
        });
    let has_q = names.iter().any(|n| n == "q");
    let any = by_user
        || has_q
        || ["name", "id", "message_id"].iter().any(|p| in_path(p))
        || names.iter().any(|n| {
            SERVER_FIELDS.contains(&n.as_str())
                || ["message_id", "ids", "message_ids", "channel_id", "dm_id"].contains(&n.as_str())
        });
    (any, by_user, has_q)
}

impl Walk {
    async fn call(
        &mut self,
        method: &str,
        path: &str,
        side: &Side,
        text: &str,
        who: Who,
        fill: Fill,
    ) -> Answer {
        let op = self.doc["paths"][path][method].clone();
        let mut url = String::new();
        for seg in path.split('/').skip(1) {
            url.push('/');
            let id = |side: &Side| match path {
                p if p.contains("/channels/") => side.channel,
                p if p.contains("/categories/") => side.category,
                p if p.contains("/roles/") => side.role,
                p if p.contains("/dms/") => side.dm,
                _ => side.message,
            };
            let value = match seg {
                "{username}" => side.user.to_string(),
                "{name}" => side.server.to_string(),
                "{subject}" => format!("u:{}", side.user),
                "{id}" => id(side).to_string(),
                "{message_id}" => side.message.to_string(),
                "{ord}" => "0".to_string(),
                s if s.starts_with('{') => "x".to_string(),
                s => s.to_string(),
            };
            url.push_str(&urlencoding(&value));
        }
        let mut query = Vec::new();
        if let Some(params) = op["parameters"].as_array() {
            for p in params {
                if p["in"] != "query" {
                    continue;
                }
                let name = p["name"].as_str().unwrap_or_default();
                let value = match name {
                    "q" => Some(json!(text)),
                    other => side.user_value(other),
                };
                let value = match (value, p["required"].as_bool().unwrap_or(false)) {
                    (Some(value), _) => value,
                    (None, true) => side.sample(&self.doc, &p["schema"], text, 0),
                    (None, false) => continue,
                };
                match value {
                    Value::Array(items) => {
                        for item in items {
                            query.push((name.to_string(), plain(&item)));
                        }
                    }
                    other => query.push((name.to_string(), plain(&other))),
                }
            }
        }
        if !query.is_empty() {
            let pairs: Vec<String> = query
                .iter()
                .map(|(k, v)| format!("{}={}", urlencoding(k), urlencoding(v)))
                .collect();
            url.push('?');
            url.push_str(&pairs.join("&"));
        }
        let body = op["requestBody"]["content"]["application/json"]["schema"]
            .as_object()
            .map(|schema| side.sample(&self.doc, &Value::Object(schema.clone()), text, 0))
            .map(|mut body| {
                match fill {
                    Fill::Sampled => {}
                    Fill::Report { to, kind } => {
                        body["to"] = json!(to);
                        body["target"] = report_target(kind, side);
                        body["form"] = Value::Null;
                    }
                }
                body
            });
        let m = reqwest::Method::from_bytes(method.to_uppercase().as_bytes()).expect("method");
        self.n += 1;
        let n = self.n;
        let mut req = self
            .client
            .request(m, format!("{}{url}", self.base))
            .header(
                "x-forwarded-for",
                format!("10.{}.{}.{}", n >> 16 & 255, n >> 8 & 255, n & 255),
            );
        req = match who {
            Who::Alice => req.bearer_auth(&self.alice),
            Who::Guest => req.header("x-guest-grant", test_grant("g-open2")),
            Who::Anonymous => req,
        };
        if let Some(body) = body {
            req = req
                .header("content-type", "application/json")
                .body(body.to_string());
        }
        checks_run();
        let res = req.send().await.expect("answer");
        let status = res.status().as_u16();
        let next = res.headers().contains_key("x-next-cursor");
        let headers: Vec<String> = res
            .headers()
            .iter()
            .map(|(k, v)| format!("{k}: {}", v.to_str().unwrap_or_default()))
            .collect();
        let body = res.text().await.expect("body");
        for marker in MARKERS {
            assert!(
                !body.contains(marker) && !headers.iter().any(|h| h.contains(marker)),
                "{method} {path} as {who:?} ({side:?}) carries {marker}: {status} {body}"
            );
        }
        Answer {
            status,
            body: masked(&body),
            next,
            checks: checks_run(),
        }
    }
}

/// Fields every answer fills fresh, whatever the name: a challenge's random nonce and the
/// time it ends, which follows the clock.
const FRESH: [&str; 2] = ["nonce", "expires_at"];

/// `body` with the fresh fields that hold a value blanked, so two answers compare by what
/// they say.
fn masked(body: &str) -> String {
    fn blank(value: &mut Value) {
        match value {
            Value::Object(map) => {
                for (key, inner) in map.iter_mut() {
                    match FRESH.contains(&key.as_str()) && !inner.is_null() {
                        true => *inner = json!("*"),
                        false => blank(inner),
                    }
                }
            }
            Value::Array(items) => items.iter_mut().for_each(blank),
            _ => {}
        }
    }
    match serde_json::from_str::<Value>(body) {
        Ok(mut value) => {
            blank(&mut value);
            value.to_string()
        }
        Err(_) => body.to_string(),
    }
}

#[test]
fn answers_a_second_apart_compare_alike() {
    let challenge = |nonce: &str, ends: Value| {
        masked(&json!({"username": "zed", "nonce": nonce, "expires_at": ends}).to_string())
    };
    assert_eq!(
        challenge("a", json!(1_794_748_097)),
        challenge("b", json!(1_794_748_098))
    );
    assert_ne!(
        challenge("a", json!(1_794_748_097)),
        challenge("a", Value::Null),
        "an end against none still tells them apart"
    );
    assert_ne!(
        masked(r#"{"username":"zed"}"#),
        masked(r#"{"username":"yan"}"#)
    );
}

fn plain(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

fn urlencoding(s: &str) -> String {
    url::form_urlencoded::byte_serialize(s.as_bytes()).collect()
}

/// `answer` for the missing side, with its names and ids read as zed's.
fn as_zed(answer: &Answer, missing: &Side, zed: &Side) -> Answer {
    Answer {
        body: swapped(&answer.body, missing, zed),
        ..answer.clone()
    }
}

/// `body` of the missing side, with its names and ids read as zed's.
fn swapped(body: &str, missing: &Side, zed: &Side) -> String {
    let mut body = body.to_string();
    for (from, to) in missing.texts.iter().zip(zed.texts.iter()).rev() {
        body = body.replace(from, to);
    }
    for (from, to) in [(missing.user, zed.user), (missing.server, zed.server)] {
        body = body.replace(from, to);
    }
    for (from, to) in [
        (missing.message, zed.message),
        (missing.dm, zed.dm),
        (missing.channel, zed.channel),
        (missing.category, zed.category),
        (missing.role, zed.role),
    ] {
        body = body.replace(&from.to_string(), &to.to_string());
    }
    body
}

/// Fields of a list entry that differ by when it was written.
const WRITTEN: [&str; 3] = ["id", "created_at", "banned_at"];

/// Lists in alice's server that keep what the by-name writes did there.
const LISTS: [&str; 2] = ["bans", "audit"];

async fn exec(db: &Db, sql: &str) {
    sqlx::query(sqlx::AssertSqlSafe(sql.to_string()))
        .execute(db)
        .await
        .expect(sql);
}

async fn id_of(db: &Db, sql: &str) -> i64 {
    sqlx::query(sqlx::AssertSqlSafe(sql.to_string()))
        .fetch_one(db)
        .await
        .expect(sql)
        .try_get(0)
        .expect("id")
}

/// zed, with marker values, is only in the password server hush ("HushMark"), where zed has
/// the role zedrole, wrote a message with a poll, reacted and pinned it, and zed wrote in a DM
/// with yan. alice shares nothing with zed and owns the server own; the guest grant `g-open2`
/// opens the password server open2, which zed is not in.
async fn world(db: &Db) -> (Side, Side) {
    NewUser::plain("root").at(1).add(db).await;
    exec(
        db,
        "UPDATE users SET is_site_admin = 1 WHERE username = 'root'",
    )
    .await;
    NewUser::plain("alice").at(1).add(db).await;
    NewUser::plain("yan").at(1).add(db).await;
    NewUser::plain("zed")
        .shown("ZedMark")
        .at(1234567)
        .add(db)
        .await;
    exec(
        db,
        "UPDATE users SET bio = 'zed-bio-7f3a', banner_color = '#7f3a11' WHERE username = 'zed'",
    )
    .await;
    exec(
        db,
        "INSERT INTO privacy(username, dms, friend_requests) VALUES('zed', 'friends', 'nobody')",
    )
    .await;
    for (name, display, creator) in [("hush", "HushMark", "zed"), ("open2", "open2", "yan")] {
        sqlx::query("INSERT INTO servers(name, display_name, creator, password_hash, created_at) VALUES($1, $2, $3, 'hash', 0)")
            .bind(name)
            .bind(display)
            .bind(creator)
            .execute(db)
            .await
            .expect("server");
    }
    exec(db, "INSERT INTO servers(name, display_name, creator, password_hash, created_at) VALUES('own', 'own', 'alice', 'hash', 0)").await;
    add_member(db, "hush", "zed", 1, 0, 1).await;
    add_member(db, "open2", "yan", 1, 0, 1).await;
    add_member(db, "own", "alice", 1, 0, 1).await;
    let channel = id_of(
        db,
        "INSERT INTO channels(server, name, created_at) VALUES('hush', 'talk', 0) RETURNING id",
    )
    .await;
    let category = id_of(db, "INSERT INTO channel_categories(server, name, position, created_at) VALUES('hush', 'zone', 0, 0) RETURNING id").await;
    let role = id_of(db, "INSERT INTO roles(server, name, color, perms) VALUES('hush', 'zedrole', '#000000', 0) RETURNING id").await;
    sqlx::query("INSERT INTO user_roles(server, username, role_id) VALUES('hush', 'zed', $1)")
        .bind(role)
        .execute(db)
        .await
        .expect("role");
    exec(
        db,
        "INSERT INTO member_profiles(server, username, name, bio, updated_at) VALUES('hush', 'zed', 'zed-nick-5c2e', 'zed-sbio-5c2e', 1)",
    )
    .await;
    let message = id_of(db, &format!("INSERT INTO messages(channel_id, author, content, created_at) VALUES({channel}, 'zed', 'hush words', 2) RETURNING id")).await;
    exec(db, &format!("INSERT INTO polls(message_id, kind, question, created_at) VALUES({message}, 'single', 'pick', 2)")).await;
    exec(db, &format!("INSERT INTO poll_options(message_id, position, text, created_at) VALUES({message}, 0, 'one', 2), ({message}, 1, 'two', 2)")).await;
    exec(db, &format!("INSERT INTO reactions(message_id, username, emoji, created_at) VALUES({message}, 'zed', 'x', 2)")).await;
    exec(
        db,
        &format!("UPDATE messages SET pinned_at = 3, pinned_by = 'zed' WHERE id = {message}"),
    )
    .await;
    let dm = id_of(
        db,
        "INSERT INTO dms(user_a, user_b) VALUES('yan', 'zed') RETURNING id",
    )
    .await;
    exec(db, &format!("INSERT INTO messages(dm_id, author, content, created_at) VALUES({dm}, 'zed', 'dm words', 2)")).await;
    exec(
        db,
        "INSERT INTO channels(server, name, created_at) VALUES('own', 'general', 0)",
    )
    .await;
    exec(
        db,
        "INSERT INTO roles(server, name, color, perms) VALUES('own', 'helpers', '#000000', 0)",
    )
    .await;
    sqlx::query("INSERT INTO guest_grants(\"grant\", server, created_at, last_used_at) VALUES($1, 'open2', 1, 4000000000)")
        .bind(secret_key(&test_grant("g-open2")))
        .execute(db)
        .await
        .expect("grant");
    sqlx::query("INSERT INTO tokens(token, username, created_at) VALUES($1, 'alice', $2)")
        .bind(secret_key("tok-alice"))
        .bind(crate::db::now())
        .execute(db)
        .await
        .expect("token");
    sqlx::query("INSERT INTO tokens(token, username, created_at) VALUES($1, 'zed', $2)")
        .bind(secret_key("tok-zed"))
        .bind(crate::db::now())
        .execute(db)
        .await
        .expect("token");
    let zed = Side {
        user: "zed",
        server: "hush",
        texts: ["zed", "zedm", "hush", "hushm"],
        message,
        dm,
        channel,
        category,
        role,
    };
    let missing = Side {
        user: "nobodyx7",
        server: "nowherex7",
        texts: ["nobodyx7", "nobodyx7m", "nowherex7", "nowherex7m"],
        message: 987_654_301,
        dm: 987_654_302,
        channel: 987_654_303,
        category: 987_654_304,
        role: 987_654_305,
    };
    (zed, missing)
}

/// The lookup limits at the top of their ranges and no miss cap, so the walk measures answers,
/// not rates.
fn wide() -> Limits {
    Limits {
        lookup_list_per_minute: 10_000,
        lookup_typeahead_per_minute: 10_000,
        lookup_search_per_minute: 1_000,
        lookup_profile_per_minute: 10_000,
        lookup_misses_per_hour: 0,
        ..Limits::default()
    }
}

async fn serve(state: &AppState) -> (String, tokio::task::JoinHandle<()>) {
    use crate::config::{AppConfig, Roles};
    use crate::server::client_ip::ProxyTrust;
    use crate::server::route_builder::{api_router, resolve_versions};
    let config = AppConfig {
        roles: Roles {
            web: false,
            ..Roles::ALL
        },
        proxy_trust: ProxyTrust::Any,
        ..AppConfig::defaults()
    };
    let app = resolve_versions(api_router(&config, state.clone()));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let addr = listener.local_addr().expect("addr");
    let server = tokio::spawn(async move {
        let _ = axum::serve(
            listener,
            app.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await;
    });
    (format!("http://{addr}"), server)
}

async fn set(db: &Db, key: &str, value: &str) {
    sqlx::query("UPDATE settings SET value = $1 WHERE key = $2")
        .bind(value)
        .bind(key)
        .execute(db)
        .await
        .expect("setting");
    crate::api::Settings::forget(db);
}

/// Every walked route; the reports route once per recipient and target kind its body lists.
fn walked(doc: &Value) -> Vec<Route> {
    let skip = allowlisted();
    let mut out = Vec::new();
    for (method, path) in registered_routes() {
        let key = format!("{method} {path}");
        if skip.contains_key(&key) {
            continue;
        }
        let op = &doc["paths"][&path][&method];
        assert!(
            !op.is_null(),
            "{key} is not in the API document; the walk needs its parameters, or an allowlist entry"
        );
        let multipart = op["requestBody"]["content"]["multipart/form-data"].is_object();
        let (any, by_user, has_q) = takes_subject(doc, op, &path);
        if !any || multipart {
            continue;
        }
        let fills = match key == REPORTS {
            true => report_fills(doc, op),
            false => vec![Fill::Sampled],
        };
        for fill in fills {
            let by_user = match fill {
                Fill::Report { to: _, kind } => takes(kind).username,
                Fill::Sampled => by_user,
            };
            out.push(Route {
                method: method.clone(),
                path: path.clone(),
                by_user,
                has_q,
                fill,
            });
        }
    }
    out
}

impl Walk {
    /// What the list `GET /servers/{server}/{list}` holds about each side, newest first, with
    /// the fields that differ by time blanked and the missing side read as zed's.
    async fn listed(
        &mut self,
        server: &str,
        list: &str,
        zed: &Side,
        missing: &Side,
    ) -> (Vec<String>, Vec<String>) {
        fn blank(value: &mut Value) {
            match value {
                Value::Object(map) => {
                    for (key, inner) in map.iter_mut() {
                        match WRITTEN.contains(&key.as_str()) {
                            true => *inner = json!("*"),
                            false => blank(inner),
                        }
                    }
                }
                Value::Array(items) => items.iter_mut().for_each(blank),
                _ => {}
            }
        }
        let body = self
            .client
            .get(format!("{}/api/v1/servers/{server}/{list}", self.base))
            .bearer_auth(&self.alice)
            .send()
            .await
            .expect("list")
            .text()
            .await
            .expect("body");
        let items: Vec<Value> = serde_json::from_str(&body).expect("a list");
        let names = |user: &str| [format!("\"{user}\""), format!("u:{user}")];
        let (mut theirs, mut none) = (Vec::new(), Vec::new());
        for mut item in items {
            blank(&mut item);
            let text = item.to_string();
            if names(missing.user)
                .iter()
                .any(|n| text.contains(n.as_str()))
            {
                none.push(swapped(&text, missing, zed));
            } else if names(zed.user).iter().any(|n| text.contains(n.as_str())) {
                theirs.push(text);
            }
        }
        (theirs, none)
    }

    /// Calls `route` for zed's side and the missing side as `who` (and for each search text),
    /// and returns every pair that differs, as text.
    async fn pair(&mut self, route: &Route, zed: &Side, missing: &Side, who: Who) -> Vec<String> {
        let Route {
            method,
            path,
            by_user: _,
            has_q,
            fill,
        } = route;
        let fill = *fill;
        let mut wrong = Vec::new();
        let texts = match has_q {
            true => 0..4,
            false => 0..1,
        };
        for t in texts {
            let theirs = self.call(method, path, zed, zed.texts[t], who, fill).await;
            let none = self
                .call(method, path, missing, missing.texts[t], who, fill)
                .await;
            let none = as_zed(&none, missing, zed);
            if theirs != none {
                wrong.push(format!(
                    "{method} {path} {fill:?} as {who:?} (text {}): {theirs:?} against {none:?}",
                    zed.texts[t]
                ));
            }
        }
        wrong
    }
}

#[tokio::test]
async fn lookups_answer_unrelated_and_missing_subjects_alike() {
    let (state, path) = temp_state("subjects_walk").await;
    let state = state.with_limits(Arc::new(wide()));
    let db = state.db.clone();
    let (zed, missing) = world(&db).await;
    let doc = serde_json::to_value(ApiDoc::openapi()).expect("doc");
    let routes = walked(&doc);
    assert!(routes.len() > 60, "{} routes walked", routes.len());
    let (base, server) = serve(&state).await;
    let mut walk = Walk {
        base,
        client: reqwest::Client::new(),
        doc,
        n: 0,
        alice: "tok-alice".to_string(),
    };
    let mut wrong = Vec::new();
    for route in &routes {
        for who in [Who::Alice, Who::Guest, Who::Anonymous] {
            wrong.extend(walk.pair(route, &zed, &missing, who).await);
        }
    }
    set(&db, "guests_enabled", "0").await;
    for route in &routes {
        for who in [Who::Guest, Who::Anonymous] {
            wrong.extend(walk.pair(route, &zed, &missing, who).await);
        }
    }
    set(&db, "guests_enabled", "1").await;
    println!("walked {} routes in {} requests", routes.len(), walk.n);
    assert!(wrong.is_empty(), "{}", wrong.join("\n"));

    // Every report target that names something reaches its access check: zed's message, zed in
    // hush, zed's account and hush itself are the uniform 404 for alice.
    let (report, reports_path) = REPORTS.split_once(' ').expect("method and path");
    let reports: Vec<Fill> = routes
        .iter()
        .filter(|r| (r.method.as_str(), r.path.as_str()) == (report, reports_path))
        .map(|r| r.fill)
        .collect();
    let named = |fill: &Fill| match *fill {
        Fill::Report { to: _, kind } => names_something(kind),
        Fill::Sampled => false,
    };
    assert!(reports.iter().any(named), "{REPORTS} is walked");
    for fill in reports.iter().filter(|f| named(f)) {
        let answer = walk
            .call(report, reports_path, &zed, zed.texts[0], Who::Alice, *fill)
            .await;
        assert_eq!(answer.status, 404, "{fill:?}: {answer:?}");
    }

    // The control half: once alice is in hush, the card and the search show zed's markers, so
    // the walk above can't have passed because every route failed.
    add_member(&db, "hush", "alice", 0, 0, 2).await;
    let card = walk
        .client
        .get(format!("{}/api/v1/users/zed/card?server=hush", walk.base))
        .bearer_auth("tok-alice")
        .send()
        .await
        .expect("card")
        .text()
        .await
        .expect("body");
    for marker in ["ZedMark", "zed-bio-7f3a", "#7f3a11", "1234567", "zedrole"] {
        assert!(card.contains(marker), "{marker} in {card}");
    }
    let found = walk
        .client
        .get(format!("{}/api/v1/users/search?q=zedm", walk.base))
        .bearer_auth("tok-alice")
        .send()
        .await
        .expect("search")
        .text()
        .await
        .expect("body");
    assert!(found.contains("ZedMark"), "{found}");
    server.abort();
    done(state, path).await;
}

/// The by-name routes in a server the caller owns: an account that isn't a member and a name
/// without an account get the same answer, and leave the same entries in the server's ban list
/// and audit log, or the route counts the miss, so past the misses both get the same refusal and
/// leave the same entries. A report answers them alike either way.
#[tokio::test]
async fn by_name_routes_in_your_own_server_answer_alike() {
    let (state, path) = temp_state("subjects_walk_own").await;
    let state = state.with_limits(Arc::new(wide()));
    let db = state.db.clone();
    let (zed, missing) = world(&db).await;
    exec(&db, "INSERT INTO servers(name, display_name, creator, password_hash, created_at) VALUES('own2', 'own2', 'alice', 'hash', 0)").await;
    add_member(&db, "own2", "alice", 1, 0, 1).await;
    exec(
        &db,
        "INSERT INTO channels(server, name, created_at) VALUES('own2', 'general', 0)",
    )
    .await;
    exec(
        &db,
        "INSERT INTO roles(server, name, color, perms) VALUES('own2', 'helpers', '#000000', 0)",
    )
    .await;
    let mut sides = Vec::new();
    for server in ["own", "own2"] {
        let channel = id_of(
            &db,
            &format!("SELECT id FROM channels WHERE server = '{server}'"),
        )
        .await;
        let role = id_of(
            &db,
            &format!("SELECT id FROM roles WHERE server = '{server}'"),
        )
        .await;
        let server: &'static str = server;
        let in_own = |side: &Side| Side {
            server,
            channel,
            role,
            category: 0,
            ..*side
        };
        sides.push((in_own(&zed), in_own(&missing)));
    }
    let doc = serde_json::to_value(ApiDoc::openapi()).expect("doc");
    let routes: Vec<_> = walked(&doc).into_iter().filter(|r| r.by_user).collect();
    assert!(routes.len() > 15, "{} by-name routes", routes.len());
    let (base, server) = serve(&state).await;
    let mut walk = Walk {
        base,
        client: reqwest::Client::new(),
        doc: doc.clone(),
        n: 0,
        alice: "tok-alice".to_string(),
    };
    println!(
        "by name in alice's own server: {}",
        routes
            .iter()
            .map(|r| match r.fill {
                Fill::Sampled => format!("{} {}", r.method, r.path),
                Fill::Report { to, kind } => format!("{} {} ({to:?} {kind:?})", r.method, r.path),
            })
            .collect::<Vec<_>>()
            .join(", ")
    );
    let (zed, missing) = sides[0];
    let mut differ = Vec::new();
    let mut reports_apart = Vec::new();
    for route in &routes {
        let apart = walk.pair(route, &zed, &missing, Who::Alice).await;
        match (route.fill, apart.is_empty()) {
            (_, true) => {}
            (Fill::Report { to: _, kind: _ }, false) => reports_apart.extend(apart),
            (Fill::Sampled, false) => differ.push(route.clone()),
        }
    }
    // A report names what you can see or gets the uniform 404, inside the miss budget too.
    assert!(reports_apart.is_empty(), "{}", reports_apart.join("\n"));
    let mut apart = 0;
    for list in LISTS {
        let (theirs, none) = walk.listed("own", list, &zed, &missing).await;
        assert!(
            !theirs.is_empty() || list != "audit",
            "the writes left entries in the audit log"
        );
        apart += usize::from(theirs != none);
    }
    println!(
        "told apart inside the miss budget: {} routes, {apart} lists",
        differ.len()
    );
    server.abort();
    // A route or a list that told the two apart must be inside the miss budget: once alice's
    // misses are spent, every route answers both alike and leaves both alike, in a server the
    // first walk did not touch.
    let counted = state.clone().with_limits(Arc::new(Limits {
        lookup_misses_per_hour: 1,
        ..wide()
    }));
    let (base, server) = serve(&counted).await;
    walk.base = base;
    let spent = walk
        .client
        .get(format!("{}/api/v1/users/ghost/card", walk.base))
        .bearer_auth("tok-alice")
        .send()
        .await
        .expect("miss")
        .status();
    assert_eq!(spent.as_u16(), 404, "the one miss");
    let (zed, missing) = sides[1];
    let mut wrong = Vec::new();
    for route in &routes {
        let apart = walk.pair(route, &zed, &missing, Who::Alice).await;
        if differ.contains(route) {
            wrong.extend(apart);
        }
    }
    for list in LISTS {
        let (theirs, none) = walk.listed("own2", list, &zed, &missing).await;
        for marker in MARKERS {
            assert!(
                !theirs.iter().any(|t| t.contains(marker)),
                "{list} carries {marker}: {theirs:?}"
            );
        }
        if theirs != none {
            wrong.push(format!("the {list} list: {theirs:?} against {none:?}"));
        }
    }
    server.abort();
    assert!(
        wrong.is_empty(),
        "answered apart and outside the miss budget:\n{}",
        wrong.join("\n")
    );
    done(state, path).await;
}

impl Walk {
    /// Sends the report `body` with the bearer `token`.
    async fn report(&mut self, token: &str, body: &Value) -> Answer {
        self.n += 1;
        let n = self.n;
        let res = self
            .client
            .post(format!("{}/api/v1/reports", self.base))
            .header(
                "x-forwarded-for",
                format!("10.{}.{}.{}", n >> 16 & 255, n >> 8 & 255, n & 255),
            )
            .bearer_auth(token)
            .header("content-type", "application/json")
            .body(body.to_string())
            .send()
            .await
            .expect("answer");
        Answer {
            status: res.status().as_u16(),
            body: res.text().await.expect("body"),
            next: false,
            checks: Vec::new(),
        }
    }
}

/// The reports route at the default limits. A member target in alice's server answers alike for
/// an account alice sees elsewhere, an account she can't see and a name without an account, and
/// an account target answers the last two alike: the uniform 404, inside her miss budget. Each
/// kind with the fields the walk gives it sends a report, and each of those fields is needed.
/// Every report sent has its own reporter, so no report cap is reached.
#[tokio::test]
async fn reports_name_their_targets_alike_at_the_default_limits() {
    let (state, path) = temp_state("subjects_walk_reports").await;
    let db = state.db.clone();
    let (zed, missing) = world(&db).await;
    NewUser::plain("vic").at(1).add(&db).await;
    exec(&db, "INSERT INTO servers(name, display_name, creator, password_hash, created_at) VALUES('side', 'side', 'vic', 'hash', 0)").await;
    add_member(&db, "side", "vic", 1, 0, 1).await;
    add_member(&db, "side", "alice", 0, 0, 2).await;
    let doc = serde_json::to_value(ApiDoc::openapi()).expect("doc");
    let (report, reports_path) = REPORTS.split_once(' ').expect("method and path");
    let fills: Vec<(ReportKind, TargetKind)> = walked(&doc)
        .into_iter()
        .filter_map(|r| match r.fill {
            Fill::Report { to, kind } if names_something(kind) => Some((to, kind)),
            Fill::Report { to: _, kind: _ } | Fill::Sampled => None,
        })
        .collect();
    assert!(fills.len() >= 8, "{fills:?}");
    let (base, server) = serve(&state).await;
    let mut walk = Walk {
        base,
        client: reqwest::Client::new(),
        doc,
        n: 0,
        alice: "tok-alice".to_string(),
    };
    let in_own = |user: &'static str| Side {
        user,
        server: "own",
        ..zed
    };
    let mut wrong = Vec::new();
    for &(to, kind) in &fills {
        let names = match kind {
            TargetKind::Member => vec![in_own("vic"), in_own(zed.user), in_own(missing.user)],
            TargetKind::Account => vec![zed, missing],
            TargetKind::Message | TargetKind::Server | TargetKind::None => continue,
        };
        let fill = Fill::Report { to, kind };
        for side in &names {
            let answer = walk
                .call(report, reports_path, side, side.texts[0], Who::Alice, fill)
                .await;
            if (answer.status, answer.body.as_str()) != (404, r#"{"error":"Not found"}"#) {
                wrong.push(format!("{fill:?} about {}: {answer:?}", side.user));
            }
        }
    }
    assert!(wrong.is_empty(), "{}", wrong.join("\n"));

    add_member(&db, "hush", "alice", 0, 0, 2).await;
    for (n, &(to, kind)) in fills.iter().enumerate() {
        let target = report_target(kind, &zed);
        let Takes {
            id,
            server,
            username,
        } = takes(kind);
        for (field, taken) in [("id", id), ("server", server), ("username", username)] {
            if !taken {
                continue;
            }
            let mut short = target.clone();
            short[field] = Value::Null;
            let answer = walk
                .report(
                    "tok-alice",
                    &json!({ "to": to, "reason": "spam", "target": short }),
                )
                .await;
            assert_eq!(
                (answer.status, answer.body.contains("Incomplete target")),
                (400, true),
                "{to:?} {kind:?} without {field}: {answer:?}"
            );
        }
        let reporter = format!("reporter{n}");
        NewUser::plain(&reporter).at(1).add(&db).await;
        add_member(&db, "hush", &reporter, 0, 0, 2).await;
        let token = format!("tok-{reporter}");
        sqlx::query("INSERT INTO tokens(token, username, created_at) VALUES($1, $2, $3)")
            .bind(secret_key(&token))
            .bind(&reporter)
            .bind(state.clock.unix())
            .execute(&db)
            .await
            .expect("token");
        let answer = walk
            .report(
                &token,
                &json!({ "to": to, "reason": "spam", "target": target }),
            )
            .await;
        let sent = match (to, kind) {
            (ReportKind::Server, TargetKind::Account | TargetKind::Server) => {
                answer.status == 400 && answer.body.contains(crate::api::reports::INSTANCE_ONLY)
            }
            (_, _) => answer.status == 200,
        };
        assert!(sent, "{to:?} {kind:?}: {answer:?}");
    }
    server.abort();
    done(state, path).await;
}

type Socket =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

/// Whether `user_updated` for zed arrives on `ws` within `wait`.
async fn heard(mut ws: Socket, wait: Duration) -> bool {
    use tokio_tungstenite::tungstenite::Message as T;
    let until = tokio::time::Instant::now() + wait;
    loop {
        match tokio::time::timeout_at(until, ws.next()).await {
            Ok(Some(Ok(T::Text(text)))) => {
                let v: Value = serde_json::from_str(&text).expect("json");
                if v["type"] == "user_updated" && v["user"]["username"] == "zed" {
                    return true;
                }
            }
            Ok(Some(Ok(_))) => {}
            Err(_) | Ok(Some(Err(_)) | None) => return false,
        }
    }
}

/// `user_updated` for zed reaches alice's socket only once she shares hush with zed.
#[tokio::test]
async fn user_updates_reach_only_people_with_a_relationship() {
    use tokio_tungstenite::tungstenite::Message as T;
    let (state, path) = temp_state("subjects_walk_ws").await;
    let db = state.db.clone();
    world(&db).await;
    let (base, server) = serve(&state).await;
    let client = reqwest::Client::new();
    let ws_url = format!("{}/api/v1/ws", base.replacen("http", "ws", 1));
    let socket = || async {
        let (mut ws, _) = tokio_tungstenite::connect_async(ws_url.as_str())
            .await
            .expect("socket");
        let frame = json!({"type": "auth", "token": "tok-alice"}).to_string();
        ws.send(T::text(frame)).await.expect("auth");
        ws
    };
    let update = |bio: &'static str| {
        let client = client.clone();
        let base = base.clone();
        async move {
            let res = client
                .patch(format!("{base}/api/v1/me"))
                .bearer_auth("tok-zed")
                .header("content-type", "application/json")
                .body(json!({ "bio": bio }).to_string())
                .send()
                .await
                .expect("patch");
            assert!(res.status().is_success(), "{}", res.status());
        }
    };
    let before = socket().await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    update("zed-bio-2").await;
    assert!(
        !heard(before, Duration::from_secs(2)).await,
        "alice shares nothing with zed"
    );
    add_member(&db, "hush", "alice", 0, 0, 2).await;
    let after = socket().await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    update("zed-bio-3").await;
    assert!(
        heard(after, Duration::from_secs(20)).await,
        "alice is in hush now"
    );
    server.abort();
    done(state, path).await;
}

/// Lookups by name follow an account's own Everyone and a server that keeps its members to
/// itself.
#[tokio::test]
async fn lookups_follow_the_choice_and_the_server_option() {
    let (state, path) = temp_state("subjects_walk_rules").await;
    let state = state.with_limits(Arc::new(wide()));
    let db = state.db.clone();
    world(&db).await;
    let (base, server) = serve(&state).await;
    let client = reqwest::Client::new();
    let get = |url: String| {
        let client = client.clone();
        async move {
            let res = client
                .get(url)
                .bearer_auth("tok-alice")
                .send()
                .await
                .expect("answer");
            (res.status().as_u16(), res.text().await.expect("body"))
        }
    };
    let lookups = |user: &'static str| {
        [
            format!("{base}/api/v1/users/{user}/card"),
            format!("{base}/api/v1/users/{user}/card?server=hush"),
            format!("{base}/api/v1/users/{user}/profile?server=hush"),
            format!("{base}/api/v1/users/search?q={}&server=hush", &user[..3]),
            format!("{base}/api/v1/servers/hush/mentions?q={}", &user[..3]),
        ]
    };
    // hush lets people read it now, so alice reads it as an outsider.
    exec(
        &db,
        "UPDATE servers SET public_read = 1 WHERE name = 'hush'",
    )
    .await;
    exec(
        &db,
        "UPDATE servers SET members_visible = 0 WHERE name = 'hush'",
    )
    .await;
    for (zed, nobody) in lookups("zed").into_iter().zip(lookups("nob")) {
        let (code, body) = get(zed.clone()).await;
        for marker in ["zed-bio-7f3a", "#7f3a11", "1234567", "zedrole"] {
            assert!(!body.contains(marker), "{zed} shows {marker}: {body}");
        }
        assert_eq!(
            (code, body.replace("zed", "nob")),
            get(nobody).await,
            "{zed}: hush keeps its members to itself"
        );
    }
    for list in [
        "members",
        "members?q=ze",
        "members?usernames=zed",
        "interacted",
    ] {
        let (code, body) = get(format!("{base}/api/v1/servers/hush/{list}")).await;
        assert_eq!((code, body.as_str()), (200, "[]"), "{list}");
    }
    exec(
        &db,
        "UPDATE servers SET members_visible = 1 WHERE name = 'hush'",
    )
    .await;
    let (_, card) = get(format!("{base}/api/v1/users/zed/card?server=hush")).await;
    assert!(card.contains("zed-bio-7f3a"), "the control: {card}");
    let (_, found) = get(format!("{base}/api/v1/users/search?q=zed&server=hush")).await;
    assert!(found.contains("ZedMark"), "the control: {found}");
    exec(
        &db,
        "UPDATE servers SET public_read = 0 WHERE name = 'hush'",
    )
    .await;
    exec(
        &db,
        "UPDATE privacy SET profile = 'everyone' WHERE username = 'zed'",
    )
    .await;
    for (choices, shown) in [("any", true), ("narrower", false), ("site", false)] {
        set(&db, "profile_choices", choices).await;
        let (code, card) = get(format!("{base}/api/v1/users/zed/card")).await;
        assert_eq!(
            card.contains("zed-bio-7f3a"),
            shown,
            "{choices}: {code} {card}"
        );
        let (_, found) = get(format!("{base}/api/v1/users/search?q=zedm")).await;
        assert_eq!(found.contains("ZedMark"), shown, "{choices}: {found}");
    }
    server.abort();
    done(state, path).await;
}
