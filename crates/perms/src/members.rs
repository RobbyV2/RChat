use crate::Mask;
use crate::masks::VIEW_MEMBERS;
use crate::registry::value;

/// The server bits that see the member list whatever the server or its roles say: Manage
/// server, Manage roles, and Kick and ban.
pub const MODERATE: Mask = value("ManageServer") | value("ManageRoles") | value("Kick");

/// Who asks to see a server's member list.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Seer {
    /// A site admin.
    Staff,
    /// A member: their server bits, and in a channel what they hold there.
    Member { server: Mask, here: Option<Mask> },
    /// Someone who is not a member, with the server bits of @everyone, and in a channel what
    /// @everyone holds there.
    Visitor { everyone: Mask, here: Option<Mask> },
}

/// What the site and the server say about member lists.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Place {
    /// The site's member list switch.
    pub site: bool,
    /// The server keeps its member list from members without moderation bits.
    pub hide: bool,
    /// The server shows its members to people outside it.
    pub outside: bool,
}

/// Why the member list is hidden.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Hidden {
    /// The site turned member lists off.
    Site,
    /// The server, or the viewer's roles there, keep it from them.
    Server,
    /// The channel keeps it from them.
    Channel,
    /// The server shows its members only to members.
    Outside,
}

fn holds(bits: Mask) -> bool {
    bits & VIEW_MEMBERS != 0
}

/// Whether `seer` sees the member list of a server described by `place`. A site admin always
/// does. With the site switch off nobody else does. A member with a moderation bit always does
/// otherwise; while the server hides its list nobody else does, and otherwise View members
/// decides, in the channel when there is one. Someone outside sees it while the server shows its
/// members outside, does not hide them, and @everyone holds View members.
pub fn member_list(seer: Seer, place: Place) -> Result<(), Hidden> {
    let Place {
        site,
        hide,
        outside,
    } = place;
    match seer {
        Seer::Staff => Ok(()),
        Seer::Member { server: _, here: _ }
        | Seer::Visitor {
            everyone: _,
            here: _,
        } if !site => Err(Hidden::Site),
        Seer::Member { server, here: _ } if server & MODERATE != 0 => Ok(()),
        Seer::Member { server: _, here: _ } if hide => Err(Hidden::Server),
        Seer::Member { server, here: None } => match holds(server) {
            true => Ok(()),
            false => Err(Hidden::Server),
        },
        Seer::Member {
            server,
            here: Some(here),
        } => match (holds(here), holds(server)) {
            (true, _) => Ok(()),
            (false, true) => Err(Hidden::Channel),
            (false, false) => Err(Hidden::Server),
        },
        Seer::Visitor { everyone, here } => {
            match (outside, hide || !holds(everyone), here.map(holds)) {
                (false, _, _) => Err(Hidden::Outside),
                (true, true, _) => Err(Hidden::Server),
                (true, false, Some(false)) => Err(Hidden::Channel),
                (true, false, Some(true) | None) => Ok(()),
            }
        }
    }
}
