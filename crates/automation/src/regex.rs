//! Regex patterns: the Rust `regex` crate, linear in the text, with a cap on compiled size.

use ::regex::{Regex, RegexBuilder, RegexSet, RegexSetBuilder};

/// The longest pattern, in characters.
pub const PATTERN_MAX: usize = 260;
/// The compiled size one pattern may have.
pub const PATTERN_BYTES: usize = 1 << 20;
/// The compiled size a server's patterns may have in all, at the default limit.
pub const SERVER_BYTES: usize = 4 << 20;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Bad {
    Empty,
    TooLong,
    Invalid,
    TooBig,
}

fn bad(e: &::regex::Error) -> Bad {
    match e {
        ::regex::Error::CompiledTooBig(_) => Bad::TooBig,
        _ => Bad::Invalid,
    }
}

/// One pattern, compiled the way a set matches: against normalized (lowercase) text, so the
/// pattern's own case never matters.
pub fn compile(pattern: &str) -> Result<Regex, Bad> {
    if pattern.trim().is_empty() {
        return Err(Bad::Empty);
    }
    if pattern.chars().count() > PATTERN_MAX {
        return Err(Bad::TooLong);
    }
    RegexBuilder::new(pattern)
        .case_insensitive(true)
        .size_limit(PATTERN_BYTES)
        .build()
        .map_err(|e| bad(&e))
}

pub fn check(pattern: &str) -> Result<(), Bad> {
    compile(pattern).map(|_| ())
}

/// Patterns compiled into one set, so a text is scanned once whatever their number.
#[derive(Debug)]
pub struct Patterns {
    set: RegexSet,
    patterns: Vec<String>,
}

impl Patterns {
    /// Compiles the patterns within `limit_bytes` in all. A pattern that fails by itself is
    /// named by its index.
    pub fn new(patterns: &[String], limit_bytes: usize) -> Result<Patterns, (Option<usize>, Bad)> {
        for (i, p) in patterns.iter().enumerate() {
            check(p).map_err(|e| (Some(i), e))?;
        }
        let set = RegexSetBuilder::new(patterns)
            .case_insensitive(true)
            .size_limit(limit_bytes)
            .build()
            .map_err(|e| (None, bad(&e)))?;
        Ok(Patterns {
            set,
            patterns: patterns.to_vec(),
        })
    }

    pub fn len(&self) -> usize {
        self.patterns.len()
    }

    pub fn is_empty(&self) -> bool {
        self.patterns.is_empty()
    }

    pub fn patterns(&self) -> &[String] {
        &self.patterns
    }

    /// The indexes of the patterns that match the normalized text.
    pub fn matches(&self, t: &str) -> Vec<usize> {
        self.set.matches(t).into_iter().collect()
    }

    pub fn is_match(&self, t: &str) -> bool {
        self.set.is_match(t)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    fn strings(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn a_pattern_is_at_most_260_characters_and_compiles_under_1_mib() {
        assert_eq!(check(&"a".repeat(260)), Ok(()));
        assert_eq!(check(&"é".repeat(260)), Ok(()));
        assert_eq!(check(&"a".repeat(261)), Err(Bad::TooLong));
        assert_eq!(check(""), Err(Bad::Empty));
        assert_eq!(check("  "), Err(Bad::Empty));
        assert_eq!(check("(open"), Err(Bad::Invalid));
        assert_eq!(check(r"(?<name>a)\k<name>"), Err(Bad::Invalid));
        assert_eq!(check(r"((\pL{50}){50}){20}"), Err(Bad::TooBig));
        assert_eq!(check(r"\pL{20}"), Ok(()));
    }

    #[test]
    fn a_set_matches_normalized_text_whatever_the_patterns_case() {
        let set = Patterns::new(&strings(&[r"\bfree\b", "N[Ii]TRO", "^gift$"]), SERVER_BYTES)
            .expect("set");
        assert_eq!(set.len(), 3);
        assert!(!set.is_empty());
        assert_eq!(set.matches("free nitro"), [0, 1]);
        assert_eq!(set.matches("freedom"), [] as [usize; 0]);
        assert!(set.is_match("gift"));
        assert!(!set.is_match("gifts"));
        assert_eq!(set.patterns(), ["\\bfree\\b", "N[Ii]TRO", "^gift$"]);
        let none = Patterns::new(&[], SERVER_BYTES).expect("empty");
        assert!(none.is_empty());
        assert_eq!(none.matches("anything"), [] as [usize; 0]);
    }

    #[test]
    fn a_set_names_the_pattern_that_fails_and_refuses_one_over_its_size() {
        assert_eq!(
            Patterns::new(&strings(&["ok", "(open"]), SERVER_BYTES).err(),
            Some((Some(1), Bad::Invalid))
        );
        assert_eq!(
            Patterns::new(&strings(&[r"\pL{20}", r"\pN{20}"]), 16 * 1024).err(),
            Some((None, Bad::TooBig))
        );
    }

    #[test]
    fn a_backtracking_classic_runs_in_linear_time() {
        let re = compile("(a+)+$").expect("pattern");
        let text = |n: usize| format!("{}b", "a".repeat(n));
        let best = |input: &str| {
            (0..20)
                .map(|_| {
                    let start = Instant::now();
                    assert!(!re.is_match(input));
                    start.elapsed()
                })
                .min()
                .expect("runs")
        };
        let short = text(4_000);
        let long = text(40_000);
        assert!(!re.is_match(&short));
        let (small, large) = (best(&short), best(&long));
        assert!(
            large < small * 40 + std::time::Duration::from_millis(5),
            "4,000 characters took {small:?} and 40,000 took {large:?}"
        );
        if !cfg!(debug_assertions) {
            assert!(small.as_micros() < 1000, "{small:?}");
        }
    }
}
