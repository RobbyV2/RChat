import { isRecord } from '../bytes'

// Wire framing for P2P sessions. Every frame is type (1 byte) | length (4 bytes, big endian) |
// payload. Handshake frames carry the SIGMA-I messages; data frames are AES-256-GCM with a
// 96-bit counter nonce per direction: epoch (1 byte) | counter (8 bytes) | ciphertext. A counter
// that isn't exactly the next one is refused, so frames can't be replayed, dropped or reordered
// without the session noticing. Messages larger than one frame are chunked.

// B1/B2 open a bulk pipe (blobs.ts): the opener's key epoch and nonce, then the other nonce.
export const FrameType = { H1: 1, H2: 2, H3: 3, Data: 16, B1: 32, B2: 33 } as const

export type FrameType = (typeof FrameType)[keyof typeof FrameType]

const TYPES: number[] = Object.values(FrameType)

// A frame type of this version; a newer one's frames are skipped, at no cost.
export const knownFrame = (type: number): type is FrameType => TYPES.includes(type)

export const HEADER = 5
// Ciphertext per data frame: chunk header (5) + data + GCM tag (16).
export const FRAME_MAX = 16 * 1024
const DATA_HEADER = 9
const CHUNK_HEADER = 5
const TAG_LEN = 16
export const CHUNK_DATA = FRAME_MAX - CHUNK_HEADER - TAG_LEN
export const MESSAGE_MAX = 1024 * 1024
// The largest frame on the wire.
export const WIRE_MAX = HEADER + DATA_HEADER + FRAME_MAX
// Counters stay below 2^53 so they fit a JS number; a session rekeys long before.
const COUNTER_MAX = Number.MAX_SAFE_INTEGER

export class FrameError extends Error {}

const fail = (why: string): never => {
  throw new FrameError(why)
}

export const encodeFrame = (type: FrameType, payload: Uint8Array) => {
  const out = new Uint8Array(HEADER + payload.length)
  const view = new DataView(out.buffer)
  out[0] = type
  view.setUint32(1, payload.length)
  out.set(payload, HEADER)
  return out
}

export const decodeFrame = (raw: ArrayBuffer | Uint8Array) => {
  const buf = raw instanceof Uint8Array ? raw : new Uint8Array(raw)
  if (buf.length < HEADER) fail('short frame')
  const len = new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint32(1)
  if (len !== buf.length - HEADER) fail('bad frame length')
  if (buf.length > WIRE_MAX) fail('frame too large')
  return { type: buf[0], payload: buf.subarray(HEADER) }
}

// ----- AES-256-GCM -----

export const nonceOf = (counter: number) => {
  const n = new Uint8Array(12)
  new DataView(n.buffer).setBigUint64(4, BigInt(counter))
  return n
}

const importKey = (key: Uint8Array) =>
  crypto.subtle.importKey('raw', key as BufferSource, 'AES-GCM', false, ['encrypt', 'decrypt'])

export const gcmSeal = async (key: Uint8Array, nonce: Uint8Array, pt: Uint8Array) =>
  new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce as BufferSource },
      await importKey(key),
      pt as BufferSource
    )
  )

export const gcmOpen = async (key: Uint8Array, nonce: Uint8Array, ct: Uint8Array) =>
  new Uint8Array(
    await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: nonce as BufferSource },
      await importKey(key),
      ct as BufferSource
    )
  )

// One direction of a session under one key. The counter advances on every frame.
export class Cipher {
  private key: Promise<CryptoKey>
  private next = 0
  bytes = 0

  constructor(raw: Uint8Array) {
    this.key = importKey(raw)
    raw.fill(0)
  }

  get counter() {
    return this.next
  }

  // Takes the counter now, so frames sealed in a row keep their order even though encryption is
  // asynchronous.
  seal(pt: Uint8Array): Promise<{ counter: number; ct: Uint8Array }> {
    const counter = this.next
    if (counter >= COUNTER_MAX) return Promise.reject(new FrameError('counter exhausted'))
    this.next += 1
    this.bytes += pt.length
    return this.key.then(async key => ({
      counter,
      ct: new Uint8Array(
        await crypto.subtle.encrypt(
          { name: 'AES-GCM', iv: nonceOf(counter) as BufferSource },
          key,
          pt as BufferSource
        )
      ),
    }))
  }

