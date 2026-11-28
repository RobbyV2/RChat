//! Encrypted storage of servers and DMs: the switches, the site's requirement, the state a
//! write follows, and the sweep for rows a sealed place got stored plain.

use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;
use tokio::time::Instant;

use axum::Json;
use axum::extract::{Path, State};
use serde::{Deserialize, Serialize};
use sqlx::{AnyConnection, Row};
use utoipa::ToSchema;

use super::access::resolve_dm;
use super::admin::require_site_admin;
use super::system_messages::{post_storage, post_storage_dm};
use super::{ApiError, Authed, OkResp, ok};
use crate::crypt::body::{Opened, Parts, Scope, Writer, open_body_on};
use crate::crypt::ring::{Readiness, Ring};
use crate::crypt::{Purpose, copies};
use crate::db::{Db, is_sqlite, now, pool_key};
use crate::hub::CopyNote;
use crate::state::AppState;
use crate::ws::{Hub, WsEvent};

/// The `settings` key of "Require encryption on this site": `on` or `off`.
pub const REQUIRED: &str = "encryption_required";
/// The `settings` key holding the first message id the site's requirement covers. It is there
/// exactly while the requirement is on, from the environment or the admin page.
pub const SITE_FROM: &str = "seal_site_from";
/// The `settings` key holding when the site first required encryption, never removed: from then
/// on every channel may hold encrypted messages.
pub const SITE_SINCE: &str = "seal_site_since";
/// The `settings` key holding the build an admin confirmed every copy runs, for a site whose
/// copies do not announce themselves.
pub const COPIES: &str = "seal_copies_build";

pub const NEEDS_KEY: &str = "This site needs an encryption key first";
pub const UPDATING: &str = "Not available while this site updates";
pub const FORCED: &str = "Required by this site";

pub(crate) const SITE_SQL: &str =
    "COALESCE((SELECT CAST(value AS BIGINT) FROM settings WHERE key = 'seal_site_from'), 0)";

/// Whether a server or DM stores new messages encrypted.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct SealView {
    /// New messages are stored encrypted, by the place's own switch or because the site
    /// requires it.
    pub on: bool,
    /// The site requires it, so the switch can't be turned off.
    pub forced: bool,
    /// The place's own switch, whatever the site requires.
    #[serde(default)]
    pub own: bool,
    /// The site requires it of this server in particular; false for a DM. With
    /// `encryption_required` of the settings, a client keeps `on` and `forced` current when only
    /// the site-wide requirement changes.
    #[serde(default)]
    pub server_forced: bool,
}

/// What seals a place: its own switch, a requirement on its server, and the site's. Each is 0
/// when off, else the first message id it covers.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct Floors {
    pub switch: i64,
    pub forced: i64,
    pub site: i64,
}

impl Floors {
    /// The first message id that is stored sealed here, `None` while nothing seals the place.
    pub fn floor(self) -> Option<i64> {
        let Floors {
            switch,
            forced,
            site,
        } = self;
        [switch, forced, site].into_iter().filter(|f| *f > 0).min()
    }

    pub fn view(self) -> SealView {
        SealView {
            on: self.floor().is_some(),
            forced: self.forced > 0 || self.site > 0,
            own: self.switch > 0,
            server_forced: self.forced > 0,
        }
    }
}

static SITE: LazyLock<Mutex<HashMap<String, (Instant, i64)>>> = LazyLock::new(Default::default);
const SITE_TTL: Duration = Duration::from_secs(5);

/// The site's requirement as last read, at most 5 seconds old. Views use it; writes read the
/// stored value inside their transaction.
pub(crate) async fn site_floor(db: &Db) -> i64 {
    let key = pool_key(db);
    let hit = SITE.lock().ok().and_then(|cache| {
        cache
            .get(&key)
            .filter(|(at, _)| at.elapsed() < SITE_TTL)
            .map(|(_, floor)| *floor)
    });
    if let Some(floor) = hit {
        return floor;
    }
    let floor = sqlx::query_scalar::<_, i64>(sqlx::AssertSqlSafe(format!("SELECT {SITE_SQL}")))
        .fetch_one(db)
        .await
        .unwrap_or(0);
    if let Ok(mut cache) = SITE.lock() {
        cache.insert(key, (Instant::now(), floor));
    }
    floor
}

/// Forgets what was last read of the site's requirement and of the servers that ever stored
/// messages encrypted, after a switch.
pub(crate) fn forget_site(db: &Db) {
    if let Ok(mut cache) = SITE.lock() {
        cache.remove(&pool_key(db));
    }
    super::messages::forget_sealed(db);
}

/// The state of a server from its `seal` and `seal_forced` columns.
pub(crate) async fn server_view(db: &Db, switch: i64, forced: i64) -> SealView {
    Floors {
        switch,
        forced,
        site: site_floor(db).await,
    }
    .view()
}

