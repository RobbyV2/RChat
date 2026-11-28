use super::*;
use crate::api::access::resolve_category;
use rchat_perms::sync::{self, Place};

/// Request body for a category permission rule. Allow and deny both 0 delete the rule.
#[derive(Deserialize, ToSchema)]
pub struct CategoryPermSet {
    /// `everyone`, `r:<role id>` or `u:<username>`, case-insensitive.
    #[schema(example = "r:12")]
    subject: String,
    /// Channel permissions the rule allows (see `ChannelPerm.allow`).
    allow: i64,
    /// Channel permissions the rule denies; never one it allows.
    deny: i64,
    /// How a member rule (`u:`) combines with the member's roles; `override` when left out on a
    /// new rule, else unchanged. Only `override` for other subjects.
    mode: Option<PermMode>,
}

/// Request body for syncing a channel's permission rules with its category's.
#[derive(Deserialize, ToSchema)]
pub struct PermSyncReq {
    /// Sync even when the category's rules let someone see or send in the channel who could not
    /// before.
    #[serde(default)]
    confirm: bool,
}

fn category_row(r: &sqlx::any::AnyRow) -> Result<PermRow, ApiError> {
    let (allow, deny): (i64, i64) = (r.try_get(1)?, r.try_get(2)?);
    let [view, send, history] = row_flags(allow, deny);
    Ok(PermRow {
        subject: r.try_get(0)?,
        view,
        send,
        history,
        allow,
        deny,
        merge: r.try_get::<String, _>(3)? == "merge",
    })
}

/// The rules of category `id` with a subject after `after`, by subject, at most `limit`.
async fn category_rules(
    db: &Db,
    id: i64,
    after: &str,
    limit: i64,
) -> Result<Vec<PermRow>, ApiError> {
    sqlx::query("SELECT subject, allow, deny, mode FROM category_perms WHERE category_id = $1 AND subject > $2 ORDER BY subject LIMIT $3")
        .bind(id)
        .bind(after)
        .bind(limit)
        .fetch_all(db)
        .await?
        .iter()
        .map(category_row)
        .collect()
}

async fn category_rule(db: &Db, id: i64, subject: &str) -> Result<Option<PermRow>, ApiError> {
    sqlx::query(
        "SELECT subject, allow, deny, mode FROM category_perms WHERE category_id = $1 AND subject = $2",
    )
    .bind(id)
    .bind(subject)
    .fetch_optional(db)
    .await?
    .map(|r| category_row(&r))
    .transpose()
}

async fn channel_rules(db: &Db, id: i64) -> Result<Vec<PermRow>, ApiError> {
    let rows = sqlx::query(sqlx::AssertSqlSafe(format!(
        "SELECT {} FROM channel_perms cp WHERE cp.channel_id = $1 ORDER BY cp.subject",
        perm_columns("cp")
    )))
    .bind(id)
    .fetch_all(db)
    .await?;
    Ok(rows
        .iter()
        .map(|r| perm_row(r, 0))
        .collect::<sqlx::Result<_>>()?)
}

/// The rule of `subject` with these masks, or none when both are 0.
fn mask_rule(subject: &str, allow: i64, deny: i64, merge: bool) -> Option<PermRow> {
    let [view, send, history] = row_flags(allow, deny);
    (allow | deny != 0).then(|| PermRow {
        subject: subject.to_string(),
        view,
        send,
        history,
        allow,
        deny,
        merge,
    })
}

fn same(a: Option<&PermRow>, b: Option<&PermRow>) -> bool {
    a.map(PermRow::evaluated) == b.map(PermRow::evaluated)
}

/// Writes `row` as channel `id`'s rule for `subject` (none deletes it), with its masks and flags.
pub(super) async fn write_channel_rule(
    conn: &mut AnyConnection,
    id: i64,
    subject: &str,
    row: Option<&PermRow>,
) -> sqlx::Result<()> {
    match row {
        Some(row) => {
            let (Ow { allow, deny }, mode) = row.evaluated();
            let [view, send, history] = row_flags(allow as i64, deny as i64);
            sqlx::query(
                "INSERT INTO channel_perms(channel_id, subject, can_view, can_send, can_read_history, restrict_set, allow, deny, mode) VALUES($1, $2, $3, $4, $5, 1, $6, $7, $8) ON CONFLICT(channel_id, subject) DO UPDATE SET can_view = excluded.can_view, can_send = excluded.can_send, can_read_history = excluded.can_read_history, restrict_set = 1, allow = excluded.allow, deny = excluded.deny, mode = excluded.mode",
            )
            .bind(id)
            .bind(subject)
            .bind(i64::from(view))
            .bind(i64::from(send))
            .bind(i64::from(history))
            .bind(allow as i64)
            .bind(deny as i64)
            .bind(match mode {
                Mode::Merge => "merge",
                Mode::Override => "override",
            })
            .execute(&mut *conn)
            .await?;
        }
        None => {
            sqlx::query("DELETE FROM channel_perms WHERE channel_id = $1 AND subject = $2")
                .bind(id)
                .bind(subject)
                .execute(&mut *conn)
                .await?;
        }
    }
    Ok(())
}

