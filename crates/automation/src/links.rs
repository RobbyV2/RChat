//! Links in a message: the ones the client makes clickable, with their hosts as a browser
//! resolves them, and the domain rules of the `links` condition.

use crate::entities::NAMED;
use crate::model::LinkMode;
use regex::Regex;
use std::borrow::Cow;
use std::collections::BTreeMap;
use std::sync::LazyLock;
use url::{Host, Url};

/// A link as posted, or as the client shows the text. `host` is the host a browser would go to, in lowercase ASCII (punycode for
/// other scripts), or empty when it can't be read. `invite` marks an invite to a server.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Link {
    pub url: String,
    pub host: String,
    pub invite: bool,
}

static ABSOLUTE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"(?i)(?:https?|rchat|ircs?)://[^\s<>"'`]+"#).expect("regex"));
static WWW: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"(?i)(?:^|[^A-Za-z0-9])(www\.[^\s<>"'`]+)"#).expect("regex"));
static INLINE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\]\(\s*<?([^\s<>)]+)").expect("regex"));
static AUTOLINK: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"<([A-Za-z][A-Za-z0-9+.-]*:[^\s<>]+)>").expect("regex"));
static REFERENCE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\]:[ \t]*(?:(?:\r\n|\r|\n)[ \t>]*)?<?([^\s<>]+)").expect("regex")
});
static EMAIL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"<([A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*)>",
    )
    .expect("regex")
});
const TRAIL: [char; 17] = [
    ')', ']', '}', '>', '.', ',', ';', ':', '!', '?', '*', '_', '~', '|', '\'', '"', '`',
];

/// Every link of a message: `http://`, `https://`, `rchat://`, `irc://` and `ircs://` addresses
/// wherever they stand, bare `www.` addresses after anything but a letter or digit, bare email
/// addresses, and the destinations of markdown links, which are links even without the slashes
/// (`[x](https:host)`, `[x](irc:host)`, `[x](//host)`), `mailto:` and `xmpp:` ones among them.
/// The host of a mail or chat address is the domain after its `@`.
/// Every `]:` starts a reference definition, whatever stands before it (a list item, a block
/// quote, a label over several lines), with its destination on the same line or the next. The links of the text as posted come
/// first, in text order, then those to other hosts that only the decoded text shows
/// (`https\://host`, `https&#58;//host`).
pub fn find(text: &str) -> Vec<Link> {
    let mut out = find_in(text);
    if let Cow::Owned(shown) = decode(text)
        && shown != text
    {
        for link in find_in(&shown) {
            if !out
                .iter()
                .any(|l| l.host == link.host && l.invite == link.invite)
            {
                out.push(link);
            }
        }
    }
    out
}

/// The text as markdown shows it: backslash escapes of ASCII punctuation and character
/// references (named, decimal and hex) decoded the way CommonMark decodes them.
pub fn decode(text: &str) -> Cow<'_, str> {
    if !text.contains(['\\', '&']) {
        return Cow::Borrowed(text);
    }
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(i) = rest.find(['\\', '&']) {
        out.push_str(&rest[..i]);
        let tail = &rest[i..];
        let used = match tail.as_bytes() {
            [b'\\', p, ..] if p.is_ascii_punctuation() => {
                out.push(char::from(*p));
                2
            }
            [b'&', ..] => reference(tail, &mut out).unwrap_or_else(|| {
                out.push('&');
                1
            }),
            _ => {
                out.push('\\');
                1
            }
        };
        rest = &tail[used..];
    }
    out.push_str(rest);
    Cow::Owned(out)
}

/// The character reference at the start of `tail`, written to `out`, and its length.
fn reference(tail: &str, out: &mut String) -> Option<usize> {
    let b = tail.as_bytes();
    if b.get(1) == Some(&b'#') {
        let (radix, start, max) = match b.get(2) {
            Some(b'x' | b'X') => (16, 3, 6),
            _ => (10, 2, 7),
        };
        let digits = b[start..]
            .iter()
            .take_while(|c| char::from(**c).is_digit(radix))
            .count();
        if digits == 0 || digits > max || b.get(start + digits) != Some(&b';') {
            return None;
        }
        let code = u32::from_str_radix(&tail[start..start + digits], radix).ok()?;
        out.push(numeric(code));
        return Some(start + digits + 1);
    }
    let len = b[1..]
        .iter()
        .take_while(|c| c.is_ascii_alphanumeric())
        .count();
    if len == 0 || len > 31 || b.get(1 + len) != Some(&b';') {
        return None;
    }
    let at = NAMED
        .binary_search_by(|(name, _)| name.cmp(&&tail[1..1 + len]))
        .ok()?;
    out.push_str(NAMED[at].1);
    Some(len + 2)
}

/// A numeric reference's character, with the replacement character for the codes CommonMark
/// refuses: controls, surrogates, noncharacters and codes past Unicode.
fn numeric(code: u32) -> char {
    let refused = code < 9
        || code == 11
        || (14..32).contains(&code)
        || (127..160).contains(&code)
        || (0xD800..0xE000).contains(&code)
        || (0xFDD0..0xFDF0).contains(&code)
        || code & 0xFFFE == 0xFFFE;
    match refused {
        true => '\u{fffd}',
        false => char::from_u32(code).unwrap_or('\u{fffd}'),
    }
}

