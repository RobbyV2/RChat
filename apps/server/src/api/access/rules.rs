use sqlx::Row;

use rchat_perms::eval::Who;
use rchat_perms::{Mask, masks};

use super::perms::{
    ALL_PERMS, ChannelAccess, Perm, PermRow, Restrict, Standing, VISITOR_CAPS, channel_mask,
    everyone_mask, member_who, perm_bits, perm_columns, perm_row,
};
use super::{ViewRules, member_role};
use crate::db::{Db, GRANT_TOUCH_SECS, User, get_user, now, queue_grant_touches, secret_key};

pub(super) async fn effective_perms(db: &Db, server: &str, user: &User) -> sqlx::Result<i64> {
    match user.is_site_admin {
        true => Ok(ALL_PERMS),
        false => member_perms(db, server, &user.username).await,
    }
}

pub(super) async fn member_perms(db: &Db, server: &str, username: &str) -> sqlx::Result<i64> {
    let mut conn = db.acquire().await?;
    Ok(member_perms_in(&mut conn, server, username)
        .await?
        .unwrap_or(0))
}

pub(super) async fn member_perms_in(
    conn: &mut sqlx::AnyConnection,
    server: &str,
    username: &str,
) -> sqlx::Result<Option<i64>> {
    let Some((is_admin, perms)) = member_role(&mut *conn, server, username).await? else {
        return Ok(None);
    };
    if is_admin {
        return Ok(Some(perm_bits(true, perms, 0)));
    }
    let rows = sqlx::query("SELECT r.perms FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.server = $1 AND ur.username = $2")
        .bind(server)
        .bind(username)
        .fetch_all(conn)
        .await?;
    let mut acc = 0i64;
    for r in &rows {
        acc |= r.try_get::<i64, _>(0)?;
    }
    Ok(Some(perm_bits(false, perms, acc)))
}

pub(super) async fn manages_channels(db: &Db, server: &str, user: &User) -> sqlx::Result<bool> {
    Ok(effective_perms(db, server, user).await? & Perm::ManageChannels as i64 != 0)
}

pub(super) async fn channel_manager_servers(db: &Db, user: &User) -> sqlx::Result<Vec<String>> {
    let rows = sqlx::query(
        "SELECT server FROM members WHERE username = $1 AND is_admin <> 0 UNION SELECT ur.server FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.username = $1 AND r.perms <> 0",
    )
    .bind(&user.username)
    .fetch_all(db)
    .await?;
    let mut out = Vec::new();
    for r in &rows {
        let server: String = r.try_get(0)?;
        if manages_channels(db, &server, user).await? {
            out.push(server);
        }
    }
    Ok(out)
}

/// The restrictions of a channel, whether it is a voice channel, and the @everyone mask of its
/// server. A channel that is gone reads as an open text channel.
pub(super) async fn channel_base(db: &Db, channel_id: i64) -> sqlx::Result<(Restrict, bool, Mask)> {
    match sqlx::query("SELECT c.restrict_view, c.restrict_send, c.kind, s.everyone_perms FROM channels c JOIN servers s ON s.name = c.server WHERE c.id = $1")
        .bind(channel_id)
        .fetch_optional(db)
        .await?
    {
        Some(r) => Ok((
            Restrict::read(&r, 0)?,
            r.try_get::<String, _>(2)? == "voice",
            everyone_mask(r.try_get(3)?),
        )),
        None => Ok((Restrict::default(), false, everyone_mask(None))),
    }
}

/// The @everyone mask of `server`.
pub(super) async fn server_everyone<'e, E>(ex: E, server: &str) -> sqlx::Result<Mask>
where
    E: sqlx::Executor<'e, Database = sqlx::Any>,
{
    let stored = sqlx::query("SELECT everyone_perms FROM servers WHERE name = $1")
        .bind(server)
        .fetch_optional(ex)
        .await?
        .map(|r| r.try_get::<Option<i64>, _>(0))
        .transpose()?
        .flatten();
    Ok(everyone_mask(stored))
}