/// The state of the DMs `ids`.
pub(crate) async fn dm_views(db: &Db, ids: &[i64]) -> sqlx::Result<HashMap<i64, SealView>> {
    let mut views = HashMap::with_capacity(ids.len());
    if ids.is_empty() {
        return Ok(views);
    }
    let site = site_floor(db).await;
    let sql = format!(
        "SELECT id, seal FROM dms WHERE id IN ({})",
        super::placeholders(1, ids.len())
    );
    let mut query = sqlx::query(sqlx::AssertSqlSafe(sql));
    for id in ids {
        query = query.bind(*id);
    }
    for r in query.fetch_all(db).await? {
        let floors = Floors {
            switch: r.try_get(1)?,
            forced: 0,
            site,
        };
        views.insert(r.try_get(0)?, floors.view());
    }
    Ok(views)
}

/// Reads what seals the channel `id` and whether it is text only, holding both against a
/// switch until the caller's transaction ends. The server row takes the weakest lock that a
/// switch's `FOR UPDATE` still waits for, so joins and member counts never queue behind it.
pub(crate) async fn channel_place(
    conn: &mut AnyConnection,
    sqlite: bool,
    id: i64,
) -> sqlx::Result<(bool, Floors)> {
    let lock = match sqlite {
        true => "",
        false => " FOR SHARE OF c FOR KEY SHARE OF s",
    };
    let sql = format!(
        "SELECT c.text_only, s.seal, s.seal_forced, {SITE_SQL} FROM channels c JOIN servers s ON s.name = c.server WHERE c.id = $1{lock}"
    );
    let r = sqlx::query(sqlx::AssertSqlSafe(sql))
        .bind(id)
        .fetch_one(&mut *conn)
        .await?;
    Ok((
        r.try_get::<i64, _>(0)? != 0,
        Floors {
            switch: r.try_get(1)?,
            forced: r.try_get(2)?,
            site: r.try_get(3)?,
        },
    ))
}

/// Reads what seals the DM `id`, holding it against a switch until the caller's transaction
/// ends. A new message updates the row, so the lock is the one that update takes.
pub(crate) async fn dm_place(
    conn: &mut AnyConnection,
    sqlite: bool,
    id: i64,
) -> sqlx::Result<Floors> {
    let lock = match sqlite {
        true => "",
        false => " FOR NO KEY UPDATE OF d",
    };
    let sql = format!("SELECT d.seal, {SITE_SQL} FROM dms d WHERE d.id = $1{lock}");
    let r = sqlx::query(sqlx::AssertSqlSafe(sql))
        .bind(id)
        .fetch_optional(&mut *conn)
        .await?;
    Ok(match r {
        Some(r) => Floors {
            switch: r.try_get(0)?,
            forced: 0,
            site: r.try_get(1)?,
        },
        None => Floors::default(),
    })
}

/// What seals `scope`, read and held like `channel_place` and `dm_place`.
pub(crate) async fn place(
    conn: &mut AnyConnection,
    sqlite: bool,
    scope: Scope,
) -> sqlx::Result<Floors> {
    match scope {
        Scope::Channel(id) => Ok(channel_place(conn, sqlite, id).await?.1),
        Scope::Dm(id) => dm_place(conn, sqlite, id).await,
    }
}

/// Where a copy of content comes from: the place whose state it is stored in.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Source<'a> {
    Server(&'a str),
    Dm(i64),
    /// No server or DM: only the site's requirement seals it.
    Site,
}

async fn site_floors(conn: &mut AnyConnection) -> sqlx::Result<Floors> {
    let site = sqlx::query_scalar::<_, i64>(sqlx::AssertSqlSafe(format!("SELECT {SITE_SQL}")))
        .fetch_one(&mut *conn)
        .await?;
    Ok(Floors {
        switch: 0,
        forced: 0,
        site,
    })
}

/// What seals a copy from `source` when it is written, held against a switch until the
/// caller's transaction ends. A server or DM that is gone leaves the site's requirement.
pub(crate) async fn copy_place(
    conn: &mut AnyConnection,
    sqlite: bool,
    source: Source<'_>,
) -> sqlx::Result<Floors> {
    let (sql, lock) = match source {
        Source::Site => return site_floors(conn).await,
        Source::Server(_) => (
            "SELECT s.seal, s.seal_forced, {SITE_SQL} FROM servers s WHERE s.name = $1",
            " FOR KEY SHARE OF s",
        ),
        Source::Dm(_) => (
            "SELECT d.seal, CAST(0 AS BIGINT), {SITE_SQL} FROM dms d WHERE d.id = $1",
            " FOR SHARE OF d",
        ),
    };
    let lock = match sqlite {
        true => "",
        false => lock,
    };
    let sql = format!("{}{lock}", sql.replace("{SITE_SQL}", SITE_SQL));
    let query = sqlx::query(sqlx::AssertSqlSafe(sql));
    let query = match source {
        Source::Server(name) => query.bind(name),
        Source::Dm(id) => query.bind(id),
        Source::Site => query,
    };
    match query.fetch_optional(&mut *conn).await? {
        Some(r) => Ok(Floors {
            switch: r.try_get(0)?,
            forced: r.try_get(1)?,
            site: r.try_get(2)?,
        }),
        None => site_floors(conn).await,
    }
}

