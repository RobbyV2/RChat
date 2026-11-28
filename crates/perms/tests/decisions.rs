use rchat_perms::delta::{
    Refusal, check_bits_edit, check_overwrite_edit, denied, granted, taken, update_bits,
};
use rchat_perms::eval::{
    Channel, DEFAULT_EVERYONE, Mode, Ow, Who, channel_mask, derived_row, server_bits, visitor_mask,
};
use rchat_perms::hier::{
    Actor, Rank, Tie, Tier, at_least, manages_role, may_assign, may_moderate, may_unassign,
    outranks,
};
use rchat_perms::masks::{
    ALL, ASSIGN_ROLES, BASE, CHANNEL, HISTORY, MANAGE_CHANNELS, MANAGE_ROLES, MANAGER_PASS, MGMT,
    SEND, SEND_GROUP, TIMED_OUT_KEEP, VIEW,
};
use rchat_perms::order::{moved, reorder};
use rchat_perms::registry::value;
use rchat_perms::rules::{HOSTED, P2P_V4, P2P_V5};
use rchat_perms::sync::widens;

const OPEN: Channel = Channel {
    everyone: None,
    restrict_view: false,
    restrict_send: false,
    voice: false,
    roles: &[],
    member: None,
};

fn role(pos: i64, tie: Tie) -> Rank {
    Rank {
        tier: Tier::Role,
        pos,
        tie,
        admin_mask: 0,
    }
}

fn admin(mask: u64) -> Rank<'static> {
    Rank {
        admin_mask: mask,
        ..Rank::of(Tier::Admin)
    }
}

#[test]
fn rows_stored_with_flags_only_are_read_from_the_flags() {
    let (ow, mode) = derived_row(0, 0, Mode::Override, true, false, true, false);
    assert_eq!(ow.allow, VIEW | HISTORY);
    assert_eq!(ow.deny, SEND_GROUP);
    assert_eq!(mode, Mode::Override);
    let (_, mode) = derived_row(0, 0, Mode::Override, true, true, true, true);
    assert_eq!(mode, Mode::Merge);
    let (ow, mode) = derived_row(VIEW, SEND, Mode::Override, false, false, false, true);
    assert_eq!((ow.allow, ow.deny, mode), (VIEW, SEND, Mode::Override));
}

#[test]
fn server_bits_follow_the_kind_of_member() {
    assert_eq!(server_bits(&Who::Staff, BASE, &HOSTED), ALL);
    assert_eq!(server_bits(&Who::Owner, BASE, &HOSTED), ALL);
    let admin_who = |mask, roles| Who::Admin { mask, roles };
    assert_eq!(server_bits(&admin_who(0, 0), BASE, &HOSTED), ALL);
    assert_eq!(
        server_bits(&admin_who(4 | VIEW, 0), 0, &HOSTED),
        4,
        "an admin mask carries management bits only"
    );
    assert_eq!(
        server_bits(&admin_who(4, 2 | VIEW), 0, &HOSTED),
        4 | VIEW,
        "roles add only base bits to admins"
    );
    assert_eq!(
        server_bits(&Who::Member { roles: 4 | 1 << 40 }, BASE, &HOSTED),
        4 | BASE
    );
    let visitor = Who::Visitor {
        signed_in: true,
        caps: ALL,
    };
    assert_eq!(server_bits(&visitor, BASE, &HOSTED), 0);
}

#[test]
fn hosted_channel_masks_apply_overwrites_in_order() {
    let member = Who::Member { roles: 0 };
    let mask =
        |ch: &Channel, who: &Who| channel_mask(who, DEFAULT_EVERYONE, ch, false, true, &HOSTED);
    assert_eq!(mask(&OPEN, &member), BASE & CHANNEL);
    let closed = Channel {
        restrict_view: true,
        ..OPEN
    };
    assert_eq!(mask(&closed, &member), 0, "no view means nothing");
    let deny = Ow {
        allow: 0,
        deny: SEND,
    };
    let allow = Ow {
        allow: SEND | VIEW,
        deny: 0,
    };
    let rows = [deny, allow];
    let both = Channel {
        roles: &rows,
        ..closed
    };
    assert_eq!(
        mask(&both, &member) & (VIEW | SEND),
        VIEW | SEND,
        "an allow beats a deny"
    );
    let own = Channel {
        member: Some((deny, Mode::Override)),
        ..both
    };
    assert_eq!(mask(&own, &member) & (VIEW | SEND), VIEW);
    let merged = Channel {
        member: Some((deny, Mode::Merge)),
        ..both
    };
    assert_eq!(mask(&merged, &member) & (VIEW | SEND), VIEW | SEND);
    let manager = Who::Member {
        roles: MANAGE_CHANNELS,
    };
    assert_eq!(mask(&own, &manager), MANAGER_PASS);
    let moderator = Who::Member { roles: 2 };
    assert_eq!(mask(&OPEN, &moderator), BASE & CHANNEL | 2);
    let no_mod = Channel {
        everyone: Some(Ow { allow: 0, deny: 2 }),
        ..OPEN
    };
    assert_eq!(mask(&no_mod, &moderator), BASE & CHANNEL);
    assert_eq!(
        mask(&no_mod, &Who::Admin { mask: 2, roles: 0 }) & 2,
        2,
        "admins keep moderation bits"
    );
    assert_eq!(mask(&no_mod, &Who::Staff) & 2, 2);
    assert_eq!(
        channel_mask(&member, BASE, &OPEN, true, true, &HOSTED),
        BASE & TIMED_OUT_KEEP
    );
    assert_eq!(
        channel_mask(&member, BASE, &OPEN, true, false, &HOSTED),
        BASE & CHANNEL
    );
    assert_eq!(
        channel_mask(&member, VIEW, &OPEN, true, true, &P2P_V4),
        VIEW,
        "wire rules below 5 have no timeouts"
    );
}

