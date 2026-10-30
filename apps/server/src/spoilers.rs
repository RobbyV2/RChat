//! `||spoilers||` in message markdown, read exactly like the web client
//! (`apps/web/app/lib/spoilers.ts`); both test suites check the same fixture. `||` opens and
//! the next `||` closes; an empty pair and an unclosed `||` are text; code (fenced, indented and
//! inline) never holds markers; `\|` is a literal pipe; a spoiler may span lines but never a
//! blank line or a code block.

/// One spoiler, as byte offsets into the text.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Span {
    /// Where the opening `||` starts.
    pub start: usize,
    /// Just after the closing `||`, or the text's end for a spoiler cut off by an excerpt.
    pub end: usize,
    /// It has its closing `||`.
    pub closed: bool,
}

/// Fence marker run and the rest of the line, like the client's
/// `^(?: {0,3}>)* {0,3}(`{3,}|~{3,})(.*)$`.
fn fence(line: &str) -> Option<(u8, usize, &str)> {
    let bytes = line.as_bytes();
    let mut i = 0;
    loop {
        let spaces = bytes[i..].iter().take_while(|&&b| b == b' ').count();
        if spaces > 3 {
            return None;
        }
        i += spaces;
        match bytes.get(i) {
            Some(b'>') => i += 1,
            Some(&c @ (b'`' | b'~')) => {
                let n = bytes[i..].iter().take_while(|&&b| b == c).count();
                let rest = &line[i + n..];
                let ends = rest.contains(['\r', '\u{2028}', '\u{2029}']);
                return (n >= 3 && !ends).then_some((c, n, rest));
            }
            _ => return None,
        }
    }
}

fn list_item(line: &str) -> bool {
    let bytes = line.as_bytes();
    let spaces = bytes.iter().take_while(|&&b| b == b' ').count();
    if spaces > 3 {
        return false;
    }
    let rest = &bytes[spaces..];
    let after = match rest.first() {
        Some(b'-' | b'+' | b'*') => 1,
        Some(b) if b.is_ascii_digit() => {
            let digits = rest.iter().take_while(|b| b.is_ascii_digit()).count();
            match (digits <= 9, rest.get(digits)) {
                (true, Some(b'.' | b')')) => digits + 1,
                _ => return false,
            }
        }
        _ => return false,
    };
    line[spaces + after..].chars().next().is_none_or(js_space)
}

/// JavaScript's `\s`: Unicode White_Space without U+0085 (next line), plus U+FEFF.
fn js_space(c: char) -> bool {
    (c.is_whitespace() && c as u32 != 0x85) || c == '\u{feff}'
}

/// Stretches of text between blank lines and code blocks, as byte ranges.
fn text_runs(text: &str) -> Vec<(usize, usize)> {
    let mut runs = Vec::new();
    let mut fenced: Option<(u8, usize)> = None;
    let mut indented = false;
    let mut list = false;
    let mut blank = true;
    let mut run: Option<(usize, usize)> = None;
    let mut at = 0;
    for line in text.split('\n') {
        let from = at;
        at += line.len() + 1;
        let open = fence(line);
        if let Some((c, n)) = fenced {
            if let Some((mark, len, rest)) = open
                && mark == c
                && len >= n
                && rest.trim_matches(js_space).is_empty()
            {
                fenced = None;
                blank = true;
            }
            continue;
        }
        if let Some((mark, len, rest)) = open
            && !(mark == b'`' && rest.contains('`'))
        {
            runs.extend(run.take());
            fenced = Some((mark, len));
            indented = false;
            continue;
        }
        if line.chars().all(|c| js_space(c) || c == '>') {
            runs.extend(run.take());
            blank = true;
            continue;
        }
        let deep = line.starts_with("    ") || line.starts_with('\t');
        let code = deep && !list && (blank || indented);
        if !deep {
            list = list_item(line) || (list && !blank);
        }
        indented = code;
        blank = false;
        if code {
            runs.extend(run.take());
            continue;
        }
        run = Some((run.map_or(from, |(start, _)| start), from + line.len()));
    }
    runs.extend(run);
    runs
}

fn ticks(bytes: &[u8], at: usize, end: usize) -> usize {
    bytes[at..end].iter().take_while(|&&b| b == b'`').count()
}

