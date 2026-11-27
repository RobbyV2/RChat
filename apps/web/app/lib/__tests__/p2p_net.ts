import 'fake-indexeddb/auto'
import { own } from './helpers/fixture'
import { P2pStore } from '../p2p/db'
import {
  P2pNode,
  TransportError,
  type NodeDeps,
  type Transport,
  type Visibility,
} from '../p2p/node'
import type { ChannelLike, LockLike } from '../p2p/leader'
import type { Clock, Pipe } from '../p2p/session'

// In-memory transport for P2P tests: a pair of pipes with optional delay, tampering and
// partitions, and a manual clock.

export interface PipeEnd extends Pipe {
  // Every frame this end sent, for replay tests.
  sent: Uint8Array[]
  closed: boolean
}

export interface Wire {
  // Rewrites or drops (null) a frame in flight.
  tamper?: (data: Uint8Array, from: 'a' | 'b') => Uint8Array | null
  cut: boolean
}

export const pipePair = (aId: string, bId: string, wire: Wire = { cut: false }, kind?: 'bulk') => {
  const make = (remote: string) => {
    const dataFns: ((d: Uint8Array) => void)[] = []
    const closeFns: (() => void)[] = []
    const end: PipeEnd & { deliver: (d: Uint8Array) => void; shut: () => void } = {
      remote,
      ...(kind ? { kind } : {}),
      sent: [],
      closed: false,
      send(data: Uint8Array) {
        if (end.closed) throw new Error('closed')
        end.sent.push(data)
        other(end).deliver(data)
      },
      onData: (fn: (d: Uint8Array) => void) => void dataFns.push(fn),
      onClose: (fn: () => void) => void closeFns.push(fn),
      deliver(d: Uint8Array) {
        if (end.closed || wire.cut) return
        const from: 'a' | 'b' = end === a ? 'b' : 'a'
        const t = wire.tamper ? wire.tamper(d, from) : d
        if (t === null) return
        queueMicrotask(() => {
          if (!end.closed) dataFns.forEach(f => f(t))
        })
      },
      shut() {
        if (end.closed) return
        end.closed = true
        closeFns.forEach(f => f())
      },
      close() {
        end.shut()
        other(end).shut()
      },
    }
    return end
  }
  // a is the end held by aId, so its remote is bId.
  const a = make(bId)
  const b = make(aId)
  const other = (e: unknown): typeof a => (e === a ? b : a)
  return { a, b }
}

export class ManualClock implements Clock {
  t = 1_700_000_000_000
  private timers = new Map<number, { at: number; fn: () => void }>()
  private next = 1

  now = () => this.t
  set = (fn: () => void, ms: number) => {
    const id = this.next++
    this.timers.set(id, { at: this.t + ms, fn })
    return id
  }
  clear = (h: unknown) => void this.timers.delete(h as number)

  async advance(ms: number) {
    const end = this.t + ms
    for (;;) {
      const due = [...this.timers.entries()]
        .filter(([, x]) => x.at <= end)
        .sort((x, y) => x[1].at - y[1].at)[0]
      if (!due) break
      this.timers.delete(due[0])
      this.t = Math.max(this.t, due[1].at)
      due[1].fn()
      await settle()
    }
    this.t = end
    await settle()
  }
}

export const settle = async (rounds = 30) => {
  for (let i = 0; i < rounds; i += 1) await new Promise(r => setTimeout(r, 0))
}

// Waits until `ok()` holds, however slow the machine is (WebCrypto and fake-indexeddb under a
// loaded test run). Fails with `what` after `ms` of real time (within the DM suites' 60 s test budget).
export const waitFor = async (ok: () => boolean, what = 'condition', ms = 50_000) => {
  const end = Date.now() + ms
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await new Promise(r => setTimeout(r, 1))
  }
  await settle(5)
}

