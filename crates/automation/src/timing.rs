//! The save-time timing of a server's guard set. Times are in microseconds.

use crate::keywords::{KeywordSet, normalize};
use crate::regex::{Patterns, SERVER_BYTES, compile};
use crate::validate::GuardSet;
use std::hint::black_box;
use std::time::Instant;

/// The budget for a server's guard set: its calibrated p99 on the corpus.
pub const BUDGET_US: f64 = 300.0;
/// What the reference workload takes on an idle machine.
pub const REFERENCE_NOMINAL_US: f64 = 20.0;
/// How often the corpus is scanned at most.
pub const ROUNDS: u32 = 20;
/// The rounds before a clear verdict may stop the run.
pub const EARLY_ROUNDS: u32 = 3;

pub fn p99(samples: &[f64]) -> f64 {
    let mut sorted = samples.to_vec();
    sorted.sort_by(f64::total_cmp);
    let at = (sorted.len() as f64 * 0.99).ceil() as usize;
    sorted
        .get(at.saturating_sub(1).min(sorted.len().saturating_sub(1)))
        .copied()
        .unwrap_or(0.0)
}

#[derive(Clone, Copy, PartialEq, Debug)]
pub struct Verdict {
    pub ok: bool,
    pub calibrated: f64,
}

/// The set's p99, scaled down by how much slower the reference workload ran than its nominal
/// time at the same moment, so a loaded machine doesn't refuse a good set. Never scaled up.
pub fn verdict(set: &[f64], reference: &[f64], budget: f64) -> Verdict {
    let scale = (p99(reference) / REFERENCE_NOMINAL_US).max(1.0);
    let calibrated = p99(set) / scale;
    Verdict {
        ok: calibrated <= budget,
        calibrated,
    }
}

static CORPUS: [(&str, &str); 24] = [
    ("latin_match", include_str!("../corpus/latin_match.txt")),
    ("latin_plain", include_str!("../corpus/latin_plain.txt")),
    (
        "cyrillic_match",
        include_str!("../corpus/cyrillic_match.txt"),
    ),
    (
        "cyrillic_plain",
        include_str!("../corpus/cyrillic_plain.txt"),
    ),
    ("greek_match", include_str!("../corpus/greek_match.txt")),
    ("greek_plain", include_str!("../corpus/greek_plain.txt")),
    ("cjk_match", include_str!("../corpus/cjk_match.txt")),
    ("cjk_plain", include_str!("../corpus/cjk_plain.txt")),
    ("arabic_match", include_str!("../corpus/arabic_match.txt")),
    ("arabic_plain", include_str!("../corpus/arabic_plain.txt")),
    ("emoji_match", include_str!("../corpus/emoji_match.txt")),
    ("emoji_plain", include_str!("../corpus/emoji_plain.txt")),
    ("mixed_match", include_str!("../corpus/mixed_match.txt")),
    ("mixed_plain", include_str!("../corpus/mixed_plain.txt")),
    (
        "lookalike_match",
        include_str!("../corpus/lookalike_match.txt"),
    ),
    (
        "lookalike_plain",
        include_str!("../corpus/lookalike_plain.txt"),
    ),
    (
        "invisible_match",
        include_str!("../corpus/invisible_match.txt"),
    ),
    (
        "invisible_plain",
        include_str!("../corpus/invisible_plain.txt"),
    ),
    (
        "fullwidth_match",
        include_str!("../corpus/fullwidth_match.txt"),
    ),
    (
        "fullwidth_plain",
        include_str!("../corpus/fullwidth_plain.txt"),
    ),
    ("links_match", include_str!("../corpus/links_match.txt")),
    ("links_plain", include_str!("../corpus/links_plain.txt")),
    ("repeats_match", include_str!("../corpus/repeats_match.txt")),
    ("repeats_plain", include_str!("../corpus/repeats_plain.txt")),
];

/// The texts a set is timed on, by name: 4,000 characters each, in several scripts, with and
/// without the phrases rules look for.
pub fn corpus() -> &'static [(&'static str, &'static str)] {
    &CORPUS
}

const SYLLABLES: [&str; 25] = [
    "ba", "ce", "di", "fo", "gu", "ha", "je", "ki", "lo", "mu", "na", "pe", "qi", "ro", "su", "ta",
    "ve", "wi", "xo", "yu", "za", "be", "ci", "do", "fu",
];

/// The workload a run is calibrated against: the largest keyword list a server may have and 50
/// simple ASCII patterns.
pub struct Reference {
    keywords: KeywordSet,
    patterns: Patterns,
}

