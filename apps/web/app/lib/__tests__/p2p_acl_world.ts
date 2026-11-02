import { afterAll, afterEach, beforeAll, expect } from 'bun:test'
import { AclReplica, decideContent, identityHead, pastOf, type Verdict } from '../p2p/acl/admit'
import { evaluate } from '../p2p/acl/eval'
import { ContentView, type ContentEv } from '../p2p/acl/visibility'
import type { EvalResult, Facts } from '../p2p/acl/facts'
import {
  BAN,
  EVERYONE,
  idOp,
  INVITE,
  KICK,
  PRODUCTION_LIMITS,
  rkey,
  ROLES,
  SERVER,
  setLimits,
  type AclContent,
  type AclEv,
  type Limits,
} from '../p2p/acl/rules'
import * as M from './acl_model/model'
import type { World as ModelWorld } from './acl_model/world'

// Test bridge between the executable reference model (acl_model/, a copy of notes/acl-model) and
// the production ACL modules: event formats both ways, a production world with the model's
// World API, and checks that replay a universe through both and compare every verdict, every
// admission record and state, and the final state.

export const devOwner = (dev: string) => dev.replace(/[0-9]+$/, '')

// The model's limits (smaller than production, so the generators reach every cap).
export const MODEL_LIMITS: Limits = {
  ...PRODUCTION_LIMITS,
  devCap: M.LIM.devCap,
  w3: M.LIM.w3,
  w3mod: M.LIM.w3mod,
  win: M.LIM.win,
  day: M.LIM.day,
  freshCap: M.LIM.freshCap,
  idCap: M.LIM.idCap,
  rotCap: M.LIM.rotCap,
  classes: M.LIM.classes,
  pendingPerDev: M.LIM.pendingPerDev,
  codesPerDev: M.LIM.codesPerDev,
  codesPerDevServer: M.LIM.codesPerDevServer,
  roles: M.LIM.roles,
  totU: M.LIM.totU,
  rotTot: M.LIM.rotTot,
  poolU: M.LIM.poolU,
}
export const useModelLimits = () => setLimits(MODEL_LIMITS)
export const useProductionLimits = () => setLimits({})

const BITMAP: [number, number][] = [
  [M.KICK, KICK],
  [M.BAN, BAN],
  [M.ROLES, ROLES],
  [M.INVITE, INVITE],
  [M.SERVER, SERVER],
]
export const m2p = (m: number) => BITMAP.reduce((o, [a, b]) => (m & a ? o | b : o), 0)
export const p2m = (m: number) => BITMAP.reduce((o, [a, b]) => (m & b ? o | a : o), 0)
const roleP = (r: unknown) => (r === M.EVERYONE ? EVERYONE : r)
const roleM = (r: unknown) => (r === EVERYONE ? M.EVERYONE : r)

type Obj = Record<string, unknown>

// The watermark an honest remover's client signs: the highest seq of each of T's devices it holds.
function seenMap(
  T: string,
  past: Iterable<string>,
  ev: (id: string) => { a: string; dev: string; seq: number }
) {
  const seen: Record<string, number> = {}
  for (const id of past) {
    const x = ev(id)
    if (x.a === T) seen[x.dev] = Math.max(seen[x.dev] ?? -1, x.seq)
  }
  return seen
}

// A model event in the production format. `mref` (the model replica that saw it) gives the
// remover's watermark of kick, ban and revoke, which the model doesn't carry.
export function toProd(e: M.Ev, mref: M.Replica): AclEv {
  const c = { ...(e.c ?? {}) } as Obj
  if (typeof c.role === 'string') c.role = roleP(c.role)
  switch (e.t) {
    case 'genesis':
      return {
        ...base(e),
        c: {
          rules: 2,
          nonce: 'n',
          owners: (e.c.owners as string[]).map(ik => ({ ik })),
          everyone_bits: m2p(e.c.everyone ?? 0),
          name: 'S',
        } as unknown as AclContent,
      }
    case 'role_create':
      c.bits = m2p(e.c.bits)
      break
    case 'role_bits':
      c.bit = m2p(e.c.bit)
      break
    case 'device_revoke':
      return { ...base(e), c: { ik: e.a, dk: e.c.dev, seen: e.c.seen } as unknown as AclContent }
    case 'primary_rotate':
      c.ik = e.a
      break
    case 'upgrade':
      if (Array.isArray(e.c.sigs))
        c.sigs = Object.fromEntries(e.c.sigs.map((o: string) => [o, 's']))
      break
    case 'kick':
    case 'ban':
    case 'revoke': {
      if (e.t === 'revoke' && e.c.to === e.a) break
      const past = new Set<string>()
      for (const p of e.ap)
        if (mref.status.get(p)?.s === 'A') {
          past.add(p)
          for (const x of mref.anc(p)) past.add(x)
        }
      c.seen = seenMap(e.c.to, past, id => mref.ev(id))
      break
    }
  }
  return { ...base(e), c: c as AclContent }
}
const base = (e: {
  id: string
  t: string
  a: string
  dev: string
  seq: number
  ap: string[]
  aprev?: string
  iprev?: string
  ts: number
}) => {
  const out: AclEv = {
    id: e.id,
    t: e.t,
    a: e.a,
    dev: e.dev,
    seq: e.seq,
    ap: [...e.ap],
    ts: e.ts,
    c: {} as AclContent,
  }
  if (e.aprev !== undefined) out.aprev = e.aprev
  if (e.iprev !== undefined) out.iprev = e.iprev
  return out
}