// Seeded PRNG (mulberry32), printed by simulations on failure.
export const prng = (seed: number) => () => {
  seed |= 0
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

// A signaling hub: peers register ids, dials make a pipe pair. Ids can be squatted and peers
// taken offline.
export class Hub {
  private peers = new Map<string, { onPipe: (p: Pipe) => void; onLost: () => void }>()
  squatted = new Set<string>()
  dialCount = 0
  bulkDials = 0
  // Bulk pipes made, for cutting or tampering with them.
  bulkWires: { from: string; to: string; wire: Wire; a: PipeEnd; b: PipeEnd }[] = []
  private links: { from: string; to: string; wire: Wire; ends: ReturnType<typeof pipePair> }[] = []

  transport(): Transport {
    return {
      listen: async (id, onPipe, onLost) => {
        if (this.squatted.has(id) || this.peers.has(id)) throw new TransportError('unavailable-id')
        this.peers.set(id, { onPipe, onLost })
        return { close: () => void this.peers.delete(id) }
      },
      dial: async (from, to, kind) => {
        if (kind === 'bulk') this.bulkDials += 1
        else this.dialCount += 1
        const target = this.peers.get(to)
        if (!target) throw new TransportError('peer-unavailable')
        const wire: Wire = { cut: false }
        const ends = pipePair(from, to, wire, kind)
        const { a, b } = ends
        if (kind === 'bulk') this.bulkWires.push({ from, to, wire, a, b })
        this.links = this.links.filter(l => !l.ends.a.closed || !l.ends.b.closed)
        this.links.push({ from, to, wire, ends })
        target.onPipe(b)
        return a
      },
    }
  }

  // The signaling server dropped everyone.
  drop(id: string) {
    const p = this.peers.get(id)
    this.peers.delete(id)
    p?.onLost()
  }

  online(id: string) {
    return this.peers.has(id)
  }

  // The tab holding `id` dies: nothing more it sends arrives, and the far ends of its pipes never
  // hear them close.
  crash(id: string) {
    for (const { from, to, wire, ends } of this.links) {
      const mine = from === id ? ends.a : to === id ? ends.b : null
      if (!mine) continue
      wire.cut = true
      mine.close = () => mine.shut()
    }
  }
}

// A slow or loaded link for one side: while `held`, what that side sends waits until `release`.
// A frame whose pipe closed in the meantime is lost, as on a real link.
export class SlowLink {
  held = false
  private waiting: (() => void)[] = []

  constructor(private inner: () => Transport) {}

  get pending() {
    return this.waiting.length
  }

  release() {
    this.held = false
    for (const send of this.waiting.splice(0)) send()
  }

  transport(): Transport {
    const inner = this.inner()
    return {
      listen: (id, onPipe, onLost) => inner.listen(id, p => onPipe(this.pipe(p)), onLost),
      dial: async (from, to, kind) => this.pipe(await inner.dial(from, to, kind)),
    }
  }

  private pipe(p: Pipe): Pipe {
    return {
      ...p,
      send: data => {
        const send = () => {
          try {
            p.send(data)
          } catch {
            // Closed while the frame waited.
          }
        }
        if (this.held) this.waiting.push(send)
        else p.send(data)
      },
    }
  }
}

let dbSeq = 0

// A node on the hub, stopped after the test that made it.
export const makeNode = async (
  hub: Hub,
  name: string,
  opts: {
    clock?: Clock
    host?: string
    db?: string
    visibility?: Visibility
    limits?: NodeDeps['limits']
    session?: NodeDeps['session']
    contacts?: NodeDeps['contacts']
    transport?: Transport
  } = {}
) => {
  const db = opts.db ?? `test-${name}-${dbSeq++}-${Math.random()}`
  const store = await P2pStore.create(db)
  const node = (await P2pNode.open(
    {
      store,
      transport: opts.transport ?? hub.transport(),
      host: opts.host ?? 'chat.example',
      clock: opts.clock,
      visibility: opts.visibility,
      limits: opts.limits,
      session: opts.session,
      contacts: opts.contacts,
    },
    { name }
  )) as P2pNode
  return own({ node, store, db }, made => made.node.stop())
}

// Web Locks and BroadcastChannel stand-ins: one lock name, steal and abort supported.
export class FakeLocks implements LockLike {
  held: { done: boolean; reject: (e: Error) => void } | null = null
  private waiting: {
    cb: (l: unknown) => Promise<unknown>
    resolve: (v: unknown) => void
    reject: (e: Error) => void
    done: boolean
  }[] = []

  request(
    _name: string,
    opts: { signal?: AbortSignal; ifAvailable?: boolean; steal?: boolean },
    cb: (lock: unknown) => Promise<unknown>
  ) {
    return new Promise<unknown>((resolve, reject) => {
      const e = { cb, resolve, reject, done: false }
      if (opts.steal) {
        const old = this.held
        if (old) {
          old.done = true
          old.reject(new Error('AbortError'))
        }
        this.held = null
        return this.grant(e)
      }
      if (!this.held && this.waiting.length === 0) return this.grant(e)
      if (opts.ifAvailable) return void cb(null).then(resolve, reject)
      this.waiting.push(e)
      opts.signal?.addEventListener('abort', () => {
        const i = this.waiting.indexOf(e)
        if (i < 0) return
        this.waiting.splice(i, 1)
        reject(new Error('AbortError'))
      })
    })
  }

  private grant(e: (typeof this.waiting)[number]) {
    this.held = e
    const finish = (settle: () => void) => {
      if (e.done) return
      e.done = true
      settle()
      if (this.held !== e) return
      this.held = null
      const next = this.waiting.shift()
      if (next) this.grant(next)
    }
    void Promise.resolve()
      .then(() => e.cb({}))
      .then(
        v => finish(() => e.resolve(v)),
        err => finish(() => e.reject(err))
      )
  }
}

export const bus = () => {
  const chans = new Set<ChannelLike>()
  return (): ChannelLike => {
    const c: ChannelLike = {
      onmessage: null,
      postMessage: msg => {
        for (const o of chans) if (o !== c) queueMicrotask(() => o.onmessage?.({ data: msg }))
      },
      close: () => void chans.delete(c),
    }
    chans.add(c)
    return c
  }
}
