import { expect, test } from 'bun:test'
import { emptyResult, View } from '../p2p/acl/facts'
import { Ix } from '../p2p/acl/reach'
import {
  BOT,
  cmp,
  EVERYONE,
  type AclContent,
  type AclEv,
  type Rank,
  type Rec,
} from '../p2p/acl/rules'

// Bit(R, b) and Pos(R) read per chain (spec §5.4 A) against their definitions (§3.2, §1.5): the
// bit is set iff a live setter has every effective clear of it in its past; the position is the
// best of the maximal counted writes. Random DAGs of concurrent toggles and moves (a single chain,
// a DAG over three devices, two lanes that never see each other, two lanes that sometimes do),
// read through views like the evaluator's: a downset of the index plus extra writes anywhere, half
// of them with the downset part's bound (hiE) just above it.

class Rng {
  constructor(public s: number) {}
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
  chance(p: number) {
    return this.next() < p
  }
}

class TestView extends View {
  constructor(
    ix: Ix,
    private D: Set<number>,
    private V: Set<number>,
    private Ef: Set<number>,
    private ex: Set<number>,
    private hi: number
  ) {
    super(ix)
  }
  hiE() {
    return this.hi
  }
  inE(x: number) {
    return this.D.has(x) || this.ex.has(x)
  }
  inD(x: number) {
    return this.D.has(x)
  }
  isVoid(x: number) {
    return this.V.has(x)
  }
  isEff(x: number) {
    return this.Ef.has(x)
  }
  isXv() {
    return false
  }
  extraE() {
    return this.ex
  }
}

const BITS = [1, 2, 4]
const RANKS: Rank[] = [BOT, [1, 'r1'], [2, 'r2']]
type Mode = 'chain' | 'dag' | 'lanes' | 'meet'

function universe(rng: Rng, mode: Mode) {
  const evs: AclEv[] = []
  const recs = new Map<string, Rec>()
  const tip = new Map<string, string>()
  const push = (
    t: string,
    dev: string,
    c: Record<string, unknown>,
    cls: Rec['cls'],
    ap: string[]
  ) => {
    const id = `${t}.${evs.length}`
    evs.push({
      id,
      t,
      a: dev.replace(/[0-9]+$/, ''),
      dev,
      seq: evs.length,
      ap,
      ts: 0,
      c: c as AclContent,
    })
    recs.set(id, {
      k: RANKS[rng.int(RANKS.length)],
      cls,
      self: false,
      exempt: false,
      depth: -1,
      epoch: '',
      local: emptyResult(),
    })
    tip.set(dev, id)
    return id
  }
  const mask = () => BITS.reduce((m, b) => (rng.chance(0.5) ? m | b : m), 0)
  const g = push(
    'genesis',
    'O1',
    { rules: 2, nonce: 'n', owners: [{ ik: 'O' }], everyone_bits: mask() },
    'G',
    []
  )
  const R = push('role_create', 'O1', { pos: 1, bits: mask() }, 'G', [g])
  const devs = mode === 'chain' ? ['O1'] : mode === 'dag' ? ['O1', 'P1', 'Q1'] : ['A1', 'B1']
  const n = 10 + rng.int(40)
  for (let i = 0; i < n; i++) {
    const dev = devs[rng.int(devs.length)]
    const ap = [tip.get(dev) ?? R]
    if (mode === 'dag' && evs.length > 2)
      for (let k = rng.int(3); k > 0; k--) ap.push(evs[rng.int(evs.length)].id)
    if (mode === 'meet' && rng.chance(0.1)) ap.push(tip.get(dev === 'A1' ? 'B1' : 'A1') ?? R)
    if (rng.chance(0.3)) {
      push('role_move', dev, { role: R, pos: 1 + rng.int(5) }, rng.chance(0.5) ? 'G' : 'D', [
        ...new Set(ap),
      ])
      continue
    }
    const on = rng.chance(0.5)
    const role = rng.chance(0.8) ? R : EVERYONE
    push('role_bits', dev, { role, bit: BITS[rng.int(BITS.length)], on }, on ? 'G' : 'D', [
      ...new Set(ap),
    ])
  }
  const byId = new Map(evs.map(e => [e.id, e]))
  const ix = Ix.of(
    evs.map(e => e.id),
    { ev: id => byId.get(id)!, rec: id => recs.get(id)! }
  )
  return { ix, R }
}