async fn channel_rules(db: &Db, channel_id: i64) -> sqlx::Result<Vec<PermRow>> {
    sqlx::query(sqlx::AssertSqlSafe(format!(
        "SELECT {} FROM channel_perms cp WHERE cp.channel_id = $1",
        perm_columns("cp")
    )))
    .bind(channel_id)
    .fetch_all(db)
    .await?
    .iter()
    .map(|r| perm_row(r, 0))
    .collect()
}

/// Who `user` is in `server`: staff, an admin or a member with their roles, or a visitor
/// holding at most `caps`.
pub(super) async fn standing(
    db: &Db,
    server: &str,
    user: Option<&User>,
    caps: Mask,
) -> sqlx::Result<Standing> {
    let Some(user) = user else {
        return Ok(Standing::visitor(None, caps));
    };
    if user.is_site_admin {
        return Ok(Standing {
            who: Who::Staff,
            subjects: vec![format!("u:{}", user.username)],
        });
    }
    let rows = sqlx::query("SELECT m.is_admin, m.perms, ur.role_id, r.perms FROM members m LEFT JOIN user_roles ur ON ur.server = m.server AND ur.username = m.username LEFT JOIN roles r ON r.id = ur.role_id WHERE m.server = $1 AND m.username = $2")
        .bind(server)
        .bind(&user.username)
        .fetch_all(db)
        .await?;
    let Some(first) = rows.first() else {
        return Ok(Standing::visitor(Some(&user.username), caps));
    };
    let (is_admin, perms): (bool, i64) = (first.try_get::<i64, _>(0)? != 0, first.try_get(1)?);
    let mut subjects = vec![format!("u:{}", user.username)];
    let mut roles = 0i64;
    for r in &rows {
        if let (Some(id), Some(bits)) = (
            r.try_get::<Option<i64>, _>(2)?,
            r.try_get::<Option<i64>, _>(3)?,
        ) {
            subjects.push(format!("r:{id}"));
            roles |= bits;
        }
    }
    Ok(Standing {
        who: member_who(is_admin, perms, roles),
        subjects,
    })
}

pub(super) async fn view_rules(db: &Db, channel_id: i64) -> sqlx::Result<ViewRules> {
    let (restrict, _, everyone) = channel_base(db, channel_id).await?;
    Ok(ViewRules {
        restrict,
        rules: channel_rules(db, channel_id).await?,
        everyone: Some(everyone as i64),
    })
}

pub(super) async fn view_under(
    db: &Db,
    server: &str,
    rules: &ViewRules,
    user: Option<&User>,
) -> sqlx::Result<bool> {
    let ViewRules {
        restrict,
        rules,
        everyone,
    } = rules;
    let standing = standing(db, server, user, VISITOR_CAPS).await?;
    let mask = channel_mask(
        rules,
        &standing,
        everyone_mask(*everyone),
        *restrict,
        false,
        false,
    );
    Ok(mask & masks::VIEW != 0)
}

/// What `user` holds in the channel. A visitor holds at most `caps`.
#[cfg(test)]
pub(super) async fn channel_access_within(
    db: &Db,
    server: &str,
    channel_id: i64,
    user: Option<&User>,
    caps: Mask,
) -> sqlx::Result<ChannelAccess> {
    channel_access_under(db, server, channel_id, user, caps).await
}

async fn channel_access_under(
    db: &Db,
    server: &str,
    channel_id: i64,
    user: Option<&User>,
    caps: Mask,
) -> sqlx::Result<ChannelAccess> {
    let (restrict, voice, everyone) = channel_base(db, channel_id).await?;
    let rows = channel_rules(db, channel_id).await?;
    let standing = standing(db, server, user, caps).await?;
    Ok(ChannelAccess::of(channel_mask(
        &rows, &standing, everyone, restrict, voice, false,
    )))
}

/// What `user` holds in the channel. A visitor holds what the channel gives everyone within
/// `VISITOR_CAPS`.
pub(super) async fn channel_access(
    db: &Db,
    server: &str,
    channel_id: i64,
    user: Option<&User>,
) -> sqlx::Result<ChannelAccess> {
    channel_access_under(db, server, channel_id, user, VISITOR_CAPS).await
}

/// A member row as the batch evaluators read it: admin, admin permissions and join.
type Seat = (bool, i64, i64);