impl Reference {
    pub fn build() -> Reference {
        let words: Vec<String> = (0..5000)
            .map(|i| {
                format!(
                    "{}{}{}",
                    SYLLABLES[i % 25],
                    SYLLABLES[i / 25 % 20],
                    SYLLABLES[i / 500]
                )
            })
            .collect();
        let patterns: Vec<String> = (0..50).map(|i| format!("ref{i:02}[a-z]+x")).collect();
        Reference {
            keywords: KeywordSet::new(&words, &[]),
            patterns: Patterns::new(&patterns, SERVER_BYTES)
                .expect("the reference patterns compile"),
        }
    }

    pub fn keywords(&self) -> usize {
        self.keywords.len()
    }

    pub fn patterns(&self) -> usize {
        self.patterns.len()
    }

    /// Scans normalized text and answers how much matched.
    pub fn scan(&self, t: &str) -> usize {
        usize::from(self.keywords.find_normalized(t).is_some()) + self.patterns.matches(t).len()
    }
}

/// The outcome of timing a set: the verdict, how many rounds it took, and for a refused set its
/// slowest pattern.
#[derive(Clone, PartialEq, Debug)]
pub struct Timed {
    pub ok: bool,
    pub calibrated: f64,
    pub rounds: u32,
    pub slowest: Option<String>,
}

fn median(samples: &[f64]) -> f64 {
    let mut sorted = samples.to_vec();
    sorted.sort_by(f64::total_cmp);
    sorted.get(sorted.len() / 2).copied().unwrap_or(0.0)
}

/// Times a set on the corpus, next to the reference workload. `clock` answers nanoseconds. The
/// run stops early once the verdict is clear: every sample so far within half the budget, or
/// the typical sample past twice the budget.
pub fn measure(
    set: &GuardSet,
    reference: &Reference,
    rounds: u32,
    budget: f64,
    clock: &mut dyn FnMut() -> u64,
) -> Timed {
    let texts: Vec<String> = corpus().iter().map(|(_, t)| normalize(t)).collect();
    let micros = |from: u64, to: u64| to.saturating_sub(from) as f64 / 1000.0;
    let mut set_samples = Vec::new();
    let mut reference_samples = Vec::new();
    let mut done = 0;
    for round in 1..=rounds {
        for t in &texts {
            let start = clock();
            black_box(reference.scan(black_box(t)));
            let between = clock();
            black_box(set.scan_normalized(black_box(t)));
            let end = clock();
            reference_samples.push(micros(start, between));
            set_samples.push(micros(between, end));
        }
        done = round;
        let scale = (median(&reference_samples) / REFERENCE_NOMINAL_US).max(1.0);
        let clear = verdict(&set_samples, &reference_samples, budget).calibrated <= budget / 2.0
            || median(&set_samples) / scale >= budget * 2.0;
        if round >= EARLY_ROUNDS && clear {
            break;
        }
    }
    let Verdict { ok, calibrated } = verdict(&set_samples, &reference_samples, budget);
    let slowest = match ok {
        true => None,
        false => set
            .patterns()
            .iter()
            .filter_map(|p| Some((p, compile(p).ok()?)))
            .map(|(p, re)| {
                let start = clock();
                for t in &texts {
                    black_box(re.is_match(black_box(t)));
                }
                (clock().saturating_sub(start), p)
            })
            .max_by_key(|(took, _)| *took)
            .map(|(_, p)| p.clone()),
    };
    Timed {
        ok,
        calibrated,
        rounds: done,
        slowest,
    }
}

