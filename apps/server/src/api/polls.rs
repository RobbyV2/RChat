use std::collections::{HashMap, HashSet};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use hmac::{Hmac, KeyInit, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use sqlx::Row;
use utoipa::{IntoParams, ToSchema};

use crate::api::access::perms::Perm;
use crate::api::access::{Proof, ResolvedMessage, not_found, resolve_message};
use crate::api::audit;
use crate::api::reactions::canonical_emoji;
use crate::api::{
    ApiError, ApiErrorBody, Authed, MaybeAuthed, Message, Paged, ProfanityTarget, Settings,
    UserRef, bad, check_len, cursor_int, decode_cursor, encode_cursor, placeholders,
    require_guest_ok, user_from, user_refs,
};
use crate::db::{Db, User, is_sqlite, now, pool_key};
use crate::state::AppState;
use crate::ws::WsEvent;

pub const QUESTION_MAX: usize = 300;
pub const OPTION_MAX: usize = 100;
pub const OPTIONS_MIN: usize = 2;
pub const OPTIONS_MAX: usize = 20;
/// Shortest and longest poll deadline, in seconds from creation.
pub const DURATION_MIN: i64 = 60;
pub const DURATION_MAX: i64 = 30 * 86400;
pub const VOTERS_PAGE: i64 = 50;
/// At most one `poll_updated` per poll in this time; votes in between are coalesced.
pub const UPDATE_EVERY: Duration = Duration::from_secs(1);
/// Due polls one deadline sweep closes.
const CLOSE_BATCH: i64 = 500;

/// What kind of vote a poll takes.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum PollKind {
    /// Pick one option.
    Single,
    /// Pick between `min_choices` and `max_choices` options.
    Multiple,
    /// Rank some or all options; counted by instant runoff.
    Ranked,
    /// Give a score from 1 to `scale`; no options.
    Rating,
    /// Yes, No or Abstain (fixed options).
    YesNo,
}

impl PollKind {
    fn as_str(self) -> &'static str {
        match self {
            PollKind::Single => "single",
            PollKind::Multiple => "multiple",
            PollKind::Ranked => "ranked",
            PollKind::Rating => "rating",
            PollKind::YesNo => "yes_no",
        }
    }

    fn parse(text: &str) -> Result<PollKind, ApiError> {
        match text {
            "single" => Ok(PollKind::Single),
            "multiple" => Ok(PollKind::Multiple),
            "ranked" => Ok(PollKind::Ranked),
            "rating" => Ok(PollKind::Rating),
            "yes_no" => Ok(PollKind::YesNo),
            other => Err(ApiError(
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("invalid poll kind: {other}"),
            )),
        }
    }

    /// Kinds whose options the author writes (and members may add to).
    fn written(self) -> bool {
        matches!(
            self,
            PollKind::Single | PollKind::Multiple | PollKind::Ranked
        )
    }
}

/// Who may see the counts.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ShowResults {
    /// Everyone who can read the poll.
    Always,
    /// Those who voted, and everyone once the poll is closed. When votes can be changed, a
    /// voter may take their vote back after seeing the counts.
    AfterVote,
    /// Everyone, once the poll is closed.
    AfterClose,
}

impl ShowResults {
    fn as_str(self) -> &'static str {
        match self {
            ShowResults::Always => "always",
            ShowResults::AfterVote => "after_vote",
            ShowResults::AfterClose => "after_close",
        }
    }

    fn parse(text: &str) -> Result<ShowResults, ApiError> {
        match text {
            "always" => Ok(ShowResults::Always),
            "after_vote" => Ok(ShowResults::AfterVote),
            "after_close" => Ok(ShowResults::AfterClose),
            other => Err(ApiError(
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("invalid poll results setting: {other}"),
            )),
        }
    }
}

fn always() -> ShowResults {
    ShowResults::Always
}

/// One option of a new poll.
#[derive(Clone, Deserialize, ToSchema)]
pub struct PollOptionReq {
    /// The option text, 1 to 100 characters after trimming. Options of one poll must differ
    /// (ignoring case).
    #[schema(example = "Pizza")]
    pub text: String,
    /// Optional emoji shown before the text: one emoji of the Unicode emoji list.
    #[serde(default)]
    pub emoji: Option<String>,
}

/// A poll to post as a message (`SendReq.poll`). The message text is the question.
#[derive(Clone, Deserialize, ToSchema)]
pub struct PollReq {
    /// The question, 1 to 300 characters after trimming.
    #[schema(example = "Where do we eat?")]
    pub question: String,
    /// What kind of vote it takes.
    pub kind: PollKind,
    /// 2 to 20 options for `single`, `multiple` and `ranked`; must be empty for `rating` and
    /// `yes_no` (which get Yes, No and Abstain).
    #[serde(default)]
    pub options: Vec<PollOptionReq>,
    /// Votes are anonymous: nobody can list who voted for what, and live updates go out in
    /// 5-second steps. This holds against API users; someone with the database and the password
    /// pepper (unless `PASSWORD_PEPPER` is set outside it) could still link votes to accounts.
    /// Defaults to `false`.
    #[serde(default)]
    pub anonymous: bool,
    /// Defaults to `always`.
    #[serde(default = "always")]
    pub show_results: ShowResults,
    /// Voters may change or take back their vote while the poll is open. Defaults to `true`.
    #[serde(default = "crate::api::yes")]
    #[schema(default = true)]
    pub allow_change: bool,
    /// Members who can vote may add options (up to 20 in total) while the poll is open; only for
    /// `single`, `multiple` and `ranked`. Defaults to `false`.
    #[serde(default)]
    pub allow_add: bool,
    /// For `multiple`: fewest options a vote must pick, 1 to the number of options. Default 1.
    #[serde(default)]
    pub min_choices: Option<i64>,
    /// For `multiple`: most options a vote may pick, `min_choices` to the number of options.
    /// Defaults to the number of options.
    #[serde(default)]
    pub max_choices: Option<i64>,
    /// For `rating`: 5 or 10. Default 5.
    #[serde(default)]
    pub scale: Option<i64>,
    /// Close the poll this many seconds after posting, 60 to 2592000 (30 days). Omit for no
    /// deadline.
    #[serde(default)]
    #[schema(example = 86400)]
    pub duration_seconds: Option<i64>,
}

/// One option of a poll.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, ToSchema)]
pub struct PollOption {
    /// Option id, used in votes and counts.
    pub id: i64,
    /// The option text.
    pub text: String,
    /// The emoji shown before the text, or `null`.
    pub emoji: Option<String>,
}

/// Votes for one option.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, ToSchema)]
pub struct OptionCount {
    /// The option's id (`PollOption.id`).
    pub option_id: i64,
    /// How many ballots count for it.
    pub count: i64,
}

/// One instant-runoff round.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, ToSchema)]
pub struct RunoffRound {
    /// Ballots for each option still in the race (each ballot counts for its highest-ranked
    /// option still in the race), in option order.
    pub counts: Vec<OptionCount>,
    /// Ballots that rank no option still in the race.
    pub exhausted: i64,
    /// The option eliminated after this round; `null` in the last round.
    pub eliminated: Option<i64>,
}

/// Counts of a poll. Never includes who voted.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, ToSchema)]
pub struct PollResults {
    /// Ballots per option in option order: for `single`, `multiple` and `yes_no` the ballots
    /// that picked it, for `ranked` the ballots that ranked it first. Empty for `rating`.
    pub counts: Vec<OptionCount>,
    /// `ranked` only: the instant-runoff rounds, first to last.
    pub rounds: Vec<RunoffRound>,
    /// `ranked`: the runoff winner. `single`, `multiple`, `yes_no`: the option with the most
    /// votes when exactly one has the most. `null` without votes or on a tie.
    pub winner: Option<i64>,
    /// `rating` only: how many voters gave each score, from 1 to `scale`.
    pub distribution: Vec<i64>,
    /// `rating` only: the average score; `null` without votes.
    pub average: Option<f64>,
}

/// A poll as one viewer sees it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, ToSchema)]
pub struct Poll {
    /// What kind of vote it takes.
    pub kind: PollKind,
    /// The question (also the message's `content`).
    #[schema(example = "Where do we eat?")]
    pub question: String,
    /// In display order; empty for `rating`.
    pub options: Vec<PollOption>,
    /// Nobody can list who voted for what.
    pub anonymous: bool,
    /// Who may see the counts.
    pub show_results: ShowResults,
    /// Voters may change or take back their vote while it is open.
    pub allow_change: bool,
    /// Members who can vote may add options while it is open.
    pub allow_add: bool,
    /// For `multiple` the fewest options a vote must pick; 1 for other kinds.
    pub min_choices: i64,
    /// For `multiple` the most options a vote may pick; 1 for other kinds.
    pub max_choices: i64,
    /// For `rating`, 5 or 10; `null` otherwise.
    pub scale: Option<i64>,
    /// Unix seconds of the deadline; `null` without one.
    pub closes_at: Option<i64>,
    /// No more votes: closed early or past the deadline.
    pub closed: bool,
    /// How many people voted.
    pub voters: i64,
    /// The counts, or `null` while they are hidden from this viewer (see `show_results`).
    pub results: Option<PollResults>,
    /// The viewer's own vote: option ids (in rank order for `ranked`), or the score for
    /// `rating`. `null` when they did not vote, and in WebSocket events.
    pub mine: Option<Vec<i64>>,
    /// A copy made when the poll was forwarded: it never changes and takes no votes.
    #[serde(default)]
    pub snapshot: bool,
}

/// A vote. Send `options` for `single`, `multiple`, `ranked` and `yes_no`, `value` for
/// `rating`.
#[derive(Deserialize, ToSchema)]
pub struct VoteReq {
    /// Option ids: exactly one for `single` and `yes_no`, `min_choices` to `max_choices`
    /// different ones for `multiple`, and for `ranked` one or more different ones, best first
    /// (options left out are unranked).
    #[serde(default)]
    pub options: Vec<i64>,
    /// The score for `rating`, 1 to `scale`.
    #[serde(default)]
    pub value: Option<i64>,
}

/// A new option for a poll that allows adding them.
#[derive(Deserialize, ToSchema)]
pub struct AddOptionReq {
    /// The option text, 1 to 100 characters after trimming, different from the others
    /// (ignoring case).
    #[schema(example = "Tacos")]
    pub text: String,
    /// Optional emoji shown before the text: one emoji of the Unicode emoji list.
    #[serde(default)]
    pub emoji: Option<String>,
}

/// Voter list paging.
#[derive(Deserialize, IntoParams)]
pub struct VotersQuery {
    /// Only voters who picked this option (for `ranked`: ranked it first). For `rating`, the
    /// score instead. Omit for everyone who voted.
    option: Option<i64>,
    /// `x-next-cursor` of the previous page.
    cursor: Option<String>,
    /// Page size, default and maximum 50.
    #[param(example = 50)]
    limit: Option<i64>,
}

/// Someone who voted.
#[derive(Serialize, ToSchema)]
pub struct PollVoter {
    /// Who voted.
    pub user: UserRef,
    /// Unix seconds of their current vote.
    pub voted_at: i64,
}

/// A validated new poll.
pub(crate) struct PollSpec {
    kind: PollKind,
    question: String,
    options: Vec<(String, Option<String>)>,
    anonymous: bool,
    show_results: ShowResults,
    allow_change: bool,
    allow_add: bool,
    min_choices: i64,
    max_choices: i64,
    scale: Option<i64>,
    duration: Option<i64>,
}

impl PollSpec {
    pub(crate) fn question(&self) -> &str {
        &self.question
    }
}

fn option_text(text: &str) -> Result<String, ApiError> {
    let text = text.trim();
    if text.is_empty() {
        return Err(bad("Options cannot be empty"));
    }
    check_len(text, OPTION_MAX, "An option")?;
    Ok(text.to_string())
}

fn option_emoji(emoji: Option<String>) -> Result<Option<String>, ApiError> {
    match emoji.as_deref().map(str::trim).filter(|e| !e.is_empty()) {
        Some(e) => canonical_emoji(e)
            .map(|e| Some(e.to_string()))
            .ok_or_else(|| bad("Not an emoji")),
        None => Ok(None),
    }
}

/// Checks a new poll. The profanity filter (server channels only) runs on the question and
/// every option.
pub(crate) fn validate(req: PollReq, settings: Option<&Settings>) -> Result<PollSpec, ApiError> {
    let PollReq {
        question,
        kind,
        options,
        anonymous,
        show_results,
        allow_change,
        allow_add,
        min_choices,
        max_choices,
        scale,
        duration_seconds,
    } = req;
    let question = question.trim().to_string();
    if question.is_empty() {
        return Err(bad("The question cannot be empty"));
    }
    check_len(&question, QUESTION_MAX, "The question")?;
    let options = match kind.written() {
        true => {
            if options.len() < OPTIONS_MIN || options.len() > OPTIONS_MAX {
                return Err(bad("A poll needs 2 to 20 options"));
            }
            let mut seen = HashSet::with_capacity(options.len());
            let mut out = Vec::with_capacity(options.len());
            for PollOptionReq { text, emoji } in options {
                let text = option_text(&text)?;
                if !seen.insert(text.to_lowercase()) {
                    return Err(bad("Options must be different"));
                }
                out.push((text, option_emoji(emoji)?));
            }
            out
        }
        false if !options.is_empty() => return Err(bad("This kind of poll has no options")),
        false => match kind {
            PollKind::YesNo => ["Yes", "No", "Abstain"]
                .iter()
                .map(|t| (t.to_string(), None))
                .collect(),
            _ => Vec::new(),
        },
    };
    let n = options.len() as i64;
    let (min_choices, max_choices) = match kind {
        PollKind::Multiple => {
            let min = min_choices.unwrap_or(1);
            let max = max_choices.unwrap_or(n);
            if min < 1 || min > n || max < min || max > n {
                return Err(bad("Invalid number of choices"));
            }
            (min, max)
        }
        _ => (1, 1),
    };
    let scale = match (kind, scale) {
        (PollKind::Rating, None) => Some(5),
        (PollKind::Rating, Some(s)) if s == 5 || s == 10 => Some(s),
        (PollKind::Rating, Some(_)) => return Err(bad("The scale must be 5 or 10")),
        (_, _) => None,
    };
    if allow_add && !kind.written() {
        return Err(bad("Options cannot be added to this kind of poll"));
    }
    if let Some(d) = duration_seconds
        && !(DURATION_MIN..=DURATION_MAX).contains(&d)
    {
        return Err(bad("The deadline must be 1 minute to 30 days away"));
    }
    if let Some(settings) = settings {
        settings.check_profanity(ProfanityTarget::Messages, &question)?;
        for (text, _) in &options {
            settings.check_profanity(ProfanityTarget::Messages, text)?;
        }
    }
    Ok(PollSpec {
        kind,
        question,
        options,
        anonymous,
        show_results,
        allow_change,
        allow_add,
        min_choices,
        max_choices,
        scale,
        duration: duration_seconds,
    })
}

/// Stores the poll of the new message `id` (inside its transaction).
pub(crate) async fn insert(
    conn: &mut sqlx::AnyConnection,
    id: i64,
    spec: &PollSpec,
    created_at: i64,
) -> sqlx::Result<()> {
    let PollSpec {
        kind,
        question,
        options,
        anonymous,
        show_results,
        allow_change,
        allow_add,
        min_choices,
        max_choices,
        scale,
        duration,
    } = spec;
    sqlx::query("INSERT INTO polls(message_id, kind, question, anonymous, results, allow_change, allow_add, min_choices, max_choices, scale, closes_at, created_at) VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)")
        .bind(id)
        .bind(kind.as_str())
        .bind(question)
        .bind(*anonymous as i64)
        .bind(show_results.as_str())
        .bind(*allow_change as i64)
        .bind(*allow_add as i64)
        .bind(*min_choices)
        .bind(*max_choices)
        .bind(*scale)
        .bind(duration.map(|d| created_at + d))
        .bind(created_at)
        .execute(&mut *conn)
        .await?;
    for (position, (text, emoji)) in options.iter().enumerate() {
        sqlx::query("INSERT INTO poll_options(message_id, position, text, emoji, created_at) VALUES($1, $2, $3, $4, $5)")
            .bind(id)
            .bind(position as i64)
            .bind(text)
            .bind(emoji)
            .bind(created_at)
            .execute(&mut *conn)
            .await?;
    }
    Ok(())
}

/// A stored poll's settings.
#[derive(Clone, Debug)]
struct Def {
    kind: PollKind,
    question: String,
    anonymous: bool,
    show_results: ShowResults,
    allow_change: bool,
    allow_add: bool,
    min_choices: i64,
    max_choices: i64,
    scale: Option<i64>,
    closes_at: Option<i64>,
    closed_at: Option<i64>,
    /// Bumped in the transaction of every change to votes, options or the open state.
    version: i64,
}

const DEF_COLS: &str = "message_id, kind, question, anonymous, results, allow_change, allow_add, min_choices, max_choices, scale, closes_at, closed_at, version";

fn row_def(r: &sqlx::any::AnyRow) -> Result<(i64, Def), ApiError> {
    Ok((
        r.try_get(0)?,
        Def {
            kind: PollKind::parse(&r.try_get::<String, _>(1)?)?,
            question: r.try_get(2)?,
            anonymous: r.try_get::<i64, _>(3)? != 0,
            show_results: ShowResults::parse(&r.try_get::<String, _>(4)?)?,
            allow_change: r.try_get::<i64, _>(5)? != 0,
            allow_add: r.try_get::<i64, _>(6)? != 0,
            min_choices: r.try_get(7)?,
            max_choices: r.try_get(8)?,
            scale: r.try_get(9)?,
            closes_at: r.try_get(10)?,
            closed_at: r.try_get(11)?,
            version: r.try_get(12)?,
        },
    ))
}

impl Def {
    fn closed(&self, t: i64) -> bool {
        self.closed_at.is_some() || self.closes_at.is_some_and(|at| at <= t)
    }

    /// Everyone who can read the poll may see the counts.
    fn public(&self, t: i64) -> bool {
        self.show_results == ShowResults::Always || self.closed(t)
    }

    fn shown_to(&self, t: i64, voted: bool) -> bool {
        self.public(t) || (self.show_results == ShowResults::AfterVote && voted)
    }
}

fn binds<'q>(
    sql: String,
    ids: &'q [i64],
) -> sqlx::query::Query<'q, sqlx::Any, sqlx::any::AnyArguments> {
    let mut query = sqlx::query(sqlx::AssertSqlSafe(sql));
    for id in ids {
        query = query.bind(*id);
    }
    query
}

async fn defs(db: &Db, ids: &[i64]) -> Result<HashMap<i64, Def>, ApiError> {
    if ids.is_empty() {
        return Ok(HashMap::new());
    }
    let sql = format!(
        "SELECT {DEF_COLS} FROM polls WHERE message_id IN ({})",
        placeholders(1, ids.len())
    );
    binds(sql, ids)
        .fetch_all(db)
        .await?
        .iter()
        .map(row_def)
        .collect()
}

async fn options_of(db: &Db, ids: &[i64]) -> Result<HashMap<i64, Vec<PollOption>>, ApiError> {
    let mut out: HashMap<i64, Vec<PollOption>> = HashMap::new();
    if ids.is_empty() {
        return Ok(out);
    }
    let sql = format!(
        "SELECT message_id, id, text, emoji FROM poll_options WHERE message_id IN ({}) ORDER BY message_id, position, id",
        placeholders(1, ids.len())
    );
    for r in binds(sql, ids).fetch_all(db).await? {
        out.entry(r.try_get(0)?).or_default().push(PollOption {
            id: r.try_get(1)?,
            text: r.try_get(2)?,
            emoji: r.try_get(3)?,
        });
    }
    Ok(out)
}

