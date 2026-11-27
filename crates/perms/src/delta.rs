use crate::Mask;
use crate::eval::Ow;
use crate::masks::MOD_CHANNEL;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Refusal {
    Grants(Mask),
    DeniesModeration(Mask),
    Outranked,
}

/// The bits an overwrite edit newly allows or stops denying.
pub fn granted(before: Option<Ow>, after: Option<Ow>) -> Mask {
    let (b, a) = (before.unwrap_or_default(), after.unwrap_or_default());
    (a.allow & !b.allow) | (b.deny & !a.deny)
}

/// The bits an overwrite edit newly denies.
pub fn denied(before: Option<Ow>, after: Option<Ow>) -> Mask {
    let (b, a) = (before.unwrap_or_default(), after.unwrap_or_default());
    a.deny & !b.deny
}

/// An overwrite edit may grant only what the actor holds in that channel, and may deny a
/// moderation bit only when the actor holds it and outranks the subject (`subject_ok`).
pub fn check_overwrite_edit(
    actor_mask: Mask,
    exempt: bool,
    before: Option<Ow>,
    after: Option<Ow>,
    subject_ok: bool,
) -> Result<(), Refusal> {
    if exempt {
        return Ok(());
    }
    let over = granted(before, after) & !actor_mask;
    let taken = denied(before, after) & MOD_CHANNEL;
    match (over, taken & !actor_mask, taken != 0 && !subject_ok) {
        (0, 0, false) => Ok(()),
        (0, 0, true) => Err(Refusal::Outranked),
        (0, missing, _) => Err(Refusal::DeniesModeration(missing)),
        (over, _, _) => Err(Refusal::Grants(over)),
    }
}

/// A role or @everyone edit may add only bits the actor holds.
pub fn check_bits_edit(
    actor_bits: Mask,
    exempt: bool,
    before: Mask,
    after: Mask,
) -> Result<(), Refusal> {
    match (exempt, after & !before & !actor_bits) {
        (true, _) | (false, 0) => Ok(()),
        (false, over) => Err(Refusal::Grants(over)),
    }
}

/// The mask a role or admin edit stores: the editor changes only bits within `may` (and `always`),
/// bits outside `known` are dropped.
pub fn update_bits(current: Mask, sent: Mask, may: Mask, always: Mask, known: Mask) -> Mask {
    ((current & !may) | (sent & (may | always))) & known
}
