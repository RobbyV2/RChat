import { sha256 } from '@noble/hashes/sha2.js'
import { isRecord } from '../bytes'
import { b64u, bytesOf, canonicalBytes, concat, hasKeys, utf8, isInt } from './canonical'
import { isKeyId, keyBytes, keyId, sign, verify, type Cert, type Revocation } from './keys'
import {
  LIMITS,
  contentHash,
  isTypeName,
  sizeOf,
  contentMax,
  isEventId,
  checkContent,
  type EvType,
  type Content,
  type Author,
  TARGETED,
} from './content'

// ----- Format v1 (direct messages) -----

// Signed room events (note section 3). The hashed core links the event into its room's DAG and
// binds the content through `ch`; the content sits outside the core, so a redaction can drop it
// and the event stays verifiable. Every event is validated in full before it is stored.
// Forward compatibility: fields this version doesn't know are kept (they are signed and hashed)
// but never read, and an event of a type it doesn't know is checked, stored and synced like any
// other but never shown, so the room's DAG stays whole when a newer peer writes one.
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

export interface Wire {
  ev: Core
  c: Content | null
  sig: string
}

export const TAG_EVENT = 'rchat-p2p-ev1\0'

export const TAG_SIG = 'rchat-p2p-sig1\0'

export const eventIdBytes = (core: Core) => sha256(concat(utf8(TAG_EVENT), canonicalBytes(core)))

export const eventId = (core: Core) => b64u(eventIdBytes(core))

const sigInput = (idBytes: Uint8Array) => concat(utf8(TAG_SIG), idBytes)

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
  // The two identities of a DM.
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
    bytesOf(ch, 32) !== null
  )
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
