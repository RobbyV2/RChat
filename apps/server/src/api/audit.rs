use axum::extract::{Path, Query, State};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use sqlx::{AnyConnection, Row};
use utoipa::{IntoParams, ToSchema};

use crate::api::access::perms::Perm;
use crate::api::access::{Proof, denied, resolve_server};
use crate::api::{
    ApiError, ApiErrorBody, Authed, Paged, UserRef, bad, cursor_int, decode_cursor, encode_cursor,
    placeholders, user_from, user_refs,
};
use crate::db::{Db, PURGE_BATCH, now};
use crate::state::AppState;

/// Most entries per page.
pub const PAGE_MAX: i64 = 50;
/// Largest stored `details` JSON, in bytes.
pub const DETAILS_MAX: usize = 4096;
/// Longest text value kept in `details`, in characters.
const TEXT_MAX: usize = 300;
const TARGET_QUERY_MAX: usize = 100;

/// What happened. Stored as the dotted name; the part before the dot is the group.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Action {
    MemberKick,
    MemberBan,
    MemberUnban,
    MemberTimeout,
    MemberUntimeout,
    AdminGrant,
    AdminRevoke,
    AdminTransfer,
    AdminPerms,
    RoleCreate,
    RoleUpdate,
    RoleDelete,
    RoleAssign,
    RoleUnassign,
    ChannelCreate,
    ChannelUpdate,
    ChannelDelete,
    ChannelPermSet,
    ChannelPermClear,
    ChannelReorder,
    CategoryCreate,
    CategoryUpdate,
    CategoryDelete,
    ServerUpdate,
    SystemMessages,
    AccessMode,
    PasswordCreate,
    PasswordRevoke,
    MessageDelete,
    MessageBulkDelete,
    AttachmentRemove,
    MessagePin,
    MessageUnpin,
    PollClose,
    PollReopen,
    WebhookCreate,
    WebhookUpdate,
    WebhookDelete,
    WebhookTokenReset,
    OutgoingCreate,
    OutgoingUpdate,
    OutgoingDelete,
    OutgoingSecretReset,
}

pub const ACTIONS: &[Action] = &[
    Action::MemberKick,
    Action::MemberBan,
    Action::MemberUnban,
    Action::MemberTimeout,
    Action::MemberUntimeout,
    Action::AdminGrant,
    Action::AdminRevoke,
    Action::AdminTransfer,
    Action::AdminPerms,
    Action::RoleCreate,
    Action::RoleUpdate,
    Action::RoleDelete,
    Action::RoleAssign,
    Action::RoleUnassign,
    Action::ChannelCreate,
    Action::ChannelUpdate,
    Action::ChannelDelete,
    Action::ChannelPermSet,
    Action::ChannelPermClear,
    Action::ChannelReorder,
    Action::CategoryCreate,
    Action::CategoryUpdate,
    Action::CategoryDelete,
    Action::ServerUpdate,
    Action::SystemMessages,
    Action::AccessMode,
    Action::PasswordCreate,
    Action::PasswordRevoke,
    Action::MessageDelete,
    Action::MessageBulkDelete,
    Action::AttachmentRemove,
    Action::MessagePin,
    Action::MessageUnpin,
    Action::PollClose,
    Action::PollReopen,
    Action::WebhookCreate,
    Action::WebhookUpdate,
    Action::WebhookDelete,
    Action::WebhookTokenReset,
    Action::OutgoingCreate,
    Action::OutgoingUpdate,
    Action::OutgoingDelete,
    Action::OutgoingSecretReset,
];

/// Action groups, the part of an action name before the dot.
pub const GROUPS: &[&str] = &[
    "member", "role", "channel", "server", "access", "message", "webhook",
];

impl Action {
    pub fn as_str(self) -> &'static str {
        match self {
            Action::MemberKick => "member.kick",
            Action::MemberBan => "member.ban",
            Action::MemberUnban => "member.unban",
            Action::MemberTimeout => "member.timeout",
            Action::MemberUntimeout => "member.untimeout",
            Action::AdminGrant => "member.admin_grant",
            Action::AdminRevoke => "member.admin_revoke",
            Action::AdminTransfer => "member.admin_transfer",
            Action::AdminPerms => "member.admin_perms",
            Action::RoleCreate => "role.create",
            Action::RoleUpdate => "role.update",
            Action::RoleDelete => "role.delete",
            Action::RoleAssign => "role.assign",
            Action::RoleUnassign => "role.unassign",
            Action::ChannelCreate => "channel.create",
            Action::ChannelUpdate => "channel.update",
            Action::ChannelDelete => "channel.delete",
            Action::ChannelPermSet => "channel.perm_set",
            Action::ChannelPermClear => "channel.perm_clear",
            Action::ChannelReorder => "channel.reorder",
            Action::CategoryCreate => "channel.category_create",
            Action::CategoryUpdate => "channel.category_update",
            Action::CategoryDelete => "channel.category_delete",
            Action::ServerUpdate => "server.update",
            Action::SystemMessages => "server.system_messages",
            Action::AccessMode => "access.mode",
            Action::PasswordCreate => "access.password_create",
            Action::PasswordRevoke => "access.password_revoke",
            Action::MessageDelete => "message.delete",
            Action::MessageBulkDelete => "message.bulk_delete",
            Action::AttachmentRemove => "message.attachment_remove",
            Action::MessagePin => "message.pin",
            Action::MessageUnpin => "message.unpin",
            Action::PollClose => "message.poll_close",
            Action::PollReopen => "message.poll_reopen",
            Action::WebhookCreate => "webhook.create",
            Action::WebhookUpdate => "webhook.update",
            Action::WebhookDelete => "webhook.delete",
            Action::WebhookTokenReset => "webhook.token_reset",
            Action::OutgoingCreate => "webhook.outgoing_create",
            Action::OutgoingUpdate => "webhook.outgoing_update",
            Action::OutgoingDelete => "webhook.outgoing_delete",
            Action::OutgoingSecretReset => "webhook.outgoing_secret_reset",
        }
    }

    pub fn parse(name: &str) -> Option<Action> {
        ACTIONS.iter().copied().find(|a| a.as_str() == name)
    }
}

/// Who did it. Site admins acting through their instance powers are `Staff` and never named.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Actor {
    User(String),
    Staff,
}

impl Actor {
    pub fn of(user: &crate::db::User, staff: bool) -> Actor {
        match staff {
            true => Actor::Staff,
            false => Actor::User(user.username.clone()),
        }
    }

