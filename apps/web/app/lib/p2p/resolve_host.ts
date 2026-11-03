import {
  AclRoom,
  type AclItem,
  type Carried,
  type Disowned,
  type Drops,
  type ProofCand,
  type Purgeable,
  type Reapply,
  type Restored,
  type Plan,
  type PlanReq,
  type Received,
  type Shown,
  type SumDelta,
} from './acl_room'
import type { ContentEv } from './acl/visibility'
import type { WireV2 } from './event'

// Where the ACL evaluator of P2P servers runs. In the browser a Web Worker keeps an AclRoom per
// room (its index, evaluation and merge caches), so an evaluation never blocks the page; elsewhere
// (tests, or a browser without workers) it runs in this thread. Replies that can change the
// current state carry what changed since the last reply for that room (acl_room.ts SumDelta).

export interface AclHost {
  // Replaces what is known of a room with its stored events; the delta is the whole state, `fresh`
  // the events admitted again (stored without a record this build reads), `refused` stored events
  // that aren't admitted (an import). `check`: imported content to decide.
  load(
    room: string,
    acl: AclItem[],
    contents: ContentEv[],
    check?: { id: string; w: WireV2 }[],
    bodiless?: string[],
    evicted?: string[]
  ): Promise<Loaded>
  acl(room: string, id: string, w: WireV2, now: number): Promise<Decided>
  content(room: string, id: string, w: WireV2, now: number): Promise<Received>
  plan(room: string, q: PlanReq): Promise<Plan>
  display(room: string, ids: string[]): Promise<(Shown | null)[]>
  history(room: string, ik: string, ids: string[]): Promise<boolean[]>
  diff(room: string, from: string[], have: string[], limit: number): Promise<string[]>
  // Storage (acl_room.ts): what to drop, proofs worth posting, purgeable bodies, bodies wanted
  // back, bodies purged or restored, and what a member may be sent.
  drops(room: string, mine?: string): Promise<Dropped>
  proofs(room: string, a: string, dev: string, devs?: string[]): Promise<ProofCand[]>
  purgeable(room: string, only?: string[]): Promise<Purgeable>
  wanted(room: string): Promise<string[]>
  bodies(room: string, ids: string[], have: boolean, evicted?: boolean): Promise<null>
  acks(room: string, me: string): Promise<string[]>
  unhold(room: string, ids: string[]): Promise<null>
  restorable(room: string, ids: string[], viewed: boolean): Promise<boolean[]>
  viewable(room: string, ik: string, chs: (string | null)[]): Promise<boolean[]>
  lastSent(room: string, a: string, ch: string): Promise<number | null>
  // Flows (spec 3.9, 9 rule 18): our denies to re-apply, and what a lost device did after `t`.
  reapply(room: string, me: string, exclude?: string[]): Promise<Reapply[]>
  counted(room: string, ids: string[]): Promise<boolean[]>
  stopped(room: string, ids: string[]): Promise<boolean[]>
  carried(room: string, up: string): Promise<Carried | null>
  disown(room: string, ik: string, dk: string, witnesses: string[], own?: number): Promise<Disowned>
  drop(room: string): void
}

// What storage drops, and the change it makes to the state's heads.
export interface Dropped extends Drops {
  delta: SumDelta | null
}

export interface Decided {
  out: Received
  delta: SumDelta | null
}

export interface Loaded extends Restored {
  delta: SumDelta | null
}

export type HostRequest =
  | {
      id: number
      op: 'load'
      room: string
      acl: AclItem[]
      contents: ContentEv[]
      check?: { id: string; w: WireV2 }[]
      bodiless?: string[]
      evicted?: string[]
    }
  | { id: number; op: 'acl' | 'content'; room: string; ev: string; w: WireV2; now: number }
  | { id: number; op: 'plan'; room: string; q: PlanReq }
  | { id: number; op: 'display'; room: string; ids: string[] }
  | { id: number; op: 'history'; room: string; ik: string; ids: string[] }
  | { id: number; op: 'diff'; room: string; from: string[]; have: string[]; limit: number }
  | { id: number; op: 'drops'; room: string; mine?: string }
  | { id: number; op: 'proofs'; room: string; a: string; dev: string; devs?: string[] }
  | { id: number; op: 'purgeable'; room: string; only?: string[] }
  | { id: number; op: 'wanted'; room: string }
  | { id: number; op: 'bodies'; room: string; ids: string[]; have: boolean; evicted?: boolean }
  | { id: number; op: 'acks'; room: string; me: string }
  | { id: number; op: 'unhold'; room: string; ids: string[] }
  | { id: number; op: 'restorable'; room: string; ids: string[]; viewed: boolean }
  | { id: number; op: 'viewable'; room: string; ik: string; chs: (string | null)[] }
  | { id: number; op: 'last'; room: string; a: string; ch: string }
  | { id: number; op: 'reapply'; room: string; me: string; exclude?: string[] }
  | { id: number; op: 'counted'; room: string; ids: string[] }
  | { id: number; op: 'stopped'; room: string; ids: string[] }
  | { id: number; op: 'carried'; room: string; up: string }
  | {
      id: number
      op: 'disown'
      room: string
      ik: string
      dk: string
      witnesses: string[]
      own?: number
    }
  | { id: number; op: 'drop'; room: string }

