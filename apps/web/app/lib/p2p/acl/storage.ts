import { anchorOf, Mono, type Anchor, type FastEval } from './eval'
import { gt, poster, type AclContent, type AclEv, type Rank } from './rules'

// What storage may do with admitted events, decided here so storage applies it as given: the
// orphan rule's drops and the headers they keep (spec §2.3, §4.2), and the deterministic parts of
// a cause's stability (§4.3 S2, S3).

// An ACL event the orphan rule lets storage drop; its header stays when `header`.
export interface Drop {
  id: string
  header: boolean
}

const NEVER: readonly string[] = ['genesis', 'upgrade', 'proof']

// Events dropped from storage before that the index still holds whole (the live replica), and
// whether each kept its header.
export type Gone = ReadonlyMap<string, boolean>

// The orphan rule (§2.3) on everything held: an X event other than the genesis, an upgrade or a
// proof, a candidate by structural evidence (not only pool evidence: that can end, revision 7),
// may go when nothing held is built on it. Held descendants are the ACL events that stay and the
// content that holds its position (`cited`: visible content cites the event; hidden content holds
// nothing, controller ruling). `keep`: events storage keeps whatever (this device's own chain,
// which it cites). Its header stays unless it is past its device's fork point, no identity op, in
// no kept header's past, and the device's fork point stays the same without it (revision 7). The
// drops are decided in the reference's order (`equivocation.ts` orphanDrops: rounds over the
// candidates in descending id order), so the same headers stay. `gone`: what earlier drops
// decided (an event dropped without its header is no evidence any more).
export function orphanDrops(
  fe: FastEval,
  cited: (i: number) => boolean,
  keep: (i: number) => boolean = () => false,
  gone: Gone = new Map()
): Drop[] {
  const ix = fe.ix
  const n = ix.n
  const held = new Uint8Array(n)
  for (let i = n - 1; i >= 0; i--) {
    if (!fe.inS(i)) continue
    if (!droppable(fe, i, keep) || cited(i)) {
      held[i] = 1
      continue
    }
    for (const k of ix.kids[i])
      if (held[k]) {
        held[i] = 1
        break
      }
  }
  // the round of each drop: after every descendant, a round later when that one has a lower id
  const round = new Int32Array(n)
  const list: number[] = []
  for (let i = n - 1; i >= 0; i--) {
    if (!fe.inS(i) || held[i]) continue
    let r = 1
    for (const k of ix.kids[i])
      if (fe.inS(k)) r = Math.max(r, round[k] + (ix.ids[k] > ix.ids[i] ? 0 : 1))
    round[i] = r
    list.push(i)
  }
  list.sort((x, y) => round[x] - round[y] || (ix.ids[x] < ix.ids[y] ? 1 : -1))
  const ev = new ForkEvidence(fe, gone)
  // in a kept header's past: below a header outside the index, or below a drop that kept its own
  const below = new Uint8Array(n)
  const H = fe.hdrs
  if (H) {
    const marked = new Uint8Array(n)
    for (const h of H.list)
      for (const f of h.fr) {
        if (marked[f]) continue
        marked[f] = 1
        below[f] = 1
        const a = ix.anc[f]
        for (let w = 0; w < a.length; w++) {
          let m = a[w]
          while (m) {
            const t = m & -m
            below[(w << 5) + (31 - Math.clz32(t))] = 1
            m ^= t
          }
        }
      }
  }
  const header = new Uint8Array(n)
  const out: Drop[] = []
  for (const i of list) {
    const id = ix.ids[i]
    for (const k of ix.kids[i]) if (fe.inS(k) && (header[k] || below[k])) below[i] = 1
    const was = gone.get(id)
    const e = ix.ev[i]
    const h =
      was ??
      !(
        e.seq >= (fe.F.get(e.dev) ?? Infinity) &&
        ix.rec[i].depth < 0 &&
        !below[i] &&
        ev.removable(i)
      )
    if (h) header[i] = 1
    else if (was === undefined) ev.remove(i)
    out.push({ id, header: h })
  }
  out.sort((x, y) => ix.at.get(x.id)! - ix.at.get(y.id)!)
  return out
}

