use std::sync::LazyLock;
use std::time::{Duration, Instant};

use axum::http::{Method, StatusCode};

use crate::api::ApiError;
use crate::api::budget;
use crate::api::servers::MemberListQuery;
use crate::db::{User, pool_key};
use crate::limits::Limits;
use crate::limits::bucket::{Keyed, Policy, Token};
use crate::state::AppState;

/// What a lookup of accounts or servers is for. Each class has its own budget per account, or
/// per client address for a caller without one.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LookupClass {
    /// Member lists, and member facts by name.
    List,
    /// Suggestions while a mention is typed.
    Typeahead,
    /// Searches across the instance.
    Search,
    /// One account's card.
    Profile,
    /// Member searches with filters, for a server's moderators.
    MemberSearch,
}

impl LookupClass {
    pub const ALL: [LookupClass; 5] = [
        LookupClass::List,
        LookupClass::Typeahead,
        LookupClass::Search,
        LookupClass::Profile,
        LookupClass::MemberSearch,
    ];

    /// The env name of its limit.
    pub fn env(self) -> &'static str {
        match self {
            LookupClass::List => "LOOKUP_LIST_PER_MINUTE",
            LookupClass::Typeahead => "LOOKUP_TYPEAHEAD_PER_MINUTE",
            LookupClass::Search => "LOOKUP_SEARCH_PER_MINUTE",
            LookupClass::Profile => "LOOKUP_PROFILE_PER_MINUTE",
            LookupClass::MemberSearch => "LOOKUP_MEMBER_SEARCH_PER_MINUTE",
        }
    }

    /// Lookups a caller gains a minute.
    pub fn per_minute(self, limits: &Limits) -> u32 {
        match self {
            LookupClass::List => limits.lookup_list_per_minute,
            LookupClass::Typeahead => limits.lookup_typeahead_per_minute,
            LookupClass::Search => limits.lookup_search_per_minute,
            LookupClass::Profile => limits.lookup_profile_per_minute,
            LookupClass::MemberSearch => limits.lookup_member_search_per_minute,
        }
    }

    /// Lookups a caller holds at once when it gains `per_minute`: the share its default has
    /// (30 of 120, 20 of 300, 10 of 30, 30 of 120, 10 of 30), at least 5.
    pub fn burst(self, per_minute: u32) -> u32 {
        let (default, held) = match self {
            LookupClass::List | LookupClass::Profile => (120, 30),
            LookupClass::Typeahead => (300, 20),
            LookupClass::Search | LookupClass::MemberSearch => (30, 10),
        };
        (per_minute.saturating_mul(held) / default).max(5)
    }

    /// Its bucket: `burst` lookups at once, then `per_minute` a minute.
    pub fn policy(self, limits: &Limits) -> Policy {
        let per_minute = self.per_minute(limits);
        Policy::per_minute(self.burst(per_minute), per_minute)
    }
}

/// The class of the lookup a request makes, by its method and its path under the API prefix
/// (with its query, which decides between a member list and mention suggestions).
pub fn class_of(method: &Method, path: &str) -> Option<LookupClass> {
    if method != Method::GET {
        return None;
    }
    let (path, query) = path.split_once('?').unwrap_or((path, ""));
    let parts: Vec<&str> = path.split('/').filter(|part| !part.is_empty()).collect();
    match parts.as_slice() {
        ["servers", _, "members", "search"] => Some(LookupClass::MemberSearch),
        ["servers", _, "members"] => {
            Some(MemberListQuery::parse(query).map_or(LookupClass::List, |query| query.class()))
        }
        ["servers", _, "interacted"] => Some(LookupClass::List),
        ["servers", _, "mentions"] => Some(LookupClass::Typeahead),
        ["server_search"] | ["users", "search"] => Some(LookupClass::Search),
        ["users", _, "card" | "profile"] => Some(LookupClass::Profile),
        _ => None,
    }
}

pub const TOO_MANY: &str = "Too many lookups. Try again later.";
pub const TOO_MANY_CONTACTS: &str = "Too many actions on other accounts. Try again later.";
pub const TOO_MANY_BLOCKS: &str = "Too many blocks. Try again later.";
pub const TOO_MANY_BANS: &str = "Too many bans of people outside this server. Try again later.";
/// The env name of the cap on a caller's misses for names: profile cards, blocks and bans.
const MISSES: &str = "LOOKUP_MISSES_PER_HOUR";
/// New DMs and friend requests by name per account and window.
pub const CONTACTS_PER_WINDOW: u32 = 30;
/// Blocks per account and window, apart from DMs and friend requests.
pub const BLOCKS_PER_WINDOW: u32 = 120;
const CONTACT_WINDOW: Duration = Duration::from_secs(600);
const MISS_WINDOW: Duration = Duration::from_secs(3600);

/// Lookups per caller and class, each class under its own policy (`LookupClass::policy`).
static TOKENS: LazyLock<Keyed> =
    LazyLock::new(|| Keyed::new(LookupClass::List.policy(&Limits::default()), 200_000));
/// Misses per caller, under `LOOKUP_MISSES_PER_HOUR`.
static MISSED: LazyLock<Keyed> =
    LazyLock::new(|| Keyed::new(misses(Limits::default().lookup_misses_per_hour), 100_000));
static CONTACTS: LazyLock<Keyed> = LazyLock::new(|| {
    Keyed::new(
        Policy::Window {
            limit: CONTACTS_PER_WINDOW,
            window: CONTACT_WINDOW,
        },
        100_000,
    )
});
static BLOCKS: LazyLock<Keyed> = LazyLock::new(|| {
    Keyed::new(
        Policy::Window {
            limit: BLOCKS_PER_WINDOW,
            window: CONTACT_WINDOW,
        },
        100_000,
    )
});

fn misses(per_hour: u32) -> Policy {
    Policy::Window {
        limit: per_hour,
        window: MISS_WINDOW,
    }
}

