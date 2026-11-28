use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::time::Instant;

use redis::aio::{ConnectionManager, ConnectionManagerConfig};
use redis::streams::{
    StreamClaimReply, StreamId, StreamInfoConsumer, StreamInfoConsumersReply,
    StreamPendingCountReply, StreamPendingId, StreamRangeReply, StreamReadReply,
};
use redis::{Client, RedisResult};
use tokio::sync::mpsc;
use tokio::task::{AbortHandle, JoinSet};
use tracing::{error, info, warn};

use crate::api::embeds::{UnfurlJob, unfurl};
use crate::config::Roles;
use crate::crypt::frames::{Frames, Stream};
use crate::hub::{Envelope, Hub, READ_FLUSH, stream_pos};
use crate::state::AppState;
use crate::ws::{LogGate, to_bus_json};

const SKIP_LOG_EVERY: Duration = Duration::from_secs(10);

static SKIPPED: LogGate = LogGate::new(SKIP_LOG_EVERY, |n| {
    warn!(
        "skipped {n} more realtime entries in the last {}s that this version cannot read (another version is running, or the entries are corrupt)",
        SKIP_LOG_EVERY.as_secs()
    )
});

fn skip(line: &str) {
    if SKIPPED.admit(tokio::time::Instant::now()) {
        warn!("{line}");
    }
}

static UNDECIDED: LogGate = LogGate::new(SKIP_LOG_EVERY, |n| {
    warn!(
        "{n} more decisions on sealing realtime frames failed in the last {}s",
        SKIP_LOG_EVERY.as_secs()
    )
});

pub const DEFAULT_HUB_MAXLEN: u64 = 100_000;
/// The field of a stream entry that holds a sealed frame.
const SEALED: &str = "sealed";
const JOBS_MAXLEN: u64 = 10_000;
const BLOCK_MS: u64 = 5_000;
const TICK: Duration = Duration::from_secs(5);
const START: &str = "0-0";
const SNAPSHOT_WAITS: u32 = 6;
const SNAPSHOT_FORCE: Duration = Duration::from_secs(60);
const SNAPSHOT_LARGE: usize = 1 << 20;
const SNAPSHOT_SLOW: Duration = Duration::from_secs(30);
const SNAPSHOT_ATTEMPTS: u32 = 2;
const SNAPSHOT_BACKOFF_CAP: Duration = Duration::from_secs(120);
const EMBEDS_GROUP: &str = "embeds";
const CLAIM_IDLE_MS: u64 = 60_000;
const CLAIM_EVERY: Duration = Duration::from_secs(30);
const MAX_DELIVERIES: usize = 3;
const CONSUMER_IDLE_MS: usize = 600_000;

/// How long a limit counted in Redis waits for an answer before it counts in this process.
const LIMITS_WAIT: Duration = Duration::from_millis(500);

/// The connection of limits counted in Redis: it never waits long or retries, so a request
/// that Redis can't answer counts in this process.
fn limits_config() -> ConnectionManagerConfig {
    ConnectionManagerConfig::new()
        .set_connection_timeout(Some(LIMITS_WAIT))
        .set_response_timeout(Some(LIMITS_WAIT))
        .set_number_of_retries(0)
}

const SAVE_SNAPSHOT: &str = "
local cur = redis.call('HGET', KEYS[1], 'id')
if cur then
  local cm, cs = string.match(cur, '^(%d+)-(%d+)$')
  local nm, ns = string.match(ARGV[1], '^(%d+)-(%d+)$')
  cm, cs, nm, ns = tonumber(cm), tonumber(cs), tonumber(nm), tonumber(ns)
  if cm and nm and (nm < cm or (nm == cm and ns <= cs)) then
    return 0
  end
end
redis.call('HSET', KEYS[1], 'id', ARGV[1], 'state', ARGV[2])
return 1
";

#[derive(Clone)]
pub struct Bus {
    conn: ConnectionManager,
    limits: crate::limits::shared::Shared,
    client: Client,
    prefix: Arc<str>,
    roles: Roles,
    instance: u32,
    tasks: Arc<Mutex<Vec<AbortHandle>>>,
    frames: Arc<Frames>,
}

#[derive(Clone)]
struct Log {
    stream: String,
    snapshot: String,
    maxlen: u64,
    frames: Arc<Frames>,
}

fn manager_config(response: Duration) -> ConnectionManagerConfig {
    ConnectionManagerConfig::new()
        .set_connection_timeout(Some(Duration::from_secs(5)))
        .set_response_timeout(Some(response))
        .set_max_delay(Duration::from_secs(2))
}

fn blocking_config() -> ConnectionManagerConfig {
    manager_config(Duration::from_millis(BLOCK_MS) + Duration::from_secs(10))
}

async fn lock(conn: &mut ConnectionManager, key: &str, holder: u32, ttl: Duration) -> bool {
    let res: RedisResult<Option<String>> = redis::cmd("SET")
        .arg(key)
        .arg(holder)
        .arg("NX")
        .arg("PX")
        .arg(ttl.as_millis() as u64)
        .query_async(conn)
        .await;
    matches!(res, Ok(Some(_)))
}

fn entries(reply: Option<StreamReadReply>) -> Vec<StreamId> {
    reply
        .into_iter()
        .flat_map(|r| r.keys)
        .flat_map(|k| k.ids)
        .collect()
}

fn is_live(id: &str, boundary: Option<&str>) -> bool {
    boundary.is_none_or(|b| stream_pos(id) > stream_pos(b))
}

fn reached(last: &str, boundary: Option<&str>) -> bool {
    boundary.is_none_or(|b| stream_pos(last) >= stream_pos(b))
}

fn continuous(last: &str, anchored: bool) -> bool {
    last == START || anchored
}

#[derive(Debug, PartialEq)]
enum Resume {
    Snapshot,
    Replay,
    Wait,
}

fn resume(
    last: &str,
    snapshot_in_stream: bool,
    newest: Option<&str>,
    trimmed: bool,
    waited: u32,
) -> Resume {
    match (snapshot_in_stream, newest) {
        (true, _) => Resume::Snapshot,
        (false, None) => Resume::Replay,
        (false, Some(n)) if stream_pos(n) < stream_pos(last) || !trimmed => Resume::Replay,
        (false, Some(_)) if waited >= SNAPSHOT_WAITS => Resume::Replay,
        (false, Some(_)) => Resume::Wait,
    }
}

fn reset_boundary(last: &str, newest: Option<String>) -> Option<String> {
    match newest {
        Some(n) if stream_pos(&n) > stream_pos(last) => Some(last.to_string()),
        other => other,
    }
}

fn spent(pending: Vec<StreamPendingId>) -> (Vec<StreamPendingId>, Vec<StreamPendingId>) {
    pending
        .into_iter()
        .partition(|p| p.times_delivered >= MAX_DELIVERIES)
}

fn idle_consumers(consumers: &[StreamInfoConsumer], me: &str) -> Vec<String> {
    consumers
        .iter()
        .filter(|c| c.name != me && c.pending == 0 && c.idle >= CONSUMER_IDLE_MS)
        .map(|c| c.name.clone())
        .collect()
}

fn xadd_batch(log: &Log, batch: &[Envelope]) -> redis::Pipeline {
    let mut pipe = redis::pipe();
    for env in batch {
        match to_bus_json(env) {
            Ok(payload) => {
                let add = pipe
                    .cmd("XADD")
                    .arg(&log.stream)
                    .arg("MAXLEN")
                    .arg("~")
                    .arg(log.maxlen)
                    .arg("*");
                match log.frames.seal(Stream::Hub, "", payload.as_bytes()) {
                    Some(sealed) => add.arg(SEALED).arg(sealed),
                    None => add.arg("op").arg(payload),
                }
                .ignore();
            }
            Err(e) => warn!("dropping unserializable realtime op: {e}"),
        }
    }
    pipe
}

/// The text of a stream entry: its plain `field`, or its sealed frame opened.
async fn entry_text(
    frames: &Frames,
    stream: Stream,
    entry: &StreamId,
    field: &str,
) -> Result<String, String> {
    if let Some(raw) = entry.get::<String>(field) {
        return Ok(raw);
    }
    let Some(sealed) = entry.get::<Vec<u8>>(SEALED) else {
        return Err(format!("without {field}"));
    };
    let plain = frames
        .open(stream, "", &sealed)
        .await
        .map_err(|e| e.to_string())?;
    String::from_utf8(plain).map_err(|e| e.to_string())
}

