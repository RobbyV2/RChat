/* eslint-disable */
// @ts-nocheck
// Part of the P2P ACL reference model, used only by tests.
// Owner-signed checkpoints:
// an artifact outside evaluation. A checkpoint changes no rule and no result, only when a joiner can show
// a state. The transfer carries every event with its admission record and its admission state St(e), packed as the
// difference from the frontier state on B(e) (the frontier state is carried once). This form is frontier-relative, so
// it is the same on every honest replica whatever its admission order; the signer builds it per checkpoint from its
// stored states, and verification compares only in this form, never a store's bytes (a store's packing depends on its
// admission order). Adopting costs a restore, not an evaluation. The joiner shows the frontier state at once
// ("verifying"), re-admits every event in the background, and keeps the checkpoint only if every record, every admission
// state and the summary agree. The model has no cryptography: a signature is `sig:<dev>:<digest of the signed content>`.
import {
  type Ctx,
  type Ev,
  type EvalResult,
  type Rec,
  type Rank,
  Replica,
  evaluate,
  evalSummary,
  facts,
  factsSummary,
  rkey,
  withLim,
  type LIM,
} from './model'

const hash = (s: string) => new Bun.CryptoHasher('sha256').update(s).digest('hex')
/** the evaluator version a checkpoint was made with: a mismatch across versions is a bug report */
export const IMPL = 'model-1'

/** the admission record of an event without its admission state: what St(e) decided */
export const recordOf = (r: Rec) =>
  JSON.stringify({
    k: rkey(r.k),
    cls: r.cls,
    self: r.self,
    exempt: r.exempt,
    depth: r.depth,
    epoch: r.epoch,
    pool: r.pool ?? null,
    by: r.by ?? null,
    // a rotation's single chain head (the sibling rule reads it) and an upgrade's signers
    ...(r.head1 ? { head1: r.head1 } : {}),
    ...(r.sigBy ? { sigBy: r.sigBy } : {}),
  })

/** St(e) packed: the ids of B(e) whose membership in each set differs from the frontier state's, and the fork maps */
export interface Packed {
  v: string[]
  e: string[]
  x: string[]
  rf: string[]
  pc: string[]
  F: [string, number][]
  FI: [string, number][]
  fz?: string[]
  du?: string[]
}
/** the frontier state's sets, carried once */
export interface Front {
  void: string[]
  eff: string[]
  X: string[]
  RF: string[]
  PC: string[]
  tail: string[]
  cut: [string, string][]
  fz?: string[]
  du?: string[]
}
/** the frozen identities and inert upgrades a state's facts read (carried in full; usually none) */
const fxOf = (St: EvalResult) =>
  St.fx
    ? {
        ...(St.fx.frozen?.size ? { fz: sorted(St.fx.frozen) } : {}),
        ...(St.fx.deadUp?.size ? { du: sorted(St.fx.deadUp) } : {}),
      }
    : {}
const fxFrom = (o: { fz?: string[]; du?: string[] }) =>
  o.fz || o.du ? { frozen: new Set(o.fz ?? []), deadUp: new Set(o.du ?? []) } : undefined

export interface Checkpoint {
  v: 2
  srv: string // the server (its genesis id)
  frontier: string[] // the heads of C(frontier), sorted
  count: number // |C(frontier)|
  recs: string // digest of (id, record, packed St(e)) over C(frontier) in id order
  front: string // digest of the frontier state's sets
  hdrs: string // digest of the signer's kept headers (none in the model's replicas)
  sum: string // digest of the canonical summary of Eval(C(frontier))
  impl: string // the signer's evaluator version
  signer: string // a genesis owner
  dev: string // the owner's device that signs: introduced for the owner and live in C(frontier)
  sig: string
}
const content = (c: Omit<Checkpoint, 'sig'>) =>
  JSON.stringify([
    c.v,
    c.srv,
    c.frontier,
    c.count,
    c.recs,
    c.front,
    c.hdrs,
    c.sum,
    c.impl,
    c.signer,
    c.dev,
  ])
export const signCp = (c: Omit<Checkpoint, 'sig'>): Checkpoint => ({
  ...c,
  sig: `sig:${c.dev}:${hash(content(c))}`,
})