/// The `||` markers of one run, outside inline code and escapes.
fn markers(text: &str, (start, end): (usize, usize)) -> Vec<usize> {
    let bytes = text.as_bytes();
    let mut out = Vec::new();
    let mut i = start;
    while i < end {
        match bytes[i] {
            b'\\' if i + 1 < end && bytes[i + 1].is_ascii_punctuation() => i += 2,
            b'`' => {
                let n = ticks(bytes, i, end);
                let mut j = i + n;
                let mut close = None;
                while j < end {
                    if bytes[j] != b'`' {
                        j += 1;
                        continue;
                    }
                    let m = ticks(bytes, j, end);
                    if m == n {
                        close = Some(j);
                        break;
                    }
                    j += m;
                }
                i = close.map_or(i + n, |c| c + n);
            }
            b'|' if i + 1 < end && bytes[i + 1] == b'|' => {
                out.push(i);
                i += 2;
            }
            _ => i += 1,
        }
    }
    out
}

/// Spoilers of `text`. `cut`: the text is an excerpt, so an unclosed `||` at the end hides the
/// rest.
pub fn spans(text: &str, cut: bool) -> Vec<Span> {
    if !text.contains("||") {
        return Vec::new();
    }
    let runs = text_runs(text);
    let mut out = Vec::new();
    for (r, &run) in runs.iter().enumerate() {
        let mut open: Option<usize> = None;
        for at in markers(text, run) {
            open = match open {
                None => Some(at),
                Some(o) if at == o + 2 => Some(at),
                Some(o) => {
                    out.push(Span {
                        start: o,
                        end: at + 2,
                        closed: true,
                    });
                    None
                }
            };
        }
        if let Some(o) = open
            && cut
            && r + 1 == runs.len()
        {
            out.push(Span {
                start: o,
                end: text.len(),
                closed: false,
            });
        }
    }
    out
}

/// `text` split into spoiler (`true`) and plain parts, markers removed.
pub fn parts(text: &str, cut: bool) -> Vec<(&str, bool)> {
    let mut out = Vec::new();
    let mut at = 0;
    for Span { start, end, closed } in spans(text, cut) {
        if start > at {
            out.push((&text[at..start], false));
        }
        let inner = &text[start + 2..if closed { end - 2 } else { end }];
        if !inner.is_empty() {
            out.push((inner, true));
        }
        at = end;
    }
    if at < text.len() {
        out.push((&text[at..], false));
    }
    out
}

/// Whether the byte range `from..to` touches a spoiler, markers included.
pub fn overlaps(spans: &[Span], from: usize, to: usize) -> bool {
    spans.iter().any(|s| from < s.end && to > s.start)
}

/// Opens a spoiler in `marked` text.
pub const OPEN: char = '\u{E000}';
/// Closes a spoiler in `marked` text.
pub const CLOSE: char = '\u{E001}';

/// `text` with each spoiler's markers replaced by [`OPEN`] and [`CLOSE`], so later steps can
/// tell them from literal pipes.
pub fn marked(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut at = 0;
    for Span { start, end, closed } in spans(text, false) {
        out.push_str(&text[at..start]);
        out.push(OPEN);
        out.push_str(&text[start + 2..if closed { end - 2 } else { end }]);
        out.push(CLOSE);
        at = end;
    }
    out.push_str(&text[at..]);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE: &str = "../web/app/lib/__tests__/fixtures/spoilers.json";

    fn fixture() -> serde_json::Value {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(FIXTURE);
        serde_json::from_str(&std::fs::read_to_string(path).expect("fixture")).expect("json")
    }

    #[test]
    fn reads_spoilers_like_the_client() {
        let doc = fixture();
        let cases = doc["spoilers"].as_array().expect("spoilers");
        assert!(cases.len() > 20);
        for case in cases {
            let text = case["text"].as_str().expect("text");
            let cut = case["cut"].as_bool().unwrap_or(false);
            let want: Vec<(String, bool)> = case["parts"]
                .as_array()
                .expect("parts")
                .iter()
                .map(|p| {
                    (
                        p[0].as_str().expect("part").to_string(),
                        p[1].as_bool().expect("flag"),
                    )
                })
                .collect();
            let got: Vec<(String, bool)> = parts(text, cut)
                .into_iter()
                .map(|(t, s)| (t.to_string(), s))
                .collect();
            assert_eq!(got, want, "{text:?}");
        }
    }

    #[test]
    fn previews_skip_spoilered_links() {
        let doc = fixture();
        let cases = doc["links"].as_array().expect("links");
        assert!(cases.len() > 10);
        for case in cases {
            let text = case["text"].as_str().expect("text");
            let want: Vec<&str> = case["urls"]
                .as_array()
                .expect("urls")
                .iter()
                .map(|u| u.as_str().expect("url"))
                .collect();
            assert_eq!(crate::api::embeds::extract_urls(text), want, "{text:?}");
        }
    }

    #[test]
    fn marked_keeps_literal_pipes() {
        assert_eq!(marked("a ||b|| \\|| c"), "a \u{E000}b\u{E001} \\|| c");
        assert_eq!(marked("`||` ||x"), "`||` ||x");
    }
}
