import type { AclContent } from './acl/rules'

// Every P2P limit outside the wire and protocol constants. AGREED: what every replica of a server
// must use to admit and evaluate its ACL (spec 4.1; ts in ms). LOCAL: what one device may pick on
// its own. RANGES bound each LOCAL value by `section.key` (array items by `section.key.i`).

export interface Agreed {
  devCap: number
  w3: number
  w3mod: number
  win: number
  day: number
  freshCap: number
  idCap: number
  rotCap: number
  classes: number
  pendingPerDev: number
  codesPerDev: number
  codesPerDevServer: number
  roles: number
  totU: number
  rotTot: number
  poolU: number
  ap: number
  channels: number
  overwrites: number
  w4: number
}

const deepFreeze = <T>(x: T): T => {
  if (x && typeof x === 'object') {
    for (const v of Object.values(x)) deepFreeze(v)
    Object.freeze(x)
  }
  return x
}

export const AGREED: Readonly<Agreed> = Object.freeze({
  devCap: 8,
  w3: 60,
  w3mod: 600,
  win: 60 * 60_000,
  day: 24 * 60 * 60_000,
  freshCap: 2,
  idCap: 8,
  rotCap: 4,
  classes: 3,
  pendingPerDev: 20,
  codesPerDev: 20,
  codesPerDevServer: 100,
  roles: 250,
  totU: 24,
  rotTot: 4,
  poolU: 384,
  ap: 10,
  channels: 500,
  overwrites: 100,
  w4: 500,
})

export const agreedFrom = (genesis: AclContent): Agreed => {
  void genesis
  return AGREED
}

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const KIB = 1024
const MIB = 1024 * KIB
const GIB = 1024 * MIB

