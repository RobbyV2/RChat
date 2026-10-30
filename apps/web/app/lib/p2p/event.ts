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
import { blockCount, EMPTY_ROOT } from './hashing'
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
export type EvType = 'msg' | 'edit' | 'redact' | 'react' | 'pin' | 'move' | 'call'

export const EV_TYPES: readonly EvType[] = ['msg', 'edit', 'redact', 'react', 'pin', 'move', 'call']

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
}

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
  MsgContent | EditContent | RedactContent | ReactContent | PinContent | MoveContent | CallContent

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

// Signs a new event. `prev` are the room heads (deepest first), `depth` one more than theirs.
export const buildEvent = (
  author: Author,
  room: string,
  type: EvType,
  content: Content,
  prev: string[],
  depth: number,
  ts: number
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

export const checkContent = (type: string, c: unknown): c is Content => {
  if (!isRecord(c)) return false
  switch (type) {
    case 'msg':
      return (
        hasKeys(c, ['body']) &&
        isBody(c.body) &&
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
  w.c && TARGETED.includes(w.ev.type) && 'target' in w.c ? w.c.target : null

// ----- Validation -----

export interface Devices {
  certs: Cert[]
  revocations: Revocation[]
}

export interface RoomAuth {
  room: string
  // The two identities of a DM.
  members: readonly string[]
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
    bytesOf(ch, 32) !== null
  )
}

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
  if (ev.room !== auth.room) return bad('room')
  if (
    ev.prev.length > LIMITS.prev ||
    new Set(ev.prev).size !== ev.prev.length ||
    !ev.prev.every(isEventId) ||
    (ev.prev.length === 0) !== (ev.depth === 0)
  )
    return bad('prev')
  if (!auth.members.includes(ev.sender)) return bad('sender')
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
  if (c !== null) {
    if (!checkContent(ev.type, c)) return bad('content')
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