// The evidence behind each device's fork point (§2.3 E1, E2, proofs): which events may go
// without their header and leave it where it is.
class ForkEvidence {
  private seqN = new Map<string, number>()
  private prevN = new Map<string, number>()
  private prevAtF = new Map<string, number>()
  private hits = new Map<string, number>()
  private dev = new Set<string>()
  constructor(
    private fe: FastEval,
    gone: Gone
  ) {
    const ix = fe.ix
    const add = (e: { dev: string; seq: number; aprev?: string }) => {
      const f = fe.F.get(e.dev)
      if (f === undefined) return
      this.dev.add(e.dev)
      this.inc(this.seqN, `${e.dev}\u0001${e.seq}`, 1)
      const pk = `${e.dev}\u0001${e.aprev ?? ''}`
      this.inc(this.prevN, pk, 1)
      if (e.seq === f) this.inc(this.prevAtF, pk, 1)
    }
    for (const [dev, es] of ix.byDev) {
      if (!fe.F.has(dev)) continue
      for (const i of es) if (fe.inS(i) && gone.get(ix.ids[i]) !== false) add(ix.ev[i])
    }
    for (const h of fe.hdrs?.list ?? []) add(h.ev)
    for (const dev of this.dev) this.hits.set(dev, 0)
    for (const [k, c] of this.seqN) {
      const [dev, sq] = k.split('\u0001')
      if (c >= 2 && Number(sq) === fe.F.get(dev)) this.inc(this.hits, dev, 1)
    }
    for (const [k, c] of this.prevN)
      if (c >= 2 && (this.prevAtF.get(k) ?? 0) > 0) this.inc(this.hits, k.split('\u0001')[0], 1)
    for (const p of ix.proofEv) {
      if (!fe.inS(p)) continue
      const { x, y } = ix.ev[p].c as unknown as {
        x: { dev: string; seq: number }
        y: { seq: number }
      }
      if (Math.min(x.seq, y.seq) === fe.F.get(x.dev)) this.inc(this.hits, x.dev, 1)
    }
  }
  private inc(m: Map<string, number>, k: string, d: number) {
    m.set(k, (m.get(k) ?? 0) + d)
  }
  // The groups (same seq, same aprev) that give F(dev) and lose that without i.
  private lost(i: number) {
    const e = this.fe.ix.ev[i]
    const f = this.fe.F.get(e.dev)!
    let l = 0
    if (e.seq === f && this.seqN.get(`${e.dev}\u0001${e.seq}`) === 2) l++
    const pk = `${e.dev}\u0001${e.aprev ?? ''}`
    const c = this.prevN.get(pk) ?? 0
    const atF = this.prevAtF.get(pk) ?? 0
    if (c >= 2 && atF > 0 && (c === 2 || (e.seq === f && atF === 1))) l++
    return l
  }
  removable(i: number) {
    const dev = this.fe.ix.ev[i].dev
    return this.dev.has(dev) && this.hits.get(dev)! - this.lost(i) >= 1
  }
  remove(i: number) {
    const e = this.fe.ix.ev[i]
    const f = this.fe.F.get(e.dev)!
    this.inc(this.hits, e.dev, -this.lost(i))
    this.inc(this.seqN, `${e.dev}\u0001${e.seq}`, -1)
    const pk = `${e.dev}\u0001${e.aprev ?? ''}`
    this.inc(this.prevN, pk, -1)
    if (e.seq === f) this.inc(this.prevAtF, pk, -1)
  }
}

