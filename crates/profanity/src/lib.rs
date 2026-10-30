use rustrict::{Censor, CensorStr, Type};
use std::collections::HashMap;
use std::ops::Range;
use unicode_normalization::UnicodeNormalization;
use unicode_normalization::char::{canonical_combining_class, compose};

// What counts as profane, for blocking on the server and masking in the client.
pub const THRESHOLD: Type = Type::INAPPROPRIATE;

const URL_PUNCT: &str = "-._~:/?#[]@!$&'()*+,;=%";
const URL_DELIMS: [char; 7] = ['/', '?', '#', '&', '=', ':', '@'];

fn url_len(text: &str, at: usize) -> Option<usize> {
    let rest = &text[at..];
    let scheme = ["http://", "https://"].iter().any(|s| {
        rest.get(..s.len())
            .is_some_and(|p| p.eq_ignore_ascii_case(s))
    });
    let bounded = !text[..at]
        .chars()
        .next_back()
        .is_some_and(|c| c.is_alphanumeric() || c == '_');
    match scheme && bounded {
        true => Some(
            rest.find(|c: char| !c.is_ascii_alphanumeric() && !URL_PUNCT.contains(c))
                .unwrap_or(rest.len()),
        ),
        false => None,
    }
}

fn words(text: &str) -> impl DoubleEndedIterator<Item = &str> {
    text.split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty())
}

fn push_words(phrases: &mut Vec<String>, phrase: &mut String, text: &str, gap: &str) {
    let short = |w: &str| w.chars().count() <= 2;
    let before = words(phrase).next_back().map(short);
    let after = words(text).next().map(short);
    match (before, after) {
        (Some(a), Some(b)) if a != b => phrases.push(std::mem::take(phrase)),
        _ => phrase.push_str(gap),
    }
    phrase.push_str(text);
}

fn issue_refs(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut prev = None;
    for (i, c) in text.char_indices() {
        let rest = &text[i + c.len_utf8()..];
        let digits = rest.len() - rest.trim_start_matches(|d: char| d.is_ascii_digit()).len();
        let reference = c == '#'
            && !prev.is_some_and(|p: char| p.is_alphanumeric())
            && digits > 0
            && !rest[digits..].starts_with(|n: char| n.is_alphanumeric());
        out.push(if reference { ' ' } else { c });
        prev = Some(c);
    }
    out
}

const NUMBER_RUN: usize = 5;
const NUMBER_KEEP: usize = 3;
const NUMBER_WORDS: [&str; 6] = ["58008", "80085", "800855", "5318008", "8008135", "55378008"];

fn long_numbers(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    let mut prev = None;
    while let Some(c) = rest.chars().next() {
        let digits = rest.len() - rest.trim_start_matches(|d: char| d.is_ascii_digit()).len();
        if digits == 0 {
            out.push(c);
            prev = Some(c);
            rest = &rest[c.len_utf8()..];
            continue;
        }
        let run = &rest[..digits];
        let number = digits >= NUMBER_RUN
            && !rest[digits..].starts_with(|n: char| n.is_alphanumeric())
            && !NUMBER_WORDS.contains(&run);
        let keep = match (number, prev.is_some_and(|p: char| p.is_alphanumeric())) {
            (false, _) => digits,
            (true, true) => NUMBER_KEEP,
            (true, false) => 0,
        };
        out.push_str(&run[..keep]);
        out.extend(std::iter::repeat_n(' ', digits - keep));
        prev = run.chars().next_back();
        rest = &rest[digits..];
    }
    out
}

fn phrases(text: &str, bridge: bool, links: bool) -> Vec<String> {
    let mut phrases = Vec::new();
    let mut phrase = String::with_capacity(text.len());
    let mut at = 0;
    for (i, _) in text.char_indices() {
        if i < at {
            continue;
        }
        let Some(len) = url_len(text, i) else {
            continue;
        };
        push_words(&mut phrases, &mut phrase, &text[at..i], "");
        let span = &text[i..i + len];
        let skip_host = bridge || (!links && skips_host(span));
        let url = percent_encoding::percent_decode_str(span).decode_utf8_lossy();
        for (n, part) in url.split(URL_DELIMS).filter(|p| !p.is_empty()).enumerate() {
            match (skip_host, n) {
                (true, 0 | 1) => {}
                (false, 0) => push_words(&mut phrases, &mut phrase, part, ""),
                (false, 1) => push_words(&mut phrases, &mut phrase, &part.replace('.', " "), " "),
                _ => push_words(&mut phrases, &mut phrase, part, " "),
            }
        }
        at = i + len;
    }
    push_words(&mut phrases, &mut phrase, &text[at..], "");
    phrases.push(phrase);
    phrases
}