/// The live members of `server` among `usernames`.
async fn seats(
    db: &Db,
    server: &str,
    usernames: &[String],
) -> sqlx::Result<std::collections::HashMap<String, Seat>> {
    let sql = format!(
        "SELECT m.username, m.is_admin, m.perms, m.joined_at FROM members m JOIN users u ON u.username = m.username WHERE m.server = $1 AND u.password_hash <> '!purging' AND m.username IN ({})",
        crate::api::placeholders(2, usernames.len())
    );
    let mut query = sqlx::query(sqlx::AssertSqlSafe(sql)).bind(server);
    for name in usernames {
        query = query.bind(name);
    }
    let mut members = std::collections::HashMap::new();
    for r in query.fetch_all(db).await? {
        let (name, is_admin, perms, joined_at): (String, i64, i64, i64) =
            (r.try_get(0)?, r.try_get(1)?, r.try_get(2)?, r.try_get(3)?);
        members.insert(name, (is_admin != 0, perms, joined_at));
    }
    Ok(members)
}

/// Who each of `members` is in `server`, a site admin counting as a plain member.
async fn standings(
    db: &Db,
    server: &str,
    members: &std::collections::HashMap<String, Seat>,
) -> sqlx::Result<std::collections::HashMap<String, Standing>> {
    let names: Vec<&String> = members.keys().collect();
    let sql = format!(
        "SELECT ur.username, ur.role_id, r.perms FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.server = $1 AND ur.username IN ({})",
        crate::api::placeholders(2, names.len())
    );
    let mut query = sqlx::query(sqlx::AssertSqlSafe(sql)).bind(server);
    for name in &names {
        query = query.bind(name.as_str());
    }
    let mut roles: std::collections::HashMap<String, (Vec<String>, i64)> =
        std::collections::HashMap::new();
    for r in query.fetch_all(db).await? {
        let (name, role, perms): (String, i64, i64) = (r.try_get(0)?, r.try_get(1)?, r.try_get(2)?);
        let entry = roles.entry(name).or_default();
        entry.0.push(format!("r:{role}"));
        entry.1 |= perms;
    }
    Ok(members
        .iter()
        .map(|(name, (is_admin, perms, _))| {
            let (role_subjects, role_perms) = roles.remove(name).unwrap_or_default();
            let mut subjects = vec![format!("u:{name}")];
            subjects.extend(role_subjects);
            let who = member_who(*is_admin, *perms, role_perms);
            (name.clone(), Standing { who, subjects })
        })
        .collect())
}

/// Which of `usernames` are live members of `server` who can view the channel: the rules of
/// `channel_access` evaluated for all of them with one query each for members, overrides and
/// roles, a site admin counting as a plain member. With `readable` (a message's `created_at`),
/// also only those who can read that message: members without read history only see messages
/// from their join on. Order is kept.
pub(super) async fn channel_viewers(
    db: &Db,
    server: &str,
    channel_id: i64,
    usernames: &[String],
    readable: Option<i64>,
) -> sqlx::Result<Vec<String>> {
    if usernames.is_empty() {
        return Ok(Vec::new());
    }
    let members = seats(db, server, usernames).await?;
    if members.is_empty() {
        return Ok(Vec::new());
    }
    let overrides = channel_rules(db, channel_id).await?;
    let (restrict, voice, everyone) = channel_base(db, channel_id).await?;
    let listed = usernames.iter().filter(|n| members.contains_key(*n));
    if overrides.is_empty()
        && restrict == Restrict::default()
        && everyone & (masks::VIEW | masks::HISTORY) == masks::VIEW | masks::HISTORY
    {
        return Ok(listed.cloned().collect());
    }
    let standings = standings(db, server, &members).await?;
    Ok(listed
        .filter(|name| {
            let (_, _, joined_at) = members[*name];
            let access = ChannelAccess::of(channel_mask(
                &overrides,
                &standings[*name],
                everyone,
                restrict,
                voice,
                false,
            ));
            access.view && (access.history || readable.is_none_or(|at| at >= joined_at))
        })
        .cloned()
        .collect())
}