const closureOf = (cx: Ctx, frontier: string[]) => {
  const B = new Set<string>()
  for (const f of frontier) {
    B.add(f)
    for (const x of cx.anc(f)) B.add(x)
  }
  return B
}
const sorted = (xs: Iterable<string>) => [...xs].sort()
/** St(e) packed against the frontier state Sf: only ids of B(e) whose membership differs */
export function pack(St: EvalResult, Sf: EvalResult, inB: (x: string) => boolean): Packed {
  const d = (s: Set<string> | undefined, b: Set<string> | undefined) => {
    const out: string[] = []
    for (const x of s ?? []) if (!(b?.has(x) ?? false)) out.push(x)
    for (const x of b ?? []) if (inB(x) && !(s?.has(x) ?? false)) out.push(x)
    return out.sort()
  }
  return {
    v: d(St.void, Sf.void),
    e: d(St.eff, Sf.eff),
    x: d(St.X, Sf.X),
    rf: d(St.RF, Sf.RF),
    pc: d(St.PC, Sf.PC),
    F: [...St.F].sort(),
    FI: [...St.FI].sort(),
    ...fxOf(St),
  }
}
export const frontOf = (Sf: EvalResult): Front => ({
  void: sorted(Sf.void),
  eff: sorted(Sf.eff),
  X: sorted(Sf.X),
  RF: sorted(Sf.RF ?? []),
  PC: sorted(Sf.PC ?? []),
  tail: sorted(Sf.tail),
  cut: [...Sf.cut.entries()].map(([k, v]) => [k, rkey(v)] as [string, string]).sort(),
  ...fxOf(Sf),
})
const packKey = (p: Packed) =>
  JSON.stringify([
    p.v,
    p.e,
    p.x,
    p.rf,
    p.pc,
    p.F,
    p.FI,
    ...(p.fz || p.du ? [p.fz ?? [], p.du ?? []] : []),
  ])
export const recsDigest = (
  ids: string[],
  rec: (id: string) => Rec,
  packed: (id: string) => Packed
) =>
  hash(
    [...ids]
      .sort()
      .map(id => `${id}=${recordOf(rec(id))}|${packKey(packed(id))}`)
      .join('\n')
  )
const frontDigest = (f: Front) => hash(JSON.stringify(f))
const HDRS0 = hash('[]')

/** what travels to a joiner: the signed checkpoint, the events, their records and packed states, the frontier state */
export interface Transfer {
  cp: Checkpoint
  events: Ev[]
  recs: [string, Omit<Rec, 'local'>][]
  packed: [string, Packed][]
  front: Front
}
const encRec = (r: Rec): Omit<Rec, 'local'> => {
  const { local: _l, ...rest } = r
  return {
    ...rest,
    k: [
      r.k[0] === Infinity ? 1e300 : r.k[0] === -Infinity ? -1e300 : r.k[0],
      r.k[1],
    ] as unknown as Rank,
  }
}
const decRank = (k: Rank): Rank => [
  k[0] >= 1e300 ? Infinity : k[0] <= -1e300 ? -Infinity : k[0],
  k[1],
]

/** the heads of a causally closed set: the events no event of it names as a parent (linear in the parents) */
export const headsOf = (rep: Ctx & { order: string[] }) => {
  const parents = new Set<string>()
  for (const id of rep.order) for (const p of rep.ev(id).ap) parents.add(p)
  return rep.order.filter(id => !parents.has(id))
}
/**
 * An owner's device signs a checkpoint of its replica at `frontier` (default: its heads), with the transfer it serves:
 * the frontier-relative packed states are built here, per checkpoint, from the replica's stored admission states.
 */
export function makeTransfer(
  rep: Ctx & { order: string[] },
  dev: string,
  signer: string,
  frontier?: string[],
  stateOf?: (ids: string[]) => EvalResult,
  packer?: (Sf: EvalResult) => (id: string) => Packed
): Transfer {
  const heads = frontier ?? headsOf(rep)
  const C = closureOf(rep, heads),
    ids = rep.order.filter(x => C.has(x))
  const g = ids.find(id => rep.ev(id).t === 'genesis')!
  const Sf = stateOf ? stateOf(ids) : evaluate(ids, rep)
  const packed = new Map<string, Packed>()
  const pk = packer?.(Sf)
  for (const id of ids)
    packed.set(id, pk ? pk(id) : pack(rep.rec(id).local, Sf, x => rep.anc(id).has(x)))
  const front = frontOf(Sf)
  const cp = signCp({
    v: 2,
    srv: g,
    frontier: [...heads].sort(),
    count: ids.length,
    recs: recsDigest(
      ids,
      id => rep.rec(id),
      id => packed.get(id)!
    ),
    front: frontDigest(front),
    hdrs: HDRS0,
    sum: hash(evalSummary(Sf)),
    impl: IMPL,
    signer,
    dev,
  })
  return {
    cp,
    events: ids.map(id => rep.ev(id)),
    recs: ids.map(id => [id, encRec(rep.rec(id))]),
    packed: [...packed],
    front,
  }
}