/// Refuses a new channel in category `category` of the caller's server when one of the
/// category's rules is one the caller could not set in a channel without rules.
pub(super) async fn check_copy(
    db: &Db,
    access: &ServerAccess,
    category: i64,
) -> Result<(), ApiError> {
    let rows = sqlx::query(
        "SELECT subject, allow, deny, mode FROM category_perms WHERE category_id = $1 AND server = $2 ORDER BY subject",
    )
    .bind(category)
    .bind(access.name())
    .fetch_all(db)
    .await?;
    for r in &rows {
        let row = category_row(r)?;
        if guard_category_rule(db, access, &row.subject, None, Some(&row))
            .await
            .is_err_and(|e| e.status() == StatusCode::FORBIDDEN)
        {
            return Err(ApiError::perm(
                "You can't make a channel with this category's permissions",
                "rank",
            ));
        }
    }
    Ok(())
}

/// Gives channel `id`, just created in category `category`, the category's rules and marks it
/// as copying them. Returns whether it got any rule.
pub(super) async fn copy_category_rules(
    conn: &mut AnyConnection,
    id: i64,
    category: i64,
) -> Result<bool, ApiError> {
    let rows = sqlx::query(
        "SELECT subject, allow, deny, mode FROM category_perms WHERE category_id = $1 ORDER BY subject",
    )
    .bind(category)
    .fetch_all(&mut *conn)
    .await?;
    for r in &rows {
        let row = category_row(r)?;
        write_channel_rule(conn, id, &row.subject, Some(&row)).await?;
    }
    sqlx::query("UPDATE channels SET perm_sync = 1 WHERE id = $1")
        .bind(id)
        .execute(&mut *conn)
        .await?;
    Ok(!rows.is_empty())
}

/// List category permission rules
///
/// Returns the permission rules of a category, ordered by subject, as pages of `limit` (default
/// and max 100). Page with `cursor` from the `X-Next-Cursor` response header. A category's rules
/// gate nothing themselves: the channels that copy them (`Channel.perm_sync`) hold copies.
/// Requires the Manage channels permission in the category's server. General rate-limit bucket.
#[utoipa::path(
    get,
    path = "/api/v1/categories/{id}/perms",
    tag = "Channels",
    params(("id" = i64, Path, description = "Category id"), ChannelPermsQuery),
    responses(
        (status = 200, description = "A page of the category's permission rules, ordered by subject", body = Vec<ChannelPerm>, headers(("x-next-cursor" = String, description = "Cursor for the next page; absent on the last page"))),
        (status = 400, description = "Invalid cursor (JSON), or a non-integer `id` or `limit` (plain-text framework error)", body = ApiErrorBody),
        (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody),
        (status = 404, description = "`Not found`: no such category, one in a server you have no access to, or you lack the Manage channels permission there (identical responses)", body = ApiErrorBody),
        (status = 429, description = "Too many requests in the general bucket", body = ApiErrorBody)
    ),
    security(("bearer" = []))
)]
pub(crate) async fn list_category_perms(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path(id): Path<i64>,
    Query(q): Query<ChannelPermsQuery>,
) -> Result<Paged<ChannelPerm>, ApiError> {
    resolve_category(&state.db, id, &user).await?;
    let ChannelPermsQuery { limit, cursor } = q;
    let limit = limit.unwrap_or(LIST_MAX).clamp(1, LIST_MAX);
    let after = match cursor.as_deref().filter(|c| !c.trim().is_empty()) {
        Some(raw) => decode_cursor(raw, 1)?.remove(0),
        None => String::new(),
    };
    let rows = category_rules(&state.read(), id, &after, limit + 1).await?;
    let mut perms: Vec<ChannelPerm> = rows.iter().map(perm_view).collect();
    let more = perms.len() as i64 > limit;
    perms.truncate(limit as usize);
    let next = match (more, perms.last()) {
        (true, Some(p)) => Some(encode_cursor(&[&p.subject])),
        _ => None,
    };
    Ok(Paged(perms, next))
}

