/* eslint-disable */
// @ts-nocheck
// Part of the P2P ACL reference model, used only by tests.
import { setDefaultTimeout } from 'bun:test'
setDefaultTimeout(120_000)
// Vectors of rules 3: per-server limits, the second head-path case, the
// recovery key from creation (ik never stored, the void rule, chains in servers) and
// owner-signed checkpoints. Each world built here also runs the exact G5 oracle
// and O13-fast (vectors-hook.ts).
import { describe, expect, test } from 'bun:test'
import { World } from './world'
import * as Model from './model'
import {
  BAN,
  INVITE,
  KICK,
  ROLES,
  Replica,
  evaluate,
  evalSummary,
  withLim,
  LIM_RANGE,
  limitsOf,
  type Ev,
  crDigest,
  recDigest,
  resolveProtection,
} from './model'
import type { RkMeta } from './gen'
import { oracleAfterEach } from './vectors-hook'
import { checkCase, protectionOracle, orphanDrops } from './props'
import { FastState } from './fast'
import {
  Adopted,
  checkTransfer,
  conflicting,
  makeTransfer,
  recordOf,
  signCp,
  verify,
} from './checkpoint'

oracleAfterEach()
const LIM: any = Model.LIM
const props = (w: World, equivocation = true) =>
  checkCase({ w, equivocation, seed: 1, adversarial: [] }).map(x => `${x.prop}: ${x.detail}`)

let T = 0
const t = () => (T += 4)
/** a server with owner O (devices O1, O2), bystander Vch, member V (devices V1, V2), members B and T */
function world(extra: Record<string, unknown> = { rules: 3 }) {
  T = 0
  const w = new World()
  w.genesis('O1', ['O'], 0, 0, extra)
  w.ok('O2', 'device_add', {}, { ts: t() })
  for (const m of ['Vch', 'V', 'B', 'T']) {
    w.ok('O1', 'add', { to: m }, { ts: t() })
    w.ok(`${m}1`, 'join', {}, { ts: t() })
  }
  w.ok('V2', 'device_add', {}, { ts: t() })
  w.ok('O1', 'mark', {}, { ts: t() }) // acknowledges the members' joins and V2
  return w
}
const maxSeq = (w: World, ap: string[], dev: string) => {
  let m = -1
  for (const id of w.closure(ap)) {
    const e = w.ref.ev(id)
    if (e.dev === dev) m = Math.max(m, e.seq)
  }
  return m
}
const BD = (w: World, a = 'V') => w.state().BD?.get(a)

describe('per-server limits', () => {
  const roles = (w: World, n: number) => {
    let ok = 0
    for (let i = 0; i < n; i++)
      if (w.act('O1', 'role_create', { pos: i, bits: 0 }, { ts: t() }).v.s === 'A') ok++
    return ok
  }
  test('rules 3 fixes the limits in the genesis; rules 2 means the defaults and leaves a `limits` field unread', () => {
    const w3 = world({ rules: 3, limits: { roles: 2 } })
    expect(roles(w3, 4)).toBe(2)
    const w2 = world({ rules: 2, limits: { roles: 2 } })
    expect(roles(w2, 4)).toBe(4)
    expect(w2.ref.lim).toBeUndefined()
    expect(props(w3, false)).toEqual([])
    expect(props(w2, false)).toEqual([])
  })
  test('a value outside its range or an unknown key refuses the genesis; win and day are fixed; names of Object.prototype members are unknown keys, and a null limits refuses', () => {
    // keys built as on the wire (JSON.parse makes `__proto__` an own key)
    for (const k of [
      'toString',
      'constructor',
      '__proto__',
      'valueOf',
      'hasOwnProperty',
      'isPrototypeOf',
    ]) {
      const L = JSON.parse(`{"roles": 5, "${k}": 1}`)
      expect(Object.hasOwn(L, k)).toBe(true)
      expect(limitsOf({ rules: 3, limits: L }).bad).toBe('limits')
    }
    expect(limitsOf({ rules: 3, limits: null }).bad).toBe('limits')
    expect(limitsOf({ rules: 3 }).bad).toBeUndefined()
    const r0 = new Replica()
    r0.receive({
      id: 'g0',
      t: 'genesis',
      a: 'O',
      dev: 'O1',
      seq: 0,
      ap: [],
      ts: 0,
      c: { owners: ['O'], everyone: 0, rules: 3, limits: JSON.parse('{"__proto__": 1}') },
    })
    expect(r0.status.get('g0')).toEqual({ s: 'R', why: 'genesis' })
    for (const [k, [lo, hi]] of Object.entries(LIM_RANGE)) {
      expect(limitsOf({ rules: 3, limits: { [k]: hi + 1 } }).bad).toBeDefined()
      expect(limitsOf({ rules: 3, limits: { [k]: lo - 1 } }).bad).toBeDefined()
      expect(
        limitsOf({ rules: 3, limits: { [k]: lo } }).bad === undefined ||
          ['w3mod', 'codesPerDevServer', 'poolU'].includes(k)
      ).toBe(true)
    }
    expect(limitsOf({ rules: 3, limits: { roles: 5, future_knob: 99 } }).bad).toBe('limits')
    expect(limitsOf({ rules: 3, limits: { roles: 5, win: 1, day: 1 } }).bad).toBe('limits')
    expect(limitsOf({ rules: 3, limits: { roles: 5 } }).lim).toMatchObject({
      roles: 5,
      win: LIM.win,
      day: LIM.day,
    })
    expect([
      limitsOf({ rules: 3, limits: { classes: 1 } }).bad,
      limitsOf({ rules: 3, limits: { ap: 9 } }).bad,
    ]).toEqual(['limits.classes', 'limits.ap'])
    expect(limitsOf({ rules: 3, limits: { w3: 8, w3mod: 4 } }).bad).toBe('limits')
    // the pool holds every live device's full unacknowledged budget: poolU ≥ devCap × totU
    expect(limitsOf({ rules: 3, limits: { poolU: 10 } }).bad).toBe('limits')
    expect(limitsOf({ rules: 3, limits: { poolU: 10, totU: 5 } }).bad).toBeUndefined()
    expect(limitsOf({ rules: 3, limits: { devCap: 4, totU: 12, poolU: 40 } }).bad).toBe('limits')
    const r = new Replica()
    r.receive({
      id: 'g0',
      t: 'genesis',
      a: 'O',
      dev: 'O1',
      seq: 0,
      ap: [],
      ts: 0,
      c: { owners: ['O'], everyone: 0, rules: 3, limits: { roles: 13 } },
    })
    expect(r.status.get('g0')).toEqual({ s: 'R', why: 'genesis' })
  })
  test('one process evaluates servers with different limits side by side', () => {
    const a = world({ rules: 3, limits: { roles: 2 } }),
      b = world({ rules: 3 })
    let na = 0,
      nb = 0
    for (let i = 0; i < 4; i++) {
      if (a.act('O1', 'role_create', { pos: i, bits: 0 }, { ts: t() }).v.s === 'A') na++
      if (b.act('O1', 'role_create', { pos: i, bits: 0 }, { ts: t() }).v.s === 'A') nb++
    }
    expect([na, nb]).toEqual([2, 4])
    expect(LIM.roles).toBe(Model.LIM_BASE.roles) // nothing leaks into the ambient limits
  })
  test("totU and poolU at their minimums: a lone member's backlog stops at the server's totU (W3(b)), never earlier by W3(g)", () => {
    const run = (limits: Record<string, number>) => {
      const w = world({ rules: 3, limits })
      let n = 0,
        last = ''
      for (let i = 0; i < 30; i++) {
        const r = w.act('B1', 'mark', {}, { ts: t() })
        if (r.v.s !== 'A') {
          last = (r.v as any).why
          break
        }
        n++
      }
      return [n, last]
    }
    // B's join was acknowledged by the owner's mark, so it posts exactly totU unacknowledged marks
    expect(run({ poolU: 10, totU: 4 })).toEqual([4, 'W3b'])
    expect(run({})).toEqual([LIM.totU, 'W3b'])
  })
  test('classes at its edges (the default and 4) keep a one-class stratum exact (the pclass shape)', () => {
    for (const [cap, fb] of [
      [2, 0],
      [4, 0],
    ] as const) {
      // vectors.test.ts "pclass": four juniors' kicks c1..c4 each cut one assign; P, promoted after c1..c3 and
      // concurrently with c4, has the one exposure set {c1, c2, c3} on Γ⁺: one protection class
      const w = new World()
      w.genesis('O1', ['O'], 0, 0, { rules: 3, limits: { classes: cap } })
      w.ok('O1', 'add', { to: 'Vch' })
      w.ok('Vch1', 'join')
      const role = (pos: number, bits: number) => w.ok('O1', 'role_create', { pos, bits }).id
      const join = (d: string) => {
        w.ok('O1', 'add', { to: d.replace(/[0-9]+$/, '') })
        return w.ok(d, 'join')
      }
      const QR = role(3, KICK | BAN),
        AR = role(2, ROLES),
        R1 = role(1, ROLES),
        R3 = role(0, INVITE),
        HR = role(5, 0)
      for (const d of [
        'Q1',
        'R1',
        'S1',
        'T1',
        'A1',
        'Z1',
        'Y1',
        'W1',
        'X1',
        'P1',
        'K1',
        'L1',
        'M1',
      ])
        join(d)
      w.ok('P2', 'device_add')
      for (const m of ['Q', 'R', 'S', 'T']) w.ok('O1', 'assign', { to: m, role: QR })
      for (const m of ['A', 'Z', 'Y', 'W']) w.ok('O1', 'assign', { to: m, role: AR })
      const P0 = w.heads()
      const g1 = w.ok('A1', 'assign', { to: 'X', role: R1 }, { ap: P0 })
      w.ok('Z1', 'assign', { to: 'K', role: R3 }, { ap: P0 })
      w.ok('Y1', 'assign', { to: 'L', role: R3 }, { ap: P0 })
      const wv = w.ok('W1', 'assign', { to: 'M', role: R3 }, { ap: P0 })
      const x = w.ok('X1', 'assign', { to: 'P', role: R3 }, { ap: [g1.id, wv.id] })
      const p = w.ok('P1', 'add', { to: 'N' }, { ap: [x.id] })
      const cs = (['Q1', 'R1', 'S1', 'T1'] as const).map((d, i) =>
        w.ok(d, 'kick', { to: ['A', 'Z', 'Y', 'W'][i] }, { ap: P0 })
      )
      w.ok('O1', 'assign', { to: 'P', role: HR }, { ap: [p.id, cs[0].id, cs[1].id, cs[2].id] })
      Model.stats.maxClasses = 0
      Model.stats.fallbacks = 0
      const S = withLim(w.ref.lim, () => evaluate(w.ref.order, w.ref))
      expect([Model.stats.maxClasses, Model.stats.fallbacks]).toEqual([1, fb])
      expect(S.cut.has(g1.id) && S.cut.has(x.id)).toBe(true)
      expect(props(w, false)).toEqual([])
    }
  })
  test('an older client shows a rules-3 server read-only and never a state; a rules-2 server it evaluates alike', () => {
    for (const rules of [2, 3]) {
      const w = world({ rules })
      w.ok('B1', 'mark', {}, { ts: t() })
      const old = new Replica({ rules: [2] })
      for (const e of [...w.all].reverse()) old.receive(e)
      if (rules === 3) {
        expect(old.order.length).toBe(0)
        expect(w.all.every(e => old.status.get(e.id)?.s === 'U')).toBe(true)
      } else expect(evalSummary(old.state())).toBe(evalSummary(w.state()))
    }
  })
})

