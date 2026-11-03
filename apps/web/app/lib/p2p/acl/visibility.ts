import type { ProofHeader } from './admit'
import type { AclState } from './cache'
import { CauseView, Mono, type Anchor, type FastEval } from './eval'
import type { EvalResult } from './facts'
import { EMPTY, type Ix } from './reach'
import { uncontested, witnessed } from './storage'
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

// An evidence pair against one device, across both layers (§2.3 E1, E2, E3), with the fork point
// it gives (`f`), as a proof carries it.
export interface Evidence {
  f: number
  x: ProofHeader
  y: ProofHeader
}

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
  private byAuthor = new Map<string, ContentEv[]>()
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
    for (const m of contents) this.index(m)
    this.indexMarks()
  }

  private index(m: ContentEv) {
    this.byId.set(m.id, m)
    const l = this.byDev.get(m.dev)
    if (l) l.push(m)
    else this.byDev.set(m.dev, [m])
    const la = this.byAuthor.get(m.a)
    if (la) la.push(m)
    else this.byAuthor.set(m.a, [m])
    const t = target(m)
    if (t !== null) {
      const a = this.aimed.get(t)
      if (a) a.push(m)
      else this.aimed.set(t, [m])
    }
  }

  private indexMarks() {
    this.marks.clear()
    for (const { r, dev, seen } of this.fe.marks) {
      const l = this.marks.get(dev)
      if (l) l.push({ r, seen })
      else this.marks.set(dev, [{ r, seen }])
    }
  }

  // The ACL state changed: what follows from it is worked out again; the content stays indexed.
  rebase() {
    this.S = this.acl.state()
    this.fe = this.acl.evaluation()
    this.memo.clear()
    this.fcMemo.clear()
    this.aclM.clear()
    this.anchors.clear()
    this.hideMemo.clear()
    this.indexMarks()
  }

  // A content event held from now on. What its arrival can change is forgotten: the fork point of
  // its device (and so its device's events), and its target's visibility up the target chain.
  add(m: ContentEv) {
    if (this.byId.has(m.id)) return
    const before = this.fcMemo.get(m.dev)
    this.index(m)
    this.fcMemo.delete(m.dev)
    const up = (id: string | null) => {
      const seen = new Set<string>()
      while (id !== null && !seen.has(id)) {
        seen.add(id)
        this.memo.delete(id)
        const x = this.byId.get(id)
        id = x ? target(x) : null
      }
    }
    if (before !== undefined && this.forkPoint(m.dev) !== before)
      for (const y of this.byDev.get(m.dev) ?? []) up(y.id)
    up(target(m))
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
    return this.acl.contentStateOf(m.ap)
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
    f = this.S.F.get(dev) ?? Infinity
    const acl = this.aclOf(dev)
    const aclSeqs = new Set(acl.map(x => x.e.seq))
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
        if (x.e.seq >= y.seq) continue
        if (x.i >= 0 && this.inC(y, x.i)) break
        f = Math.min(f, x.e.seq)
      }
    }
    this.fcMemo.set(dev, f)
    return f
  }

  // The ACL events of a device as evidence, by seq: those of S (`i`), and the headers of dropped
  // ones outside the index (i = -1; no held position has one in its past).
  private aclM = new Map<string, { i: number; id: string; e: AclEv }[]>()
  private aclOf(dev: string) {
    let l = this.aclM.get(dev)
    if (l) return l
    const ix = this.ix
    const H = this.acl.headers()
    l = (ix.byDev.get(dev) ?? EMPTY)
      .filter(i => this.fe.inS(i))
      .map(i => ({ i, id: ix.ids[i], e: ix.ev[i] }))
    for (const k of H?.byDev.get(dev) ?? EMPTY) {
      const e = H!.list[k].ev
      l.push({ i: -1, id: e.id, e })
    }
    l.sort((x, y) => x.e.seq - y.e.seq)
    this.aclM.set(dev, l)
    return l
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

  // ----- Storage (§2.3, §4.2, §4.3) -----

  // Why m goes from storage with its header (§4.2): at or past its device's fork point, or past
  // the watermark of a revocation of its device in force.
  dropKind(m: ContentEv): 'fork' | 'revoked' | null {
    if (m.seq >= this.forkPoint(m.dev)) return 'fork'
    for (const { seen } of this.marks.get(m.dev) ?? []) if (m.seq > seen) return 'revoked'
    return null
  }

  // The held evidence pair against `dev` with the lowest fork point (ties: the lowest ids), from
  // its ACL events and its content: two events at one seq, two ACL events with one aprev, two
  // content events with one cprev, and a content event past an ACL event of the device that its
  // position does not hold (the lowest such above the highest it holds).
  evidence(dev: string): Evidence | null {
    let best: Evidence | null = null
    const take = (f: number, a: ProofHeader, b: ProofHeader) => {
      const [x, y] = a.id < b.id ? [a, b] : [b, a]
      if (
        !best ||
        f < best.f ||
        (f === best.f && (x.id < best.x.id || (x.id === best.x.id && y.id < best.y.id)))
      )
        best = { f, x, y }
    }
    const acl = this.aclOf(dev)
    const aclH = (x: { id: string; e: AclEv }): ProofHeader => {
      const h: ProofHeader = { id: x.id, dev, seq: x.e.seq, L: 'a', ap: x.e.ap }
      if (x.e.aprev !== undefined) h.aprev = x.e.aprev
      return h
    }
    const bySeq = new Map<number, ProofHeader>()
    const byPrev = new Map<string, ProofHeader>()
    for (const x of acl) {
      const h = aclH(x)
      const s = bySeq.get(h.seq)
      if (s) take(h.seq, s, h)
      else bySeq.set(h.seq, h)
      const k = h.aprev ?? ''
      const p = byPrev.get(k)
      if (p) take(Math.min(p.seq, h.seq), p, h)
      else byPrev.set(k, h)
    }
    const cSeq = new Map<number, ProofHeader>()
    const cPrev = new Map<string, ProofHeader>()
    for (const m of this.byDev.get(dev) ?? []) {
      const h: ProofHeader = { id: m.id, dev, seq: m.seq, L: 'c', ap: m.ap }
      if (m.cprev !== undefined) h.cprev = m.cprev
      const a = bySeq.get(m.seq)
      if (a) take(m.seq, a, h)
      const s = cSeq.get(m.seq)
      if (s) take(m.seq, s, h)
      else cSeq.set(m.seq, h)
      const k = m.cprev ?? ''
      const p = cPrev.get(k)
      if (p) take(Math.min(p.seq, m.seq), p, h)
      else cPrev.set(k, h)
      let low = -1
      for (let j = acl.length - 1; j >= 0; j--) {
        const x = acl[j]
        if (x.e.seq >= m.seq) continue
        if (x.i >= 0 && this.inC(m, x.i)) break
        low = j
      }
      if (low >= 0) take(acl[low].e.seq, aclH(acl[low]), h)
    }
    return best
  }

  // The content of the evidence pair that defines Fc(dev) below the ACL fork point: kept with its
  // header when the rest past Fc goes (§4.2).
  fcPair(dev: string): Set<string> {
    const out = new Set<string>()
    const ev = this.evidence(dev)
    if (!ev || !(ev.f < (this.S.F.get(dev) ?? Infinity))) return out
    for (const h of [ev.x, ev.y]) if (h.L === 'c') out.add(h.id)
    return out
  }

  // A visible redaction of t by t's own author, positioned at or after t, whatever else hides t
  // (self-redactions purge at once, §4.3).
  selfRedacted(t: ContentEv): boolean {
    return (this.aimed.get(t.id) ?? []).some(
      r => r.t === 'redact' && r.a === t.a && sameCh(t, r) && this.after(t, r) && this.visible(r)
    )
  }

  // Content that a removal, a ban that hides everything, a cut or a redaction may hide: by an
  // author with an effective removal, a wiping ban or a cut support, or targeted by a redaction.
  private hideMemo = new Map<string, boolean>()
  mayHide(m: ContentEv): boolean {
    if (this.aimed.get(m.id)?.some(r => r.t === 'redact')) return true
    const key = `${m.a}\u0001${m.dev}`
    let h = this.hideMemo.get(key)
    if (h === undefined) {
      const fe = this.fe
      const ix = this.ix
      h = fe.againstMember(m.a).length > 0 || this.wipedBy(m.a) !== null
      for (const l of [ix.memEv.get(m.a), ix.unbanEv.get(m.a), ix.introEv.get(m.dev)])
        for (const x of l ?? EMPTY) if (fe.cutOrd[x] >= 0) h = true
      this.hideMemo.set(key, h)
    }
    return h
  }

  // The held content `mayHide` picks, to look at for purges.
  hideable(): ContentEv[] {
    const out: ContentEv[] = []
    for (const m of this.byId.values()) if (this.mayHide(m)) out.push(m)
    return out
  }

  // S2 and S3 of a moderator's redaction r of t (§4.3): ACL events of others than r's and t's
  // authors that hold r acknowledge it (controller ruling: an ACL event holds content only by
  // naming it, `ack`, and must have r's whole position in its past), and no more senior deny
  // concurrent with that position takes away its authority.
  stableRedaction(r: ContentEv, t: ContentEv): boolean {
    if (!this.redactionWitnessed(r, t)) return false
    const ps = this.positionOf(r)!
    const after = (i: number) => ps.every(p => this.ix.has(i, p))
    const k = rank(this.stateOf(r).facts, r.a)
    return uncontested(this.fe, this.anchor(r, true), k, i => !this.inC(r, i) && !after(i))
  }

  // S2 of a moderator's redaction r of t alone.
  redactionWitnessed(r: ContentEv, t: ContentEv): boolean {
    const ix = this.ix
    const ps = this.positionOf(r)
    if (!ps) return false
    const holds = (i: number) => {
      const ack = ix.ev[i].c.ack
      return Array.isArray(ack) && ack.includes(r.id) && ps.every(p => ix.has(i, p))
    }
    return witnessed(this.fe, Math.max(...ps) + 1, holds, [r.a, t.a])
  }

  private positionOf(m: ContentEv): number[] | null {
    const ps: number[] = []
    for (const p of m.ap) {
      const i = this.ix.at.get(p)
      if (i === undefined) return null
      ps.push(i)
    }
    return ps
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
