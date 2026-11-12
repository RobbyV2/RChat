//! The giveaway draw: uniform, seeded, and the same for anyone who holds the seed.

use rand_chacha::ChaCha20Rng;
use rand_chacha::rand_core::{Rng, SeedableRng};

pub type Seed = [u8; 32];

pub fn seed_to_hex(seed: &Seed) -> String {
    seed.iter().map(|b| format!("{b:02x}")).collect()
}

pub fn seed_from_hex(hex: &str) -> Option<Seed> {
    if hex.len() != 64 || !hex.is_ascii() {
        return None;
    }
    let mut seed = [0u8; 32];
    for (i, byte) in seed.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&hex[2 * i..2 * i + 2], 16).ok()?;
    }
    Some(seed)
}

/// A number below `bound`, every one as likely as another.
fn below(rng: &mut ChaCha20Rng, bound: u64) -> u64 {
    let zone = u64::MAX - (u64::MAX % bound + 1) % bound;
    loop {
        let x = rng.next_u64();
        if x <= zone {
            return x % bound;
        }
    }
}

/// Up to `n` winners among the entrants. The entrants are sorted by name first and each name
/// counts once, so the draw depends only on who entered and on the seed: the numbers are the
/// ChaCha20 stream of the seed read as little-endian 64-bit words, and winner `i` is swapped in
/// from the entrants not yet drawn.
pub fn draw(entries: &[String], n: usize, seed: &Seed) -> Vec<String> {
    let mut pool: Vec<&String> = entries.iter().collect();
    pool.sort();
    pool.dedup();
    let mut rng = ChaCha20Rng::from_seed(*seed);
    let winners = n.min(pool.len());
    for i in 0..winners {
        let j = i + below(&mut rng, (pool.len() - i) as u64) as usize;
        pool.swap(i, j);
    }
    pool[..winners].iter().map(|w| w.to_string()).collect()
}

/// A draw that leaves past winners out.
pub fn reroll(entries: &[String], past: &[String], n: usize, seed: &Seed) -> Vec<String> {
    let left: Vec<String> = entries
        .iter()
        .filter(|e| !past.contains(e))
        .cloned()
        .collect();
    draw(&left, n, seed)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(n: usize) -> Vec<String> {
        (0..n).map(|i| format!("user{i:03}")).collect()
    }

    #[test]
    fn a_fixed_seed_gives_fixed_winners() {
        let seed = [7u8; 32];
        let first = draw(&names(50), 3, &seed);
        assert_eq!(first.len(), 3);
        assert_eq!(draw(&names(50), 3, &seed), first);
        let mut shuffled = names(50);
        shuffled.reverse();
        shuffled.push("user010".into());
        assert_eq!(draw(&shuffled, 3, &seed), first);
        assert_ne!(draw(&names(50), 3, &[8u8; 32]), first);
    }

    #[test]
    fn never_a_winner_twice_and_never_more_winners_than_entrants() {
        for seed in 0..50u8 {
            let winners = draw(&names(20), 20, &[seed; 32]);
            let mut sorted = winners.clone();
            sorted.sort();
            assert_eq!(sorted, names(20));
        }
        assert_eq!(draw(&names(2), 5, &[1; 32]).len(), 2);
        assert!(draw(&[], 3, &[1; 32]).is_empty());
        assert!(draw(&names(5), 0, &[1; 32]).is_empty());
    }

    #[test]
    fn a_reroll_leaves_past_winners_out() {
        let seed = [3u8; 32];
        let first = draw(&names(10), 4, &seed);
        let again = reroll(&names(10), &first, 4, &[4u8; 32]);
        assert_eq!(again.len(), 4);
        assert!(again.iter().all(|w| !first.contains(w)));
        assert_eq!(
            reroll(&names(4), &first, 4, &seed).len(),
            4 - first.iter().filter(|w| names(4).contains(w)).count()
        );
    }

    #[test]
    fn seeds_are_written_as_hex() {
        let seed =
            seed_from_hex("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f")
                .expect("seed");
        assert_eq!(seed[31], 31);
        assert_eq!(
            seed_to_hex(&seed),
            "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"
        );
        assert_eq!(seed_from_hex("00"), None);
        assert_eq!(seed_from_hex(&"zz".repeat(32)), None);
    }

    #[test]
    fn ten_thousand_seeded_draws_are_uniform() {
        let entries = names(10);
        let mut wins = [0u32; 10];
        for i in 0..10_000u32 {
            let mut seed = [0u8; 32];
            seed[..4].copy_from_slice(&i.to_le_bytes());
            let winner = &draw(&entries, 1, &seed)[0];
            wins[entries.iter().position(|e| e == winner).expect("entrant")] += 1;
        }
        let expected = 1000.0;
        let chi: f64 = wins
            .iter()
            .map(|&w| (f64::from(w) - expected).powi(2) / expected)
            .sum();
        assert!(
            chi < 27.88,
            "chi-square {chi} with 9 degrees of freedom: {wins:?}"
        );
    }
}