/** a set restored from the frontier set and a packed difference, over B(e) */
class Overlay implements Iterable<string> {
  constructor(
    private inB: (x: string) => boolean,
    private base: Set<string>,
    private d: Set<string>
  ) {}
  has(x: string) {
    return this.inB(x) && this.base.has(x) !== this.d.has(x)
  }
  *[Symbol.iterator]() {
    for (const x of this.base) if (!this.d.has(x) && this.inB(x)) yield x
    for (const x of this.d) if (!this.base.has(x)) yield x
  }
  get size() {
    let n = 0
    for (const _ of this) n++
    return n
  }
}
/** St(e) restored from its packed form; `facts` worked out from the restored sets when first read */
export function restoreSt(
  cx: Ctx & { order: string[] },
  id: string,
  p: Packed,
  fs: { void: Set<string>; eff: Set<string>; X: Set<string>; RF: Set<string>; PC: Set<string> }
): EvalResult {
  const inB = (x: string) => cx.anc(id).has(x)
  const ov = (b: Set<string>, d: string[]) =>
    new Overlay(inB, b, new Set(d)) as unknown as Set<string>
  const st: any = {
    void: ov(fs.void, p.v),
    eff: ov(fs.eff, p.e),
    X: ov(fs.X, p.x),
    RF: ov(fs.RF, p.rf),
    PC: ov(fs.PC, p.pc),
    F: new Map(p.F),
    FI: new Map(p.FI),
    tail: new Set<string>(),
    cut: new Map(),
    ...(fxFrom(p) ? { fx: fxFrom(p) } : {}),
  }
  let f: ReturnType<typeof facts> | undefined
  Object.defineProperty(st, 'facts', {
    get: () =>
      (f ??= facts(cx.order.filter(inB), new Set(st.void), new Set(st.eff), cx, st.X, st.fx)),
    enumerable: true,
  })
  return st as EvalResult
}

export type CpCheck = { ok: true } | { ok: false; why: string }
/**
 * What a joiner checks before adopting: the signer is a genesis owner, the signature verifies, the device that
 * signed is introduced for the owner and live in the frontier state the transfer carries, and the events, records,
 * packed states and frontier state match the signed digests.
 */
export function checkTransfer(T: Transfer): CpCheck {
  const { cp, events } = T
  const g = events.find(e => e.t === 'genesis')
  if (!g || g.id !== cp.srv) return { ok: false, why: 'srv' }
  if (!(g.c?.owners ?? []).includes(cp.signer)) return { ok: false, why: 'signer' }
  const { sig, ...rest } = cp
  if (sig !== signCp(rest).sig) return { ok: false, why: 'sig' }
  const ids = events.map(e => e.id)
  if (ids.length !== cp.count || !cp.frontier.every(f => ids.includes(f)))
    return { ok: false, why: 'frontier' }
  const R = new Map(T.recs),
    P = new Map(T.packed)
  if (!ids.every(id => R.has(id) && P.has(id))) return { ok: false, why: 'records' }
  if (
    recsDigest(
      ids,
      id => ({ ...R.get(id)!, k: decRank(R.get(id)!.k) }) as Rec,
      id => P.get(id)!
    ) !== cp.recs
  )
    return { ok: false, why: 'records' }
  if (frontDigest(T.front) !== cp.front) return { ok: false, why: 'front' }
  if (cp.hdrs !== HDRS0) return { ok: false, why: 'headers' }
  return { ok: true }
}
/**
 * A joiner's replica restored from a transfer: every event with the record and the packed admission state it came with,
 * admission order = the given order, no `decide`, no evaluation.
 * The frontier state is shown at once from the carried sets, marked "verifying". The device that signed must be live
 * for the owner in it (else the transfer is refused and nothing is shown).
 */
