//! The level curve: level n costs 5n^2 + 50n + 100 XP.

/// The highest level the curve is computed for.
pub const MAX_LEVEL: u32 = 1000;

/// The XP it takes to go from `level` to the next.
pub fn cost(level: u32) -> i64 {
    let n = i64::from(level);
    5 * n * n + 50 * n + 100
}

/// The XP at which `level` is reached.
pub fn total(level: u32) -> i64 {
    (0..level).map(cost).sum()
}

/// The level a member with `xp` is at.
pub fn level(xp: i64) -> u32 {
    let mut level = 0;
    let mut left = xp;
    while level < MAX_LEVEL && left >= cost(level) {
        left -= cost(level);
        level += 1;
    }
    level
}

/// The level, the XP earned inside it, and what the level costs.
pub fn progress(xp: i64) -> (u32, i64, i64) {
    let at = level(xp);
    (at, xp.max(0) - total(at), cost(at))
}

/// The levels an award from `before` to `after` reaches.
pub fn crossed(before: i64, after: i64) -> Vec<u32> {
    (level(before) + 1..=level(after)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_curve_is_the_published_one() {
        assert_eq!(cost(0), 100);
        assert_eq!(cost(1), 155);
        assert_eq!(cost(2), 220);
        for (level, xp) in [
            (0, 0),
            (1, 100),
            (2, 255),
            (3, 475),
            (4, 770),
            (5, 1150),
            (10, 4675),
            (20, 23_850),
            (30, 67_525),
            (50, 268_375),
            (100, 1_899_250),
        ] {
            assert_eq!(total(level), xp, "level {level}");
        }
    }

    #[test]
    fn a_level_is_reached_at_its_total_and_not_one_xp_before() {
        assert_eq!(level(0), 0);
        assert_eq!(level(99), 0);
        assert_eq!(level(100), 1);
        assert_eq!(level(254), 1);
        assert_eq!(level(255), 2);
        for l in 1..=100 {
            assert_eq!(level(total(l)), l);
            assert_eq!(level(total(l) - 1), l - 1);
        }
        assert_eq!(level(-5), 0);
        assert_eq!(level(i64::MAX), MAX_LEVEL);
    }

    #[test]
    fn progress_within_a_level() {
        assert_eq!(progress(0), (0, 0, 100));
        assert_eq!(progress(130), (1, 30, 155));
        assert_eq!(progress(2310), (7, 105, 695));
    }

    #[test]
    fn boundaries_crossed_by_an_award() {
        assert_eq!(crossed(90, 110), [1]);
        assert_eq!(crossed(100, 120), [] as [u32; 0]);
        assert_eq!(crossed(0, 500), [1, 2, 3]);
        assert_eq!(crossed(500, 0), [] as [u32; 0]);
    }
}
