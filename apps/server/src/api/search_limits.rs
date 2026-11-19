use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{LazyLock, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use axum::http::StatusCode;
use tokio::time::Instant;

use crate::api::budget::{self, Share, Shares};
use crate::api::{ApiError, lookup};
use crate::db::{User, pool_key};
use crate::limits::Limits;
use crate::limits::bucket::{Keyed, Policy};
use crate::state::AppState;

pub const TOO_MANY: &str = "Too many searches. Try again in a moment.";
pub const STILL_RUNNING: &str =
    "Another search of yours is still running. Try again when it is done.";
pub const FULL: &str =
    "This site is at capacity for searches right now. Try again in a few seconds.";
pub const REPLACED: &str = "A newer search of yours took the place of this one.";

/// How long a search waits for one of its caller's searches to end.
pub const OWN_WAIT: Duration = Duration::from_secs(5);
/// How long a search waits for a place in the process.
pub const SITE_WAIT: Duration = Duration::from_secs(2);

const PER_MINUTE: &str = "MESSAGE_SEARCH_PER_MINUTE";
const AT_ONCE: &str = "MESSAGE_SEARCH_AT_ONCE";
/// The `control` of the refusal when the process runs as many message searches as it allows.
pub const CONCURRENT: &str = "message_search_concurrent_limit";
/// How long a caller refused for a search in flight is told to wait.
const RUNNING_WAIT: Duration = Duration::from_secs(1);
/// Seconds a caller refused at capacity is told to wait.
const FULL_WAIT_SECS: u64 = 2;

/// Message searches per caller, under `policy`.
static TOKENS: LazyLock<Keyed> = LazyLock::new(|| Keyed::new(policy(&Limits::default()), 200_000));
static RUNNING: LazyLock<Shares> = LazyLock::new(Shares::default);
/// The number of the turn each caller has waiting for one of its places.
static WAITING: LazyLock<Mutex<HashMap<String, u64>>> = LazyLock::new(Default::default);
static TURNS: AtomicU64 = AtomicU64::new(0);

/// Message searches a caller holds at once when it gains `per_minute`: 10 of 30, at least 5.
pub fn burst(per_minute: u32) -> u32 {
    (per_minute.saturating_mul(10) / 30).max(5)
}

/// A caller's bucket of message searches: `burst` at once, then `MESSAGE_SEARCH_PER_MINUTE`.
fn policy(limits: &Limits) -> Policy {
    let per_minute = limits.message_search_per_minute;
    Policy::per_minute(burst(per_minute), per_minute)
}

/// Message searches this process runs at once: `MESSAGE_SEARCH_CONCURRENT_LIMIT`, or half the
/// connections its reads use, at least one.
pub fn concurrent(state: &AppState) -> u32 {
    state
        .limits
        .message_search_concurrent_limit
        .unwrap_or_else(|| (state.read().options().get_max_connections() / 2).max(1))
}

/// An admitted read holds one of its caller's places and one of the process's
/// until it is dropped.
#[must_use]
pub struct Admitted {
    _own: Share,
    _site: Share,
}

fn waiting() -> MutexGuard<'static, HashMap<String, u64>> {
    WAITING.lock().unwrap_or_else(PoisonError::into_inner)
}

/// A search's turn to wait for one of its caller's places. A caller has one turn at a time:
/// a newer one ends the one before.
struct Turn<'a> {
    who: &'a str,
    number: u64,
}

impl<'a> Turn<'a> {
    fn take(who: &'a str) -> Turn<'a> {
        let number = TURNS.fetch_add(1, Ordering::Relaxed);
        let ended = waiting().insert(who.to_string(), number).is_some();
        if ended {
            RUNNING.wake();
        }
        Turn { who, number }
    }

    fn current(&self) -> bool {
        waiting().get(self.who) == Some(&self.number)
    }

    async fn place(&self, key: &str, most: u64, wait: Duration) -> Option<Share> {
        RUNNING
            .take_by(key, 1, most, Instant::now() + wait, || self.current())
            .await
    }
}

impl Drop for Turn<'_> {
    fn drop(&mut self) {
        let mut waiting = waiting();
        if waiting.get(self.who) == Some(&self.number) {
            waiting.remove(self.who);
        }
    }
}