  // Refuses any counter but the expected one before decrypting, and consumes it either way: a
  // frame that fails to authenticate ends the session, so the counter never rolls back.
  async open(counter: number, ct: Uint8Array): Promise<Uint8Array> {
    if (counter !== this.next) fail(counter < this.next ? 'counter reused' : 'counter skipped')
    this.next += 1
    let pt: Uint8Array
    try {
      pt = new Uint8Array(
        await crypto.subtle.decrypt(
          { name: 'AES-GCM', iv: nonceOf(counter) as BufferSource },
          await this.key,
          ct as BufferSource
        )
      )
    } catch {
      return fail('frame did not authenticate')
    }
    this.bytes += pt.length
    return pt
  }
}

export const dataPayload = (epoch: number, counter: number, ct: Uint8Array) => {
  const out = new Uint8Array(DATA_HEADER + ct.length)
  out[0] = epoch & 0xff
  new DataView(out.buffer).setBigUint64(1, BigInt(counter))
  out.set(ct, DATA_HEADER)
  return out
}

export const parseData = (payload: Uint8Array) => {
  if (payload.length < DATA_HEADER + TAG_LEN) fail('short data frame')
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
  const big = view.getBigUint64(1)
  if (big > BigInt(COUNTER_MAX)) fail('counter out of range')
  return { epoch: payload[0], counter: Number(big), ct: payload.subarray(DATA_HEADER) }
}

// ----- Chunking -----

// Splits a message into chunk plaintexts: seq (4 bytes) | last (1 byte) | data.
export const chunk = (msg: Uint8Array): Uint8Array[] => {
  if (msg.length > MESSAGE_MAX) fail('message too large')
  const parts: Uint8Array[] = []
  const count = Math.max(1, Math.ceil(msg.length / CHUNK_DATA))
  for (let seq = 0; seq < count; seq += 1) {
    const data = msg.subarray(seq * CHUNK_DATA, (seq + 1) * CHUNK_DATA)
    const out = new Uint8Array(CHUNK_HEADER + data.length)
    new DataView(out.buffer).setUint32(0, seq)
    out[4] = seq === count - 1 ? 1 : 0
    out.set(data, CHUNK_HEADER)
    parts.push(out)
  }
  return parts
}

export class Reassembler {
  private parts: Uint8Array[] = []
  private size = 0

  constructor(private max = MESSAGE_MAX) {}

  // The whole message once its last chunk arrived, else null.
  push(pt: Uint8Array): Uint8Array | null {
    if (pt.length < CHUNK_HEADER) fail('short chunk')
    const seq = new DataView(pt.buffer, pt.byteOffset, pt.byteLength).getUint32(0)
    if (seq !== this.parts.length) fail('chunk out of order')
    const last = pt[4]
    if (last > 1) fail('bad chunk flag')
    const data = pt.subarray(CHUNK_HEADER)
    this.size += data.length
    if (this.size > this.max) fail('message too large')
    this.parts.push(data)
    if (!last) return null
    const out = new Uint8Array(this.size)
    let at = 0
    for (const p of this.parts) {
      out.set(p, at)
      at += p.length
    }
    this.parts = []
    this.size = 0
    return out
  }
}

// ----- Messages -----

export interface Message {
  t: string
  [key: string]: unknown
}

const enc = new TextEncoder()
const dec = new TextDecoder('utf-8', { fatal: true })

export const encodeMessage = (m: Message) => enc.encode(JSON.stringify(m))

export const decodeMessage = (b: Uint8Array): Message => {
  let v: unknown
  try {
    v = JSON.parse(dec.decode(b))
  } catch {
    return fail('message is not JSON')
  }
  if (!isRecord(v) || typeof v.t !== 'string' || v.t.length > 32) fail('message has no type')
  return v as Message
}
