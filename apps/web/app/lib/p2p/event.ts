import { sha256 } from '@noble/hashes/sha2.js'
import { isRecord } from '../bytes'
import {
  b64u,
  bytesOf,
  canonical,
  canonicalBytes,
  concat,
  fromB64u,
  hasKeys,
  utf8,
} from './canonical'
import type { ProofHeader } from './acl/admit'
import { aclContentOk, type AclContent, type AclEv } from './acl/rules'
import type { ContentEv } from './acl/visibility'
import { blockCount, EMPTY_ROOT } from './hashing'
import { checkState, isShortId, isStateType, STATE_LIMITS, type StateType } from './state'
import {
  isKeyId,
  keyBytes,
  keyId,
  sign,
  verify,
  type Cert,
  type KeyPair,
  type Revocation,
} from './keys'

// Signed room events (note section 3). The hashed core links the event into its room's DAG and
// binds the content through `ch`; the content sits outside the core, so a redaction can drop it
// and the event stays verifiable. Every event is validated in full before it is stored.
// Forward compatibility: fields this version doesn't know are kept (they are signed and hashed)
// but never read, and an event of a type it doesn't know is checked, stored and synced like any
// other but never shown, so the room's DAG stays whole when a newer peer writes one.

// `move`: written by a new device right after a device move, on top of the room heads it brought
// along, so the old device's events before the move stay vouched for (see sync).
// `call`: the log row of a call, written by the caller once it is over.
// State types (state.ts) belong to P2P servers and carry `skey`.
export type EvType = 'msg' | 'edit' | 'redact' | 'react' | 'pin' | 'move' | 'call' | StateType

export const EV_TYPES: readonly string[] = ['msg', 'edit', 'redact', 'react', 'pin', 'move', 'call']

export const isKnownType = (x: unknown): x is EvType => EV_TYPES.includes(x as EvType)

// A type name a newer version may use.
const isTypeName = (x: unknown): x is string =>
  typeof x === 'string' && /^[a-z][a-z0-9_]{0,31}$/.test(x)

export interface Core {
  v: 1
  room: string
  // One of EV_TYPES, or a newer type this version stores without reading.
  type: EvType | (string & {})
  sender: string
  dev: string
  ts: number
  depth: number
  prev: string[]
  ch: string
  // P2P servers (note section 6): the state events this one relies on (not on `create`), the
  // state heads its sender knew (state events only, not on `create`), and the state key.
  auth?: string[]
  pstate?: string[]
  skey?: string
  // P2P servers: the sender's chain in the room (note section 6): the number of this event among
  // theirs, their previous event, how many of theirs came earlier the same UTC day, their
  // previous state event (state events), and their latest accepted power event where it sits
  // (power events and leaving).
  dseq?: number
  dprev?: string
  dwin?: number
  sprev?: string
  pprev?: string
}

// The room an event belongs to. A server's room id is the id of its `create` event, which can't
// name itself: its own `room` is a random seed.
export const roomOf = (id: string, ev: Pick<Core, 'type' | 'room'>) =>
  ev.type === 'create' ? id : ev.room

// A file in a message (note section 5): its root hash `h` over the 1 MiB block hashes, its
// size and block count, and what the sender says about it. `name`, `mime` and the thumbnail are
// claims: what a received file is shown as is decided from its bytes only.
export interface Attachment {
  h: string
  size: number
  blocks: number
  name: string
  mime: string
  spoiler?: true
  // Pixel size of an image or video, and the length of a video or audio file in ms.
  w?: number
  h_px?: number
  dur?: number
  // A JPEG preview of at most 6 KiB (b64u), checked again before it is shown.
  thumb?: string
}

// A forwarded copy: who wrote it, when, and what. No link back to the source.
export interface Fwd {
  name: string
  ts: number
  body: string
  att?: Attachment[]
}

export interface MsgContent {
  body: string
  reply?: string
  mentions?: string[]
  fwd?: Fwd
  att?: Attachment[]
  // P2P servers: the channel, and a mention of everyone (shown as one only when the sender may).
  ch?: string
  everyone?: true
}

export interface EditContent {
  target: string
  body: string
}

export interface RedactContent {
  target: string
}

export interface ReactContent {
  target: string
  key: string
  on: boolean
}

export interface PinContent {
  target: string
  on: boolean
}

