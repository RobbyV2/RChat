use super::config::GroupMap;
use crate::{
    api::{
        ApiError,
        access::{self, Proof},
        auth::begin_account_write,
        instance_audit, servers,
        system_messages::announce_system,
    },
    db,
    state::AppState,
    ws::WsEvent,
};
use serde_json::json;
use sqlx::{AnyConnection, Row};
use std::collections::{BTreeMap, BTreeSet};

/// Replace this provider's snapshot in the transaction that verified the account link.
pub(crate) async fn set_claim_groups(
    conn: &mut AnyConnection,
    map: &GroupMap,
    username: &str,
    provider: &str,
    groups: &[String],
) -> sqlx::Result<()> {
    sqlx::query("DELETE FROM sso_user_groups WHERE username=$1 AND source=$2")
        .bind(username)
        .bind(provider)
        .execute(&mut *conn)
        .await?;
    for group in groups
        .iter()
        .filter(|g| map.0.contains_key(*g))
        .collect::<BTreeSet<_>>()
    {
        sqlx::query("INSERT INTO sso_user_groups(username,source,grp,alias_key) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING").bind(username).bind(provider).bind(group).bind(super::accounts::oidc_key(group).as_str()).execute(&mut *conn).await?;
    }
    Ok(())
}

pub async fn effective_groups<'e>(
    ex: impl sqlx::Executor<'e, Database = sqlx::Any>,
    username: &str,
) -> sqlx::Result<BTreeSet<String>> {
    let rows = sqlx::query_scalar(
        "WITH scim AS (
            SELECT g.display_name, g.external_id FROM scim_groups g
            JOIN scim_group_members m ON m.group_id=g.id WHERE m.username=$1
        ) SELECT c.grp FROM sso_user_groups c WHERE c.username=$1
          AND NOT EXISTS (SELECT 1 FROM scim_owned_aliases a WHERE a.source=c.source
              AND (c.alias_key IS NULL OR a.alias_key=c.alias_key) AND a.grp=c.grp)
        UNION SELECT display_name FROM scim
        UNION SELECT external_id FROM scim WHERE external_id IS NOT NULL",
    )
    .bind(username)
    .fetch_all(ex)
    .await?;
    Ok(rows.into_iter().collect())
}

#[derive(Default, Debug, PartialEq, Eq)]
pub struct Reconciled {
    pub joined: Vec<String>,
    pub left: Vec<String>,
    pub roles_added: Vec<(String, i64)>,
    pub roles_removed: Vec<(String, i64)>,
}

async fn remember(
    conn: &mut AnyConnection,
    username: &str,
    server: &str,
    id: i64,
    group: &str,
) -> sqlx::Result<()> {
    sqlx::query("INSERT INTO sso_grants(username,server,role_id,created_at,grp) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING").bind(username).bind(server).bind(id).bind(db::now()).bind(group).execute(conn).await?;
    Ok(())
}

async fn audit(
    conn: &mut AnyConnection,
    action: &str,
    username: &str,
    server: &str,
    group: Option<&str>,
    role: Option<i64>,
) -> Result<(), ApiError> {
    let mut detail = json!({"group":group,"server":server});
    if let Some(id) = role {
        detail["role"] = json!(id);
    }
    instance_audit::record_in(conn, "sso", action, Some(username), detail, db::now()).await
}

/// Fold role names identically on SQLite and Postgres. Two matching IDs make a name ambiguous.
async fn desired_grants<'a>(
    conn: &mut AnyConnection,
    server: &str,
    entries: &[(&'a str, Option<&str>)],
) -> sqlx::Result<BTreeMap<i64, &'a str>> {
    let mut roles = BTreeMap::<String, Option<i64>>::new();
    if entries.iter().any(|(_, role)| role.is_some()) {
        for row in sqlx::query("SELECT name, id FROM roles WHERE server=$1")
            .bind(server)
            .fetch_all(conn)
            .await?
        {
            let name: String = row.try_get(0)?;
            let id: i64 = row.try_get(1)?;
            roles
                .entry(name.to_lowercase())
                .and_modify(|id| *id = None)
                .or_insert(Some(id));
        }
    }
    let mut warned = BTreeSet::new();
    let mut desired = BTreeMap::new();
    for &(group, role) in entries {
        if let Some(name) = role {
            let folded = name.to_lowercase();
            let Some(Some(id)) = roles.get(&folded) else {
                if warned.insert(folded) {
                    tracing::warn!(
                        server,
                        role = name,
                        "Missing or ambiguous SSO group map role"
                    );
                }
                continue;
            };
            desired.insert(*id, group);
        }
        desired.insert(0, group);
    }
    Ok(desired)
}

