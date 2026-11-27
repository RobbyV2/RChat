//! The shared permission rules for the client. Masks cross as `f64` (every value is below 2^53).
//! `rules` is 0 for a hosted server and the rules version for a P2P room.

use rchat_perms::Mask;
use rchat_perms::delta::{self, Refusal};
use rchat_perms::eval::{self, Channel, Mode, Ow, Who};
use rchat_perms::hier::{self, Actor, Rank, Tie, Tier};
use rchat_perms::rules::{self, HOSTED, Ruleset};
use wasm_bindgen::prelude::*;

const RESTRICT_VIEW: u32 = 1;
const RESTRICT_SEND: u32 = 2;
const VOICE: u32 = 4;
const EVERYONE_ROW: u32 = 8;
const MEMBER_ROW: u32 = 16;
const TIMED_OUT: u32 = 32;
const ACTING: u32 = 64;

fn mask(x: f64) -> Mask {
    x as Mask
}

fn ruleset(rules: i32) -> Option<&'static Ruleset> {
    match rules {
        0 => Some(&HOSTED),
        v => rules::p2p(i64::from(v)),
    }
}

fn who(kind: u8, who_mask: f64, who_roles: f64) -> Who {
    match kind {
        0 => Who::Staff,
        1 => Who::Owner,
        2 => Who::Admin {
            mask: mask(who_mask),
            roles: mask(who_roles),
        },
        3 => Who::Member {
            roles: mask(who_mask),
        },
        signed => Who::Visitor {
            signed_in: signed == 5,
            caps: mask(who_mask),
        },
    }
}

fn tier(kind: u8) -> Tier {
    match kind {
        1 => Tier::Plain,
        2 => Tier::Role,
        3 => Tier::Admin,
        4 => Tier::Owner,
        5 => Tier::Staff,
        _ => Tier::Outside,
    }
}

fn rank(kind: u8, pos: f64, tie_int: f64, tie_str: &Option<String>, admin_mask: f64) -> Rank<'_> {
    Rank {
        tier: tier(kind),
        pos: pos as i64,
        tie: match tie_str {
            Some(s) => Tie::Str(s),
            None => Tie::Int(tie_int as i64),
        },
        admin_mask: mask(admin_mask),
    }
}

fn held(held_above: u8) -> Option<bool> {
    match held_above {
        0 => None,
        x => Some(x == 2),
    }
}

fn ids(xs: &[f64]) -> Vec<i64> {
    xs.iter().map(|x| *x as i64).collect()
}

fn floats(xs: Vec<i64>) -> Vec<f64> {
    xs.into_iter().map(|x| x as f64).collect()
}

fn refusal(r: Result<(), Refusal>) -> u8 {
    match r {
        Ok(()) => 0,
        Err(Refusal::Grants(_)) => 1,
        Err(Refusal::DeniesModeration(_)) => 2,
        Err(Refusal::Outranked) => 3,
    }
}

fn ow(allow: f64, deny: f64) -> Option<Ow> {
    Some(Ow {
        allow: mask(allow),
        deny: mask(deny),
    })
}

#[wasm_bindgen]
pub fn perms_registry() -> String {
    rchat_perms::registry::json()
}

#[wasm_bindgen]
pub fn perms_known(rules: i32) -> f64 {
    ruleset(rules).map_or(0, |r| r.known) as f64
}

#[wasm_bindgen]
pub fn perms_from_wire(wire: u32, rules: i32) -> f64 {
    rules::from_wire(wire, i64::from(rules)) as f64
}

#[wasm_bindgen]
pub fn perms_to_wire(mask_: f64, rules: i32, keep: u32) -> u32 {
    rules::to_wire(mask(mask_), i64::from(rules), keep)
}

/// `who_roles` is the union of an admin's role masks.
#[wasm_bindgen]
pub fn perms_server_bits(
    who_kind: u8,
    who_mask: f64,
    who_roles: f64,
    everyone: f64,
    rules: i32,
) -> f64 {
    ruleset(rules).map_or(0, |r| {
        eval::server_bits(&who(who_kind, who_mask, who_roles), mask(everyone), r)
    }) as f64
}