#[test]
fn visitors_get_everyone_within_their_caps() {
    let caps = VIEW | HISTORY | SEND | value("Connect") | value("Speak") | value("Video");
    let got = visitor_mask(false, caps, BASE, &OPEN);
    assert_eq!(got, caps & !value("Video"));
    let quiet = Channel {
        restrict_send: true,
        voice: true,
        ..OPEN
    };
    assert_eq!(visitor_mask(false, caps, BASE, &quiet), VIEW | HISTORY);
    let own = Channel {
        member: Some((
            Ow {
                allow: 0,
                deny: VIEW,
            },
            Mode::Override,
        )),
        ..OPEN
    };
    assert_eq!(visitor_mask(true, caps, BASE, &own), 0);
    assert_ne!(visitor_mask(false, caps, BASE, &own), 0);
    let who = Who::Visitor {
        signed_in: false,
        caps: VIEW,
    };
    assert_eq!(channel_mask(&who, BASE, &OPEN, false, true, &HOSTED), VIEW);
}

#[test]
fn ranks_order_by_tier_then_position_then_tie() {
    let (staff, owner) = (Rank::of(Tier::Staff), Rank::of(Tier::Owner));
    let (plain, outside) = (Rank::of(Tier::Plain), Rank::of(Tier::Outside));
    assert!(outranks(&staff, &staff) && outranks(&staff, &owner));
    assert!(!outranks(&owner, &owner) && at_least(&owner, &owner));
    assert!(outranks(&owner, &admin(4)) && outranks(&admin(4), &role(9, Tie::Int(1))));
    assert!(outranks(&admin(4 | 1), &admin(4)));
    assert!(!outranks(&admin(4), &admin(1)) && !outranks(&admin(1), &admin(4)));
    assert!(!at_least(&admin(4), &admin(1)));
    assert!(outranks(&role(2, Tie::Str("a")), &role(1, Tie::Str("z"))));
    assert!(outranks(&role(1, Tie::Str("b")), &role(1, Tie::Str("a"))));
    assert!(outranks(&role(1, Tie::Int(-3)), &role(1, Tie::Int(-7))));
    assert!(!outranks(&role(1, Tie::Int(5)), &role(1, Tie::Int(5))));
    assert!(outranks(&role(0, Tie::Str("a")), &plain) && outranks(&plain, &outside));
    assert!(outranks(&role(-1, Tie::Str("a")), &plain));
    assert!(outranks(&plain, &role(-2, Tie::Str("a"))));
    assert!(!outranks(&plain, &plain) && !outranks(&outside, &outside));
}

#[test]
fn moderation_needs_the_bit_and_the_rank_or_a_strict_superset_under_the_guard() {
    let actor = |rank, bits| Actor { rank, bits };
    let (hi, lo) = (role(2, Tie::Int(0)), role(1, Tie::Int(0)));
    assert!(may_moderate(&actor(hi, 4), &actor(lo, 4 | 1), 4, false));
    assert!(!may_moderate(&actor(hi, 1), &actor(lo, 0), 4, false));
    assert!(!may_moderate(&actor(lo, 4), &actor(hi, 0), 4, false));
    assert!(!may_moderate(&actor(hi, 4), &actor(lo, 4), 4, true));
    assert!(may_moderate(&actor(lo, 4 | 1), &actor(hi, 4), 4, true));
    assert!(!may_moderate(&actor(hi, 4), &actor(lo, 1), 4, true));
    assert!(may_moderate(
        &actor(Rank::of(Tier::Staff), 0),
        &actor(hi, ALL),
        4,
        true
    ));
    assert!(
        may_moderate(&actor(hi, 4 | VIEW), &actor(lo, VIEW), 0, true),
        "base bits do not count"
    );
}

