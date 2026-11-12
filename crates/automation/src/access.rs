//! The two reads of a member: rank and authority ungated, acting and seeing gated. And whose
//! rights a run has: its owner's, and the member's whose act set it off.

use crate::grants::{ALL_PERMS, MENTION_EVERYONE, Refusal, VIEW_AUDIT_LOG, self_service};
use crate::onboarding::{Gate, effective_gate};
use serde::{Deserialize, Serialize};

/// What a timed-out or rules-locked member may still do.
pub const READ_PERMS: u32 = VIEW_AUDIT_LOG;

/// A member row: `perms` holds the explicit admin bits (0 means all) for an admin, and the union
/// of the role bits otherwise.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
pub struct Member {
    pub is_admin: bool,
    pub perms: u32,
    pub gate: Gate,
}

/// Rank, hierarchy, the admin flag, audit and automation authority: never gated.
pub fn rank_bits(m: &Member) -> u32 {
    match (m.is_admin, m.perms) {
        (true, 0) => ALL_PERMS,
        (_, perms) => perms & ALL_PERMS,
    }
}

/// What the member may do: nothing while pending or held, read rights under a rules lock.
pub fn acting_bits(m: &Member, switch_on: bool) -> u32 {
    match effective_gate(m.gate, switch_on) {
        Gate::Pending | Gate::Held => 0,
        Gate::RulesLock => rank_bits(m) & READ_PERMS,
        Gate::In => rank_bits(m),
    }
}

/// What the member sees through bits. A rules lock keeps every view.
pub fn seeing_bits(m: &Member, switch_on: bool) -> u32 {
    match effective_gate(m.gate, switch_on) {
        Gate::Pending | Gate::Held => 0,
        Gate::RulesLock | Gate::In => rank_bits(m),
    }
}

/// The server's `can_moderate(actor, false, target)` over rank bits.
pub fn can_moderate(actor: u32, target: u32) -> bool {
    target & !actor == 0 && target != actor
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    Ok,
    PausedOwner,
}

/// Whether an automation (or an onboarding config) may run as its owner: paused while the owner
/// is gone, held, or lacks a needed bit, and running again as soon as the bits cover the needs.
pub fn owner_status(owner: Option<&Member>, needs: u32) -> Status {
    match owner {
        Some(m) if m.gate != Gate::Held && needs & !rank_bits(m) == 0 => Status::Ok,
        _ => Status::PausedOwner,
    }
}

/// Whose rights a run has besides its owner's, by its trigger: `Trigger::fired`.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Fired {
    /// The server, a schedule, staff or a detector sets it off: it runs as its owner.
    Owner,
    /// A member's own act sets it off: it runs within the owner's rights and that member's, and
    /// gives only self-service roles.
    Member,
    /// `counter_reached`: as `Member`, with the member whose act moved the counter, or as `Owner`
    /// when no member's act did.
    Mover,
}

/// What an action reaches, for the check against the member a run answers to (`may_run`).
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Reach {
    /// Takes from the event's member: `timeout`, `kick`, `ban`, `hold`, `quarantine`. The actor
    /// is punished for their own act with the owner's rights.
    Member,
    /// Takes the triggering message from its author: `block`, `delete_message`. The actor's own
    /// message goes with the owner's rights.
    Message,
    /// `pin`, on the triggering message. It takes nothing from the author, so it needs the
    /// actor's bits on their own message too.
    Pin,
    /// A role taken from the event's member: `remove_role`, `strip_roles`, a `toggle_role` that
    /// removes. It needs the actor's rights, on themselves too. At every removal the engine asks
    /// `revoke_of` for the role, which makes the member's own self role a `SelfRevoke`.
    Revoke,
    /// A role taken that its holder could have given themselves (`revoke_of`). From the actor
    /// themselves it is self-service, like a `SelfGrant` to them; from anyone else it is a
    /// `Revoke`.
    SelfRevoke,
    /// A role given: `add_role`, a `toggle_role` that adds. It goes to the event's member: the
    /// author of the message sent, edited or deleted (not whoever deleted it), the reacter, the
    /// member who joined, was admitted, left or was removed, whose profile, roles or voice
    /// channel changed, who ran the command or pressed, the counter's member for
    /// `counter_reached` (not always who moved it), the reported member for `report_filed`. A
    /// run that answers to its owner alone gives it within the owner's rights. A run that
    /// answers to a member gives only self-service roles, whatever its trigger: at every grant
    /// the engine asks `grant_of` for the role, which makes one that passes a `SelfGrant`, and a
    /// `Grant` is refused.
    Grant,
    /// A role given that passes `grants::self_service` with its bits as they are at the grant
    /// (`grant_of`). To the actor themselves it is self-service: the owner's rights. To anyone
    /// else it needs both sides' rights.
    SelfGrant,
    /// A channel or the whole server.
    Place,
    /// The automation's own posts, notices, reports, counters, kit services and deliveries.
    /// Sending keeps the owner's rights, so it can post where the member can't. Pinging
    /// `@everyone`, `@here` or a role that isn't mentionable needs both the owner's and the
    /// actor's Mention everyone.
    Own,
}

/// The member a run answers to, as the run checks them: what they may do now (`acting_bits`:
/// nothing while pending or held, read rights under a rules lock) and their rank (`rank_bits`).
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
pub struct Actor {
    pub id: i64,
    pub acting: u32,
    pub rank: u32,
}

impl Actor {
    pub fn of(id: i64, m: &Member, switch_on: bool) -> Actor {
        Actor {
            id,
            acting: acting_bits(m, switch_on),
            rank: rank_bits(m),
        }
    }
}