/// The sealer of a copy in the state `floors`: `None` while nothing seals it. A sealed place
/// without a key refuses the write.
pub(crate) async fn copy_sealer(
    db: &Db,
    conn: &mut AnyConnection,
    floors: Floors,
) -> Result<Option<copies::Sealer>, ApiError> {
    if floors.floor().is_none() {
        return Ok(None);
    }
    match copies::Sealer::of(&crate::db::ring(db), conn).await {
        Ok(Some(sealer)) => Ok(Some(sealer)),
        Ok(None) => Err(ApiError::keys(NEEDS_KEY)),
        Err(e) => Err(ApiError::internal(e)),
    }
}

/// `copy_place` and `copy_sealer` in one step.
pub(crate) async fn copy_sealer_of(
    db: &Db,
    conn: &mut AnyConnection,
    source: Source<'_>,
) -> Result<Option<copies::Sealer>, ApiError> {
    let floors = copy_place(conn, is_sqlite(db), source).await?;
    copy_sealer(db, conn, floors).await
}

/// The writer of a place in the state `floors`: `None` while nothing seals it. A sealed place
/// without a key refuses the write.
pub(crate) async fn writer(
    db: &Db,
    conn: &mut AnyConnection,
    scope: Scope,
    floors: Floors,
) -> Result<Option<Writer>, ApiError> {
    if floors.floor().is_none() {
        return Ok(None);
    }
    match Writer::of(&crate::db::ring(db), conn, scope).await {
        Ok(Some(writer)) => Ok(Some(writer)),
        Ok(None) => Err(ApiError::keys(NEEDS_KEY)),
        Err(e) => Err(ApiError::internal(e)),
    }
}

/// `place` and `writer` in one step.
pub(crate) async fn writer_of(
    db: &Db,
    conn: &mut AnyConnection,
    scope: Scope,
) -> Result<Option<Writer>, ApiError> {
    let floors = place(conn, is_sqlite(db), scope).await?;
    writer(db, conn, scope, floors).await
}

/// What the plain columns of a message hold: its text while it is stored plain, blanks beside
/// a record.
pub(crate) fn columns(writer: Option<&Writer>, parts: &Parts) -> Parts {
    match writer {
        None => parts.clone(),
        Some(_) => Parts {
            content: String::new(),
            embeds: None,
            filename: parts.filename.as_ref().map(|_| String::new()),
            dropped: parts.dropped.as_ref().map(|_| String::new()),
            alt: None,
        },
    }
}

/// On Postgres, the id the next row of `table` takes when it is stored sealed, reserved so the
/// record can be bound to it. SQLite inserts first and writes the record after.
pub(crate) async fn reserve(
    conn: &mut AnyConnection,
    sqlite: bool,
    table: &str,
    writer: Option<&Writer>,
) -> sqlx::Result<Option<i64>> {
    match (sqlite, writer) {
        (true, _) | (false, None) => Ok(None),
        (false, Some(_)) => sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
            "SELECT nextval(pg_get_serial_sequence('{table}', 'id'))"
        )))
        .fetch_one(&mut *conn)
        .await
        .map(Some),
    }
}

/// The SQL of the bind `$n`, a `Writer::grams`, as the `messages.grams` Postgres stores.
pub(crate) fn grams_value(n: usize) -> String {
    format!("CAST(CAST(${n} AS TEXT) AS integer[])")
}

/// Writes the record of a row that was inserted without one.
pub(crate) async fn set_body(
    conn: &mut AnyConnection,
    table: &str,
    key: &str,
    id: i64,
    record: Vec<u8>,
) -> sqlx::Result<()> {
    sqlx::query(sqlx::AssertSqlSafe(format!(
        "UPDATE {table} SET body = $1 WHERE {key} = $2"
    )))
    .bind(record)
    .bind(id)
    .execute(&mut *conn)
    .await
    .map(|_| ())
}

