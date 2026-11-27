use crate::Mask;
use crate::masks::{ASSIGN_ROLES, MANAGE_ROLES, MGMT};
use crate::rules::Ruleset;
use std::cmp::Ordering;

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
pub enum Tier {
    Outside,
    Plain,
    Role,
    Admin,
    Owner,
    Staff,
}

/// Breaks a tie between roles at one position. Strings order by UTF-16 code unit, as P2P
/// devices compare role ids.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Tie<'a> {
    Int(i64),
    Str(&'a str),
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Rank<'a> {
    pub tier: Tier,
    pub pos: i64,
    pub tie: Tie<'a>,
    pub admin_mask: Mask,
}

impl Rank<'static> {
    pub const fn of(tier: Tier) -> Rank<'static> {
        Rank {
            tier,
            pos: PLAIN_POS,
            tie: Tie::Str(""),
            admin_mask: 0,
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Actor<'a> {
    pub rank: Rank<'a>,
    pub bits: Mask,
}

/// A member without roles ranks as a role at this position with the lowest tie.
const PLAIN_POS: i64 = -1;

fn tie_cmp(a: Tie, b: Tie) -> Ordering {
    match (a, b) {
        (Tie::Int(a), Tie::Int(b)) => a.cmp(&b),
        (Tie::Str(a), Tie::Str(b)) => a.encode_utf16().cmp(b.encode_utf16()),
        (Tie::Int(_), Tie::Str(_)) | (Tie::Str(_), Tie::Int(_)) => Ordering::Equal,
    }
}

fn above_plain(r: &Rank) -> Ordering {
    r.pos.cmp(&PLAIN_POS).then(match r.tie {
        Tie::Int(_) => Ordering::Greater,
        Tie::Str(s) => s.cmp(""),
    })
}

fn rank_cmp(a: &Rank, b: &Rank) -> Option<Ordering> {
    match (a.tier, b.tier) {
        (Tier::Role, Tier::Role) => Some(a.pos.cmp(&b.pos).then(tie_cmp(a.tie, b.tie))),
        (Tier::Role, Tier::Plain) => Some(above_plain(a)),
        (Tier::Plain, Tier::Role) => Some(above_plain(b).reverse()),
        (Tier::Admin, Tier::Admin) => {
            let (x, y) = (a.admin_mask & MGMT, b.admin_mask & MGMT);
            match (x == y, y & !x == 0, x & !y == 0) {
                (true, _, _) => Some(Ordering::Equal),
                (false, true, _) => Some(Ordering::Greater),
                (false, false, true) => Some(Ordering::Less),
                (false, false, false) => None,
            }
        }
        (Tier::Staff, Tier::Staff) => Some(Ordering::Greater),
        (x, y) => Some(x.cmp(&y)),
    }
}

/// Whether `a` ranks strictly above `b`. Equal ranks never outrank; staff outrank everyone.
pub fn outranks(a: &Rank, b: &Rank) -> bool {
    rank_cmp(a, b) == Some(Ordering::Greater)
}

/// Whether `a` ranks at or above `b`.
pub fn at_least(a: &Rank, b: &Rank) -> bool {
    matches!(rank_cmp(a, b), Some(Ordering::Greater | Ordering::Equal))
}

/// Whether `a` may moderate `t` with the bits `need`. While the order guard is on, the
/// management bits of `a` must be a strict superset of those of `t` instead of outranking.
pub fn may_moderate(a: &Actor, t: &Actor, need: Mask, guard: bool) -> bool {
    if a.rank.tier == Tier::Staff {
        return true;
    }
    let (x, y) = (a.bits & MGMT, t.bits & MGMT);
    a.bits & need == need
        && match guard {
            true => y & !x == 0 && x != y,
            false => outranks(&a.rank, &t.rank),
        }
}

/// Whether `a` manages a role: staff always, anyone else with Manage roles and a rank above the
/// role. `held_above_ok` is the extra test of the order guard, which owners skip.
pub fn manages_role(a: &Actor, role: &Rank, held_above_ok: Option<bool>) -> bool {
    let ranked = a.bits & MANAGE_ROLES != 0 && outranks(&a.rank, role);
    match a.rank.tier {
        Tier::Staff => true,
        Tier::Owner => ranked,
        Tier::Outside | Tier::Plain | Tier::Role | Tier::Admin => {
            ranked && held_above_ok.unwrap_or(true)
        }
    }
}

fn hands_out(a: &Actor, role: &Rank) -> bool {
    a.rank.tier == Tier::Staff || (a.bits & ASSIGN_ROLES != 0 && outranks(&a.rank, role))
}

/// Whether `a` may give a role to `target` (`None` is `a` itself): Assign roles and a rank above
/// the role, a target `a` may moderate, and under rules with a grant check the role's bits
/// within those of `a`. `allows_ok` says the role's overwrite allows are within the channel
/// masks of `a`.
pub fn may_assign(
    a: &Actor,
    role: &Rank,
    guard: bool,
    role_bits: Mask,
    allows_ok: bool,
    target: Option<&Actor>,
    r: &Ruleset,
) -> bool {
    let exempt = matches!(a.rank.tier, Tier::Staff | Tier::Owner);
    hands_out(a, role)
        && target.is_none_or(|t| may_moderate(a, t, 0, guard))
        && (!r.grant_check || exempt || (role_bits & r.known & !a.bits == 0 && allows_ok))
}

/// Whether `a` may take a role from `target` (`None` is `a` itself, who may always drop it).
pub fn may_unassign(a: &Actor, role: &Rank, guard: bool, target: Option<&Actor>) -> bool {
    target.is_none_or(|t| hands_out(a, role) && may_moderate(a, t, 0, guard))
}