export type MoveContent = Record<string, never>

// How a call went, from the caller: `dur` (seconds from the answer to the end) only for an
// answered call.
export type CallOutcome = 'ended' | 'missed' | 'declined'
export const CALL_OUTCOMES: readonly CallOutcome[] = ['ended', 'missed', 'declined']

export interface CallContent {
  id: string
  video: boolean
  outcome: CallOutcome
  dur?: number
}

export type Content =
  | MsgContent
  | EditContent
  | RedactContent
  | ReactContent
  | PinContent
  | MoveContent
  | CallContent
  | Record<string, unknown>

export interface Wire {
  ev: Core
  c: Content | null
  sig: string
}

export const TAG_EVENT = 'rchat-p2p-ev1\0'
export const TAG_SIG = 'rchat-p2p-sig1\0'

export const LIMITS = {
  core: 2048,
  content: 16 * 1024,
  body: 4000,
  prev: 10,
  mentions: 20,
  reactKey: 32,
  name: 64,
  // Files per message, and the content size a message with files may reach (thumbnails).
  att: 50,
  attContent: 64 * 1024,
  attName: 255,
  attNameBytes: 1024,
  mime: 127,
  thumb: 6 * 1024,
  dims: 100_000,
  // Events shown more than this before they arrived get the "arrived later" marker.
  lateMs: 60_000,
  // A sender's clock may run at most this far ahead.
  futureMs: 5 * 60_000,
  depth: 2 ** 40,
  // The longest call a log row may claim (seconds).
  callDur: 7 * 24 * 60 * 60,
}

export const ID_LEN = 32

export const isEventId = (x: unknown): x is string => bytesOf(x, ID_LEN) !== null

// Calls are named by 16 random bytes (b64u).
export const CALL_ID_LEN = 16
export const isCallId = (x: unknown): x is string => bytesOf(x, CALL_ID_LEN) !== null

const chars = (s: string) => Array.from(s).length

const isInt = (x: unknown, min = 0): x is number => Number.isSafeInteger(x) && (x as number) >= min

export const contentHash = (c: Content) => b64u(sha256(canonicalBytes(c)))

export const eventIdBytes = (core: Core) => sha256(concat(utf8(TAG_EVENT), canonicalBytes(core)))

export const eventId = (core: Core) => b64u(eventIdBytes(core))

const sigInput = (idBytes: Uint8Array) => concat(utf8(TAG_SIG), idBytes)

export interface Author {
  ik: KeyPair
  dk: KeyPair
}

// The server fields of a new event.
export interface ServerFields {
  auth?: string[]
  pstate?: string[]
  skey?: string
  dseq?: number
  dprev?: string
  dwin?: number
  sprev?: string
  pprev?: string
}

// Signs a new event. `prev` are the room heads (deepest first), `depth` one more than theirs.
export const buildEvent = (
  author: Author,
  room: string,
  type: EvType,
  content: Content,
  prev: string[],
  depth: number,
  ts: number,
  extra: ServerFields = {}
): { id: string; wire: Wire } => {
  const core: Core = {
    v: 1,
    room,
    type,
    sender: keyId(author.ik.pk),
    dev: keyId(author.dk.pk),
    ts,
    depth,
    prev: prev.slice(0, LIMITS.prev),
    ch: contentHash(content),
  }
  if (extra.auth) core.auth = extra.auth.slice(0, STATE_LIMITS.auth)
  if (extra.pstate) core.pstate = extra.pstate.slice(0, STATE_LIMITS.pstate)
  if (extra.skey !== undefined) core.skey = extra.skey
  if (extra.dseq !== undefined) core.dseq = extra.dseq
  if (extra.dprev !== undefined) core.dprev = extra.dprev
  if (extra.dwin !== undefined) core.dwin = extra.dwin
  if (extra.sprev !== undefined) core.sprev = extra.sprev
  if (extra.pprev !== undefined) core.pprev = extra.pprev
  const idBytes = eventIdBytes(core)
  const sig = b64u(sign(author.dk.sk, sigInput(idBytes)))
  return { id: b64u(idBytes), wire: { ev: core, c: content, sig } }
}

// The redacted form: the core and signature only, still verifiable and still in the DAG.
export const redacted = (w: Wire): Wire => ({ ev: w.ev, c: null, sig: w.sig })

// ----- Content schemas -----

