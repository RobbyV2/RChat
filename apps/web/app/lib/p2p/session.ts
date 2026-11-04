import { b64u, fromB64u } from './canonical'
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
  knownFrame,
  parseData,
  Reassembler,
  WIRE_MAX,
  type Message,
} from './frames'
import { Initiator, Responder, type Established, type Me, type Remote } from './handshake'
import { LOCAL } from './limits'

// One authenticated, encrypted session with a remote device over a reliable binary pipe:
// handshake, then `hello` both ways, then typed messages. Later tasks register handlers for
// their own message types with `on`. Misbehaving peers collect strikes and are dropped.

export interface Pipe {
  // The remote peer id, as the signaling server reported it.
  readonly remote: string
  // `bulk` for an attachment pipe of an established session (blobs.ts); absent for sessions.
  readonly kind?: 'bulk'
  // Resolves once the bytes waiting to go out dropped below the transport's low mark.
  drain?: () => Promise<void>
  send: (data: Uint8Array) => void
  onData: (fn: (data: Uint8Array) => void) => void
  onClose: (fn: () => void) => void
  close: () => void
}

export interface Clock {
  now: () => number
  set: (fn: () => void, ms: number) => unknown
  clear: (handle: unknown) => void
}

export const realClock: Clock = {
  now: () => Date.now(),
  set: (fn, ms) => setTimeout(fn, ms),
  clear: h => clearTimeout(h as ReturnType<typeof setTimeout>),
}

export interface Limits {
  // From the start until the hello is accepted: SIGMA, then the hello. Pings don't extend it.
  handshakeMs: number
  pingMs: number
  deadMs: number
  strikes: number
  // Token bucket for incoming frames: `framesPerSec` sustained, bursts up to `frameBurst` (two
  // full 1 MiB messages). Past it, frames wait for tokens; they are never dropped.
  framesPerSec: number
  frameBurst: number
  // Bytes of frames waiting to be read before the session gives up on a flooding peer. Each frame
  // counts at least FRAME_COST. Past the burst an honest peer queues far less than this.
  frameBacklogBytes: number
  rekeyMs: number
  rekeyBytes: number
}

export const LIMITS: Limits = { ...LOCAL.session }

export type CloseReason =
  'closed' | 'remote' | 'handshake' | 'timeout' | 'strikes' | 'refused' | 'replaced' | 'paused'

export type Handler = (msg: Message, session: Session) => void | Promise<void>

export interface SessionOpts {
  role: 'initiator' | 'responder'
  pipe: Pipe
  me: Me
  clock?: Clock
  limits?: Partial<Limits>
  // After the handshake: false refuses the remote (blocked, or not who we dialed).
  admit?: (remote: Remote) => boolean
  // Our hello for this remote, sent as soon as the session is up.
  hello: (remote: Remote) => Message
  // Their hello. Returning false closes the session.
  onHello: (msg: Message, session: Session) => boolean | Promise<boolean>
}

const FRAME_COST = LOCAL.session.frameCost

type Rx = { epoch: number; cipher: Cipher }

export class Session {
  state: 'handshake' | 'open' | 'ready' | 'closed' = 'handshake'
  remote: Remote | null = null
  reason: CloseReason | null = null
  strikes = 0
  openedAt = 0
  lastUseful = 0
  private clock: Clock
  private limits: Limits
  private initiator: Initiator | null = null
  private responder: Responder | null = null
  private tx: Rx | null = null
  private rx: Rx | null = null
  private nextRx: Rx | null = null
  private keyedAt = 0
  private reasm = new Reassembler()
  private txChain: Promise<unknown> = Promise.resolve()
  // Sends queued so far, and those queued before a close of ours (still sent); the pipe closed
  // under us (what came before is still read).
  private queuedSends = 0
  private flushTo = 0
  private ending = false
  private rxChain: Promise<unknown> = Promise.resolve()
  private handlers = new Map<string, Handler>()
  private openFns = new Set<(s: Session) => void>()
  private readyFns = new Set<(s: Session) => void>()
  private closeFns = new Set<(s: Session, why: CloseReason) => void>()
  private timers: unknown[] = []
  private lastHeard = 0
  private tokens: number
  private filledAt: number
  // Bytes of received frames not yet read.
  queued = 0
  private wake: (() => void) | null = null
  private rekeying: { init: Initiator | null; resp: Responder | null } | null = null
  // Bulk channel keys (handshake `bulk1`) of the current and the previous key epoch. Bulk pipes
  // derive their own keys from these (blobs.ts).
  private bulk = new Map<number, { send: Uint8Array; recv: Uint8Array }>()
  private bulkWaiters = new Set<() => void>()