async fn voter_counts(db: &Db, ids: &[i64]) -> Result<HashMap<i64, i64>, ApiError> {
    let mut out = HashMap::new();
    if ids.is_empty() {
        return Ok(out);
    }
    let sql = format!(
        "SELECT message_id, COUNT(DISTINCT voter) FROM poll_votes WHERE message_id IN ({}) GROUP BY message_id",
        placeholders(1, ids.len())
    );
    for r in binds(sql, ids).fetch_all(db).await? {
        out.insert(r.try_get(0)?, r.try_get(1)?);
    }
    Ok(out)
}

async fn voter_keys(db: &Db, ids: &[i64]) -> Result<HashMap<i64, HashSet<String>>, ApiError> {
    let mut out: HashMap<i64, HashSet<String>> = HashMap::new();
    if ids.is_empty() {
        return Ok(out);
    }
    let sql = format!(
        "SELECT DISTINCT message_id, voter FROM poll_votes WHERE message_id IN ({})",
        placeholders(1, ids.len())
    );
    for r in binds(sql, ids).fetch_all(db).await? {
        out.entry(r.try_get(0)?).or_default().insert(r.try_get(1)?);
    }
    Ok(out)
}

/// One stored vote: (option id, value) pairs, ordered by value then option id. For `rating`
/// the option id is 0 and the value the score; for `ranked` the value is the rank.
type Ballot = Vec<(i64, i64)>;

async fn ballots(db: &Db, ids: &[i64]) -> Result<HashMap<i64, Vec<Ballot>>, ApiError> {
    let mut out: HashMap<i64, Vec<Ballot>> = HashMap::new();
    if ids.is_empty() {
        return Ok(out);
    }
    let sql = format!(
        "SELECT message_id, voter, option_id, value FROM poll_votes WHERE message_id IN ({}) ORDER BY message_id, voter, value, option_id",
        placeholders(1, ids.len())
    );
    let mut last: Option<(i64, String)> = None;
    for r in binds(sql, ids).fetch_all(db).await? {
        let (id, voter): (i64, String) = (r.try_get(0)?, r.try_get(1)?);
        let list = out.entry(id).or_default();
        let pair = (r.try_get::<i64, _>(2)?, r.try_get::<i64, _>(3)?);
        let key = Some((id, voter));
        match last == key {
            true => match list.last_mut() {
                Some(ballot) => ballot.push(pair),
                None => list.push(vec![pair]),
            },
            false => list.push(vec![pair]),
        }
        last = key;
    }
    Ok(out)
}

/// How many vote rows each (option id, value) pair has, per poll.
type Groups = HashMap<(i64, i64), i64>;

async fn groups(db: &Db, ids: &[i64]) -> Result<HashMap<i64, Groups>, ApiError> {
    let mut out: HashMap<i64, Groups> = HashMap::new();
    if ids.is_empty() {
        return Ok(out);
    }
    let sql = format!(
        "SELECT message_id, option_id, value, COUNT(*) FROM poll_votes WHERE message_id IN ({}) GROUP BY message_id, option_id, value",
        placeholders(1, ids.len())
    );
    for r in binds(sql, ids).fetch_all(db).await? {
        out.entry(r.try_get(0)?)
            .or_default()
            .insert((r.try_get(1)?, r.try_get(2)?), r.try_get(3)?);
    }
    Ok(out)
}

/// The deterministic instant runoff. Each round, every ballot counts for its highest-ranked
/// option still in the race; ballots with none left are exhausted. An option with more than
/// half of the counted ballots wins, as does the last one left. Otherwise the option with the
/// fewest ballots is eliminated. A tie for fewest is broken by the fewest ballots in the latest
/// earlier round where the tied options differ, and then by eliminating the one listed last.
pub fn instant_runoff(options: &[i64], ballots: &[Vec<i64>]) -> (Vec<RunoffRound>, Option<i64>) {
    let mut left: Vec<i64> = options.to_vec();
    let mut rounds: Vec<RunoffRound> = Vec::new();
    let mut history: Vec<HashMap<i64, i64>> = Vec::new();
    loop {
        let mut tally: HashMap<i64, i64> = left.iter().map(|o| (*o, 0)).collect();
        let mut exhausted = 0;
        for ballot in ballots {
            match ballot.iter().find(|o| tally.contains_key(o)) {
                Some(o) => *tally.entry(*o).or_default() += 1,
                None => exhausted += 1,
            }
        }
        let counted: i64 = tally.values().sum();
        let counts: Vec<OptionCount> = left
            .iter()
            .map(|o| OptionCount {
                option_id: *o,
                count: tally[o],
            })
            .collect();
        let majority = left.iter().find(|o| tally[*o] * 2 > counted).copied();
        let winner = match (counted, majority, left.as_slice()) {
            (0, _, _) => {
                rounds.push(RunoffRound {
                    counts,
                    exhausted,
                    eliminated: None,
                });
                return (rounds, None);
            }
            (_, Some(o), _) => Some(o),
            (_, None, [o]) => Some(*o),
            (_, None, _) => None,
        };
        if winner.is_some() {
            rounds.push(RunoffRound {
                counts,
                exhausted,
                eliminated: None,
            });
            return (rounds, winner);
        }
        let low = left.iter().map(|o| tally[o]).min().unwrap_or(0);
        let mut tied: Vec<i64> = left.iter().copied().filter(|o| tally[o] == low).collect();
        for past in history.iter().rev() {
            if tied.len() == 1 {
                break;
            }
            let fewest = tied.iter().map(|o| past[o]).min().unwrap_or(0);
            tied.retain(|o| past[o] == fewest);
        }
        let out = *tied.last().unwrap_or(&left[left.len() - 1]);
        rounds.push(RunoffRound {
            counts,
            exhausted,
            eliminated: Some(out),
        });
        history.push(tally);
        left.retain(|o| *o != out);
    }
}

/// The option with the most votes when exactly one has the most.
fn leader(counts: &[OptionCount]) -> Option<i64> {
    let top = counts.iter().map(|c| c.count).max().unwrap_or(0);
    let mut leaders = counts.iter().filter(|c| c.count == top);
    match (top, leaders.next(), leaders.next()) {
        (0, _, _) | (_, _, Some(_)) | (_, None, None) => None,
        (_, Some(c), None) => Some(c.option_id),
    }
}

/// Counts of a `ranked` poll from its ballots.
fn ranked_tally(options: &[PollOption], ballots: &[Ballot]) -> PollResults {
    let ids: Vec<i64> = options.iter().map(|o| o.id).collect();
    let mut first: HashMap<i64, i64> = HashMap::new();
    for (o, _) in ballots.iter().filter_map(|b| b.first()) {
        *first.entry(*o).or_default() += 1;
    }
    let counts = ids
        .iter()
        .map(|id| OptionCount {
            option_id: *id,
            count: first.get(id).copied().unwrap_or(0),
        })
        .collect();
    let ranked: Vec<Vec<i64>> = ballots
        .iter()
        .map(|b| b.iter().map(|(o, _)| *o).collect())
        .collect();
    let (rounds, winner) = instant_runoff(&ids, &ranked);
    PollResults {
        counts,
        rounds,
        winner,
        distribution: Vec::new(),
        average: None,
    }
}

/// Counts of the other kinds from how many rows each (option, value) pair has: one row per
/// picked option for `single`, `multiple` and `yes_no`, one row (option 0, score) for `rating`.
fn counted(def: &Def, options: &[PollOption], groups: &Groups) -> PollResults {
    match def.kind {
        PollKind::Rating => {
            let scale = def.scale.unwrap_or(5).max(1);
            let mut distribution = vec![0; scale as usize];
            let mut sum = 0;
            let mut n = 0;
            for ((option, value), count) in groups {
                if *option == 0 && (1..=scale).contains(value) {
                    distribution[(*value - 1) as usize] += count;
                    sum += value * count;
                    n += count;
                }
            }
            PollResults {
                counts: Vec::new(),
                rounds: Vec::new(),
                winner: None,
                distribution,
                average: (n > 0).then(|| ((sum as f64 / n as f64) * 100.0).round() / 100.0),
            }
        }
        PollKind::Single | PollKind::Multiple | PollKind::YesNo | PollKind::Ranked => {
            let counts: Vec<OptionCount> = options
                .iter()
                .map(|o| OptionCount {
                    option_id: o.id,
                    count: groups
                        .iter()
                        .filter(|((option, _), _)| *option == o.id)
                        .map(|(_, n)| *n)
                        .sum(),
                })
                .collect();
            let winner = leader(&counts);
            PollResults {
                counts,
                rounds: Vec::new(),
                winner,
                distribution: Vec::new(),
                average: None,
            }
        }
    }
}

/// The counts of one poll at one `version`, shared by every read until the next change.
pub(crate) struct Tally {
    voters: i64,
    results: PollResults,
    /// The stored voters, kept for open `after_vote` polls only (to send voters their counts).
    keys: Option<HashSet<String>>,
}

type Tallies = HashMap<(String, i64), (i64, Arc<Tally>)>;

/// The latest tally of each poll (keyed by pool and poll id), with the version it counts. A
/// changed poll has a new version, so a stale entry is never used.
static TALLIES: LazyLock<Mutex<Tallies>> = LazyLock::new(Default::default);
const TALLY_CACHE: usize = 4096;

/// How often each poll was counted, for tests.
#[cfg(test)]
static TALLY_RUNS: LazyLock<Mutex<HashMap<(String, i64), u64>>> = LazyLock::new(Default::default);

#[cfg(test)]
pub(crate) fn tally_runs(db: &Db, id: i64) -> u64 {
    TALLY_RUNS
        .lock()
        .ok()
        .and_then(|runs| runs.get(&(pool_key(db), id)).copied())
        .unwrap_or(0)
}

fn cached(db: &Db, id: i64, version: i64) -> Option<Arc<Tally>> {
    let tallies = TALLIES.lock().ok()?;
    match tallies.get(&(pool_key(db), id)) {
        Some((v, tally)) if version == *v => Some(tally.clone()),
        Some(_) | None => None,
    }
}

fn keeps_keys(def: &Def, t: i64) -> bool {
    def.show_results == ShowResults::AfterVote && !def.closed(t)
}

/// The tallies of the polls `ids` (all in `defs`), from the cache or counted once per version.
/// `options` are the polls' options when the caller loaded them with `defs`.
async fn tallies(
    db: &Db,
    defs: &HashMap<i64, Def>,
    ids: &[i64],
    options: Option<&HashMap<i64, Vec<PollOption>>>,
) -> Result<HashMap<i64, Arc<Tally>>, ApiError> {
    let t = now();
    let mut out = HashMap::with_capacity(ids.len());
    let mut missing = Vec::new();
    for id in ids {
        let Some(def) = defs.get(id) else {
            continue;
        };
        match cached(db, *id, def.version) {
            Some(tally) if tally.keys.is_some() || !keeps_keys(def, t) => {
                out.insert(*id, tally);
            }
            Some(_) | None => missing.push(*id),
        }
    }
    if missing.is_empty() {
        return Ok(out);
    }
    let loaded;
    let options = match options {
        Some(options) => options,
        None => {
            loaded = options_of(db, &missing).await?;
            &loaded
        }
    };
    let (ranked, plain): (Vec<i64>, Vec<i64>) = missing
        .iter()
        .partition(|id| defs[*id].kind == PollKind::Ranked);
    let keyed: Vec<i64> = missing
        .iter()
        .copied()
        .filter(|id| keeps_keys(&defs[id], t))
        .collect();
    let counts = voter_counts(db, &missing).await?;
    let mut keys = voter_keys(db, &keyed).await?;
    let mut all = ballots(db, &ranked).await?;
    let mut grouped = groups(db, &plain).await?;
    let empty = Vec::new();
    for id in missing {
        let def = &defs[&id];
        let opts = options.get(&id).unwrap_or(&empty);
        let results = match def.kind {
            PollKind::Ranked => ranked_tally(opts, &all.remove(&id).unwrap_or_default()),
            _ => counted(def, opts, &grouped.remove(&id).unwrap_or_default()),
        };
        let tally = Arc::new(Tally {
            voters: counts.get(&id).copied().unwrap_or(0),
            results,
            keys: match keeps_keys(def, t) {
                true => Some(keys.remove(&id).unwrap_or_default()),
                false => None,
            },
        });
        if let Ok(mut tallies) = TALLIES.lock() {
            if tallies.len() >= TALLY_CACHE {
                tallies.clear();
            }
            let key = (pool_key(db), id);
            if tallies.get(&key).is_none_or(|(v, _)| *v <= def.version) {
                tallies.insert(key, (def.version, tally.clone()));
            }
        }
        #[cfg(test)]
        if let Ok(mut runs) = TALLY_RUNS.lock() {
            *runs.entry((pool_key(db), id)).or_default() += 1;
        }
        out.insert(id, tally);
    }
    Ok(out)
}

fn view(def: &Def, options: Vec<PollOption>, voters: i64, results: Option<PollResults>) -> Poll {
    let Def {
        kind,
        question,
        anonymous,
        show_results,
        allow_change,
        allow_add,
        min_choices,
        max_choices,
        scale,
        closes_at,
        closed_at: _,
        version: _,
    } = def.clone();
    Poll {
        kind,
        question,
        options,
        anonymous,
        show_results,
        allow_change,
        allow_add,
        min_choices,
        max_choices,
        scale,
        closes_at,
        closed: def.closed(now()),
        voters,
        results,
        mine: None,
        snapshot: false,
    }
}

/// The anonymous form of a voter: a keyed hash of the poll and the account (its name and when it
/// was created), so a later account with the same name never maps to an earlier one's vote. It
/// only serves to keep one vote per person and to find "your vote".
pub(crate) fn anonymous_key(pepper: &[u8], id: i64, username: &str, since: i64) -> String {
    let mut mac = <Hmac<Sha256> as KeyInit>::new_from_slice(pepper).expect("hmac takes any key");
    mac.update(b"poll-voter\0");
    mac.update(id.to_string().as_bytes());
    mac.update(b"\0");
    mac.update(username.as_bytes());
    mac.update(b"\0");
    mac.update(since.to_string().as_bytes());
    format!("a2:{}", hex::encode(mac.finalize().into_bytes()))
}

/// The stored form of a voter: the username, or for anonymous polls `anonymous_key`. Callers
/// inside a transaction load the pepper before it starts (SQLite has one writer connection).
async fn voter_key(
    db: &Db,
    anonymous: bool,
    id: i64,
    username: &str,
    since: i64,
) -> Result<String, ApiError> {
    if !anonymous {
        return Ok(username.to_string());
    }
    let pepper = crate::db::pepper(db).await?;
    Ok(anonymous_key(&pepper, id, username, since))
}

/// Polls as everyone who can read them sees them: counts only when they are public.
async fn public_views(db: &Db, ids: &[i64]) -> Result<HashMap<i64, Poll>, ApiError> {
    let defs = defs(db, ids).await?;
    if defs.is_empty() {
        return Ok(HashMap::new());
    }
    let t = now();
    let found: Vec<i64> = ids
        .iter()
        .copied()
        .filter(|id| defs.contains_key(id))
        .collect();
    let mut options = options_of(db, &found).await?;
    let tallies = tallies(db, &defs, &found, Some(&options)).await?;
    let mut out = HashMap::with_capacity(found.len());
    for id in found {
        let def = &defs[&id];
        let opts = options.remove(&id).unwrap_or_default();
        let tally = tallies.get(&id);
        let results = match def.public(t) {
            true => tally.map(|t| t.results.clone()),
            false => None,
        };
        out.insert(id, view(def, opts, tally.map_or(0, |t| t.voters), results));
    }
    Ok(out)
}

/// Fills in `poll` of poll messages (counts only when public) and of forwarded poll snapshots.
/// Every message read goes through this, so nothing viewer-specific is added here.
pub(crate) async fn attach(db: &Db, msgs: &mut [Message]) -> Result<(), ApiError> {
    let polls: Vec<i64> = msgs
        .iter()
        .filter(|m| m.kind == "poll")
        .map(|m| m.id)
        .collect();
    let copies: Vec<i64> = msgs
        .iter()
        .filter(|m| m.forward.is_some())
        .map(|m| m.id)
        .collect();
    if polls.is_empty() && copies.is_empty() {
        return Ok(());
    }
    let mut views = public_views(db, &polls).await?;
    if !copies.is_empty() {
        let sql = format!(
            "SELECT message_id, data FROM poll_snapshots WHERE message_id IN ({})",
            placeholders(1, copies.len())
        );
        for r in binds(sql, &copies).fetch_all(db).await? {
            let data: String = r.try_get(1)?;
            if let Ok(poll) = serde_json::from_str::<Poll>(&data) {
                views.insert(r.try_get(0)?, poll);
            }
        }
    }
    for m in msgs.iter_mut() {
        m.poll = views.remove(&m.id);
    }
    Ok(())
}

/// Adds what only `viewer` may see to polls filled in by `attach`: their own vote, and the
/// counts when `show_results` is `after_vote` and they voted.
pub(crate) async fn personalize(
    db: &Db,
    msgs: &mut [Message],
    viewer: Option<&User>,
) -> Result<(), ApiError> {
    let Some(user) = viewer else {
        return Ok(());
    };
    let live: Vec<(i64, bool)> = msgs
        .iter()
        .filter_map(|m| match &m.poll {
            Some(p) if !p.snapshot && m.kind == "poll" => Some((m.id, p.anonymous)),
            Some(_) | None => None,
        })
        .collect();
    if live.is_empty() {
        return Ok(());
    }
    let mut keys = Vec::with_capacity(live.len());
    for (id, anonymous) in &live {
        keys.push((
            *id,
            voter_key(db, *anonymous, *id, &user.username, user.created_at).await?,
        ));
    }
    let cond: Vec<String> = (0..keys.len())
        .map(|i| format!("(message_id = ${} AND voter = ${})", i * 2 + 1, i * 2 + 2))
        .collect();
    let sql = format!(
        "SELECT message_id, option_id, value FROM poll_votes WHERE {} ORDER BY message_id, value, option_id",
        cond.join(" OR ")
    );
    let mut query = sqlx::query(sqlx::AssertSqlSafe(sql));
    for (id, key) in &keys {
        query = query.bind(*id).bind(key.clone());
    }
    let mut mine: HashMap<i64, Ballot> = HashMap::new();
    for r in query.fetch_all(db).await? {
        mine.entry(r.try_get(0)?)
            .or_default()
            .push((r.try_get(1)?, r.try_get(2)?));
    }
    let unlock: Vec<i64> = msgs
        .iter()
        .filter_map(|m| match &m.poll {
            Some(p)
                if p.results.is_none()
                    && p.show_results == ShowResults::AfterVote
                    && mine.contains_key(&m.id) =>
            {
                Some(m.id)
            }
            Some(_) | None => None,
        })
        .collect();
    let defs = defs(db, &unlock).await?;
    let tallies = tallies(db, &defs, &unlock, None).await?;
    for m in msgs.iter_mut() {
        let id = m.id;
        let Some(poll) = m.poll.as_mut() else {
            continue;
        };
        if poll.snapshot || m.kind != "poll" {
            continue;
        }
        poll.mine = mine.get(&id).map(|b| ballot_ids(poll.kind, b));
        if let Some(def) = defs.get(&id)
            && let Some(tally) = tallies.get(&id)
            && poll.mine.is_some()
            && def.shown_to(now(), true)
        {
            poll.results = Some(tally.results.clone());
        }
    }
    Ok(())
}

