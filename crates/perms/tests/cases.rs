use rchat_perms::Mask;
use rchat_perms::delta::check_bits_edit;
use rchat_perms::eval::{Channel, Mode, Ow, Who, channel_mask};
use rchat_perms::hier::{
    Actor, Rank, Tie, Tier, at_least, manages_role, may_assign, may_moderate, may_unassign,
    outranks,
};
use rchat_perms::masks::VOICE;
use rchat_perms::rules::{P2P_V2, P2P_V4, Ruleset, from_wire, p2p, to_wire};
use serde::Deserialize;

#[derive(Deserialize)]
struct Cases {
    p2p4: P2p4,
}

#[derive(Deserialize)]
struct P2p4 {
    channel_bits: Vec<BitCase>,
    channel_worlds: Vec<String>,
    auth_ranks: Vec<String>,
    auth_lists: Vec<String>,
    auth_worlds: Vec<AuthWorlds>,
    auth_cases: Vec<String>,
    voice_worlds: VoiceWorlds,
}

#[derive(Deserialize)]
struct VoiceWorlds {
    bits: Vec<u32>,
    out: String,
}

#[derive(Deserialize)]
struct AuthWorlds {
    t: String,
    held: Vec<u32>,
    a: bool,
    b: bool,
    lists: bool,
    flags: Vec<u32>,
    n: Vec<u32>,
    out: String,
}

#[derive(Deserialize)]
struct BitCase {
    bit: u32,
    out: String,
}

fn cases() -> Cases {
    let path =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../assets/perm_cases.json");
    serde_json::from_str(&std::fs::read_to_string(path).expect("read cases")).expect("cases json")
}

struct World {
    owner: bool,
    everyone: u32,
    roles: [u32; 2],
    holds: usize,
    rows: [Option<(u32, u32)>; 4],
    restrict: u32,
}

/// The member's mask in the channel.
fn mask_of(w: &World, rules: i64, r: &Ruleset, voice: bool) -> Mask {
    let World {
        owner,
        everyone,
        roles,
        holds,
        rows,
        restrict,
    } = w;
    let ow = |row: Option<(u32, u32)>| {
        row.map(|(allow, deny)| Ow {
            allow: from_wire(allow, rules),
            deny: from_wire(deny, rules),
        })
    };
    let held: u32 = roles[..*holds].iter().fold(0, |m, b| m | b);
    let who = match owner {
        true => Who::Owner,
        false => Who::Member {
            roles: from_wire(held, rules),
        },
    };
    let role_rows: Vec<Ow> = rows[1..1 + holds].iter().filter_map(|r| ow(*r)).collect();
    let ch = Channel {
        everyone: ow(rows[0]),
        restrict_view: restrict & 1 != 0,
        restrict_send: restrict & 2 != 0,
        voice,
        roles: &role_rows,
        member: ow(rows[3]).map(|o| (o, Mode::Override)),
    };
    channel_mask(&who, from_wire(*everyone, rules), &ch, false, true, r)
}

/// The wire mask of the member, or `None` for every bit.
fn run(w: &World, rules: i64, r: &Ruleset) -> Option<u32> {
    let mask = mask_of(w, rules, r, false);
    let held: u32 = w.roles[..w.holds].iter().fold(w.everyone, |m, b| m | b);
    match mask == r.known {
        true if w.owner || held & 1 != 0 => None,
        _ => Some(to_wire(mask, rules, 0)),
    }
}

fn tri(k: usize, b: u32) -> Option<(u32, u32)> {
    match k {
        0 => None,
        1 => Some((b, 0)),
        _ => Some((0, b)),
    }
}

#[test]
fn single_bit_channel_worlds_match_the_recorded_outputs() {
    for (rules, r) in [(2, &P2P_V2), (4, &P2P_V4)] {
        for BitCase { bit, out } in cases().p2p4.channel_bits {
            let mut want = out.chars();
            for i in 0..2 * 2 * 3 * 81 * 4 {
                let digit = |div: usize, radix: usize| (i / div) % radix;
                let w = World {
                    owner: false,
                    everyone: digit(1944, 2) as u32 * bit,
                    roles: [digit(972, 2) as u32 * bit, 0],
                    holds: digit(324, 3),
                    rows: [
                        tri(digit(108, 3), bit),
                        tri(digit(36, 3), bit),
                        tri(digit(12, 3), bit),
                        tri(digit(4, 3), bit),
                    ],
                    restrict: digit(1, 4) as u32,
                };
                let got = match run(&w, rules, r) {
                    None => 'A',
                    Some(m) if m & bit != 0 => '1',
                    Some(_) => '0',
                };
                assert_eq!(Some(got), want.next(), "bit {bit} case {i} rules {rules}");
            }
            assert_eq!(want.next(), None);
        }
    }
}