/// One of the `most` places `who` has at once. While they are all taken the search waits up to
/// `OWN_WAIT` for one to come free, unless a newer search of the caller starts to wait.
async fn own_place(who: &str, most: u64) -> Result<Share, ApiError> {
    let turn = Turn::take(who);
    match turn.place(who, most, OWN_WAIT).await {
        Some(own) => Ok(own),
        None if turn.current() => Err(lookup::limited(AT_ONCE, STILL_RUNNING, RUNNING_WAIT)),
        None => Err(lookup::limited(AT_ONCE, REPLACED, RUNNING_WAIT)),
    }
}

/// Admits one message search of `caller` (an account, or the client address of a guest) before
/// any of its queries runs. It takes one token of the caller's bucket, then one of the places
/// the caller has at once (`MESSAGE_SEARCH_AT_ONCE`), waiting up to `OWN_WAIT`, then one of the
/// process's (`concurrent`), waiting up to `SITE_WAIT`. A search that waits for one of its
/// caller's places gives way to a newer one of the same caller. Past the bucket, the wait for
/// the caller's places or a newer search, the refusal is 429 with the reason `rate`; past the
/// wait for the process's places it is 503 with the reason `capacity`. Only an admitted search
/// spends its token: one refused after its wait, replaced, or whose request went away while it
/// waited gives it back.
pub async fn admit(state: &AppState, caller: Option<&User>) -> Result<Admitted, ApiError> {
    let who = lookup::who(state, caller);
    let limits = &state.limits;
    let token = TOKENS
        .under(policy(limits))
        .hold(who.clone(), 1.0, std::time::Instant::now())
        .map_err(|wait| lookup::limited(PER_MINUTE, TOO_MANY, wait))?;
    let own = own_place(&who, u64::from(limits.message_search_at_once)).await?;
    let deadline = Instant::now() + SITE_WAIT;
    let most = u64::from(concurrent(state));
    let site = RUNNING
        .take_by(&pool_key(&state.db), 1, most, deadline, || true)
        .await
        .ok_or_else(|| {
            tracing::debug!("refused by the {CONCURRENT} limit");
            ApiError::capacity(
                StatusCode::SERVICE_UNAVAILABLE,
                FULL,
                CONCURRENT,
                Some(FULL_WAIT_SECS),
            )
        })?;
    token.spend();
    Ok(Admitted {
        _own: own,
        _site: site,
    })
}

fn list_key(state: &AppState, caller: Option<&User>) -> String {
    format!("interacted\n{}", lookup::who(state, caller))
}

#[cfg(test)]
pub(super) fn list_waiting(state: &AppState, caller: &User) -> bool {
    waiting().contains_key(&list_key(state, Some(caller)))
}

/// Admits one former-member list per caller. Lists share the process's search places
/// and reserve a reader for other requests when the pool has more than one.
pub(super) async fn admit_interacted(
    state: &AppState,
    caller: Option<&User>,
) -> Result<Admitted, ApiError> {
    let readers = state.read().options().get_max_connections();
    let who = list_key(state, caller);
    let turn = Turn::take(&who);
    let refused = |text, wait| {
        if turn.current() {
            lookup::limited("interacted", text, wait)
        } else {
            lookup::limited(
                "interacted",
                "A newer list request took the place of this one.",
                RUNNING_WAIT,
            )
        }
    };
    let own = turn.place(&who, 1, OWN_WAIT).await.ok_or_else(|| {
        refused(
            "Another list request of yours is still running.",
            RUNNING_WAIT,
        )
    })?;
    let most = concurrent(state).min(readers.saturating_sub(1).max(1));
    let full = || {
        refused(
            "This site is busy loading lists. Try again in a moment.",
            SITE_WAIT,
        )
    };
    let site = turn
        .place(&pool_key(&state.db), u64::from(most), SITE_WAIT)
        .await
        .filter(|_| turn.current())
        .ok_or_else(full)?;
    Ok(Admitted {
        _own: own,
        _site: site,
    })
}

impl Admitted {
    /// Runs the admitted work on its own task. The places stay held
    /// until the work ends, also when the request that started it goes away first.
    pub async fn run<T: Send + 'static>(
        self,
        work: impl Future<Output = T> + Send + 'static,
    ) -> Result<T, ApiError> {
        let client = budget::client();
        tokio::spawn(async move {
            let _held = self;
            match client {
                Some(ip) => budget::as_client(ip, work).await,
                None => work.await,
            }
        })
        .await
        .map_err(ApiError::internal)
    }
}