export type HostReply = { id: number; ok: unknown } | { id: number; err: string }

const roomOf = (rooms: Map<string, AclRoom>, room: string) => {
  let r = rooms.get(room)
  if (!r) {
    r = new AclRoom(room)
    rooms.set(room, r)
  }
  return r
}

// One request against the rooms a host keeps.
export const runRequest = (rooms: Map<string, AclRoom>, m: HostRequest): unknown => {
  switch (m.op) {
    case 'load': {
      const r = new AclRoom(m.room)
      rooms.set(m.room, r)
      const out = r.restore(m.acl, m.contents, m.check, m.bodiless, m.evicted)
      return { ...out, delta: r.delta() } satisfies Loaded
    }
    case 'acl': {
      const r = roomOf(rooms, m.room)
      const out = r.receiveAcl(m.ev, m.w, m.now)
      return { out, delta: out.s === 'A' || out.s === 'U' ? r.delta() : null } satisfies Decided
    }
    case 'content':
      return roomOf(rooms, m.room).receiveContent(m.ev, m.w, m.now)
    case 'plan':
      return roomOf(rooms, m.room).plan(m.q)
    case 'display':
      return roomOf(rooms, m.room).display(m.ids)
    case 'history':
      return roomOf(rooms, m.room).history(m.ik, m.ids)
    case 'diff':
      return roomOf(rooms, m.room).aclDiff(m.from, m.have, m.limit)
    case 'drops': {
      const r = roomOf(rooms, m.room)
      const d = r.drops(m.mine)
      return { ...d, delta: d.acl.length ? r.delta() : null } satisfies Dropped
    }
    case 'proofs':
      return roomOf(rooms, m.room).proofs({ a: m.a, dev: m.dev }, m.devs)
    case 'purgeable':
      return roomOf(rooms, m.room).purgeable(m.only)
    case 'wanted':
      return roomOf(rooms, m.room).wanted()
    case 'bodies':
      roomOf(rooms, m.room).bodies(m.ids, m.have, m.evicted)
      return null
    case 'acks':
      return roomOf(rooms, m.room).acks(m.me)
    case 'unhold':
      roomOf(rooms, m.room).unhold(m.ids)
      return null
    case 'restorable':
      return roomOf(rooms, m.room).restorable(m.ids, m.viewed)
    case 'viewable':
      return roomOf(rooms, m.room).viewable(m.ik, m.chs)
    case 'last':
      return roomOf(rooms, m.room).lastSent(m.a, m.ch)
    case 'reapply':
      return roomOf(rooms, m.room).reapply(m.me, m.exclude)
    case 'counted':
      return roomOf(rooms, m.room).counted(m.ids)
    case 'stopped':
      return roomOf(rooms, m.room).stopped(m.ids)
    case 'carried':
      return roomOf(rooms, m.room).carried(m.up)
    case 'disown':
      return roomOf(rooms, m.room).disown(m.ik, m.dk, m.witnesses, m.own)
    case 'drop':
      rooms.delete(m.room)
      return null
  }
}

// A request in the worker (p2p.worker.ts): an AclRoom per room, kept between requests.
export const serveAcl = (
  rooms: Map<string, AclRoom>,
  m: HostRequest,
  post: (r: HostReply) => void
) => {
  try {
    const ok = runRequest(rooms, m)
    if (m.op !== 'drop') post({ id: m.id, ok })
  } catch (err) {
    post({ id: m.id, err: err instanceof Error ? err.message : String(err) })
  }
}

type Body<T> = T extends unknown ? Omit<T, 'id'> : never

