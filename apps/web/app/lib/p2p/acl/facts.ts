import { addS, EMPTY, firstTrue, Ix, type BitW } from './reach'
import {
  ALL,
  BOT,
  cmp,
  EVERYONE,
  gt,
  INVITE,
  NEG,
  TOP,
  type AclContent,
  type Ctx,
  type Rank,
} from './rules'

// The state of a set of ACL events (spec §1.5, §3.2): facts derived from live grants and
// effective denies. Facts are computed per key from that key's event list (keyed lazy views),
// never by a pass over the set (§5).

export interface Has<K> {
  has(k: K): boolean
}
export interface Get<K, V> {
  get(k: K): V | undefined
}
export interface RSet<K> extends Has<K>, Iterable<K> {
  readonly size: number
}
export interface RMap<K, V> extends Has<K>, Get<K, V>, Iterable<[K, V]> {
  readonly size: number
  keys(): Iterable<K>
  values(): Iterable<V>
}

export interface Pend {
  id: string
  a: string
  dev: string
  k: Rank
  code?: string
}
export interface CodeFact {
  id: string
  a: string
  dev: string
  k: Rank
}

// What authority, rank and protection read (§1.4, §1.6).
export interface FactsQ {
  owners: ReadonlySet<string>
  mem: Has<string>
  ban: Has<string>
  effBanK: Get<string, readonly Rank[]>
  invited: Get<string, readonly Pend[]>
  roles: Has<string>
  pos: Get<string, number>
  bits: Get<string, number>
  holds: Get<string, Iterable<string>>
  devs: Get<string, Has<string>>
  revoked: Has<string>
  codeIssuer: Get<string, string>
  addsTo: Get<string, readonly Pend[]>
  consumed: Has<string>
  codeOk: Has<string>
  codeDead: Has<string>
}

// The whole state (§3.2), with the registers.
export interface Facts extends FactsQ {
  upgraded: readonly string[]
  mem: RSet<string>
  ban: RSet<string>
  effBanK: RMap<string, readonly Rank[]>
  invited: RMap<string, readonly Pend[]>
  pending: RMap<string, readonly Pend[]>
  roles: RSet<string>
  pos: RMap<string, number>
  bits: RMap<string, number>
  holds: RMap<string, ReadonlySet<string>>
  devs: RMap<string, ReadonlySet<string>>
  revoked: RSet<string>
  codes: RMap<string, CodeFact>
  codeIssuer: RMap<string, string>
  profile: RMap<string, AclContent>
  setting: AclContent | undefined
  channels: RMap<string, AclContent>
  overwrites: RMap<string, ReadonlyMap<string, AclContent>>
  addsTo: RMap<string, readonly Pend[]>
  consumed: RSet<string>
  codeOk: RSet<string>
  codeDead: RSet<string>
  from: string | undefined
}

// Index predicates of a recorded state over an index numbered like the evaluator's.
export interface StIdx {
  ix: Ix
  X(i: number): boolean
  void(i: number): boolean
  eff(i: number): boolean
  ep?: { key: object; eff(i: number): boolean }
}

export interface EvalResult {
  facts: Facts
  X: RSet<string>
  tail: RSet<string>
  cut: RMap<string, Rank>
  eff: RSet<string>
  void: RSet<string>
  F: ReadonlyMap<string, number>
  FI: ReadonlyMap<string, number>
  RF: ReadonlySet<string>
  PC: ReadonlySet<string>
  idx?: StIdx
}

// FI of identity `a` in epoch `epoch` ('' = genesis epoch).
export const fiOf = (FI: ReadonlyMap<string, number>, a: string, epoch: string) =>
  FI.get(`${a}|${epoch}`) ?? Infinity

const NOBITS: ReadonlyMap<number, BitW> = new Map()

