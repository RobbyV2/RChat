/// The new order (ids, top first) when `requested` is applied to `current`: ids the actor cannot
/// manage keep their slots, the others fill the remaining slots in the requested order, and ids
/// the request leaves out follow in their current order.
pub fn reorder(current: &[i64], requested: &[i64], manageable: &dyn Fn(i64) -> bool) -> Vec<i64> {
    let mut seen = Vec::new();
    let mut movable: Vec<i64> = Vec::new();
    for id in requested {
        if current.contains(id) && manageable(*id) && !seen.contains(id) {
            seen.push(*id);
            movable.push(*id);
        }
    }
    for id in current {
        if manageable(*id) && !seen.contains(id) {
            movable.push(*id);
        }
    }
    let mut next = movable.into_iter();
    current
        .iter()
        .map(|id| match manageable(*id) {
            true => next.next().unwrap_or(*id),
            false => *id,
        })
        .collect()
}

/// The ids that changed place between two orders: those outside a longest common subsequence.
pub fn moved(before: &[i64], after: &[i64]) -> Vec<i64> {
    let (n, m) = (before.len(), after.len());
    let mut len = vec![vec![0usize; m + 1]; n + 1];
    for i in (0..n).rev() {
        for j in (0..m).rev() {
            len[i][j] = match before[i] == after[j] {
                true => len[i + 1][j + 1] + 1,
                false => len[i + 1][j].max(len[i][j + 1]),
            };
        }
    }
    let (mut i, mut j) = (0, 0);
    let mut kept = Vec::new();
    while i < n && j < m {
        if before[i] == after[j] {
            kept.push(before[i]);
            i += 1;
            j += 1;
        } else if len[i + 1][j] >= len[i][j + 1] {
            i += 1;
        } else {
            j += 1;
        }
    }
    after
        .iter()
        .copied()
        .filter(|id| !kept.contains(id))
        .collect()
}