fn ballot_ids(kind: PollKind, ballot: &Ballot) -> Vec<i64> {
    match kind {
        PollKind::Rating => ballot.iter().map(|(_, v)| *v).collect(),
        _ => ballot.iter().map(|(o, _)| *o).collect(),
    }
}

/// One poll as `viewer` sees it.
pub(crate) async fn view_for(db: &Db, id: i64, viewer: Option<&User>) -> Result<Poll, ApiError> {
    let mut msgs = [
        crate::api::messages::load_message(db, id, crate::api::messages::Quotes::Skip)
            .await?
            .ok_or_else(not_found)?,
    ];
    personalize(db, &mut msgs, viewer).await?;
    let [message] = msgs;
    match (message.kind.as_str(), message.poll) {
        ("poll", Some(poll)) => Ok(poll),
        (_, _) => Err(not_found()),
    }
}

/// The frozen copy stored with a forward of `source`: a poll's public view (counts only when
/// everyone could see them), or the snapshot a forwarded copy already carries.
pub(crate) async fn snapshot_of(db: &Db, source: i64) -> Result<Option<String>, ApiError> {
    let mut views = public_views(db, &[source]).await?;
    if let Some(mut poll) = views.remove(&source) {
        poll.snapshot = true;
        poll.mine = None;
        return Ok(Some(serde_json::to_string(&poll).map_err(|e| {
            ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string())
        })?));
    }
    Ok(
        sqlx::query("SELECT data FROM poll_snapshots WHERE message_id = $1")
            .bind(source)
            .fetch_optional(db)
            .await?
            .map(|r| r.try_get(0))
            .transpose()?,
    )
}

/// Runs the profanity filter on the question and every option of a stored snapshot, for a
/// forward into a server channel (DM polls are never filtered).
pub(crate) fn check_snapshot(settings: &Settings, data: &str) -> Result<(), ApiError> {
    let poll: Poll = serde_json::from_str(data)
        .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    settings.check_profanity(ProfanityTarget::Messages, &poll.question)?;
    for option in &poll.options {
        settings.check_profanity(ProfanityTarget::Messages, &option.text)?;
    }
    Ok(())
}

pub(crate) async fn store_snapshot(
    conn: &mut sqlx::AnyConnection,
    id: i64,
    data: &str,
) -> sqlx::Result<()> {
    sqlx::query("INSERT INTO poll_snapshots(message_id, data) VALUES($1, $2)")
        .bind(id)
        .bind(data)
        .execute(&mut *conn)
        .await?;
    Ok(())
}

/// Removes every vote of an account that is being purged, public and anonymous (found by
/// recomputing its keys; `since` is the account's `created_at`), so the counts drop. Returns
/// the polls that changed. Votes stored before anonymous keys included the account are left
/// as they are.
pub(crate) async fn forget_voter(
    conn: &mut sqlx::AnyConnection,
    pepper: &[u8],
    username: &str,
    since: Option<i64>,
) -> sqlx::Result<Vec<i64>> {
    let mut keys = vec![username.to_string()];
    if let Some(since) = since {
        let anonymous: Vec<i64> = sqlx::query("SELECT p.message_id FROM polls p WHERE p.anonymous <> 0 AND EXISTS(SELECT 1 FROM poll_votes v WHERE v.message_id = p.message_id)")
            .fetch_all(&mut *conn)
            .await?
            .iter()
            .map(|r| r.try_get(0))
            .collect::<sqlx::Result<_>>()?;
        keys.extend(
            anonymous
                .iter()
                .map(|id| anonymous_key(pepper, *id, username, since)),
        );
    }
    let mut changed: Vec<i64> = Vec::new();
    for chunk in keys.chunks(500) {
        let list = placeholders(1, chunk.len());
        let mut find = sqlx::query(sqlx::AssertSqlSafe(format!(
            "SELECT DISTINCT message_id FROM poll_votes WHERE voter IN ({list})"
        )));
        let mut drop = sqlx::query(sqlx::AssertSqlSafe(format!(
            "DELETE FROM poll_votes WHERE voter IN ({list})"
        )));
        for key in chunk {
            find = find.bind(key.clone());
            drop = drop.bind(key.clone());
        }
        for r in find.fetch_all(&mut *conn).await? {
            changed.push(r.try_get(0)?);
        }
        drop.execute(&mut *conn).await?;
    }
    changed.sort_unstable();
    changed.dedup();
    for id in &changed {
        bump(conn, *id).await?;
    }
    Ok(changed)
}

/// Voting needs read access (checked by `resolve_message`) and the rights of a reaction: a
/// member who may send in the channel, or a DM participant past the DM write guard (blocks and
/// friends-only DMs). A member timed out in the channel's server is refused (DMs know no
/// timeouts).
pub(crate) async fn can_vote(db: &Db, resolved: &ResolvedMessage) -> Result<(), ApiError> {
    resolved.vote_gate(db).await
}

/// The audit log context of a moderator closing or reopening someone else's channel poll: the
/// server, the actor and the channel. A site admin who passes only through instance powers is
/// the unnamed staff.
async fn moderated(
    db: &Db,
    id: i64,
    resolved: &ResolvedMessage,
) -> Result<Option<(String, audit::Actor, audit::ChannelRef)>, ApiError> {
    let Some(channel) = resolved.channel() else {
        return Ok(None);
    };
    let Some(found) = audit::channel_ref(db, channel.id()).await? else {
        return Ok(None);
    };
    let server = channel.server();
    let bypassed = match server.as_member().as_ref().and_then(|m| m.viewer()) {
        Some(member) => match resolve_message(db, id, Some(member), &Proof::none()).await {
            Ok(m) => !matches!(m.poll_manage_gate(db).await, Ok(true)),
            Err(_) => true,
        },
        None => false,
    };
    let actor = server
        .audit_actor(db, Perm::DeleteMessages)
        .await?
        .staff_if(bypassed);
    Ok(Some((server.name().to_string(), actor, found)))
}

async fn poll_target(state: &AppState, id: i64, user: &User) -> Result<ResolvedMessage, ApiError> {
    let resolved = resolve_message(&state.db, id, Some(user), &Proof::none()).await?;
    match resolved.scope().kind.as_str() {
        "poll" => Ok(resolved),
        _ => Err(not_found()),
    }
}

/// Serializes writes to one poll (Postgres row lock; SQLite has a single writer) and reads it.
async fn lock_poll(db: &Db, conn: &mut sqlx::AnyConnection, id: i64) -> Result<Def, ApiError> {
    let sql = match is_sqlite(db) {
        true => format!("SELECT {DEF_COLS} FROM polls WHERE message_id = $1"),
        false => format!("SELECT {DEF_COLS} FROM polls WHERE message_id = $1 FOR UPDATE"),
    };
    let row = sqlx::query(sqlx::AssertSqlSafe(sql))
        .bind(id)
        .fetch_optional(&mut *conn)
        .await?
        .ok_or_else(not_found)?;
    Ok(row_def(&row)?.1)
}

/// Marks a change to the votes or options of poll `id`, so its tally is counted again.
async fn bump(conn: &mut sqlx::AnyConnection, id: i64) -> sqlx::Result<()> {
    sqlx::query("UPDATE polls SET version = version + 1 WHERE message_id = $1")
        .bind(id)
        .execute(&mut *conn)
        .await?;
    Ok(())
}

fn invalid_vote() -> ApiError {
    bad("Invalid vote")
}

fn closed_error() -> ApiError {
    bad("This poll is closed")
}

/// The rows of a vote, checked against the poll.
fn ballot_rows(def: &Def, option_ids: &[i64], req: VoteReq) -> Result<Ballot, ApiError> {
    let VoteReq { options, value } = req;
    let mut seen = HashSet::new();
    if options
        .iter()
        .any(|o| !option_ids.contains(o) || !seen.insert(*o))
    {
        return Err(invalid_vote());
    }
    let n = options.len() as i64;
    match (def.kind, value) {
        (PollKind::Rating, Some(v))
            if options.is_empty() && (1..=def.scale.unwrap_or(5)).contains(&v) =>
        {
            Ok(vec![(0, v)])
        }
        (PollKind::Single | PollKind::YesNo, None) if n == 1 => Ok(vec![(options[0], 1)]),
        (PollKind::Multiple, None) if n >= def.min_choices && n <= def.max_choices => {
            Ok(options.iter().map(|o| (*o, 1)).collect())
        }
        (PollKind::Ranked, None) if n >= 1 => Ok(options
            .iter()
            .enumerate()
            .map(|(i, o)| (*o, i as i64 + 1))
            .collect()),
        (_, _) => Err(invalid_vote()),
    }
}

async fn option_ids(conn: &mut sqlx::AnyConnection, id: i64) -> sqlx::Result<Vec<i64>> {
    sqlx::query("SELECT id FROM poll_options WHERE message_id = $1 ORDER BY position, id")
        .bind(id)
        .fetch_all(&mut *conn)
        .await?
        .iter()
        .map(|r| r.try_get(0))
        .collect()
}

/// Get a poll
///
/// Returns the poll of a poll message (the message id) as the caller sees it: the counts only
/// when its `show_results` setting lets them see them, and their own vote. Access is checked
/// exactly like reading the message (guests allowed when guest access is on, with
/// `X-Guest-Grant` for password-protected servers; channel view and read-history rules; DM
/// participants). General rate-limit bucket.
#[utoipa::path(get, path = "/api/polls/{id}", tag = "Polls", params(("id" = i64, Path, description = "Id of the poll message")), responses((status = 200, description = "The poll", body = Poll), (status = 400, description = "Non-numeric id (plain-text framework error)", content_type = "text/plain", body = String), (status = 401, description = "No valid token and guest access is disabled (`Guest access is disabled`)", body = ApiErrorBody), (status = 404, description = "`Not found`: no such poll, its author's account is being deleted, or you cannot read it (hidden channel, before your join without read history, a server you have no access to, or a DM you are not in); identical responses", body = ApiErrorBody), (status = 429, description = "Too many requests in the general bucket", content_type = "text/plain", body = String)), security((), ("bearer" = [])))]
pub(crate) async fn get_poll(
    State(state): State<AppState>,
    MaybeAuthed(user): MaybeAuthed,
    headers: HeaderMap,
    Path(id): Path<i64>,
) -> Result<Json<Poll>, ApiError> {
    let db = &state.read();
    require_guest_ok(db, user.as_ref()).await?;
    resolve_message(
        db,
        id,
        user.as_ref(),
        &Proof::headers(&headers, &state.limits),
    )
    .await?;
    Ok(Json(view_for(db, id, user.as_ref()).await?))
}

/// Vote in a poll
///
/// Stores the caller's vote, replacing their earlier one when the poll allows changing votes.
/// Voting needs read access to the poll and the rights of a reaction: in server channels
/// membership and the send permission, in DMs being a participant while neither blocked the
/// other (and the other's DM setting allows it). The poll must be open: a vote that arrives
/// after the poll closed (early or at its deadline) is refused, even if the close happened while
/// it was on its way. Each person has one vote; anonymous polls store it under a keyed hash so
/// it cannot be listed. Clients that can see the poll then get `poll_updated` (counts only, at
/// most one per poll per second, and for anonymous polls only on 5-second steps; while an
/// `after_vote` poll is open the counts are left out, except in the copy each voter's own
/// connections get), and the voter's own connections get `poll_voted`
/// (`{username, message_id}`) so their other tabs reload the poll. Shares the reactions, pins and
/// edits limit.
#[utoipa::path(put, path = "/api/polls/{id}/vote", tag = "Polls", params(("id" = i64, Path, description = "Id of the poll message")), request_body = VoteReq, responses((status = 200, description = "The poll with the vote", body = Poll), (status = 400, description = "`Invalid vote` (unknown or repeated options, the wrong number of them, or a score out of range), `This poll is closed`, or `You already voted` when votes cannot be changed. Malformed JSON gives a plain-text 400/415/422 framework error", body = ApiErrorBody), (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody), (status = 403, description = "Not a member of the channel's server, no permission to vote in the channel (`No permission to vote in this channel`), timed out in the server (`You are timed out in this server`), or a block or the DM setting between the participants (`This user is not accepting messages from you.`, `You blocked this user. Unblock them to send messages.`, or `You only accept DMs from friends. Change this in Settings > Privacy.`)", body = ApiErrorBody), (status = 404, description = "`Not found`: no such poll, or you cannot read it; identical responses", body = ApiErrorBody), (status = 429, description = "Too many requests in the general bucket (plain text), or `Too many attempts. Try again later` (JSON) after more than 30 reactions, pins, edits and votes in 10 seconds", content((ApiErrorBody = "application/json"), (String = "text/plain")))), security(("bearer" = [])))]
pub(crate) async fn vote(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Authed(user): Authed,
    Json(req): Json<VoteReq>,
) -> Result<Json<Poll>, ApiError> {
    let resolved = poll_target(&state, id, &user).await?;
    can_vote(&state.db, &resolved).await?;
    let db = &state.db;
    crate::db::pepper(db).await?;
    let mut tx = db.begin().await?;
    let def = lock_poll(db, &mut tx, id).await?;
    if def.closed(now()) {
        return Err(closed_error());
    }
    let ids = option_ids(&mut tx, id).await?;
    let rows = ballot_rows(&def, &ids, req)?;
    let key = voter_key(db, def.anonymous, id, &user.username, user.created_at).await?;
    let before: Ballot = sqlx::query(
        "SELECT option_id, value FROM poll_votes WHERE message_id = $1 AND voter = $2 ORDER BY value, option_id",
    )
    .bind(id)
    .bind(&key)
    .fetch_all(&mut *tx)
    .await?
    .iter()
    .map(|r| Ok((r.try_get(0)?, r.try_get(1)?)))
    .collect::<sqlx::Result<_>>()?;
    let mut sorted = rows.clone();
    sorted.sort_by_key(|(o, v)| (*v, *o));
    if before == sorted {
        tx.commit().await?;
        return Ok(Json(view_for(db, id, Some(&user)).await?));
    }
    if !before.is_empty() && !def.allow_change {
        return Err(bad("You already voted"));
    }
    sqlx::query("DELETE FROM poll_votes WHERE message_id = $1 AND voter = $2")
        .bind(id)
        .bind(&key)
        .execute(&mut *tx)
        .await?;
    let t = match def.anonymous {
        true => now().div_euclid(86400) * 86400,
        false => now(),
    };
    for (option, value) in &rows {
        sqlx::query("INSERT INTO poll_votes(message_id, voter, option_id, value, created_at) VALUES($1, $2, $3, $4, $5)")
            .bind(id)
            .bind(&key)
            .bind(*option)
            .bind(*value)
            .bind(t)
            .execute(&mut *tx)
            .await?;
    }
    bump(&mut tx, id).await?;
    tx.commit().await?;
    schedule_vote(&state, id, def.anonymous);
    voted(&state, &user, id);
    Ok(Json(view_for(db, id, Some(&user)).await?))
}

fn voted(state: &AppState, user: &User, id: i64) {
    state.hub.broadcast(WsEvent::PollVoted {
        username: user.username.clone(),
        message_id: id,
    });
}

/// Take back a vote
///
/// Removes the caller's vote from an open poll that allows changing votes. Removing a vote that
/// does not exist changes nothing. Same access rules as voting; emits `poll_updated` like a
/// vote.
#[utoipa::path(delete, path = "/api/polls/{id}/vote", tag = "Polls", params(("id" = i64, Path, description = "Id of the poll message")), responses((status = 200, description = "The poll without the vote", body = Poll), (status = 400, description = "`This poll is closed`, or `Votes in this poll cannot be changed`", body = ApiErrorBody), (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody), (status = 403, description = "As for voting", body = ApiErrorBody), (status = 404, description = "`Not found`: no such poll, or you cannot read it; identical responses", body = ApiErrorBody), (status = 429, description = "As for voting", content((ApiErrorBody = "application/json"), (String = "text/plain")))), security(("bearer" = [])))]
pub(crate) async fn retract_vote(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Authed(user): Authed,
) -> Result<Json<Poll>, ApiError> {
    let resolved = poll_target(&state, id, &user).await?;
    can_vote(&state.db, &resolved).await?;
    let db = &state.db;
    crate::db::pepper(db).await?;
    let mut tx = db.begin().await?;
    let def = lock_poll(db, &mut tx, id).await?;
    if def.closed(now()) {
        return Err(closed_error());
    }
    if !def.allow_change {
        return Err(bad("Votes in this poll cannot be changed"));
    }
    let key = voter_key(db, def.anonymous, id, &user.username, user.created_at).await?;
    let removed = sqlx::query("DELETE FROM poll_votes WHERE message_id = $1 AND voter = $2")
        .bind(id)
        .bind(&key)
        .execute(&mut *tx)
        .await?
        .rows_affected()
        > 0;
    if removed {
        bump(&mut tx, id).await?;
    }
    tx.commit().await?;
    if removed {
        schedule_vote(&state, id, def.anonymous);
        voted(&state, &user, id);
    }
    Ok(Json(view_for(db, id, Some(&user)).await?))
}

/// Add a poll option
///
/// Adds an option to an open `single`, `multiple` or `ranked` poll whose author allowed it
/// (the author may always add), up to 20 options in total. A `multiple` poll whose
/// `max_choices` allowed every option keeps allowing every option. Same access rules as voting; in
/// server channels the profanity filter checks the text. Emits `poll_updated`.
#[utoipa::path(post, path = "/api/polls/{id}/options", tag = "Polls", params(("id" = i64, Path, description = "Id of the poll message")), request_body = AddOptionReq, responses((status = 200, description = "The poll with the new option", body = Poll), (status = 400, description = "`This poll is closed`, `Options cannot be added to this poll`, `A poll can have at most 20 options`, `Options must be different`, an empty or too long text, `Not an emoji`, or blocked by the profanity filter", body = ApiErrorBody), (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody), (status = 403, description = "As for voting", body = ApiErrorBody), (status = 404, description = "`Not found`: no such poll, or you cannot read it; identical responses", body = ApiErrorBody), (status = 429, description = "As for voting", content((ApiErrorBody = "application/json"), (String = "text/plain")))), security(("bearer" = [])))]
pub(crate) async fn add_option(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Authed(user): Authed,
    Json(req): Json<AddOptionReq>,
) -> Result<Json<Poll>, ApiError> {
    let AddOptionReq { text, emoji } = req;
    let resolved = poll_target(&state, id, &user).await?;
    can_vote(&state.db, &resolved).await?;
    let text = option_text(&text)?;
    let emoji = option_emoji(emoji)?;
    if resolved.channel().is_some() {
        Settings::cached(&state.db)
            .await
            .check_profanity(ProfanityTarget::Messages, &text)?;
    }
    let own = resolved.scope().author == user.username;
    let db = &state.db;
    crate::db::pepper(db).await?;
    let mut tx = db.begin().await?;
    let def = lock_poll(db, &mut tx, id).await?;
    if def.closed(now()) {
        return Err(closed_error());
    }
    if !def.kind.written() || !(def.allow_add || own) {
        return Err(bad("Options cannot be added to this poll"));
    }
    let existing: Vec<String> = sqlx::query("SELECT text FROM poll_options WHERE message_id = $1")
        .bind(id)
        .fetch_all(&mut *tx)
        .await?
        .iter()
        .map(|r| r.try_get(0))
        .collect::<sqlx::Result<_>>()?;
    if existing.len() >= OPTIONS_MAX {
        return Err(bad("A poll can have at most 20 options"));
    }
    if existing
        .iter()
        .any(|t| t.to_lowercase() == text.to_lowercase())
    {
        return Err(bad("Options must be different"));
    }
    sqlx::query("INSERT INTO poll_options(message_id, position, text, emoji, added_by, created_at) VALUES($1, $2, $3, $4, $5, $6)")
        .bind(id)
        .bind(existing.len() as i64)
        .bind(&text)
        .bind(&emoji)
        .bind(&user.username)
        .bind(now())
        .execute(&mut *tx)
        .await?;
    if def.kind == PollKind::Multiple && def.max_choices == existing.len() as i64 {
        sqlx::query("UPDATE polls SET max_choices = max_choices + 1 WHERE message_id = $1")
            .bind(id)
            .execute(&mut *tx)
            .await?;
    }
    bump(&mut tx, id).await?;
    tx.commit().await?;
    schedule_update(&state, id);
    Ok(Json(view_for(db, id, Some(&user)).await?))
}

