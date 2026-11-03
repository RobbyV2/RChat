import { sha256 } from '@noble/hashes/sha2.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { imageSize, NEUTRAL_TYPE, safeType, SNIFF_BYTES } from '../sniff'
import { b64u, bytesOf, concat, equalBytes, fromB64u, randomBytes, utf8 } from './canonical'
import type { BlobRecord, EventRecord, HashPage, P2pDatabase, P2pStore } from './db'
import type { Attachment } from './event'
import {
  chunk,
  Cipher,
  dataPayload,
  decodeFrame,
  decodeMessage,
  encodeFrame,
  encodeMessage,
  FrameError,
  FrameType,
  MESSAGE_MAX,
  parseData,
  Reassembler,
  WIRE_MAX,
  type Message,
} from './frames'
import {
  BLOCK,
  blobRootOf,
  blockCount,
  digest,
  EMPTY_ROOT,
  HASH_PAGE,
  type Hashed,
} from './hashing'
import type { P2pNode } from './node'
import { realClock, type Clock, type Pipe, type Session } from './session'

// P2P attachments (note section 5). Files are split into 1 MiB blocks, named by a root hash over
// the block hashes, and fetched block by block over a separate encrypted pipe per session
// (`rcp1b`), so file transfers never hold up chat and never count against the chat session's
// limits. Every block is checked against its hash before it is stored, so blocks can come from
// several holders at once and a download resumes after a disconnect or a reload. A holder serves
// a file only to a contact who shares a conversation with a live message that carries it, and
// checks that again for every block.

export const BULK = {
  // Plaintext bytes of a block per frame, and frames sent before waiting for the pipe to drain.
  chunk: 15 * 1024,
  batch: 16,
  // Verified blocks waiting to be written before no more are asked for.
  writes: 4,
  // Block requests we keep outstanding per pipe, all downloads together, and never more than
  // the credit the holder advertised.
  window: 2,
  // The credit we advertise: block requests a peer may have queued or in service with us. They
  // are served one after another; only a request past this credit is refused (with a strike).
  serveMax: 2,
  // Frames received and not yet handled, on top of the block bytes we asked for and haven't
  // received yet, before the pipe counts as flooded.
  queueBytes: 4 * MESSAGE_MAX,
  // Control requests (meta, has) we keep outstanding per pipe, and a peer may have waiting with
  // us. One past it gets `busy` (no strike): only far more of those than any client of ours can
  // cause in a minute counts against the peer.
  controlMax: 4,
  busyFree: 256,
  metaPage: HASH_PAGE,
  // Files asked about in one `blob_has`; the block hashes of files with at most `smallMeta`
  // blocks come with the answer, so small files need no `blob_meta` of their own.
  hasMax: 64,
  smallMeta: 16,
  // Cancels a peer may send per minute before they count against it.
  cancelsFree: 120,
  // Bytes of cancelled blocks that may still be on the way on one pipe; past it the pipe is
  // replaced (no strike) instead of waiting for them.
  graceBytes: 8 * BLOCK,
  strikes: 20,
  // One strike is forgiven per this long, so rare harmless events never add up to a ban.
  forgiveMs: 60_000,
  banMs: 10 * 60_000,
  openMs: 15_000,
  // A block that makes no progress for this long (while its pipe makes none either) goes to
  // another holder.
  stallMs: 30_000,
  // A pipe is replaced (fresh keys) after this many bytes or this long.
  pipeBytes: 1024 ** 3,
  pipeMs: 60 * 60_000,
  // Pipes a peer may open to us (still opening ones included), per session and per identity.
  inSession: 2,
  inPeer: 4,
  // Blocks read from storage at once to serve them.
  readers: 4,
  // Holders asked again after this long.
  probeMs: 60_000,
  // A served file's last-used time is written at most this often.
  touchMs: 60_000,
  // Free space kept on top of a download.
  margin: 16 * 1024 * 1024,
}

export type BulkLimits = typeof BULK

export const PIPE_INFO = 'rchat-p2p bulk pipe1'

export const NO_ROOM_TEXT = (need: number, free: number) =>
  `Not enough storage on this device for this file (${fmtMb(need)} needed, ${fmtMb(free)} free).`
export const OFF_TEXT = 'Attachments are turned off on this instance.'
export const SHARE_ROOM_TEXT = 'Not enough storage on this device to share this file.'
export const MISMATCH_TEXT = "This file doesn't match what was sent."

const fmtMb = (n: number) =>
  n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : `${(n / 1024 ** 2).toFixed(1)} MB`

// ----- Storage helpers -----

export const partRange = (h: string) => IDBKeyRange.bound([h, 0], [h, Number.MAX_SAFE_INTEGER])

const blockLen = (size: number, i: number) => Math.min(BLOCK, size - i * BLOCK)

const HASH = 32

// The block hashes of a file, laid end to end, as pages to store once.
export const hashPages = (h: string, flat: Uint8Array): HashPage[] => {
  const out: HashPage[] = []
  const per = HASH_PAGE * HASH
  for (let at = 0, page = 0; at < flat.length; at += per, page += 1)
    out.push({ h, page, data: flat.slice(at, at + per) })
  return out
}

export const flatHashes = (list: (string | Uint8Array)[]) => {
  const out = new Uint8Array(list.length * HASH)
  list.forEach((b, i) => out.set(typeof b === 'string' ? fromB64u(b) : b, i * HASH))
  return out
}

// All block hashes of a stored file, or null when they aren't all there.
export const readHashes = async (db: P2pDatabase, h: string, count: number) => {
  const pages = await db.getAll('blob_hashes', partRange(h))
  pages.sort((a, b) => a.page - b.page)
  const out = new Uint8Array(count * HASH)
  let at = 0
  for (const p of pages) {
    if (p.page * HASH_PAGE * HASH !== at || at + p.data.length > out.length) return null
    out.set(p.data, at)
    at += p.data.length
  }
  return at === out.length ? out : null
}

// The whole file, put together from what is stored (the sender's own file, or the verified
// blocks). Nothing is read into memory: the parts are Blobs backed by the browser's storage.
export const assemble = async (db: P2pDatabase, h: string): Promise<Blob | null> => {
  const rec = await db.get('blobs', h)
  if (!rec?.done) return null
  const type = rec.type ?? NEUTRAL_TYPE
  if (rec.file) return new Blob([rec.file], { type })
  const parts = await db.getAll('blob_parts', partRange(h))
  if (parts.length !== blockCount(rec.size)) return null
  return new Blob(
    parts.sort((a, b) => a.block - b.block).map(p => p.data),
    { type }
  )
}

export const readBlock = async (db: P2pDatabase, rec: BlobRecord, i: number) => {
  if (rec.file)
    return new Uint8Array(await rec.file.slice(i * BLOCK, (i + 1) * BLOCK).arrayBuffer())
  const part = await db.get('blob_parts', [rec.h, i])
  return part ? new Uint8Array(await part.data.arrayBuffer()) : null
}

export interface Usage {
  files: number
  bytes: number
  sent: number
  downloaded: number
}

export const usageOf = (list: BlobRecord[]): Usage => {
  let sent = 0
  let downloaded = 0
  for (const r of list) {
    if (r.own) sent += r.size
    else downloaded += r.done ? r.size : Math.min(r.size, r.have * BLOCK)
  }
  return { files: list.length, bytes: sent + downloaded, sent, downloaded }
}

// Which blocks of a file are in, one bit each.
export class Bits {
  private bits: Uint8Array
  size = 0

  constructor(readonly n: number) {
    this.bits = new Uint8Array(Math.ceil(n / 8))
  }

  has(i: number) {
    return i >= 0 && i < this.n && (this.bits[i >> 3] & (1 << (i & 7))) !== 0
  }

  add(i: number) {
    if (i < 0 || i >= this.n || this.has(i)) return
    this.bits[i >> 3] |= 1 << (i & 7)
    this.size += 1
  }
}

// ----- The bulk pipe -----

const PART_MSG = 0
const PART_CHUNK = 1
const CHUNK_HEAD = 1 + 32 + 4 + 4

const pipeKey = (key: Uint8Array, salt: Uint8Array) => hkdf(sha256, key, salt, utf8(PIPE_INFO), 32)

export type LinkClose = 'closed' | 'remote' | 'strikes' | 'handshake' | 'old'

