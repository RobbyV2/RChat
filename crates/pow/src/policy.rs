//! The policy file: rules in Anubis's style that allow, deny, challenge or weigh a request by
//! its path, user agent, headers, address, method and caller.

use std::collections::HashSet;
use std::fmt;
use std::net::IpAddr;

use regex::{Regex, RegexSet};
use serde::Deserialize;
use serde::de::value::MapAccessDeserializer;
use serde::de::{DeserializeSeed, Deserializer, Error, IgnoredAny, MapAccess, SeqAccess, Visitor};

pub const RULES_MAX: usize = 1000;
pub const REGEX_MAX: usize = 1000;
/// The bytes of a path, a user agent or a header value that a rule reads.
pub const FIELD_MAX: usize = 8 * 1024;
/// The largest policy file.
pub const POLICY_MAX: usize = 1024 * 1024;
const ADJUST_MAX: i32 = 64;
const NO_RULES: &str = "the policy has no rules; without a file the built-in rule applies";
const BUILTIN: &str =
    "bots:\n  - name: browsers\n    user_agent_regex: Mozilla|Opera\n    action: CHALLENGE\n";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Action {
    Allow,
    Deny,
    Challenge,
    Weigh,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Who {
    Guest,
    Account,
}

/// Which gate asks: the page gate, or the API gate for a caller.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Gate {
    Pages,
    Api(Who),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Scope {
    Pages,
    Api,
    Both,
}

#[derive(Clone, Copy, Debug)]
pub struct Request<'a> {
    pub gate: Gate,
    pub method: &'a str,
    pub path: &'a str,
    pub user_agent: &'a str,
    /// Names in any case; the first value of a name counts.
    pub headers: &'a [(&'a str, &'a str)],
    pub remote: IpAddr,
}

/// The first ALLOW, DENY or CHALLENGE rule that matched, by name, and the sum of the WEIGH
/// rules that matched before it. `cut` says a path, user agent or header that a rule reads was
/// over 8 KiB: the request is then denied unread, by no rule.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Verdict<'a> {
    pub action: Option<Action>,
    pub rule: Option<&'a str>,
    pub weight: i32,
    pub cut: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PolicyError {
    pub line: Option<usize>,
    pub reason: String,
}

impl fmt::Display for PolicyError {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        match self.line {
            Some(line) => write!(f, "line {line}: {}", self.reason),
            None => f.write_str(&self.reason),
        }
    }
}

impl std::error::Error for PolicyError {}

#[derive(Clone, Copy, Debug)]
struct Cidr {
    net: IpAddr,
    len: u8,
}

impl Cidr {
    fn parse(spec: &str) -> Option<Cidr> {
        let (addr, len) = match spec.split_once('/') {
            Some((addr, len)) => (addr, Some(len)),
            None => (spec, None),
        };
        let written = addr.trim().parse::<IpAddr>().ok()?;
        let net = written.to_canonical();
        let (max, offset) = match (written, net) {
            (IpAddr::V4(_), _) => (32, 0),
            (IpAddr::V6(_), IpAddr::V4(_)) => (128, 96),
            (IpAddr::V6(_), IpAddr::V6(_)) => (128, 0),
        };
        let len = match len {
            Some(len) => len.trim().parse::<u8>().ok().filter(|l| *l <= max)?,
            None => max,
        };
        Some(Cidr {
            net,
            len: len.checked_sub(offset)?,
        })
    }

    fn contains(&self, ip: IpAddr) -> bool {
        let (net, addr, width) = match (self.net, ip.to_canonical()) {
            (IpAddr::V4(n), IpAddr::V4(a)) => (u32::from(n) as u128, u32::from(a) as u128, 32),
            (IpAddr::V6(n), IpAddr::V6(a)) => (u128::from(n), u128::from(a), 128),
            (_, _) => return false,
        };
        (net ^ addr)
            .checked_shr(width - u32::from(self.len))
            .unwrap_or(0)
            == 0
    }
}

/// A scalar read through `parse`, so a refusal carries the line of the value itself.
struct Scalar<T>(fn(&str) -> Result<T, String>);

impl<'de, T> Visitor<'de> for Scalar<T> {
    type Value = T;

    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("a string")
    }

    fn visit_str<E: Error>(self, text: &str) -> Result<T, E> {
        (self.0)(text).map_err(E::custom)
    }
}

