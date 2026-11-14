use rustrict::{Censor, CensorStr, Type};
use std::cell::{Cell, RefCell};
use std::collections::{HashMap, HashSet};
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
        let reference = c == '#' && !prev.is_some_and(|p: char| p.is_alphanumeric()) && {
            let rest = &text[i + 1..];
            let digits = rest.len() - rest.trim_start_matches(|d: char| d.is_ascii_digit()).len();
            digits > 0 && !rest[digits..].starts_with(|n: char| n.is_alphanumeric())
        };
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

const EXTENSIONS: &[&str] = &[
    "7z", "aac", "apk", "avi", "avif", "bat", "bmp", "bz2", "cfg", "cjs", "conf", "cpp", "cs",
    "css", "csv", "dart", "db", "deb", "diff", "dll", "dmg", "doc", "docx", "env", "epub", "exe",
    "flac", "gif", "go", "gz", "heic", "hpp", "htm", "html", "ico", "ics", "ini", "ipa", "iso",
    "jar", "java", "jpeg", "jpg", "js", "json", "jsonl", "jsx", "kt", "log", "lua", "m4a", "md",
    "mjs", "mkv", "mov", "mp3", "mp4", "msi", "mts", "odp", "ods", "odt", "ogg", "opus", "otf",
    "patch", "pdf", "php", "png", "ppt", "pptx", "ps1", "psd", "py", "rar", "rb", "rpm", "rs",
    "rtf", "scss", "sh", "sql", "sqlite", "svelte", "svg", "swift", "tar", "tgz", "tif", "tiff",
    "toml", "ts", "tsv", "tsx", "ttf", "txt", "vcf", "vue", "wasm", "wav", "webm", "webp", "woff2",
    "xls", "xlsx", "xml", "xz", "yaml", "yml", "zip", "zst",
];

// A file name is read as its stem: a known extension after it ("test.js", "archive.tar.gz") is
// left out, so a match never joins the two.
fn stems(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut prev = None;
    let mut at = 0;
    for (i, c) in text.char_indices() {
        if i < at {
            continue;
        }
        let ext = match c == '.' && prev.is_some_and(|p: char| p.is_alphanumeric()) {
            true => {
                let rest = &text[i + 1..];
                let end = rest.find(|n: char| !n.is_alphanumeric());
                Some(&rest[..end.unwrap_or(rest.len())])
            }
            false => None,
        };
        match ext.filter(|ext| EXTENSIONS.iter().any(|e| e.eq_ignore_ascii_case(ext))) {
            Some(ext) => {
                out.extend(std::iter::repeat_n(' ', 1 + ext.len()));
                prev = ext.chars().next_back();
                at = i + 1 + ext.len();
            }
            None => {
                out.push(c);
                prev = Some(c);
            }
        }
    }
    out
}

// Where a file name is read as its stem.
#[derive(Clone, Copy)]
enum Stems {
    // Nowhere: the whole reading, which strict file names add.
    Nowhere,
    // In the paths of links.
    Paths,
    // In the whole text, a file name.
    Everywhere,
}

impl Stems {
    fn read(self, text: &str, path: bool) -> String {
        match (self, path) {
            (Stems::Nowhere, _) | (Stems::Paths, false) => text.to_owned(),
            (Stems::Paths, true) | (Stems::Everywhere, _) => stems(text),
        }
    }
}

// Where the authority of a link (user info, host, port) starts, and where its path starts.
fn authority(url: &str) -> (usize, usize) {
    let host = url.find("://").map_or(0, |n| n + 3);
    let path = url[host..]
        .find(['/', '?', '#'])
        .map_or(url.len(), |n| host + n);
    (host, path)
}

fn spaced(text: &str) -> impl Iterator<Item = char> {
    text.chars().map(|c| match URL_DELIMS.contains(&c) {
        true => ' ',
        false => c,
    })
}