async fn set_closed(
    state: &AppState,
    id: i64,
    user: &User,
    close: bool,
) -> Result<Json<Poll>, ApiError> {
    let resolved = poll_target(state, id, user).await?;
    let moderator = resolved.poll_manage_gate(&state.db).await?;
    let db = &state.db;
    let audit = match moderator {
        true => moderated(db, id, &resolved).await?,
        false => None,
    };
    let mut tx = db.begin().await?;
    lock_poll(db, &mut tx, id).await?;
    let t = now();
    let changed = match close {
        true => sqlx::query("UPDATE polls SET closed_at = CASE WHEN closes_at IS NOT NULL AND closes_at < $2 THEN closes_at ELSE $2 END, closed_by = $3, version = version + 1 WHERE message_id = $1 AND closed_at IS NULL")
            .bind(id)
            .bind(t)
            .bind(&user.username)
            .execute(&mut *tx)
            .await?,
        false => sqlx::query("UPDATE polls SET closed_at = NULL, closed_by = NULL, version = version + 1, closes_at = CASE WHEN closes_at IS NOT NULL AND closes_at <= $2 THEN NULL ELSE closes_at END WHERE message_id = $1 AND (closed_at IS NOT NULL OR (closes_at IS NOT NULL AND closes_at <= $2))")
            .bind(id)
            .bind(t)
            .execute(&mut *tx)
            .await?,
    }
    .rows_affected()
        > 0;
    if changed && let Some((server, actor, channel)) = &audit {
        let action = match close {
            true => audit::Action::PollClose,
            false => audit::Action::PollReopen,
        };
        audit::record(
            &mut tx,
            audit::message_entry(server, actor, action, id, &resolved.scope().author, channel),
        )
        .await?;
    }
    tx.commit().await?;
    if changed {
        schedule_update(state, id);
    }
    Ok(Json(view_for(db, id, Some(user)).await?))
}

/// Close a poll
///
/// Ends voting now. Only the poll's author (while they can still send there) or, in server
/// channels, a member with the Manage messages permission. Closing a closed poll changes
/// nothing. Votes that were still on their way are refused. Emits `poll_updated`. Shares the
/// reactions, pins and edits limit.
#[utoipa::path(post, path = "/api/polls/{id}/close", tag = "Polls", params(("id" = i64, Path, description = "Id of the poll message")), responses((status = 200, description = "The closed poll", body = Poll), (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody), (status = 403, description = "`Only the author or a moderator can do this`, not a member of the server, timed out in the server (`You are timed out in this server`), or a block or the DM setting between DM participants", body = ApiErrorBody), (status = 404, description = "`Not found`: no such poll, or you cannot read it; identical responses", body = ApiErrorBody), (status = 429, description = "As for voting", content((ApiErrorBody = "application/json"), (String = "text/plain")))), security(("bearer" = [])))]
pub(crate) async fn close_poll(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Authed(user): Authed,
) -> Result<Json<Poll>, ApiError> {
    set_closed(&state, id, &user, true).await
}

/// Reopen a poll
///
/// Takes votes again. A deadline that has passed is removed; a later one stays. Same rules as
/// closing; reopening an open poll changes nothing. Emits `poll_updated`.
#[utoipa::path(post, path = "/api/polls/{id}/reopen", tag = "Polls", params(("id" = i64, Path, description = "Id of the poll message")), responses((status = 200, description = "The reopened poll", body = Poll), (status = 401, description = "Missing or unknown bearer token", body = ApiErrorBody), (status = 403, description = "As for closing", body = ApiErrorBody), (status = 404, description = "`Not found`: no such poll, or you cannot read it; identical responses", body = ApiErrorBody), (status = 429, description = "As for voting", content((ApiErrorBody = "application/json"), (String = "text/plain")))), security(("bearer" = [])))]
pub(crate) async fn reopen_poll(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Authed(user): Authed,
) -> Result<Json<Poll>, ApiError> {
    set_closed(&state, id, &user, false).await
}

/// List voters
///
/// Who voted in a poll that is not anonymous, a page at a time (default and max 50), earliest
/// vote first, optionally only for one option. Needs read access to the poll and the right to
/// see its counts (`show_results`). Anonymous polls never list voters. General rate-limit
/// bucket.
#[utoipa::path(get, path = "/api/polls/{id}/voters", tag = "Polls", params(("id" = i64, Path, description = "Id of the poll message"), VotersQuery), responses((status = 200, description = "A page of voters", body = Vec<PollVoter>, headers(("x-next-cursor" = String, description = "Cursor for the next page; absent on the last page"))), (status = 400, description = "Invalid cursor (JSON), or a non-numeric parameter (plain-text framework error)", body = ApiErrorBody), (status = 401, description = "No valid token and guest access is disabled", body = ApiErrorBody), (status = 403, description = "`Votes in this poll are anonymous`, or `Results are hidden` while the counts are hidden from you", body = ApiErrorBody), (status = 404, description = "`Not found`: no such poll, or you cannot read it; identical responses", body = ApiErrorBody), (status = 429, description = "Too many requests in the general bucket", content_type = "text/plain", body = String)), security((), ("bearer" = [])))]
pub(crate) async fn list_voters(
    State(state): State<AppState>,
    MaybeAuthed(user): MaybeAuthed,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Query(q): Query<VotersQuery>,
) -> Result<Paged<PollVoter>, ApiError> {
    let VotersQuery {
        option,
        cursor,
        limit,
    } = q;
    let db = &state.read();
    require_guest_ok(db, user.as_ref()).await?;
    resolve_message(
        db,
        id,
        user.as_ref(),
        &Proof::headers(&headers, &state.limits),
    )
    .await?;
    let poll = view_for(db, id, user.as_ref()).await?;
    if poll.anonymous {
        return Err(ApiError(
            StatusCode::FORBIDDEN,
            "Votes in this poll are anonymous".to_string(),
        ));
    }
    if poll.results.is_none() {
        return Err(ApiError(
            StatusCode::FORBIDDEN,
            "Results are hidden".to_string(),
        ));
    }
    let limit = limit.unwrap_or(VOTERS_PAGE).clamp(1, VOTERS_PAGE);
    let (after_at, after_voter) = match cursor.as_deref().filter(|c| !c.trim().is_empty()) {
        Some(c) => {
            let parts = decode_cursor(c, 2)?;
            (cursor_int(&parts[0])?, parts[1].clone())
        }
        None => (i64::MIN, String::new()),
    };
    let filter = match (option, poll.kind) {
        (None, _) => "",
        (Some(_), PollKind::Rating) => " AND v.option_id = 0 AND v.value = $5",
        (Some(_), PollKind::Ranked) => " AND v.option_id = $5 AND v.value = 1",
        (Some(_), _) => " AND v.option_id = $5",
    };
    let sql = format!(
        "SELECT DISTINCT v.voter, v.created_at FROM poll_votes v WHERE v.message_id = $1 AND (v.created_at > $2 OR (v.created_at = $2 AND v.voter > $3)){filter} AND NOT EXISTS(SELECT 1 FROM users pu WHERE pu.username = v.voter AND pu.password_hash = '!purging') ORDER BY v.created_at, v.voter LIMIT $4"
    );
    let mut query = sqlx::query(sqlx::AssertSqlSafe(sql))
        .bind(id)
        .bind(after_at)
        .bind(after_voter)
        .bind(limit + 1);
    if let Some(option) = option {
        query = query.bind(option);
    }
    let rows = query.fetch_all(db).await?;
    let mut found: Vec<(String, i64)> = rows
        .iter()
        .map(|r| Ok((r.try_get(0)?, r.try_get(1)?)))
        .collect::<sqlx::Result<_>>()?;
    let next = match found.len() as i64 > limit {
        true => {
            found.truncate(limit as usize);
            found
                .last()
                .map(|(voter, at)| encode_cursor(&[&at.to_string(), voter]))
        }
        false => None,
    };
    let names: Vec<String> = found.iter().map(|(v, _)| v.clone()).collect();
    let refs = user_refs(db, &names).await;
    Ok(Paged(
        found
            .into_iter()
            .map(|(voter, voted_at)| PollVoter {
                user: user_from(&refs, &voter),
                voted_at,
            })
            .collect(),
        next,
    ))
}

#[derive(Default)]
struct Live {
    pending: HashSet<(String, i64)>,
    last: HashMap<(String, i64), Instant>,
}

static LIVE: LazyLock<Mutex<Live>> = LazyLock::new(Default::default);

/// Sends `poll_updated` for poll `id` soon: right away when none went out in the last second,
/// otherwise once that second is over. Changes in between are coalesced into that one event,
/// which reads the poll when it is sent.
pub(crate) fn schedule_update(state: &AppState, id: i64) {
    schedule(state, id, Duration::ZERO);
}

/// Votes in anonymous polls are announced only on 5-second wall-clock steps, so one vote can't be
/// timed against what its voter does elsewhere.
pub const ANONYMOUS_STEP: Duration = Duration::from_secs(5);

/// How long until the next `ANONYMOUS_STEP` boundary, `since_epoch` after the Unix epoch.
pub(crate) fn step_delay(since_epoch: Duration) -> Duration {
    let step = ANONYMOUS_STEP.as_millis();
    Duration::from_millis((step - since_epoch.as_millis() % step) as u64)
}

/// `schedule_update` after a vote or a vote taken back.
fn schedule_vote(state: &AppState, id: i64, anonymous: bool) {
    let wait = match anonymous {
        true => step_delay(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default(),
        ),
        false => Duration::ZERO,
    };
    schedule(state, id, wait);
}

fn schedule(state: &AppState, id: i64, wait: Duration) {
    let key = (pool_key(&state.db), id);
    let delay = {
        let Ok(mut live) = LIVE.lock() else {
            return;
        };
        if !live.pending.insert(key.clone()) {
            return;
        }
        if live.last.len() > 10_000 {
            live.last.retain(|_, at| at.elapsed() < UPDATE_EVERY);
        }
        live.last
            .get(&key)
            .map_or(Duration::ZERO, |at| {
                UPDATE_EVERY.saturating_sub(at.elapsed())
            })
            .max(wait)
    };
    let state = state.clone();
    tokio::spawn(async move {
        if !delay.is_zero() {
            tokio::time::sleep(delay).await;
        }
        if let Ok(mut live) = LIVE.lock() {
            live.pending.remove(&key);
            live.last.insert(key, Instant::now());
        }
        match update_event(&state.db, id).await {
            Ok(Some(ev)) => state.hub.broadcast(ev),
            Ok(None) => {}
            Err(ApiError(_, e)) => tracing::warn!("poll update failed: {e}"),
        }
    });
}

/// The counts of open `after_vote` poll `id` for one connection's account, when it voted;
/// `poll_updated` leaves them out for everyone else. Reads the poll's stored version first and
/// reuses the cached tally only at that version, so an event fanned out from another node (whose
/// mutation this node's cache never saw) is recounted rather than served stale.
pub(crate) async fn voter_results(
    db: &Db,
    id: i64,
    anonymous: bool,
    username: &str,
    since: i64,
) -> Option<PollResults> {
    let defs = defs(db, &[id]).await.ok()?;
    let tally = tallies(db, &defs, &[id], None).await.ok()?.remove(&id)?;
    let key = voter_key(db, anonymous, id, username, since).await.ok()?;
    match tally.keys.as_ref()?.contains(&key) {
        true => Some(tally.results.clone()),
        false => None,
    }
}

/// `poll_updated` for poll `id` as it is now (counts only when public); `None` once it is gone.
pub(crate) async fn update_event(db: &Db, id: i64) -> Result<Option<WsEvent>, ApiError> {
    let row = sqlx::query("SELECT m.channel_id, m.dm_id, m.thread_root_id, m.created_at, c.server, d.user_a, d.user_b FROM messages m LEFT JOIN channels c ON c.id = m.channel_id LEFT JOIN dms d ON d.id = m.dm_id WHERE m.id = $1 AND m.kind = 'poll'")
        .bind(id)
        .fetch_optional(db)
        .await?;
    let Some(r) = row else {
        return Ok(None);
    };
    let Some(poll) = public_views(db, &[id]).await?.remove(&id) else {
        return Ok(None);
    };
    let dm_users = match (
        r.try_get::<Option<String>, _>(5)?,
        r.try_get::<Option<String>, _>(6)?,
    ) {
        (Some(a), Some(b)) => Some(vec![a, b]),
        (_, _) => None,
    };
    Ok(Some(WsEvent::PollUpdated {
        server: r.try_get(4)?,
        channel_id: r.try_get(0)?,
        dm_id: r.try_get(1)?,
        dm_users,
        message_id: id,
        thread_root_id: r.try_get(2)?,
        created_at: r.try_get(3)?,
        poll: Box::new(poll),
    }))
}

/// Closes polls whose deadline passed (the jobs sweep), each once, and announces them.
pub async fn close_due(state: &AppState) -> sqlx::Result<usize> {
    let t = now();
    let ids: Vec<i64> = sqlx::query("SELECT message_id FROM polls WHERE closed_at IS NULL AND closes_at IS NOT NULL AND closes_at <= $1 ORDER BY closes_at LIMIT $2")
        .bind(t)
        .bind(CLOSE_BATCH)
        .fetch_all(&state.db)
        .await?
        .iter()
        .map(|r| r.try_get(0))
        .collect::<sqlx::Result<_>>()?;
    let mut closed = 0;
    for id in ids {
        let done = sqlx::query("UPDATE polls SET closed_at = closes_at, version = version + 1 WHERE message_id = $1 AND closed_at IS NULL AND closes_at IS NOT NULL AND closes_at <= $2")
            .bind(id)
            .bind(t)
            .execute(&state.db)
            .await?
            .rows_affected()
            > 0;
        if done {
            closed += 1;
            schedule_update(state, id);
        }
    }
    Ok(closed)
}

/// A poll for event tests.
#[cfg(test)]
pub(crate) fn sample_poll() -> Poll {
    Poll {
        kind: PollKind::Single,
        question: "Lunch?".to_string(),
        options: vec![PollOption {
            id: 1,
            text: "Pizza".to_string(),
            emoji: None,
        }],
        anonymous: false,
        show_results: ShowResults::Always,
        allow_change: true,
        allow_add: false,
        min_choices: 1,
        max_choices: 1,
        scale: None,
        closes_at: None,
        closed: false,
        voters: 0,
        results: None,
        mine: None,
        snapshot: false,
    }
}

#[cfg(test)]
mod tests {
    use axum::extract::RawQuery;
    use serde_json::{Value, json};

    use super::*;
    use crate::api::messages::SendReq;
    use crate::api::test_util::{add_member, done, mem_user, temp_state};

    /// A signed-in account as stored by `add_user` (created at 1).
    fn account(name: &str, site_admin: bool) -> User {
        User {
            created_at: 1,
            ..mem_user(name, site_admin)
        }
    }

    async fn exec(db: &Db, sql: &str) {
        sqlx::query(sqlx::AssertSqlSafe(sql.to_string()))
            .execute(db)
            .await
            .expect(sql);
    }

    async fn int(db: &Db, sql: &str) -> i64 {
        sqlx::query(sqlx::AssertSqlSafe(sql.to_string()))
            .fetch_one(db)
            .await
            .expect(sql)
            .try_get(0)
            .expect("int")
    }

    async fn add_user(db: &Db, name: &str) {
        sqlx::query("INSERT INTO users(username, display_name, password_hash, password_kind, avatar_kind, created_at) VALUES($1, $2, '', 'text', 'identicon', 1)")
            .bind(name)
            .bind(name.to_uppercase())
            .execute(db)
            .await
            .expect("user");
    }

    async fn world(tag: &str) -> (AppState, std::path::PathBuf, i64) {
        let (state, path) = temp_state(tag).await;
        let db = &state.db;
        for name in ["alice", "bob", "carol", "dave"] {
            add_user(db, name).await;
            add_member(db, "rchat", name, 0, 0, 1).await;
        }
        add_user(db, "nina").await;
        let cid = int(db, "SELECT id FROM channels WHERE server = 'rchat'").await;
        (state, path, cid)
    }

    fn code<T>(res: Result<T, ApiError>) -> Option<(StatusCode, String)> {
        res.err().map(|ApiError(c, m)| (c, m))
    }

    fn req(poll: Value) -> SendReq {
        serde_json::from_value(json!({"content": "", "poll": poll})).expect("send req")
    }

    async fn post_poll(
        state: &AppState,
        who: &str,
        cid: i64,
        poll: Value,
    ) -> Result<Message, ApiError> {
        crate::api::messages::send_channel_message(
            State(state.clone()),
            Path(cid),
            Authed(account(who, false)),
            Json(req(poll)),
        )
        .await
        .map(|Json(m)| m)
    }

    async fn post_dm_poll(
        state: &AppState,
        who: &str,
        dm: i64,
        poll: Value,
    ) -> Result<Message, ApiError> {
        crate::api::messages::send_dm_message(
            State(state.clone()),
            Path(dm),
            Authed(account(who, false)),
            Json(req(poll)),
        )
        .await
        .map(|Json(m)| m)
    }

    fn ballot(options: &[i64]) -> VoteReq {
        VoteReq {
            options: options.to_vec(),
            value: None,
        }
    }

    async fn cast(
        state: &AppState,
        who: &str,
        id: i64,
        vote_req: VoteReq,
    ) -> Result<Poll, ApiError> {
        vote(
            State(state.clone()),
            Path(id),
            Authed(account(who, false)),
            Json(vote_req),
        )
        .await
        .map(|Json(p)| p)
    }

    async fn seen(state: &AppState, who: Option<&str>, id: i64) -> Result<Poll, ApiError> {
        get_poll(
            State(state.clone()),
            MaybeAuthed(who.map(|w| account(w, false))),
            HeaderMap::new(),
            Path(id),
        )
        .await
        .map(|Json(p)| p)
    }

    async fn voters_of(
        state: &AppState,
        who: &str,
        id: i64,
        option: Option<i64>,
        cursor: Option<String>,
    ) -> Result<(Vec<String>, Option<String>), ApiError> {
        list_voters(
            State(state.clone()),
            MaybeAuthed(Some(account(who, false))),
            HeaderMap::new(),
            Path(id),
            Query(VotersQuery {
                option,
                cursor,
                limit: None,
            }),
        )
        .await
        .map(|Paged(list, next)| (list.into_iter().map(|v| v.user.username).collect(), next))
    }

    fn counts(poll: &Poll) -> Option<Vec<i64>> {
        poll.results
            .as_ref()
            .map(|r| r.counts.iter().map(|c| c.count).collect())
    }

    fn ids(poll: &Poll) -> Vec<i64> {
        poll.options.iter().map(|o| o.id).collect()
    }

