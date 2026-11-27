use std::collections::HashMap;

use rchat_perms::Mask;
use rchat_perms::hier::{Rank, Tie, Tier};
use sqlx::Row;

use super::perms::perm_bits;

/// A role's place in the order: its position, and among roles at one position the older one
/// first.
pub fn role_rank(position: i64, id: i64) -> Rank<'static> {
    Rank {
        tier: Tier::Role,
        pos: position,
        tie: Tie::Int(-id),
        admin_mask: 0,
    }
}

/// A member's place: an admin with every permission is an owner, another admin ranks by its
/// permission set, anyone else by the highest role held (`top`, its position and id).
pub fn member_rank(is_admin: bool, perms: i64, top: Option<(i64, i64)>) -> Rank<'static> {
    match (is_admin, perms, top) {
        (true, 0, _) => Rank::of(Tier::Owner),
        (true, mask, _) => Rank {
            admin_mask: perm_bits(true, mask, 0) as Mask,
            ..Rank::of(Tier::Admin)
        },
        (false, _, Some((position, id))) => role_rank(position, id),
        (false, _, None) => Rank::of(Tier::Plain),
    }
}

fn higher(a: Option<(i64, i64)>, b: (i64, i64)) -> (i64, i64) {
    match a {
        Some(a) if (a.0, -a.1) >= (b.0, -b.1) => a,
        Some(_) | None => b,
    }
}

/// The rank of `username` in `server`: outside it for someone who is not a member.
pub(crate) async fn rank_in(
    conn: &mut sqlx::AnyConnection,
    server: &str,
    username: &str,
) -> sqlx::Result<Rank<'static>> {
    let Some((is_admin, perms)) = super::member_role(&mut *conn, server, username).await? else {
        return Ok(Rank::of(Tier::Outside));
    };
    let top = sqlx::query("SELECT r.position, r.id FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.server = $1 AND ur.username = $2 ORDER BY r.position DESC, r.id LIMIT 1")
        .bind(server)
        .bind(username)
        .fetch_optional(&mut *conn)
        .await?;
    let top = match top {
        Some(r) => Some((r.try_get(0)?, r.try_get(1)?)),
        None => None,
    };
    Ok(member_rank(is_admin, perms, top))
}

/// The rank of each of `names` in `server`.
pub(crate) async fn ranks_in(
    conn: &mut sqlx::AnyConnection,
    server: &str,
    names: &[String],
) -> sqlx::Result<HashMap<String, Rank<'static>>> {
    let mut out = HashMap::new();
    for chunk in names.chunks(500) {
        let list = crate::api::placeholders(2, chunk.len());
        let mut members = sqlx::query(sqlx::AssertSqlSafe(format!(
            "SELECT username, is_admin, perms FROM members WHERE server = $1 AND username IN ({list})"
        )))
        .bind(server);
        let mut held = sqlx::query(sqlx::AssertSqlSafe(format!(
            "SELECT ur.username, r.position, r.id FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.server = $1 AND ur.username IN ({list})"
        )))
        .bind(server);
        for name in chunk {
            members = members.bind(name);
            held = held.bind(name);
        }
        let mut tops: HashMap<String, (i64, i64)> = HashMap::new();
        for r in &held.fetch_all(&mut *conn).await? {
            let name: String = r.try_get(0)?;
            let role = (r.try_get(1)?, r.try_get(2)?);
            let top = higher(tops.get(&name).copied(), role);
            tops.insert(name, top);
        }
        for r in &members.fetch_all(&mut *conn).await? {
            let name: String = r.try_get(0)?;
            let rank = member_rank(
                r.try_get::<i64, _>(1)? != 0,
                r.try_get(2)?,
                tops.get(&name).copied(),
            );
            out.insert(name, rank);
        }
    }
    for name in names {
        out.entry(name.clone()).or_insert(Rank::of(Tier::Outside));
    }
    Ok(out)
}

/// The rank of role `id` of `server`, `None` when the server has no such role.
pub(crate) async fn role_rank_in<'e, E>(
    ex: E,
    server: &str,
    id: i64,
) -> sqlx::Result<Option<Rank<'static>>>
where
    E: sqlx::Executor<'e, Database = sqlx::Any>,
{
    let row = sqlx::query("SELECT position FROM roles WHERE id = $1 AND server = $2")
        .bind(id)
        .bind(server)
        .fetch_optional(ex)
        .await?;
    Ok(match row {
        Some(r) => Some(role_rank(r.try_get(0)?, id)),
        None => None,
    })
}

/// Whether the order guard is on in `server`: the order of its roles has not been confirmed, so
/// moderation compares permission sets and role management also asks who holds the role.
pub(crate) async fn guard_in<'e, E>(ex: E, server: &str) -> sqlx::Result<bool>
where
    E: sqlx::Executor<'e, Database = sqlx::Any>,
{
    let row = sqlx::query("SELECT roles_order_confirmed FROM servers WHERE name = $1")
        .bind(server)
        .fetch_optional(ex)
        .await?;
    Ok(match row {
        Some(r) => r.try_get::<i64, _>(0)? == 0,
        None => false,
    })
}