// The text as the matcher reads it; it has the same chars as `text`. With `paths`, a link is read
// the way `phrases` reads it for `is_profane`: the parts of its authority apart, and the words of
// its path apart.
fn read_text(text: &str, paths: bool, stems: Stems) -> String {
    let mut out = String::with_capacity(text.len());
    let mut at = 0;
    for (i, _) in text.char_indices() {
        if i < at {
            continue;
        }
        let Some(len) = url_len(text, i) else {
            continue;
        };
        let url = &text[i..i + len];
        let (host, path) = match paths {
            true => authority(url),
            false => (url.len(), url.len()),
        };
        out.push_str(&stems.read(&text[at..i], false));
        out.push_str(&url[..host]);
        out.extend(spaced(&url[host..path]));
        out.extend(spaced(&stems.read(&url[path..], true)));
        at = i + len;
    }
    out.push_str(&stems.read(&text[at..], false));
    long_numbers(&issue_refs(&out))
}

fn phrases(text: &str, bridge: bool, links: bool, stems: Stems) -> Vec<String> {
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
        let (head, path) = url.split_at(authority(&url).1);
        for (n, part) in head.split(URL_DELIMS).filter(|p| !p.is_empty()).enumerate() {
            match (skip_host, n) {
                (true, 0 | 1) => {}
                (false, 0) => push_words(&mut phrases, &mut phrase, part, ""),
                (false, 1) => push_words(&mut phrases, &mut phrase, &part.replace('.', " "), " "),
                _ => push_words(&mut phrases, &mut phrase, part, " "),
            }
        }
        for part in path.split(URL_DELIMS).filter(|p| !p.is_empty()) {
            push_words(&mut phrases, &mut phrase, &stems.read(part, true), " ");
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

fn lookalikes(digit: char) -> &'static str {
    match digit {
        '0' => "o",
        '1' => "il",
        '2' => "z",
        '3' => "beg",
        '4' => "a",
        '5' => "s",
        '6' => "bs",
        '7' => "t",
        '8' => "bh",
        '9' => "gpq",
        _ => "",
    }
}

const READINGS: usize = 64;

// The maximal run of chars `inside` around each char (`(i, i)` for a char that isn't).
fn extents(len: usize, inside: impl Fn(usize) -> bool) -> Vec<(usize, usize)> {
    let mut out: Vec<(usize, usize)> = (0..len).map(|i| (i, i)).collect();
    let mut start = 0;
    for end in (0..=len).filter(|&j| j == len || !inside(j)) {
        out[start..end].fill((start, end));
        start = end + 1;
    }
    out
}

// Whether `text` is only profane when the digits between the letters of a short word (two
// letters at most, "p2p", "h2o", "k8s") are read through, as rustrict does with every char that
// isn't a letter ("p2p" as "pp"): it is still profane without them, and in no reading of them
// as the letters they look like. Digits in a longer word are read through ("fu2ck").
fn reads_through_digits(text: &str, left: &Cell<usize>) -> bool {
    let chars: Vec<char> = text.chars().collect();
    let mut skip = vec![false; chars.len()];
    let mut start = 0;
    for end in (0..=chars.len()).filter(|&j| j == chars.len() || !chars[j].is_alphanumeric()) {
        let letters: Vec<usize> = (start..end)
            .filter(|&j| chars[j].is_alphabetic())
            .take(3)
            .collect();
        if let [a, b] = letters[..]
            && (a + 1..b).all(|j| chars[j].is_ascii_digit())
        {
            skip[a + 1..b].fill(true);
        }
        start = end + 1;
    }
    let inner: Vec<usize> = (0..chars.len()).filter(|&i| skip[i]).collect();
    let readings = inner.iter().try_fold(1usize, |n, &i| {
        n.checked_mul(lookalikes(chars[i]).len())
            .filter(|n| *n <= READINGS)
    });
    let (false, Some(readings)) = (inner.is_empty(), readings) else {
        return false;
    };
    let without: String = (0..chars.len())
        .filter(|&i| !skip[i])
        .map(|i| chars[i])
        .collect();
    let reading = |mut n: usize| -> String {
        let mut out = chars.clone();
        for &i in &inner {
            let letters = lookalikes(chars[i]).as_bytes();
            out[i] = letters[n % letters.len()] as char;
            n /= letters.len();
        }
        out.into_iter().collect()
    };
    listed_within(&without, left) && !(0..readings).any(|n| listed_within(&reading(n), left))
}

// A text handed to rustrict; tests count them to bound the work.
fn counted(text: &str) -> &str {
    #[cfg(test)]
    tests::READ.with(|read| read.set(read.get() + text.len()));
    text
}

// Whether rustrict lists `text`, read while `left` lasts (bytes to hand to rustrict). Past it
// every text counts as listed, which keeps what rustrict masked.
fn listed_within(text: &str, left: &Cell<usize>) -> bool {
    match left.get().checked_sub(text.len()) {
        Some(rest) => {
            left.set(rest);
            counted(text).is(THRESHOLD)
        }
        None => true,
    }
}

fn flagged(text: &str, left: &Cell<usize>) -> bool {
    listed_within(text, left) && !reads_through_digits(text, left)
}

// What a check may hand to rustrict after its first reading of `text`: rustrict's cost per char
// varies a hundred times with the text, so a check of a long text stops trimming early rather
// than reading it many times over.
fn budget(text: &str) -> Cell<usize> {
    Cell::new(PASSES * (text.len() + REACH))
}

// What rustrict counts as a space between words. It reads through every other char that isn't
// a letter, or reads it as one ("sh!t").
fn gap(c: char) -> bool {
    c.is_whitespace() || matches!(c, '.' | ',' | ':' | ';' | '…' | '(' | ')' | '_' | '-')
}

// Whether any of the readings of `text` is profane. They share one budget, and a phrase two of
// them read alike is read once.
fn profane(text: &str, links: bool, readings: &[Stems]) -> bool {
    let left = budget(text);
    let mut read = HashSet::new();
    readings.iter().any(|&stems| {
        let text = read_text(text, false, stems);
        [false, true]
            .into_iter()
            .flat_map(|bridge| phrases(&text, bridge, links, stems))
            .filter(|p| read.insert(p.clone()))
            .any(|p| {
                let (censored, analysis) = censor(&p);
                analysis.is(THRESHOLD)
                    && matches(&p, &censored, &left).is_none_or(|m| m.contains(&true))
            })
    })
}

// Whether the site filter blocks `text`. `links`: the host of a link is read too.
pub fn is_profane(text: &str, links: bool) -> bool {
    profane(text, links, &[Stems::Paths])
}

// Whether the site filter blocks the name of an uploaded file.
pub fn is_profane_file_name(name: &str) -> bool {
    profane(name, true, &[Stems::Everywhere])
}

// `is_profane`, or the same with file names in the paths of links read whole, extension
// included: the site filter with strict file names.
pub fn is_profane_strict(text: &str, links: bool) -> bool {
    profane(text, links, &[Stems::Paths, Stems::Nowhere])
}

// `is_profane_file_name`, or the name read whole like message text.
pub fn is_profane_file_name_strict(name: &str) -> bool {
    profane(name, true, &[Stems::Everywhere, Stems::Nowhere])
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
            .or_insert_with_key(|k| Censor::from_str(counted(k)).censor());
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

// How far a cut inside a word is looked for, and read on each side of it: no listed word is that
// long, and long words ("fuck1fuck1...") stay fast.
const REACH: usize = 64;

// How many times over a check may hand a text to rustrict to trim its matches. Ordinary text needs
// one at most; past this, the rest keeps what rustrict masked.
const PASSES: usize = 3;

// Shrinks each masked run at its edges, as rustrict's matches can reach into neighbouring
// letters and words ("this shit" is read as "thisshit"). A run is masked letters with only
// non-alphanumeric chars between them. An edge piece goes when its word is clean on its own and
// the rest of the run is still profane (single letters stay: "f u c k"); inside a word, the mask
// stops where the rest of the match is still profane and the rest of the word is clean
// ("fuckclub"). Dropped chars are part of the word they sit in. A run that only joins part of a
// clean word to its neighbour, or reads through the digits of a word, goes as a whole.
fn trim(read: &str, chars: &[char], masked: &mut [bool], dropped: &[bool], left: &Cell<usize>) {
    let mut offsets: Vec<usize> = read.char_indices().map(|(i, _)| i).collect();
    offsets.push(read.len());
    let seen = RefCell::new(HashMap::new());
    let profane = |a: usize, b: usize| {
        a < b && {
            let text = &read[offsets[a]..offsets[b]];
            *seen
                .borrow_mut()
                .entry(text)
                .or_insert_with(|| flagged(text, left))
        }
    };
    let alnum = |i: usize| chars[i].is_alphanumeric();
    let mut counts = vec![0];
    counts.extend((0..chars.len()).scan(0, |n, i| {
        *n += usize::from(alnum(i));
        Some(*n)
    }));
    let letters = |(start, end): (usize, usize)| counts[end] - counts[start];
    // Words hold letters, digits, dropped chars and apostrophes between letters ("it's").
    let words = extents(chars.len(), |j| {
        alnum(j)
            || dropped[j]
            || (matches!(chars[j], '\'' | '\u{2019}')
                && j > 0
                && alnum(j - 1)
                && chars.get(j + 1).is_some_and(|c| c.is_alphanumeric()))
    });
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
            Some(run) if end.is_some_and(|end| letters((end, piece.0)) == 0) => run.push(piece),
            _ => runs.push(vec![piece]),
        }
    }
    masked.fill(false);
    let clean = |(start, _): (usize, usize)| {
        let word = words[start];
        letters(word) > 1 && !profane(word.0, word.1)
    };
    // Whether the pieces next to a dropped one are still profane: the few nearest are enough,
    // as a match never spans many words, and it keeps long runs ("fuck you fuck you ...") fast.
    const NEAR: usize = 3;
    let spans = |run: &[(usize, usize)]| profane(run[0].0, run[run.len() - 1].1);
    let before = |run: &[(usize, usize)], i: usize| spans(&run[i.saturating_sub(NEAR)..i]);
    let after = |run: &[(usize, usize)], i: usize| spans(&run[i + 1..run.len().min(i + 1 + NEAR)]);
    // The text between two gaps around a char, and whether it is a clean word of its own.
    let stretches = extents(chars.len(), |j| !gap(chars[j]));
    let ordinary = |(start, end): (usize, usize)| letters((start, end)) > 1 && !profane(start, end);
    // Across a gap, rustrict lets a match start in the last letter of a word ("kept.txt" is
    // "t txt", read as "tit") or end in the first letters of the next ("see example" is "see
    // ex"). Such a run is no match when that word is clean, the run takes only its last letter or
    // half or less of the word it ends in, and the rest isn't profane without it. A run that
    // takes more of the word it starts in stays ("xfu ck"), and so does one that ends inside a
    // word it covers most of ("blow jobs").
    let joins = |run: &[(usize, usize)]| {
        let (first, last) = (stretches[run[0].0], stretches[run[run.len() - 1].0]);
        let (start, end) = (run[0].0, run[run.len() - 1].1);
        let head = run.iter().take_while(|piece| piece.0 < first.1).count();
        let tail = run
            .iter()
            .rev()
            .take_while(|piece| piece.0 >= last.0)
            .count();
        // Repeats of the last letter are part of the match ("MEEEE").
        let repeats = |j: &usize| chars[*j].to_lowercase().eq(chars[end - 1].to_lowercase());
        let rest = (end..last.1).find(|j| !repeats(j)).unwrap_or(last.1);
        first != last
            && ((letters((first.0, start)) > 0
                && letters((start, first.1)) <= 1
                && ordinary(first)
                && !after(run, head - 1))
                || (letters((rest, last.1)) >= letters((last.0, end))
                    && ordinary(last)
                    && !before(run, run.len() - tail)))
    };
    let mut todo: Vec<Vec<(usize, usize)>> = runs.into_iter().filter(|run| !joins(run)).collect();
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
        let word_end = words[piece_start].1;
        if letters((end, word_end)) > 0
            && let Some(k) = (piece_start + 1..end).rev().take(REACH).find(|&k| {
                profane(from.max(k.saturating_sub(REACH)), k)
                    && !profane(k, word_end.min(k + REACH))
            })
        {
            run[last].1 = k;
        }
        let (start, to) = (run[first], run[last].1);
        let word_start = words[start.0].0;
        if letters((word_start, start.0)) > 0
            && let Some(k) = (start.0 + 1..start.1).take(REACH).find(|&k| {
                profane(k, to.min(k + REACH))
                    && !profane(word_start.max(k.saturating_sub(REACH)), k)
            })
        {
            run[first].0 = k;
        }
        let (from, to) = (run[first].0, run[last].1);
        if reads_through_digits(&read[offsets[from]..offsets[to]], left) {
            continue;
        }
        for (start, end) in run {
            for (j, m) in masked.iter_mut().enumerate().take(end).skip(start) {
                *m = alnum(j);
            }
        }
    }
}