/// The refusal of the limit `limit` (its env name, `contact` or `blocks`): 429 with the reason
/// `rate` and the time to wait in whole seconds, rounded up and at least one, also as
/// `Retry-After`. Every refusal of a lookup limit, of the rare requests (`rare`) or of a
/// caller's message searches (`search_limits`) is built here.
pub(crate) fn limited(limit: &'static str, text: &str, wait: Duration) -> ApiError {
    tracing::debug!("refused by the {limit} limit");
    ApiError::rate(text, Some(wait.as_secs_f64().ceil().max(1.0) as u64))
}

/// Whose budget a lookup counts against: the account's, or the client address's for a caller
/// without one.
pub(crate) fn who(state: &AppState, caller: Option<&User>) -> String {
    let who = match (caller, budget::client()) {
        (Some(user), _) => format!("u\n{}", user.username),
        (None, Some(ip)) => format!("a\n{}", budget::group(ip)),
        (None, None) => "a\n-".to_string(),
    };
    format!("{}\n{who}", pool_key(&state.db))
}

/// One of a caller's misses, held while its lookup by name runs. `counted` keeps it for a 404;
/// any other answer, or a handler that returns early, gives it back.
#[must_use]
pub struct Held {
    who: String,
    start: Option<Instant>,
}

impl Held {
    /// Keeps this miss whatever the answer: for an action by name that answers every name alike
    /// but leaves it where the caller reads it later (a ban of someone outside the server, a
    /// block of an account the caller may not see).
    pub fn spend(mut self) {
        self.start = None;
    }
}

impl Drop for Held {
    fn drop(&mut self) {
        if let Some(start) = self.start.take() {
            MISSED.refund(&self.who, 1.0, start);
        }
    }
}

/// Holds one of the caller's misses for the hour, or refuses a caller past them, whatever name
/// it asks about. Every lookup by name that answers 404 for a name without an account runs it
/// before it reads the account, and passes its answer through `counted`. Lookups in flight
/// hold their misses, so together they can't go past the limit.
pub fn unmissed(state: &AppState, caller: Option<&User>) -> Result<Held, ApiError> {
    let who = who(state, caller);
    let start = match state.limits.lookup_misses_per_hour {
        0 => None,
        per_hour => match MISSED
            .under(misses(per_hour))
            .try_take(&who, 1.0, Instant::now())
        {
            Ok(start) => Some(start),
            Err(wait) => return Err(limited(MISSES, TOO_MANY, wait)),
        },
    };
    Ok(Held { who, start })
}

/// Holds one of `user`'s misses for a ban of someone who is not a member of the server, like
/// `unmissed`. Past its misses the ban is refused as a ban, whoever the name is.
pub fn outside_ban(state: &AppState, user: &User) -> Result<Held, ApiError> {
    unmissed(state, Some(user))
        .map_err(|ApiError(code, _, reason)| ApiError(code, TOO_MANY_BANS.to_string(), reason))
}

/// Takes one lookup of `class` from the caller's budget, before the handler runs any query.
pub fn take(state: &AppState, class: LookupClass, caller: Option<&User>) -> Result<(), ApiError> {
    reserve(state, class, caller).map(Token::spend)
}

/// Holds a lookup while the request waits for admission.
pub(super) fn reserve(
    state: &AppState,
    class: LookupClass,
    caller: Option<&User>,
) -> Result<Token<'static>, ApiError> {
    let key = format!("{}\n{}", who(state, caller), class.env());
    TOKENS
        .under(class.policy(&state.limits))
        .hold(key, 1.0, Instant::now())
        .map_err(|wait| limited(class.env(), TOO_MANY, wait))
}

/// Keeps the miss `held` for the answer of a lookup by name when it is a 404, and gives it
/// back otherwise.
pub fn counted<T>(mut held: Held, answer: Result<T, ApiError>) -> Result<T, ApiError> {
    if let Err(ApiError(StatusCode::NOT_FOUND, _, _)) = &answer {
        held.start = None;
    }
    answer
}

/// Counts one new DM or friend request of `user` by name. Past `CONTACTS_PER_WINDOW` in ten
/// minutes it is refused, whoever the name is.
pub fn contact(state: &AppState, user: &User) -> Result<(), ApiError> {
    let key = format!("{}\n{}", pool_key(&state.db), user.username);
    match CONTACTS.try_take(&key, 1.0, Instant::now()) {
        Ok(_) => Ok(()),
        Err(wait) => Err(limited("contact", TOO_MANY_CONTACTS, wait)),
    }
}

/// Counts one block of `user` by name and holds one of its misses for it, like `unmissed`.
/// Past its misses, or past `BLOCKS_PER_WINDOW` in ten minutes, it is refused, whoever the
/// name is.
pub fn block(state: &AppState, user: &User) -> Result<Held, ApiError> {
    let held = unmissed(state, Some(user))?;
    let key = format!("{}\n{}", pool_key(&state.db), user.username);
    match BLOCKS.try_take(&key, 1.0, Instant::now()) {
        Ok(_) => Ok(held),
        Err(wait) => Err(limited("blocks", TOO_MANY_BLOCKS, wait)),
    }
}

#[cfg(test)]
mod tests {
    use std::net::{IpAddr, SocketAddr};
    use std::sync::Arc;
    use std::time::Duration;

    use axum::Json;
    use axum::extract::{Path, Query, RawQuery, State};
    use axum::http::{HeaderMap, Method, StatusCode};
    use serde_json::json;
    use sqlx::Row;

    use super::*;
    use crate::api::access::NOT_FOUND;
    use crate::api::blocks::{block_user, unblock_user};
    use crate::api::budget::as_client;
    use crate::api::dms::open_dm;
    use crate::api::friends::send_request;
    use crate::api::servers::{
        ban_member, list_interacted, list_members, search_servers, set_channel_perm,
    };
    use crate::api::test_util::{done, mem_user, temp_state};
    use crate::api::timeouts::remove_timeout;
    use crate::api::users::{ProfileQuery, card, profile};
    use crate::api::{ApiError, Authed, MaybeAuthed, Reason, ReasonKind};
    use crate::db::{Db, NewUser};
    use crate::limits::Limits;

    fn status<T>(res: Result<T, ApiError>) -> (StatusCode, String) {
        match res {
            Ok(_) => (StatusCode::OK, String::new()),
            Err(ApiError(code, text, _)) => (code, text),
        }
    }