const DEFAULTS = {
  sync: {
    pushPerMin: 600,
    // Events pulled per session before older history waits for "Load older".
    horizon: 2000,
    // Servers: the ACL DAG comes whole (spec 4.2, no horizon), within a rate, so a peer can't flood
    // us through pulls.
    statePerMin: 2000,
    headsDebounceMs: 250,
    typingMs: 8000,
    // Delivery checks against the peer's heads walk at most this far.
    deliveredWalk: 500,
    // After the other side said its storage is full, live pushes pause this long.
    peerFullMs: 10 * MIN,
    // Heads asked for are answered at most this often per link.
    headsAnswerMs: 1000,
  },
  gossip: {
    perRoom: 8,
    outTarget: 4,
    resampleMs: 10 * MIN,
    tickMs: 5000,
    presenceMs: 20_000,
    presenceTtl: 60_000,
    typingMs: 8000,
    // Relayed typing: once per typer and channel this often at most, and per link this many
    // frames a second (in and out; the rest is dropped).
    typingRelayMs: 3000,
    typingPerSec: 5,
    // Members let in (who redeemed a code with us, or invited us) are linked first for this long.
    preferMs: 10 * MIN,
    preferMax: 4,
    // Candidates per room we ask for links at once, and members per room handed to the dialer
    // (it skips those that didn't answer lately, so it goes down the list).
    candidates: 16,
    dialList: 256,
    // After a busy answer, that member isn't asked for that room again for this long.
    busyMs: 2 * MIN,
    // An unanswered link request is given up after this long.
    askMs: 15_000,
    // Links of a room we left stay this long, for our last events and their acks.
    leaveMs: 3000,
    // Links of an archived server (an old copy after an upgrade).
    archivePerRoom: 2,
    archiveOutTarget: 1,
  },
  node: {
    sessions: 48,
    // Of those, sessions with identities that aren't mutual contacts (P2P server members): they
    // never push out a contact's session.
    memberSessions: 32,
    // Incoming connections still in their handshake (unauthenticated): a pool of their own, so
    // they never push out established sessions.
    handshakes: 8,
    inFlight: 4,
    backoff: [30_000, 60_000, 120_000, 300_000, 600_000],
    tickMs: 10_000,
    hiddenPauseMs: 5 * MIN,
    failedHandshakes: 3,
    strikeBanMs: 10 * MIN,
    // Message requests kept (the oldest unverified ones make room) and new ones per hour.
    requests: 50,
    requestsPerHour: 20,
    offerSkewMs: 2 * MIN,
    helloCerts: 4,
    // Devices of ours recorded as no longer ours (lost, stolen or signed out by recovery).
    lostKept: 256,
    // Failed handshakes count against a peer this long.
    failedMs: 60_000,
    requestsWindowMs: HOUR,
  },
  session: {
    handshakeMs: 10_000,
    pingMs: 20_000,
    deadMs: 60_000,
    strikes: 20,
    framesPerSec: 50,
    frameBurst: 160,
    frameBacklogBytes: 4 * MIB,
    rekeyMs: HOUR,
    rekeyBytes: GIB,
    frameCost: 1024,
  },
  transport: {
    lowMark: 256 * KIB,
    dialMs: 15_000,
    heldMax: 4,
    heldPerPeer: 1,
    checksPerMin: 30,
  },
  dag: {
    // Heads kept per room; new events reference at most LIMITS.prev of them.
    heads: 50,
    missing: 500,
    // Events and bytes stored per room and in the whole database on this device.
    roomCap: 100_000,
    totalCap: 500_000,
    roomBytes: 200 * MIB,
    totalBytes: GIB,
    // P2P servers have a budget of their own, so a server can never crowd out DMs. It bounds their
    // content; ACL events are always stored (spec 4.2).
    serverCap: 400_000,
    serverBytes: 768 * MIB,
    // Steps of any walk over prev links.
    walk: 5000,
    // A body fetched back after it was purged or evicted isn't evicted again for this long.
    backGraceMs: HOUR,
    unknownEvents: 20_000,
    unknownBytes: 32 * MIB,
    oldestBodies: 500,
  },
  share: {
    // Of a room's content budget, and of the budget of every server together.
    room: 1 / 4,
    server: 1 / 8,
    hourMs: HOUR,
    hours: 24,
  },
  server: {
    // Server rooms on this device, and pending invites from contacts.
    invites: 20,
    // Redeem attempts a session may make.
    redeems: 3,
    redeemMs: 15_000,
    // Spec 4.3 S4: a hidden body is purged once its cause has stood this long here (and S1 to S3
    // hold), or at once when the room or the device runs out of space.
    purgeAfter: 7 * DAY,
    // Storage passes (spec 2.3, 4.2, 4.3: drops, purges, bodies wanted back, proofs) run at most
    // this often per room, and while causes stand at least once per `causesMs`.
    storeMs: 5000,
    causesMs: 60_000,
    // Proofs (spec 4.1): posted after a random delay up to this, at most proofsPerHour per room.
    proofDelayMs: 30_000,
    proofsPerHour: 6,
    // A mark that acknowledges a moderator's redaction (spec 4.3 S2): within this of applying it,
    // at most one per room per `ackMs`.
    ackDelayMs: 60_000,
    ackMs: 10 * MIN,
    // Evicted bodies someone viewed, wanted back at once (spec 4.2 step 3), and the least an
    // eviction of the oldest bodies frees.
    viewedMax: 500,
    evictBytes: 64 * KIB,
    // A code redeemed with us: the redeemer may sync the ACL (to join) for this long, at most
    // `redeemsPerCode` at once per code and `redeemsPerRoom` per room. An invite they don't use is
    // withdrawn after it.
    redeemTtl: 10 * MIN,
    // A co-owner has this long to agree when a contact creates a server with them; at most this
    // many such questions wait at once.
    coOwnerMs: 2 * MIN,
    coOwnerAsks: 4,
    redeemsPerCode: 4,
    redeemsPerRoom: 8,
    // Invites one code makes us post, per hour by our clock; after this many in a row lapse
    // unused, we stop taking the code for a while.
    codeAddsPerHour: 4,
    codeLapses: 4,
    codePauseMs: DAY,
    // A session with someone who isn't a contact, left without room links, closes after this.
    idleMs: 5000,
    // Local limits (spec 4.2): events waiting for their ACL parents, per room, and events dated
    // in the future, per device. Overflow is dropped and fetched again later.
    pendingEvents: 2000,
    pendingBytes: 8 * MIB,
    heldPerDevice: 256,
    rejectedKept: 10_000,
    vouchRoomMs: 10 * MIN,
    vouchInviterMs: HOUR,
    joinWaitMs: 30_000,
    saveMs: 1000,
    codeTtls: [HOUR, DAY, 7 * DAY, 30 * DAY],
    migratePer: 200,
    settleMs: HOUR,
    settleResample: [MIN, 5 * MIN],
    carryAck: 20,
    carryAcksMax: 50,
    roleNameMax: 32,
    roleStep: 1024,
    // A future-dated event is held until this long before its time.
    heldEarlyMs: 5 * MIN,
    // Waits for a session, a carry-over, a migration check and a retried upgrade step.
    sessionTries: 30,
    sessionWaitMs: 500,
    carryTries: 720,
    carryRetryMs: 5000,
    checkTries: 12,
    checkRetryMs: 5000,
    stepTries: 24 * 60,
    stepRetryMs: MIN,
    carryWindowMs: DAY,
    carryAckGapMs: MIN,
    // Replies loaded around a thread's jump target, and events per search chunk.
    threadBefore: 50,
    threadAfter: 1000,
    searchChunk: 50,
    // Server and channel names, and member names, are cut to this.
    nameMax: 100,
    memberNameMax: 64,
  },
  acl: {
    // Future-dated events are held this long ahead; rejected ids the evaluator remembers.
    holdMs: 5 * MIN,
    keepRejected: 10_000,
    // Steps of a vouching walk, and acknowledgements per storage pass.
    vouchWalk: 4096,
    acksPerPass: 10,
    // Algorithm switches: the race budget (and its growth), the bitmask size, the S2 counts.
    raceSteps: 16,
    raceGrowth: 4,
    maskSwitch: 32,
    s2Events: 3,
    s2Ids: 2,
  },
  cache: {
    // Whole enumerations and facts of recorded states per index; the packed chunk size; the merge
    // cache; admission states kept for rendering, by count and bytes; head-path snapshots.
    lruCap: 16,
    factsCap: 1024,
    chunk: 2048,
    mergeCap: 4096,
    contentCap: 16_384,
    contentBytes: 64 * MIB,
    headSnaps: 8,
  },
  voice: {
    refreshMs: 20_000,
    ttlMs: 60_000,
    tickMs: 5000,
    // A participant whose session with its voice device went away, and who isn't heard of again
    // (also through others), is gone after this: longer than a refresh.
    lostMs: 30_000,
    // How long someone we have a session with has to confirm what was passed on about them.
    confirmMs: 10_000,
    // A passed-on frame stamped (by its participant's clock) more than ttlMs plus this before ours
    // is stale.
    skewMs: 5 * MIN,
    // Frames a session may send us (a bucket: this many a second, bursts up to inBurst, for a
    // newcomer's list); the rest is dropped.
    inPerSec: 20,
    inBurst: 80,
    // Passing on: one state per member every gapMs at most, an unchanged one every relayMs, and
    // linkPerSec frames a second on each link (the rest is dropped; refreshes come again).
    gapMs: 1000,
    relayMs: 5000,
    linkPerSec: 10,
    // Participants we keep sessions with outside the budget.
    keepMax: 40,
    fitAudio: 8,
    fitVideo: 4,
  },
  calls: {
    ringMs: 30_000,
    ringGraceMs: 5000,
    ringsPerMin: 5,
    unknownPerMin: 5,
    lostMs: 20_000,
    byeMs: 5000,
    heldMax: 256,
    aliveMs: 10_000,
    answeredMax: 64,
  },
  bulk: {
    // Frames sent before waiting for the pipe to drain.
    batch: 16,
    // Verified blocks waiting to be written before no more are asked for.
    writes: 4,
    // Block requests we keep outstanding per pipe, all downloads together, and never more than
    // the credit the holder advertised.
    window: 2,
    // Frames received and not yet handled, on top of the block bytes we asked for and haven't
    // received yet, before the pipe counts as flooded.
    queueBytes: 4 * MIB,
    // `busy` answers a peer may cause before they count against it: only far more of those than any
    // client of ours can cause in a minute.
    busyFree: 256,
    // The block hashes of files with at most this many blocks come with a `blob_has` answer, so
    // small files need no `blob_meta` of their own.
    smallMeta: 16,
    // Cancels a peer may send per minute before they count against it.
    cancelsFree: 120,
    // Bytes of cancelled blocks that may still be on the way on one pipe; past it the pipe is
    // replaced (no strike) instead of waiting for them.
    graceBytes: 8 * MIB,
    strikes: 20,
    // One strike is forgiven per this long, so rare harmless events never add up to a ban.
    forgiveMs: 60_000,
    banMs: 10 * MIN,
    openMs: 15_000,
    // A block that makes no progress for this long (while its pipe makes none either) goes to
    // another holder.
    stallMs: 30_000,
    // A pipe is replaced (fresh keys) after this many bytes or this long.
    pipeBytes: GIB,
    pipeMs: HOUR,
    // Blocks read from storage at once to serve them.
    readers: 4,
    // Holders asked again after this long.
    probeMs: 60_000,
    // A served file's last-used time is written at most this often.
    touchMs: 60_000,
    // Free space kept on top of a download.
    margin: 16 * MIB,
    holdersKept: 256,
    thumbSide: 1024,
    lateMax: 64,
    touchedMax: 256,
  },
  files: {
    side: 160,
    qualities: [0.7, 0.55, 0.4, 0.3, 0.2],
    timeoutMs: 8000,
    headBytes: 256 * KIB,
    previewPixels: 100_000_000,
    thumbUrls: 200,
    // Auto-download defaults and choices: files in direct messages, images in P2P servers, and
    // bytes per contact per day.
    autoDm: 10 * MIB,
    autoServer: 10 * MIB,
    autoDailyOptions: [256 * MIB, GIB, 4 * GIB, 16 * GIB],
    autoDmOptions: [0, 1, 10, 25, 100].map(n => n * MIB),
    autoServerOptions: [0, 1, 5, 10].map(n => n * MIB),
    bigFile: GIB,
  },
  transfer: {
    kdfDesktopM: 128 * 1024,
    kdfDesktopT: 3,
    kdfDesktopP: 1,
    kdfMobileM: 64 * 1024,
    kdfMobileT: 3,
    kdfMobileP: 1,
    kdfMinM: 64 * 1024,
    kdfMinT: 3,
    kdfMinP: 1,
    kdfMaxM: 256 * 1024,
    kdfMaxT: 10,
    kdfMaxP: 4,
    passMin: 10,
    dumpMax: GIB,
    headsMax: 1000,
    importsKept: 50,
    headMax: 1024,
    fileSizeMax: 256 * GIB,
    browserImportsKept: 50,
  },
  dm: {
    pinsMax: 100,
    page: 100,
    missedMax: 50,
    autoDaily: GIB,
    autoFloor: 512 * MIB,
    pausedMax: 1000,
  },
  search: {
    // Characters kept of a word, and words kept of a message.
    word: 32,
    words: 256,
    // Query words this short match whole words only.
    exact: 2,
    page: 25,
    // Candidates looked at for one page; past it the page ends early with a cursor.
    scan: 2000,
    // Candidates of one query kept for its next pages, and for how long.
    pool: 20_000,
    poolMs: 60_000,
    // Events indexed per rebuild step.
    step: 500,
  },
  badge: {
    // A check older than this is done again.
    staleMs: DAY,
    // A token the issuer couldn't be asked about is tried again after this.
    retryMs: 10 * MIN,
    // Our own binding is fetched again after this (it lives 7 days).
    refreshMs: DAY,
    tickMs: 10 * MIN,
    // A binding that expired this long ago is forgotten.
    keepExpiredMs: 30 * DAY,
    tokenMax: 4096,
    // Tokens that failed their check, remembered so a peer repeating one costs nothing.
    refusedMax: 256,
    // Our server member events are posted again when the binding in them has less than this left.
    memberLeftMs: 3.5 * DAY,
  },
  display: {
    name: 100,
    topic: 1024,
    label: 64,
    reason: 200,
    // How far past its own time a code may say it expires (the admitting device clamps to this).
    codeTtl: 30 * DAY,
  },
  contacts: {
    introMax: 500,
    introsMax: 3,
    petnameMax: 32,
    certsKept: 8,
  },
  inbox: {
    pingsKept: 500,
    pingKeepMs: 30 * DAY,
    pageSize: 30,
    recountMs: 30,
    pingBatchMs: 50,
  },
  misc: {
    handoverMs: 3000,
    paletteGapMs: 50,
    paletteRefreshMs: 5000,
    jumpBefore: 50,
    jumpAfter: 1000,
    safetyCache: 64,
    cutMs: 7 * DAY,
    lostTimes: [HOUR, DAY, 7 * DAY],
  },
}