impl<'de, T> DeserializeSeed<'de> for Scalar<T> {
    type Value = T;

    fn deserialize<D: Deserializer<'de>>(self, d: D) -> Result<T, D::Error> {
        d.deserialize_str(self)
    }
}

fn pattern(text: &str) -> Result<String, String> {
    if text.chars().count() > REGEX_MAX {
        return Err(format!("a regex has at most {REGEX_MAX} characters"));
    }
    match Regex::new(text) {
        Ok(_) => Ok(text.to_string()),
        Err(e) => Err(format!("not a regex: {e}")),
    }
}

fn regex<'de, D: Deserializer<'de>>(d: D) -> Result<Option<String>, D::Error> {
    d.deserialize_str(Scalar(pattern)).map(Some)
}

fn some<'de, D: Deserializer<'de>, T>(found: Result<T, D::Error>) -> Result<Option<T>, D::Error> {
    found.map(Some)
}

fn scope<'de, D: Deserializer<'de>>(d: D) -> Result<Scope, D::Error> {
    d.deserialize_str(Scalar(|text| match text {
        "pages" => Ok(Scope::Pages),
        "api" => Ok(Scope::Api),
        "both" => Ok(Scope::Both),
        _ => Err("expected pages, api or both".to_string()),
    }))
}

fn who<'de, D: Deserializer<'de>>(d: D) -> Result<Option<Who>, D::Error> {
    d.deserialize_str(Scalar(|text| match text {
        "guest" => Ok(Some(Who::Guest)),
        "account" => Ok(Some(Who::Account)),
        _ => Err("expected guest or account".to_string()),
    }))
}

fn action<'de, D: Deserializer<'de>>(d: D) -> Result<Option<Action>, D::Error> {
    d.deserialize_str(Scalar(|text| match text {
        "ALLOW" => Ok(Some(Action::Allow)),
        "DENY" => Ok(Some(Action::Deny)),
        "CHALLENGE" => Ok(Some(Action::Challenge)),
        "WEIGH" => Ok(Some(Action::Weigh)),
        _ => Err("expected ALLOW, DENY, CHALLENGE or WEIGH".to_string()),
    }))
}

struct Each<T>(fn(&str) -> Result<T, String>, &'static str);

impl<'de, T> Visitor<'de> for Each<T> {
    type Value = Vec<T>;

    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str(self.1)
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Vec<T>, A::Error> {
        let mut out = Vec::new();
        while let Some(item) = seq.next_element_seed(Scalar(self.0))? {
            out.push(item);
        }
        Ok(out)
    }
}

fn addresses<'de, D: Deserializer<'de>>(d: D) -> Result<Option<Vec<Cidr>>, D::Error> {
    let cidr = |text: &str| {
        Cidr::parse(text).ok_or_else(|| format!("{text} is not an address or a range"))
    };
    some::<D, _>(d.deserialize_seq(Each(cidr, "a list of addresses and ranges")))
}

fn methods<'de, D: Deserializer<'de>>(d: D) -> Result<Option<Vec<String>>, D::Error> {
    let method = |text: &str| Ok(text.to_ascii_uppercase());
    some::<D, _>(d.deserialize_seq(Each(method, "a list of methods")))
}

struct Headers;

impl<'de> Visitor<'de> for Headers {
    type Value = Vec<(String, String)>;

    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("header names with a regex each")
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
        let mut out = Vec::new();
        while let Some(name) = map.next_key::<String>()? {
            let source = map.next_value_seed(Scalar(pattern))?;
            out.push((name, source));
        }
        Ok(out)
    }

    fn visit_unit<E: Error>(self) -> Result<Self::Value, E> {
        Ok(Vec::new())
    }
}

