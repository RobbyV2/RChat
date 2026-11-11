//! Every function of the crate that reads outside input, run over generated input that leans on
//! the edges. None may panic, each agrees with a reference written in wider arithmetic, and the
//! digest of all its answers is pinned, so a debug build and a release build must agree.

use rchat_pow::*;
use sha2::{Digest, Sha256};

const KEY: &[u8] = b"0123456789abcdef0123456789abcdef";
const CASES: usize = 20_000;

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

    fn pick<'a, T: ?Sized>(&mut self, pool: &[&'a T]) -> &'a T {
        pool[self.below(pool.len())]
    }

    /// A number, more often than not at an edge.
    fn number(&mut self) -> u64 {
        match self.below(9) {
            0 => 0,
            1 => 1,
            2 => u64::MAX,
            3 => u64::MAX - self.below(3) as u64,
            4 => 1 << self.below(64),
            5 => (1u64 << self.below(64)).wrapping_sub(1),
            6 => self.below(100_000) as u64,
            7 => u64::from(u32::MAX)
                .wrapping_add(self.below(3) as u64)
                .wrapping_sub(1),
            _ => self.next(),
        }
    }

    fn text(&mut self, pieces: &[&str], most: usize) -> String {
        (0..self.below(most + 1))
            .map(|_| self.pick(pieces))
            .collect()
    }
}

struct Seen(Sha256);

impl Seen {
    fn new() -> Seen {
        Seen(Sha256::new())
    }

    fn add(&mut self, answer: impl std::fmt::Debug) {
        let text = format!("{answer:?}");
        self.0.update((text.len() as u64).to_le_bytes());
        self.0.update(text);
    }

    fn digest(self) -> String {
        self.0
            .finalize()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect()
    }
}

fn number_text(g: &mut Gen) -> String {
    let n = g.number();
    match g.below(8) {
        0 => format!("{}", u128::from(n) + 1),
        1 => format!("-{n}"),
        2 => format!("+{n}"),
        3 => format!(" {n} "),
        4 => format!("0{n}"),
        _ => n.to_string(),
    }
}

#[test]
fn range_headers() {
    fn reference(header: Option<&str>) -> u64 {
        let number = |t: &str| t.parse::<u64>().ok().map(u128::from);
        let asked = (|| {
            let spec = header?.trim().strip_prefix("bytes=")?;
            if spec.contains(',') {
                return None;
            }
            let (a, b) = spec.split_once('-')?;
            match (a.trim(), b.trim()) {
                ("", n) => number(n),
                (_, "") => None,
                (a, b) => {
                    let (a, b) = (number(a)?, number(b)?);
                    (b >= a).then(|| b - a + 1)
                }
            }
        })();
        let cap = u128::from(BULK_PART_MAX);
        asked.filter(|n| *n > 0).map_or(cap, |n| n.min(cap)) as u64
    }
    let mut g = Gen(1);
    let mut seen = Seen::new();
    for _ in 0..CASES {
        let header = match g.below(4) {
            0 => format!("bytes={}-{}", number_text(&mut g), number_text(&mut g)),
            1 => format!("bytes=-{}", number_text(&mut g)),
            2 => format!("bytes={}-", number_text(&mut g)),
            _ => {
                let pieces = [
                    "bytes=", "bytes", "=", "-", ",", " ", "items=", "0", "9", "x", "\u{e9}",
                ];
                let mut text = g.text(&pieces, 6);
                text.push_str(&number_text(&mut g));
                text
            }
        };
        let asked = match g.below(20) {
            0 => None,
            _ => Some(header.as_str()),
        };
        let got = BulkAsk::range(asked);
        assert_eq!(
            got,
            BulkAsk::MediaRange {
                bytes: reference(asked)
            },
            "{asked:?}"
        );
        assert!((1..=8).contains(&got.cost()), "{asked:?}");
        seen.add((asked, got, got.cost()));
    }
    assert_eq!(
        seen.digest(),
        "592495906a0dace7998eb0d47501df43dcde9752879bf6a26d2982e8e3a9f5a7"
    );
}

