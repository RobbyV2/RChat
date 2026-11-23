//! Permission bits and the self-service grant rule.

use serde::{Deserialize, Serialize};

pub const MANAGE_CHANNELS: u32 = 1;
pub const DELETE_MESSAGES: u32 = 2;
pub const KICK: u32 = 4;
pub const DELETE_SERVER: u32 = 8;
pub const MANAGE_ADMINS: u32 = 16;
pub const MENTION_EVERYONE: u32 = 32;
pub const VIEW_AUDIT_LOG: u32 = 64;
pub const TIMEOUT_MEMBERS: u32 = 128;
pub const MANAGE_WEBHOOKS: u32 = 256;
pub const MANAGE_REPORTS: u32 = 512;
pub const MOVE_MEMBERS: u32 = 1024;
pub const MANAGE_AUTOMATIONS: u32 = 2048;
pub const MANAGE_SERVER: u32 = 4096;
pub const MANAGE_INVITES: u32 = 8192;
pub const MANAGE_ROLES: u32 = 16384;
pub const ASSIGN_ROLES: u32 = 32768;
pub const ALL_PERMS: u32 = 65535;

/// The bits a role may carry and still be handed out by a self-service path.
pub const SELF_SERVICE_OK: u32 = MENTION_EVERYONE;

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Refusal {
    GivesPermissions,
    OwnerCantGrant,
}

/// Whether a self-service path (an onboarding answer, a panel press, a command, role memory) may
/// give a role with these bits, as they are now. Asked at every grant, never only at save.
pub fn self_service(role_bits: u32, may_give: bool, owner_bits: u32) -> Option<Refusal> {
    match (
        role_bits & !owner_bits != 0,
        !may_give && role_bits & !SELF_SERVICE_OK != 0,
    ) {
        (true, _) => Some(Refusal::OwnerCantGrant),
        (false, true) => Some(Refusal::GivesPermissions),
        (false, false) => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const OWNER: u32 = ALL_PERMS;

    #[test]
    fn roles_within_mention_everyone_are_given() {
        assert_eq!(self_service(0, false, OWNER), None);
        assert_eq!(self_service(MENTION_EVERYONE, false, OWNER), None);
    }

    #[test]
    fn a_role_that_later_gained_kick_and_delete_messages_is_refused_at_the_next_grant() {
        assert_eq!(
            self_service(KICK | DELETE_MESSAGES, false, OWNER),
            Some(Refusal::GivesPermissions)
        );
        for bit in [
            MANAGE_CHANNELS,
            TIMEOUT_MEMBERS,
            MANAGE_WEBHOOKS,
            VIEW_AUDIT_LOG,
            MANAGE_ADMINS,
            DELETE_SERVER,
            MANAGE_AUTOMATIONS,
            MANAGE_SERVER,
            MANAGE_INVITES,
            MANAGE_ROLES,
            ASSIGN_ROLES,
        ] {
            assert_eq!(
                self_service(bit, false, OWNER),
                Some(Refusal::GivesPermissions)
            );
        }
    }

    #[test]
    fn a_role_marked_may_give_permissions_is_given_within_the_owners_rights_only() {
        assert_eq!(self_service(KICK, true, OWNER), None);
        assert_eq!(
            self_service(KICK, true, MANAGE_ADMINS),
            Some(Refusal::OwnerCantGrant)
        );
    }

    #[test]
    fn a_command_role_argument_from_outside_the_fixed_list_is_impossible() {
        let list = [11, 12];
        let pick = |role: i64| match list.contains(&role) {
            true => Ok(self_service(0, false, OWNER)),
            false => Err("not_in_list"),
        };
        assert_eq!(pick(99), Err("not_in_list"));
        assert_eq!(pick(11), Ok(None));
    }

    #[test]
    fn the_bits_are_the_servers() {
        assert_eq!(
            [
                MANAGE_CHANNELS,
                DELETE_MESSAGES,
                KICK,
                DELETE_SERVER,
                MANAGE_ADMINS,
                MENTION_EVERYONE,
                VIEW_AUDIT_LOG,
                TIMEOUT_MEMBERS,
                MANAGE_WEBHOOKS,
                MANAGE_REPORTS,
                MOVE_MEMBERS,
                MANAGE_AUTOMATIONS,
                MANAGE_SERVER,
                MANAGE_INVITES,
                MANAGE_ROLES,
                ASSIGN_ROLES,
            ],
            [
                1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768
            ]
        );
        assert_eq!(ALL_PERMS, 65535);
    }
}