/// `role_rows` is (allow, deny) pairs; `mem_mode` is 1 for a merged member row.
#[wasm_bindgen]
#[allow(clippy::too_many_arguments)]
pub fn perms_channel_mask(
    who_kind: u8,
    who_mask: f64,
    who_roles: f64,
    everyone: f64,
    ev_allow: f64,
    ev_deny: f64,
    flags: u32,
    role_rows: &[f64],
    mem_allow: f64,
    mem_deny: f64,
    mem_mode: u8,
    rules: i32,
) -> f64 {
    let Some(r) = ruleset(rules) else { return 0.0 };
    let roles: Vec<Ow> = role_rows
        .as_chunks::<2>()
        .0
        .iter()
        .map(|[allow, deny]| Ow {
            allow: mask(*allow),
            deny: mask(*deny),
        })
        .collect();
    let mode = match mem_mode {
        1 => Mode::Merge,
        _ => Mode::Override,
    };
    let ch = Channel {
        everyone: ow(ev_allow, ev_deny).filter(|_| flags & EVERYONE_ROW != 0),
        restrict_view: flags & RESTRICT_VIEW != 0,
        restrict_send: flags & RESTRICT_SEND != 0,
        voice: flags & VOICE != 0,
        roles: &roles,
        member: ow(mem_allow, mem_deny)
            .filter(|_| flags & MEMBER_ROW != 0)
            .map(|o| (o, mode)),
    };
    eval::channel_mask(
        &who(who_kind, who_mask, who_roles),
        mask(everyone),
        &ch,
        flags & TIMED_OUT != 0,
        flags & ACTING != 0,
        r,
    ) as f64
}

/// What a channel gives everyone before any role or member row. `flags` holds the restrict
/// bits and whether there is an @everyone row.
#[wasm_bindgen]
pub fn perms_everyone_stage(
    everyone: f64,
    ev_allow: f64,
    ev_deny: f64,
    flags: u32,
    rules: i32,
) -> f64 {
    let Some(r) = ruleset(rules) else { return 0.0 };
    let ch = Channel {
        everyone: ow(ev_allow, ev_deny).filter(|_| flags & EVERYONE_ROW != 0),
        restrict_view: flags & RESTRICT_VIEW != 0,
        restrict_send: flags & RESTRICT_SEND != 0,
        voice: false,
        roles: &[],
        member: None,
    };
    eval::everyone_stage(mask(everyone), &ch, r) as f64
}

/// The row a hosted rule stands for, as (allow, deny, 1 when it merges with role rows). `flags`
/// is 1 can view, 2 can send, 4 can read history, 8 a member's row, 16 a merged row.
#[wasm_bindgen]
pub fn perms_derived_row(allow: f64, deny: f64, flags: u32) -> Vec<f64> {
    let mode = match flags & 16 {
        0 => Mode::Override,
        _ => Mode::Merge,
    };
    let (Ow { allow, deny }, mode) = eval::derived_row(
        mask(allow),
        mask(deny),
        mode,
        flags & 1 != 0,
        flags & 2 != 0,
        flags & 4 != 0,
        flags & 8 != 0,
    );
    vec![
        allow as f64,
        deny as f64,
        f64::from(u8::from(mode == Mode::Merge)),
    ]
}

/// A rank is (tier 0-5 from outside to staff, position, integer tie, string tie, admin mask).
/// The string tie is used when it is given.
#[wasm_bindgen]
#[allow(clippy::too_many_arguments)]
pub fn perms_outranks(
    a_tier: u8,
    a_pos: f64,
    a_tie_int: f64,
    a_tie_str: Option<String>,
    a_mask: f64,
    b_tier: u8,
    b_pos: f64,
    b_tie_int: f64,
    b_tie_str: Option<String>,
    b_mask: f64,
) -> bool {
    hier::outranks(
        &rank(a_tier, a_pos, a_tie_int, &a_tie_str, a_mask),
        &rank(b_tier, b_pos, b_tie_int, &b_tie_str, b_mask),
    )
}

#[wasm_bindgen]
#[allow(clippy::too_many_arguments)]
pub fn perms_at_least(
    a_tier: u8,
    a_pos: f64,
    a_tie_int: f64,
    a_tie_str: Option<String>,
    a_mask: f64,
    b_tier: u8,
    b_pos: f64,
    b_tie_int: f64,
    b_tie_str: Option<String>,
    b_mask: f64,
) -> bool {
    hier::at_least(
        &rank(a_tier, a_pos, a_tie_int, &a_tie_str, a_mask),
        &rank(b_tier, b_pos, b_tie_int, &b_tie_str, b_mask),
    )
}

#[wasm_bindgen]
#[allow(clippy::too_many_arguments)]
pub fn perms_may_moderate(
    a_tier: u8,
    a_pos: f64,
    a_tie_int: f64,
    a_tie_str: Option<String>,
    a_mask: f64,
    a_bits: f64,
    t_tier: u8,
    t_pos: f64,
    t_tie_int: f64,
    t_tie_str: Option<String>,
    t_mask: f64,
    t_bits: f64,
    need: f64,
    guard: bool,
) -> bool {
    hier::may_moderate(
        &Actor {
            rank: rank(a_tier, a_pos, a_tie_int, &a_tie_str, a_mask),
            bits: mask(a_bits),
        },
        &Actor {
            rank: rank(t_tier, t_pos, t_tie_int, &t_tie_str, t_mask),
            bits: mask(t_bits),
        },
        mask(need),
        guard,
    )
}

