import { sha256 } from '@noble/hashes/sha2.js'
import { isRecord } from '../bytes'
import { looksLikeEmoji } from '../emoji'
import { b64u, bytesOf, canonical, canonicalBytes, fromB64u, hasKeys, utf8 } from './canonical'
import { blockCount, EMPTY_ROOT } from './hashing'
import { isShortId } from './state'
import { isKeyId, type KeyPair } from './keys'

// The content of room events, as both formats carry it (v1 in DMs, v2 in P2P servers): its types,
// size limits and checks.

// `move`: written by a new device right after a device move, on top of the room heads it brought
// along, so the old device's events before the move stay vouched for (see sync).
// `call`: the log row of a call, written by the caller once it is over.
export type EvType = 'msg' | 'edit' | 'redact' | 'react' | 'pin' | 'move' | 'call'

// A type name a newer version may use.
export const isTypeName = (x: unknown): x is string =>
  typeof x === 'string' && /^[a-z][a-z0-9_]{0,31}$/.test(x)

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
  // P2P servers: the channel, a mention of everyone (shown as one only when the sender may), and
  // the thread's root (a top-level message of the same channel).
  ch?: string
  everyone?: true
  thread?: string
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

export const isInt = (x: unknown, min = 0): x is number =>
  Number.isSafeInteger(x) && (x as number) >= min

export const contentHash = (c: Content) => b64u(sha256(canonicalBytes(c)))

export interface Author {
  ik: KeyPair
  dk: KeyPair
}

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

// Any short key is admitted (versions must agree), but only an emoji shows: a chip, a ping, a
// notification. Others are inert.
export const shownReaction = (c: unknown) =>
  isRecord(c) && typeof c.key === 'string' && looksLikeEmoji(c.key)

export const checkContent = (type: string, c: unknown): c is Content => {
  if (!isRecord(c)) return false
  switch (type) {
    case 'msg':
      return (
        hasKeys(c, ['body']) &&
        isBody(c.body) &&
        (c.ch === undefined || isShortId(c.ch)) &&
        (c.everyone === undefined || c.everyone === true) &&
        (c.reply === undefined || isEventId(c.reply)) &&
        (c.thread === undefined || isEventId(c.thread)) &&
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

// Messages with files may be larger (names and thumbnails); everything else stays small.
export const contentMax = (c: unknown) =>
  isRecord(c) && (Array.isArray(c.att) || (isRecord(c.fwd) && Array.isArray(c.fwd.att)))
    ? LIMITS.attContent
    : LIMITS.content

// Drops thumbnails from the last attachment back until the content fits; null when it can't.
export const fitContent = <T extends { att?: { thumb?: string }[] }>(c: T): T | null => {
  if (sizeOf(c) <= contentMax(c)) return c
  if (!c.att?.length) return null
  const att = c.att.map(a => ({ ...a }))
  const out = { ...c, att }
  for (let i = att.length - 1; i >= 0 && sizeOf(out) > contentMax(out); i -= 1) delete att[i].thumb
  return sizeOf(out) <= contentMax(out) ? out : null
}

export const sizeOf = (x: unknown) => {
  try {
    return utf8(canonical(x)).length
  } catch {
    return Infinity
  }
}