pub async fn connect(
    url: &str,
    prefix: &str,
    hub_maxlen: u64,
    roles: Roles,
    frames: Arc<Frames>,
) -> anyhow::Result<(Hub, Bus)> {
    let client = Client::open(url)?;
    let mut conn = client
        .get_connection_manager_with_config(manager_config(Duration::from_secs(10)))
        .await?;
    let _: String = redis::cmd("PING").query_async(&mut conn).await?;
    let tail = client.get_connection_manager_lazy(blocking_config())?;
    let log = Log {
        stream: format!("{prefix}:hub"),
        snapshot: format!("{prefix}:hub:snapshot"),
        maxlen: hub_maxlen,
        frames: frames.clone(),
    };
    let (hub, out) = Hub::replicated();
    hub.coalesce_reads();
    hub.announce_copy(crate::crypt::ring::SEALS, frames.opens(), frames.keks());
    let tasks = Arc::new(Mutex::new(vec![
        tokio::spawn(publish(out, conn.clone(), log.clone(), hub.clone())).abort_handle(),
        tokio::spawn(follow(tail, log.clone(), hub.clone())).abort_handle(),
        tokio::spawn(heartbeats(hub.clone())).abort_handle(),
        tokio::spawn(reads(hub.clone())).abort_handle(),
        tokio::spawn(seal_frames(hub.clone(), frames.clone())).abort_handle(),
    ]));
    let bus = Bus {
        conn,
        limits: crate::limits::shared::Shared::new(
            client.get_connection_manager_lazy(limits_config())?,
            prefix,
        ),
        client,
        prefix: Arc::from(prefix),
        roles,
        instance: hub.instance(),
        tasks,
        frames,
    };
    let snapshots = tokio::spawn(snapshots(bus.clone(), log.snapshot, hub.clone()));
    bus.hold(snapshots.abort_handle());
    Ok((hub, bus))
}

async fn publish(
    mut rx: mpsc::Receiver<Envelope>,
    mut conn: ConnectionManager,
    log: Log,
    hub: Hub,
) {
    while let Some(first) = rx.recv().await {
        let mut batch = vec![first];
        while batch.len() < 256
            && let Ok(env) = rx.try_recv()
        {
            batch.push(env);
        }
        let pipe = xadd_batch(&log, &batch);
        let mut delay = Duration::from_millis(100);
        while let Err(e) = pipe.query_async::<()>(&mut conn).await {
            hub.set_publishing(false);
            warn!("realtime publish failed, retrying: {e}");
            tokio::time::sleep(delay).await;
            delay = (delay * 2).min(Duration::from_secs(5));
        }
        hub.set_publishing(true);
    }
}

struct Probe {
    snapshot: Option<(String, Vec<u8>)>,
    in_stream: bool,
    newest: Option<String>,
    trimmed: bool,
}

async fn probe(conn: &mut ConnectionManager, log: &Log) -> RedisResult<Probe> {
    let (mut saved, newest, len): (HashMap<String, Vec<u8>>, StreamRangeReply, u64) = redis::pipe()
        .cmd("HGETALL")
        .arg(&log.snapshot)
        .cmd("XREVRANGE")
        .arg(&log.stream)
        .arg("+")
        .arg("-")
        .arg("COUNT")
        .arg(1)
        .cmd("XLEN")
        .arg(&log.stream)
        .query_async(conn)
        .await?;
    let snapshot = match (saved.remove("id"), saved.remove("state")) {
        (Some(id), Some(state)) => String::from_utf8(id).ok().map(|id| (id, state)),
        (_, _) => None,
    };
    let in_stream = match &snapshot {
        Some((id, _)) => {
            let hit: StreamRangeReply = redis::cmd("XRANGE")
                .arg(&log.stream)
                .arg(id)
                .arg(id)
                .arg("COUNT")
                .arg(1)
                .query_async(conn)
                .await?;
            !hit.ids.is_empty()
        }
        None => false,
    };
    Ok(Probe {
        snapshot,
        in_stream,
        newest: newest.ids.into_iter().next().map(|e| e.id),
        trimmed: len >= log.maxlen,
    })
}

async fn bootstrap(
    conn: &mut ConnectionManager,
    log: &Log,
    last: &str,
    hub: &Hub,
) -> (String, Option<String>) {
    let mut waited = 0;
    loop {
        let Probe {
            snapshot,
            in_stream,
            newest,
            trimmed,
        } = match probe(conn, log).await {
            Ok(p) => p,
            Err(e) => {
                hub.set_following(false);
                warn!("realtime bootstrap failed, retrying: {e}");
                tokio::time::sleep(Duration::from_secs(1)).await;
                continue;
            }
        };
        hub.set_following(true);
        let usable = match (snapshot, in_stream) {
            (Some((id, state)), true) => match log
                .frames
                .text(Stream::Snapshot, &id, state)
                .await
                .and_then(|state| Ok(hub.restore(&id, &state)?))
            {
                Ok(()) => Some(id),
                Err(e) => {
                    warn!("ignoring unreadable realtime snapshot {id}: {e}");
                    None
                }
            },
            (_, _) => None,
        };
        let plan = resume(last, usable.is_some(), newest.as_deref(), trimmed, waited);
        match (plan, usable) {
            (Resume::Snapshot, Some(id)) => {
                info!("Realtime state restored from snapshot {id}");
                return (id, newest);
            }
            (Resume::Wait, _) => {
                waited += 1;
                warn!(
                    "realtime stream was trimmed past this instance; waiting for a newer snapshot"
                );
                tokio::time::sleep(TICK).await;
            }
            (Resume::Snapshot | Resume::Replay, _) => {
                let boundary = match (waited >= SNAPSHOT_WAITS, last == START) {
                    (true, _) => {
                        error!(
                            "no usable realtime snapshot appeared; replaying the remaining stream"
                        );
                        newest
                    }
                    (false, false) => {
                        info!("Realtime stream was reset; keeping the local state");
                        reset_boundary(last, newest)
                    }
                    (false, true) => newest,
                };
                return (START.to_string(), boundary);
            }
        }
    }
}

async fn follow(mut conn: ConnectionManager, log: Log, hub: Hub) {
    hub.set_diverged(true);
    let (mut last, mut boundary) = bootstrap(&mut conn, &log, START, &hub).await;
    hub.set_diverged(false);
    let mut caught = reached(&last, boundary.as_deref());
    hub.set_caught_up(caught);
    loop {
        let read: RedisResult<(Option<StreamReadReply>, StreamRangeReply)> = redis::pipe()
            .cmd("XREAD")
            .arg("COUNT")
            .arg(512)
            .arg("BLOCK")
            .arg(BLOCK_MS)
            .arg("STREAMS")
            .arg(&log.stream)
            .arg(&last)
            .cmd("XRANGE")
            .arg(&log.stream)
            .arg(&last)
            .arg(&last)
            .arg("COUNT")
            .arg(1)
            .query_async(&mut conn)
            .await;
        let (reply, anchor) = match read {
            Ok(read) => read,
            Err(e) => {
                hub.set_following(false);
                warn!("realtime read failed: {e}");
                tokio::time::sleep(Duration::from_secs(1)).await;
                continue;
            }
        };
        hub.set_following(true);
        if !continuous(&last, !anchor.ids.is_empty()) {
            warn!("realtime stream no longer holds {last}; re-bootstrapping");
            hub.set_diverged(true);
            (last, boundary) = bootstrap(&mut conn, &log, &last, &hub).await;
            hub.set_diverged(false);
            caught = reached(&last, boundary.as_deref());
            hub.set_caught_up(caught);
            hub.resync(true);
            continue;
        }
        for entry in entries(reply) {
            let live = is_live(&entry.id, boundary.as_deref());
            match entry_text(&log.frames, Stream::Hub, &entry, "op")
                .await
                .and_then(|raw| serde_json::from_str::<Envelope>(&raw).map_err(|e| e.to_string()))
            {
                Ok(env) => hub.ingest(&entry.id, env, live),
                Err(e) => skip(&format!("skipping realtime entry {}: {e}", entry.id)),
            }
            last = entry.id;
        }
        if !caught && reached(&last, boundary.as_deref()) {
            caught = true;
            hub.set_caught_up(true);
            info!("Realtime bus caught up at {last}");
        }
    }
}