const URL_TRAILING: &str = ".,;:!?)'\"";

fn plausible_host(authority: &str) -> bool {
    let host = match authority.rsplit_once(':') {
        Some((host, port))
            if !port.is_empty() && port.len() <= 5 && port.bytes().all(|b| b.is_ascii_digit()) =>
        {
            host
        }
        Some(_) => return false,
        None => authority,
    };
    let labels: Vec<&str> = host.split('.').collect();
    let label_ok = |l: &&str| {
        !l.is_empty()
            && l.len() <= 63
            && !l.starts_with('-')
            && !l.ends_with('-')
            && l.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
    };
    let ipv4 = labels.len() == 4
        && labels
            .iter()
            .all(|l| !l.is_empty() && l.len() <= 3 && l.parse::<u8>().is_ok());
    let tld = labels
        .last()
        .is_some_and(|t| t.len() >= 2 && t.bytes().all(|b| b.is_ascii_alphabetic()));
    host.eq_ignore_ascii_case("localhost")
        || ipv4
        || (labels.len() >= 2 && host.len() <= 253 && labels.iter().all(label_ok) && tld)
}

fn skips_host(span: &str) -> bool {
    let span = span.trim_end_matches(|c| URL_TRAILING.contains(c));
    let after_scheme = &span[span.find("://").map_or(span.len(), |n| n + 3)..];
    let end = after_scheme
        .find(['/', '?', '#'])
        .unwrap_or(after_scheme.len());
    plausible_host(&after_scheme[..end])
}

pub fn is_profane(text: &str, links: bool) -> bool {
    let text = long_numbers(&issue_refs(text));
    [false, true]
        .into_iter()
        .flat_map(|bridge| phrases(&text, bridge, links))
        .any(|p| p.as_str().is(THRESHOLD))
}

// Texts the server and the wasm build are checked against, in Rust and in bun.
pub const SAMPLES: &str = include_str!("../samples.txt");

// Devanagari only text is left alone, as rustrict does: its normalization damages it.
fn skips_censor(text: &str) -> bool {
    let mut special = false;
    for c in text.chars() {
        match c {
            '\u{0900}'..='\u{097F}' => special = true,
            c if c.is_whitespace() => {}
            _ => return false,
        }
    }
    special
}

// Char ranges of the text that rustrict's normalization (NFD, dropping marks, private use,
// unassigned and banned chars, NFC) never joins across: a new range starts at a char whose
// decomposition begins with a starter that doesn't compose with what comes before.
fn groups(read: &[char]) -> Vec<Range<usize>> {
    let mut out: Vec<Range<usize>> = Vec::new();
    let mut last = None;
    for (i, &c) in read.iter().enumerate() {
        let joins = |first: char| {
            last.is_some_and(|l| {
                canonical_combining_class(first) != 0 || compose(l, first).is_some()
            })
        };
        match out.last_mut() {
            Some(group) if c.nfd().next().is_some_and(joins) => group.end = i + 1,
            _ => out.push(i..i + 1),
        }
        last = c.nfd().last();
    }
    out
}

// Which chars of `read` rustrict censored, by walking its output along each range's own
// image (what rustrict makes of that range alone), and which it dropped. A dropped char has an
// empty image and uses up nothing. `None` when the output doesn't line up.
fn align(read: &[char], censored: &str) -> Option<(Vec<bool>, Vec<bool>)> {
    let mut images: HashMap<String, String> = HashMap::new();
    let mut out = vec![false; read.len()];
    let mut dropped = vec![false; read.len()];
    let mut censored = censored.chars();
    for group in groups(read) {
        let key: String = read[group.clone()].iter().collect();
        let image = images
            .entry(key)
            .or_insert_with_key(|k| Censor::from_str(k).censor());
        let mut starred = false;
        if image.is_empty() {
            dropped[group.clone()].fill(true);
        }
        for want in image.chars() {
            match censored.next()? {
                '*' => starred = true,
                got if got == want || want == '*' => {}
                _ => return None,
            }
        }
        if starred {
            for i in group {
                out[i] = read[i].is_alphanumeric();
            }
        }
    }
    censored.next().is_none().then_some((out, dropped))
}

