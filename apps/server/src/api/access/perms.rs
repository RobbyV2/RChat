use serde::{Deserialize, Serialize};
use sqlx::Row;
use sqlx::any::AnyRow;

use crate::db::Db;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Perm {
    ManageChannels = 1,
    DeleteMessages = 2,
    Kick = 4,
    DeleteServer = 8,
    ManageAdmins = 16,
    MentionEveryone = 32,
    ViewAuditLog = 64,
    TimeoutMembers = 128,
    ManageWebhooks = 256,
    ManageReports = 512,
}

pub const ALL_PERMS: i64 = 1023;
/// Every permission before `ManageReports` existed.
pub const PRE_REPORT_PERMS: i64 = 511;

pub fn perm_bits(is_admin: bool, perms: i64, roles: i64) -> i64 {
    match (is_admin, perms) {
        (true, 0) => ALL_PERMS,
        (true, p) => p & ALL_PERMS,
        (false, _) => roles & ALL_PERMS,
    }
}

pub fn can_moderate(actor: i64, actor_site_admin: bool, target: i64) -> bool {
    actor_site_admin || ((target & !actor) == 0 && target != actor)
}

pub fn can_grant(actor: i64, actor_site_admin: bool, perms: i64) -> bool {
    actor_site_admin || (perms & ALL_PERMS & !actor) == 0
}

#[derive(Clone, Copy)]
pub struct ChannelAccess {
    pub view: bool,
    pub send: bool,
    pub history: bool,
}

impl ChannelAccess {
    pub fn all(v: bool) -> ChannelAccess {
        ChannelAccess {
            view: v,
            send: v,
            history: v,
        }
    }
}

pub async fn perm_subjects(
    db: &Db,
    server: Option<&str>,
    username: &str,
) -> sqlx::Result<Vec<String>> {
    let rows = match server {
        Some(server) => {
            sqlx::query("SELECT role_id FROM user_roles WHERE server = $1 AND username = $2")
                .bind(server)
                .bind(username)
                .fetch_all(db)
                .await?
        }
        None => {
            sqlx::query("SELECT role_id FROM user_roles WHERE username = $1")
                .bind(username)
                .fetch_all(db)
                .await?
        }
    };
    let mut subjects = Vec::with_capacity(rows.len() + 1);
    subjects.push(format!("u:{username}"));
    for r in &rows {
        subjects.push(format!("r:{}", r.try_get::<i64, _>(0)?));
    }
    Ok(subjects)
}

/// The roles `username` holds in the servers they are in, as (server, role name).
pub async fn held_roles(db: &Db, username: &str) -> sqlx::Result<Vec<(String, String)>> {
    sqlx::query(
        "SELECT r.server, r.name FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.username = $1",
    )
    .bind(username)
    .fetch_all(db)
    .await?
    .iter()
    .map(|r| Ok((r.try_get(0)?, r.try_get(1)?)))
    .collect()
}

/// Whether the live server `server` has a role named `name`.
pub async fn role_named<'e, E>(ex: E, server: &str, name: &str) -> sqlx::Result<bool>
where
    E: sqlx::Executor<'e, Database = sqlx::Any>,
{
    Ok(sqlx::query(
        "SELECT 1 FROM roles r JOIN servers s ON s.name = r.server WHERE r.server = $1 AND r.name = $2 AND COALESCE(s.password_hash, '') <> '!purging' LIMIT 1",
    )
    .bind(server)
    .bind(name)
    .fetch_optional(ex)
    .await?
    .is_some())
}

#[derive(Clone, Serialize, Deserialize)]
pub struct PermRow {
    pub subject: String,
    pub view: bool,
    pub send: bool,
    pub history: bool,
}

pub fn perm_row(r: &AnyRow, at: usize) -> sqlx::Result<PermRow> {
    Ok(PermRow {
        subject: r.try_get(at)?,
        view: r.try_get::<i64, _>(at + 1)? != 0,
        send: r.try_get::<i64, _>(at + 2)? != 0,
        history: r.try_get::<i64, _>(at + 3)? != 0,
    })
}

/// Which actions of a channel need an explicit allow from one of its rules (`restrict_view`,
/// `restrict_send`).
#[derive(Clone, Copy, Default, PartialEq, Eq, Debug, Serialize, Deserialize)]
pub struct Restrict {
    pub view: bool,
    pub send: bool,
}

impl Restrict {
    pub fn read(r: &AnyRow, at: usize) -> sqlx::Result<Restrict> {
        Ok(Restrict {
            view: r.try_get::<i64, _>(at)? != 0,
            send: r.try_get::<i64, _>(at + 1)? != 0,
        })
    }
}

/// The channel rule: managers pass. Otherwise each action is allowed by any rule matching one of
/// `subjects` that allows it; without a matching rule, actions are allowed unless the channel
/// restricts them (history only follows view). No view means nothing.
pub fn fold_access<'a>(
    rows: impl IntoIterator<Item = &'a PermRow>,
    subjects: &[String],
    manages: bool,
    restrict: Restrict,
) -> ChannelAccess {
    if manages {
        return ChannelAccess::all(true);
    }
    let mut matched = false;
    let mut acc = ChannelAccess::all(false);
    for row in rows {
        let PermRow {
            subject,
            view,
            send,
            history,
        } = row;
        if subjects.contains(subject) {
            matched = true;
            acc.view |= *view;
            acc.send |= *send;
            acc.history |= *history;
        }
    }
    let Restrict {
        view: restrict_view,
        send: restrict_send,
    } = restrict;
    let acc = match matched {
        true => acc,
        false => ChannelAccess {
            view: !restrict_view,
            send: !restrict_send,
            history: true,
        },
    };
    match acc.view {
        true => acc,
        false => ChannelAccess::all(false),
    }
}

/// Whether taking `rule` away from a member can widen their access: for a member it was the only
/// match for, it allows less than a member matching no rule gets in that channel. Deleting or
/// unassigning a role with such a rule needs Manage channels.
pub fn rule_narrows(rule: &PermRow, restrict: Restrict) -> bool {
    let subject = [rule.subject.clone()];
    let ChannelAccess {
        view,
        send,
        history,
    } = fold_access([rule], &subject, false, restrict);
    let open = fold_access([], &subject, false, restrict);
    (open.view && !view) || (open.send && !send) || (open.history && !history)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn moderation_needs_a_strict_superset() {
        let kick = Perm::Kick as i64;
        let channels = Perm::ManageChannels as i64;
        let cases: [(i64, bool, i64, bool); 9] = [
            (kick, false, 0, true),
            (kick, false, kick, false),
            (kick, false, ALL_PERMS, false),
            (kick, false, channels, false),
            (kick | channels, false, channels, true),
            (kick | channels, false, kick, true),
            (ALL_PERMS, false, ALL_PERMS, false),
            (ALL_PERMS, false, ALL_PERMS & !channels, true),
            (ALL_PERMS, true, ALL_PERMS, true),
        ];
        for (actor, site_admin, target, expected) in cases {
            assert_eq!(
                can_moderate(actor, site_admin, target),
                expected,
                "actor {actor} site admin {site_admin} target {target}"
            );
        }
    }
}