/// Whether a search of `who` waits for one of the caller's places.
#[cfg(test)]
fn waits_for_own(who: &str) -> bool {
    waiting().contains_key(who)
}

#[cfg(test)]
mod tests {
    use std::net::IpAddr;
    use std::pin::Pin;
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    use axum::extract::{RawQuery, State};
    use axum::http::{HeaderMap, StatusCode};

    use super::*;
    use crate::api::budget::as_client;
    use crate::api::messages::search;
    use crate::api::test_util::{add_member, done, mem_user, temp_state, temp_state_env};
    use crate::api::{MaybeAuthed, Paged, Reason, ReasonKind};
    use crate::limits::Limits;

    const LONG: Duration = Duration::from_secs(120);
    /// More than a search that does not wait takes to answer.
    const BRIEF: Duration = Duration::from_millis(300);
    /// How late a timed wait may end on a busy machine.
    const SLACK: Duration = Duration::from_secs(20);
    const PATHS: [&str; 5] = [
        "q=hello",
        "q=he",
        "q=hello&offset=1",
        "q=hello&server=rchat",
        "after_ts=1",
    ];

    async fn world(tag: &str, limits: Limits) -> (AppState, std::path::PathBuf) {
        filled(temp_state(tag).await, limits).await
    }

    /// A world with two read connections, where a search that finds them taken waits for one
    /// far longer than the test runs.
    async fn patient_world(tag: &str, limits: Limits) -> (AppState, std::path::PathBuf) {
        let env = [
            ("DATABASE_READ_CONNECTIONS", "2"),
            ("DATABASE_ACQUIRE_TIMEOUT_SECS", "600"),
        ];
        filled(temp_state_env(tag, &env).await, limits).await
    }

    async fn filled(
        (state, path): (AppState, std::path::PathBuf),
        limits: Limits,
    ) -> (AppState, std::path::PathBuf) {
        let db = &state.db;
        for name in ["alice", "bob", "carol"] {
            add_member(db, "rchat", name, 0, 0, 0).await;
        }
        sqlx::query("INSERT INTO messages(channel_id, author, content, created_at) SELECT id, 'alice', 'hello there', 1 FROM channels WHERE server = 'rchat'")
            .execute(db)
            .await
            .expect("a message");
        (state.with_limits(Arc::new(limits)), path)
    }

    async fn run(state: &AppState, who: Option<&str>, query: &str) -> Result<usize, ApiError> {
        search(
            State(state.clone()),
            MaybeAuthed(who.map(|name| mem_user(name, false))),
            HeaderMap::new(),
            RawQuery(Some(query.to_string())),
        )
        .await
        .map(|Paged(found, _)| found.len())
    }

    fn refusal<T>(answer: Result<T, ApiError>) -> (StatusCode, String, Reason) {
        match answer {
            Ok(_) => panic!("the search ran"),
            Err(ApiError(status, text, reason)) => (status, text, reason.expect("a reason")),
        }
    }

    fn rate(wait: u64) -> Reason {
        Reason {
            kind: ReasonKind::Rate,
            control: None,
            retry_after: Some(wait),
            field: None,
        }
    }

    /// The refusal of a bucket that gains one search a minute: a wait of up to a minute.
    fn about_a_minute(reason: &Reason) -> bool {
        (30..=60).any(|wait| *reason == rate(wait))
    }

    /// Whether `future`, polled for `BRIEF`, is still waiting.
    async fn waits<F: Future>(future: Pin<&mut F>) -> bool {
        tokio::time::timeout(BRIEF, future).await.is_err()
    }

    /// The answer of `future`, which must come within `LONG`.
    async fn answer<T>(future: impl Future<Output = T>) -> T {
        tokio::time::timeout(LONG, future).await.expect("answered")
    }

    /// How long `future` took to answer, and its answer.
    async fn timed<T>(future: impl Future<Output = T>) -> (Duration, T) {
        let start = Instant::now();
        let out = answer(future).await;
        (start.elapsed(), out)
    }

    fn limits(change: impl FnOnce(&mut Limits)) -> Limits {
        let mut limits = Limits {
            message_search_concurrent_limit: Some(10),
            ..Limits::default()
        };
        change(&mut limits);
        limits
    }

    /// Every read connection of `state`, so a search that starts waits at its first query.
    async fn hold_reads(state: &AppState) -> Vec<sqlx::pool::PoolConnection<sqlx::Any>> {
        let read = state.read();
        let mut held = Vec::new();
        for _ in 0..read.options().get_max_connections() {
            held.push(read.acquire().await.expect("a read connection"));
        }
        held
    }