#[test]
fn random_channel_worlds_match_the_recorded_outputs() {
    for (rules, r) in [(2, &P2P_V2), (4, &P2P_V4)] {
        for line in cases().p2p4.channel_worlds {
            let n: Vec<i64> = line.split(' ').map(|x| x.parse().expect("int")).collect();
            let row = |k: usize| match n[5 + 2 * k] {
                -1 => None,
                allow => Some((allow as u32, n[6 + 2 * k] as u32)),
            };
            let w = World {
                owner: n[0] == 1,
                everyone: n[1] as u32,
                roles: [n[2] as u32, n[3] as u32],
                holds: n[4] as usize,
                rows: [row(0), row(1), row(2), row(3)],
                restrict: n[13] as u32,
            };
            let want = match n[14] {
                -1 => None,
                m => Some(m as u32),
            };
            assert_eq!(run(&w, rules, r), want, "{line} rules {rules}");
        }
    }
}

#[test]
fn voice_follows_view_as_recorded() {
    const VIEW_WIRE: u32 = 256;
    let VoiceWorlds { bits, out } = cases().p2p4.voice_worlds;
    let subset = |k: usize| {
        bits.iter()
            .enumerate()
            .filter(|(i, _)| k >> i & 1 != 0)
            .fold(0, |m, (_, b)| m | b)
    };
    for (rules, r) in [(2, &P2P_V2), (4, &P2P_V4)] {
        let mut want = out.chars();
        for i in 0..2 * 8 * 8 * 2 * 27 * 4 {
            let digit = |div: usize, radix: usize| (i / div) % radix;
            let w = World {
                owner: digit(13824, 2) == 1,
                everyone: subset(digit(1728, 8)),
                roles: [subset(digit(216, 8)), 0],
                holds: digit(108, 2),
                rows: [
                    tri(digit(36, 3), VIEW_WIRE),
                    tri(digit(12, 3), VIEW_WIRE),
                    None,
                    tri(digit(4, 3), VIEW_WIRE),
                ],
                restrict: digit(1, 4) as u32,
            };
            let got = match mask_of(&w, rules, r, true) & VOICE {
                0 => '0',
                VOICE => '1',
                _ => '?',
            };
            assert_eq!(Some(got), want.next(), "case {i} rules {rules}");
        }
        assert_eq!(want.next(), None);
    }
}

const TO_OWNER: u32 = 1;
const ROLE_EXISTS: u32 = 2;
const SELF: u32 = 4;
const WIPE: u32 = 8;
const ON: u32 = 16;
const ROLE_SUBJECT: u32 = 32;
const MEMBER_SUBJECT: u32 = 64;

const KICK: u32 = 4;
const BAN: u32 = 32;
const CHANNELS: u32 = 1;
const MESSAGES: u32 = 2;
const EVERY_WIRE_BIT: u32 = 0x7fff_ffff;

fn rank(s: &str) -> Rank<'_> {
    match s {
        "T" => Rank::of(Tier::Owner),
        "N" => Rank::of(Tier::Outside),
        "-" | "-1/" => Rank::of(Tier::Plain),
        s => {
            let (pos, tie) = s.split_once('/').expect("rank");
            Rank {
                tier: Tier::Role,
                pos: pos.parse().expect("position"),
                tie: Tie::Str(tie),
                admin_mask: 0,
            }
        }
    }
}

fn at_rank<'a>(rank: &Rank<'a>) -> Actor<'a> {
    Actor {
        rank: *rank,
        bits: 0,
    }
}