const isBody = (x: unknown): x is string => typeof x === 'string' && chars(x) <= LIMITS.body

const isDim = (x: unknown) => x === undefined || (isInt(x, 1) && (x as number) <= LIMITS.dims)

export const isAttachment = (x: unknown): x is Attachment => {
  if (!isRecord(x) || !hasKeys(x, ['h', 'size', 'blocks', 'name', 'mime'])) return false
  const { h, size, blocks, name, mime, spoiler, w, h_px, dur, thumb } = x
  if (thumb !== undefined) {
    const t = typeof thumb === 'string' ? bytesLen(thumb) : null
    if (t === null || t === 0 || t > LIMITS.thumb) return false
  }
  return (
    bytesOf(h, 32) !== null &&
    isInt(size) &&
    // An empty file has exactly one root; any other zero-length claim is refused, so it can
    // never stand for (and block) a real file.
    ((size as number) > 0 || h === EMPTY_ROOT) &&
    isInt(blocks) &&
    blocks === blockCount(size as number) &&
    typeof name === 'string' &&
    name.trim() !== '' &&
    chars(name) <= LIMITS.attName &&
    utf8(name).length <= LIMITS.attNameBytes &&
    typeof mime === 'string' &&
    mime.length <= LIMITS.mime &&
    /^[\x21-\x7e]*$/.test(mime) &&
    (spoiler === undefined || spoiler === true) &&
    isDim(w) &&
    isDim(h_px) &&
    (dur === undefined || isInt(dur))
  )
}

// Decoded length of a b64u string, or null when it isn't one.
const bytesLen = (s: string) => {
  try {
    return fromB64u(s).length
  } catch {
    return null
  }
}

const isAtts = (x: unknown): x is Attachment[] =>
  Array.isArray(x) &&
  x.length > 0 &&
  x.length <= LIMITS.att &&
  x.every(isAttachment) &&
  new Set(x.map(a => a.h)).size === x.length

const isFwd = (x: unknown): x is Fwd =>
  isRecord(x) &&
  hasKeys(x, ['name', 'ts', 'body']) &&
  typeof x.name === 'string' &&
  chars(x.name) <= LIMITS.name &&
  isInt(x.ts) &&
  isBody(x.body) &&
  (x.att === undefined || isAtts(x.att))

// Root hashes of the files a message carries, its own and forwarded ones.
export const attsOf = (c: Content | null | undefined): string[] => {
  if (!c || !('body' in c) || 'target' in c) return []
  const m = c as MsgContent
  return [...new Set([...(m.att ?? []), ...(m.fwd?.att ?? [])].map(a => a.h))]
}

const isMentions = (x: unknown): x is string[] =>
  Array.isArray(x) &&
  x.length <= LIMITS.mentions &&
  new Set(x).size === x.length &&
  x.every(isKeyId)

const reactKeyOk = (x: unknown): x is string =>
  typeof x === 'string' && x.length > 0 && utf8(x).length <= LIMITS.reactKey

export const checkContent = (type: string, c: unknown, skey?: string): c is Content => {
  if (!isRecord(c)) return false
  if (skey !== undefined || isStateType(type)) return checkState(type, skey ?? '', c)
  switch (type) {
    case 'msg':
      return (
        hasKeys(c, ['body']) &&
        isBody(c.body) &&
        (c.ch === undefined || isShortId(c.ch)) &&
        (c.everyone === undefined || c.everyone === true) &&
        (c.reply === undefined || isEventId(c.reply)) &&
        (c.mentions === undefined || isMentions(c.mentions)) &&
        (c.fwd === undefined || isFwd(c.fwd)) &&
        (c.att === undefined || (c.fwd === undefined && isAtts(c.att))) &&
        (c.body.trim() !== '' || c.fwd !== undefined || c.att !== undefined)
      )
    case 'edit':
      return (
        hasKeys(c, ['target', 'body']) &&
        isEventId(c.target) &&
        isBody(c.body) &&
        c.body.trim() !== ''
      )
    case 'redact':
      return isEventId(c.target)
    case 'react':
      return isEventId(c.target) && reactKeyOk(c.key) && typeof c.on === 'boolean'
    case 'pin':
      return isEventId(c.target) && typeof c.on === 'boolean'
    case 'move':
      return true
    case 'call':
      // An outcome a newer version adds is kept and not shown; `dur` is read only for `ended`.
      return (
        isCallId(c.id) &&
        typeof c.video === 'boolean' &&
        isTypeName(c.outcome) &&
        (c.outcome !== 'ended' || (isInt(c.dur) && c.dur <= LIMITS.callDur))
      )
    default:
      // A type this version doesn't know: any object, within the size limit.
      return true
  }
}

