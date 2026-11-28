//! Data key rotation: the next generation of a purpose's data key becomes active, and its
//! records are sealed again under it, a pass at a time over every sealed column. Every process
//! drops a held key that is active no more within one sweep (`Ring::note_keys`), so the old keys
//! retire only after a pass that began once that time had passed and found nothing left to seal
//! again. A retired key is destroyed a day later, and only when no record names it; one that a
//! record still names retires again and the rotation runs on.

use std::sync::Mutex;
use std::sync::atomic::{AtomicI64, Ordering};
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::api::ApiError;
use crate::crypt::body::{OPTIONS, Opener, POLLS, Parts, SNAPSHOTS, Scope, Writer};
use crate::crypt::copies::{self, BACKUPS, BIOS, Column, DELIVERIES, REPORT_EVENTS, REPORTS};
use crate::crypt::{Purpose, header};
use crate::db::{Db, is_sqlite, now, pool_key};
use crate::state::AppState;

/// The `settings` key holding the rotation that runs.
const STATE: &str = "key_rotation";
/// Rows one step reads.
const BATCH: i64 = 500;
/// Seconds a retired data key is kept before it is destroyed.
pub const DESTROY_AFTER: i64 = 86_400;
const PAUSE: Duration = Duration::from_millis(100);
/// Seconds after a rotation starts before a pass can be its last: two sweeps, so every process
/// dropped the key it replaces.
pub static SETTLE: AtomicI64 = AtomicI64::new(600);

fn settle() -> i64 {
    SETTLE.load(Ordering::Relaxed)
}

/// What a rotation seals again, in order, and the purpose whose key each step replaces.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Step {
    Messages,
    Polls,
    Options,
    Snapshots,
    Reports,
    ReportLines,
    Deliveries,
    Bios,
    Backups,
    Files,
    Settings,
    Hooks,
    Grams,
}

const STEPS: [Step; 13] = [
    Step::Messages,
    Step::Polls,
    Step::Options,
    Step::Snapshots,
    Step::Reports,
    Step::ReportLines,
    Step::Deliveries,
    Step::Bios,
    Step::Backups,
    Step::Files,
    Step::Settings,
    Step::Hooks,
    Step::Grams,
];

impl Step {
    fn purpose(self) -> Purpose {
        match self {
            Step::Messages
            | Step::Polls
            | Step::Options
            | Step::Snapshots
            | Step::Reports
            | Step::ReportLines
            | Step::Deliveries
            | Step::Bios
            | Step::Backups => Purpose::Content,
            Step::Files => Purpose::Media,
            Step::Settings | Step::Hooks => Purpose::Secrets,
            Step::Grams => Purpose::Search,
        }
    }
}

/// The rotation that runs, as kept in `settings`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Rotation {
    /// The purposes whose keys it replaces.
    pub purposes: Vec<String>,
    /// The index of the step it is at, of every step of those purposes.
    pub step: usize,
    /// Where that step goes on: the last row it finished.
    pub at: String,
    pub started_at: i64,
    /// When this pass began.
    #[serde(default)]
    pub pass_at: i64,
    /// Records this pass sealed again, or found changed meanwhile: another pass follows.
    #[serde(default)]
    pub moved: u64,
    /// Records this pass could not seal again for now; with any, the old keys stay.
    pub left: u64,
    /// Records under the old keys that do not open with them: they stay unreadable.
    #[serde(default)]
    pub lost: u64,
    /// Whether it stopped with records left, to be run again from the admin page or the CLI.
    pub ended: bool,
}

impl Rotation {
    fn purposes(&self) -> Vec<Purpose> {
        self.purposes
            .iter()
            .filter_map(|p| Purpose::parse(p))
            .collect()
    }

    fn steps(&self) -> Vec<Step> {
        let purposes = self.purposes();
        STEPS
            .iter()
            .copied()
            .filter(|s| purposes.contains(&s.purpose()))
            .collect()
    }
}