/// What taking one role off a member reaches: `SelfRevoke` when the role passes
/// `grants::self_service` with its bits as they are now and taking it off doesn't widen the
/// member's channel access (`widens`: the server's channel-limit check, as for a role taken by
/// hand), `Revoke` otherwise. `strip_roles` asks for each role and skips the ones `may_run`
/// refuses.
pub fn revoke_of(role_bits: u32, owner: u32, widens: bool) -> Reach {
    match !widens && self_service(role_bits, false, owner).is_none() {
        true => Reach::SelfRevoke,
        false => Reach::Revoke,
    }
}

/// What giving one role reaches: `SelfGrant` when the role passes `grants::self_service` with
/// its bits as they are now, `Grant` otherwise. `may_give` is a panel's "May give permissions"
/// mark on the role, and false for a role an action names. Asked at every grant, whatever the
/// trigger: `Compiled::self_served` lists only what the save checked.
pub fn grant_of(role_bits: u32, may_give: bool, owner: u32) -> Reach {
    match self_service(role_bits, may_give, owner) {
        None => Reach::SelfGrant,
        Some(Refusal::GivesPermissions | Refusal::OwnerCantGrant) => Reach::Grant,
    }
}

/// The member a run answers to besides its owner, if any. An event an automation's run caused
/// answers to that run's member (`caused`), as it carries its cause chain. Otherwise a trigger a
/// member sets off answers to the member who acted (`acted`: the author, editor, deleter,
/// reacter, joiner, the member who left or whoever removed them, the member who joined or left
/// voice or the staff member who disconnected them, who ran the command, pressed or filed the
/// report), `counter_reached` to the member who moved the counter by hand, and the owner's
/// triggers to nobody. A guest is no member: a guest's event starts no run. A run's follow-up
/// jobs (an action delayed with `after`, the undo that ends a timed role) answer to the member
/// the run answered to, and every event they cause carries that member as `caused`. A role that
/// an onboarding answer gives, or that role memory gives back on rejoin, comes from no run: the
/// events it causes carry the member who picked the answer or rejoined as `caused`.
pub fn actor(fired: Fired, acted: Option<i64>, caused: Option<Option<i64>>) -> Option<i64> {
    match (caused, fired) {
        (Some(run), _) => run,
        (None, Fired::Owner) => None,
        (None, Fired::Member | Fired::Mover) => acted,
    }
}

/// Who posted a message: a member, an automation (`@auto:`) or a webhook.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Poster {
    Member(i64),
    Automation,
    Webhook,
}

/// The member a message counts as written by, for the target of an action that reaches `reach`
/// on it (`may_run`): a member's post is theirs. For `block` and `delete_message`
/// (`Reach::Message`) an automation's or a webhook's post counts as written by the member its
/// cause chain answers to: `caused` is the cause stored with the post (the run that posted it,
/// or the delivery an incoming webhook execute sent back), not the cause of a reaction or an edit
/// that triggers the run on it. So a guard takes away what a member's command made an automation
/// say, or a relay of their run brought back through a webhook, as it would that member's own
/// message, and a post with no member in its chain is the owner's to block or delete. For every
/// other action an automation's or a webhook's post is written by no member: a member or role
/// action on it has no one to act on and is skipped.
pub fn author(reach: Reach, poster: Poster, caused: Option<Option<i64>>) -> Option<i64> {
    match (poster, reach) {
        (Poster::Member(member), _) => Some(member),
        (Poster::Automation | Poster::Webhook, Reach::Message) => caused.flatten(),
        (
            Poster::Automation | Poster::Webhook,
            Reach::Member
            | Reach::Pin
            | Reach::Revoke
            | Reach::SelfRevoke
            | Reach::Grant
            | Reach::SelfGrant
            | Reach::Place
            | Reach::Own,
        ) => None,
    }
}

