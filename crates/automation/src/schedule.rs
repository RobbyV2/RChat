//! Schedules: when the next slot comes due. Times are unix seconds; slots follow the wall clock
//! of the automation's time zone.

use crate::validate::{Check, Problem, Reason};
use serde::{Deserialize, Serialize};
use std::fmt;
use std::str::FromStr;

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Day {
    Mon,
    Tue,
    Wed,
    Thu,
    Fri,
    Sat,
    Sun,
}

/// A wall-clock time, written `HH:MM`.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct Clock {
    pub hour: u8,
    pub minute: u8,
}

impl Clock {
    pub fn ok(self) -> bool {
        self.hour < 24 && self.minute < 60
    }
}

impl FromStr for Clock {
    type Err = String;

    fn from_str(s: &str) -> Result<Clock, String> {
        let two = |part: &str| match part.len() == 2 && part.bytes().all(|b| b.is_ascii_digit()) {
            true => part.parse::<u8>().ok(),
            false => None,
        };
        let clock = s
            .split_once(':')
            .and_then(|(h, m)| Some((two(h)?, two(m)?)))
            .map(|(hour, minute)| Clock { hour, minute });
        match clock {
            Some(c) if c.ok() => Ok(c),
            _ => Err(format!("not a time: {s}")),
        }
    }
}

impl TryFrom<String> for Clock {
    type Error = String;

    fn try_from(s: String) -> Result<Clock, String> {
        s.parse()
    }
}

impl fmt::Display for Clock {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        write!(f, "{:02}:{:02}", self.hour, self.minute)
    }
}

impl From<Clock> for String {
    fn from(c: Clock) -> String {
        c.to_string()
    }
}

#[derive(Clone, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Repeat {
    /// Once, at a unix time.
    Once {
        at: i64,
    },
    /// Every N minutes, counted from `from` or from the unix epoch.
    Every {
        minutes: u32,
    },
    /// At `minute` past every hour of the day that `every` divides.
    Hourly {
        every: u8,
        minute: u8,
    },
    /// Every N days, counted from the day of `from` or from 1970-01-01.
    Daily {
        every: u16,
        at: Clock,
    },
    Weekly {
        days: Vec<Day>,
        at: Clock,
    },
    /// On a day of the month; the last day when the month is shorter.
    Monthly {
        day: u8,
        at: Clock,
    },
}

#[derive(Clone, PartialEq, Eq, Debug, Serialize, Deserialize)]
pub struct Schedule {
    #[serde(flatten)]
    pub repeat: Repeat,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub until: Option<i64>,
}

pub const EVERY_MAX_MINUTES: u32 = 525_600;

/// Every problem of a schedule. `floor_minutes` is the shortest interval the instance allows.
pub fn problems(s: &Schedule, floor_minutes: u32) -> Vec<Problem> {
    let mut check = Check::default();
    let clock = |check: &mut Check, at: Clock| {
        if !at.ok() {
            check.add("at", Reason::OutOfRange);
        }
    };
    match &s.repeat {
        Repeat::Once { .. } => {}
        Repeat::Every { minutes } => check.range(
            "minutes",
            u64::from(*minutes),
            u64::from(floor_minutes),
            u64::from(EVERY_MAX_MINUTES),
        ),
        Repeat::Hourly { every, minute } => {
            let floor = u64::from(floor_minutes.div_ceil(60).max(1));
            check.range("every", u64::from(*every), floor, 24);
            check.range("minute", u64::from(*minute), 0, 59);
        }
        Repeat::Daily { every, at } => {
            check.range("every", u64::from(*every), 1, 366);
            clock(&mut check, *at);
        }
        Repeat::Weekly { days, at } => {
            let mut seen: Vec<Day> = days.clone();
            seen.sort();
            seen.dedup();
            if days.is_empty() || seen.len() != days.len() {
                check.add("days", Reason::OutOfRange);
            }
            clock(&mut check, *at);
        }
        Repeat::Monthly { day, at } => {
            check.range("day", u64::from(*day), 1, 31);
            clock(&mut check, *at);
        }
    }
    if let (Some(from), Some(until)) = (s.from, s.until)
        && until < from
    {
        check.add("until", Reason::OutOfRange);
    }
    check.done()
}

/// Whether a string could be an IANA time zone name. The database decides whether it is one.
pub fn zone_name_ok(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'/' | b'_' | b'+' | b'-'))
}

/// A slot missed by more than this is skipped after an outage.
pub const CATCH_UP_SECS: i64 = 3600;