function bitDef(v: View, ix: Ix, R: string, b: number) {
  const sets: number[] = []
  const clrs: number[] = []
  for (let i = 0; i < ix.n; i++) {
    const e = ix.ev[i]
    if (e.t === 'genesis' && R === EVERYONE && (e.c.everyone_bits ?? 0) & b) sets.push(i)
    if (e.t === 'role_create' && e.id === R && e.c.bits & b && v.live(i)) sets.push(i)
    if (e.t !== 'role_bits' || e.c.role !== R || e.c.bit !== b) continue
    if (e.c.on ? v.live(i) : v.effIn(i)) (e.c.on ? sets : clrs).push(i)
  }
  return sets.some(s => clrs.every(c => ix.has(s, c)))
}

function posDef(v: View, ix: Ix, R: string) {
  const ws = (ix.posW.get(R) ?? []).filter(x => v.isPosWrite(x, R))
  const max = ws.filter(x => !ws.some(y => y !== x && ix.has(y, x)))
  let best = -1
  for (const w of max) {
    if (best < 0) {
      best = w
      continue
    }
    const c = cmp(ix.k(w), ix.k(best))
    const p = ix.ev[w].c.pos
    const pb = ix.ev[best].c.pos
    if (c > 0 || (c === 0 && (p < pb || (p === pb && ix.ids[w] < ix.ids[best])))) best = w
  }
  return best < 0 ? undefined : ix.ev[best].c.pos
}

test('Bit(R, b) and Pos(R) read per chain equal their definitions on random DAGs, two toggle lanes and views', () => {
  const rng = new Rng(20261103)
  let set = 0
  let checked = 0
  let pos = 0
  const modes: Mode[] = ['chain', 'dag', 'lanes', 'meet']
  for (let u = 0; u < 400; u++) {
    const mode = modes[u % 4]
    const { ix, R } = universe(rng, mode)
    for (let k = 0; k < 25; k++) {
      const hi = rng.chance(0.3) ? ix.n : rng.int(ix.n + 1)
      const D = new Set<number>()
      if (rng.chance(0.3)) for (let i = 0; i < hi; i++) D.add(i)
      else
        for (let t = rng.int(4); t >= 0 && hi > 0; t--) {
          const x = rng.int(hi)
          D.add(x)
          for (let y = 0; y < x; y++) if (ix.has(x, y)) D.add(y)
        }
      const pick = (p: number, not?: Set<number>) => {
        const s = new Set<number>()
        for (let i = 0; i < ix.n; i++) if (!not?.has(i) && rng.chance(p)) s.add(i)
        return s
      }
      // half the views bound their downset part as OpView does (extras on both sides of the bound)
      const bound = rng.chance(0.5) ? Math.max(-1, ...D) + 1 : ix.n
      const v = new TestView(ix, D, pick(0.15), pick(0.7), pick(0.1, D), bound)
      for (const role of [R, EVERYONE]) {
        const defined = role === EVERYONE || v.live(ix.at.get(R)!)
        let want: number | undefined
        if (defined) {
          want = 0
          for (const b of BITS) if (bitDef(v, ix, role, b)) want |= b
          if (want) set++
        }
        if (v.bits(role) !== want)
          expect({ universe: u, mode, view: k, role, bits: v.bits(role) }).toEqual({
            universe: u,
            mode,
            view: k,
            role,
            bits: want,
          })
        checked++
      }
      const p = posDef(v, ix, R)
      if (p !== undefined) pos++
      if (v.pos(R) !== p)
        expect({ universe: u, mode, view: k, pos: v.pos(R) }).toEqual({
          universe: u,
          mode,
          view: k,
          pos: p,
        })
    }
  }
  expect(checked).toBe(20000)
  expect(set).toBeGreaterThan(2000)
  expect(pos).toBeGreaterThan(5000)
})
