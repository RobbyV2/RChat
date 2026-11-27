use crate::Mask;
use crate::eval::{Channel, Mode, Ow, Who, channel_mask};
use crate::masks::{SEND, VIEW};
use crate::registry::value;
use crate::rules::Ruleset;

/// The subjects whose mask gains View or Send between two sets of overwrites.
pub fn widens(before: &[(String, Mask)], after: &[(String, Mask)]) -> Vec<String> {
    gains(before, after, VIEW | SEND)
}

fn gains(before: &[(String, Mask)], after: &[(String, Mask)], bits: Mask) -> Vec<String> {
    after
        .iter()
        .filter(|(subject, mask)| {
            let was = before
                .iter()
                .find(|(s, _)| s == subject)
                .map_or(0, |(_, m)| *m);
            mask & !was & bits != 0
        })
        .map(|(subject, _)| subject.clone())
        .collect()
}

/// A channel's rule: its subject (`everyone`, a role or `u:<member>`), allow, deny and mode.
pub type Rule<'a> = (&'a str, Ow, Mode);

/// The channel the rules are on.
#[derive(Clone, Copy, Debug)]
pub struct Place {
    pub restrict_view: bool,
    pub restrict_send: bool,
    pub voice: bool,
}

/// Who a mask is asked for: the roles they hold and, for a member subject, their own rule.
struct Holder<'a> {
    roles: Vec<&'a str>,
    member: Option<&'a str>,
}

/// What `who` holds in a channel with `rules`. Without View they hold nothing there.
fn mask_of(
    rules: &[Rule],
    who: &Holder,
    everyone: (&str, Mask),
    role_bits: &dyn Fn(&str) -> Mask,
    place: Place,
    r: &Ruleset,
) -> Mask {
    let (everyone_subject, everyone_bits) = everyone;
    let row = |s: &str| rules.iter().find(|(x, _, _)| *x == s);
    let roles: Vec<Ow> = who
        .roles
        .iter()
        .filter_map(|s| row(s).map(|(_, ow, _)| *ow))
        .collect();
    let ch = Channel {
        everyone: row(everyone_subject).map(|(_, ow, _)| *ow),
        restrict_view: place.restrict_view,
        restrict_send: place.restrict_send,
        voice: place.voice,
        roles: &roles,
        member: who
            .member
            .and_then(|m| row(m).map(|(_, ow, mode)| (*ow, *mode))),
    };
    let held = who.roles.iter().fold(0, |bits, s| bits | role_bits(s));
    let mask = channel_mask(
        &Who::Member { roles: held },
        everyone_bits,
        &ch,
        false,
        false,
        r,
    );
    if mask & VIEW == 0 { 0 } else { mask }
}

/// The subjects that gain View or Send (Connect in a voice channel) in a channel whose rules
/// `before` become `after`, each compared as one kind of member: @everyone (`everyone`: the
/// subject of its row and its bits) as a member without roles; each role of either set as a
/// member holding only it (`role_bits`); each pair of those roles as a member holding both,
/// named `a+b`, when neither alone gains (allows beat denies across roles); and each member
/// subject (`u:`) with the roles they hold (`member_roles`).
pub fn widened(
    before: &[Rule],
    after: &[Rule],
    everyone: (&str, Mask),
    role_bits: &dyn Fn(&str) -> Mask,
    member_roles: &dyn Fn(&str) -> Vec<String>,
    place: Place,
    r: &Ruleset,
) -> Vec<String> {
    let bits = match place.voice {
        true => VIEW | value("Connect"),
        false => VIEW | SEND,
    };
    let gained = |who: &Holder| {
        let was = mask_of(before, who, everyone, role_bits, place, r);
        let now = mask_of(after, who, everyone, role_bits, place, r);
        now & !was & bits != 0
    };
    let mut roles: Vec<&str> = Vec::new();
    let mut members: Vec<&str> = Vec::new();
    for (s, _, _) in before.iter().chain(after) {
        let list = match s.starts_with("u:") {
            true => &mut members,
            false => &mut roles,
        };
        if *s != everyone.0 && !list.contains(s) {
            list.push(s);
        }
    }
    let mut out = Vec::new();
    let none = Holder {
        roles: Vec::new(),
        member: None,
    };
    if gained(&none) {
        out.push(everyone.0.to_string());
    }
    let single: Vec<bool> = roles
        .iter()
        .map(|s| {
            gained(&Holder {
                roles: vec![s],
                member: None,
            })
        })
        .collect();
    for (s, g) in roles.iter().zip(&single) {
        if *g {
            out.push(s.to_string());
        }
    }
    for i in 0..roles.len() {
        for j in i + 1..roles.len() {
            let both = Holder {
                roles: vec![roles[i], roles[j]],
                member: None,
            };
            if !single[i] && !single[j] && gained(&both) {
                out.push(format!("{}+{}", roles[i], roles[j]));
            }
        }
    }
    for m in members {
        let held = member_roles(m);
        let who = Holder {
            roles: held.iter().map(String::as_str).collect(),
            member: Some(m),
        };
        if gained(&who) {
            out.push(m.to_string());
        }
    }
    out
}