#[cfg(feature = "tz")]
pub use zoned::{next, resume, zone};

#[cfg(feature = "tz")]
mod zoned {
    use super::{CATCH_UP_SECS, Clock, Day, Repeat, Schedule, zone_name_ok};
    use jiff::civil::{Date, DateTime, Weekday};
    use jiff::tz::{AmbiguousOffset, TimeZone};
    use jiff::{Timestamp, ToSpan};

    /// The time zone of an IANA name, from the system's database or the bundled one.
    pub fn zone(name: &str) -> Option<TimeZone> {
        match zone_name_ok(name) {
            true => TimeZone::get(name).ok(),
            false => None,
        }
    }

    /// The instant of a wall-clock time. A time the clock skips runs when the gap ends; a time
    /// the clock repeats runs the first time.
    fn instant(tz: &TimeZone, date: Date, at: Clock) -> Option<i64> {
        let wall: DateTime = date.at(
            i8::try_from(at.hour).ok()?,
            i8::try_from(at.minute).ok()?,
            0,
            0,
        );
        let ambiguous = tz.to_ambiguous_timestamp(wall);
        let ts = match ambiguous.offset() {
            AmbiguousOffset::Gap { .. } => {
                let before = ambiguous.earlier().ok()?;
                tz.following(before).next()?.timestamp()
            }
            AmbiguousOffset::Unambiguous { .. } | AmbiguousOffset::Fold { .. } => {
                ambiguous.earlier().ok()?
            }
        };
        Some(ts.as_second())
    }

    fn local_date(tz: &TimeZone, t: i64) -> Option<Date> {
        Some(tz.to_datetime(Timestamp::from_second(t).ok()?).date())
    }

    fn day_of(date: Date) -> Day {
        match date.weekday() {
            Weekday::Monday => Day::Mon,
            Weekday::Tuesday => Day::Tue,
            Weekday::Wednesday => Day::Wed,
            Weekday::Thursday => Day::Thu,
            Weekday::Friday => Day::Fri,
            Weekday::Saturday => Day::Sat,
            Weekday::Sunday => Day::Sun,
        }
    }

    fn days_between(from: Date, to: Date) -> Option<i64> {
        Some(i64::from(from.until(to).ok()?.get_days()))
    }

    /// The wall-clock slots from two days before `start`, far enough ahead to hold the next one.
    fn slots(repeat: &Repeat, tz: &TimeZone, start: Date, anchor: Date) -> Option<Vec<i64>> {
        let first = start.checked_sub(2.days()).ok()?;
        let dates = |n: i64| (0..n).filter_map(move |d| first.checked_add(d.days()).ok());
        let mut out = Vec::new();
        match repeat {
            Repeat::Once { .. } | Repeat::Every { .. } => {}
            Repeat::Hourly { every, minute } => {
                for date in dates(6) {
                    for hour in (0..24u8).filter(|h| h % (*every).max(1) == 0) {
                        out.extend(instant(
                            tz,
                            date,
                            Clock {
                                hour,
                                minute: *minute,
                            },
                        ));
                    }
                }
            }
            Repeat::Daily { every, at } => {
                let every = i64::from((*every).max(1));
                for date in dates(2 * every + 6) {
                    if days_between(anchor, date)?.rem_euclid(every) == 0 {
                        out.extend(instant(tz, date, *at));
                    }
                }
            }
            Repeat::Weekly { days, at } => {
                for date in dates(14).filter(|d| days.contains(&day_of(*d))) {
                    out.extend(instant(tz, date, *at));
                }
            }
            Repeat::Monthly { day, at } => {
                let mut month = first.first_of_month();
                for _ in 0..4 {
                    let day = i8::try_from(*day).ok()?.clamp(1, month.days_in_month());
                    out.extend(instant(tz, month.with().day(day).build().ok()?, *at));
                    month = month.checked_add(1.month()).ok()?;
                }
            }
        }
        Some(out)
    }

    /// The first slot after `after`, inside `from` and `until`.
    pub fn next(s: &Schedule, tz: &TimeZone, after: i64) -> Option<i64> {
        let slot = match &s.repeat {
            Repeat::Once { at } => Some(*at).filter(|at| *at > after),
            Repeat::Every { minutes } => {
                let step = i64::from((*minutes).max(1)) * 60;
                let anchor = s.from.unwrap_or(0);
                let k = ((after - anchor).div_euclid(step) + 1).max(0);
                Some(anchor + k * step)
            }
            repeat => {
                let start = local_date(tz, s.from.map_or(after, |from| from.max(after)))?;
                let anchor = match s.from {
                    Some(from) => local_date(tz, from)?,
                    None => Date::constant(1970, 1, 1),
                };
                slots(repeat, tz, start, anchor)?
                    .into_iter()
                    .filter(|t| *t > after && s.from.is_none_or(|from| *t >= from))
                    .min()
            }
        }?;
        match s.from.is_some_and(|from| slot < from) || s.until.is_some_and(|until| slot > until) {
            true => None,
            false => Some(slot),
        }
    }