export interface LinkHooks {
  onMessage: (msg: Message, link: BulkLink) => void
  onChunk: (h: string, block: number, off: number, data: Uint8Array, link: BulkLink) => void
  onOpen: (link: BulkLink) => void
  onClose: (link: BulkLink, why: LinkClose) => void
}

// A block request a peer made of us, queued or being sent.
export interface ServeReq {
  key: string
  h: string
  block: number
  cancelled: boolean
}

// What is left of a block we stopped asking for: its remaining chunks may still be on the way
// until the holder answers (a request ends with its last byte or exactly one `blob_no`), and
// are dropped without a strike. The pipe is ordered, so they come before anything asked later.
interface Abandoned {
  next: number
  end: number
}

// Block hashes of a small file, from a `blob_has` answer, still to be checked against its root.
interface SmallMeta {
  size: number
  blocks: string[]
}

// One bulk pipe: a short handshake binds it to its session's bulk keys (fresh keys per pipe from
// both sides' nonces), then AES-GCM frames with counters, as in the session. Strikes here never
// touch the chat session.
export class BulkLink {
  state: 'opening' | 'open' | 'closed' = 'opening'
  strikes = 0
  private forgiven = 0
  // Bytes of frames received and not handled yet.
  queued = 0
  maxQueued = 0
  // Block bytes we asked for and have not received yet: they never count as a flood.
  expect = 0
  // As the holder: their block requests, waiting and in service (until its last batch goes
  // out), and their control requests waiting.
  serveQueue: ServeReq[] = []
  serveCur: ServeReq | null = null
  serveBusy = false
  control = 0
  recs = new Map<string, BlobRecord>()
  private tallies = new Map<string, { n: number; at: number }>()
  // As the downloader: what the holder lets us keep outstanding, our requests, and blocks we
  // stopped asking for.
  credit = 1
  rid = 0
  calls = new Map<number, { t: string; done: (m: Message | null) => void }>()
  // Control calls in flight (at most controlMax), the ones waiting for a turn, and calls whose
  // answer came too late (dropped without a strike).
  private ctl = 0
  private ctlWait: (() => void)[] = []
  private late = new Set<number>()
  // Files asked about in the next `blob_has`, and whether one is under way.
  hasWant = new Map<string, ((have: boolean) => void)[]>()
  hasBusy = false
  metas = new Map<string, SmallMeta>()
  fetches = new Map<string, Fetch>()
  abandoned = new Map<string, Abandoned[]>()
  lastChunk = 0
  rotating = false
  bytes = 0
  openedAt = 0
  private rxFrames = 0
  private tx: Cipher | null = null
  private rx: Cipher | null = null
  private reasm = new Reassembler()
  private rxChain: Promise<unknown> = Promise.resolve()
  private txChain: Promise<unknown> = Promise.resolve()
  private nonce = randomBytes(16)
  private timer: unknown = null
  private openFn: ((ok: boolean) => void) | null = null
  private epoch = -1

  constructor(
    readonly session: Session,
    private pipe: Pipe,
    readonly opener: boolean,
    private hooks: LinkHooks,
    private clock: Clock,
    private limits: BulkLimits
  ) {
    pipe.onData(data => {
      if (this.state === 'closed') return
      const cost = Math.max(data.byteLength, 1024)
      const room = this.limits.queueBytes + this.expect + (this.expect >> 4)
      if (data.byteLength > WIRE_MAX || this.queued + cost > room)
        return this.close(this.state === 'open' ? 'strikes' : 'handshake')
      this.queued += cost
      this.maxQueued = Math.max(this.maxQueued, this.queued)
      this.rxChain = this.rxChain
        .then(() => this.receive(data))
        .catch(() => this.close('strikes'))
        .finally(() => {
          this.queued -= cost
        })
    })
    pipe.onClose(() => this.finish('remote'))
  }

  get ik() {
    return this.session.remote?.ik ?? ''
  }

  // Opener: B1 {epoch, nonce}; the other side answers B2 {nonce}. Resolves false on failure.
  start(): Promise<boolean> {
    return new Promise(resolve => {
      this.openFn = resolve
      this.timer = this.clock.set(() => this.close('handshake'), this.limits.openMs)
      if (!this.opener) return
      const epoch = this.session.epoch
      if (epoch < 0) return this.close('handshake')
      this.epoch = epoch
      this.raw(FrameType.B1, concat(new Uint8Array([epoch]), this.nonce))
    })
  }

  private raw(type: FrameType, payload: Uint8Array) {
    try {
      this.pipe.send(encodeFrame(type, payload))
    } catch {
      this.finish('remote')
    }
  }

  private async keysFor(epoch: number, salt: Uint8Array) {
    const k = await this.session.waitBulkKeys(epoch, this.limits.openMs)
    if (!k) return false
    this.tx = new Cipher(pipeKey(k.send, salt))
    this.rx = new Cipher(pipeKey(k.recv, salt))
    k.send.fill(0)
    k.recv.fill(0)
    return true
  }

  private opened() {
    if (this.state !== 'opening') return
    this.state = 'open'
    this.openedAt = this.clock.now()
    if (this.timer !== null) this.clock.clear(this.timer)
    this.timer = null
    this.openFn?.(true)
    this.openFn = null
    this.hooks.onOpen(this)
  }

  private async receive(data: Uint8Array) {
    if (this.state === 'closed') return
    let frame
    try {
      frame = decodeFrame(data)
    } catch {
      return this.close(this.state === 'open' ? 'strikes' : 'handshake')
    }
    if (this.state === 'opening') {
      if (!this.opener && frame.type === FrameType.B1 && frame.payload.length === 17) {
        const epoch = frame.payload[0]
        const theirs = frame.payload.slice(1)
        if (!(await this.keysFor(epoch, concat(theirs, this.nonce)))) return this.close('handshake')
        if (this.state !== 'opening') return
        this.raw(FrameType.B2, this.nonce)
        return this.opened()
      }
      if (this.opener && frame.type === FrameType.B2 && frame.payload.length === 16) {
        if (!(await this.keysFor(this.epoch, concat(this.nonce, frame.payload))))
          return this.close('handshake')
        return this.opened()
      }
      return this.close('handshake')
    }
    if (frame.type !== FrameType.Data || !this.rx) return this.strike()
    const { counter, ct } = parseData(frame.payload)
    let pt: Uint8Array
    try {
      pt = await this.rx.open(counter, ct)
    } catch {
      // The first frame failing means the two sides took different keys (a rekey in flight):
      // a failed handshake, not an attack. Later it means the pipe is broken or tampered with.
      return this.close(this.rxFrames === 0 ? 'handshake' : 'strikes')
    }
    this.rxFrames += 1
    this.bytes += pt.length
    if (pt.length < 1) return this.strike()
    if (pt[0] === PART_CHUNK) {
      if (pt.length <= CHUNK_HEAD) return this.strike()
      const view = new DataView(pt.buffer, pt.byteOffset, pt.byteLength)
      const h = b64u(pt.subarray(1, 33))
      this.hooks.onChunk(h, view.getUint32(33), view.getUint32(37), pt.subarray(CHUNK_HEAD), this)
      return
    }
    // A part kind from a newer version: ignored, at no cost (the byte budget still applies).
    if (pt[0] !== PART_MSG) return
    let msg: Message
    try {
      const whole = this.reasm.push(pt.subarray(1))
      if (!whole) return
      msg = decodeMessage(whole)
    } catch {
      this.reasm = new Reassembler()
      return this.strike()
    }
    this.hooks.onMessage(msg, this)
  }

  private seal(parts: Uint8Array[]) {
    const tx = this.tx
    if (!tx || this.state !== 'open') return Promise.resolve()
    const sealed = parts.map(p => tx.seal(p))
    const run = this.txChain.then(async () => {
      for (const p of sealed) {
        const { counter, ct } = await p
        if (this.state === 'closed') return
        this.bytes += ct.length
        this.raw(FrameType.Data, dataPayload(0, counter, ct))
      }
    })
    this.txChain = run.catch(() => {})
    return run
  }

  send(msg: Message) {
    let parts: Uint8Array[]
    try {
      parts = chunk(encodeMessage(msg)).map(p => concat(new Uint8Array([PART_MSG]), p))
    } catch {
      return Promise.reject(new FrameError('message too large'))
    }
    return this.seal(parts)
  }

