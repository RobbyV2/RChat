use crate::Mask;
use crate::masks::{
    BASE, HISTORY, MANAGE_CHANNELS, MGMT, MOD_CHANNEL, SEND, SEND_GROUP, TIMED_OUT_KEEP, VIEW,
};
use crate::registry::value;
use crate::rules::Ruleset;

#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub struct Ow {
    pub allow: Mask,
    pub deny: Mask,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Mode {
    Override,
    Merge,
}

/// An admin's `roles` is the union of its role masks: only their base bits count.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Who {
    Staff,
    Owner,
    Admin { mask: Mask, roles: Mask },
    Member { roles: Mask },
    Visitor { signed_in: bool, caps: Mask },
}

#[derive(Clone, Copy, Debug)]
pub struct Channel<'a> {
    pub everyone: Option<Ow>,
    pub restrict_view: bool,
    pub restrict_send: bool,
    pub voice: bool,
    pub roles: &'a [Ow],
    pub member: Option<(Ow, Mode)>,
}

fn apply(p: Mask, o: Ow) -> Mask {
    let Ow { allow, deny } = o;
    (p & !deny) | allow
}

fn flag(on: bool, bits: Mask) -> Mask {
    match on {
        true => bits,
        false => 0,
    }
}

/// The row a rule stands for. A rule stored with flags only (both masks 0) is read from them.
pub fn derived_row(
    allow: Mask,
    deny: Mask,
    mode: Mode,
    can_view: bool,
    can_send: bool,
    can_history: bool,
    member_row: bool,
) -> (Ow, Mode) {
    if allow != 0 || deny != 0 {
        return (Ow { allow, deny }, mode);
    }
    let allow = flag(can_view, VIEW) | flag(can_send, SEND_GROUP) | flag(can_history, HISTORY);
    let ow = Ow {
        allow,
        deny: (VIEW | SEND_GROUP | HISTORY) & !allow,
    };
    match member_row {
        true => (ow, Mode::Merge),
        false => (ow, Mode::Override),
    }
}

/// The server-wide bits of `who`, before any timeout.
pub fn server_bits(who: &Who, everyone: Mask, r: &Ruleset) -> Mask {
    let bits = match *who {
        Who::Staff | Who::Owner | Who::Admin { mask: 0, roles: _ } => r.known,
        Who::Admin { mask, roles } => (mask & MGMT) | everyone | (roles & BASE),
        Who::Member { roles } => everyone | roles,
        Who::Visitor {
            signed_in: _,
            caps: _,
        } => 0,
    };
    bits & r.known
}

fn restricted(p: Mask, ch: &Channel, view: Mask) -> Mask {
    p & !flag(ch.restrict_view, view) & !flag(ch.restrict_send, SEND_GROUP)
}

/// What the @everyone stage of a channel grants before any role or member overwrite.
pub fn everyone_stage(everyone: Mask, ch: &Channel, r: &Ruleset) -> Mask {
    let mut p = everyone & r.known & r.scope;
    if let Some(o) = ch.everyone {
        p = apply(p, o) & r.scope;
    }
    restricted(p, ch, r.view_group)
}

/// Whether taking an overwrite away from a member can widen their access: it denies a bit the
/// @everyone stage grants, for someone who views the channel without it. They do when the stage
/// grants View, or when one of `others` (the channel's other role and member rows) allows View
/// and says nothing about that bit.
pub fn narrows(row: Ow, others: &[Ow], everyone: Mask, ch: &Channel, r: &Ruleset) -> bool {
    let stage = everyone_stage(everyone, ch, r);
    let lost = row.deny & stage;
    let viewer = |o: &Ow| o.allow & VIEW != 0 && lost & !(o.allow | o.deny) != 0;
    lost != 0 && (stage & VIEW != 0 || others.iter().any(viewer))
}

/// What `who` holds in a channel. `acting` applies a timeout; reads pass false.
pub fn channel_mask(
    who: &Who,
    everyone: Mask,
    ch: &Channel,
    timed_out: bool,
    acting: bool,
    r: &Ruleset,
) -> Mask {
    if let Who::Visitor { signed_in, caps } = *who {
        return visitor_mask(signed_in, caps, everyone, ch);
    }
    let b = server_bits(who, everyone, r);
    let mut p = b & r.scope;
    if let Some(o) = ch.everyone {
        p = apply(p, o);
    }
    p = restricted(p, ch, r.view_group);
    let mut both = Ow::default();
    for o in ch.roles {
        both.allow |= o.allow;
        both.deny |= o.deny;
    }
    if let Some((o, Mode::Merge)) = ch.member {
        both.allow |= o.allow;
        both.deny |= o.deny;
    }
    p = apply(p, both);
    if let Some((o, Mode::Override)) = ch.member {
        p = apply(p, o);
    }
    if b & MANAGE_CHANNELS != 0 {
        p |= r.manager_pass;
    }
    let privileged = matches!(
        who,
        Who::Staff | Who::Owner | Who::Admin { mask: _, roles: _ }
    );
    if r.mod_pass && privileged {
        p |= b & MOD_CHANNEL;
    }
    p &= r.scope;
    if r.view_gates_all && p & VIEW == 0 {
        p = 0;
    }
    if r.timeouts && acting && timed_out {
        p &= TIMED_OUT_KEEP;
    }
    p
}

/// What a guest, a public reader or a signed-in non-member holds in a channel, within `caps`.
pub fn visitor_mask(signed_in: bool, caps: Mask, everyone: Mask, ch: &Channel) -> Mask {
    let mut p = everyone & crate::masks::CHANNEL;
    if let Some(o) = ch.everyone {
        p = apply(p, o);
    }
    p = restricted(p, ch, VIEW);
    if let (true, Some((o, _))) = (signed_in, ch.member) {
        p = apply(p, o);
    }
    let mut caps = caps;
    if ch.voice && p & SEND == 0 {
        caps &= !(value("Connect") | value("Speak"));
    }
    p &= caps & !value("Video");
    match p & VIEW {
        0 => 0,
        _ => p,
    }
}

/// The @everyone mask of a server that stores none.
pub const DEFAULT_EVERYONE: Mask = BASE;