  constructor(private opts: SessionOpts) {
    this.clock = opts.clock ?? realClock
    this.limits = { ...LIMITS, ...opts.limits }
    this.tokens = this.limits.frameBurst
    this.filledAt = this.clock.now()
    opts.pipe.onData(data => {
      if (this.state === 'closed') return
      // Checked before queuing, so a waiting frame holds at most frameBacklogBytes behind it.
      const cost = Math.max(data.byteLength, FRAME_COST)
      if (data.byteLength > WIRE_MAX || this.queued + cost > this.limits.frameBacklogBytes)
        return this.close(this.state === 'ready' ? 'strikes' : 'handshake')
      this.queued += cost
      this.rxChain = this.rxChain
        .then(() => this.receive(data))
        .catch(() => {})
        .finally(() => {
          this.queued -= cost
        })
    })
    // Frames already in arrive first (a goodbye among them).
    opts.pipe.onClose(() => {
      this.ending = true
      this.wake?.()
      void this.rxChain.then(() => this.finish('remote'))
    })
  }

  get peer() {
    return this.opts.pipe.remote
  }

  get role() {
    return this.opts.role
  }

  on(type: string, fn: Handler) {
    this.handlers.set(type, fn)
    return this
  }

  onOpen(fn: (s: Session) => void) {
    this.openFns.add(fn)
  }

  onReady(fn: (s: Session) => void) {
    this.readyFns.add(fn)
  }

  onClose(fn: (s: Session, why: CloseReason) => void) {
    this.closeFns.add(fn)
  }

  start() {
    this.lastHeard = this.clock.now()
    this.timers.push(
      this.clock.set(() => {
        if (this.state === 'handshake' || this.state === 'open') this.close('handshake')
      }, this.limits.handshakeMs)
    )
    if (this.opts.role === 'initiator') {
      this.initiator = new Initiator(this.opts.me, this.opts.pipe.remote)
      this.raw(FrameType.H1, this.initiator.h1())
    } else this.responder = new Responder(this.opts.me, this.opts.pipe.remote)
  }

  private raw(type: FrameType, payload: Uint8Array) {
    try {
      this.opts.pipe.send(encodeFrame(type, payload))
    } catch {
      this.finish('remote')
    }
  }

  private async receive(data: Uint8Array) {
    if (this.state === 'closed') return
    let frame
    try {
      frame = decodeFrame(data)
    } catch {
      return this.state === 'handshake' ? this.close('handshake') : this.strike()
    }
    if (this.state === 'handshake') {
      if (!knownFrame(frame.type)) return this.close('handshake')
      return this.handshake(frame.type, frame.payload)
    }
    // A frame type of a newer version: skipped within the rate limit.
    if (!knownFrame(frame.type)) return void (await this.throttle())
    if (frame.type !== FrameType.Data) return this.strike()
    let pt: Uint8Array
    try {
      // Every frame is decrypted in order, so the counter always advances.
      pt = await this.decrypt(frame.payload)
    } catch {
      // A frame that fails to authenticate means the stream is broken or tampered with.
      return this.close('strikes')
    }
    this.lastHeard = this.clock.now()
    if (!(await this.throttle())) return
    let msg: Message
    try {
      const whole = this.reasm.push(pt)
      if (!whole) return
      msg = decodeMessage(whole)
    } catch {
      this.reasm = new Reassembler()
      return this.strike()
    }
    await this.dispatch(msg)
  }