#[test]
fn page_limits_and_scope_counts() {
    let mut g = Gen(2);
    let mut seen = Seen::new();
    for _ in 0..CASES {
        let text = match g.below(6) {
            0 => g.text(&["a", "1", ".", "e", " ", "-", "\u{661}"], 5),
            _ => number_text(&mut g),
        };
        let limit = (g.below(20) != 0).then_some(text.as_str());
        let want = limit
            .and_then(|l| l.trim().parse::<i128>().ok())
            .filter(|n| *n >= i128::from(i64::MIN) && *n <= i128::from(i64::MAX))
            .map_or(BULK_PAGE_DEFAULT, |n| {
                n.clamp(1, i128::from(BULK_PAGE_MAX)) as i64
            });
        let got = BulkAsk::page(limit);
        assert_eq!(got, BulkAsk::Page { messages: want }, "{limit:?}");
        assert!((1..=50).contains(&got.cost()));
        let scopes = g.number() as usize;
        let changes = BulkAsk::changes(scopes);
        assert_eq!(
            changes,
            BulkAsk::Changes {
                scopes: scopes.clamp(1, BULK_SCOPES_MAX)
            }
        );
        assert!((1..=10).contains(&changes.cost()));
        let raw = [
            BulkAsk::Page {
                messages: g.number() as i64,
            },
            BulkAsk::MediaRange { bytes: g.number() },
            BulkAsk::Changes { scopes },
            BulkAsk::MediaBatch,
        ];
        seen.add((limit, got, changes, raw.map(BulkAsk::cost)));
    }
    assert_eq!(
        seen.digest(),
        "2ecd430c601c369eb9af8a4296e7c0575f4a014060a1758c1980e30f1a5c529b"
    );
}

#[test]
fn nonces_on_the_wire() {
    let mut g = Gen(3);
    let mut seen = Seen::new();
    for _ in 0..CASES {
        let k = match g.below(8) {
            0 => u32::MAX,
            1 => K_MAX + 1,
            2 => K_MAX,
            3 => g.number() as u32,
            _ => g.below(6) as u32,
        };
        let length = match g.below(6) {
            0 => g.below(40),
            1 => (k as usize).min(70) * 16 + 1,
            2 => ((k as usize).min(70) * 16).saturating_sub(1),
            _ => (k as usize).min(70) * 16,
        };
        let alphabet: &[&str] = match g.below(4) {
            0 => &["0", "f", "A", "g", " ", "\u{e9}"],
            _ => &["0", "1", "7", "9", "a", "c", "f"],
        };
        let text: String = (0..length).map(|_| g.pick(alphabet)).collect();
        let got = decode_nonces(&text, k);
        if let Some(nonces) = &got {
            assert_eq!(nonces.len(), k as usize);
            assert!(k <= K_MAX);
            assert_eq!(encode_nonces(nonces), text);
        }
        let seed = seed_of(&text);
        let verified = got
            .as_ref()
            .is_some_and(|n| verify(&seed, k, g.number(), n));
        seen.add((k, &text, &got, verified));
    }
    assert_eq!(
        seen.digest(),
        "0d77546bec4456ae58bc49315e4a2b8f9c02a8fd4f9cf5f5bac2413f72fb820e"
    );
}

#[test]
fn sealed_strings() {
    let key_of = |kid: &str| (kid == "1" || kid == "12345678").then(|| KEY.to_vec());
    let mut g = Gen(4);
    let mut seen = Seen::new();
    for _ in 0..CASES {
        let kind = g.pick(&["c1", "t1", "g1"]);
        let kid = g.pick(&["1", "12345678"]);
        let payload: Vec<u8> = (0..g.below(40)).map(|_| g.next() as u8).collect();
        let sealed = seal(KEY, kind, kid, &payload);
        let mut text = sealed.clone();
        for _ in 0..g.below(3) {
            let at = g.below(text.len() + 1);
            let at = (0..=at).rev().find(|i| text.is_char_boundary(*i)).unwrap();
            match g.below(7) {
                0 => text.insert_str(at, g.pick(&[".", "A", "-", "=", " ", "\u{e9}", "9"])),
                1 if at < text.len() => {
                    text.remove(at);
                }
                2 => text.truncate(at),
                3 => text.push_str(&"A".repeat(g.below(SEALED_MAX + 8))),
                4 => text = text.replacen('.', g.pick(&["..", "", ".0x", ".9"]), 1),
                5 => text = text.to_uppercase(),
                _ => text = g.text(&["c1", "t1", ".", "1", "e30", "AAAA", "\u{e9}"], 9),
            }
        }
        let asked = g.pick(&["c1", "t1", "g1", "", "t"]);
        let opened = open(key_of, asked, &text);
        match &opened {
            Some(body) => {
                assert_eq!((asked, &text, body), (kind, &sealed, &payload));
                assert_eq!(kid_of(asked, &text), Some(kid));
            }
            None => assert!(asked != kind || text != sealed, "{text}"),
        }
        seen.add((asked, &text, kid_of(asked, &text), opened));
    }
    assert_eq!(
        seen.digest(),
        "244f3e4cdd34142c2ab70e665ba9731cc2d02031002d9fc9c1a90185f889da96"
    );
}