describe('the second head-path case (concurrent non-causes)', () => {
  const replay = (w: World) => {
    const fs = new FastState(w.ref)
    for (const id of w.ref.order) {
      fs.append(id)
      fs.state()
    }
    expect(evalSummary(fs.state())).toBe(evalSummary(w.state()))
    return fs.stats
  }
  test('marks and a profile from partial views take the second case and equal the re-run', () => {
    const w = world({ rules: 2 })
    const P = w.heads()
    w.ok('B1', 'mark', {}, { ap: P, ts: t() })
    w.ok('T1', 'profile', { name: 1 }, { ap: P, ts: t() })
    w.ok('Vch1', 'mark', {}, { ap: P, ts: t() })
    const st = replay(w)
    expect(st.conc).toBeGreaterThanOrEqual(2)
  })
  test("a concurrent deny, or a concurrent event of the arrival's own identity, forces the re-run", () => {
    const w = world({ rules: 2 })
    const P = w.heads()
    w.ok('O1', 'kick', { to: 'T' }, { ap: P, ts: t() })
    w.ok('B1', 'mark', {}, { ap: P, ts: t() }) // concurrent with the kick
    const a = replay(w)
    expect(a.conc).toBe(0)
    const w2 = world({ rules: 2 })
    const Q = w2.heads()
    w2.ok('V1', 'mark', {}, { ap: Q, ts: t() })
    w2.ok('V2', 'mark', {}, { ap: Q, ts: t() }) // concurrent with V's other device
    expect(replay(w2).conc).toBe(0)
  })
})