fn headers<'de, D: Deserializer<'de>>(d: D) -> Result<Option<Vec<(String, String)>>, D::Error> {
    some::<D, _>(d.deserialize_map(Headers))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Weight {
    adjust: i32,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Written {
    name: Option<String>,
    #[serde(default = "pages", deserialize_with = "scope")]
    scope: Scope,
    #[serde(default, deserialize_with = "regex")]
    path_regex: Option<String>,
    #[serde(default, deserialize_with = "regex")]
    user_agent_regex: Option<String>,
    #[serde(default, deserialize_with = "headers")]
    headers_regex: Option<Vec<(String, String)>>,
    #[serde(default, deserialize_with = "addresses")]
    remote_addresses: Option<Vec<Cidr>>,
    #[serde(default, deserialize_with = "methods")]
    methods: Option<Vec<String>>,
    #[serde(default, deserialize_with = "who")]
    who: Option<Who>,
    #[serde(default, deserialize_with = "action")]
    action: Option<Action>,
    weight: Option<Weight>,
    import: Option<IgnoredAny>,
}

fn pages() -> Scope {
    Scope::Pages
}

/// A rule as written and checked, before its regexes join the sets.
struct Checked {
    name: String,
    scope: Scope,
    path: Option<String>,
    user_agent: Option<String>,
    headers: Vec<(String, String)>,
    nets: Vec<Cidr>,
    methods: Vec<String>,
    who: Option<Who>,
    action: Action,
    adjust: i32,
}

/// The field of a rule that is written but says nothing. An empty matcher never means
/// "everything": it is a mistake, and the rule is refused.
fn empty_matcher(w: &Written) -> Option<String> {
    let Written {
        name: _,
        scope: _,
        path_regex,
        user_agent_regex,
        headers_regex,
        remote_addresses,
        methods,
        who: _,
        action: _,
        weight: _,
        import: _,
    } = w;
    let blank = |text: &Option<String>| text.as_ref().is_some_and(|t| t.is_empty());
    let header = headers_regex.iter().flatten().find_map(|(name, source)| {
        match (name.is_empty(), source.is_empty()) {
            (true, _) => Some("headers_regex".to_string()),
            (false, true) => Some(format!("headers_regex.{name}")),
            (false, false) => None,
        }
    });
    let no_method = |m: &Vec<String>| m.is_empty() || m.iter().any(|x| x.is_empty());
    [
        blank(path_regex).then(|| "path_regex".to_string()),
        blank(user_agent_regex).then(|| "user_agent_regex".to_string()),
        (headers_regex.as_ref().is_some_and(|h| h.is_empty())).then(|| "headers_regex".to_string()),
        header,
        (remote_addresses.as_ref().is_some_and(|a| a.is_empty()))
            .then(|| "remote_addresses".to_string()),
        (methods.as_ref().is_some_and(no_method)).then(|| "methods".to_string()),
    ]
    .into_iter()
    .flatten()
    .next()
}

fn checked(w: Written, seen: &HashSet<String>) -> Result<Checked, String> {
    let empty = empty_matcher(&w);
    let Written {
        name,
        scope,
        path_regex,
        user_agent_regex,
        headers_regex,
        remote_addresses,
        methods,
        who,
        action,
        weight,
        import,
    } = w;
    if import.is_some() {
        return Err("imports are not supported; copy the rules in".to_string());
    }
    let name = name
        .filter(|n| !n.is_empty())
        .ok_or("a rule needs a name")?;
    if seen.contains(&name) {
        return Err(format!("the name {name} is used twice"));
    }
    let action = action.ok_or("a rule needs an action")?;
    let adjust = match (action, weight) {
        (Action::Weigh, Some(Weight { adjust }))
            if (-ADJUST_MAX..=ADJUST_MAX).contains(&adjust) =>
        {
            adjust
        }
        (Action::Weigh, Some(_)) => {
            return Err(format!("weight.adjust is -{ADJUST_MAX} to {ADJUST_MAX}"));
        }
        (Action::Weigh, None) => return Err("WEIGH needs weight.adjust".to_string()),
        (Action::Allow | Action::Deny | Action::Challenge, Some(_)) => {
            return Err("weight is only for WEIGH".to_string());
        }
        (Action::Allow | Action::Deny | Action::Challenge, None) => 0,
    };
    if who.is_some() && scope != Scope::Api {
        return Err("who needs scope: api".to_string());
    }
    if let Some(field) = empty {
        return Err(format!(
            "rule {name}: {field} is empty; a matcher must say what it matches"
        ));
    }
    let matchers = [
        path_regex.is_some(),
        user_agent_regex.is_some(),
        headers_regex.is_some(),
        remote_addresses.is_some(),
        methods.is_some(),
        who.is_some(),
    ];
    if !matchers.contains(&true) {
        return Err(format!(
            "rule {name}: no matcher; a rule must say what it matches"
        ));
    }
    Ok(Checked {
        name,
        scope,
        path: path_regex,
        user_agent: user_agent_regex,
        headers: headers_regex
            .unwrap_or_default()
            .into_iter()
            .map(|(header, source)| (header.to_ascii_lowercase(), source))
            .collect(),
        nets: remote_addresses.unwrap_or_default(),
        methods: methods.unwrap_or_default(),
        who,
        action,
        adjust,
    })
}

/// One item of `bots`, checked inside its own mapping so a refusal carries the rule's line.
struct Item<'a>(&'a mut Vec<Checked>, &'a mut HashSet<String>);

impl<'de> Visitor<'de> for Item<'_> {
    type Value = ();

    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("a rule")
    }

    fn visit_map<A: MapAccess<'de>>(self, map: A) -> Result<(), A::Error> {
        let Item(rules, seen) = self;
        if rules.len() >= RULES_MAX {
            return Err(A::Error::custom(format!("at most {RULES_MAX} rules")));
        }
        let written = Written::deserialize(MapAccessDeserializer::new(map))?;
        let rule = checked(written, seen).map_err(A::Error::custom)?;
        seen.insert(rule.name.clone());
        rules.push(rule);
        Ok(())
    }
}