// A view: (event set E, void set, effective denies) as predicates over event indices. Every fact
// is computed from its key's event list and memoized for the view's life.
export abstract class View {
  constructor(public ix: Ix) {}
  abstract inE(x: number): boolean
  // x ∈ void (only asked for x ∈ E)
  abstract isVoid(x: number): boolean
  // x ∈ eff (only asked for x ∈ E)
  abstract isEff(x: number): boolean
  // x ∈ X of the state this view belongs to (a rotation drops only devices a non-X event introduces)
  abstract isXv(x: number): boolean
  live(x: number) {
    return this.inE(x) && !this.isVoid(x)
  }
  effIn(x: number) {
    return this.inE(x) && this.isEff(x)
  }

  private _mBan?: Map<string, boolean>
  private get mBan(): Map<string, boolean> {
    return (this._mBan ??= new Map())
  }
  private _mMem?: Map<string, boolean>
  private get mMem(): Map<string, boolean> {
    return (this._mMem ??= new Map())
  }
  private _mRole?: Map<string, boolean>
  private get mRole(): Map<string, boolean> {
    return (this._mRole ??= new Map())
  }
  private _mBits?: Map<string, number | undefined>
  private get mBits(): Map<string, number | undefined> {
    return (this._mBits ??= new Map())
  }
  private _mPos?: Map<string, number | undefined>
  private get mPos(): Map<string, number | undefined> {
    return (this._mPos ??= new Map())
  }
  private _mHolds?: Map<string, Set<string>>
  private get mHolds(): Map<string, Set<string>> {
    return (this._mHolds ??= new Map())
  }
  private _mRevC?: Map<string, boolean>
  private get mRevC(): Map<string, boolean> {
    return (this._mRevC ??= new Map())
  }
  private _mDead?: Map<string, boolean>
  private get mDead(): Map<string, boolean> {
    return (this._mDead ??= new Map())
  }
  private _mCodeOk?: Map<string, boolean>
  private get mCodeOk(): Map<string, boolean> {
    return (this._mCodeOk ??= new Map())
  }
  private _mAdds?: Map<string, Pend[]>
  private get mAdds(): Map<string, Pend[]> {
    return (this._mAdds ??= new Map())
  }
  private _mCons?: Map<number, boolean>
  private get mCons(): Map<number, boolean> {
    return (this._mCons ??= new Map())
  }
  private _mInv?: Map<string, Pend[]>
  private get mInv(): Map<string, Pend[]> {
    return (this._mInv ??= new Map())
  }
  private _mRevoked?: Map<string, boolean>
  private get mRevoked(): Map<string, boolean> {
    return (this._mRevoked ??= new Map())
  }