describe('the recovery key from creation (ik never stored, the void rule, chains in servers)', () => {
  // V joins with its creation record (rkV; its epoch-0 primary p0, a fresh key: `ik` signed the record and was erased).
  // A thief that steals V2 holds V2's device key and p0, never `ik`.
  const crV = crDigest('V', 'rkV', 'p0')
  const R1 = (keep: string[] = ['V1'], pk = 'pV1', by = 'rkV') => ({
    n: 1,
    prev: crV,
    by,
    pk,
    keep,
  })
  const pworld = (rules = 3, head?: string, roomy = false, everyone = 0) => {
    T = 0
    const w = new World()
    w.genesis(
      'O1',
      ['O'],
      everyone,
      0,
      rules === 3 ? { rules: 3, ...(roomy ? { limits: { devCap: 4, poolU: 60 } } : {}) } : {}
    )
    w.ok('O2', 'device_add', {}, { ts: t() })
    for (const m of ['Vch', 'B', 'T']) {
      w.ok('O1', 'add', { to: m }, { ts: t() })
      w.ok(`${m}1`, 'join', {}, { ts: t() })
    }
    w.ok('O1', 'add', head ? { to: 'V', head } : { to: 'V' }, { ts: t() })
    w.ok('V1', 'join', { rk: 'rkV' }, { ts: t() })
    w.ok('V2', 'device_add', {}, { ts: t() })
    w.ok('O1', 'mark', {}, { ts: t() })
    return w
  }
  /** V's recovery (chain record 1: pV1, keep the recovering device) posted in this server, signed by rkV */
  const recover = (
    w: World,
    dev: string,
    ap: string[],
    drop: string[],
    o: Record<string, unknown> = {}
  ) =>
    w.ok(
      dev,
      'primary_rotate',
      {
        by: 'rkV',
        chain: [R1([dev])],
        keep: [],
        seen: Object.fromEntries(drop.map(v => [v, maxSeq(w, ap, v)])),
        ...o,
      },
      { ap, ts: t() }
    )
  /** a fresh rules-3 server with members Vch and B, and an add for `to` */
  const fresh = (to = 'V', add: Record<string, unknown> = {}, roomy = true, everyone = 0) => {
    T = 0
    const w = new World()
    w.genesis('O1', ['O'], everyone, 0, {
      rules: 3,
      ...(roomy ? { limits: { devCap: 4, poolU: 60 } } : {}),
    })
    for (const m of ['Vch', 'B']) {
      w.ok('O1', 'add', { to: m }, { ts: t() })
      w.ok(`${m}1`, 'join', {}, { ts: t() })
    }
    const a = w.ok('O1', 'add', { to, ...add }, { ts: t() })
    return { w, a }
  }
  const inert = (w: World) => resolveProtection(w.ref.order, w.ref).inert
  const propsRk = (w: World, rkCase: RkMeta) =>
    checkCase({ w, equivocation: true, seed: 1, adversarial: [], rkCase }).map(
      x => `${x.prop}: ${x.detail}`
    )

  test("a protected identity rotates only with its recovery key: its primary p0 can't rotate, and ik is never needed", () => {
    const w = pworld()
    expect(
      w.act('V1', 'primary_rotate', { by: 'p0', keep: ['V2'], seen: {} }, { ts: t() }).v
    ).toEqual({ s: 'R', why: 'sig' })
    expect(
      w.act(
        'V1',
        'primary_rotate',
        { by: 'rkZ', chain: [R1(['V1'])], keep: ['V2'], seen: {} },
        { ts: t() }
      ).v
    ).toEqual({ s: 'R', why: 'sig' })
    const r = w.ok(
      'V1',
      'primary_rotate',
      { by: 'rkV', chain: [R1(['V1', 'V2'])], keep: ['V2'], seen: {} },
      { ts: t() }
    )
    expect(BD(w)).toMatchObject({ st: 'protected', rec: ['rkV'], prim: ['pV1'], won: 'rkV|p0' })
    expect(w.state().X.has(r.id)).toBe(false)
    // the honest default signer of a certificate is the head's primary
    w.ok('B1', 'mark', {}, { ts: t() })
    expect(props(w)).toEqual([])
  })
  test("an unprotected identity can't become protected in place: a chain or a rotation's own rk is refused, and so is a creation record after a plain introduction", () => {
    const w = world()
    expect(
      w.act(
        'B1',
        'primary_rotate',
        {
          pcert: 'pB',
          chain: [{ n: 1, prev: crDigest('B', 'rkB', 'p0'), by: 'rkB', pk: 'pB', keep: [] }],
          keep: [],
          seen: {},
        },
        { ts: t() }
      ).v
    ).toEqual({ s: 'R', why: 'rk' })
    expect(
      w.act('B1', 'primary_rotate', { rk: 'rkB', pcert: 'pB', keep: [], seen: {} }, { ts: t() }).v
    ).toEqual({ s: 'R', why: 'rk' })
    w.ok('B1', 'leave', {}, { ts: t() })
    w.ok('O1', 'add', { to: 'B' }, { ts: t() })
    expect(w.act('B8', 'join', { rk: 'rkB' }, { ts: t() }).v).toEqual({ s: 'R', why: 'rk' })
    // a creation record names a fresh primary, never ik
    const { w: w2 } = fresh('N')
    expect(w2.act('N1', 'join', { rk: 'rkN', pk: 'ik' }, { ts: t() }).v).toEqual({
      s: 'R',
      why: 'rk',
    })
  })
  test('reset and removal are chain records signed by the key in force, each with a new primary; after a removal its primary plays recovery', () => {
    const w = pworld()
    const reset = { n: 1, prev: crV, by: 'rkV', rk: 'rkV2', pk: 'pV2', keep: ['V1', 'V2'] }
    expect(
      w.act(
        'V1',
        'primary_rotate',
        { by: 'rkV2', chain: [{ ...reset, by: 'rkZ' }], keep: ['V2'], seen: {} },
        { ts: t() }
      ).v
    ).toEqual({ s: 'R', why: 'rk' })
    w.ok(
      'V1',
      'primary_rotate',
      { by: 'rkV2', chain: [reset], keep: ['V2'], seen: {} },
      { ts: t() }
    )
    expect(BD(w)).toMatchObject({ rec: ['rkV2'], prim: ['pV2'] })
    const d1 = recDigest(reset)
    expect(
      w.act(
        'V1',
        'primary_rotate',
        {
          by: 'pV3',
          chain: [{ n: 2, prev: d1, by: 'rkV', rk: '', pk: 'pV3', keep: ['V1', 'V2'] }],
          keep: ['V2'],
          seen: {},
        },
        { ts: t() }
      ).v
    ).toEqual({ s: 'R', why: 'rk' })
    w.ok('B1', 'mark', {}, { ts: t() })
    const rem = { n: 2, prev: d1, by: 'rkV2', rk: '', pk: 'pV3', keep: ['V1', 'V2'] }
    w.ok('V1', 'primary_rotate', { by: 'pV3', chain: [rem], keep: ['V2'], seen: {} }, { ts: t() })
    expect(BD(w)).toMatchObject({ rec: ['pV3'], prim: ['pV3'] })
    w.ok('B1', 'mark', {}, { ts: t() })
    w.ok(
      'V1',
      'primary_rotate',
      {
        by: 'pV3',
        chain: [{ n: 3, prev: recDigest(rem), by: 'pV3', pk: 'pV4', keep: ['V1', 'V2'] }],
        keep: ['V2'],
        seen: {},
      },
      { ts: t() }
    )
    expect(BD(w)).toMatchObject({ rec: ['pV3'], prim: ['pV4'] })
    expect(props(w)).toEqual([])
  })
  test('void rule: a record signed by ik voids the creation record, so the identity is unprotected under the rules-2 signers (a protected identity never signs with ik)', () => {
    const w = pworld(3, undefined, true)
    const d = w.ok('V6', 'device_add', { by: 'ik' }, { ts: t() }) // only a holder of ik can sign it: never a protected identity
    const S = w.state()
    expect(BD(w)).toMatchObject({ st: 'unprotected', rec: ['ik'], void: 'ik' })
    const j = w.ref.order.find(id => w.ref.ev(id).t === 'join' && w.ref.ev(id).a === 'V')!
    expect([S.X.has(d.id), S.X.has(j), inert(w).has(j), S.facts.mem.has('V')]).toEqual([
      false,
      true,
      true,
      false,
    ])
    expect(props(w)).toEqual([])
  })
  test("a thief holding a legacy identity's ik can't mint protection: its creation record is void beside the user's ik-signed records, here and in a server it reached first", () => {
    const w = world()
    const g = w.ref.order.find(id => w.ref.ev(id).t === 'add' && w.ref.ev(id).c.to === 'B')!
    const jZ = w.ok('B9', 'join', { rk: 'rkZ', pk: 'pZ', by: 'pZ' }, { ap: [g], ts: t() }) // admitted: its position knows no introduction of B
    const rZ = w.ok(
      'B8',
      'primary_rotate',
      { by: 'rkZ', keep: ['B9'], seen: {} },
      { ap: [jZ.id], ts: t() }
    )
    w.ok('O1', 'mark', {}, { ts: t() })
    let S = w.state()
    expect(BD(w, 'B')).toMatchObject({ st: 'unprotected', void: 'ik' })
    expect([
      S.X.has(jZ.id),
      S.X.has(rZ.id),
      S.facts.devs.get('B')?.has('B9') ?? false,
      S.facts.devs.get('B')?.has('B8') ?? false,
    ]).toEqual([true, true, false, false])
    expect(
      w.act('B1', 'primary_rotate', { by: 'ik', pcert: 'pB', keep: [], seen: {} }, { ts: t() }).v.s
    ).toBe('A')
    expect(props(w)).toEqual([])
    // a server the thief reaches first: protected by rkZ until B's own ik-signed rotation (B is a member through the
    // thief's join) voids it
    const { w: w2, a } = fresh('L')
    const jT = w2.ok('L9', 'join', { rk: 'rkZ', pk: 'pZ', by: 'pZ' }, { ap: [a.id], ts: t() })
    expect(BD(w2, 'L')).toMatchObject({ st: 'protected', rec: ['rkZ'] })
    const rB = w2.ok(
      'L5',
      'primary_rotate',
      { by: 'ik', pcert: 'pL', keep: [], seen: { L9: maxSeq(w2, w2.heads(), 'L9') } },
      { ts: t() }
    )
    S = w2.state()
    expect(BD(w2, 'L')).toMatchObject({ st: 'unprotected', void: 'ik' })
    expect([S.X.has(rB.id), S.X.has(jT.id), [...(S.facts.devs.get('L') ?? [])]]).toEqual([
      false,
      true,
      ['L5'],
    ])
    expect(props(w2)).toEqual([])
  })
  test("epoch death: after the recovery the stolen primary's backdated revocation and certificate are inert (with the device's events), its later certificate is refused, and the stolen device's events are in Tail", () => {
    const w = pworld(3, undefined, true)
    const P0 = w.heads()
    const r = recover(w, 'V1', w.heads(), ['V2'])
    w.ok('B1', 'mark', {}, { ts: t() })
    const rv = w.ok(
      'V2',
      'device_revoke',
      { by: 'p0', dev: 'V1', seen: maxSeq(w, P0, 'V1') },
      { ap: P0, ts: t() }
    )
    const m = w.ok('V2', 'mark', {}, { ap: [rv.id], ts: t() })
    const dAdd = w.ok('V3', 'device_add', { by: 'p0' }, { ap: P0, ts: t() }) // concurrent with the recovery
    const m3 = w.ok('V3', 'mark', {}, { ap: [dAdd.id], ts: t() })
    expect(w.act('V4', 'device_add', { by: 'p0' }, { ap: [r.id], ts: t() }).v).toEqual({
      s: 'R',
      why: 'sig',
    })
    const S = w.state()
    expect([
      S.X.has(rv.id),
      S.tail.has(m.id) || S.X.has(m.id),
      S.X.has(dAdd.id),
      S.X.has(m3.id),
    ]).toEqual([true, true, true, true])
    expect([
      S.facts.revoked.has('V1'),
      S.facts.devs.get('V')?.has('V3') ?? false,
      S.facts.revoked.has('V2'),
    ]).toEqual([false, false, true])
    // an identity with a creation record keeps its events stored unless they are past their device's fork point
    // (mutant rk-drop): the inert certificate and its device's mark stay
    const drops = orphanDrops(w.ref.order, S, w.ref)
    expect([drops.has(dAdd.id), drops.has(m3.id)]).toEqual([false, false])
    expect(
      propsRk(w, {
        kind: 'thief',
        x: 'V',
        V1: 'V1',
        V2: 'V2',
        r: r.id,
        rDrops: ['V2'],
        thief: [rv.id, m.id, dAdd.id, m3.id],
        thiefDevs: ['V3'],
        thiefKeys: ['p0'],
        userRecs: [recDigest(R1(['V1']))],
      })
    ).toEqual([])
  })
  test('a revocation signed by the recovery key is not touched by epoch death: the disowning flow with the phrase before a recovery that kept the device', () => {
    const run = (by: string) => {
      const w = pworld(3, undefined, true, INVITE)
      const PT = w.heads()
      const add = w.ok('V2', 'add', { to: 'Z' }, { ts: t() }) // V2 is stolen at PT and invites Z
      w.ok('Vch1', 'mark', {}, { ts: t() })
      w.ok('Z1', 'join', {}, { ts: t() })
      const ap = w.heads()
      w.ok(
        'V5',
        'primary_rotate',
        { by: 'rkV', chain: [R1(['V1', 'V2', 'V5'])], keep: ['V1', 'V2'], seen: {} },
        { ap, ts: t() }
      ) // keeps V2
      w.ok('B1', 'mark', {}, { ts: t() })
      const rv = w.ok(
        'V1',
        'device_revoke',
        { by, dev: 'V2', seen: maxSeq(w, PT, 'V2') },
        { ap: PT, ts: t() }
      )
      w.ok('B1', 'mark', {}, { ts: t() })
      const S = w.state()
      return [
        S.X.has(rv.id),
        S.facts.revoked.has('V2'),
        S.tail.has(add.id),
        S.facts.mem.has('Z'),
        props(w),
      ]
    }
    expect(run('rkV')).toEqual([false, true, true, false, []])
    expect(run('p0')).toEqual([true, false, false, true, []])
  })
  test('key death: after a reset, records signed by the old phrase concurrent with it are inert (a rotation and a revocation); the rotation stays race evidence', () => {
    const w = pworld(3, undefined, true)
    const Pd = w.heads()
    const d5 = w.ok('V5', 'device_add', {}, { ts: t() })
    const reset = { n: 1, prev: crV, by: 'rkV', rk: 'rkV2', pk: 'pV2', keep: ['V1', 'V2', 'V5'] }
    const r = w.ok(
      'V1',
      'primary_rotate',
      { by: 'rkV2', chain: [reset], keep: ['V2', 'V5'], seen: {} },
      { ts: t() }
    )
    // the old phrase's holder: a rotation from a fresh device and a revocation of V1 from V2, both at Pd
    const y = w.ok(
      'V2',
      'device_revoke',
      { by: 'rkV', dev: 'V1', seen: maxSeq(w, Pd, 'V1') },
      { ap: Pd, ts: t() }
    )
    const x = w.ok(
      'V6',
      'primary_rotate',
      { by: 'rkV', keep: ['V1', 'V2'], seen: {} },
      { ap: Pd, ts: t() }
    )
    // an identity op in the inert rotation's epoch, signed by the old primary: inert too (epoch death, since the reset
    // installs a new primary), and kept stored
    const d7 = w.ok('V7', 'device_add', { by: 'p0' }, { ap: [x.id], ts: t() })
    const S = w.state()
    expect([S.X.has(x.id), S.X.has(y.id), S.X.has(r.id), S.X.has(d5.id), S.X.has(d7.id)]).toEqual([
      true,
      true,
      false,
      true,
      true,
    ])
    expect(BD(w)?.rec).toEqual(['rkV2'])
    expect(S.facts.revoked.has('V1')).toBe(false)
    expect(orphanDrops(w.ref.order, S, w.ref).has(d7.id)).toBe(false)
  })
  test("a thief holding the epoch-0 primary joins a new server first: refused through an add that names the user's head; otherwise the user's rotation at its introduction, or the user's join beside it, ends it", () => {
    const d1 = recDigest(R1(['V1']))
    // (a) the add names the user's head (record 1)
    {
      const { w, a } = fresh('V', { head: d1 })
      expect(w.act('V8', 'join', { rk: 'rkV', by: 'p0' }, { ap: [a.id], ts: t() }).v).toEqual({
        s: 'R',
        why: 'rk',
      })
      w.ok('V1', 'join', { rk: 'rkV', chain: [R1(['V1'])], by: 'pV1' }, { ts: t() })
      expect(BD(w)).toMatchObject({ st: 'protected', prim: ['pV1'] })
      expect(props(w)).toEqual([])
    }
    // (b) no head named: the thief joins; the user's join is refused (V is a member); the user's rotation positioned at
    // the thief's introduction drops its device: its later events are in Tail, its certificates inert
    {
      const { w, a } = fresh('V')
      const tj = w.ok('V8', 'join', { rk: 'rkV', by: 'p0' }, { ap: [a.id], ts: t() })
      const tm = w.ok('V8', 'mark', {}, { ap: [tj.id], ts: t() })
      const td = w.ok('V7', 'device_add', { by: 'p0' }, { ap: [tj.id], ts: t() })
      w.ok('B1', 'mark', {}, { ts: t() })
      expect(
        w.act('V1', 'join', { rk: 'rkV', chain: [R1(['V1'])], by: 'pV1' }, { ts: t() }).v
      ).toEqual({ s: 'R', why: 'auth' })
      const r = w.ok(
        'V1',
        'primary_rotate',
        { by: 'rkV', chain: [R1(['V1'])], keep: [], seen: { V8: maxSeq(w, [tj.id], 'V8') } },
        { ap: [tj.id], ts: t() }
      )
      w.ok('B1', 'mark', {}, { ts: t() })
      const S = w.state()
      expect([S.X.has(tj.id), S.tail.has(tm.id), S.X.has(td.id), S.X.has(r.id)]).toEqual([
        false,
        true,
        true,
        false,
      ])
      expect([[...(S.facts.devs.get('V') ?? [])], S.facts.mem.has('V'), BD(w)?.prim]).toEqual([
        ['V1'],
        true,
        ['pV1'],
      ])
      expect(
        propsRk(w, {
          kind: 'newsrv',
          x: 'V',
          r: r.id,
          rDrops: ['V8'],
          thief: [tj.id, tm.id, td.id],
          thiefDevs: ['V7', 'V8'],
          thiefKeys: ['p0'],
          userRecs: [d1],
        })
      ).toEqual([])
    }
    // (c) the user joins beside the thief's join (at the add): the thief's join is inert by epoch death, with its device's events
    {
      const { w, a } = fresh('V')
      const tj = w.ok('V8', 'join', { rk: 'rkV', by: 'p0' }, { ap: [a.id], ts: t() })
      const tm = w.ok('V8', 'mark', {}, { ap: [tj.id], ts: t() })
      w.ok('B1', 'mark', {}, { ap: [tm.id], ts: t() }) // a member acknowledges the thief's mark in good faith
      const uj = w.ok(
        'V1',
        'join',
        { rk: 'rkV', chain: [R1(['V1'])], by: 'pV1' },
        { ap: [a.id], ts: t() }
      )
      w.ok('B1', 'mark', {}, { ts: t() })
      const S = w.state()
      expect([
        S.X.has(tj.id),
        S.X.has(tm.id),
        S.X.has(uj.id),
        [...(S.facts.devs.get('V') ?? [])],
      ]).toEqual([true, true, false, ['V1']])
      expect(
        propsRk(w, {
          kind: 'newsrv',
          x: 'V',
          thief: [tj.id, tm.id],
          thiefDevs: ['V8'],
          thiefKeys: ['p0'],
          userRecs: [d1],
        })
      ).toEqual([])
    }
  })
  test('a phrase-only restore joins a new server: its join carries the chain and is certified by the new primary', () => {
    const rec = R1(['V5'])
    const { w } = fresh('V')
    const j = w.ok('V5', 'join', { rk: 'rkV', chain: [rec], by: 'pV1' }, { ts: t() })
    expect(BD(w)).toMatchObject({ st: 'protected', rec: ['rkV'], prim: ['pV1'] })
    expect(w.act('V6', 'device_add', { by: 'p0' }, { ts: t() }).v).toEqual({ s: 'R', why: 'sig' })
    w.ok('V6', 'device_add', { by: 'pV1' }, { ts: t() })
    expect(w.state().X.has(j.id)).toBe(false)
    expect(props(w)).toEqual([])
    // the user joins first with a kept device; the thief can't add a device under the old primary
    const { w: w2 } = fresh('V')
    const uj = w2.ok('V1', 'join', { rk: 'rkV', chain: [R1(['V1'])], by: 'pV1' }, { ts: t() })
    expect(w2.act('V9', 'device_add', { by: 'p0' }, { ap: [uj.id], ts: t() }).v).toEqual({
      s: 'R',
      why: 'sig',
    })
  })
  test("a reset, then a leaked old phrase in a new server: the thief's recovery branch is dead where the reset is known; rival resets void the creation record (nobody acts as V there)", () => {
    const reset1 = { n: 1, prev: crV, by: 'rkV', rk: 'rkV2', pk: 'pV2', keep: ['V1'] }
    for (const rival of [false, true]) {
      const t1 = rival
        ? { n: 1, prev: crV, by: 'rkV', rk: 'rkZ', pk: 'pZ', keep: ['V9'] }
        : { n: 1, prev: crV, by: 'rkV', pk: 'pZ', keep: ['V9'] }
      const tchain = [t1]
      const { w, a } = fresh('V')
      const tj = w.ok('V9', 'join', { rk: 'rkV', chain: tchain, by: 'pZ' }, { ap: [a.id], ts: t() })
      expect(BD(w)).toMatchObject({ st: 'protected', prim: ['pZ'] })
      const tm = w.ok('V9', 'mark', {}, { ap: [tj.id], ts: t() })
      const uj = w.ok(
        'V1',
        'join',
        { rk: 'rkV', chain: [reset1], by: 'pV2' },
        { ap: [a.id], ts: t() }
      )
      w.ok('B1', 'mark', {}, { ts: t() })
      const S = w.state()
      if (!rival) {
        expect(BD(w)).toMatchObject({ st: 'protected', rec: ['rkV2'], prim: ['pV2'] })
        expect([
          S.X.has(tj.id),
          S.X.has(tm.id),
          S.X.has(uj.id),
          [...(S.facts.devs.get('V') ?? [])],
        ]).toEqual([true, true, false, ['V1']])
      } else {
        expect(BD(w)).toMatchObject({ st: 'unprotected', void: 'chain' })
        expect([
          S.X.has(tj.id),
          S.X.has(uj.id),
          S.facts.mem.has('V'),
          S.facts.devs.get('V')?.size ?? 0,
        ]).toEqual([true, true, false, 0])
        // the user's client is frozen in its state and posts nothing there; an event it posted anyway
        // (mutant frozen-acts) would have no effect: refused, or in X on its inert join
        expect(w.frozenIn('V')).toBe(true)
        const vm = w.act('V1', 'mark', {}, { ts: t() })
        expect(vm.v.s === 'R' || w.state().X.has(vm.e.id)).toBe(true)
      }
      expect(props(w)).toEqual([])
    }
  })
  test("adds name the inviter's chain head: a join must reach every head its usable adds name; a code join names the head the redeemer presents", () => {
    const d1 = recDigest(R1(['V1']))
    const { w, a } = fresh('V', { head: crV }, true, INVITE)
    w.ok('B1', 'add', { to: 'V', head: d1 }, { ap: a.ap, ts: t() }) // a second inviter, concurrently, who holds record 1
    expect(w.act('V1', 'join', { rk: 'rkV', by: 'p0' }, { ts: t() }).v).toEqual({
      s: 'R',
      why: 'rk',
    }) // reaches the creation record only
    const j = w.ok('V1', 'join', { rk: 'rkV', chain: [R1(['V1'])], by: 'pV1' }, { ts: t() }) // reaches both
    expect(w.state().X.has(j.id)).toBe(false)
    // a code join: the admitter's add names the head the redeemer presented
    const { w: w2 } = fresh('Q')
    const code = w2.ok('O1', 'code', { h: 'hV' }, { ts: t() })
    w2.ok('O1', 'add', { to: 'V', code: code.id, head: d1 }, { ts: t() })
    expect(w2.act('V8', 'join', { rk: 'rkV', by: 'p0' }, { ts: t() }).v).toEqual({
      s: 'R',
      why: 'rk',
    })
    w2.ok('V1', 'join', { rk: 'rkV', chain: [R1(['V1'])], by: 'pV1' }, { ts: t() })
    expect(props(w2)).toEqual([])
  })
  test("an extension: a rotation that carries the chain, signed by the new head's primary (no phrase), drops the stolen device; an old primary, no new record, or a device the recovery dropped is refused", () => {
    const w = pworld(3, undefined, true)
    const rec = R1(['V1'])
    expect(
      w.act(
        'V1',
        'primary_rotate',
        { by: 'p0', chain: [rec], keep: [], seen: { V2: maxSeq(w, w.heads(), 'V2') } },
        { ts: t() }
      ).v
    ).toEqual({ s: 'R', why: 'sig' })
    expect(
      w.act(
        'V1',
        'primary_rotate',
        { by: 'pV1', chain: [rec], keep: ['V2'], seen: {} },
        { ts: t() }
      ).v
    ).toEqual({ s: 'R', why: 'rk' })
    const x = w.ok(
      'V1',
      'primary_rotate',
      { by: 'pV1', chain: [rec], keep: [], seen: { V2: maxSeq(w, w.heads(), 'V2') } },
      { ts: t() }
    )
    w.ok('B1', 'mark', {}, { ts: t() })
    expect(
      w.act(
        'V3',
        'primary_rotate',
        { by: 'pV1', keep: ['V1'], seen: { V2: maxSeq(w, w.heads(), 'V2') } },
        { ts: t() }
      ).v
    ).toEqual({ s: 'R', why: 'sig' })
    const S = w.state()
    expect([S.X.has(x.id), S.facts.revoked.has('V2'), BD(w)?.prim]).toEqual([false, true, ['pV1']])
    expect(props(w)).toEqual([])
  })
  test("a reset installs a new primary: a thief holding the old one can't post the user's reset elsewhere, so it can't make the user's earlier records die by key death", () => {
    const w = pworld(3, undefined, true)
    const P0 = w.heads()
    const rec1 = R1(['V1', 'V5'])
    const r1 = w.ok(
      'V1',
      'primary_rotate',
      { by: 'rkV', chain: [rec1], keep: [], seen: { V2: maxSeq(w, w.heads(), 'V2') } },
      { ts: t() }
    )
    w.ok('V5', 'device_add', { by: 'pV1' }, { ts: t() }) // V5 holds pV1; the thief steals it
    w.ok('B1', 'mark', {}, { ts: t() })
    const reset = { n: 2, prev: recDigest(rec1), by: 'rkV', rk: 'rkV2', pk: 'pV2', keep: ['V1'] }
    w.ok(
      'V1',
      'primary_rotate',
      {
        by: 'rkV2',
        chain: [reset],
        keep: [],
        seen: { V2: maxSeq(w, w.heads(), 'V2'), V5: maxSeq(w, w.heads(), 'V5') },
      },
      { ts: t() }
    )
    w.ok('B1', 'mark', {}, { ts: t() })
    // the thief re-posts the records at P0 as an extension signed by the primary it holds: refused (the head's is pV2)
    expect(
      w.act(
        'V9',
        'primary_rotate',
        {
          by: 'pV1',
          chain: [rec1, reset],
          keep: [],
          seen: { V1: maxSeq(w, P0, 'V1'), V2: maxSeq(w, P0, 'V2') },
        },
        { ap: P0, ts: t() }
      ).v
    ).toEqual({ s: 'R', why: 'sig' })
    const S = w.state()
    expect([S.X.has(r1.id), BD(w)?.prim, S.facts.revoked.has('V5')]).toEqual([false, ['pV2'], true])
    expect(props(w)).toEqual([])
  })
  test('genesis owner bundles carry the chain: a restored owner creates a rules-3 server, certified by its current primary', () => {
    T = 0
    const cO = crDigest('O', 'rkO', 'pO0')
    const w = new World()
    w.genesis('O1', ['O'], 0, 0, {
      rules: 3,
      rks: {
        O: {
          rk: 'rkO',
          pk: 'pO0',
          chain: [{ n: 1, prev: cO, by: 'rkO', pk: 'pO1', keep: ['O1'] }],
        },
      },
    })
    expect(BD(w, 'O')).toMatchObject({ st: 'protected', rec: ['rkO'], prim: ['pO1'] })
    expect(w.act('O2', 'device_add', { by: 'pO0' }, { ts: t() }).v).toEqual({ s: 'R', why: 'sig' })
    w.ok('O2', 'device_add', { by: 'pO1' }, { ts: t() })
    expect(props(w, false)).toEqual([])
  })
  test("two recoveries with the same n reconcile: both are heads until a record cites one; then the other's primary dies by epoch death", () => {
    const w = pworld(3, undefined, true)
    const P = w.heads()
    const ra = R1(['V1'], 'pVa'),
      rb = R1(['V5'], 'pVb')
    const xa = w.ok(
      'V1',
      'primary_rotate',
      { by: 'rkV', chain: [ra], keep: [], seen: { V2: maxSeq(w, P, 'V2') } },
      { ap: P, ts: t() }
    )
    const xb = w.ok(
      'V5',
      'primary_rotate',
      { by: 'rkV', chain: [rb], keep: ['V1'], seen: { V2: maxSeq(w, P, 'V2') } },
      { ap: P, ts: t() }
    )
    expect(BD(w)).toMatchObject({ rec: ['rkV'], prim: ['pVa', 'pVb'] })
    // a certificate under pVb concurrent with the record that cites the other branch
    const dB = w.ok('V6', 'device_add', { by: 'pVb' }, { ap: [xb.id], ts: t() })
    // while the two recoveries contest each other, a certificate in one's epoch is contested (a candidate, in X) but not
    // inert: an identity with a creation record keeps it stored unless it is past its device's fork point (
    // mutant rk-drop)
    const dA = w.ok('V7', 'device_add', { by: 'pVa' }, { ap: [xa.id], ts: t() })
    const S1 = w.state()
    expect([S1.X.has(dA.id), resolveProtection(w.ref.order, w.ref).inert.has(dA.id)]).toEqual([
      true,
      false,
    ])
    expect(orphanDrops(w.ref.order, S1, w.ref).has(dA.id)).toBe(false)
    const r2 = { n: 2, prev: recDigest(ra), by: 'rkV', pk: 'pV2', keep: ['V1', 'V5'] }
    // the two rotations contest each other (neither saw the other), so the one that cites both keeps only its own device
    const x2 = w.ok(
      'V1',
      'primary_rotate',
      {
        by: 'rkV',
        chain: [r2],
        keep: [],
        seen: { V2: maxSeq(w, [xa.id, xb.id], 'V2'), V5: maxSeq(w, [xa.id, xb.id], 'V5') },
      },
      { ap: [xa.id, xb.id], ts: t() }
    )
    w.ok('B1', 'mark', {}, { ts: t() })
    const S = w.state()
    expect(BD(w)).toMatchObject({ rec: ['rkV'], prim: ['pV2'] })
    expect([
      S.X.has(x2.id),
      S.X.has(dB.id),
      S.facts.devs.get('V')?.has('V6') ?? false,
      S.facts.revoked.has('V1'),
    ]).toEqual([false, true, false, false])
    expect(props(w)).toEqual([])
  })
  test('a different creation record where one is known is refused (refusal only); two concurrent ones void it', () => {
    const w = pworld()
    w.ok('V1', 'leave', {}, { ts: t() })
    w.ok('O1', 'add', { to: 'V' }, { ts: t() })
    expect(w.act('V6', 'join', { rk: 'rkZ' }, { ts: t() }).v).toEqual({ s: 'R', why: 'rk' })
    const { w: w2, a } = fresh('V')
    w2.ok('V1', 'join', { rk: 'rkV' }, { ap: [a.id], ts: t() })
    w2.ok('V7', 'join', { rk: 'rkZ' }, { ap: [a.id], ts: t() }) // needs ik's signature: only a legacy identity's ik can make it
    w2.ok('O1', 'mark', {}, { ts: t() })
    expect(BD(w2)).toMatchObject({ st: 'unprotected', void: 'cr' })
    expect(props(w2)).toEqual([])
  })
  test("an owner's creation record is its genesis bundle's: a join of an owner with another one, or with one when the bundle had none, is refused", () => {
    T = 0
    const w = new World()
    w.genesis('O1', ['O', 'Q'], 0, 0, { rules: 3, rks: { O: 'rkO' } })
    w.ok('Q1', 'join', {}, { ts: t() })
    expect(w.act('O7', 'join', { rk: 'rkZ' }, { ts: t() }).v).toEqual({ s: 'R', why: 'rk' })
    expect(w.act('Q7', 'join', { rk: 'rkZ' }, { ts: t() }).v).toEqual({ s: 'R', why: 'rk' })
    expect(w.act('O7', 'device_add', {}, { ts: t() }).v.s).toBe('A')
    expect(BD(w, 'O')).toMatchObject({ st: 'protected', won: 'rkO|p0' })
    expect(BD(w, 'Q')).toBeUndefined()
  })
  test('version rule: on rules 2 the same events are read as today (ik plays recovery; rk, chain, pk, head and by are unread), and alike by an older client', () => {
    const w = pworld(2)
    const P0 = w.heads()
    const rT = w.ok(
      'V2',
      'primary_rotate',
      { by: 'ik', pcert: 'pT', keep: [], seen: { V1: maxSeq(w, P0, 'V1') } },
      { ap: P0, ts: t() }
    )
    w.ok('T1', 'mark', {}, { ap: [rT.id], ts: t() })
    const S = w.state()
    expect([S.X.has(rT.id), S.facts.revoked.has('V1'), S.BD]).toEqual([false, true, undefined])
    const old = new Replica({ rules: [2] })
    for (const e of w.all) old.receive(e)
    expect(evalSummary(old.state())).toBe(evalSummary(S))
  })
  test("restore from the phrase alone in a server it was in: a new device's rotation signed by the recovery key introduces it and drops the rest", () => {
    const w = pworld()
    const ap = w.heads()
    const r = w.ok(
      'V3',
      'primary_rotate',
      {
        by: 'rkV',
        chain: [R1(['V3'])],
        keep: [],
        seen: { V1: maxSeq(w, ap, 'V1'), V2: maxSeq(w, ap, 'V2') },
      },
      { ap, ts: t() }
    )
    const S = w.state()
    expect(S.facts.devs.get('V')).toEqual(new Set(['V3']))
    expect(
      w.act(
        'V3',
        'primary_rotate',
        { by: 'p0', keep: [], seen: { V1: maxSeq(w, [r.id], 'V1'), V2: maxSeq(w, [r.id], 'V2') } },
        { ap: [r.id], ts: t() }
      ).v
    ).toEqual({ s: 'R', why: 'sig' })
    expect(props(w)).toEqual([])
  })
  test("a succession is never automatic: a successor's join that carries one gets no membership, roles or devices from it", () => {
    const w = pworld()
    const R = w.ok('O1', 'role_create', { pos: 2, bits: KICK }, { ts: t() }).id
    w.ok('O1', 'assign', { to: 'V', role: R }, { ts: t() })
    w.ok('O1', 'add', { to: 'W' }, { ts: t() })
    w.ok('W1', 'join', { rk: 'rkW', succ: { old: 'V', sig: 'sig:ik(V):W' } }, { ts: t() })
    const F0 = w.state().facts
    expect([
      F0.holds.get('W')?.has(R) ?? false,
      F0.holds.get('V')?.has(R) ?? false,
      F0.mem.has('V'),
    ]).toEqual([false, true, true])
  })
  test('oracle: protectionOracle agrees with the model on these worlds, and the inert sets agree both ways (O15-oracle)', () => {
    const builds = [
      () => pworld(),
      () => {
        const w = pworld()
        recover(w, 'V1', w.heads(), ['V2'])
        return w
      },
      () => {
        const w = pworld(3, undefined, true)
        const P0 = w.heads()
        recover(w, 'V1', w.heads(), ['V2'])
        w.ok('V3', 'device_add', { by: 'p0' }, { ap: P0, ts: t() })
        return w
      },
    ]
    for (const build of builds) {
      const w = build()
      const S = w.state(),
        O = protectionOracle(w.ref, w.ref.order).get('V')!
      expect([S.BD?.get('V')?.st, S.BD?.get('V')?.rec, S.BD?.get('V')?.prim]).toEqual([
        O.st,
        O.rec,
        O.prim,
      ])
      expect([...inert(w)].sort()).toEqual([...O.inert].sort())
    }
  })
})