    fn poll_events(rx: &mut tokio::sync::broadcast::Receiver<WsEvent>) -> Vec<Poll> {
        std::iter::from_fn(|| rx.try_recv().ok())
            .filter_map(|ev| match ev {
                WsEvent::PollUpdated { poll, .. } => Some(*poll),
                _ => None,
            })
            .collect()
    }

    fn lunch() -> Value {
        json!({"question": " Lunch? ", "kind": "single", "options": [{"text": "Pizza", "emoji": "🍕"}, {"text": "Soup"}, {"text": "Tacos"}]})
    }

    #[test]
    fn instant_runoff_transfers_and_breaks_ties_deterministically() {
        let (rounds, winner) = instant_runoff(&[1, 2, 3], &[vec![1], vec![1, 2], vec![2]]);
        assert_eq!(
            (rounds.len(), winner),
            (1, Some(1)),
            "a first-round majority"
        );
        let ballots = vec![vec![1, 3], vec![1], vec![2], vec![2, 1], vec![3, 2]];
        let (rounds, winner) = instant_runoff(&[1, 2, 3], &ballots);
        let shape: Vec<(Vec<i64>, i64, Option<i64>)> = rounds
            .iter()
            .map(|r| {
                (
                    r.counts.iter().map(|c| c.count).collect(),
                    r.exhausted,
                    r.eliminated,
                )
            })
            .collect();
        assert_eq!(
            shape,
            vec![(vec![2, 2, 1], 0, Some(3)), (vec![2, 3], 0, None)],
            "3 goes out and its ballot moves to 2"
        );
        assert_eq!(winner, Some(2));
        let (rounds, winner) = instant_runoff(
            &[1, 2, 3],
            &[vec![1], vec![2], vec![3, 1], vec![1, 2], vec![2]],
        );
        assert_eq!(rounds[0].eliminated, Some(3));
        assert_eq!(rounds[1].counts[0].count, 3);
        assert_eq!(winner, Some(1));
        let (rounds, winner) = instant_runoff(&[1, 2, 3, 4], &[vec![1], vec![2], vec![3], vec![4]]);
        assert_eq!(
            rounds.iter().map(|r| r.eliminated).collect::<Vec<_>>(),
            vec![Some(4), Some(3), Some(2), None],
            "an even tie eliminates the option listed last"
        );
        assert_eq!(winner, Some(1));
        let ballots = vec![
            vec![1, 2],
            vec![1, 2],
            vec![2, 3],
            vec![2, 3],
            vec![3],
            vec![4, 3],
            vec![4, 3],
            vec![5, 1],
        ];
        let (rounds, winner) = instant_runoff(&[1, 2, 3, 4, 5], &ballots);
        assert_eq!(
            rounds[0].eliminated,
            Some(5),
            "5 had the fewest first choices"
        );
        assert_eq!(
            rounds[1].counts.iter().map(|c| c.count).collect::<Vec<_>>(),
            vec![3, 2, 1, 2]
        );
        assert_eq!(rounds[1].eliminated, Some(3));
        assert_eq!(
            rounds[2].counts.iter().map(|c| c.count).collect::<Vec<_>>(),
            vec![3, 2, 2]
        );
        assert_eq!(rounds[2].exhausted, 1);
        assert_eq!(
            rounds[2].eliminated,
            Some(4),
            "2 and 4 tie now and in every earlier round: the later one goes"
        );
        assert_eq!(winner, Some(1));
        let tie = instant_runoff(
            &[1, 2, 3],
            &[
                vec![1],
                vec![1],
                vec![2],
                vec![2, 3],
                vec![3],
                vec![3, 2],
                vec![2],
            ],
        );
        assert_eq!(
            tie.0[0].counts.iter().map(|c| c.count).collect::<Vec<_>>(),
            vec![2, 3, 2]
        );
        assert_eq!(
            tie.0[0].eliminated,
            Some(3),
            "1 and 3 tie in round 1: the later one goes"
        );
        let (rounds, winner) = instant_runoff(
            &[1, 2, 3],
            &[vec![3, 2], vec![1], vec![1], vec![2], vec![2], vec![3]],
        );
        assert_eq!(rounds[0].eliminated, Some(3));
        assert_eq!(
            rounds[1].counts.iter().map(|c| c.count).collect::<Vec<_>>(),
            vec![2, 3]
        );
        assert_eq!(winner, Some(2));
        let (rounds, winner) = instant_runoff(&[1, 2], &[vec![1], vec![2], vec![1, 2], vec![2, 1]]);
        assert_eq!(
            rounds[0].eliminated,
            Some(2),
            "a two-way tie: the later option goes"
        );
        assert_eq!(winner, Some(1));
        let (rounds, winner) = instant_runoff(
            &[1, 2, 3],
            &[vec![2], vec![3], vec![3], vec![1, 2], vec![2]],
        );
        assert_eq!(rounds[0].eliminated, Some(1));
        assert_eq!(
            rounds[1].counts.iter().map(|c| c.count).collect::<Vec<_>>(),
            vec![3, 2]
        );
        assert_eq!(winner, Some(2));
        let (rounds, winner) = instant_runoff(&[1, 2, 3], &[vec![1], vec![2, 3], vec![3]]);
        assert_eq!(
            rounds[0].eliminated,
            Some(3),
            "all tie: the last listed goes"
        );
        assert_eq!(
            rounds[1].counts.iter().map(|c| c.count).collect::<Vec<_>>(),
            vec![1, 1]
        );
        assert_eq!(rounds[1].exhausted, 1, "a partial ballot runs out");
        assert_eq!(
            rounds[1].eliminated,
            Some(2),
            "still tied: round 1 had them equal too, so the later one goes"
        );
        assert_eq!(winner, Some(1));
        assert_eq!(
            instant_runoff(&[1, 2], &[]),
            (
                vec![RunoffRound {
                    counts: vec![
                        OptionCount {
                            option_id: 1,
                            count: 0
                        },
                        OptionCount {
                            option_id: 2,
                            count: 0
                        }
                    ],
                    exhausted: 0,
                    eliminated: None
                }],
                None
            )
        );
    }

    #[test]
    fn earlier_rounds_break_ties_for_last_place() {
        let ballots = vec![
            vec![1],
            vec![1],
            vec![1],
            vec![2],
            vec![2],
            vec![3],
            vec![3],
            vec![4],
            vec![4, 2],
            vec![5, 3],
        ];
        let (rounds, _) = instant_runoff(&[1, 2, 3, 4, 5], &ballots);
        assert_eq!(rounds[0].eliminated, Some(5));
        assert_eq!(
            rounds[1].counts.iter().map(|c| c.count).collect::<Vec<_>>(),
            vec![3, 2, 3, 2]
        );
        assert_eq!(
            rounds[1].eliminated,
            Some(4),
            "2 and 4 tie on 2; in round 1 they also tie, so the later one (4) goes"
        );
        assert_eq!(
            rounds[2].counts.iter().map(|c| c.count).collect::<Vec<_>>(),
            vec![3, 3, 3]
        );
        assert_eq!(
            rounds[2].eliminated,
            Some(2),
            "a three-way tie: round 2 had 2 behind 1 and 3, so 2 goes"
        );
        let ballots = vec![
            vec![1],
            vec![1],
            vec![2],
            vec![2],
            vec![3],
            vec![3],
            vec![3, 2],
            vec![4, 1],
        ];
        let (rounds, winner) = instant_runoff(&[1, 2, 3, 4], &ballots);
        assert_eq!(rounds[0].eliminated, Some(4));
        assert_eq!(
            rounds[1].counts.iter().map(|c| c.count).collect::<Vec<_>>(),
            vec![3, 2, 3]
        );
        assert_eq!(rounds[1].eliminated, Some(2));
        assert_eq!(
            rounds[2].counts.iter().map(|c| c.count).collect::<Vec<_>>(),
            vec![3, 3]
        );
        assert_eq!(rounds[2].exhausted, 2);
        assert_eq!(
            rounds[2].eliminated,
            Some(1),
            "1 and 3 tie in rounds 3 and 2, but 1 had fewer in round 1"
        );
        assert_eq!(winner, Some(3));
        let ballots = vec![
            vec![1],
            vec![1],
            vec![2],
            vec![2],
            vec![2],
            vec![3],
            vec![3],
            vec![3],
            vec![4, 1],
            vec![4, 1],
            vec![1],
        ];
        let (rounds, _) = instant_runoff(&[1, 2, 3, 4], &ballots);
        assert_eq!(rounds[0].eliminated, Some(4));
        assert_eq!(
            rounds[1].counts.iter().map(|c| c.count).collect::<Vec<_>>(),
            vec![5, 3, 3]
        );
        assert_eq!(
            rounds[1].eliminated,
            Some(3),
            "2 and 3 tie and tied before too: the later one goes"
        );
        let ballots = vec![
            vec![2],
            vec![2],
            vec![2],
            vec![3],
            vec![3],
            vec![1],
            vec![1],
            vec![1],
            vec![1],
            vec![4, 3],
            vec![5, 2],
        ];
        let (rounds, _) = instant_runoff(&[1, 2, 3, 4, 5], &ballots);
        assert_eq!(rounds[0].eliminated, Some(5));
        assert_eq!(
            rounds[1].counts.iter().map(|c| c.count).collect::<Vec<_>>(),
            vec![4, 4, 2, 1]
        );
        assert_eq!(rounds[1].eliminated, Some(4));
        assert_eq!(
            rounds[2].counts.iter().map(|c| c.count).collect::<Vec<_>>(),
            vec![4, 4, 3]
        );
        assert_eq!(rounds[2].eliminated, Some(3));
        assert_eq!(
            rounds[3].counts.iter().map(|c| c.count).collect::<Vec<_>>(),
            vec![4, 4]
        );
        assert_eq!(rounds[3].eliminated, Some(2), "round 1 had 2 behind 1");
        assert_eq!(
            rounds[4].counts.iter().map(|c| c.count).collect::<Vec<_>>(),
            vec![4]
        );
        let ballots = vec![
            vec![1],
            vec![1],
            vec![1],
            vec![2],
            vec![2],
            vec![3],
            vec![3],
            vec![2, 1],
            vec![4, 3],
        ];
        let (rounds, _) = instant_runoff(&[1, 2, 3, 4], &ballots);
        assert_eq!(rounds[0].eliminated, Some(4));
        assert_eq!(
            rounds[1].counts.iter().map(|c| c.count).collect::<Vec<_>>(),
            vec![3, 3, 3]
        );
        assert_eq!(
            rounds[1].eliminated,
            Some(3),
            "a three-way tie: round 1 had 3 behind 1 and 2 (2 against 3), so 3 goes"
        );
    }

    #[tokio::test]
    async fn polls_validate_and_post_as_poll_messages() {
        let (state, path, cid) = world("polls_post").await;
        let db = &state.db;
        let bad_polls = [
            (
                json!({"question": " ", "kind": "single", "options": [{"text": "a"}, {"text": "b"}]}),
                "The question cannot be empty",
            ),
            (
                json!({"question": "q", "kind": "single", "options": [{"text": "a"}]}),
                "A poll needs 2 to 20 options",
            ),
            (
                json!({"question": "q", "kind": "single", "options": (0..21).map(|i| json!({"text": format!("o{i}")})).collect::<Vec<_>>()}),
                "A poll needs 2 to 20 options",
            ),
            (
                json!({"question": "q", "kind": "single", "options": [{"text": "a"}, {"text": " A "}]}),
                "Options must be different",
            ),
            (
                json!({"question": "q", "kind": "single", "options": [{"text": "a"}, {"text": " "}]}),
                "Options cannot be empty",
            ),
            (
                json!({"question": "q", "kind": "single", "options": [{"text": "a", "emoji": "nope"}, {"text": "b"}]}),
                "Not an emoji",
            ),
            (
                json!({"question": "q", "kind": "multiple", "options": [{"text": "a"}, {"text": "b"}], "min_choices": 3}),
                "Invalid number of choices",
            ),
            (
                json!({"question": "q", "kind": "multiple", "options": [{"text": "a"}, {"text": "b"}], "min_choices": 2, "max_choices": 1}),
                "Invalid number of choices",
            ),
            (
                json!({"question": "q", "kind": "rating", "scale": 7}),
                "The scale must be 5 or 10",
            ),
            (
                json!({"question": "q", "kind": "rating", "options": [{"text": "a"}]}),
                "This kind of poll has no options",
            ),
            (
                json!({"question": "q", "kind": "yes_no", "allow_add": true}),
                "Options cannot be added to this kind of poll",
            ),
            (
                json!({"question": "q", "kind": "yes_no", "duration_seconds": 59}),
                "The deadline must be 1 minute to 30 days away",
            ),
            (
                json!({"question": "q", "kind": "yes_no", "duration_seconds": 2592001}),
                "The deadline must be 1 minute to 30 days away",
            ),
            (
                json!({"question": "x".repeat(301), "kind": "yes_no"}),
                "The question must be at most 300 characters",
            ),
            (
                json!({"question": "q", "kind": "single", "options": [{"text": "x".repeat(101)}, {"text": "b"}]}),
                "An option must be at most 100 characters",
            ),
        ];
        for (poll, error) in bad_polls {
            assert_eq!(
                code(post_poll(&state, "alice", cid, poll.clone()).await),
                Some((StatusCode::BAD_REQUEST, error.to_string())),
                "{poll}"
            );
        }
        assert_eq!(int(db, "SELECT COUNT(*) FROM messages").await, 0);
        exec(
            db,
            "UPDATE settings SET value = '1' WHERE key = 'profanity_filter'",
        )
        .await;
        crate::api::Settings::forget(db);
        for poll in [
            json!({"question": "what the fuck", "kind": "yes_no"}),
            json!({"question": "q", "kind": "single", "options": [{"text": "shit"}, {"text": "b"}]}),
        ] {
            assert_eq!(
                code(post_poll(&state, "alice", cid, poll).await).map(|(c, _)| c),
                Some(StatusCode::BAD_REQUEST),
                "the profanity filter checks question and options"
            );
        }
        let dm = int(
            db,
            "INSERT INTO dms(user_a, user_b) VALUES('alice', 'bob') RETURNING id",
        )
        .await;
        post_dm_poll(
            &state,
            "alice",
            dm,
            json!({"question": "what the fuck", "kind": "yes_no"}),
        )
        .await
        .expect("DMs are not filtered, like DM messages");
        exec(
            db,
            "UPDATE settings SET value = '0' WHERE key = 'profanity_filter'",
        )
        .await;
        crate::api::Settings::forget(db);
        let attached: SendReq =
            serde_json::from_value(json!({"content": "", "media_id": "x", "poll": lunch()}))
                .expect("req");
        assert_eq!(
            code(
                crate::api::messages::send_channel_message(
                    State(state.clone()),
                    Path(cid),
                    Authed(account("alice", false)),
                    Json(attached)
                )
                .await
            ),
            Some((
                StatusCode::BAD_REQUEST,
                "Polls cannot have attachments".to_string()
            ))
        );
        let mut rx = state.hub.subscribe();
        let m = post_poll(&state, "alice", cid, lunch())
            .await
            .expect("post");
        assert_eq!((m.kind.as_str(), m.content.as_str()), ("poll", "Lunch?"));
        let poll = m.poll.clone().expect("poll");
        assert_eq!(
            poll.options
                .iter()
                .map(|o| (o.text.as_str(), o.emoji.as_deref()))
                .collect::<Vec<_>>(),
            vec![("Pizza", Some("🍕")), ("Soup", None), ("Tacos", None)]
        );
        assert_eq!(
            (poll.kind, poll.closed, poll.voters, counts(&poll)),
            (PollKind::Single, false, 0, Some(vec![0, 0, 0]))
        );
        let live = std::iter::from_fn(|| rx.try_recv().ok())
            .find_map(|ev| match ev {
                WsEvent::Message { message, .. } => Some(*message),
                _ => None,
            })
            .expect("message event");
        assert_eq!(live.poll.map(|p| p.question), Some("Lunch?".to_string()));
        let yes_no = post_poll(
            &state,
            "alice",
            cid,
            json!({"question": "Ship it?", "kind": "yes_no", "duration_seconds": 3600}),
        )
        .await
        .expect("yes no");
        let p = yes_no.poll.expect("poll");
        assert_eq!(
            p.options
                .iter()
                .map(|o| o.text.as_str())
                .collect::<Vec<_>>(),
            vec!["Yes", "No", "Abstain"]
        );
        assert_eq!(p.closes_at, Some(yes_no.created_at + 3600));
        let rating = post_poll(
            &state,
            "alice",
            cid,
            json!({"question": "Rate it", "kind": "rating", "scale": 10}),
        )
        .await
        .expect("rating");
        assert_eq!(
            rating.poll.as_ref().map(|p| (p.scale, p.options.len())),
            Some((Some(10), 0))
        );
        let multi = post_poll(&state, "alice", cid, json!({"question": "Pick", "kind": "multiple", "options": [{"text": "a"}, {"text": "b"}, {"text": "c"}]})).await.expect("multi");
        assert_eq!(
            multi.poll.as_ref().map(|p| (p.min_choices, p.max_choices)),
            Some((1, 3))
        );
        assert_eq!(
            code(
                crate::api::messages::edit_message(
                    State(state.clone()),
                    Path(m.id),
                    Authed(account("alice", false)),
                    Json(serde_json::from_value(json!({"content": "Dinner?"})).expect("edit"))
                )
                .await
            ),
            Some((
                StatusCode::BAD_REQUEST,
                "Cannot edit this message".to_string()
            )),
            "polls are not edited"
        );
        let found = crate::api::messages::search(
            State(state.clone()),
            MaybeAuthed(Some(account("bob", false))),
            HeaderMap::new(),
            RawQuery(Some("q=lunch".to_string())),
        )
        .await
        .map(|Paged(list, _)| list.into_iter().map(|r| r.message.id).collect::<Vec<_>>())
        .expect("search");
        assert_eq!(found, vec![m.id], "search finds polls by question");
        cast(&state, "bob", m.id, ballot(&[ids(&poll)[0]]))
            .await
            .expect("vote");
        let _ = crate::api::messages::delete_message(
            State(state.clone()),
            Path(m.id),
            Authed(account("alice", false)),
        )
        .await
        .expect("delete");
        for table in ["polls", "poll_options", "poll_votes"] {
            assert_eq!(
                int(
                    db,
                    &format!("SELECT COUNT(*) FROM {table} WHERE message_id = {}", m.id)
                )
                .await,
                0,
                "deleting the message deletes its {table}"
            );
        }
        done(state, path).await;
    }