/// The rotation kept in `settings` and its stored form, for a compare-and-swap.
async fn load(db: &Db) -> Result<Option<(Rotation, String)>, ApiError> {
    let stored: Option<String> = sqlx::query_scalar("SELECT value FROM settings WHERE key = $1")
        .bind(STATE)
        .fetch_optional(db)
        .await?;
    Ok(stored.and_then(|v| serde_json::from_str(&v).ok().map(|r| (r, v))))
}

/// The rotation that runs or last left records behind.
pub async fn current(db: &Db) -> Result<Option<Rotation>, ApiError> {
    Ok(load(db).await?.map(|(r, _)| r))
}

/// A rotation as the admin page shows it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct RotationView {
    pub purposes: Vec<String>,
    /// The steps this pass finished, of `steps`.
    pub done: usize,
    pub steps: usize,
    pub left: u64,
    pub ended: bool,
    /// The pass ended and the last one waits until every process can have dropped the old keys.
    pub waiting: bool,
}

impl Rotation {
    pub fn view(&self) -> RotationView {
        let steps = self.steps().len();
        RotationView {
            purposes: self.purposes.clone(),
            done: self.step.min(steps),
            steps,
            left: self.left,
            ended: self.ended,
            waiting: !self.ended && self.step >= steps,
        }
    }
}

/// Writes `next` in place of `was`; false when another copy moved it first.
async fn save(db: &Db, was: &str, next: &Rotation) -> Result<bool, ApiError> {
    let value = serde_json::to_string(next).map_err(ApiError::internal)?;
    Ok(
        sqlx::query("UPDATE settings SET value = $1 WHERE key = $2 AND value = $3")
            .bind(value)
            .bind(STATE)
            .bind(was)
            .execute(db)
            .await?
            .rows_affected()
            == 1,
    )
}

/// Rotates the data keys of `purposes` and runs the job in the background.
pub async fn start(state: &AppState, purposes: &[Purpose]) -> Result<Rotation, ApiError> {
    let rotation = begin(state, purposes).await?;
    spawn(state);
    Ok(rotation)
}

/// Rotates the data keys of `purposes` and starts the job's pass, or, for purposes a rotation
/// already replaces, starts it again. A purpose with no data key yet is left out.
pub async fn begin(state: &AppState, purposes: &[Purpose]) -> Result<Rotation, ApiError> {
    let db = &state.db;
    let ring = crate::db::ring(db);
    ring.note_keys(db).await?;
    let mut wanted: Vec<Purpose> = Vec::new();
    for purpose in purposes {
        if wanted.contains(purpose) {
            continue;
        }
        let rotated = match ring.rotating(*purpose) {
            true => true,
            false => {
                ring.stored_data_key(db, *purpose)
                    .await
                    .map_err(ApiError::internal)?
                    .is_some()
                    && ring
                        .rotate(db, *purpose)
                        .await
                        .map_err(ApiError::internal)?
                        .is_some()
            }
        };
        if rotated {
            wanted.push(*purpose);
        }
    }
    plan(db, &wanted).await
}

