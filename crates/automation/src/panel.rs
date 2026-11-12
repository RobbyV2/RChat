//! The role panel reducer, the self-service check per press, and P2P press handling.

use crate::grants::{self, self_service};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet, HashMap};

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Mode {
    Toggle,
    Unique,
    Verify,
    Drop,
    Reversed,
    Binding,
    Limit { n: u32 },
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Refusal {
    NotInPanel,
    Binding,
    Limit,
    TooMany,
    #[serde(untagged)]
    Grant(grants::Refusal),
}

/// What a press does to the presser's roles. `record` marks a binding panel's first pick.
#[derive(Clone, PartialEq, Eq, Debug, Default, Serialize, Deserialize)]
pub struct Change {
    pub add: Vec<i64>,
    pub remove: Vec<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refused: Option<Refusal>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub record: bool,
}

fn change(add: Vec<i64>, remove: Vec<i64>) -> Change {
    Change {
        add,
        remove,
        ..Change::default()
    }
}

fn refuse(why: Refusal) -> Change {
    Change {
        refused: Some(why),
        ..Change::default()
    }
}

/// A button press. `held` is every role the member holds, `panel` the panel's roles, `picked`
/// whether a binding panel already recorded a pick for them.
pub fn press(mode: &Mode, held: &[i64], panel: &[i64], role: i64, picked: bool) -> Change {
    if !panel.contains(&role) {
        return refuse(Refusal::NotInPanel);
    }
    let has = held.contains(&role);
    let mine = || -> Vec<i64> { held.iter().copied().filter(|r| panel.contains(r)).collect() };
    match (*mode, has) {
        (Mode::Toggle | Mode::Reversed | Mode::Unique | Mode::Drop, true) => {
            change(vec![], vec![role])
        }
        (Mode::Toggle | Mode::Reversed, false) => change(vec![role], vec![]),
        (Mode::Unique, false) => change(vec![role], mine()),
        (Mode::Verify, true) | (Mode::Drop, false) => Change::default(),
        (Mode::Verify, false) => change(vec![role], vec![]),
        (Mode::Binding, _) if picked => refuse(Refusal::Binding),
        (Mode::Binding, has) => Change {
            add: match has {
                true => vec![],
                false => vec![role],
            },
            record: true,
            ..Change::default()
        },
        (Mode::Limit { .. }, true) => change(vec![], vec![role]),
        (Mode::Limit { n }, false) => match mine().len() >= n as usize {
            true => refuse(Refusal::Limit),
            false => change(vec![role], vec![]),
        },
    }
}

/// A select menu, which submits the full set of picked panel roles.
pub fn select(mode: &Mode, held: &[i64], panel: &[i64], values: &[i64], picked: bool) -> Change {
    let mut want: Vec<i64> = Vec::new();
    for v in values {
        if !want.contains(v) {
            want.push(*v);
        }
    }
    if want.iter().any(|v| !panel.contains(v)) {
        return refuse(Refusal::NotInPanel);
    }
    let add: Vec<i64> = want.iter().copied().filter(|v| !held.contains(v)).collect();
    let drop: Vec<i64> = held
        .iter()
        .copied()
        .filter(|r| panel.contains(r) && !want.contains(r))
        .collect();
    match *mode {
        Mode::Toggle | Mode::Reversed => change(add, drop),
        Mode::Unique if want.len() > 1 => refuse(Refusal::TooMany),
        Mode::Unique => change(add, drop),
        Mode::Limit { n } if want.len() > n as usize => refuse(Refusal::Limit),
        Mode::Limit { .. } => change(add, drop),
        Mode::Verify => change(add, vec![]),
        Mode::Drop => change(
            vec![],
            want.into_iter().filter(|v| held.contains(v)).collect(),
        ),
        Mode::Binding if picked => refuse(Refusal::Binding),
        Mode::Binding => Change {
            add,
            record: true,
            ..Change::default()
        },
    }
}

/// The self-service rule at press time: every role a change would add must pass with its
/// current bits. Removing a role is always allowed.
pub fn checked(
    c: Change,
    bits: impl Fn(i64) -> u32,
    may_give: impl Fn(i64) -> bool,
    owner_bits: u32,
) -> Change {
    if c.refused.is_some() {
        return c;
    }
    match c
        .add
        .iter()
        .find_map(|&r| self_service(bits(r), may_give(r), owner_bits))
    {
        Some(why) => refuse(Refusal::Grant(why)),
        None => c,
    }
}

/// Whether a button shows as pressed for the viewer. Reversed panels show the opted-out state.
pub fn shown_pressed(mode: &Mode, held: &[i64], role: i64) -> bool {
    held.contains(&role) != matches!(mode, Mode::Reversed)
}

/// The desired state a P2P press carries: on or off for a button, the full set for a menu.
#[derive(Clone, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Want {
    On,
    Off,
    #[serde(untagged)]
    Set(Vec<i64>),
}

