use rchat_perms::Mask;
use rchat_perms::delta::{Refusal, check_bits_edit, check_overwrite_edit};
use rchat_perms::eval::{Channel, DEFAULT_EVERYONE, Mode, Ow, Who, channel_mask, derived_row};
use rchat_perms::masks::{BASE, CHANNEL, READ_LINK, SEND_GROUP, WEBHOOK};
use rchat_perms::registry::BITS;
use rchat_perms::rules::{HOSTED, P2P_V5, Ruleset, from_wire, to_wire};
use serde::Deserialize;
use serde_json::Value;

#[derive(Deserialize)]
struct Cases {
    hosted: Hosted,
    p2p5: P2p5,
}

#[derive(Deserialize)]
struct Hosted {
    channel: Vec<ChannelCase>,
    edits: Vec<EditCase>,
    bits: Vec<BitsCase>,
    configured: Configured,
}

#[derive(Deserialize)]
struct P2p5 {
    channel: Vec<ChannelCase>,
    edits: Vec<EditCase>,
}

#[derive(Deserialize)]
struct Configured {
    webhook: Vec<Value>,
    read_link: Vec<Value>,
}

#[derive(Deserialize)]
struct Row {
    #[serde(default)]
    allow: Vec<Value>,
    #[serde(default)]
    deny: Vec<Value>,
    #[serde(default)]
    merge: bool,
    can: Option<String>,
}

#[derive(Deserialize)]
struct ChannelCase {
    name: String,
    who: String,
    #[serde(default)]
    mask: Vec<Value>,
    #[serde(default)]
    roles: Vec<Value>,
    #[serde(default)]
    caps: Vec<Value>,
    everyone: Option<Vec<Value>>,
    #[serde(default)]
    restrict: u8,
    #[serde(default)]
    voice: bool,
    ev: Option<Row>,
    #[serde(default)]
    rows: Vec<Row>,
    own: Option<Row>,
    #[serde(default)]
    timed_out: bool,
    #[serde(default)]
    acting: bool,
    out: Vec<Value>,
}

#[derive(Deserialize)]
struct EditCase {
    name: String,
    actor: Vec<Value>,
    exempt: bool,
    before: Option<Row>,
    after: Option<Row>,
    subject_ok: bool,
    out: u8,
}

#[derive(Deserialize)]
struct BitsCase {
    name: String,
    actor: Vec<Value>,
    exempt: bool,
    before: Vec<Value>,
    after: Vec<Value>,
    out: u8,
}

fn cases() -> Cases {
    let path =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../assets/perm_cases.json");
    serde_json::from_str(&std::fs::read_to_string(path).expect("read cases")).expect("cases json")
}

/// A list of bit names, numbers, the groups `OPEN` and `SEND_GROUP`, and `-name` removals.
fn mask(list: &[Value]) -> Mask {
    let one = |name: &str| match name {
        "OPEN" => BASE & CHANNEL,
        "SEND_GROUP" => SEND_GROUP,
        name => {
            BITS.iter()
                .find(|b| b.name == name)
                .unwrap_or_else(|| panic!("unknown bit {name}"))
                .value
        }
    };
    let mut m = 0;
    for v in list {
        match (v.as_u64(), v.as_str().map(|s| s.strip_prefix('-').ok_or(s))) {
            (Some(n), _) => m |= n,
            (None, Some(Err(name))) => m |= one(name),
            (None, Some(Ok(name))) => m &= !one(name),
            (None, None) => panic!("bad mask entry {v}"),
        }
    }
    m
}

fn row(r: &Row, member: bool, fit: &dyn Fn(Mask) -> Mask) -> (Ow, Mode) {
    let Row {
        allow,
        deny,
        merge,
        can,
    } = r;
    let mode = match merge {
        true => Mode::Merge,
        false => Mode::Override,
    };
    let has = |flag: char| can.as_deref().is_some_and(|c| c.contains(flag));
    let (allow, deny) = match can {
        Some(_) => (0, 0),
        None => (fit(mask(allow)), fit(mask(deny))),
    };
    derived_row(allow, deny, mode, has('v'), has('s'), has('h'), member)
}

