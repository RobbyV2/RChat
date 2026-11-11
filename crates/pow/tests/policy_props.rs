//! The policy parser and evaluator over generated mutants of the example file. Nothing panics,
//! what parses obeys the format's rules, and the digest of every answer is pinned, so a debug
//! build and a release build must agree.

use std::net::IpAddr;

use rchat_pow::policy::{Action, FIELD_MAX, Gate, Policy, Request, Who};
use sha2::{Digest, Sha256};

const EXAMPLE: &str = include_str!("../examples/pow-policy.example.yaml");
const CASES: usize = 4_000;

struct Gen(u64);

impl Gen {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0.wrapping_mul(0x2545_f491_4f6c_dd1d)
    }

    fn below(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }

    fn pick<'a>(&mut self, pool: &[&'a str]) -> &'a str {
        pool[self.below(pool.len())]
    }
}

const EMPTY: &[&str] = &[
    "    remote_addresses: []",
    "    remote_addresses:",
    "    methods: []",
    "    headers_regex: {}",
    "    path_regex: \"\"",
    "    user_agent_regex: ''",
];

const LINES: &[&str] = &[
    "    scope: api",
    "    scope: everywhere",
    "    who: guest",
    "    who: account",
    "    methods: [GET, post]",
    "    methods: [[[[[[[[]]]]]]]]",
    "    remote_addresses: [\"10.0.0.0/8\", \"::ffff:192.0.2.0/120\", \"10.0.0.0/33\"]",
    "    path_regex: ^/(a|b)[0-9]{2,}$",
    "    path_regex: (",
    "    user_agent_regex: &anchor (?i)bot",
    "    user_agent_regex: *anchor",
    "    headers_regex:",
    "      Accept: text/html",
    "    action: ALLOW",
    "    action: DENY",
    "    action: WEIGH",
    "    weight:",
    "      adjust: 64",
    "      adjust: -2147483648",
    "      adjust: 9223372036854775808",
    "      adjust: -65",
    "  - name: extra",
    "  - import: (data)/bots/ai.yaml",
    "bots:",
    "bots: []",
    "\tname: tab",
    "---",
    "? [a, b]",
];

/// A mutant, and whether one of its lines is a matcher that is written but empty.
fn mutant(g: &mut Gen) -> (String, bool) {
    let mut lines: Vec<String> = EXAMPLE.lines().map(String::from).collect();
    for _ in 0..1 + g.below(3) {
        let at = g.below(lines.len());
        match g.below(8) {
            0 => {
                lines.remove(at);
            }
            1 => lines.insert(at, lines[at].clone()),
            2 => lines[at] = g.pick(LINES).to_string(),
            3 => lines.insert(at, g.pick(LINES).to_string()),
            4 => {
                let cut = g.below(lines[at].len() + 1);
                let cut = (0..=cut)
                    .rev()
                    .find(|i| lines[at].is_char_boundary(*i))
                    .unwrap();
                lines[at].insert_str(
                    cut,
                    g.pick(&["[", "]", "{", ":", "#", "\"", "'", " ", "-", "\u{e9}", "8"]),
                );
            }
            5 => lines.truncate(at + 1),
            6 => {
                lines[at] =
                    lines[at].replace("8", g.pick(&["-64", "64", "65", "-2147483648", "1e3", ""]))
            }
            _ => lines.insert(at, g.pick(EMPTY).to_string()),
        }
    }
    let emptied = lines.iter().any(|l| EMPTY.contains(&l.as_str()));
    (lines.join("\n"), emptied)
}

#[test]
fn mutants_of_the_example_never_panic_and_obey_the_format() {
    let mut g = Gen(11);
    let mut seen = Sha256::new();
    let (mut parsed, mut refused) = (0, 0);
    let agents = ["Mozilla/5.0", "GPTBot/1.2", "curl/8.9", "", "\u{e9}"];
    let addresses = [
        "203.0.113.9",
        "198.51.100.7",
        "2001:db8:42::1",
        "::ffff:10.1.2.3",
        "192.0.2.1",
    ];
    for case in 0..CASES {
        let (yaml, emptied) = mutant(&mut g);
        let answer = match Policy::parse(&yaml) {
            Ok(policy) => {
                parsed += 1;
                let names: Vec<&str> = policy.names().collect();
                assert!(
                    !names.is_empty(),
                    "case {case}: a policy has a rule\n{yaml}"
                );
                assert!(
                    !emptied,
                    "case {case}: an empty matcher never parses\n{yaml}"
                );
                let verdicts: Vec<String> = (0..3)
                    .map(|_| {
                        let long = format!("Mozilla/5.0 {}", "a".repeat(FIELD_MAX));
                        let padded = g.below(4);
                        let agent = match padded {
                            1 => long.as_str(),
                            _ => g.pick(&agents),
                        };
                        let language = match padded {
                            2 => long.as_str(),
                            _ => g.pick(&["", "en"]),
                        };
                        let language = [("Accept-Language", language)];
                        let headers = &language[..g.below(2)];
                        let request = Request {
                            gate: [Gate::Pages, Gate::Api(Who::Guest), Gate::Api(Who::Account)]
                                [g.below(3)],
                            method: g.pick(&["GET", "post", ""]),
                            path: match padded {
                                3 => long.as_str(),
                                _ => g.pick(&["/", "/a12", "/s/lobby/"]),
                            },
                            user_agent: agent,
                            headers,
                            remote: g.pick(&addresses).parse::<IpAddr>().unwrap(),
                        };
                        let verdict = policy.eval(&request);
                        assert!(verdict.weight.abs() <= 64 * names.len() as i32);
                        assert!(!verdict.cut || padded != 0, "nothing was long\n{yaml}");
                        match verdict.cut {
                            true => assert_eq!(
                                (verdict.action, verdict.rule, verdict.weight),
                                (Some(Action::Deny), None, 0),
                                "a long field is denied unread\n{yaml}"
                            ),
                            false => assert_eq!(verdict.action.is_some(), verdict.rule.is_some()),
                        }
                        format!("{verdict:?}")
                    })
                    .collect();
                format!("{names:?} {verdicts:?}")
            }
            Err(e) => {
                refused += 1;
                assert!(!e.reason.is_empty());
                assert!(
                    e.line
                        .is_none_or(|l| l >= 1 && l <= yaml.lines().count() + 1),
                    "{e}\n{yaml}"
                );
                e.to_string()
            }
        };
        seen.update((answer.len() as u64).to_le_bytes());
        seen.update(answer);
    }
    assert!(
        parsed > CASES / 20 && refused > CASES / 20,
        "{parsed} parsed, {refused} refused"
    );
    let digest: String = seen.finalize().iter().map(|b| format!("{b:02x}")).collect();
    assert_eq!(
        digest,
        "17104ecd06b78799ce76438c6a5b338d07b71beb3ca6151ea5259d322372f73e"
    );
}