// What rustrict makes of `read` in one pass: the text with its matches masked, and its verdict.
fn censor(read: &str) -> (String, Type) {
    Censor::from_str(counted(read))
        .with_censor_threshold(THRESHOLD)
        .with_censor_first_character_threshold(Type::ANY)
        .with_censor_replacement('*')
        .censor_and_analyze()
}

// The letters and digits of `read` that are in a profane match, from rustrict's `censored` text;
// `None` when it masked none.
fn matches(read: &str, censored: &str, left: &Cell<usize>) -> Option<Vec<bool>> {
    if !censored.contains('*') {
        return None;
    }
    let chars: Vec<char> = read.chars().collect();
    let (mut masked, dropped) = align(&chars, censored).unwrap_or_else(|| {
        let letters = chars.iter().map(|c| c.is_alphanumeric()).collect();
        (letters, vec![false; chars.len()])
    });
    if !masked.contains(&true) {
        return None;
    }
    trim(read, &chars, &mut masked, &dropped, left);
    Some(masked)
}

fn masked(text: &str, stems: Stems) -> String {
    if skips_censor(text) {
        return text.to_owned();
    }
    let read = read_text(text, true, stems);
    let (censored, _) = censor(&read);
    let Some(masked) = matches(&read, &censored, &budget(&read)) else {
        return text.to_owned();
    };
    text.chars()
        .zip(masked)
        .map(|(c, masked)| if masked { '*' } else { c })
        .collect()
}