  // Takes one token, first waiting for the bucket to refill when it is empty. False once the
  // session closed meanwhile.
  private async throttle() {
    const { framesPerSec: rate, frameBurst: burst } = this.limits
    const refill = () => {
      const now = this.clock.now()
      this.tokens = Math.min(burst, this.tokens + ((now - this.filledAt) * rate) / 1000)
      this.filledAt = now
    }
    refill()
    while (this.tokens < 1 && this.state !== 'closed') {
      // Closed under us: what is left is read only within the bucket, the rest is dropped.
      if (this.ending) return false
      const wait = Math.ceil(((1 - this.tokens) * 1000) / rate)
      await new Promise<void>(resolve => {
        const h = this.clock.set(() => {
          this.wake = null
          resolve()
        }, wait)
        this.wake = () => {
          this.clock.clear(h)
          this.wake = null
          resolve()
        }
      })
      refill()
    }
    this.tokens -= 1
    return this.state !== 'closed'
  }

  private async decrypt(payload: Uint8Array) {
    const { epoch, counter, ct } = parseData(payload)
    const rx = this.rx
    if (!rx) throw new FrameError('no keys')
    if (epoch === rx.epoch) return rx.cipher.open(counter, ct)
    if (this.nextRx && epoch === this.nextRx.epoch) {
      this.rx = this.nextRx
      this.nextRx = null
      return this.rx.cipher.open(counter, ct)
    }
    throw new FrameError('unknown epoch')
  }

  private async handshake(type: FrameType, payload: Uint8Array) {
    try {
      let est: Established
      if (this.initiator) {
        if (type !== FrameType.H2) return this.close('handshake')
        const r = await this.initiator.h2(payload)
        this.raw(FrameType.H3, r.h3)
        est = r
      } else if (this.responder) {
        if (type === FrameType.H1) {
          this.raw(FrameType.H2, await this.responder.h1(payload))
          return
        }
        if (type !== FrameType.H3) return this.close('handshake')
        est = await this.responder.h3(payload)
      } else return this.close('handshake')
      this.initiator = null
      this.responder = null
      if (this.state !== 'handshake') return
      if (this.opts.admit && !this.opts.admit(est.remote)) return this.close('refused')
      this.remote = est.remote
      this.install(est, 0)
      this.state = 'open'
      this.openedAt = this.clock.now()
      this.lastUseful = this.openedAt
      this.heartbeat()
      for (const fn of this.openFns) fn(this)
      void this.send(this.opts.hello(est.remote))
    } catch {
      this.close('handshake')
    }
  }

  private install(est: Established, epoch: number) {
    this.tx = { epoch, cipher: new Cipher(est.keys.send) }
    this.rx = { epoch, cipher: new Cipher(est.keys.recv) }
    this.keepBulk(est, epoch)
    this.keyedAt = this.clock.now()
  }

  private keepBulk(est: Established, epoch: number) {
    this.bulk.set(epoch, { send: est.keys.bulkSend, recv: est.keys.bulkRecv })
    for (const [e, k] of this.bulk)
      if (this.bulk.size > 2 && e !== epoch) {
        k.send.fill(0)
        k.recv.fill(0)
        this.bulk.delete(e)
      }
    for (const fn of this.bulkWaiters) fn()
  }

  // The bulk keys of a key epoch (copies), or null when it is unknown or long gone.
  bulkKeys(epoch: number) {
    const k = this.bulk.get(epoch)
    return k && this.state === 'ready' ? { send: k.send.slice(), recv: k.recv.slice() } : null
  }