  // Sends one block, a batch of frames at a time, waiting for the transport to drain between
  // batches so at most about a batch waits in its buffers. `live` stops it (a cancel); `last`
  // runs just before the final batch is sealed, so the request's credit is free again before
  // the peer can possibly have the whole block. False when it stopped early.
  async sendBlock(
    h: string,
    block: number,
    data: Uint8Array,
    live: () => boolean = () => true,
    last: () => void = () => {}
  ) {
    const hb = fromB64u(h)
    const step = BULK.chunk * BULK.batch
    for (let at = 0; at < data.length; at += step) {
      if (this.state !== 'open' || !live()) return false
      const parts: Uint8Array[] = []
      for (let off = at; off < Math.min(data.length, at + step); off += BULK.chunk) {
        const part = data.subarray(off, off + BULK.chunk)
        const out = new Uint8Array(CHUNK_HEAD + part.length)
        out[0] = PART_CHUNK
        out.set(hb, 1)
        const view = new DataView(out.buffer)
        view.setUint32(33, block)
        view.setUint32(37, off)
        out.set(part, CHUNK_HEAD)
        parts.push(out)
      }
      if (at + step >= data.length) last()
      await this.seal(parts)
      if (this.pipe.drain) await this.pipe.drain()
    }
    return this.state === 'open'
  }

  // A request of ours; null when the pipe closed or the answer never came. At most controlMax
  // are out at once; the rest wait their turn. A `busy` answer (the holder counted one more than
  // we sent, e.g. its answer and our next request crossed) is asked again a few times.
  async call(msg: Message, t: string): Promise<Message | null> {
    for (let tries = 0; tries < 4; tries += 1) {
      if (!(await this.slot())) return null
      let ans: Message | null
      try {
        ans = await this.callOnce(msg, t)
      } finally {
        this.ctl -= 1
        this.ctlWait.shift()?.()
      }
      if (ans?.t === 'blob_no' && ans.why === 'busy') continue
      return ans
    }
    return null
  }

  private slot(): Promise<boolean> {
    if (this.state !== 'open') return Promise.resolve(false)
    if (this.ctl < this.limits.controlMax) {
      this.ctl += 1
      return Promise.resolve(true)
    }
    return new Promise(resolve =>
      this.ctlWait.push(() => {
        if (this.state !== 'open') return resolve(false)
        this.ctl += 1
        resolve(true)
      })
    )
  }

  // An answer to a call that already timed out.
  lateAnswer(rid: number) {
    return this.late.delete(rid)
  }

  // Counts an event per minute; true once it happened more than `free` times this minute.
  tally(kind: string, free: number) {
    const now = this.clock.now()
    const c = this.tallies.get(kind) ?? { n: 0, at: now }
    if (now - c.at >= this.limits.forgiveMs) {
      c.n = 0
      c.at = now
    }
    c.n += 1
    this.tallies.set(kind, c)
    return c.n > free
  }

  private callOnce(msg: Message, t: string): Promise<Message | null> {
    if (this.state !== 'open') return Promise.resolve(null)
    const rid = ++this.rid
    return new Promise(resolve => {
      const timer = this.clock.set(() => {
        this.calls.delete(rid)
        this.late.add(rid)
        if (this.late.size > 64) this.late.delete(this.late.values().next().value as number)
        resolve(null)
      }, this.limits.openMs * 2)
      this.calls.set(rid, {
        t,
        done: m => {
          this.clock.clear(timer)
          resolve(m)
        },
      })
      this.send({ ...msg, rid }).catch(() => {
        this.calls.delete(rid)
        this.clock.clear(timer)
        resolve(null)
      })
    })
  }

  // Too old or too much traffic for one set of pipe keys: a new pipe takes over.
  get stale() {
    return (
      this.bytes >= this.limits.pipeBytes ||
      (this.openedAt > 0 && this.clock.now() - this.openedAt >= this.limits.pipeMs)
    )
  }

  // Requests the holder still counts against our credit.
  get busy() {
    return this.fetches.size
  }

  strike(n = 1) {
    if (this.state === 'closed') return
    const now = this.clock.now()
    if (this.forgiven === 0) this.forgiven = now
    const back = Math.floor((now - this.forgiven) / this.limits.forgiveMs)
    if (back > 0) {
      this.strikes = Math.max(0, this.strikes - back)
      this.forgiven += back * this.limits.forgiveMs
    }
    this.strikes += n
    if (this.strikes >= this.limits.strikes) this.close('strikes')
  }

  close(why: LinkClose = 'closed') {
    if (this.state === 'closed') return
    const pipe = this.pipe
    void this.txChain.then(() => pipe.close())
    this.finish(why)
  }

  private finish(why: LinkClose) {
    if (this.state === 'closed') return
    this.state = 'closed'
    if (this.timer !== null) this.clock.clear(this.timer)
    this.timer = null
    this.tx = null
    this.rx = null
    this.openFn?.(false)
    this.openFn = null
    for (const c of this.calls.values()) c.done(null)
    this.calls.clear()
    for (const w of this.ctlWait.splice(0)) w()
    for (const list of this.hasWant.values()) for (const fn of list) fn(false)
    this.hasWant.clear()
    for (const r of this.serveQueue) r.cancelled = true
    if (this.serveCur) this.serveCur.cancelled = true
    this.serveQueue = []
    this.serveCur = null
    this.recs.clear()
    this.hooks.onClose(this, why)
  }
}

// ----- Downloads -----

// One block being received from one holder.
export interface Fetch {
  dl: Download
  block: number
  buf: Uint8Array
  got: number
  at: number
  timer?: unknown
}

export type BlobState = 'none' | 'waiting' | 'downloading' | 'done' | 'failed' | 'removed'

export interface BlobView {
  state: BlobState
  got: number
  total: number
  // Online contacts that have it.
  holders: number
  // Sniffed type once stored.
  type: string | null
  error: string | null
}

export const EMPTY_VIEW: BlobView = {
  state: 'none',
  got: 0,
  total: 0,
  holders: 0,
  type: null,
  error: null,
}

export class Download {
  have: Bits
  // Block hashes, 32 bytes each, once checked against `h`.
  hashes: Uint8Array | null = null
  // Holders that sent a bad block: not asked again for this file.
  bad = new Set<BulkLink>()
  // Holders that said they don't have it, or refused: skipped until a session comes up.
  skip = new Set<BulkLink>()
  refused = new Set<BulkLink>()
  // Holders whose size for the file differs from the message's.
  mismatch = 0
  inflight = new Map<number, BulkLink>()
  // Blocks handed out in order from `next`; ones that came back (a cancel, a stall, a closed
  // pipe, a bad block) wait in `retry`.
  next = 0
  retry: number[] = []
  state: 'running' | 'waiting' | 'done' | 'failed' | 'removed' = 'running'
  error: string | null = null
  metaBusy = false
  writes: Promise<unknown> = Promise.resolve()
  // Blocks received and not stored yet.
  writing = 0

  constructor(
    readonly h: string,
    readonly size: number
  ) {
    this.have = new Bits(blockCount(size))
  }

  get count() {
    return blockCount(this.size)
  }

  get got() {
    return Math.min(this.size, this.have.size * BLOCK)
  }
}

// ----- The manager -----

// The serving gate's answer: may have it, may not (or doesn't exist here), or attachments are
// off on this instance.
export type Gate = 'yes' | 'no' | 'off'

export interface BlobsDeps {
  node: P2pNode
  store: P2pStore
  clock?: Clock
  limits?: Partial<BulkLimits>
  // Whether `ik` may fetch `h` from us: a contact we are not blocking, sharing a conversation
  // with a live message that carries it and that `ik` did not write.
  entitled: (ik: string, h: string) => Promise<boolean>
  // Who may hold `h`: the other members of the conversations whose live messages carry it.
  members: (h: string) => Promise<string[]>
  // Attachments are off (the instance is text only).
  enabled?: () => boolean
  // Free bytes for downloads, or null when the platform can't tell.
  room?: () => Promise<number | null>
}

const hashOk = (x: unknown): x is string => typeof x === 'string' && bytesOf(x, 32) !== null

const blockOk = (x: unknown): x is number => Number.isSafeInteger(x) && (x as number) >= 0

export class Blobs {
  readonly limits: BulkLimits
  private clock: Clock
  private links = new Set<BulkLink>()
  // Pipes peers opened to us, counted from the moment they arrive.
  private inbound = new Set<BulkLink>()
  private dialing = new Map<Session, Promise<BulkLink | null>>()
  private downloads = new Map<string, Download>()
  private holders = new Map<string, { links: Set<BulkLink>; at: number }>()
  private probing = new Map<string, Promise<void>>()
  private banned = new Map<string, number>()
  private touched = new Map<string, number>()
  private fns = new Set<(h: string) => void>()
  private readers = 0
  private readQueue: (() => void)[] = []
  private turn = 0
  private stopped = false