/// The change that brings `held` to `want`, within what the panel's buttons and menus can do in
/// its mode: a unique panel holds one role, a limited one at most `n`, verify only gives, drop
/// only takes, and a binding pick is never changed (a member holding a panel role has picked).
/// Applying the same want twice changes nothing the second time.
pub fn apply_want(mode: &Mode, want: &Want, held: &[i64], panel: &[i64], role: i64) -> Change {
    let mine: Vec<i64> = held.iter().copied().filter(|r| panel.contains(r)).collect();
    let on = match want {
        Want::Set(set) => {
            let mut want: Vec<i64> = Vec::new();
            for r in set.iter().copied().filter(|r| panel.contains(r)) {
                if !want.contains(&r) {
                    want.push(r);
                }
            }
            let add: Vec<i64> = want.iter().copied().filter(|r| !held.contains(r)).collect();
            let remove: Vec<i64> = mine.iter().copied().filter(|r| !want.contains(r)).collect();
            return match *mode {
                Mode::Unique if want.len() > 1 => refuse(Refusal::TooMany),
                Mode::Limit { n } if want.len() > n as usize => refuse(Refusal::Limit),
                Mode::Binding if !mine.is_empty() && !add.is_empty() => refuse(Refusal::Binding),
                Mode::Verify | Mode::Binding => change(add, vec![]),
                Mode::Drop => change(vec![], remove),
                Mode::Toggle | Mode::Reversed | Mode::Unique | Mode::Limit { .. } => {
                    change(add, remove)
                }
            };
        }
        Want::On => true,
        Want::Off => false,
    };
    if !panel.contains(&role) {
        return refuse(Refusal::NotInPanel);
    }
    match (on, held.contains(&role), *mode) {
        (false, true, Mode::Verify | Mode::Binding) | (false, false, _) => Change::default(),
        (false, true, _) => change(vec![], vec![role]),
        (true, true, _) | (true, false, Mode::Drop) => Change::default(),
        (true, false, Mode::Limit { n }) if mine.len() >= n as usize => refuse(Refusal::Limit),
        (true, false, Mode::Binding) if !mine.is_empty() => refuse(Refusal::Binding),
        (true, false, Mode::Unique) => change(vec![role], mine),
        (true, false, _) => change(vec![role], vec![]),
    }
}

/// An event of a DAG: its id and the ids it follows.
#[derive(Clone, PartialEq, Eq, Debug, Serialize, Deserialize)]
pub struct Event {
    pub id: String,
    pub deps: Vec<String>,
}

fn order<'a>(events: impl Iterator<Item = (&'a str, &'a [String])>) -> Vec<String> {
    let mut deps: BTreeMap<&str, &[String]> = BTreeMap::new();
    for (id, d) in events {
        deps.entry(id).or_insert(d);
    }
    let mut waiting: HashMap<&str, usize> = HashMap::new();
    let mut after: HashMap<&str, Vec<&str>> = HashMap::new();
    let mut ready: BTreeSet<&str> = BTreeSet::new();
    for (&id, d) in &deps {
        let held: BTreeSet<&str> = d
            .iter()
            .map(String::as_str)
            .filter(|d| deps.contains_key(d))
            .collect();
        for d in &held {
            after.entry(d).or_default().push(id);
        }
        match held.len() {
            0 => {
                ready.insert(id);
            }
            n => {
                waiting.insert(id, n);
            }
        }
    }
    let mut out = Vec::with_capacity(deps.len());
    while let Some(id) = ready.pop_first() {
        out.push(id.to_string());
        for next in after.remove(id).unwrap_or_default() {
            let left = waiting.entry(next).or_default();
            *left -= 1;
            if *left == 0 {
                ready.insert(next);
            }
        }
    }
    out
}

