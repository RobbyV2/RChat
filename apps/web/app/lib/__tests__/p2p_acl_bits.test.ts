import { expect, test } from 'bun:test'
import { emptyResult, View } from '../p2p/acl/facts'
import { Ix } from '../p2p/acl/reach'
import { BOT, EVERYONE, type AclContent, type AclEv, type Rec } from '../p2p/acl/rules'

// Bit(R, b) read from the top down over its writes (spec §5.4 A) against its definition (§3.2):
// the bit is set iff a live setter has every effective clear of it in its past. Random DAGs of
// concurrent toggles, read through random views with a bound and extra writes above it.

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
    private hi: number,
    private E: Set<number>,
    private V: Set<number>,
    private D: Set<number>,
    private ex: Set<number>
  ) {
    super(ix)
  }
  inE(x: number) {
    return (x < this.hi && this.E.has(x)) || this.ex.has(x)
  }
  isVoid(x: number) {
    return this.V.has(x)
  }
  isEff(x: number) {
    return this.D.has(x)
  }
  isXv() {
    return false
  }
  hiE() {
    return this.hi
  }
  extraE() {
    return this.ex
  }
}

const BITS = [1, 2, 4]

function universe(rng: Rng) {
  const evs: AclEv[] = []
  const recs = new Map<string, Rec>()
  const chain = rng.chance(0.5)
  const push = (t: string, c: Record<string, unknown>, cls: Rec['cls']) => {
    const ap: string[] = []
    if (evs.length) {
      ap.push(evs[chain ? evs.length - 1 : rng.int(evs.length)].id)
      const extra = chain ? (rng.chance(0.15) ? 1 : 0) : rng.int(3)
      for (let k = 0; k < extra; k++) ap.push(evs[rng.int(evs.length)].id)
    }
    const id = `${t}.${evs.length}`
    evs.push({ id, t, a: 'O', dev: 'O1', seq: evs.length, ap, ts: 0, c: c as AclContent })
    recs.set(id, {
      k: BOT,
      cls,
      self: false,
      exempt: false,
      depth: -1,
      epoch: '',
      local: emptyResult(),
    })
    return id
  }
  const mask = () => BITS.reduce((m, b) => (rng.chance(0.5) ? m | b : m), 0)
  push('genesis', { rules: 2, nonce: 'n', owners: [{ ik: 'O' }], everyone_bits: mask() }, 'G')
  const R = push('role_create', { pos: 1, bits: mask() }, 'G')
  const n = 10 + rng.int(40)
  for (let i = 0; i < n; i++) {
    const on = rng.chance(0.5)
    const role = rng.chance(0.8) ? R : EVERYONE
    push('role_bits', { role, bit: BITS[rng.int(BITS.length)], on }, on ? 'G' : 'D')
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

test('Bit(R, b) from the top down equals its definition on random DAGs and views', () => {
  const rng = new Rng(20261102)
  let set = 0
  let checked = 0
  for (let u = 0; u < 400; u++) {
    const { ix, R } = universe(rng)
    for (let k = 0; k < 25; k++) {
      const hi = rng.chance(0.4) ? ix.n : rng.int(ix.n + 1)
      const pick = (lo: number, hi2: number, p: number) => {
        const s = new Set<number>()
        for (let i = lo; i < hi2; i++) if (rng.chance(p)) s.add(i)
        return s
      }
      const v = new TestView(
        ix,
        hi,
        pick(0, hi, 0.9),
        pick(0, ix.n, 0.15),
        pick(0, ix.n, 0.7),
        pick(hi, ix.n, 0.2)
      )
      for (const role of [R, EVERYONE]) {
        const defined = role === EVERYONE || v.live(ix.at.get(R)!)
        let want: number | undefined
        if (defined) {
          want = 0
          for (const b of BITS) if (bitDef(v, ix, role, b)) want |= b
          if (want) set++
        }
        expect(v.bits(role)).toBe(want)
        checked++
      }
    }
  }
  expect(checked).toBe(20000)
  expect(set).toBeGreaterThan(2000)
})