  constructor(private deps: BlobsDeps) {
    this.clock = deps.clock ?? realClock
    this.limits = { ...BULK, ...deps.limits }
    deps.node.use({
      attach: () => {},
      ready: () => this.kick(),
      bulk: (pipe, s) => this.accept(pipe, s),
    })
  }

  private get store() {
    return this.deps.store
  }

  private get db() {
    return this.deps.store.db
  }

  private enabled() {
    return this.deps.enabled?.() ?? true
  }

  onChange(fn: (h: string) => void) {
    this.fns.add(fn)
    return () => void this.fns.delete(fn)
  }

  private changed(h: string) {
    for (const fn of this.fns) fn(h)
  }

  // ----- Pipes -----

  private hooks: LinkHooks = {
    onMessage: (m, l) => this.onMessage(m, l),
    onChunk: (h, b, off, data, l) => this.onChunk(h, b, off, data, l),
    onOpen: l => {
      this.links.add(l)
    },
    onClose: (l, why) => this.closed(l, why),
  }

  private isBanned(ik: string) {
    const until = this.banned.get(ik)
    if (until === undefined) return false
    if (until > this.clock.now()) return true
    this.banned.delete(ik)
    return false
  }

  private accept(pipe: Pipe, s: Session) {
    const ik = s.remote?.ik
    let session = 0
    let peer = 0
    for (const l of this.inbound) {
      if (l.session === s) session += 1
      if (l.ik === ik) peer += 1
    }
    if (
      !ik ||
      this.stopped ||
      this.isBanned(ik) ||
      session >= this.limits.inSession ||
      peer >= this.limits.inPeer
    )
      return pipe.close()
    const link = new BulkLink(s, pipe, false, this.hooks, this.clock, this.limits)
    this.inbound.add(link)
    s.onClose(() => link.close('closed'))
    void link.start()
  }

  // Our own pipe to a session's device: the newest one that isn't stale. A stale one with
  // nothing outstanding is closed; one still in use carries on until a new one is open.
  private linkTo(s: Session): Promise<BulkLink | null> {
    const ik = s.remote?.ik
    if (!ik || s.state !== 'ready' || this.isBanned(ik)) return Promise.resolve(null)
    const mine = [...this.links].filter(l => l.session === s && l.opener && l.state === 'open')
    const fresh = mine.filter(l => !l.stale).sort((a, b) => b.openedAt - a.openedAt)[0]
    for (const l of mine)
      if (l !== fresh && l.stale && l.busy === 0 && l.abandoned.size === 0) l.close('old')
    if (fresh) return Promise.resolve(fresh)
    const old = mine.find(l => l.state === 'open') ?? null
    const busy = this.dialing.get(s)
    if (busy) return busy.then(l => l ?? old)
    const run = (async () => {
      try {
        const pipe = await this.deps.node.dialBulk(s)
        if (s.state !== 'ready' || this.stopped) {
          pipe.close()
          return null
        }
        const link = new BulkLink(s, pipe, true, this.hooks, this.clock, this.limits)
        s.onClose(() => link.close('closed'))
        return (await link.start()) ? link : null
      } catch {
        return null
      } finally {
        this.dialing.delete(s)
      }
    })()
    this.dialing.set(s, run)
    return run.then(l => l ?? (old?.state === 'open' ? old : null))
  }

  private closed(link: BulkLink, why: LinkClose) {
    this.links.delete(link)
    this.inbound.delete(link)
    if (why === 'strikes' && link.ik) this.banned.set(link.ik, this.clock.now() + this.limits.banMs)
    link.abandoned.clear()
    link.metas.clear()
    const hit = new Set<Download>()
    for (const f of [...link.fetches.values()]) {
      this.unfetch(link, f)
      this.giveBack(f.dl, f.block)
      hit.add(f.dl)
    }
    for (const [h, x] of this.holders)
      if (x.links.delete(link)) {
        this.changed(h)
        const dl = this.downloads.get(h)
        if (dl) hit.add(dl)
      }
    if (hit.size) this.pumpAll()
  }

  // ----- Serving -----

  private onMessage(m: Message, link: BulkLink) {
    switch (m.t) {
      case 'blob_get':
        return this.onGet(m, link)
      case 'blob_cancel':
        return this.onCancel(m, link)
      case 'blob_meta':
      case 'blob_has':
        return this.onControl(m, link)
      case 'blob_meta_ok':
      case 'blob_has_ok':
      case 'blob_no': {
        if (m.t === 'blob_no' && m.rid === undefined) return this.onRefused(m, link)
        const rid = m.rid
        const call = typeof rid === 'number' ? link.calls.get(rid) : undefined
        if (!call)
          return typeof rid === 'number' && link.lateAnswer(rid) ? undefined : link.strike()
        link.calls.delete(rid as number)
        if (m.t !== 'blob_no' && m.t !== call.t) return link.strike()
        return call.done(m)
      }
      default:
      // A message type from a newer version: ignored, at no cost.
    }
  }

  private async read<T>(fn: () => Promise<T>): Promise<T> {
    if (this.readers >= this.limits.readers)
      await new Promise<void>(resolve => this.readQueue.push(resolve))
    this.readers += 1
    try {
      return await fn()
    } finally {
      this.readers -= 1
      this.readQueue.shift()?.()
    }
  }

  // The gate, asked again for every request: still a contact, still sharing a conversation with
  // a live message that carries the file and that they did not write. A file they may not have
  // and a file we don't know get the same answer.
  private async gate(link: BulkLink, h: string): Promise<Gate> {
    if (!this.enabled() || this.stopped) return 'off'
    const ik = link.ik
    return ik && link.session.state === 'ready' && (await this.deps.entitled(ik, h)) ? 'yes' : 'no'
  }

  private serving(link: BulkLink) {
    return link.serveQueue.length + (link.serveCur ? 1 : 0)
  }

  // Block requests queue up to the credit we advertised and are served in order; only one past
  // it costs a strike.
  private onGet(m: Message, link: BulkLink) {
    const { h, block } = m
    if (!hashOk(h) || !blockOk(block)) return link.strike()
    const key = `${h}:${block}`
    if (link.serveCur?.key === key || link.serveQueue.some(r => r.key === key)) return link.strike()
    if (this.serving(link) >= this.limits.serveMax) {
      link.strike()
      void link.send({ t: 'blob_no', h, block, why: 'busy' }).catch(() => {})
      return
    }
    link.serveQueue.push({ key, h, block, cancelled: false })
    void this.serveLoop(link)
  }

  // They stopped wanting a block: it leaves the queue (or stops between batches) and they hear
  // that it stopped, after whatever of it was already sent. A block already sent in full needs
  // no answer.
  private onCancel(m: Message, link: BulkLink) {
    const { h, block } = m
    if (!hashOk(h) || !blockOk(block)) return link.strike()
    const key = `${h}:${block}`
    const at = link.serveQueue.findIndex(r => r.key === key)
    const req =
      at >= 0 ? link.serveQueue.splice(at, 1)[0] : link.serveCur?.key === key ? link.serveCur : null
    // Cancels cost us work and them nothing: only far more than any client sends count.
    if (link.tally('cancel', this.limits.cancelsFree)) link.strike()
    if (!req) return
    req.cancelled = true
    if (link.serveCur === req) link.serveCur = null
    void link.send({ t: 'blob_no', h, block, why: 'cancelled' }).catch(() => {})
  }

  private async serveLoop(link: BulkLink) {
    if (link.serveBusy) return
    link.serveBusy = true
    try {
      for (;;) {
        const req = link.serveQueue.shift()
        if (!req || link.state !== 'open') break
        link.serveCur = req
        try {
          await this.serveOne(link, req)
        } catch {
          // The pipe closed or storage went away.
        }
        if (link.serveCur === req) link.serveCur = null
      }
    } finally {
      link.serveBusy = false
    }
  }

  private async servedRecord(link: BulkLink, h: string) {
    const hit = link.recs.get(h)
    if (hit) return hit
    const rec = await this.db.get('blobs', h)
    if (!rec?.done) return null
    link.recs.set(h, rec)
    while (link.recs.size > 8) link.recs.delete(link.recs.keys().next().value as string)
    return rec
  }