abstract class Base implements AclHost {
  protected abstract call<T>(m: Body<HostRequest>): Promise<T>
  load(
    room: string,
    acl: AclItem[],
    contents: ContentEv[],
    check?: { id: string; w: WireV2 }[],
    bodiless?: string[],
    evicted?: string[]
  ) {
    return this.call<Loaded>({
      op: 'load',
      room,
      acl,
      contents,
      ...(check ? { check } : {}),
      ...(bodiless?.length ? { bodiless } : {}),
      ...(evicted?.length ? { evicted } : {}),
    })
  }
  acl(room: string, ev: string, w: WireV2, now: number) {
    return this.call<Decided>({ op: 'acl', room, ev, w, now })
  }
  content(room: string, ev: string, w: WireV2, now: number) {
    return this.call<Received>({ op: 'content', room, ev, w, now })
  }
  plan(room: string, q: PlanReq) {
    return this.call<Plan>({ op: 'plan', room, q })
  }
  display(room: string, ids: string[]) {
    return this.call<(Shown | null)[]>({ op: 'display', room, ids })
  }
  history(room: string, ik: string, ids: string[]) {
    return this.call<boolean[]>({ op: 'history', room, ik, ids })
  }
  diff(room: string, from: string[], have: string[], limit: number) {
    return this.call<string[]>({ op: 'diff', room, from, have, limit })
  }
  drops(room: string, mine?: string) {
    return this.call<Dropped>({ op: 'drops', room, ...(mine ? { mine } : {}) })
  }
  proofs(room: string, a: string, dev: string, devs?: string[]) {
    return this.call<ProofCand[]>({ op: 'proofs', room, a, dev, ...(devs ? { devs } : {}) })
  }
  purgeable(room: string, only?: string[]) {
    return this.call<Purgeable>({ op: 'purgeable', room, ...(only ? { only } : {}) })
  }
  wanted(room: string) {
    return this.call<string[]>({ op: 'wanted', room })
  }
  bodies(room: string, ids: string[], have: boolean, evicted?: boolean) {
    return this.call<null>({ op: 'bodies', room, ids, have, ...(evicted ? { evicted } : {}) })
  }
  acks(room: string, me: string) {
    return this.call<string[]>({ op: 'acks', room, me })
  }
  unhold(room: string, ids: string[]) {
    return this.call<null>({ op: 'unhold', room, ids })
  }
  restorable(room: string, ids: string[], viewed: boolean) {
    return this.call<boolean[]>({ op: 'restorable', room, ids, viewed })
  }
  viewable(room: string, ik: string, chs: (string | null)[]) {
    return this.call<boolean[]>({ op: 'viewable', room, ik, chs })
  }
  lastSent(room: string, a: string, ch: string) {
    return this.call<number | null>({ op: 'last', room, a, ch })
  }
  reapply(room: string, me: string, exclude?: string[]) {
    return this.call<Reapply[]>({
      op: 'reapply',
      room,
      me,
      ...(exclude?.length ? { exclude } : {}),
    })
  }
  stopped(room: string, ids: string[]) {
    return this.call<boolean[]>({ op: 'stopped', room, ids })
  }

  carried(room: string, up: string) {
    return this.call<Carried | null>({ op: 'carried', room, up })
  }

  counted(room: string, ids: string[]) {
    return this.call<boolean[]>({ op: 'counted', room, ids })
  }
  disown(room: string, ik: string, dk: string, witnesses: string[], own = -1) {
    return this.call<Disowned>({ op: 'disown', room, ik, dk, witnesses, own })
  }
  abstract drop(room: string): void
}

export class LocalHost extends Base {
  rooms = new Map<string, AclRoom>()
  protected async call<T>(m: Body<HostRequest>) {
    return runRequest(this.rooms, { ...m, id: 0 } as HostRequest) as T
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

// The evaluator in a worker. Requests run in order; if the worker fails, its rooms are lost: the
// owner reloads them (`onLost`) into this thread, which serves every request from then on.
export class WorkerHost extends Base {
  private worker: WorkerLike | null
  private seq = 0
  private jobs = new Map<number, { done: (r: unknown) => void; fail: (e: Error) => void }>()
  private local: LocalHost | null = null
  onLost: (() => void) | null = null

  constructor(make: () => WorkerLike) {
    super()
    this.worker = make()
    this.worker.onmessage = e => this.reply(e.data as HostReply)
    this.worker.onerror = () => this.fallBack()
  }

  private reply(m: HostReply) {
    const job = this.jobs.get(m.id)
    if (!job) return
    this.jobs.delete(m.id)
    if ('err' in m) job.fail(new Error(m.err))
    else job.done(m.ok)
  }

  private fallBack() {
    this.worker?.terminate()
    this.worker = null
    this.local = new LocalHost()
    const jobs = [...this.jobs.values()]
    this.jobs.clear()
    for (const j of jobs) j.fail(new Error('acl host lost'))
    this.onLost?.()
  }

  protected call<T>(m: Body<HostRequest>): Promise<T> {
    if (!this.worker) return (this.local as LocalHost)['call']<T>(m)
    const id = ++this.seq
    return new Promise<T>((done, fail) => {
      this.jobs.set(id, { done: done as (r: unknown) => void, fail })
      ;(this.worker as WorkerLike).postMessage({ ...m, id } as HostRequest)
    })
  }

  drop(room: string) {
    if (this.worker)
      this.worker.postMessage({ id: ++this.seq, op: 'drop', room } satisfies HostRequest)
    else this.local?.drop(room)
  }

  stop() {
    this.worker?.terminate()
    this.worker = null
  }
}