    async fn until(what: &str, mut holds: impl FnMut() -> bool) {
        let start = Instant::now();
        while !holds() {
            assert!(start.elapsed() < LONG, "{what}");
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }

    fn started(state: &AppState, who: &'static str) -> tokio::task::JoinHandle<usize> {
        let state = state.clone();
        tokio::spawn(async move { run(&state, Some(who), "q=hello").await.expect("search") })
    }

    /// A search of `who` that started and waits at its first query.
    async fn in_flight(state: &AppState, who: &'static str) -> tokio::task::JoinHandle<usize> {
        let before = places(state);
        let search = started(state, who);
        until("the search is in flight", || places(state) == before + 1).await;
        search
    }

    fn places(state: &AppState) -> u64 {
        RUNNING.held(&pool_key(&state.db))
    }

    fn waiting(state: &AppState, name: &str) -> bool {
        waits_for_own(&lookup::who(state, Some(&mem_user(name, false))))
    }

    /// How many searches `who` is admitted to in a row, each given back at once, up to `most`.
    async fn admitted(state: &AppState, who: &str, most: usize) -> usize {
        let caller = mem_user(who, false);
        let mut n = 0;
        while n < most && admit(state, Some(&caller)).await.is_ok() {
            n += 1;
        }
        n
    }

    #[test]
    fn refusals_are_plain_text_and_a_burst_is_a_third_of_the_rate() {
        for text in [TOO_MANY, STILL_RUNNING, REPLACED, FULL] {
            assert!(text.is_ascii(), "{text}");
        }
        assert_eq!(
            [burst(30), burst(1), burst(15), burst(1_000)],
            [10, 5, 5, 333]
        );
        let d = Limits::default();
        assert_eq!(
            (
                d.message_search_per_minute,
                d.message_search_at_once,
                d.message_search_concurrent_limit
            ),
            (30, 1, None)
        );
        assert_eq!(
            (OWN_WAIT, SITE_WAIT),
            (Duration::from_secs(5), Duration::from_secs(2))
        );
    }

    #[tokio::test]
    async fn a_caller_runs_a_burst_of_searches_on_any_path_and_then_waits() {
        let slow = limits(|l| l.message_search_per_minute = 1);
        let (state, path) = world("search_limit_rate", slow).await;
        assert_eq!(burst(1) as usize, PATHS.len());
        for query in PATHS {
            assert!(run(&state, Some("alice"), query).await.is_ok(), "{query}");
        }
        for query in PATHS {
            let (status, text, reason) = refusal(run(&state, Some("alice"), query).await);
            assert_eq!(
                (status, text.as_str()),
                (StatusCode::TOO_MANY_REQUESTS, TOO_MANY),
                "{query}"
            );
            assert!(about_a_minute(&reason), "{query}: {reason:?}");
        }
        assert_eq!(run(&state, Some("bob"), "q=hello").await.expect("bob"), 1);
        for n in 0..10 {
            assert!(
                matches!(
                    run(&state, Some("carol"), "q=hello&before=x").await,
                    Err(ApiError(StatusCode::BAD_REQUEST, _, _))
                ),
                "{n}: a request that is not a search takes nothing"
            );
        }
        assert_eq!(
            run(&state, Some("carol"), "q=hello").await.expect("carol"),
            1
        );
        let ip = |s: &str| -> IpAddr { s.parse().expect("ip") };
        as_client(ip("203.0.113.7"), async {
            for n in 0..5 {
                assert!(
                    run(&state, None, "q=hello&servers=rchat").await.is_ok(),
                    "guest {n}"
                );
            }
            let (status, text, reason) = refusal(run(&state, None, "q=hello&servers=rchat").await);
            assert_eq!(
                (status, text.as_str()),
                (StatusCode::TOO_MANY_REQUESTS, TOO_MANY)
            );
            assert!(about_a_minute(&reason), "{reason:?}");
        })
        .await;
        as_client(ip("198.51.100.9"), async {
            assert!(
                run(&state, None, "q=hello&servers=rchat").await.is_ok(),
                "a guest at another address has their own searches"
            );
        })
        .await;
        done(state, path).await;
    }

    #[tokio::test]
    async fn the_bucket_follows_its_setting_and_refills() {
        let fast = limits(|l| l.message_search_per_minute = 600);
        let (state, path) = world("search_limit_refill", fast).await;
        let held = burst(600) as usize;
        let taken = admitted(&state, "alice", 10 * held).await;
        assert!((held..2 * held).contains(&taken), "{taken}");
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert_eq!(
            run(&state, Some("alice"), "q=hello")
                .await
                .expect("refilled"),
            1
        );
        let more = admitted(&state, "alice", held).await;
        assert!(more < held, "10 a second, not all at once: {more}");
        let usual = state.clone().with_limits(Arc::new(limits(|_| ())));
        let taken = admitted(&usual, "bob", 100).await;
        assert!((10..=20).contains(&taken), "10 at once by default: {taken}");
        done(state, path).await;
    }

    #[tokio::test]
    async fn a_callers_next_search_waits_for_the_one_running() {
        let (state, path) = patient_world("search_limit_wait", limits(|_| ())).await;
        let reads = hold_reads(&state).await;
        let first = in_flight(&state, "alice").await;
        let mut second = Box::pin(run(&state, Some("alice"), "q=hello"));
        assert!(
            waits(second.as_mut()).await,
            "the next search waits instead of being refused"
        );
        assert!(waiting(&state, "alice"));
        assert_eq!(places(&state), 1, "a waiting search holds no place");
        assert!(
            admit(&state, Some(&mem_user("bob", false))).await.is_ok(),
            "another caller is not held back"
        );
        first.abort();
        assert!(first.await.expect_err("aborted").is_cancelled());
        assert!(
            waits(second.as_mut()).await,
            "a search whose request went away runs on and keeps its place"
        );
        drop(reads);
        assert_eq!(
            answer(second).await.expect("it runs once the first ends"),
            1
        );
        assert!(!waiting(&state, "alice"));
        assert_eq!(places(&state), 0);
        let two = state
            .clone()
            .with_limits(Arc::new(limits(|l| l.message_search_at_once = 2)));
        let carol = mem_user("carol", false);
        let mut held = vec![
            admit(&two, Some(&carol)).await.expect("one"),
            admit(&two, Some(&carol)).await.expect("two"),
        ];
        let mut third = Box::pin(admit(&two, Some(&carol)));
        assert!(
            waits(third.as_mut()).await,
            "past its places a search waits"
        );
        held.pop();
        assert!(answer(third).await.is_ok(), "and runs when one comes free");
        done(state, path).await;
    }

    #[tokio::test]
    async fn a_newer_search_takes_the_place_of_the_waiting_one() {
        let (state, path) = patient_world("search_limit_replace", limits(|_| ())).await;
        let reads = hold_reads(&state).await;
        let first = in_flight(&state, "alice").await;
        let mut second = Box::pin(run(&state, Some("alice"), "q=hello"));
        assert!(waits(second.as_mut()).await, "the second search waits");
        let mut third = Box::pin(run(&state, Some("alice"), "q=hello"));
        assert!(waits(third.as_mut()).await, "the third search waits");
        let (status, text, reason) = refusal(answer(second).await);
        assert_eq!(
            (status, text.as_str(), reason),
            (StatusCode::TOO_MANY_REQUESTS, REPLACED, rate(1)),
            "the second answers as soon as the third takes its place"
        );
        assert!(waiting(&state, "alice"));
        drop(third);
        assert!(
            !waiting(&state, "alice"),
            "a search whose request went away while it waited leaves no turn behind"
        );
        let mut fourth = Box::pin(run(&state, Some("alice"), "q=hello"));
        assert!(waits(fourth.as_mut()).await, "the fourth search waits");
        assert_eq!(places(&state), 1);
        drop(reads);
        assert_eq!(answer(first).await.expect("first"), 1);
        assert_eq!(answer(fourth).await.expect("the newest search runs"), 1);
        assert!(!waiting(&state, "alice"));
        done(state, path).await;
    }

    #[tokio::test]
    async fn a_replaced_search_answers_well_before_its_deadline() {
        let (state, path) = patient_world("search_limit_replaced_now", limits(|_| ())).await;
        let reads = hold_reads(&state).await;
        let first = in_flight(&state, "alice").await;
        let start = Instant::now();
        let mut second = Box::pin(run(&state, Some("alice"), "q=hello"));
        assert!(waits(second.as_mut()).await, "the second search waits");
        let mut third = Box::pin(run(&state, Some("alice"), "q=hello"));
        assert!(waits(third.as_mut()).await, "the third search waits");
        let (took, out) = timed(second).await;
        let (_, text, _) = refusal(out);
        assert_eq!(text, REPLACED);
        assert!(
            took < Duration::from_secs(1),
            "the second answers once the third waits: {took:?}"
        );
        assert!(
            start.elapsed() < OWN_WAIT,
            "and before its own wait ends: {:?}",
            start.elapsed()
        );
        drop(third);
        drop(reads);
        assert_eq!(answer(first).await.expect("first"), 1);
        done(state, path).await;
    }

    #[tokio::test]
    async fn a_search_waits_at_most_five_seconds_for_the_callers_own() {
        let slow = limits(|l| l.message_search_per_minute = 1);
        let (state, path) = patient_world("search_limit_bound", slow).await;
        let reads = hold_reads(&state).await;
        let first = in_flight(&state, "alice").await;
        let (waited, out) = timed(run(&state, Some("alice"), "q=hello")).await;
        let (status, text, reason) = refusal(out);
        assert_eq!(
            (status, text.as_str(), reason),
            (StatusCode::TOO_MANY_REQUESTS, STILL_RUNNING, rate(1))
        );
        assert!((OWN_WAIT..OWN_WAIT + SLACK).contains(&waited), "{waited:?}");
        assert!(!waiting(&state, "alice"));
        drop(reads);
        assert_eq!(answer(first).await.expect("first"), 1);
        assert_eq!(
            admitted(&state, "alice", 10).await,
            4,
            "only the search that ran spent a token"
        );
        done(state, path).await;
    }

    #[tokio::test]
    async fn a_search_replaced_or_gone_while_it_waits_gives_its_token_back() {
        let slow = limits(|l| l.message_search_per_minute = 1);
        let (state, path) = patient_world("search_limit_refund", slow).await;
        let reads = hold_reads(&state).await;
        let first = in_flight(&state, "alice").await;
        let mut older = Box::pin(run(&state, Some("alice"), "q=hello"));
        assert!(waits(older.as_mut()).await, "the second search waits");
        for n in 0..2 * burst(1) {
            let mut newer = Box::pin(run(&state, Some("alice"), "q=hello"));
            assert!(
                waits(newer.as_mut()).await,
                "{n}: a newer search waits instead of being refused for the bucket"
            );
            let (_, text, _) = refusal(answer(older).await);
            assert_eq!(text, REPLACED, "{n}");
            older = newer;
        }
        drop(older);
        assert!(!waiting(&state, "alice"));
        let mut last = Box::pin(run(&state, Some("alice"), "q=hello"));
        assert!(waits(last.as_mut()).await, "the last search waits");
        drop(reads);
        assert_eq!(answer(first).await.expect("first"), 1);
        assert_eq!(answer(last).await.expect("the last search runs"), 1);
        assert_eq!(
            admitted(&state, "alice", 10).await,
            3,
            "only the two searches that ran spent a token"
        );
        done(state, path).await;
    }

    #[tokio::test]
    async fn a_search_refused_at_capacity_gives_its_token_back() {
        let one = limits(|l| {
            l.message_search_per_minute = 1;
            l.message_search_concurrent_limit = Some(1);
        });
        let (state, path) = world("search_limit_full_refund", one).await;
        let held = admit(&state, Some(&mem_user("user0", false)))
            .await
            .expect("room");
        for n in 0..2 {
            let (status, text, _) = refusal(run(&state, Some("carol"), "q=hello").await);
            assert_eq!(
                (status, text.as_str()),
                (StatusCode::SERVICE_UNAVAILABLE, FULL),
                "{n}"
            );
        }
        drop(held);
        assert_eq!(
            admitted(&state, "carol", 10).await,
            burst(1) as usize,
            "the refused searches spent nothing"
        );
        done(state, path).await;
    }

    async fn guests(state: &AppState, on: bool) {
        sqlx::query("UPDATE settings SET value = $1 WHERE key = 'guests_enabled'")
            .bind(if on { "1" } else { "0" })
            .execute(&state.db)
            .await
            .expect("guest access");
        crate::api::Settings::forget(&state.db);
    }

    #[tokio::test]
    async fn requests_refused_before_they_search_spend_nothing() {
        let one = limits(|l| {
            l.message_search_per_minute = 1;
            l.message_search_concurrent_limit = Some(1);
        });
        let (state, path) = world("search_limit_cheap", one).await;
        let bad = [
            "q=hello&cursor=zz",
            "q=hello&cursor=7a7a",
            "q=hel%00lo",
            "from=a%00",
            "q=hello&server=x%00",
            "q=hello&servers=rchat%00",
        ];
        let guest: IpAddr = "203.0.113.7".parse().expect("ip");
        let refused = |full: bool| {
            let state = &state;
            async move {
                for query in bad {
                    for n in 0..burst(1) {
                        let (took, out) = timed(run(state, Some("alice"), query)).await;
                        assert!(
                            matches!(out, Err(ApiError(StatusCode::BAD_REQUEST, _, None))),
                            "{query} {n} full={full}"
                        );
                        assert!(
                            took < SITE_WAIT,
                            "{query}: refused without a wait: {took:?}"
                        );
                    }
                }
                guests(state, false).await;
                as_client(guest, async {
                    for n in 0..2 * burst(1) {
                        let (took, out) = timed(run(state, None, "q=hello&servers=rchat")).await;
                        assert!(
                            matches!(out, Err(ApiError(StatusCode::UNAUTHORIZED, _, _))),
                            "{n} full={full}"
                        );
                        assert!(took < SITE_WAIT, "{n}: refused without a wait: {took:?}");
                    }
                })
                .await;
                guests(state, true).await;
            }
        };
        refused(false).await;
        let held = admit(&state, Some(&mem_user("user0", false)))
            .await
            .expect("room");
        refused(true).await;
        drop(held);
        assert_eq!(
            admitted(&state, "alice", 10).await,
            burst(1) as usize,
            "a bad cursor or a NUL character spends no search"
        );
        let left = as_client(guest, async {
            let mut n = 0;
            while n < 10 && admit(&state, None).await.is_ok() {
                n += 1;
            }
            n
        })
        .await;
        assert_eq!(
            left,
            burst(1) as usize,
            "a guest refused while guest access is off spends no search"
        );
        done(state, path).await;
    }

    #[tokio::test]
    async fn a_search_waits_briefly_for_a_place_in_the_process() {
        let two = limits(|l| l.message_search_concurrent_limit = Some(2));
        let (state, path) = world("search_limit_site", two).await;
        let mut held = Vec::new();
        for name in ["user0", "user1"] {
            let caller = mem_user(name, false);
            held.push(admit(&state, Some(&caller)).await.expect("room"));
        }
        assert_eq!(places(&state), 2);
        let (waited, out) = timed(run(&state, Some("carol"), "q=hello")).await;
        let (status, text, reason) = refusal(out);
        assert_eq!(
            (status, text.as_str()),
            (StatusCode::SERVICE_UNAVAILABLE, FULL)
        );
        assert_eq!(
            reason,
            Reason {
                kind: ReasonKind::Capacity,
                control: Some(CONCURRENT.to_string()),
                retry_after: Some(2),
                field: None,
            }
        );
        assert!(
            (SITE_WAIT..SITE_WAIT + SLACK).contains(&waited),
            "{waited:?}"
        );
        let mut next = Box::pin(run(&state, Some("carol"), "q=hello"));
        assert!(waits(next.as_mut()).await, "a search waits for a place");
        held.pop();
        assert_eq!(
            answer(next).await.expect("it runs once a place comes free"),
            1
        );
        done(state, path).await;
    }

    #[tokio::test]
    async fn by_default_searches_take_at_most_half_the_read_connections() {
        let (state, path) = world("search_limit_half", Limits::default()).await;
        let reads = state.read().options().get_max_connections();
        let most = concurrent(&state);
        assert_eq!(most, (reads / 2).max(1));
        assert!(reads < 2 || most < reads, "{most} of {reads}");
        let mut held = Vec::new();
        for n in 0..most {
            let caller = mem_user(&format!("user{n}"), false);
            held.push(admit(&state, Some(&caller)).await.expect("room"));
        }
        let alice = mem_user("alice", false);
        let mut next = Box::pin(admit(&state, Some(&alice)));
        assert!(waits(next.as_mut()).await, "past the most a search waits");
        held.pop();
        assert!(answer(next).await.is_ok());
        let set = state.clone().with_limits(Arc::new(Limits {
            message_search_concurrent_limit: Some(1_000),
            ..Limits::default()
        }));
        assert_eq!(concurrent(&set), 1_000);
        done(state, path).await;
    }
}