  private async serveOne(link: BulkLink, req: ServeReq) {
    const { h, block } = req
    const release = () => {
      if (link.serveCur === req) link.serveCur = null
    }
    const gate = await this.gate(link, h)
    if (req.cancelled) return
    if (gate !== 'yes') {
      release()
      if (gate === 'no') link.strike()
      await link.send({ t: 'blob_no', h, block, why: gate === 'off' ? 'missing' : 'denied' })
      return
    }
    const rec = await this.servedRecord(link, h)
    const data =
      rec && block < blockCount(rec.size)
        ? await this.read(() => readBlock(this.db, rec, block))
        : null
    if (req.cancelled) return
    if (!data) {
      release()
      await link.send({ t: 'blob_no', h, block, why: 'missing' })
      return
    }
    if (await link.sendBlock(h, block, data, () => !req.cancelled, release)) this.touch(h)
  }

  // Control requests are answered in turn, up to controlMax at once. Our own downloader never has
  // more out (and we count one as done before its answer goes), so one past it is a race or an
  // older client: it gets `busy`, and only an abusive number of those cost a strike.
  private onControl(m: Message, link: BulkLink) {
    const rid = m.rid
    if (!Number.isSafeInteger(rid) || (rid as number) <= 0) return link.strike()
    if (link.control >= this.limits.controlMax) {
      if (link.tally('busy', this.limits.busyFree)) link.strike()
      void link.send({ t: 'blob_no', rid, why: 'busy' }).catch(() => {})
      return
    }
    link.control += 1
    void (async () => {
      let ans: Message | null = null
      try {
        ans = m.t === 'blob_has' ? await this.answerHas(m, link) : await this.answerMeta(m, link)
      } catch {
        // The pipe closed or storage went away.
      } finally {
        link.control -= 1
      }
      if (ans) await link.send(ans).catch(() => {})
    })()
  }

  // Which of the asked files we have in full and may give to this peer, the block hashes of the
  // small ones, and the credit for block requests. Asking about files we don't know is normal
  // (the message may not have reached us yet), so it costs no strike. Each distinct hash costs
  // the same gate check, whatever we hold.
  private async answerHas(m: Message, link: BulkLink): Promise<Message | null> {
    const hs = m.hs
    if (!Array.isArray(hs) || hs.length > this.limits.hasMax || !hs.every(hashOk)) {
      link.strike()
      return null
    }
    const have: string[] = []
    const metas: { h: string; size: number; blocks: string[] }[] = []
    for (const h of new Set(hs as string[])) {
      if ((await this.gate(link, h)) !== 'yes') continue
      const rec = await this.db.get('blobs', h)
      if (!rec?.done) continue
      have.push(h)
      const count = blockCount(rec.size)
      if (!rec.hashed || count < 1 || count > this.limits.smallMeta) continue
      const page = await this.db.get('blob_hashes', [h, 0])
      if (!page || page.data.length < count * HASH) continue
      const blocks: string[] = []
      for (let i = 0; i < count; i += 1)
        blocks.push(b64u(page.data.subarray(i * HASH, (i + 1) * HASH)))
      metas.push({ h, size: rec.size, blocks })
    }
    return { t: 'blob_has_ok', rid: m.rid, have, metas, credit: this.limits.serveMax }
  }

  private async answerMeta(m: Message, link: BulkLink): Promise<Message | null> {
    const { h, from } = m
    if (!hashOk(h) || !blockOk(from)) {
      link.strike()
      return null
    }
    const gate = await this.gate(link, h)
    if (gate !== 'yes') {
      if (gate === 'no') link.strike()
      return { t: 'blob_no', rid: m.rid, h, why: gate === 'off' ? 'missing' : 'denied' }
    }
    const rec = await this.db.get('blobs', h)
    const count = rec ? blockCount(rec.size) : 0
    const page = Math.floor(from / HASH_PAGE)
    const stored = rec?.done && rec.hashed ? await this.db.get('blob_hashes', [h, page]) : undefined
    if (!rec || (count > 0 && !stored) || from > count)
      return { t: 'blob_no', rid: m.rid, h, why: 'missing' }
    const off = from - page * HASH_PAGE
    const n = Math.min(this.limits.metaPage, HASH_PAGE - off, count - from)
    const blocks: string[] = []
    for (let i = 0; i < n; i += 1) {
      const x = stored?.data.subarray((off + i) * HASH, (off + i + 1) * HASH)
      if (!x || x.length !== HASH) return { t: 'blob_no', rid: m.rid, h, why: 'missing' }
      blocks.push(b64u(x))
    }
    return {
      t: 'blob_meta_ok',
      rid: m.rid,
      h,
      size: rec.size,
      from,
      blocks,
      more: from + n < count,
      credit: this.limits.serveMax,
    }
  }

  // ----- Fetching -----

  // A fetch leaves its pipe: its stall timer goes too, so its buffer is never held longer.
  private unfetch(link: BulkLink, f: Fetch) {
    link.fetches.delete(`${f.dl.h}:${f.block}`)
    if (f.timer !== undefined) this.clock.clear(f.timer)
    f.timer = undefined
  }

  // The same, when the rest of the block will never come.
  private dropFetch(link: BulkLink, f: Fetch) {
    this.unfetch(link, f)
    link.expect = Math.max(0, link.expect - (f.buf.length - f.got))
  }

  // A block goes back to be asked for again.
  private giveBack(dl: Download, block: number) {
    dl.inflight.delete(block)
    if (!dl.have.has(block)) dl.retry.push(block)
  }

  // We stop wanting a block from this holder: we tell them, and drop what of it is still on the
  // way (at most the rest of that block, until they answer) without counting it against them.
  // That wait is bounded by bytes, never by time: past graceBytes on one pipe, the pipe is
  // replaced (no strike, no ban) instead.
  private abandon(link: BulkLink, f: Fetch) {
    const key = `${f.dl.h}:${f.block}`
    this.unfetch(link, f)
    f.dl.inflight.delete(f.block)
    if (link.state !== 'open') return
    const list = link.abandoned.get(key) ?? []
    list.push({ next: f.got, end: f.buf.length })
    link.abandoned.set(key, list)
    void link.send({ t: 'blob_cancel', h: f.dl.h, block: f.block }).catch(() => {})
    let grace = 0
    for (const l of link.abandoned.values()) for (const a of l) grace += a.end - a.next
    if (grace > this.limits.graceBytes) link.close('old')
  }

  // The oldest cancelled request for this block ended (its last byte, or the holder's answer).
  private ended(link: BulkLink, key: string) {
    const list = link.abandoned.get(key)
    const a = list?.shift()
    if (!list || !a) return
    if (!list.length) link.abandoned.delete(key)
    link.expect = Math.max(0, link.expect - (a.end - a.next))
    this.pumpAll()
  }

  private onRefused(m: Message, link: BulkLink) {
    const { h, block } = m
    const key = `${String(h)}:${String(block)}`
    // Every request ends with its last byte or one answer, in order: this one is for the block we
    // stopped wanting, not for one asked again since.
    if (link.abandoned.has(key)) return this.ended(link, key)
    const f = link.fetches.get(key)
    if (!f || m.why === 'cancelled') return link.strike()
    this.dropFetch(link, f)
    this.giveBack(f.dl, f.block)
    if (m.why === 'denied') {
      f.dl.refused.add(link)
      f.dl.skip.add(link)
    } else if (m.why !== 'busy') f.dl.skip.add(link)
    this.pumpAll()
  }

  private onChunk(h: string, block: number, off: number, data: Uint8Array, link: BulkLink) {
    const key = `${h}:${block}`
    const a = link.abandoned.get(key)?.[0]
    if (a) {
      // The rest of a block we stopped wanting comes before anything asked for again.
      if (off !== a.next || off + data.length > a.end) return link.strike()
      a.next += data.length
      link.expect = Math.max(0, link.expect - data.length)
      if (a.next === a.end) this.ended(link, key)
      return
    }
    const f = link.fetches.get(key)
    if (!f) return link.strike()
    // Only what we asked for, in order.
    if (off !== f.got || f.got + data.length > f.buf.length) {
      this.dropFetch(link, f)
      this.giveBack(f.dl, block)
      f.dl.bad.add(link)
      this.pumpAll()
      return link.strike()
    }
    f.buf.set(data, off)
    f.got += data.length
    link.expect = Math.max(0, link.expect - data.length)
    f.at = this.clock.now()
    link.lastChunk = f.at
    if (f.got % (256 * 1024) < data.length || f.got === f.buf.length) this.changed(h)
    if (f.got < f.buf.length) return
    this.unfetch(link, f)
    f.dl.writing += 1
    void this.verify(f, link).finally(() => {
      f.dl.writing -= 1
      this.pumpAll()
    })
    // The window is free again: the next block goes out while this one is checked and stored.
    this.pumpAll()
  }