    #[tokio::test]
    async fn votes_change_and_every_kind_is_counted() {
        let (state, path, cid) = world("polls_votes").await;
        let m = post_poll(&state, "alice", cid, lunch())
            .await
            .expect("post");
        let id = m.id;
        let o = ids(m.poll.as_ref().expect("poll"));
        for (bad, why) in [
            (ballot(&[]), "no option"),
            (ballot(&[o[0], o[1]]), "two options"),
            (ballot(&[o[0] + 1000]), "unknown option"),
            (
                VoteReq {
                    options: vec![],
                    value: Some(3),
                },
                "a score",
            ),
        ] {
            assert_eq!(
                code(cast(&state, "bob", id, bad).await),
                Some((StatusCode::BAD_REQUEST, "Invalid vote".to_string())),
                "{why}"
            );
        }
        let mut rx = state.hub.subscribe();
        let p = cast(&state, "bob", id, ballot(&[o[1]]))
            .await
            .expect("vote");
        let own: Vec<(String, i64)> = std::iter::from_fn(|| rx.try_recv().ok())
            .filter_map(|ev| match ev {
                WsEvent::PollVoted {
                    username,
                    message_id,
                } => Some((username, message_id)),
                _ => None,
            })
            .collect();
        assert_eq!(
            own,
            vec![("bob".to_string(), id)],
            "the voter's other tabs hear of it"
        );
        assert_eq!(
            (p.mine.clone(), counts(&p), p.voters),
            (Some(vec![o[1]]), Some(vec![0, 1, 0]), 1)
        );
        let p = cast(&state, "bob", id, ballot(&[o[0]]))
            .await
            .expect("change");
        assert_eq!((counts(&p), p.voters), (Some(vec![1, 0, 0]), 1));
        cast(&state, "carol", id, ballot(&[o[0]]))
            .await
            .expect("carol");
        let p = retract_vote(
            State(state.clone()),
            Path(id),
            Authed(account("bob", false)),
        )
        .await
        .expect("retract")
        .0;
        assert_eq!(
            (p.mine.clone(), counts(&p), p.voters),
            (None, Some(vec![1, 0, 0]), 1)
        );
        assert_eq!(
            counts(&seen(&state, None, id).await.expect("guest")),
            Some(vec![1, 0, 0])
        );
        assert_eq!(
            seen(&state, Some("carol"), id).await.expect("carol").mine,
            Some(vec![o[0]])
        );
        assert_eq!(
            seen(&state, Some("carol"), id)
                .await
                .expect("carol")
                .results
                .and_then(|r| r.winner),
            Some(o[0])
        );

        let fixed = post_poll(
            &state,
            "alice",
            cid,
            json!({"question": "Once", "kind": "yes_no", "allow_change": false}),
        )
        .await
        .expect("fixed");
        let f = ids(fixed.poll.as_ref().expect("poll"));
        cast(&state, "bob", fixed.id, ballot(&[f[0]]))
            .await
            .expect("vote");
        cast(&state, "bob", fixed.id, ballot(&[f[0]]))
            .await
            .expect("the same vote again is fine");
        assert_eq!(
            code(cast(&state, "bob", fixed.id, ballot(&[f[1]])).await),
            Some((StatusCode::BAD_REQUEST, "You already voted".to_string()))
        );
        assert_eq!(
            code(
                retract_vote(
                    State(state.clone()),
                    Path(fixed.id),
                    Authed(account("bob", false))
                )
                .await
            ),
            Some((
                StatusCode::BAD_REQUEST,
                "Votes in this poll cannot be changed".to_string()
            ))
        );

        let multi = post_poll(&state, "alice", cid, json!({"question": "Pick", "kind": "multiple", "min_choices": 2, "max_choices": 3, "options": [{"text": "a"}, {"text": "b"}, {"text": "c"}, {"text": "d"}]})).await.expect("multi");
        let mo = ids(multi.poll.as_ref().expect("poll"));
        assert!(
            cast(&state, "bob", multi.id, ballot(&[mo[0]]))
                .await
                .is_err(),
            "too few"
        );
        assert!(
            cast(&state, "bob", multi.id, ballot(&mo)).await.is_err(),
            "too many"
        );
        assert!(
            cast(&state, "bob", multi.id, ballot(&[mo[0], mo[0]]))
                .await
                .is_err(),
            "repeated"
        );
        cast(&state, "bob", multi.id, ballot(&[mo[2], mo[0]]))
            .await
            .expect("bob");
        let p = cast(&state, "carol", multi.id, ballot(&[mo[0], mo[1], mo[3]]))
            .await
            .expect("carol");
        assert_eq!(
            (
                counts(&p),
                p.voters,
                p.results.as_ref().and_then(|r| r.winner)
            ),
            (Some(vec![2, 1, 1, 1]), 2, Some(mo[0]))
        );

        let rating = post_poll(
            &state,
            "alice",
            cid,
            json!({"question": "Rate", "kind": "rating"}),
        )
        .await
        .expect("rating");
        for bad in [Some(0), Some(6), None] {
            assert!(
                cast(
                    &state,
                    "bob",
                    rating.id,
                    VoteReq {
                        options: vec![],
                        value: bad
                    }
                )
                .await
                .is_err()
            );
        }
        cast(
            &state,
            "bob",
            rating.id,
            VoteReq {
                options: vec![],
                value: Some(5),
            },
        )
        .await
        .expect("bob");
        cast(
            &state,
            "carol",
            rating.id,
            VoteReq {
                options: vec![],
                value: Some(4),
            },
        )
        .await
        .expect("carol");
        let p = cast(
            &state,
            "dave",
            rating.id,
            VoteReq {
                options: vec![],
                value: Some(4),
            },
        )
        .await
        .expect("dave");
        let r = p.results.expect("results");
        assert_eq!(
            (r.distribution, r.average, p.mine),
            (vec![0, 0, 0, 2, 1], Some(4.33), Some(vec![4]))
        );

        let ranked = post_poll(&state, "alice", cid, json!({"question": "Order", "kind": "ranked", "options": [{"text": "a"}, {"text": "b"}, {"text": "c"}]})).await.expect("ranked");
        let ro = ids(ranked.poll.as_ref().expect("poll"));
        assert!(
            cast(&state, "bob", ranked.id, ballot(&[ro[0], ro[0]]))
                .await
                .is_err()
        );
        cast(&state, "alice", ranked.id, ballot(&[ro[2], ro[1]]))
            .await
            .expect("alice");
        cast(&state, "bob", ranked.id, ballot(&[ro[0]]))
            .await
            .expect("bob, a partial ballot");
        cast(&state, "carol", ranked.id, ballot(&[ro[1], ro[0], ro[2]]))
            .await
            .expect("carol");
        let p = cast(&state, "dave", ranked.id, ballot(&[ro[0], ro[1]]))
            .await
            .expect("dave");
        assert_eq!(p.mine, Some(vec![ro[0], ro[1]]), "rank order is kept");
        let r = p.results.expect("results");
        assert_eq!(
            r.counts.iter().map(|c| c.count).collect::<Vec<_>>(),
            vec![2, 1, 1]
        );
        assert_eq!(r.rounds.len(), 3);
        assert_eq!(
            r.rounds[0].eliminated,
            Some(ro[2]),
            "b and c tie: c is listed later"
        );
        assert_eq!(
            r.rounds[1]
                .counts
                .iter()
                .map(|c| c.count)
                .collect::<Vec<_>>(),
            vec![2, 2]
        );
        assert_eq!(r.rounds[1].eliminated, Some(ro[1]), "a led b in round 1");
        assert_eq!(r.winner, Some(ro[0]));
        done(state, path).await;
    }

    #[tokio::test]
    async fn moderator_closes_and_reopens_are_audited() {
        let (state, path, cid) = world("polls_audit").await;
        let db = &state.db;
        exec(
            db,
            "UPDATE members SET is_admin = 1, perms = 2 WHERE username = 'dave'",
        )
        .await;
        let m = post_poll(
            &state,
            "alice",
            cid,
            json!({"question": "Lunch?", "kind": "yes_no"}),
        )
        .await
        .expect("post");
        let as_user = |who: &str| Authed(account(who, false));
        let _ = close_poll(State(state.clone()), Path(m.id), as_user("alice"))
            .await
            .expect("the author closes");
        let _ = reopen_poll(State(state.clone()), Path(m.id), as_user("alice"))
            .await
            .expect("the author reopens");
        assert_eq!(
            int(db, "SELECT COUNT(*) FROM audit_log").await,
            0,
            "the author's own poll is not moderation"
        );
        let _ = close_poll(State(state.clone()), Path(m.id), as_user("dave"))
            .await
            .expect("a moderator closes");
        let _ = close_poll(State(state.clone()), Path(m.id), as_user("dave"))
            .await
            .expect("closing again changes nothing");
        let _ = reopen_poll(State(state.clone()), Path(m.id), as_user("dave"))
            .await
            .expect("a moderator reopens");
        let rows: Vec<(String, String, i64, String)> =
            sqlx::query("SELECT action, actor, target_id, target_name FROM audit_log ORDER BY id")
                .fetch_all(db)
                .await
                .expect("audit")
                .iter()
                .map(|r| {
                    (
                        r.try_get(0).expect("action"),
                        r.try_get(1).expect("actor"),
                        r.try_get(2).expect("target"),
                        r.try_get(3).expect("author"),
                    )
                })
                .collect();
        let entry = |action: &str| {
            (
                action.to_string(),
                "dave".to_string(),
                m.id,
                "alice".to_string(),
            )
        };
        assert_eq!(
            rows,
            [entry("message.poll_close"), entry("message.poll_reopen")]
        );
        assert_eq!(
            int(db, "SELECT COUNT(*) FROM audit_channels").await,
            2,
            "entries carry the channel"
        );
        done(state, path).await;
    }