  // The same, waiting up to `ms` for a rekey still on its way here.
  async waitBulkKeys(epoch: number, ms = this.limits.handshakeMs) {
    const end = this.clock.now() + ms
    for (;;) {
      const k = this.bulkKeys(epoch)
      if (k || this.state === 'closed' || this.clock.now() >= end) return k
      await new Promise<void>(resolve => {
        const done = () => {
          this.bulkWaiters.delete(done)
          this.clock.clear(h)
          resolve()
        }
        const h = this.clock.set(done, Math.max(1, end - this.clock.now()))
        this.bulkWaiters.add(done)
      })
    }
  }

  // Pings every pingMs; a peer not heard from for deadMs is gone right then.
  private heartbeat() {
    const tick = () => {
      if (this.state === 'closed') return
      void this.send({ t: 'ping' })
      if (this.opts.role === 'initiator' && this.needsRekey()) void this.rekey()
      this.timers.push(this.clock.set(tick, this.limits.pingMs))
    }
    const watch = () => {
      if (this.state === 'closed') return
      const left = this.lastHeard + this.limits.deadMs - this.clock.now()
      if (left < 0) return this.close('timeout')
      this.timers.push(this.clock.set(watch, left + 1))
    }
    this.timers.push(this.clock.set(tick, this.limits.pingMs))
    this.timers.push(this.clock.set(watch, this.limits.deadMs + 1))
  }

  private needsRekey() {
    const tx = this.tx?.cipher.bytes ?? 0
    const rx = this.rx?.cipher.bytes ?? 0
    return (
      !this.rekeying &&
      (this.clock.now() - this.keyedAt >= this.limits.rekeyMs || tx + rx >= this.limits.rekeyBytes)
    )
  }

  private async dispatch(msg: Message) {
    if (msg.t === 'ping') return void this.send({ t: 'pong' })
    if (msg.t === 'pong') return
    if (msg.t === 'bye') return this.finish('remote')
    if (msg.t === 'rk1' || msg.t === 'rk2' || msg.t === 'rk3') return this.onRekey(msg)
    if (msg.t === 'hello') {
      if (this.state !== 'open') return this.strike()
      let ok: boolean
      try {
        ok = await this.opts.onHello(msg, this)
      } catch {
        ok = false
      }
      if (!ok) return this.close('refused')
      if (this.state !== 'open') return
      this.state = 'ready'
      for (const fn of this.readyFns) fn(this)
      return
    }
    if (this.state !== 'ready') return this.strike()
    const fn = this.handlers.get(msg.t)
    // A message type from a newer version (forward compatibility): ignored, at no cost. The
    // session's rate limit still bounds how many arrive.
    if (!fn) return
    try {
      await fn(msg, this)
    } catch {
      this.strike()
    }
  }

  strike(n = 1) {
    if (this.state === 'closed') return
    this.strikes += n
    if (this.strikes >= this.limits.strikes) this.close('strikes')
  }

  useful() {
    this.lastUseful = this.clock.now()
  }

  send(msg: Message): Promise<void> {
    if (this.state === 'closed' || this.state === 'handshake' || !this.tx) return Promise.resolve()
    let parts: Uint8Array[]
    try {
      parts = chunk(encodeMessage(msg))
    } catch {
      return Promise.reject(new FrameError('message too large'))
    }
    const tx = this.tx
    const seq = ++this.queuedSends
    const sealed = parts.map(p => tx.cipher.seal(p).then(s => ({ ...s, epoch: tx.epoch })))
    const run = this.txChain.then(async () => {
      for (const p of sealed) {
        const { epoch, counter, ct } = await p
        // Closed by us: what was sent before still goes out, ahead of the goodbye.
        if (this.state === 'closed' && seq > this.flushTo) return
        this.raw(FrameType.Data, dataPayload(epoch, counter, ct))
      }
    })
    this.txChain = run.catch(() => {})
    return run
  }