  private async verify(f: Fetch, link: BulkLink) {
    const dl = f.dl
    const want = dl.hashes?.subarray(f.block * HASH, (f.block + 1) * HASH)
    const got = await digest(f.buf)
    if (!want || want.length !== HASH || !equalBytes(got, want)) {
      // A corrupt block: never stored; another holder gets asked.
      dl.bad.add(link)
      this.giveBack(dl, f.block)
      link.strike()
      return
    }
    dl.writes = dl.writes.then(() => this.storeBlock(dl, f))
    await dl.writes
    this.giveBack(dl, f.block)
    link.session.useful()
  }

  // One part and the small progress record: the same work for every block, whatever the size.
  private async storeBlock(dl: Download, f: Fetch) {
    if (dl.state === 'removed' || dl.have.has(f.block)) return
    try {
      const tx = this.db.transaction(['blobs', 'blob_parts'], 'readwrite')
      tx.done.catch(() => {})
      const rec = await tx.objectStore('blobs').get(dl.h)
      if (!rec) {
        tx.abort()
        dl.state = 'removed'
        return
      }
      await tx
        .objectStore('blob_parts')
        .put({ h: dl.h, block: f.block, data: new Blob([f.buf as BlobPart]) })
      await tx.objectStore('blobs').put({ ...rec, have: rec.have + 1, lastUsed: this.clock.now() })
      await tx.done
      dl.have.add(f.block)
    } catch (e) {
      dl.state = 'failed'
      dl.error =
        (e as { name?: unknown })?.name === 'QuotaExceededError'
          ? 'Storage on this device is full.'
          : "Couldn't save the file."
    }
    this.changed(dl.h)
  }

  private request(dl: Download, link: BulkLink, block: number) {
    const f: Fetch = {
      dl,
      block,
      buf: new Uint8Array(blockLen(dl.size, block)),
      got: 0,
      at: this.clock.now(),
    }
    link.fetches.set(`${dl.h}:${block}`, f)
    link.expect += f.buf.length
    dl.inflight.set(block, link)
    void link.send({ t: 'blob_get', h: dl.h, block }).catch(() => {})
    this.watch(f, link)
  }

  // A block that makes no progress while its pipe makes none either goes back to the queue,
  // with a cancel to that holder. The holder isn't marked bad: it may only be slow.
  private watch(f: Fetch, link: BulkLink) {
    const check = () => {
      f.timer = undefined
      if (link.fetches.get(`${f.dl.h}:${f.block}`) !== f) return
      if (this.clock.now() - Math.max(f.at, link.lastChunk) >= this.limits.stallMs) {
        this.abandon(link, f)
        f.dl.retry.push(f.block)
        return this.pumpAll()
      }
      f.timer = this.clock.set(check, this.limits.stallMs)
    }
    f.timer = this.clock.set(check, this.limits.stallMs)
  }

  // Online holders of `h` (asked over our pipes), cached for a while.
  private async probe(h: string, force = false) {
    const cur = this.holders.get(h)
    if (!force && cur && this.clock.now() - cur.at < this.limits.probeMs) {
      for (const l of cur.links) if (l.state !== 'open') cur.links.delete(l)
      return cur.links
    }
    const busy = this.probing.get(h)
    if (busy) {
      await busy
      return this.holders.get(h)?.links ?? new Set<BulkLink>()
    }
    const run = (async () => {
      const found = new Set<BulkLink>()
      const iks = await this.deps.members(h)
      const sessions = iks.flatMap(ik => this.deps.node.readySessions(ik))
      await Promise.all(
        sessions.map(async s => {
          const link = await this.linkTo(s)
          if (link && (await this.hasOf(link, h))) found.add(link)
        })
      )
      this.holders.set(h, { links: found, at: this.clock.now() })
      this.changed(h)
    })()
    this.probing.set(h, run)
    try {
      await run
    } finally {
      this.probing.delete(h)
    }
    return this.holders.get(h)?.links ?? new Set<BulkLink>()
  }

  // Whether a holder has `h`. Files asked about while a `blob_has` is under way on the same pipe
  // go together in the next one (up to hasMax), so many files cost a few requests, not one each.
  private hasOf(link: BulkLink, h: string): Promise<boolean> {
    return new Promise(resolve => {
      const list = link.hasWant.get(h)
      if (list) list.push(resolve)
      else link.hasWant.set(h, [resolve])
      if (!link.hasBusy) void this.hasLoop(link)
    })
  }

  private async hasLoop(link: BulkLink) {
    link.hasBusy = true
    try {
      // Files probed in the same turn join the first request.
      await Promise.resolve()
      while (link.hasWant.size) {
        const batch = [...link.hasWant.keys()].slice(0, this.limits.hasMax)
        const waiting = batch.map(h => {
          const list = link.hasWant.get(h) ?? []
          link.hasWant.delete(h)
          return list
        })
        const ans = await link.call({ t: 'blob_has', hs: batch }, 'blob_has_ok')
        const have = new Set<string>()
        if (ans?.t === 'blob_has_ok') {
          this.creditFrom(link, ans)
          if (Array.isArray(ans.have)) for (const x of ans.have) if (hashOk(x)) have.add(x)
          this.metasFrom(link, ans, have)
        }
        batch.forEach((h, i) => waiting[i].forEach(fn => fn(have.has(h))))
      }
    } finally {
      link.hasBusy = false
    }
  }

  // Small files' block hashes from a `blob_has` answer: kept for fetchMeta, which checks them
  // against the root like any other.
  private metasFrom(link: BulkLink, m: Message, have: Set<string>) {
    if (!Array.isArray(m.metas)) return
    for (const x of m.metas.slice(0, this.limits.hasMax) as unknown[]) {
      if (!x || typeof x !== 'object') continue
      const { h, size, blocks } = x as Record<string, unknown>
      if (
        !hashOk(h) ||
        !have.has(h) ||
        !Number.isSafeInteger(size) ||
        (size as number) < 1 ||
        !Array.isArray(blocks) ||
        blocks.length !== blockCount(size as number) ||
        blocks.length > this.limits.smallMeta ||
        !blocks.every(hashOk)
      )
        continue
      link.metas.delete(h)
      link.metas.set(h, { size: size as number, blocks: blocks as string[] })
    }
    while (link.metas.size > 4 * this.limits.hasMax)
      link.metas.delete(link.metas.keys().next().value as string)
  }

  private creditFrom(link: BulkLink, m: Message) {
    const c = m.credit
    if (Number.isSafeInteger(c) && (c as number) >= 1) link.credit = Math.min(c as number, 64)
  }

  // How many block requests we keep outstanding on a pipe.
  private cap(link: BulkLink) {
    return Math.max(1, Math.min(link.credit, this.limits.window))
  }

  // How many online contacts have it (asks them when the answer is old).
  async availability(h: string) {
    if (!this.enabled()) return 0
    return (await this.probe(h)).size
  }

  private async fetchMeta(dl: Download, links: BulkLink[]) {
    for (const link of links) {
      const hashes = new Uint8Array(dl.count * HASH)
      let from = 0
      let ok = true
      let size = dl.size
      // A small file's hashes may have come with the holder's `blob_has` answer.
      const pre = link.metas.get(dl.h)
      if (pre) {
        link.metas.delete(dl.h)
        if (pre.size !== dl.size) {
          size = pre.size
          ok = false
        } else
          for (const b of pre.blocks) {
            hashes.set(fromB64u(b), from * HASH)
            from += 1
          }
      }
      while (ok && from < dl.count) {
        const ans = await link.call({ t: 'blob_meta', h: dl.h, from }, 'blob_meta_ok')
        if (!ans || ans.t !== 'blob_meta_ok' || ans.h !== dl.h || ans.from !== from) {
          if (ans?.t === 'blob_no' && ans.why === 'denied') dl.refused.add(link)
          ok = false
          break
        }
        this.creditFrom(link, ans)
        const list = ans.blocks
        if (ans.size !== dl.size) {
          size = ans.size as number
          ok = false
          break
        }
        if (
          !Array.isArray(list) ||
          list.length > this.limits.metaPage ||
          !list.every(hashOk) ||
          from + list.length > dl.count ||
          (ans.more === true && list.length === 0)
        ) {
          ok = false
          break
        }
        for (const b of list as string[]) {
          hashes.set(fromB64u(b), from * HASH)
          from += 1
        }
        if (ans.more !== true) break
      }
      if (ok && from === dl.count && blobRootOf(dl.size, hashes) === dl.h) {
        dl.hashes = hashes
        await this.saveHashes(dl.h, hashes)
        return true
      }
      if (size !== dl.size) {
        // Their copy has another size: either the message or they are wrong, and the root of a
        // file binds its size, so this download can't come from them.
        dl.mismatch += 1
        dl.skip.add(link)
        continue
      }
      dl.skip.add(link)
      if (!dl.refused.has(link)) link.strike()
    }
    return false
  }

