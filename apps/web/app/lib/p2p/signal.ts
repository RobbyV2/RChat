import { isRecord } from '../bytes'
import { declaredHosts } from '../relays'
import type { RtcTarget, Signaler } from '../rtc'
import type { RtcPayload } from '../types'
import { bytesOf, hasKeys, pickKeys } from './canonical'
import { isCallId } from './content'
import { isKeyId } from './keys'

// Call signaling over the encrypted session with a contact (note section 4): the media SDP and
// candidates never pass the instance, so the DTLS fingerprints they carry are authenticated by
// the session's device keys. Two message types:
// - `rtc {to, target, call, payload}`: one negotiation step of the call `call` in `target`;
// - `call {op, id, room, ...}`: ringing and the call's lifetime (calls.ts).
// Both follow the forward compatibility rule: unknown fields are ignored (and not passed on), a
// `call` op this version doesn't know is dropped without a strike, and only malformed known fields
// make a frame invalid.

export const SDP_MAX = 100_000
export const CANDIDATE_MAX = 2048

export interface RtcFrame {
  t: 'rtc'
  to: string
  target: { p2pRoom: string }
  call: string
  payload: RtcPayload
}

export type CallOp = 'ring' | 'accept' | 'decline' | 'end' | 'busy' | 'taken'
export const CALL_OPS: readonly CallOp[] = ['ring', 'accept', 'decline', 'end', 'busy', 'taken']

export interface CallFrame {
  t: 'call'
  op: CallOp
  id: string
  room: string
  // ring: whether it is a video call.
  video?: boolean
  // ring and accept: the relay hosts this side may connect through (relays.ts).
  relays?: string[]
}

export const isRoomId = (x: unknown): x is string =>
  typeof x === 'string' && bytesOf(x, 32) !== null

const isSid = (x: unknown): x is string => typeof x === 'string' && /^[0-9a-f]{1,32}$/.test(x)

const shortOrNull = (x: unknown, max: number) =>
  x === undefined || x === null || (typeof x === 'string' && x.length <= max)

const DESC_TYPES = ['offer', 'answer', 'pranswer', 'rollback']

const isDescription = (x: unknown) =>
  isRecord(x) &&
  DESC_TYPES.includes(x.type as string) &&
  (x.sdp === undefined || (typeof x.sdp === 'string' && x.sdp.length <= SDP_MAX))

const isCandidate = (x: unknown) =>
  isRecord(x) &&
  typeof x.candidate === 'string' &&
  x.candidate.length <= CANDIDATE_MAX &&
  shortOrNull(x.sdpMid, 64) &&
  (x.sdpMLineIndex === undefined ||
    x.sdpMLineIndex === null ||
    (Number.isSafeInteger(x.sdpMLineIndex) &&
      (x.sdpMLineIndex as number) >= 0 &&
      (x.sdpMLineIndex as number) < 64)) &&
  shortOrNull(x.usernameFragment, 256)

const FLAGS = ['muted', 'cam', 'screen', 'restart']
const PAYLOAD_KEYS = ['description', 'candidate', ...FLAGS, 'sid', 'rsid']

// A negotiation payload: the fields rtc.ts knows, checked and copied; any others are dropped.
export const readPayload = (x: unknown): RtcPayload | null => {
  if (
    !isRecord(x) ||
    (x.description !== undefined && !isDescription(x.description)) ||
    (x.candidate !== undefined && !isCandidate(x.candidate)) ||
    !FLAGS.every(k => x[k] === undefined || typeof x[k] === 'boolean') ||
    (x.sid !== undefined && !isSid(x.sid)) ||
    (x.rsid !== undefined && !isSid(x.rsid))
  )
    return null
  const p = pickKeys<RtcPayload>(x, PAYLOAD_KEYS)
  if (isRecord(x.description)) p.description = pickKeys(x.description, ['type', 'sdp'])
  if (isRecord(x.candidate))
    p.candidate = pickKeys(x.candidate, [
      'candidate',
      'sdpMid',
      'sdpMLineIndex',
      'usernameFragment',
    ])
  return p
}

export const readRtcFrame = (x: unknown): RtcFrame | null => {
  if (!isRecord(x) || !hasKeys(x, ['t', 'to', 'target', 'call', 'payload'])) return null
  const { t, to, target, call, payload } = x
  if (t !== 'rtc' || !isKeyId(to) || !isCallId(call)) return null
  if (!isRecord(target) || !isRoomId(target.p2pRoom)) return null
  const p = readPayload(payload)
  return p ? { t, to, target: { p2pRoom: target.p2pRoom }, call, payload: p } : null
}

// A `call` frame, `'unknown'` for a well-formed one whose op is newer than this version (dropped
// without a strike), or null when it is malformed.
export const readCallFrame = (x: unknown): CallFrame | 'unknown' | null => {
  if (!isRecord(x) || !hasKeys(x, ['t', 'op', 'id', 'room'])) return null
  const { t, op, id, room, video, relays } = x
  if (t !== 'call' || typeof op !== 'string' || !isCallId(id) || !isRoomId(room)) return null
  if (!CALL_OPS.includes(op as CallOp)) return op.length <= 32 ? 'unknown' : null
  if (op === 'ring' && typeof video !== 'boolean') return null
  // Relays are read only where this version uses them.
  const withRelays = (op === 'ring' || op === 'accept') && relays !== undefined
  const hosts = withRelays ? declaredHosts(relays) : []
  if (hosts === null || (withRelays && hosts.length !== (relays as unknown[]).length)) return null
  return {
    t,
    op: op as CallOp,
    id,
    room,
    ...(op === 'ring' ? { video: video as boolean } : {}),
    ...(withRelays ? { relays: hosts } : {}),
  }
}

// The P2P side of rtc.ts's Signaler: each payload goes to the contact `to` (an identity key) as
// an `rtc` frame of the current call, over the session the call is bound to.
export class P2pSignaler implements Signaler {
  constructor(
    private call: () => string | null,
    private out: (to: string, frame: RtcFrame) => void
  ) {}

  send(to: string, target: RtcTarget, payload: RtcPayload) {
    const call = this.call()
    if (target.p2pRoom === undefined || call === null) return
    this.out(to, { t: 'rtc', to, target: { p2pRoom: target.p2pRoom }, call, payload })
  }
}