export const droppable = (fe: FastEval, i: number, keep: (i: number) => boolean) =>
  fe.X[i] === 1 &&
  !NEVER.includes(fe.ix.ev[i].t) &&
  !keep(i) &&
  fe.candidateIn(i, fe.F, fe.FI, fe.RF)

// Events that are droppable or have a droppable event in their past: content citing one of them
// may be all that holds it.
export function underDroppable(fe: FastEval, keep: (i: number) => boolean): Uint8Array {
  const ix = fe.ix
  const out = new Uint8Array(ix.n)
  for (let i = 0; i < ix.n; i++) {
    if (!fe.inS(i)) continue
    if (droppable(fe, i, keep)) out[i] = 1
    else for (const p of ix.pa[i]) if (out[p]) out[i] = 1
  }
  return out
}

// A dropped event's header (§2.3): its core with what indexing and evidence read of its content
// (targets, roles, bits, codes, devices, watermarks), without bulk such as certificates and
// profiles. A header counts as every kind of evidence; it never takes effect.
export function headerContent(c: Record<string, unknown> | null): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const small = (v: unknown) =>
    typeof v === 'number' || typeof v === 'boolean' || (typeof v === 'string' && v.length <= 128)
  for (const [k, v] of Object.entries(c ?? {})) {
    if (small(v)) out[k] = v
    else if (Array.isArray(v) && v.length <= 16 && v.every(x => typeof x === 'string' && small(x)))
      out[k] = v
    else if (
      typeof v === 'object' &&
      v !== null &&
      !Array.isArray(v) &&
      Object.keys(v).length <= 16 &&
      Object.values(v).every(x => typeof x === 'number')
    )
      out[k] = v
  }
  return out
}

export const headerOf = (e: AclEv): AclEv => ({
  ...e,
  c: headerContent(e.c as Record<string, unknown>) as AclContent,
})

// S2 (§4.3): at least 3 admitted ACL events, none void by equivocation, by at least 2 identities
// other than `not`, acknowledge the cause (`acks`, tried from index `from` on).
export function witnessed(
  fe: FastEval,
  from: number,
  acks: (i: number) => boolean,
  not: readonly string[]
): boolean {
  const ix = fe.ix
  const who = new Set<string>()
  let n = 0
  for (let i = Math.max(0, from); i < ix.n; i++) {
    if (!fe.inS(i) || fe.X[i] === 1) continue
    const a = poster(ix.ev[i])
    if (not.includes(a) || not.includes(ix.ev[i].a) || !acks(i)) continue
    n += 1
    who.add(a)
    if (n >= 3 && who.size >= 2) return true
  }
  return false
}

// S3 (§4.3): no admitted deny at a stratum above `k`, concurrent with the cause (`conc`), takes
// away something in the authority the cause relied on (its anchor: an ACL deny's admission state,
// or a redaction's position).
export function uncontested(
  fe: FastEval,
  an: Anchor,
  k: Rank,
  conc: (i: number) => boolean
): boolean {
  const ix = fe.ix
  const base = new Mono(ix, an, null, null, new Set()).authorized()
  for (let i = 0; i < ix.n; i++) {
    if (!fe.inS(i) || !ix.isD[i] || !gt(ix.k(i), k) || !conc(i)) continue
    if (!base || !new Mono(ix, an, null, null, new Set([i])).authorized()) return false
  }
  return true
}

// S2 and S3 of an ACL cause d (a per-member deny, or a ban that hides everything): acknowledged
// by others than its author and target, and uncontested by a more senior concurrent deny.
export function stableDeny(fe: FastEval, d: number): boolean {
  const ix = fe.ix
  const e = ix.ev[d]
  const to = typeof e.c.to === 'string' ? e.c.to : e.a
  if (!witnessed(fe, d + 1, i => ix.has(i, d), [e.a, poster(e), to])) return false
  return uncontested(fe, anchorOf(ix, d), ix.k(d), i => i !== d && !ix.has(d, i) && !ix.has(i, d))
}