  // A fresh handshake inside the encrypted session: new keys, same devices. Frames carry the key
  // epoch, so frames already on their way under the old keys still open.
  async rekey() {
    if (this.state !== 'ready' || this.rekeying || this.opts.role !== 'initiator') return
    const init = new Initiator(this.opts.me, this.opts.pipe.remote, 'rekey')
    this.rekeying = { init, resp: null }
    this.rekeyDeadline()
    await this.send({ t: 'rk1', h: b64u(init.h1()) })
  }

  private async onRekey(msg: Message) {
    if (this.state !== 'ready' || !this.remote) return this.strike()
    let h: Uint8Array
    try {
      h = fromB64u(String(msg.h))
    } catch {
      return this.strike()
    }
    try {
      if (msg.t === 'rk1' && this.opts.role === 'responder' && !this.rekeying) {
        const resp = new Responder(this.opts.me, this.opts.pipe.remote, 'rekey')
        this.rekeying = { init: null, resp }
        this.rekeyDeadline()
        await this.send({ t: 'rk2', h: b64u(await resp.h1(h)) })
      } else if (msg.t === 'rk2' && this.rekeying?.init) {
        const r = await this.rekeying.init.h2(h)
        if (r.remote.dk !== this.remote.dk) return this.close('strikes')
        await this.send({ t: 'rk3', h: b64u(r.h3) })
        this.switchKeys(r)
      } else if (msg.t === 'rk3' && this.rekeying?.resp) {
        const r = await this.rekeying.resp.h3(h)
        if (r.remote.dk !== this.remote.dk) return this.close('strikes')
        this.switchKeys(r)
      } else return this.strike()
    } catch {
      this.close('strikes')
    }
  }

  // A rekey that never finishes leaves the two sides unsure which keys are next: drop the
  // session (without a ban) and let it reconnect.
  private rekeyDeadline() {
    const pending = this.rekeying
    this.timers.push(
      this.clock.set(() => {
        if (this.rekeying !== null && this.rekeying === pending) this.close('timeout')
      }, this.limits.handshakeMs)
    )
  }

  private switchKeys(est: Established) {
    const epoch = ((this.tx?.epoch ?? 0) + 1) & 0xff
    this.tx = { epoch, cipher: new Cipher(est.keys.send) }
    this.nextRx = { epoch, cipher: new Cipher(est.keys.recv) }
    this.keepBulk(est, epoch)
    this.keyedAt = this.clock.now()
    this.rekeying = null
  }

  get epoch() {
    return this.tx?.epoch ?? -1
  }

  close(reason: CloseReason = 'closed') {
    if (this.state === 'closed') return
    this.flushTo = this.queuedSends
    const tx = this.tx
    // A goodbye, so the other side sees us leave at once instead of after the ping timeout.
    if (tx && (this.state === 'ready' || this.state === 'open')) {
      const sealed = tx.cipher.seal(chunk(encodeMessage({ t: 'bye' }))[0])
      this.txChain = this.txChain
        .then(async () => {
          const { counter, ct } = await sealed
          this.opts.pipe.send(encodeFrame(FrameType.Data, dataPayload(tx.epoch, counter, ct)))
        })
        .catch(() => {})
    }
    const pipe = this.opts.pipe
    void this.txChain.then(() => pipe.close())
    this.finish(reason)
  }

  private finish(reason: CloseReason) {
    if (this.state === 'closed') return
    this.state = 'closed'
    this.reason = reason
    for (const t of this.timers) this.clock.clear(t)
    this.timers = []
    this.wake?.()
    this.tx = null
    this.rx = null
    this.nextRx = null
    for (const k of this.bulk.values()) {
      k.send.fill(0)
      k.recv.fill(0)
    }
    this.bulk.clear()
    for (const fn of this.bulkWaiters) fn()
    for (const fn of this.closeFns) fn(this, reason)
  }
}
