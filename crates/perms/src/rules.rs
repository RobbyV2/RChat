use crate::Mask;
use crate::masks;
use crate::registry::{BITS, State, Wire, p2p_known, value};

/// The knobs that differ between hosted servers and P2P rules versions.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Ruleset {
    pub known: Mask,
    /// The bits a channel mask carries.
    pub scope: Mask,
    /// What a channel's restrict_view clears.
    pub view_group: Mask,
    pub manager_pass: Mask,
    pub mod_pass: bool,
    pub view_gates_all: bool,
    pub timeouts: bool,
    pub delta_checks: bool,
    pub grant_check: bool,
    pub text_only: bool,
}

pub const HOSTED: Ruleset = Ruleset {
    known: masks::ALL,
    scope: masks::CHANNEL,
    view_group: masks::VIEW,
    manager_pass: masks::MANAGER_PASS,
    mod_pass: true,
    view_gates_all: true,
    timeouts: true,
    delta_checks: true,
    grant_check: true,
    text_only: true,
};

const V2_KNOWN: Mask = from_wire(p2p_known(2), 2);

pub const P2P_V2: Ruleset = Ruleset {
    known: V2_KNOWN,
    scope: V2_KNOWN,
    view_group: masks::VIEW | masks::VOICE,
    manager_pass: V2_KNOWN,
    mod_pass: false,
    view_gates_all: false,
    timeouts: false,
    delta_checks: false,
    grant_check: false,
    text_only: false,
};

pub const P2P_V4: Ruleset = Ruleset {
    text_only: true,
    ..P2P_V2
};

const V5_KNOWN: Mask = from_wire(p2p_known(5), 5);

pub const P2P_V5: Ruleset = Ruleset {
    known: V5_KNOWN,
    scope: masks::CHANNEL & V5_KNOWN,
    view_group: masks::VIEW,
    manager_pass: masks::MANAGER_PASS & V5_KNOWN,
    mod_pass: true,
    view_gates_all: true,
    timeouts: true,
    delta_checks: true,
    grant_check: true,
    text_only: true,
};

pub fn p2p(rules: i64) -> Option<&'static Ruleset> {
    match rules {
        2 => Some(&P2P_V2),
        4 => Some(&P2P_V4),
        5 => Some(&P2P_V5),
        _ => None,
    }
}

/// What a wire bit covers besides its own row while rules are below 5, where voice needs only
/// View.
const fn covers(row: Mask) -> Mask {
    if row == masks::VIEW {
        masks::VOICE
    } else if row == value("DeleteMessages") {
        value("PinMessages")
    } else if row == value("ManageServer") {
        value("ManageInvites")
    } else if row == value("ManageRoles") {
        value("AssignRoles")
    } else if row == masks::SEND {
        masks::SEND_GROUP
    } else {
        0
    }
}

/// P2P wire bits as a canonical mask. Unknown wire bits are left out.
pub const fn from_wire(wire: u32, rules: i64) -> Mask {
    let (mut i, mut m) = (0, 0);
    while i < BITS.len() {
        if let Some(Wire {
            value: w,
            state: State::Live,
            since,
        }) = BITS[i].p2p
            && since <= rules
            && wire & w != 0
        {
            m |= BITS[i].value;
            if rules < 5 {
                m |= covers(BITS[i].value);
            }
        }
        i += 1;
    }
    m
}

/// A canonical mask as P2P wire bits, keeping the wire bits of `keep` these rules do not know.
pub const fn to_wire(mask: Mask, rules: i64, keep: u32) -> u32 {
    let (mut i, mut w) = (0, keep & !p2p_known(rules));
    while i < BITS.len() {
        if let Some(Wire {
            value: v,
            state: State::Live,
            since,
        }) = BITS[i].p2p
            && since <= rules
            && mask & BITS[i].value != 0
        {
            w |= v;
        }
        i += 1;
    }
    w
}
