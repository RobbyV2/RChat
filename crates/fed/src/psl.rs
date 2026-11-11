use std::collections::HashSet;
use std::sync::OnceLock;

const SNAPSHOT: &str = include_str!("../data/public_suffix_list.dat");
const PRIVATE: &str = "// ===BEGIN PRIVATE DOMAINS===";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum List {
    Icann,
    Full,
}

#[derive(Default)]
struct Rules {
    exact: HashSet<&'static str>,
    wildcard: HashSet<&'static str>,
    exception: HashSet<&'static str>,
    depth: usize,
}

impl Rules {
    fn parse(section: &'static str) -> Rules {
        let mut rules = Rules::default();
        for line in section
            .lines()
            .filter(|l| !l.is_empty() && !l.starts_with("//"))
        {
            let labels = line.split('.').count();
            rules.depth = rules.depth.max(labels);
            match (line.strip_prefix('!'), line.strip_prefix("*.")) {
                (Some(name), _) => rules.exception.insert(name),
                (None, Some(name)) => rules.wildcard.insert(name),
                (None, None) => rules.exact.insert(line),
            };
        }
        rules
    }

    fn len(&self) -> usize {
        self.exact.len() + self.wildcard.len() + self.exception.len()
    }
}

fn sections() -> &'static [Rules; 2] {
    static SECTIONS: OnceLock<[Rules; 2]> = OnceLock::new();
    SECTIONS.get_or_init(|| {
        let (icann, private) = SNAPSHOT.split_once(PRIVATE).unwrap_or((SNAPSHOT, ""));
        [Rules::parse(icann), Rules::parse(private)]
    })
}

fn used(list: List) -> &'static [Rules] {
    match list {
        List::Icann => &sections()[..1],
        List::Full => sections(),
    }
}

pub fn rules(list: List) -> usize {
    used(list).iter().map(Rules::len).sum()
}

pub fn depth() -> usize {
    sections()
        .iter()
        .map(|rules| rules.depth)
        .max()
        .unwrap_or(1)
}

fn starts(host: &str) -> Vec<usize> {
    let dots = host.match_indices('.').map(|(at, _)| at + 1);
    std::iter::once(0).chain(dots).collect()
}

fn suffix_start(host: &str, list: List) -> usize {
    let starts = starts(host);
    let rules = used(list);
    let tail = |i: usize| &host[starts[i]..];
    let candidates = starts.len().saturating_sub(depth())..starts.len();
    if let Some(i) = candidates
        .clone()
        .find(|i| rules.iter().any(|r| r.exception.contains(tail(*i))))
    {
        return starts.get(i + 1).copied().unwrap_or(host.len());
    }
    let matched = |i: usize| {
        rules.iter().any(|r| {
            r.exact.contains(tail(i))
                || starts
                    .get(i + 1)
                    .is_some_and(|_| r.wildcard.contains(tail(i + 1)))
        })
    };
    let last = starts.len() - 1;
    starts[candidates.clone().find(|i| matched(*i)).unwrap_or(last)]
}

pub fn public_suffix(host: &str, list: List) -> &str {
    &host[suffix_start(host, list)..]
}

pub fn registrable(host: &str, list: List) -> &str {
    let suffix = suffix_start(host, list);
    let before = starts(host)
        .into_iter()
        .take_while(|start| *start < suffix)
        .last();
    &host[before.unwrap_or(suffix.min(host.len()))..]
}