/// The text of the message `id` as stored, opened, with its scope and author. Reads the row
/// and its key on the caller's connection, so inside a transaction it sees that transaction's
/// row and asks for no other connection.
pub(crate) async fn stored_parts(
    ring: Arc<Ring>,
    conn: &mut AnyConnection,
    id: i64,
) -> sqlx::Result<Option<(Option<Scope>, String, Opened)>> {
    let row = sqlx::query("SELECT channel_id, dm_id, author, content, webhook_embeds, media_filename, fwd_dropped, body, media_alt FROM messages WHERE id = $1")
        .bind(id)
        .fetch_optional(&mut *conn)
        .await?;
    let Some(row) = row else {
        return Ok(None);
    };
    let scope = Scope::of(row.try_get(0)?, row.try_get(1)?);
    let author: String = row.try_get(2)?;
    let plain = Parts {
        content: row.try_get(3)?,
        embeds: row.try_get(4)?,
        filename: row.try_get(5)?,
        dropped: row.try_get(6)?,
        alt: row.try_get(8)?,
    };
    let opened = open_body_on(ring, conn, id, scope, &author, row.try_get(7)?, plain).await?;
    Ok(Some((scope, author, opened)))
}

/// Stores `parts` as the text of the message `id` in the form its place has now: a record
/// beside blank columns with a `writer`, plain columns and no record without one.
pub(crate) async fn store_parts(
    conn: &mut AnyConnection,
    writer: Option<&Writer>,
    id: i64,
    author: &str,
    parts: &Parts,
) -> sqlx::Result<()> {
    let Parts {
        content,
        embeds,
        filename,
        dropped,
        alt,
    } = columns(writer, parts);
    let postgres = conn.backend_name() == "PostgreSQL";
    let grams = match postgres {
        true => format!(", grams = {}", grams_value(8)),
        false => String::new(),
    };
    let query = sqlx::query(sqlx::AssertSqlSafe(format!("UPDATE messages SET body = $1, content = $2, webhook_embeds = $3, media_filename = $4, fwd_dropped = $5, media_alt = $7{grams} WHERE id = $6")))
        .bind(writer.map(|w| w.message(id, author, parts)))
        .bind(content)
        .bind(embeds)
        .bind(filename)
        .bind(dropped)
        .bind(id)
        .bind(alt);
    let query = match postgres {
        true => query.bind(writer.and_then(|w| w.grams(parts))),
        false => query,
    };
    query.execute(&mut *conn).await.map(|_| ())
}

async fn next_message_id(conn: &mut AnyConnection) -> sqlx::Result<i64> {
    sqlx::query_scalar("SELECT COALESCE(MAX(id), 0) + 1 FROM messages")
        .fetch_one(&mut *conn)
        .await
}

/// What this copy last saw of the other copies of its database, for the readiness the public
/// settings carry where only the database is at hand.
static SEEN: LazyLock<Mutex<HashMap<String, Seen>>> = LazyLock::new(Default::default);

#[derive(Clone, Default)]
struct Seen {
    replicated: bool,
    others: Vec<Option<CopyNote>>,
}

/// Notes what this copy sees of the others now.
pub(crate) fn note_copies(db: &Db, hub: &Hub) {
    let seen = Seen {
        replicated: hub.is_replicated(),
        others: hub.other_copies(),
    };
    if let Ok(mut all) = SEEN.lock() {
        all.insert(pool_key(db), seen);
    }
}

async fn copies_confirmed(db: &Db) -> sqlx::Result<bool> {
    let build: Option<String> = sqlx::query_scalar("SELECT value FROM settings WHERE key = $1")
        .bind(COPIES)
        .fetch_optional(db)
        .await?;
    Ok(build.as_deref() == Some(env!("CARGO_PKG_VERSION")))
}

/// Whether an admin confirmed that every copy runs this build: `None` where nobody has to (one
/// SQLite file, or copies that announce themselves).
pub(crate) async fn copies(state: &AppState) -> sqlx::Result<Option<bool>> {
    match is_sqlite(&state.db) || state.hub.is_replicated() {
        true => Ok(None),
        false => copies_confirmed(&state.db).await.map(Some),
    }
}

/// Whether sealing may be turned on here: a key that every live copy holds.
pub(crate) async fn readiness(state: &AppState) -> sqlx::Result<Readiness> {
    note_copies(&state.db, &state.hub);
    site_readiness(&state.db).await
}

/// `site_readiness` as the public settings say it; `updating` while it can't be read.
pub(crate) async fn public_readiness(db: &Db) -> String {
    site_readiness(db)
        .await
        .unwrap_or(Readiness::Updating)
        .name()
        .to_owned()
}

