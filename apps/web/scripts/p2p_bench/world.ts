// The P2P bench world (recon-p2p-scale §2.1): the scenario builder over the production admission
// that acl_bench.ts and the P2P bench scripts share, a fake v2 wire for AclRoom.receiveAcl, and
// what every P2P bench script shares: its command line (`--out <dir>`, `--events`, `--members`,
// `--seed`, `--chan`, script options) and its output, one JSON line per measurement with the
// 1-minute load (`load`).
import { loadavg } from 'node:os'
import { fileURLToPath } from 'node:url'
import { AclReplica, identityHead, pastOf, type Verdict } from '../../app/lib/p2p/acl/admit'
import { idOp, type AclContent, type AclEv } from '../../app/lib/p2p/acl/rules'
import type { WireV2 } from '../../app/lib/p2p/event_v2'
import { AGREED, type Agreed } from '../../app/lib/p2p/limits'

export type Obj = Record<string, unknown>

// The benchmarks' limits: production ones, with timestamps in minutes.
export const LIM: Agreed = { ...AGREED, win: 60, day: 1440 }

export const devOwner = (dev: string) => dev.replace(/[0-9]+$/, '')
export const binds = (e: AclEv) => devOwner(e.dev) === e.a

export class Rng {
  constructor(public s: number) {
    if (!this.s) this.s = 1
  }
  next() {
    let x = this.s
    x ^= x << 13
    x ^= x >>> 17
    x ^= x << 5
    this.s = x >>> 0
    return this.s / 4294967296
  }
  int(n: number) {
    return Math.floor(this.next() * n)
  }
  pick<T>(a: readonly T[]): T {
    return a[this.int(a.length)]
  }
  chance(p: number) {
    return this.next() < p
  }
  shuffle<T>(a: T[]): T[] {
    const b = [...a]
    for (let i = b.length - 1; i > 0; i--) {
      const j = this.int(i + 1)
      const t = b[i]
      b[i] = b[j]
      b[j] = t
    }
    return b
  }
}

export interface Opts {
  ap?: string[]
  keepOwn?: boolean
  seq?: number
  aprev?: string | null
  iprev?: string | null
  ts?: number
}