// Each letter or digit of a profane match becomes `*`; spaces, punctuation and everything
// else stay. The text is read the way `is_profane` reads it, so `#55` and long numbers pass, and
// a file name in a link is read as its stem.
pub fn mask(text: &str) -> String {
    masked(text, Stems::Paths)
}

// `mask` for the name of an uploaded file, read as `is_profane_file_name` reads it.
pub fn mask_file_name(name: &str) -> String {
    masked(name, Stems::Everywhere)
}

#[cfg(test)]
mod tests {
    use super::*;

    thread_local! {
        // The chars handed to rustrict.
        pub static READ: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
    }

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

    fn passes(text: &str) {
        assert_eq!(mask(text), text, "{text}");
        for links in [true, false] {
            assert!(!is_profane(text, links), "{text} links={links}");
        }
    }

    fn caught(text: &str) {
        assert_ne!(mask(text), text, "{text}");
        for links in [true, false] {
            assert!(is_profane(text, links), "{text} links={links}");
        }
    }

    // rustrict reads through any char that isn't a letter, so "p2p" was "pp". A digit between
    // the letters of a short word stands for itself or a letter it looks like, never for nothing;
    // one inserted in a longer word is still read through.
    #[test]
    fn digits_inside_a_word_are_not_read_through() {
        for text in [
            "p2p",
            "P2P",
            "a p2p attachment for the channel",
            "p2p attachment",
            "h2o",
            "H2O",
            "b2b",
            "b2c",
            "e2e",
            "f2p",
            "y2k",
            "i18n",
            "l10n",
            "a11y",
            "k8s",
            "w3c",
            "co2",
            "r2d2",
            "c3po",
            "ipv6",
            "x86",
            "utf8",
            "sha256sum",
            "base64url",
            "oauth2",
            "http2",
            "web3",
            "win32",
            "mp3s",
            "h264",
            "p2p.txt",
            "p2p-notes.md",
            "h2o levels",
        ] {
            passes(text);
        }
        for text in [
            "sh1t",
            "5h1t",
            "sh17",
            "f4ck",
            "a5s",
            "a55",
            "a555s",
            "b00b",
            "pu55y",
            "d1ck",
            "c0ck",
            "n1663r",
            "r8pe",
            "#55hole",
            "fuck2",
            "2fuck",
            "fuck 2 you",
            "fu5ck",
            "fu7ck",
            "fu2ck",
            "sh2it",
            "s9hit",
            "cu5nt",
            "a1ss",
            "c1unt",
            "tw1at",
            "di2ck",
            "co2ck",
            "wh2ore",
            "fa7ggot",
            "f1u1c1k",
            "s1h1i1t",
            "f9u9c9k",
            "you are a fu2cking idiot",
            "f2ck",
            "b2tch",
            "f8ck you",
        ] {
            caught(text);
        }
    }

