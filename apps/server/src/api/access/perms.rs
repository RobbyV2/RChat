use rchat_perms::eval::{self, Channel, Mode, Ow, Who};
use rchat_perms::hier::{self, Actor, Rank, Tier};
use rchat_perms::rules::HOSTED;
use rchat_perms::{Mask, delta, masks};
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
    PinMessages = 1 << 29,
    BypassSlowmode = 1 << 30,
}

pub const ALL_PERMS: i64 = masks::MGMT as i64;
/// Every permission before `PinMessages` and `BypassSlowmode` existed.
pub const PRE_SPLIT_PERMS: i64 = 127999;
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
/// `update_bits` for a role, which may also hold the bits of everyone.
pub fn update_role_bits(current: i64, sent: i64, mask: i64) -> i64 {
    delta::update_bits(
        current as Mask,
        sent as Mask,
        mask as Mask,
        PRE_DELEGATION_PERMS as Mask,
        ROLE_BITS as Mask,
    ) as i64
}
/// Every permission before `ManageReports` existed.
pub const PRE_REPORT_PERMS: i64 = 511;

pub fn perm_bits(is_admin: bool, perms: i64, roles: i64) -> i64 {
    eval::server_bits(&member_who(is_admin, perms, roles), 0, &HOSTED) as i64 & ALL_PERMS
}

/// A member as the evaluator reads them: an admin with its mask, or the union of their roles.
pub fn member_who(is_admin: bool, perms: i64, roles: i64) -> Who {
    match is_admin {
        true => Who::Admin {
            mask: perms as Mask,
            roles: roles as Mask,
        },
        false => Who::Member {
            roles: roles as Mask,
        },
    }
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

/// The channel permissions the gates ask for.
pub mod held {
    use rchat_perms::{Mask, registry::value};

    pub const DELETE: Mask = value("DeleteMessages");
    pub const MENTION: Mask = value("MentionEveryone");
    pub const REACT: Mask = value("AddReactions");
    pub const ATTACH: Mask = value("AttachFiles");
    pub const EMBED: Mask = value("EmbedLinks");
    pub const POLLS: Mask = value("CreatePolls");
    pub const THREADS: Mask = value("StartThreads");
    pub const CONNECT: Mask = value("Connect");
    pub const SPEAK: Mask = value("Speak");
    pub const VIDEO: Mask = value("Video");
    pub const PIN: Mask = value("PinMessages");
    pub const BYPASS_SLOWMODE: Mask = value("BypassSlowmode");
}

/// What a viewer holds in a channel: `mask`, and its View, Send and Read history bits.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ChannelAccess {
    pub view: bool,
    pub send: bool,
    pub history: bool,
    pub mask: i64,
}

impl ChannelAccess {
    pub fn of(mask: Mask) -> ChannelAccess {
        ChannelAccess {
            view: mask & masks::VIEW != 0,
            send: mask & masks::SEND != 0,
            history: mask & masks::HISTORY != 0,
            mask: mask as i64,
        }
    }

    /// Whether the viewer holds every one of `bits` here.
    pub fn holds(&self, bits: Mask) -> bool {
        self.mask as Mask & bits == bits
    }
}

/// The subject of the rule for everyone in the server.
pub const EVERYONE: &str = "everyone";

/// The bits @everyone may hold.
pub const EVERYONE_BITS: i64 = masks::BASE as i64;
/// The bits a role may hold.
pub const ROLE_BITS: i64 = ALL_PERMS | EVERYONE_BITS;

/// What someone who is not a member may hold at most in a channel. Whether a guest may send or
/// join voice at all is `ResolvedChannel::guest_participation`.
pub const VISITOR_CAPS: Mask = masks::READ_LINK | masks::GUEST_CHAT | masks::GUEST_VOICE;

/// The @everyone mask of a server from its stored `everyone_perms`.
pub fn everyone_mask(stored: Option<i64>) -> Mask {
    match stored {
        Some(bits) => bits as Mask,
        None => eval::DEFAULT_EVERYONE,
    }
}

/// Who a viewer is in a server, and the rule subjects that match them there.
#[derive(Clone, Debug)]
pub struct Standing {
    pub who: Who,
    pub subjects: Vec<String>,
}

impl Standing {
    /// Someone who is not a member: a guest, or the account `user`.
    pub fn visitor(user: Option<&str>, caps: Mask) -> Standing {
        Standing {
            who: Who::Visitor {
                signed_in: user.is_some(),
                caps,
            },
            subjects: user.map(|name| format!("u:{name}")).into_iter().collect(),
        }
    }