  ban(T: string): boolean {
    let v = this.mBan.get(T)
    if (v === undefined) {
      v = false
      const ix = this.ix
      for (const b of ix.banEv.get(T) ?? EMPTY) {
        if (!this.effIn(b)) continue
        const kb = ix.k(b)
        const lifted = (ix.unbanEv.get(T) ?? EMPTY).some(
          u => this.live(u) && ix.before(b, u) && cmp(ix.k(u), kb) >= 0
        )
        if (!lifted) {
          v = true
          break
        }
      }
      this.mBan.set(T, v)
    }
    return v
  }
  effBanK(T: string): Rank[] | undefined {
    const l = this.ix.banEv.get(T)
    if (!l) return undefined
    const out: Rank[] = []
    for (const b of l) if (this.effIn(b)) out.push(this.ix.k(b))
    return out.length ? out : undefined
  }
  mem(T: string): boolean {
    let v = this.mMem.get(T)
    if (v === undefined) {
      v = false
      if (!this.ban(T)) {
        const ix = this.ix
        const rem = ix.remEv.get(T) ?? EMPTY
        for (const g of ix.memEv.get(T) ?? EMPTY) {
          if (!this.live(g)) continue
          if (rem.every(r => !this.effIn(r) || ix.before(r, g))) {
            v = true
            break
          }
        }
      }
      this.mMem.set(T, v)
    }
    return v
  }
  role(R: string): boolean {
    let v = this.mRole.get(R)
    if (v === undefined) {
      const rc = this.ix.roleCreate.get(R)
      v =
        rc !== undefined &&
        this.live(rc) &&
        !(this.ix.roleDel.get(R) ?? EMPTY).some(d => this.effIn(d))
      this.mRole.set(R, v)
    }
    return v
  }
  // Bit(R, ·): per bit, clear-wins; defined for everyone and live roles only.
  bits(R: string): number | undefined {
    if (this.mBits.has(R)) return this.mBits.get(R)
    let v: number | undefined
    if (R === EVERYONE || this.role(R)) {
      v = 0
      for (const [b, l] of this.ix.bitW.get(R) ?? NOBITS) if (this.bit(l)) v |= b
    }
    this.mBits.set(R, v)
    return v
  }
  // Bit(R, b) from the top down over its writes (§5.4 A). Before the newest effective clear, the
  // live setters, stopping at a covering one (the bit is set); from that clear on, the maximal
  // effective clears, stopping at a covering one. The bit holds iff a collected setter has every
  // collected clear in its past.
  private bit(l: BitW): boolean {
    const ix = this.ix
    const ws = l.w
    const cov = ix.bitCov(l)
    const hi = this.hiE()
    const sets: number[] = []
    const clrs: number[] = []
    let late = false
    let res: boolean | undefined
    let stop = false
    const visit = (x: number, k: number) => {
      const e = ix.ev[x]
      if (e.t === 'role_bits' && !e.c.on) {
        if (!this.effIn(x)) return
        if (!late) {
          late = true
          if (!sets.length) {
            res = false
            stop = true
            return
          }
        }
        let dom = false
        for (const y of clrs)
          if (ix.has(y, x)) {
            dom = true
            break
          }
        if (!dom) clrs.push(x)
        if (cov[k]) stop = true
      } else if (!late && (e.t === 'genesis' || this.live(x))) {
        sets.push(x)
        if (cov[k]) {
          res = true
          stop = true
        }
      }
    }
    const a = firstTrue(0, ws.length, j => ws[j] >= hi)
    if (a < ws.length) {
      const ex: number[] = []
      for (const x of this.extraE()) if (x >= hi) ex.push(x)
      ex.sort((p, q) => q - p)
      for (const x of ex) {
        const k = firstTrue(a, ws.length, j => ws[j] >= x)
        if (k < ws.length && ws[k] === x) visit(x, k)
        if (stop) break
      }
    }
    for (let k = a - 1; k >= 0 && !stop; k--) visit(ws[k], k)
    if (!stop && a === 0 && ws.length && ws[0] === ix.genesis) visit(ws[0], 0)
    if (res !== undefined) return res
    if (!late) return sets.length > 0
    return sets.some(x => clrs.every(c => ix.has(x, c)))
  }
  // A position write of R in this view: a live create, a live G move, an effective move.
  isPosWrite(x: number, R: string): boolean {
    const e = this.ix.ev[x]
    if (!this.inE(x)) return false
    if (e.t === 'role_create') return e.id === R && !this.isVoid(x)
    return this.isEff(x) || (!this.isVoid(x) && this.ix.rec[x].cls === 'G')
  }
  // E holds no event indexed at or above hiE() other than those of extraE().
  hiE(): number {
    return this.ix.n
  }
  extraE(): Iterable<number> {
    return EMPTY
  }
  // Pos(R): the register read from the top down, stopping at the first maximal write that has
  // every lower write of R in its past.
  pos(R: string): number | undefined {
    if (this.mPos.has(R)) return this.mPos.get(R)
    const ix = this.ix
    const ws = ix.posW.get(R) ?? EMPTY
    let v: number | undefined
    if (ws.length) {
      const cov = ix.posCov(R)
      const hi = this.hiE()
      const maxes: number[] = []
      let best = -1
      const consider = (w: number) => {
        for (const m of maxes) if (ix.has(m, w)) return false
        maxes.push(w)
        if (best < 0 || this.beats(w, best)) best = w
        return true
      }
      let a = 0
      let b = ws.length
      while (a < b) {
        const m = (a + b) >> 1
        if (ws[m] < hi) a = m + 1
        else b = m
      }
      let stop = false
      if (a < ws.length) {
        const ex: number[] = []
        for (const x of this.extraE()) if (x >= hi) ex.push(x)
        if (ex.length) {
          ex.sort((p, q) => q - p)
          for (const x of ex) {
            let lo = a
            let hi2 = ws.length
            while (lo < hi2) {
              const m = (lo + hi2) >> 1
              if (ws[m] < x) lo = m + 1
              else hi2 = m
            }
            if (lo < ws.length && ws[lo] === x && this.isPosWrite(x, R) && consider(x) && cov[lo]) {
              stop = true
              break
            }
          }
        }
      }
      for (let k = a - 1; k >= 0 && !stop; k--)
        if (this.isPosWrite(ws[k], R) && consider(ws[k]) && cov[k]) stop = true
      v = best < 0 ? undefined : this.posAt(best)
    }
    this.mPos.set(R, v)
    return v
  }
  posAt(x: number): number {
    return this.ix.ev[x].c.pos
  }
  private beats(w: number, w2: number) {
    const ix = this.ix
    const c = cmp(ix.k(w), ix.k(w2))
    if (c !== 0) return c > 0
    const p = this.posAt(w)
    const p2 = this.posAt(w2)
    return p < p2 || (p === p2 && ix.ids[w] < ix.ids[w2])
  }
  // Forgets Pos(R) (a probe changed the position of its extra write).
  resetPos(R: string) {
    this.mPos.delete(R)
  }
  holds(T: string): Set<string> {
    let v = this.mHolds.get(T)
    if (v === undefined) {
      v = new Set<string>()
      if (this.mem(T)) {
        const ix = this.ix
        const rem = ix.remEv.get(T) ?? EMPTY
        for (const R of ix.everHeld.get(T) ?? []) {
          if (!this.role(R)) continue
          const key = `${T}|${R}`
          const revs = ix.revokeEv.get(key) ?? EMPTY
          for (const g of ix.assignEv.get(key) ?? EMPTY) {
            if (!this.live(g)) continue
            if (
              revs.every(r => !this.effIn(r) || ix.before(r, g)) &&
              rem.every(r => !this.effIn(r) || ix.before(r, g))
            ) {
              v.add(R)
              break
            }
          }
        }
      }
      this.mHolds.set(T, v)
    }
    return v
  }
  perms(P: string): number {
    if (this.ix.owners.has(P)) return ALL
    let m = this.bits(EVERYONE) ?? 0
    for (const R of this.holds(P)) m |= this.bits(R) ?? 0
    return m
  }
  rankOf(R: string): Rank {
    return R === EVERYONE ? BOT : [this.pos(R) ?? -1, R]
  }
  rank(P: string): Rank {
    if (this.ix.owners.has(P)) return TOP
    if (!this.mem(P)) return NEG
    let r: Rank = BOT
    for (const R of this.holds(P)) {
      const q = this.rankOf(R)
      if (gt(q, r)) r = q
    }
    return r
  }
  codeIssuer(c: string): string | undefined {
    const x = this.ix.codeEv.get(c)
    return x !== undefined && this.inE(x) ? this.ix.ev[x].a : undefined
  }
  revokedC(c: string): boolean {
    let v = this.mRevC.get(c)
    if (v === undefined) {
      v = (this.ix.codeRev.get(c) ?? EMPTY).some(r => this.effIn(r))
      this.mRevC.set(c, v)
    }
    return v
  }
  codeDead(c: string): boolean {
    let v = this.mDead.get(c)
    if (v === undefined) {
      const x = this.ix.codeEv.get(c)
      v = x !== undefined && this.live(x) && this.ix.deathList(c).some(y => this.live(y))
      this.mDead.set(c, v)
    }
    return v
  }
  codeOk(c: string): boolean {
    let v = this.mCodeOk.get(c)
    if (v === undefined) {
      const x = this.ix.codeEv.get(c)
      v = false
      if (x !== undefined && this.live(x) && !this.revokedC(c)) {
        const iss = this.ix.ev[x].a
        v = this.mem(iss) && (this.perms(iss) & INVITE) !== 0
      }
      this.mCodeOk.set(c, v)
    }
    return v
  }
  hasCode(c: string): boolean {
    return this.codeOk(c) && !this.codeDead(c)
  }
  addsTo(T: string): Pend[] {
    let v = this.mAdds.get(T)
    if (v === undefined) {
      v = []
      const ix = this.ix
      const un = ix.uninvEv.get(T) ?? EMPTY
      for (const g of ix.addEv.get(T) ?? EMPTY) {
        if (!this.live(g)) continue
        if (!un.every(u => !this.effIn(u) || ix.before(u, g))) continue
        const e = ix.ev[g]
        v.push({ id: e.id, a: e.a, dev: e.dev, k: ix.k(g), code: e.c.code })
      }
      this.mAdds.set(T, v)
    }
    return v
  }
  // Add g (to T) is consumed: it passes the uninvite filter and a live join by T has it in its past.
  consumedIdx(g: number): boolean {
    let v = this.mCons.get(g)
    if (v === undefined) {
      const ix = this.ix
      const T = ix.ev[g].c.to
      v =
        this.addsTo(T).some(p => p.id === ix.ids[g]) &&
        (ix.joinEv.get(T) ?? EMPTY).some(j => this.live(j) && ix.before(g, j))
      this.mCons.set(g, v)
    }
    return v
  }
  invited(T: string): Pend[] {
    let v = this.mInv.get(T)
    if (v === undefined) {
      v = []
      for (const p of this.addsTo(T)) {
        if (this.consumedIdx(this.ix.at.get(p.id)!)) continue
        if (p.code !== undefined && !this.hasCode(p.code)) continue
        v.push(p)
      }
      this.mInv.set(T, v)
    }
    return v
  }
  // v ∈ revoked: an effective device_revoke of v, or an effective primary_rotate that drops v.
  revoked(v: string): boolean {
    let r = this.mRevoked.get(v)
    if (r === undefined) {
      const ix = this.ix
      r = (ix.devRevEv.get(v) ?? EMPTY).some(d => this.effIn(d))
      if (!r) {
        for (const x of ix.introEv.get(v) ?? EMPTY) {
          if (!this.inE(x) || this.isXv(x)) continue
          const xa = ix.ev[x].a
          for (const rr of ix.rotBy.get(xa) ?? EMPTY) {
            if (rr === x || !this.effIn(rr) || ix.before(rr, x)) continue
            const re = ix.ev[rr]
            if (re.dev === v || (re.c.keep ?? []).includes(v)) continue
            r = true
            break
          }
          if (r) break
        }
      }
      this.mRevoked.set(v, r)
    }
    return r
  }
  devHas(a: string, v: string): boolean {
    return (
      (this.ix.introEv.get(v) ?? EMPTY).some(x => this.ix.ev[x].a === a && this.live(x)) &&
      !this.revoked(v)
    )
  }