#[test]
fn client_ids_and_redirect_targets() {
    let mut g = Gen(5);
    let mut seen = Seen::new();
    let letters = [
        "A", "Q", "g", "w", "x", "_", "-", "0", "+", "/", "=", " ", "\u{e9}",
    ];
    let parts = [
        "/", "//", "\\", "\t", "\n", "\u{7f}", "\u{85}", "a", "%09", "?x=1", "#y", ":", "\u{e9}",
    ];
    for _ in 0..CASES {
        let id = match g.below(3) {
            0 => g.text(&letters, 24),
            _ => {
                let mut id: String = (0..21).map(|_| g.pick(&letters[..8])).collect();
                id.push_str(g.pick(&letters));
                id
            }
        };
        let shape = id.len() == 22
            && id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
            && "AQgw".contains(&id[21..]);
        assert_eq!(client_id_ok(&id), shape, "{id:?}");
        let mut to = g.text(&parts, 8);
        if g.below(50) == 0 {
            to.push_str(&"a".repeat(2040 + g.below(12)));
        }
        let target = safe_target(&to);
        let stays = to.len() <= 2048
            && to.starts_with('/')
            && !to.starts_with("//")
            && !to.chars().any(|c| c == '\\' || c.is_control());
        assert_eq!(target, if stays { to.as_str() } else { "/" }, "{to:?}");
        seen.add((&id, shape, &to, target));
    }
    assert_eq!(
        seen.digest(),
        "3111ffddfebf65eb109de77430d4afa26d565c4dc62c32770429dc1b95c78d13"
    );
}

#[test]
fn work_targets_and_lives() {
    let mut g = Gen(6);
    let mut seen = Seen::new();
    for _ in 0..CASES {
        let (k, work, rate) = (g.number() as u32, g.number(), g.number());
        let target = target_for(k, work);
        let sub = u128::from(k.clamp(1, K_MAX));
        let want = ((sub << 64) / u128::from(work).max(sub)).clamp(1, u128::from(u64::MAX));
        assert_eq!(u128::from(target), want, "{k} {work}");
        let life = life_secs(work, rate);
        let exact = 300 + u128::from(work).div_ceil(u128::from(rate).max(1));
        assert_eq!(
            u128::from(life),
            exact.min(u128::from(u64::MAX)),
            "{work} {rate}"
        );
        let (base, max) = (g.number(), g.number());
        let (score, load, step) = (g.number() as u32, g.number() as u32, g.number() as u32);
        let plain = work_for(base, score, step, max);
        let loaded = work_with_load(base, score, load, step, max);
        assert_eq!(plain.is_none(), loaded.is_none(), "load alone never waits");
        assert!(plain.is_none_or(|w| w <= max) && loaded.is_none_or(|w| w <= max));
        assert!(loaded >= plain);
        seen.add((target, work_of(k, target).to_bits(), life, plain, loaded));
    }
    assert_eq!(
        seen.digest(),
        "2de5b37e60c1d41e7463a337547e66ee4dabd5cd6fa3d2c2a544d835ebf90241"
    );
}

#[test]
fn spent_sets_and_bindings() {
    let mut g = Gen(7);
    let mut seen = Seen::new();
    let mut spent = SpentSet::default();
    let mut held: Vec<(String, u128)> = Vec::new();
    let words = [
        "",
        "alice",
        "ALICE",
        "alice ",
        "\u{130}",
        "203.0.113.9",
        "\0",
        "AAECAwQFBgcICQoLDA0ODw",
        "h:00ff",
    ];
    for round in 0..CASES {
        let r = format!("r{}", g.below(40));
        let (exp, now) = (g.number(), g.number());
        held.retain(|(_, until)| *until > u128::from(now));
        let fresh = !held.iter().any(|(name, _)| *name == r);
        if fresh {
            held.push((r.clone(), u128::from(exp) + 30));
        }
        assert_eq!(spent.spend(&r, exp, now), fresh, "round {round}");
        let (a, b, c) = (g.pick(&words), g.pick(&words), g.pick(&words));
        let callers = [
            Caller::Session(a),
            Caller::Guest {
                group: a,
                client: (g.below(2) == 0).then_some(b),
            },
            Caller::Signin {
                group: a,
                username: (g.below(2) == 0).then_some(b),
                client: Some(c),
            },
            Caller::Page {
                ua: a,
                group: (g.below(2) == 0).then_some(c),
            },
        ];
        let subs = callers.map(|caller| binding(KEY, caller));
        for sub in &subs {
            assert!(sub.split(',').all(|part| {
                part.len() == 22
                    && part.as_bytes()[1] == b':'
                    && part[2..].bytes().all(|d| d.is_ascii_hexdigit())
            }));
        }
        let who = requester((g.below(3) == 0).then_some(a), b, Some(c), a);
        seen.add((
            fresh,
            subs,
            who,
            username_key(b),
            challenge_of(a),
            verifier_ok(a, b),
        ));
    }
    assert_eq!(
        seen.digest(),
        "3f1bc828e1ff1292267c7cfd5d45690cd7a5424f4375ed1853a2cac533056e39"
    );
}
