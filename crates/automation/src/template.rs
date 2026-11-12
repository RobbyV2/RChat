//! Template rendering with inert values.

use regex::{Captures, Regex};
use serde::{Deserialize, Serialize};
use std::borrow::Cow;
use std::collections::BTreeMap;
use std::sync::LazyLock;

/// The word joiner that makes a substituted value inert.
pub const WJ: char = '\u{2060}';
pub const VALUE_MAX: usize = 100;

static BREAKS: LazyLock<Regex> =
    LazyLock::new(|| Regex::new("[\r\n\u{2028}\u{2029}]+").expect("regex"));
static WWW: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)(www)\.").expect("regex"));
static PLACEHOLDER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\{\{|\}\}|\{([A-Za-z0-9_.]+)\}").expect("regex"));
static PING: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"@([\p{L}\p{N}\p{M}_]+)").expect("regex"));
static NAME: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[\p{L}\p{N}\p{M}_]+$").expect("regex"));
static OPEN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)(?:[a-z][a-z0-9+.-]*(:)[/\\]*|/(/)[/\\]*|www(\.))[^\s/\\?#<>()\[\]"'`]*$"#)
        .expect("regex")
});

/// A substituted value that can't ping, link or break lines, nor join the text or the value
/// beside it, nor climb out of a path the text links to: a word joiner at its start and end,
/// after every `@`, `\`, `&`, `<` and `%`, between two dots, inside `://`, after `www` in every
/// `www.` and between `]` and `(` or `:`, line breaks folded to a space, and 100 characters at
/// most between the outer joiners.
pub fn inert(value: &str) -> String {
    let v = BREAKS.replace_all(value, " ");
    let v = v.replace('@', &format!("@{WJ}"));
    let v = v.replace('\\', &format!("\\{WJ}"));
    let v = v.replace('&', &format!("&{WJ}"));
    let v = v.replace('<', &format!("<{WJ}"));
    let v = v.replace('%', &format!("%{WJ}"));
    let v = v
        .replace("..", &format!(".{WJ}."))
        .replace("..", &format!(".{WJ}."));
    let v = v.replace("://", &format!(":{WJ}//"));
    let v = WWW.replace_all(&v, |c: &Captures| format!("{}{WJ}.", &c[1]));
    let v = v.replace("](", &format!("]{WJ}("));
    let v = v.replace("]:", &format!("]{WJ}:"));
    let v = match v.chars().count() > VALUE_MAX {
        true => v.chars().take(VALUE_MAX - 1).chain(['…']).collect(),
        false => v,
    };
    format!("{WJ}{v}{WJ}")
}

/// The template with a word joiner where its own text starts a link whose host a placeholder
/// would fill: before the `:` of a scheme, between the slashes of `//` or before the dot of
/// `www.`. So a value never completes a link.
fn guarded(text: &str) -> Cow<'_, str> {
    let tokens: Vec<(usize, usize, bool)> = PLACEHOLDER
        .captures_iter(text)
        .map(|c| {
            let all = c.get(0).expect("match");
            (all.start(), all.end(), c.get(1).is_some())
        })
        .collect();
    let mut at: Vec<usize> = tokens
        .iter()
        .filter(|(_, _, named)| *named)
        .filter_map(|(start, _, _)| OPEN.captures(&text[..*start]))
        .filter_map(|c| (1..=3).find_map(|g| c.get(g)).map(|m| m.start()))
        .filter(|p| !tokens.iter().any(|(s, e, _)| s < p && p < e))
        .collect();
    if at.is_empty() {
        return Cow::Borrowed(text);
    }
    at.sort_unstable();
    at.dedup();
    let mut out = String::with_capacity(text.len() + 3 * at.len());
    let mut last = 0;
    for p in at {
        out.push_str(&text[last..p]);
        out.push(WJ);
        last = p;
    }
    out.push_str(&text[last..]);
    Cow::Owned(out)
}

/// What a template is rendered with: the member's username and display name, the other values
/// by placeholder name (`args.note`, `server`, `count`, ...), and whether `{member.mention}`
/// pings.
#[derive(Clone, PartialEq, Eq, Debug, Default, Serialize, Deserialize)]
pub struct Vars {
    pub name: String,
    pub display: String,
    pub values: BTreeMap<String, String>,
    pub ping: bool,
}