  // The maximal live writes of a register and the winner: the most senior k(w), then the lowest id.
  register(ws: readonly number[]): { win: number; maxes: number[] } | undefined {
    const ix = this.ix
    const live = ws.filter(x => this.live(x))
    const maxes = live.filter(w => !live.some(w2 => w2 !== w && ix.before(w, w2)))
    let win = -1
    for (const w of maxes) {
      if (win < 0) {
        win = w
        continue
      }
      const c = cmp(ix.k(w), ix.k(win))
      if (c > 0 || (c === 0 && ix.ids[w] < ix.ids[win])) win = w
    }
    return win < 0 ? undefined : { win, maxes }
  }
  profileOf(T: string): AclContent | undefined {
    const r = this.register(this.ix.profileBy.get(T) ?? EMPTY)
    return r && this.ix.ev[r.win].c
  }
  setting(): AclContent | undefined {
    const r = this.register(this.ix.settingsEv)
    if (!r) return undefined
    const c = this.ix.ev[r.win].c
    return r.maxes.some(x => this.ix.ev[x].c.history === 'joined') ? { ...c, history: 'joined' } : c
  }
  channel(id: string): AclContent | undefined {
    const r = this.register(this.ix.channelEv.get(id) ?? EMPTY)
    if (!r) return undefined
    const cs = r.maxes.map(x => this.ix.ev[x].c)
    const out: AclContent = { ...this.ix.ev[r.win].c }
    for (const f of ['restrict_view', 'restrict_send', 'gone'])
      if (cs.some(c => c[f] === true)) out[f] = true
    const slow = Math.max(
      0,
      ...cs.map(c => (Number.isSafeInteger(c.slow) ? (c.slow as number) : 0))
    )
    if (slow > 0) out.slow = slow
    return out
  }
  overwrite(ch: string, subj: string): AclContent | undefined {
    const r = this.register(this.ix.chpermEv.get(`${ch}|${subj}`) ?? EMPTY)
    if (!r) return undefined
    let deny = 0
    for (const x of r.maxes) deny |= this.ix.ev[x].c.deny ?? 0
    return { ...this.ix.ev[r.win].c, deny }
  }