// A scenario builder over the production replica (the model's fastworld.ts): heads and each
// device's latest event tracked incrementally; like an honest client, `build` fills the acting
// identity of revocations and the remover's watermark of kick, ban and revoke.
export class BenchWorld {
  ref = new AclReplica({ binds, agreed: LIM })
  n = 0
  headSet = new Set<string>()
  private lastOwn = new Map<string, AclEv>()
  heads(): string[] {
    return [...this.headSet]
  }
  latestOwn(dev: string): AclEv | undefined {
    return this.lastOwn.get(dev)
  }
  private note(e: AclEv, v: Verdict) {
    if (v.s !== 'A') return
    for (const p of e.ap) this.headSet.delete(p)
    this.headSet.add(e.id)
    const l = this.lastOwn.get(e.dev)
    if (!l || e.seq > l.seq) this.lastOwn.set(e.dev, e)
  }
  genesis(dev: string, owners: string[], everyone = 0, ts = 0): AclEv {
    const e: AclEv = {
      id: `g${this.n++}`,
      t: 'genesis',
      a: devOwner(dev),
      dev,
      seq: 0,
      ap: [],
      ts,
      c: {
        rules: 2,
        nonce: 'AAAAAAAAAAAAAAAAAAAAAA',
        owners: owners.map(ik => ({ ik })),
        everyone_bits: everyone,
        name: 'S',
      } as unknown as AclContent,
    }
    this.note(e, this.ref.receive(e))
    return e
  }
  build(dev: string, t: string, c: Obj = {}, o: Opts = {}): AclEv {
    const a = devOwner(dev)
    const ix = this.ref.acl.ix
    const inC = (ap: string[], id: string) => {
      const i = ix.at.get(id)!
      return ap.some(p => p === id || ix.has(ix.at.get(p)!, i))
    }
    let ap = o.ap
      ? [...o.ap]
      : this.clientRule
        ? this.defaultParents(dev)
        : this.capped(dev, this.heads())
    if (o.ap && (o.keepOwn ?? (o.seq === undefined && o.aprev === undefined))) {
      const own = this.latestOwn(dev)
      if (own && !inC(ap, own.id)) ap.push(own.id)
    }
    ap = [...new Set(ap)]
    const B = pastOf(ix, ap)
    const inB = (i: number) => ((B.bits[i >>> 5] >>> (i & 31)) & 1) === 1
    let last: AclEv | undefined
    for (const x of ix.byDev.get(dev) ?? []) {
      if (!inB(x)) continue
      if (!last || ix.ev[x].seq > last.seq) last = ix.ev[x]
    }
    const ts = o.ts ?? Math.max(0, ...ap.map(p => this.ref.ev(p).ts)) + 1
    const cc = { ...c }
    if ((t === 'device_revoke' || t === 'primary_rotate') && cc.ik === undefined) cc.ik = a
    if ((t === 'kick' || t === 'ban' || (t === 'revoke' && cc.to !== a)) && cc.seen === undefined) {
      const seen: Record<string, number> = {}
      for (const x of ix.byAuthor.get(cc.to as string) ?? [])
        if (inB(x)) seen[ix.ev[x].dev] = Math.max(seen[ix.ev[x].dev] ?? -1, ix.ev[x].seq)
      cc.seen = seen
    }
    const e: AclEv = {
      id: `${t}.${dev}.${this.n++}`,
      t,
      a,
      dev,
      seq: o.seq ?? (last ? last.seq + 1 : 1),
      ap,
      ts,
      c: cc as AclContent,
    }
    const aprev = o.aprev === undefined ? last?.id : (o.aprev ?? undefined)
    if (aprev) e.aprev = aprev
    if (idOp(e, this.ref.acl.stateOf(ap).facts)) {
      const ip =
        o.iprev === undefined
          ? identityHead(a, B, t === 'primary_rotate').iprev
          : (o.iprev ?? undefined)
      if (ip) e.iprev = ip
    }
    return e
  }
  // At most LIM.ap parents (§1.2): the most recently admitted, with the device's own latest event
  // in their closure.
  private capped(dev: string, hs: string[]): string[] {
    const ix = this.ref.acl.ix
    let ap = hs
    if (ap.length > LIM.ap)
      ap = [...ap].sort((x, y) => ix.at.get(y)! - ix.at.get(x)!).slice(0, LIM.ap)
    const own = this.latestOwn(dev)
    if (own && !ap.some(p => p === own.id || ix.has(ix.at.get(p)!, ix.at.get(own.id)!))) {
      if (ap.length >= LIM.ap) ap[ap.length - 1] = own.id
      else ap.push(own.id)
    }
    return ap
  }
  // The client rule (§1.2), for the measured honest events: the maximal events that are no
  // candidate, X or Tail event (upgrades excepted), walking down from excluded heads.
  clientRule = false
  defaultParents(dev: string): string[] {
    const st = this.ref.state()
    const fe = this.ref.acl.evaluation()
    const ix = this.ref.acl.ix
    const forked =
      st.F.size > 0 ||
      [...st.FI.values()].some(d => d < Infinity) ||
      st.RF.size > 0 ||
      st.PC.size > 0
    const bad = (id: string) => {
      const i = ix.at.get(id)!
      return (
        ix.ev[i].t !== 'upgrade' &&
        (fe.X[i] === 1 ||
          fe.tail[i] === 1 ||
          (forked && fe.candidateIn(i, st.F, st.FI, st.RF, st.PC)))
      )
    }
    const hs = this.heads()
    if (!hs.some(bad)) return this.capped(dev, hs)
    const out = new Set<string>()
    const seen = new Set<string>()
    const todo = [...hs]
    while (todo.length) {
      const x = todo.pop()!
      if (seen.has(x)) continue
      seen.add(x)
      if (!bad(x)) out.add(x)
      else for (const q of this.ref.ev(x).ap) todo.push(q)
    }
    const l = [...out]
    const at = (id: string) => ix.at.get(id)!
    return this.capped(
      dev,
      l.filter(x => !l.some(y => y !== x && ix.has(at(y), at(x))))
    )
  }
  act(dev: string, t: string, c: Obj = {}, o: Opts = {}): { e: AclEv; v: Verdict } {
    const e = this.build(dev, t, c, o)
    const v = this.ref.receive(e)
    this.note(e, v)
    return { e, v }
  }
  state() {
    return this.ref.state()
  }
}