/// Whether `@name` mentions this username and nothing else, as the server reads mentions: only
/// word characters (letters, marks, digits, `_`), so no shorter name is read in it, and not
/// `everyone` or `here`.
fn plain(name: &str) -> bool {
    let lower = name.to_lowercase();
    NAME.is_match(name) && lower != "everyone" && lower != "here"
}

fn value(name: &str, v: &Vars) -> Option<String> {
    match name {
        "member.mention" if v.ping && plain(&v.name) => {
            Some(format!("@{}{WJ}", v.name.to_lowercase()))
        }
        "member.mention" | "member" => Some(inert(&v.display)),
        "member.name" => Some(inert(&v.name)),
        _ => v.values.get(name).map(|s| inert(s)),
    }
}

fn piece(c: &Captures, v: &Vars) -> String {
    match (&c[0], c.get(1)) {
        ("{{", _) => "{".to_string(),
        ("}}", _) => "}".to_string(),
        (all, name) => name
            .and_then(|n| value(n.as_str(), v))
            .unwrap_or_else(|| all.to_string()),
    }
}

/// Renders `{name}` placeholders. Only `{member.mention}` can ping, and only with `ping` and a
/// username of word characters that is not `everyone` or `here` (else it renders like
/// `{member}`): lowercased, as the server stores usernames, and followed by a word joiner, so
/// the text after it never extends the name or changes its lowercase. Every other value is
/// inert, and no value completes a link the text starts. `{{` and `}}` are literal braces;
/// unknown names stay as typed.
pub fn render(text: &str, v: &Vars) -> String {
    PLACEHOLDER
        .replace_all(&guarded(text), |c: &Captures| piece(c, v))
        .into_owned()
}

/// Whether the text holds a `{name}` placeholder. `{{` and `}}` are literal braces.
pub fn templated(text: &str) -> bool {
    PLACEHOLDER.captures_iter(text).any(|c| c.get(1).is_some())
}

/// The word after every `@` of the rendered text, lowercased: the names of word characters it
/// may ping, `everyone` and `here` among them.
pub fn pings(text: &str) -> Vec<String> {
    PING.captures_iter(text)
        .map(|c| c[1].to_lowercase())
        .collect()
}

/// Whether the rendered text holds a link, as `links::find` reads it.
pub fn links(text: &str) -> bool {
    !crate::links::find(text).is_empty()
}

/// Where a value from `Vars::values` landed in the rendered text, in UTF-16 code units.
#[derive(Clone, PartialEq, Eq, Debug, Serialize, Deserialize)]
pub struct Span {
    pub start: usize,
    pub end: usize,
    pub arg: String,
}

#[derive(Clone, PartialEq, Eq, Debug, Serialize, Deserialize)]
pub struct Rendered {
    pub text: String,
    pub spans: Vec<Span>,
}