/// `readiness` by the copies as this copy last noted them.
pub(crate) async fn site_readiness(db: &Db) -> sqlx::Result<Readiness> {
    let Seen { replicated, others } = SEEN
        .lock()
        .ok()
        .and_then(|all| all.get(&pool_key(db)).cloned())
        .unwrap_or_default();
    let ready = crate::db::ring(db).readiness(is_sqlite(db), &others);
    let confirmed = match is_sqlite(db) || replicated {
        true => None,
        false => Some(copies_confirmed(db).await?),
    };
    Ok(match (ready, confirmed) {
        (Readiness::Ready | Readiness::FirstNeed, Some(false)) => Readiness::Updating,
        (ready, _) => ready,
    })
}

/// Makes sure sealing may be turned on here, making the instance key file on the first need.
/// 409 `keys` otherwise.
pub(crate) async fn make_ready(state: &AppState) -> Result<(), ApiError> {
    let db = &state.db;
    let ring = crate::db::ring(db);
    let others = state.hub.other_copies();
    match readiness(state).await? {
        Readiness::Ready | Readiness::FirstNeed => {}
        Readiness::NoKeys => return Err(ApiError::keys(NEEDS_KEY)),
        Readiness::Updating => return Err(ApiError::keys(UPDATING)),
    }
    if ring
        .ensure_ring(db, !others.is_empty())
        .await
        .map_err(ApiError::internal)?
        .is_err()
    {
        return Err(ApiError::keys(NEEDS_KEY));
    }
    match content_key(db).await.map_err(ApiError::internal)? {
        true => Ok(()),
        false => Err(ApiError::keys(NEEDS_KEY)),
    }
}

/// Makes the active `content` key, the `search` key of its grams and the `media` key of its
/// files, on a connection of their own, so they are committed before a place turns on and a
/// write transaction only ever reads them. False without a root key.
async fn content_key(db: &Db) -> anyhow::Result<bool> {
    let ring = crate::db::ring(db);
    if ring.data_key(db, Purpose::Content).await?.is_none() {
        return Ok(false);
    }
    ring.data_key(db, Purpose::Media).await?;
    if !ring.scans() {
        ring.data_key(db, Purpose::Search).await?;
    }
    Ok(true)
}

/// Makes the `search` and `media` keys of a site that stores messages encrypted and has none
/// of them yet.
async fn search_key(db: &Db) -> anyhow::Result<()> {
    let ring = crate::db::ring(db);
    let sealed: Option<i64> =
        sqlx::query_scalar("SELECT id FROM data_keys WHERE purpose = 'content' LIMIT 1")
            .fetch_optional(db)
            .await?;
    if sealed.is_none() {
        return Ok(());
    }
    ring.data_key(db, Purpose::Media).await?;
    if !ring.scans() {
        ring.data_key(db, Purpose::Search).await?;
    }
    Ok(())
}

/// What a switch request changed.
pub(crate) enum Switched {
    Same,
    /// The id of the system message that says so, when one was posted.
    Changed(Option<i64>),
}

/// Sets the switch of the server `key` inside the caller's transaction and posts the system
/// message. `make_ready` ran before the transaction when `on`. 403 `forced` when the site
/// requires encryption there and `on` is false.
pub(crate) async fn set_server(
    conn: &mut AnyConnection,
    sqlite: bool,
    key: &str,
    actor: &str,
    on: bool,
) -> Result<Switched, ApiError> {
    let lock = match sqlite {
        true => "",
        false => " FOR UPDATE OF s",
    };
    let sql =
        format!("SELECT s.seal, s.seal_forced, {SITE_SQL} FROM servers s WHERE s.name = $1{lock}");
    let r = sqlx::query(sqlx::AssertSqlSafe(sql))
        .bind(key)
        .fetch_one(&mut *conn)
        .await?;
    let floors = Floors {
        switch: r.try_get(0)?,
        forced: r.try_get(1)?,
        site: r.try_get(2)?,
    };
    if !on && floors.view().forced {
        return Err(ApiError::forced(FORCED));
    }
    if on == (floors.switch > 0) {
        return Ok(Switched::Same);
    }
    let from = match on {
        true => next_message_id(conn).await?,
        false => 0,
    };
    sqlx::query(
        "UPDATE servers SET seal = $1, seal_since = COALESCE(seal_since, $2) WHERE name = $3",
    )
    .bind(from)
    .bind(on.then(now))
    .bind(key)
    .execute(&mut *conn)
    .await?;
    let word = match on {
        true => "on",
        false => "off",
    };
    Ok(Switched::Changed(
        post_storage(conn, key, actor, word).await?,
    ))
}

/// What `PUT /api/v1/dms/{id}/seal` takes.
#[derive(Deserialize, ToSchema)]
pub struct SealReq {
    /// Whether new messages are stored encrypted.
    pub on: bool,
}