    // A match can start in the last letter of a word and run into the next one ("kept.txt" was
    // "t txt", read as "tit"). Past a gap it may take only the last letter of a clean word it
    // starts in, or half or less of one it ends in. Taking more is a match ("api key" is "pikey",
    // "release.exe" is "se ex"); as file names they are read as their stems.
    #[test]
    fn a_match_takes_whole_words_across_a_gap() {
        for text in [
            "kept.txt",
            "kept txt",
            "attachment-from-alice.txt",
            "note.txt",
            "report.txt",
            "list.txt",
            "test.txt",
            "draft.txt",
            "chat.txt",
            "export.txt",
            "budget.txt",
            "transcript.txt",
            "output.txt",
            "installer.exe",
            "banana.log",
            "backbone.rs",
            "aiming.xml",
            "bin.tar",
            "meeting notes.docx",
            "see example",
            "env default",
            "open json",
            "who rchat",
            "p password",
            "push it",
        ] {
            passes(text);
        }
        for name in ["release.exe", "arena.zip", "happen.json"] {
            name_passes(name);
            caught(name);
        }
        for text in ["api key", "install in", "apple per"] {
            caught(text);
        }
        for text in [
            "this shit",
            "Is this shit good",
            "it's shit",
            "f u c k",
            "f.u.c.k off",
            "sh it",
            "sh.it",
            "kill yourself",
            "kill-yourself",
            "bad ass bitch",
            "fuck club",
            "go fuck yourself",
            "fuck.txt",
            "shit.exe",
            "kept.fuck",
        ] {
            caught(text);
        }
    }