    pub fn manages_channels(&self, everyone: Mask) -> bool {
        eval::server_bits(&self.who, everyone, &HOSTED) & masks::MANAGE_CHANNELS != 0
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

/// A channel rule as stored. A rule with both masks 0 is read from its three flags.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PermRow {
    pub subject: String,
    pub view: bool,
    pub send: bool,
    pub history: bool,
    #[serde(default)]
    pub allow: i64,
    #[serde(default)]
    pub deny: i64,
    #[serde(default)]
    pub merge: bool,
}

impl PermRow {
    pub fn evaluated(&self) -> (Ow, Mode) {
        let PermRow {
            subject,
            view,
            send,
            history,
            allow,
            deny,
            merge,
        } = self;
        let mode = match merge {
            true => Mode::Merge,
            false => Mode::Override,
        };
        eval::derived_row(
            *allow as Mask,
            *deny as Mask,
            mode,
            *view,
            *send,
            *history,
            subject.starts_with("u:"),
        )
    }
}

/// The columns `perm_row` reads, of the `channel_perms` table named `alias`.
pub fn perm_columns(alias: &str) -> String {
    [
        "subject",
        "can_view",
        "can_send",
        "can_read_history",
        "allow",
        "deny",
        "mode",
    ]
    .map(|c| format!("{alias}.{c}"))
    .join(", ")
}

pub fn perm_row(r: &AnyRow, at: usize) -> sqlx::Result<PermRow> {
    Ok(PermRow {
        subject: r.try_get(at)?,
        view: r.try_get::<i64, _>(at + 1)? != 0,
        send: r.try_get::<i64, _>(at + 2)? != 0,
        history: r.try_get::<i64, _>(at + 3)? != 0,
        allow: r.try_get(at + 4)?,
        deny: r.try_get(at + 5)?,
        merge: r.try_get::<String, _>(at + 6)? == "merge",
    })
}

/// The permissions behind each flag of a rule: view, send and read history.
const FLAG_BITS: [Mask; 3] = [masks::VIEW, masks::SEND_GROUP, masks::HISTORY];

/// The three flags a rule with these masks stores, so a reader of the flags alone stays close.
pub fn row_flags(allow: i64, deny: i64) -> [bool; 3] {
    let (allow, deny) = (allow as Mask, deny as Mask);
    FLAG_BITS.map(|bits| allow & bits != 0 || deny & bits == 0)
}

/// The masks of a rule after its flags change from `was` to `now`: a flag turned on allows its
/// permissions, one turned off denies them, and every other bit stays.
pub fn reflag(allow: i64, deny: i64, was: [bool; 3], now: [bool; 3]) -> (i64, i64) {
    FLAG_BITS.into_iter().zip(was.into_iter().zip(now)).fold(
        (allow, deny),
        |(allow, deny), (bits, change)| {
            let bits = bits as i64;
            match change {
                (false, true) => (allow | bits, deny & !bits),
                (true, false) => (allow & !bits, deny | bits),
                (true, true) | (false, false) => (allow, deny),
            }
        },
    )
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

/// The rules of one channel as the evaluator reads them for `standing`.
fn channel_of<'a>(
    rows: impl IntoIterator<Item = &'a PermRow>,
    standing: &Standing,
) -> (Option<Ow>, Vec<Ow>, Option<(Ow, Mode)>) {
    let (mut everyone, mut roles, mut member) = (None, Vec::new(), None);
    for row in rows {
        let subject = row.subject.as_str();
        match (
            subject == EVERYONE,
            standing.subjects.iter().any(|s| s == subject),
        ) {
            (true, _) => everyone = Some(row.evaluated().0),
            (false, true) if subject.starts_with("u:") => member = Some(row.evaluated()),
            (false, true) => roles.push(row.evaluated().0),
            (false, false) => {}
        }
    }
    (everyone, roles, member)
}

/// What `standing` holds in a channel with these rules. `timed_out` is for acting while timed
/// out; reads pass false.
pub fn channel_mask<'a>(
    rows: impl IntoIterator<Item = &'a PermRow>,
    standing: &Standing,
    everyone: Mask,
    restrict: Restrict,
    voice: bool,
    timed_out: bool,
) -> Mask {
    let Restrict {
        view: restrict_view,
        send: restrict_send,
    } = restrict;
    let (ev, roles, member) = channel_of(rows, standing);
    let channel = Channel {
        everyone: ev,
        restrict_view,
        restrict_send,
        voice,
        roles: &roles,
        member,
    };
    eval::channel_mask(&standing.who, everyone, &channel, timed_out, true, &HOSTED)
}