/// Whether a run may carry out an action that needs `needs` and reaches `reach`. `owner` is the
/// owner's rank bits, `actor` the member the run answers to (`actor`), `target` the member the
/// action is on, with their rank bits (the event's member, or who the triggering message counts
/// as written by, `author`), and `picked` whether that member chose the role themselves: with no
/// condition deciding the run, from their own `choice` argument of a command, or the role a press
/// or a reaction on a reaction-role message stands for (`Automation::picks`, compiled as
/// `Compiled::picks`). The owner must hold the bits and outrank the target. With an
/// actor the action must also be within the actor's own rights, the bits against what they may
/// do now and the hierarchy against their rank, wherever it does more than take from them:
/// - a punishment of the actor or of their own message runs with the owner's rights;
/// - a pin, and a role taken that is not their own self role, needs their bits;
/// - a role given must be a self-service role (`grant_of`), whoever receives it;
/// - a self-service role given to the actor, and their own self role taken, need nothing of
///   theirs. The owner must outrank them, unless they picked the role: a guard's mute role
///   leaves staff above the owner alone, and a self role command works for them;
/// - on anyone else, a member, message or role action needs their bits and their rank;
/// - a channel or server action needs their bits;
/// - the automation's own posts and services keep the owner's rights, but Mention everyone in
///   `needs` must be the actor's too, whatever the action reaches.
///
/// A member or role action needs a member to act on: with no target (a post no member wrote,
/// `author`) it is refused. For a message action a target that isn't known counts as someone
/// else.
///
/// A run asks `owner_status` first, with everything the automation needs: an owner who lacks a
/// bit pauses the automation. After that a refusal here comes from the actor's side or from the
/// owner's rank over the target: it skips that action for that run and never pauses.
pub fn may_run(
    reach: Reach,
    needs: u32,
    owner: u32,
    actor: Option<Actor>,
    target: Option<(i64, u32)>,
    picked: bool,
) -> bool {
    let held = |bits: u32| needs & !bits == 0;
    let above = |rank: u32| target.is_none_or(|(_, t)| can_moderate(rank, t));
    let own = actor.zip(target).is_some_and(|(a, (t, _))| a.id == t);
    let owners = match reach {
        Reach::Member | Reach::Revoke | Reach::Grant => target.is_some() && above(owner),
        Reach::SelfRevoke | Reach::SelfGrant => {
            target.is_some() && ((own && picked) || above(owner))
        }
        Reach::Message | Reach::Pin => above(owner),
        Reach::Place | Reach::Own => true,
    };
    let theirs = actor.is_none_or(|a| {
        let ping = needs & MENTION_EVERYONE & !a.acting == 0;
        ping && match reach {
            Reach::Member | Reach::Message | Reach::SelfRevoke | Reach::SelfGrant => {
                own || (held(a.acting) && above(a.rank))
            }
            Reach::Pin | Reach::Revoke => held(a.acting) && (own || above(a.rank)),
            Reach::Grant => false,
            Reach::Place => held(a.acting),
            Reach::Own => true,
        }
    });
    held(owner) && owners && theirs
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::grants::{
        DELETE_MESSAGES, KICK, MANAGE_ADMINS, MANAGE_AUTOMATIONS, MANAGE_CHANNELS, MANAGE_WEBHOOKS,
        MENTION_EVERYONE, TIMEOUT_MEMBERS,
    };

    const BAN_NEEDS: u32 = KICK;

    fn moderator() -> Member {
        Member {
            is_admin: false,
            perms: KICK | DELETE_MESSAGES,
            gate: Gate::In,
        }
    }

    fn channel_manager(gate: Gate) -> Member {
        Member {
            is_admin: false,
            perms: MANAGE_CHANNELS | KICK | READ_PERMS | DELETE_MESSAGES,
            gate,
        }
    }

    const OWNER: u32 = ALL_PERMS & !crate::grants::DELETE_SERVER;
    const MODERATOR: u32 = KICK | TIMEOUT_MEMBERS | DELETE_MESSAGES | MENTION_EVERYONE;
    /// An owner below the staff who hold what `OWNER` holds.
    const JUNIOR: u32 = KICK | TIMEOUT_MEMBERS | DELETE_MESSAGES | MANAGE_ADMINS;
    const REACHES: [Reach; 9] = [
        Reach::Member,
        Reach::Message,
        Reach::Pin,
        Reach::Revoke,
        Reach::SelfRevoke,
        Reach::Grant,
        Reach::SelfGrant,
        Reach::Place,
        Reach::Own,
    ];

    /// A member who is in, with these bits.
    fn with(id: i64, bits: u32) -> Option<Actor> {
        Some(Actor {
            id,
            acting: bits,
            rank: bits,
        })
    }

    #[test]
    fn a_run_answers_to_the_member_whose_act_set_it_off() {
        assert_eq!(actor(Fired::Member, Some(4), None), Some(4));
        assert_eq!(actor(Fired::Owner, Some(4), None), None);
        assert_eq!(actor(Fired::Owner, None, None), None);
        assert_eq!(actor(Fired::Mover, Some(4), None), Some(4));
        assert_eq!(actor(Fired::Mover, None, None), None);
        for fired in [Fired::Owner, Fired::Member, Fired::Mover] {
            assert_eq!(actor(fired, Some(4), Some(Some(9))), Some(9), "{fired:?}");
            assert_eq!(actor(fired, Some(4), Some(None)), None, "{fired:?}");
        }
    }

    #[test]
    fn the_reaches_have_their_stored_names() {
        assert_eq!(
            serde_json::to_string(&REACHES).expect("json"),
            r#"["member","message","pin","revoke","self_revoke","grant","self_grant","place","own"]"#
        );
    }

    #[test]
    fn a_member_command_times_out_another_member_only_if_they_could_by_hand() {
        let timeout = |actor: Option<Actor>, target: u32| {
            may_run(
                Reach::Member,
                TIMEOUT_MEMBERS,
                OWNER,
                actor,
                Some((2, target)),
                false,
            )
        };
        assert!(!timeout(with(1, 0), 0));
        assert!(!timeout(with(1, KICK), 0));
        assert!(timeout(with(1, TIMEOUT_MEMBERS), 0));
        assert!(!timeout(with(1, TIMEOUT_MEMBERS), TIMEOUT_MEMBERS));
        assert!(!timeout(with(1, MODERATOR), MODERATOR));
        assert!(timeout(with(1, MODERATOR | MANAGE_ADMINS), MODERATOR));
        assert!(timeout(None, MODERATOR));
        assert!(!timeout(None, OWNER));
        assert!(!may_run(
            Reach::Member,
            TIMEOUT_MEMBERS,
            KICK,
            None,
            Some((2, 0)),
            false
        ));
    }

    #[test]
    fn a_member_is_punished_for_their_own_act_with_the_owners_rights() {
        for (reach, needs) in [
            (Reach::Member, TIMEOUT_MEMBERS),
            (Reach::Member, KICK),
            (Reach::Member, KICK | MANAGE_ADMINS),
            (Reach::Message, DELETE_MESSAGES),
        ] {
            let punish = |owner: u32, target: Option<(i64, u32)>| {
                may_run(reach, needs, owner, with(1, 0), target, false)
            };
            assert!(punish(OWNER, Some((1, 0))));
            assert!(!punish(OWNER, Some((1, OWNER))));
            assert!(!punish(0, Some((1, 0))));
            assert!(!punish(OWNER, Some((2, 0))));
            assert!(!punish(OWNER, None));
        }
    }

    #[test]
    fn a_reaction_deletes_another_members_message_only_if_the_reacter_could() {
        let delete = |reacter: u32, author: Option<(i64, u32)>| {
            may_run(
                Reach::Message,
                DELETE_MESSAGES,
                OWNER,
                with(1, reacter),
                author,
                false,
            )
        };
        assert!(!delete(0, Some((2, 0))));
        assert!(delete(DELETE_MESSAGES, Some((2, 0))));
        assert!(!delete(DELETE_MESSAGES, Some((2, DELETE_MESSAGES))));
        assert!(!delete(0, None));
        assert!(delete(DELETE_MESSAGES, None));
    }

    #[test]
    fn an_automations_or_a_webhooks_post_counts_as_the_members_only_for_block_and_delete() {
        for reach in REACHES {
            assert_eq!(author(reach, Poster::Member(4), None), Some(4), "{reach:?}");
            assert_eq!(
                author(reach, Poster::Member(4), Some(Some(9))),
                Some(4),
                "{reach:?}"
            );
            for poster in [Poster::Automation, Poster::Webhook] {
                assert_eq!(author(reach, poster, Some(None)), None, "{poster:?}");
                assert_eq!(author(reach, poster, None), None, "{poster:?}");
                assert_eq!(
                    author(reach, poster, Some(Some(9))),
                    (reach == Reach::Message).then_some(9),
                    "{reach:?} {poster:?}"
                );
            }
        }
        let block = |owner: u32, guarded: Option<Actor>, wrote: Option<(i64, u32)>| {
            may_run(
                Reach::Message,
                DELETE_MESSAGES,
                owner,
                guarded,
                wrote,
                false,
            )
        };
        let commanded = Some(Some(1));
        assert_eq!(actor(Fired::Member, None, commanded), Some(1));
        let wrote =
            |rank: u32| author(Reach::Message, Poster::Automation, commanded).map(|id| (id, rank));
        assert!(block(OWNER, with(1, 0), wrote(0)));
        assert!(!block(OWNER, with(1, 0), None));
        assert!(!block(JUNIOR, with(1, OWNER), wrote(OWNER)));
        assert!(block(OWNER, with(1, MODERATOR), wrote(MODERATOR)));
        let scheduled = Some(None);
        assert_eq!(actor(Fired::Member, None, scheduled), None);
        assert_eq!(author(Reach::Message, Poster::Automation, scheduled), None);
        assert!(block(OWNER, None, None));
        let echoed =
            |rank: u32| author(Reach::Message, Poster::Webhook, commanded).map(|id| (id, rank));
        assert!(block(OWNER, with(1, 0), echoed(0)));
        assert!(!block(JUNIOR, with(1, OWNER), echoed(OWNER)));
        assert_eq!(author(Reach::Member, Poster::Webhook, commanded), None);
        assert!(!may_run(
            Reach::Member,
            TIMEOUT_MEMBERS,
            OWNER,
            with(1, 0),
            None,
            false
        ));
        assert_eq!(author(Reach::Message, Poster::Webhook, scheduled), None);
        assert_eq!(author(Reach::Message, Poster::Webhook, None), None);
    }

    #[test]
    fn a_member_or_role_action_on_a_post_no_member_wrote_is_skipped() {
        let on_members = [
            (Reach::Member, TIMEOUT_MEMBERS),
            (Reach::Member, KICK),
            (Reach::Revoke, MANAGE_ADMINS),
            (Reach::SelfRevoke, MANAGE_ADMINS),
            (Reach::Grant, MANAGE_ADMINS),
            (Reach::SelfGrant, MANAGE_ADMINS),
        ];
        let starred = Some(Some(1));
        let starrer = actor(Fired::Member, None, starred);
        assert_eq!(starrer, Some(1));
        for (reach, needs) in on_members {
            let target = author(reach, Poster::Automation, starred).map(|id| (id, 0));
            assert_eq!(target, None, "{reach:?}");
            for bits in [0, MODERATOR, ALL_PERMS] {
                for picked in [false, true] {
                    assert!(
                        !may_run(reach, needs, ALL_PERMS, with(1, bits), target, picked),
                        "{reach:?}"
                    );
                }
            }
            assert!(
                !may_run(reach, needs, ALL_PERMS, None, None, false),
                "{reach:?}"
            );
            assert!(
                may_run(reach, needs, ALL_PERMS, None, Some((1, 0)), false),
                "{reach:?}"
            );
        }
        let repost = author(Reach::Message, Poster::Automation, starred).map(|id| (id, 0));
        assert!(may_run(
            Reach::Message,
            DELETE_MESSAGES,
            OWNER,
            with(1, 0),
            repost,
            false
        ));
        let banned = Some(Some(3));
        let banner = actor(Fired::Member, None, banned);
        assert_eq!(banner, Some(3));
        for (reach, needs) in on_members {
            let target = author(reach, Poster::Automation, banned).map(|id| (id, MODERATOR));
            assert!(
                !may_run(reach, needs, OWNER, with(3, MODERATOR), target, false),
                "{reach:?}"
            );
        }
        let leave_post =
            author(Reach::Message, Poster::Automation, banned).map(|id| (id, MODERATOR));
        assert_eq!(leave_post, Some((3, MODERATOR)));
        assert!(may_run(
            Reach::Message,
            DELETE_MESSAGES,
            OWNER,
            with(3, MODERATOR),
            leave_post,
            false
        ));
        assert!(may_run(
            Reach::Message,
            DELETE_MESSAGES,
            OWNER,
            None,
            None,
            false
        ));
        assert!(may_run(
            Reach::Pin,
            DELETE_MESSAGES,
            OWNER,
            with(1, DELETE_MESSAGES),
            None,
            false
        ));
    }

    #[test]
    fn a_runs_follow_up_jobs_answer_to_the_member_whose_run_made_them() {
        let picker = actor(Fired::Member, Some(1), None);
        assert_eq!(picker, Some(1));
        let ping_me = grant_of(MENTION_EVERYONE, false, OWNER);
        assert!(may_run(
            ping_me,
            MANAGE_ADMINS,
            OWNER,
            with(1, 0),
            Some((1, 0)),
            true
        ));
        let undone = actor(Fired::Owner, None, Some(picker));
        assert_eq!(undone, Some(1));
        let helper = grant_of(KICK | DELETE_MESSAGES, false, OWNER);
        assert_eq!(helper, Reach::Grant);
        assert!(!may_run(
            helper,
            MANAGE_ADMINS,
            OWNER,
            with(1, 0),
            Some((1, 0)),
            false
        ));
        assert!(may_run(
            helper,
            MANAGE_ADMINS,
            OWNER,
            None,
            Some((1, 0)),
            false
        ));
        let delayed = actor(Fired::Member, Some(1), None);
        let gained_kick = grant_of(MENTION_EVERYONE | KICK, false, OWNER);
        assert_eq!(gained_kick, Reach::Grant);
        assert_eq!(delayed, Some(1));
        assert!(!may_run(
            gained_kick,
            MANAGE_ADMINS,
            OWNER,
            with(1, 0),
            Some((1, 0)),
            true
        ));
    }

    #[test]
    fn a_role_onboarding_or_role_memory_gives_answers_to_the_member_who_got_it() {
        for given in ["an onboarding answer", "role memory on rejoin"] {
            let joiner = actor(Fired::Owner, None, Some(Some(1)));
            assert_eq!(joiner, Some(1), "{given}");
            let helper = grant_of(KICK | DELETE_MESSAGES, false, OWNER);
            assert_eq!(helper, Reach::Grant);
            let holds_ping = Some((1, MENTION_EVERYONE));
            assert!(
                !may_run(helper, MANAGE_ADMINS, OWNER, with(1, 0), holds_ping, false),
                "{given}"
            );
            assert!(
                may_run(helper, MANAGE_ADMINS, OWNER, None, holds_ping, false),
                "{given}"
            );
            let plain = grant_of(0, false, OWNER);
            assert_eq!(plain, Reach::SelfGrant);
            assert!(
                may_run(plain, MANAGE_ADMINS, OWNER, with(1, 0), holds_ping, false),
                "{given}"
            );
        }
    }

    #[test]
    fn pinning_needs_the_members_own_bits_even_on_their_own_message() {
        let pin = |actor: Option<Actor>, author: (i64, u32)| {
            may_run(
                Reach::Pin,
                DELETE_MESSAGES,
                OWNER,
                actor,
                Some(author),
                false,
            )
        };
        assert!(!pin(with(1, 0), (1, 0)));
        assert!(!pin(with(1, 0), (2, 0)));
        assert!(!pin(with(1, KICK), (1, KICK)));
        assert!(pin(with(1, DELETE_MESSAGES), (1, DELETE_MESSAGES)));
        assert!(pin(with(1, DELETE_MESSAGES), (2, 0)));
        assert!(!pin(with(1, DELETE_MESSAGES), (2, DELETE_MESSAGES)));
        assert!(pin(None, (2, 0)));
        assert!(!pin(None, (2, OWNER)));
        assert!(!may_run(
            Reach::Pin,
            DELETE_MESSAGES,
            KICK,
            with(1, DELETE_MESSAGES),
            Some((1, DELETE_MESSAGES)),
            false
        ));
    }

    #[test]
    fn a_member_loses_their_own_role_only_if_it_is_a_self_role() {
        assert_eq!(revoke_of(0, OWNER, false), Reach::SelfRevoke);
        assert_eq!(revoke_of(MENTION_EVERYONE, OWNER, false), Reach::SelfRevoke);
        assert_eq!(revoke_of(0, OWNER, true), Reach::Revoke);
        assert_eq!(revoke_of(KICK, OWNER, false), Reach::Revoke);
        assert_eq!(revoke_of(MENTION_EVERYONE, KICK, false), Reach::Revoke);
        let take = |reach: Reach, owner: u32, actor: Option<Actor>, from: (i64, u32)| {
            may_run(reach, MANAGE_ADMINS, owner, actor, Some(from), false)
        };
        assert!(take(Reach::SelfRevoke, OWNER, with(1, 0), (1, 0)));
        assert!(!take(Reach::Revoke, OWNER, with(1, 0), (1, 0)));
        assert!(take(
            Reach::Revoke,
            OWNER,
            with(1, MANAGE_ADMINS),
            (1, MANAGE_ADMINS)
        ));
        assert!(!take(Reach::Revoke, OWNER, with(1, KICK), (1, KICK)));
        for reach in [Reach::Revoke, Reach::SelfRevoke] {
            assert!(!take(reach, OWNER, with(1, 0), (2, 0)), "{reach:?}");
            assert!(take(reach, OWNER, with(1, MANAGE_ADMINS), (2, 0)));
            assert!(!take(
                reach,
                OWNER,
                with(1, MANAGE_ADMINS),
                (2, MANAGE_ADMINS)
            ));
            assert!(take(reach, OWNER, None, (2, MODERATOR)), "{reach:?}");
            assert!(!take(reach, MANAGE_ADMINS, None, (2, OWNER)), "{reach:?}");
            assert!(!take(reach, KICK, with(1, 0), (1, 0)), "{reach:?}");
            assert!(
                !take(reach, MANAGE_ADMINS, with(1, OWNER), (1, OWNER)),
                "{reach:?}"
            );
        }
    }

    #[test]
    fn stripping_a_members_own_roles_skips_the_ones_they_couldnt_take_off() {
        let roles = [
            (0, false),
            (0, true),
            (KICK, false),
            (MENTION_EVERYONE, false),
        ];
        let stripped = |actor: Option<Actor>, from: (i64, u32)| {
            roles.map(|(bits, widens)| {
                may_run(
                    revoke_of(bits, OWNER, widens),
                    MANAGE_ADMINS,
                    OWNER,
                    actor,
                    Some(from),
                    false,
                )
            })
        };
        assert_eq!(stripped(with(1, 0), (1, 0)), [true, false, false, true]);
        assert_eq!(
            stripped(with(1, MANAGE_ADMINS), (1, MANAGE_ADMINS)),
            [true; 4]
        );
        assert_eq!(stripped(with(1, 0), (2, 0)), [false; 4]);
        assert_eq!(stripped(None, (2, 0)), [true; 4]);
    }

    #[test]
    fn a_role_given_to_someone_else_needs_both_sides_rights() {
        let give = |owner: u32, actor: Option<Actor>, to: Option<(i64, u32)>| {
            may_run(Reach::SelfGrant, MANAGE_ADMINS, owner, actor, to, false)
        };
        assert!(give(OWNER, with(1, 0), Some((1, 0))));
        assert!(!give(OWNER, with(1, 0), Some((2, 0))));
        assert!(!give(OWNER, with(1, KICK), Some((2, 0))));
        assert!(give(OWNER, with(1, MANAGE_ADMINS), Some((2, 0))));
        assert!(!give(
            OWNER,
            with(1, MANAGE_ADMINS),
            Some((2, MANAGE_ADMINS))
        ));
        assert!(!give(OWNER, with(1, 0), None));
        assert!(give(OWNER, None, Some((2, MODERATOR))));
        assert!(!give(OWNER, None, None));
        assert!(!give(KICK | MANAGE_ADMINS, None, Some((2, OWNER))));
        assert!(!give(KICK, None, Some((2, 0))));
        assert!(!give(KICK, with(1, 0), Some((1, 0))));
        assert!(!give(
            MANAGE_ADMINS,
            with(1, MANAGE_ADMINS),
            Some((2, OWNER))
        ));
    }

    #[test]
    fn a_run_that_answers_to_a_member_gives_only_self_service_roles() {
        assert_eq!(grant_of(0, false, OWNER), Reach::SelfGrant);
        assert_eq!(grant_of(MENTION_EVERYONE, false, OWNER), Reach::SelfGrant);
        assert_eq!(grant_of(KICK | DELETE_MESSAGES, false, OWNER), Reach::Grant);
        assert_eq!(grant_of(MENTION_EVERYONE, false, KICK), Reach::Grant);
        assert_eq!(grant_of(KICK, true, OWNER), Reach::SelfGrant);
        assert_eq!(grant_of(KICK, true, MANAGE_ADMINS), Reach::Grant);
        let give = |reach: Reach, actor: Option<Actor>, to: (i64, u32), picked: bool| {
            may_run(reach, MANAGE_ADMINS, OWNER, actor, Some(to), picked)
        };
        for picked in [false, true] {
            assert!(!give(Reach::Grant, with(1, 0), (1, 0), picked));
            assert!(!give(Reach::Grant, with(1, MANAGE_ADMINS), (2, 0), picked));
            assert!(!give(Reach::Grant, with(1, ALL_PERMS), (2, 0), picked));
            assert!(!give(
                Reach::Grant,
                with(1, ALL_PERMS),
                (1, ALL_PERMS),
                picked
            ));
            assert!(give(Reach::Grant, None, (2, MODERATOR), picked));
            assert!(!give(Reach::Grant, None, (2, OWNER), picked));
            assert!(give(Reach::SelfGrant, None, (2, MODERATOR), picked));
        }
        let ping_me = grant_of(MENTION_EVERYONE, false, OWNER);
        assert!(give(ping_me, with(1, 0), (1, 0), true));
        let helper = grant_of(KICK | DELETE_MESSAGES, false, OWNER);
        assert_eq!(actor(Fired::Owner, None, Some(Some(1))), Some(1));
        assert!(!give(helper, with(1, 0), (1, MENTION_EVERYONE), false));
        assert!(give(ping_me, with(1, 0), (1, MENTION_EVERYONE), false));
        assert_eq!(actor(Fired::Owner, Some(1), None), None);
        assert!(give(helper, None, (2, MENTION_EVERYONE), false));
    }

    #[test]
    fn the_owners_rank_is_skipped_only_for_a_role_the_member_picked() {
        let staff = (3, OWNER);
        assert!(!can_moderate(JUNIOR, OWNER));
        for reach in [Reach::SelfGrant, Reach::SelfRevoke] {
            let change = |actor: Option<Actor>, on: (i64, u32), picked: bool| {
                may_run(reach, MANAGE_ADMINS, JUNIOR, actor, Some(on), picked)
            };
            assert!(!change(with(3, OWNER), staff, false), "{reach:?}");
            assert!(change(with(3, OWNER), staff, true), "{reach:?}");
            assert!(change(with(1, 0), (1, 0), false), "{reach:?}");
            assert!(change(with(1, 0), (1, 0), true), "{reach:?}");
            assert!(!change(with(1, ALL_PERMS), staff, true), "{reach:?}");
            assert!(!change(None, staff, true), "{reach:?}");
            assert!(
                may_run(
                    reach,
                    MANAGE_ADMINS,
                    ALL_PERMS,
                    with(1, ALL_PERMS),
                    Some(staff),
                    true
                ),
                "{reach:?}"
            );
        }
        for (reach, needs) in [
            (Reach::Member, TIMEOUT_MEMBERS),
            (Reach::Message, DELETE_MESSAGES),
            (Reach::Pin, DELETE_MESSAGES),
            (Reach::Revoke, MANAGE_ADMINS),
            (Reach::Grant, MANAGE_ADMINS),
        ] {
            for picked in [false, true] {
                assert!(
                    !may_run(reach, needs, JUNIOR, with(3, OWNER), Some(staff), picked),
                    "{reach:?}"
                );
            }
        }
    }

    #[test]
    fn channel_and_server_actions_need_the_members_own_bits() {
        let lock = |needs: u32, owner: u32, actor: Option<Actor>| {
            may_run(Reach::Place, needs, owner, actor, None, false)
        };
        assert!(!lock(MANAGE_CHANNELS, OWNER, with(1, 0)));
        assert!(!lock(KICK, OWNER, with(1, MANAGE_CHANNELS)));
        assert!(lock(MANAGE_CHANNELS, OWNER, with(1, MANAGE_CHANNELS)));
        assert!(lock(MANAGE_CHANNELS, OWNER, None));
        assert!(!lock(MANAGE_CHANNELS, KICK, with(1, MANAGE_CHANNELS)));
    }

    #[test]
    fn posts_and_counters_run_with_the_owners_rights() {
        let post = |needs: u32, owner: u32, actor: Option<Actor>, on: Option<(i64, u32)>| {
            may_run(Reach::Own, needs, owner, actor, on, false)
        };
        assert!(post(0, OWNER, with(1, 0), None));
        assert!(post(MANAGE_AUTOMATIONS, OWNER, with(1, 0), None));
        assert!(post(
            MANAGE_AUTOMATIONS,
            OWNER,
            with(1, 0),
            Some((2, OWNER))
        ));
        assert!(post(MANAGE_ADMINS, OWNER, with(1, 0), None));
        assert!(!post(MANAGE_ADMINS, KICK, with(1, MANAGE_ADMINS), None));
        assert!(!post(MANAGE_WEBHOOKS, KICK, None, None));
    }

    #[test]
    fn a_group_ping_needs_the_members_own_mention_everyone() {
        let post = |needs: u32, owner: u32, actor: Option<Actor>| {
            may_run(Reach::Own, needs, owner, actor, None, false)
        };
        assert!(!post(MENTION_EVERYONE, OWNER, with(1, 0)));
        assert!(!post(
            MENTION_EVERYONE,
            OWNER,
            with(1, MODERATOR & !MENTION_EVERYONE)
        ));
        assert!(post(MENTION_EVERYONE, OWNER, with(1, MENTION_EVERYONE)));
        assert!(post(MENTION_EVERYONE, OWNER, None));
        assert!(post(MENTION_EVERYONE, MENTION_EVERYONE, None));
        assert!(!post(MENTION_EVERYONE, KICK, None));
        assert!(!post(MENTION_EVERYONE, KICK, with(1, MENTION_EVERYONE)));
        let buttons = MANAGE_ADMINS | MENTION_EVERYONE;
        assert!(post(buttons, OWNER, with(1, MENTION_EVERYONE)));
        assert!(!post(buttons, OWNER, with(1, MANAGE_ADMINS)));
        assert!(!post(buttons, MENTION_EVERYONE, with(1, MENTION_EVERYONE)));
        for reach in REACHES {
            assert!(
                !may_run(
                    reach,
                    MENTION_EVERYONE,
                    OWNER,
                    with(1, 0),
                    Some((1, 0)),
                    false
                ),
                "{reach:?}"
            );
            assert_eq!(
                may_run(
                    reach,
                    MENTION_EVERYONE,
                    OWNER,
                    with(1, MENTION_EVERYONE),
                    Some((1, MENTION_EVERYONE)),
                    false
                ),
                reach != Reach::Grant,
                "{reach:?}"
            );
        }
    }

    #[test]
    fn strikes_other_members_raised_punish_only_within_their_rights() {
        for (reach, needs) in [
            (Reach::Member, TIMEOUT_MEMBERS),
            (Reach::SelfGrant, MANAGE_ADMINS),
        ] {
            let strikes = |mover: Option<(i64, u32)>, by_hand: bool, target: (i64, u32)| {
                let acted = mover.filter(|_| by_hand).map(|(id, _)| id);
                let caused = match by_hand {
                    true => None,
                    false => Some(mover.map(|(id, _)| id)),
                };
                let answers = actor(Fired::Mover, acted, caused);
                let bits = mover.filter(|(id, _)| Some(*id) == answers).map(|(_, b)| b);
                let actor = answers.zip(bits).and_then(|(id, bits)| with(id, bits));
                may_run(reach, needs, OWNER, actor, Some(target), false)
            };
            let staff = MODERATOR | MANAGE_ADMINS;
            assert!(!strikes(Some((1, 0)), false, (2, 0)), "{reach:?}");
            assert!(strikes(Some((1, staff)), false, (2, 0)), "{reach:?}");
            assert!(strikes(Some((2, 0)), false, (2, 0)), "{reach:?}");
            assert!(strikes(None, false, (2, 0)), "{reach:?}");
            assert!(
                !strikes(Some((1, MANAGE_AUTOMATIONS)), true, (2, 0)),
                "{reach:?}"
            );
            assert!(strikes(Some((1, staff)), true, (2, 0)), "{reach:?}");
        }
    }

    #[test]
    fn a_held_moderator_has_rank_and_no_rights_of_their_own() {
        let moderator = |gate: Gate| Member {
            is_admin: false,
            perms: DELETE_MESSAGES | TIMEOUT_MEMBERS | READ_PERMS,
            gate,
        };
        let delete = |gate: Gate, author: (i64, u32)| {
            let actor = Actor::of(1, &moderator(gate), true);
            may_run(
                Reach::Message,
                DELETE_MESSAGES,
                OWNER,
                Some(actor),
                Some(author),
                false,
            )
        };
        let held = Actor::of(1, &moderator(Gate::Held), true);
        assert_eq!((held.acting, held.rank), (0, 194));
        assert_eq!(Actor::of(1, &moderator(Gate::Held), false), held);
        assert_eq!(Actor::of(1, &moderator(Gate::Pending), false).acting, 194);
        assert!(delete(Gate::In, (2, 0)));
        assert!(!delete(Gate::Held, (2, 0)));
        assert!(!delete(Gate::Pending, (2, 0)));
        assert!(!delete(Gate::RulesLock, (2, 0)));
        assert!(delete(Gate::Held, (1, 194)));
        let pin = |gate: Gate| {
            let actor = Actor::of(1, &moderator(gate), true);
            may_run(
                Reach::Pin,
                DELETE_MESSAGES,
                OWNER,
                Some(actor),
                Some((1, 194)),
                false,
            )
        };
        assert!(pin(Gate::In));
        assert!(!pin(Gate::Held));
        let locked = Actor::of(1, &moderator(Gate::RulesLock), true);
        assert_eq!((locked.acting, locked.rank), (READ_PERMS, 194));
        let read = |target: u32| {
            may_run(
                Reach::Member,
                READ_PERMS,
                OWNER,
                Some(locked),
                Some((2, target)),
                false,
            )
        };
        assert!(read(READ_PERMS));
        assert!(!read(194));
        let ping = |gate: Gate| {
            let pinger = Member {
                is_admin: false,
                perms: MENTION_EVERYONE,
                gate,
            };
            let actor = Actor::of(1, &pinger, true);
            may_run(
                Reach::Own,
                MENTION_EVERYONE,
                OWNER,
                Some(actor),
                None,
                false,
            )
        };
        assert!(ping(Gate::In));
        assert!(!ping(Gate::Held));
        assert!(!ping(Gate::RulesLock));
        let lock = |gate: Gate| {
            let actor = Actor::of(1, &channel_manager(gate), true);
            may_run(
                Reach::Place,
                MANAGE_CHANNELS,
                OWNER,
                Some(actor),
                None,
                false,
            )
        };
        assert!(lock(Gate::In));
        assert!(!lock(Gate::Held));
        assert!(!lock(Gate::RulesLock));
    }

    #[test]
    fn a_held_channel_manager_keeps_rank() {
        let held = channel_manager(Gate::Held);
        assert_eq!(acting_bits(&held, true), 0);
        assert_eq!(seeing_bits(&held, true), 0);
        assert_eq!(
            rank_bits(&held),
            MANAGE_CHANNELS | KICK | READ_PERMS | DELETE_MESSAGES
        );
        assert!(!can_moderate(rank_bits(&moderator()), rank_bits(&held)));
    }

    #[test]
    fn a_rules_lock_is_a_timeout() {
        let locked = channel_manager(Gate::RulesLock);
        assert_eq!(
            seeing_bits(&locked, true) & MANAGE_CHANNELS,
            MANAGE_CHANNELS
        );
        assert_eq!(acting_bits(&locked, true), READ_PERMS);
    }

    #[test]
    fn a_pending_admin_acts_and_sees_nothing_and_keeps_rank() {
        let admin = Member {
            is_admin: true,
            perms: 0,
            gate: Gate::Pending,
        };
        assert_eq!(acting_bits(&admin, true), 0);
        assert_eq!(seeing_bits(&admin, true), 0);
        assert_eq!(rank_bits(&admin), 4095);
        assert_eq!(acting_bits(&admin, false), 4095);
        let held = Member {
            gate: Gate::Held,
            ..admin
        };
        assert_eq!(acting_bits(&held, false), 0);
    }

    #[test]
    fn explicit_admin_bits_and_role_bits_are_masked() {
        let explicit = Member {
            is_admin: true,
            perms: KICK | 1 << 20,
            gate: Gate::In,
        };
        assert_eq!(rank_bits(&explicit), KICK);
        let roles = Member {
            is_admin: false,
            perms: 0,
            gate: Gate::In,
        };
        assert_eq!(rank_bits(&roles), 0);
    }

    #[test]
    fn pending_and_locked_owners_keep_authority_and_a_held_owner_pauses() {
        let owner = |gate: Gate, perms: u32| Member {
            is_admin: false,
            perms,
            gate,
        };
        assert_eq!(
            owner_status(Some(&owner(Gate::Pending, KICK)), BAN_NEEDS),
            Status::Ok
        );
        assert_eq!(
            owner_status(Some(&owner(Gate::RulesLock, KICK)), BAN_NEEDS),
            Status::Ok
        );
        assert_eq!(
            owner_status(Some(&owner(Gate::Held, KICK)), BAN_NEEDS),
            Status::PausedOwner
        );
        assert_eq!(
            owner_status(Some(&owner(Gate::In, 0)), BAN_NEEDS),
            Status::PausedOwner
        );
        assert_eq!(
            owner_status(Some(&owner(Gate::In, KICK)), BAN_NEEDS),
            Status::Ok
        );
        assert_eq!(owner_status(None, BAN_NEEDS), Status::PausedOwner);
    }

    #[test]
    fn can_moderate_needs_a_strict_superset() {
        assert!(can_moderate(KICK | DELETE_MESSAGES, KICK));
        assert!(!can_moderate(KICK, KICK));
        assert!(!can_moderate(KICK, DELETE_MESSAGES));
        assert!(can_moderate(KICK, 0));
        assert!(!can_moderate(0, 0));
    }
}