/// Set a category permission rule
///
/// Creates, replaces or (with `allow` and `deny` both 0) removes the category's rule for
/// `subject`, as for a channel (see `PUT /api/v1/channels/{id}/perms`): the subject must be
/// `everyone`, a role of the server or an account, the masks hold only channel permissions, and
/// you can't allow what you don't hold, or deny or stop allowing a moderation permission you don't
/// hold or for a role or member above you, in a channel of the server without rules. Every
/// channel that copies the category's rules (`Channel.perm_sync`) gets the same rule in the same
/// change, with the same checks against what you hold in it. A category has at most 500 rules.
/// Requires the Manage channels permission. Emits `channels_perms_changed` with the channels
/// whose rule changed, and takes members out of voice channels they can no longer be in.
/// General rate-limit bucket.
#[utoipa::path(
    put,
    path = "/api/v1/categories/{id}/perms",
    tag = "Channels",
    params(("id" = i64, Path, description = "Category id")),
    request_body = CategoryPermSet,
    responses(
        (status = 200, description = "Rule created, replaced or removed, in the category and the channels that copy it", body = OkResp),
        (status = 400, description = "`Invalid subject` (reason `invalid`, field `subject`; also a `u:` name without an account), `Invalid permissions` (bits outside the channel permissions, or a bit in both masks), `Invalid mode` (`merge` on a rule that is not for a user), or the category already has 500 rules. A non-integer `id`, malformed JSON or a missing `Content-Type` give a plain-text 400 or 415", body = ApiErrorBody),
        (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody),
        (status = 403, description = "The rule allows or denies more than you may, in the category or in a channel that copies it", body = ApiErrorBody),
        (status = 404, description = "`Not found`: no such category, one in a server you have no access to, or you lack the Manage channels permission there (identical responses); or the subject's role does not exist", body = ApiErrorBody),
        (status = 422, description = "The body is not valid for this schema (plain-text framework error)", content_type = "text/plain", body = String),
        (status = 429, description = "Too many requests in the general bucket, or `Too many lookups. Try again later.` for a `u:` subject outside the server once your lookup misses are spent", body = ApiErrorBody)
    ),
    security(("bearer" = []))
)]
pub(crate) async fn set_category_perm(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path(id): Path<i64>,
    Json(req): Json<CategoryPermSet>,
) -> Result<Json<OkResp>, ApiError> {
    let CategoryPermSet {
        subject,
        allow,
        deny,
        mode,
    } = req;
    let user = rule_actor(&user, &subject);
    let access = resolve_category(&state.db, id, &user).await?;
    let subject = subject.to_lowercase();
    check_subject(&state, &user, &access, &subject).await?;
    if (allow | deny) & !(masks::CHANNEL as i64) != 0 || allow & deny != 0 {
        return Err(ApiError::invalid("Invalid permissions", "allow"));
    }
    let was = category_rule(&state.db, id, &subject).await?;
    let merge = match (mode, &was) {
        (Some(PermMode::Merge), _) if !subject.starts_with("u:") => {
            return Err(ApiError::invalid("Invalid mode", "mode"));
        }
        (Some(mode), _) => mode == PermMode::Merge,
        (None, Some(row)) => row.merge,
        (None, None) => false,
    };
    let now = mask_rule(&subject, allow, deny, merge);
    let rules: i64 = sqlx::query("SELECT COUNT(*) FROM category_perms WHERE category_id = $1")
        .bind(id)
        .fetch_one(&state.db)
        .await?
        .try_get(0)?;
    if was.is_none() && now.is_some() && rules >= CHANNEL_PERM_MAX {
        return Err(ApiError::limit(
            StatusCode::BAD_REQUEST,
            format!("A category can have at most {CHANNEL_PERM_MAX} permission rules"),
            crate::api::error::Cap::ChannelPermRules,
        ));
    }
    change_category_rule(&state, &user, &access, id, &subject, was, now).await?;
    Ok(ok())
}

