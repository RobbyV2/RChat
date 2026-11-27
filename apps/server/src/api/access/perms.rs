use rchat_perms::eval::{self, Channel, Mode, Who};
use rchat_perms::hier::{self, Actor, Rank, Tier};
use rchat_perms::rules::HOSTED;
use rchat_perms::{Mask, delta, masks, registry};
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
    ManageServer = 4096,
    ManageInvites = 8192,
    ManageRoles = 16384,
    AssignRoles = 32768,
    ManageProfiles = 65536,
}

/// Channel moderation bits without a server gate stay out of stored masks.
const UNGATED: Mask = registry::value("PinMessages") | registry::value("BypassSlowmode");
pub const ALL_PERMS: i64 = (masks::MGMT & !UNGATED) as i64;
pub const PRE_DELEGATION_PERMS: i64 = 1023;

/// A client may echo newer bits it read without having controls for them.
/// It can change a delegated permission only when its mask covers that bit.
pub fn update_bits(current: i64, sent: i64, mask: i64) -> i64 {
    delta::update_bits(
        current as Mask,
        sent as Mask,
        mask as Mask,
        PRE_DELEGATION_PERMS as Mask,
        ALL_PERMS as Mask,
    ) as i64
}
/// Every permission before `ManageReports` existed.
pub const PRE_REPORT_PERMS: i64 = 511;

pub fn perm_bits(is_admin: bool, perms: i64, roles: i64) -> i64 {
    let who = match is_admin {
        true => Who::Admin {
            mask: perms as Mask,
            roles: roles as Mask,
        },
        false => Who::Member {
            roles: roles as Mask,
        },
    };
    eval::server_bits(&who, 0, &HOSTED) as i64 & ALL_PERMS
}

fn actor(site_admin: bool, bits: i64) -> Actor<'static> {
    let tier = match site_admin {
        true => Tier::Staff,
        false => Tier::Plain,
    };
    Actor {
        rank: Rank::of(tier),
        bits: bits as Mask,
    }
}

pub fn can_moderate(actor_bits: i64, actor_site_admin: bool, target: i64) -> bool {
    hier::may_moderate(
        &actor(actor_site_admin, actor_bits),
        &actor(false, target),
        0,
        true,
    )
}

pub fn can_grant(actor: i64, actor_site_admin: bool, perms: i64) -> bool {
    delta::check_bits_edit(
        actor as Mask,
        actor_site_admin,
        0,
        (perms & ALL_PERMS) as Mask,
    )
    .is_ok()
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
    let Restrict {
        view: restrict_view,
        send: restrict_send,
    } = restrict;
    let mut roles = Vec::new();
    let mut member = None;
    for row in rows {
        let PermRow {
            subject,
            view,
            send,
            history,
        } = row;
        if subjects.contains(subject) {
            let own = subject.starts_with("u:");
            let (ow, mode) = eval::derived_row(0, 0, Mode::Override, *view, *send, *history, own);
            match (own, member) {
                (true, None) => member = Some((ow, mode)),
                (true, Some(_)) | (false, _) => roles.push(ow),
            }
        }
    }
    let who = Who::Member {
        roles: match manages {
            true => masks::MANAGE_CHANNELS,
            false => 0,
        },
    };
    let channel = Channel {
        everyone: None,
        restrict_view,
        restrict_send,
        voice: false,
        roles: &roles,
        member,
    };
    let mask = eval::channel_mask(
        &who,
        eval::DEFAULT_EVERYONE,
        &channel,
        false,
        false,
        &HOSTED,
    );
    ChannelAccess {
        view: mask & masks::VIEW != 0,
        send: mask & masks::SEND != 0,
        history: mask & masks::HISTORY != 0,
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
    fn permissions_follow_the_shared_registry() {
        let all = [
            Perm::ManageChannels,
            Perm::DeleteMessages,
            Perm::Kick,
            Perm::DeleteServer,
            Perm::ManageAdmins,
            Perm::MentionEveryone,
            Perm::ViewAuditLog,
            Perm::TimeoutMembers,
            Perm::ManageWebhooks,
            Perm::ManageReports,
            Perm::ManageServer,
            Perm::ManageInvites,
            Perm::ManageRoles,
            Perm::AssignRoles,
            Perm::ManageProfiles,
        ];
        for perm in all {
            let name = format!("{perm:?}");
            let bit = registry::BITS
                .iter()
                .find(|b| b.name == name)
                .unwrap_or_else(|| panic!("{name} is not in the registry"));
            assert_eq!(bit.value, perm as Mask, "{name}");
            assert_eq!(bit.hosted, registry::State::Live, "{name}");
        }
        assert_eq!(all.iter().fold(0, |m, p| m | *p as i64), ALL_PERMS);
    }

    #[test]
    fn stored_masks_keep_the_gated_management_bits() {
        assert_eq!(ALL_PERMS, 127999);
        assert_eq!(perm_bits(true, 0, 5), ALL_PERMS);
        assert_eq!(perm_bits(true, 4 | 1024 | 1 << 17, 1), 4);
        assert_eq!(perm_bits(false, 4, 1 | 2048 | 1 << 29), 1);
        assert_eq!(perm_bits(false, 0, -1), ALL_PERMS);
        assert_eq!(update_bits(1 | 4 | 4096, 4096 | 8192 | 2, 8192), 12295);
        assert_eq!(update_bits(0, -1, 0), PRE_DELEGATION_PERMS);
        assert_eq!(update_bits(-1, 0, 0), ALL_PERMS);
        assert_eq!(update_bits(-1, 0, -1), 0);
        assert!(can_grant(4, false, 4 | 1024) && !can_grant(4, false, 5));
        assert!(can_grant(0, true, ALL_PERMS));
    }

    #[test]
    fn channel_access_is_the_union_of_matching_rules() {
        let subjects = ["u:a".to_string(), "r:1".to_string(), "r:2".to_string()];
        let names = ["u:a", "r:1", "r:2", "u:b", "r:3"];
        for bits in 0u32..1 << 12 {
            let rows: Vec<PermRow> = (0..3)
                .filter(|i| bits >> (i * 4) & 1 != 0)
                .map(|i| PermRow {
                    subject: names[(i + (bits as usize >> 11) * 3) % 5].to_string(),
                    view: bits >> (i * 4 + 1) & 1 != 0,
                    send: bits >> (i * 4 + 2) & 1 != 0,
                    history: bits >> (i * 4 + 3) & 1 != 0,
                })
                .collect();
            for flags in 0..8 {
                let restrict = Restrict {
                    view: flags & 1 != 0,
                    send: flags & 2 != 0,
                };
                let manages = flags & 4 != 0;
                let matching: Vec<&PermRow> = rows
                    .iter()
                    .filter(|r| subjects.contains(&r.subject))
                    .collect();
                let any = |f: fn(&PermRow) -> bool, open: bool| match matching.is_empty() {
                    true => open,
                    false => matching.iter().any(|r| f(r)),
                };
                let view = manages || any(|r| r.view, !restrict.view);
                let want = [
                    view,
                    view && (manages || any(|r| r.send, !restrict.send)),
                    view && (manages || any(|r| r.history, true)),
                ];
                let ChannelAccess {
                    view,
                    send,
                    history,
                } = fold_access(&rows, &subjects, manages, restrict);
                assert_eq!([view, send, history], want, "{bits} {flags}");
            }
        }
    }

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