    fn too_many() -> (StatusCode, String) {
        (StatusCode::TOO_MANY_REQUESTS, TOO_MANY.to_string())
    }

    async fn add_user(db: &Db, name: &str) {
        NewUser::plain(name).at(1).add(db).await;
    }

    /// Every class at its smallest value: each holds 5 lookups at once.
    fn smallest() -> Limits {
        Limits {
            lookup_list_per_minute: 10,
            lookup_typeahead_per_minute: 10,
            lookup_search_per_minute: 1,
            lookup_profile_per_minute: 10,
            lookup_member_search_per_minute: 1,
            lookup_misses_per_hour: 0,
            ..Limits::default()
        }
    }

    #[test]
    fn every_lookup_route_has_its_class() {
        let get = |path: &str| class_of(&Method::GET, path);
        for (path, class) in [
            ("/servers/club/members", Some(LookupClass::List)),
            (
                "/servers/club/members?cursor=abc&limit=20",
                Some(LookupClass::List),
            ),
            (
                "/servers/club/members?usernames=a&usernames=b",
                Some(LookupClass::List),
            ),
            (
                "/servers/club/members?q=al&admins=1",
                Some(LookupClass::List),
            ),
            ("/servers/club/members?suggest=1", Some(LookupClass::List)),
            (
                "/servers/club/members?usernames=a&suggest=1&q=al",
                Some(LookupClass::List),
            ),
            (
                "/servers/club/members?suggest=1&q=al",
                Some(LookupClass::Typeahead),
            ),
            (
                "/servers/club/members?q=al&suggest=true",
                Some(LookupClass::Typeahead),
            ),
            ("/servers/club/interacted", Some(LookupClass::List)),
            ("/servers/club/mentions?q=al", Some(LookupClass::Typeahead)),
            ("/servers/club/mentions", Some(LookupClass::Typeahead)),
            ("/server_search?q=club", Some(LookupClass::Search)),
            ("/server_search", Some(LookupClass::Search)),
            ("/users/search?q=bo", Some(LookupClass::Search)),
            ("/users/bob/card", Some(LookupClass::Profile)),
            ("/users/bob/card?server=club", Some(LookupClass::Profile)),
            ("/users/bob/profile", Some(LookupClass::Profile)),
            ("/users/bob/friendship", None),
            ("/servers/club", None),
            (
                "/servers/club/members/search?q=al&sort=joined_desc",
                Some(LookupClass::MemberSearch),
            ),
            ("/servers/club/members/bob", None),
            ("/me", None),
            ("/", None),
        ] {
            assert_eq!(get(path), class, "{path}");
        }
        assert_eq!(class_of(&Method::POST, "/users/bob/card"), None);
        assert_eq!(class_of(&Method::DELETE, "/servers/club/members"), None);
        let envs: Vec<&str> = LookupClass::ALL.into_iter().map(|c| c.env()).collect();
        assert_eq!(
            envs,
            [
                "LOOKUP_LIST_PER_MINUTE",
                "LOOKUP_TYPEAHEAD_PER_MINUTE",
                "LOOKUP_SEARCH_PER_MINUTE",
                "LOOKUP_PROFILE_PER_MINUTE",
                "LOOKUP_MEMBER_SEARCH_PER_MINUTE"
            ]
        );
        for env in envs {
            assert!(Limits::range(env).is_some(), "{env} is a limit");
        }
    }

    #[test]
    fn each_class_holds_its_burst() {
        let d = Limits::default();
        let held: Vec<u32> = LookupClass::ALL
            .into_iter()
            .map(|c| c.burst(c.per_minute(&d)))
            .collect();
        assert_eq!(held, [30, 20, 10, 30, 10], "the defaults");
        let s = smallest();
        for class in LookupClass::ALL {
            assert_eq!(
                class.burst(class.per_minute(&s)),
                5,
                "never under 5: {class:?}"
            );
        }
        assert_eq!(LookupClass::List.burst(10_000), 2_500);
        assert_eq!(LookupClass::Typeahead.burst(10_000), 666);
        assert_eq!(LookupClass::Search.burst(1_000), 333);
        assert_eq!(LookupClass::Profile.burst(240), 60);
    }