impl<'de> DeserializeSeed<'de> for Item<'_> {
    type Value = ();

    fn deserialize<D: Deserializer<'de>>(self, d: D) -> Result<(), D::Error> {
        d.deserialize_map(self)
    }
}

struct Bots;

impl<'de> Visitor<'de> for Bots {
    type Value = Vec<Checked>;

    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("a list of rules")
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Vec<Checked>, A::Error> {
        let (mut rules, mut seen) = (Vec::new(), HashSet::new());
        while seq
            .next_element_seed(Item(&mut rules, &mut seen))?
            .is_some()
        {}
        match rules.is_empty() {
            true => Err(A::Error::custom(NO_RULES)),
            false => Ok(rules),
        }
    }

    fn visit_unit<E: Error>(self) -> Result<Vec<Checked>, E> {
        Err(E::custom(NO_RULES))
    }
}

fn bots<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<Checked>, D::Error> {
    d.deserialize_seq(Bots)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct File {
    #[serde(deserialize_with = "bots")]
    bots: Vec<Checked>,
}

struct Rule {
    name: String,
    scope: Scope,
    path: Option<usize>,
    user_agent: Option<usize>,
    /// (which header set, which regex of it)
    headers: Vec<(usize, usize)>,
    nets: Vec<Cidr>,
    methods: Vec<String>,
    who: Option<Who>,
    action: Action,
    adjust: i32,
}

/// Rules run top down. Every regex of one field is in one set, so a request costs one pass per
/// field however many rules there are.
pub struct Policy {
    rules: Vec<Rule>,
    paths: RegexSet,
    user_agents: RegexSet,
    headers: Vec<(String, RegexSet)>,
}

fn slot(sources: &mut Vec<String>, source: Option<String>) -> Option<usize> {
    source.map(|s| {
        sources.push(s);
        sources.len() - 1
    })
}

fn set(sources: &[String]) -> Result<RegexSet, PolicyError> {
    RegexSet::new(sources).map_err(|e| PolicyError {
        line: None,
        reason: format!("the rules' regexes are too large together: {e}"),
    })
}

impl Policy {
    /// The policy of a YAML file. A refusal names the line and the reason.
    pub fn parse(yaml: &str) -> Result<Policy, PolicyError> {
        if yaml.len() > POLICY_MAX {
            return Err(PolicyError {
                line: None,
                reason: "the policy file is over 1 MiB".to_string(),
            });
        }
        let File { bots } = serde_norway::from_str(yaml).map_err(|e| {
            let marks = Regex::new(" at line [0-9]+ column [0-9]+").expect("a regex");
            PolicyError {
                line: e.location().map(|l| l.line()),
                reason: marks.replace_all(&e.to_string(), "").into_owned(),
            }
        })?;
        let (mut paths, mut user_agents) = (Vec::new(), Vec::new());
        let mut headers: Vec<(String, Vec<String>)> = Vec::new();
        let rules = bots
            .into_iter()
            .map(|c| {
                let Checked {
                    name,
                    scope,
                    path,
                    user_agent,
                    headers: wanted,
                    nets,
                    methods,
                    who,
                    action,
                    adjust,
                } = c;
                let wanted = wanted
                    .into_iter()
                    .map(|(header, source)| {
                        let at = headers
                            .iter()
                            .position(|(h, _)| *h == header)
                            .unwrap_or_else(|| {
                                headers.push((header, Vec::new()));
                                headers.len() - 1
                            });
                        headers[at].1.push(source);
                        (at, headers[at].1.len() - 1)
                    })
                    .collect();
                Rule {
                    name,
                    scope,
                    path: slot(&mut paths, path),
                    user_agent: slot(&mut user_agents, user_agent),
                    headers: wanted,
                    nets,
                    methods,
                    who,
                    action,
                    adjust,
                }
            })
            .collect();
        Ok(Policy {
            rules,
            paths: set(&paths)?,
            user_agents: set(&user_agents)?,
            headers: headers
                .into_iter()
                .map(|(header, sources)| Ok((header, set(&sources)?)))
                .collect::<Result<_, PolicyError>>()?,
        })
    }

    /// The policy without a file: one rule, `browsers`, that challenges browsers on pages.
    pub fn builtin() -> Policy {
        Policy::parse(BUILTIN).expect("the built-in policy parses")
    }

    pub fn names(&self) -> impl Iterator<Item = &str> {
        self.rules.iter().map(|r| r.name.as_str())
    }

    /// Judges a request. A path, user agent or header that a rule reads and that is over 8 KiB
    /// is never read: the request is denied, so no padding can win an ALLOW, lower a weight, slip
    /// past a DENY or change which rule answers first.
    pub fn eval(&self, r: &Request) -> Verdict<'_> {
        let sent = |header: &str| {
            let found = r
                .headers
                .iter()
                .find(|(h, _)| h.eq_ignore_ascii_case(header));
            found.map_or("", |(_, value)| value)
        };
        let long = |set: &RegexSet, text: &str| !set.is_empty() && text.len() > FIELD_MAX;
        let cut = long(&self.paths, r.path)
            || long(&self.user_agents, r.user_agent)
            || self.headers.iter().any(|(h, set)| long(set, sent(h)));
        if cut {
            return Verdict {
                action: Some(Action::Deny),
                rule: None,
                weight: 0,
                cut,
            };
        }
        let paths = self.paths.matches(r.path);
        let user_agents = self.user_agents.matches(r.user_agent);
        let headers: Vec<_> = self
            .headers
            .iter()
            .map(|(h, set)| set.matches(sent(h)))
            .collect();
        let mut weight = 0;
        for rule in &self.rules {
            let scope = match (rule.scope, r.gate) {
                (Scope::Both, _) | (Scope::Pages, Gate::Pages) | (Scope::Api, Gate::Api(_)) => true,
                (Scope::Pages, Gate::Api(_)) | (Scope::Api, Gate::Pages) => false,
            };
            let matches = scope
                && rule.who.is_none_or(|w| r.gate == Gate::Api(w))
                && rule.path.is_none_or(|i| paths.matched(i))
                && rule.user_agent.is_none_or(|i| user_agents.matched(i))
                && rule
                    .headers
                    .iter()
                    .all(|(set, i)| headers[*set].matched(*i))
                && (rule.nets.is_empty() || rule.nets.iter().any(|n| n.contains(r.remote)))
                && (rule.methods.is_empty()
                    || rule
                        .methods
                        .iter()
                        .any(|m| m.eq_ignore_ascii_case(r.method)));
            match (matches, rule.action) {
                (false, _) => {}
                (true, Action::Weigh) => weight += rule.adjust,
                (true, action @ (Action::Allow | Action::Deny | Action::Challenge)) => {
                    return Verdict {
                        action: Some(action),
                        rule: Some(&rule.name),
                        weight,
                        cut,
                    };
                }
            }
        }
        Verdict {
            action: None,
            rule: None,
            weight,
            cut,
        }
    }
}