/// The authority decision of one recorded line (without its output), as P2P devices take it.
fn decide(line: &str, rules: i64) -> bool {
    let f: Vec<&str> = line.split(' ').collect();
    let (t, mem, owner) = (f[0], f[1] == "1", f[2] == "1");
    let wire: u32 = match owner {
        true => EVERY_WIRE_BIT,
        false => f[3].parse().expect("held"),
    };
    let (me, a, b) = (rank(f[4]), rank(f[5]), rank(f[6]));
    let flags: u32 = f[8].parse().expect("flags");
    let n: u32 = f[9].parse().expect("n");
    let held = from_wire(wire, rules);
    let unknown = |bits: u32| bits & !to_wire(from_wire(bits, rules), rules, 0);
    let has = |bits: u32| held & from_wire(bits, rules) != 0 || wire & unknown(bits) != 0;
    let above = |r: &Rank| outranks(&me, r);
    let flag = |x: u32| flags & x != 0;
    let actor = Actor {
        rank: me,
        bits: held,
    };
    let target = at_rank(&b);
    let moderates = |need: u32| may_moderate(&actor, &target, from_wire(need, rules), false);
    let manages = |role: &Rank| manages_role(&actor, role, None);
    let ruleset = p2p(rules).expect("rules");
    mem && match t {
        "kick" => !flag(TO_OWNER) && moderates(KICK),
        "ban" => !flag(TO_OWNER) && moderates(BAN) && (!flag(WIPE) || has(MESSAGES)),
        "unban" => {
            has(BAN)
                && f[7]
                    .split(',')
                    .filter(|s| *s != "-")
                    .all(|s| at_least(&me, &rank(s)))
        }
        "role_create" => {
            manages(&a)
                && check_bits_edit(held, false, 0, from_wire(n, rules)).is_ok()
                && unknown(n) & !wire == 0
        }
        "role_move" => flag(ROLE_EXISTS) && manages(&a) && manages(&b),
        "role_bits" => flag(ROLE_EXISTS) && manages(&a) && (!flag(ON) || has(n)),
        "role_del" => flag(ROLE_EXISTS) && manages(&a),
        "assign" => {
            flag(ROLE_EXISTS)
                && !flag(TO_OWNER)
                && may_assign(&actor, &a, false, 0, true, Some(&target), ruleset)
        }
        "revoke" => flag(SELF) || may_unassign(&actor, &a, false, Some(&target)),
        "chperm" => {
            has(CHANNELS)
                && match (flag(ROLE_SUBJECT), flag(MEMBER_SUBJECT)) {
                    (true, _) => above(&a),
                    (false, true) => above(&b),
                    (false, false) => false,
                }
        }
        "c:redact" => flag(SELF) || owner || (has(MESSAGES) && above(&b)),
        "c:pin" => has(MESSAGES),
        other => panic!("unknown type {other}"),
    }
}

#[test]
fn small_authority_worlds_match_the_recorded_outputs() {
    let Cases { p2p4 } = cases();
    let none = vec!["-".to_string()];
    for rules in [2, 4] {
        for w in &p2p4.auth_worlds {
            let mut want = w.out.chars();
            let (a, b, lists) = (
                if w.a { &p2p4.auth_ranks } else { &none },
                if w.b { &p2p4.auth_ranks } else { &none },
                if w.lists { &p2p4.auth_lists } else { &none },
            );
            for mem in 0..2 {
                for owner in 0..2 {
                    for held in &w.held {
                        for me in &p2p4.auth_ranks {
                            for a in a {
                                for b in b {
                                    for list in lists {
                                        for flags in &w.flags {
                                            for n in &w.n {
                                                let line = format!(
                                                    "{} {mem} {owner} {held} {me} {a} {b} {list} {flags} {n}",
                                                    w.t
                                                );
                                                let got = match decide(&line, rules) {
                                                    true => '1',
                                                    false => '0',
                                                };
                                                assert_eq!(
                                                    Some(got),
                                                    want.next(),
                                                    "{line} rules {rules}"
                                                );
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
            assert_eq!(want.next(), None);
        }
    }
}

#[test]
fn recorded_authority_decisions_match() {
    for rules in [2, 4] {
        for line in cases().p2p4.auth_cases {
            let (input, out) = line.rsplit_once(' ').expect("output");
            assert_eq!(decide(input, rules), out == "1", "{line} rules {rules}");
        }
    }
}