    /// `Staff` when the action only passed through instance powers.
    pub fn staff_if(self, bypassed: bool) -> Actor {
        match bypassed {
            true => Actor::Staff,
            false => self,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TargetKind {
    User,
    Role,
    Channel,
    Category,
    Message,
    Password,
    Server,
    Webhook,
}

impl TargetKind {
    pub fn as_str(self) -> &'static str {
        match self {
            TargetKind::User => "user",
            TargetKind::Role => "role",
            TargetKind::Channel => "channel",
            TargetKind::Category => "category",
            TargetKind::Message => "message",
            TargetKind::Password => "password",
            TargetKind::Server => "server",
            TargetKind::Webhook => "webhook",
        }
    }
}

/// What the action was done to: a user (`name` is the username), a role, channel or category
/// (`id` and name at the time), a message (`id`, `name` is its author), an extra password
/// (`id`, `name` is its label) or the server itself (`name` is its display name).
#[derive(Clone, Debug)]
pub struct Target {
    pub kind: TargetKind,
    pub id: Option<i64>,
    pub name: Option<String>,
}

impl Target {
    pub fn user(username: &str) -> Target {
        Target {
            kind: TargetKind::User,
            id: None,
            name: Some(username.to_string()),
        }
    }

    pub fn with_id(kind: TargetKind, id: i64, name: Option<&str>) -> Target {
        Target {
            kind,
            id: Some(id),
            name: name.map(str::to_string),
        }
    }

    pub fn server(display_name: &str) -> Target {
        Target {
            kind: TargetKind::Server,
            id: None,
            name: Some(display_name.to_string()),
        }
    }
}

/// A channel as it was when the action happened. `private` channels (view restricted or with
/// any permission rule) are hidden in the log from viewers who can't see them.
#[derive(Clone, Debug)]
pub struct ChannelRef {
    pub id: i64,
    pub name: String,
    pub private: bool,
}

impl ChannelRef {
    pub fn value(&self) -> Value {
        json!({ "id": self.id, "name": self.name, "private": self.private })
    }
}

pub async fn channel_ref<'e, E>(ex: E, id: i64) -> sqlx::Result<Option<ChannelRef>>
where
    E: sqlx::Executor<'e, Database = sqlx::Any>,
{
    sqlx::query("SELECT c.name, CASE WHEN c.restrict_view <> 0 OR EXISTS(SELECT 1 FROM channel_perms cp WHERE cp.channel_id = c.id) THEN 1 ELSE 0 END FROM channels c WHERE c.id = $1")
        .bind(id)
        .fetch_optional(ex)
        .await?
        .map(|r| {
            Ok(ChannelRef {
                id,
                name: r.try_get(0)?,
                private: r.try_get::<i64, _>(1)? != 0,
            })
        })
        .transpose()
}

fn clip(value: Value) -> Value {
    match value {
        Value::String(s) if s.chars().count() > TEXT_MAX => Value::String(format!(
            "{}...",
            s.chars().take(TEXT_MAX).collect::<String>()
        )),
        Value::Array(items) => Value::Array(items.into_iter().map(clip).collect()),
        Value::Object(map) => Value::Object(map.into_iter().map(|(k, v)| (k, clip(v))).collect()),
        other => other,
    }
}

/// Small, plain details of an entry: `changes` (field, before, after), the `channel` it
/// happened in, and other facts. Never secrets. Every channel named anywhere in them must be
/// passed to `channel` or `mention`, so viewers who can't see one get the entry hidden.
#[derive(Clone, Debug, Default)]
pub struct Details {
    map: Map<String, Value>,
    channels: Vec<(i64, bool)>,
}

impl Details {
    pub fn new() -> Details {
        Details::default()
    }

    /// Adds a change unless `before` equals `after`. Creations use `null` before, deletions
    /// `null` after.
    pub fn change(
        mut self,
        field: &str,
        before: impl Into<Value>,
        after: impl Into<Value>,
    ) -> Self {
        let (before, after) = (before.into(), after.into());
        if before != after {
            let changes = self
                .map
                .entry("changes")
                .or_insert_with(|| Value::Array(Vec::new()));
            if let Value::Array(list) = changes {
                list.push(json!({ "field": field, "before": before, "after": after }));
            }
        }
        self
    }

    pub fn set(mut self, key: &str, value: impl Into<Value>) -> Self {
        self.map.insert(key.to_string(), value.into());
        self
    }

    /// The channel the action happened in.
    pub fn channel(self, channel: &ChannelRef) -> Self {
        self.mention(channel).set("channel", channel.value())
    }

    /// A channel the details name somewhere else, such as in a change.
    pub fn mention(mut self, channel: &ChannelRef) -> Self {
        if !self.channels.iter().any(|(id, _)| *id == channel.id) {
            self.channels.push((channel.id, channel.private));
        }
        self
    }

    pub fn has_changes(&self) -> bool {
        self.map
            .get("changes")
            .is_some_and(|c| c.as_array().is_some_and(|l| !l.is_empty()))
    }

    fn encode(map: Map<String, Value>) -> String {
        let map: Map<String, Value> = map.into_iter().map(|(k, v)| (k, clip(v))).collect();
        let text = Value::Object(map.clone()).to_string();
        match text.len() <= DETAILS_MAX {
            true => text,
            false => {
                let mut short = Map::new();
                short.insert("truncated".to_string(), Value::Bool(true));
                if let Some(channel) = map.get("channel") {
                    short.insert("channel".to_string(), channel.clone());
                }
                Value::Object(short).to_string()
            }
        }
    }
}

/// One audit log entry, written with `record` in the same transaction as the action.
pub struct Entry {
    pub server: String,
    pub actor: Actor,
    pub action: Action,
    pub target: Option<Target>,
    pub details: Details,
}

impl Entry {
    pub fn new(server: &str, actor: &Actor, action: Action) -> Entry {
        Entry {
            server: server.to_string(),
            actor: actor.clone(),
            action,
            target: None,
            details: Details::new(),
        }
    }

    pub fn target(mut self, target: Target) -> Entry {
        self.target = Some(target);
        self
    }

    pub fn details(mut self, details: Details) -> Entry {
        self.details = details;
        self
    }
}

/// An entry about the message `id` by `author` in `channel`.
pub fn message_entry(
    server: &str,
    actor: &Actor,
    action: Action,
    id: i64,
    author: &str,
    channel: &ChannelRef,
) -> Entry {
    Entry::new(server, actor, action)
        .target(Target::with_id(TargetKind::Message, id, Some(author)))
        .details(Details::new().channel(channel))
}

/// An entry about `channel`.
pub fn channel_entry(server: &str, actor: &Actor, action: Action, channel: &ChannelRef) -> Entry {
    Entry::new(server, actor, action).target(Target::with_id(
        TargetKind::Channel,
        channel.id,
        Some(&channel.name),
    ))
}

/// Writes `entry`. Pass the action's transaction, so a failed action logs nothing and a failed
/// write undoes the action. Targets and rule subjects are always named, site admins included:
/// the action's own events name them anyway, so a staff marker on them would only reveal who
/// is staff (`target_staff` stays 0 for new entries).
pub async fn record(conn: &mut AnyConnection, entry: Entry) -> sqlx::Result<()> {
    record_id(conn, entry).await.map(|_| ())
}

/// `record`, answering the new entry's id.
pub(crate) async fn record_id(conn: &mut AnyConnection, entry: Entry) -> sqlx::Result<i64> {
    let Entry {
        server,
        actor,
        action,
        target,
        details: Details { map, channels },
    } = entry;
    let (kind, id, name) = match target {
        Some(Target { kind, id, name }) => (Some(kind), id, name),
        None => (None, None, None),
    };
    let (actor, staff) = match actor {
        Actor::User(name) => (Some(name), 0i64),
        Actor::Staff => (None, 1),
    };
    let entry: i64 = sqlx::query("INSERT INTO audit_log(server, actor, staff, action, target_kind, target_id, target_name, target_staff, details, created_at) VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id")
        .bind(server)
        .bind(actor)
        .bind(staff)
        .bind(action.as_str())
        .bind(kind.map(TargetKind::as_str))
        .bind(id)
        .bind(name)
        .bind(0i64)
        .bind(Details::encode(map))
        .bind(now())
        .fetch_one(&mut *conn)
        .await?
        .try_get(0)?;
    for (channel, private) in channels {
        sqlx::query("INSERT INTO audit_channels(entry_id, channel_id, private) VALUES($1, $2, $3)")
            .bind(entry)
            .bind(channel)
            .bind(i64::from(private))
            .execute(&mut *conn)
            .await?;
    }
    Ok(entry)
}

/// Replaces the details of entry `id` (written by `record_id` for the same place) with those of
/// `entry`, for an action that is logged as it goes. The actor only ever turns into Staff, so a
/// name `forget_user` removed never comes back.
pub(crate) async fn rewrite(conn: &mut AnyConnection, id: i64, entry: Entry) -> sqlx::Result<()> {
    let staff = i64::from(matches!(entry.actor, Actor::Staff));
    sqlx::query("UPDATE audit_log SET details = $1, staff = CASE WHEN $2 = 1 THEN 1 ELSE staff END, actor = CASE WHEN $2 = 1 THEN NULL ELSE actor END WHERE id = $3")
        .bind(Details::encode(entry.details.map))
        .bind(staff)
        .bind(id)
        .execute(&mut *conn)
        .await?;
    Ok(())
}

/// Replaces every mention of a deleted account with the "Deleted user" marker (no actor that
/// isn't staff, no target name, no rule subject name), so a new account with the same username
/// never inherits the history.
pub(crate) async fn forget_user(conn: &mut AnyConnection, username: &str) -> sqlx::Result<()> {
    sqlx::query("UPDATE audit_log SET actor = NULL WHERE actor = $1")
        .bind(username)
        .execute(&mut *conn)
        .await?;
    sqlx::query("UPDATE audit_log SET target_name = NULL WHERE target_kind IN ('user', 'message') AND target_name = $1")
        .bind(username)
        .execute(&mut *conn)
        .await?;
    let rows = sqlx::query("SELECT id, details FROM audit_log WHERE action IN ('channel.perm_set', 'channel.perm_clear') AND details LIKE $1 ESCAPE '\\'")
        .bind(like_escape(username))
        .fetch_all(&mut *conn)
        .await?;
    for r in &rows {
        let (id, text): (i64, String) = (r.try_get(0)?, r.try_get(1)?);
        let Ok(Value::Object(mut map)) = serde_json::from_str::<Value>(&text) else {
            continue;
        };
        let named = map.get("subject").is_some_and(|s| {
            s.get("kind").and_then(Value::as_str) == Some("user")
                && s.get("name").and_then(Value::as_str) == Some(username)
        });
        if named {
            map.insert(
                "subject".to_string(),
                json!({ "kind": "user", "deleted": true }),
            );
            sqlx::query("UPDATE audit_log SET details = $1 WHERE id = $2")
                .bind(Value::Object(map).to_string())
                .bind(id)
                .execute(&mut *conn)
                .await?;
        }
    }
    let rows = sqlx::query("SELECT id, details FROM audit_log WHERE action = 'message.bulk_delete' AND details LIKE $1 ESCAPE '\\'")
        .bind(like_escape(username))
        .fetch_all(&mut *conn)
        .await?;
    for r in &rows {
        let (id, text): (i64, String) = (r.try_get(0)?, r.try_get(1)?);
        let Ok(Value::Object(mut map)) = serde_json::from_str::<Value>(&text) else {
            continue;
        };
        let Some(Value::Array(authors)) = map.get("authors") else {
            continue;
        };
        let mut changed = false;
        let authors: Vec<Value> = authors
            .iter()
            .map(|a| match a.get("name").and_then(Value::as_str) {
                Some(n) if n == username => {
                    changed = true;
                    json!({ "deleted": true, "count": a.get("count").cloned().unwrap_or(Value::Null) })
                }
                _ => a.clone(),
            })
            .collect();
        if changed {
            map.insert("authors".to_string(), Value::Array(authors));
            sqlx::query("UPDATE audit_log SET details = $1 WHERE id = $2")
                .bind(Value::Object(map).to_string())
                .bind(id)
                .execute(&mut *conn)
                .await?;
        }
    }
    Ok(())
}

/// Deletes the log of a server that is being purged, in batches.
pub(crate) async fn purge_server(db: &Db, server: &str) -> sqlx::Result<u64> {
    let mut total = 0;
    loop {
        let n = sqlx::query("DELETE FROM audit_log WHERE id IN (SELECT id FROM audit_log WHERE server = $1 LIMIT $2)")
            .bind(server)
            .bind(PURGE_BATCH)
            .execute(db)
            .await?
            .rows_affected();
        total += n;
        if n < PURGE_BATCH as u64 {
            return Ok(total);
        }
        tokio::task::yield_now().await;
    }
}

/// What an entry was done to.
#[derive(Clone, Serialize, Deserialize, ToSchema)]
pub struct AuditTarget {
    /// `user`, `role`, `channel`, `category`, `message`, `password` or `server`.
    #[schema(example = "user")]
    pub kind: String,
    /// Id of the role, channel, category, message or password; `null` for users and the server.
    pub id: Option<i64>,
    /// Name at the time: the username for users, the author's username for messages, the
    /// label for passwords (`null` without one), the display name for the server. `null` when
    /// hidden.
    pub name: Option<String>,
    /// The user, for `user` targets and message authors.
    pub user: Option<UserRef>,
    /// The user or message author is instance staff; `name` and `user` are left out.
    pub staff: bool,
    /// The user or message author deleted their account; `name` and `user` are left out.
    pub deleted: bool,
}

/// An audit log entry.
#[derive(Clone, Serialize, Deserialize, ToSchema)]
pub struct AuditEntry {
    /// Entry id.
    pub id: i64,
    /// Dotted action name; the part before the dot is its group. `member`: `kick`, `ban`,
    /// `unban`, `admin_grant`, `admin_revoke`, `admin_transfer`, `admin_perms`. `role`: `create`,
    /// `update`, `delete`, `assign`, `unassign`. `channel`: `create`, `update` (name, topic, slow
    /// mode, restrictions), `delete`, `perm_set`, `perm_clear`, `reorder`, `category_create`,
    /// `category_update`, `category_delete`. `server`: `update` (name and colors),
    /// `system_messages`. `access`: `mode` (password protection and the permanent password, never
    /// the password itself), `password_create`, `password_revoke`. `message`: `delete` and
    /// `attachment_remove` (of other people's messages), `pin`, `unpin`, `poll_close` and
    /// `poll_reopen` (of other people's polls). Clients should show
    /// unknown actions generically; new ones may be added.
    #[schema(example = "member.ban")]
    pub action: String,
    /// Who did it; `null` when `staff` is true, or when the account was deleted since.
    pub actor: Option<UserRef>,
    /// Done by the instance staff. Staff are never named.
    pub staff: bool,
    /// What it was done to; `null` for server-wide actions such as reordering channels.
    pub target: Option<AuditTarget>,
    /// Small JSON object with what changed: `changes` (a list of `field`, `before`, `after`),
    /// `channel` (`id`, `name`, `private`) for actions in a channel, `subject` for channel rules
    /// (`kind` with `name`, or `staff: true` or `deleted: true` instead of a user's name), and
    /// other facts. Empty when
    /// `hidden`.
    #[schema(value_type = Object)]
    pub details: Value,
    /// The entry concerns a channel you can't see; its names and details are left out.
    pub hidden: bool,
    /// When it happened, Unix seconds.
    pub created_at: i64,
}

#[derive(Deserialize, IntoParams, Default)]
pub struct AuditQuery {
    /// An action group (`member`, `role`, `channel`, `server`, `access`, `message`) or one
    /// action name such as `member.ban`.
    action: Option<String>,
    /// Only entries by this username, case-insensitive.
    actor: Option<String>,
    /// Only entries whose target name contains this text, case-insensitive (at most 100
    /// characters). Hidden entries never match, and page sizes and cursors don't count them.
    target: Option<String>,
    /// Only entries at or after this time, Unix seconds.
    from: Option<i64>,
    /// Only entries at or before this time, Unix seconds.
    to: Option<i64>,
    /// Opaque cursor from the previous page's `X-Next-Cursor` header.
    cursor: Option<String>,
    /// Page size, default and max 50.
    limit: Option<i64>,
}

enum Bind {
    Int(i64),
    Text(String),
}

fn like_escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 2);
    out.push('%');
    for c in text.chars() {
        if matches!(c, '%' | '_' | '\\') {
            out.push('\\');
        }
        out.push(c);
    }
    out.push('%');
    out
}