// A production event in the model format.
export function toModel(e: AclEv): M.Ev {
  const c = { ...e.c } as Obj
  if (typeof c.role === 'string') c.role = roleM(c.role)
  switch (e.t) {
    case 'genesis':
      return {
        ...base(e),
        t: 'genesis',
        c: { owners: (e.c.owners ?? []).map(o => o.ik), everyone: p2m(e.c.everyone_bits ?? 0) },
      } as M.Ev
    case 'role_create':
      c.bits = p2m(e.c.bits)
      break
    case 'role_bits':
      c.bit = p2m(e.c.bit)
      break
    case 'device_revoke':
      return { ...base(e), c: { dev: e.c.dk, seen: e.c.seen } } as M.Ev
    case 'primary_rotate':
      delete c.ik
      break
    case 'upgrade':
      if (c.sigs && typeof c.sigs === 'object') c.sigs = Object.keys(c.sigs)
      break
  }
  return { ...base(e), c } as M.Ev
}

// The model's evalSummary of a production state (bits and @everyone in the model's terms).
export function evalSummary(r: EvalResult): string {
  return JSON.stringify({
    facts: factsSummary(r.facts),
    X: [...r.X].sort(),
    tail: [...r.tail].sort(),
    cut: [...r.cut].map(([k, v]) => [k, rkey(v)]).sort(),
    eff: [...r.eff].sort(),
  })
}
export function factsSummary(F: Facts) {
  const sortSet = (s: Iterable<string>) => [...s].sort()
  const mapSets = (m: Iterable<[string, Iterable<string>]>) =>
    [...m]
      .map(([k, v]) => [k, sortSet(v)] as const)
      .filter(([, v]) => v.length)
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
  return JSON.stringify({
    mem: sortSet(F.mem),
    ban: sortSet(F.ban),
    invited: sortSet(F.invited.keys()),
    pending: sortSet(F.pending.keys()),
    roles: sortSet(F.roles),
    pos: [...F.pos].sort(),
    bits: [...F.bits].map(([k, v]) => [roleM(k), p2m(v)]).sort(),
    holds: mapSets(F.holds),
    devs: mapSets(F.devs),
    revoked: sortSet(F.revoked),
    codes: sortSet(F.codes.keys()),
    profile: [...F.profile].map(([k, v]) => [k, v.name]).sort(),
    setting: F.setting?.name ?? null,
    upgraded: sortSet(F.upgraded),
  })
}

const verdictKey = (v: Verdict | M.Verdict | undefined) =>
  v === undefined ? 'none' : v.s === 'R' || v.s === 'M' ? `${v.s}:${v.why}` : v.s
const recKey = (r: {
  k: readonly [number, string]
  cls: string
  self: boolean
  exempt: boolean
  depth: number
  epoch: string
  pool?: string[]
}) =>
  JSON.stringify([
    rkey(r.k),
    r.cls,
    r.self,
    r.exempt,
    r.depth,
    r.epoch,
    r.pool ? [...r.pool].sort() : null,
  ])