#[test]
fn role_management_needs_manage_roles_and_a_rank_above_the_role() {
    let actor = |rank, bits| Actor { rank, bits };
    let (hi, mid) = (role(3, Tie::Int(0)), role(2, Tie::Int(0)));
    let manager = actor(hi, MANAGE_ROLES | 4);
    assert!(manages_role(&manager, &mid, None));
    assert!(!manages_role(&manager, &hi, None));
    assert!(!manages_role(&manager, &mid, Some(false)));
    assert!(manages_role(&manager, &mid, Some(true)));
    assert!(!manages_role(&actor(hi, ASSIGN_ROLES | 4), &mid, None));
    let owner = Rank::of(Tier::Owner);
    assert!(manages_role(&actor(owner, ALL), &hi, Some(false)));
    assert!(!manages_role(&actor(owner, 0), &hi, None));
    assert!(
        !manages_role(&actor(owner, ALL), &owner, None),
        "an owner does not outrank a role ranked as an owner"
    );
    assert!(manages_role(
        &actor(Rank::of(Tier::Staff), 0),
        &owner,
        Some(false)
    ));
}

#[test]
fn assignment_needs_assign_roles_the_rank_and_under_a_grant_check_the_bits() {
    let actor = |rank, bits| Actor { rank, bits };
    let (hi, mid, lo) = (
        role(3, Tie::Int(0)),
        role(2, Tie::Int(0)),
        role(1, Tie::Int(0)),
    );
    let giver = actor(hi, ASSIGN_ROLES | 4);
    let target = actor(lo, 0);
    let gives = |a: &Actor, role: &Rank, bits, allows, t: Option<&Actor>, r| {
        may_assign(a, role, false, bits, allows, t, r)
    };
    assert!(gives(&giver, &mid, 4, true, Some(&target), &HOSTED));
    assert!(gives(&giver, &mid, 4, true, None, &HOSTED));
    assert!(!gives(&giver, &hi, 4, true, None, &HOSTED));
    assert!(!gives(
        &actor(hi, MANAGE_ROLES | 4),
        &mid,
        4,
        true,
        None,
        &HOSTED
    ));
    assert!(!gives(&giver, &mid, 1, true, Some(&target), &HOSTED));
    assert!(!gives(&giver, &mid, 4, false, Some(&target), &P2P_V5));
    assert!(gives(&giver, &mid, 1, false, Some(&target), &P2P_V4));
    assert!(!gives(&giver, &mid, 4, true, Some(&actor(hi, 0)), &HOSTED));
    let owner = actor(Rank::of(Tier::Owner), ALL);
    assert!(gives(&owner, &mid, ALL, false, Some(&target), &HOSTED));
    assert!(gives(
        &actor(Rank::of(Tier::Staff), 0),
        &hi,
        ALL,
        false,
        Some(&owner),
        &HOSTED
    ));
    let wide = actor(lo, ASSIGN_ROLES | 4 | 1);
    let narrow = actor(hi, 4);
    assert!(
        !may_assign(
            &giver,
            &mid,
            true,
            4,
            true,
            Some(&actor(lo, ASSIGN_ROLES | 4)),
            &HOSTED
        ),
        "under the order guard the target must hold strictly less"
    );
    assert!(may_assign(
        &giver,
        &mid,
        true,
        4,
        true,
        Some(&target),
        &HOSTED
    ));
    assert!(
        !may_assign(&wide, &mid, true, 4, true, Some(&narrow), &HOSTED),
        "the guard does not replace the rank above the role"
    );
}

#[test]
fn taking_a_role_needs_assign_roles_and_the_ranks_unless_it_is_your_own() {
    let actor = |rank, bits| Actor { rank, bits };
    let (hi, mid, lo) = (
        role(3, Tie::Int(0)),
        role(2, Tie::Int(0)),
        role(1, Tie::Int(0)),
    );
    let giver = actor(hi, ASSIGN_ROLES);
    assert!(may_unassign(&actor(lo, 0), &hi, false, None));
    assert!(may_unassign(&giver, &mid, false, Some(&actor(lo, 0))));
    assert!(!may_unassign(&giver, &hi, false, Some(&actor(lo, 0))));
    assert!(!may_unassign(&giver, &mid, false, Some(&actor(hi, 0))));
    assert!(!may_unassign(
        &actor(hi, MANAGE_ROLES),
        &mid,
        false,
        Some(&actor(lo, 0))
    ));
    assert!(!may_unassign(
        &giver,
        &mid,
        true,
        Some(&actor(lo, ASSIGN_ROLES))
    ));
}