// A v2 wire that aclEvOf maps back to e (the page checked signatures before the worker).
export const wireOf = (e: AclEv): WireV2 =>
  ({
    ev: {
      v: 2,
      ...(e.t === 'genesis' ? {} : { srv: 'g0' }),
      t: e.t,
      L: 'a',
      a: e.a,
      dev: e.dev,
      seq: e.seq,
      ...(e.ap.length ? { ap: e.ap } : {}),
      ...(e.aprev ? { aprev: e.aprev } : {}),
      ...(e.iprev ? { iprev: e.iprev } : {}),
      ts: e.ts,
      ch: '',
    },
    c: e.c,
    sig: '',
  }) as unknown as WireV2

// ----- Command line and output -----

export const BENCH_DIR = fileURLToPath(new URL('../../.bench/', import.meta.url))

export interface Args {
  out: string
  events: number
  members: number
  seed: number
  chan: boolean
  num(name: string, d: number): number
  list(name: string): number[] | undefined
  flag(name: string): boolean
}

export function args(argv = process.argv.slice(2)): Args {
  const m = new Map<string, string>()
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) throw new Error(`unexpected argument ${a}`)
    const v = argv[i + 1]
    if (v === undefined || v.startsWith('--')) m.set(a.slice(2), '')
    else {
      m.set(a.slice(2), v)
      i++
    }
  }
  const num = (name: string, d: number) => {
    const v = m.get(name)
    if (v === undefined) return d
    const n = Number(v)
    if (v === '' || !Number.isFinite(n)) throw new Error(`--${name} needs a number`)
    return n
  }
  const list = (name: string) => {
    const v = m.get(name)
    if (v === undefined) return undefined
    const l = v.split(',').map(Number)
    if (!v || l.some(x => !Number.isFinite(x))) throw new Error(`--${name} needs numbers`)
    return l
  }
  return {
    out: m.get('out') || BENCH_DIR,
    events: num('events', 5000),
    members: num('members', 150),
    seed: num('seed', 1),
    chan: m.has('chan'),
    num,
    list,
    flag: name => m.has(name),
  }
}

export const load = () => +loadavg()[0].toFixed(1)

export const emit = (bench: string, o: Obj) =>
  console.log(JSON.stringify({ bench, ...o, load: load() }))

export const progress = (bench: string, o: Obj) =>
  console.error(JSON.stringify({ bench, ...o, load: load() }))

export const f1 = (x: number) => +x.toFixed(1)
export const f3 = (x: number) => +x.toFixed(3)
export const med = (xs: readonly number[]) => [...xs].sort((a, b) => a - b)[xs.length >> 1]
export const mean = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0) / xs.length

export const gc = () => (globalThis as { Bun?: { gc: (f: boolean) => void } }).Bun?.gc(true)
// The JS heap and the typed arrays it holds, MiB.
export const heapMb = () => {
  const m = process.memoryUsage()
  return Math.round((m.heapUsed + m.arrayBuffers) / 2 ** 20)
}
export const rssMb = () => Math.round(process.memoryUsage().rss / 2 ** 20)