fn filters(q: &AuditQuery) -> Result<(String, Vec<Bind>), ApiError> {
    let mut sql = String::new();
    let mut binds = Vec::new();
    let mut add = |clause: &str, value: Bind, binds: &mut Vec<Bind>| {
        binds.push(value);
        sql.push_str(&clause.replace("{}", &format!("${}", binds.len() + 1)));
    };
    if let Some(action) = q.action.as_deref().map(str::trim).filter(|a| !a.is_empty()) {
        let action = action.to_lowercase();
        match (GROUPS.contains(&action.as_str()), Action::parse(&action)) {
            (true, _) => add(
                " AND action LIKE {}",
                Bind::Text(format!("{action}.%")),
                &mut binds,
            ),
            (false, Some(a)) => add(
                " AND action = {}",
                Bind::Text(a.as_str().to_string()),
                &mut binds,
            ),
            (false, None) => return Err(bad("Unknown action")),
        }
    }
    if let Some(actor) = q.actor.as_deref().map(str::trim).filter(|a| !a.is_empty()) {
        add(
            " AND actor = {}",
            Bind::Text(actor.to_lowercase()),
            &mut binds,
        );
    }
    if let Some(target) = q.target.as_deref().map(str::trim).filter(|t| !t.is_empty()) {
        if target.chars().count() > TARGET_QUERY_MAX {
            return Err(bad("Target search is too long"));
        }
        add(
            " AND lower(target_name) LIKE lower({}) ESCAPE '\\'",
            Bind::Text(like_escape(target)),
            &mut binds,
        );
    }
    if let Some(from) = q.from {
        add(" AND created_at >= {}", Bind::Int(from), &mut binds);
    }
    if let Some(to) = q.to {
        add(" AND created_at <= {}", Bind::Int(to), &mut binds);
    }
    if let Some(raw) = q.cursor.as_deref().filter(|c| !c.trim().is_empty()) {
        let parts = decode_cursor(raw, 2)?;
        let (at, id) = (cursor_int(&parts[0])?, cursor_int(&parts[1])?);
        binds.push(Bind::Int(at));
        binds.push(Bind::Int(id));
        sql.push_str(&format!(
            " AND (created_at, id) < (${}, ${})",
            binds.len(),
            binds.len() + 1
        ));
    }
    Ok((sql, binds))
}

struct Raw {
    id: i64,
    actor: Option<String>,
    staff: bool,
    action: String,
    target_kind: Option<String>,
    target_id: Option<i64>,
    target_name: Option<String>,
    target_staff: bool,
    details: Value,
    created_at: i64,
    hidden: bool,
}