/// Starts a pass over `purposes` and those of the rotation kept, from the beginning.
async fn plan(db: &Db, purposes: &[Purpose]) -> Result<Rotation, ApiError> {
    let mut names: Vec<String> = load(db).await?.map(|(r, _)| r.purposes).unwrap_or_default();
    for purpose in purposes {
        if !names.iter().any(|n| n == purpose.name()) {
            names.push(purpose.name().to_owned());
        }
    }
    let at = now();
    let next = Rotation {
        purposes: names,
        started_at: at,
        pass_at: at,
        ..Rotation::default()
    };
    let value = serde_json::to_string(&next).map_err(ApiError::internal)?;
    sqlx::query("INSERT INTO settings(key, value) VALUES($1, $2) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .bind(STATE)
        .bind(&value)
        .execute(db)
        .await?;
    Ok(next)
}

static RUNNING: Mutex<Option<std::collections::HashSet<String>>> = Mutex::new(None);

/// Runs the rotation in the background unless this process already runs it.
pub fn spawn(state: &AppState) {
    let state = state.clone();
    tokio::spawn(async move {
        if let Err(ApiError(_, e, _)) = run(&state).await {
            tracing::warn!("the key rotation stopped: {e}");
        }
    });
}

/// Runs the rotation as far as it goes now: to its end, or until its last pass has to wait.
/// Answers whether this process ran it.
pub async fn run(state: &AppState) -> Result<bool, ApiError> {
    let key = pool_key(&state.db);
    {
        let mut running = RUNNING.lock().unwrap_or_else(|p| p.into_inner());
        if !running
            .get_or_insert_with(Default::default)
            .insert(key.clone())
        {
            return Ok(false);
        }
    }
    let out = steps(state).await;
    if let Some(running) = RUNNING.lock().unwrap_or_else(|p| p.into_inner()).as_mut() {
        running.remove(&key);
    }
    out.map(|()| true)
}

async fn steps(state: &AppState) -> Result<(), ApiError> {
    let db = &state.db;
    let ring = crate::db::ring(db);
    loop {
        let Some((rotation, was)) = load(db).await? else {
            return Ok(());
        };
        if rotation.ended {
            return Ok(());
        }
        let steps = rotation.steps();
        let Some(step) = steps.get(rotation.step).copied() else {
            match finish(state, rotation, &was).await? {
                true => continue,
                false => return Ok(()),
            }
        };
        ring.note_keys(db).await?;
        let retiring = ring.retiring_ids(db, step.purpose()).await?;
        let tally = match retiring.is_empty() {
            true => Tally::default(),
            false => one(state, step, &retiring, &rotation.at).await?,
        };
        let next = Rotation {
            step: rotation.step + usize::from(tally.next.is_none()),
            at: tally.next.unwrap_or_default(),
            moved: rotation.moved + tally.moved,
            left: rotation.left + tally.left,
            lost: rotation.lost + tally.lost,
            ..rotation
        };
        if !save(db, &was, &next).await? {
            return Ok(());
        }
        tokio::time::sleep(PAUSE).await;
    }
}

/// A pass ended. With records left it stops, to be shown and run again. A pass that sealed
/// records again, or began before every process could have dropped the old keys, is followed by
/// another (once that time passed); a pass that found nothing retires the old keys. Answers
/// whether another pass started.
async fn finish(state: &AppState, rotation: Rotation, was: &str) -> Result<bool, ApiError> {
    let db = &state.db;
    if rotation.left > 0 {
        let ended = Rotation {
            ended: true,
            ..rotation
        };
        save(db, was, &ended).await?;
        return Ok(false);
    }
    let settled_at = rotation.started_at + settle();
    if rotation.moved > 0 || rotation.pass_at < settled_at {
        if state.clock.unix() < settled_at {
            return Ok(false);
        }
        let again = Rotation {
            step: 0,
            at: String::new(),
            pass_at: state.clock.unix(),
            moved: 0,
            left: 0,
            lost: 0,
            ..rotation
        };
        return save(db, was, &again).await;
    }
    let mut tx = db.begin().await?;
    let claimed = sqlx::query("DELETE FROM settings WHERE key = $1 AND value = $2")
        .bind(STATE)
        .bind(was)
        .execute(&mut *tx)
        .await?
        .rows_affected();
    if claimed != 1 {
        return Ok(false);
    }
    for purpose in rotation.purposes() {
        sqlx::query(
            "UPDATE data_keys SET state = 'retired', retired_at = $1 WHERE purpose = $2 AND state = 'retiring'",
        )
        .bind(state.clock.unix())
        .bind(purpose.name())
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    crate::db::ring(db).note_keys(db).await?;
    if rotation.lost > 0 {
        tracing::warn!(
            "{} records under the replaced keys could not be opened with them and stay unreadable",
            rotation.lost
        );
    }
    tracing::info!("the key rotation of {} ended", rotation.purposes.join(", "));
    Ok(false)
}

/// The keeping the seal-sweep loop does: data keys moved under the first root key once every
/// copy holds it, retired keys destroyed after a day when nothing names them, a retiring key
/// with no rotation given one, and a rotation run on.
pub async fn keep_up(state: &AppState) -> Result<(), ApiError> {
    let db = &state.db;
    let ring = crate::db::ring(db);
    match everyone_holds(state).await {
        Ok(true) => {
            if let Err(e) = ring.rewrap(db, true).await {
                tracing::warn!("moving data keys under the first root key failed: {e}");
            }
        }
        Ok(false) => {}
        Err(ApiError(_, e, _)) => tracing::warn!("asking which keys the copies hold failed: {e}"),
    }
    if let Err(ApiError(_, e, _)) = destroy_due(state, state.clock.unix() - DESTROY_AFTER).await {
        tracing::warn!("destroying retired data keys failed: {e}");
    }
    let retiring: Vec<String> =
        sqlx::query_scalar("SELECT DISTINCT purpose FROM data_keys WHERE state = 'retiring'")
            .fetch_all(db)
            .await?;
    let kept = load(db).await?;
    if kept.is_none() && !retiring.is_empty() {
        let purposes: Vec<Purpose> = retiring.iter().filter_map(|p| Purpose::parse(p)).collect();
        plan(db, &purposes).await?;
    }
    if let Some((rotation, _)) = load(db).await?
        && !rotation.ended
    {
        spawn(state);
    }
    Ok(())
}

/// Destroys the data keys retired at `before` or earlier that no record names; one a record
/// still names retires again and its purpose is rotated on.
pub(crate) async fn destroy_due(state: &AppState, before: i64) -> Result<(), ApiError> {
    let db = &state.db;
    let ring = crate::db::ring(db);
    for (id, purpose) in ring.retired_by(db, before).await? {
        let named = names(db, id, purpose).await?;
        if named == 0 {
            ring.destroy(db, id).await?;
            continue;
        }
        tracing::warn!("{named} records still name the retired data key {id}; it is sealed again");
        ring.unretire(db, id, purpose).await?;
        plan(db, &[purpose]).await?;
    }
    Ok(())
}

/// The records that name the data key `id` of `purpose`. Search grams and the bus keep no record
/// a key opens.
pub async fn names(db: &Db, id: u32, purpose: Purpose) -> Result<i64, ApiError> {
    let columns: &[(&str, &str)] = match purpose {
        Purpose::Content => &[
            ("messages", "body"),
            ("polls", "body"),
            ("poll_options", "body"),
            ("poll_snapshots", "body"),
            ("reports", "sealed"),
            ("report_events", "detail_sealed"),
            ("webhook_deliveries", "payload_sealed"),
            ("users", "bio_sealed"),
            ("p2p_backups", "data_sealed"),
        ],
        Purpose::Secrets => &[("outgoing_webhooks", "secret_sealed")],
        Purpose::Media => {
            let files: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM media WHERE seal_key = $1")
                .bind(i64::from(id))
                .fetch_one(db)
                .await?;
            return Ok(files);
        }
        Purpose::Search | Purpose::Bus => return Ok(0),
    };
    let bytes = id.to_be_bytes().to_vec();
    let mut named = 0;
    for (table, column) in columns {
        let slice = match is_sqlite(db) {
            true => format!("substr({column}, 3, 4)"),
            false => format!("substring({column} from 3 for 4)"),
        };
        let sql =
            format!("SELECT COUNT(*) FROM {table} WHERE {column} IS NOT NULL AND {slice} = $1");
        named += sqlx::query_scalar::<_, i64>(sqlx::AssertSqlSafe(sql))
            .bind(&bytes)
            .fetch_one(db)
            .await?;
    }
    if purpose == Purpose::Secrets {
        named += crate::crypt::secrets::settings_under(db, id)
            .await
            .map_err(ApiError::internal)?;
    }
    Ok(named)
}

/// Whether every live copy holds the first root key, so data keys may move under it. Copies that
/// do not announce themselves (Postgres without Redis) can't say: there `server keys rewrap`
/// moves them once every copy has it.
pub async fn everyone_holds(state: &AppState) -> Result<bool, ApiError> {
    let Some(first) = crate::db::ring(&state.db).first_kek() else {
        return Ok(false);
    };
    if super::copies(state).await?.is_some() {
        return Ok(false);
    }
    Ok(state
        .hub
        .other_copies()
        .iter()
        .all(|note| note.as_ref().is_some_and(|n| n.keks.contains(&first))))
}

/// Whether `record` names one of `keys`.
fn under(record: &[u8], keys: &[u32]) -> bool {
    header(record).is_ok_and(|h| keys.contains(&h.key_id))
}

async fn write_tx(db: &Db) -> sqlx::Result<sqlx::Transaction<'static, sqlx::Any>> {
    match is_sqlite(db) {
        true => db.begin_with("BEGIN IMMEDIATE").await,
        false => db.begin().await,
    }
}

/// What one batch of a step did: where the step goes on (`None` once it ended), the records it
/// sealed again or found changed meanwhile, those it could not seal again for now, and those
/// that do not open with their key.
#[derive(Debug, Default)]
pub(crate) struct Tally {
    pub next: Option<String>,
    pub moved: u64,
    pub left: u64,
    pub lost: u64,
}

impl Tally {
    pub(crate) fn add(&mut self, outcome: Outcome) {
        match outcome {
            Outcome::Moved => self.moved += 1,
            Outcome::Left => self.left += 1,
            Outcome::Lost => self.lost += 1,
        }
    }
}

/// What became of one record under a retiring key.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Outcome {
    /// Sealed again under the active key, or changed meanwhile by someone else.
    Moved,
    /// Not sealed again for now.
    Left,
    /// It does not open with its key.
    Lost,
}