// Shrinks each masked run at its edges, as rustrict's matches can reach into neighbouring
// letters and words ("this shit" is read as "thisshit"). A run is masked letters with only
// non-alphanumeric chars between them. An edge piece goes when its word is clean on its own and
// the rest of the run is still profane (single letters stay: "f u c k"); inside a word, the mask
// stops where the rest of the match is still profane and the rest of the word is clean
// ("fuckclub"). Dropped chars are part of the word they sit in.
fn trim(read: &str, chars: &[char], masked: &mut [bool], dropped: &[bool]) {
    let mut offsets: Vec<usize> = read.char_indices().map(|(i, _)| i).collect();
    offsets.push(read.len());
    let profane = |a: usize, b: usize| a < b && read[offsets[a]..offsets[b]].is(THRESHOLD);
    let alnum = |i: usize| chars[i].is_alphanumeric();
    // Words hold letters, digits, dropped chars and apostrophes between letters ("it's").
    let inside = |j: usize| {
        alnum(j)
            || dropped[j]
            || (matches!(chars[j], '\'' | '\u{2019}')
                && j > 0
                && alnum(j - 1)
                && chars.get(j + 1).is_some_and(|c| c.is_alphanumeric()))
    };
    let word = |i: usize| {
        let start = (0..i).rev().take_while(|&j| inside(j)).last().unwrap_or(i);
        let end = (i..chars.len())
            .find(|&j| !inside(j))
            .unwrap_or(chars.len());
        (start, end)
    };
    let letters = |(start, end): (usize, usize)| (start..end).filter(|&j| alnum(j)).count();
    let mut pieces: Vec<(usize, usize)> = Vec::new();
    for i in (0..chars.len()).filter(|&i| masked[i]) {
        match pieces.last_mut() {
            Some(piece) if (piece.1..i).all(|j| dropped[j]) => piece.1 = i + 1,
            _ => pieces.push((i, i + 1)),
        }
    }
    let mut runs: Vec<Vec<(usize, usize)>> = Vec::new();
    for piece in pieces {
        let end = runs.last().and_then(|run| run.last()).map(|last| last.1);
        match runs.last_mut() {
            Some(run) if end.is_some_and(|end| !(end..piece.0).any(alnum)) => run.push(piece),
            _ => runs.push(vec![piece]),
        }
    }
    masked.fill(false);
    let clean = |(start, _): (usize, usize)| {
        let (start, end) = word(start);
        letters((start, end)) > 1 && !profane(start, end)
    };
    // Whether the pieces next to a dropped one are still profane: the few nearest are enough,
    // as a match never spans many words, and it keeps long runs ("fuck you fuck you ...") fast.
    const NEAR: usize = 3;
    let spans = |run: &[(usize, usize)]| profane(run[0].0, run[run.len() - 1].1);
    let before = |run: &[(usize, usize)], i: usize| spans(&run[i.saturating_sub(NEAR)..i]);
    let after = |run: &[(usize, usize)], i: usize| spans(&run[i + 1..run.len().min(i + 1 + NEAR)]);
    let mut todo = runs;
    let mut shrunk = Vec::new();
    while let Some(run) = todo.pop() {
        let (mut lo, mut hi) = (0, run.len());
        while hi - lo > 1 && clean(run[lo]) && after(&run[..hi], lo) {
            lo += 1;
        }
        while hi - lo > 1 && clean(run[hi - 1]) && before(&run[lo..], hi - 1 - lo) {
            hi -= 1;
        }
        let run = &run[lo..hi];
        // A clean word inside goes too when the parts on both sides are profane on their own.
        let inner = (1..run.len().saturating_sub(1))
            .find(|&i| clean(run[i]) && before(run, i) && after(run, i));
        match inner {
            Some(i) => todo.extend([run[..i].to_vec(), run[i + 1..].to_vec()]),
            None => shrunk.push(run.to_vec()),
        }
    }
    for mut run in shrunk {
        let (first, last) = (0, run.len() - 1);
        let (from, (piece_start, end)) = (run[first].0, run[last]);
        let word_end = word(piece_start).1;
        if (end..word_end).any(alnum)
            && let Some(k) = (piece_start + 1..end)
                .rev()
                .find(|&k| profane(from, k) && !profane(k, word_end))
        {
            run[last].1 = k;
        }
        let (start, to) = (run[first], run[last].1);
        let word_start = word(start.0).0;
        if (word_start..start.0).any(alnum)
            && let Some(k) =
                (start.0 + 1..start.1).find(|&k| profane(k, to) && !profane(word_start, k))
        {
            run[first].0 = k;
        }
        for (start, end) in run {
            for (j, m) in masked.iter_mut().enumerate().take(end).skip(start) {
                *m = alnum(j);
            }
        }
    }
}