#[test]
fn edits_grant_only_what_the_actor_holds() {
    let ow = |allow, deny| Some(Ow { allow, deny });
    assert_eq!(granted(None, ow(VIEW, SEND)), VIEW);
    assert_eq!(granted(ow(0, SEND), None), SEND);
    assert_eq!(denied(ow(0, SEND), ow(0, SEND | VIEW)), VIEW);
    assert_eq!(
        check_overwrite_edit(VIEW, false, None, ow(VIEW, 0), true),
        Ok(())
    );
    assert_eq!(
        check_overwrite_edit(VIEW, false, None, ow(VIEW | SEND, 0), true),
        Err(Refusal::Grants(SEND))
    );
    assert_eq!(
        check_overwrite_edit(0, true, None, ow(VIEW | SEND, 2), false),
        Ok(())
    );
    assert_eq!(
        check_overwrite_edit(0, false, None, ow(0, VIEW), false),
        Ok(())
    );
    assert_eq!(
        check_overwrite_edit(0, false, None, ow(0, 2), true),
        Err(Refusal::DeniesModeration(2))
    );
    assert_eq!(
        check_overwrite_edit(2, false, None, ow(0, 2), false),
        Err(Refusal::Outranked)
    );
    assert_eq!(check_overwrite_edit(2, false, None, ow(0, 2), true), Ok(()));
    assert_eq!(taken(ow(2 | VIEW, 0), None), 2);
    assert_eq!(taken(ow(2, 0), ow(0, 2 | SEND)), 2);
    assert_eq!(taken(ow(VIEW, 0), ow(0, VIEW)), 0);
    assert_eq!(
        check_overwrite_edit(0, false, ow(2, 0), None, true),
        Ok(()),
        "deleting an allow the actor lacks"
    );
    assert_eq!(
        check_overwrite_edit(0, false, ow(2, 0), None, false),
        Err(Refusal::Outranked)
    );
    assert_eq!(
        check_overwrite_edit(SEND, false, ow(2, 0), ow(SEND, 0), false),
        Err(Refusal::Outranked)
    );
    assert_eq!(check_bits_edit(4, false, 1, 1 | 4), Ok(()));
    assert_eq!(check_bits_edit(4, false, 0, 1 | 4), Err(Refusal::Grants(1)));
    assert_eq!(check_bits_edit(0, true, 0, ALL), Ok(()));
    assert_eq!(
        update_bits(1 | 4 | 4096, 4096 | 8192 | 2, 8192, 1023, MGMT),
        1 | 2 | 4 | 4096 | 8192
    );
    assert_eq!(update_bits(0, 1 << 40, 1 << 40, 0, MGMT), 0);
}

#[test]
fn reorder_keeps_unmanageable_slots() {
    let all = |_: i64| true;
    assert_eq!(reorder(&[1, 2, 3], &[3, 1, 2], &all), vec![3, 1, 2]);
    assert_eq!(reorder(&[1, 2, 3], &[3, 9, 3], &all), vec![3, 1, 2]);
    let not_first = |id: i64| id != 1;
    assert_eq!(
        reorder(&[1, 2, 3, 4], &[4, 1, 3, 2], &not_first),
        vec![1, 4, 3, 2]
    );
    let middle_fixed = |id: i64| id != 2;
    assert_eq!(
        reorder(&[1, 2, 3], &[3, 2, 1], &middle_fixed),
        vec![3, 2, 1]
    );
    assert_eq!(reorder(&[], &[1], &all), Vec::<i64>::new());
}

#[test]
fn moved_names_the_ids_outside_the_longest_common_order() {
    assert_eq!(moved(&[1, 2, 3, 4], &[1, 2, 3, 4]), Vec::<i64>::new());
    assert_eq!(moved(&[1, 2, 3, 4], &[4, 1, 2, 3]), vec![4]);
    assert_eq!(moved(&[1, 2, 3], &[1, 5, 2, 3]), vec![5]);
    assert_eq!(moved(&[1, 2, 3, 4], &[2, 1, 4, 3]).len(), 2);
}

#[test]
fn widening_names_subjects_that_gain_view_or_send() {
    let s = |x: &str| x.to_string();
    let before = [(s("r:1"), VIEW), (s("r:2"), VIEW | SEND)];
    let after = [
        (s("r:1"), VIEW | SEND),
        (s("r:2"), VIEW),
        (s("u:a"), HISTORY),
        (s("u:b"), VIEW),
    ];
    assert_eq!(widens(&before, &after), vec![s("r:1"), s("u:b")]);
}