/// Turn encrypted storage of a DM on or off
///
/// Either participant switches it. From then on new messages, edits and polls of the DM are
/// stored encrypted with a key this site keeps, or plain again. Messages stored before stay as
/// they were, and turning it off decrypts nothing. This is not end-to-end encryption. A change
/// posts a `storage` system message in the DM and sends `dm_updated` to both participants, so
/// a request counts as a message against the message rate, and a block between the
/// participants refuses it like a message.
#[utoipa::path(put, path = "/api/v1/dms/{id}/seal", tag = "Direct messages", params(("id" = i64, Path, description = "DM conversation id")), request_body = SealReq, responses((status = 200, description = "Stored; body `{\"ok\": true}`", body = OkResp), (status = 401, description = "Missing or unknown bearer token", body = super::ApiErrorBody), (status = 403, description = "`Required by this site`: the site requires encrypted storage, so it can't be turned off (`reason.kind` `forced`). Or a block between the DM participants (`This user is not accepting messages from you.` for the blocked side, `You blocked this user. Unblock them to send messages.` for the blocker)", body = super::ApiErrorBody), (status = 404, description = "`Not found`: no such DM, or you are not in it", body = super::ApiErrorBody), (status = 409, description = "`This site needs an encryption key first` or `Not available while this site updates` (`reason.kind` `keys`)", body = super::ApiErrorBody), (status = 429, description = "Too many requests in the general bucket. Or `Sending too fast, try again in a moment` (JSON, reason `rate`, with `Retry-After`): past `MESSAGE_RATE_BURST` or `MESSAGE_RATE_PER_MINUTE`, as for messages", body = super::ApiErrorBody)), security(("bearer" = [])))]
pub(crate) async fn put_dm_seal(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path(id): Path<i64>,
    Json(SealReq { on }): Json<SealReq>,
) -> Result<Json<OkResp>, ApiError> {
    let users = resolve_dm(&state.db, id, &user).await?;
    super::blocks::check_dm_write(&state.db, &user.username, &users).await?;
    super::messages::message_rate(&state, &user).await?;
    if on {
        make_ready(&state).await?;
    }
    let db = &state.db;
    let sqlite = is_sqlite(db);
    let mut tx = match sqlite {
        true => db.begin_with("BEGIN IMMEDIATE").await?,
        false => db.begin().await?,
    };
    let floors = dm_place(&mut tx, sqlite, id).await?;
    if !on && floors.view().forced {
        return Err(ApiError::forced(FORCED));
    }
    if on == (floors.switch > 0) {
        return Ok(ok());
    }
    let from = match on {
        true => next_message_id(&mut tx).await?,
        false => 0,
    };
    sqlx::query("UPDATE dms SET seal = $1, seal_since = COALESCE(seal_since, $2) WHERE id = $3")
        .bind(from)
        .bind(on.then(now))
        .bind(id)
        .execute(&mut *tx)
        .await?;
    let word = match on {
        true => "on",
        false => "off",
    };
    let notice = post_storage_dm(&mut tx, id, &user.username, word).await?;
    tx.commit().await?;
    let seal = Floors {
        switch: from,
        forced: 0,
        site: floors.site,
    }
    .view();
    state.hub.broadcast(WsEvent::DmUpdated {
        dm_id: id,
        dm_users: users.clone(),
        seal,
    });
    super::system_messages::announce_storage_dm(&state, id, users, notice).await;
    Ok(ok())
}

/// What the admin routes that require encryption take.
#[derive(Deserialize, utoipa::ToSchema)]
pub struct RequireReq {
    /// Whether encryption is required.
    pub on: bool,
}

/// Whether the site requires encryption, and where that is set.
#[derive(Serialize, utoipa::ToSchema)]
pub struct RequiredView {
    /// Whether the site requires encryption.
    pub on: bool,
    /// The server configuration sets it, so the admin page can't.
    pub pinned: bool,
}

async fn stored(conn: &mut AnyConnection, key: &str) -> sqlx::Result<Option<String>> {
    sqlx::query_scalar("SELECT value FROM settings WHERE key = $1")
        .bind(key)
        .fetch_optional(&mut *conn)
        .await
}