/// One batch of `step` after `at`, over the records under `retiring`.
async fn one(state: &AppState, step: Step, retiring: &[u32], at: &str) -> Result<Tally, ApiError> {
    let db = &state.db;
    match step {
        Step::Messages => messages(db, retiring, at).await,
        Step::Polls => texts(db, retiring, at, POLLS, "polls", "message_id", "message_id").await,
        Step::Options => {
            texts(
                db,
                retiring,
                at,
                OPTIONS,
                "poll_options",
                "id",
                "message_id",
            )
            .await
        }
        Step::Snapshots => {
            texts(
                db,
                retiring,
                at,
                SNAPSHOTS,
                "poll_snapshots",
                "message_id",
                "message_id",
            )
            .await
        }
        Step::Reports => numbered_copies(db, retiring, at, REPORTS, "id").await,
        Step::ReportLines => numbered_copies(db, retiring, at, REPORT_EVENTS, "id").await,
        Step::Deliveries => numbered_copies(db, retiring, at, DELIVERIES, "id").await,
        Step::Bios => bios(db, retiring, at).await,
        Step::Backups => backups(db, retiring, at).await,
        Step::Files => files(state, retiring, at).await,
        Step::Settings => crate::crypt::secrets::reseal_settings(db, retiring)
            .await
            .map_err(ApiError::internal),
        Step::Hooks => crate::crypt::secrets::reseal_hooks(db, retiring, at)
            .await
            .map_err(ApiError::internal),
        Step::Grams => grams(db, at).await,
    }
}

