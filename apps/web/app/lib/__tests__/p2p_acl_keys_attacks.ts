import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Rng } from './acl_model_r8f/gen'
import { crDigest, KICK, recDigest, type Ev } from './acl_model_r8f/model'
import { World } from './acl_model_r8f/world'
import { protection } from '../p2p/acl/keys'
import { wireOf, worldDiff } from './p2p_acl_r3'

// Run by p2p_acl_keys.test.ts in a process of its own (`bun test ./p2p_acl_keys_attacks.ts`):
// test files share their modules, and the model's vector files check every world built in their
// process. Here: the saved seed of the r8e C2 verifier, and the r8e attack review's C1 (a stolen
// device of a later epoch undoes an earlier transfer) with its verifier's scripts, on the model's
// worlds, against production's `acl/keys.ts`.

const HERE = fileURLToPath(new URL('.', import.meta.url))

test('fixture r8e-o15oracle-seed93100183: production equals the model and the oracle', () => {
  const fx = JSON.parse(
    readFileSync(`${HERE}acl_model_r8f/fixtures/r8e-o15oracle-seed93100183.json`, 'utf8')
  ) as { format: number; events: Ev[] }
  expect(fx.format).toBe(3)
  const w = new World()
  for (const e of fx.events) {
    w.all.push(e)
    w.ref.receive(e)
  }
  expect(w.ref.order.length).toBeGreaterThan(20)
  expect(worldDiff(w, true)).toEqual([])
  const P = protection(w.ref.order, wireOf(w.ref).ctx())
  expect([...P.ids.values()].map(k => k.st)).toContain('frozen')
})

// ----- r8e attack C1: a stolen device of a later epoch undoes an earlier transfer -----

let T = 0
const t = () => (T += 4)
const maxSeq = (w: World, ap: string[], dev: string) => {
  let m = -1
  for (const id of w.closure(ap)) {
    const e = w.ref.ev(id)
    if (e.dev === dev) m = Math.max(m, e.seq)
  }
  return m
}
const seenOf = (w: World, ap: string[], ds: string[]) =>
  Object.fromEntries(ds.map(d => [d, maxSeq(w, ap, d)]))
const seenIn = (w: World, ap: string[], ds: string[]) =>
  Object.fromEntries(Object.entries(seenOf(w, ap, ds)).filter(([, m]) => m >= 0))
const LIMITS = { devCap: 4, poolU: 60 }

// The transfer `u` counts in production's reading of the world as it stands, and production
// equals the model there.
const stands = (w: World, u: string) => {
  expect(worldDiff(w, true)).toEqual([])
  const P = protection(w.ref.order, wireOf(w.ref).ctx())
  expect(P.inertUpgrades.has(u)).toBe(false)
  expect(P.inert.has(u)).toBe(false)
  expect(w.state().facts.upgraded).toContain(u)
}
const honestHeads = (w: World, thief: string[]) =>
  w.heads(w.ref.order.filter(id => !thief.some(x => x === id || w.ref.anc(id).has(x))))