  private lf?: FactsQ
  // This view through the FactsQ interface (what authority, rank and protection read).
  facts(): FactsQ {
    if (this.lf) return this.lf
    const lf: FactsQ = {
      owners: this.ix.owners,
      mem: { has: T => this.mem(T) },
      ban: { has: T => this.ban(T) },
      effBanK: { get: T => this.effBanK(T) },
      invited: {
        get: T => {
          const l = this.invited(T)
          return l.length ? l : undefined
        },
      },
      roles: { has: R => this.role(R) },
      pos: { get: R => this.pos(R) },
      bits: { get: R => this.bits(R) },
      holds: {
        get: T => {
          const s = this.holds(T)
          return s.size ? s : undefined
        },
      },
      devs: { get: a => ({ has: v => this.devHas(a, v) }) },
      revoked: { has: v => this.revoked(v) },
      codeIssuer: { get: c => this.codeIssuer(c) },
      addsTo: {
        get: T => {
          const l = this.addsTo(T)
          return l.length ? l : undefined
        },
      },
      consumed: {
        has: g => {
          const i = this.ix.at.get(g)
          return i !== undefined && this.consumedIdx(i)
        },
      },
      codeOk: { has: c => this.codeOk(c) },
      codeDead: { has: c => this.codeDead(c) },
    }
    return (this.lf = lf)
  }
}