async fn store(conn: &mut AnyConnection, key: &str, value: &str) -> sqlx::Result<()> {
    sqlx::query("INSERT INTO settings(key, value) VALUES($1, $2) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .bind(key)
        .bind(value)
        .execute(&mut *conn)
        .await
        .map(|_| ())
}

/// Makes `SITE_FROM` say whether the site requires encryption: there, from the next message
/// on, while the environment or the admin page requires it, and gone otherwise. Returns
/// whether it is required.
async fn settle_site(conn: &mut AnyConnection, by_config: bool) -> sqlx::Result<bool> {
    let required = by_config || stored(conn, REQUIRED).await?.as_deref() == Some("on");
    let from = stored(conn, SITE_FROM).await?;
    match (required, from) {
        (true, Some(_)) | (false, None) => {}
        (true, None) => {
            let next = next_message_id(conn).await?;
            store(conn, SITE_FROM, &next.to_string()).await?;
        }
        (false, Some(_)) => {
            sqlx::query("DELETE FROM settings WHERE key = $1")
                .bind(SITE_FROM)
                .execute(&mut *conn)
                .await?;
        }
    }
    if required && stored(conn, SITE_SINCE).await?.is_none() {
        store(conn, SITE_SINCE, &now().to_string()).await?;
    }
    Ok(required)
}

/// The start's part: applies `ENCRYPTION_REQUIRED`. A site that requires encryption without a
/// key refuses the start.
pub async fn start(state: &AppState) -> anyhow::Result<()> {
    let db = &state.db;
    let ring = crate::db::ring(db);
    if ring.required() {
        let others = !state.hub.other_copies().is_empty();
        if ring.ensure_ring(db, others).await?.is_err() || !content_key(db).await? {
            anyhow::bail!(
                "ENCRYPTION_REQUIRED is on, but there is no encryption key. Set ENCRYPTION_KEYS or ENCRYPTION_KEYS_FILE"
            );
        }
    }
    if let Err(e) = search_key(db).await {
        tracing::warn!("the search and file keys of encrypted messages could not be made: {e}");
    }
    note_copies(db, &state.hub);
    let mut tx = db.begin().await?;
    settle_site(&mut tx, ring.required()).await?;
    tx.commit().await?;
    forget_site(db);
    Ok(())
}

pub(crate) async fn required_view(state: &AppState) -> sqlx::Result<RequiredView> {
    let pinned = crate::db::ring(&state.db).required();
    let mut conn = state.db.acquire().await?;
    let on = pinned || stored(&mut conn, REQUIRED).await?.as_deref() == Some("on");
    Ok(RequiredView { on, pinned })
}

/// Require encryption on the site
///
/// `PUT /api/v1/admin/encryption/required`: "Require encryption on this site".
#[utoipa::path(put, path = "/api/v1/admin/encryption/required", tag = "Admin", operation_id = "admin_require_encryption", request_body = RequireReq, responses((status = 200, description = "Whether the site requires encryption", body = RequiredView), (status = 400, description = "Malformed JSON (plain-text framework error)", body = crate::api::ApiErrorBody), (status = 401, description = "Missing or unknown bearer token", body = crate::api::ApiErrorBody), (status = 403, description = "`Set by the server configuration` (reason `forced`)", body = crate::api::ApiErrorBody), (status = 404, description = "`Not found`: the caller is not a site administrator", body = crate::api::ApiErrorBody), (status = 409, description = "No encryption key that every copy of this site holds (reason `keys`)", body = crate::api::ApiErrorBody), (status = 429, description = "Too many requests in the general bucket", body = crate::api::ApiErrorBody)), security(("bearer" = [])))]
pub(crate) async fn put_required(
    State(state): State<AppState>,
    Authed(user): Authed,
    Json(RequireReq { on }): Json<RequireReq>,
) -> Result<Json<RequiredView>, ApiError> {
    require_site_admin(&user)?;
    let db = &state.db;
    let pinned = crate::db::ring(db).required();
    if pinned {
        return Err(ApiError::forced("Set by the server configuration"));
    }
    if on {
        make_ready(&state).await?;
    }
    let mut tx = db.begin().await?;
    let was = stored(&mut tx, REQUIRED).await?.as_deref() == Some("on");
    if was != on {
        let word = match on {
            true => "on",
            false => "off",
        };
        store(&mut tx, REQUIRED, word).await?;
        settle_site(&mut tx, false).await?;
        super::instance_audit::record_in(
            &mut tx,
            &user.username,
            "encryption.required",
            None,
            serde_json::json!({"on": on}),
            state.clock.unix(),
        )
        .await?;
    }
    tx.commit().await?;
    forget_site(db);
    if was != on {
        let settings = super::PublicSettings::load(db).await;
        state.hub.broadcast(WsEvent::SettingsChanged { settings });
    }
    Ok(Json(RequiredView { on, pinned }))
}

/// Require encryption for one server
///
/// `PUT /api/v1/admin/servers/{name}/seal_forced`: "Require encryption" for one server.
#[utoipa::path(put, path = "/api/v1/admin/servers/{name}/seal_forced", tag = "Admin", operation_id = "admin_require_server_encryption", params(("name" = String, Path, description = "Server name, case-insensitive")), request_body = RequireReq, responses((status = 200, description = "How the server stores new messages", body = SealView), (status = 400, description = "Malformed JSON (plain-text framework error)", body = crate::api::ApiErrorBody), (status = 401, description = "Missing or unknown bearer token", body = crate::api::ApiErrorBody), (status = 404, description = "`Not found`: the caller is not a site administrator, or no such server", body = crate::api::ApiErrorBody), (status = 409, description = "No encryption key that every copy of this site holds (reason `keys`)", body = crate::api::ApiErrorBody), (status = 429, description = "Too many requests in the general bucket", body = crate::api::ApiErrorBody)), security(("bearer" = [])))]
pub(crate) async fn put_server_forced(
    State(state): State<AppState>,
    Authed(user): Authed,
    Path(name): Path<String>,
    Json(RequireReq { on }): Json<RequireReq>,
) -> Result<Json<SealView>, ApiError> {
    require_site_admin(&user)?;
    let access =
        super::access::resolve_server(&state.db, &name, Some(&user), &super::access::Proof::none())
            .await?;
    let key = access.name().to_string();
    if on {
        make_ready(&state).await?;
    }
    let db = &state.db;
    let sqlite = is_sqlite(db);
    let mut tx = match sqlite {
        true => db.begin_with("BEGIN IMMEDIATE").await?,
        false => db.begin().await?,
    };
    let lock = match sqlite {
        true => "",
        false => " FOR UPDATE",
    };
    let was: i64 = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "SELECT seal_forced FROM servers WHERE name = $1{lock}"
    )))
    .bind(&key)
    .fetch_one(&mut *tx)
    .await?;
    let mut notice = None;
    if on != (was > 0) {
        let from = match on {
            true => next_message_id(&mut tx).await?,
            false => 0,
        };
        sqlx::query("UPDATE servers SET seal_forced = $1, seal_since = COALESCE(seal_since, $2) WHERE name = $3")
            .bind(from)
            .bind(on.then(now))
            .bind(&key)
            .execute(&mut *tx)
            .await?;
        super::instance_audit::record_in(
            &mut tx,
            &user.username,
            "encryption.server_required",
            Some(&key),
            serde_json::json!({"on": on}),
            state.clock.unix(),
        )
        .await?;
        let word = match on {
            true => "forced",
            false => "unforced",
        };
        notice = post_storage(&mut tx, &key, "", word).await?;
    }
    tx.commit().await?;
    forget_site(db);
    let server =
        super::access::resolve_server(db, &key, Some(&user), &super::access::Proof::none())
            .await?
            .lite()
            .clone();
    let seal = server.seal;
    if on != (was > 0) {
        state.hub.broadcast(WsEvent::ServerUpdated { server });
        super::system_messages::announce_system(&state, &key, notice).await;
    }
    Ok(Json(seal))
}