// Compares a production replica with a model replica that saw the same universe: every verdict,
// every admission record and admission state St(e), the incremental and the batch final state.
function compare(ids: string[], pr: AclReplica, mr: M.Replica, out: string[]) {
  for (const id of ids) {
    const pv = verdictKey(pr.status.get(id))
    const mv = verdictKey(mr.status.get(id))
    if (pv !== mv) {
      out.push(`verdict of ${id}: ${pv}, model ${mv}`)
      return
    }
    if (pv !== 'A' || mr.ev(id).t === 'genesis') continue
    const p = recKey(pr.rec(id))
    const m = recKey(mr.rec(id))
    if (p !== m) {
      out.push(`record of ${id}: ${p}, model ${m}`)
      return
    }
    const ps = evalSummary(pr.rec(id).local)
    const ms = M.evalSummary(mr.rec(id).local)
    if (ps !== ms) {
      out.push(`St(${id}) differs: ${ps} model ${ms}`)
      return
    }
  }
  const want = M.evalSummary(mr.state())
  const got = evalSummary(pr.state())
  if (got !== want) out.push(`final state differs: ${got} model ${want}`)
  const b = evalSummary(evaluate([...pr.order].reverse(), pr))
  if (b !== want) out.push(`batch evaluation differs: ${b} model ${want}`)
}

// Replays a model universe (genCase) through the production replica and compares.
export function diffModelWorld(mw: ModelWorld): string[] {
  const out: string[] = []
  const pr = new AclReplica({ binds: e => devOwner(e.dev) === e.a })
  for (const me of mw.all) pr.receive(toProd(me, mw.ref))
  compare(
    mw.all.map(e => e.id),
    pr,
    mw.ref,
    out
  )
  return out
}