const TARGETED: readonly string[] = ['edit', 'redact', 'react', 'pin']

// The event an edit, redaction, reaction or pin is about. Decided by the type, so a field named
// `target` that a newer version adds to another type is never read as one.
export const targetOf = (w: { ev: Pick<Core, 'type'>; c: Content | null }): string | null =>
  w.c && TARGETED.includes(w.ev.type) && typeof (w.c as { target?: unknown }).target === 'string'
    ? (w.c as { target: string }).target
    : null

// ----- Validation -----

export interface Devices {
  certs: Cert[]
  revocations: Revocation[]
}

export interface RoomAuth {
  room: string
  // The two identities of a DM; null in a server, whose auth rules decide membership.
  members: readonly string[] | null
  devices: (ik: string) => Devices | null
}

export type Invalid =
  | 'shape'
  | 'size'
  | 'room'
  | 'sender'
  | 'device'
  | 'revoked'
  | 'signature'
  | 'content'
  | 'prev'
  | 'depth'
  | 'auth'

// `revoked`: signed by a device that has since been revoked, with a time before the revocation.
// The signature alone can't tell that from a backdated event made with a stolen key, so the
// caller keeps it only when it is already stored or a good device of the sender vouches for it.
export type Checked =
  { ok: true; id: string; wire: Wire; revoked: boolean } | { ok: false; why: Invalid }

const bad = (why: Invalid): Checked => ({ ok: false, why })

const isCore = (x: unknown): x is Core => {
  if (
    !isRecord(x) ||
    !hasKeys(x, ['v', 'room', 'type', 'sender', 'dev', 'ts', 'depth', 'prev', 'ch'])
  )
    return false
  const { v, room, type, sender, dev, ts, depth, prev, ch } = x
  return (
    v === 1 &&
    typeof room === 'string' &&
    bytesOf(room, 32) !== null &&
    isTypeName(type) &&
    isKeyId(sender) &&
    isKeyId(dev) &&
    isInt(ts) &&
    isInt(depth) &&
    (depth as number) < LIMITS.depth &&
    Array.isArray(prev) &&
    typeof ch === 'string' &&
    bytesOf(ch, 32) !== null &&
    idList(x.auth, 0, STATE_LIMITS.auth) &&
    idList(x.pstate, 1, STATE_LIMITS.pstate) &&
    (x.skey === undefined || (typeof x.skey === 'string' && x.skey.length <= STATE_LIMITS.skey)) &&
    (x.dseq === undefined || isInt(x.dseq)) &&
    (x.dwin === undefined || isInt(x.dwin)) &&
    (x.dprev === undefined || isEventId(x.dprev)) &&
    (x.sprev === undefined || isEventId(x.sprev)) &&
    (x.pprev === undefined || isEventId(x.pprev))
  )
}

// An optional list of distinct event ids.
const idList = (x: unknown, min: number, max: number) =>
  x === undefined ||
  (Array.isArray(x) &&
    x.length >= min &&
    x.length <= max &&
    new Set(x).size === x.length &&
    x.every(isEventId))

// Messages with files may be larger (names and thumbnails); everything else stays small.
export const contentMax = (c: unknown) =>
  isRecord(c) && (Array.isArray(c.att) || (isRecord(c.fwd) && Array.isArray(c.fwd.att)))
    ? LIMITS.attContent
    : LIMITS.content

export const sizeOf = (x: unknown) => {
  try {
    return utf8(canonical(x)).length
  } catch {
    return Infinity
  }
}