/// `render`, with the span of every substituted value, so a client can hide exactly the spans
/// of the arguments it keeps hidden.
pub fn render_spans(text: &str, v: &Vars) -> Rendered {
    let text = &*guarded(text);
    let mut out = String::new();
    let mut units = 0;
    let mut spans = Vec::new();
    let mut last = 0;
    for c in PLACEHOLDER.captures_iter(text) {
        let all = c.get(0).expect("match");
        let before = &text[last..all.start()];
        units += before.encode_utf16().count();
        out.push_str(before);
        last = all.end();
        let piece = piece(&c, v);
        let len = piece.encode_utf16().count();
        if let Some(name) = c.get(1).filter(|n| v.values.contains_key(n.as_str())) {
            spans.push(Span {
                start: units,
                end: units + len,
                arg: name.as_str().to_string(),
            });
        }
        units += len;
        out.push_str(&piece);
    }
    out.push_str(&text[last..]);
    Rendered { text: out, spans }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vars(display: &str, values: &[(&str, &str)], ping: bool) -> Vars {
        Vars {
            name: "bob".into(),
            display: display.into(),
            values: values
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
            ping,
        }
    }

    fn r(text: &str, display: &str, values: &[(&str, &str)], ping: bool) -> String {
        render(text, &vars(display, values, ping))
    }

    #[test]
    fn a_display_name_of_everyone_never_pings() {
        let out = r("Welcome {member}!", "@everyone", &[], true);
        assert!(pings(&out).is_empty());
        assert_eq!(out, format!("Welcome {WJ}@{WJ}everyone{WJ}!"));
    }

    #[test]
    fn a_value_never_joins_the_text_or_the_value_beside_it() {
        let v = vars(
            "here",
            &[
                ("args.who", "everyone"),
                ("args.a", "https:"),
                ("args.b", "//evil.example/x"),
                ("args.c", "www"),
                ("args.d", ".evil.example"),
                ("args.e", "&"),
            ],
            true,
        );
        for text in [
            "Thanks @{args.who}",
            "Welcome @{member}!",
            "{args.a}{args.b}",
            "{args.a}//evil.example",
            "https:{args.b}",
            "{args.c}{args.d}",
            "{args.c}.evil.example",
            "{args.e}#58;",
        ] {
            let out = render(text, &v);
            assert!(pings(&out).is_empty(), "{text}: {out}");
            assert!(!links(&out), "{text}: {out}");
        }
        assert_eq!(render("{args.e}", &v), format!("{WJ}&{WJ}{WJ}"));
    }

    #[test]
    fn escapes_and_references_in_a_value_stay_text() {
        for note in [
            r"www\.phish.example",
            r"https:\/\/phish.example/x",
            "https&#58;//phish.example/x",
            "www&#46;phish.example",
            r"[x](https\://phish.example)",
            "&#64;everyone",
            r"\@everyone",
        ] {
            let out = r(
                "Thanks sent: {args.note}",
                "Bob",
                &[("args.note", note)],
                false,
            );
            assert!(!links(&out), "{note}: {out}");
            assert!(
                pings(&crate::links::decode(&out)).is_empty(),
                "{note}: {out}"
            );
        }
        assert_eq!(inert(r"a\b&c"), format!("{WJ}a\\{WJ}b&{WJ}c{WJ}"));
    }

    #[test]
    fn a_value_never_completes_a_link_the_text_starts() {
        let v = vars(
            "Bob",
            &[("args.d", "evil.example"), ("args.p", "docs/x")],
            false,
        );
        for text in [
            "see https://{args.d}",
            "see HTTPS://{args.d}/x",
            "see rchat://{args.d}/invite/x",
            "see www.{args.d}",
            "see https://paypal.{args.d}",
            "see www.paypal{args.d}",
            "<https:{args.d}>",
            "[x](https:{args.d})",
            "[x](//{args.d})",
            r"[x](https:\\{args.d})",
            "[x](<https://{args.d}>)",
            "[x][1]\n\n[1]: https://{args.d}",
        ] {
            let out = render(text, &v);
            assert!(!links(&out), "{text}: {out}");
        }
        for (text, host) in [
            ("see https://docs.example/{args.p}", "docs.example"),
            ("see https://docs.example?q={args.d}", "docs.example"),
            ("Note: https://a.example {args.d}", "a.example"),
        ] {
            let out = render(text, &v);
            let found = crate::links::find(&out);
            assert_eq!(found.len(), 1, "{text}: {out}");
            assert_eq!(found[0].host, host, "{text}: {out}");
        }
        assert_eq!(
            render("Time:{args.d}", &v),
            format!("Time{WJ}:{WJ}evil.example{WJ}")
        );
        assert_eq!(
            render("see https://{args.d}", &v),
            format!("see https{WJ}://{WJ}evil.example{WJ}")
        );
        let spans = render_spans("see https://{args.d} now", &v);
        let units: Vec<u16> = spans.text.encode_utf16().collect();
        let sp = &spans.spans[0];
        assert_eq!(
            String::from_utf16(&units[sp.start..sp.end]).expect("utf16"),
            inert("evil.example")
        );
    }

    #[test]
    fn an_argument_with_here_a_link_and_a_markdown_link_posts_inert() {
        let out = r(
            "Thanks sent: {args.note}",
            "Bob",
            &[(
                "args.note",
                "@here free nitro https://phish.example [x](http://a.b)",
            )],
            false,
        );
        assert!(pings(&out).is_empty());
        assert!(!links(&out));
        assert!(out.contains("]\u{2060}("));
    }

    #[test]
    fn www_links_and_newlines_are_neutralised() {
        let out = r(
            "{args.a}",
            "Bob",
            &[("args.a", "see www.evil.example\n# Heading")],
            false,
        );
        assert!(!links(&out));
        assert!(!out.contains('\n'));
        assert_eq!(
            inert("a\r\n\u{2028}\u{2029}b WWW.x.y awww.x.y"),
            "\u{2060}a b WWW\u{2060}.x.y awww\u{2060}.x.y\u{2060}"
        );
    }

    #[test]
    fn only_member_mention_with_ping_pings_and_literal_text_keeps_its_own_mentions() {
        assert_eq!(pings(&r("Hi {member.mention}", "Bob", &[], true)), ["bob"]);
        assert!(pings(&r("Hi {member.mention}", "Bob", &[], false)).is_empty());
        assert_eq!(
            pings(&r("@everyone a new member: {member}", "Bob", &[], true)),
            ["everyone"]
        );
        assert_eq!(r("{member.name}", "Bob", &[], true), format!("{WJ}bob{WJ}"));
    }

    #[test]
    fn values_are_cut_at_100_characters_and_braces_and_unknown_names_stay() {
        let cut = inert(&"x".repeat(150));
        assert_eq!(cut.chars().count(), 102);
        assert!(cut.ends_with(&format!("…{WJ}")));
        assert_eq!(inert(&"x".repeat(100)).chars().count(), 102);
        assert!(!inert(&"x".repeat(100)).contains('…'));
        assert_eq!(
            r("{{literal}} {unknown}", "Bob", &[], false),
            "{literal} {unknown}"
        );
        assert_eq!(
            r("{ARGS.A} {args.a}", "Bob", &[("args.a", "v")], false),
            format!("{{ARGS.A}} {WJ}v{WJ}")
        );
    }

    #[test]
    fn spans_cover_the_inert_value_exactly_after_word_joiners_and_the_cut() {
        let code = format!("@X7Q-993-ALPHA https://a.b {}", "z".repeat(120));
        let v = vars("Bob", &[("args.code", &code)], false);
        let got = render_spans("Linked with {args.code}. Done.", &v);
        assert_eq!(got.spans.len(), 1);
        let sp = &got.spans[0];
        let units: Vec<u16> = got.text.encode_utf16().collect();
        let piece = String::from_utf16(&units[sp.start..sp.end]).expect("utf16");
        assert_eq!(piece, inert(&code));
        assert_eq!(sp.arg, "args.code");
        assert!(got.text.starts_with("Linked with "));
        assert!(got.text.ends_with(". Done."));
    }

    #[test]
    fn spans_count_utf16_units_and_skip_member_placeholders() {
        let v = vars("Bob 😀", &[("args.a", "x😀"), ("args.b", "y")], false);
        let got = render_spans("😀 {member} {args.a}{{}} {args.b} {nope}", &v);
        assert_eq!(
            got.text,
            format!("😀 {WJ}Bob 😀{WJ} {WJ}x😀{WJ}{{}} {WJ}y{WJ} {{nope}}")
        );
        assert_eq!(
            got.spans,
            [
                Span {
                    start: 12,
                    end: 17,
                    arg: "args.a".into()
                },
                Span {
                    start: 20,
                    end: 23,
                    arg: "args.b".into()
                },
            ]
        );
        assert_eq!(
            got.text,
            render("😀 {member} {args.a}{{}} {args.b} {nope}", &v)
        );
    }

    #[test]
    fn a_value_makes_no_autolink_and_no_www_link_whatever_stands_before_it() {
        for (text, value, out) in [
            (
                "Welcome {member}!",
                "<http:evil.example>",
                format!("Welcome {WJ}<{WJ}http:evil.example>{WJ}!"),
            ),
            (
                "{args.x}",
                "<HTTP:evil.example>",
                format!("{WJ}<{WJ}HTTP:evil.example>{WJ}"),
            ),
            (
                "Note: {args.x}",
                "<https:evil.example/x>",
                format!("Note: {WJ}<{WJ}https:evil.example/x>{WJ}"),
            ),
            (
                "{args.x}",
                "see <http:evil.example/a> now",
                format!("{WJ}see <{WJ}http:evil.example/a> now{WJ}"),
            ),
            (
                "{args.x}",
                "_www.evil.example",
                format!("{WJ}_www{WJ}.evil.example{WJ}"),
            ),
            (
                "{member}",
                "x_www.evil.example",
                format!("{WJ}x_www{WJ}.evil.example{WJ}"),
            ),
            (
                "{args.x}",
                "<mailto:a@evil.example>",
                format!("{WJ}<{WJ}mailto:a@{WJ}evil.example>{WJ}"),
            ),
            (
                "{args.x}",
                "[1]: //evil.example",
                format!("{WJ}[1]{WJ}: //evil.example{WJ}"),
            ),
        ] {
            let got = r(text, value, &[("args.x", value)], false);
            assert_eq!(got, out, "{text} {value}");
            assert!(!links(&got), "{text} {value}");
        }
        for text in ["see _www.{args.x}", "see x_www.{args.x}", "(www.{args.x})"] {
            let out = r(text, "Bob", &[("args.x", "evil.example")], false);
            assert!(out.contains(&format!("www{WJ}.")), "{text}: {out}");
            assert!(!links(&out), "{text}: {out}");
        }
    }

    #[test]
    fn a_value_in_a_link_of_the_text_never_climbs_to_another_path() {
        for (value, out) in [
            (
                "../../invite/lobby",
                format!("[x]({WJ}.{WJ}./.{WJ}./invite/lobby{WJ})"),
            ),
            (
                "x/../../invite/lobby/?",
                format!("[x]({WJ}x/.{WJ}./.{WJ}./invite/lobby/?{WJ})"),
            ),
            (
                "%2e%2e/%2E%2E/invite/lobby",
                format!("[x]({WJ}%{WJ}2e%{WJ}2e/%{WJ}2E%{WJ}2E/invite/lobby{WJ})"),
            ),
        ] {
            let got = r("[x]({args.x})", "Bob", &[("args.x", value)], false);
            assert_eq!(got, out, "{value}");
            assert!(!links(&got), "{value}");
            let deep = r("[x](/s/1/{args.x})", "Bob", &[("args.x", value)], false);
            assert!(!links(&deep), "{value}: {deep}");
        }
        assert_eq!(inert("a...b"), format!("{WJ}a.{WJ}.{WJ}.b{WJ}"));
        assert_eq!(inert("...."), format!("{WJ}.{WJ}.{WJ}.{WJ}.{WJ}"));
        assert_eq!(inert("50% off"), format!("{WJ}50%{WJ} off{WJ}"));
    }

    static WORD: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"^[\p{L}\p{N}\p{M}_]$").expect("regex"));

    fn is_word(c: char) -> bool {
        WORD.is_match(c.encode_utf8(&mut [0u8; 4]))
    }

    /// The names the server reads as mentions: `mention_candidates` of
    /// `apps/server/src/api/pings.rs`, without its code masking.
    fn candidates(content: &str) -> Vec<String> {
        let text: Vec<char> = content.to_lowercase().chars().collect();
        let mut out: Vec<String> = Vec::new();
        for (at, c) in text.iter().enumerate() {
            if *c != '@' || (at > 0 && is_word(text[at - 1])) {
                continue;
            }
            let mut end = at + 1;
            while end < text.len() && end - at <= 100 && text[end] != '@' && text[end] != '\n' {
                let next = text.get(end + 1);
                if !next.is_some_and(|n| is_word(*n)) && !text[end].is_whitespace() {
                    let name: String = text[at + 1..=end].iter().collect();
                    if !out.contains(&name) {
                        out.push(name);
                    }
                }
                end += 1;
            }
        }
        out
    }

    fn mention(text: &str, name: &str) -> String {
        let v = Vars {
            name: name.into(),
            display: "Bob".into(),
            values: BTreeMap::new(),
            ping: true,
        };
        render(text, &v)
    }

    #[test]
    fn a_mention_pings_only_a_username_of_word_characters_and_never_everyone_or_here() {
        for name in [
            "everyone",
            "here",
            "Everyone",
            "HERE",
            "eVeRyOnE",
            "here-x",
            "Everyone.",
            "here we go",
            "here.now",
            "HERE x",
            "everyone-fan",
            "alice x",
            "moderators team",
            "b.o-b",
            "Bob Smith",
            "https://evil.example/x",
            "bob [x](https://evil.example)",
            "www.evil.example",
            "bob <http:evil.example>",
            "bob\n# Heading",
            r"bob\_",
            "a&#58;b",
            "bob`x`",
            "bob\u{2060}",
            "",
        ] {
            let out = mention("Welcome, {member.mention}!", name);
            assert_eq!(out, format!("Welcome, {WJ}Bob{WJ}!"), "{name}");
            assert!(candidates(&out).is_empty(), "{name}");
            assert!(pings(&out).is_empty(), "{name}");
        }
        for name in [
            "bob",
            "everyones",
            "heres",
            "bob_smith",
            "zoë",
            "ali3",
            "Bob",
            "e\u{301}",
            "日本",
            "_",
            "ΣΣ",
            "ΑΣ",
            "İx",
        ] {
            let key = name.to_lowercase();
            assert_eq!(
                mention("{member.mention}", name),
                format!("@{key}{WJ}"),
                "{name}"
            );
            for text in ["Welcome, {member.mention}! Say hi.", "{member.mention}one"] {
                let got = candidates(&mention(text, name));
                assert_eq!(got[0], key, "{name}");
                assert!(got[1..].iter().all(|c| c.contains(WJ)), "{name}: {got:?}");
            }
        }
        for (text, name) in [
            ("{member.mention}one", "every"),
            ("{member.mention}s", "bob"),
            ("{member.mention}_x", "here"),
            ("{member.mention}.example.com", "bob"),
            ("{member.mention}{member.mention}", "bob"),
        ] {
            let got = candidates(&mention(text, name));
            assert!(
                got.iter().all(|c| c == name || c.contains(WJ)),
                "{text} {name}: {got:?}"
            );
            assert!(!links(&mention(text, name)), "{text} {name}");
        }
    }

    #[test]
    fn pings_reads_the_word_after_every_at_sign_as_the_server_does() {
        assert_eq!(
            pings(&format!(
                "Hi @Zoë{WJ}! @here-x @Everyone. x@here @e\u{301}x @{WJ}bob"
            )),
            ["zoë", "here", "everyone", "here", "e\u{301}x"]
        );
        assert_eq!(pings("@everyoneé @here_x"), ["everyoneé", "here_x"]);
    }

    #[test]
    fn a_username_of_word_characters_stays_one_in_the_servers_lowercase() {
        let changed = (0..=0x10FFFFu32)
            .filter_map(char::from_u32)
            .filter(|&c| is_word(c) && c.to_lowercase().ne([c]))
            .inspect(|c| assert!(c.to_lowercase().all(is_word), "{c:?}"))
            .inspect(|c| {
                let low = format!("x{}{WJ}o", c.to_lowercase());
                assert_eq!(low.to_lowercase(), low, "{c:?}");
            })
            .count();
        assert!(changed > 1_000, "{changed}");
    }

    #[test]
    fn no_link_spelling_in_a_value_links_in_any_vector_template() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/vectors/templates.json");
        let doc: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(path).expect("vectors")).expect("json");
        let mut texts: Vec<String> = doc["cases"]
            .as_array()
            .expect("cases")
            .iter()
            .filter_map(|c| c["text"].as_str().map(str::to_string))
            .collect();
        texts.extend(
            [
                "{v}",
                "{v}{v}",
                "Welcome {member}!",
                "{member} left.",
                "Welcome, {member.mention}!",
                "<{v}>",
                "<http:{v}>",
                "<{v}:{v}>",
                "https://{v}",
                "{v}://{v}",
                "irc://{v}",
                "[x](irc:{v})",
                "www.{v}",
                "_www.{v}",
                "x_www.{v}",
                "[x]({v})",
                "[x](/s/1/{v})",
                "[x](<{v}>)",
                "[{v}]({v})",
                "@{v}",
                "[x][1]\n\n[1]: {v}",
                "[x][1]\n\n[1]:\n{v}",
                "[x][1]\n\n{v}",
                "> {v}",
                "- {v}",
                "{member.mention}s",
                "{member.mention}one",
                "@{member.mention}",
                "x{member.mention}",
                "{member.mention}{member.mention}",
                "Hi {member.mention} and @alice",
            ]
            .map(str::to_string),
        );
        let spellings = [
            "https://evil.example/x",
            "http:evil.example",
            "<http:evil.example>",
            "<HTTP:evil.example>",
            "<http:/evil.example>",
            "<https:evil.example/x>",
            "see <http:evil.example/a> now",
            "<mailto:a@evil.example>",
            "<a@evil.example>",
            "www.evil.example",
            "WWW.evil.example",
            "_www.evil.example",
            "x_www.evil.example",
            "-www.evil.example",
            "(www.evil.example)",
            "[x](https://evil.example)",
            "[x](//evil.example)",
            "[x](http:evil.example)",
            "![x](https://evil.example/p.png)",
            "[1]: //evil.example",
            "[1]:\n//evil.example",
            r"https\://evil.example",
            "https&#58;//evil.example",
            "www&#46;evil.example",
            r"[x](https\://evil.example)",
            "rchat://evil.example/invite/x",
            "ircs://evil.example",
            "[x](irc:evil.example)",
            "<irc://evil.example>",
            "/invite/lobby",
            "../../invite/lobby",
            "x/../../../../invite/lobby/?",
            "%2e%2e/%2e%2e/invite/lobby",
            "//evil.example",
            "evil.example",
            "https:",
            "http",
            "www",
            ".evil.example",
            "<",
            "]",
            "](",
            "]:",
            "everyone",
            "here",
            "here-x",
            "Everyone.",
            "here we go",
            "here.now",
            "HERE x",
            "everyone-fan",
            "alice x",
            "moderators team",
            "every",
            "bob",
        ];
        let neutral = |t: &str| {
            let v = Vars {
                name: "bob".into(),
                display: "Bob".into(),
                values: BTreeMap::from([
                    ("v".to_string(), "x".to_string()),
                    ("args.note".to_string(), "x".to_string()),
                ]),
                ping: false,
            };
            render(t, &v)
        };
        let mut checked = 0;
        for text in &texts {
            let base = neutral(text);
            let own: Vec<(String, bool)> = crate::links::find(&base)
                .into_iter()
                .map(|l| (l.host, l.invite))
                .collect();
            let own_names = candidates(&base);
            for value in spellings {
                for ping in [false, true] {
                    let v = Vars {
                        name: value.into(),
                        display: value.into(),
                        values: [
                            "v",
                            "args.note",
                            "args.a",
                            "args.b",
                            "args.code",
                            "args.who",
                        ]
                        .iter()
                        .map(|k| (k.to_string(), value.to_string()))
                        .collect(),
                        ping,
                    };
                    let out = render(text, &v);
                    for link in crate::links::find(&out) {
                        assert!(
                            own.contains(&(link.host.clone(), link.invite)),
                            "{text:?} with {value:?}: {out:?} links {link:?}"
                        );
                    }
                    for name in candidates(&out).into_iter().filter(|c| !c.contains(WJ)) {
                        let member = ping
                            && name == value.to_lowercase()
                            && name != "everyone"
                            && name != "here";
                        assert!(
                            own_names.contains(&name) || member,
                            "{text:?} with {value:?}: {out:?} mentions {name:?}"
                        );
                    }
                    checked += 1;
                }
            }
        }
        assert!(checked > 2_000, "{checked}");
    }

    #[test]
    fn links_sees_schemes_and_www() {
        assert!(links("see https://a.b"));
        assert!(links("see www.a.b"));
        assert!(links("see WWW.a.b"));
        assert!(!links("see awww.a.b"));
        assert!(!links("https:\u{2060}//a.b www\u{2060}.a.b"));
    }
}