// The whole state of a view as a Facts object, key by key.
export function fullFacts(V: View): Facts {
  const ix = V.ix
  const mem = new Set<string>()
  const ban = new Set<string>()
  const effBanK = new Map<string, Rank[]>()
  for (const T of ix.memEv.keys()) if (V.mem(T)) mem.add(T)
  for (const T of ix.banEv.keys()) {
    if (V.ban(T)) ban.add(T)
    const ks = V.effBanK(T)
    if (ks) effBanK.set(T, ks)
  }
  const roles = new Set<string>()
  for (const R of ix.roleCreate.keys()) if (V.role(R)) roles.add(R)
  const pos = new Map<string, number>()
  for (const R of ix.posW.keys()) {
    const p = V.pos(R)
    if (p !== undefined) pos.set(R, p)
  }
  const bits = new Map<string, number>()
  bits.set(EVERYONE, V.bits(EVERYONE) ?? 0)
  for (const R of roles) bits.set(R, V.bits(R) ?? 0)
  const holds = new Map<string, Set<string>>()
  for (const T of ix.everHeld.keys()) {
    const h = V.holds(T)
    if (h.size) holds.set(T, new Set(h))
  }
  const revoked = new Set<string>()
  for (const v of new Set([...ix.devRevEv.keys(), ...ix.introEv.keys()]))
    if (V.revoked(v)) revoked.add(v)
  const devs = new Map<string, Set<string>>()
  for (const [v, xs] of ix.introEv) {
    if (revoked.has(v)) continue
    for (const x of xs) if (V.live(x)) addS(devs, ix.ev[x].a, v)
  }
  const codes = new Map<string, CodeFact>()
  const codeIssuer = new Map<string, string>()
  const codeOk = new Set<string>()
  const codeDead = new Set<string>()
  for (const [c, x] of ix.codeEv) {
    if (!V.inE(x)) continue
    codeIssuer.set(c, ix.ev[x].a)
    if (V.codeDead(c)) codeDead.add(c)
    if (V.codeOk(c)) {
      codeOk.add(c)
      if (!V.codeDead(c)) codes.set(c, { id: c, a: ix.ev[x].a, dev: ix.ev[x].dev, k: ix.k(x) })
    }
  }
  const invited = new Map<string, Pend[]>()
  const pending = new Map<string, Pend[]>()
  const addsTo = new Map<string, Pend[]>()
  const consumed = new Set<string>()
  for (const T of ix.addEv.keys()) {
    const at = V.addsTo(T)
    if (at.length) addsTo.set(T, at)
    for (const p of at) if (V.consumedIdx(ix.at.get(p.id)!)) consumed.add(p.id)
    const inv = V.invited(T)
    if (!inv.length) continue
    invited.set(T, inv)
    if (!mem.has(T) && !ban.has(T)) pending.set(T, inv)
  }
  const profile = new Map<string, AclContent>()
  for (const T of ix.profileBy.keys()) {
    const p = V.profileOf(T)
    if (p) profile.set(T, p)
  }
  const channels = new Map<string, AclContent>()
  for (const id of ix.channelEv.keys()) {
    const ch = V.channel(id)
    if (ch) channels.set(id, ch)
  }
  const overwrites = new Map<string, Map<string, AclContent>>()
  for (const [key, xs] of ix.chpermEv) {
    const { ch, subj } = ix.ev[xs[0]].c
    const o = V.overwrite(ch ?? '', subj ?? '')
    if (!o) continue
    let m = overwrites.get(ch ?? '')
    if (!m) overwrites.set(ch ?? '', (m = new Map()))
    m.set(subj ?? key, o)
  }
  return {
    owners: new Set(ix.owners),
    upgraded: ix.upgradeEv.filter(x => V.inE(x)).map(x => ix.ids[x]),
    mem,
    ban,
    effBanK,
    invited,
    pending,
    roles,
    pos,
    bits,
    holds,
    devs,
    revoked,
    codes,
    codeIssuer,
    profile,
    setting: V.setting(),
    channels,
    overwrites,
    addsTo,
    consumed,
    codeOk,
    codeDead,
    from: fromOf(ix),
  }
}

