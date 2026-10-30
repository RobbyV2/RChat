import { Resolver, type Resolved } from './resolve'
import type { Membership, StateEvent } from './state'

// Where state resolution runs. In the browser a Web Worker keeps a resolver per room (with its
// incremental caches), so a replay of a large room never blocks the page; elsewhere (tests, or a
// browser without workers) it runs in this thread. The page keeps the state events it sent, and
// results come back as ids.

export interface ResolveHost {
  // Replaces what is known of a room with these events.
  load(room: string, events: StateEvent[]): Promise<Resolved>
  add(room: string, events: StateEvent[]): Promise<Resolved>
  drop(room: string): void
}

export interface Packed {
  state: [string, string][]
  heads: string[]
  rejected: string[]
  lost: string[]
  transitions: [string, Membership | null][]
  joins: [string, string][]
  count: number
  gaps: number
  flagged: [string, number][]
  power: [string, string][]
}

export const pack = (r: Resolved): Packed => ({
  state: [...r.state].map(([k, e]) => [k, e.id]),
  heads: r.heads,
  rejected: [...r.rejected],
  lost: [...r.lost],
  transitions: [...r.transitions],
  joins: [...r.joins],
  count: r.count,
  gaps: r.gaps,
  flagged: [...r.flagged],
  power: [...r.power],
})

export const unpack = (p: Packed, byId: (id: string) => StateEvent | undefined): Resolved => {
  const state = new Map<string, StateEvent>()
  for (const [k, id] of p.state) {
    const e = byId(id)
    if (e) state.set(k, e)
  }
  return {
    state,
    heads: p.heads,
    rejected: new Set(p.rejected),
    lost: new Set(p.lost),
    transitions: new Map(p.transitions),
    joins: new Map(p.joins),
    count: p.count,
    gaps: p.gaps,
    flagged: new Map(p.flagged),
    power: new Map(p.power),
  }
}

export class LocalHost implements ResolveHost {
  private rooms = new Map<string, Resolver>()

  async load(room: string, events: StateEvent[]) {
    const r = new Resolver()
    r.add(events)
    this.rooms.set(room, r)
    return r.resolved()
  }

  async add(room: string, events: StateEvent[]) {
    let r = this.rooms.get(room)
    if (!r) {
      r = new Resolver()
      this.rooms.set(room, r)
    }
    r.add(events)
    return r.resolved()
  }

  drop(room: string) {
    this.rooms.delete(room)
  }
}

export interface WorkerLike {
  postMessage(m: unknown): void
  onmessage: ((e: MessageEvent) => void) | null
  onerror: ((e: unknown) => void) | null
  terminate(): void
}

export type HostRequest =
  | { id: number; op: 'load' | 'add'; room: string; events: StateEvent[] }
  | { id: number; op: 'drop'; room: string }

export type HostReply = { id: number; ok: Packed } | { id: number; err: string }

// A resolution request, in the worker (p2p.worker.ts): a resolver per room, kept between requests.
export const serveResolve = (
  rooms: Map<string, Resolver>,
  m: HostRequest,
  post: (r: HostReply) => void
) => {
  if (m.op === 'drop') {
    rooms.delete(m.room)
    return
  }
  try {
    let r = m.op === 'load' ? undefined : rooms.get(m.room)
    if (!r) {
      r = new Resolver()
      rooms.set(m.room, r)
    }
    r.add(m.events)
    post({ id: m.id, ok: pack(r.resolved()) })
  } catch (err) {
    post({ id: m.id, err: err instanceof Error ? err.message : String(err) })
  }
}

// Resolution in a worker. Requests run in order; if the worker fails, the rooms it held are
// resolved here instead from then on.
export class WorkerHost implements ResolveHost {
  private worker: WorkerLike | null
  private seq = 0
  private jobs = new Map<
    number,
    { room: string; done: (r: Resolved) => void; fail: (e: Error) => void }
  >()
  private events = new Map<string, Map<string, StateEvent>>()
  private local: LocalHost | null = null

  constructor(make: () => WorkerLike) {
    this.worker = make()
    this.worker.onmessage = e => this.reply(e.data as HostReply)
    this.worker.onerror = () => this.fallBack()
  }

  private known(room: string) {
    let m = this.events.get(room)
    if (!m) {
      m = new Map()
      this.events.set(room, m)
    }
    return m
  }

  private reply(m: HostReply) {
    const job = this.jobs.get(m.id)
    if (!job) return
    this.jobs.delete(m.id)
    if ('err' in m) return job.fail(new Error(m.err))
    const known = this.events.get(job.room) ?? new Map<string, StateEvent>()
    job.done(unpack(m.ok, id => known.get(id)))
  }

  private fallBack() {
    this.worker?.terminate()
    this.worker = null
    this.local = new LocalHost()
    const jobs = [...this.jobs.values()]
    this.jobs.clear()
    // Everything the worker held is resolved here again.
    void (async () => {
      for (const [room, m] of this.events)
        await (this.local as LocalHost).load(room, [...m.values()])
      for (const j of jobs) j.done(await (this.local as LocalHost).add(j.room, []))
    })().catch(e => jobs.forEach(j => j.fail(e as Error)))
  }

  private send(room: string, op: 'load' | 'add', events: StateEvent[]): Promise<Resolved> {
    const known = op === 'load' ? new Map<string, StateEvent>() : this.known(room)
    for (const e of events) known.set(e.id, e)
    this.events.set(room, known)
    if (!this.worker) return (this.local as LocalHost)[op](room, events)
    const id = ++this.seq
    return new Promise((done, fail) => {
      this.jobs.set(id, { room, done, fail })
      ;(this.worker as WorkerLike).postMessage({ id, op, room, events } satisfies HostRequest)
    })
  }

  load(room: string, events: StateEvent[]) {
    return this.send(room, 'load', events)
  }

  add(room: string, events: StateEvent[]) {
    return this.send(room, 'add', events)
  }

  drop(room: string) {
    this.events.delete(room)
    if (this.worker)
      this.worker.postMessage({ id: ++this.seq, op: 'drop', room } satisfies HostRequest)
    else this.local?.drop(room)
  }

  stop() {
    this.worker?.terminate()
    this.worker = null
  }
}