    #[tokio::test]
    async fn each_class_refuses_after_its_burst_and_refills() {
        let (state, path) = temp_state("lookup_classes").await;
        let slow = state.clone().with_limits(Arc::new(smallest()));
        let alice = mem_user("alice", false);
        for class in LookupClass::ALL {
            for n in 0..5 {
                assert!(take(&slow, class, Some(&alice)).is_ok(), "{class:?} {n}");
            }
            assert_eq!(
                status(take(&slow, class, Some(&alice))),
                too_many(),
                "{class:?} past its burst"
            );
        }
        let fast = state.clone().with_limits(Arc::new(Limits {
            lookup_list_per_minute: 600,
            lookup_typeahead_per_minute: 600,
            lookup_search_per_minute: 600,
            lookup_profile_per_minute: 600,
            lookup_member_search_per_minute: 600,
            lookup_misses_per_hour: 0,
            ..Limits::default()
        }));
        let bob = mem_user("bob", false);
        for class in LookupClass::ALL {
            let held = class.burst(600) as usize;
            let taken = (0..10 * held)
                .take_while(|_| take(&fast, class, Some(&bob)).is_ok())
                .count();
            assert!((held..2 * held).contains(&taken), "{class:?}: {taken}");
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
        for class in LookupClass::ALL {
            assert!(take(&fast, class, Some(&bob)).is_ok(), "{class:?} refills");
            let more = (0..class.burst(600))
                .take_while(|_| take(&fast, class, Some(&bob)).is_ok())
                .count();
            assert!(
                more < class.burst(600) as usize,
                "{class:?} refills 10 a second, not all at once: {more}"
            );
        }
        done(state, path).await;
    }

    #[tokio::test]
    async fn accounts_and_addresses_have_their_own_budgets() {
        let (state, path) = temp_state("lookup_keys").await;
        let state = state.with_limits(Arc::new(smallest()));
        let ip = |s: &str| -> IpAddr { s.parse().expect("ip") };
        let (home, away) = (ip("203.0.113.7"), ip("198.51.100.9"));
        let (alice, bob) = (mem_user("alice", false), mem_user("bob", false));
        let class = LookupClass::Profile;
        let takes = |who: Option<&crate::db::User>, n: usize| {
            (0..n).filter(|_| take(&state, class, who).is_ok()).count()
        };
        as_client(home, async {
            assert_eq!(takes(Some(&alice), 6), 5, "alice has 5");
            assert_eq!(
                takes(Some(&bob), 6),
                5,
                "bob behind the same address has his own"
            );
            assert_eq!(takes(None, 6), 5, "a guest there counts by the address");
            assert_eq!(takes(None, 1), 0);
        })
        .await;
        as_client(away, async {
            assert_eq!(takes(None, 6), 5, "a guest elsewhere has their own");
            assert_eq!(takes(Some(&alice), 1), 0, "alice is alice anywhere");
        })
        .await;
        as_client(ip("2001:db8:1:2::1"), async {
            assert_eq!(takes(None, 3), 3);
        })
        .await;
        as_client(ip("2001:db8:1:2:ffff::9"), async {
            assert_eq!(takes(None, 6), 2, "one /64 is one address");
        })
        .await;
        assert_eq!(
            status(take(&state, LookupClass::List, Some(&alice))).0,
            StatusCode::OK,
            "another class of the same account"
        );
        done(state, path).await;
    }

    async fn card_of(state: &AppState, viewer: Option<&str>, name: &str) -> (StatusCode, String) {
        status(
            card(
                State(state.clone()),
                MaybeAuthed(viewer.map(|v| mem_user(v, false))),
                HeaderMap::new(),
                Path(name.to_string()),
                Query(serde_json::from_value::<ProfileQuery>(json!({})).expect("query")),
            )
            .await,
        )
    }

    async fn profile_of(
        state: &AppState,
        viewer: Option<&str>,
        name: &str,
    ) -> (StatusCode, String) {
        status(
            profile(
                State(state.clone()),
                MaybeAuthed(viewer.map(|v| mem_user(v, false))),
                HeaderMap::new(),
                Path(name.to_string()),
                Query(serde_json::from_value::<ProfileQuery>(json!({})).expect("query")),
            )
            .await,
        )
    }

    #[tokio::test]
    async fn only_404s_count_as_misses() {
        let (state, path) = temp_state("lookup_misses").await;
        let state = state.with_limits(Arc::new(Limits {
            lookup_profile_per_minute: 10_000,
            lookup_misses_per_hour: 3,
            ..Limits::default()
        }));
        let db = &state.db;
        for name in ["alice", "bob", "carol"] {
            add_user(db, name).await;
        }
        sqlx::query("INSERT INTO friends(username, friend, created_at) VALUES('alice', 'bob', 1), ('bob', 'alice', 1)")
            .execute(db)
            .await
            .expect("friends");
        let ok = (StatusCode::OK, String::new());
        let hidden = (StatusCode::NOT_FOUND, NOT_FOUND.to_string());
        for _ in 0..10 {
            assert_eq!(card_of(&state, Some("alice"), "bob").await, ok, "a hit");
        }
        sqlx::query("UPDATE settings SET value = '0' WHERE key = 'guests_enabled'")
            .execute(db)
            .await
            .expect("guests off");
        crate::api::Settings::forget(db);
        for _ in 0..5 {
            assert_eq!(
                card_of(&state, None, "ghost").await.0,
                StatusCode::UNAUTHORIZED,
                "a 401 is not a miss"
            );
        }
        sqlx::query("UPDATE settings SET value = '1' WHERE key = 'guests_enabled'")
            .execute(db)
            .await
            .expect("guests on");
        crate::api::Settings::forget(db);
        for (name, old) in [("ghost", false), ("carol", true), ("nobody", false)] {
            let miss = match old {
                true => profile_of(&state, Some("alice"), name).await,
                false => card_of(&state, Some("alice"), name).await,
            };
            assert_eq!(miss, hidden, "{name}");
        }
        for name in ["bob", "alice", "ghost", "carol"] {
            assert_eq!(
                card_of(&state, Some("alice"), name).await,
                too_many(),
                "every card after 3 misses: {name}"
            );
            assert_eq!(profile_of(&state, Some("alice"), name).await, too_many());
        }
        assert_eq!(
            card_of(&state, Some("bob"), "alice").await,
            ok,
            "bob's own count"
        );
        assert!(take(&state, LookupClass::List, Some(&mem_user("alice", false))).is_ok());
        for n in 0..3 {
            assert_eq!(
                card_of(&state, None, "ghost").await,
                hidden,
                "a guest's miss {n}"
            );
        }
        assert_eq!(card_of(&state, None, "ghost").await, too_many());
        done(state, path).await;

        let (state, path) = temp_state("lookup_no_miss_cap").await;
        let state = state.with_limits(Arc::new(Limits {
            lookup_profile_per_minute: 10_000,
            lookup_misses_per_hour: 0,
            ..Limits::default()
        }));
        add_user(&state.db, "alice").await;
        for n in 0..50 {
            assert_eq!(
                card_of(&state, Some("alice"), "ghost").await,
                hidden,
                "0 means no cap: {n}"
            );
        }
        done(state, path).await;
    }

    #[tokio::test]
    async fn the_handlers_take_their_class() {
        let (state, path) = temp_state("lookup_handlers").await;
        let state = state.with_limits(Arc::new(smallest()));
        add_user(&state.db, "alice").await;
        let alice = || MaybeAuthed(Some(mem_user("alice", false)));
        let members = |query: &'static str| {
            let state = state.clone();
            async move {
                status(
                    list_members(
                        State(state),
                        alice(),
                        HeaderMap::new(),
                        Path("rchat".to_string()),
                        RawQuery(Some(query.to_string())),
                    )
                    .await,
                )
            }
        };
        let interacted = || {
            let state = state.clone();
            async move {
                status(
                    list_interacted(
                        State(state),
                        alice(),
                        HeaderMap::new(),
                        Path("rchat".to_string()),
                        Query(serde_json::from_value(json!({})).expect("query")),
                    )
                    .await,
                )
            }
        };
        let search = || {
            let state = state.clone();
            async move {
                status(
                    search_servers(
                        State(state),
                        alice(),
                        Query(serde_json::from_value(json!({"q": "rch"})).expect("query")),
                    )
                    .await,
                )
            }
        };
        let ok = (StatusCode::OK, String::new());
        assert_eq!(members("").await, ok);
        assert_eq!(members("q=a").await, ok);
        assert_eq!(members("usernames=alice").await, ok);
        assert_eq!(interacted().await, ok);
        assert_eq!(interacted().await, ok);
        assert_eq!(members("").await, too_many(), "the list class is used up");
        assert_eq!(members("usernames=alice").await, too_many());
        assert_eq!(members("admins=1").await, too_many());
        assert_eq!(interacted().await, too_many());
        let mentions = || {
            let state = state.clone();
            async move {
                status(
                    crate::api::servers::mentions(
                        State(state),
                        alice(),
                        HeaderMap::new(),
                        Path("rchat".to_string()),
                        Query(serde_json::from_value(json!({"q": "a"})).expect("query")),
                    )
                    .await,
                )
            }
        };
        for n in 0..3 {
            assert_eq!(members("suggest=1&q=a").await, ok, "typeahead {n}");
        }
        for n in 0..2 {
            assert_eq!(mentions().await, ok, "mentions share it: {n}");
        }
        assert_eq!(members("suggest=1&q=a").await, too_many());
        assert_eq!(mentions().await, too_many());
        for n in 0..5 {
            assert_eq!(search().await, ok, "search {n}");
        }
        assert_eq!(search().await, too_many());
        for n in 0..3 {
            assert_eq!(
                card_of(&state, Some("alice"), "alice").await,
                ok,
                "card {n}"
            );
        }
        for n in 0..2 {
            assert_eq!(
                profile_of(&state, Some("alice"), "alice").await,
                ok,
                "the old shape shares the class: {n}"
            );
        }
        assert_eq!(card_of(&state, Some("alice"), "alice").await, too_many());
        assert_eq!(profile_of(&state, Some("alice"), "alice").await, too_many());
        assert_eq!(
            status(
                list_members(
                    State(state.clone()),
                    MaybeAuthed(Some(mem_user("bob", false))),
                    HeaderMap::new(),
                    Path("nowhere".to_string()),
                    RawQuery(None),
                )
                .await
            )
            .0,
            StatusCode::NOT_FOUND,
            "the server gate answers as before under the class"
        );
        done(state, path).await;
    }