/// `held_above` is 0 without the order guard, 1 when its test fails and 2 when it passes.
#[wasm_bindgen]
#[allow(clippy::too_many_arguments)]
pub fn perms_manages_role(
    a_tier: u8,
    a_pos: f64,
    a_tie_int: f64,
    a_tie_str: Option<String>,
    a_mask: f64,
    a_bits: f64,
    role_pos: f64,
    role_tie_int: f64,
    role_tie_str: Option<String>,
    held_above: u8,
) -> bool {
    hier::manages_role(
        &Actor {
            rank: rank(a_tier, a_pos, a_tie_int, &a_tie_str, a_mask),
            bits: mask(a_bits),
        },
        &rank(2, role_pos, role_tie_int, &role_tie_str, 0.0),
        held(held_above),
    )
}

/// The role ranks as a role at its position and tie (the @everyone role is position -1 with an
/// empty tie). `held_above` is as for `perms_manages_role`.
#[wasm_bindgen]
#[allow(clippy::too_many_arguments)]
pub fn perms_may_assign(
    a_tier: u8,
    a_pos: f64,
    a_tie_int: f64,
    a_tie_str: Option<String>,
    a_mask: f64,
    a_bits: f64,
    role_pos: f64,
    role_tie_int: f64,
    role_tie_str: Option<String>,
    held_above: u8,
    role_bits: f64,
    allows_ok: bool,
    has_target: bool,
    t_tier: u8,
    t_pos: f64,
    t_tie_int: f64,
    t_tie_str: Option<String>,
    t_mask: f64,
    rules: i32,
) -> bool {
    let Some(r) = ruleset(rules) else {
        return false;
    };
    let target = Actor {
        rank: rank(t_tier, t_pos, t_tie_int, &t_tie_str, t_mask),
        bits: 0,
    };
    hier::may_assign(
        &Actor {
            rank: rank(a_tier, a_pos, a_tie_int, &a_tie_str, a_mask),
            bits: mask(a_bits),
        },
        &rank(2, role_pos, role_tie_int, &role_tie_str, 0.0),
        held(held_above),
        mask(role_bits),
        allows_ok,
        has_target.then_some(&target),
        r,
    )
}

#[wasm_bindgen]
pub fn perms_granted(b_allow: f64, b_deny: f64, a_allow: f64, a_deny: f64) -> f64 {
    delta::granted(ow(b_allow, b_deny), ow(a_allow, a_deny)) as f64
}

#[wasm_bindgen]
pub fn perms_denied(b_allow: f64, b_deny: f64, a_allow: f64, a_deny: f64) -> f64 {
    delta::denied(ow(b_allow, b_deny), ow(a_allow, a_deny)) as f64
}

/// 0 when allowed, 1 when it grants bits the actor lacks, 2 when it denies moderation bits the
/// actor lacks, 3 when the actor does not outrank the subject.
#[wasm_bindgen]
#[allow(clippy::too_many_arguments)]
pub fn perms_check_overwrite_edit(
    actor_mask: f64,
    exempt: bool,
    b_allow: f64,
    b_deny: f64,
    a_allow: f64,
    a_deny: f64,
    subject_ok: bool,
) -> u8 {
    refusal(delta::check_overwrite_edit(
        mask(actor_mask),
        exempt,
        ow(b_allow, b_deny),
        ow(a_allow, a_deny),
        subject_ok,
    ))
}

#[wasm_bindgen]
pub fn perms_check_bits_edit(actor_bits: f64, exempt: bool, before: f64, after: f64) -> u8 {
    refusal(delta::check_bits_edit(
        mask(actor_bits),
        exempt,
        mask(before),
        mask(after),
    ))
}

#[wasm_bindgen]
pub fn perms_reorder(current: &[f64], requested: &[f64], manageable: &[f64]) -> Vec<f64> {
    let manageable = ids(manageable);
    floats(rchat_perms::order::reorder(
        &ids(current),
        &ids(requested),
        &|id| manageable.contains(&id),
    ))
}

#[wasm_bindgen]
pub fn perms_moved(before: &[f64], after: &[f64]) -> Vec<f64> {
    floats(rchat_perms::order::moved(&ids(before), &ids(after)))
}

/// Subjects are joined with newlines, one mask each; the answer is joined the same way.
#[wasm_bindgen]
pub fn perms_widens(
    before_subjects: &str,
    before_masks: &[f64],
    after_subjects: &str,
    after_masks: &[f64],
) -> String {
    let rows = |subjects: &str, masks: &[f64]| -> Vec<(String, Mask)> {
        subjects
            .split('\n')
            .zip(masks)
            .map(|(s, m)| (s.to_string(), mask(*m)))
            .collect()
    };
    rchat_perms::sync::widens(
        &rows(before_subjects, before_masks),
        &rows(after_subjects, after_masks),
    )
    .join("\n")
}