// Each letter or digit of a profane match becomes `*`; spaces, punctuation and everything
// else stay. The text is read the way `is_profane` reads it, so `#55` and long numbers pass.
pub fn mask(text: &str) -> String {
    if skips_censor(text) {
        return text.to_owned();
    }
    let read = long_numbers(&issue_refs(text));
    let censored = Censor::from_str(&read)
        .with_censor_threshold(THRESHOLD)
        .with_censor_first_character_threshold(Type::ANY)
        .with_censor_replacement('*')
        .censor();
    if !censored.contains('*') {
        return text.to_owned();
    }
    let chars: Vec<char> = read.chars().collect();
    let (mut masked, dropped) = align(&chars, &censored).unwrap_or_else(|| {
        let letters = chars.iter().map(|c| c.is_alphanumeric()).collect();
        (letters, vec![false; chars.len()])
    });
    trim(&read, &chars, &mut masked, &dropped);
    text.chars()
        .zip(masked)
        .map(|(c, masked)| if masked { '*' } else { c })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn masks_each_letter_of_a_match() {
        for (text, want) in [
            ("hello", "hello"),
            ("fuck", "****"),
            ("Fuck you", "**** you"),
            ("what the shit.", "what the ****."),
            ("sh1t", "****"),
            ("f.u.c.k off", "*.*.*.* off"),
            ("fučk", "****"),
            ("push it", "push it"),
            ("you are an asshole!!", "you are an *******!!"),
            ("f u c k", "* * * *"),
            ("a\u{301}sshole", "*\u{301}******"),
            ("\u{200b}fuck", "\u{200b}****"),
            ("club1793012345678", "club1793012345678"),
            ("see #55 and #55hole", "see #55 and #******"),
            ("", ""),
            ("नमस्ते", "नमस्ते"),
        ] {
            assert_eq!(mask(text), want, "{text}");
        }
    }

    // rustrict's matches reach into neighbouring letters and words; masks stop at the match.
    #[test]
    fn masks_stay_on_the_match() {
        for (text, want) in [
            ("Is this shit good", "Is this **** good"),
            ("this shit", "this ****"),
            ("his shit", "his ****"),
            ("is shit", "is ****"),
            ("was shit", "was ****"),
            ("it's shit", "it's ****"),
            ("fuck club", "**** club"),
            ("fuck cops", "**** cops"),
            ("go fuck yourself", "go **** yourself"),
            ("bad ass bitch", "bad *** *****"),
            ("https://fuck.co/x", "https://****.co/x"),
            ("fuckclub", "****club"),
            ("f u c k", "* * * *"),
            ("f.u.c.k off", "*.*.*.* off"),
            ("fucking hell", "******* ****"),
            ("shithead", "********"),
        ] {
            assert_eq!(mask(text), want, "{text}");
        }
    }

    // Chars rustrict drops (bidi controls, private use, unassigned) use up no `*`.
    #[test]
    fn dropped_chars_keep_the_mask_in_place() {
        for (text, want) in [
            ("\u{2066}fuck\u{2069}", "\u{2066}****\u{2069}"),
            ("fu\u{202e}ck", "**\u{202e}**"),
            (
                "\u{202e}\u{202e}\u{202e}\u{202e}fuck",
                "\u{202e}\u{202e}\u{202e}\u{202e}****",
            ),
            ("\u{e000}fuck you", "\u{e000}**** you"),
            ("\u{378}shit\u{378}", "\u{378}****\u{378}"),
        ] {
            assert_eq!(mask(text), want, "{text:?}");
        }
    }

    fn leaks(text: &str) -> bool {
        mask(text).contains(['f', 'u', 'c', 'k'])
    }

    // Every char that isn't a letter or digit, before, after and inside a profane word.
    #[test]
    fn no_char_lets_letters_through() {
        let chars = (0..=0xFFFF)
            .chain(0xE0000..=0xE007F)
            .chain((0x10000..=0x10FFFF).step_by(97))
            .filter_map(char::from_u32)
            .filter(|c| !c.is_alphanumeric());
        for c in chars {
            for text in [format!("{c}fuck"), format!("fuck{c}")] {
                assert!(!leaks(&text), "{text:?} -> {:?}", mask(&text));
            }
            let dropped = Censor::from_str(&c.to_string()).censor().is_empty();
            let text = format!("fu{c}ck");
            assert!(!dropped || !leaks(&text), "{text:?} -> {:?}", mask(&text));
        }
    }

    // Random dropped and zero-width chars around and inside known words: profane words come
    // out fully masked and clean words untouched.
    #[test]
    fn fuzz_invisible_chars() {
        const PROFANE: [&str; 4] = ["fuck", "shit", "bitch", "asshole"];
        const CLEAN: [&str; 5] = ["hello", "good", "club", "you", "cats"];
        const DROPPED: [char; 12] = [
            '\u{202a}', '\u{202b}', '\u{202c}', '\u{202d}', '\u{202e}', '\u{2066}', '\u{2067}',
            '\u{2068}', '\u{2069}', '\u{e000}', '\u{f8ff}', '\u{378}',
        ];
        const AROUND: [char; 7] = [
            '\u{200b}',
            '\u{200c}',
            '\u{200d}',
            '\u{2060}',
            '\u{feff}',
            '\u{e0001}',
            '\u{10fffd}',
        ];
        let mut seed: u64 = 0x9e37_79b9_7f4a_7c15;
        let mut next = |n: usize| {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            (seed % n as u64) as usize
        };
        for _ in 0..3000 {
            let mut text: Vec<char> = Vec::new();
            let mut letters: Vec<(usize, bool)> = Vec::new();
            for w in 0..1 + next(4) {
                if w > 0 {
                    text.push(' ');
                }
                for _ in 0..next(3) {
                    text.push(AROUND[next(AROUND.len())]);
                }
                let profane = next(2) == 0;
                let word = match profane {
                    true => PROFANE[next(PROFANE.len())],
                    false => CLEAN[next(CLEAN.len())],
                };
                for (i, c) in word.chars().enumerate() {
                    if i > 0 && next(3) == 0 {
                        text.push(DROPPED[next(DROPPED.len())]);
                    }
                    letters.push((text.len(), profane));
                    text.push(c);
                }
                for _ in 0..next(3) {
                    text.push(AROUND[next(AROUND.len())]);
                }
            }
            let text: String = text.into_iter().collect();
            let masked: Vec<char> = mask(&text).chars().collect();
            for (at, profane) in letters {
                assert_eq!(masked[at] == '*', profane, "{text:?} -> {masked:?}");
            }
            let chars: Vec<char> = text.chars().collect();
            let censored = Censor::from_str(&text)
                .with_censor_threshold(THRESHOLD)
                .with_censor_first_character_threshold(Type::ANY)
                .censor();
            assert!(align(&chars, &censored).is_some(), "{text:?}");
        }
    }

    #[test]
    fn keeps_length_and_clean_text() {
        for text in [
            "a\u{301}sshole",
            "zalgo f\u{338}u\u{337}ck",
            "\u{200b}fuck",
            "ｆｕｃｋ",
        ] {
            let masked = mask(text);
            assert_eq!(
                masked.chars().count(),
                text.chars().count(),
                "{text} -> {masked}"
            );
        }
    }

    // Every sample the server blocks is masked, and nothing else.
    #[test]
    fn masks_what_the_server_blocks() {
        for text in SAMPLES.lines() {
            let masked = mask(text);
            assert_eq!(
                masked != text,
                is_profane(text, true),
                "{text:?} -> {masked:?}"
            );
        }
    }
}