    #[tokio::test]
    async fn a_refusal_says_how_long_to_wait_and_the_general_bucket_applies() {
        let (state, path) = temp_state("lookup_http").await;
        let state = state.with_limits(Arc::new(Limits {
            rate_limit_per_second: 1,
            rate_limit_burst: 12,
            ..smallest()
        }));
        let config = crate::config::AppConfig::defaults();
        let app = crate::server::route_builder::api_router(&config, state.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let addr = listener.local_addr().expect("addr");
        let server = tokio::spawn(async move {
            let _ = axum::serve(
                listener,
                app.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .await;
        });
        let client = reqwest::Client::new();
        let url = format!("http://{addr}/api/v1/users/ghost/card");
        let mut seen = Vec::new();
        for _ in 0..40 {
            let res = client.get(&url).send().await.expect("request");
            let code = res.status();
            let wait = res
                .headers()
                .get("retry-after")
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.parse::<u64>().ok());
            let body = res.text().await.expect("body");
            seen.push((code, wait, body));
        }
        server.abort();
        let not_found = format!(r#"{{"error":"{NOT_FOUND}"}}"#);
        for (n, (code, wait, body)) in seen.iter().take(5).enumerate() {
            assert_eq!(
                (*code, *wait, body.as_str()),
                (StatusCode::NOT_FOUND, None, not_found.as_str()),
                "lookup {n}"
            );
        }
        let (code, wait, body) = &seen[5];
        let wait = wait.expect("a Retry-After header");
        assert_eq!(*code, StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(body).expect("json"),
            json!({"error": TOO_MANY, "reason": {"kind": "rate", "retry_after": wait}}),
            "the reason says the same wait as the header"
        );
        assert!(
            (1..=6).contains(&wait),
            "a token of 10 a minute comes within 6 seconds: {wait}"
        );
        let general = seen.iter().skip(6).find(|(code, _, body)| {
            *code == StatusCode::TOO_MANY_REQUESTS && !body.contains(TOO_MANY)
        });
        let (_, wait, body) = general.expect("the general bucket refuses past its burst");
        assert!(wait.is_some(), "{body}");
        done(state, path).await;
    }

    /// The 429 `text` with the reason `rate` and a wait of at least a second.
    fn rate_refusal(res: Result<impl Sized, ApiError>, text: &str) {
        let Err(ApiError(code, error, reason)) = res else {
            panic!("{text}: not refused");
        };
        assert_eq!(
            (code, error.as_str()),
            (StatusCode::TOO_MANY_REQUESTS, text)
        );
        let Reason {
            kind,
            control,
            retry_after,
            field,
            until: _,
            channel: _,
        } = *reason.expect("a reason");
        assert_eq!(
            (kind, control, field),
            (ReasonKind::Rate, None, None),
            "{text}"
        );
        assert!(retry_after.is_some_and(|secs| secs >= 1), "{text}");
    }

    #[tokio::test]
    async fn every_refusal_says_rate_and_how_long_to_wait() {
        let (state, path) = temp_state("lookup_reasons").await;
        let state = state.with_limits(Arc::new(Limits {
            lookup_misses_per_hour: 1,
            ..smallest()
        }));
        let (alice, bob, carol) = (
            mem_user("alice", false),
            mem_user("bob", false),
            mem_user("carol", false),
        );
        let held = unmissed(&state, Some(&alice)).expect("one miss");
        let missed: Result<(), ApiError> = counted(
            held,
            Err(ApiError(StatusCode::NOT_FOUND, NOT_FOUND.into(), None)),
        );
        assert!(missed.is_err());
        rate_refusal(unmissed(&state, Some(&alice)), TOO_MANY);
        rate_refusal(outside_ban(&state, &alice), TOO_MANY_BANS);
        for n in 0..5 {
            take(&state, LookupClass::Profile, Some(&bob)).unwrap_or_else(|_| panic!("{n}"));
        }
        rate_refusal(take(&state, LookupClass::Profile, Some(&bob)), TOO_MANY);
        for n in 0..CONTACTS_PER_WINDOW {
            contact(&state, &bob).unwrap_or_else(|_| panic!("contact {n}"));
        }
        rate_refusal(contact(&state, &bob), TOO_MANY_CONTACTS);
        for n in 0..BLOCKS_PER_WINDOW {
            drop(super::block(&state, &carol).unwrap_or_else(|_| panic!("block {n}")));
        }
        rate_refusal(super::block(&state, &carol), TOO_MANY_BLOCKS);
        done(state, path).await;
    }

    fn me(name: &str) -> Authed {
        Authed(mem_user(name, false))
    }

    fn body<T: serde::de::DeserializeOwned>(value: serde_json::Value) -> Json<T> {
        Json(serde_json::from_value(value).expect("body"))
    }

    async fn block(state: &AppState, by: &str, name: &str) -> (StatusCode, String) {
        status(
            block_user(
                State(state.clone()),
                me(by),
                body(json!({ "username": name })),
            )
            .await,
        )
    }

    async fn dm(state: &AppState, by: &str, name: &str) -> (StatusCode, String) {
        status(
            open_dm(
                State(state.clone()),
                me(by),
                body(json!({ "username": name })),
            )
            .await,
        )
    }

    async fn befriend(state: &AppState, by: &str, name: &str) -> (StatusCode, String) {
        status(
            send_request(
                State(state.clone()),
                me(by),
                body(json!({ "username": name })),
            )
            .await,
        )
    }

    #[tokio::test]
    async fn new_dms_and_friend_requests_share_one_pace() {
        let (state, path) = temp_state("lookup_contact").await;
        let db = &state.db;
        for name in ["alice", "bob"] {
            add_user(db, name).await;
        }
        for n in 0..22 {
            add_user(db, &format!("t{n}")).await;
        }
        for n in 0..10 {
            assert_eq!(
                dm(&state, "alice", &format!("t{n}")).await.0,
                StatusCode::OK,
                "{n}"
            );
            assert_eq!(
                dm(&state, "alice", &format!("nobody{n}")).await.0,
                StatusCode::NOT_FOUND,
                "a miss counts: {n}"
            );
        }
        for n in 10..20 {
            assert_eq!(
                befriend(&state, "alice", &format!("t{n}")).await.0,
                StatusCode::OK,
                "{n}"
            );
        }
        let paced = (StatusCode::TOO_MANY_REQUESTS, TOO_MANY_CONTACTS.to_string());
        assert_eq!(dm(&state, "alice", "t20").await, paced);
        assert_eq!(dm(&state, "alice", "nobody").await, paced);
        assert_eq!(befriend(&state, "alice", "t21").await, paced);
        assert_eq!(
            dm(&state, "alice", "t0").await.0,
            StatusCode::OK,
            "a conversation that exists opens without the pace"
        );
        assert_eq!(dm(&state, "alice", "alice").await.0, StatusCode::OK);
        assert_eq!(
            block(&state, "alice", "t21").await.0,
            StatusCode::OK,
            "blocking is never refused for DMs and requests"
        );
        assert_eq!(dm(&state, "bob", "t1").await.0, StatusCode::OK);
        done(state, path).await;
    }

    #[tokio::test]
    async fn blocks_have_their_own_pace() {
        let (state, path) = temp_state("lookup_blocks").await;
        let db = &state.db;
        for name in ["alice", "bob", "carol", "dave"] {
            add_user(db, name).await;
        }
        for n in 0..61 {
            add_user(db, &format!("raider{n}")).await;
        }
        for n in 0..60 {
            assert_eq!(
                block(&state, "alice", &format!("raider{n}")).await.0,
                StatusCode::OK,
                "{n}"
            );
            assert_eq!(
                block(&state, "alice", &format!("nobody{n}")).await.0,
                StatusCode::NOT_FOUND,
                "{n}"
            );
        }
        let paced = (StatusCode::TOO_MANY_REQUESTS, TOO_MANY_BLOCKS.to_string());
        assert_eq!(block(&state, "alice", "raider60").await, paced);
        assert_eq!(block(&state, "alice", "nobody").await, paced);
        assert_eq!(dm(&state, "alice", "carol").await.0, StatusCode::OK);
        assert_eq!(befriend(&state, "alice", "dave").await.0, StatusCode::OK);
        assert_eq!(
            status(
                unblock_user(
                    State(state.clone()),
                    me("alice"),
                    Path("raider5".to_string())
                )
                .await
            )
            .0,
            StatusCode::OK,
            "unblocking is not paced"
        );
        assert_eq!(
            block(&state, "alice", "alice").await,
            (
                StatusCode::BAD_REQUEST,
                "You cannot block yourself".to_string()
            )
        );
        assert_eq!(block(&state, "bob", "raider0").await.0, StatusCode::OK);
        done(state, path).await;
    }

    async fn untime(state: &AppState, by: &str, name: &str) -> (StatusCode, String) {
        status(
            remove_timeout(
                State(state.clone()),
                me(by),
                Path(("probe".to_string(), name.to_string())),
            )
            .await,
        )
    }

    async fn ban_answer(state: &AppState, by: &str, name: &str) -> Result<(), ApiError> {
        ban_member(
            State(state.clone()),
            me(by),
            Path("probe".to_string()),
            body(json!({ "username": name })),
        )
        .await
        .map(|_| ())
    }

    async fn ban(state: &AppState, by: &str, name: &str) -> (StatusCode, String) {
        status(ban_answer(state, by, name).await)
    }

    async fn rule_answer(
        state: &AppState,
        by: &str,
        channel: i64,
        name: &str,
    ) -> Result<(), ApiError> {
        set_channel_perm(
            State(state.clone()),
            me(by),
            Path(channel),
            body(json!({
                "subject": format!("u:{name}"),
                "can_view": true,
                "can_send": true,
                "can_read_history": true,
            })),
        )
        .await
        .map(|_| ())
    }

    async fn rule(state: &AppState, by: &str, channel: i64, name: &str) -> (StatusCode, String) {
        status(rule_answer(state, by, channel, name).await)
    }

    /// The 400 `text` with the reason `invalid` for the request value `field`.
    fn invalid_refusal(res: Result<(), ApiError>, text: &str, field: &str) {
        let Err(ApiError(code, error, reason)) = res else {
            panic!("{text}: not refused");
        };
        assert_eq!((code, error.as_str()), (StatusCode::BAD_REQUEST, text));
        let Reason {
            kind,
            control,
            retry_after,
            field: named,
            until: _,
            channel: _,
        } = *reason.expect("a reason");
        assert_eq!(
            (kind, control, retry_after, named.as_deref()),
            (ReasonKind::Invalid, None, None, Some(field)),
            "{text}"
        );
    }

    async fn probe_world(db: &Db) -> i64 {
        for name in ["alice", "bob", "carol"] {
            add_user(db, name).await;
        }
        for (owner, server) in [("alice", "probe"), ("carol", "other")] {
            own_server(db, owner, server).await;
        }
        sqlx::query("INSERT INTO channels(server, name, created_at) VALUES('probe', 'general', 0) RETURNING id")
            .fetch_one(db)
            .await
            .expect("channel")
            .try_get(0)
            .expect("id")
    }

    async fn join(db: &Db, server: &str, name: &str) {
        sqlx::query("INSERT INTO members(server, username, is_admin, perms, joined_at) VALUES($1, $2, 0, 0, 0)")
            .bind(server)
            .bind(name)
            .execute(db)
            .await
            .expect("member");
    }

    async fn banned(db: &Db, name: &str) -> i64 {
        sqlx::query("SELECT COUNT(*) FROM server_bans WHERE server = 'probe' AND username = $1")
            .bind(name)
            .fetch_one(db)
            .await
            .expect("bans")
            .try_get(0)
            .expect("n")
    }

    #[tokio::test]
    async fn moderation_by_name_answers_alike() {
        let (state, path) = temp_state("lookup_moderation").await;
        let state = state.with_limits(Arc::new(Limits {
            lookup_misses_per_hour: 3,
            ..Limits::default()
        }));
        let db = &state.db;
        let channel = probe_world(db).await;
        for name in ["dave", "erin", "frank"] {
            add_user(db, name).await;
        }
        join(db, "probe", "dave").await;
        let ok = (StatusCode::OK, String::new());
        for round in 0..5 {
            for name in ["bob", "nobody"] {
                let what = format!("{name}, round {round}");
                assert_eq!(untime(&state, "alice", name).await, ok, "{what}");
                assert_eq!(rule(&state, "alice", channel, name).await, ok, "{what}");
            }
        }
        assert_eq!(ban(&state, "alice", "dave").await, ok, "a member");
        for name in ["bob", "nobody", "bob"] {
            assert_eq!(ban(&state, "alice", name).await, ok, "{name}: one miss");
        }
        for name in ["nobody", "bob", "erin", "nobody2"] {
            assert_eq!(
                ban(&state, "alice", name).await,
                (StatusCode::TOO_MANY_REQUESTS, TOO_MANY_BANS.to_string()),
                "{name}: past the misses, an account outside the server and a missing name alike"
            );
        }
        rate_refusal(ban_answer(&state, "alice", "erin").await, TOO_MANY_BANS);
        for name in ["bob", "nobody"] {
            assert_eq!(untime(&state, "alice", name).await, ok, "{name}");
            assert_eq!(rule(&state, "alice", channel, name).await, ok, "{name}");
        }
        join(db, "probe", "frank").await;
        assert_eq!(
            ban(&state, "alice", "frank").await,
            ok,
            "a member needs no miss"
        );
        assert_eq!(
            card_of(&state, Some("alice"), "ghost").await,
            too_many(),
            "the bans used the misses"
        );
        for (name, n) in [
            ("bob", 1),
            ("nobody", 1),
            ("dave", 1),
            ("frank", 1),
            ("erin", 0),
        ] {
            assert_eq!(banned(db, name).await, n, "{name}");
        }
        for name in ["bob", "nobody"] {
            assert_eq!(
                sqlx::query(
                    "SELECT COUNT(*) FROM channel_perms WHERE channel_id = $1 AND subject = $2"
                )
                .bind(channel)
                .bind(format!("u:{name}"))
                .fetch_one(db)
                .await
                .expect("rules")
                .try_get::<i64, _>(0)
                .expect("n"),
                1,
                "{name} has its rule either way"
            );
        }
        for name in ["", "  ", "a@b"] {
            invalid_refusal(
                ban_answer(&state, "alice", name).await,
                "Invalid username",
                "username",
            );
        }
        invalid_refusal(
            rule_answer(&state, "alice", channel, "a@b").await,
            "Invalid subject",
            "subject",
        );
        done(state, path).await;
    }

    #[tokio::test]
    async fn a_block_of_someone_the_caller_cant_see_is_a_miss() {
        let (state, path) = temp_state("lookup_block_unseen").await;
        let state = state.with_limits(Arc::new(Limits {
            lookup_misses_per_hour: 3,
            ..Limits::default()
        }));
        let db = &state.db;
        probe_world(db).await;
        for name in ["dave", "erin", "frank", "gwen"] {
            add_user(db, name).await;
        }
        join(db, "probe", "bob").await;
        sqlx::query("INSERT INTO privacy(username, profile) VALUES('gwen', 'everyone')")
            .execute(db)
            .await
            .expect("gwen");
        let ok = (StatusCode::OK, String::new());
        for name in ["bob", "gwen", "bob"] {
            assert_eq!(block(&state, "alice", name).await, ok, "{name}: seen");
        }
        assert_eq!(block(&state, "alice", "dave").await, ok, "dave: one miss");
        assert_eq!(
            block(&state, "alice", "nobody").await,
            (StatusCode::NOT_FOUND, "User not found".to_string()),
            "nobody: one miss"
        );
        assert_eq!(block(&state, "alice", "erin").await, ok, "erin: one miss");
        for name in ["frank", "nobody2"] {
            assert_eq!(
                block(&state, "alice", name).await,
                too_many(),
                "{name}: past the misses"
            );
        }
        assert_eq!(card_of(&state, Some("alice"), "ghost").await, too_many());
        done(state, path).await;
    }

    #[tokio::test]
    async fn names_without_an_account_count_as_misses_where_they_answer_404() {
        let (state, path) = temp_state("lookup_by_name").await;
        let state = state.with_limits(Arc::new(Limits {
            lookup_misses_per_hour: 3,
            ..Limits::default()
        }));
        let db = &state.db;
        probe_world(db).await;
        let missing = (StatusCode::NOT_FOUND, "User not found".to_string());
        let hidden = (StatusCode::NOT_FOUND, NOT_FOUND.to_string());
        for _ in 0..5 {
            assert_eq!(
                card_of(&state, Some("alice"), "alice").await.0,
                StatusCode::OK
            );
        }
        assert_eq!(block(&state, "alice", "nobody1").await, missing);
        assert_eq!(card_of(&state, Some("alice"), "nobody2").await, hidden);
        assert_eq!(profile_of(&state, Some("alice"), "nobody3").await, hidden);
        for name in ["bob", "nobody4"] {
            assert_eq!(block(&state, "alice", name).await, too_many(), "{name}");
            assert_eq!(card_of(&state, Some("alice"), name).await, too_many());
            assert_eq!(profile_of(&state, Some("alice"), name).await, too_many());
        }
        assert_eq!(
            block(&state, "carol", "ghost").await,
            missing,
            "carol's own count"
        );
        assert_eq!(card_of(&state, Some("carol"), "ghost").await, hidden);
        assert_eq!(
            card_of(&state, Some("carol"), "ghost2").await,
            hidden,
            "the third miss"
        );
        assert_eq!(block(&state, "carol", "bob").await, too_many());
        assert_eq!(card_of(&state, Some("carol"), "carol").await, too_many());
        done(state, path).await;
    }

    async fn own_server(db: &Db, owner: &str, server: &str) {
        for stmt in [
            "INSERT INTO servers(name, display_name, creator, created_at) VALUES($1, $1, $2, 0)",
            "INSERT INTO members(server, username, is_admin, perms, joined_at) VALUES($1, $2, 1, 0, 0)",
        ] {
            sqlx::query(stmt)
                .bind(server)
                .bind(owner)
                .execute(db)
                .await
                .expect(stmt);
        }
    }

    #[tokio::test]
    async fn lookups_in_flight_hold_their_miss() {
        let (state, path) = temp_state("lookup_in_flight").await;
        let state = state.with_limits(Arc::new(Limits {
            lookup_misses_per_hour: 3,
            ..Limits::default()
        }));
        add_user(&state.db, "alice").await;
        own_server(&state.db, "alice", "probe").await;
        let alice = mem_user("alice", false);
        let held: Vec<_> = (0..3).map(|_| unmissed(&state, Some(&alice))).collect();
        assert!(held.iter().all(Result::is_ok));
        assert_eq!(
            status(unmissed(&state, Some(&alice))),
            too_many(),
            "three lookups in flight hold the three misses"
        );
        drop(held);
        let names: Vec<String> = (0..12).map(|n| format!("nobody{n}")).collect();
        let answers = futures_util::future::join_all(
            names
                .iter()
                .map(|name| card_of(&state, Some("alice"), name)),
        )
        .await;
        let missing = (StatusCode::NOT_FOUND, NOT_FOUND.to_string());
        assert_eq!(
            answers.iter().filter(|answer| **answer == missing).count(),
            3,
            "{answers:?}"
        );
        assert!(
            answers
                .iter()
                .all(|answer| *answer == missing || *answer == too_many()),
            "{answers:?}"
        );
        assert_eq!(card_of(&state, Some("alice"), "nobody").await, too_many());
        done(state, path).await;
    }

    async fn member_profile(
        state: &AppState,
        viewer: &str,
        name: &str,
        server: &str,
    ) -> (StatusCode, String) {
        status(
            profile(
                State(state.clone()),
                MaybeAuthed(Some(mem_user(viewer, false))),
                HeaderMap::new(),
                Path(name.to_string()),
                Query(
                    serde_json::from_value::<ProfileQuery>(json!({ "server": server }))
                        .expect("query"),
                ),
            )
            .await,
        )
    }

    #[tokio::test]
    async fn a_membership_the_caller_sees_is_not_a_miss() {
        let (state, path) = temp_state("lookup_member_profile").await;
        let state = state.with_limits(Arc::new(Limits {
            lookup_profile_per_minute: 10_000,
            lookup_misses_per_hour: 3,
            ..Limits::default()
        }));
        let db = &state.db;
        for name in ["alice", "carol"] {
            add_user(db, name).await;
        }
        own_server(db, "alice", "club").await;
        for stmt in [
            "INSERT INTO members(server, username, is_admin, perms, joined_at) VALUES('club', 'carol', 0, 0, 0)",
            "INSERT INTO privacy(username, profile) VALUES('carol', 'friends')",
        ] {
            sqlx::query(stmt).execute(db).await.expect(stmt);
        }
        let hidden = (StatusCode::NOT_FOUND, NOT_FOUND.to_string());
        for n in 0..5 {
            assert_eq!(
                member_profile(&state, "alice", "carol", "club").await,
                hidden,
                "the old shape hides a profile whose membership the caller sees: {n}"
            );
        }
        for n in 0..3 {
            assert_eq!(
                card_of(&state, Some("alice"), &format!("ghost{n}")).await,
                hidden,
                "the misses are all left: {n}"
            );
        }
        assert_eq!(card_of(&state, Some("alice"), "ghost").await, too_many());
        assert_eq!(
            member_profile(&state, "alice", "carol", "club").await,
            too_many()
        );
        done(state, path).await;
    }

    #[test]
    fn a_refusal_never_says_to_wait_less_than_needed() {
        let wait = |d: Duration| {
            limited("contact", "Slow down", d)
                .2
                .and_then(|r| r.retry_after)
        };
        assert_eq!(wait(Duration::from_millis(59_100)), Some(60));
        assert_eq!(wait(Duration::from_secs(60)), Some(60));
        assert_eq!(wait(Duration::from_millis(300)), Some(1));
        assert_eq!(wait(Duration::ZERO), Some(1));
    }
}