// A production replica with the model replica's ancestry helper.
export class TestReplica extends AclReplica {
  private ancs = new Map<string, Set<string>>()
  constructor() {
    super({ binds: e => devOwner(e.dev) === e.a })
  }
  anc(id: string): Set<string> {
    let s = this.ancs.get(id)
    if (!s) {
      const ix = this.acl.ix
      const i = ix.at.get(id)
      if (i === undefined) throw new Error(`not admitted: ${id}`)
      s = new Set<string>()
      for (let x = 0; x < i; x++) if (ix.has(i, x)) s.add(ix.ids[x])
      this.ancs.set(id, s)
    }
    return s
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

export const liveWorlds: AclWorld[] = []

// The model's World over the production modules. Content is in the production format; like an
// honest client, `build` fills the acting identity of device_revoke and primary_rotate and the
// remover's watermark of kick, ban and revoke when they are not given.
export class AclWorld {
  ref = new TestReplica()
  all: AclEv[] = []
  n = 0
  contents: ContentEv[] = []
  private top = new Map<string, number>()
  // model: false for universes with types the model lacks (channel, chperm, proof)
  constructor(o: { model?: boolean } = {}) {
    if (o.model !== false) liveWorlds.push(this)
  }
  heads(ids?: string[]): string[] {
    const set = ids ?? this.ref.order
    const inPast = new Set<string>()
    for (const id of set) for (const x of this.ref.anc(id)) inPast.add(x)
    return set.filter(id => !inPast.has(id))
  }
  closure(ap: string[]): Set<string> {
    const B = new Set<string>()
    for (const p of ap) {
      B.add(p)
      for (const x of this.ref.anc(p)) B.add(x)
    }
    return B
  }
  latestOwn(dev: string): AclEv | undefined {
    let best: AclEv | undefined
    for (const id of this.ref.order) {
      const e = this.ref.ev(id)
      if (e.dev === dev && (!best || e.seq > best.seq)) best = e
    }
    return best
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
        nonce: 'n',
        owners: owners.map(ik => ({ ik })),
        everyone_bits: everyone,
        name: 'S',
      } as unknown as AclContent,
    }
    this.all.push(e)
    this.ref.receive(e)
    return e
  }
  build(dev: string, t: string, c: Obj = {}, o: Opts = {}): AclEv {
    const a = devOwner(dev)
    let ap = o.ap ? [...o.ap] : this.heads()
    if (o.ap && (o.keepOwn ?? (o.seq === undefined && o.aprev === undefined))) {
      const own = this.latestOwn(dev)
      if (own && !this.closure(ap).has(own.id)) ap.push(own.id)
    }
    ap = [...new Set(ap)]
    const B = this.closure(ap)
    const own = [...B]
      .map(id => this.ref.ev(id))
      .filter(x => x.dev === dev)
      .sort((x, y) => x.seq - y.seq)
    const last = own[own.length - 1]
    const ts = o.ts ?? Math.max(0, ...ap.map(p => this.ref.ev(p).ts)) + 1
    const cc = { ...c }
    if ((t === 'device_revoke' || t === 'primary_rotate') && cc.ik === undefined) cc.ik = a
    if ((t === 'kick' || t === 'ban' || (t === 'revoke' && cc.to !== a)) && cc.seen === undefined) {
      const seen = seenMap(cc.to as string, B, id => this.ref.ev(id))
      for (const m of this.contents)
        if (m.a === cc.to) seen[m.dev] = Math.max(seen[m.dev] ?? -1, m.seq)
      cc.seen = seen
    }
    const e: AclEv = {
      id: `${t}.${dev}.${this.n++}`,
      t,
      a,
      dev,
      seq: o.seq ?? Math.max(last ? last.seq + 1 : 1, (this.top.get(dev) ?? 0) + 1),
      ap,
      ts,
      c: cc as AclContent,
    }
    const aprev = o.aprev === undefined ? last?.id : (o.aprev ?? undefined)
    if (aprev) e.aprev = aprev
    const Fb = this.ref.acl.stateOf(ap).facts
    if (idOp(e, Fb)) {
      const ip =
        o.iprev === undefined
          ? identityHead(a, pastOf(this.ref.acl.ix, ap), t === 'primary_rotate').iprev
          : (o.iprev ?? undefined)
      if (ip) e.iprev = ip
    }
    return e
  }
  act(dev: string, t: string, c: Obj = {}, o: Opts = {}): { e: AclEv; v: Verdict } {
    const e = this.build(dev, t, c, o)
    this.all.push(e)
    return { e, v: this.ref.receive(e) }
  }
  ok(dev: string, t: string, c: Obj = {}, o: Opts = {}): AclEv {
    const { e, v } = this.act(dev, t, c, o)
    if (v.s !== 'A') throw new Error(`expected admit: ${e.id} ${JSON.stringify(v)}`)
    return e
  }
  state() {
    return this.ref.state()
  }
  // A content event (L = "c") by an honest device: one seq counter over both layers, its position
  // holding the device's own last ACL event, cprev its previous content event.
  content(
    dev: string,
    t = 'msg',
    c: Obj = { body: 'hi' },
    o: { ap?: string[]; seq?: number; cprev?: string | null; ts?: number; keepOwn?: boolean } = {}
  ): ContentEv {
    let ap = o.ap ? [...o.ap] : this.heads()
    const own = this.latestOwn(dev)
    if (o.ap && o.keepOwn !== false && own && !this.closure(ap).has(own.id)) ap.push(own.id)
    ap = [...new Set(ap)]
    const mine = this.contents.filter(x => x.dev === dev)
    const prevC = mine.reduce<ContentEv | undefined>(
      (b, x) => (!b || x.seq > b.seq ? x : b),
      undefined
    )
    const seq = o.seq ?? Math.max(own?.seq ?? 0, this.top.get(dev) ?? 0) + 1
    const m: ContentEv = {
      id: `${t}.${dev}.${this.n++}`,
      t,
      a: devOwner(dev),
      dev,
      seq,
      ap,
      ts: o.ts ?? Math.max(0, ...ap.map(p => this.ref.ev(p).ts)) + 1,
      c,
    }
    const cprev = o.cprev === undefined ? prevC?.id : (o.cprev ?? undefined)
    if (cprev) m.cprev = cprev
    this.top.set(dev, Math.max(this.top.get(dev) ?? 0, seq))
    this.contents.push(m)
    return m
  }
  admitContent(m: ContentEv) {
    return decideContent(m, pastOf(this.ref.acl.ix, m.ap), this.ref.acl.stateOf(m.ap), {
      binds: e => devOwner(e.dev) === e.a,
    })
  }
  view() {
    return new ContentView(this.ref.acl, this.contents)
  }
}

// Replays a production world's universe through the model (in the model's format) and compares.
export function diffProdWorld(w: AclWorld): string[] {
  const out: string[] = []
  const mr = new M.Replica()
  for (const e of w.all) mr.receive(toModel(e))
  compare(
    w.all.map(e => e.id),
    w.ref,
    mr,
    out
  )
  return out
}

// Installs, in a test file: the model's limits, and after each test the model diff of every
// world the test built.
export function modelDiffAfterEach() {
  beforeAll(useModelLimits)
  afterAll(useProductionLimits)
  afterEach(() => {
    const ws = liveWorlds.splice(0)
    for (const w of ws) expect(diffProdWorld(w)).toEqual([])
  }, 600_000)
}