/// Whether taking `rule` away from a member can widen their access: it denies something the
/// channel (with all its `rows`) gives everyone who views it. Deleting or unassigning a role
/// with such a rule needs Manage channels.
pub fn rule_narrows<'a>(
    rule: &PermRow,
    rows: impl IntoIterator<Item = &'a PermRow>,
    everyone: Mask,
    restrict: Restrict,
) -> bool {
    let Restrict {
        view: restrict_view,
        send: restrict_send,
    } = restrict;
    let rows: Vec<&PermRow> = rows.into_iter().collect();
    let others: Vec<Ow> = rows
        .iter()
        .filter(|r| r.subject != EVERYONE && r.subject != rule.subject)
        .map(|r| r.evaluated().0)
        .collect();
    let (ev, _, _) = channel_of(rows, &Standing::visitor(None, 0));
    let channel = Channel {
        everyone: ev,
        restrict_view,
        restrict_send,
        voice: false,
        roles: &[],
        member: None,
    };
    eval::narrows(rule.evaluated().0, &others, everyone, &channel, &HOSTED)
}

/// The allow-list reading of rules stored with flags only, the model they are checked against:
/// managers pass. Otherwise each action is allowed by any rule matching one of `subjects` that
/// allows it; without a matching rule, actions are allowed unless the channel restricts them
/// (history only follows view). No view means nothing. The answer is (view, send, history).
#[cfg(test)]
pub(crate) fn allow_lists(
    rows: &[PermRow],
    subjects: &[String],
    manages: bool,
    restrict: Restrict,
) -> [bool; 3] {
    let matching: Vec<&PermRow> = rows
        .iter()
        .filter(|r| subjects.contains(&r.subject))
        .collect();
    let any = |f: fn(&PermRow) -> bool, open: bool| match matching.is_empty() {
        true => open,
        false => matching.iter().any(|r| f(r)),
    };
    let view = manages || any(|r| r.view, !restrict.view);
    [
        view,
        view && (manages || any(|r| r.send, !restrict.send)),
        view && (manages || any(|r| r.history, true)),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use rchat_perms::registry;

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
            Perm::PinMessages,
            Perm::BypassSlowmode,
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
        let split = Perm::PinMessages as i64 | Perm::BypassSlowmode as i64;
        assert_eq!(ALL_PERMS, PRE_SPLIT_PERMS | split);
        assert_eq!(perm_bits(true, 0, 5), ALL_PERMS);
        assert_eq!(perm_bits(true, 4 | 1024 | 1 << 17, 1), 4);
        assert_eq!(perm_bits(false, 4, 1 | 2048 | 1 << 29), 1 | 1 << 29);
        assert_eq!(perm_bits(false, 0, -1), ALL_PERMS);
        assert_eq!(update_bits(1 | 4 | 4096, 4096 | 8192 | 2, 8192), 12295);
        assert_eq!(update_bits(0, -1, 0), PRE_DELEGATION_PERMS);
        assert_eq!(update_bits(-1, 0, 0), ALL_PERMS);
        assert_eq!(update_bits(-1, 0, -1), 0);
        assert!(can_grant(4, false, 4 | 1024) && !can_grant(4, false, 5));
        assert!(can_grant(0, true, ALL_PERMS));
    }

    fn flag_row(subject: &str, flags: u32) -> PermRow {
        PermRow {
            subject: subject.to_string(),
            view: flags & 1 != 0,
            send: flags & 2 != 0,
            history: flags & 4 != 0,
            allow: 0,
            deny: 0,
            merge: false,
        }
    }

    #[test]
    fn derived_rules_match_allow_lists() {
        let names = ["r:1", "r:2", "r:3", "u:a"];
        let open = masks::BASE & masks::CHANNEL;
        let mut evaluations = 0;
        for world in 0..9u32.pow(4) {
            let rows: Vec<PermRow> = (0..4)
                .filter_map(|i| match world / 9u32.pow(i) % 9 {
                    0 => None,
                    flags => Some(flag_row(names[i as usize], flags - 1)),
                })
                .collect();
            for flags in 0..4 {
                let restrict = Restrict {
                    view: flags & 1 != 0,
                    send: flags & 2 != 0,
                };
                for held in 0..9u32 {
                    let member = held < 8;
                    let mut subjects = vec!["u:a".to_string()];
                    subjects.extend(
                        (0..3)
                            .filter(|i| member && held >> i & 1 != 0)
                            .map(|i| names[i].to_string()),
                    );
                    let standing = match member {
                        true => Standing {
                            who: Who::Member { roles: 0 },
                            subjects: subjects.clone(),
                        },
                        false => Standing::visitor(Some("a"), open),
                    };
                    let mask = channel_mask(
                        &rows,
                        &standing,
                        eval::DEFAULT_EVERYONE,
                        restrict,
                        false,
                        false,
                    );
                    let ChannelAccess {
                        view,
                        send,
                        history,
                        mask: _,
                    } = ChannelAccess::of(mask);
                    let want = allow_lists(&rows, &subjects, false, restrict);
                    assert_eq!([view, send, history], want, "{world} {flags} {held}");
                    let group = mask & masks::SEND_GROUP;
                    assert!(group == 0 || group == masks::SEND_GROUP);
                    if member {
                        assert_eq!(mask & masks::VOICE == masks::VOICE, view);
                    }
                    evaluations += 1;
                }
            }
        }
        assert_eq!(evaluations, 236_196);
        let manager = Standing {
            who: Who::Member {
                roles: masks::MANAGE_CHANNELS,
            },
            subjects: vec!["u:a".to_string()],
        };
        let shut = Restrict {
            view: true,
            send: true,
        };
        let rows = [flag_row("u:a", 0)];
        let mask = channel_mask(&rows, &manager, eval::DEFAULT_EVERYONE, shut, false, false);
        assert_eq!(mask, masks::MANAGER_PASS);
        assert_eq!(allow_lists(&rows, &manager.subjects, true, shut), [true; 3]);
    }

    #[test]
    fn rules_narrow_when_they_deny_what_everyone_gets() {
        let open = Restrict::default();
        let private = Restrict {
            view: true,
            send: false,
        };
        let everyone = eval::DEFAULT_EVERYONE;
        let quiet = flag_row("r:1", 1 | 4);
        assert!(rule_narrows(&quiet, [], everyone, open));
        assert!(!rule_narrows(&flag_row("r:1", 7), [], everyone, open));
        let hidden = flag_row("r:1", 2 | 4);
        assert!(rule_narrows(&hidden, [], everyone, open));
        assert!(!rule_narrows(&hidden, [], everyone, private));
        let deny_send = PermRow {
            deny: masks::SEND as i64,
            ..flag_row("r:1", 7)
        };
        assert!(rule_narrows(&deny_send, [], everyone, open));
        assert!(!rule_narrows(&deny_send, [], everyone & !masks::SEND, open));
        let ev = PermRow {
            deny: masks::SEND as i64,
            ..flag_row(EVERYONE, 7)
        };
        assert!(!rule_narrows(&deny_send, [&ev], everyone, open));
        let allow_only = PermRow {
            allow: masks::VIEW as i64,
            ..flag_row("r:2", 0)
        };
        assert!(!rule_narrows(&allow_only, [], everyone, open));
        assert!(!rule_narrows(&deny_send, [], everyone, private));
        assert!(
            rule_narrows(&deny_send, [&allow_only], everyone, private),
            "another rule lets a member in, and this one holds them back there"
        );
        let with_flags = flag_row("r:2", 1 | 4);
        assert!(
            !rule_narrows(&deny_send, [&with_flags], everyone, private),
            "the rule that lets them in denies it too"
        );
    }

    #[test]
    fn mask_writes_keep_close_flags() {
        let (v, s, h) = (
            masks::VIEW as i64,
            masks::SEND as i64,
            masks::HISTORY as i64,
        );
        assert_eq!(row_flags(v, 0), [true, true, true]);
        assert_eq!(row_flags(v, s | h), [true, false, false]);
        assert_eq!(row_flags(0, v), [false, true, true]);
        assert_eq!(
            row_flags(s, masks::SEND_GROUP as i64 & !s),
            [true, true, true]
        );
    }

    #[test]
    fn a_changed_flag_moves_only_its_permissions() {
        let group = masks::SEND_GROUP as i64;
        let (v, mention, attach) = (
            masks::VIEW as i64,
            Perm::MentionEveryone as i64,
            registry::value("AttachFiles") as i64,
        );
        let (on, off) = ([true; 3], [false, true, true]);
        assert_eq!(reflag(0, mention, on, off), (0, mention | v));
        assert_eq!(reflag(v, mention, on, off), (0, mention | v));
        assert_eq!(reflag(0, attach, [true, false, true], on), (group, 0));
        assert_eq!(
            reflag(mention, attach, [true, false, true], [true, false, false]),
            (mention, attach | masks::HISTORY as i64)
        );
        assert_eq!(reflag(mention, v, off, off), (mention, v));
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
