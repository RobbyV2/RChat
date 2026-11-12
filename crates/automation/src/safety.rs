//! Staff safety's guard rails: what its counter counts, who may change locked automations, and
//! the quarantine snapshot.

use crate::onboarding::Gate;
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StaffAction {
    Ban,
    Kick,
    ChannelDelete,
    RoleDelete,
    Other,
}

/// An audit entry as the counter reads it. `actor` is a username, `@auto:<id>` or `staff`;
/// `target_joined_at` is when a banned or kicked member joined the server.
#[derive(Clone, PartialEq, Eq, Debug, Serialize, Deserialize)]
pub struct AuditEntry {
    pub actor: String,
    pub action: StaffAction,
    pub automation_id: Option<i64>,
    pub target_joined_at: Option<i64>,
    pub at: i64,
}

pub const NEW_MEMBER_SECS: i64 = 24 * 3600;

/// The entries the staff-action rate counts for `actor`: never instance staff, never an
/// automation's, never bans or kicks of members who joined in the last 24 h or inside an open
/// raid window.
pub fn counted<'a>(
    entries: &'a [AuditEntry],
    actor: &str,
    raid_until: Option<i64>,
) -> Vec<&'a AuditEntry> {
    entries
        .iter()
        .filter(|e| {
            e.actor == actor
                && e.actor != "staff"
                && !e.actor.starts_with("@auto:")
                && e.automation_id.is_none()
        })
        .filter(|e| match e.action {
            StaffAction::Ban | StaffAction::Kick => {
                !e.target_joined_at
                    .is_some_and(|joined| e.at - joined < NEW_MEMBER_SECS)
                    && !raid_until.is_some_and(|until| e.at <= until)
            }
            StaffAction::ChannelDelete | StaffAction::RoleDelete => true,
            StaffAction::Other => false,
        })
        .collect()
}