/// `measure` on the real clock.
pub fn time_set(set: &GuardSet, reference: &Reference, budget: f64) -> Timed {
    let start = Instant::now();
    measure(set, reference, ROUNDS, budget, &mut || {
        u64::try_from(start.elapsed().as_nanos()).unwrap_or(u64::MAX)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::validate::{Caps, GuardSet, Source};

    fn many(v: f64) -> Vec<f64> {
        (0..100).map(|i| v + f64::from(i % 5)).collect()
    }

    #[test]
    fn a_set_within_the_budget_is_accepted_and_a_slow_one_refused() {
        assert!(verdict(&many(17.0), &many(20.0), BUDGET_US).ok);
        let slow = verdict(&many(1000.0), &many(20.0), BUDGET_US);
        assert!(!slow.ok);
        assert!((slow.calibrated - 836.666_666_666_666_7).abs() < 1e-9);
    }

    #[test]
    fn a_loaded_machine_does_not_refuse_a_good_set() {
        let v = verdict(&many(900.0), &many(100.0), BUDGET_US);
        assert!(v.ok);
        assert!((v.calibrated - 173.846_153_846_153_84).abs() < 1e-9);
    }

    #[test]
    fn a_fast_machine_never_scales_a_slow_set_up_into_passing() {
        assert!(!verdict(&many(400.0), &many(5.0), BUDGET_US).ok);
    }

    #[test]
    fn p99_of_100_samples_is_the_99th() {
        let samples: Vec<f64> = (1..=100).map(f64::from).collect();
        assert_eq!(p99(&samples), 99.0);
        assert_eq!(p99(&[7.0]), 7.0);
        assert_eq!(p99(&[]), 0.0);
    }

    #[test]
    fn the_corpus_has_24_texts_of_4000_characters() {
        let texts = corpus();
        assert_eq!(texts.len(), 24);
        for (name, text) in texts {
            assert_eq!(text.chars().count(), 4000, "{name}");
        }
        let names: Vec<&str> = texts.iter().map(|(n, _)| *n).collect();
        for script in [
            "latin", "cyrillic", "greek", "cjk", "arabic", "emoji", "mixed",
        ] {
            assert!(names.iter().any(|n| n.starts_with(script)), "{script}");
        }
        assert!(names.iter().any(|n| n.ends_with("_match")));
        assert!(names.iter().any(|n| n.ends_with("_plain")));
    }

    #[test]
    fn the_reference_workload_is_the_largest_keyword_list_and_50_simple_patterns() {
        let reference = Reference::build();
        assert_eq!(reference.keywords(), 5000);
        assert_eq!(reference.patterns(), 50);
        assert_eq!(reference.scan("nothing to find here"), 0);
        assert_eq!(reference.scan("a fuhaki and ref07abcx"), 2);
    }

    fn source(keywords: &[&str], patterns: &[&str]) -> Source {
        Source {
            automation: 1,
            condition: 0,
            keywords: keywords.iter().map(|s| s.to_string()).collect(),
            allow: vec![],
            patterns: patterns.iter().map(|s| s.to_string()).collect(),
        }
    }

    // A clock for `measure`: each text reads it three times, before the reference scan, between
    // the two scans and after the set's scan.
    fn clock(reference_us: u64, set_us: u64) -> impl FnMut() -> u64 {
        let mut now = 0u64;
        let mut reads = 0u32;
        move || {
            reads += 1;
            now += match reads % 3 {
                1 => 7_000,
                2 => reference_us * 1000,
                _ => set_us * 1000,
            };
            now
        }
    }

    #[test]
    fn measuring_uses_the_injected_clock_and_stops_early_on_a_clear_verdict() {
        let caps = Caps::default();
        let guards =
            GuardSet::build(vec![source(&["free nitro"], &[r"\bfree\b"])], &caps).expect("set");
        let reference = Reference::build();
        let mut reads = 0u32;
        let mut inner = clock(10, 10);
        let fast = measure(&guards, &reference, ROUNDS, BUDGET_US, &mut || {
            reads += 1;
            inner()
        });
        assert!(fast.ok);
        assert_eq!(fast.calibrated, 10.0);
        assert_eq!(fast.rounds, EARLY_ROUNDS);
        assert_eq!(fast.slowest, None);
        assert_eq!(reads, EARLY_ROUNDS * 24 * 3);

        let slow = measure(&guards, &reference, ROUNDS, BUDGET_US, &mut clock(20, 5000));
        assert!(!slow.ok);
        assert_eq!(slow.calibrated, 5000.0);
        assert_eq!(slow.rounds, EARLY_ROUNDS);
        assert_eq!(slow.slowest.as_deref(), Some(r"\bfree\b"));
    }

    #[test]
    fn a_loaded_copy_is_calibrated_and_a_borderline_set_runs_every_round() {
        let caps = Caps::default();
        let guards = GuardSet::build(vec![source(&["cat"], &[])], &caps).expect("set");
        let reference = Reference::build();
        let loaded = measure(&guards, &reference, ROUNDS, BUDGET_US, &mut clock(100, 900));
        assert!(loaded.ok);
        assert_eq!(loaded.calibrated, 180.0);
        assert_eq!(loaded.rounds, ROUNDS);
        let edge = measure(&guards, &reference, ROUNDS, BUDGET_US, &mut clock(20, 280));
        assert!(edge.ok);
        assert_eq!(edge.rounds, ROUNDS);
        assert_eq!(edge.slowest, None);
        let over = measure(&guards, &reference, ROUNDS, BUDGET_US, &mut clock(20, 310));
        assert!(!over.ok);
        assert_eq!(over.rounds, ROUNDS);
        assert_eq!(over.slowest, None);
    }

    #[test]
    fn a_real_run_accepts_a_simple_set() {
        let caps = Caps::default();
        let guards =
            GuardSet::build(vec![source(&["free nitro", "*spam*"], &[])], &caps).expect("set");
        let v = time_set(&guards, &Reference::build(), 100_000.0);
        assert!(v.ok, "{v:?}");
        assert!(v.calibrated > 0.0);
    }
}