/// List the audit log
///
/// Returns what members with moderation and management permissions did in the server, newest
/// first, as pages of `limit` (default and max 50). Page with `cursor` from the
/// `X-Next-Cursor` response header. Filter by action group or action, actor, target name and
/// time range. Entries are kept for 90 days. Actions by the instance staff show `staff: true`
/// and no actor. Entries about channels you can't see come with `hidden: true` and without
/// their names and details. Requires being a member with the View audit log permission. General
/// rate-limit bucket.
#[utoipa::path(
    get,
    path = "/api/v1/servers/{name}/audit",
    tag = "Moderation",
    params(("name" = String, Path, description = "Server name, case-insensitive"), AuditQuery),
    responses(
        (status = 200, description = "A page of entries, newest first", body = Vec<AuditEntry>, headers(("x-next-cursor" = String, description = "Cursor for the next page; absent on the last page"))),
        (status = 400, description = "Unknown action, a target search over 100 characters or an invalid cursor (JSON), or a non-integer `from`, `to` or `limit` (plain-text framework error)", body = ApiErrorBody),
        (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody),
        (status = 403, description = "Missing the View audit log permission, or banned from the server", body = ApiErrorBody),
        (status = 404, description = "`Server not found or wrong password`: no such server, one you are not a member of, or a password-protected one you have no access to (identical responses)", body = ApiErrorBody),
        (status = 429, description = "Too many requests in the general bucket", content_type = "text/plain", body = String)
    ),
    security(("bearer" = []))
)]
pub(crate) async fn list_audit(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path(name): Path<String>,
    Query(q): Query<AuditQuery>,
) -> Result<Paged<AuditEntry>, ApiError> {
    let db = &state.read();
    let access = resolve_server(db, &name, Some(&user), &Proof::none()).await?;
    if !access.is_member() && !access.site_admin() {
        return Err(denied());
    }
    access.require_perm(db, Perm::ViewAuditLog).await?;
    let limit = q.limit.unwrap_or(PAGE_MAX).clamp(1, PAGE_MAX);
    let (clauses, mut binds) = filters(&q)?;
    let hidden = match access.manages_channels(db).await? {
        true => "0".to_string(),
        false => {
            let closed: Vec<i64> = access
                .channel_rights(db)
                .await?
                .into_iter()
                .filter(|(_, r)| !r.view)
                .map(|(id, _)| id)
                .collect();
            let closed_sql = match closed.is_empty() {
                true => String::new(),
                false => format!(
                    "ac.channel_id IN ({}) OR ",
                    placeholders(binds.len() + 2, closed.len())
                ),
            };
            binds.extend(closed.into_iter().map(Bind::Int));
            format!(
                "CASE WHEN EXISTS(SELECT 1 FROM audit_channels ac WHERE ac.entry_id = audit_log.id AND ({closed_sql}(ac.private <> 0 AND NOT EXISTS(SELECT 1 FROM channels c WHERE c.id = ac.channel_id AND c.server = $1)))) THEN 1 ELSE 0 END"
            )
        }
    };
    let searched = q.target.as_deref().is_some_and(|t| !t.trim().is_empty());
    let only_visible = match searched {
        true => format!(" AND {hidden} = 0"),
        false => String::new(),
    };
    let sql = format!(
        "SELECT id, actor, staff, action, target_kind, target_id, target_name, target_staff, details, created_at, {hidden} FROM audit_log WHERE server = $1{clauses}{only_visible} ORDER BY created_at DESC, id DESC LIMIT {}",
        limit + 1
    );
    let mut query = sqlx::query(sqlx::AssertSqlSafe(sql)).bind(access.name());
    for b in binds {
        query = match b {
            Bind::Int(v) => query.bind(v),
            Bind::Text(v) => query.bind(v),
        };
    }
    let rows = query.fetch_all(db).await?;
    let mut raw = Vec::with_capacity(rows.len());
    for r in &rows {
        raw.push(Raw {
            id: r.try_get(0)?,
            actor: r.try_get(1)?,
            staff: r.try_get::<i64, _>(2)? != 0,
            action: r.try_get(3)?,
            target_kind: r.try_get(4)?,
            target_id: r.try_get(5)?,
            target_name: r.try_get(6)?,
            target_staff: r.try_get::<i64, _>(7)? != 0,
            details: serde_json::from_str(&r.try_get::<String, _>(8)?)
                .unwrap_or_else(|_| json!({})),
            created_at: r.try_get(9)?,
            hidden: r.try_get::<i64, _>(10)? != 0,
        });
    }
    let more = raw.len() as i64 > limit;
    raw.truncate(limit as usize);
    let next = match (more, raw.last()) {
        (true, Some(last)) => Some(encode_cursor(&[
            &last.created_at.to_string(),
            &last.id.to_string(),
        ])),
        _ => None,
    };
    let mut names = Vec::new();
    for e in &raw {
        names.extend(e.actor.clone());
        if matches!(e.target_kind.as_deref(), Some("user") | Some("message")) {
            names.extend(e.target_name.clone());
        }
    }
    let refs = user_refs(db, &names).await;
    let mut out = Vec::with_capacity(raw.len());
    for e in raw {
        let Raw {
            id,
            actor,
            staff,
            action,
            target_kind,
            target_id,
            target_name,
            target_staff,
            details,
            created_at,
            hidden,
        } = e;
        let target = target_kind.map(|kind| {
            let person = matches!(kind.as_str(), "user" | "message");
            let name = match hidden {
                true => None,
                false => target_name,
            };
            AuditTarget {
                user: match person {
                    true => name.as_deref().map(|n| user_from(&refs, n)),
                    false => None,
                },
                deleted: person && !hidden && !target_staff && name.is_none(),
                staff: target_staff && !hidden,
                kind,
                id: target_id,
                name,
            }
        });
        out.push(AuditEntry {
            id,
            action,
            actor: actor.as_deref().map(|a| user_from(&refs, a)),
            staff,
            target,
            details: match hidden {
                true => json!({}),
                false => details,
            },
            hidden,
            created_at,
        });
    }
    Ok(Paged(out, next))
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use axum::Json;
    use axum::http::StatusCode;
    use serde::de::DeserializeOwned;

    use super::*;
    use crate::api::categories::{
        create_category, delete_category, layout_version, rename_category, reorder_layout,
    };
    use crate::api::passwords::{create_password, revoke_password};
    use crate::api::pins::{pin_message, unpin_message};
    use crate::api::servers::{
        assign_role, ban_member, clear_channel_perm, create_channel, create_role, delete_channel,
        delete_role, grant_admin, kick_member, set_admin_perms, set_channel_perm, unassign_role,
        unban_member, update_channel, update_role, update_server,
    };
    use crate::api::system_messages::update_system_messages;
    use crate::api::test_util::{add_member, done, mem_user, temp_state};

    fn req<T: DeserializeOwned>(v: Value) -> T {
        serde_json::from_value(v).expect("request body")
    }

    fn who(name: &str) -> Authed {
        Authed(mem_user(name, name == "root"))
    }

    fn named(s: &str) -> Path<String> {
        Path(s.to_string())
    }

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

    /// `club` with admin alice and members bob, carol and dave, channels general and second.
    async fn club(tag: &str) -> (AppState, PathBuf, i64) {
        let (state, path) = temp_state(tag).await;
        let db = &state.db;
        for name in ["alice", "bob", "carol", "dave", "root", "erin"] {
            crate::db::NewUser::plain(name).add(db).await;
        }
        exec(
            db,
            "UPDATE users SET is_site_admin = 1 WHERE username = 'root'",
        )
        .await;
        exec(db, "INSERT INTO servers(name, display_name, creator, created_at) VALUES('club', 'Club', 'alice', 0)").await;
        let general = id_of(db, "INSERT INTO channels(server, name, created_at) VALUES('club', 'general', 0) RETURNING id").await;
        exec(db, "INSERT INTO channels(server, name, created_at, position) VALUES('club', 'second', 0, 1)").await;
        add_member(db, "club", "alice", 1, 0, 0).await;
        for name in ["bob", "carol", "dave"] {
            add_member(db, "club", name, 0, 0, 0).await;
        }
        (state, path, general)
    }

    async fn page_of(
        state: &AppState,
        server: &str,
        viewer: &str,
        q: Value,
    ) -> Result<(Vec<AuditEntry>, Option<String>), ApiError> {
        let Paged(items, next) = list_audit(
            State(state.clone()),
            who(viewer),
            named(server),
            Query(req(q)),
        )
        .await?;
        Ok((items, next))
    }

    async fn page(
        state: &AppState,
        viewer: &str,
        q: Value,
    ) -> Result<(Vec<AuditEntry>, Option<String>), ApiError> {
        page_of(state, "club", viewer, q).await
    }

    async fn actions(state: &AppState) -> Vec<String> {
        let mut out: Vec<String> = sqlx::query("SELECT action FROM audit_log ORDER BY id")
            .fetch_all(&state.db)
            .await
            .expect("log")
            .iter()
            .map(|r| r.try_get(0).expect("action"))
            .collect();
        out.dedup();
        out
    }

    async fn last(state: &AppState) -> AuditEntry {
        let server: String = sqlx::query("SELECT server FROM audit_log ORDER BY id DESC LIMIT 1")
            .fetch_one(&state.db)
            .await
            .expect("an entry")
            .try_get(0)
            .expect("server");
        page_of(state, &server, "alice", json!({ "limit": 1 }))
            .await
            .expect("log")
            .0
            .remove(0)
    }

    fn changes(entry: &AuditEntry) -> Vec<(String, Value, Value)> {
        entry.details["changes"]
            .as_array()
            .map(|list| {
                list.iter()
                    .map(|c| {
                        (
                            c["field"].as_str().unwrap_or_default().to_string(),
                            c["before"].clone(),
                            c["after"].clone(),
                        )
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    fn status<T>(res: Result<T, ApiError>) -> Option<StatusCode> {
        res.err().map(|e| e.0)
    }

    async fn message(db: &Db, channel: i64, author: &str) -> i64 {
        sqlx::query("INSERT INTO messages(channel_id, author, content, created_at) VALUES($1, $2, 'hi', $3) RETURNING id")
            .bind(channel)
            .bind(author)
            .bind(now())
            .fetch_one(db)
            .await
            .expect("message")
            .try_get(0)
            .expect("id")
    }

    #[tokio::test]
    async fn member_actions_are_logged() {
        let (state, path, _) = club("audit_members").await;
        let s = || State(state.clone());
        let _ = kick_member(
            s(),
            who("alice"),
            named("club"),
            Json(req(json!({ "username": "bob" }))),
        )
        .await
        .expect("kick");
        let kick = last(&state).await;
        assert_eq!(kick.action, "member.kick");
        assert_eq!(
            kick.actor.as_ref().map(|a| a.username.as_str()),
            Some("alice")
        );
        let target = kick.target.expect("target");
        assert_eq!(
            (target.kind.as_str(), target.name.as_deref()),
            ("user", Some("bob"))
        );
        assert_eq!(target.user.map(|u| u.display_name), Some("bob".to_string()));
        let _ = ban_member(
            s(),
            who("alice"),
            named("club"),
            Json(req(json!({ "username": "carol" }))),
        )
        .await
        .expect("ban");
        assert_eq!(last(&state).await.details["was_member"], json!(true));
        let _ = ban_member(
            s(),
            who("alice"),
            named("club"),
            Json(req(json!({ "username": "carol" }))),
        )
        .await
        .expect("ban again changes nothing");
        let _ = unban_member(
            s(),
            who("alice"),
            Path(("club".to_string(), "Carol".to_string())),
        )
        .await
        .expect("unban");
        let _ = grant_admin(
            s(),
            who("alice"),
            named("club"),
            Json(req(json!({ "username": "dave" }))),
        )
        .await
        .expect("grant");
        let _ = set_admin_perms(
            s(),
            who("alice"),
            Path(("club".to_string(), "dave".to_string())),
            Json(req(json!({
                "perms": Perm::Kick as i64,
                "mask": crate::api::access::perms::ALL_PERMS
            }))),
        )
        .await
        .expect("perms");
        assert_eq!(
            changes(&last(&state).await),
            vec![(
                "perms".to_string(),
                json!(crate::api::access::perms::ALL_PERMS),
                json!(Perm::Kick as i64)
            )]
        );
        assert_eq!(
            actions(&state).await,
            [
                "member.kick",
                "member.ban",
                "member.unban",
                "member.admin_grant",
                "member.admin_perms"
            ]
        );
        assert_eq!(
            status(
                kick_member(
                    s(),
                    who("alice"),
                    named("club"),
                    Json(req(json!({ "username": "erin" })))
                )
                .await
            ),
            Some(StatusCode::NOT_FOUND)
        );
        assert_eq!(actions(&state).await.len(), 5, "a failed kick logs nothing");
        done(state, path).await;
    }

    #[tokio::test]
    async fn role_actions_are_logged() {
        let (state, path, _) = club("audit_roles").await;
        let s = || State(state.clone());
        let Json(role) = create_role(
            s(),
            who("alice"),
            named("club"),
            Json(req(
                json!({ "name": "mods", "color": "#ff0000", "perms": 6 }),
            )),
        )
        .await
        .expect("create");
        let rp = || Path(("club".to_string(), role.id));
        let _ = update_role(
            s(),
            who("alice"),
            rp(),
            Json(req(json!({ "name": "helpers", "color": "#ff0000" }))),
        )
        .await
        .expect("rename");
        let renamed = last(&state).await;
        assert_eq!(
            changes(&renamed),
            vec![("name".to_string(), json!("mods"), json!("helpers"))]
        );
        assert_eq!(
            renamed.target.and_then(|t| t.name).as_deref(),
            Some("helpers")
        );
        let _ = update_role(
            s(),
            who("alice"),
            rp(),
            Json(req(json!({ "color": "#ff0000" }))),
        )
        .await
        .expect("same color");
        let _ = assign_role(
            s(),
            who("alice"),
            rp(),
            Json(req(json!({ "username": "bob" }))),
        )
        .await
        .expect("assign");
        assert_eq!(
            last(&state).await.details["role"],
            json!({ "id": role.id, "name": "helpers" })
        );
        let _ = assign_role(
            s(),
            who("alice"),
            rp(),
            Json(req(json!({ "username": "bob" }))),
        )
        .await
        .expect("assign again");
        let _ = unassign_role(
            s(),
            who("alice"),
            Path(("club".to_string(), role.id, "bob".to_string())),
        )
        .await
        .expect("unassign");
        let _ = delete_role(s(), who("alice"), rp()).await.expect("delete");
        assert_eq!(
            actions(&state).await,
            [
                "role.create",
                "role.update",
                "role.assign",
                "role.unassign",
                "role.delete"
            ]
        );
        assert_eq!(
            sqlx::query("SELECT COUNT(*) FROM audit_log")
                .fetch_one(&state.db)
                .await
                .expect("count")
                .try_get::<i64, _>(0)
                .expect("n"),
            5,
            "no-op updates and repeated assigns log nothing"
        );
        done(state, path).await;
    }

    #[tokio::test]
    async fn channel_actions_are_logged() {
        let (state, path, general) = club("audit_channels").await;
        let s = || State(state.clone());
        let Json(made) = create_channel(
            s(),
            who("alice"),
            named("club"),
            Json(req(json!({ "name": "news" }))),
        )
        .await
        .expect("create");
        let _ = update_channel(
            s(),
            who("alice"),
            Path(general),
            Json(req(json!({ "slowmode_seconds": 30, "topic": "Be nice" }))),
        )
        .await
        .expect("update");
        let updated = last(&state).await;
        assert_eq!(updated.action, "channel.update");
        assert_eq!(
            changes(&updated),
            vec![
                ("topic".to_string(), Value::Null, json!("Be nice")),
                ("slowmode_seconds".to_string(), json!(0), json!(30)),
            ]
        );
        assert_eq!(updated.details["channel"]["name"], json!("general"));
        let _ = update_channel(
            s(),
            who("alice"),
            Path(general),
            Json(req(json!({ "slowmode_seconds": 30 }))),
        )
        .await
        .expect("same slow mode");
        let _ = set_channel_perm(
            s(),
            who("alice"),
            Path(made.id),
            Json(req(json!({ "subject": "u:bob", "can_view": true, "can_send": false, "can_read_history": true }))),
        )
        .await
        .expect("rule");
        let rule = last(&state).await;
        assert_eq!(
            rule.details["subject"],
            json!({ "kind": "user", "name": "bob" })
        );
        assert!(changes(&rule).contains(&("can_send".to_string(), Value::Null, json!(false))));
        let _ = clear_channel_perm(s(), who("alice"), Path((made.id, "U:bob".to_string())))
            .await
            .expect("clear");
        let Json(category) = create_category(
            s(),
            who("alice"),
            named("club"),
            Json(req(json!({ "name": "Games" }))),
        )
        .await
        .expect("category");
        let _ = rename_category(
            s(),
            who("alice"),
            Path(category.id),
            Json(req(json!({ "name": "Play" }))),
        )
        .await
        .expect("rename category");
        let version = layout_version(&state.db, "club").await.expect("version");
        let second = id_of(&state.db, "SELECT id FROM channels WHERE name = 'second'").await;
        let _ = reorder_layout(
            s(),
            who("alice"),
            named("club"),
            Json(req(json!({ "version": version, "uncategorized": [made.id, general], "categories": [{ "id": category.id, "channels": [second] }] }))),
        )
        .await
        .expect("reorder");
        let _ = delete_category(s(), who("alice"), Path(category.id))
            .await
            .expect("delete category");
        assert!(
            last(&state).await.details.get("channels").is_none(),
            "no count of channels some viewers can't see"
        );
        let _ = delete_channel(s(), who("alice"), Path(made.id))
            .await
            .expect("delete");
        assert_eq!(
            last(&state).await.target.and_then(|t| t.name).as_deref(),
            Some("news")
        );
        assert_eq!(
            actions(&state).await,
            [
                "channel.create",
                "channel.update",
                "channel.perm_set",
                "channel.perm_clear",
                "channel.category_create",
                "channel.category_update",
                "channel.reorder",
                "channel.category_delete",
                "channel.delete"
            ]
        );
        done(state, path).await;
    }

    #[tokio::test]
    async fn server_and_access_actions_are_logged_without_secrets() {
        let (state, path, general) = club("audit_server").await;
        let s = || State(state.clone());
        let _ = update_server(
            s(),
            who("alice"),
            named("club"),
            Json(req(
                json!({ "name": "Club House", "banner_color": "#112233" }),
            )),
        )
        .await
        .expect("rename");
        let renamed = last(&state).await;
        assert_eq!(renamed.action, "server.update");
        assert_eq!(
            changes(&renamed),
            vec![
                ("name".to_string(), json!("Club"), json!("Club House")),
                ("banner_color".to_string(), Value::Null, json!("#112233")),
            ]
        );
        let p = || named("club house");
        let _ = update_server(
            s(),
            who("alice"),
            p(),
            Json(req(json!({ "password": "hunter2-secret" }))),
        )
        .await
        .expect("protect");
        let mode = page_of(&state, "club house", "alice", json!({ "action": "access" }))
            .await
            .expect("log")
            .0;
        assert_eq!(mode.len(), 1);
        assert_eq!(mode[0].details["permanent_password"], json!("set"));
        assert_eq!(
            page_of(&state, "club house", "alice", json!({}))
                .await
                .expect("renamed server keeps its log")
                .0
                .len(),
            2
        );
        let Json(created) = create_password(
            s(),
            who("alice"),
            p(),
            Json(req(
                json!({ "label": "Friends", "password": "tickets-please", "max_uses": 3 }),
            )),
        )
        .await
        .expect("extra password");
        let _ = revoke_password(
            s(),
            who("alice"),
            Path(("club house".to_string(), created.info.id)),
        )
        .await
        .expect("revoke");
        let _ = update_system_messages(
            s(),
            who("alice"),
            p(),
            Json(req(
                json!({ "channel_id": general, "join_messages": false }),
            )),
        )
        .await
        .expect("system messages");
        let dump: Vec<String> = sqlx::query(
            "SELECT action, details, COALESCE(target_name, '') FROM audit_log ORDER BY id",
        )
        .fetch_all(&state.db)
        .await
        .expect("rows")
        .iter()
        .map(|r| {
            format!(
                "{} {} {}",
                r.try_get::<String, _>(0).expect("a"),
                r.try_get::<String, _>(1).expect("d"),
                r.try_get::<String, _>(2).expect("t")
            )
        })
        .collect();
        assert_eq!(dump.len(), 5);
        for row in &dump {
            assert!(
                !row.contains("hunter2") && !row.contains("tickets-please"),
                "{row}"
            );
        }
        assert!(dump[2].starts_with("access.password_create") && dump[2].ends_with("Friends"));
        assert!(dump[3].starts_with("access.password_revoke"));
        assert!(dump[4].starts_with("server.system_messages"));
        assert!(dump[4].contains("\"join_messages\""));
        done(state, path).await;
    }

    #[tokio::test]
    async fn message_moderation_is_logged_but_own_deletes_are_not() {
        let (state, path, general) = club("audit_messages").await;
        let s = || State(state.clone());
        let own = message(&state.db, general, "alice").await;
        let theirs = message(&state.db, general, "bob").await;
        let pinned = message(&state.db, general, "bob").await;
        let _ = crate::api::messages::delete_message(s(), Path(own), who("alice"))
            .await
            .expect("own delete");
        assert!(actions(&state).await.is_empty());
        let _ = pin_message(s(), Path(pinned), who("alice"))
            .await
            .expect("pin");
        let _ = unpin_message(s(), Path(pinned), who("alice"))
            .await
            .expect("unpin");
        let _ = unpin_message(s(), Path(pinned), who("alice"))
            .await
            .expect("unpin again");
        let _ = crate::api::messages::delete_message(s(), Path(theirs), who("alice"))
            .await
            .expect("delete bob's");
        let deleted = last(&state).await;
        assert_eq!(deleted.action, "message.delete");
        let target = deleted.target.expect("target");
        assert_eq!(
            (target.kind.as_str(), target.id, target.name.as_deref()),
            ("message", Some(theirs), Some("bob"))
        );
        assert_eq!(deleted.details["channel"]["name"], json!("general"));
        assert_eq!(
            actions(&state).await,
            ["message.pin", "message.unpin", "message.delete"]
        );
        done(state, path).await;
    }

    #[tokio::test]
    async fn a_failed_write_rolls_the_action_back_and_a_rolled_back_action_logs_nothing() {
        let (state, path, _) = club("audit_rollback").await;
        let mut tx = state.db.begin().await.expect("tx");
        sqlx::query("DELETE FROM members WHERE server = 'club' AND username = 'bob'")
            .execute(&mut *tx)
            .await
            .expect("delete");
        record(
            &mut tx,
            Entry::new(
                "club",
                &Actor::User("alice".to_string()),
                Action::MemberKick,
            )
            .target(Target::user("bob")),
        )
        .await
        .expect("record");
        tx.rollback().await.expect("rollback");
        assert!(actions(&state).await.is_empty());
        exec(
            &state.db,
            "CREATE TRIGGER audit_fails BEFORE INSERT ON audit_log BEGIN SELECT RAISE(ABORT, 'audit write failed'); END",
        )
        .await;
        let res = kick_member(
            State(state.clone()),
            who("alice"),
            named("club"),
            Json(req(json!({ "username": "bob" }))),
        )
        .await;
        assert_eq!(status(res), Some(StatusCode::INTERNAL_SERVER_ERROR));
        assert_eq!(
            id_of(
                &state.db,
                "SELECT COUNT(*) FROM members WHERE server = 'club' AND username = 'bob'"
            )
            .await,
            1,
            "the kick was undone"
        );
        let res = update_channel(
            State(state.clone()),
            who("alice"),
            Path(
                id_of(
                    &state.db,
                    "SELECT id FROM channels WHERE server = 'club' AND name = 'general'",
                )
                .await,
            ),
            Json(req(json!({ "topic": "x", "slowmode_seconds": 5 }))),
        )
        .await;
        assert_eq!(status(res), Some(StatusCode::INTERNAL_SERVER_ERROR));
        assert_eq!(
            id_of(
                &state.db,
                "SELECT COUNT(*) FROM channels WHERE server = 'club' AND name = 'general' AND topic IS NULL AND slowmode_seconds = 0"
            )
            .await,
            1
        );
        exec(&state.db, "DROP TRIGGER audit_fails").await;
        done(state, path).await;
    }

    #[tokio::test]
    async fn viewing_needs_the_permission_and_membership() {
        let (state, path, _) = club("audit_perm").await;
        let _ = kick_member(
            State(state.clone()),
            who("alice"),
            named("club"),
            Json(req(json!({ "username": "dave" }))),
        )
        .await
        .expect("kick");
        assert_eq!(
            status(page(&state, "bob", json!({})).await),
            Some(StatusCode::FORBIDDEN)
        );
        assert_eq!(
            status(page(&state, "erin", json!({})).await),
            Some(StatusCode::NOT_FOUND),
            "non-members get the uniform 404"
        );
        assert_eq!(
            status(page(&state, "dave", json!({})).await),
            Some(StatusCode::NOT_FOUND)
        );
        let role = id_of(&state.db, "INSERT INTO roles(server, name, color, perms) VALUES('club', 'auditors', '#ffffff', 64) RETURNING id").await;
        exec(
            &state.db,
            &format!(
                "INSERT INTO user_roles(server, username, role_id) VALUES('club', 'bob', {role})"
            ),
        )
        .await;
        assert_eq!(
            page(&state, "bob", json!({})).await.expect("bob").0.len(),
            1
        );
        exec(
            &state.db,
            "UPDATE members SET perms = 4 WHERE username = 'alice'",
        )
        .await;
        assert_eq!(
            status(page(&state, "alice", json!({})).await),
            Some(StatusCode::FORBIDDEN),
            "an admin without the bit can't"
        );
        assert_eq!(
            page(&state, "root", json!({}))
                .await
                .expect("staff")
                .0
                .len(),
            1
        );
        done(state, path).await;
    }

    #[tokio::test]
    async fn site_admins_are_logged_as_unnamed_staff() {
        let (state, path, general) = club("audit_staff").await;
        let _ = kick_member(
            State(state.clone()),
            who("root"),
            named("club"),
            Json(req(json!({ "username": "bob" }))),
        )
        .await
        .expect("staff kick");
        let theirs = message(&state.db, general, "carol").await;
        let _ = crate::api::admin::delete_message(State(state.clone()), who("root"), Path(theirs))
            .await
            .expect("staff delete");
        add_member(&state.db, "club", "root", 1, 0, 0).await;
        let _ = kick_member(
            State(state.clone()),
            who("root"),
            named("club"),
            Json(req(json!({ "username": "dave" }))),
        )
        .await
        .expect("member kick");
        let (entries, _) = page(&state, "alice", json!({})).await.expect("log");
        let summary: Vec<(String, bool, Option<String>)> = entries
            .iter()
            .map(|e| {
                (
                    e.action.clone(),
                    e.staff,
                    e.actor.as_ref().map(|a| a.username.clone()),
                )
            })
            .collect();
        assert_eq!(
            summary,
            vec![
                ("member.kick".to_string(), false, Some("root".to_string())),
                ("message.delete".to_string(), true, None),
                ("member.kick".to_string(), true, None),
            ],
            "a site admin acting as a member with the permission is just a member"
        );
        let json = serde_json::to_string(&entries[1..]).expect("json");
        assert!(!json.contains("root"), "{json}");
        let stored = id_of(
            &state.db,
            "SELECT COUNT(*) FROM audit_log WHERE staff = 1 AND actor IS NULL",
        )
        .await;
        assert_eq!(stored, 2);
        done(state, path).await;
    }

    #[tokio::test]
    async fn filters_and_pages() {
        let (state, path, general) = club("audit_filters").await;
        let db = &state.db;
        let mut conn = db.acquire().await.expect("conn");
        let alice = Actor::User("alice".to_string());
        let bob = Actor::User("bob".to_string());
        for i in 0..60i64 {
            let (actor, action) = match i % 3 {
                0 => (&alice, Action::MemberKick),
                1 => (&bob, Action::RoleCreate),
                _ => (&alice, Action::ChannelUpdate),
            };
            record(
                &mut conn,
                Entry::new("club", actor, action).target(Target::user(&format!("user{i}"))),
            )
            .await
            .expect("record");
            sqlx::query(
                "UPDATE audit_log SET created_at = $1 WHERE id = (SELECT MAX(id) FROM audit_log)",
            )
            .bind(1000 + i)
            .execute(&mut *conn)
            .await
            .expect("time");
        }
        drop(conn);
        let (first, next) = page(&state, "alice", json!({})).await.expect("page 1");
        assert_eq!(first.len(), PAGE_MAX as usize);
        assert_eq!(first[0].created_at, 1059);
        let (rest, end) = page(&state, "alice", json!({ "cursor": next }))
            .await
            .expect("page 2");
        assert_eq!(rest.len(), 10);
        assert!(end.is_none());
        assert_eq!(rest.last().map(|e| e.created_at), Some(1000));
        let only = |q: Value| {
            let state = state.clone();
            async move {
                page(&state, "alice", q)
                    .await
                    .expect("filtered")
                    .0
                    .iter()
                    .map(|e| e.created_at)
                    .collect::<Vec<_>>()
            }
        };
        assert_eq!(only(json!({ "action": "role" })).await.len(), 20);
        assert_eq!(only(json!({ "action": "member.kick" })).await.len(), 20);
        assert_eq!(only(json!({ "actor": "BOB" })).await.len(), 20);
        assert_eq!(
            only(json!({ "target": "USER5" })).await,
            vec![
                1059, 1058, 1057, 1056, 1055, 1054, 1053, 1052, 1051, 1050, 1005
            ]
        );
        assert_eq!(only(json!({ "target": "%" })).await.len(), 0);
        assert_eq!(
            only(json!({ "from": 1010, "to": 1012 })).await,
            vec![1012, 1011, 1010]
        );
        assert_eq!(
            only(json!({ "action": "channel", "actor": "alice", "from": 1050 })).await,
            vec![1059, 1056, 1053, 1050]
        );
        assert_eq!(
            status(page(&state, "alice", json!({ "action": "nope" })).await),
            Some(StatusCode::BAD_REQUEST)
        );
        assert_eq!(
            status(page(&state, "alice", json!({ "cursor": "zz" })).await),
            Some(StatusCode::BAD_REQUEST)
        );
        let _ = general;
        done(state, path).await;
    }

    #[tokio::test]
    async fn private_channels_are_hidden_from_viewers_who_cant_see_them() {
        let (state, path, _) = club("audit_private").await;
        let db = &state.db;
        let secret = id_of(db, "INSERT INTO channels(server, name, created_at, restrict_view) VALUES('club', 'secret', 0, 1) RETURNING id").await;
        let _ = update_channel(
            State(state.clone()),
            who("alice"),
            Path(secret),
            Json(req(json!({ "topic": "plans" }))),
        )
        .await
        .expect("topic");
        let gone = id_of(db, "INSERT INTO channels(server, name, created_at, restrict_view) VALUES('club', 'vault', 0, 1) RETURNING id").await;
        let _ = delete_channel(State(state.clone()), who("alice"), Path(gone))
            .await
            .expect("delete");
        let role = id_of(db, "INSERT INTO roles(server, name, color, perms) VALUES('club', 'auditors', '#ffffff', 64) RETURNING id").await;
        exec(
            db,
            &format!(
                "INSERT INTO user_roles(server, username, role_id) VALUES('club', 'bob', {role})"
            ),
        )
        .await;
        let (seen, _) = page(&state, "bob", json!({})).await.expect("bob");
        assert_eq!(seen.len(), 2);
        for e in &seen {
            assert!(e.hidden);
            assert_eq!(e.details, json!({}));
            assert_eq!(e.target.as_ref().and_then(|t| t.name.clone()), None);
        }
        let json = serde_json::to_string(&seen).expect("json");
        assert!(!json.contains("secret") && !json.contains("vault") && !json.contains("plans"));
        assert!(
            page(&state, "bob", json!({ "target": "sec" }))
                .await
                .expect("search")
                .0
                .is_empty()
        );
        let (full, _) = page(&state, "alice", json!({})).await.expect("alice");
        assert!(full.iter().all(|e| !e.hidden));
        exec(db, &format!("INSERT INTO channel_perms(channel_id, subject, can_view, restrict_set) VALUES({secret}, 'u:bob', 1, 1)")).await;
        let (seen, _) = page(&state, "bob", json!({})).await.expect("bob again");
        assert_eq!(
            seen.iter().map(|e| e.hidden).collect::<Vec<_>>(),
            vec![true, false],
            "a channel bob can view now shows; a deleted private one stays hidden"
        );
        done(state, path).await;
    }

    async fn auditor(db: &Db, name: &str) {
        let role = id_of(db, "INSERT INTO roles(server, name, color, perms) VALUES('club', 'auditors', '#ffffff', 64) RETURNING id").await;
        exec(
            db,
            &format!(
                "INSERT INTO user_roles(server, username, role_id) VALUES('club', '{name}', {role})"
            ),
        )
        .await;
    }

    fn ids(entries: &[AuditEntry]) -> Vec<i64> {
        entries.iter().map(|e| e.id).collect()
    }

    #[tokio::test]
    async fn a_hidden_name_search_looks_like_a_search_for_nothing() {
        let (state, path, general) = club("audit_oracle").await;
        let db = &state.db;
        let secret = id_of(db, "INSERT INTO channels(server, name, created_at, restrict_view) VALUES('club', 'secret', 0, 1) RETURNING id").await;
        let hidden = channel_ref(db, secret).await.expect("q").expect("secret");
        let open = channel_ref(db, general).await.expect("q").expect("general");
        let alice = Actor::User("alice".to_string());
        let mut conn = db.acquire().await.expect("conn");
        for i in 0..60 {
            let named = ChannelRef {
                name: format!("secret{i}"),
                ..hidden.clone()
            };
            record(
                &mut conn,
                channel_entry("club", &alice, Action::ChannelUpdate, &named)
                    .details(Details::new().channel(&hidden)),
            )
            .await
            .expect("record");
        }
        record(
            &mut conn,
            channel_entry("club", &alice, Action::ChannelUpdate, &open)
                .details(Details::new().channel(&open)),
        )
        .await
        .expect("record");
        drop(conn);
        auditor(db, "bob").await;
        let (all, next) = page(&state, "bob", json!({})).await.expect("all");
        assert_eq!(all.len(), PAGE_MAX as usize);
        assert!(next.is_some());
        assert!(!all[0].hidden && all[1..].iter().all(|e| e.hidden));
        let (guess, guess_next) = page(&state, "bob", json!({ "target": "sec" }))
            .await
            .expect("guess");
        let (nothing, nothing_next) = page(&state, "bob", json!({ "target": "zzzz" }))
            .await
            .expect("nothing");
        assert_eq!(ids(&guess), ids(&nothing));
        assert_eq!(guess_next, nothing_next);
        assert!(guess.is_empty() && guess_next.is_none());
        let (small, small_next) = page(&state, "bob", json!({ "target": "e", "limit": 1 }))
            .await
            .expect("small page");
        assert_eq!(
            (small.len(), small_next),
            (1, None),
            "only visible entries count for the page and the cursor"
        );
        let (found, more) = page(&state, "alice", json!({ "target": "sec" }))
            .await
            .expect("alice");
        assert_eq!(found.len(), PAGE_MAX as usize);
        assert!(more.is_some());
        done(state, path).await;
    }

    #[tokio::test]
    async fn every_channel_an_entry_names_must_be_visible() {
        let (state, path, _) = club("audit_two_channels").await;
        let db = &state.db;
        let alpha = id_of(db, "INSERT INTO channels(server, name, created_at, restrict_view) VALUES('club', 'alpha', 0, 1) RETURNING id").await;
        let beta = id_of(db, "INSERT INTO channels(server, name, created_at, restrict_view) VALUES('club', 'beta', 0, 1) RETURNING id").await;
        exec(
            db,
            &format!("UPDATE servers SET system_channel_id = {alpha} WHERE name = 'club'"),
        )
        .await;
        let _ = update_system_messages(
            State(state.clone()),
            who("alice"),
            named("club"),
            Json(req(json!({ "channel_id": beta }))),
        )
        .await
        .expect("move");
        exec(db, &format!("INSERT INTO channel_perms(channel_id, subject, can_view, restrict_set) VALUES({beta}, 'u:bob', 1, 1)")).await;
        auditor(db, "bob").await;
        let (seen, _) = page(&state, "bob", json!({})).await.expect("bob");
        assert_eq!(seen.len(), 1);
        assert!(seen[0].hidden, "bob can see beta but not alpha");
        let json = serde_json::to_string(&seen).expect("json");
        assert!(!json.contains("alpha") && !json.contains("beta"), "{json}");
        exec(db, &format!("INSERT INTO channel_perms(channel_id, subject, can_view, restrict_set) VALUES({alpha}, 'u:bob', 1, 1)")).await;
        let (seen, _) = page(&state, "bob", json!({})).await.expect("bob again");
        assert!(!seen[0].hidden);
        assert_eq!(
            changes(&seen[0])[0].1["name"],
            json!("alpha"),
            "with both channels visible the move shows"
        );
        done(state, path).await;
    }

    #[tokio::test]
    async fn actions_that_need_instance_powers_are_logged_as_staff() {
        let (state, path, _) = club("audit_powers").await;
        let db = &state.db;
        let s = || State(state.clone());
        let partial = Perm::Kick as i64 | Perm::ManageAdmins as i64 | Perm::DeleteMessages as i64;
        add_member(db, "club", "root", 1, partial, 0).await;
        exec(
            db,
            "UPDATE members SET is_admin = 1 WHERE username = 'carol'",
        )
        .await;
        let _ = kick_member(
            s(),
            who("root"),
            named("club"),
            Json(req(json!({ "username": "carol" }))),
        )
        .await
        .expect("kick a higher admin");
        let _ = grant_admin(
            s(),
            who("root"),
            named("club"),
            Json(req(json!({ "username": "dave" }))),
        )
        .await
        .expect("grant every permission");
        let secret = id_of(db, "INSERT INTO channels(server, name, created_at, restrict_view) VALUES('club', 'secret', 0, 1) RETURNING id").await;
        let hidden = message(db, secret, "bob").await;
        let _ = crate::api::messages::delete_message(s(), Path(hidden), who("root"))
            .await
            .expect("delete in a channel root can't see as a member");
        let _ = kick_member(
            s(),
            who("root"),
            named("club"),
            Json(req(json!({ "username": "bob" }))),
        )
        .await
        .expect("kick as a member could");
        let (entries, _) = page(&state, "alice", json!({})).await.expect("log");
        let summary: Vec<(String, bool, Option<String>)> = entries
            .iter()
            .map(|e| {
                (
                    e.action.clone(),
                    e.staff,
                    e.actor.as_ref().map(|a| a.username.clone()),
                )
            })
            .collect();
        assert_eq!(
            summary,
            vec![
                ("member.kick".to_string(), false, Some("root".to_string())),
                ("message.delete".to_string(), true, None),
                ("member.admin_grant".to_string(), true, None),
                ("member.kick".to_string(), true, None),
            ]
        );
        let json = serde_json::to_string(&entries[1..]).expect("json");
        assert!(!json.contains("root"), "{json}");
        done(state, path).await;
    }

    #[tokio::test]
    async fn site_admins_are_named_as_targets_and_act_on_themselves_as_members() {
        let (state, path, general) = club("audit_staff_target").await;
        let db = &state.db;
        let s = || State(state.clone());
        add_member(db, "club", "root", 0, 0, 0).await;
        let refused = grant_admin(
            s(),
            who("root"),
            named("club"),
            Json(req(json!({ "username": "root" }))),
        )
        .await;
        assert_eq!(
            refused.err().map(|ApiError(c, m)| (c, m)),
            Some((StatusCode::FORBIDDEN, "Missing permission".to_string())),
            "a site admin can't grant themselves admin through instance powers"
        );
        let _ = grant_admin(
            s(),
            who("alice"),
            named("club"),
            Json(req(json!({ "username": "root" }))),
        )
        .await
        .expect("alice grants root admin");
        let _ = crate::api::servers::revoke_admin(
            s(),
            who("alice"),
            Path(("club".to_string(), "root".to_string())),
        )
        .await
        .expect("revoke");
        let _ = set_channel_perm(
            s(),
            who("alice"),
            Path(general),
            Json(req(json!({ "subject": "u:root", "can_view": true, "can_send": false, "can_read_history": true }))),
        )
        .await
        .expect("rule");
        let theirs = message(db, general, "root").await;
        let _ = crate::api::messages::delete_message(s(), Path(theirs), who("alice"))
            .await
            .expect("delete root's message");
        exec(
            db,
            "UPDATE members SET is_admin = 1 WHERE username = 'root'",
        )
        .await;
        let mine = message(db, general, "root").await;
        let _ = pin_message(s(), Path(mine), who("root"))
            .await
            .expect("root pins their own message as a member");
        exec(
            db,
            "UPDATE members SET is_admin = 0 WHERE username = 'root'",
        )
        .await;
        let _ = kick_member(
            s(),
            who("alice"),
            named("club"),
            Json(req(json!({ "username": "root" }))),
        )
        .await
        .expect("kick");
        let (entries, _) = page(&state, "alice", json!({})).await.expect("log");
        assert_eq!(entries.len(), 6);
        // Members acting on a site admin name them as usual: marking them would reveal staff.
        for e in &entries {
            assert!(!e.staff, "{:?}", e.action);
            let t = e.target.as_ref().expect("target");
            if matches!(t.kind.as_str(), "user" | "message") {
                assert!(!t.staff && t.name.as_deref() == Some("root"));
                assert!(!t.deleted);
            }
        }
        assert_eq!(
            entries[3].details["subject"],
            json!({ "kind": "user", "name": "root" })
        );
        let pin = &entries[1];
        assert_eq!(pin.action, "message.pin");
        assert_eq!(
            pin.actor.as_ref().map(|a| a.username.as_str()),
            Some("root")
        );
        let grant = &entries[5];
        assert_eq!(grant.action, "member.admin_grant");
        assert_eq!(
            grant.actor.as_ref().map(|a| a.username.as_str()),
            Some("alice")
        );
        done(state, path).await;
    }

    #[tokio::test]
    async fn deleted_accounts_leave_a_marker_that_a_new_account_does_not_inherit() {
        let (state, path, general) = club("audit_deleted").await;
        let db = &state.db;
        let s = || State(state.clone());
        exec(db, "UPDATE members SET is_admin = 1 WHERE username = 'bob'").await;
        let _ = kick_member(
            s(),
            who("bob"),
            named("club"),
            Json(req(json!({ "username": "dave" }))),
        )
        .await
        .expect("bob kicks");
        let _ = crate::api::servers::revoke_admin(
            s(),
            who("alice"),
            Path(("club".to_string(), "bob".to_string())),
        )
        .await
        .expect("revoke");
        let _ = set_channel_perm(
            s(),
            who("alice"),
            Path(general),
            Json(req(json!({ "subject": "u:bob", "can_view": true, "can_send": false, "can_read_history": true }))),
        )
        .await
        .expect("rule");
        let theirs = message(db, general, "bob").await;
        let _ = crate::api::messages::delete_message(s(), Path(theirs), who("alice"))
            .await
            .expect("delete");
        let _ =
            crate::api::admin::hide_user_rows(&state, "bob", crate::api::admin::PurgeKind::User)
                .await
                .expect("hide");
        crate::api::admin::finish_purge(&state, crate::api::admin::PurgeKind::User, "bob")
            .await
            .expect("purge");
        crate::db::NewUser::plain("bob")
            .shown("Newcomer")
            .add(db)
            .await;
        let (entries, _) = page(&state, "alice", json!({})).await.expect("log");
        assert_eq!(entries.len(), 4);
        let json = serde_json::to_string(&entries).expect("json");
        assert!(
            !json.contains("bob") && !json.contains("Newcomer"),
            "{json}"
        );
        let kick = &entries[3];
        assert!(kick.actor.is_none() && !kick.staff);
        for e in [&entries[0], &entries[2]] {
            let t = e.target.as_ref().expect("target");
            assert!(t.deleted && !t.staff && t.name.is_none() && t.user.is_none());
        }
        assert_eq!(
            entries[1].details["subject"],
            json!({ "kind": "user", "deleted": true })
        );
        assert!(
            page(&state, "alice", json!({ "actor": "bob" }))
                .await
                .expect("by bob")
                .0
                .is_empty()
        );
        done(state, path).await;
    }

    #[tokio::test]
    async fn making_a_role_mentionable_needs_mention_everyone() {
        let (state, path, _) = club("audit_mentionable").await;
        let s = || State(state.clone());
        exec(
            &state.db,
            &format!(
                "UPDATE members SET is_admin = 1, perms = {} WHERE username = 'bob'",
                Perm::ManageAdmins as i64
            ),
        )
        .await;
        let role = |on: bool| json!({ "name": "helpers", "color": "#ff0000", "perms": 0, "mentionable": on });
        assert_eq!(
            status(create_role(s(), who("bob"), named("club"), Json(req(role(true)))).await),
            Some(StatusCode::FORBIDDEN)
        );
        let Json(made) = create_role(s(), who("bob"), named("club"), Json(req(role(false))))
            .await
            .expect("create");
        let rp = || Path(("club".to_string(), made.id));
        assert_eq!(
            status(
                update_role(
                    s(),
                    who("bob"),
                    rp(),
                    Json(req(json!({ "mentionable": true })))
                )
                .await
            ),
            Some(StatusCode::FORBIDDEN)
        );
        let _ = update_role(
            s(),
            who("alice"),
            rp(),
            Json(req(json!({ "mentionable": true }))),
        )
        .await
        .expect("alice turns it on");
        assert_eq!(
            changes(&last(&state).await),
            vec![("mentionable".to_string(), json!(false), json!(true))]
        );
        let _ = update_role(
            s(),
            who("bob"),
            rp(),
            Json(req(json!({ "mentionable": true, "color": "#00ff00" }))),
        )
        .await
        .expect("keeping it on is fine");
        let _ = update_role(
            s(),
            who("bob"),
            rp(),
            Json(req(json!({ "mentionable": false }))),
        )
        .await
        .expect("turning it off is fine");
        let _ = create_role(s(), who("alice"), named("club"), Json(req(role(true))))
            .await
            .expect("alice can");
        assert_eq!(
            actions(&state).await,
            ["role.create", "role.update", "role.create"]
        );
        done(state, path).await;
    }

    #[test]
    fn details_are_small_and_plain() {
        let long = "x".repeat(5000);
        let text = Details::encode(
            Details::new()
                .change("topic", None::<String>, long.as_str())
                .map,
        );
        assert!(text.len() < 1000);
        let mut big = Details::new();
        for i in 0..100 {
            big = big.change(&format!("field{i}"), "a".repeat(250), "b".repeat(250));
        }
        assert_eq!(
            Details::encode(big.clone().map),
            json!({ "truncated": true }).to_string()
        );
        let at = ChannelRef {
            id: 7,
            name: "secret".to_string(),
            private: true,
        };
        let kept = big.channel(&at);
        assert_eq!(kept.channels, vec![(7, true)]);
        assert_eq!(
            serde_json::from_str::<Value>(&Details::encode(kept.map)).expect("json"),
            json!({ "truncated": true, "channel": { "id": 7, "name": "secret", "private": true } }),
            "truncating keeps the channel"
        );
        assert!(!Details::new().change("a", 1, 1).has_changes());
        for a in ACTIONS {
            assert_eq!(Action::parse(a.as_str()), Some(*a));
            assert!(GROUPS.contains(&a.as_str().split('.').next().unwrap_or_default()));
        }
    }
}