/// Remove a category permission rule
///
/// Removes the category's rule for `subject`, and the same rule from every channel that copies
/// the category's rules, with the checks of `PUT /api/v1/categories/{id}/perms`. Requires the
/// Manage channels permission. Emits `channels_perms_changed` with the channels whose rule
/// changed. General rate-limit bucket.
#[utoipa::path(
    delete,
    path = "/api/v1/categories/{id}/perms/{subject}",
    tag = "Channels",
    params(
        ("id" = i64, Path, description = "Category id"),
        ("subject" = String, Path, description = "Rule subject, `everyone`, `u:<username>` or `r:<role id>`, case-insensitive")
    ),
    responses(
        (status = 200, description = "Rule removed from the category and the channels that copy it", body = OkResp),
        (status = 400, description = "Non-integer `id` (plain-text framework error)", content_type = "text/plain", body = String),
        (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody),
        (status = 403, description = "The rule denies a permission you don't hold, or allows a moderation permission to a role or member above you, in the category or a channel that copies it", body = ApiErrorBody),
        (status = 404, description = "`Not found`: no such category, one in a server you have no access to, or you lack the Manage channels permission there (identical responses); or no rule for that subject", body = ApiErrorBody),
        (status = 429, description = "Too many requests in the general bucket", body = ApiErrorBody)
    ),
    security(("bearer" = []))
)]
pub(crate) async fn clear_category_perm(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path((id, subject)): Path<(i64, String)>,
) -> Result<Json<OkResp>, ApiError> {
    let user = rule_actor(&user, &subject);
    let access = resolve_category(&state.db, id, &user).await?;
    let subject = subject.to_lowercase();
    let was = category_rule(&state.db, id, &subject)
        .await?
        .ok_or_else(|| not_found("No such rule"))?;
    change_category_rule(&state, &user, &access, id, &subject, Some(was), None).await?;
    Ok(ok())
}

/// Changes category `id`'s rule for `subject` from `was` to `now`, and the rule of every channel
/// that copies the category's rules, in one transaction.
async fn change_category_rule(
    state: &AppState,
    user: &User,
    access: &ServerAccess,
    id: i64,
    subject: &str,
    was: Option<PermRow>,
    now: Option<PermRow>,
) -> Result<(), ApiError> {
    let server = access.name().to_string();
    let actor = access.audit_actor(&state.db, Perm::ManageChannels).await?;
    let mut bypassed =
        guard_category_rule(&state.db, access, subject, was.as_ref(), now.as_ref()).await?;
    let synced: Vec<i64> = sqlx::query_scalar(
        "SELECT id FROM channels WHERE category_id = $1 AND server = $2 AND perm_sync = 1 ORDER BY id",
    )
    .bind(id)
    .bind(&server)
    .fetch_all(&state.db)
    .await?;
    let mut changed = Vec::new();
    for child in synced {
        let channel = resolve_channel(&state.db, child, Some(user), &Proof::none()).await?;
        let before = channel_rules(&state.db, child)
            .await?
            .into_iter()
            .find(|r| r.subject == subject);
        if same(before.as_ref(), now.as_ref()) {
            continue;
        }
        bypassed |=
            guard_rule_edit(&state.db, &channel, subject, before.as_ref(), now.as_ref()).await?;
        changed.push(child);
    }
    let name: Option<String> =
        sqlx::query_scalar("SELECT name FROM channel_categories WHERE id = $1")
            .bind(id)
            .fetch_optional(&state.db)
            .await?;
    let mut tx = state.db.begin().await?;
    lock_server(&mut tx, &server).await?;
    let still: Vec<i64> = sqlx::query_scalar(
        "SELECT id FROM channels WHERE category_id = $1 AND server = $2 AND perm_sync = 1",
    )
    .bind(id)
    .bind(&server)
    .fetch_all(&mut *tx)
    .await?;
    let written: Vec<i64> = changed.into_iter().filter(|c| still.contains(c)).collect();
    match &now {
        Some(row) => {
            let (Ow { allow, deny }, mode) = row.evaluated();
            sqlx::query(
                "INSERT INTO category_perms(category_id, server, subject, allow, deny, mode) VALUES($1, $2, $3, $4, $5, $6) ON CONFLICT(category_id, subject) DO UPDATE SET allow = excluded.allow, deny = excluded.deny, mode = excluded.mode",
            )
            .bind(id)
            .bind(&server)
            .bind(subject)
            .bind(allow as i64)
            .bind(deny as i64)
            .bind(match mode {
                Mode::Merge => "merge",
                Mode::Override => "override",
            })
            .execute(&mut *tx)
            .await?;
        }
        None => {
            sqlx::query("DELETE FROM category_perms WHERE category_id = $1 AND subject = $2")
                .bind(id)
                .bind(subject)
                .execute(&mut *tx)
                .await?;
        }
    }
    for child in &written {
        write_channel_rule(&mut tx, *child, subject, now.as_ref()).await?;
    }
    let changes = rule_changes(was.as_ref(), now.as_ref());
    if changes.has_changes() {
        let details = changes
            .set("subject", rule_subject(&mut tx, subject).await?)
            .set("copies", written.len())
            .set("removed", now.is_none());
        audit::record(
            &mut tx,
            Entry::new(
                &server,
                &actor.staff_if(bypassed),
                audit::Action::CategoryPerms,
            )
            .target(Target::with_id(TargetKind::Category, id, name.as_deref()))
            .details(details),
        )
        .await?;
    }
    tx.commit().await?;
    if !written.is_empty() {
        state.hub.broadcast(WsEvent::ChannelsPermsChanged {
            server: server.clone(),
            channel_ids: written,
        });
        voice_rules_changed(state, &server, None).await;
    }
    Ok(())
}

