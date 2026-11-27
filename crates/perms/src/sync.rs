use crate::Mask;
use crate::masks::{SEND, VIEW};

/// The subjects whose mask gains View or Send between two sets of overwrites.
pub fn widens(before: &[(String, Mask)], after: &[(String, Mask)]) -> Vec<String> {
    after
        .iter()
        .filter(|(subject, mask)| {
            let was = before
                .iter()
                .find(|(s, _)| s == subject)
                .map_or(0, |(_, m)| *m);
            mask & !was & (VIEW | SEND) != 0
        })
        .map(|(subject, _)| subject.clone())
        .collect()
}