/// What the admin route that confirms the copies takes.
#[derive(Deserialize, utoipa::ToSchema)]
pub struct CopiesReq {
    /// Whether every copy of this site runs this build.
    pub confirmed: bool,
}

/// Confirm every copy runs this build
///
/// `PUT /api/v1/admin/encryption/copies`: "Every copy runs this build", for a site whose
/// copies do not announce themselves.
#[utoipa::path(put, path = "/api/v1/admin/encryption/copies", tag = "Admin", operation_id = "admin_confirm_copies", request_body = CopiesReq, responses((status = 200, description = "The confirmation is stored", body = OkResp), (status = 400, description = "Malformed JSON (plain-text framework error)", body = crate::api::ApiErrorBody), (status = 401, description = "Missing or unknown bearer token", body = crate::api::ApiErrorBody), (status = 404, description = "`Not found`: the caller is not a site administrator", body = crate::api::ApiErrorBody), (status = 429, description = "Too many requests in the general bucket", body = crate::api::ApiErrorBody)), security(("bearer" = [])))]
pub(crate) async fn put_copies(
    State(state): State<AppState>,
    Authed(user): Authed,
    Json(CopiesReq { confirmed }): Json<CopiesReq>,
) -> Result<Json<OkResp>, ApiError> {
    require_site_admin(&user)?;
    let was = copies_confirmed(&state.db).await?;
    let mut conn = state.db.acquire().await?;
    match confirmed {
        true => store(&mut conn, COPIES, env!("CARGO_PKG_VERSION")).await?,
        false => {
            sqlx::query("DELETE FROM settings WHERE key = $1")
                .bind(COPIES)
                .execute(&mut *conn)
                .await?;
        }
    }
    drop(conn);
    if was != confirmed {
        let settings = super::PublicSettings::load(&state.db).await;
        state.hub.broadcast(WsEvent::SettingsChanged { settings });
    }
    Ok(ok())
}

pub(crate) mod jobs;
pub(crate) mod rotate;
mod sweep;
pub(crate) use jobs::{SealJob, get_job, list_jobs, resume_jobs, start_job};
pub(crate) use sweep::sweep;
#[cfg(test)]
pub(crate) use sweep::{WITHOUT_GRAMS, fill_grams};

#[cfg(test)]
mod tests;