/// A deterministic topological order: Kahn's algorithm, taking the smallest id among the ready
/// events at each step. Every reader that holds the same events gets the same order, whatever
/// order they arrived in. Dependencies on events not held are ignored.
pub fn topo_order(events: &[Event]) -> Vec<String> {
    order(events.iter().map(|e| (e.id.as_str(), e.deps.as_slice())))
}

/// One identity's press on one panel role. `at` is when this runner received it, in
/// milliseconds, and counts only for the stability rule.
#[derive(Clone, PartialEq, Eq, Debug, Serialize, Deserialize)]
pub struct Press {
    pub id: String,
    pub deps: Vec<String>,
    pub want: Want,
    #[serde(default)]
    pub at: i64,
}

fn press_order(presses: &[Press]) -> Vec<String> {
    order(presses.iter().map(|p| (p.id.as_str(), p.deps.as_slice())))
}

/// The identity's latest press in causal order, never by a device's sequence number.
pub fn latest_press(presses: &[Press]) -> Option<&Press> {
    let last = press_order(presses).pop()?;
    presses.iter().find(|p| p.id == last)
}

/// What a runner does for one identity and one panel role: bring the role to the latest want,
/// within the panel's mode.
pub fn reconcile(mode: &Mode, presses: &[Press], held: &[i64], panel: &[i64], role: i64) -> Change {
    match latest_press(presses) {
        Some(p) => apply_want(mode, &p.want, held, panel, role),
        None => Change::default(),
    }
}

/// Whether a role op caused by press `cause` makes this runner reconcile: only when it knows
/// that press and a later one.
pub fn counters(presses: &[Press], cause: &str) -> bool {
    let order = press_order(presses);
    order
        .iter()
        .position(|id| id == cause)
        .is_some_and(|i| i + 1 < order.len())
}

pub const STABLE_MS: i64 = 3_000;

/// Whether the latest want has been the latest for 3 seconds.
pub fn stable(presses: &[Press], now: i64) -> bool {
    latest_press(presses).is_some_and(|p| now - p.at >= STABLE_MS)
}

pub const OPS_PER_HOUR: usize = 10;
const HOUR_MS: i64 = 3_600_000;

/// At most 10 role ops an hour per member and panel.
#[derive(Default, Debug)]
pub struct OpCap {
    ops: HashMap<(String, String), Vec<i64>>,
}