  // Block hashes are written once, apart from the progress record.
  private async saveHashes(h: string, flat: Uint8Array) {
    const tx = this.db.transaction(['blobs', 'blob_hashes'], 'readwrite')
    const rec = await tx.objectStore('blobs').get(h)
    if (rec && !rec.hashed) {
      for (const p of hashPages(h, flat)) await tx.objectStore('blob_hashes').put(p)
      await tx.objectStore('blobs').put({ ...rec, hashed: true })
    }
    await tx.done
  }

  private pumping = new Set<string>()
  private again = new Set<string>()

  // Hands out missing blocks to holders; finishes when all are in.
  private pump(dl: Download) {
    if (this.pumping.has(dl.h)) {
      this.again.add(dl.h)
      return
    }
    this.pumping.add(dl.h)
    void this.pumpOnce(dl).finally(() => {
      this.pumping.delete(dl.h)
      if (this.again.delete(dl.h)) this.pump(dl)
    })
  }

  // Credit came free on a pipe: every download gets a turn, starting with a different one each
  // time, so several files from one holder share its credit.
  private pumpAll() {
    const list = [...this.downloads.values()]
    if (!list.length) return
    const k = this.turn++ % list.length
    for (const dl of [...list.slice(k), ...list.slice(0, k)]) this.pump(dl)
  }

  // The next block to ask for: one that came back first, then the next in order.
  private nextBlock(dl: Download) {
    while (dl.retry.length) {
      const b = dl.retry.shift() as number
      if (!dl.have.has(b) && !dl.inflight.has(b)) return b
    }
    while (dl.next < dl.count) {
      const b = dl.next
      dl.next += 1
      if (!dl.have.has(b) && !dl.inflight.has(b)) return b
    }
    return null
  }

  private usable(dl: Download, l: BulkLink) {
    return l.state === 'open' && !dl.bad.has(l) && !dl.skip.has(l)
  }

  private async pumpOnce(dl: Download) {
    if (this.stopped || dl.state === 'done' || dl.state === 'removed' || dl.state === 'failed')
      return
    if (!this.enabled()) {
      dl.state = 'waiting'
      return this.changed(dl.h)
    }
    if (dl.hashes && dl.have.size === dl.count) return this.finish(dl)
    let links = [...(await this.probe(dl.h))].filter(l => this.usable(dl, l))
    if (links.length === 0 && dl.inflight.size === 0)
      links = [...(await this.probe(dl.h, true))].filter(l => this.usable(dl, l))
    // A pipe due for new keys: ask the holders again, which opens a fresh one.
    const stale = links.filter(l => l.stale && !l.rotating)
    if (stale.length) {
      for (const l of stale) l.rotating = true
      const x = this.holders.get(dl.h)
      if (x) x.at = 0
    }
    if (!dl.hashes) {
      if (dl.metaBusy) return
      dl.metaBusy = true
      const ok = links.length > 0 && (await this.fetchMeta(dl, links))
      dl.metaBusy = false
      if (!ok) return this.stuck(dl)
      links = links.filter(l => this.usable(dl, l))
      if (dl.have.size === dl.count) return this.finish(dl)
    }
    if (links.length === 0) {
      if (dl.inflight.size === 0) this.stuck(dl)
      return
    }
    if (dl.state !== 'running') {
      dl.state = 'running'
      this.changed(dl.h)
    }
    if (dl.writing >= this.limits.writes) return
    // Fresh pipes first, stale ones only while nothing else is there.
    const fresh = links.filter(l => !l.stale)
    const use = fresh.length ? fresh : links
    let at = 0
    for (;;) {
      const free = use.filter(l => l.state === 'open' && l.busy < this.cap(l))
      if (!free.length) break
      const block = this.nextBlock(dl)
      if (block === null) break
      this.request(dl, free[at % free.length], block)
      at += 1
    }
    // Nothing is out and nothing is left in order, yet blocks are missing: look again.
    if (
      dl.inflight.size === 0 &&
      dl.writing === 0 &&
      dl.retry.length === 0 &&
      dl.next >= dl.count &&
      dl.have.size < dl.count
    )
      dl.next = 0
  }

  // Nobody who has it is online (or everyone refused): waits for a holder to come online.
  private stuck(dl: Download) {
    if (dl.inflight.size) return
    if (dl.mismatch > 0 && dl.have.size === 0) {
      dl.state = 'failed'
      dl.error = MISMATCH_TEXT
      this.changed(dl.h)
      return
    }
    const online = [...(this.holders.get(dl.h)?.links ?? [])].filter(l => l.state === 'open')
    const removed =
      dl.refused.size > 0 && dl.have.size === 0 && online.every(l => dl.refused.has(l))
    const next = removed ? 'removed' : 'waiting'
    if (removed) dl.error = 'Removed'
    if (dl.state !== next) {
      dl.state = next
      this.changed(dl.h)
    }
  }

  // Complete only when every block is in and the hashes they were checked against give the root
  // the file is named by, whatever its size.
  private async finish(dl: Download) {
    if (dl.state === 'done') return
    await dl.writes
    if (!dl.hashes || dl.have.size !== dl.count || blobRootOf(dl.size, dl.hashes) !== dl.h) {
      dl.state = 'failed'
      dl.error = MISMATCH_TEXT
      this.changed(dl.h)
      return
    }
    const first = dl.count ? await this.db.get('blob_parts', [dl.h, 0]) : undefined
    const head = first ? new Uint8Array(await first.data.slice(0, SNIFF_BYTES).arrayBuffer()) : null
    const type = head ? safeType(head) : NEUTRAL_TYPE
    await this.store.updateBlob(dl.h, cur =>
      cur
        ? {
            ...cur,
            done: true,
            hashed: true,
            have: dl.count,
            wanted: false,
            type,
            lastUsed: this.clock.now(),
          }
        : null
    )
    dl.state = 'done'
    this.downloads.delete(dl.h)
    this.changed(dl.h)
  }

  // Bytes still to come for the downloads under way.
  private reserved(except: string) {
    let n = 0
    for (const d of this.downloads.values())
      if (d.h !== except && (d.state === 'running' || d.state === 'waiting'))
        n += Math.max(0, d.size - d.got)
    return n
  }

  // Bytes the downloads under way still need.
  reservedBytes() {
    return this.reserved('')
  }

  // Something about how a file is shown changed outside of here.
  touchView(h: string) {
    this.changed(h)
  }