    // A letter added before a split word doesn't make it a clean one: the match takes more than
    // the last letter of the word it starts in ("xfu ck"). Split plurals are caught too.
    #[test]
    fn padding_does_not_hide_a_split_word() {
        for text in [
            "xfu ck",
            "xfu ck you",
            "xsh it",
            "you are a xbi.tch",
            "x@fu ck",
            "u@cun.ts",
            "you are a u@cun.ts",
            "xfu.ck",
            "sh its",
            "co cks",
            "fu cks",
            "fuc ks",
            "bit ches",
            "bi tches",
            "cun ts",
            "cu nts",
            "dic ks",
            "twa ts",
            "whor es",
        ] {
            caught(text);
        }
        for text in ["it. It", "opens it. It checks"] {
            passes(text);
        }
    }

    fn name_passes(name: &str) {
        assert_eq!(mask_file_name(name), name, "{name}");
        assert!(!is_profane_file_name(name), "{name}");
    }

    // A file name is its stem and a known extension, read apart: "test.js" was "t js" and
    // "main.cpp" "cpp", both read as listed words.
    #[test]
    fn a_file_name_is_its_stem_and_a_known_extension() {
        for name in [
            "test.js",
            "test.jsx",
            "index.test.js",
            "app.test.ts",
            "text.ts",
            "but.txt",
            "bit.txt",
            "see.exe",
            "see.csv",
            "sec.csv",
            "rect.xml",
            "pill.mp3",
            "main.cpp",
            "archive.tar.gz",
            "Test.JS",
            "IMG_2041.JPG",
            "kept.txt",
            "attachment-from-alice.txt",
            "cun.ts",
            "feti.sh",
        ] {
            name_passes(name);
        }
        for (name, want) in [
            ("fuck.txt", "****.txt"),
            ("shit.cpp", "****.cpp"),
            ("fuck.tar.gz", "****.tar.gz"),
            ("my shit.js", "my ****.js"),
            ("f.u.c.k.txt", "*.*.*.*.txt"),
            ("kept.fuck", "kept.****"),
            ("fuck.test.js", "****.test.js"),
            ("sh1t.txt", "****.txt"),
        ] {
            assert_eq!(mask_file_name(name), want, "{name}");
            assert!(is_profane_file_name(name), "{name}");
        }
    }