describe('r8e attack C1: a stolen later-epoch device undoes no transfer', () => {
  for (const posting of [true, false])
    for (const resp of ['none', 'atu', 'heads'])
      test(`r8e attack C1: an extension before the transfer (c1-epoch-ext-undo), the user's posting ${posting ? 'there' : 'missing'}, its next recovery ${resp}`, () => {
        T = 0
        const w = new World()
        w.genesis('O1', ['O'], 0, 0, {
          rules: 3,
          limits: LIMITS,
          rks: { O: { rk: 'rkO', pk: 'pO0' } },
        })
        w.ok('O2', 'device_add', { by: 'pO0' }, { ts: t() })
        for (const m of ['B', 'C']) {
          w.ok('O1', 'add', { to: m }, { ts: t() })
          w.ok(`${m}1`, 'join', {}, { ts: t() })
        }
        w.ok('B1', 'mark', {}, { ts: t() })
        const P0 = w.heads()
        const u = w.ok('O1', 'upgrade', { g: 'G1', sigs: { O: { by: 'pO0' } } }, { ts: t() })
        w.ok('B1', 'leave', {}, { ts: t() })
        const rec1 = {
          n: 1,
          prev: crDigest('O', 'rkO', 'pO0'),
          by: 'rkO',
          pk: 'pO1',
          keep: ['O1', 'O3'],
        }
        if (posting)
          w.act(
            'O1',
            'primary_rotate',
            { by: 'rkO', chain: [rec1], keep: [], seen: seenOf(w, w.heads(), ['O2']) },
            { ts: t() }
          )
        stands(w, u.id)
        const ext = w.act(
          'O3',
          'primary_rotate',
          { by: 'pO1', chain: [rec1], keep: ['O1'], seen: seenOf(w, P0, ['O2']) },
          { ap: P0, ts: t() }
        )
        expect(ext.v.s).toBe('A')
        stands(w, u.id)
        const rc = w.act('O3', 'role_create', { pos: 5, bits: KICK }, { ts: t() })
        const kc = w.act('O3', 'kick', { to: 'C', seen: seenOf(w, w.heads(), ['C1']) }, { ts: t() })
        const u2 = w.act('O3', 'upgrade', { g: 'Gt', sigs: { O: { by: 'pO1' } } }, { ts: t() })
        stands(w, u.id)
        if (resp === 'none') return
        const thief = [ext.e.id, rc.e.id, kc.e.id, u2.e.id]
        const ap = resp === 'atu' ? honestHeads(w, thief) : w.heads()
        const rec2 = { n: 2, prev: recDigest(rec1), by: 'rkO', pk: 'pO2', keep: ['O1', 'O4'] }
        w.act(
          'O4',
          'primary_rotate',
          { by: 'rkO', chain: [rec1, rec2], keep: ['O1'], seen: seenOf(w, ap, ['O2', 'O3']) },
          { ap, ts: t() }
        )
        stands(w, u.id)
      })

  for (const v of ['min', 'dadd', 'dadd-keep', 'conflict'])
    test(`r8e attack C1 (verifier v1, ${v}): the device_add path of the transfer's author device`, () => {
      T = 0
      const w = new World()
      w.genesis('O1', ['O'], 0, 0, {
        rules: 3,
        limits: LIMITS,
        rks: { O: { rk: 'rkO', pk: 'pO0' } },
      })
      const Pg = w.heads()
      w.ok('O2', 'device_add', { by: 'pO0' }, { ts: t() })
      for (const m of ['B', 'C']) {
        w.ok('O1', 'add', { to: m }, { ts: t() })
        w.ok(`${m}1`, 'join', {}, { ts: t() })
      }
      w.ok('B1', 'mark', {}, { ts: t() })
      const P0 = w.heads()
      const author = v.startsWith('dadd') ? 'O2' : 'O1'
      const u = w.ok(author, 'upgrade', { g: 'G1', sigs: { O: { by: 'pO0' } } }, { ts: t() })
      const rec1 = {
        n: 1,
        prev: crDigest('O', 'rkO', 'pO0'),
        by: 'rkO',
        pk: 'pO1',
        keep: ['O1', 'O2', 'O3'],
      }
      w.act(
        'O1',
        'primary_rotate',
        { by: 'rkO', chain: [rec1], keep: ['O2'], seen: {} },
        { ts: t() }
      )
      stands(w, u.id)
      const pos = v.startsWith('dadd') ? Pg : P0
      const keep = v === 'dadd-keep' ? ['O1', 'O2'] : ['O1']
      const ext = w.act(
        'O3',
        'primary_rotate',
        { by: 'pO1', chain: [rec1], keep, seen: seenOf(w, pos, ['O2']) },
        { ap: pos, ts: t() }
      )
      expect(ext.v.s).toBe(v === 'dadd-keep' ? 'R' : 'A')
      stands(w, u.id)
      const sigs = { O: { by: 'pO1' } }
      if (v === 'conflict') w.act('O3', 'upgrade', { g: 'Gt', sigs }, { ap: [ext.e.id], ts: t() })
      else {
        w.act('O3', 'role_create', { pos: 5, bits: KICK }, { ts: t() })
        w.act('O3', 'kick', { to: 'C', seen: seenOf(w, w.heads(), ['C1']) }, { ts: t() })
        w.act('O3', 'upgrade', { g: 'Gt', sigs }, { ts: t() })
      }
      stands(w, u.id)
    })

  for (const v of ['heads', 'before-u2', 'atu'])
    test(`r8e attack C1 (verifier v2, ${v}): the user's next recovery after the thief's own transfer`, () => {
      T = 0
      const w = new World()
      w.genesis('O1', ['O'], 0, 0, {
        rules: 3,
        limits: LIMITS,
        rks: { O: { rk: 'rkO', pk: 'pO0' } },
      })
      for (const m of ['B', 'C']) {
        w.ok('O1', 'add', { to: m }, { ts: t() })
        w.ok(`${m}1`, 'join', {}, { ts: t() })
      }
      w.ok('B1', 'mark', {}, { ts: t() })
      const P0 = w.heads()
      const u = w.ok('O1', 'upgrade', { g: 'G1', sigs: { O: { by: 'pO0' } } }, { ts: t() })
      const rec1 = {
        n: 1,
        prev: crDigest('O', 'rkO', 'pO0'),
        by: 'rkO',
        pk: 'pO1',
        keep: ['O1', 'O3'],
      }
      w.ok('O1', 'primary_rotate', { by: 'rkO', chain: [rec1], keep: [], seen: {} }, { ts: t() })
      const ext = w.ok(
        'O3',
        'primary_rotate',
        { by: 'pO1', chain: [rec1], keep: ['O1'], seen: {} },
        { ap: P0, ts: t() }
      )
      const kc = w.act('O3', 'kick', { to: 'C', seen: seenIn(w, w.heads(), ['C1']) }, { ts: t() })
      const u2 = w.act('O3', 'upgrade', { g: 'Gt', sigs: { O: { by: 'pO1' } } }, { ts: t() })
      stands(w, u.id)
      const under = (id: string, x: string) => id === x || w.ref.anc(id).has(x)
      const ap =
        v === 'heads'
          ? w.heads()
          : v === 'before-u2'
            ? w.heads(w.ref.order.filter(id => !under(id, u2.e.id) && !under(id, kc.e.id)))
            : honestHeads(w, [ext.id, kc.e.id, u2.e.id])
      const rec2 = { n: 2, prev: recDigest(rec1), by: 'rkO', pk: 'pO2', keep: ['O1', 'O4'] }
      w.act(
        'O4',
        'primary_rotate',
        {
          by: 'rkO',
          chain: w.closure(ap).has(ext.id) ? [rec2] : [rec1, rec2],
          keep: ['O1'],
          seen: seenIn(w, ap, ['O3']),
        },
        { ap, ts: t() }
      )
      stands(w, u.id)
      w.act('O1', 'upgrade', { g: 'G1', sigs: { O: { by: 'pO2' } } }, { ts: t() })
      stands(w, u.id)
    })

  // The reviewer's shape fuzz (c1-fuzz) and the verifier's widening of it (vfuzz).
  const shape = (s: number, wide: boolean): { w: World; u: string } | undefined => {
    const rng = new Rng(Math.imul(s, 2654435761) >>> 0 || 1)
    for (let i = 0; i < 4; i++) rng.next()
    const co = rng.chance(0.4)
    const posted = rng.chance(0.7)
    const isReset = rng.chance(0.4)
    const leftFirst = !wide && co && rng.chance(0.3)
    const fromX2 = wide && !co && rng.chance(0.5)
    const conflict = wide && rng.chance(0.3)
    const respond = wide && rng.chance(0.5)
    T = 0
    const w = new World()
    w.genesis(co ? 'A1' : 'X1', co ? ['A', 'X'] : ['X'], 0, 0, {
      rules: 3,
      limits: LIMITS,
      rks: { X: { rk: 'rkX', pk: 'pX0' } },
    })
    if (co) w.ok('X1', 'join', { rk: 'rkX', pk: 'pX0', by: 'pX0' }, { ts: t() })
    const positions: string[][] = [w.heads()]
    w.ok('X2', 'device_add', { by: 'pX0' }, { ts: t() })
    const mod = co ? 'A1' : 'X1'
    for (const m of ['B', 'C']) {
      w.ok(mod, 'add', { to: m }, { ts: t() })
      w.ok(`${m}1`, 'join', {}, { ts: t() })
    }
    if (wide) positions.push(w.heads())
    else positions[0] = w.heads()
    for (let i = rng.int(3); i > 0; i--) {
      w.ok(rng.pick(['B1', 'C1', 'X1']), 'mark', {}, { ts: t() })
      positions.push(w.heads())
    }
    if (leftFirst) {
      w.ok('X1', 'leave', {}, { ts: t() })
      positions.push(w.heads())
    }
    const sigs: Record<string, unknown> = { X: { by: 'pX0' } }
    if (co) sigs.A = 'ik'
    const u = w.act(co ? 'A1' : fromX2 ? 'X2' : 'X1', 'upgrade', { g: 'G1', sigs }, { ts: t() })
    if (u.v.s !== 'A') return undefined
    if (rng.chance(0.5)) w.act('B1', 'leave', {}, { ts: t() })
    const keepRec = wide ? ['X1', 'X2', 'X3'] : ['X1', 'X3']
    const base = { n: 1, prev: crDigest('X', 'rkX', 'pX0'), by: 'rkX', pk: 'pXr', keep: keepRec }
    const rec = isReset ? { ...base, rk: 'rkX2' } : base
    const k1 = isReset ? 'rkX2' : 'rkX'
    if (posted)
      w.act(
        'X1',
        'primary_rotate',
        wide
          ? { by: k1, chain: [rec], keep: ['X2'], seen: {} }
          : {
              by: rng.chance(0.5) ? k1 : 'pXr',
              chain: [rec],
              keep: [],
              seen: seenOf(w, w.heads(), ['X2']),
            },
        { ts: t() }
      )
    const P = rng.pick(positions)
    const ext = w.act(
      'X3',
      'primary_rotate',
      {
        by: 'pXr',
        chain: [rec],
        keep: ['X1'],
        seen: wide ? seenIn(w, P, ['X2']) : seenOf(w, P, ['X2']),
      },
      { ap: P, ts: t() }
    )
    if (wide && ext.v.s !== 'A') return undefined
    const thief = [ext.e.id]
    const own = { g: 'Gt', sigs: { X: { by: 'pXr' } } }
    if (conflict) {
      if (!co) thief.push(w.act('X3', 'upgrade', own, { ap: [ext.e.id], ts: t() }).e.id)
    } else {
      if (leftFirst && !w.state().facts.upgraded.includes(u.e.id))
        thief.push(w.act('X3', 'join', {}, { ts: t() }).e.id)
      thief.push(w.act('X3', 'role_create', { pos: 5, bits: KICK }, { ts: t() }).e.id)
      const seen = wide ? seenIn(w, w.heads(), ['C1']) : seenOf(w, w.heads(), ['C1'])
      thief.push(w.act('X3', 'kick', { to: 'C', seen }, { ts: t() }).e.id)
      if (!co) thief.push(w.act('X3', 'upgrade', own, { ts: t() }).e.id)
    }
    if (rng.chance(0.5)) w.act('B1', 'mark', {}, { ts: t() })
    if (respond) {
      const ap = honestHeads(w, thief)
      const rec2 = { n: 2, prev: recDigest(rec), by: k1, pk: 'pX2r', keep: ['X1', 'X4'] }
      w.act(
        'X4',
        'primary_rotate',
        { by: k1, chain: [rec, rec2], keep: ['X1'], seen: seenIn(w, ap, ['X2', 'X3']) },
        { ap, ts: t() }
      )
    }
    return { w, u: u.e.id }
  }

  for (const wide of [false, true])
    test(`r8e attack C1: 0 transfers undone in 500 shapes (${wide ? "the verifier's vfuzz" : "the reviewer's c1-fuzz"})`, () => {
      let shapes = 0
      const undone: number[] = []
      const differ: string[] = []
      for (let s = 1; shapes < 500; s++) {
        const x = shape(s, wide)
        if (!x) continue
        shapes += 1
        const P = protection(x.w.ref.order, wireOf(x.w.ref).ctx())
        if (P.inert.has(x.u) || P.inertUpgrades.has(x.u)) undone.push(s)
        for (const d of worldDiff(x.w)) if (differ.length < 5) differ.push(`shape ${s}: ${d}`)
      }
      expect(undone).toEqual([])
      expect(differ).toEqual([])
    }, 600_000)
})