fn channel_case(c: &ChannelCase, r: &Ruleset, fit: &dyn Fn(Mask) -> Mask) -> Mask {
    let ChannelCase {
        name: _,
        who,
        mask: admin,
        roles,
        caps,
        everyone,
        restrict,
        voice,
        ev,
        rows,
        own,
        timed_out,
        acting,
        out: _,
    } = c;
    let roles = fit(mask(roles));
    let who = match who.as_str() {
        "staff" => Who::Staff,
        "owner" => Who::Owner,
        "admin" => Who::Admin {
            mask: mask(admin),
            roles,
        },
        "member" => Who::Member { roles },
        "guest" | "visitor" => Who::Visitor {
            signed_in: who == "visitor",
            caps: mask(caps),
        },
        other => panic!("unknown who {other}"),
    };
    let role_rows: Vec<Ow> = rows.iter().map(|x| row(x, false, fit).0).collect();
    let ch = Channel {
        everyone: ev.as_ref().map(|x| row(x, false, fit).0),
        restrict_view: restrict & 1 != 0,
        restrict_send: restrict & 2 != 0,
        voice: *voice,
        roles: &role_rows,
        member: own.as_ref().map(|x| row(x, true, fit)),
    };
    let everyone = everyone.as_ref().map(|e| mask(e));
    channel_mask(
        &who,
        everyone.unwrap_or(DEFAULT_EVERYONE),
        &ch,
        *timed_out,
        *acting,
        r,
    )
}

fn refusal(r: Result<(), Refusal>) -> u8 {
    match r {
        Ok(()) => 0,
        Err(Refusal::Grants(_)) => 1,
        Err(Refusal::DeniesModeration(_)) => 2,
        Err(Refusal::Outranked) => 3,
    }
}

fn edit_case(c: &EditCase, fit: &dyn Fn(Mask) -> Mask) -> u8 {
    let EditCase {
        name: _,
        actor,
        exempt,
        before,
        after,
        subject_ok,
        out: _,
    } = c;
    let ow = |r: &Option<Row>| r.as_ref().map(|x| row(x, false, fit).0);
    refusal(check_overwrite_edit(
        fit(mask(actor)),
        *exempt,
        ow(before),
        ow(after),
        *subject_ok,
    ))
}

#[test]
fn hosted_channel_cases() {
    for c in cases().hosted.channel {
        let got = channel_case(&c, &HOSTED, &|m| m);
        assert_eq!(got, mask(&c.out), "{}", c.name);
    }
}

#[test]
fn hosted_edit_cases() {
    let Hosted {
        channel: _,
        edits,
        bits,
        configured: _,
    } = cases().hosted;
    for c in edits {
        assert_eq!(edit_case(&c, &|m| m), c.out, "{}", c.name);
    }
    for c in bits {
        let BitsCase {
            name,
            actor,
            exempt,
            before,
            after,
            out,
        } = c;
        let got = check_bits_edit(mask(&actor), exempt, mask(&before), mask(&after));
        assert_eq!(refusal(got), out, "{name}");
    }
}

#[test]
fn configured_masks() {
    let Configured { webhook, read_link } = cases().hosted.configured;
    assert_eq!(WEBHOOK, mask(&webhook));
    assert_eq!(READ_LINK, mask(&read_link));
}

/// What a device does with a rules-5 mask: over the wire and back.
fn wire5(m: Mask) -> Mask {
    from_wire(to_wire(m, 5, 0), 5)
}

#[test]
fn rules_5_channel_cases() {
    for c in cases().p2p5.channel {
        let c = ChannelCase {
            everyone: Some(Vec::new()),
            ..c
        };
        let got = channel_case(&c, &P2P_V5, &wire5);
        assert_eq!(
            to_wire(got, 5, 0),
            to_wire(mask(&c.out), 5, 0),
            "{}",
            c.name
        );
        assert_eq!(got, wire5(got), "{}", c.name);
    }
}

#[test]
fn rules_5_edit_cases() {
    for c in cases().p2p5.edits {
        assert_eq!(edit_case(&c, &wire5), c.out, "{}", c.name);
    }
}