// Signature, schema, sizes and membership: everything that needs no other event. Content may be
// null (redacted elsewhere). Prev ids are checked for shape and count; depth against known prevs
// happens when it is stored.
export const validate = (raw: unknown, auth: RoomAuth): Checked => {
  if (!isRecord(raw) || !hasKeys(raw, ['ev', 'c', 'sig'])) return bad('shape')
  const { ev, c, sig } = raw
  if (!isCore(ev)) return bad('shape')
  if (sizeOf(ev) > LIMITS.core || (c !== null && sizeOf(c) > contentMax(c))) return bad('size')
  // A server's create event: its id is the room (checked below, once the id is known).
  const create = ev.type === 'create'
  if (!create && ev.room !== auth.room) return bad('room')
  if (
    ev.prev.length > LIMITS.prev ||
    new Set(ev.prev).size !== ev.prev.length ||
    !ev.prev.every(isEventId) ||
    (ev.prev.length === 0) !== (ev.depth === 0)
  )
    return bad('prev')
  if (auth.members && !auth.members.includes(ev.sender)) return bad('sender')
  const devices = auth.devices(ev.sender)
  // A revocation is signed by the identity, so it also proves the device was one of its own
  // (its cert is dropped once it is revoked).
  const rev = devices?.revocations.find(r => r.dk === ev.dev && r.ik === ev.sender)
  if (!devices || (!rev && !devices.certs.some(x => x.dk === ev.dev && x.ik === ev.sender)))
    return bad('device')
  if (rev && ev.ts > rev.revoked_at) return bad('revoked')
  const s = bytesOf(sig, 64)
  const pk = keyBytes(ev.dev)
  let idBytes: Uint8Array
  try {
    idBytes = eventIdBytes(ev)
  } catch {
    return bad('shape')
  }
  if (!s || !pk || !verify(pk, sigInput(idBytes), s)) return bad('signature')
  if (create && b64u(idBytes) !== auth.room) return bad('room')
  if (c !== null) {
    if (!checkContent(ev.type, c, ev.skey)) return bad('content')
    let hash: string
    try {
      hash = contentHash(c)
    } catch {
      return bad('content')
    }
    if (hash !== ev.ch) return bad('content')
  }
  return {
    ok: true,
    id: b64u(idBytes),
    wire: { ev, c: (c as Content | null) ?? null, sig: sig as string },
    revoked: rev !== undefined,
  }
}

// The id an event claims, when its core is well formed (so a refused event isn't asked for again).
export const claimedId = (raw: unknown): string | null => {
  if (!isRecord(raw) || !isCore(raw.ev)) return null
  try {
    return eventId(raw.ev)
  } catch {
    return null
  }
}

// Rules that need the target event, checked when both are known. A DM has two members and no
// roles: edits and redactions only by the target's sender, reactions and pins on messages only.
export const authorizeTarget = (ev: Core, target: Wire | undefined): boolean => {
  if (!target) return true
  const t = target.ev
  switch (ev.type) {
    case 'msg':
    case 'move':
    case 'call':
      return true
    case 'edit':
      return (
        t.type === 'msg' &&
        t.sender === ev.sender &&
        !(target.c && 'fwd' in target.c && target.c.fwd)
      )
    case 'redact':
      return t.sender === ev.sender
    case 'react':
    case 'pin':
      return t.type === 'msg'
    default:
      return true
  }
}

// ----- Ordering -----

// Display time: the sender's clock, at most futureMs ahead of when we got it, and never before
// its parents.
export const effTsOf = (ts: number, receivedAt: number, prevEffTs: number[]) =>
  Math.max(Math.min(ts, receivedAt + LIMITS.futureMs), ...prevEffTs, 0)

const pad = (n: number, width: number) => String(n).padStart(width, '0')

export const sortKeyOf = (effTs: number, depth: number, id: string) =>
  `${pad(effTs, 16)}.${pad(depth, 13)}.${id}`

export const isLate = (effTs: number, receivedAt: number) => receivedAt - effTs > LIMITS.lateMs

// ----- Format v2 (P2P servers, ACL spec §1.2) -----

// A v2 core: every server event, ACL (`L` "a") or content (`L` "c"), signed by a device. Nothing
// the sender asserts about authority is in it; admission computes everything from the position.
export interface CoreV2 {
  v: 2
  // the server id (the genesis event's id); absent only on the genesis
  srv?: string
  t: string
  L: 'a' | 'c'
  a: string
  dev: string
  // per (srv, dev), strictly increasing over all the device's events in the server
  seq: number
  // ACL parents: the ACL heads the author knew (absent only on the genesis)
  ap?: string[]
  // ACL events: the device's previous ACL event; identity ops: the identity's previous one
  aprev?: string
  iprev?: string
  // content events: content parents (display order) and the device's previous content event
  prev?: string[]
  cprev?: string
  ts: number
  ch: string
}