    // The path of a link is read like a file name, in any text.
    #[test]
    fn a_link_path_reads_file_names_as_stems() {
        for text in [
            "https://example.com/test.js",
            "https://github.com/a/b/blob/main/src/index.test.js",
            "see https://x.org/main.cpp and https://x.org/but.txt",
            "https://example.com/files/sec.csv?raw=1#L10",
            "https://example.com/a/see.exe/",
            "https://x.org/text/see.exe",
            "https://x.org/src/cun.ts",
        ] {
            passes(text);
            name_passes(text);
        }
        for text in [
            "https://x.org/f/u/c/k",
            "https://example.com/go/fuck/yourself",
            "https://u@cun.ts/",
            "https://u@feti.sh/",
            "https://u:pw@hoote.rs/x",
        ] {
            caught(text);
        }
        for (text, want) in [
            (
                "https://example.com/fuck.txt",
                "https://example.com/****.txt",
            ),
            (
                "https://example.com/kept.fuck",
                "https://example.com/kept.****",
            ),
        ] {
            caught(text);
            assert_eq!(mask(text), want, "{text}");
        }
        let host = "https://fuck.sh/main.cpp";
        assert_eq!(mask(host), "https://****.sh/main.cpp");
        assert!(is_profane(host, true));
    }

    // Outside a file name and the path of a link, a known extension is read with the word before
    // it, as everywhere else.
    #[test]
    fn other_text_reads_a_name_with_its_extension() {
        for text in ["cun.ts", "you are a cun.ts", "ti.ts", "feti.sh", "c.u.n.ts"] {
            caught(text);
        }
        assert!(is_profane("https://cun.ts/", true));
        for text in [
            "kept.txt",
            "attachment-from-alice.txt",
            "note.txt",
            "p2p.txt",
        ] {
            passes(text);
        }
        assert_eq!(mask("you are a cun.ts"), "you are a ***.**");
    }

    // The strict reading reads a file name in the path of a link with its extension, like the
    // rest of the text.
    #[test]
    fn the_strict_reading_keeps_extensions_in_link_paths() {
        for text in [
            "https://x.org/src/cun.ts",
            "see https://x.org/feti.sh",
            "https://example.com/test.js",
        ] {
            for links in [true, false] {
                assert!(!is_profane(text, links), "{text} links={links}");
                assert!(is_profane_strict(text, links), "{text} links={links}");
            }
        }
        for text in [
            "a p2p attachment for the channel",
            "kept.txt",
            "https://x.org/kept.txt",
            "https://github.com/a/b/blob/main/README.md",
        ] {
            for links in [true, false] {
                assert!(!is_profane_strict(text, links), "{text} links={links}");
            }
        }
        for text in ["cun.ts", "fuck", "https://x.org/fuck", "kept.fuck"] {
            for links in [true, false] {
                assert!(is_profane_strict(text, links), "{text} links={links}");
            }
        }
        assert!(is_profane_strict("https://fuck.co/", true));
        assert!(!is_profane_strict("https://fuck.co/", false));
    }