// These two refusals are returned by insert_member_locked before any writes.
pub(crate) fn is_membership_limit(error: &ApiError) -> bool {
    use crate::api::ReasonKind;
    matches!(
        error
            .2
            .as_ref()
            .map(|reason| (reason.kind, reason.control.as_deref())),
        Some(
            (ReasonKind::Limit, Some("servers_per_account"))
                | (ReasonKind::Capacity, Some("server_members_max"))
        )
    )
}

pub async fn reconcile(state: &AppState, username: &str) -> Result<Reconciled, ApiError> {
    reconcile_after_lookup(state, username, std::future::ready(())).await
}

async fn reconcile_after_lookup(
    state: &AppState,
    username: &str,
    after_lookup: impl Future<Output = ()>,
) -> Result<Reconciled, ApiError> {
    let mut after_lookup = Some(after_lookup);
    let db = &state.db;
    let Some(user) = db::get_user(db, username).await? else {
        return Ok(Reconciled::default());
    };
    if user.suspended_at.is_some() {
        return Ok(Reconciled::default());
    }
    let username = user.username.as_str();
    // Resolve access without occupying a transaction connection. Recheck the source snapshot
    // under the account lock before using these results (also works with a one-connection pool).
    let (mut tx, targets, accesses, servers) = loop {
        let groups = effective_groups(db, username).await?;
        let mut targets = BTreeMap::<String, Vec<(&str, Option<&str>)>>::new();
        for (group, grants) in &state.sso.config.group_map.0 {
            if groups.contains(group) {
                for grant in grants {
                    targets
                        .entry(grant.server.to_lowercase())
                        .or_default()
                        .push((group, grant.role.as_deref()));
                }
            }
        }
        let mut accesses = BTreeMap::new();
        for server in targets.keys() {
            match access::resolve_server(db, server, Some(&user), &Proof::managed()).await {
                Ok(access) => {
                    accesses.insert(server.clone(), access);
                }
                Err(e) if e.1 == access::BANNED => {}
                Err(e) if e.0 == axum::http::StatusCode::NOT_FOUND => {
                    tracing::warn!(server, "Unknown SSO group map server");
                }
                Err(e) => return Err(e),
            }
        }
        if let Some(after_lookup) = after_lookup.take() {
            after_lookup.await;
        }
        let mut tx = begin_account_write(db).await?;
        servers::lock_account(&mut tx, username).await?;
        if db::get_user(&mut *tx, username)
            .await?
            .is_none_or(|u| u.suspended_at.is_some())
        {
            return Ok(Reconciled::default());
        }
        if effective_groups(&mut *tx, username).await? != groups {
            tx.rollback().await?;
            continue;
        }
        let mut servers: BTreeSet<String> = targets.keys().cloned().collect();
        servers.extend(
            sqlx::query_scalar::<_, String>(
                "SELECT DISTINCT server FROM sso_grants WHERE username=$1",
            )
            .bind(username)
            .fetch_all(&mut *tx)
            .await?,
        );
        for server in &servers {
            db::lock_server(&mut tx, server).await?;
        }
        // Managed access admits every existing, non-purging server unless banned.
        // Validate both allowed and denied decisions while holding all writer locks.
        let mut current = true;
        for server in targets.keys() {
            let available = sqlx::query(
                "SELECT 1 FROM servers WHERE name=$1 AND COALESCE(password_hash,'') <> '!purging'
                 AND NOT EXISTS(SELECT 1 FROM server_bans WHERE server=$1 AND username=$2
                 AND (expires_at IS NULL OR expires_at > $3))",
            )
            .bind(server)
            .bind(username)
            .bind(state.clock.unix())
            .fetch_optional(&mut *tx)
            .await?
            .is_some();
            if available != accesses.contains_key(server) {
                current = false;
                break;
            }
        }
        if current {
            break (tx, targets, accesses, servers);
        }
        tx.rollback().await?;
    };
    let mut result = Reconciled::default();
    let mut admission_error = None;
    let mut joins = Vec::new();
    let mut leaves = Vec::new();
    let (removed, retained): (Vec<_>, Vec<_>) = servers
        .into_iter()
        .partition(|server| !targets.contains_key(server));
    for server in removed.into_iter().chain(retained) {
        let mut grants = BTreeMap::<i64, Option<String>>::new();
        for row in sqlx::query("SELECT role_id,grp FROM sso_grants WHERE username=$1 AND server=$2")
            .bind(username)
            .bind(&server)
            .fetch_all(&mut *tx)
            .await?
        {
            grants.insert(row.try_get(0)?, row.try_get(1)?);
        }
        let mut desired = BTreeMap::new();
        if let Some(access) = accesses.get(&server) {
            desired = desired_grants(&mut tx, &server, &targets[&server]).await?;
            if let Some(&group) = desired.get(&0) {
                let member =
                    match servers::insert_member_locked(&mut tx, &state.limits, access, username)
                        .await
                    {
                        Ok(member) => member,
                        Err(error) if is_membership_limit(&error) => {
                            admission_error.get_or_insert(error);
                            desired.clear();
                            None
                        }
                        Err(error) => return Err(error),
                    };
                if let Some(member) = member {
                    remember(&mut tx, username, &server, 0, group).await?;
                    audit(
                        &mut tx,
                        "sso.group_join",
                        username,
                        &server,
                        Some(group),
                        None,
                    )
                    .await?;
                    result.joined.push(server.clone());
                    joins.push((server.clone(), access.lite().creator.clone(), member.notice));
                }
                for (&id, &group) in desired.range(1..) {
                    if servers::grant_role(&mut tx, &server, username, id).await? > 0 {
                        remember(&mut tx, username, &server, id, group).await?;
                        audit(
                            &mut tx,
                            "sso.role_grant",
                            username,
                            &server,
                            Some(group),
                            Some(id),
                        )
                        .await?;
                        result.roles_added.push((server.clone(), id));
                    }
                }
            }
        }
        for (&id, group) in grants.range(1..) {
            if !desired.contains_key(&id)
                && servers::revoke_role(&mut tx, &server, username, id).await? > 0
            {
                audit(
                    &mut tx,
                    "sso.role_revoke",
                    username,
                    &server,
                    group.as_deref(),
                    Some(id),
                )
                .await?;
                result.roles_removed.push((server.clone(), id));
            }
        }
        if let Some(group) = grants.get(&0)
            && !desired.contains_key(&0)
        {
            // Independent roles and direct permissions still need their membership.
            if sqlx::query(
                "SELECT 1 FROM members WHERE server=$1 AND username=$2 AND
                (is_admin<>0 OR perms<>0 OR EXISTS(
                    SELECT 1 FROM user_roles WHERE server=$1 AND username=$2
                ))",
            )
            .bind(&server)
            .bind(username)
            .fetch_optional(&mut *tx)
            .await?
            .is_some()
            {
                sqlx::query("DELETE FROM sso_grants WHERE server=$1 AND username=$2 AND role_id=0")
                    .bind(&server)
                    .bind(username)
                    .execute(&mut *tx)
                    .await?;
                continue;
            }
            if let Some(ended) = servers::end_membership(&mut tx, &server, username).await? {
                audit(
                    &mut tx,
                    "sso.group_leave",
                    username,
                    &server,
                    group.as_deref(),
                    None,
                )
                .await?;
                result.left.push(server.clone());
                leaves.push((server.clone(), ended.notice));
            }
        }
    }
    tx.commit().await?;
    for (server, creator, notice) in joins {
        if let Err(error) =
            servers::announce_join(state, &server, creator.as_deref(), username, notice).await
        {
            tracing::warn!(server, username, reason = %error.1, "Could not announce committed SSO join");
        }
    }
    for (server, notice) in leaves {
        announce_system(state, &server, notice).await;
        state.hub.broadcast(WsEvent::MemberLeft {
            server,
            username: username.to_owned(),
        });
    }
    for server in result
        .roles_added
        .iter()
        .chain(&result.roles_removed)
        .map(|(s, _)| s)
        .collect::<BTreeSet<_>>()
    {
        servers::announce_member_roles(state, server, username).await;
    }
    admission_error.map_or(Ok(result), Err)
}

