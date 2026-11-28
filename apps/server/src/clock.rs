//! Wall time as the server sees it. Code that needs the time takes it from the `Clock` of its
//! `AppState`, so a test sets it. Durations and timers use `tokio::time`, which tests pause.
//! Only this module reads the machine's clock.

#![allow(clippy::disallowed_methods)]

use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Clone, Debug, Default)]
pub struct Clock(Source);

#[derive(Clone, Debug, Default)]
enum Source {
    #[default]
    System,
    /// Unix milliseconds, moved by hand.
    Set(Arc<AtomicI64>),
}

impl Clock {
    /// The machine's clock.
    pub fn system() -> Clock {
        Clock(Source::System)
    }

    /// A clock that shows `unix` seconds until it is set or advanced. Its clones move with it.
    pub fn fixed(unix: i64) -> Clock {
        Clock(Source::Set(Arc::new(AtomicI64::new(
            unix.saturating_mul(1000),
        ))))
    }

    /// Unix seconds.
    pub fn unix(&self) -> i64 {
        self.unix_ms().div_euclid(1000)
    }

    pub fn unix_ms(&self) -> i64 {
        match &self.0 {
            Source::System => SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0),
            Source::Set(at) => at.load(Ordering::SeqCst),
        }
    }

    /// Sets a fixed clock to `unix` seconds. The machine's clock stays as it is.
    pub fn set(&self, unix: i64) {
        if let Source::Set(at) = &self.0 {
            at.store(unix.saturating_mul(1000), Ordering::SeqCst);
        }
    }

    /// Moves a fixed clock `seconds` forward. The machine's clock stays as it is.
    pub fn advance(&self, seconds: i64) {
        if let Source::Set(at) = &self.0 {
            at.fetch_add(seconds.saturating_mul(1000), Ordering::SeqCst);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_system_clock_shows_the_machine_time_in_both_units() {
        let before = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        let clock = Clock::system();
        let ms = clock.unix_ms();
        let s = clock.unix();
        assert!(s >= before && s <= before + 60);
        assert!(ms / 1000 >= before && ms / 1000 <= s + 1);
        clock.set(5);
        clock.advance(100);
        assert!(clock.unix() >= before);
    }

    #[test]
    fn a_fixed_clock_moves_only_by_hand_and_its_clones_move_with_it() {
        let clock = Clock::fixed(1_000);
        let seen = clock.clone();
        assert_eq!((seen.unix(), seen.unix_ms()), (1_000, 1_000_000));
        clock.advance(30);
        assert_eq!(seen.unix(), 1_030);
        seen.set(7);
        assert_eq!((clock.unix(), clock.unix_ms()), (7, 7_000));
    }
}
