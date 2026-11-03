import type { AclState } from './cache'
import { CauseView, Mono, type Anchor, type FastEval } from './eval'
import type { EvalResult } from './facts'
import { EMPTY, type Ix } from './reach'
import {
  cmp,
  CONTENT_PIN,
  CONTENT_REDACT,
  exposedTo,
  gt,
  MESSAGES,
  minR,
  P,
  permsQ,
  rank,
  type AclContent,
  type AclEv,
  type Rank,
} from './rules'

// Content visibility (spec §3.5): content never affects the ACL state; whether a held content
// event shows is a function of the final ACL state and the content held. Also the display rules
// of redactions, pins, edits and reactions, and the history point of §3.6.

export interface ContentEv {
  id: string
  t: string
  a: string
  dev: string
  seq: number
  ap: string[]
  cprev?: string
  ts: number
  c: Record<string, unknown> | null
}

export type Hidden =
  | { why: 'fork' }
  | { why: 'revoked'; by: string }
  | { why: 'cut'; at: Rank }
  | { why: 'removed'; by: string }
  | { why: 'wipe'; by: string }
  | { why: 'redacted'; by: string }

const B0 = BigInt(0)
const B1 = BigInt(1)
const EMPTYSET = new Set<number>()
const target = (m: ContentEv) => (typeof m.c?.target === 'string' ? (m.c.target as string) : null)
const later = (x: ContentEv, y: ContentEv) => x.ts > y.ts || (x.ts === y.ts && x.id > y.id)
// A targeting event acts only in its target's channel (admission checked its own `ch`).
const sameCh = (t: ContentEv, r: ContentEv) => typeof t.c?.ch === 'string' && r.c?.ch === t.c.ch

export class ContentView {
  private fe: FastEval
  private ix: Ix
  private S: EvalResult
  private byId = new Map<string, ContentEv>()
  private byDev = new Map<string, ContentEv[]>()
  private aimed = new Map<string, ContentEv[]>()
  private marks = new Map<string, { r: number; seen: number }[]>()
  private memo = new Map<string, Hidden | null>()
  private busy = new Set<string>()
  private fcMemo = new Map<string, number>()
  private cl = new Map<string, { bits: Uint32Array; hi: number }>()
  private anchors = new Map<string, Anchor>()

  constructor(
    public acl: AclState,
    contents: Iterable<ContentEv>
  ) {
    this.S = acl.state()
    this.fe = acl.evaluation()
    this.ix = acl.ix
    for (const m of contents) {
      this.byId.set(m.id, m)
      const l = this.byDev.get(m.dev)
      if (l) l.push(m)
      else this.byDev.set(m.dev, [m])
      const t = target(m)
      if (t !== null) {
        const a = this.aimed.get(t)
        if (a) a.push(m)
        else this.aimed.set(t, [m])
      }
    }
    for (const { r, dev, seen } of this.fe.marks) {
      const l = this.marks.get(dev)
      if (l) l.push({ r, seen })
      else this.marks.set(dev, [{ r, seen }])
    }
  }