/// What each live member of `server` among `usernames` holds in the channel through membership
/// alone: a site admin counts as a plain member.
pub(super) async fn member_masks(
    db: &Db,
    server: &str,
    channel_id: i64,
    usernames: &[String],
) -> sqlx::Result<std::collections::HashMap<String, Mask>> {
    if usernames.is_empty() {
        return Ok(std::collections::HashMap::new());
    }
    let members = seats(db, server, usernames).await?;
    if members.is_empty() {
        return Ok(std::collections::HashMap::new());
    }
    let overrides = channel_rules(db, channel_id).await?;
    let (restrict, voice, everyone) = channel_base(db, channel_id).await?;
    Ok(standings(db, server, &members)
        .await?
        .into_iter()
        .map(|(name, standing)| {
            let mask = channel_mask(&overrides, &standing, everyone, restrict, voice, false);
            (name, mask)
        })
        .collect())
}

/// What `username` holds in the channel, and whether it names an account. With `as_member`, a
/// site admin counts as a plain member.
pub(super) async fn channel_access_of(
    db: &Db,
    server: &str,
    channel_id: i64,
    username: Option<&str>,
    as_member: bool,
) -> sqlx::Result<(ChannelAccess, bool)> {
    let user = match username {
        Some(name) => get_user(db, name).await?.map(|user| User {
            is_site_admin: user.is_site_admin && !as_member,
            ..user
        }),
        None => None,
    };
    let access = channel_access(db, server, channel_id, user.as_ref()).await?;
    Ok((access, user.is_some()))
}

/// Whether `username` can view the channel. With `as_member`, a site admin counts as a plain
/// member.
pub(super) async fn channel_viewable(
    db: &Db,
    server: &str,
    channel_id: i64,
    username: Option<&str>,
    as_member: bool,
) -> bool {
    channel_access_of(db, server, channel_id, username, as_member)
        .await
        .is_ok_and(|(access, _)| access.view)
}

pub(super) async fn is_banned(db: &Db, server: &str, username: &str) -> sqlx::Result<bool> {
    crate::api::bans::banned(db, server, username).await
}

fn password_live(at: &str) -> String {
    format!(
        "(password_id IS NULL OR EXISTS(SELECT 1 FROM server_passwords p WHERE p.id = guest_grants.password_id AND p.revoked_at IS NULL AND (p.expires_at IS NULL OR p.expires_at > {at})))"
    )
}

/// Whether any of `grants` (raw values, as the client holds them, unused grants living `ttl`
/// seconds) opens `server`. One query for the whole list.
pub(super) async fn grants_open(
    db: &Db,
    grants: &[String],
    server: &str,
    ttl: i64,
) -> sqlx::Result<bool> {
    grants_open_on(db, db, grants, server, ttl).await
}

pub(super) async fn grants_open_on<'e>(
    executor: impl sqlx::Executor<'e, Database = sqlx::Any>,
    db: &Db,
    grants: &[String],
    server: &str,
    ttl: i64,
) -> sqlx::Result<bool> {
    if grants.is_empty() {
        return Ok(false);
    }
    let t = now();
    let sql = format!(
        "SELECT \"grant\", last_used_at FROM guest_grants WHERE \"grant\" IN ({}) AND server = $1 AND (last_used_at >= $2 OR (last_used_at = 0 AND created_at >= $2)) AND {} LIMIT 1",
        crate::api::placeholders(4, grants.len()),
        password_live("$3")
    );
    let mut query = sqlx::query(sqlx::AssertSqlSafe(sql))
        .bind(server)
        .bind(t - ttl)
        .bind(t);
    for grant in grants {
        query = query.bind(secret_key(grant));
    }
    let Some(row) = query.fetch_optional(executor).await? else {
        return Ok(false);
    };
    let (key, used): (String, i64) = (row.try_get(0)?, row.try_get(1)?);
    if t - used >= GRANT_TOUCH_SECS {
        queue_grant_touches(db, [key]);
    }
    Ok(true)
}

