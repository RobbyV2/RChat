/// The most earlier messages a report about a message takes along.
pub const CONTEXT_MAX: u8 = 10;

/// The messages a report about `reported` takes along: up to `count` of the `held` keys that
/// come before it (never more than `CONTEXT_MAX`), the latest ones, oldest first. `held` may be
/// in any order and may hold `reported` itself.
pub fn pick<K: Ord + Copy>(held: &[K], reported: K, count: u8) -> Vec<K> {
    let mut before: Vec<K> = held.iter().copied().filter(|k| *k < reported).collect();
    before.sort();
    before.dedup();
    let keep = usize::from(count.min(CONTEXT_MAX));
    before.split_off(before.len().saturating_sub(keep))
}

#[cfg(test)]
mod tests {
    use super::{CONTEXT_MAX, pick};

    #[test]
    fn the_latest_earlier_messages_come_oldest_first() {
        assert_eq!(pick(&[5, 1, 9, 3, 7], 7, 2), vec![3, 5]);
        assert_eq!(pick(&[5, 1, 9, 3, 7], 7, 10), vec![1, 3, 5]);
        assert_eq!(pick(&[5, 1, 9], 1, 3), Vec::<i32>::new());
        assert_eq!(pick(&[2, 2, 1], 3, 3), vec![1, 2]);
        assert_eq!(pick(&[1, 2], 3, 0), Vec::<i32>::new());
    }

    #[test]
    fn never_more_than_the_cap() {
        let held: Vec<i64> = (0..40).collect();
        let picked = pick(&held, 40, u8::MAX);
        assert_eq!(picked.len(), usize::from(CONTEXT_MAX));
        assert_eq!(picked.first(), Some(&30));
    }
}