  // Starts (or resumes) fetching a file. Refuses up front when the device has no room for it,
  // counting what the downloads under way still need.
  async download(att: Pick<Attachment, 'h' | 'size'>): Promise<void> {
    if (!this.enabled()) throw new Error(OFF_TEXT)
    const { h, size } = att
    if (!hashOk(h) || !Number.isSafeInteger(size) || size < 0) throw new Error(MISMATCH_TEXT)
    if (size === 0 && h !== EMPTY_ROOT) throw new Error(MISMATCH_TEXT)
    const cur = this.downloads.get(h)
    if (cur && cur.size === size) {
      if (cur.state === 'failed' || cur.state === 'removed') this.downloads.delete(h)
      else return this.pump(cur)
    } else if (cur) {
      // Another claim for the same file: a size checked against the root wins, an unchecked one
      // gives way.
      if (cur.hashes && cur.state !== 'failed') throw new Error(MISMATCH_TEXT)
      await this.cancel(h)
    }
    let rec = await this.db.get('blobs', h)
    if (rec && rec.size !== size) {
      // A size checked against the root wins; an unchecked claim is replaced (it never had any
      // blocks: those are only stored once the hashes are checked).
      if (rec.done || rec.hashed) throw new Error(MISMATCH_TEXT)
      await this.remove(h)
      rec = undefined
    }
    if (rec?.done) return
    const parts = rec?.hashed
      ? (await this.db.getAllKeys('blob_parts', partRange(h))).map(k => k[1] as number)
      : []
    const need = Math.max(0, size - parts.length * BLOCK)
    const free = (await this.deps.room?.()) ?? null
    const ahead = this.reserved(h)
    if (free !== null && need + ahead + this.limits.margin > free)
      throw new Error(NO_ROOM_TEXT(need, Math.max(0, free - ahead)))
    const now = this.clock.now()
    await this.store.updateBlob(h, c =>
      c
        ? { ...c, wanted: true }
        : {
            h,
            size,
            hashed: false,
            have: 0,
            done: false,
            type: null,
            own: false,
            wanted: true,
            created: now,
            lastUsed: now,
          }
    )
    if (this.downloads.has(h)) return this.pump(this.downloads.get(h) as Download)
    const dl = new Download(h, size)
    for (const b of parts) dl.have.add(b)
    if (size === 0) dl.hashes = new Uint8Array(0)
    else if (rec?.hashed) dl.hashes = await readHashes(this.db, h, dl.count)
    this.downloads.set(h, dl)
    this.changed(h)
    this.pump(dl)
  }

  // Stops a download, telling its holders; what was stored stays for later unless `drop`.
  async cancel(h: string, drop = false) {
    const dl = this.downloads.get(h)
    if (dl) {
      dl.state = 'removed'
      this.downloads.delete(h)
      for (const l of this.links)
        for (const f of [...l.fetches.values()]) if (f.dl === dl) this.abandon(l, f)
    }
    if (drop) await this.remove(h)
    else
      await this.store.updateBlob(h, cur => (cur && !cur.done ? { ...cur, wanted: false } : null))
    this.changed(h)
  }

  // Unfinished downloads the user asked for continue once someone who has the file is online.
  async resume() {
    const list = await this.db.getAll('blobs')
    for (const r of list)
      if (r.wanted && !r.done && !this.downloads.has(r.h))
        await this.download({ h: r.h, size: r.size }).catch(() => {})
  }

  // A session came up: waiting downloads try again, asking everyone again.
  kick() {
    for (const x of this.holders.values()) x.at = 0
    for (const dl of this.downloads.values()) {
      dl.skip.clear()
      if (dl.state === 'waiting' || dl.state === 'running') this.pump(dl)
    }
  }

  view(h: string, size: number): BlobView {
    const dl = this.downloads.get(h)
    const holders = this.holders.get(h)
    const n = holders ? [...holders.links].filter(l => l.state === 'open').length : 0
    if (!dl) return { ...EMPTY_VIEW, total: size, holders: n }
    let got = dl.got
    for (const l of this.links) for (const f of l.fetches.values()) if (f.dl === dl) got += f.got
    return {
      state:
        dl.state === 'running'
          ? 'downloading'
          : dl.state === 'waiting'
            ? 'waiting'
            : dl.state === 'removed'
              ? 'removed'
              : dl.state === 'failed'
                ? 'failed'
                : 'done',
      got: Math.min(size, got),
      total: size,
      holders: n,
      type: null,
      error: dl.error,
    }
  }

  // ----- Local files -----

  // Last used, written at most once a minute per file while it is served.
  private touch(h: string) {
    const now = this.clock.now()
    const last = this.touched.get(h)
    if (last !== undefined && now - last < this.limits.touchMs) return
    this.touched.set(h, now)
    if (this.touched.size > 256) this.touched.delete(this.touched.keys().next().value as string)
    void this.store.updateBlob(h, cur => (cur ? { ...cur, lastUsed: now } : null)).catch(() => {})
  }

  // Keeps a file we are about to send, whole, as it was hashed. Blocks of an unfinished download
  // of the same file go: the whole file replaces them.
  async putOwn(file: Blob, hashed: Hashed) {
    const free = (await this.deps.room?.()) ?? null
    const rec0 = await this.db.get('blobs', hashed.h)
    if (rec0?.done) return
    if (free !== null && hashed.size + this.limits.margin > free) throw new Error(SHARE_ROOM_TEXT)
    const head = new Uint8Array(await file.slice(0, SNIFF_BYTES).arrayBuffer())
    const now = this.clock.now()
    const dl = this.downloads.get(hashed.h)
    if (dl) await this.cancel(hashed.h)
    const tx = this.db.transaction(['blobs', 'blob_parts', 'blob_hashes'], 'readwrite')
    await tx.objectStore('blob_parts').delete(partRange(hashed.h))
    await tx.objectStore('blob_hashes').delete(partRange(hashed.h))
    for (const p of hashPages(hashed.h, flatHashes(hashed.blocks)))
      await tx.objectStore('blob_hashes').put(p)
    await tx.objectStore('blobs').put({
      h: hashed.h,
      size: hashed.size,
      hashed: true,
      have: 0,
      done: true,
      file,
      type: safeType(head),
      own: true,
      wanted: false,
      created: now,
      lastUsed: now,
    })
    await tx.done
    this.changed(hashed.h)
  }

  // Deletes a file here: its record, its blocks, its hashes and any download of it.
  async remove(h: string) {
    const dl = this.downloads.get(h)
    if (dl) {
      dl.state = 'removed'
      this.downloads.delete(h)
    }
    for (const l of this.links) l.recs.delete(h)
    const tx = this.db.transaction(['blobs', 'blob_parts', 'blob_hashes'], 'readwrite')
    await tx.objectStore('blob_parts').delete(partRange(h))
    await tx.objectStore('blob_hashes').delete(partRange(h))
    await tx.objectStore('blobs').delete(h)
    await tx.done
    this.holders.delete(h)
    this.changed(h)
  }

  // Files of a redacted message: deleted here unless another live message still carries them
  // and `counts` says that message may keep it. `keepOwn`: files we sent stay whatever.
  async release(
    hs: string[],
    counts: (r: EventRecord) => Promise<boolean> | boolean = () => true,
    keepOwn = false
  ) {
    for (const h of hs) {
      if (keepOwn && (await this.db.get('blobs', h))?.own) continue
      let keep = false
      for (const r of await this.db.getAllFromIndex('events', 'att', h))
        if (!r.redacted && (await counts(r))) {
          keep = true
          break
        }
      if (!keep) await this.remove(h).catch(() => {})
    }
  }

  // Downloaded files (never our own) that came in more than `days` ago.
  async clearOlder(days: number) {
    const cutoff = this.clock.now() - days * 24 * 60 * 60_000
    const old = await this.db.getAllFromIndex('blobs', 'created', IDBKeyRange.upperBound(cutoff))
    let n = 0
    for (const r of old)
      if (!r.own) {
        await this.remove(r.h)
        n += 1
      }
    return n
  }

  async usage() {
    return usageOf(await this.db.getAll('blobs'))
  }

  record(h: string) {
    return this.db.get('blobs', h)
  }

  file(h: string) {
    return assemble(this.db, h)
  }

  stop() {
    this.stopped = true
    for (const l of [...this.links]) l.close('closed')
    for (const l of [...this.inbound]) l.close('closed')
    this.links.clear()
    this.inbound.clear()
    this.downloads.clear()
  }

  // For tests: the pipes we hold, and the ones still opening that peers started.
  get pipes() {
    return [...this.links]
  }

  get incoming() {
    return [...this.inbound]
  }
}

// ----- Attachments in messages -----

export const isThumbJpeg = (b: Uint8Array) =>
  b.length >= 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff

// Largest side a thumbnail may say it has.
export const THUMB_SIDE = 1024

// A thumbnail claim from a message: b64u, at most 6 KiB, a JPEG by its bytes whose header says
// it is at most 1024 px a side (read without decoding, so a tiny file can't declare a huge
// image). The UI still has to decode it as an image before showing it.
export const thumbBytes = (thumb: string | undefined, max = 6 * 1024) => {
  if (!thumb) return null
  try {
    const b = fromB64u(thumb)
    if (b.length === 0 || b.length > max || !isThumbJpeg(b)) return null
    const size = imageSize(b)
    return size && size.w >= 1 && size.h >= 1 && size.w <= THUMB_SIDE && size.h <= THUMB_SIDE
      ? { bytes: b, ...size }
      : null
  } catch {
    return null
  }
}