fn after(at: &str) -> i64 {
    at.parse().unwrap_or(0)
}

fn next_of<T>(rows: &[T], last: impl Fn(&T) -> String) -> Option<String> {
    match rows.last() {
        Some(row) if rows.len() as i64 == BATCH => Some(last(row)),
        _ => None,
    }
}

/// `id, channel, dm, author, body` of a message.
type MessageRow = (i64, Option<i64>, Option<i64>, String, Vec<u8>);
/// `key, channel, dm, body` of a poll text.
type TextRow = (i64, Option<i64>, Option<i64>, Vec<u8>);

/// Writes `fresh` over `record` with `update` (`$1` the new record, `$2` the row, `$3` the old
/// record). A row changed meanwhile is left as it is and counts as moved too: another pass
/// reads it again.
async fn swap(
    tx: &mut sqlx::Transaction<'static, sqlx::Any>,
    update: &str,
    id: i64,
    fresh: Vec<u8>,
    record: &[u8],
) -> Result<Outcome, ApiError> {
    sqlx::query(sqlx::AssertSqlSafe(update.to_owned()))
        .bind(fresh)
        .bind(id)
        .bind(record)
        .execute(&mut **tx)
        .await?;
    Ok(Outcome::Moved)
}

async fn messages(db: &Db, retiring: &[u32], at: &str) -> Result<Tally, ApiError> {
    let rows: Vec<MessageRow> = sqlx::query_as("SELECT id, channel_id, dm_id, author, body FROM messages WHERE body IS NOT NULL AND id > $1 ORDER BY id LIMIT $2")
        .bind(after(at))
        .bind(BATCH)
        .fetch_all(db)
        .await?;
    let ring = crate::db::ring(db);
    let mut tally = Tally::default();
    for (id, channel, dm, author, record) in &rows {
        if !under(record, retiring) {
            continue;
        }
        let Some(scope) = Scope::of(*channel, *dm) else {
            tally.add(Outcome::Lost);
            continue;
        };
        let opener = Opener::of(db, [record.as_slice()]).await?;
        let opened = opener.message(*id, Some(scope), author, Some(record), Parts::default());
        if opened.unreadable {
            tally.add(Outcome::Lost);
            continue;
        }
        let mut tx = write_tx(db).await?;
        let writer = Writer::of(&ring, &mut tx, scope)
            .await
            .map_err(ApiError::internal)?;
        let outcome = match writer {
            Some(writer) if !retiring.contains(&writer.key_id()) => {
                let fresh = writer.message(*id, author, &opened.parts);
                swap(
                    &mut tx,
                    "UPDATE messages SET body = $1 WHERE id = $2 AND body = $3",
                    *id,
                    fresh,
                    record,
                )
                .await?
            }
            Some(_) | None => Outcome::Left,
        };
        tx.commit().await?;
        tally.add(outcome);
    }
    tally.next = next_of(&rows, |r| r.0.to_string());
    Ok(tally)
}