  // C(ap) as a bitset over the index, and one past its highest index.
  private closure(ap: readonly string[]) {
    const key = [...new Set(ap)].sort().join(',')
    let c = this.cl.get(key)
    if (!c) {
      const { bits } = this.ix.closure(ap)
      let hi = 0
      for (const p of ap) hi = Math.max(hi, this.ix.at.get(p)! + 1)
      this.cl.set(key, (c = { bits, hi }))
    }
    return c
  }
  private inC(m: ContentEv, x: number) {
    const { bits } = this.closure(m.ap)
    return x < bits.length * 32 && ((bits[x >>> 5] >>> (x & 31)) & 1) === 1
  }
  // t.ap ⊆ C(r.ap): r's position is at or after t's.
  private after(t: ContentEv, r: ContentEv) {
    return t.ap.every(p => {
      const i = this.ix.at.get(p)
      return i !== undefined && this.inC(r, i)
    })
  }
  stateOf(m: ContentEv): EvalResult {
    return this.acl.stateOf(m.ap)
  }
  // The authority anchor of a content event: its position C(m.ap), its admission state St(m), and
  // its authority: that of a mark (Mem and Dev), or with `typed` what a redaction or a pin of
  // another member's message relies on (rules.ts CONTENT_REDACT, CONTENT_PIN).
  private anchor(m: ContentEv, typed: boolean): Anchor {
    const key = `${typed ? 't' : 'm'}|${m.id}`
    let a = this.anchors.get(key)
    if (!a) {
      const lo = this.stateOf(m)
      const { hi } = this.closure(m.ap)
      const t = target(m)
      const tm = t === null ? undefined : this.byId.get(t)
      const e: AclEv = {
        id: m.id,
        t: !typed
          ? 'mark'
          : m.t === 'redact' && tm
            ? CONTENT_REDACT
            : m.t === 'pin'
              ? CONTENT_PIN
              : 'mark',
        a: m.a,
        dev: m.dev,
        seq: m.seq,
        ap: m.ap,
        ts: m.ts,
        c: (tm ? { to: tm.a } : {}) as AclContent,
      }
      const li = lo.idx && lo.idx.ix === this.ix ? lo.idx : undefined
      a = { e, inB: x => this.inC(m, x), hi, lo, li }
      this.anchors.set(key, a)
    }
    return a
  }

  // Fc(dev): the content-layer fork point, from the ACL fork point and the held evidence: two
  // events at one seq, two content events with one cprev, and a content event past an ACL event of
  // its device that its position does not hold.
  forkPoint(dev: string): number {
    let f = this.fcMemo.get(dev)
    if (f !== undefined) return f
    const ix = this.ix
    f = this.S.F.get(dev) ?? Infinity
    const acl = [...(ix.byDev.get(dev) ?? EMPTY)].sort((x, y) => ix.ev[x].seq - ix.ev[y].seq)
    const aclSeqs = new Set(acl.map(x => ix.ev[x].seq))
    const bySeq = new Set<number>()
    const byPrev = new Map<string, number>()
    for (const y of this.byDev.get(dev) ?? []) {
      if (aclSeqs.has(y.seq) || bySeq.has(y.seq)) f = Math.min(f, y.seq)
      bySeq.add(y.seq)
      const pk = y.cprev ?? ''
      const s2 = byPrev.get(pk)
      if (s2 !== undefined) {
        f = Math.min(f, s2, y.seq)
        byPrev.set(pk, Math.min(s2, y.seq))
      } else byPrev.set(pk, y.seq)
      for (let k = acl.length - 1; k >= 0; k--) {
        const x = acl[k]
        if (ix.ev[x].seq >= y.seq) continue
        if (this.inC(y, x)) break
        f = Math.min(f, ix.ev[x].seq)
      }
    }
    this.fcMemo.set(dev, f)
    return f
  }

  visible(m: ContentEv): boolean {
    return this.hidden(m) === null
  }

  hidden(m: ContentEv): Hidden | null {
    const memo = this.memo.get(m.id)
    if (memo !== undefined) return memo
    if (this.busy.has(m.id)) return null
    this.busy.add(m.id)
    const h = this.decide(m)
    this.busy.delete(m.id)
    this.memo.set(m.id, h)
    return h
  }

  private decide(m: ContentEv): Hidden | null {
    const ix = this.ix
    if (m.seq >= this.forkPoint(m.dev)) return { why: 'fork' }
    for (const { r, seen } of this.marks.get(m.dev) ?? [])
      if (m.seq > seen) return { why: 'revoked', by: ix.ids[r] }
    const cut = this.cascadeCut(m)
    if (cut) return { why: 'cut', at: cut }
    const removed = this.removedBy(m)
    if (removed !== null) return { why: 'removed', by: ix.ids[removed] }
    const wipe = this.wipedBy(m.a)
    if (wipe !== null) return { why: 'wipe', by: ix.ids[wipe] }
    const r = this.redactedBy(m)
    if (r) return { why: 'redacted', by: r.id }
    return null
  }