/// Sync a channel's permission rules with its category
///
/// Replaces every permission rule of the channel with its category's rules and marks the channel
/// as copying them (`Channel.perm_sync`), so later changes to the category's rules reach it too.
/// The channel's "Private" and "Read-only" switches stay as they are. Each rule that changes is
/// checked as `PUT /api/v1/channels/{id}/perms` checks it. When the category's rules would let
/// `everyone`, a role or a member see or send in the channel who could not before, the answer is
/// 409 naming them, unless `confirm` is true. Requires the Manage channels permission. Emits
/// `channel_perms_changed`. General rate-limit bucket.
#[utoipa::path(
    post,
    path = "/api/v1/channels/{id}/perms/sync",
    tag = "Channels",
    params(("id" = i64, Path, description = "Channel id")),
    request_body = PermSyncReq,
    responses(
        (status = 200, description = "The channel's rules are its category's", body = OkResp),
        (status = 400, description = "`This channel is not in a category`. A non-integer `id`, malformed JSON or a missing `Content-Type` give a plain-text 400 or 415", body = ApiErrorBody),
        (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody),
        (status = 403, description = "Missing the Manage channels permission, or a rule allows or denies more than you may", body = ApiErrorBody),
        (status = 404, description = "`Not found`: no such channel, a channel you cannot see, or one in a password-protected server you have no access to (identical responses)", body = ApiErrorBody),
        (status = 409, description = "Without `confirm`, the sync would let someone see or send in the channel who could not before (reason `conflict`): `Syncing lets everyone, r:12 see or send here. Send confirm to sync.`", body = ApiErrorBody),
        (status = 422, description = "The body is not valid for this schema (plain-text framework error)", content_type = "text/plain", body = String),
        (status = 429, description = "Too many requests in the general bucket", body = ApiErrorBody)
    ),
    security(("bearer" = []))
)]
pub(crate) async fn sync_channel_perms(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path(id): Path<i64>,
    Json(req): Json<PermSyncReq>,
) -> Result<Json<OkResp>, ApiError> {
    let PermSyncReq { confirm } = req;
    let channel = channel_perm_guard(&state, id, &user).await?;
    let access = channel.server();
    let server = access.name().to_string();
    let actor = access.audit_actor(&state.db, Perm::ManageChannels).await?;
    let row = sqlx::query(
        "SELECT category_id, restrict_view, restrict_send, kind FROM channels WHERE id = $1",
    )
    .bind(id)
    .fetch_one(&state.db)
    .await?;
    let Some(category) = row.try_get::<Option<i64>, _>(0)? else {
        return Err(ApiError::conflict(
            StatusCode::BAD_REQUEST,
            "This channel is not in a category",
        ));
    };
    let place = Place {
        restrict_view: row.try_get::<i64, _>(1)? != 0,
        restrict_send: row.try_get::<i64, _>(2)? != 0,
        voice: row.try_get::<String, _>(3)? == "voice",
    };
    let before = channel_rules(&state.db, id).await?;
    let after = category_rules(&state.db, category, "", CHANNEL_PERM_MAX).await?;
    let rules = |rows: &[PermRow]| -> Vec<(String, Ow, Mode)> {
        rows.iter()
            .map(|r| {
                let (ow, mode) = r.evaluated();
                (r.subject.clone(), ow, mode)
            })
            .collect()
    };
    let (was, now) = (rules(&before), rules(&after));
    let roles: HashMap<String, Mask> = sqlx::query("SELECT id, perms FROM roles WHERE server = $1")
        .bind(&server)
        .fetch_all(&state.db)
        .await?
        .iter()
        .map(|r| {
            Ok((
                format!("r:{}", r.try_get::<i64, _>(0)?),
                r.try_get::<i64, _>(1)? as Mask,
            ))
        })
        .collect::<sqlx::Result<_>>()?;
    let mut held: HashMap<String, Vec<String>> = HashMap::new();
    for r in before.iter().chain(&after) {
        if let Some(name) = r.subject.strip_prefix("u:")
            && !held.contains_key(&r.subject)
        {
            let ids = role_ids(&state.db, &server, name).await?;
            held.insert(
                r.subject.clone(),
                ids.iter().map(|id| format!("r:{id}")).collect(),
            );
        }
    }
    let widened = sync::widened(
        &as_rules(&was),
        &as_rules(&now),
        (EVERYONE, access.everyone(&state.db).await?),
        &|s| roles.get(s).copied().unwrap_or(0),
        &|m| held.get(m).cloned().unwrap_or_default(),
        place,
        &HOSTED,
    );
    if !widened.is_empty() && !confirm {
        return Err(ApiError::conflict(
            StatusCode::CONFLICT,
            format!(
                "Syncing lets {} see or send here. Send confirm to sync.",
                widened.join(", ")
            ),
        ));
    }
    let mut subjects: Vec<&str> = before.iter().map(|r| r.subject.as_str()).collect();
    for r in &after {
        if !subjects.contains(&r.subject.as_str()) {
            subjects.push(&r.subject);
        }
    }
    let mut bypassed = false;
    let mut changed = Vec::new();
    for subject in subjects {
        let b = before.iter().find(|r| r.subject == subject);
        let a = after.iter().find(|r| r.subject == subject);
        if same(b, a) {
            continue;
        }
        bypassed |= guard_rule_edit(&state.db, &channel, subject, b, a).await?;
        changed.push((subject, a));
    }
    let mut tx = state.db.begin().await?;
    lock_server(&mut tx, &server).await?;
    let placed: Option<i64> = sqlx::query_scalar("SELECT category_id FROM channels WHERE id = $1")
        .bind(id)
        .fetch_one(&mut *tx)
        .await?;
    let rows: Vec<(String, i64, i64)> = sqlx::query_as(
        "SELECT subject, allow, deny FROM category_perms WHERE category_id = $1 ORDER BY subject",
    )
    .bind(category)
    .fetch_all(&mut *tx)
    .await?;
    let read: Vec<(String, i64, i64)> = after
        .iter()
        .map(|r| (r.subject.clone(), r.allow, r.deny))
        .collect();
    if placed != Some(category) || rows != read {
        return Err(ApiError::conflict(
            StatusCode::CONFLICT,
            "The channel list changed. Reload it and try again",
        ));
    }
    for (subject, row) in &changed {
        write_channel_rule(&mut tx, id, subject, *row).await?;
    }
    sqlx::query("UPDATE channels SET perm_sync = 1 WHERE id = $1")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    if let Some(at) = audit::channel_ref(&mut *tx, id).await? {
        let name: Option<String> =
            sqlx::query_scalar("SELECT name FROM channel_categories WHERE id = $1")
                .bind(category)
                .fetch_optional(&mut *tx)
                .await?;
        audit::record(
            &mut tx,
            audit::channel_entry(
                &server,
                &actor.staff_if(bypassed),
                audit::Action::ChannelPermSync,
                &at,
            )
            .details(
                Details::new()
                    .channel(&at)
                    .set("category", name)
                    .set("rules", changed.len()),
            ),
        )
        .await?;
    }
    tx.commit().await?;
    state.hub.broadcast(WsEvent::ChannelPermsChanged {
        server: server.clone(),
        channel_id: id,
    });
    voice_rules_changed(&state, &server, Some(id)).await;
    Ok(ok())
}

fn as_rules(list: &[(String, Ow, Mode)]) -> Vec<(&str, Ow, Mode)> {
    list.iter()
        .map(|(s, ow, m)| (s.as_str(), *ow, *m))
        .collect()
}