/// The poll texts of `table`, keyed by its column `key`, whose message is `message`.
async fn texts(
    db: &Db,
    retiring: &[u32],
    at: &str,
    record_table: &'static str,
    table: &str,
    key: &str,
    message: &str,
) -> Result<Tally, ApiError> {
    let sql = format!(
        "SELECT t.{key}, m.channel_id, m.dm_id, t.body FROM {table} t JOIN messages m ON m.id = t.{message} WHERE t.body IS NOT NULL AND t.{key} > $1 ORDER BY t.{key} LIMIT $2"
    );
    let rows: Vec<TextRow> = sqlx::query_as(sqlx::AssertSqlSafe(sql))
        .bind(after(at))
        .bind(BATCH)
        .fetch_all(db)
        .await?;
    let ring = crate::db::ring(db);
    let update = format!("UPDATE {table} SET body = $1 WHERE {key} = $2 AND body = $3");
    let mut tally = Tally::default();
    for (id, channel, dm, record) in &rows {
        if !under(record, retiring) {
            continue;
        }
        let Some(scope) = Scope::of(*channel, *dm) else {
            tally.add(Outcome::Lost);
            continue;
        };
        let opener = Opener::of(db, [record.as_slice()]).await?;
        let Some(text) = opener.opened_text(record_table, *id, Some(scope), record) else {
            tally.add(Outcome::Lost);
            continue;
        };
        let mut tx = write_tx(db).await?;
        let writer = Writer::of(&ring, &mut tx, scope)
            .await
            .map_err(ApiError::internal)?;
        let outcome = match writer {
            Some(writer) if !retiring.contains(&writer.key_id()) => {
                let fresh = writer.text(record_table, *id, &text);
                swap(&mut tx, &update, *id, fresh, record).await?
            }
            Some(_) | None => Outcome::Left,
        };
        tx.commit().await?;
        tally.add(outcome);
    }
    tally.next = next_of(&rows, |r| r.0.to_string());
    Ok(tally)
}

