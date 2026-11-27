use rchat_perms::looks::{HOIST_GROUPS, Look, display_order, groups};

fn look(place: i64, hoist: bool) -> Look {
    Look { place, hoist }
}

#[test]
fn roles_show_by_place_and_keep_rank_order_at_one_place() {
    assert_eq!(display_order(&[]), Vec::<usize>::new());
    let ranked = [
        look(4, false),
        look(3, false),
        look(9, false),
        look(3, false),
        look(1, false),
    ];
    assert_eq!(display_order(&ranked), [2, 0, 1, 3, 4]);
    let following = [look(5, false), look(4, false), look(3, false)];
    assert_eq!(
        display_order(&following),
        [0, 1, 2],
        "without display positions the display order is the rank order"
    );
}

#[test]
fn groups_are_the_first_hoisted_roles_in_display_order() {
    let ranked = [look(1, true), look(5, false), look(3, true), look(4, true)];
    assert_eq!(groups(&ranked), [3, 2, 0]);
    let many: Vec<Look> = (0..14).map(|i| look(100 - i, i % 2 == 0)).collect();
    let got = groups(&many);
    assert_eq!(got.len(), 7);
    let all: Vec<Look> = (0..14).map(|i| look(100 - i, true)).collect();
    let got = groups(&all);
    assert_eq!(got.len(), HOIST_GROUPS);
    assert_eq!(got, (0..HOIST_GROUPS).collect::<Vec<_>>());
    assert!(groups(&[look(1, false)]).is_empty());
}
