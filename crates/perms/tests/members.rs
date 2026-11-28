use rchat_perms::Mask;
use rchat_perms::eval::{Channel, Ow, Who, channel_mask, server_bits};
use rchat_perms::masks::{BASE, CHANNEL, MANAGER_PASS, TIMED_OUT_KEEP, VIEW, VIEW_MEMBERS};
use rchat_perms::members::{Hidden, MODERATE, Place, Seer, member_list};
use rchat_perms::registry::value;
use rchat_perms::rules::HOSTED;

const OPEN: Place = Place {
    site: true,
    hide: false,
    outside: true,
};

fn member(server: Mask) -> Seer {
    Seer::Member { server, here: None }
}

fn in_channel(server: Mask, here: Mask) -> Seer {
    Seer::Member {
        server,
        here: Some(here),
    }
}

#[test]
fn view_members_is_a_base_channel_bit_everyone_holds() {
    assert_eq!(VIEW_MEMBERS, 1 << 35);
    assert_ne!(BASE & VIEW_MEMBERS, 0);
    assert_ne!(CHANNEL & VIEW_MEMBERS, 0);
    assert_ne!(MANAGER_PASS & VIEW_MEMBERS, 0);
    assert_ne!(TIMED_OUT_KEEP & VIEW_MEMBERS, 0);
    assert_eq!(
        MODERATE,
        value("ManageServer") | value("ManageRoles") | value("Kick")
    );
}

#[test]
fn members_with_view_members_see_the_list() {
    assert_eq!(member_list(member(BASE), OPEN), Ok(()));
    assert_eq!(
        member_list(member(BASE & !VIEW_MEMBERS), OPEN),
        Err(Hidden::Server)
    );
}

#[test]
fn a_channel_decides_inside_it() {
    let without = BASE & !VIEW_MEMBERS;
    assert_eq!(member_list(in_channel(BASE, BASE), OPEN), Ok(()));
    assert_eq!(
        member_list(in_channel(BASE, without), OPEN),
        Err(Hidden::Channel)
    );
    assert_eq!(member_list(in_channel(without, BASE), OPEN), Ok(()));
    assert_eq!(
        member_list(in_channel(without, without), OPEN),
        Err(Hidden::Server)
    );
}

#[test]
fn moderators_see_a_hidden_list() {
    let hidden = Place { hide: true, ..OPEN };
    let plain = BASE & !VIEW_MEMBERS;
    for bit in ["ManageServer", "ManageRoles", "Kick"] {
        assert_eq!(member_list(member(plain | value(bit)), hidden), Ok(()));
        assert_eq!(
            member_list(in_channel(plain | value(bit), 0), OPEN),
            Ok(()),
            "{bit}"
        );
    }
    for bit in ["ManageChannels", "TimeoutMembers", "DeleteMessages"] {
        assert_eq!(
            member_list(member(BASE | value(bit)), hidden),
            Err(Hidden::Server),
            "{bit}"
        );
    }
    assert_eq!(member_list(member(BASE), hidden), Err(Hidden::Server));
    assert_eq!(
        member_list(in_channel(BASE, BASE), hidden),
        Err(Hidden::Server)
    );
}

#[test]
fn owners_and_full_admins_hold_the_moderation_bits() {
    let hidden = Place { hide: true, ..OPEN };
    let everyone = BASE & !VIEW_MEMBERS;
    for who in [Who::Owner, Who::Admin { mask: 0, roles: 0 }] {
        let bits = server_bits(&who, everyone, &HOSTED);
        assert_eq!(member_list(member(bits), hidden), Ok(()));
    }
    let timeouts = server_bits(
        &Who::Admin {
            mask: value("TimeoutMembers"),
            roles: 0,
        },
        everyone,
        &HOSTED,
    );
    assert_eq!(member_list(member(timeouts), hidden), Err(Hidden::Server));
}

#[test]
fn the_site_switch_hides_it_from_everyone_but_staff() {
    let off = Place {
        site: false,
        ..OPEN
    };
    assert_eq!(member_list(Seer::Staff, off), Ok(()));
    assert_eq!(member_list(member(BASE | MODERATE), off), Err(Hidden::Site));
    assert_eq!(
        member_list(
            Seer::Visitor {
                everyone: BASE,
                here: None
            },
            off
        ),
        Err(Hidden::Site)
    );
    let shut = Place {
        site: false,
        hide: true,
        outside: false,
    };
    assert_eq!(member_list(Seer::Staff, shut), Ok(()));
}

#[test]
fn visitors_follow_the_outside_option_and_everyone() {
    let seer = Seer::Visitor {
        everyone: BASE,
        here: None,
    };
    assert_eq!(member_list(seer, OPEN), Ok(()));
    let closed = Place {
        outside: false,
        ..OPEN
    };
    assert_eq!(member_list(seer, closed), Err(Hidden::Outside));
    let hidden = Place { hide: true, ..OPEN };
    assert_eq!(member_list(seer, hidden), Err(Hidden::Server));
    assert_eq!(
        member_list(
            Seer::Visitor {
                everyone: BASE & !VIEW_MEMBERS,
                here: None
            },
            OPEN
        ),
        Err(Hidden::Server)
    );
}

#[test]
fn a_channel_that_denies_view_members_hides_the_list_from_visitors_there() {
    let there = |here: Mask| Seer::Visitor {
        everyone: BASE,
        here: Some(here),
    };
    assert_eq!(member_list(there(BASE), OPEN), Ok(()));
    assert_eq!(
        member_list(there(BASE & !VIEW_MEMBERS), OPEN),
        Err(Hidden::Channel)
    );
}

#[test]
fn channel_overwrites_carry_view_members() {
    let everyone = BASE & !VIEW_MEMBERS;
    let roles = [Ow {
        allow: VIEW_MEMBERS,
        deny: 0,
    }];
    let allowed = Channel {
        everyone: None,
        restrict_view: false,
        restrict_send: false,
        voice: false,
        roles: &roles,
        member: None,
    };
    let who = Who::Member { roles: 0 };
    let here = channel_mask(&who, everyone, &allowed, false, false, &HOSTED);
    assert_ne!(here & VIEW_MEMBERS, 0);
    let denied = Channel {
        everyone: Some(Ow {
            allow: 0,
            deny: VIEW_MEMBERS,
        }),
        roles: &[],
        ..allowed
    };
    let here = channel_mask(&who, BASE, &denied, false, false, &HOSTED);
    assert_eq!(here & VIEW_MEMBERS, 0);
    assert_ne!(here & VIEW, 0);
    let managers = channel_mask(
        &Who::Admin {
            mask: value("ManageChannels"),
            roles: 0,
        },
        BASE,
        &denied,
        false,
        false,
        &HOSTED,
    );
    assert_ne!(managers & VIEW_MEMBERS, 0, "Manage channels passes it");
}