/// Seals `plain` of the copy column `at` again, bound to `binding`, over `record` in the row
/// `keys` name.
async fn reseal_copy(
    db: &Db,
    retiring: &[u32],
    at: Column,
    binding: &str,
    plain: &[u8],
    record: &[u8],
    keys: Vec<(&str, Bind)>,
) -> Result<Outcome, ApiError> {
    let ring = crate::db::ring(db);
    let mut tx = write_tx(db).await?;
    let sealer = copies::Sealer::of(&ring, &mut tx)
        .await
        .map_err(ApiError::internal)?;
    let Some(sealer) = sealer.filter(|s| !retiring.contains(&s.key_id())) else {
        return Ok(Outcome::Left);
    };
    let wheres: Vec<String> = keys
        .iter()
        .enumerate()
        .map(|(i, (column, _))| format!("{column} = ${}", i + 3))
        .collect();
    let sql = format!(
        "UPDATE {} SET {} = $1 WHERE {} = $2 AND {}",
        at.table,
        at.column,
        at.column,
        wheres.join(" AND ")
    );
    let mut query = sqlx::query(sqlx::AssertSqlSafe(sql))
        .bind(sealer.seal(at, binding, plain))
        .bind(record);
    for (_, value) in keys {
        query = match value {
            Bind::Int(v) => query.bind(v),
            Bind::Text(v) => query.bind(v),
        };
    }
    query.execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(Outcome::Moved)
}

enum Bind {
    Int(i64),
    Text(String),
}

/// The copies of `at`, numbered by the column `key`.
async fn numbered_copies(
    db: &Db,
    retiring: &[u32],
    at: &str,
    column: Column,
    key: &str,
) -> Result<Tally, ApiError> {
    let sql = format!(
        "SELECT {key}, {} FROM {} WHERE {} IS NOT NULL AND {key} > $1 ORDER BY {key} LIMIT $2",
        column.column, column.table, column.column
    );
    let rows: Vec<(i64, Vec<u8>)> = sqlx::query_as(sqlx::AssertSqlSafe(sql))
        .bind(after(at))
        .bind(BATCH)
        .fetch_all(db)
        .await?;
    let opener = copies::Opener::of(db, rows.iter().map(|(_, r)| r.as_slice())).await?;
    let mut tally = Tally::default();
    for (id, record) in &rows {
        if !under(record, retiring) {
            continue;
        }
        let binding = id.to_string();
        let outcome = match opener.open(column, &binding, record) {
            Some(plain) => {
                let keys = vec![(key, Bind::Int(*id))];
                reseal_copy(db, retiring, column, &binding, &plain, record, keys).await?
            }
            None => Outcome::Lost,
        };
        tally.add(outcome);
    }
    tally.next = next_of(&rows, |r| r.0.to_string());
    Ok(tally)
}

async fn bios(db: &Db, retiring: &[u32], at: &str) -> Result<Tally, ApiError> {
    let rows: Vec<(String, Vec<u8>)> = sqlx::query_as("SELECT username, bio_sealed FROM users WHERE bio_sealed IS NOT NULL AND username > $1 ORDER BY username LIMIT $2")
        .bind(at)
        .bind(BATCH)
        .fetch_all(db)
        .await?;
    let opener = copies::Opener::of(db, rows.iter().map(|(_, r)| r.as_slice())).await?;
    let mut tally = Tally::default();
    for (username, record) in &rows {
        if !under(record, retiring) {
            continue;
        }
        let outcome = match opener.open(BIOS, username, record) {
            Some(plain) => {
                let keys = vec![("username", Bind::Text(username.clone()))];
                reseal_copy(db, retiring, BIOS, username, &plain, record, keys).await?
            }
            None => Outcome::Lost,
        };
        tally.add(outcome);
    }
    tally.next = next_of(&rows, |r| r.0.clone());
    Ok(tally)
}

/// P2P backup versions read in one go: they are large.
const BACKUPS_BATCH: i64 = 10;