export interface WireV2 {
  ev: CoreV2
  c: Record<string, unknown> | null
  sig: string
}

export const TAG_EVENT2 = 'rchat-p2p-ev2\0'
export const TAG_SIG2 = 'rchat-p2p-sig2\0'

export const LIMITS2 = {
  core: 2048,
  aclContent: 4096,
  migrateContent: 16 * 1024,
  ap: 10,
  prev: 10,
}

export const eventIdBytes2 = (core: CoreV2) =>
  sha256(concat(utf8(TAG_EVENT2), canonicalBytes(core)))
export const eventId2 = (core: CoreV2) => b64u(eventIdBytes2(core))
const sigInput2 = (idBytes: Uint8Array) => concat(utf8(TAG_SIG2), idBytes)

export interface ChainFields {
  seq: number
  ap?: string[]
  aprev?: string
  iprev?: string
  prev?: string[]
  cprev?: string
}

// Signs a new v2 event. `srv` is null for the genesis.
export const buildEvent2 = (
  author: Author,
  srv: string | null,
  t: string,
  L: 'a' | 'c',
  content: Record<string, unknown>,
  chain: ChainFields,
  ts: number
): { id: string; wire: WireV2 } => {
  const core: CoreV2 = {
    v: 2,
    t,
    L,
    a: keyId(author.ik.pk),
    dev: keyId(author.dk.pk),
    seq: chain.seq,
    ts,
    ch: contentHash(content as Content),
  }
  if (srv !== null) core.srv = srv
  if (chain.ap) core.ap = chain.ap.slice(0, LIMITS2.ap)
  if (chain.aprev !== undefined) core.aprev = chain.aprev
  if (chain.iprev !== undefined) core.iprev = chain.iprev
  if (L === 'c') core.prev = (chain.prev ?? []).slice(0, LIMITS2.prev)
  if (chain.cprev !== undefined) core.cprev = chain.cprev
  const idBytes = eventIdBytes2(core)
  const sig = b64u(sign(author.dk.sk, sigInput2(idBytes)))
  return { id: b64u(idBytes), wire: { ev: core, c: content, sig } }
}

export type Invalid2 = 'shape' | 'size' | 'server' | 'signature' | 'content'
export type Checked2 = { ok: true; id: string; wire: WireV2 } | { ok: false; why: Invalid2 }

const ids = (x: unknown, min: number, max: number) =>
  Array.isArray(x) &&
  x.length >= min &&
  x.length <= max &&
  new Set(x).size === x.length &&
  x.every(isEventId)

const isCore2 = (x: unknown): x is CoreV2 => {
  if (!isRecord(x) || !hasKeys(x, ['v', 't', 'L', 'a', 'dev', 'seq', 'ts', 'ch'])) return false
  const genesis = x.t === 'genesis'
  const acl = x.L === 'a'
  return (
    x.v === 2 &&
    isTypeName(x.t) &&
    (acl || x.L === 'c') &&
    (!genesis || acl) &&
    isKeyId(x.a) &&
    isKeyId(x.dev) &&
    isInt(x.seq) &&
    isInt(x.ts) &&
    typeof x.ch === 'string' &&
    bytesOf(x.ch, 32) !== null &&
    (genesis
      ? x.srv === undefined && x.ap === undefined && x.seq === 0
      : typeof x.srv === 'string' && bytesOf(x.srv, 32) !== null && ids(x.ap, 1, LIMITS2.ap)) &&
    (x.aprev === undefined || (acl && isEventId(x.aprev))) &&
    (x.iprev === undefined || (acl && isEventId(x.iprev))) &&
    (acl ? x.prev === undefined : ids(x.prev ?? [], 0, LIMITS2.prev)) &&
    (x.cprev === undefined || (!acl && isEventId(x.cprev)))
  )
}

// A signed core of the same server (one side of a proof), verified.
const signedHeader = (x: unknown, srv: string | null): x is { ev: CoreV2; sig: string } => {
  if (!isRecord(x) || !isCore2(x.ev) || x.ev.t === 'genesis' || x.ev.srv !== srv) return false
  const s = bytesOf(x.sig, 64)
  const pk = keyBytes(x.ev.dev)
  try {
    return !!s && !!pk && verify(pk, sigInput2(eventIdBytes2(x.ev)), s)
  } catch {
    return false
  }
}