impl OpCap {
    pub fn take(&mut self, member: &str, panel: &str, now: i64) -> bool {
        let recent = self
            .ops
            .entry((member.to_string(), panel.to_string()))
            .or_default();
        recent.retain(|&t| now - t < HOUR_MS);
        if recent.len() >= OPS_PER_HOUR {
            return false;
        }
        recent.push(now);
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::grants::{KICK, Refusal as Grant};

    const PANEL: [i64; 3] = [1, 2, 3];

    fn change(add: &[i64], remove: &[i64]) -> Change {
        Change {
            add: add.to_vec(),
            remove: remove.to_vec(),
            refused: None,
            record: false,
        }
    }

    fn refused(why: Refusal) -> Change {
        Change {
            refused: Some(why),
            ..change(&[], &[])
        }
    }

    fn p(mode: Mode, held: &[i64], role: i64, picked: bool) -> Change {
        press(&mode, held, &PANEL, role, picked)
    }

    fn s(mode: Mode, held: &[i64], values: &[i64], picked: bool) -> Change {
        select(&mode, held, &PANEL, values, picked)
    }

    #[test]
    fn toggle_adds_and_removes() {
        assert_eq!(p(Mode::Toggle, &[], 1, false), change(&[1], &[]));
        assert_eq!(p(Mode::Toggle, &[1, 9], 1, false), change(&[], &[1]));
    }

    #[test]
    fn unique_swaps_and_never_touches_roles_outside_the_panel() {
        assert_eq!(p(Mode::Unique, &[1, 9], 2, false), change(&[2], &[1]));
        assert_eq!(p(Mode::Unique, &[2], 2, false), change(&[], &[2]));
    }

    #[test]
    fn verify_only_adds_and_drop_only_removes() {
        assert_eq!(p(Mode::Verify, &[1], 1, false), change(&[], &[]));
        assert_eq!(p(Mode::Verify, &[], 1, false), change(&[1], &[]));
        assert_eq!(p(Mode::Drop, &[], 1, false), change(&[], &[]));
        assert_eq!(p(Mode::Drop, &[1], 1, false), change(&[], &[1]));
    }

    #[test]
    fn reversed_acts_like_toggle_and_shows_the_opted_out_state() {
        assert_eq!(p(Mode::Reversed, &[1], 1, false), change(&[], &[1]));
        assert_eq!(p(Mode::Reversed, &[], 1, false), change(&[1], &[]));
        assert!(!shown_pressed(&Mode::Reversed, &[1], 1));
        assert!(shown_pressed(&Mode::Reversed, &[], 1));
        assert!(shown_pressed(&Mode::Toggle, &[1], 1));
    }

    #[test]
    fn binding_records_the_first_pick_and_refuses_later_ones() {
        assert_eq!(
            p(Mode::Binding, &[], 2, false),
            Change {
                record: true,
                ..change(&[2], &[])
            }
        );
        assert_eq!(
            p(Mode::Binding, &[2], 2, false),
            Change {
                record: true,
                ..change(&[], &[])
            }
        );
        assert_eq!(p(Mode::Binding, &[2], 1, true), refused(Refusal::Binding));
    }

    #[test]
    fn limit_refuses_past_n_but_lets_you_remove() {
        let lim = Mode::Limit { n: 2 };
        assert_eq!(p(lim, &[1, 2], 3, false), refused(Refusal::Limit));
        assert_eq!(p(lim, &[1, 2], 2, false), change(&[], &[2]));
        assert_eq!(p(lim, &[1], 3, false), change(&[3], &[]));
        assert_eq!(p(lim, &[1, 9, 8], 3, false), change(&[3], &[]));
    }

    #[test]
    fn a_role_outside_the_panel_is_refused() {
        assert_eq!(p(Mode::Toggle, &[], 9, false), refused(Refusal::NotInPanel));
    }

    #[test]
    fn every_mode_against_every_held_state() {
        let modes = [
            Mode::Toggle,
            Mode::Unique,
            Mode::Verify,
            Mode::Drop,
            Mode::Reversed,
            Mode::Binding,
            Mode::Limit { n: 1 },
            Mode::Limit { n: 3 },
        ];
        for mode in modes {
            for mask in 0..8u8 {
                let held: Vec<i64> = PANEL
                    .iter()
                    .copied()
                    .filter(|r| mask & (1 << (r - 1)) != 0)
                    .chain([9])
                    .collect();
                for role in PANEL {
                    let c = p(mode, &held, role, false);
                    assert!(c.add.iter().all(|r| PANEL.contains(r) && !held.contains(r)));
                    assert!(
                        c.remove
                            .iter()
                            .all(|r| PANEL.contains(r) && held.contains(r))
                    );
                    assert!(c.refused.is_none() || (c.add.is_empty() && c.remove.is_empty()));
                    let after: Vec<i64> = held
                        .iter()
                        .copied()
                        .filter(|r| !c.remove.contains(r))
                        .chain(c.add.iter().copied())
                        .collect();
                    let mine = after.iter().filter(|r| PANEL.contains(r)).count();
                    match mode {
                        Mode::Unique => assert!(mine <= 1.max(held.len() - 1)),
                        Mode::Limit { n } => assert!(mine <= (n as usize).max(held.len() - 1)),
                        Mode::Verify => assert!(c.remove.is_empty()),
                        Mode::Drop => assert!(c.add.is_empty()),
                        Mode::Binding => assert!(c.record && c.remove.is_empty()),
                        Mode::Toggle | Mode::Reversed => {
                            assert_eq!(after.contains(&role), !held.contains(&role))
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn select_toggle_sets_the_panel_roles_to_the_picks() {
        assert_eq!(
            s(Mode::Toggle, &[1, 9], &[2, 3], false),
            change(&[2, 3], &[1])
        );
        assert_eq!(s(Mode::Toggle, &[1], &[2, 2], false), change(&[2], &[1]));
        assert_eq!(
            s(Mode::Toggle, &[], &[9], false),
            refused(Refusal::NotInPanel)
        );
    }

    #[test]
    fn select_unique_and_limit_bound_the_picks() {
        assert_eq!(
            s(Mode::Unique, &[], &[1, 2], false),
            refused(Refusal::TooMany)
        );
        assert_eq!(s(Mode::Unique, &[1], &[2], false), change(&[2], &[1]));
        assert_eq!(
            s(Mode::Limit { n: 1 }, &[], &[1, 2], false),
            refused(Refusal::Limit)
        );
        assert_eq!(
            s(Mode::Limit { n: 2 }, &[3], &[1, 2], false),
            change(&[1, 2], &[3])
        );
    }

    #[test]
    fn select_verify_never_removes_and_drop_removes_the_picks() {
        assert_eq!(s(Mode::Verify, &[1], &[2], false), change(&[2], &[]));
        assert_eq!(s(Mode::Drop, &[1, 2], &[2, 3], false), change(&[], &[2]));
    }

    #[test]
    fn select_binding_once() {
        assert_eq!(
            s(Mode::Binding, &[], &[1], false),
            Change {
                record: true,
                ..change(&[1], &[])
            }
        );
        assert_eq!(
            s(Mode::Binding, &[1], &[2], true),
            refused(Refusal::Binding)
        );
    }

    #[test]
    fn a_role_that_gained_kick_is_refused_when_added_and_can_be_removed() {
        let bits = |r: i64| if r == 2 { KICK } else { 0 };
        assert_eq!(
            checked(p(Mode::Toggle, &[], 2, false), bits, |_| false, 4095),
            refused(Refusal::Grant(Grant::GivesPermissions))
        );
        assert_eq!(
            checked(p(Mode::Toggle, &[2], 2, false), bits, |_| false, 4095),
            change(&[], &[2])
        );
        assert_eq!(
            checked(p(Mode::Toggle, &[], 2, false), bits, |r| r == 2, 4095),
            change(&[2], &[])
        );
        assert_eq!(
            checked(p(Mode::Toggle, &[], 2, false), bits, |r| r == 2, 0),
            refused(Refusal::Grant(Grant::OwnerCantGrant))
        );
        assert_eq!(
            checked(p(Mode::Toggle, &[], 9, false), bits, |_| false, 4095),
            refused(Refusal::NotInPanel)
        );
    }

    #[test]
    fn refusals_have_their_stored_names() {
        let json = |c: &Change| serde_json::to_string(c).expect("json");
        assert_eq!(
            json(&refused(Refusal::Grant(Grant::GivesPermissions))),
            r#"{"add":[],"remove":[],"refused":"gives_permissions"}"#
        );
        assert_eq!(
            json(&refused(Refusal::NotInPanel)),
            r#"{"add":[],"remove":[],"refused":"not_in_panel"}"#
        );
        assert_eq!(json(&change(&[1], &[])), r#"{"add":[1],"remove":[]}"#);
        let back: Change =
            serde_json::from_str(r#"{"add":[],"remove":[],"refused":"owner_cant_grant"}"#)
                .expect("change");
        assert_eq!(back, refused(Refusal::Grant(Grant::OwnerCantGrant)));
        let mode: Mode = serde_json::from_str(r#"{"kind":"limit","n":2}"#).expect("mode");
        assert_eq!(mode, Mode::Limit { n: 2 });
    }

    fn run(wants: &[Want], role: i64, start: &[i64]) -> Vec<i64> {
        let mut held = start.to_vec();
        for w in wants {
            let c = apply_want(&Mode::Toggle, w, &held, &PANEL, role);
            held.retain(|r| !c.remove.contains(r));
            held.extend(c.add);
        }
        held.sort();
        held
    }

    #[test]
    fn on_then_off_converges_to_off_once_the_last_want_wins() {
        assert_eq!(run(&[Want::On, Want::Off], 1, &[]), [] as [i64; 0]);
        assert_eq!(
            run(&[Want::Off, Want::On, Want::Off], 1, &[]),
            [] as [i64; 0]
        );
        assert_eq!(run(&[Want::On, Want::On], 1, &[]), [1]);
    }

    #[test]
    fn the_same_want_applied_twice_is_a_no_op_the_second_time() {
        assert_eq!(
            apply_want(&Mode::Toggle, &Want::On, &[1], &PANEL, 1),
            change(&[], &[])
        );
        assert_eq!(
            apply_want(&Mode::Toggle, &Want::Off, &[], &PANEL, 1),
            change(&[], &[])
        );
        assert_eq!(
            apply_want(&Mode::Toggle, &Want::On, &[], &PANEL, 9),
            refused(Refusal::NotInPanel)
        );
    }

    #[test]
    fn menu_wants_set_the_panel_roles_exactly() {
        assert_eq!(
            apply_want(&Mode::Toggle, &Want::Set(vec![2, 3]), &[1, 9], &PANEL, 0),
            change(&[2, 3], &[1])
        );
        assert_eq!(
            apply_want(&Mode::Toggle, &Want::Set(vec![2, 7]), &[2], &PANEL, 0),
            change(&[], &[])
        );
        let want: Want = serde_json::from_str("[2,3]").expect("want");
        assert_eq!(want, Want::Set(vec![2, 3]));
        assert_eq!(
            serde_json::from_str::<Want>(r#""on""#).expect("want"),
            Want::On
        );
    }

    #[test]
    fn a_want_does_only_what_the_panel_mode_lets_its_buttons_and_menus_do() {
        let every = Want::Set(PANEL.to_vec());
        assert_eq!(
            apply_want(&Mode::Unique, &every, &[], &PANEL, 0),
            refused(Refusal::TooMany)
        );
        assert_eq!(
            apply_want(&Mode::Unique, &Want::On, &[1, 9], &PANEL, 2),
            change(&[2], &[1])
        );
        assert_eq!(
            apply_want(&Mode::Limit { n: 1 }, &Want::On, &[1], &PANEL, 2),
            refused(Refusal::Limit)
        );
        assert_eq!(
            apply_want(&Mode::Verify, &Want::Off, &[2], &PANEL, 2),
            change(&[], &[])
        );
        assert_eq!(
            apply_want(&Mode::Binding, &Want::On, &[1], &PANEL, 2),
            refused(Refusal::Binding)
        );
        assert_eq!(
            apply_want(&Mode::Drop, &Want::On, &[], &PANEL, 2),
            change(&[], &[])
        );
        let all = [pr("p", &[], every, 0)];
        assert_eq!(
            reconcile(&Mode::Unique, &all, &[], &PANEL, 0),
            refused(Refusal::TooMany)
        );
        assert_eq!(
            reconcile(&Mode::Toggle, &all, &[], &PANEL, 0),
            change(&PANEL, &[])
        );
    }

    fn pr(id: &str, deps: &[&str], want: Want, at: i64) -> Press {
        Press {
            id: id.into(),
            deps: deps.iter().map(|d| d.to_string()).collect(),
            want,
            at,
        }
    }

    fn permutations<T: Clone>(xs: &[T]) -> Vec<Vec<T>> {
        if xs.len() <= 1 {
            return vec![xs.to_vec()];
        }
        let mut out = Vec::new();
        for i in 0..xs.len() {
            let mut rest = xs.to_vec();
            let x = rest.remove(i);
            for mut tail in permutations(&rest) {
                tail.insert(0, x.clone());
                out.push(tail);
            }
        }
        out
    }

    #[test]
    fn every_interleaving_ends_at_the_latest_want_with_a_bounded_number_of_ops() {
        struct Op {
            add: bool,
            cause: String,
        }
        let presses = [pr("p1", &[], Want::On, 0), pr("p2", &["p1"], Want::Off, 0)];
        let deliveries = permutations(&[(0usize, 0usize), (0, 1), (1, 0), (1, 1)]);
        let mut runs = 0;
        for order in &deliveries {
            for ops_at_once in [true, false] {
                let mut held: Vec<i64> = Vec::new();
                let mut op_count = 0;
                let mut seen: [Vec<Press>; 2] = [Vec::new(), Vec::new()];
                let mut queue: std::collections::VecDeque<Op> = Default::default();
                let act =
                    |seen: &[Press], held: &[i64], queue: &mut std::collections::VecDeque<Op>| {
                        let c = reconcile(&Mode::Toggle, seen, held, &PANEL, 1);
                        let cause = latest_press(seen).map(|p| p.id.clone()).unwrap_or_default();
                        if !c.add.is_empty() {
                            queue.push_back(Op {
                                add: true,
                                cause: cause.clone(),
                            });
                        }
                        if !c.remove.is_empty() {
                            queue.push_back(Op { add: false, cause });
                        }
                    };
                let deliver = |seen: &[Vec<Press>; 2],
                               held: &mut Vec<i64>,
                               queue: &mut std::collections::VecDeque<Op>,
                               op_count: &mut u32| {
                    let mut guard = 0;
                    while let Some(o) = queue.pop_front() {
                        guard += 1;
                        assert!(guard <= 50, "flapping");
                        *op_count += 1;
                        *held = if o.add { vec![1] } else { vec![] };
                        for who in seen {
                            if counters(who, &o.cause) {
                                act(who, held, queue);
                            }
                        }
                    }
                };
                for &(who, i) in order {
                    seen[who].push(presses[i].clone());
                    act(&seen[who], &held, &mut queue);
                    if ops_at_once {
                        deliver(&seen, &mut held, &mut queue, &mut op_count);
                    }
                }
                deliver(&seen, &mut held, &mut queue, &mut op_count);
                assert!(held.is_empty());
                assert!(op_count <= 6);
                runs += 1;
            }
        }
        assert_eq!(runs, 48);
    }

    #[test]
    fn a_phone_at_seq_40_then_a_desktop_at_seq_12_that_saw_it() {
        let phone = pr("ev-phone-40", &[], Want::On, 0);
        let desktop = pr("ev-desk-12", &["ev-phone-40"], Want::Off, 10);
        for ps in [
            [phone.clone(), desktop.clone()],
            [desktop.clone(), phone.clone()],
        ] {
            assert_eq!(latest_press(&ps).map(|p| p.id.as_str()), Some("ev-desk-12"));
            assert_eq!(
                reconcile(&Mode::Toggle, &ps, &[1], &PANEL, 1),
                change(&[], &[1])
            );
        }
        assert_eq!(latest_press(&[]), None);
        assert_eq!(
            reconcile(&Mode::Toggle, &[], &[1], &PANEL, 1),
            change(&[], &[])
        );
    }

    #[test]
    fn concurrent_presses_from_two_devices_resolve_the_same_on_every_runner() {
        let a = pr("ev-a", &[], Want::On, 0);
        let b = pr("ev-b", &[], Want::Off, 0);
        assert_eq!(
            latest_press(&[a.clone(), b.clone()]).map(|p| p.id.clone()),
            latest_press(&[b, a]).map(|p| p.id.clone())
        );
    }

    #[test]
    fn a_want_is_acted_on_only_once_it_has_been_the_latest_for_3_s() {
        let p = [pr("x", &[], Want::On, 1_000)];
        assert!(!stable(&p, 3_999));
        assert!(stable(&p, 4_000));
        assert!(!stable(&[], 4_000));
    }

    #[test]
    fn the_11th_role_op_in_an_hour_for_one_member_and_panel_is_refused() {
        let mut cap = OpCap::default();
        for i in 0..10 {
            assert!(cap.take("bob", "panel1", i * 1000));
        }
        assert!(!cap.take("bob", "panel1", 11_000));
        assert!(cap.take("carol", "panel1", 11_000));
        assert!(cap.take("bob", "panel1", 3_600_000 + 1));
    }

    #[test]
    fn counters_only_when_the_cause_is_known_and_older() {
        let presses = [pr("p1", &[], Want::On, 0), pr("p2", &["p1"], Want::Off, 0)];
        assert!(counters(&presses, "p1"));
        assert!(!counters(&presses, "p2"));
        assert!(!counters(&presses, "p9"));
        assert!(!counters(&presses[..1], "p1"));
    }

    fn ev(id: &str, deps: &[&str]) -> Event {
        Event {
            id: id.into(),
            deps: deps.iter().map(|d| d.to_string()).collect(),
        }
    }

    #[test]
    fn every_arrival_order_gives_the_same_topological_order() {
        let evs = [
            ev("c", &["a"]),
            ev("b", &[]),
            ev("a", &[]),
            ev("d", &["c", "b"]),
            ev("e", &["missing"]),
        ];
        let want = topo_order(&evs);
        assert_eq!(want, ["a", "b", "c", "d", "e"]);
        for p in permutations(&evs) {
            assert_eq!(topo_order(&p), want);
        }
    }

    #[test]
    fn a_cycle_or_a_repeated_event_never_hangs_the_order() {
        let cyclic = [ev("a", &["b"]), ev("b", &["a"]), ev("c", &[])];
        assert_eq!(topo_order(&cyclic), ["c"]);
        let twice = [ev("a", &[]), ev("a", &[]), ev("b", &["a"])];
        assert_eq!(topo_order(&twice), ["a", "b"]);
    }
}