export type Local = typeof DEFAULTS

export const LOCAL: Readonly<Local> = deepFreeze(DEFAULTS)

type Range = readonly [number, number]
const fixed = (v: number): Range => [v, v]

const RANGE_OF: { [S in keyof Local]: { [K in keyof Local[S]]: Range | readonly Range[] } } = {
  sync: {
    pushPerMin: [60, 6000],
    horizon: [100, 100_000],
    statePerMin: [200, 100_000],
    headsDebounceMs: [50, 5000],
    typingMs: [1000, 60_000],
    deliveredWalk: [50, 50_000],
    peerFullMs: [MIN, DAY],
    headsAnswerMs: [100, 60_000],
  },
  gossip: {
    perRoom: [2, 32],
    outTarget: [1, 16],
    resampleMs: [MIN, DAY],
    tickMs: [1000, MIN],
    presenceMs: [5000, 5 * MIN],
    presenceTtl: [15_000, 15 * MIN],
    typingMs: [1000, 60_000],
    typingRelayMs: [500, 60_000],
    typingPerSec: [1, 50],
    preferMs: [MIN, DAY],
    preferMax: [0, 16],
    candidates: [1, 64],
    dialList: [16, 4096],
    busyMs: [10_000, HOUR],
    askMs: [5000, 2 * MIN],
    leaveMs: [1000, MIN],
    archivePerRoom: [1, 8],
    archiveOutTarget: [1, 4],
  },
  node: {
    sessions: [8, 512],
    memberSessions: [4, 512],
    handshakes: [2, 64],
    inFlight: [1, 32],
    backoff: [
      [5000, 10 * MIN],
      [10_000, 30 * MIN],
      [30_000, HOUR],
      [60_000, 2 * HOUR],
      [2 * MIN, 6 * HOUR],
    ],
    tickMs: [1000, 5 * MIN],
    hiddenPauseMs: [MIN, DAY],
    failedHandshakes: [1, 100],
    strikeBanMs: [MIN, DAY],
    requests: [5, 1000],
    requestsPerHour: [1, 1000],
    offerSkewMs: [30_000, 30 * MIN],
    helloCerts: [1, 16],
    lostKept: [16, 4096],
    failedMs: [10_000, HOUR],
    requestsWindowMs: fixed(HOUR),
  },
  session: {
    handshakeMs: [2000, 2 * MIN],
    pingMs: [5000, 5 * MIN],
    deadMs: [15_000, 30 * MIN],
    strikes: [5, 1000],
    framesPerSec: [10, 1000],
    frameBurst: [20, 10_000],
    frameBacklogBytes: [MIB, 64 * MIB],
    rekeyMs: [10 * MIN, DAY],
    rekeyBytes: [64 * MIB, 64 * GIB],
    frameCost: [64, 16 * KIB],
  },
  transport: {
    lowMark: [16 * KIB, 16 * MIB],
    dialMs: [3000, 2 * MIN],
    heldMax: [1, 64],
    heldPerPeer: [1, 16],
    checksPerMin: [1, 1000],
  },
  dag: {
    heads: [10, 1000],
    missing: [50, 50_000],
    roomCap: [1000, 10_000_000],
    totalCap: [10_000, 50_000_000],
    roomBytes: [16 * MIB, 64 * GIB],
    totalBytes: [64 * MIB, 256 * GIB],
    serverCap: [10_000, 50_000_000],
    serverBytes: [64 * MIB, 256 * GIB],
    walk: [500, 1_000_000],
    backGraceMs: [MIN, 7 * DAY],
    unknownEvents: [1000, 1_000_000],
    unknownBytes: [MIB, 4 * GIB],
    oldestBodies: [50, 50_000],
  },
  share: {
    room: [1 / 64, 1],
    server: [1 / 256, 1],
    hourMs: fixed(HOUR),
    hours: fixed(24),
  },
  server: {
    invites: [1, 1000],
    redeems: [1, 100],
    redeemMs: [2000, 5 * MIN],
    purgeAfter: [HOUR, 365 * DAY],
    storeMs: [500, 10 * MIN],
    causesMs: [5000, HOUR],
    proofDelayMs: [1000, 10 * MIN],
    proofsPerHour: [1, 600],
    ackDelayMs: [1000, HOUR],
    ackMs: [MIN, DAY],
    viewedMax: [10, 100_000],
    evictBytes: [4 * KIB, 64 * MIB],
    redeemTtl: [MIN, DAY],
    coOwnerMs: [30_000, HOUR],
    coOwnerAsks: [1, 64],
    redeemsPerCode: [1, 100],
    redeemsPerRoom: [1, 1000],
    codeAddsPerHour: [1, 1000],
    codeLapses: [1, 100],
    codePauseMs: [HOUR, 30 * DAY],
    idleMs: [1000, 10 * MIN],
    pendingEvents: [100, 1_000_000],
    pendingBytes: [MIB, GIB],
    heldPerDevice: [16, 100_000],
    rejectedKept: [100, 1_000_000],
    vouchRoomMs: [MIN, DAY],
    vouchInviterMs: [MIN, 7 * DAY],
    joinWaitMs: [5000, 10 * MIN],
    saveMs: [100, MIN],
    codeTtls: [fixed(HOUR), fixed(DAY), fixed(7 * DAY), fixed(30 * DAY)],
    migratePer: fixed(200),
    settleMs: [10 * MIN, 7 * DAY],
    settleResample: [
      [10_000, HOUR],
      [10_000, HOUR],
    ],
    carryAck: [1, 1000],
    carryAcksMax: [1, 10_000],
    roleNameMax: fixed(32),
    roleStep: fixed(1024),
    heldEarlyMs: [0, HOUR],
    sessionTries: [1, 1000],
    sessionWaitMs: [100, 10_000],
    carryTries: [1, 100_000],
    carryRetryMs: [1000, 10 * MIN],
    checkTries: [1, 10_000],
    checkRetryMs: [1000, 10 * MIN],
    stepTries: [1, 100_000],
    stepRetryMs: [5000, HOUR],
    carryWindowMs: [HOUR, 30 * DAY],
    carryAckGapMs: [5000, HOUR],
    threadBefore: [10, 1000],
    threadAfter: [50, 10_000],
    searchChunk: [10, 1000],
    nameMax: fixed(100),
    memberNameMax: fixed(64),
  },
  acl: {
    holdMs: [MIN, HOUR],
    keepRejected: [100, 1_000_000],
    vouchWalk: [256, 1_000_000],
    acksPerPass: [1, 1000],
    raceSteps: fixed(16),
    raceGrowth: fixed(4),
    maskSwitch: fixed(32),
    s2Events: fixed(3),
    s2Ids: fixed(2),
  },
  cache: {
    lruCap: [4, 4096],
    factsCap: [64, 1_000_000],
    chunk: fixed(2048),
    mergeCap: [256, 1_000_000],
    contentCap: [256, 1_000_000],
    contentBytes: [4 * MIB, 4 * GIB],
    headSnaps: [1, 256],
  },
  voice: {
    refreshMs: [5000, 5 * MIN],
    ttlMs: [15_000, 15 * MIN],
    tickMs: [1000, MIN],
    lostMs: [5000, 5 * MIN],
    confirmMs: [2000, 2 * MIN],
    skewMs: [MIN, HOUR],
    inPerSec: [5, 500],
    inBurst: [10, 5000],
    gapMs: [100, 30_000],
    relayMs: [1000, MIN],
    linkPerSec: [1, 500],
    keepMax: [4, 512],
    fitAudio: [2, 1000],
    fitVideo: [2, 1000],
  },
  calls: {
    ringMs: [10_000, 5 * MIN],
    ringGraceMs: [1000, MIN],
    ringsPerMin: [1, 100],
    unknownPerMin: [1, 100],
    lostMs: [5000, 5 * MIN],
    byeMs: [1000, MIN],
    heldMax: [16, 10_000],
    aliveMs: [1000, 5 * MIN],
    answeredMax: [8, 10_000],
  },
  bulk: {
    batch: [1, 256],
    writes: [1, 64],
    window: [1, 64],
    queueBytes: [MIB, 256 * MIB],
    busyFree: [16, 100_000],
    smallMeta: [0, 4096],
    cancelsFree: [10, 100_000],
    graceBytes: [MIB, GIB],
    strikes: [5, 1000],
    forgiveMs: [1000, HOUR],
    banMs: [MIN, DAY],
    openMs: [3000, 2 * MIN],
    stallMs: [5000, 10 * MIN],
    pipeBytes: [64 * MIB, 64 * GIB],
    pipeMs: [10 * MIN, DAY],
    readers: [1, 64],
    probeMs: [5000, HOUR],
    touchMs: [1000, HOUR],
    margin: [0, 4 * GIB],
    holdersKept: [16, 100_000],
    thumbSide: [160, 4096],
    lateMax: [8, 10_000],
    touchedMax: [16, 100_000],
  },
  files: {
    side: fixed(160),
    qualities: [fixed(0.7), fixed(0.55), fixed(0.4), fixed(0.3), fixed(0.2)],
    timeoutMs: [1000, 2 * MIN],
    headBytes: [16 * KIB, 64 * MIB],
    previewPixels: [MIB, 1_000_000_000],
    thumbUrls: [10, 100_000],
    autoDm: [0, 100 * GIB],
    autoServer: [0, 100 * GIB],
    autoDailyOptions: [fixed(256 * MIB), fixed(GIB), fixed(4 * GIB), fixed(16 * GIB)],
    autoDmOptions: [fixed(0), fixed(MIB), fixed(10 * MIB), fixed(25 * MIB), fixed(100 * MIB)],
    autoServerOptions: [fixed(0), fixed(MIB), fixed(5 * MIB), fixed(10 * MIB)],
    bigFile: [MIB, 1024 * GIB],
  },
  transfer: {
    kdfDesktopM: [64 * 1024, 256 * 1024],
    kdfDesktopT: [3, 10],
    kdfDesktopP: [1, 4],
    kdfMobileM: [64 * 1024, 256 * 1024],
    kdfMobileT: [3, 10],
    kdfMobileP: [1, 4],
    kdfMinM: fixed(64 * 1024),
    kdfMinT: fixed(3),
    kdfMinP: fixed(1),
    kdfMaxM: fixed(256 * 1024),
    kdfMaxT: fixed(10),
    kdfMaxP: fixed(4),
    passMin: [8, 64],
    dumpMax: [64 * MIB, 64 * GIB],
    headsMax: fixed(1000),
    importsKept: [10, 1000],
    headMax: fixed(1024),
    fileSizeMax: [GIB, 1024 * GIB],
    browserImportsKept: [10, 1000],
  },
  dm: {
    pinsMax: [10, 1000],
    page: [20, 1000],
    missedMax: [10, 1000],
    autoDaily: [0, 1024 * GIB],
    autoFloor: [0, 64 * GIB],
    pausedMax: [100, 100_000],
  },
  search: {
    word: [8, 256],
    words: [16, 4096],
    exact: [1, 8],
    page: [5, 200],
    scan: [100, 100_000],
    pool: [1000, 1_000_000],
    poolMs: [5000, HOUR],
    step: [50, 10_000],
  },
  badge: {
    staleMs: [HOUR, 7 * DAY],
    retryMs: [MIN, DAY],
    refreshMs: [HOUR, 3 * DAY],
    tickMs: [MIN, DAY],
    keepExpiredMs: [DAY, 365 * DAY],
    tokenMax: [1024, 64 * KIB],
    refusedMax: [16, 100_000],
    memberLeftMs: [DAY, 6 * DAY],
  },
  display: {
    name: [32, 1024],
    topic: [64, 16 * KIB],
    label: [16, 1024],
    reason: [32, 4096],
    codeTtl: [DAY, 365 * DAY],
  },
  contacts: {
    introMax: [0, 4000],
    introsMax: [1, 64],
    petnameMax: [8, 256],
    certsKept: [2, 256],
  },
  inbox: {
    pingsKept: [50, 100_000],
    pingKeepMs: [DAY, 365 * DAY],
    pageSize: [10, 500],
    recountMs: [0, 10_000],
    pingBatchMs: [0, 10_000],
  },
  misc: {
    handoverMs: [500, 60_000],
    paletteGapMs: [0, 10_000],
    paletteRefreshMs: [500, MIN],
    jumpBefore: [10, 1000],
    jumpAfter: [50, 10_000],
    safetyCache: [8, 10_000],
    cutMs: [DAY, 365 * DAY],
    lostTimes: [fixed(HOUR), fixed(DAY), fixed(7 * DAY)],
  },
}