export class Adopted implements Ctx {
  evs = new Map<string, Ev>()
  recs = new Map<string, Rec>()
  ancs = new Map<string, Set<string>>()
  order: string[] = []
  lim?: typeof LIM
  verifying = true
  discarded = false
  shown: {
    facts: ReturnType<typeof facts>
    X: Set<string>
    eff: Set<string>
    tail: Set<string>
    cut: Map<string, string>
  }
  report?: {
    kind: 'lie' | 'impl'
    signer: string
    dev: string
    cp: Checkpoint
    id: string
    claimed: string
    verified: string
  }
  cp: Checkpoint
  constructor(T: Transfer, lim?: typeof LIM) {
    this.cp = T.cp
    this.lim = lim
    const R = new Map(T.recs),
      P = new Map(T.packed)
    const fs = {
      void: new Set(T.front.void),
      eff: new Set(T.front.eff),
      X: new Set(T.front.X),
      RF: new Set(T.front.RF),
      PC: new Set(T.front.PC),
    }
    for (const e of T.events) {
      this.evs.set(e.id, e)
      const B = new Set<string>()
      for (const p of e.ap) {
        B.add(p)
        for (const x of this.ancs.get(p) ?? []) B.add(x)
      }
      this.ancs.set(e.id, B)
      this.order.push(e.id)
      const r = R.get(e.id)!
      this.recs.set(e.id, {
        ...r,
        k: decRank(r.k),
        local: restoreSt(this, e.id, P.get(e.id)!, fs),
      } as Rec)
    }
    const f = withLim(lim, () => facts(this.order, fs.void, fs.eff, this, fs.X, fxFrom(T.front)))
    this.shown = {
      facts: f,
      X: fs.X,
      eff: fs.eff,
      tail: new Set(T.front.tail),
      cut: new Map(T.front.cut),
    }
    if (!(f.devs.get(T.cp.signer)?.has(T.cp.dev) ?? false) || f.revoked.has(T.cp.dev))
      throw new Error('checkpoint signer device not live')
  }
  ev(id: string) {
    return this.evs.get(id)!
  }
  anc(id: string) {
    return this.ancs.get(id)!
  }
  rec(id: string) {
    return this.recs.get(id)!
  }
  /** the shown state's summary, from the carried sets (no evaluation) */
  shownSummary() {
    return JSON.stringify({
      facts: factsSummary(this.shown.facts),
      X: sorted(this.shown.X),
      tail: sorted(this.shown.tail),
      cut: [...this.shown.cut.entries()].sort(),
      eff: sorted(this.shown.eff),
    })
  }
  /** a full evaluation over the restored records (what the joiner runs when an ACL event arrives) */
  state(): EvalResult {
    return withLim(this.lim, () => evaluate(this.order, this))
  }
  /** what the client may do while verifying: post content and its own join (admitted against the shown state); every
   * other ACL action (moderation, invites, roles) waits */
  mayPost(layer: 'a' | 'c' | 'join') {
    return layer !== 'a' || !this.verifying
  }
}

/**
 * Background verification: the joiner re-admits every event itself (its own `decide`, in its own order),
 * packs its own admission states against its own frontier state, and compares each record, each packed state, the
 * frontier state and the summary. Equal: the checkpoint is kept and verification ends. Different: the adopted state is
 * discarded, the verified replica replaces it, and the signer is reported with the checkpoint, the device that signed
 * and the first event whose record or state differs; with another evaluator version (`impl`) it is a bug report, not
 * evidence against the signer. Only a checkpoint the joiner's own verification refutes is reported.
 */
export function verify(ad: Adopted, events: Ev[], T?: Transfer): { replica: Replica; ok: boolean } {
  const rep = new Replica()
  for (const e of events) rep.receive(e)
  const ids = ad.order
  const Sf = rep.evalSet(rep.order.filter(x => ad.evs.has(x)))
  const P = T ? new Map(T.packed) : undefined
  let first: string | undefined
  for (const id of [...ids].sort()) {
    if (!rep.admitted(id) || recordOf(rep.rec(id)) !== recordOf(ad.rec(id))) {
      first = id
      break
    }
    if (
      P &&
      packKey(pack(rep.rec(id).local, Sf, x => rep.anc(id).has(x))) !== packKey(P.get(id)!)
    ) {
      first = id
      break
    }
  }
  const sumOk =
    hash(evalSummary(Sf)) === ad.cp.sum && (!T || frontDigest(frontOf(Sf)) === ad.cp.front)
  const ok = first === undefined && sumOk
  ad.verifying = false
  if (!ok) {
    ad.discarded = true
    const id = first ?? '(summary)'
    ad.report = {
      kind: ad.cp.impl === IMPL ? 'lie' : 'impl',
      signer: ad.cp.signer,
      dev: ad.cp.dev,
      cp: ad.cp,
      id,
      claimed: first ? recordOf(ad.rec(first)) : ad.cp.sum,
      verified:
        first && rep.admitted(first)
          ? recordOf(rep.rec(first))
          : String(rep.status.get(id)?.s ?? 'summary'),
    }
  }
  return { replica: rep, ok }
}

/** Two checkpoints of one server for one frontier that differ: neither is evidence by itself; a client
 * reports only the one its own verification refutes. */
export function conflicting(a: Checkpoint, b: Checkpoint): boolean {
  return (
    a.srv === b.srv &&
    JSON.stringify(a.frontier) === JSON.stringify(b.frontier) &&
    (a.recs !== b.recs || a.sum !== b.sum || a.count !== b.count)
  )
}