    // The strict reading adds the whole reading to the default one: a known extension read apart
    // can join the words around it ("fu.txt ck"), so the whole reading alone misses those.
    #[test]
    fn the_strict_reading_adds_to_the_default_one() {
        let names = [
            "fu.txt ck.png",
            "f.js u.js c.js k.js",
            "sh.txt-it.txt",
            "my fu.txt ck you.pdf",
        ];
        for name in names {
            assert!(is_profane_file_name(name), "{name}");
            assert!(!profane(name, true, &[Stems::Nowhere]), "{name}");
            assert!(is_profane_file_name_strict(name), "{name}");
        }
        let links = ["https://x.org/fu.txt ck you", "see https://x.org/sh.txt it"];
        for text in links {
            for links in [true, false] {
                assert!(is_profane(text, links), "{text} links={links}");
                assert!(is_profane_strict(text, links), "{text} links={links}");
            }
        }
        for name in ["cun.ts", "test.js", "https://x.org/src/cun.ts"] {
            assert!(!is_profane_file_name(name), "{name}");
            assert!(is_profane_file_name_strict(name), "{name}");
        }
        for name in [
            "kept.txt",
            "attachment-from-alice.txt",
            "note.txt",
            "p2p.txt",
        ] {
            assert!(!is_profane_file_name_strict(name), "{name}");
        }
        for text in SAMPLES.lines().chain(names).chain(links) {
            for links in [true, false] {
                let strict = is_profane_strict(text, links);
                assert!(!is_profane(text, links) || strict, "{text} links={links}");
                assert!(
                    !profane(text, links, &[Stems::Nowhere]) || strict,
                    "{text} links={links}"
                );
            }
            let strict = is_profane_file_name_strict(text);
            assert!(!is_profane_file_name(text) || strict, "{text}");
            assert!(!profane(text, true, &[Stems::Nowhere]) || strict, "{text}");
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

    // Long words of matches ("fuck1fuck1...") were read again for every match in them: one
    // 4,000-char message took the server minutes. rustrict's cost per char varies a hundred times
    // with the text (x and 8 are the slowest), so a check hands it at most a few times the text,
    // whatever it holds.
    #[test]
    fn long_texts_are_read_a_bounded_number_of_times() {
        let mut seed: u64 = 0x2545_f491_4f6c_dd1d;
        let mut next = |n: usize| {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            (seed % n as u64) as usize
        };
        let mut mixed = String::new();
        while mixed.len() < 1000 {
            for _ in 0..1 + next(5) {
                mixed.push_str(["fuck", "shit", "cunt", "ass"][next(4)]);
            }
            mixed.push(char::from(b'0' + next(10) as u8));
        }
        const WORDS: [&str; 16] = [
            "cunt",
            "f u c k ",
            "shit",
            "a5s",
            "f1u1c1k",
            "dick",
            "kept",
            ".ts",
            "p2p",
            "tit",
            "bitch",
            "c0ck",
            "https://x.org/",
            "@",
            "/",
            "hole",
        ];
        let mut sea = |units: &[&str], every: usize| {
            let mut text = String::new();
            while text.len() < 3900 {
                text.push_str(units[next(units.len())]);
                if next(every) == 0 {
                    text.push_str(WORDS[next(WORDS.len())]);
                }
            }
            text
        };
        let eights = sea(&["xxx8", "xxx8", "xxx8", "xx8", "x"], 8);
        let xs = sea(&["xxxxxxxx"], 10);
        for (text, caught) in [
            ("f1u1c1k1".repeat(500), true),
            ("fuck1".repeat(800), true),
            (format!("{}fuck", "x1".repeat(1998)), true),
            ("a9s5 ".repeat(800), true),
            (mixed, true),
            (eights, true),
            (xs, true),
            ("p2p.js-".repeat(560), false),
        ] {
            let bound = 5 * (text.len() + REACH);
            let read = |check: &dyn Fn(&str) -> bool| {
                READ.set(0);
                assert_eq!(check(&text), caught, "{}", &text[..12]);
                assert!(READ.get() <= bound, "{} {}", &text[..12], READ.get());
            };
            read(&|t| mask(t) != t);
            read(&|t| mask_file_name(t) != t);
            read(&|t| is_profane(t, true));
            read(&|t| is_profane(t, false));
            read(&|t| is_profane_file_name(t));
            read(&|t| is_profane_strict(t, true));
            read(&|t| is_profane_strict(t, false));
            read(&|t| is_profane_file_name_strict(t));
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
            let name = mask_file_name(text);
            assert_eq!(
                name != text,
                is_profane_file_name(text),
                "{text:?} -> {name:?}"
            );
        }
    }
}
