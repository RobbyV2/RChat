use rchat_perms::Mask;
use rchat_perms::eval::{Mode, Ow};
use rchat_perms::masks::{BASE, HISTORY, MANAGE_CHANNELS, SEND, VIEW};
use rchat_perms::rules::{HOSTED, P2P_V4};
use rchat_perms::sync::{Place, Rule, widened};

const TEXT: Place = Place {
    restrict_view: false,
    restrict_send: false,
    voice: false,
};

fn allow(bits: Mask) -> Ow {
    Ow {
        allow: bits,
        deny: 0,
    }
}

fn deny(bits: Mask) -> Ow {
    Ow {
        allow: 0,
        deny: bits,
    }
}

fn none(_: &str) -> Mask {
    0
}

fn no_roles(_: &str) -> Vec<String> {
    Vec::new()
}

fn gained(before: &[Rule], after: &[Rule]) -> Vec<String> {
    widened(
        before,
        after,
        ("everyone", BASE),
        &none,
        &no_roles,
        TEXT,
        &HOSTED,
    )
}

#[test]
fn a_sync_that_lets_a_subject_see_or_send_widens_for_it() {
    let hidden: [Rule; 2] = [
        ("everyone", deny(VIEW), Mode::Override),
        ("r:1", allow(VIEW), Mode::Override),
    ];
    assert_eq!(
        gained(&hidden, &[]),
        vec!["everyone".to_string()],
        "no rules at all opens the channel to everyone; the role saw it already"
    );
    let more: [Rule; 3] = [
        ("everyone", deny(VIEW), Mode::Override),
        ("r:1", allow(VIEW), Mode::Override),
        ("r:2", allow(VIEW | SEND), Mode::Override),
    ];
    assert_eq!(gained(&hidden, &more), vec!["r:2".to_string()]);
    let muted: [Rule; 1] = [("u:bob", deny(SEND), Mode::Override)];
    assert_eq!(gained(&muted, &[]), vec!["u:bob".to_string()]);
    assert_eq!(
        gained(&[], &hidden),
        Vec::<String>::new(),
        "taking access away widens nothing"
    );
    let history: [Rule; 1] = [("r:3", allow(HISTORY), Mode::Override)];
    assert_eq!(
        gained(&[("everyone", deny(HISTORY), Mode::Override)], &history),
        Vec::<String>::new(),
        "only View and Send count"
    );
}

#[test]
fn roles_count_with_their_own_permissions() {
    let closed: [Rule; 1] = [("everyone", deny(VIEW), Mode::Override)];
    let managers = |s: &str| match s {
        "r:9" => MANAGE_CHANNELS,
        _ => 0,
    };
    let rows: [Rule; 2] = [
        ("everyone", deny(VIEW), Mode::Override),
        ("r:9", deny(SEND), Mode::Override),
    ];
    assert_eq!(
        widened(
            &rows,
            &closed,
            ("everyone", BASE),
            &managers,
            &no_roles,
            TEXT,
            &HOSTED
        ),
        Vec::<String>::new(),
        "Manage channels passes the role's denies either way"
    );
    assert_eq!(
        widened(
            &rows,
            &closed,
            ("everyone", BASE),
            &none,
            &no_roles,
            TEXT,
            &HOSTED
        ),
        Vec::<String>::new(),
        "a role without permissions sees nothing either way"
    );
    let restricted = Place {
        restrict_view: true,
        ..TEXT
    };
    assert_eq!(
        widened(
            &[],
            &[("r:1", allow(VIEW), Mode::Override)],
            ("everyone", BASE),
            &none,
            &no_roles,
            restricted,
            &HOSTED
        ),
        vec!["r:1".to_string()],
        "a private channel keeps everyone out; the role's allow lets it in"
    );
}

#[test]
fn rooms_compare_under_their_own_rules() {
    let open = P2P_V4.known & (VIEW | SEND);
    assert_eq!(
        widened(
            &[("r:everyone", deny(VIEW), Mode::Override)],
            &[],
            ("r:everyone", open),
            &none,
            &no_roles,
            TEXT,
            &P2P_V4
        ),
        vec!["r:everyone".to_string()]
    );
    let muted: [Rule; 1] = [(
        "u:b",
        Ow {
            allow: VIEW,
            deny: SEND,
        },
        Mode::Override,
    )];
    let hidden: [Rule; 1] = [("u:b", deny(VIEW), Mode::Override)];
    assert_eq!(
        widened(
            &muted,
            &hidden,
            ("r:everyone", open),
            &none,
            &no_roles,
            TEXT,
            &P2P_V4
        ),
        Vec::<String>::new(),
        "without View nothing is gained, even where View doesn't gate the rest"
    );
}

#[test]
fn members_count_with_the_roles_they_hold_and_roles_count_in_pairs() {
    let staff: [Rule; 3] = [
        ("everyone", deny(VIEW), Mode::Override),
        ("r:staff", allow(VIEW), Mode::Override),
        ("u:troll", deny(VIEW), Mode::Override),
    ];
    let holds = |s: &str| match s {
        "u:troll" => vec!["r:staff".to_string()],
        _ => Vec::new(),
    };
    assert_eq!(
        widened(
            &staff,
            &staff[..2],
            ("everyone", BASE),
            &none,
            &holds,
            TEXT,
            &HOSTED
        ),
        vec!["u:troll".to_string()],
        "a member's own deny gone lets the role they hold in"
    );
    let muted: [Rule; 1] = [("r:muted", deny(VIEW), Mode::Override)];
    let verified: [Rule; 2] = [
        ("r:muted", deny(VIEW), Mode::Override),
        ("r:verified", allow(VIEW), Mode::Override),
    ];
    assert_eq!(
        widened(
            &muted,
            &verified,
            ("everyone", BASE),
            &none,
            &no_roles,
            TEXT,
            &HOSTED
        ),
        vec!["r:muted+r:verified".to_string()],
        "an allow beats another role's deny: members holding both get in"
    );
    let voice = Place {
        voice: true,
        ..TEXT
    };
    let connect = rchat_perms::registry::value("Connect");
    assert_eq!(
        widened(
            &[("everyone", deny(connect), Mode::Override)],
            &[],
            ("everyone", BASE),
            &none,
            &no_roles,
            voice,
            &HOSTED
        ),
        vec!["everyone".to_string()],
        "in a voice channel Connect counts"
    );
}
