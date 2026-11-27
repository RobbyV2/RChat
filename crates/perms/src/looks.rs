//! How roles show in member lists: the display order and the roles whose members show as groups
//! of their own.

/// Most roles the member list shows as groups of their own.
pub const HOIST_GROUPS: usize = 10;

/// A role as the member list shows it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Look {
    /// Its display position, or its rank position where it has none.
    pub place: i64,
    /// Its members show as a group of their own.
    pub hoist: bool,
}

/// The display order of `ranked` (the roles, highest rank first) as indexes into it, the highest
/// first: a higher place shows higher, and roles at one place show in rank order.
pub fn display_order(ranked: &[Look]) -> Vec<usize> {
    let mut order: Vec<usize> = (0..ranked.len()).collect();
    order.sort_by_key(|&i| std::cmp::Reverse(ranked[i].place));
    order
}

/// The roles shown as groups, as indexes into `ranked`, in display order: the first
/// `HOIST_GROUPS` hoisted roles. A member shows in the first of them they hold.
pub fn groups(ranked: &[Look]) -> Vec<usize> {
    display_order(ranked)
        .into_iter()
        .filter(|&i| ranked[i].hoist)
        .take(HOIST_GROUPS)
        .collect()
}