export const fromOf = (ix: Ix): string | undefined =>
  ix.genesis < 0 ? undefined : ix.ev[ix.genesis].c.from?.srv

// A view over explicit sets of ids.
class SetView extends View {
  constructor(
    ix: Ix,
    public voidS: Has<string>,
    public effS: Has<string>,
    public XS: Has<string>
  ) {
    super(ix)
  }
  inE() {
    return true
  }
  isVoid(x: number) {
    return this.voidS.has(this.ix.ids[x])
  }
  isEff(x: number) {
    return this.effS.has(this.ix.ids[x])
  }
  isXv(x: number) {
    return this.XS.has(this.ix.ids[x])
  }
}

// facts(E, void, eff) of §3.2 for a causally closed set E (the model's `facts`).
export function facts(
  E: Iterable<string>,
  voidS: Has<string>,
  eff: Has<string>,
  cx: Ctx,
  X: Has<string> = new Set<string>()
): Facts {
  return fullFacts(new SetView(Ix.of(E, cx), voidS, eff, X))
}

const EMPTY_FACTS: Facts = {
  owners: new Set(),
  upgraded: [],
  mem: new Set(),
  ban: new Set(),
  effBanK: new Map(),
  invited: new Map(),
  pending: new Map(),
  roles: new Set(),
  pos: new Map(),
  bits: new Map(),
  holds: new Map(),
  devs: new Map(),
  revoked: new Set(),
  codes: new Map(),
  codeIssuer: new Map(),
  profile: new Map(),
  setting: undefined,
  channels: new Map(),
  overwrites: new Map(),
  addsTo: new Map(),
  consumed: new Set(),
  codeOk: new Set(),
  codeDead: new Set(),
  from: undefined,
}

// The admission state of a genesis: the empty set.
export const emptyResult = (): EvalResult => ({
  facts: EMPTY_FACTS,
  X: new Set(),
  tail: new Set(),
  cut: new Map(),
  eff: new Set(),
  void: new Set(),
  F: new Map(),
  FI: new Map(),
  RF: new Set(),
  PC: new Set(),
})