fn find_in(text: &str) -> Vec<Link> {
    let mut found: BTreeMap<usize, Link> = BTreeMap::new();
    let mut spans: Vec<(usize, usize)> = Vec::new();
    for m in ABSOLUTE.find_iter(text) {
        let shown = m.as_str().trim_end_matches(TRAIL);
        if let Some(link) = read(shown, shown) {
            found.insert(m.start(), link);
            spans.push((m.start(), m.end()));
        }
    }
    for pattern in [&*INLINE, &*AUTOLINK, &*REFERENCE] {
        for m in pattern.captures_iter(text).filter_map(|c| c.get(1)) {
            if found.contains_key(&m.start()) {
                continue;
            }
            if let Some(link) = destination(m.as_str()) {
                found.insert(m.start(), link);
                spans.push((m.start(), m.end()));
            }
        }
    }
    for m in EMAIL.captures_iter(text).filter_map(|c| c.get(1)) {
        found
            .entry(m.start())
            .or_insert_with(|| mailbox(m.as_str(), m.as_str()));
        spans.push((m.start(), m.end()));
    }
    for (start, end) in emails(text) {
        if spans.iter().any(|(s, e)| (*s..*e).contains(&start)) {
            continue;
        }
        found.insert(start, mailbox(&text[start..end], &text[start..end]));
        spans.push((start, end));
    }
    for m in WWW.captures_iter(text).filter_map(|c| c.get(1)) {
        if spans.iter().any(|(s, e)| (*s..*e).contains(&m.start())) {
            continue;
        }
        let shown = m.as_str().trim_end_matches(TRAIL);
        if let Some(link) = read(&format!("https://{shown}"), shown) {
            found.insert(m.start(), link);
        }
    }
    found.into_values().collect()
}

/// A mail or chat address as a link. Its host is the domain after its `@`, read like any other
/// host; an address without an `@`, or with several, has no host that can be read.
fn mailbox(address: &str, shown: &str) -> Link {
    let host = match address.matches('@').count() {
        1 => address
            .rsplit('@')
            .next()
            .and_then(|domain| domain.split('/').next())
            .and_then(ascii_host),
        _ => None,
    };
    Link {
        url: shown.to_string(),
        host: host.unwrap_or_default(),
        invite: false,
    }
}

fn atext(c: u8) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, b'.' | b'_' | b'+' | b'-')
}

/// Where the domain of a bare email address ends: labels of letters, digits, `-` and `_`, with
/// a dot among them, ending in a letter. A dot belongs to it only before a letter or digit, or
/// with `loose`, as the client reads what its first pass left, before `-` or `_` too.
fn domain_end(b: &[u8], from: usize, loose: bool) -> Option<usize> {
    let label = |c: u8| c.is_ascii_alphanumeric() || c == b'-' || c == b'_';
    if loose && b.get(from) == Some(&b'.') {
        return None;
    }
    let mut end = from;
    let (mut data, mut dot) = (false, false);
    while let Some(&c) = b.get(end) {
        let next = b.get(end + 1).copied();
        match c {
            b'.' if next.is_some_and(|n| n.is_ascii_alphanumeric() || (loose && label(n))) => {
                dot = true;
            }
            c if label(c) => data = true,
            _ => break,
        }
        end += 1;
    }
    (data && dot && b[end - 1].is_ascii_alphabetic()).then_some(end)
}

/// The bare email addresses the client links by itself, as byte ranges: the longest run of
/// letters, digits, `.`, `_`, `+` and `-` before an `@`, and a domain after it. Right after a
/// `/` the address starts after the first `.`, `_`, `+` or `-` of the run, or there is none.
fn emails(text: &str) -> Vec<(usize, usize)> {
    let b = text.as_bytes();
    let mut out = Vec::new();
    for at in (0..b.len()).filter(|i| b[*i] == b'@') {
        let run = b[..at].iter().rev().take_while(|c| atext(**c)).count();
        let first = at - run;
        let start = match first.checked_sub(1).map(|i| b[i]) {
            Some(b'/') => b[first..at]
                .iter()
                .position(|c| !c.is_ascii_alphanumeric())
                .map_or(at, |i| first + i + 1),
            _ => first,
        };
        let end = domain_end(b, at + 1, false).or_else(|| domain_end(b, at + 1, true));
        if let Some(end) = end.filter(|_| start < at) {
            out.push((start, end));
        }
    }
    out
}

fn scheme(address: &str, name: &str) -> bool {
    address
        .get(..name.len())
        .is_some_and(|start| start.eq_ignore_ascii_case(name))
}

static PAGE: LazyLock<Url> = LazyLock::new(|| Url::parse("https://page.invalid/").expect("url"));

/// The destination of a markdown link: a web address with or without its slashes, a
/// protocol-relative one, a `mailto:` or `xmpp:` address, or a path that is an invite on this
/// instance from some page of it (`/invite/x`, `../../invite/x`): resolved from the top, every
/// `..` climbs out of a page.
fn destination(dest: &str) -> Option<Link> {
    if let Some(s) = ["mailto:", "xmpp:"].into_iter().find(|s| scheme(dest, s)) {
        let address = dest[s.len()..].split(['?', '#']).next().unwrap_or("");
        return Some(mailbox(address, dest));
    }
    if ["http:", "https:", "irc:", "ircs:", "rchat://"]
        .iter()
        .any(|s| scheme(dest, s))
    {
        return read(dest, dest);
    }
    if dest.starts_with("//") {
        return read(&format!("https:{dest}"), dest);
    }
    PAGE.join(dest)
        .ok()
        .filter(|u| u.origin() == PAGE.origin() && invite_path(u.path()))
        .map(|_| Link {
            url: dest.to_string(),
            host: String::new(),
            invite: true,
        })
}