pub(super) async fn live_grant_servers(
    db: &Db,
    grants: &[String],
    ttl: i64,
) -> sqlx::Result<Vec<String>> {
    if grants.is_empty() {
        return Ok(Vec::new());
    }
    let t = now();
    let sql = format!(
        "SELECT \"grant\", server, last_used_at FROM guest_grants WHERE \"grant\" IN ({}) AND (last_used_at >= $1 OR (last_used_at = 0 AND created_at >= $1)) AND {}",
        crate::api::placeholders(3, grants.len()),
        password_live("$2")
    );
    let mut query = sqlx::query(sqlx::AssertSqlSafe(sql)).bind(t - ttl).bind(t);
    for grant in grants {
        query = query.bind(secret_key(grant));
    }
    let rows = query.fetch_all(db).await?;
    let mut servers = Vec::with_capacity(rows.len());
    let mut touch = Vec::new();
    for r in &rows {
        let (grant, server, used): (String, String, i64) =
            (r.try_get(0)?, r.try_get(1)?, r.try_get(2)?);
        if t - used >= GRANT_TOUCH_SECS {
            touch.push(grant);
        }
        servers.push(server);
    }
    queue_grant_touches(db, touch);
    servers.sort();
    servers.dedup();
    Ok(servers)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::test_util::{add_member, done, mem_user, temp_state};
    use crate::db::{close, flush_grant_touches, grant_touch_queued, reader, sweep_stale};

    async fn general_id(db: &Db) -> i64 {
        sqlx::query("SELECT id FROM channels WHERE server = 'rchat'")
            .fetch_one(db)
            .await
            .expect("general channel")
            .try_get(0)
            .expect("channel id")
    }

    async fn count(db: &Db, sql: &str) -> i64 {
        sqlx::query(sqlx::AssertSqlSafe(sql.to_string()))
            .fetch_one(db)
            .await
            .expect(sql)
            .try_get(0)
            .expect("count")
    }

    #[tokio::test]
    async fn effective_perms_matrix() {
        let (state, path) = temp_state("perm_matrix").await;
        let db = &state.db;
        let t = now();
        add_member(db, "rchat", "full", 1, 0, t).await;
        add_member(db, "rchat", "narrow", 1, Perm::Kick as i64, t).await;
        add_member(db, "rchat", "roled", 0, 0, t).await;
        add_member(db, "rchat", "plain", 0, 0, t).await;
        for perms in [Perm::ManageChannels as i64, Perm::Kick as i64] {
            let role_id: i64 = sqlx::query(
                "INSERT INTO roles(server, name, color, perms) VALUES('rchat', $1, '#ffffff', $2) RETURNING id",
            )
            .bind(format!("role{perms}"))
            .bind(perms)
            .fetch_one(db)
            .await
            .expect("insert role")
            .try_get(0)
            .expect("role id");
            sqlx::query(
                "INSERT INTO user_roles(server, username, role_id) VALUES('rchat', 'roled', $1)",
            )
            .bind(role_id)
            .execute(db)
            .await
            .expect("assign role");
        }
        let cases: [(&str, bool, i64); 5] = [
            ("site", true, ALL_PERMS),
            ("full", false, ALL_PERMS),
            ("narrow", false, Perm::Kick as i64),
            (
                "roled",
                false,
                Perm::ManageChannels as i64 | Perm::Kick as i64,
            ),
            ("plain", false, 0),
        ];
        for (name, site_admin, expected) in cases {
            let got = effective_perms(db, "rchat", &mem_user(name, site_admin))
                .await
                .expect("effective_perms");
            assert_eq!(got, expected, "user {name}");
        }
        done(state, path).await;
    }

    #[tokio::test]
    async fn member_perms_ignore_site_admin_and_non_members() {
        let (state, path) = temp_state("member_perms").await;
        let db = &state.db;
        add_member(db, "rchat", "root", 0, 0, now()).await;
        add_member(db, "rchat", "narrow", 1, Perm::Kick as i64, now()).await;
        assert_eq!(member_perms(db, "rchat", "root").await.expect("root"), 0);
        assert_eq!(
            effective_perms(db, "rchat", &mem_user("root", true))
                .await
                .expect("root effective"),
            ALL_PERMS
        );
        assert_eq!(
            member_perms(db, "rchat", "narrow").await.expect("narrow"),
            Perm::Kick as i64
        );
        assert_eq!(member_perms(db, "rchat", "ghost").await.expect("ghost"), 0);
        done(state, path).await;
    }

    #[tokio::test]
    async fn channel_access_private() {
        let (state, path) = temp_state("chan_access").await;
        let db = &state.db;
        let cid = general_id(db).await;
        let open = channel_access(db, "rchat", cid, None).await.expect("open");
        assert!(open.view && open.send && open.history);
        sqlx::query(
            "INSERT INTO channel_perms(channel_id, subject, can_view, can_send, can_read_history) VALUES($1, 'u:alice', 1, 1, 0)",
        )
        .bind(cid)
        .execute(db)
        .await
        .expect("insert perm");
        crate::api::test_util::restrict_ruled(db).await;
        add_member(db, "rchat", "carol", 1, 0, now()).await;
        let alice = channel_access(db, "rchat", cid, Some(&mem_user("alice", false)))
            .await
            .expect("alice");
        assert!(alice.view && alice.send && !alice.history);
        let bob = channel_access(db, "rchat", cid, Some(&mem_user("bob", false)))
            .await
            .expect("bob");
        assert!(!bob.view && !bob.send && !bob.history);
        let guest = channel_access(db, "rchat", cid, None).await.expect("guest");
        assert!(!guest.view && !guest.send && !guest.history);
        let carol = channel_access(db, "rchat", cid, Some(&mem_user("carol", false)))
            .await
            .expect("carol");
        assert!(carol.view && carol.send && carol.history);
        done(state, path).await;
    }

    #[tokio::test]
    async fn restrictions_need_an_explicit_allow() {
        let (state, path) = temp_state("chan_restrict").await;
        let db = &state.db;
        let cid = general_id(db).await;
        let t = now();
        for (name, admin, perms) in [
            ("owner", 1, 0),
            ("kicker", 1, Perm::Kick as i64),
            ("listed", 0, 0),
            ("muted", 0, 0),
            ("roled", 0, 0),
            ("manager", 0, 0),
            ("plain", 0, 0),
        ] {
            add_member(db, "rchat", name, admin, perms, t).await;
        }
        for (holder, perms) in [("roled", 0), ("manager", Perm::ManageChannels as i64)] {
            let role: i64 = sqlx::query(
                "INSERT INTO roles(server, name, color, perms) VALUES('rchat', $1, '#ffffff', $2) RETURNING id",
            )
            .bind(holder)
            .bind(perms)
            .fetch_one(db)
            .await
            .expect("role")
            .try_get(0)
            .expect("role id");
            sqlx::query(
                "INSERT INTO user_roles(server, username, role_id) VALUES('rchat', $1, $2)",
            )
            .bind(holder)
            .bind(role)
            .execute(db)
            .await
            .expect("assign");
            if holder == "roled" {
                sqlx::query("INSERT INTO channel_perms(channel_id, subject, can_view, can_send, can_read_history) VALUES($1, $2, 1, 1, 1)")
                    .bind(cid)
                    .bind(format!("r:{role}"))
                    .execute(db)
                    .await
                    .expect("role rule");
            }
        }
        let names = [
            "owner", "kicker", "listed", "muted", "roled", "manager", "plain", "site",
        ];
        let check = |label: &'static str, want: [(bool, bool, bool); 9]| async move {
            for (i, (view, send, history)) in want.into_iter().enumerate() {
                let user = names.get(i).map(|n| mem_user(n, *n == "site"));
                let got = channel_access(db, "rchat", cid, user.as_ref())
                    .await
                    .expect("access");
                let who = names.get(i).copied().unwrap_or("guest");
                assert_eq!(
                    (got.view, got.send, got.history),
                    (view, send, history),
                    "{label}: {who}"
                );
            }
        };
        let set = |view: i64, send: i64| async move {
            sqlx::query("UPDATE channels SET restrict_view = $1, restrict_send = $2 WHERE id = $3")
                .bind(view)
                .bind(send)
                .bind(cid)
                .execute(db)
                .await
                .expect("restrict");
        };
        let all = (true, true, true);
        let none = (false, false, false);
        let looks = (true, false, true);
        set(1, 0).await;
        check(
            "view, only a role rule",
            [all, none, none, none, all, all, none, all, none],
        )
        .await;
        set(0, 1).await;
        check(
            "send, only a role rule",
            [all, looks, looks, looks, all, all, looks, all, looks],
        )
        .await;
        sqlx::query("DELETE FROM channel_perms WHERE channel_id = $1")
            .bind(cid)
            .execute(db)
            .await
            .expect("empty list");
        set(1, 1).await;
        check(
            "both, empty list: managers only",
            [all, none, none, none, none, all, none, all, none],
        )
        .await;
        set(0, 1).await;
        check(
            "send, empty list",
            [all, looks, looks, looks, looks, all, looks, all, looks],
        )
        .await;
        for (subject, view, send, history) in [
            ("u:listed", 1, 1, 0),
            ("u:muted", 1, 0, 1),
            ("u:plain", 0, 1, 1),
        ] {
            sqlx::query("INSERT INTO channel_perms(channel_id, subject, can_view, can_send, can_read_history) VALUES($1, $2, $3, $4, $5)")
                .bind(cid)
                .bind(subject)
                .bind(view)
                .bind(send)
                .bind(history)
                .execute(db)
                .await
                .expect("user rule");
        }
        check(
            "send, user rules",
            [
                all,
                looks,
                (true, true, false),
                looks,
                looks,
                all,
                none,
                all,
                looks,
            ],
        )
        .await;
        set(1, 0).await;
        check(
            "view, user rules",
            [
                all,
                none,
                (true, true, false),
                looks,
                none,
                all,
                none,
                all,
                none,
            ],
        )
        .await;
        set(0, 0).await;
        check(
            "off: rules only deny their subjects",
            [
                all,
                all,
                (true, true, false),
                looks,
                all,
                all,
                none,
                all,
                all,
            ],
        )
        .await;
        done(state, path).await;
    }

    #[tokio::test]
    async fn guest_grants_slide_and_touch_at_most_daily() {
        let (state, path) = temp_state("grant_slide").await;
        let db = &state.db;
        let t = now();
        let ttl = state.limits.guest_grant_ttl();
        for (grant, used) in [
            ("fresh", t - 60),
            ("stale", t - 2 * 86400),
            ("gone", t - ttl - 60),
        ] {
            sqlx::query("INSERT INTO guest_grants(\"grant\", server, created_at, last_used_at) VALUES($1, 'rchat', 0, $2)")
                .bind(secret_key(grant))
                .bind(used)
                .execute(db)
                .await
                .expect("grant");
        }
        let read = reader(db);
        assert!(grant_live(&read, "fresh", "rchat").await.expect("fresh"));
        assert!(grant_live(&read, "stale", "rchat").await.expect("stale"));
        assert!(
            grant_live(&read, "stale", "rchat")
                .await
                .expect("stale again")
        );
        assert!(!grant_live(&read, "gone", "rchat").await.expect("gone"));
        assert!(
            !grant_live(&read, "fresh", "other")
                .await
                .expect("other server")
        );
        let used = |grant: &'static str| async move {
            sqlx::query("SELECT last_used_at FROM guest_grants WHERE \"grant\" = $1")
                .bind(secret_key(grant))
                .fetch_one(db)
                .await
                .expect("row")
                .try_get::<i64, _>(0)
                .expect("used")
        };
        assert_eq!(used("stale").await, t - 2 * 86400);
        assert_eq!(flush_grant_touches(db, ttl).await.expect("flush"), 1);
        assert!(used("stale").await >= t);
        assert_eq!(used("fresh").await, t - 60);
        assert!(
            grant_live(&read, "stale", "rchat")
                .await
                .expect("refreshed")
        );
        assert_eq!(
            flush_grant_touches(db, ttl).await.expect("nothing queued"),
            0
        );
        done(state, path).await;
    }

    async fn grant_live(db: &Db, grant: &str, server: &str) -> sqlx::Result<bool> {
        let ttl = crate::limits::Limits::default().guest_grant_ttl();
        grants_open(db, &[grant.to_string()], server, ttl).await
    }

    #[tokio::test]
    async fn legacy_grants_count_from_creation_and_failed_touches_requeue() {
        let (state, path) = temp_state("grant_legacy").await;
        let db = &state.db;
        let t = now();
        let ttl = state.limits.guest_grant_ttl();
        for (grant, created) in [("new", t - 60), ("old", t - ttl - 60)] {
            sqlx::query(
                "INSERT INTO guest_grants(\"grant\", server, created_at) VALUES($1, 'rchat', $2)",
            )
            .bind(secret_key(grant))
            .bind(created)
            .execute(db)
            .await
            .expect("grant");
        }
        assert!(grant_live(db, "new", "rchat").await.expect("new"));
        assert!(!grant_live(db, "old", "rchat").await.expect("old"));
        assert_eq!(
            sweep_stale(db, &state.limits)
                .await
                .expect("sweep")
                .guest_grants,
            1
        );
        assert!(grant_live(db, "new", "rchat").await.expect("kept"));
        queue_grant_touches(db, [secret_key("expired")]);
        sqlx::query("INSERT INTO guest_grants(\"grant\", server, created_at, last_used_at) VALUES($2, 'rchat', 1, $1)")
            .bind(t - ttl - 60)
            .bind(secret_key("expired"))
            .execute(db)
            .await
            .expect("expired grant");
        assert_eq!(flush_grant_touches(db, ttl).await.expect("flush"), 1);
        assert!(
            count(
                db,
                &format!(
                    "SELECT last_used_at FROM guest_grants WHERE \"grant\" = '{}'",
                    secret_key("new")
                )
            )
            .await
                >= t
        );
        assert!(
            count(
                db,
                &format!(
                    "SELECT last_used_at FROM guest_grants WHERE \"grant\" = '{}'",
                    secret_key("expired")
                )
            )
            .await
                < t - ttl
        );
        queue_grant_touches(db, [secret_key("new")]);
        close(db).await;
        assert!(flush_grant_touches(db, ttl).await.is_err());
        assert!(grant_touch_queued(db, &secret_key("new")));
        done(state, path).await;
    }

    #[tokio::test]
    async fn each_state_keeps_its_own_guest_grant_ttl() {
        use crate::api::access::{Proof, ws_server_open};
        use crate::limits::Limits;
        use crate::state::AppState;
        let (state, path) = temp_state("grant_ttl_per_state").await;
        let short = state.clone().with_limits(std::sync::Arc::new(Limits {
            guest_grant_days: 2,
            ..Limits::default()
        }));
        let long = AppState::new(
            state.db.clone(),
            state.hub.clone(),
            None,
            None,
            state.instance.clone(),
        );
        let db = &state.db;
        sqlx::query("UPDATE servers SET password_hash = 'x' WHERE name = 'rchat'")
            .execute(db)
            .await
            .expect("protect");
        let t = now();
        sqlx::query("INSERT INTO guest_grants(\"grant\", server, created_at, last_used_at) VALUES($1, 'rchat', 0, $2)")
            .bind(secret_key("aged"))
            .bind(t - 3 * 86400)
            .execute(db)
            .await
            .expect("grant");
        let aged = vec!["aged".to_string()];
        let (s, l) = (
            short.limits.guest_grant_ttl(),
            long.limits.guest_grant_ttl(),
        );
        assert!(!grants_open(db, &aged, "rchat", s).await.expect("short"));
        assert!(grants_open(db, &aged, "rchat", l).await.expect("long"));
        assert!(
            live_grant_servers(db, &aged, s)
                .await
                .expect("short")
                .is_empty()
        );
        assert_eq!(
            live_grant_servers(db, &aged, l).await.expect("long"),
            ["rchat"]
        );
        let open = |limits: &Limits| {
            let proof = Proof::grants(aged.clone(), limits);
            async move {
                ws_server_open(
                    crate::ws::Layer::for_tests(),
                    db,
                    "rchat",
                    None,
                    false,
                    &proof,
                )
                .await
                .expect("gate")
            }
        };
        assert!(!open(&short.limits).await);
        assert!(open(&long.limits).await);
        queue_grant_touches(db, [secret_key("aged")]);
        assert_eq!(flush_grant_touches(db, s).await.expect("short flush"), 0);
        queue_grant_touches(db, [secret_key("aged")]);
        assert_eq!(flush_grant_touches(db, l).await.expect("long flush"), 1);
        sqlx::query("UPDATE guest_grants SET last_used_at = $1")
            .bind(t - 3 * 86400)
            .execute(db)
            .await
            .expect("age again");
        assert_eq!(
            sweep_stale(db, &long.limits)
                .await
                .expect("long sweep")
                .guest_grants,
            0
        );
        assert_eq!(
            sweep_stale(db, &short.limits)
                .await
                .expect("short sweep")
                .guest_grants,
            1
        );
        done(state, path).await;
    }
}