pub fn trips(
    entries: &[AuditEntry],
    actor: &str,
    raid_until: Option<i64>,
    count: usize,
    window_secs: i64,
    now: i64,
) -> bool {
    counted(entries, actor, raid_until)
        .iter()
        .filter(|e| now - e.at <= window_secs)
        .count()
        > count
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Server {
    pub creator: Option<String>,
}

/// Who holds the creator's powers over locked and safety automations: the creator, or members
/// with Delete server when there is none.
pub fn creator_power(server: &Server, who: &str, holds_delete_server: bool) -> bool {
    match &server.creator {
        Some(creator) => creator == who,
        None => holds_delete_server,
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Auto {
    pub id: i64,
    pub locked: bool,
    pub safety: bool,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Edit {
    Create,
    Edit,
    Disable,
    Delete,
    Takeover,
    SetLock,
}

pub fn may_change(
    a: &Auto,
    op: Edit,
    server: &Server,
    who: &str,
    holds_delete_server: bool,
    has_needs: bool,
) -> bool {
    match op == Edit::SetLock || a.locked || a.safety {
        true => creator_power(server, who, holds_delete_server) && has_needs,
        false => has_needs,
    }
}

/// The automations "Pause all" pauses: never a locked one.
pub fn pause_all(autos: &[Auto]) -> Vec<i64> {
    autos.iter().filter(|a| !a.locked).map(|a| a.id).collect()
}

pub fn may_quarantine(server: &Server, owner: &str, target: &str) -> bool {
    target != owner && server.creator.as_deref() != Some(target)
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Standing {
    pub is_admin: bool,
    pub perms: u32,
    pub roles: Vec<i64>,
    pub gate: Gate,
}

/// What a quarantine took, stored in `member_onboarding.hold_snapshot`.
#[derive(Clone, PartialEq, Eq, Debug, Serialize, Deserialize)]
pub struct Snapshot {
    pub is_admin: bool,
    pub perms: u32,
    pub roles: Vec<i64>,
}

pub fn quarantine(m: &Standing) -> (Snapshot, Standing) {
    let snapshot = Snapshot {
        is_admin: m.is_admin,
        perms: m.perms,
        roles: m.roles.clone(),
    };
    let after = Standing {
        is_admin: false,
        perms: 0,
        roles: Vec::new(),
        gate: Gate::Held,
    };
    (snapshot, after)
}

pub fn restore(s: &Snapshot) -> Standing {
    Standing {
        is_admin: s.is_admin,
        perms: s.perms,
        roles: s.roles.clone(),
        gate: Gate::In,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 100_000;

    fn entry() -> AuditEntry {
        AuditEntry {
            actor: "alice".into(),
            action: StaffAction::Ban,
            automation_id: None,
            target_joined_at: Some(0),
            at: NOW - 10,
        }
    }

    fn server(creator: Option<&str>) -> Server {
        Server {
            creator: creator.map(str::to_string),
        }
    }

    #[test]
    fn a_honeypot_banning_20_raiders_never_counts_against_its_owner() {
        let entries: Vec<AuditEntry> = (0..20)
            .map(|_| AuditEntry {
                actor: "@auto:7".into(),
                automation_id: Some(7),
                ..entry()
            })
            .collect();
        assert!(counted(&entries, "alice", None).is_empty());
        assert!(!trips(&entries, "alice", None, 5, 120, NOW));
    }

    #[test]
    fn instance_staff_new_members_and_raid_windows_never_count() {
        let staff = AuditEntry {
            actor: "staff".into(),
            ..entry()
        };
        assert!(counted(&[staff], "staff", None).is_empty());
        let fresh = AuditEntry {
            target_joined_at: Some(NOW - 3600),
            ..entry()
        };
        assert!(counted(&[fresh], "alice", None).is_empty());
        assert!(counted(&[entry()], "alice", Some(NOW)).is_empty());
        let real: Vec<AuditEntry> = (0..6).map(|_| entry()).collect();
        assert!(trips(&real, "alice", None, 5, 120, NOW));
        assert!(!trips(&real[..5], "alice", None, 5, 120, NOW));
    }

    #[test]
    fn an_automations_own_entry_under_a_member_name_never_counts() {
        let own = AuditEntry {
            automation_id: Some(7),
            ..entry()
        };
        assert!(counted(&[own], "alice", None).is_empty());
    }

    #[test]
    fn other_actions_and_old_entries_never_count() {
        let other = AuditEntry {
            action: StaffAction::Other,
            ..entry()
        };
        assert!(counted(&[other], "alice", None).is_empty());
        let deletes: Vec<AuditEntry> = [StaffAction::ChannelDelete, StaffAction::RoleDelete]
            .into_iter()
            .map(|action| AuditEntry {
                action,
                target_joined_at: None,
                ..entry()
            })
            .collect();
        assert_eq!(counted(&deletes, "alice", Some(NOW)).len(), 2);
        let old: Vec<AuditEntry> = (0..6)
            .map(|_| AuditEntry {
                at: NOW - 121,
                ..entry()
            })
            .collect();
        assert!(!trips(&old, "alice", None, 5, 120, NOW));
    }

    #[test]
    fn only_the_creator_can_lock_or_change_safety_and_locked_automations() {
        let a = Auto {
            id: 1,
            locked: true,
            safety: true,
        };
        let plain = Auto {
            id: 1,
            locked: false,
            safety: false,
        };
        let with_creator = server(Some("root"));
        assert!(!may_change(
            &a,
            Edit::Disable,
            &with_creator,
            "rogue",
            true,
            true
        ));
        assert!(may_change(
            &a,
            Edit::Disable,
            &with_creator,
            "root",
            true,
            true
        ));
        assert!(!may_change(
            &plain,
            Edit::SetLock,
            &with_creator,
            "rogue",
            true,
            true
        ));
        assert!(may_change(
            &plain,
            Edit::Edit,
            &with_creator,
            "rogue",
            false,
            true
        ));
        assert!(!may_change(
            &plain,
            Edit::Edit,
            &with_creator,
            "rogue",
            false,
            false
        ));
        assert!(!may_change(
            &a,
            Edit::Disable,
            &with_creator,
            "root",
            true,
            false
        ));
        let no_creator = server(None);
        assert!(may_change(
            &a,
            Edit::Disable,
            &no_creator,
            "helper",
            true,
            true
        ));
        assert!(!may_change(
            &a,
            Edit::Disable,
            &no_creator,
            "helper",
            false,
            true
        ));
    }

    #[test]
    fn pause_all_skips_locked_automations() {
        let autos = [
            Auto {
                id: 1,
                locked: true,
                safety: false,
            },
            Auto {
                id: 2,
                locked: false,
                safety: false,
            },
        ];
        assert_eq!(pause_all(&autos), [2]);
    }

    #[test]
    fn never_the_creator_or_the_owner_and_restore_puts_back_what_quarantine_took() {
        assert!(!may_quarantine(&server(Some("root")), "root", "root"));
        assert!(may_quarantine(&server(Some("root")), "root", "rogue"));
        assert!(!may_quarantine(&server(None), "helper", "helper"));
        let before = Standing {
            is_admin: true,
            perms: 0,
            roles: vec![3, 4],
            gate: Gate::In,
        };
        let (snapshot, after) = quarantine(&before);
        assert_eq!(
            after,
            Standing {
                is_admin: false,
                perms: 0,
                roles: vec![],
                gate: Gate::Held,
            }
        );
        assert_eq!(restore(&snapshot), before);
        let json = serde_json::to_string(&snapshot).expect("json");
        assert_eq!(json, r#"{"is_admin":true,"perms":0,"roles":[3,4]}"#);
        assert_eq!(
            serde_json::from_str::<Snapshot>(&json).expect("snapshot"),
            snapshot
        );
    }
}