async fn heartbeats(hub: Hub) {
    let mut every = tokio::time::interval(TICK);
    loop {
        every.tick().await;
        hub.heartbeat();
    }
}

async fn seal_frames(hub: Hub, frames: Arc<Frames>) {
    let mut every = tokio::time::interval(TICK);
    loop {
        every.tick().await;
        decide_frames(&hub, &frames).await;
    }
}

/// Seals frames from now on when every live copy opens them, else writes them plain. A switch to
/// plain has every copy announce its connections again and the snapshot written again, in plain
/// frames, so a copy that can't open sealed ones gets the state it skipped. Nothing changes while
/// the hub is not ready. Answers whether frames are sealed, or `None` while not ready.
async fn decide_frames(hub: &Hub, frames: &Frames) -> Option<bool> {
    if !hub.ready() {
        return None;
    }
    let was = frames.sealed();
    let decided = frames.decide(&hub.other_copies()).await;
    if let Err(e) = &decided
        && UNDECIDED.admit(tokio::time::Instant::now())
    {
        warn!("realtime frames go plain, the decision on sealing them failed: {e}");
    }
    match (was, frames.sealed()) {
        (false, true) => info!("Realtime bus: frames are stored encrypted"),
        (true, false) => {
            info!("Realtime bus: frames are stored plain until every copy opens them");
            hub.mark_dirty();
            hub.reannounce_all();
        }
        (true, true) | (false, false) => {}
    }
    Some(frames.sealed())
}

async fn reads(hub: Hub) {
    let mut every = tokio::time::interval(READ_FLUSH);
    loop {
        every.tick().await;
        hub.flush_reads();
    }
}

fn snapshot_wait(size: usize) -> Duration {
    match size >= SNAPSHOT_LARGE {
        true => SNAPSHOT_SLOW,
        false => TICK,
    }
}

async fn save_snapshot(
    conn: &mut ConnectionManager,
    sha: &mut Option<String>,
    key: &str,
    id: &str,
    state: &[u8],
) -> RedisResult<i64> {
    let mut attempt = 0;
    loop {
        attempt += 1;
        let hash = match sha {
            Some(hash) => hash.clone(),
            None => {
                let loaded: String = redis::cmd("SCRIPT")
                    .arg("LOAD")
                    .arg(SAVE_SNAPSHOT)
                    .query_async(conn)
                    .await?;
                sha.insert(loaded).clone()
            }
        };
        let saved: RedisResult<i64> = redis::cmd("EVALSHA")
            .arg(&hash)
            .arg(1)
            .arg(key)
            .arg(id)
            .arg(state)
            .query_async(conn)
            .await;
        match saved {
            Err(e) if e.code() == Some("NOSCRIPT") => {
                *sha = None;
                if attempt >= SNAPSHOT_ATTEMPTS {
                    return Err(e);
                }
            }
            other => return other,
        }
    }
}

fn snapshot_backoff(failures: u32) -> Duration {
    TICK.saturating_mul(1 << failures.min(8))
        .min(SNAPSHOT_BACKOFF_CAP)
}

async fn snapshots(bus: Bus, key: String, hub: Hub) {
    let mut every = tokio::time::interval(TICK);
    let mut sha: Option<String> = None;
    let mut saved_at: Option<Instant> = None;
    let mut size = 0;
    let mut failures = 0;
    let mut held_until: Option<Instant> = None;
    loop {
        every.tick().await;
        if held_until.is_some_and(|t| Instant::now() < t) {
            continue;
        }
        let since = saved_at.map(|t| t.elapsed());
        if since.is_some_and(|s| s < snapshot_wait(size)) || !hub.ready() {
            continue;
        }
        let force = since.is_none_or(|s| s >= SNAPSHOT_FORCE);
        if !bus
            .try_lock("hub-snapshot", TICK - Duration::from_millis(500))
            .await
        {
            continue;
        }
        let Some((id, replica)) = hub.snapshot_state(force) else {
            continue;
        };
        let json = match serde_json::to_string(&replica) {
            Ok(json) => json,
            Err(e) => {
                warn!("realtime snapshot not serialized: {e}");
                continue;
            }
        };
        drop(replica);
        size = json.len();
        let state = match bus.frames.seal(Stream::Snapshot, &id, json.as_bytes()) {
            Some(sealed) => sealed,
            None => json.into_bytes(),
        };
        let mut conn = bus.conn.clone();
        match save_snapshot(&mut conn, &mut sha, &key, &id, &state).await {
            Ok(_) => {
                saved_at = Some(Instant::now());
                failures = 0;
                held_until = None;
            }
            Err(e) => {
                hub.mark_dirty();
                held_until = Some(Instant::now() + snapshot_backoff(failures));
                failures += 1;
                warn!("realtime snapshot not saved, retrying later: {e}");
            }
        }
    }
}

impl Bus {
    fn key(&self, name: &str) -> String {
        format!("{}:{name}", self.prefix)
    }

    /// Buckets in this Redis, for limits counted across copies.
    pub fn shared(&self) -> crate::limits::shared::Shared {
        self.limits.clone()
    }

    pub fn unfurls_locally(&self) -> bool {
        self.roles.embeds
    }

    /// How this bus seals and opens its frames.
    pub fn frames(&self) -> &Arc<Frames> {
        &self.frames
    }

    pub async fn enqueue_unfurl(&self, job: &UnfurlJob) -> anyhow::Result<()> {
        let payload = serde_json::to_string(job)?;
        let mut conn = self.conn.clone();
        let mut add = redis::cmd("XADD");
        add.arg(self.key("embeds"))
            .arg("MAXLEN")
            .arg("~")
            .arg(JOBS_MAXLEN)
            .arg("*");
        match self.frames.seal(Stream::Jobs, "", payload.as_bytes()) {
            Some(sealed) => add.arg(SEALED).arg(sealed),
            None => add.arg("job").arg(payload),
        };
        let _: String = add.query_async(&mut conn).await?;
        Ok(())
    }

    pub async fn try_lock(&self, name: &str, ttl: Duration) -> bool {
        let mut conn = self.conn.clone();
        lock(
            &mut conn,
            &self.key(&format!("lock:{name}")),
            self.instance,
            ttl,
        )
        .await
    }

    pub fn spawn_workers(&self, state: &AppState) {
        if !self.roles.embeds {
            return;
        }
        match self.client.get_connection_manager_lazy(blocking_config()) {
            Ok(conn) => {
                let worker = tokio::spawn(embeds_worker(
                    state.clone(),
                    self.frames.clone(),
                    conn,
                    self.key("embeds"),
                    format!("{:08x}", self.instance),
                ));
                self.hold(worker.abort_handle());
            }
            Err(e) => warn!("embeds worker not started: {e}"),
        }
    }

    fn hold(&self, task: AbortHandle) {
        if let Ok(mut tasks) = self.tasks.lock() {
            tasks.push(task);
        }
    }

    /// Ends the tasks that publish to and follow the bus.
    pub fn stop(&self) {
        if let Ok(mut tasks) = self.tasks.lock() {
            for task in tasks.drain(..) {
                task.abort();
            }
        }
    }
}

async fn reclaim(
    conn: &mut ConnectionManager,
    stream: &str,
    consumer: &str,
) -> RedisResult<Vec<StreamId>> {
    let pending: StreamPendingCountReply = redis::cmd("XPENDING")
        .arg(stream)
        .arg(EMBEDS_GROUP)
        .arg("IDLE")
        .arg(CLAIM_IDLE_MS)
        .arg("-")
        .arg("+")
        .arg(16)
        .query_async(conn)
        .await?;
    let (dead, retry) = spent(pending.ids);
    if !dead.is_empty() {
        for job in &dead {
            warn!(
                "dropping embed job {} after {} deliveries",
                job.id, job.times_delivered
            );
        }
        let ids: Vec<&str> = dead.iter().map(|p| p.id.as_str()).collect();
        redis::pipe()
            .cmd("XACK")
            .arg(stream)
            .arg(EMBEDS_GROUP)
            .arg(&ids)
            .ignore()
            .cmd("XDEL")
            .arg(stream)
            .arg(&ids)
            .ignore()
            .query_async::<()>(conn)
            .await?;
    }
    if retry.is_empty() {
        return Ok(Vec::new());
    }
    let ids: Vec<&str> = retry.iter().map(|p| p.id.as_str()).collect();
    let claimed: StreamClaimReply = redis::cmd("XCLAIM")
        .arg(stream)
        .arg(EMBEDS_GROUP)
        .arg(consumer)
        .arg(CLAIM_IDLE_MS)
        .arg(&ids)
        .query_async(conn)
        .await?;
    Ok(claimed.ids)
}