    /// The slot to run when the worker comes back at `now` with `due` pending: `due` itself, as
    /// the one catch-up, unless it is more than an hour old, and then the next slot after `now`.
    pub fn resume(s: &Schedule, tz: &TimeZone, due: i64, now: i64) -> Option<i64> {
        match now - due > CATCH_UP_SECS {
            true => next(s, tz, now),
            false => Some(due),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn daily(at: &str) -> Schedule {
        Schedule {
            repeat: Repeat::Daily {
                every: 1,
                at: at.parse().expect("clock"),
            },
            from: None,
            until: None,
        }
    }

    fn paths(s: &Schedule, floor: u32) -> Vec<String> {
        problems(s, floor).into_iter().map(|p| p.path).collect()
    }

    #[test]
    fn a_clock_is_written_as_hours_and_minutes() {
        let c: Clock = "02:30".parse().expect("clock");
        assert_eq!((c.hour, c.minute), (2, 30));
        assert_eq!(c.to_string(), "02:30");
        assert_eq!(serde_json::to_string(&c).expect("json"), r#""02:30""#);
        assert_eq!(
            serde_json::from_str::<Clock>(r#""23:59""#)
                .expect("clock")
                .hour,
            23
        );
        for bad in [
            "24:00", "12:60", "2:30", "0230", "02:3", "ab:cd", "", "02:30:00",
        ] {
            assert!(bad.parse::<Clock>().is_err(), "{bad}");
            assert!(
                serde_json::from_str::<Clock>(&format!("\"{bad}\"")).is_err(),
                "{bad}"
            );
        }
    }

    #[test]
    fn a_schedule_has_a_stored_shape() {
        let s: Schedule = serde_json::from_str(
            r#"{"kind":"weekly","days":["mon","thu"],"at":"18:00","from":10,"until":20}"#,
        )
        .expect("schedule");
        assert_eq!(
            s,
            Schedule {
                repeat: Repeat::Weekly {
                    days: vec![Day::Mon, Day::Thu],
                    at: Clock {
                        hour: 18,
                        minute: 0
                    }
                },
                from: Some(10),
                until: Some(20),
            }
        );
        assert_eq!(
            serde_json::to_string(&daily("09:00")).expect("json"),
            r#"{"kind":"daily","every":1,"at":"09:00"}"#
        );
    }

    #[test]
    fn every_kind_has_its_limits() {
        let of = |repeat: Repeat| Schedule {
            repeat,
            from: None,
            until: None,
        };
        let at = Clock { hour: 9, minute: 0 };
        assert_eq!(
            paths(&of(Repeat::Every { minutes: 10 }), 10),
            [] as [&str; 0]
        );
        assert_eq!(paths(&of(Repeat::Every { minutes: 9 }), 10), ["minutes"]);
        assert_eq!(paths(&of(Repeat::Every { minutes: 9 }), 5), [] as [&str; 0]);
        assert_eq!(
            paths(&of(Repeat::Every { minutes: 525_601 }), 10),
            ["minutes"]
        );
        assert_eq!(
            paths(
                &of(Repeat::Hourly {
                    every: 24,
                    minute: 59
                }),
                10
            ),
            [] as [&str; 0]
        );
        assert_eq!(
            paths(
                &of(Repeat::Hourly {
                    every: 0,
                    minute: 0
                }),
                10
            ),
            ["every"]
        );
        assert_eq!(
            paths(
                &of(Repeat::Hourly {
                    every: 25,
                    minute: 60
                }),
                10
            ),
            ["every", "minute"]
        );
        assert_eq!(
            paths(
                &of(Repeat::Hourly {
                    every: 1,
                    minute: 0
                }),
                61
            ),
            ["every"]
        );
        assert_eq!(
            paths(&of(Repeat::Daily { every: 366, at }), 10),
            [] as [&str; 0]
        );
        assert_eq!(paths(&of(Repeat::Daily { every: 0, at }), 10), ["every"]);
        assert_eq!(paths(&of(Repeat::Daily { every: 367, at }), 10), ["every"]);
        assert_eq!(
            paths(&of(Repeat::Weekly { days: vec![], at }), 10),
            ["days"]
        );
        assert_eq!(
            paths(
                &of(Repeat::Weekly {
                    days: vec![Day::Mon, Day::Mon],
                    at
                }),
                10
            ),
            ["days"]
        );
        assert_eq!(
            paths(&of(Repeat::Monthly { day: 31, at }), 10),
            [] as [&str; 0]
        );
        assert_eq!(paths(&of(Repeat::Monthly { day: 0, at }), 10), ["day"]);
        assert_eq!(paths(&of(Repeat::Monthly { day: 32, at }), 10), ["day"]);
        let backwards = Schedule {
            from: Some(20),
            until: Some(10),
            ..daily("09:00")
        };
        assert_eq!(paths(&backwards, 10), ["until"]);
        let bad_clock = of(Repeat::Daily {
            every: 1,
            at: Clock {
                hour: 24,
                minute: 0,
            },
        });
        assert_eq!(paths(&bad_clock, 10), ["at"]);
    }

    #[test]
    fn zone_names_have_a_shape() {
        assert!(zone_name_ok("UTC"));
        assert!(zone_name_ok("America/Argentina/Buenos_Aires"));
        assert!(zone_name_ok("Etc/GMT+5"));
        assert!(!zone_name_ok(""));
        assert!(!zone_name_ok("Europe/Ber lin"));
        assert!(!zone_name_ok(&"a".repeat(65)));
    }

    #[cfg(feature = "tz")]
    #[test]
    fn zones_come_from_the_time_zone_database() {
        assert!(zone("Europe/Berlin").is_some());
        assert!(zone("UTC").is_some());
        assert!(zone("Mars/Olympus").is_none());
        assert!(zone("").is_none());
    }

    #[cfg(feature = "tz")]
    #[test]
    fn a_daily_slot_on_the_spring_forward_day_runs_at_03_00_and_once_on_the_fall_back_day() {
        let berlin = zone("Europe/Berlin").expect("zone");
        let s = daily("02:30");
        assert_eq!(next(&s, &berlin, 1_711_800_000), Some(1_711_846_800));
        assert_eq!(next(&s, &berlin, 1_729_944_000), Some(1_729_989_000));
        assert_eq!(next(&s, &berlin, 1_729_989_000), Some(1_730_079_000));
    }

    #[cfg(feature = "tz")]
    #[test]
    fn a_slot_is_always_after_the_asked_time_and_slots_never_repeat() {
        let zones = [
            "UTC",
            "Europe/Berlin",
            "America/New_York",
            "Asia/Kolkata",
            "Australia/Lord_Howe",
        ];
        let at = Clock {
            hour: 2,
            minute: 30,
        };
        let repeats = [
            Repeat::Every { minutes: 45 },
            Repeat::Hourly {
                every: 1,
                minute: 30,
            },
            Repeat::Hourly {
                every: 5,
                minute: 0,
            },
            Repeat::Daily { every: 1, at },
            Repeat::Daily { every: 7, at },
            Repeat::Weekly {
                days: vec![Day::Sun, Day::Wed],
                at,
            },
            Repeat::Monthly { day: 31, at },
        ];
        for name in zones {
            let tz = zone(name).expect("zone");
            for repeat in &repeats {
                let s = Schedule {
                    repeat: repeat.clone(),
                    from: None,
                    until: None,
                };
                for start in [1_709_000_000, 1_711_840_000, 1_729_980_000, 1_735_600_000] {
                    let mut t = start;
                    for _ in 0..40 {
                        let n = next(&s, &tz, t).expect("slot");
                        assert!(n > t, "{name} {repeat:?} {t}");
                        t = n;
                    }
                }
            }
        }
    }

    #[cfg(feature = "tz")]
    #[test]
    fn after_an_outage_a_slot_missed_by_more_than_an_hour_is_skipped() {
        let utc = zone("UTC").expect("zone");
        let s = daily("09:00");
        let due = 1_714_554_000;
        assert_eq!(resume(&s, &utc, due, due + 1200), Some(due));
        assert_eq!(resume(&s, &utc, due, due + 3600), Some(due));
        assert_eq!(resume(&s, &utc, due, due + 3601), Some(due + 86_400));
        assert_eq!(resume(&s, &utc, due, due - 500), Some(due));
        assert_eq!(CATCH_UP_SECS, 3600);
    }
}