export const TAG_UPGRADE = 'rchat-p2p-upgrade2\0'
const upgradeInput = (srv: string, g: unknown) =>
  concat(utf8(TAG_UPGRADE), utf8(srv), utf8('\0'), canonicalBytes(g))

// A co-owner's countersignature of an upgrade of server `srv` to the new genesis `g` (§3.8).
export const signUpgrade = (ik: KeyPair, srv: string, g: Record<string, unknown>) =>
  b64u(sign(ik.sk, upgradeInput(srv, g)))

// Identity records (§1.1): a device revocation is signed by the identity's primary or recovery
// key over (srv, dk, seen), a rotation by its recovery key over the record, its position (iprev)
// and the device that posts it. Until identities have separate recovery and primary keys, the
// identity key plays both.
export const TAG_REVOKE = 'rchat-p2p-revoke2\0'
export const TAG_ROTATE = 'rchat-p2p-rotate2\0'
const revokeInput = (srv: string, c: { ik: unknown; dk: unknown; seen: unknown }) =>
  concat(
    utf8(TAG_REVOKE),
    utf8(srv),
    utf8('\0'),
    canonicalBytes({ ik: c.ik, dk: c.dk, seen: c.seen })
  )
const rotateInput = (
  srv: string,
  dev: string,
  iprev: string | undefined,
  c: { ik: unknown; pcert?: unknown; keep?: unknown; seen?: unknown }
) =>
  concat(
    utf8(TAG_ROTATE),
    utf8(srv),
    utf8('\0'),
    canonicalBytes({
      ik: c.ik,
      dev,
      iprev: iprev ?? '',
      pcert: c.pcert ?? '',
      keep: c.keep ?? [],
      seen: c.seen ?? {},
    })
  )
export const signRevocation2 = (ik: KeyPair, srv: string, dk: string, seen: number) =>
  b64u(sign(ik.sk, revokeInput(srv, { ik: keyId(ik.pk), dk, seen })))
export const signRotation2 = (
  ik: KeyPair,
  srv: string,
  dev: string,
  iprev: string | undefined,
  c: { pcert?: string; keep?: string[]; seen?: Record<string, number> }
) => b64u(sign(ik.sk, rotateInput(srv, dev, iprev, { ...c, ik: keyId(ik.pk) })))
const signedBy = (ik: unknown, msg: () => Uint8Array, sig: unknown) => {
  const pk = keyBytes(ik)
  const sb = bytesOf(sig, 64)
  try {
    return !!pk && !!sb && verify(pk, msg(), sb)
  } catch {
    return false
  }
}

const contentOk2 = (ev: CoreV2, c: Record<string, unknown>) => {
  if (ev.L === 'c') return checkContent(ev.t, c)
  if (!KNOWN_ACL.includes(ev.t)) return true
  if (!aclContentOk(ev.t, c)) return false
  const srv = ev.srv ?? null
  if (ev.t === 'device_revoke')
    return (
      srv !== null &&
      c.ik === ev.a &&
      signedBy(
        c.ik,
        () => revokeInput(srv, c as { ik: unknown; dk: unknown; seen: unknown }),
        c.rec
      )
    )
  if (ev.t === 'primary_rotate')
    return (
      srv !== null &&
      c.ik === ev.a &&
      signedBy(c.ik, () => rotateInput(srv, ev.dev, ev.iprev, c as { ik: unknown }), c.rsig)
    )
  if (ev.t === 'proof')
    return (
      signedHeader(c.x, srv) &&
      signedHeader(c.y, srv) &&
      (c.x as { ev: CoreV2 }).ev.dev === (c.y as { ev: CoreV2 }).ev.dev
    )
  if (ev.t === 'upgrade') {
    if (!isRecord(c.g) || srv === null) return false
    const sigs = c.sigs ?? {}
    if (!isRecord(sigs)) return false
    for (const [ik, sg] of Object.entries(sigs)) {
      const pk = keyBytes(ik)
      const sb = bytesOf(sg, 64)
      try {
        if (!pk || !sb || !verify(pk, upgradeInput(srv, c.g), sb)) return false
      } catch {
        return false
      }
    }
  }
  return true
}