const flatten = <V>(
  tree: Record<string, Record<string, unknown>>,
  leaf: (x: unknown) => x is V
): Record<string, V> => {
  const out: Record<string, V> = {}
  for (const [s, sec] of Object.entries(tree))
    for (const [k, v] of Object.entries(sec)) {
      if (leaf(v)) out[`${s}.${k}`] = v
      else if (Array.isArray(v)) v.forEach((x, i) => leaf(x) && (out[`${s}.${k}.${i}`] = x))
    }
  return out
}

const isNum = (x: unknown): x is number => typeof x === 'number'
const isRange = (x: unknown): x is Range => Array.isArray(x) && x.length === 2 && x.every(isNum)

export const flatLocal = (l: Local): Record<string, number> =>
  flatten(l as unknown as Record<string, Record<string, unknown>>, isNum)

export const RANGES: Readonly<Record<string, Range>> = deepFreeze(
  flatten(RANGE_OF as unknown as Record<string, Record<string, unknown>>, isRange)
)

export const localDefaults = (instance?: Record<string, number>): Local => {
  const out = structuredClone(DEFAULTS) as unknown as Record<string, Record<string, unknown>>
  if (!instance) return out as unknown as Local
  for (const [name, v] of Object.entries(instance)) {
    if (!Object.hasOwn(RANGES, name) || typeof v !== 'number' || !Number.isFinite(v)) continue
    const r = RANGES[name]
    const x = Math.min(r[1], Math.max(r[0], v))
    const [s, k, i] = name.split('.')
    if (i === undefined) out[s][k] = x
    else (out[s][k] as number[])[Number(i)] = x
  }
  return out as unknown as Local
}

export const registryJson = (): { v: 1; local: Record<string, [number, number, number]> } => {
  const local: Record<string, [number, number, number]> = {}
  for (const [k, v] of Object.entries(flatLocal(LOCAL))) local[k] = [v, ...RANGES[k]]
  return { v: 1, local }
}
