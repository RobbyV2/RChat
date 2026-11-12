//! Keyword matching: Discord's wildcard syntax over normalized text. Word characters are letters,
//! marks and digits; anything else, or the edge of the text, is a boundary.

use crate::fold::fold;
use aho_corasick::{AhoCorasick, MatchKind};
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::sync::LazyLock;
use unicode_normalization::UnicodeNormalization;

static INVISIBLE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\p{Cf}+").expect("regex"));
static WORD: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[\p{L}\p{M}\p{N}]").expect("regex"));

/// The text as keywords, patterns and names are matched against it: NFKC, format characters
/// removed, lowercase, look-alikes folded, and every run of white space one space.
pub fn normalize(text: &str) -> String {
    let composed: String = text.nfkc().collect();
    let visible = INVISIBLE.replace_all(&composed, "");
    let mut out = String::with_capacity(visible.len());
    let mut spaced = false;
    for c in visible.to_lowercase().chars().map(fold) {
        match (c.is_whitespace(), spaced) {
            (true, true) => {}
            (true, false) => out.push(' '),
            (false, _) => out.push(c),
        }
        spaced = c.is_whitespace();
    }
    out
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    Whole,
    Prefix,
    Suffix,
    Anywhere,
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Pattern {
    pub kind: Kind,
    pub text: String,
}

pub const MAX_ENTRY: usize = 60;

/// One list entry: `word`, `word*`, `*word` or `*word*`. Empty entries, entries with a `*`
/// inside and entries over 60 characters are no pattern.
pub fn parse(entry: &str) -> Option<Pattern> {
    let raw = entry.trim();
    let lead = raw.starts_with('*');
    let tail = raw.ends_with('*') && raw.len() > 1;
    let inner = &raw[usize::from(lead)..raw.len() - usize::from(tail)];
    let text = normalize(inner).trim().to_string();
    if text.is_empty() || text.contains('*') || raw.chars().count() > MAX_ENTRY {
        return None;
    }
    let kind = match (lead, tail) {
        (true, true) => Kind::Anywhere,
        (true, false) => Kind::Suffix,
        (false, true) => Kind::Prefix,
        (false, false) => Kind::Whole,
    };
    Some(Pattern { kind, text })
}

fn word(c: char) -> bool {
    match c.is_ascii() {
        true => c.is_ascii_alphanumeric(),
        false => WORD.is_match(c.encode_utf8(&mut [0; 4])),
    }
}

fn fits(t: &str, kind: Kind, start: usize, end: usize) -> bool {
    let before = || !t[..start].chars().next_back().is_some_and(word);
    let after = || !t[end..].chars().next().is_some_and(word);
    match kind {
        Kind::Anywhere => true,
        Kind::Whole => before() && after(),
        Kind::Prefix => before(),
        Kind::Suffix => after(),
    }
}

fn occurrences(t: &str, needle: &str) -> Vec<usize> {
    let mut out = Vec::new();
    let mut from = 0;
    while let Some(at) = t[from..].find(needle) {
        let start = from + at;
        out.push(start);
        from = start + t[start..].chars().next().map_or(1, char::len_utf8);
    }
    out
}

/// Every span of the normalized text `t` that `p` matches, as byte offsets.
pub fn spans(t: &str, p: &Pattern) -> Vec<(usize, usize)> {
    occurrences(t, &p.text)
        .into_iter()
        .map(|start| (start, start + p.text.len()))
        .filter(|&(start, end)| fits(t, p.kind, start, end))
        .collect()
}

/// A match: the index of the entry in its list, and the span in the normalized text.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
pub struct Hit {
    pub entry: usize,
    pub start: usize,
    pub end: usize,
}

fn covered(allowed: &[(usize, usize)], start: usize, end: usize) -> bool {
    allowed.iter().any(|&(s, e)| s <= start && end <= e)
}

/// The first entry of `list` that matches `text` outside every span the allow list covers.
pub fn find(text: &str, list: &[String], allow: &[String]) -> Option<Hit> {
    let t = normalize(text);
    let allowed: Vec<(usize, usize)> = allow
        .iter()
        .filter_map(|a| parse(a))
        .flat_map(|p| spans(&t, &p))
        .collect();
    list.iter().enumerate().find_map(|(entry, raw)| {
        let p = parse(raw)?;
        spans(&t, &p)
            .into_iter()
            .find(|&(start, end)| !covered(&allowed, start, end))
            .map(|(start, end)| Hit { entry, start, end })
    })
}

#[derive(Debug)]
struct Tag {
    group: usize,
    allow: bool,
    entry: usize,
    kind: Kind,
}

/// Keyword lists compiled into one automaton. Each group is a list with its own allow list; a
/// single list is group 0.
#[derive(Debug)]
pub struct KeywordSet {
    automaton: Option<AhoCorasick>,
    tags: Vec<Tag>,
    groups: usize,
    entries: usize,
}

impl KeywordSet {
    pub fn new(list: &[String], allow: &[String]) -> KeywordSet {
        KeywordSet::grouped(&[(list, allow)])
    }

    pub fn grouped(groups: &[(&[String], &[String])]) -> KeywordSet {
        let mut tags = Vec::new();
        let mut texts = Vec::new();
        for (group, (list, allow)) in groups.iter().enumerate() {
            for (allow, entries) in [(false, list), (true, allow)] {
                for (entry, raw) in entries.iter().enumerate() {
                    if let Some(p) = parse(raw) {
                        tags.push(Tag {
                            group,
                            allow,
                            entry,
                            kind: p.kind,
                        });
                        texts.push(p.text);
                    }
                }
            }
        }
        let entries = tags.iter().filter(|t| !t.allow).count();
        let automaton = match entries {
            0 => None,
            _ => AhoCorasick::builder()
                .match_kind(MatchKind::Standard)
                .build(&texts)
                .ok(),
        };
        KeywordSet {
            automaton,
            tags,
            groups: groups.len(),
            entries,
        }
    }

    /// The list entries that are patterns, over every group.
    pub fn len(&self) -> usize {
        self.entries
    }

    pub fn is_empty(&self) -> bool {
        self.entries == 0
    }

    /// `find` for the first group.
    pub fn find(&self, text: &str) -> Option<Hit> {
        self.find_normalized(&normalize(text))
    }

    pub fn find_normalized(&self, t: &str) -> Option<Hit> {
        self.find_each(t).into_iter().next().flatten()
    }

    /// Each group's first hit in the normalized text `t`, as `find` gives it for that group.
    pub fn find_each(&self, t: &str) -> Vec<Option<Hit>> {
        let mut allowed: Vec<Vec<(usize, usize)>> = vec![Vec::new(); self.groups];
        let mut hits: Vec<Vec<Hit>> = vec![Vec::new(); self.groups];
        for m in self
            .automaton
            .iter()
            .flat_map(|a| a.find_overlapping_iter(t))
        {
            let tag = &self.tags[m.pattern().as_usize()];
            if !fits(t, tag.kind, m.start(), m.end()) {
                continue;
            }
            match tag.allow {
                true => allowed[tag.group].push((m.start(), m.end())),
                false => hits[tag.group].push(Hit {
                    entry: tag.entry,
                    start: m.start(),
                    end: m.end(),
                }),
            }
        }
        hits.into_iter()
            .zip(allowed)
            .map(|(hits, allowed)| {
                hits.into_iter()
                    .filter(|h| !covered(&allowed, h.start, h.end))
                    .min_by_key(|h| (h.entry, h.start))
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strings(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    fn hit(text: &str, list: &[&str], allow: &[&str]) -> Option<String> {
        let (list, allow) = (strings(list), strings(allow));
        let linear = find(text, &list, &allow).map(|h| list[h.entry].clone());
        let set = KeywordSet::new(&list, &allow);
        assert_eq!(
            set.find(text).map(|h| list[h.entry].clone()),
            linear,
            "{text}"
        );
        linear
    }

    #[test]
    fn whole_word_needs_boundaries_on_both_sides() {
        assert_eq!(hit("the cat sat", &["cat"], &[]).as_deref(), Some("cat"));
        assert_eq!(hit("cat!", &["cat"], &[]).as_deref(), Some("cat"));
        assert_eq!(hit("catch", &["cat"], &[]), None);
        assert_eq!(hit("wildcat", &["cat"], &[]), None);
        assert_eq!(hit("a cat", &["cat"], &[]).as_deref(), Some("cat"));
        assert_eq!(hit("xcat", &["cat"], &[]), None);
    }

    #[test]
    fn prefix_suffix_and_anywhere() {
        assert_eq!(hit("Catapult", &["cat*"], &[]).as_deref(), Some("cat*"));
        assert_eq!(hit("wildcat", &["cat*"], &[]), None);
        assert_eq!(hit("wildcat", &["*cat"], &[]).as_deref(), Some("*cat"));
        assert_eq!(hit("catch", &["*cat"], &[]), None);
        assert_eq!(hit("location", &["*cat*"], &[]).as_deref(), Some("*cat*"));
    }

    #[test]
    fn phrases_match_across_extra_spaces() {
        assert_eq!(
            hit("get  free\tnitro now", &["free nitro"], &[]).as_deref(),
            Some("free nitro")
        );
    }

    #[test]
    fn normalization_covers_width_case_format_characters_and_look_alikes() {
        assert_eq!(
            hit("ＦＲＥＥ stuff", &["free"], &[]).as_deref(),
            Some("free")
        );
        assert_eq!(
            hit("fr\u{200b}ee stuff", &["free"], &[]).as_deref(),
            Some("free")
        );
        assert_eq!(hit("frее stuff", &["free"], &[]).as_deref(), Some("free"));
        assert_eq!(normalize("ΑΒΓ"), "aby");
        assert_eq!(normalize("ΑΒΛ"), "abλ");
    }

    #[test]
    fn the_allow_list_wins_only_over_the_spans_it_covers() {
        assert_eq!(hit("scunthorpe united", &["*cunt*"], &["scunthorpe"]), None);
        assert_eq!(
            hit("scunthorpe and cunt", &["*cunt*"], &["scunthorpe"]).as_deref(),
            Some("*cunt*")
        );
    }

    #[test]
    fn bad_entries_are_ignored() {
        assert_eq!(parse(""), None);
        assert_eq!(parse("*"), None);
        assert_eq!(parse("a*b"), None);
        assert_eq!(parse(&"x".repeat(61)), None);
        assert!(parse(&"x".repeat(60)).is_some());
        assert_eq!(hit("anything", &["", "*"], &[]), None);
        assert_eq!(
            parse(" *Cat* "),
            Some(Pattern {
                kind: Kind::Anywhere,
                text: "cat".into()
            })
        );
        assert_eq!(parse("**"), None);
        assert_eq!(parse("* *"), None);
    }

    #[test]
    fn latin_words_never_turn_into_other_latin_words() {
        assert_eq!(hit("I got burned, burn it", &["bum"], &[]), None);
        assert_eq!(hit("a field of corn", &["com"], &[]), None);
        assert_eq!(hit("l0l that was funny", &["lol"], &[]), None);
        assert_eq!(hit("documents", &["*curn*"], &[]), None);
        assert_eq!(hit("he is a bum", &["bum"], &[]).as_deref(), Some("bum"));
    }

    #[test]
    fn latin_letters_never_fold() {
        assert_eq!(normalize("ı"), "ı");
        assert_eq!(normalize("ｍ"), "m");
        assert_eq!(normalize("rn m 0 1 l"), "rn m 0 1 l");
    }

    #[test]
    fn the_first_entry_in_list_order_wins_and_its_first_span() {
        let list = strings(&["dog", "cat", "*at"]);
        let h = find("a cat and a dog", &list, &[]).expect("hit");
        assert_eq!((h.entry, h.start, h.end), (0, 12, 15));
        let h = find("a cat sat", &strings(&["*at", "cat"]), &[]).expect("hit");
        assert_eq!((h.entry, h.start, h.end), (0, 3, 5));
        let set = KeywordSet::new(&list, &[]);
        let h = set.find("a cat and a dog").expect("hit");
        assert_eq!((h.entry, h.start, h.end), (0, 12, 15));
    }

    #[test]
    fn spans_overlap_and_marks_are_word_characters() {
        let p = parse("*aa*").expect("pattern");
        assert_eq!(spans("aaa", &p), [(0, 2), (1, 3)]);
        assert_eq!(hit("cat\u{0301}", &["cat"], &[]), None);
        assert_eq!(hit("cat_", &["cat"], &[]).as_deref(), Some("cat"));
        assert_eq!(hit("cat5", &["cat"], &[]), None);
        assert_eq!(hit("猫cat", &["cat"], &[]), None);
    }

    #[test]
    fn a_thousand_entries_match_like_the_linear_scan() {
        let list: Vec<String> = (0..1000)
            .map(|i| match i % 4 {
                0 => format!("word{i}"),
                1 => format!("word{i}*"),
                2 => format!("*word{i}"),
                _ => format!("*word{i}*"),
            })
            .collect();
        let allow = strings(&["word7 ok", "xword998"]);
        let set = KeywordSet::new(&list, &allow);
        assert_eq!(set.len(), 1000);
        for text in [
            "nothing here",
            "word4",
            "word5s",
            "aword6",
            "aword7b",
            "word7 ok",
            "xword998 and word999x",
            "WORD12 word8",
            "word1000",
        ] {
            let linear = find(text, &list, &allow);
            assert_eq!(set.find(text), linear, "{text}");
        }
        assert_eq!(set.find("word4").map(|h| h.entry), Some(4));
        assert_eq!(set.find("word7 ok"), None);
    }

    #[test]
    fn an_empty_list_matches_nothing() {
        let set = KeywordSet::new(&[], &[]);
        assert!(set.is_empty());
        assert_eq!(set.find("anything"), None);
    }
}