/// Reads an address the way a browser does. `rchat://host` names the instance at that host,
/// `irc://host` and `ircs://host` a chat server, never an invite.
fn read(address: &str, shown: &str) -> Option<Link> {
    let (web, invites) = match ["rchat:", "irc:", "ircs:"]
        .into_iter()
        .find(|s| scheme(address, s))
    {
        Some(s) => (format!("https:{}", &address[s.len()..]), s == "rchat:"),
        None => (address.to_string(), true),
    };
    let rest = web.split_once(':')?.1.trim_start_matches(['/', '\\']);
    let (authority, tail) = rest.split_at(rest.find(['/', '\\', '?', '#']).unwrap_or(rest.len()));
    let named = authority.rsplit('@').next().unwrap_or("");
    if named.is_empty() || named.starts_with(':') {
        return None;
    }
    let link = |host: String, path: &str| Link {
        url: shown.to_string(),
        host,
        invite: invites && invite_path(path),
    };
    Some(match Url::parse(&web) {
        Ok(url) => link(
            url.host_str().and_then(clean).unwrap_or_default(),
            url.path(),
        ),
        Err(_) => link(
            String::new(),
            &tail
                .split(['?', '#'])
                .next()
                .unwrap_or("")
                .replace('\\', "/"),
        ),
    })
}

/// `/invite/<server>` or `/invite/<server>/`, on any instance.
fn invite_path(path: &str) -> bool {
    let mut parts = path.split('/').skip(1);
    matches!(
        (parts.next(), parts.next(), parts.next(), parts.next()),
        (Some("invite"), Some(name), None | Some(""), None) if !name.is_empty()
    )
}

/// A parsed host without its trailing dot; none when a label is empty.
fn clean(host: &str) -> Option<String> {
    let host = host.strip_suffix('.').unwrap_or(host);
    let whole = !host.is_empty() && !host.starts_with('.') && !host.contains("..");
    whole.then(|| host.to_string())
}

/// A host name as hosts are compared: the way a browser resolves it, so lowercase, without a
/// trailing dot, with every label of another script in punycode.
pub fn ascii_host(host: &str) -> Option<String> {
    let literal = host.starts_with('[');
    if host.is_empty() || (!literal && host.contains(['/', '\\', '?', '#', '@', ':'])) {
        return None;
    }
    let url = Url::parse(&format!("https://{host}/")).ok()?;
    clean(url.host_str()?)
}

/// A domain rule: `example.com` is that host alone, `*.example.com` every host under it.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Rule {
    host: String,
    wild: bool,
}

pub fn rule(raw: &str) -> Option<Rule> {
    let raw = raw.trim();
    let (wild, host) = match raw.strip_prefix("*.") {
        Some(host) => (true, host),
        None => (false, raw),
    };
    let plain = |c: char| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.');
    let host = ascii_host(host).filter(|h| h.chars().all(plain))?;
    Some(Rule { host, wild })
}

impl Rule {
    pub fn matches(&self, host: &str) -> bool {
        match self.wild {
            true => host
                .strip_suffix(&self.host)
                .is_some_and(|rest| rest.ends_with('.')),
            false => host == self.host,
        }
    }
}

/// Which list a bad rule is in, and where.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum BadRule {
    Allow(usize),
    Deny(usize),
}

/// A `links` condition, compiled.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Rules {
    mode: LinkMode,
    allow: Vec<Rule>,
    deny: Vec<Rule>,
}

impl Rules {
    pub fn new(mode: LinkMode, allow: &[String], deny: &[String]) -> Result<Rules, BadRule> {
        let list = |raw: &[String], bad: fn(usize) -> BadRule| {
            raw.iter()
                .enumerate()
                .map(|(i, r)| rule(r).ok_or(bad(i)))
                .collect::<Result<Vec<Rule>, BadRule>>()
        };
        Ok(Rules {
            mode,
            allow: list(allow, BadRule::Allow)?,
            deny: list(deny, BadRule::Deny)?,
        })
    }

    /// Whether the condition counts this link. `Any` counts every link. `Invites` counts invites
    /// to hosts outside the allow list. `NotAllowed` counts a link whose host is on the deny
    /// list or, when there is an allow list, not on it; with neither list it counts every link.
    /// A link whose host can't be read is on no allow list, and `NotAllowed` always counts it.
    pub fn flags(&self, link: &Link) -> bool {
        let on = |rules: &[Rule]| rules.iter().any(|r| r.matches(&link.host));
        match self.mode {
            LinkMode::Any => true,
            LinkMode::Invites => link.invite && !on(&self.allow),
            LinkMode::NotAllowed => {
                link.host.is_empty()
                    || on(&self.deny)
                    || match self.allow.is_empty() {
                        true => self.deny.is_empty(),
                        false => !on(&self.allow),
                    }
            }
        }
    }

    /// The first link of the message that the condition counts.
    pub fn hit(&self, text: &str) -> Option<Link> {
        find(text).into_iter().find(|l| self.flags(l))
    }
}

const LOCAL: [&str; 5] = [".localhost", ".local", ".internal", ".lan", ".home.arpa"];