  // The step-4 rule of §3.1 applied to m after Eval: at a stratum with cuts in C(m.ap), the cuts
  // that the causes m's author is exposed to make on their own break m's authority (Mem, Dev;
  // a redaction's or pin's Manage messages is read in St(m), §3.5), which the cuts above left
  // intact, at an effective stratum below the stratum's.
  private cascadeCut(m: ContentEv): Rank | null {
    const fe = this.fe
    const ix = this.ix
    const supports = [
      ...(ix.memEv.get(m.a) ?? EMPTY),
      ...(ix.unbanEv.get(m.a) ?? EMPTY),
      ...(ix.introEv.get(m.dev) ?? EMPTY),
    ]
    if (!supports.some(x => fe.cutOrd[x] >= 0)) return null
    const an = this.anchor(m, false)
    const km = rank(an.lo.facts, m.a)
    for (const info of fe.strataInfo) {
      const s = info.s
      if (!supports.some(x => fe.cutOrd[x] === s && this.inC(m, x))) continue
      let Um = B0
      info.causes.forEach((g, i) => {
        if (info.exposed(an.e, g)) Um |= B1 << BigInt(i)
      })
      if (Um === B0) continue
      const st = fe.above(info.kk)
      if (!new Mono(ix, an, st, null, EMPTYSET).authorized()) continue
      const N = (x: number) => fe.cutOrd[x] === s && this.inC(m, x) && info.inW(x, Um)
      if (new Mono(ix, an, st, N, EMPTYSET).authorized()) continue
      const ks = minR(km, new Mono(ix, an, st, N, this.highs(m, st.high)).me())
      if (cmp(ks, info.kk) < 0) return info.kk
    }
    return null
  }

  // The effective higher denies about m's author that m did not see as effective.
  private highs(m: ContentEv, high: (x: number) => boolean): Set<number> {
    const out = new Set<number>()
    for (const d of this.fe.relevantHighs(m.a)) if (high(d) && this.frontier(m, d)) out.add(d)
    return out
  }
  // frontier(m, d): m's position did not see d as effective.
  private frontier(m: ContentEv, d: number) {
    if (!this.inC(m, d)) return true
    const lo = this.stateOf(m)
    const li = lo.idx
    return !(li && li.ix.ids[d] === this.ix.ids[d] ? li.eff(d) : lo.eff.has(this.ix.ids[d]))
  }

  // A per-member deny of m's author (kick, ban, revoke of it, its own leave) that m did not see as
  // effective, past the remover's watermark for m's device, at or above m's effective stratum, to
  // which m's author is exposed (self-denies always), and that takes away m's authority.
  private removedBy(m: ContentEv): number | null {
    const ix = this.ix
    const fe = this.fe
    const ds = fe.againstMember(m.a)
    if (!ds.length) return null
    const an = this.anchor(m, true)
    const km = rank(an.lo.facts, m.a)
    for (const d of ds) {
      const de = ix.ev[d]
      if (!this.frontier(m, d)) continue
      if (!(m.seq > seenFor(de, m.dev))) continue
      const kk = ix.k(d)
      const st = fe.above(kk)
      const ks = minR(km, new Mono(ix, an, st, null, this.highs(m, st.high)).me())
      if (cmp(ks, kk) > 0) continue
      if (
        !ix.isSelfD[d] &&
        !exposedTo(an.e, de, ix.rec[d], new CauseView(ix, d, st, null).facts(), kk)
      )
        continue
      if (!new Mono(ix, an, st, null, EMPTYSET).authorized()) continue
      if (new Mono(ix, an, st, null, new Set([d])).authorized()) continue
      return d
    }
    return null
  }

  // An effective ban of P with `wipe` that no unban lifted.
  wipedBy(P: string): number | null {
    const fe = this.fe
    const ix = this.ix
    for (const b of ix.banEv.get(P) ?? EMPTY) {
      if (!fe.inS(b) || !fe.isEffI(b) || ix.ev[b].c.wipe !== true) continue
      const kb = ix.k(b)
      const lifted = (ix.unbanEv.get(P) ?? EMPTY).some(
        u => fe.inS(u) && !fe.isVoidI(u) && ix.before(b, u) && cmp(ix.k(u), kb) >= 0
      )
      if (!lifted) return b
    }
    return null
  }