    #[tokio::test]
    async fn results_stay_hidden_until_the_poll_allows_them() {
        let (state, path, cid) = world("polls_hidden").await;
        let db = &state.db;
        let m = post_poll(
            &state,
            "alice",
            cid,
            json!({"question": "Secret?", "kind": "yes_no", "show_results": "after_vote"}),
        )
        .await
        .expect("post");
        let o = ids(m.poll.as_ref().expect("poll"));
        assert_eq!(m.poll.as_ref().map(|p| p.results.is_none()), Some(true));
        let mut rx = state.hub.subscribe();
        let p = cast(&state, "bob", m.id, ballot(&[o[0]]))
            .await
            .expect("bob");
        assert_eq!(
            counts(&p),
            Some(vec![1, 0, 0]),
            "bob voted and sees the counts"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
        let live = poll_events(&mut rx);
        assert_eq!(live.len(), 1);
        assert_eq!(
            (
                live[0].voters,
                live[0].results.is_none(),
                live[0].mine.is_none()
            ),
            (1, true, true),
            "the event never carries hidden counts"
        );
        let carol = seen(&state, Some("carol"), m.id).await.expect("carol");
        assert_eq!((carol.voters, carol.results.is_none()), (1, true));
        assert_eq!(seen(&state, None, m.id).await.expect("guest").results, None);
        let list = crate::api::messages::channel_messages(
            State(state.clone()),
            MaybeAuthed(Some(account("carol", false))),
            HeaderMap::new(),
            Path(cid),
            Query(serde_json::from_value(json!({})).expect("page")),
        )
        .await
        .expect("list")
        .0;
        assert!(
            list[0].poll.as_ref().is_some_and(|p| p.results.is_none()),
            "the message list hides them from carol"
        );
        let list = crate::api::messages::channel_messages(
            State(state.clone()),
            MaybeAuthed(Some(account("bob", false))),
            HeaderMap::new(),
            Path(cid),
            Query(serde_json::from_value(json!({})).expect("page")),
        )
        .await
        .expect("list")
        .0;
        assert_eq!(
            list[0].poll.as_ref().and_then(counts),
            Some(vec![1, 0, 0]),
            "and shows them to bob"
        );
        assert_eq!(
            list[0].poll.as_ref().and_then(|p| p.mine.clone()),
            Some(vec![o[0]])
        );
        let found = crate::api::messages::search(
            State(state.clone()),
            MaybeAuthed(Some(account("carol", false))),
            HeaderMap::new(),
            RawQuery(Some("q=secret".to_string())),
        )
        .await
        .expect("search")
        .0;
        assert!(
            found[0]
                .message
                .poll
                .as_ref()
                .is_some_and(|p| p.results.is_none())
        );
        let pinned = crate::api::pins::pin_message(
            State(state.clone()),
            Path(m.id),
            Authed(account("alice", true)),
        )
        .await;
        assert!(pinned.is_err(), "alice has no Manage messages");
        exec(
            db,
            "UPDATE members SET is_admin = 1, perms = 2 WHERE username = 'dave'",
        )
        .await;
        let _ = crate::api::pins::pin_message(
            State(state.clone()),
            Path(m.id),
            Authed(account("dave", false)),
        )
        .await
        .expect("pin");
        let pins = crate::api::pins::channel_pins(
            State(state.clone()),
            MaybeAuthed(Some(account("carol", false))),
            HeaderMap::new(),
            Path(cid),
        )
        .await
        .expect("pins")
        .0;
        assert!(
            pins.iter()
                .any(|p| p.id == m.id && p.poll.as_ref().is_some_and(|p| p.results.is_none())),
            "pins hide them too"
        );
        assert_eq!(
            code(voters_of(&state, "carol", m.id, None, None).await),
            Some((StatusCode::FORBIDDEN, "Results are hidden".to_string()))
        );
        assert_eq!(
            voters_of(&state, "bob", m.id, Some(o[0]), None)
                .await
                .expect("voters")
                .0,
            vec!["bob"]
        );
        let reply: SendReq =
            serde_json::from_value(json!({"content": "nice", "reply_to": m.id})).expect("reply");
        let quoted = crate::api::messages::send_channel_message(
            State(state.clone()),
            Path(cid),
            Authed(account("carol", false)),
            Json(reply),
        )
        .await
        .expect("reply to a poll")
        .0;
        assert_eq!(
            quoted.reply_to.map(|q| q.content),
            Some("Secret?".to_string()),
            "a quote shows the question only"
        );

        let after_close = post_poll(
            &state,
            "alice",
            cid,
            json!({"question": "Later", "kind": "yes_no", "show_results": "after_close"}),
        )
        .await
        .expect("post");
        let c = ids(after_close.poll.as_ref().expect("poll"));
        let p = cast(&state, "bob", after_close.id, ballot(&[c[1]]))
            .await
            .expect("bob");
        assert_eq!(
            (p.results.is_none(), p.mine.clone()),
            (true, Some(vec![c[1]])),
            "even voters wait for the close"
        );
        assert!(
            code(
                close_poll(
                    State(state.clone()),
                    Path(after_close.id),
                    Authed(account("bob", false))
                )
                .await
            )
            .is_some_and(|(c, _)| c == StatusCode::FORBIDDEN),
            "only the author or a moderator"
        );
        let p = close_poll(
            State(state.clone()),
            Path(after_close.id),
            Authed(account("dave", false)),
        )
        .await
        .expect("a moderator closes")
        .0;
        assert_eq!((p.closed, counts(&p)), (true, Some(vec![0, 1, 0])));
        assert_eq!(
            counts(&seen(&state, None, after_close.id).await.expect("guest")),
            Some(vec![0, 1, 0]),
            "public once closed"
        );
        assert_eq!(
            int(
                db,
                &format!(
                    "SELECT COUNT(*) FROM polls WHERE message_id = {} AND closed_by = 'dave'",
                    after_close.id
                )
            )
            .await,
            1
        );
        assert_eq!(
            code(cast(&state, "carol", after_close.id, ballot(&[c[0]])).await),
            Some((StatusCode::BAD_REQUEST, "This poll is closed".to_string()))
        );
        let p = reopen_poll(
            State(state.clone()),
            Path(after_close.id),
            Authed(account("alice", false)),
        )
        .await
        .expect("the author reopens")
        .0;
        assert_eq!(
            (p.closed, p.results.is_none()),
            (false, true),
            "hidden again"
        );
        let _ = reopen_poll(
            State(state.clone()),
            Path(after_close.id),
            Authed(account("alice", false)),
        )
        .await
        .expect("reopening twice is fine");
        cast(&state, "carol", after_close.id, ballot(&[c[0]]))
            .await
            .expect("open again");

        let anon = post_poll(&state, "alice", cid, json!({"question": "Anon", "kind": "single", "anonymous": true, "options": [{"text": "a"}, {"text": "b"}]})).await.expect("anon");
        let a = ids(anon.poll.as_ref().expect("poll"));
        let p = cast(&state, "bob", anon.id, ballot(&[a[1]]))
            .await
            .expect("bob");
        assert_eq!((counts(&p), p.mine), (Some(vec![0, 1]), Some(vec![a[1]])));
        assert_eq!(
            code(voters_of(&state, "alice", anon.id, None, None).await),
            Some((
                StatusCode::FORBIDDEN,
                "Votes in this poll are anonymous".to_string()
            ))
        );
        assert_eq!(int(db, &format!("SELECT COUNT(*) FROM poll_votes WHERE message_id = {} AND (voter = 'bob' OR voter LIKE '%bob%')", anon.id)).await, 0, "the voter is stored only as a keyed hash");
        assert_eq!(
            int(
                db,
                &format!(
                    "SELECT COUNT(*) FROM poll_votes WHERE message_id = {} AND voter LIKE 'a2:%'",
                    anon.id
                )
            )
            .await,
            1
        );
        let p = cast(&state, "bob", anon.id, ballot(&[a[0]]))
            .await
            .expect("change");
        assert_eq!(
            (counts(&p), p.voters),
            (Some(vec![1, 0]), 1),
            "still one vote per person"
        );
        done(state, path).await;
    }

    #[tokio::test]
    async fn voting_needs_read_access_send_rights_and_the_history_floor() {
        let (state, path, cid) = world("polls_access").await;
        let db = &state.db;
        let m = post_poll(&state, "alice", cid, lunch())
            .await
            .expect("post");
        let o = ids(m.poll.as_ref().expect("poll"));
        assert_eq!(
            code(cast(&state, "nina", m.id, ballot(&[o[0]])).await).map(|(c, _)| c),
            Some(StatusCode::FORBIDDEN),
            "not a member"
        );
        let quiet = int(db, "INSERT INTO channels(server, name, created_at) VALUES('rchat', 'quiet', 1) RETURNING id").await;
        exec(db, &format!("INSERT INTO channel_perms(channel_id, subject, can_view, can_send, can_read_history) VALUES({quiet}, 'u:bob', 1, 0, 1), ({quiet}, 'u:alice', 1, 1, 1)")).await;
        let announced = post_poll(&state, "alice", quiet, lunch())
            .await
            .expect("post");
        let q = ids(announced.poll.as_ref().expect("poll"));
        assert_eq!(
            code(cast(&state, "bob", announced.id, ballot(&[q[0]])).await),
            Some((
                StatusCode::FORBIDDEN,
                "No permission to vote in this channel".to_string()
            ))
        );
        let hidden = int(db, "INSERT INTO channels(server, name, created_at) VALUES('rchat', 'hidden', 1) RETURNING id").await;
        exec(db, &format!("INSERT INTO channel_perms(channel_id, subject, can_view, can_send, can_read_history) VALUES({hidden}, 'r:0', 0, 1, 1), ({hidden}, 'u:alice', 1, 1, 1)")).await;
        crate::api::test_util::restrict_ruled(db).await;
        let secret = post_poll(&state, "alice", hidden, lunch())
            .await
            .expect("post");
        let s = ids(secret.poll.as_ref().expect("poll"));
        let missing = code(seen(&state, Some("bob"), m.id + 10_000).await);
        assert_eq!(missing.clone().map(|(c, _)| c), Some(StatusCode::NOT_FOUND));
        assert_eq!(
            code(seen(&state, Some("bob"), secret.id).await),
            missing,
            "a hidden poll looks missing"
        );
        assert_eq!(
            code(cast(&state, "bob", secret.id, ballot(&[s[0]])).await),
            missing
        );
        assert_eq!(
            code(voters_of(&state, "bob", secret.id, None, None).await),
            missing
        );
        let user_msg: SendReq = serde_json::from_value(json!({"content": "plain"})).expect("plain");
        let plain = crate::api::messages::send_channel_message(
            State(state.clone()),
            Path(cid),
            Authed(account("alice", false)),
            Json(user_msg),
        )
        .await
        .expect("plain")
        .0;
        assert_eq!(
            code(seen(&state, Some("bob"), plain.id).await),
            missing,
            "a plain message is no poll"
        );
        assert_eq!(
            code(cast(&state, "bob", plain.id, ballot(&[o[0]])).await),
            missing
        );
        let old = int(
            db,
            "INSERT INTO channels(server, name, created_at) VALUES('rchat', 'old', 1) RETURNING id",
        )
        .await;
        exec(db, &format!("INSERT INTO channel_perms(channel_id, subject, can_view, can_send, can_read_history) VALUES({old}, 'u:erin', 1, 1, 0)")).await;
        let past = post_poll(&state, "alice", old, lunch())
            .await
            .expect("post");
        let p = ids(past.poll.as_ref().expect("poll"));
        add_user(db, "erin").await;
        add_member(db, "rchat", "erin", 0, 0, now() + 100).await;
        assert_eq!(
            code(seen(&state, Some("erin"), past.id).await),
            missing,
            "posted before erin joined, without read history"
        );
        assert_eq!(
            code(cast(&state, "erin", past.id, ballot(&[p[0]])).await),
            missing
        );
        assert_eq!(
            code(voters_of(&state, "erin", past.id, None, None).await),
            missing
        );
        cast(&state, "bob", past.id, ballot(&[p[0]]))
            .await
            .expect("bob reads history");
        exec(
            db,
            "UPDATE settings SET value = '0' WHERE key = 'guests_enabled'",
        )
        .await;
        crate::api::Settings::forget(db);
        assert_eq!(
            code(seen(&state, None, m.id).await).map(|(c, _)| c),
            Some(StatusCode::UNAUTHORIZED)
        );
        done(state, path).await;
    }

    #[tokio::test]
    async fn dm_polls_go_through_the_dm_write_guard() {
        let (state, path, _) = world("polls_dm").await;
        let db = &state.db;
        let dm = int(
            db,
            "INSERT INTO dms(user_a, user_b) VALUES('alice', 'bob') RETURNING id",
        )
        .await;
        let m = post_dm_poll(&state, "alice", dm, json!({"question": "Movie?", "kind": "single", "allow_add": true, "options": [{"text": "a"}, {"text": "b"}]})).await.expect("post");
        let o = ids(m.poll.as_ref().expect("poll"));
        assert_eq!(
            code(seen(&state, Some("carol"), m.id).await).map(|(c, _)| c),
            Some(StatusCode::NOT_FOUND)
        );
        assert_eq!(
            code(cast(&state, "carol", m.id, ballot(&[o[0]])).await).map(|(c, _)| c),
            Some(StatusCode::NOT_FOUND)
        );
        cast(&state, "bob", m.id, ballot(&[o[0]]))
            .await
            .expect("bob votes");
        assert_eq!(
            code(
                close_poll(
                    State(state.clone()),
                    Path(m.id),
                    Authed(account("bob", false))
                )
                .await
            ),
            Some((
                StatusCode::FORBIDDEN,
                "Only the author or a moderator can do this".to_string()
            ))
        );
        exec(
            db,
            "INSERT INTO blocks(blocker, blocked, created_at) VALUES('alice', 'bob', 1)",
        )
        .await;
        let refused = Some((
            StatusCode::FORBIDDEN,
            crate::api::blocks::NOT_ACCEPTING.to_string(),
        ));
        assert_eq!(
            code(cast(&state, "bob", m.id, ballot(&[o[1]])).await),
            refused
        );
        assert_eq!(
            code(
                retract_vote(
                    State(state.clone()),
                    Path(m.id),
                    Authed(account("bob", false))
                )
                .await
            ),
            refused
        );
        let option = || {
            Json(AddOptionReq {
                text: "c".to_string(),
                emoji: None,
            })
        };
        assert_eq!(
            code(
                add_option(
                    State(state.clone()),
                    Path(m.id),
                    Authed(account("bob", false)),
                    option()
                )
                .await
            ),
            refused
        );
        let mine = code(
            close_poll(
                State(state.clone()),
                Path(m.id),
                Authed(account("alice", false)),
            )
            .await,
        );
        assert!(
            mine.is_some_and(
                |(c, msg)| c == StatusCode::FORBIDDEN && msg.starts_with("You blocked")
            ),
            "the blocker is refused too"
        );
        assert_eq!(
            code(post_dm_poll(&state, "bob", dm, lunch()).await),
            refused
        );
        exec(db, "DELETE FROM blocks").await;
        exec(
            db,
            "INSERT INTO privacy(username, dms) VALUES('alice', 'friends')",
        )
        .await;
        assert_eq!(
            code(cast(&state, "bob", m.id, ballot(&[o[1]])).await),
            refused,
            "friends-only DMs"
        );
        exec(db, "INSERT INTO friends(username, friend, created_at) VALUES('alice', 'bob', 1), ('bob', 'alice', 1)").await;
        let p = add_option(
            State(state.clone()),
            Path(m.id),
            Authed(account("bob", false)),
            option(),
        )
        .await
        .expect("friends may")
        .0;
        assert_eq!(p.options.len(), 3);
        cast(&state, "bob", m.id, ballot(&[p.options[2].id]))
            .await
            .expect("vote for the new option");
        let _ = close_poll(
            State(state.clone()),
            Path(m.id),
            Authed(account("alice", false)),
        )
        .await
        .expect("the author closes");
        done(state, path).await;
    }

    #[tokio::test]
    async fn timed_out_members_cannot_vote_or_run_polls_in_the_server() {
        let (state, path, cid) = world("polls_timeout").await;
        let db = &state.db;
        exec(
            db,
            "UPDATE members SET is_admin = 1, perms = 2 WHERE username = 'dave'",
        )
        .await;
        let open = json!({"question": "Lunch?", "kind": "single", "allow_add": true, "options": [{"text": "a"}, {"text": "b"}]});
        let theirs = post_poll(&state, "alice", cid, open.clone())
            .await
            .expect("alice posts");
        let own = post_poll(&state, "bob", cid, open.clone())
            .await
            .expect("bob posts");
        let o = ids(theirs.poll.as_ref().expect("poll"));
        cast(&state, "bob", theirs.id, ballot(&[o[0]]))
            .await
            .expect("bob votes before");
        let dm = int(
            db,
            "INSERT INTO dms(user_a, user_b) VALUES('alice', 'bob') RETURNING id",
        )
        .await;
        let in_dm = post_dm_poll(&state, "alice", dm, open.clone())
            .await
            .expect("dm poll");
        let time_out = |who: &str, until: i64| {
            format!(
                "INSERT INTO member_timeouts(server, username, until, reason, set_by, created_at) VALUES('rchat', '{who}', {until}, NULL, 'alice', 1)"
            )
        };
        exec(db, &time_out("bob", now() + 600)).await;
        exec(db, &time_out("dave", now() + 600)).await;
        let refused = Some((
            StatusCode::FORBIDDEN,
            crate::api::access::TIMED_OUT.to_string(),
        ));
        let as_user = |who: &str| Authed(account(who, false));
        let option = || {
            Json(AddOptionReq {
                text: "c".to_string(),
                emoji: None,
            })
        };
        assert_eq!(
            code(cast(&state, "bob", theirs.id, ballot(&[o[1]])).await),
            refused
        );
        assert_eq!(
            code(retract_vote(State(state.clone()), Path(theirs.id), as_user("bob")).await),
            refused
        );
        assert_eq!(
            code(
                add_option(
                    State(state.clone()),
                    Path(theirs.id),
                    as_user("bob"),
                    option()
                )
                .await
            ),
            refused
        );
        assert_eq!(
            code(post_poll(&state, "bob", cid, open.clone()).await),
            refused
        );
        assert_eq!(
            code(close_poll(State(state.clone()), Path(own.id), as_user("bob")).await),
            refused,
            "the author is timed out"
        );
        assert_eq!(
            code(close_poll(State(state.clone()), Path(theirs.id), as_user("dave")).await),
            refused,
            "the moderator is timed out"
        );
        cast(&state, "carol", theirs.id, ballot(&[o[1]]))
            .await
            .expect("others still vote");
        let d = ids(in_dm.poll.as_ref().expect("poll"));
        cast(&state, "bob", in_dm.id, ballot(&[d[0]]))
            .await
            .expect("DMs know no timeouts");
        post_dm_poll(&state, "bob", dm, open.clone())
            .await
            .expect("bob posts in the DM");
        let counted = seen(&state, Some("alice"), theirs.id).await.expect("read");
        assert_eq!(
            counts(&counted),
            Some(vec![1, 1]),
            "the refused vote was not stored"
        );
        exec(db, &format!("UPDATE member_timeouts SET until = {}", now())).await;
        cast(&state, "bob", theirs.id, ballot(&[o[1]]))
            .await
            .expect("votes again once it ended");
        let _ = close_poll(State(state.clone()), Path(own.id), as_user("bob"))
            .await
            .expect("closes again once it ended");
        let _ = close_poll(State(state.clone()), Path(theirs.id), as_user("dave"))
            .await
            .expect("moderates again once it ended");
        done(state, path).await;
    }

    #[tokio::test]
    async fn options_can_be_added_while_open_up_to_the_cap() {
        let (state, path, cid) = world("polls_add").await;
        let m = post_poll(&state, "alice", cid, lunch())
            .await
            .expect("post");
        let add = |who: &'static str, text: String| {
            let state = state.clone();
            async move {
                add_option(
                    State(state),
                    Path(m.id),
                    Authed(account(who, false)),
                    Json(AddOptionReq { text, emoji: None }),
                )
                .await
                .map(|Json(p)| p)
            }
        };
        assert_eq!(
            code(add("bob", "Rice".to_string()).await),
            Some((
                StatusCode::BAD_REQUEST,
                "Options cannot be added to this poll".to_string()
            ))
        );
        add("alice", "Rice".to_string())
            .await
            .expect("the author may");
        let open = post_poll(&state, "alice", cid, json!({"question": "Ideas", "kind": "ranked", "allow_add": true, "options": [{"text": "a"}, {"text": "b"}]})).await.expect("post");
        let add_open = |who: &'static str, text: &str| {
            let state = state.clone();
            let text = text.to_string();
            async move {
                add_option(
                    State(state),
                    Path(open.id),
                    Authed(account(who, false)),
                    Json(AddOptionReq {
                        text,
                        emoji: Some("🎉".to_string()),
                    }),
                )
                .await
                .map(|Json(p)| p)
            }
        };
        assert_eq!(
            code(add_open("bob", " A ").await),
            Some((
                StatusCode::BAD_REQUEST,
                "Options must be different".to_string()
            ))
        );
        assert_eq!(
            code(add_open("nina", "x").await).map(|(c, _)| c),
            Some(StatusCode::FORBIDDEN)
        );
        let p = add_open("bob", "c").await.expect("bob adds");
        assert_eq!(
            p.options
                .last()
                .map(|o| (o.text.as_str(), o.emoji.as_deref())),
            Some(("c", Some("🎉")))
        );
        for i in 0..17 {
            add_open("carol", &format!("o{i}")).await.expect("up to 20");
        }
        assert_eq!(
            code(add_open("carol", "one more").await),
            Some((
                StatusCode::BAD_REQUEST,
                "A poll can have at most 20 options".to_string()
            ))
        );
        let yes_no = post_poll(
            &state,
            "alice",
            cid,
            json!({"question": "y", "kind": "yes_no"}),
        )
        .await
        .expect("post");
        assert!(
            add_option(
                State(state.clone()),
                Path(yes_no.id),
                Authed(account("alice", false)),
                Json(AddOptionReq {
                    text: "Maybe".to_string(),
                    emoji: None
                })
            )
            .await
            .is_err()
        );
        let _ = close_poll(
            State(state.clone()),
            Path(open.id),
            Authed(account("alice", false)),
        )
        .await
        .expect("close");
        assert_eq!(
            code(add_open("alice", "late").await),
            Some((StatusCode::BAD_REQUEST, "This poll is closed".to_string()))
        );
        done(state, path).await;
    }

    #[tokio::test]
    async fn voters_are_listed_in_pages() {
        let (state, path, cid) = world("polls_voters").await;
        let db = &state.db;
        let m = post_poll(&state, "alice", cid, lunch())
            .await
            .expect("post");
        let o = ids(m.poll.as_ref().expect("poll"));
        for i in 0..55 {
            let name = format!("v{i:02}");
            add_user(db, &name).await;
            add_member(db, "rchat", &name, 0, 0, 1).await;
            sqlx::query("INSERT INTO poll_votes(message_id, voter, option_id, value, created_at) VALUES($1, $2, $3, 1, $4)")
                .bind(m.id)
                .bind(&name)
                .bind(o[i % 2])
                .bind(100 + (i as i64) / 10)
                .execute(db)
                .await
                .expect("vote");
        }
        let (first, next) = voters_of(&state, "bob", m.id, None, None)
            .await
            .expect("page");
        assert_eq!(first.len(), 50);
        assert_eq!(first[0], "v00");
        let (rest, last) = voters_of(&state, "bob", m.id, None, next)
            .await
            .expect("page 2");
        assert_eq!((rest.len(), last), (5, None));
        let mut all = first.clone();
        all.extend(rest);
        all.sort();
        all.dedup();
        assert_eq!(all.len(), 55, "no voter twice or missing across pages");
        let (odd, _) = voters_of(&state, "bob", m.id, Some(o[1]), None)
            .await
            .expect("option");
        assert_eq!(odd.len(), 27);
        exec(
            db,
            "UPDATE users SET password_hash = '!purging' WHERE username = 'v01'",
        )
        .await;
        let (odd, _) = voters_of(&state, "bob", m.id, Some(o[1]), None)
            .await
            .expect("option");
        assert_eq!(odd.len(), 26, "accounts being deleted are left out");
        assert_eq!(
            code(voters_of(&state, "bob", m.id, None, Some("zz".to_string())).await),
            Some((StatusCode::BAD_REQUEST, "Invalid cursor".to_string()))
        );
        done(state, path).await;
    }

    #[tokio::test]
    async fn updates_are_coalesced_to_one_per_second() {
        let (state, path, cid) = world("polls_live").await;
        let m = post_poll(&state, "alice", cid, lunch())
            .await
            .expect("post");
        let o = ids(m.poll.as_ref().expect("poll"));
        let mut rx = state.hub.subscribe();
        for who in ["alice", "bob", "carol", "dave"] {
            cast(&state, who, m.id, ballot(&[o[0]]))
                .await
                .expect("vote");
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
        let first = poll_events(&mut rx);
        assert_eq!(first.len(), 1, "the first change goes out right away");
        tokio::time::sleep(UPDATE_EVERY + Duration::from_millis(300)).await;
        let rest = poll_events(&mut rx);
        assert_eq!(rest.len(), 1, "the others are coalesced into one");
        assert_eq!((rest[0].voters, counts(&rest[0])), (4, Some(vec![4, 0, 0])));
        assert!(rest[0].mine.is_none());
        tokio::time::sleep(UPDATE_EVERY).await;
        assert!(poll_events(&mut rx).is_empty());
        match update_event(&state.db, m.id).await.expect("event") {
            Some(WsEvent::PollUpdated {
                server,
                channel_id,
                created_at,
                ..
            }) => {
                assert_eq!(
                    (server.as_deref(), channel_id, created_at),
                    (Some("rchat"), Some(cid), m.created_at)
                );
            }
            _ => panic!("no event"),
        }
        assert!(
            crate::ws::current(
                &state,
                update_event(&state.db, m.id).await.expect("e").expect("e")
            )
            .await
            .is_some()
        );
        let _ = crate::api::messages::delete_message(
            State(state.clone()),
            Path(m.id),
            Authed(account("alice", false)),
        )
        .await
        .expect("delete");
        assert!(
            update_event(&state.db, m.id)
                .await
                .expect("event")
                .is_none(),
            "a deleted poll sends nothing"
        );
        done(state, path).await;
    }

    #[tokio::test]
    async fn deadlines_close_once_and_late_votes_are_refused() {
        let (state, path, cid) = world("polls_deadline").await;
        let db = &state.db;
        let m = post_poll(
            &state,
            "alice",
            cid,
            json!({"question": "Soon", "kind": "yes_no", "duration_seconds": 60}),
        )
        .await
        .expect("post");
        let o = ids(m.poll.as_ref().expect("poll"));
        cast(&state, "bob", m.id, ballot(&[o[0]]))
            .await
            .expect("in time");
        assert_eq!(close_due(&state).await.expect("sweep"), 0, "not due yet");
        exec(
            db,
            &format!(
                "UPDATE polls SET closes_at = {} WHERE message_id = {}",
                now() - 1,
                m.id
            ),
        )
        .await;
        let p = seen(&state, Some("carol"), m.id).await.expect("carol");
        assert!(
            p.closed,
            "past the deadline it reads as closed before any sweep"
        );
        assert_eq!(
            code(cast(&state, "carol", m.id, ballot(&[o[1]])).await),
            Some((StatusCode::BAD_REQUEST, "This poll is closed".to_string()))
        );
        let mut rx = state.hub.subscribe();
        assert_eq!(close_due(&state).await.expect("sweep"), 1);
        assert_eq!(
            close_due(&state).await.expect("sweep"),
            0,
            "closing is idempotent"
        );
        tokio::time::sleep(UPDATE_EVERY + Duration::from_millis(300)).await;
        let live = poll_events(&mut rx);
        assert_eq!(live.len(), 1);
        assert!(live[0].closed);
        assert_eq!(int(db, &format!("SELECT COUNT(*) FROM polls WHERE message_id = {} AND closed_at = closes_at AND closed_by IS NULL", m.id)).await, 1);
        let _ = close_poll(
            State(state.clone()),
            Path(m.id),
            Authed(account("alice", false)),
        )
        .await
        .expect("closing again is fine");
        let p = reopen_poll(
            State(state.clone()),
            Path(m.id),
            Authed(account("alice", false)),
        )
        .await
        .expect("reopen")
        .0;
        assert_eq!(
            (p.closed, p.closes_at),
            (false, None),
            "the passed deadline is gone"
        );
        cast(&state, "carol", m.id, ballot(&[o[1]]))
            .await
            .expect("votes again");
        done(state, path).await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn concurrent_votes_keep_one_ballot_each_and_lose_to_a_close() {
        let (state, path, cid) = world("polls_race").await;
        let db = &state.db;
        let m = post_poll(&state, "alice", cid, json!({"question": "Race", "kind": "multiple", "options": [{"text": "a"}, {"text": "b"}, {"text": "c"}]})).await.expect("post");
        let o = ids(m.poll.as_ref().expect("poll"));
        let mut tasks = Vec::new();
        for i in 0..24 {
            let state = state.clone();
            let pick = match i % 3 {
                0 => vec![o[0]],
                1 => vec![o[1], o[2]],
                _ => vec![o[2], o[0], o[1]],
            };
            tasks.push(tokio::spawn(async move {
                cast(&state, "bob", m.id, ballot(&pick)).await
            }));
        }
        for t in tasks {
            t.await.expect("join").expect("vote");
        }
        let rows = int(db, &format!("SELECT COUNT(DISTINCT created_at) FROM poll_votes WHERE message_id = {} AND voter = 'bob'", m.id)).await;
        assert_eq!(rows, 1, "one ballot, never a mix of two");
        let p = seen(&state, Some("bob"), m.id).await.expect("bob");
        assert_eq!(p.voters, 1);
        assert_eq!(
            counts(&p).map(|c| c.iter().sum::<i64>()),
            Some(p.mine.as_ref().map_or(0, |m| m.len() as i64))
        );

        let race = post_poll(
            &state,
            "alice",
            cid,
            json!({"question": "Late", "kind": "yes_no", "allow_change": false}),
        )
        .await
        .expect("post");
        let r = ids(race.poll.as_ref().expect("poll"));
        let mut names = Vec::new();
        for i in 0..40 {
            let name = format!("r{i:02}");
            add_user(db, &name).await;
            add_member(db, "rchat", &name, 0, 0, 1).await;
            names.push(name);
        }
        let mut tasks = Vec::new();
        for (i, name) in names.iter().enumerate() {
            let voter = state.clone();
            let name = name.clone();
            let pick = r[i % 3];
            tasks.push(tokio::spawn(async move {
                vote(
                    State(voter),
                    Path(race.id),
                    Authed(account(&name, false)),
                    Json(ballot(&[pick])),
                )
                .await
                .map(|_| ())
            }));
            if i == 20 {
                let state = state.clone();
                tasks.push(tokio::spawn(async move {
                    close_poll(State(state), Path(race.id), Authed(account("alice", false)))
                        .await
                        .map(|_| ())
                }));
            }
        }
        let mut ok = 0;
        for t in tasks {
            match t.await.expect("join") {
                Ok(()) => ok += 1,
                Err(ApiError(StatusCode::BAD_REQUEST, msg)) => {
                    assert_eq!(msg, "This poll is closed")
                }
                Err(ApiError(code, msg)) => panic!("{code} {msg}"),
            }
        }
        let stored = int(
            db,
            &format!(
                "SELECT COUNT(*) FROM poll_votes WHERE message_id = {}",
                race.id
            ),
        )
        .await;
        assert_eq!(
            stored + 1,
            ok,
            "every accepted vote is stored (plus the close), no refused one is"
        );
        let p = seen(&state, None, race.id).await.expect("guest");
        assert!(p.closed);
        assert_eq!(counts(&p).map(|c| c.iter().sum::<i64>()), Some(stored));
        done(state, path).await;
    }

    #[tokio::test]
    async fn forwards_carry_a_frozen_snapshot() {
        let (state, path, cid) = world("polls_forward").await;
        let db = &state.db;
        let m = post_poll(&state, "alice", cid, lunch())
            .await
            .expect("post");
        let o = ids(m.poll.as_ref().expect("poll"));
        cast(&state, "bob", m.id, ballot(&[o[0]]))
            .await
            .expect("vote");
        let fwd: SendReq =
            serde_json::from_value(json!({"content": "", "forward_of": m.id})).expect("fwd");
        let copy = crate::api::messages::send_channel_message(
            State(state.clone()),
            Path(cid),
            Authed(account("carol", false)),
            Json(fwd),
        )
        .await
        .expect("forward")
        .0;
        assert_eq!(copy.kind, "user");
        let snap = copy.poll.clone().expect("snapshot");
        assert_eq!(
            (snap.snapshot, counts(&snap), snap.mine),
            (true, Some(vec![1, 0, 0]), None)
        );
        cast(&state, "carol", m.id, ballot(&[o[1]]))
            .await
            .expect("vote");
        let reread =
            crate::api::messages::load_message(db, copy.id, crate::api::messages::Quotes::Skip)
                .await
                .expect("load")
                .expect("copy");
        assert_eq!(
            reread.poll.as_ref().and_then(counts),
            Some(vec![1, 0, 0]),
            "the copy never changes"
        );
        assert_eq!(
            code(cast(&state, "bob", copy.id, ballot(&[o[0]])).await).map(|(c, _)| c),
            Some(StatusCode::NOT_FOUND),
            "no voting from a forward"
        );
        let fwd2: SendReq =
            serde_json::from_value(json!({"content": "", "forward_of": copy.id})).expect("fwd");
        let again = crate::api::messages::send_channel_message(
            State(state.clone()),
            Path(cid),
            Authed(account("bob", false)),
            Json(fwd2),
        )
        .await
        .expect("forward again")
        .0;
        assert_eq!(
            again.poll.map(|p| p.snapshot),
            Some(true),
            "forwarding the copy keeps the snapshot"
        );
        let hidden = post_poll(
            &state,
            "alice",
            cid,
            json!({"question": "Hidden", "kind": "yes_no", "show_results": "after_vote"}),
        )
        .await
        .expect("post");
        let h = ids(hidden.poll.as_ref().expect("poll"));
        cast(&state, "carol", hidden.id, ballot(&[h[0]]))
            .await
            .expect("vote");
        let fwd3: SendReq =
            serde_json::from_value(json!({"content": "", "forward_of": hidden.id})).expect("fwd");
        let copy = crate::api::messages::send_channel_message(
            State(state.clone()),
            Path(cid),
            Authed(account("carol", false)),
            Json(fwd3),
        )
        .await
        .expect("forward")
        .0;
        assert_eq!(
            copy.poll.map(|p| (p.results.is_none(), p.voters)),
            Some((true, 1)),
            "hidden counts are not copied, even by a voter"
        );
        let _ = crate::api::messages::delete_message(
            State(state.clone()),
            Path(m.id),
            Authed(account("alice", false)),
        )
        .await
        .expect("delete");
        assert!(
            crate::api::messages::load_message(db, again.id, crate::api::messages::Quotes::Skip)
                .await
                .expect("load")
                .and_then(|m| m.poll)
                .is_some(),
            "copies outlive the original"
        );
        done(state, path).await;
    }

    async fn forward(
        state: &AppState,
        who: &str,
        to: Target,
        source: i64,
    ) -> Result<Message, ApiError> {
        let fwd: SendReq =
            serde_json::from_value(json!({"content": "", "forward_of": source})).expect("fwd");
        match to {
            Target::Channel(cid) => {
                crate::api::messages::send_channel_message(
                    State(state.clone()),
                    Path(cid),
                    Authed(account(who, false)),
                    Json(fwd),
                )
                .await
            }
            Target::Dm(dm) => {
                crate::api::messages::send_dm_message(
                    State(state.clone()),
                    Path(dm),
                    Authed(account(who, false)),
                    Json(fwd),
                )
                .await
            }
        }
        .map(|Json(m)| m)
    }

    #[derive(Clone, Copy)]
    enum Target {
        Channel(i64),
        Dm(i64),
    }

    async fn add_text(state: &AppState, who: &str, id: i64, text: &str) -> Result<Poll, ApiError> {
        add_option(
            State(state.clone()),
            Path(id),
            Authed(account(who, false)),
            Json(AddOptionReq {
                text: text.to_string(),
                emoji: None,
            }),
        )
        .await
        .map(|Json(p)| p)
    }

    #[tokio::test]
    async fn forwards_and_added_options_go_through_the_profanity_filter() {
        let (state, path, cid) = world("polls_profane").await;
        let db = &state.db;
        exec(
            db,
            "UPDATE settings SET value = '1' WHERE key = 'profanity_filter'",
        )
        .await;
        crate::api::Settings::forget(db);
        let dm = int(
            db,
            "INSERT INTO dms(user_a, user_b) VALUES('alice', 'bob') RETURNING id",
        )
        .await;
        let other = int(
            db,
            "INSERT INTO dms(user_a, user_b) VALUES('alice', 'carol') RETURNING id",
        )
        .await;
        let m = post_dm_poll(&state, "alice", dm, json!({"question": "Clean?", "kind": "single", "allow_add": true, "options": [{"text": "shit"}, {"text": "fine"}]}))
            .await
            .expect("DM polls are not filtered");
        assert_eq!(
            code(forward(&state, "alice", Target::Channel(cid), m.id).await).map(|(c, _)| c),
            Some(StatusCode::BAD_REQUEST),
            "a blocked option never reaches a channel through a forward"
        );
        let copy = forward(&state, "alice", Target::Dm(other), m.id)
            .await
            .expect("forwarding to a DM still works");
        assert_eq!(
            code(forward(&state, "carol", Target::Channel(cid), copy.id).await).map(|(c, _)| c),
            Some(StatusCode::BAD_REQUEST),
            "nor through a forward of the forward"
        );
        let added = post_dm_poll(&state, "alice", dm, json!({"question": "Clean too?", "kind": "single", "allow_add": true, "options": [{"text": "a"}, {"text": "b"}]}))
            .await
            .expect("post");
        add_text(&state, "bob", added.id, "fuck this")
            .await
            .expect("DM options are not filtered");
        assert_eq!(
            code(forward(&state, "alice", Target::Channel(cid), added.id).await).map(|(c, _)| c),
            Some(StatusCode::BAD_REQUEST),
            "added options are checked on forward too"
        );
        let clean = post_dm_poll(
            &state,
            "alice",
            dm,
            json!({"question": "Lunch?", "kind": "yes_no"}),
        )
        .await
        .expect("post");
        forward(&state, "alice", Target::Channel(cid), clean.id)
            .await
            .expect("a clean poll forwards");
        let open = post_poll(&state, "alice", cid, json!({"question": "Ideas?", "kind": "single", "allow_add": true, "options": [{"text": "a"}, {"text": "b"}]}))
            .await
            .expect("post");
        assert_eq!(
            code(add_text(&state, "bob", open.id, "shit").await).map(|(c, _)| c),
            Some(StatusCode::BAD_REQUEST),
            "options added in channels are filtered"
        );
        done(state, path).await;
    }

    #[tokio::test]
    async fn the_author_needs_view_and_send_rights_to_close() {
        let (state, path, cid) = world("polls_close_gate").await;
        let db = &state.db;
        let m = post_poll(&state, "alice", cid, lunch())
            .await
            .expect("post");
        let close = |who: &'static str| {
            let state = state.clone();
            async move {
                close_poll(State(state), Path(m.id), Authed(account(who, false)))
                    .await
                    .map(|Json(p)| p)
            }
        };
        exec(db, &format!("INSERT INTO channel_perms(channel_id, subject, can_view, can_send, can_read_history) VALUES({cid}, 'u:alice', 1, 0, 1)")).await;
        assert_eq!(
            code(close("alice").await),
            Some((
                StatusCode::FORBIDDEN,
                "Only the author or a moderator can do this".to_string()
            )),
            "an author who lost send rights can't close"
        );
        assert_eq!(
            code(
                reopen_poll(
                    State(state.clone()),
                    Path(m.id),
                    Authed(account("alice", false))
                )
                .await
                .map(|Json(p)| p)
            )
            .map(|(c, _)| c),
            Some(StatusCode::FORBIDDEN)
        );
        exec(
            db,
            "UPDATE members SET is_admin = 1, perms = 2 WHERE username = 'dave'",
        )
        .await;
        assert!(
            close("dave")
                .await
                .expect("a moderator still closes")
                .closed
        );
        exec(db, &format!("UPDATE channel_perms SET can_send = 1 WHERE channel_id = {cid} AND subject = 'u:alice'")).await;
        assert!(
            !reopen_poll(
                State(state.clone()),
                Path(m.id),
                Authed(account("alice", false))
            )
            .await
            .expect("with rights back")
            .0
            .closed
        );
        done(state, path).await;
    }

    #[tokio::test]
    async fn purged_accounts_take_their_votes_with_them() {
        let (state, path, cid) = world("polls_purge").await;
        let db = &state.db;
        let anon = post_poll(&state, "alice", cid, json!({"question": "Anon", "kind": "single", "anonymous": true, "options": [{"text": "a"}, {"text": "b"}]}))
            .await
            .expect("post");
        let public = post_poll(&state, "alice", cid, lunch())
            .await
            .expect("post");
        let a = ids(anon.poll.as_ref().expect("poll"));
        let p = ids(public.poll.as_ref().expect("poll"));
        cast(&state, "bob", anon.id, ballot(&[a[1]]))
            .await
            .expect("vote");
        cast(&state, "carol", anon.id, ballot(&[a[0]]))
            .await
            .expect("vote");
        cast(&state, "bob", public.id, ballot(&[p[2]]))
            .await
            .expect("vote");
        assert_eq!(
            counts(&seen(&state, Some("alice"), anon.id).await.expect("seen")),
            Some(vec![1, 1])
        );
        crate::api::admin::hide_user_rows(&state, "bob", crate::api::admin::PurgeKind::User)
            .await
            .expect("hide")
            .expect("hidden");
        crate::api::admin::finish_purge(&state, crate::api::admin::PurgeKind::User, "bob")
            .await
            .expect("purge");
        assert_eq!(
            int(db, "SELECT COUNT(*) FROM users WHERE username = 'bob'").await,
            0
        );
        let after = seen(&state, Some("alice"), anon.id).await.expect("seen");
        assert_eq!(
            (counts(&after), after.voters),
            (Some(vec![1, 0]), 1),
            "anonymous votes of a purged account are removed"
        );
        let after = seen(&state, Some("alice"), public.id).await.expect("seen");
        assert_eq!((counts(&after), after.voters), (Some(vec![0, 0, 0]), 0));
        sqlx::query("INSERT INTO users(username, display_name, password_hash, password_kind, avatar_kind, created_at) VALUES('bob', 'New Bob', '', 'text', 'identicon', 2)")
            .execute(db)
            .await
            .expect("re-register");
        add_member(db, "rchat", "bob", 0, 0, 1).await;
        let newcomer = User {
            created_at: 2,
            ..mem_user("bob", false)
        };
        let view = view_for(db, anon.id, Some(&newcomer)).await.expect("view");
        assert_eq!(
            view.mine, None,
            "a new account with the same name has no vote"
        );
        let _ = vote(
            State(state.clone()),
            Path(anon.id),
            Authed(newcomer.clone()),
            Json(ballot(&[a[0]])),
        )
        .await
        .expect("and votes as anyone new");
        let view = view_for(db, anon.id, Some(&account("carol", false)))
            .await
            .expect("view");
        assert_eq!((counts(&view), view.voters), (Some(vec![2, 0]), 2));
        assert_ne!(
            anonymous_key(b"pepper", anon.id, "bob", 1),
            anonymous_key(b"pepper", anon.id, "bob", 2),
            "the key belongs to the account, not the name"
        );
        done(state, path).await;
    }

    #[tokio::test]
    async fn tallies_are_counted_once_per_change() {
        let (state, path, cid) = world("polls_tally_cache").await;
        let db = &state.db;
        let m = post_poll(&state, "alice", cid, json!({"question": "Best?", "kind": "ranked", "show_results": "after_vote", "options": [{"text": "a"}, {"text": "b"}, {"text": "c"}]}))
            .await
            .expect("post");
        let o = ids(m.poll.as_ref().expect("poll"));
        let voters: Vec<String> = (0..40).map(|i| format!("v{i}")).collect();
        for v in &voters {
            add_user(db, v).await;
            add_member(db, "rchat", v, 0, 0, 1).await;
            cast(&state, v, m.id, ballot(&[o[1], o[0]]))
                .await
                .expect("vote");
        }
        let before = tally_runs(db, m.id);
        let mut reads = Vec::new();
        for v in voters.iter().cycle().take(400) {
            let state = state.clone();
            let v = v.clone();
            reads.push(tokio::spawn(
                async move { seen(&state, Some(&v), m.id).await },
            ));
        }
        for _ in 0..50 {
            let state = state.clone();
            reads.push(tokio::spawn(async move {
                seen(&state, Some("carol"), m.id).await
            }));
        }
        for read in reads {
            let p = read.await.expect("join").expect("read");
            assert_eq!(p.voters, 40);
        }
        for _ in 0..20 {
            update_event(db, m.id).await.expect("event").expect("poll");
        }
        let runs = tally_runs(db, m.id) - before;
        assert!(
            runs <= 4,
            "450 reads and 20 events of an unchanged poll counted it {runs} times"
        );
        cast(&state, "carol", m.id, ballot(&[o[2]]))
            .await
            .expect("vote");
        let before = tally_runs(db, m.id);
        for v in voters.iter().take(50) {
            let p = seen(&state, Some(v), m.id).await.expect("read");
            assert_eq!(
                p.results
                    .expect("a voter sees counts")
                    .counts
                    .iter()
                    .map(|c| c.count)
                    .sum::<i64>(),
                41
            );
        }
        assert_eq!(
            tally_runs(db, m.id) - before,
            0,
            "the vote's own response already counted it"
        );
        done(state, path).await;
    }

    #[tokio::test]
    async fn voter_results_recount_when_another_node_changed_the_poll() {
        let (state, path, cid) = world("polls_voter_results_stale").await;
        let db = &state.db;
        let m = post_poll(
            &state,
            "alice",
            cid,
            json!({"question": "Q?", "kind": "yes_no", "show_results": "after_vote"}),
        )
        .await
        .expect("post");
        let o = ids(m.poll.as_ref().expect("poll"));
        cast(&state, "bob", m.id, ballot(&[o[0]]))
            .await
            .expect("vote");
        update_event(db, m.id).await.expect("event").expect("poll");
        let key = (pool_key(db), m.id);
        let stale = TALLIES
            .lock()
            .expect("lock")
            .get(&key)
            .cloned()
            .expect("cached");
        // Another node takes carol's vote: the DB moves to N+1, this node's cache stays at N.
        cast(&state, "carol", m.id, ballot(&[o[1]]))
            .await
            .expect("vote");
        TALLIES.lock().expect("lock").insert(key, stale);
        let results = voter_results(db, m.id, false, "carol", 1)
            .await
            .expect("carol voted on the other node");
        assert_eq!(results.counts.iter().map(|c| c.count).sum::<i64>(), 2);
        done(state, path).await;
    }

    #[tokio::test]
    async fn voters_of_after_vote_polls_get_counts_without_asking() {
        let (state, path, cid) = world("polls_voter_results").await;
        let db = &state.db;
        for anonymous in [false, true] {
            let m = post_poll(&state, "alice", cid, json!({"question": "Secret?", "kind": "yes_no", "show_results": "after_vote", "anonymous": anonymous}))
                .await
                .expect("post");
            let o = ids(m.poll.as_ref().expect("poll"));
            cast(&state, "bob", m.id, ballot(&[o[0]]))
                .await
                .expect("vote");
            let Some(WsEvent::PollUpdated { poll, .. }) =
                update_event(db, m.id).await.expect("event")
            else {
                panic!("no event");
            };
            assert!(poll.results.is_none(), "the shared event hides counts");
            assert_eq!(
                voter_results(db, m.id, anonymous, "bob", 1)
                    .await
                    .map(|r| r.counts[0].count),
                Some(1),
                "the voter gets them"
            );
            assert!(
                voter_results(db, m.id, anonymous, "carol", 1)
                    .await
                    .is_none()
            );
            assert!(
                voter_results(db, m.id, anonymous, "bob", 2).await.is_none() || !anonymous,
                "another account named bob does not"
            );
        }
        done(state, path).await;
    }

    #[test]
    fn anonymous_updates_wait_for_the_next_step() {
        let s = Duration::from_millis;
        assert_eq!(step_delay(s(10_000)), s(5_000));
        assert_eq!(step_delay(s(12_300)), s(2_700));
        assert_eq!(step_delay(s(14_999)), s(1));
    }

    #[tokio::test]
    async fn added_options_stay_pickable_when_every_option_was() {
        let (state, path, cid) = world("polls_max_choices").await;
        let m = post_poll(&state, "alice", cid, json!({"question": "Toppings?", "kind": "multiple", "options": [{"text": "a"}, {"text": "b"}]}))
            .await
            .expect("post");
        let p = add_text(&state, "alice", m.id, "c").await.expect("add");
        assert_eq!(p.max_choices, 3);
        cast(&state, "bob", m.id, ballot(&ids(&p)))
            .await
            .expect("all three");
        let capped = post_poll(&state, "alice", cid, json!({"question": "Two?", "kind": "multiple", "max_choices": 1, "options": [{"text": "a"}, {"text": "b"}]}))
            .await
            .expect("post");
        assert_eq!(
            add_text(&state, "alice", capped.id, "c")
                .await
                .expect("add")
                .max_choices,
            1
        );
        done(state, path).await;
    }
}