describe('owner-signed checkpoints (packed admission states)', () => {
  const setup = () => {
    const w = world({ rules: 2 })
    const MR = w.ok('O1', 'role_create', { pos: 3, bits: BAN }, { ts: t() }).id
    w.ok('O1', 'assign', { to: 'B', role: MR }, { ts: t() })
    const ban = w.ok('B1', 'ban', { to: 'T' }, { ts: t() })
    const unban = w.ok('O1', 'unban', { to: 'T' }, { ts: t() })
    w.ok('Vch1', 'mark', {}, { ts: t() })
    return { w, ban, unban }
  }
  const transfer = (w: World, dev = 'O1', signer = 'O') =>
    makeTransfer(w.ref, dev, signer, undefined, ids => w.ref.evalSet(ids))
  test('checkpoint: a joiner adopts at once from the packed states (no evaluation), shows the frontier state, and background verification agrees', () => {
    const { w } = setup()
    const T = transfer(w)
    expect(checkTransfer(T)).toEqual({ ok: true })
    const ad = new Adopted(T)
    expect(ad.shownSummary()).toBe(evalSummary(w.state()))
    // the restored admission states reproduce the evaluation (what the joiner runs when an ACL event arrives)
    expect(evalSummary(ad.state())).toBe(evalSummary(w.state()))
    expect([ad.mayPost('c'), ad.mayPost('join'), ad.mayPost('a')]).toEqual([true, true, false])
    const v = verify(ad, T.events, T)
    expect(v.ok && !ad.verifying && !ad.discarded && ad.mayPost('a')).toBe(true)
  })
  test("checkpoint: a lying owner's transfer shows a wrong state until verification ends, then it is discarded and the signing device reported", () => {
    const { w, unban } = setup()
    const honest = transfer(w)
    // the liar records the unban "below" the ban (T stays banned) and evaluates its lie for the frontier state it sends
    const bad = new Map(w.ref.order.map(id => [id, w.ref.rec(id)] as const))
    bad.set(unban.id, { ...bad.get(unban.id)!, k: Model.BOT })
    const cx = {
      order: w.ref.order,
      ev: (id: string) => w.ref.ev(id),
      anc: (id: string) => w.ref.anc(id),
      rec: (id: string) => bad.get(id)!,
    }
    const lie0 = makeTransfer(cx, 'O2', 'O', undefined, ids => evaluate(ids, cx))
    expect(checkTransfer(lie0)).toEqual({ ok: true })
    const ad = new Adopted(lie0)
    expect(ad.shown.facts.ban.has('T')).toBe(true) // the wrong state, marked verifying
    expect(w.state().facts.ban.has('T')).toBe(false)
    const v = verify(ad, lie0.events, lie0)
    expect(v.ok).toBe(false)
    expect(ad.discarded).toBe(true)
    expect(ad.report).toMatchObject({ kind: 'lie', signer: 'O', dev: 'O2', id: unban.id })
    expect(v.replica.state().facts.ban.has('T')).toBe(false)
    // two different checkpoints for one frontier are no evidence by themselves; only the refuted one is reported
    expect(conflicting(honest.cp, lie0.cp)).toBe(true)
    const ad2 = new Adopted(honest)
    expect([verify(ad2, honest.events, honest).ok, ad2.report]).toEqual([true, undefined])
    // signed with another evaluator version: a refutation is a bug report, not evidence against the signer
    const other = { ...lie0, cp: signCp({ ...lie0.cp, impl: 'other' }) }
    const ad3 = new Adopted(other)
    verify(ad3, other.events, other)
    expect(ad3.report?.kind).toBe('impl')
  })
  test("checkpoint: two honest replicas that admitted concurrent events in opposite orders build the same signed digests, and each verifies the other's", () => {
    const w = world({ rules: 2 })
    const P = w.heads()
    const a1 = w.ok('O1', 'role_create', { pos: 2, bits: 0 }, { ap: P, ts: t() })
    const a2 = w.ok('O1', 'kick', { to: 'T' }, { ap: [a1.id], ts: t() })
    const b1 = w.ok('B1', 'mark', {}, { ap: P, ts: t() })
    const b2 = w.ok('Vch1', 'mark', {}, { ap: [b1.id], ts: t() })
    w.ok('V1', 'mark', {}, { ap: [a2.id, b2.id], ts: t() })
    const adm = w.all.filter(e => w.ref.admitted(e.id))
    const swap = (e: Ev) => (e.id === a1.id || e.id === a2.id ? 1 : 0)
    const order2 = [
      ...adm.filter(e => !swap(e) && w.ref.order.indexOf(e.id) < w.ref.order.indexOf(a1.id)),
      b1,
      b2,
      a1,
      a2,
      ...adm.filter(e => w.ref.order.indexOf(e.id) > w.ref.order.indexOf(b2.id)),
    ]
    const rA = new Replica(),
      rB = new Replica()
    for (const e of adm) rA.receive(e)
    for (const e of order2) rB.receive(e)
    expect(rA.order.join()).not.toBe(rB.order.join())
    expect(rB.order.length).toBe(rA.order.length)
    const TA = makeTransfer(rA, 'O1', 'O', undefined, ids => rA.evalSet(ids))
    const TB = makeTransfer(rB, 'O1', 'O', undefined, ids => rB.evalSet(ids))
    expect([TA.cp.recs, TA.cp.front, TA.cp.sum]).toEqual([TB.cp.recs, TB.cp.front, TB.cp.sum])
    expect(verify(new Adopted(TB), adm, TB).ok).toBe(true)
    expect(verify(new Adopted(TA), order2, TA).ok).toBe(true)
  })
  test("checkpoint: a non-owner's checkpoint, a bad signature, records or states that don't match, or a device not live for the owner is refused", () => {
    const { w } = setup()
    expect(checkTransfer(transfer(w, 'B1', 'B'))).toEqual({ ok: false, why: 'signer' })
    const T = transfer(w)
    expect(checkTransfer({ ...T, cp: { ...T.cp, count: T.cp.count + 1 } })).toEqual({
      ok: false,
      why: 'sig',
    })
    const recs = T.recs.map(
      ([id, r], i) => [id, i === 3 ? { ...r, cls: 'D' } : r] as [string, typeof r]
    )
    expect(checkTransfer({ ...T, recs })).toEqual({ ok: false, why: 'records' })
    const packed = T.packed.map(
      ([id, p], i) => [id, i === 5 ? { ...p, v: [...p.v, 'x'] } : p] as [string, typeof p]
    )
    expect(checkTransfer({ ...T, packed })).toEqual({ ok: false, why: 'records' })
    expect(checkTransfer({ ...T, front: { ...T.front, X: [...T.front.X, 'x'] } })).toEqual({
      ok: false,
      why: 'front',
    })
    // the signing device must be introduced for the owner and live in the frontier state
    w.ok('O1', 'device_revoke', { dev: 'O2', seen: maxSeq(w, w.heads(), 'O2') }, { ts: t() })
    const T2 = transfer(w, 'O2', 'O')
    expect(checkTransfer(T2)).toEqual({ ok: true })
    expect(() => new Adopted(T2)).toThrow('not live')
    expect(recordOf(w.ref.rec(T.events[3].id))).not.toBe(JSON.stringify(recs[3][1]))
  })
})