/// Whether a server may be asked to fetch this address: `http` or `https`, a domain name with
/// a dot that is not a local one, never an IP address, never with credentials, and nothing a
/// stricter parser could read as another host. The fetcher still has to check every address
/// the name resolves to.
pub fn fetchable(address: &str) -> bool {
    let odd = |c: char| c == '\\' || c.is_whitespace() || c.is_control();
    if address.chars().count() > 2048 || address.contains(odd) {
        return false;
    }
    let Ok(url) = Url::parse(address) else {
        return false;
    };
    let domain = match url.host() {
        Some(Host::Domain(name)) => clean(name),
        _ => None,
    };
    matches!(url.scheme(), "http" | "https")
        && url.username().is_empty()
        && url.password().is_none()
        && domain.is_some_and(|d| d.contains('.') && !LOCAL.iter().any(|l| d.ends_with(l)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::LinkMode;

    fn hosts(text: &str) -> Vec<(String, bool)> {
        find(text).into_iter().map(|l| (l.host, l.invite)).collect()
    }

    fn pair(host: &str, invite: bool) -> (String, bool) {
        (host.to_string(), invite)
    }

    #[test]
    fn the_finder_reads_the_servers_preview_vectors_the_same_way() {
        assert_eq!(
            hosts(
                "join https://chat.example/invite/club/?password=hunter2 or http://other.example/invite/x and https://site.example/page?token=abc&id=7#frag https://u:p@site.example/a?password=x&q=1"
            ),
            [
                pair("chat.example", true),
                pair("other.example", true),
                pair("site.example", false),
                pair("site.example", false)
            ]
        );
        assert_eq!(
            hosts("https://x.example/invite/club/sub https://x.example/invites/a"),
            [pair("x.example", false), pair("x.example", false)]
        );
        assert_eq!(
            hosts("https://s3.example/o?X-Amz-Signature=s&X-Amz-Credential=c&v=1"),
            [pair("s3.example", false)]
        );
        assert_eq!(
            hosts("https://Site.Example/Path"),
            [pair("site.example", false)]
        );
        assert_eq!(
            hosts("https://c.example:8443/s/rust/4/90 http://localhost:3000/dm/3/91"),
            [pair("c.example", false), pair("localhost", false)]
        );
    }

    #[test]
    fn links_are_found_wherever_they_stand_without_trailing_punctuation() {
        assert_eq!(
            find("see <https://a.example/x>, (https://b.example/y). \"https://c.example\"!")
                .into_iter()
                .map(|l| l.url)
                .collect::<Vec<String>>(),
            [
                "https://a.example/x",
                "https://b.example/y",
                "https://c.example"
            ]
        );
        assert_eq!(
            hosts("||https://x.example|| and ||see https://y.example||"),
            [pair("x.example", false), pair("y.example", false)]
        );
        assert_eq!(
            hosts("HTTPS://x.example ftp://y.example z.example www.z.example"),
            [pair("x.example", false), pair("www.z.example", false)]
        );
        assert_eq!(hosts("https:// https://? https://@ http://:80"), []);
        assert_eq!(
            hosts("[x](https://a.example/y) `https://b.example`"),
            [pair("a.example", false), pair("b.example", false)]
        );
        assert_eq!(
            hosts("https://[::1]:8080/x https://192.0.2.7/"),
            [pair("[::1]", false), pair("192.0.2.7", false)]
        );
        assert_eq!(hosts("https://a.example./x"), [pair("a.example", false)]);
    }

    #[test]
    fn hosts_are_read_the_way_a_browser_reads_them() {
        assert_eq!(
            hosts("https://allowed.example@evil.test/"),
            [pair("evil.test", false)]
        );
        assert_eq!(hosts("https://%65vil.test/x"), [pair("evil.test", false)]);
        assert_eq!(
            hosts("https://exa%6Dple.com/x"),
            [pair("example.com", false)]
        );
        assert_eq!(
            hosts("https://evil\u{3002}test/x"),
            [pair("evil.test", false)]
        );
        assert_eq!(
            hosts("https://EVIL\u{ff0e}Test"),
            [pair("evil.test", false)]
        );
        assert_eq!(
            hosts("http://0x7f.1/ http://2130706433/ http://127.0.0.1"),
            [
                pair("127.0.0.1", false),
                pair("127.0.0.1", false),
                pair("127.0.0.1", false)
            ]
        );
        assert_eq!(
            hosts(r"https://evil.test\invite\x"),
            [pair("evil.test", true)]
        );
    }

    #[test]
    fn markdown_links_count_whatever_their_address_looks_like() {
        assert_eq!(hosts("[x](https:evil.test/a)"), [pair("evil.test", false)]);
        assert_eq!(
            hosts("[x]( <HTTPS:/evil.test> )"),
            [pair("evil.test", false)]
        );
        assert_eq!(hosts(r"[x](https:\\evil.test)"), [pair("evil.test", false)]);
        assert_eq!(hosts("[x](//evil.test/a)"), [pair("evil.test", false)]);
        assert_eq!(hosts("<https:evil.test>"), [pair("evil.test", false)]);
        assert_eq!(
            hosts("[click][1]\n\n[1]: https:evil.test/a"),
            [pair("evil.test", false)]
        );
        assert_eq!(
            hosts("[x](/invite/lobby/) [y](/s/lobby/4)"),
            [pair("", true)]
        );
        assert_eq!(hosts("[x](tel:+15550100) [y](#top) [z](page)"), []);
        assert_eq!(
            hosts("[a](https://a.example/y) and https://b.example"),
            [pair("a.example", false), pair("b.example", false)]
        );
        assert_eq!(hosts("the port is http:8080 and https: is a scheme"), []);
    }

    #[test]
    fn escaped_links_count_as_the_client_shows_them() {
        for (text, url) in [
            (r"[x](https\://evil.test/a)", "https://evil.test/a"),
            ("[x](https&#58;//evil.test/a)", "https://evil.test/a"),
            ("[x][1]\n\n[1]: https\\://evil.test", "https://evil.test"),
            (r"see https\://evil.test", "https://evil.test"),
            ("see https&#58;//evil.test", "https://evil.test"),
            ("see www&#46;evil.test", "www.evil.test"),
            ("<https&#58;//evil.test>", "https://evil.test"),
            (
                "see https&colon;&sol;&sol;evil&period;test",
                "https://evil.test",
            ),
            ("see h&#x74;tps&#X3A;//evil.test", "https://evil.test"),
            ("see https&#0000058;//evil.test", "https://evil.test"),
            (r"see https:\/\/evil.test", "https://evil.test"),
        ] {
            let found = find(text);
            assert_eq!(found.len(), 1, "{text}");
            assert_eq!(found[0].url, url, "{text}");
            let host = url.rsplit("//").next().and_then(|r| r.split('/').next());
            assert_eq!(Some(found[0].host.as_str()), host, "{text}");
        }
        assert_eq!(hosts("[x](/invite&#47;lobby)"), [pair("", true)]);
        let deny = rules(LinkMode::NotAllowed, &[], &["evil.test", "*.evil.test"]);
        let allow = rules(LinkMode::NotAllowed, &["ok.example"], &[]);
        let any = rules(LinkMode::Any, &[], &[]);
        let invites = rules(LinkMode::Invites, &["chat.example"], &[]);
        for text in [
            r"[x](https\://evil.test/a)",
            "see https&#58;//evil.test",
            "see www&#46;evil.test",
        ] {
            assert!(deny.hit(text).is_some(), "{text}");
            assert!(allow.hit(text).is_some(), "{text}");
            assert!(any.hit(text).is_some(), "{text}");
        }
        assert!(invites.hit("[x](/invite&#47;lobby)").is_some());
        assert!(
            invites
                .hit("see https&#58;//other.example/invite/x")
                .is_some()
        );
    }

    #[test]
    fn what_the_client_leaves_escaped_is_no_link() {
        for text in [
            "see https&#58//evil.test",
            "see https&#00000058;//evil.test",
            "see https&#x000003a;//evil.test",
            "see https&nope;//evil.test",
            r"see https\\://evil.test",
            "see https&amp;#58;//evil.test",
            r"see https\&#58;//evil.test",
            "see https\u{2060}://evil.test",
        ] {
            assert_eq!(find(text), [], "{text}");
        }
        assert_eq!(
            find("https://a.example/x?a=1&amp;b=2")
                .into_iter()
                .map(|l| l.url)
                .collect::<Vec<String>>(),
            ["https://a.example/x?a=1&amp;b=2"]
        );
        assert_eq!(
            hosts(r"https://evil.test\@allowed.example/"),
            [pair("evil.test", false), pair("allowed.example", false)]
        );
    }

    #[test]
    fn references_decode_as_commonmark_says() {
        assert_eq!(NAMED.len(), 2125);
        assert!(NAMED.windows(2).all(|w| w[0].0 < w[1].0));
        assert_eq!(decode("plain"), "plain");
        assert_eq!(decode(r"\*a\* \a \\ \"), r"*a* \a \ \");
        assert_eq!(
            decode("&amp;&AMP;&lt;&NotEqualTilde;&nope;&;&#;&#x;"),
            "&&<\u{2242}\u{338}&nope;&;&#;&#x;"
        );
        assert_eq!(
            decode("&#0;&#65;&#x1F600;&#xD800;&#1114112;&#128;"),
            "\u{fffd}A😀\u{fffd}\u{fffd}\u{fffd}"
        );
        assert_eq!(
            decode("&#9999999;&#xFFFFFF;&#xFFFE;"),
            "\u{fffd}\u{fffd}\u{fffd}"
        );
        assert_eq!(decode("&CounterClockwiseContourIntegral;"), "\u{2233}");
        assert_eq!(decode(r"\&amp; &amp;amp;"), "&amp; &amp;");
    }

    #[test]
    fn reference_definitions_count_wherever_commonmark_reads_one() {
        for (text, host, invite) in [
            ("[x][1]\n\n[1]:\n//evil.test", "evil.test", false),
            ("[x][1]\n\n[1]:\nhttp:evil.test", "evil.test", false),
            ("[x][1]\n\n[1]:\n<//evil.test/a>", "evil.test", false),
            ("[x][1]\n\n[1]:\n   //evil.test", "evil.test", false),
            ("[x][1]\n\n[1]:   \n  \t //evil.test", "evil.test", false),
            ("[x][1]\n\n[1]:\r\n//evil.test", "evil.test", false),
            ("[x][a\nb]\n\n[a\nb]: //evil.test", "evil.test", false),
            ("[x][a\nb\nc]\n\n[a\nb\nc]: //evil.test", "evil.test", false),
            ("- [1]: //evil.test\n\n[x][1]", "evil.test", false),
            ("> [1]: //evil.test\n\n[x][1]", "evil.test", false),
            ("1. [1]: http:evil.test\n\n[x][1]", "evil.test", false),
            ("[x][1]\n\n* [1]: //evil.test", "evil.test", false),
            ("[x][1]\n\n+ [1]: //evil.test", "evil.test", false),
            ("[x][1]\n\n1) [1]: //evil.test", "evil.test", false),
            ("[x][1]\n\n>> [1]: //evil.test", "evil.test", false),
            ("[x][1]\n\n> - [1]: //evil.test", "evil.test", false),
            ("[x][1]\n\n> [1]:\n> //evil.test", "evil.test", false),
            ("[x][1]\n\n- [1]:\n  //evil.test", "evil.test", false),
            ("- [x][1]\n- [1]: //evil.test", "evil.test", false),
            ("[1]://evil.test\n\n[x][1]", "evil.test", false),
            ("[x][1]\n\n[1]:\n/invite/lobby", "", true),
        ] {
            assert_eq!(hosts(text), [pair(host, invite)], "{text:?}");
        }
        let deny = rules(LinkMode::NotAllowed, &[], &["evil.test"]);
        let any = rules(LinkMode::Any, &[], &[]);
        let invites = rules(LinkMode::Invites, &[], &[]);
        for text in [
            "[x][1]\n\n[1]:\n//evil.test",
            "- [1]: //evil.test\n\n[x][1]",
            "> [1]: //evil.test\n\n[x][1]",
        ] {
            assert!(deny.hit(text).is_some(), "{text:?}");
            assert!(any.hit(text).is_some(), "{text:?}");
        }
        assert!(invites.hit("[x][1]\n\n[1]:\n/invite/lobby").is_some());
        assert_eq!(hosts("[x][1]\n\n[1]:\n\n//evil.test"), []);
    }

    #[test]
    fn a_relative_destination_is_an_invite_when_it_can_resolve_to_one() {
        for text in [
            "[x](/invite/lobby)",
            "[x](../../invite/lobby)",
            "[x](../invite/lobby/)",
            "[x](./invite/lobby)",
            "[x](invite/lobby)",
            "[x](/s/a/../../invite/lobby)",
            "[x](/./invite/lobby?x=1#y)",
            "[x][1]\n\n[1]: ../../invite/lobby",
        ] {
            assert_eq!(hosts(text), [pair("", true)], "{text:?}");
        }
        for text in [
            "[x](x/invite/lobby)",
            "[x](/s/invite/lobby)",
            "[x](\u{2060}/invite/lobby\u{2060})",
            "[x](#/invite/lobby)",
            "[x](?/invite/lobby)",
            "[x](tel:invite/lobby)",
            "[x](/invite/)",
        ] {
            assert_eq!(hosts(text), [], "{text:?}");
        }
    }

    #[test]
    fn www_counts_after_any_character_but_a_letter_or_digit() {
        for text in [
            "_www.evil.test",
            "x_www.evil.test",
            "*www.evil.test",
            "~www.evil.test",
            "(www.evil.test)",
            "-www.evil.test",
            ".www.evil.test",
            "$www.evil.test",
            "=www.evil.test",
            "+www.evil.test",
        ] {
            assert_eq!(hosts(text), [pair("www.evil.test", false)], "{text:?}");
        }
        for text in ["1www.evil.test", "Awww.evil.test", "awww.evil.test"] {
            assert_eq!(hosts(text), [], "{text:?}");
        }
        let deny = rules(LinkMode::NotAllowed, &[], &["*.evil.test"]);
        assert!(deny.hit("_www.evil.test").is_some());
    }

    #[test]
    fn bare_www_addresses_are_links() {
        assert_eq!(
            hosts("see www.evil.test/x, WWW.Evil.Test and https://www.a.example"),
            [
                pair("www.evil.test", false),
                pair("www.evil.test", false),
                pair("www.a.example", false)
            ]
        );
        assert_eq!(hosts("awww.evil.test www. www"), []);
    }

    #[test]
    fn a_link_whose_host_cant_be_read_counts() {
        assert_eq!(hosts("https://[bad/x"), [pair("", false)]);
        assert_eq!(hosts("https://a..b/x"), [pair("", false)]);
        let deny = rules(LinkMode::NotAllowed, &[], &["evil.test"]);
        assert!(deny.hit("https://[bad/x").is_some());
        assert!(deny.hit("https://fine.example/x").is_none());
        let allow = rules(LinkMode::NotAllowed, &["fine.example"], &[]);
        assert!(allow.hit("https://[bad/x").is_some());
        let invites = rules(LinkMode::Invites, &["chat.example"], &[]);
        assert!(invites.hit("[x](/invite/lobby)").is_some());
        assert!(invites.hit("https://[bad/invite/x").is_some());
    }

    #[test]
    fn a_deny_list_is_not_dodged_by_spelling_the_host_another_way() {
        let deny = rules(LinkMode::NotAllowed, &[], &["evil.test", "*.evil.test"]);
        for text in [
            "https://EVIL.test",
            "https://evil.test./x",
            "https://%65vil.test",
            "https://evil\u{3002}test",
            "https://x@evil.test",
            r"https://evil.test\@fine.example",
            "[x](https:evil.test)",
            "[x](//evil.test)",
            "<https:evil.test>",
            "www.evil.test",
            "https://evil.test:8443/x",
        ] {
            assert!(deny.hit(text).is_some(), "{text}");
        }
        assert!(deny.hit(r"[x](https://fine.example\@evil.test)").is_some());
        assert!(deny.hit("https://fine.example/?next=evil.test").is_none());
    }

    #[test]
    fn a_feed_address_is_a_public_web_address() {
        for ok in [
            "https://blog.example.com/feed.xml",
            "http://news.example.org:8080/rss?tag=a",
            "https://b\u{fc}cher.example/feed",
        ] {
            assert!(fetchable(ok), "{ok}");
        }
        for bad in [
            "ftp://blog.example.com/feed",
            "blog.example.com/feed",
            "https://",
            "http://localhost/feed",
            "http://LOCALHOST./feed",
            "http://app.localhost/feed",
            "http://127.0.0.1/feed",
            "http://2130706433/feed",
            "http://0x7f.1/feed",
            "http://[::1]/feed",
            "http://[fe80::1]/feed",
            "http://10.0.0.5/feed",
            "http://192.168.1.1/feed",
            "http://169.254.169.254/latest/meta-data",
            "http://203.0.113.9/feed",
            "http://intranet/feed",
            "http://printer.local/feed",
            "http://db.internal/feed",
            "http://router.lan/feed",
            "http://nas.home.arpa/feed",
            "http://user:pw@blog.example.com/feed",
            "http://token@blog.example.com/feed",
            r"http://blog.example.com\@127.0.0.1/feed",
        ] {
            assert!(!fetchable(bad), "{bad}");
        }
        assert!(!fetchable(&format!(
            "https://blog.example.com/{}",
            "a".repeat(2048)
        )));
    }

    #[test]
    fn irc_links_count_with_their_host_and_are_never_invites() {
        for (text, host) in [
            ("[x](irc://evil.test/chan)", "evil.test"),
            ("[x](ircs://evil.test)", "evil.test"),
            ("<irc://evil.test>", "evil.test"),
            ("[x](irc:evil.test)", "evil.test"),
            ("<ircs:evil.test>", "evil.test"),
            ("[x](IRC://Evil.Test)", "evil.test"),
            ("[x][1]\n\n[1]: irc://evil.test", "evil.test"),
            ("[x](irc&#58;//evil.test)", "evil.test"),
            ("see irc://evil.test/x", "evil.test"),
            ("[x](irc://chat.example/invite/lobby)", "chat.example"),
        ] {
            assert_eq!(hosts(text), [pair(host, false)], "{text}");
        }
        assert_eq!(hosts("[x](ircx://evil.test) the irc: client"), []);
        let allowed =
            Rules::new(LinkMode::NotAllowed, &["docs.example".into()], &[]).expect("rules");
        assert!(allowed.hit("[x](ircs://evil.test)").is_some());
        assert!(allowed.hit("[x](irc://docs.example/chan)").is_none());
    }

    #[test]
    fn mail_and_xmpp_addresses_are_links_to_the_domain_after_the_at() {
        for text in [
            "[bank login](mailto:help@evil.test)",
            "<mailto:help@evil.test>",
            "mailto:help@evil.test",
            "help@evil.test",
            "[chat](xmpp:help@evil.test)",
            "xmpp:help@evil.test",
            "[x](MAILTO:help@evil.test)",
            "[x](Xmpp:help@evil.test)",
            "[x](https://evil.test)",
            "<help@evil.test>",
            "<a!b@evil.test>",
            "<a/b@evil.test>",
            "[x][1]\n\n[1]: mailto:help@evil.test",
            "[x](mailto:help@EVIL.test?subject=hi)",
            "[x](xmpp:help@evil.test/phone?message)",
            "write to Help@Evil.Test.",
            "(help@evil.test), please",
            "git@evil.test:repo.git",
            "first.last+tag@evil.test",
            "[x](mailto&#58;help@evil.test)",
            "help&#64;evil.test",
            "x/first.last@evil.test",
            "help@evil.test and help@evil.test",
        ] {
            let found = hosts(text);
            assert!(!found.is_empty(), "{text}");
            assert!(
                found.iter().all(|h| *h == pair("evil.test", false)),
                "{text}"
            );
        }
        assert_eq!(hosts("help@www.evil.test"), [pair("www.evil.test", false)]);
        assert_eq!(
            hosts("a@x.example, b@evil.test"),
            [pair("x.example", false), pair("evil.test", false)]
        );
        assert_eq!(hosts("help@evil.-test"), [pair("evil.-test", false)]);
        assert_eq!(hosts("help@.evil.test"), [pair("", false)]);
        assert_eq!(
            find("mailto:help@evil.test")
                .into_iter()
                .map(|l| l.url)
                .collect::<Vec<String>>(),
            ["help@evil.test"]
        );
        assert_eq!(
            find("[x](mailto:help@evil.test?subject=hi)")
                .into_iter()
                .map(|l| l.url)
                .collect::<Vec<String>>(),
            ["mailto:help@evil.test?subject=hi"]
        );
        for text in [
            "[x](mailto:nobody)",
            "[x](mailto:)",
            "[x](mailto:invite/lobby)",
            "[x](mailto:a@x.example,b@evil.test)",
            "[x](mailto:help%40evil.test)",
            "[x](xmpp:help@)",
        ] {
            assert_eq!(hosts(text), [pair("", false)], "{text}");
        }
        for text in [
            "help@evil",
            "help@evil.test1",
            "help@evil.test-",
            "@evil.test",
            "help@ evil.test",
            "help @evil.test",
            "help\u{2060}@evil.test",
            "help@\u{2060}evil.test",
            "help@evil.\u{2060}test",
            "help@.-evil.test",
            "help@evil.-",
            "x/help@evil.test",
            "the mailto: and xmpp: schemes",
            "mailto:nobody",
            "[x](mailtox:help) [y](xmpps:help)",
        ] {
            assert_eq!(hosts(text), [], "{text}");
        }
        let deny = rules(LinkMode::NotAllowed, &[], &["evil.test", "*.evil.test"]);
        let allow = rules(LinkMode::NotAllowed, &["fine.example"], &[]);
        let allowed = rules(LinkMode::NotAllowed, &["evil.test"], &[]);
        let none = rules(LinkMode::NotAllowed, &[], &[]);
        let any = rules(LinkMode::Any, &[], &[]);
        let invites = rules(LinkMode::Invites, &[], &[]);
        for text in [
            "[bank login](mailto:help@evil.test)",
            "<mailto:help@evil.test>",
            "mailto:help@evil.test",
            "help@evil.test",
            "[chat](xmpp:help@evil.test)",
            "xmpp:help@evil.test",
            "[x](MAILTO:help@evil.test)",
        ] {
            assert!(deny.hit(text).is_some(), "{text}");
            assert!(allow.hit(text).is_some(), "{text}");
            assert!(none.hit(text).is_some(), "{text}");
            assert!(any.hit(text).is_some(), "{text}");
            assert!(allowed.hit(text).is_none(), "{text}");
            assert!(invites.hit(text).is_none(), "{text}");
        }
        assert!(deny.hit("[x](mailto:help@mail.evil.test)").is_some());
        assert!(deny.hit("[x](mailto:help@fine.example)").is_none());
        assert!(deny.hit("[x](mailto:a@fine.example,b@evil.test)").is_some());
        assert!(allowed.hit("[x](mailto:help%40evil.test)").is_some());
        assert!(invites.hit("[x](mailto:invite/lobby)").is_none());
    }

    #[test]
    fn invites_are_this_and_other_instances_invite_paths_and_app_links() {
        for text in [
            "https://chat.example/invite/lobby",
            "https://chat.example/invite/lobby/",
            "http://other.example:3000/invite/my%20club/#password=x",
            "rchat://chat.example/invite/lobby/",
            "rchat://localhost:3000/invite/lobby",
        ] {
            let found = find(text);
            assert_eq!(found.len(), 1, "{text}");
            assert!(found[0].invite, "{text}");
        }
        for text in [
            "https://chat.example/invite/",
            "https://chat.example/invite",
            "https://chat.example/invite/a/b",
            "https://chat.example/invites/a",
            "https://chat.example/s/lobby/4/90",
            "rchat://chat.example/s/lobby/4",
        ] {
            assert!(find(text).iter().all(|l| !l.invite), "{text}");
        }
        assert_eq!(
            hosts("rchat://chat.example/invite/lobby/"),
            [pair("chat.example", true)]
        );
    }

    #[test]
    fn hosts_are_compared_in_punycode() {
        assert_eq!(
            ascii_host("Bücher.Example").as_deref(),
            Some("xn--bcher-kva.example")
        );
        assert_eq!(
            ascii_host("xn--bcher-kva.example").as_deref(),
            Some("xn--bcher-kva.example")
        );
        assert_eq!(
            ascii_host("пример.рф").as_deref(),
            Some("xn--e1afmkfd.xn--p1ai")
        );
        assert_eq!(
            ascii_host("例え.テスト").as_deref(),
            Some("xn--r8jz45g.xn--zckzah")
        );
        assert_eq!(
            ascii_host("ｅｘａｍｐｌｅ.com").as_deref(),
            Some("example.com")
        );
        assert_eq!(ascii_host("a.example.").as_deref(), Some("a.example"));
        assert_eq!(ascii_host(""), None);
        assert_eq!(ascii_host("a..b"), None);
        assert_eq!(ascii_host("a b.example"), None);
        assert_eq!(
            hosts("https://bücher.example/x https://xn--bcher-kva.example/y"),
            [
                pair("xn--bcher-kva.example", false),
                pair("xn--bcher-kva.example", false)
            ]
        );
    }

    #[test]
    fn domain_rules_match_exactly_or_every_subdomain() {
        let exact = rule("Example.com").expect("rule");
        assert!(exact.matches("example.com"));
        assert!(!exact.matches("www.example.com"));
        assert!(!exact.matches("badexample.com"));
        let wild = rule("*.example.com").expect("rule");
        assert!(wild.matches("www.example.com"));
        assert!(wild.matches("a.b.example.com"));
        assert!(!wild.matches("example.com"));
        assert!(!wild.matches("badexample.com"));
        let idn = rule("*.bücher.example").expect("rule");
        assert!(idn.matches("shop.xn--bcher-kva.example"));
        for bad in [
            "",
            "*",
            "*.",
            "not a domain",
            "https://example.com",
            "a/b",
            "*.*.example.com",
            "exa*mple.com",
        ] {
            assert!(rule(bad).is_none(), "{bad}");
        }
    }

    fn rules(mode: LinkMode, allow: &[&str], deny: &[&str]) -> Rules {
        let list = |l: &[&str]| l.iter().map(|s| s.to_string()).collect::<Vec<String>>();
        Rules::new(mode, &list(allow), &list(deny)).expect("rules")
    }

    #[test]
    fn any_matches_every_link() {
        let any = rules(LinkMode::Any, &[], &[]);
        assert_eq!(
            any.hit("see https://a.example/x")
                .map(|l| l.host)
                .as_deref(),
            Some("a.example")
        );
        assert!(any.hit("rchat://chat.example/invite/lobby").is_some());
        assert!(any.hit("no links here").is_none());
    }

    #[test]
    fn invites_match_invite_links_except_to_allowed_hosts() {
        let invites = rules(LinkMode::Invites, &["chat.example"], &[]);
        assert!(invites.hit("https://other.example/invite/x").is_some());
        assert!(invites.hit("https://chat.example/invite/x").is_none());
        assert!(invites.hit("https://other.example/page").is_none());
        assert!(invites.hit("rchat://other.example/invite/x/").is_some());
    }

    #[test]
    fn not_allowed_follows_the_allow_and_deny_lists() {
        let all = rules(LinkMode::NotAllowed, &[], &[]);
        assert!(all.hit("https://a.example").is_some());
        let allow = rules(LinkMode::NotAllowed, &["example.com", "*.example.com"], &[]);
        assert!(
            allow
                .hit("https://example.com/a https://docs.example.com/b")
                .is_none()
        );
        assert_eq!(
            allow
                .hit("https://example.com/a https://evil.test/b")
                .map(|l| l.host)
                .as_deref(),
            Some("evil.test")
        );
        let deny = rules(LinkMode::NotAllowed, &[], &["*.evil.test"]);
        assert!(deny.hit("https://a.example").is_none());
        assert!(deny.hit("https://x.evil.test").is_some());
        let both = rules(
            LinkMode::NotAllowed,
            &["*.example.com"],
            &["ads.example.com"],
        );
        assert!(both.hit("https://docs.example.com").is_none());
        assert!(both.hit("https://ads.example.com").is_some());
        assert!(both.hit("https://other.test").is_some());
        assert!(Rules::new(LinkMode::Any, &["not a domain".to_string()], &[]).is_err());
    }
}