async fn prune_consumers(
    conn: &mut ConnectionManager,
    stream: &str,
    consumer: &str,
) -> RedisResult<()> {
    let info: StreamInfoConsumersReply = redis::cmd("XINFO")
        .arg("CONSUMERS")
        .arg(stream)
        .arg(EMBEDS_GROUP)
        .query_async(conn)
        .await?;
    for name in idle_consumers(&info.consumers, consumer) {
        redis::cmd("XGROUP")
            .arg("DELCONSUMER")
            .arg(stream)
            .arg(EMBEDS_GROUP)
            .arg(&name)
            .query_async::<i64>(conn)
            .await?;
        info!("Removed idle embeds consumer {name}");
    }
    Ok(())
}

async fn embeds_worker(
    state: AppState,
    frames: Arc<Frames>,
    mut conn: ConnectionManager,
    stream: String,
    consumer: String,
) {
    let mut grouped = false;
    let mut claimed_at: Option<Instant> = None;
    loop {
        if !grouped {
            let made: RedisResult<()> = redis::cmd("XGROUP")
                .arg("CREATE")
                .arg(&stream)
                .arg(EMBEDS_GROUP)
                .arg("0")
                .arg("MKSTREAM")
                .query_async(&mut conn)
                .await;
            match made {
                Ok(()) => grouped = true,
                Err(e) if e.code() == Some("BUSYGROUP") => grouped = true,
                Err(e) => {
                    warn!("embeds queue group not ready: {e}");
                    tokio::time::sleep(Duration::from_secs(2)).await;
                    continue;
                }
            }
        }
        let mut batch: Vec<StreamId> = Vec::new();
        if claimed_at.is_none_or(|t| t.elapsed() >= CLAIM_EVERY) {
            claimed_at = Some(Instant::now());
            match reclaim(&mut conn, &stream, &consumer).await {
                Ok(claimed) => batch = claimed,
                Err(e) => warn!("embeds queue reclaim failed: {e}"),
            }
            if let Err(e) = prune_consumers(&mut conn, &stream, &consumer).await {
                warn!("embeds consumer cleanup failed: {e}");
            }
        }
        if batch.is_empty() {
            let read: RedisResult<Option<StreamReadReply>> = redis::cmd("XREADGROUP")
                .arg("GROUP")
                .arg(EMBEDS_GROUP)
                .arg(&consumer)
                .arg("COUNT")
                .arg(8)
                .arg("BLOCK")
                .arg(BLOCK_MS)
                .arg("STREAMS")
                .arg(&stream)
                .arg(">")
                .query_async(&mut conn)
                .await;
            match read {
                Ok(reply) => batch = entries(reply),
                Err(e) => {
                    if e.code() == Some("NOGROUP") {
                        grouped = false;
                    }
                    warn!("embeds queue read failed: {e}");
                    tokio::time::sleep(Duration::from_secs(1)).await;
                    continue;
                }
            }
        }
        let mut jobs = JoinSet::new();
        for entry in batch {
            let (state, frames) = (state.clone(), frames.clone());
            jobs.spawn(async move {
                match entry_text(&frames, Stream::Jobs, &entry, "job").await {
                    Ok(raw) => match serde_json::from_str::<UnfurlJob>(&raw) {
                        Ok(job) => unfurl(&state, job).await,
                        Err(e) => warn!("dropping malformed embed job {}: {e}", entry.id),
                    },
                    Err(e) if entry.contains_key(SEALED) => {
                        warn!(
                            "embed job {} does not open here, left for a retry: {e}",
                            entry.id
                        );
                        return None;
                    }
                    Err(e) => warn!("dropping embed job {}: {e}", entry.id),
                }
                Some(entry.id)
            });
        }
        while let Some(done) = jobs.join_next().await {
            if let Ok(Some(id)) = done {
                let acked: RedisResult<()> = redis::pipe()
                    .cmd("XACK")
                    .arg(&stream)
                    .arg(EMBEDS_GROUP)
                    .arg(&id)
                    .ignore()
                    .cmd("XDEL")
                    .arg(&stream)
                    .arg(&id)
                    .ignore()
                    .query_async(&mut conn)
                    .await;
                if let Err(e) = acked {
                    warn!("embed job {id} not acknowledged: {e}");
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hub::{Aftermath, Op};
    use crate::ws::WsEvent;

    fn env(origin: u32, seq: u64, op: Op) -> Envelope {
        Envelope { origin, seq, op }
    }

    fn viewing(user: &str, conn: u64, server: &str) -> Op {
        Op::Viewing {
            user: user.to_string(),
            conn,
            old: None,
            new: Some(server.to_string()),
        }
    }

    async fn settle() {
        for _ in 0..8 {
            tokio::task::yield_now().await;
        }
    }

    #[test]
    fn snapshot_retries_back_off_to_a_cap() {
        assert_eq!(snapshot_backoff(0), TICK);
        assert_eq!(snapshot_backoff(1), TICK * 2);
        assert_eq!(snapshot_backoff(3), TICK * 8);
        assert_eq!(snapshot_backoff(30), SNAPSHOT_BACKOFF_CAP);
    }

    #[test]
    fn live_boundary() {
        assert!(is_live("5-0", None));
        assert!(!is_live("5-0", Some("5-0")));
        assert!(!is_live("4-9", Some("5-0")));
        assert!(is_live("5-1", Some("5-0")));
        assert!(is_live("10-0", Some("9-5")));
        assert!(reached("5-0", Some("5-0")));
        assert!(!reached("4-9", Some("5-0")));
        assert!(reached(START, None));
        assert!(!reached(START, Some("1-0")));
    }

    #[test]
    fn gap_detection() {
        assert!(continuous(START, false));
        assert!(continuous("7-0", true));
        assert!(!continuous("7-0", false));
    }

    #[test]
    fn snapshot_selection() {
        assert_eq!(resume("7-0", true, Some("9-0"), true, 0), Resume::Snapshot);
        assert_eq!(resume("7-0", true, Some("3-0"), false, 0), Resume::Snapshot);
        assert_eq!(resume("7-0", false, None, false, 0), Resume::Replay);
        assert_eq!(resume("7-0", false, Some("3-0"), true, 0), Resume::Replay);
        assert_eq!(resume("7-0", false, Some("9-0"), false, 0), Resume::Replay);
        assert_eq!(resume("7-0", false, Some("9-0"), true, 0), Resume::Wait);
        assert_eq!(
            resume("7-0", false, Some("9-0"), true, SNAPSHOT_WAITS - 1),
            Resume::Wait
        );
        assert_eq!(
            resume("7-0", false, Some("9-0"), true, SNAPSHOT_WAITS),
            Resume::Replay
        );
        assert_eq!(resume(START, false, Some("9-0"), false, 0), Resume::Replay);
        assert_eq!(resume(START, false, Some("9-0"), true, 0), Resume::Wait);
    }

    #[test]
    fn publish_batch_is_capped() {
        let log = Log {
            stream: "p:hub".to_string(),
            snapshot: "p:hub:snapshot".to_string(),
            maxlen: 4242,
            frames: Arc::new(Frames::plain()),
        };
        let batch = [env(1, 1, Op::Heartbeat), env(1, 2, Op::Heartbeat)];
        let packed =
            String::from_utf8_lossy(&xadd_batch(&log, &batch).get_packed_pipeline()).into_owned();
        assert_eq!(packed.matches("XADD").count(), 2);
        assert_eq!(packed.matches("\r\n4242\r\n").count(), 2);
        assert!(packed.contains("\"seq\":2"));
    }

    #[tokio::test]
    async fn frames_are_published_sealed_once_decided_and_read_either_way() {
        let path = crate::db::temp_db_path("bus_sealed_frames");
        let _ = std::fs::remove_file(&path);
        let db = crate::db::open_keyed(path.to_str()).await.expect("open db");
        let frames = Arc::new(Frames::new(crate::db::ring(&db), db.clone()));
        let log = Log {
            stream: "p:hub".to_string(),
            snapshot: "p:hub:snapshot".to_string(),
            maxlen: 4242,
            frames: frames.clone(),
        };
        let batch = [env(1, 1, viewing("alice", 1, "rchat"))];
        let packed = |log: &Log| {
            String::from_utf8_lossy(&xadd_batch(log, &batch).get_packed_pipeline()).into_owned()
        };
        let plain = packed(&log);
        assert!(plain.contains("\r\nop\r\n") && plain.contains("alice"));
        assert!(frames.decide(&[]).await.expect("decide"));
        let sealed = packed(&log);
        assert!(sealed.contains("\r\nsealed\r\n"));
        assert!(!sealed.contains("alice") && !sealed.contains("\r\nop\r\n"));
        let json = to_bus_json(&batch[0]).expect("json");
        let entry = |field: &str, value: Vec<u8>| StreamId {
            id: "1-0".to_string(),
            map: HashMap::from([(field.to_string(), redis::Value::BulkString(value))]),
            ..StreamId::default()
        };
        let record = frames
            .seal(Stream::Hub, "", json.as_bytes())
            .expect("sealed");
        for read in [
            entry("op", json.clone().into_bytes()),
            entry(SEALED, record.clone()),
        ] {
            let text = entry_text(&frames, Stream::Hub, &read, "op").await;
            assert_eq!(text.as_deref(), Ok(json.as_str()));
        }
        let jobs = entry_text(&frames, Stream::Jobs, &entry(SEALED, record), "job").await;
        assert!(jobs.is_err(), "a hub frame is not a job");
        let other = entry_text(&frames, Stream::Hub, &entry("x", b"{}".to_vec()), "op").await;
        assert_eq!(other, Err("without op".to_string()));
        crate::db::close(&db).await;
        let _ = std::fs::remove_file(path);
    }

    #[tokio::test]
    async fn a_switch_to_plain_frames_writes_the_snapshot_and_asks_for_connections_again() {
        let path = crate::db::temp_db_path("bus_frames_switch");
        let _ = std::fs::remove_file(&path);
        let db = crate::db::open_keyed(path.to_str()).await.expect("open db");
        let frames = Frames::new(crate::db::ring(&db), db.clone());
        let (hub, mut out) = Hub::replicated();
        let copy = |seq: u64, bus: bool| {
            let op = Op::Copy {
                build: "0".to_string(),
                seal: true,
                bus,
                keks: vec!["k1".to_string()],
            };
            env(hub.instance().wrapping_add(1), seq, op)
        };
        hub.ingest("1-0", copy(1, true), true);
        assert_eq!(decide_frames(&hub, &frames).await, None, "not ready yet");
        assert!(!frames.sealed());
        hub.set_publishing(true);
        hub.set_following(true);
        hub.set_caught_up(true);
        assert_eq!(decide_frames(&hub, &frames).await, Some(true));
        assert!(
            out.try_recv().is_err(),
            "sealing asks nothing of the others"
        );
        hub.ingest("2-0", copy(2, false), true);
        let _ = hub.snapshot_state(true);
        assert!(hub.snapshot_state(false).is_none());
        assert_eq!(decide_frames(&hub, &frames).await, Some(false));
        assert!(
            hub.snapshot_state(false).is_some(),
            "the snapshot is written again"
        );
        assert!(matches!(out.try_recv().map(|e| e.op), Ok(Op::Reannounce)));
        assert_eq!(decide_frames(&hub, &frames).await, Some(false));
        assert!(out.try_recv().is_err(), "once per switch");
        hub.ingest("3-0", copy(3, true), true);
        assert_eq!(decide_frames(&hub, &frames).await, Some(true));
        crate::db::close(&db).await;
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn delivery_cap_and_idle_consumers() {
        let pending = |id: &str, times: usize| StreamPendingId {
            id: id.to_string(),
            consumer: "c".to_string(),
            last_delivered_ms: 70_000,
            times_delivered: times,
        };
        let (dead, retry) = spent(vec![
            pending("1-0", 1),
            pending("2-0", 3),
            pending("3-0", 9),
        ]);
        assert_eq!(
            dead.iter().map(|p| p.id.as_str()).collect::<Vec<_>>(),
            vec!["2-0", "3-0"]
        );
        assert_eq!(retry.len(), 1);
        let consumer = |name: &str, pending: usize, idle: usize| StreamInfoConsumer {
            name: name.to_string(),
            pending,
            idle,
        };
        let all = [
            consumer("me", 0, CONSUMER_IDLE_MS * 2),
            consumer("gone", 0, CONSUMER_IDLE_MS),
            consumer("busy", 2, CONSUMER_IDLE_MS * 2),
            consumer("fresh", 0, 1_000),
        ];
        assert_eq!(idle_consumers(&all, "me"), vec!["gone".to_string()]);
    }

    #[tokio::test]
    async fn publisher_retry_is_deduplicated() {
        let (a, mut out) = Hub::replicated();
        let (b, _) = Hub::replicated();
        let me = a.instance();
        let conn = a.next_conn();
        a.set_online("alice", conn, &["rchat"]);
        a.broadcast(crate::ws::WsEvent::RolesChanged {
            server: "rchat".to_string(),
        });
        let first = out.try_recv().unwrap();
        let second = out.try_recv().unwrap();
        assert_eq!((first.origin, first.seq, second.seq), (me, 1, 2));
        let json = |e: &Envelope| to_bus_json(e).unwrap();
        let log = [
            ("10-0", json(&first)),
            ("11-0", json(&first)),
            ("11-1", json(&second)),
        ];
        let mut rx = b.subscribe();
        for (id, raw) in &log {
            b.ingest(id, serde_json::from_str(raw).unwrap(), true);
        }
        let mut seen = Vec::new();
        while let Ok(ev) = rx.try_recv() {
            seen.push(ev);
        }
        assert_eq!(seen.len(), 2);
        assert!(b.is_online("rchat", "alice"));
    }

    #[tokio::test]
    async fn lost_own_op_resolves_waiters() {
        let (hub, mut out) = Hub::replicated();
        let conn = hub.next_conn();
        let joining = {
            let hub = hub.clone();
            tokio::spawn(async move { hub.voice_join("alice", conn, "rchat", 5).await })
        };
        settle().await;
        let join = out.try_recv().unwrap();
        assert_eq!(join.seq, 1);
        hub.heartbeat();
        let beat = out.try_recv().unwrap();
        let epoch = hub.epoch();
        hub.ingest("20-0", beat, true);
        assert!(joining.await.unwrap().is_empty());
        assert!(hub.rooms_in("rchat", None).is_empty());
        assert!(epoch.has_changed().unwrap());
        hub.ingest("20-1", join, true);
        assert!(hub.rooms_in("rchat", None).is_empty());
    }

    #[tokio::test]
    async fn lost_cleanup_is_posted_again() {
        let (a, mut out) = Hub::replicated();
        let (b, _) = Hub::replicated();
        let conn = a.next_conn();
        let mut n = 0;
        let mut deliver = |env: Envelope| {
            n += 1;
            let id = format!("30-{n}");
            let raw = to_bus_json(&env).unwrap();
            a.ingest(&id, serde_json::from_str(&raw).unwrap(), true);
            b.ingest(&id, serde_json::from_str(&raw).unwrap(), true);
        };
        a.set_online("alice", conn, &["rchat"]);
        a.set_p2p("alice", conn, "peer".to_string(), vec!["f".to_string()]);
        deliver(out.try_recv().unwrap());
        deliver(out.try_recv().unwrap());
        assert!(b.is_online("rchat", "alice") && b.p2p_of("alice").is_some());
        let dropping = {
            let a = a.clone();
            tokio::spawn(async move { a.drop_conn("alice", conn).await })
        };
        settle().await;
        let lost = out.try_recv().unwrap();
        assert!(matches!(lost.op, Op::DropConn { .. }));
        a.heartbeat();
        deliver(out.try_recv().unwrap());
        settle().await;
        let again = out.try_recv().unwrap();
        assert!(matches!(again.op, Op::DropConn { .. }) && again.seq > lost.seq);
        assert!(b.is_online("rchat", "alice"));
        deliver(again);
        let (ends, drop) = dropping.await.unwrap();
        assert!(ends.is_empty());
        assert!(matches!(drop, crate::hub::P2pDrop::Offline));
        assert!(!b.is_online_anywhere("alice") && b.p2p_of("alice").is_none());
        assert!(!a.is_online_anywhere("alice") && a.is_online("rchat", "alice"));
    }

    fn deliver_to(hubs: Vec<Hub>, prefix: &'static str) -> impl FnMut(Envelope) {
        let mut n = 0;
        move |env: Envelope| {
            n += 1;
            let id = format!("{prefix}-{n}");
            let raw = to_bus_json(&env).unwrap();
            for hub in &hubs {
                hub.ingest(&id, serde_json::from_str(&raw).unwrap(), true);
            }
        }
    }

    fn availability(hoster: &str, online: bool) -> WsEvent {
        WsEvent::P2pAvailability {
            hoster: hoster.to_string(),
            peer_id: online.then(|| "peer".to_string()),
            ids: Vec::new(),
            online,
            scope_servers: Vec::new(),
            scope_users: Vec::new(),
        }
    }

    fn take_reposts(aftermath: &mut crate::hub::Feed<Aftermath>) -> Vec<Op> {
        let mut ops = Vec::new();
        while let Ok(job) = aftermath.try_recv() {
            if let Aftermath::Repost(lost) = job {
                ops.extend(lost);
            }
        }
        ops
    }

    #[tokio::test]
    async fn lost_ops_go_to_the_aftermath() {
        let (a, mut out) = Hub::replicated();
        let (b, _) = Hub::replicated();
        let mut aftermath = a.take_aftermath().unwrap();
        let mut epoch = a.epoch();
        let mut rx = b.subscribe();
        let mut deliver = deliver_to(vec![a.clone(), b.clone()], "60");
        deliver(env(9, 1, viewing("bob", 9 << 32, "rchat")));
        deliver(env(9, 2, viewing("carol", (9 << 32) | 1, "rchat")));
        a.broadcast(WsEvent::Banned {
            username: "bob".to_string(),
        });
        a.force_offline("rchat", "carol");
        a.broadcast(availability("erin", true));
        a.broadcast(availability("frank", true));
        a.set_online("alice", a.next_conn(), &["rchat"]);
        a.broadcast(WsEvent::RolesChanged {
            server: "rchat".to_string(),
        });
        for _ in 1..=6 {
            out.try_recv().unwrap();
        }
        a.broadcast(availability("erin", false));
        let applied = out.try_recv().unwrap();
        a.broadcast(availability("frank", false));
        let pending = out.try_recv().unwrap();
        deliver(applied);
        assert!(epoch.has_changed().unwrap());
        assert_eq!(epoch.borrow_and_update().lossy, 0);
        assert!(out.try_recv().is_err());
        let lost = take_reposts(&mut aftermath);
        let kinds: Vec<String> = lost
            .iter()
            .map(|op| match op {
                Op::Broadcast { event } => to_bus_json(event).unwrap(),
                Op::ForceOffline { server, user } => format!("force_offline {server} {user}"),
                _ => "other".to_string(),
            })
            .collect();
        assert_eq!(kinds.len(), 3, "{kinds:?}");
        assert!(kinds[0].contains("\"banned\"") && kinds[0].contains("\"bob\""));
        assert_eq!(kinds[1], "force_offline rchat carol");
        assert!(kinds[2].contains("\"roles_changed\""));
        deliver(pending);
        for op in lost {
            match op {
                Op::Broadcast { event } => a.broadcast(event),
                Op::ForceOffline { server, user } => a.force_offline(&server, &user),
                _ => {}
            }
        }
        let again: Vec<Envelope> = std::iter::from_fn(|| out.try_recv().ok()).collect();
        assert_eq!(again.len(), 3);
        let first = again[0].clone();
        for env in again {
            deliver(env);
        }
        deliver(first);
        let seen: Vec<String> = std::iter::from_fn(|| rx.try_recv().ok())
            .map(|ev| to_bus_json(&ev).unwrap())
            .collect();
        let count = |needle: &str| seen.iter().filter(|e| e.contains(needle)).count();
        assert_eq!(count("\"type\":\"banned\""), 1);
        assert_eq!(count("\"type\":\"roles_changed\""), 1);
        assert_eq!(count("\"online\":true,\"scope"), 0);
        assert_eq!(count("\"hoster\":\"erin\""), 1);
        assert_eq!(count("\"hoster\":\"frank\""), 1);
        assert!(!b.is_online("rchat", "bob") && !a.is_online("rchat", "bob"));
        assert!(!b.is_online("rchat", "carol") && !b.is_online("rchat", "alice"));
        assert!(take_reposts(&mut aftermath).is_empty());
        assert!(!epoch.has_changed().unwrap());
    }

    #[tokio::test]
    async fn lost_availability_lands_before_newer_ones() {
        let (a, mut out) = Hub::replicated();
        let (b, _) = Hub::replicated();
        let mut aftermath = a.take_aftermath().unwrap();
        let mut rx = b.subscribe();
        let mut deliver = deliver_to(vec![a.clone(), b.clone()], "62");
        a.broadcast(availability("erin", true));
        let lost = out.try_recv().unwrap();
        a.heartbeat();
        deliver(out.try_recv().unwrap());
        a.broadcast(availability("erin", false));
        let posted: Vec<Envelope> = std::iter::from_fn(|| out.try_recv().ok()).collect();
        assert!(take_reposts(&mut aftermath).is_empty());
        let online: Vec<bool> = posted
            .iter()
            .map(|env| match &env.op {
                Op::Broadcast {
                    event: WsEvent::P2pAvailability { online, .. },
                } => *online,
                _ => panic!("expected only P2P availability"),
            })
            .collect();
        assert_eq!(online, vec![true, false]);
        assert!(posted[0].seq > lost.seq && posted[1].seq > posted[0].seq);
        for env in posted {
            deliver(env);
        }
        let last = std::iter::from_fn(|| rx.try_recv().ok())
            .filter_map(|ev| match ev {
                WsEvent::P2pAvailability { online, .. } => Some(online),
                _ => None,
            })
            .last();
        assert_eq!(last, Some(false));
    }

    #[tokio::test]
    async fn lost_voice_leave_is_posted_until_applied() {
        let (a, mut out) = Hub::replicated();
        let (b, _) = Hub::replicated();
        let mut deliver = deliver_to(vec![a.clone(), b.clone()], "65");
        let (alice, tab) = (a.next_conn(), a.next_conn());
        let join = |conn: u64, channel_id: i64| {
            let a = a.clone();
            tokio::spawn(async move { a.voice_join("alice", conn, "rchat", channel_id).await })
        };
        let joining = join(alice, 5);
        settle().await;
        deliver(out.try_recv().unwrap());
        joining.await.unwrap();
        assert_eq!(
            b.rooms_in("rchat", None),
            vec![(5, vec!["alice".to_string()])]
        );
        let leaving = {
            let a = a.clone();
            tokio::spawn(async move { a.voice_leave("alice").await })
        };
        settle().await;
        let lost_leave = out.try_recv().unwrap();
        let calling = {
            let a = a.clone();
            let dm_users = vec!["alice".to_string(), "alice".to_string()];
            tokio::spawn(async move {
                a.call_start(
                    "alice",
                    tab,
                    9,
                    dm_users,
                    crate::ws::CallKind::Rtc,
                    false,
                    70,
                    None,
                )
                .await
            })
        };
        settle().await;
        let call = out.try_recv().unwrap();
        let rejoining = join(tab, 6);
        settle().await;
        let lost_join = out.try_recv().unwrap();
        assert!(lost_leave.seq < call.seq && call.seq < lost_join.seq);
        deliver(call);
        assert_eq!(
            calling.await.unwrap(),
            Err("Cannot call yourself".to_string())
        );
        settle().await;
        let again = out.try_recv().unwrap();
        assert!(matches!(&again.op, Op::VoiceLeave { user } if user == "alice"));
        assert!(again.seq > lost_join.seq);
        deliver(again);
        assert!(rejoining.await.unwrap().is_empty());
        leaving.await.unwrap();
        for hub in [&a, &b] {
            assert!(hub.rooms_in("rchat", None).is_empty());
        }
    }

    #[tokio::test]
    async fn reset_keeps_new_entries_live() {
        assert_eq!(
            reset_boundary("7-0", Some("9-0".to_string())),
            Some("7-0".to_string())
        );
        assert_eq!(
            reset_boundary("7-0", Some("3-0".to_string())),
            Some("3-0".to_string())
        );
        assert_eq!(reset_boundary("7-0", None), None);
        let (hub, _) = Hub::replicated();
        let mut rx = hub.subscribe();
        let before = [
            ("6-0", env(9, 1, viewing("bob", 9 << 32, "rchat"))),
            ("7-0", env(9, 2, viewing("dave", (9 << 32) | 2, "rchat"))),
        ];
        for (id, e) in before.clone() {
            hub.ingest(id, e, true);
        }
        while rx.try_recv().is_ok() {}
        let boundary = reset_boundary("7-0", Some("9-0".to_string()));
        let reset = [
            ("8-0", env(9, 3, viewing("carol", (9 << 32) | 1, "rchat"))),
            (
                "9-0",
                env(
                    9,
                    4,
                    Op::Broadcast {
                        event: WsEvent::RolesChanged {
                            server: "rchat".to_string(),
                        },
                    },
                ),
            ),
        ];
        for (id, e) in reset {
            hub.ingest(id, e, is_live(id, boundary.as_deref()));
        }
        let mut seen = Vec::new();
        while let Ok(ev) = rx.try_recv() {
            seen.push(to_bus_json(&ev).unwrap());
        }
        assert_eq!(seen.len(), 2, "{seen:?}");
        assert!(seen[0].contains("\"carol\"") && seen[0].contains("\"online\":true"));
        assert!(seen[1].contains("\"roles_changed\""));
        let rolled = reset_boundary("7-0", Some("7-0".to_string()));
        for (id, e) in before {
            hub.ingest(id, e, is_live(id, rolled.as_deref()));
        }
        assert!(rx.try_recv().is_err());
        assert!(hub.is_online("rchat", "bob") && hub.is_online("rchat", "carol"));
    }

    async fn drop_seen_only_in_snapshot(lose_drop: bool, legacy_snapshot: bool) {
        let (a, mut out) = Hub::replicated();
        let (b, _) = Hub::replicated();
        let mut deliver = deliver_to(vec![a.clone(), b.clone()], "70");
        let alice = a.next_conn();
        let bob = 9 << 32;
        a.set_online("alice", alice, &["rchat"]);
        a.set_p2p("alice", alice, "peer".to_string(), vec!["f".to_string()]);
        deliver(out.try_recv().unwrap());
        deliver(out.try_recv().unwrap());
        let calling = {
            let a = a.clone();
            tokio::spawn(async move {
                a.call_start(
                    "alice",
                    alice,
                    3,
                    vec!["alice".into(), "bob".into()],
                    crate::ws::CallKind::Rtc,
                    false,
                    70,
                    None,
                )
                .await
            })
        };
        settle().await;
        deliver(out.try_recv().unwrap());
        calling.await.unwrap().unwrap();
        let accept = Op::CallAccept {
            user: "bob".to_string(),
            conn: bob,
            dm_id: 3,
            peer_id: None,
            relays: Vec::new(),
        };
        deliver(env(9, 1, accept));
        assert!(b.rtc_shared("alice", "bob", None, Some(3)));
        let dropping = {
            let a = a.clone();
            tokio::spawn(async move { a.drop_conn("alice", alice).await })
        };
        settle().await;
        let drop = out.try_recv().unwrap();
        assert!(matches!(drop.op, Op::DropConn { .. }));
        match lose_drop {
            true => {
                a.heartbeat();
                let beat = out.try_recv().unwrap();
                b.ingest("71-0", beat, true);
                assert!(b.is_online("rchat", "alice"));
            }
            false => {
                b.ingest("71-0", drop, true);
                assert!(!b.is_online_anywhere("alice"));
            }
        }
        let (id, mut json) = b.snapshot().unwrap();
        if legacy_snapshot {
            let mut state: serde_json::Value = serde_json::from_str(&json).unwrap();
            for peer in state["peers"].as_object_mut().unwrap().values_mut() {
                peer.as_object_mut().unwrap().remove("gaps");
            }
            json = state.to_string();
        }
        a.restore(&id, &json).unwrap();
        if lose_drop {
            settle().await;
            let again = out.try_recv().unwrap();
            assert!(matches!(again.op, Op::DropConn { .. }));
            deliver(again);
        }
        let (ends, drop) = dropping.await.unwrap();
        assert_eq!(ends.len(), 1);
        assert!(ends[0].log_id == 70 && ends[0].answered);
        assert!(matches!(drop, crate::hub::P2pDrop::Offline));
        for hub in [&a, &b] {
            assert!(!hub.is_online_anywhere("alice"));
            assert!(hub.p2p_of("alice").is_none());
            assert!(!hub.rtc_shared("alice", "bob", None, Some(3)));
        }
    }

    #[tokio::test]
    async fn restore_finishes_applied_drop() {
        drop_seen_only_in_snapshot(false, false).await;
    }

    #[tokio::test]
    async fn restore_posts_lost_drop_again() {
        drop_seen_only_in_snapshot(true, false).await;
        drop_seen_only_in_snapshot(true, true).await;
    }

    #[tokio::test]
    async fn readiness_tracks_publisher_and_follower() {
        let (hub, _out) = Hub::replicated();
        assert!(!hub.ready());
        hub.set_following(true);
        hub.set_caught_up(true);
        assert!(!hub.ready());
        hub.set_publishing(true);
        assert!(hub.ready());
        hub.set_publishing(false);
        assert!(!hub.ready());
        hub.set_publishing(true);
        hub.set_diverged(true);
        assert!(!hub.ready());
        hub.set_diverged(false);
        hub.set_following(false);
        assert!(!hub.ready());
    }

    #[tokio::test]
    async fn diverged_replica_never_snapshots() {
        let (hub, _out) = Hub::replicated();
        hub.ingest("40-0", env(9, 1, viewing("bob", 9 << 32, "rchat")), false);
        let (id, json) = hub.snapshot().unwrap();
        assert_eq!(id, "40-0");
        hub.set_diverged(true);
        assert!(hub.snapshot().is_none());
        let (fresh, _) = Hub::replicated();
        fresh.restore(&id, &json).unwrap();
        assert!(fresh.is_online("rchat", "bob"));
        hub.set_diverged(false);
        assert_eq!(hub.snapshot().unwrap().1, fresh.snapshot().unwrap().1);
    }

    #[tokio::test]
    async fn restore_settles_applied_waiters() {
        let (a, mut out) = Hub::replicated();
        let (b, _) = Hub::replicated();
        let conn = a.next_conn();
        let joining = {
            let a = a.clone();
            tokio::spawn(async move { a.voice_join("alice", conn, "rchat", 5).await })
        };
        settle().await;
        let join = out.try_recv().unwrap();
        b.ingest("50-0", join, true);
        let (id, json) = b.snapshot().unwrap();
        a.restore(&id, &json).unwrap();
        assert!(joining.await.unwrap().is_empty());
        assert_eq!(
            a.rooms_in("rchat", None),
            vec![(5, vec!["alice".to_string()])]
        );
    }

    async fn until(what: &str, check: impl Fn() -> bool) {
        let started = Instant::now();
        while !check() {
            assert!(
                started.elapsed() < Duration::from_secs(20),
                "timed out: {what}"
            );
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    #[tokio::test]
    #[ignore = "needs a Redis-protocol server at REDIS_URL"]
    async fn redis_round_trip() {
        let Some(url) = crate::config::test_env("REDIS_URL") else {
            return;
        };
        let prefix = format!("rchat-test-{:08x}", rand::random::<u32>());
        let plain = || Arc::new(Frames::plain());
        let (a, bus) = connect(&url, &prefix, DEFAULT_HUB_MAXLEN, Roles::ALL, plain())
            .await
            .unwrap();
        let (b, _) = connect(&url, &prefix, DEFAULT_HUB_MAXLEN, Roles::ALL, plain())
            .await
            .unwrap();
        until("both ready", || a.ready() && b.ready()).await;
        let alice = a.next_conn();
        a.set_online("alice", alice, &["rchat"]);
        until("presence reaches b", || b.is_online("rchat", "alice")).await;
        let mut conn = bus.conn.clone();
        let snapshot_key = format!("{prefix}:hub:snapshot");
        let started = Instant::now();
        loop {
            let id: Option<String> = redis::cmd("HGET")
                .arg(&snapshot_key)
                .arg("id")
                .query_async(&mut conn)
                .await
                .unwrap();
            if id.is_some() {
                break;
            }
            assert!(started.elapsed() < Duration::from_secs(20), "no snapshot");
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
        let stale: i64 = redis::cmd("EVAL")
            .arg(SAVE_SNAPSHOT)
            .arg(1)
            .arg(&snapshot_key)
            .arg("1-0")
            .arg("{}")
            .query_async(&mut conn)
            .await
            .unwrap();
        assert_eq!(stale, 0);
        let mut rx = a.subscribe();
        let _: i64 = redis::cmd("DEL")
            .arg(format!("{prefix}:hub"))
            .query_async(&mut conn)
            .await
            .unwrap();
        let bob = b.next_conn();
        b.set_online("bob", bob, &["rchat"]);
        until("presence after reset", || a.is_online("rchat", "bob")).await;
        until("ready after reset", || a.ready() && b.ready()).await;
        let mut live = false;
        while let Ok(ev) = rx.try_recv() {
            live |= matches!(&ev, WsEvent::PresenceChanged { username, online: true, .. } if username == "bob");
        }
        assert!(
            live,
            "an entry posted after the reset never reached a's connections"
        );
        assert!(a.is_online("rchat", "alice") && b.is_online("rchat", "alice"));
        let (ends, _) = a.drop_conn("alice", alice).await;
        assert!(ends.is_empty());
        until("drop reaches b", || !b.is_online("rchat", "alice")).await;
        let keys: Vec<String> = redis::cmd("KEYS")
            .arg(format!("{prefix}:*"))
            .query_async(&mut conn)
            .await
            .unwrap();
        if !keys.is_empty() {
            let _: i64 = redis::cmd("DEL")
                .arg(&keys)
                .query_async(&mut conn)
                .await
                .unwrap();
        }
    }

    #[tokio::test]
    #[ignore = "needs a Redis-protocol server at REDIS_URL"]
    async fn sealed_frames_round_trip() {
        let Some(url) = crate::config::test_env("REDIS_URL") else {
            return;
        };
        let path = crate::db::temp_db_path("bus_sealed_round_trip");
        let _ = std::fs::remove_file(&path);
        let db = crate::db::open_keyed(path.to_str()).await.unwrap();
        let prefix = format!("rchat-test-{:08x}", rand::random::<u32>());
        let keyed = || Arc::new(Frames::new(crate::db::keyed_ring(), db.clone()));
        let (fa, fb) = (keyed(), keyed());
        let (a, bus) = connect(&url, &prefix, DEFAULT_HUB_MAXLEN, Roles::ALL, fa.clone())
            .await
            .unwrap();
        let (b, _) = connect(&url, &prefix, DEFAULT_HUB_MAXLEN, Roles::ALL, fb.clone())
            .await
            .unwrap();
        until("both seal their frames", || fa.sealed() && fb.sealed()).await;
        let alice = a.next_conn();
        a.set_online("alice", alice, &["rchat"]);
        let mut epoch = a.epoch();
        let again = a.clone();
        tokio::spawn(async move {
            while epoch.changed().await.is_ok() {
                again.set_online("alice", alice, &["rchat"]);
            }
        });
        until("sealed presence reaches b", || {
            b.is_online("rchat", "alice")
        })
        .await;
        let job: UnfurlJob = serde_json::from_value(serde_json::json!({
            "server": "rchat", "channel_id": 1, "dm_id": null, "dm_users": null,
            "message_id": 7, "urls": ["https://example.com/hidden-path"]
        }))
        .unwrap();
        bus.enqueue_unfurl(&job).await.unwrap();
        let mut conn = bus.conn.clone();
        let reader = bus.conn.clone();
        let range = |key: String| {
            let mut conn = reader.clone();
            async move {
                let reply: StreamRangeReply = redis::cmd("XRANGE")
                    .arg(key)
                    .arg("-")
                    .arg("+")
                    .query_async(&mut conn)
                    .await
                    .unwrap();
                reply.ids
            }
        };
        let hub_entries = range(format!("{prefix}:hub")).await;
        assert!(hub_entries.iter().any(|e| e.contains_key(SEALED)));
        for entry in &hub_entries {
            if let Some(op) = entry.get::<String>("op") {
                assert!(!op.contains("alice"), "a plain entry after sealing: {op}");
            }
        }
        let jobs = range(format!("{prefix}:embeds")).await;
        let [queued] = &jobs[..] else {
            panic!("one job: {jobs:?}");
        };
        assert!(queued.get::<String>("job").is_none());
        let opened = entry_text(&fb, Stream::Jobs, queued, "job").await.unwrap();
        assert!(opened.contains("hidden-path"));
        let snapshot_key = format!("{prefix}:hub:snapshot");
        let started = Instant::now();
        let snapshot_id = loop {
            let (id, state): (Option<String>, Option<Vec<u8>>) = redis::pipe()
                .cmd("HGET")
                .arg(&snapshot_key)
                .arg("id")
                .cmd("HGET")
                .arg(&snapshot_key)
                .arg("state")
                .query_async(&mut conn)
                .await
                .unwrap();
            match (id, state) {
                (Some(id), Some(state))
                    if crate::crypt::frames::is_sealed(&state)
                        && stream_pos(&id) > stream_pos(&hub_entries.last().unwrap().id) =>
                {
                    break id;
                }
                (_, _) => {}
            }
            assert!(
                started.elapsed() < Duration::from_secs(30),
                "no sealed snapshot after alice"
            );
            tokio::time::sleep(Duration::from_millis(200)).await;
        };
        let before: Vec<String> = range(format!("{prefix}:hub"))
            .await
            .into_iter()
            .map(|e| e.id)
            .filter(|id| stream_pos(id) < stream_pos(&snapshot_id))
            .collect();
        let _: i64 = redis::cmd("XDEL")
            .arg(format!("{prefix}:hub"))
            .arg(&before)
            .query_async(&mut conn)
            .await
            .unwrap();
        let (c, _) = connect(&url, &prefix, DEFAULT_HUB_MAXLEN, Roles::ALL, keyed())
            .await
            .unwrap();
        until(
            "a new copy reads alice from the sealed snapshot alone",
            || c.ready() && c.is_online("rchat", "alice"),
        )
        .await;
        let (d, _) = connect(
            &url,
            &prefix,
            DEFAULT_HUB_MAXLEN,
            Roles::ALL,
            Arc::new(Frames::plain()),
        )
        .await
        .unwrap();
        until("frames go plain once a copy can't open them", || {
            !fa.sealed() && !fb.sealed()
        })
        .await;
        until(
            "the copy that can't open them gets the state it skipped",
            || d.ready() && d.is_online("rchat", "alice"),
        )
        .await;
        let bob = b.next_conn();
        b.set_online("bob", bob, &["rchat"]);
        until("plain presence reaches it", || d.is_online("rchat", "bob")).await;
        let keys: Vec<String> = redis::cmd("KEYS")
            .arg(format!("{prefix}:*"))
            .query_async(&mut conn)
            .await
            .unwrap();
        if !keys.is_empty() {
            let _: i64 = redis::cmd("DEL")
                .arg(&keys)
                .query_async(&mut conn)
                .await
                .unwrap();
        }
        crate::db::close(&db).await;
        let _ = std::fs::remove_file(path);
    }
}