async fn backups(db: &Db, retiring: &[u32], at: &str) -> Result<Tally, ApiError> {
    let (user, ik, version) = match serde_json::from_str::<(String, String, i64)>(at) {
        Ok(cursor) => cursor,
        Err(_) => (String::new(), String::new(), -1),
    };
    let rows: Vec<(String, String, i64, Vec<u8>)> = sqlx::query_as("SELECT username, ik, version, data_sealed FROM p2p_backups WHERE data_sealed IS NOT NULL AND (username > $1 OR (username = $1 AND (ik > $2 OR (ik = $2 AND version > $3)))) ORDER BY username, ik, version LIMIT $4")
        .bind(&user)
        .bind(&ik)
        .bind(version)
        .bind(BACKUPS_BATCH)
        .fetch_all(db)
        .await?;
    let opener = copies::Opener::of(db, rows.iter().map(|(.., r)| r.as_slice())).await?;
    let mut tally = Tally::default();
    for (username, ik, version, record) in &rows {
        if !under(record, retiring) {
            continue;
        }
        let binding = copies::backup_binding(username, ik, *version);
        let outcome = match opener.open(BACKUPS, &binding, record) {
            Some(plain) => {
                let keys = vec![
                    ("username", Bind::Text(username.clone())),
                    ("ik", Bind::Text(ik.clone())),
                    ("version", Bind::Int(*version)),
                ];
                reseal_copy(db, retiring, BACKUPS, &binding, &plain, record, keys).await?
            }
            None => Outcome::Lost,
        };
        tally.add(outcome);
    }
    tally.next = match rows.last() {
        Some((u, k, v, _)) if rows.len() as i64 == BACKUPS_BATCH => {
            Some(serde_json::json!([u, k, v]).to_string())
        }
        _ => None,
    };
    Ok(tally)
}

async fn files(state: &AppState, retiring: &[u32], at: &str) -> Result<Tally, ApiError> {
    let ids: Vec<String> = sqlx::query_scalar(
        "SELECT id FROM media WHERE seal_key IS NOT NULL AND id > $1 ORDER BY id LIMIT $2",
    )
    .bind(at)
    .bind(BATCH)
    .fetch_all(&state.db)
    .await?;
    let mut tally = Tally::default();
    for id in &ids {
        match crate::api::media::sealed::reseal_now(state, id, retiring).await {
            Ok(Some(outcome)) => tally.add(outcome),
            Ok(None) => {}
            Err(ApiError(_, e, _)) => {
                tracing::warn!("the file {id} could not be sealed again: {e}");
                tally.add(Outcome::Left);
            }
        }
    }
    tally.next = next_of(&ids, Clone::clone);
    Ok(tally)
}

/// The search grams of encrypted channel messages, made again under the active search key:
/// on Postgres in `messages.grams`, on SQLite by putting them back on the channel index's
/// catch-all posting to be merged again. While a search key retires, searches read encrypted
/// messages one by one.
async fn grams(db: &Db, at: &str) -> Result<Tally, ApiError> {
    let rows: Vec<(i64, i64, String, Vec<u8>)> = sqlx::query_as("SELECT id, channel_id, author, body FROM messages WHERE body IS NOT NULL AND channel_id IS NOT NULL AND id > $1 ORDER BY id LIMIT $2")
        .bind(after(at))
        .bind(BATCH)
        .fetch_all(db)
        .await?;
    match is_sqlite(db) {
        true => crate::db::requeue_rekeyed(db, &rows).await?,
        false => {
            let ring = crate::db::ring(db);
            let opener = Opener::of(db, rows.iter().map(|r| r.3.as_slice())).await?;
            for (id, channel, author, record) in &rows {
                let scope = Scope::Channel(*channel);
                let opened =
                    opener.message(*id, Some(scope), author, Some(record), Parts::default());
                if opened.unreadable {
                    continue;
                }
                let mut conn = db.acquire().await?;
                let Some(keyer) = crate::crypt::grams::Grams::of_on(&ring, &mut conn, scope)
                    .await
                    .map_err(ApiError::internal)?
                else {
                    continue;
                };
                drop(conn);
                let grams = crate::crypt::grams::array(&keyer.document(&opened.parts.content));
                sqlx::query(sqlx::AssertSqlSafe(format!(
                    "UPDATE messages SET grams = {} WHERE id = $2 AND body = $3",
                    super::grams_value(1)
                )))
                .bind(grams)
                .bind(id)
                .bind(record)
                .execute(db)
                .await?;
            }
        }
    }
    Ok(Tally {
        next: next_of(&rows, |r| r.0.to_string()),
        ..Tally::default()
    })
}

#[cfg(test)]
mod tests;