// Schema, sizes, id, `ch` and the device's signature: everything that needs no other event. The
// device's binding to its identity, the chains and authority are admission (acl/admit.ts).
// `srv`: the server the event must belong to; null to check a genesis on its own.
export const validate2 = (raw: unknown, srv: string | null): Checked2 => {
  if (!isRecord(raw) || !hasKeys(raw, ['ev', 'c', 'sig'])) return { ok: false, why: 'shape' }
  const { ev, c, sig } = raw
  if (!isCore2(ev) || (c !== null && !isRecord(c))) return { ok: false, why: 'shape' }
  const cMax =
    ev.L === 'a'
      ? ev.t === 'migrate'
        ? LIMITS2.migrateContent
        : LIMITS2.aclContent
      : contentMax(c)
  if (sizeOf(ev) > LIMITS2.core || (c !== null && sizeOf(c) > cMax))
    return { ok: false, why: 'size' }
  if (ev.t === 'genesis' ? srv !== null : ev.srv !== srv) return { ok: false, why: 'server' }
  let idBytes: Uint8Array
  try {
    idBytes = eventIdBytes2(ev)
  } catch {
    return { ok: false, why: 'shape' }
  }
  const s = bytesOf(sig, 64)
  const pk = keyBytes(ev.dev)
  if (!s || !pk || !verify(pk, sigInput2(idBytes), s)) return { ok: false, why: 'signature' }
  if (c !== null) {
    if (!contentOk2(ev, c)) return { ok: false, why: 'content' }
    let hash: string
    try {
      hash = contentHash(c as Content)
    } catch {
      return { ok: false, why: 'content' }
    }
    if (hash !== ev.ch) return { ok: false, why: 'content' }
  } else if (ev.L === 'a') return { ok: false, why: 'content' }
  return { ok: true, id: b64u(idBytes), wire: { ev, c, sig: sig as string } }
}

// The ACL types whose content has a schema (acl/rules.ts); others are stored and inert.
const KNOWN_ACL: readonly string[] = [
  'genesis',
  'add',
  'uninvite',
  'join',
  'leave',
  'kick',
  'ban',
  'unban',
  'role_create',
  'role_move',
  'role_bits',
  'role_del',
  'assign',
  'revoke',
  'channel',
  'chperm',
  'settings',
  'code',
  'code_revoke',
  'profile',
  'mark',
  'device_add',
  'device_revoke',
  'primary_rotate',
  'proof',
  'upgrade',
  'migrate',
]

// A proof side as the ACL core reads it (acl/admit.ts ProofHeader), from a verified signed core.
const proofHeaderOf = (x: { ev: CoreV2 }): ProofHeader => {
  const h: ProofHeader = { id: eventId2(x.ev), dev: x.ev.dev, seq: x.ev.seq, L: x.ev.L }
  if (x.ev.aprev !== undefined) h.aprev = x.ev.aprev
  if (x.ev.cprev !== undefined) h.cprev = x.ev.cprev
  if (x.ev.ap) h.ap = x.ev.ap
  return h
}

// A validated v2 ACL event as the ACL core reads it (a proof's sides as headers).
export const aclEvOf = (id: string, w: WireV2): AclEv => {
  const e: AclEv = {
    id,
    t: w.ev.t,
    a: w.ev.a,
    dev: w.ev.dev,
    seq: w.ev.seq,
    ap: w.ev.ap ?? [],
    ts: w.ev.ts,
    c: (w.c ?? {}) as AclContent,
  }
  if (w.ev.t === 'proof' && w.c)
    e.c = {
      ...w.c,
      x: proofHeaderOf(w.c.x as { ev: CoreV2 }),
      y: proofHeaderOf(w.c.y as { ev: CoreV2 }),
    } as unknown as AclContent
  if (w.ev.aprev !== undefined) e.aprev = w.ev.aprev
  if (w.ev.iprev !== undefined) e.iprev = w.ev.iprev
  return e
}

// A validated v2 content event as content admission and visibility read it.
export const contentEvOf = (id: string, w: WireV2): ContentEv => {
  const m: ContentEv = {
    id,
    t: w.ev.t,
    a: w.ev.a,
    dev: w.ev.dev,
    seq: w.ev.seq,
    ap: w.ev.ap ?? [],
    ts: w.ev.ts,
    c: w.c,
  }
  if (w.ev.cprev !== undefined) m.cprev = w.ev.cprev
  return m
}