  // A visible redaction of t positioned at or after t, by t's author, an owner, or a member with
  // Manage messages ranked above t's author in the redaction's admission state.
  redactedBy(t: ContentEv): ContentEv | null {
    for (const r of this.aimed.get(t.id) ?? []) {
      if (r.t !== 'redact' || !sameCh(t, r) || !this.after(t, r) || !this.visible(r)) continue
      if (r.a === t.a || this.ix.owners.has(r.a)) return r
      const F = this.stateOf(r).facts
      if (permsQ(F, r.a) & MESSAGES && gt(rank(F, r.a), rank(F, t.a))) return r
    }
    return null
  }

  // The pin that decides whether t is pinned: the latest (ts, id) of the visible pins at or after
  // t by members with Manage messages in their admission state; t must be visible.
  pinOf(t: ContentEv): ContentEv | null {
    if (!this.visible(t)) return null
    let best: ContentEv | null = null
    for (const p of this.aimed.get(t.id) ?? []) {
      if (p.t !== 'pin' || !sameCh(t, p) || !this.after(t, p) || !this.visible(p)) continue
      if (!(permsQ(this.stateOf(p).facts, p.a) & MESSAGES)) continue
      if (!best || later(p, best)) best = p
    }
    return best
  }
  pinned(t: ContentEv): boolean {
    return this.pinOf(t)?.c?.on === true
  }

  // The edit that shows: the latest (ts, id) visible edit by t's author at or after t.
  editOf(t: ContentEv): ContentEv | null {
    let best: ContentEv | null = null
    for (const e of this.aimed.get(t.id) ?? []) {
      if (e.t !== 'edit' || e.a !== t.a || !sameCh(t, e) || !this.after(t, e) || !this.visible(e))
        continue
      if (!best || later(e, best)) best = e
    }
    return best
  }

  // The reactions on t that show: per (author, key), the latest visible one, if it is on.
  reactions(t: ContentEv): ContentEv[] {
    const best = new Map<string, ContentEv>()
    for (const r of this.aimed.get(t.id) ?? []) {
      if (r.t !== 'react' || typeof r.c?.key !== 'string' || !sameCh(t, r) || !this.visible(r))
        continue
      const k = `${r.a}\u0001${r.c.key}`
      const b = best.get(k)
      if (!b || later(r, b)) best.set(k, r)
    }
    return [...best.values()].filter(r => r.c?.on === true)
  }

  // A mention of everyone counts only if the author held Mention everyone at its position.
  mentionsEveryone(m: ContentEv): boolean {
    return m.c?.everyone === true && (permsQ(this.stateOf(m).facts, m.a) & P.MentionEveryone) !== 0
  }

  // §3.6: m belongs to X's history under `joined` if m is X's own or its position holds the live
  // join (or genesis) that starts X's current membership.
  inHistory(m: ContentEv, X: string): boolean {
    if (m.a === X) return true
    const fe = this.fe
    const ix = this.ix
    const rem = ix.remEv.get(X) ?? EMPTY
    for (const g of ix.memEv.get(X) ?? EMPTY) {
      if (!fe.inS(g) || fe.isVoidI(g)) continue
      if (!rem.every(r => !fe.inS(r) || !fe.isEffI(r) || ix.before(r, g))) continue
      if (this.inC(m, g)) return true
    }
    return false
  }

  byIdOf(id: string): ContentEv | undefined {
    return this.byId.get(id)
  }
}

// The remover's watermark of device v (§3.5): its `seen` entry; a self-deny without one covers
// its own device up to itself; otherwise -1.
export function seenFor(d: AclEv, v: string): number {
  const s = d.c.seen
  if (typeof s === 'object' && s !== null && typeof s[v] === 'number') return s[v]
  if ((d.t === 'leave' || (d.t === 'revoke' && d.c.to === d.a)) && d.dev === v) return d.seq
  return -1
}