pub async fn reconcile_all(state: &AppState) -> Result<u64, ApiError> {
    let mut after = String::new();
    let mut count = 0;
    let mut first_failure = None;
    loop {
        let names: Vec<String> = sqlx::query_scalar(
            "SELECT username FROM (
                SELECT username FROM sso_user_groups UNION SELECT username FROM scim_group_members
                UNION SELECT username FROM sso_grants
            ) candidates WHERE username>$1 ORDER BY username LIMIT 500",
        )
        .bind(&after)
        .fetch_all(&state.db)
        .await?;
        if names.is_empty() {
            return first_failure.map_or(Ok(count), Err);
        }
        for name in names {
            match reconcile(state, &name).await {
                Ok(_) => count += 1,
                Err(error) => {
                    tracing::warn!(username = %name, reason = %error.1, "SSO account reconciliation failed");
                    first_failure.get_or_insert(error);
                }
            }
            after = name;
        }
    }
}

pub fn spawn_reconcile(state: &AppState, usernames: Vec<String>) -> tokio::task::JoinHandle<()> {
    let state = state.clone();
    tokio::spawn(async move {
        for batch in usernames.chunks(100) {
            for username in batch {
                if let Err(error) = reconcile(&state, username).await {
                    tracing::warn!(?error, "SCIM group reconciliation failed");
                }
            }
            tokio::task::yield_now().await;
        }
    })
}

#[cfg(test)]
mod tests;
