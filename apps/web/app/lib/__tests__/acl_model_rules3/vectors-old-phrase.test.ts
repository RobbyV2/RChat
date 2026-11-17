/* eslint-disable */
// @ts-nocheck
// Part of the P2P ACL reference model, used only by tests.
import { setDefaultTimeout } from 'bun:test'
setDefaultTimeout(120_000)
// Vectors of a leaked old phrase after a transfer,
// a server the identity left, an identity frozen at an
// upgrade, an add naming the other one of two same-n records, links of a
// frozen identity and of a legacy identity across servers, and a flood of
// rival resets. Each world built here also runs the exact G5 oracle and O13-fast (vectors-hook.ts).
import { describe, expect, test } from 'bun:test'
import { World } from './world'
import { KICK, crDigest, recDigest, linkOf, projectMembers } from './model'
import type { RkMeta } from './gen'
import { oracleAfterEach } from './vectors-hook'
import { checkCase } from './props'

oracleAfterEach()
let T = 0
const t = () => (T += 4)
const props = (w: World, rkCase?: RkMeta) =>
  checkCase({ w, equivocation: true, seed: 1, adversarial: [], ...(rkCase ? { rkCase } : {}) }).map(
    x => `${x.prop}: ${x.detail}`
  )
const maxSeq = (w: World, ap: string[], dev: string) => {
  let m = -1
  for (const id of w.closure(ap)) {
    const e = w.ref.ev(id)
    if (e.dev === dev) m = Math.max(m, e.seq)
  }
  return m
}
const seenOf = (w: World, ap: string[], ds: string[]) =>
  Object.fromEntries(ds.map(d => [d, maxSeq(w, ap, d)]).filter(([, s]) => (s as number) >= 0))
const BD = (w: World, a: string) => w.state().BD?.get(a)
const devs = (w: World, a: string) => [...(w.state().facts.devs.get(a) ?? [])].sort()
const fate = (w: World, id: string) => {
  const S = w.state()
  return S.X.has(id) ? 'X' : S.tail.has(id) ? 'Tail' : 'counts'
}

describe('a leaked old phrase after a transfer', () => {
  const cO = crDigest('O', 'rkO', 'pO0'),
    cQ = crDigest('Q', 'rkQ', 'pQ0')
  const resetO = { n: 1, prev: cO, by: 'rkO', rk: 'rkO2', pk: 'pO2', keep: ['O1'] }
  const resetQ = { n: 1, prev: cQ, by: 'rkQ', rk: 'rkQ2', pk: 'pQ2', keep: ['Q1'] }
  const rival = (c: string, rk: string, dev: string) => ({
    n: 1,
    prev: c,
    by: rk,
    rk: 'rkT',
    pk: 'pT',
    keep: [dev],
  })
  /** owner O protected (rkO, pO0) with O2; co-owner Q protected (rkQ, pQ0) joined with Q1; members B and C */
  const oworld = (co: boolean) => {
    T = 0
    const w = new World()
    w.genesis('O1', co ? ['O', 'Q'] : ['O'], 0, 0, {
      rules: 3,
      limits: { devCap: 4, poolU: 60 },
      rks: { O: { rk: 'rkO', pk: 'pO0' }, ...(co ? { Q: { rk: 'rkQ', pk: 'pQ0' } } : {}) },
    })
    w.ok('O2', 'device_add', { by: 'pO0' }, { ts: t() })
    if (co) w.ok('Q1', 'join', { rk: 'rkQ', pk: 'pQ0', by: 'pQ0' }, { ts: t() })
    for (const m of ['B', 'C']) {
      w.ok('O1', 'add', { to: m }, { ts: t() })
      w.ok(`${m}1`, 'join', {}, { ts: t() })
    }
    w.ok('B1', 'mark', {}, { ts: t() })
    return w
  }
  test("a single owner's reset reaches its upgraded S, and the old phrase then only freezes it: S revives (the stated cost), the thief's acts and its own transfer are refused", () => {
    const w = oworld(false)
    const P0 = w.heads()
    const u = w.ok('O1', 'upgrade', { g: 'G1', sigs: { O: { by: 'pO0' } } }, { ts: t() })
    w.ok('B1', 'leave', {}, { ts: t() }) // B follows S'
    // O's reset, posted by its client on the heads of the archived S (admitted: it carries a record S lacks)
    const r = w.act(
      'O1',
      'primary_rotate',
      { by: 'rkO2', chain: [resetO], keep: [], seen: seenOf(w, w.heads(), ['O2']) },
      { ts: t() }
    )
    expect([r.v, w.state().facts.upgraded, BD(w, 'O')?.rec]).toEqual([{ s: 'A' }, [u.id], ['rkO2']])
    // an event that carries nothing new is still refused after the upgrade
    expect(
      w.act(
        'O1',
        'primary_rotate',
        { by: 'rkO2', chain: [resetO], keep: [], seen: seenOf(w, w.heads(), ['O2']) },
        { ts: t() }
      ).v
    ).toEqual({ s: 'R', why: 'auth' })
    // the holder of the old phrase: a reset of its own from a fresh device, positioned before the upgrade
    const tr = w.ok(
      'O9',
      'primary_rotate',
      { by: 'rkT', chain: [rival(cO, 'rkO', 'O9')], keep: [], seen: seenOf(w, P0, ['O1', 'O2']) },
      { ap: P0, ts: t() }
    )
    const ta = w.ok('O9', 'role_create', { pos: 5, bits: KICK }, { ap: [tr.id], ts: t() }) // as O at its own rival
    let S = w.state()
    expect([
      BD(w, 'O')?.void,
      S.facts.mem.has('O'),
      devs(w, 'O'),
      fate(w, u.id),
      S.facts.upgraded,
      fate(w, tr.id),
      fate(w, ta.id),
    ]).toEqual(['chain', false, [], 'X', [], 'X', 'X'])
    // at a position that holds both resets every act of O is refused, the thief's own transfer included; where the thief
    // positions one without the user's reset (honest members never cite the rival: it is in X), it is admitted and inert
    const all = () => w.heads()
    expect(
      w.act('O9', 'kick', { to: 'C', seen: seenOf(w, all(), ['C1']) }, { ap: all(), ts: t() }).v
    ).toEqual({ s: 'R', why: 'void' })
    expect(
      w.act('O9', 'upgrade', { g: 'G2', sigs: { O: { by: 'pT' } } }, { ap: all(), ts: t() }).v
    ).toEqual({ s: 'R', why: 'void' })
    const tk = w.act(
      'O9',
      'kick',
      { to: 'C', seen: seenOf(w, [ta.id], ['C1']) },
      { ap: [ta.id], ts: t() }
    )
    const tu = w.act(
      'O9',
      'upgrade',
      { g: 'G2', sigs: { O: { by: 'pT' } } },
      { ap: [tk.e.id], ts: t() }
    )
    S = w.state()
    expect([tk.v.s, fate(w, tk.e.id), tu.v.s, S.facts.mem.has('C'), S.facts.upgraded]).toEqual([
      'A',
      'X',
      'A',
      true,
      [],
    ])
    expect(
      props(w, {
        kind: 'upgrade',
        x: 'O',
        thief: [tr.id, ta.id, tk.e.id, tu.e.id],
        thiefDevs: ['O9'],
        thiefKeys: ['rkO', 'rkT', 'pT'],
        leaked: true,
        userRecs: [recDigest(resetO)],
        e2e: true,
        mustAdmit: [r.e.id],
      })
    ).toEqual([])
  })
  test("a co-owner's old phrase: its reset reaches S, the thief's rival freezes it and undoes the transfer; nobody can sign a new transfer while it is frozen", () => {
    const w = oworld(true)
    const P0 = w.heads()
    const u = w.ok(
      'O1',
      'upgrade',
      { g: 'G1', sigs: { O: { by: 'pO0' }, Q: { by: 'pQ0' } } },
      { ts: t() }
    )
    const r = w.ok(
      'Q1',
      'primary_rotate',
      { by: 'rkQ2', chain: [resetQ], keep: [], seen: {} },
      { ts: t() }
    ) // signed by the recovery key (Q is a genesis owner)
    // the holder of the old phrase signs its rival carrier with its own recovery key rkT (only a
    // carrier signed by a recovery key kills an upgrade signature; one signed by pT is the stated residual's opposite)
    const tr = w.ok(
      'Q9',
      'primary_rotate',
      { by: 'rkT', chain: [rival(cQ, 'rkQ', 'Q9')], keep: [], seen: seenOf(w, P0, ['Q1']) },
      { ap: P0, ts: t() }
    )
    const S = w.state()
    expect([
      BD(w, 'Q')?.void,
      fate(w, u.id),
      S.facts.upgraded,
      fate(w, r.id),
      fate(w, tr.id),
    ]).toEqual(['chain', 'X', [], 'X', 'X'])
    expect(
      w.act(
        'Q9',
        'kick',
        { to: 'C', seen: seenOf(w, w.heads(), ['C1']) },
        { ap: w.heads(), ts: t() }
      ).v
    ).toEqual({ s: 'R', why: 'void' })
    // S revived: O acts again, but no new transfer at a position that knows the freeze can carry a signature of Q,
    // whatever its key
    expect(w.act('O1', 'role_create', { pos: 2, bits: KICK }, { ap: w.heads(), ts: t() }).v.s).toBe(
      'A'
    )
    for (const by of ['pQ0', 'pQ2', 'rkQ2', 'pT', 'rkT'])
      expect(
        w.act(
          'O1',
          'upgrade',
          { g: 'G3', sigs: { O: { by: 'pO0' }, Q: { by } } },
          { ap: w.heads(), ts: t() }
        ).v
      ).toEqual({ s: 'R', why: 'sig' })
    expect(
      props(w, {
        kind: 'upgrade',
        x: 'Q',
        thief: [tr.id],
        thiefDevs: ['Q9'],
        thiefKeys: ['rkQ', 'rkT', 'pT'],
        leaked: true,
        userRecs: [recDigest(resetQ)],
        e2e: true,
      })
    ).toEqual([])
  })
  test("a co-owner that left before signing posts its reset in the upgraded S as a non-member; the thief's rival before its leave freezes it, and the thief's rejoin is refused (mutant rk-upg-rot-mem)", () => {
    const w = oworld(true)
    const P0 = w.heads()
    const lv = w.ok('Q1', 'leave', {}, { ts: t() })
    const u = w.ok(
      'O1',
      'upgrade',
      { g: 'G1', sigs: { O: { by: 'pO0' }, Q: { by: 'pQ0' } } },
      { ts: t() }
    )
    // the client's posting goes at the frontier of its recorded leave's
    // parents and the upgrade it signed (here u itself), never on the heads
    const r = w.act(
      'Q1',
      'primary_rotate',
      { by: 'rkQ2', chain: [resetQ], keep: [], seen: {} },
      { ap: [u.id], ts: t() }
    )
    expect(r.v).toEqual({ s: 'A' })
    const tr = w.ok(
      'Q9',
      'primary_rotate',
      { by: 'rkT', chain: [rival(cQ, 'rkQ', 'Q9')], keep: [], seen: seenOf(w, P0, ['Q1']) },
      { ap: P0, ts: t() }
    )
    expect(w.act('Q9', 'join', { by: 'pT' }, { ap: w.heads(), ts: t() }).v).toEqual({
      s: 'R',
      why: 'void',
    })
    expect(w.act('Q9', 'join', { by: 'pT' }, { ts: t() }).v.s).toBe('R') // on the honest heads Q is a member again there: refused too
    const S = w.state()
    expect([
      BD(w, 'Q')?.void,
      S.facts.mem.has('Q'),
      fate(w, u.id),
      fate(w, lv.id) !== 'counts' || !S.facts.mem.has('Q'),
    ]).toEqual(['chain', false, 'X', true])
    expect(
      props(w, {
        kind: 'upgrade',
        x: 'Q',
        thief: [tr.id],
        thiefDevs: ['Q9'],
        thiefKeys: ['rkQ', 'rkT', 'pT'],
        leaked: true,
        userRecs: [recDigest(resetQ)],
        e2e: true,
        leftOut: true,
        mustAdmit: [r.e.id],
      })
    ).toEqual([])
  })
  test("a reset carried in a co-owner's upgrade signature joins S's chain: the old phrase's rival then freezes Q instead of taking it (mutant rk-sigchain-off)", () => {
    const w = oworld(true)
    const P0 = w.heads()
    const u = w.ok(
      'O1',
      'upgrade',
      { g: 'G1', sigs: { O: { by: 'pO0' }, Q: { by: 'pQ2', chain: [resetQ] } } },
      { ts: t() }
    )
    expect([w.state().facts.upgraded, BD(w, 'Q')?.rec, BD(w, 'Q')?.prim]).toEqual([
      [u.id],
      ['rkQ2'],
      ['pQ2'],
    ])
    const tr = w.ok(
      'Q9',
      'primary_rotate',
      { by: 'pT', chain: [rival(cQ, 'rkQ', 'Q9')], keep: [], seen: seenOf(w, P0, ['Q1']) },
      { ap: P0, ts: t() }
    )
    const tk = w.ok(
      'Q9',
      'kick',
      { to: 'C', seen: seenOf(w, [tr.id], ['C1']) },
      { ap: [tr.id], ts: t() }
    )
    const S = w.state()
    expect([BD(w, 'Q')?.void, fate(w, u.id), fate(w, tk.id), S.facts.mem.has('C')]).toEqual([
      'chain',
      'X',
      'X',
      true,
    ])
    expect(
      w.act('Q9', 'kick', { to: 'C', seen: seenOf(w, w.heads(), ['C1']) }, { ts: t() }).v
    ).toEqual({ s: 'R', why: 'void' })
    expect(
      props(w, {
        kind: 'upgrade',
        x: 'Q',
        thief: [tr.id, tk.id],
        thiefDevs: ['Q9'],
        thiefKeys: ['rkQ', 'rkT', 'pT'],
        leaked: true,
        userRecs: [recDigest(resetQ)],
        e2e: true,
      })
    ).toEqual([])
  })
})

describe('a server the identity left or was removed from', () => {
  const cX = crDigest('X', 'rkX', 'pX0')
  /** X protected (rkX, pX0) with X1 and X2 (X2 certified by pX0): the single owner, a co-owner beside A, or a member of
   * A's server holding a Kick role; members B and C */
  const lworld = (who: 'owner' | 'coowner' | 'member') => {
    T = 0
    const w = new World()
    const owners = who === 'owner' ? ['X'] : who === 'coowner' ? ['A', 'X'] : ['A']
    w.genesis(owners[0] === 'X' ? 'X1' : 'A1', owners, 0, 0, {
      rules: 3,
      limits: { devCap: 4, poolU: 60 },
      rks: owners.includes('X') ? { X: { rk: 'rkX', pk: 'pX0' } } : {},
    })
    if (who === 'member') w.ok('A1', 'add', { to: 'X' }, { ts: t() })
    if (who !== 'owner') w.ok('X1', 'join', { rk: 'rkX', pk: 'pX0', by: 'pX0' }, { ts: t() })
    w.ok('X2', 'device_add', { by: 'pX0' }, { ts: t() })
    const mod = owners.includes('A') ? 'A1' : 'X1'
    if (who === 'member') {
      const R = w.ok('A1', 'role_create', { pos: 3, bits: KICK }, { ts: t() }).id
      w.ok('A1', 'assign', { to: 'X', role: R }, { ts: t() })
    }
    for (const m of ['B', 'C']) {
      w.ok(mod, 'add', { to: m }, { ts: t() })
      w.ok(`${m}1`, 'join', {}, { ts: t() })
    }
    w.ok('X1', 'mark', {}, { ts: t() })
    w.ok('B1', 'mark', {}, { ts: t() })
    return w
  }
  /** X leaves (from `dev`), then its client posts the record carried at the leave's parents from the given devices (in
   * the record's keep, never in this server), keeping the record's devices live there, with watermarks through the leave */
  const leaveAndPost = (w: World, rec: any, by: string, posters: string[], dev = 'X1') => {
    const Pb = w.heads()
    w.ok('X2', 'mark', {}, { ts: t() })
    const lvPar = w.heads()
    const lv = w.ok(dev, 'leave', {}, { ts: t() })
    w.ok('B1', 'mark', {}, { ts: t() })
    const before = w.heads()
    const live = ['X1', 'X2']
    const kp = live.filter(v => rec.keep.includes(v))
    const seen: Record<string, number> = {}
    for (const v of live)
      if (!rec.keep.includes(v)) seen[v] = Math.max(maxSeq(w, lvPar, v), lv.dev === v ? lv.seq : -1)
    const rs = posters.map(p =>
      w.ok(p, 'primary_rotate', { by, chain: [rec], keep: kp, seen }, { ap: lvPar, ts: t() })
    )
    w.ok('B1', 'mark', {}, { ts: t() })
    return { Pb, lvPar, lv, before, rs }
  }
  const rec1 = { n: 1, prev: cX, by: 'rkX', pk: 'pX1', keep: ['X1', 'X5'] }
  test("a co-owner leaves, then recovers elsewhere: its client's rotation at the leave's parents drops the stolen X2; the thief's rejoin from X2 or a device certified by pX0 is refused, a concurrent one is in Tail, and the leave stands", () => {
    const w = lworld('coowner')
    const { lv, before, rs } = leaveAndPost(w, rec1, 'rkX', ['X5'])
    expect(w.act('X2', 'join', {}, { ts: t() }).v.s).toBe('R')
    expect(w.act('X8', 'join', { by: 'pX0' }, { ts: t() }).v).toEqual({ s: 'R', why: 'sig' })
    const tj = w.ok('X2', 'join', {}, { ap: before, ts: t() }) // the thief concurrent with the posting
    const tk = w.ok(
      'X2',
      'kick',
      { to: 'C', seen: seenOf(w, [tj.id], ['C1']) },
      { ap: [tj.id], ts: t() }
    )
    w.ok('B1', 'mark', {}, { ts: t() })
    const S = w.state()
    expect([
      fate(w, rs[0].id),
      S.facts.revoked.has('X2'),
      fate(w, tj.id),
      fate(w, tk.id),
      S.facts.mem.has('C'),
      fate(w, lv.id),
      S.facts.mem.has('X'),
    ]).toEqual(['counts', true, 'Tail', 'Tail', true, 'counts', false])
    expect(
      props(w, {
        kind: 'left',
        x: 'X',
        V1: 'X5',
        V2: 'X2',
        r: rs[0].id,
        rDrops: ['X2'],
        thief: [tj.id, tk.id],
        thiefDevs: ['X2', 'X8'],
        thiefKeys: ['pX0'],
        userRecs: [recDigest(rec1)],
        e2e: true,
        leftOut: true,
      })
    ).toEqual([])
  })
  test("a single owner leaves and recovers elsewhere: the thief's rejoin and transfer signed by the old primary are refused, or inert when concurrent", () => {
    const w = lworld('owner')
    const { before } = leaveAndPost(w, rec1, 'rkX', ['X5']) // X is a genesis owner, so the recovery key signs
    expect(w.act('X8', 'join', { by: 'pX0' }, { ts: t() }).v).toEqual({ s: 'R', why: 'sig' })
    const tj = w.ok('X8', 'join', { by: 'pX0' }, { ap: before, ts: t() })
    const tu = w.ok(
      'X8',
      'upgrade',
      { g: 'Gt', sigs: { X: { by: 'pX0' } } },
      { ap: [tj.id], ts: t() }
    )
    w.ok('B1', 'mark', {}, { ts: t() })
    const S = w.state()
    expect([fate(w, tj.id), fate(w, tu.id), S.facts.upgraded, S.facts.mem.has('X')]).toEqual([
      'X',
      'X',
      [],
      false,
    ])
    expect(
      props(w, {
        kind: 'left',
        x: 'X',
        thief: [tj.id, tu.id],
        thiefDevs: ['X2', 'X8'],
        thiefKeys: ['pX0'],
        userRecs: [recDigest(rec1)],
        e2e: true,
        leftOut: true,
      })
    ).toEqual([])
  })
  test("a member with a role leaves and resets elsewhere; the old phrase's reset positioned before the leave only freezes it: no rejoin, no kick", () => {
    const w = lworld('member')
    const reset = { n: 1, prev: cX, by: 'rkX', rk: 'rkX2', pk: 'pX2', keep: ['X1', 'X5'] }
    const { Pb } = leaveAndPost(w, reset, 'rkX2', ['X5'])
    const tr = w.ok(
      'X9',
      'primary_rotate',
      {
        by: 'rkT',
        chain: [{ n: 1, prev: cX, by: 'rkX', rk: 'rkT', pk: 'pT', keep: ['X9'] }],
        keep: [],
        seen: seenOf(w, Pb, ['X1', 'X2']),
      },
      { ap: Pb, ts: t() }
    )
    const tk = w.ok(
      'X9',
      'kick',
      { to: 'C', seen: seenOf(w, [tr.id], ['C1']) },
      { ap: [tr.id], ts: t() }
    )
    w.ok('B1', 'mark', {}, { ts: t() })
    const S = w.state()
    expect([BD(w, 'X')?.void, S.facts.mem.has('X'), fate(w, tk.id), S.facts.mem.has('C')]).toEqual([
      'chain',
      false,
      'X',
      true,
    ])
    expect(
      props(w, {
        kind: 'left',
        x: 'X',
        thief: [tr.id, tk.id],
        thiefDevs: ['X9'],
        thiefKeys: ['rkX', 'rkT', 'pT'],
        leaked: true,
        userRecs: [recDigest(reset)],
        e2e: true,
        leftOut: true,
      })
    ).toEqual([])
  })
  test("a leave made by a device the record drops stands: the rotation's watermark covers it", () => {
    const w = lworld('member')
    const rec = { n: 1, prev: cX, by: 'rkX', pk: 'pX1', keep: ['X1', 'X5'] }
    const { lv, rs } = leaveAndPost(w, rec, 'rkX', ['X5'], 'X2')
    const S = w.state()
    expect([
      fate(w, lv.id),
      S.facts.revoked.has('X2'),
      S.facts.mem.has('X'),
      fate(w, rs[0].id),
    ]).toEqual(['counts', true, false, 'counts'])
    expect(props(w)).toEqual([])
  })
  test("two of the user's devices in the record's keep post it at the leave's parents: siblings, both in force", () => {
    const w = lworld('coowner')
    const rec = { n: 1, prev: cX, by: 'rkX', pk: 'pX1', keep: ['X1', 'X5', 'X7'] }
    const { rs } = leaveAndPost(w, rec, 'pX1', ['X5', 'X7'])
    expect(w.act('X2', 'join', {}, { ts: t() }).v.s).toBe('R')
    const S = w.state()
    expect([
      fate(w, rs[0].id),
      fate(w, rs[1].id),
      S.facts.revoked.has('X2'),
      S.facts.mem.has('X'),
    ]).toEqual(['counts', 'counts', true, false])
    expect(props(w)).toEqual([])
  })
  test("a member removed by a kick: the rotation at the kick's parents turns a later re-add that names no head into a refusal for the stolen device", () => {
    const w = lworld('member')
    const kp = w.heads()
    w.ok('A1', 'kick', { to: 'X', seen: seenOf(w, kp, ['X1', 'X2']) }, { ap: kp, ts: t() })
    w.ok(
      'X5',
      'primary_rotate',
      { by: 'rkX', chain: [rec1], keep: ['X1'], seen: seenOf(w, kp, ['X2']) },
      { ap: kp, ts: t() }
    )
    w.ok('B1', 'mark', {}, { ts: t() })
    w.ok('A1', 'add', { to: 'X' }, { ts: t() }) // an owner's re-add naming no head
    expect(w.act('X2', 'join', {}, { ts: t() }).v.s).toBe('R')
    expect(w.act('X8', 'join', { by: 'pX0' }, { ts: t() }).v).toEqual({ s: 'R', why: 'sig' })
    expect(w.state().facts.mem.has('X')).toBe(false)
    expect(props(w)).toEqual([])
  })
})

describe('an identity frozen at an upgrade, same-n heads in an add, links, a rival flood', () => {
  const crV = crDigest('V', 'rkV', 'p0')
  /** a rules-3 server with owner O, members Vch, B, C, T; V protected (rkV, p0) with V1 and V2 */
  const pworld = () => {
    T = 0
    const w = new World()
    w.genesis('O1', ['O'], 0, 0, { rules: 3, limits: { devCap: 4, poolU: 60 } })
    w.ok('O2', 'device_add', {}, { ts: t() })
    for (const m of ['Vch', 'B', 'C', 'T']) {
      w.ok('O1', 'add', { to: m }, { ts: t() })
      w.ok(`${m}1`, 'join', {}, { ts: t() })
    }
    w.ok('O1', 'add', { to: 'V' }, { ts: t() })
    w.ok('V1', 'join', { rk: 'rkV' }, { ts: t() })
    w.ok('V2', 'device_add', {}, { ts: t() })
    w.ok('O1', 'mark', {}, { ts: t() })
    return w
  }
  const reset = { n: 1, prev: crV, by: 'rkV', rk: 'rkV2', pk: 'pV2', keep: ['V1'] }
  const rival = { n: 1, prev: crV, by: 'rkV', rk: 'rkZ', pk: 'pZ', keep: ['V9'] }
  test("an identity frozen in B(u) is no member there: migrate doesn't carry it and the carry-over posts no add for it, so nobody joins S' as it (mutant rk-migrate-frozen)", () => {
    const w = pworld()
    const P0 = w.heads()
    w.ok(
      'V1',
      'primary_rotate',
      { by: 'rkV2', chain: [reset], keep: [], seen: seenOf(w, P0, ['V2']) },
      { ts: t() }
    )
    w.ok('B1', 'mark', {}, { ts: t() })
    w.ok(
      'V9',
      'primary_rotate',
      { by: 'pZ', chain: [rival], keep: [], seen: seenOf(w, P0, ['V1', 'V2']) },
      { ap: P0, ts: t() }
    )
    w.ok('B1', 'mark', {}, { ts: t() })
    // the upgrade positioned on every head: its past holds both resets (an honest client's position never cites the
    // rival, and then V is carried at its reset's head, which the thief's join can't reach)
    const u = w.ok('O1', 'upgrade', { g: 'Gf', sigs: { O: {} } }, { ap: w.heads(), ts: t() })
    const Su = w.ref.rec(u.id).local
    expect([Su.BD?.get('V')?.void, Su.facts.mem.has('V'), w.state().facts.upgraded]).toEqual([
      'chain',
      false,
      [u.id],
    ])
    const entries = projectMembers(Su)
    expect(entries.map(x => x.ik)).toEqual(['B', 'C', 'T', 'Vch'])
    expect(props(w)).toEqual([])
    T = 0
    const s2 = new World()
    s2.genesis('R1', ['R'], 0, 0, { rules: 3, from: 'S', limits: { devCap: 4, poolU: 60 } })
    s2.ok('R1', 'migrate', { chunk: { kind: 'members', list: entries } }, { ts: t() })
    for (const x of entries) {
      s2.ok('R1', 'add', { to: x.ik, ...(x.heads.length ? { head: x.heads[0] } : {}) }, { ts: t() })
      s2.ok(`${x.ik}1`, 'join', {}, { ts: t() })
    }
    expect(s2.act('V9', 'join', { rk: 'rkV', chain: [rival], by: 'pZ' }, { ts: t() }).v).toEqual({
      s: 'R',
      why: 'auth',
    })
    expect(s2.act('V1', 'join', { rk: 'rkV', chain: [reset], by: 'pV2' }, { ts: t() }).v).toEqual({
      s: 'R',
      why: 'auth',
    })
    expect([s2.state().facts.mem.has('V'), devs(s2, 'V')]).toEqual([false, []])
    expect(props(s2)).toEqual([])
  })
  test("an add naming the other one of two same-n records reaches the user's reconciled chain: a join carrying both and the reconciling record is admitted (mutant rk-reach-desc)", () => {
    const r1a = { n: 1, prev: crV, by: 'rkV', pk: 'pVa', keep: ['V1'] },
      r1b = { n: 1, prev: crV, by: 'rkV', pk: 'pVb', keep: ['V5'] }
    const r2 = { n: 2, prev: recDigest(r1a), by: 'rkV', pk: 'pV2', keep: ['V1', 'V5'] }
    T = 0
    const w = new World()
    w.genesis('O1', ['O'], 0, 0, { rules: 3, limits: { devCap: 4, poolU: 60 } })
    for (const m of ['B', 'C']) {
      w.ok('O1', 'add', { to: m }, { ts: t() })
      w.ok(`${m}1`, 'join', {}, { ts: t() })
    }
    w.ok('O1', 'add', { to: 'V', head: recDigest(r1b) }, { ts: t() }) // the inviter knew r1b only
    expect(w.act('V1', 'join', { rk: 'rkV', chain: [r1a, r2], by: 'pV2' }, { ts: t() }).v).toEqual({
      s: 'R',
      why: 'rk',
    })
    const j = w.act('V1', 'join', { rk: 'rkV', chain: [r1a, r1b, r2], by: 'pV2' }, { ts: t() })
    expect([j.v, BD(w, 'V')?.prim]).toEqual([{ s: 'A' }, ['pV2']])
    expect(props(w)).toEqual([])
  })
  test('a frozen identity gets no link, also a fresh device once an owner invites it again (mutant rk-link-frozen)', () => {
    const w = pworld()
    const P0 = w.heads()
    w.ok(
      'V1',
      'primary_rotate',
      { by: 'rkV2', chain: [reset], keep: [], seen: seenOf(w, P0, ['V2']) },
      { ts: t() }
    )
    w.ok(
      'V9',
      'primary_rotate',
      { by: 'pZ', chain: [rival], keep: [], seen: seenOf(w, P0, ['V1', 'V2']) },
      { ap: P0, ts: t() }
    )
    w.ok('B1', 'mark', {}, { ts: t() })
    w.ok('O1', 'add', { to: 'V' }, { ap: w.heads(), ts: t() }) // at a position that knows V is frozen (no member)
    const S = w.state()
    expect([BD(w, 'V')?.void, S.facts.pending.has('V')]).toEqual(['chain', true])
    expect([
      linkOf(S, w.ref, w.ref.order, 'V', 'V7'),
      linkOf(S, w.ref, w.ref.order, 'V', 'V7', 'pV2'),
      linkOf(S, w.ref, w.ref.order, 'V', 'V1'),
      linkOf(S, w.ref, w.ref.order, 'V', 'V9'),
    ]).toEqual(['none', 'none', 'none', 'none'])
    expect(props(w)).toEqual([])
  })
  test("links are server-local for a legacy identity: a thief's made-up creation record in one server doesn't touch the legacy user's links in another", () => {
    // server 1: the thief holding L's ik joined first with a creation record it made; L never posted there
    T = 0
    const s1 = new World()
    s1.genesis('O1', ['O'], 0, 0, { rules: 3 })
    for (const m of ['B', 'C']) {
      s1.ok('O1', 'add', { to: m }, { ts: t() })
      s1.ok(`${m}1`, 'join', {}, { ts: t() })
    }
    s1.ok('O1', 'add', { to: 'L' }, { ts: t() })
    s1.ok('L9', 'join', { rk: 'rkZ', pk: 'pZ', by: 'pZ' }, { ts: t() })
    // server 2: the legacy user's own devices (ik-signed), no creation record
    const s2 = new World()
    s2.genesis('P1', ['P'], 0, 0, { rules: 3 })
    for (const m of ['B', 'C']) {
      s2.ok('P1', 'add', { to: m }, { ts: t() })
      s2.ok(`${m}1`, 'join', {}, { ts: t() })
    }
    s2.ok('P1', 'add', { to: 'L' }, { ts: t() })
    s2.ok('L1', 'join', {}, { ts: t() })
    s2.ok('L2', 'device_add', { by: 'ik' }, { ts: t() })
    const S1 = s1.state(),
      S2 = s2.state()
    expect([S1.BD?.get('L')?.st, S2.BD?.get('L')]).toEqual(['protected', undefined])
    expect([
      linkOf(S2, s2.ref, s2.ref.order, 'L', 'L1'),
      linkOf(S2, s2.ref, s2.ref.order, 'L', 'L2'),
      linkOf(S2, s2.ref, s2.ref.order, 'L', 'L9'),
    ]).toEqual(['full', 'full', 'none'])
    expect(linkOf(S1, s1.ref, s1.ref.order, 'L', 'L1')).toBe('none')
    expect([props(s1), props(s2)]).toEqual([[], []])
  })
  test('a flood of rival resets from fresh devices at one old position: all in X, none cited by honest members, V frozen', () => {
    const w = pworld()
    const P0 = w.heads()
    w.ok(
      'V1',
      'primary_rotate',
      { by: 'rkV2', chain: [reset], keep: [], seen: seenOf(w, P0, ['V2']) },
      { ts: t() }
    )
    w.ok('B1', 'mark', {}, { ts: t() })
    const flood: string[] = []
    for (let i = 0; i < 40; i++)
      flood.push(
        w.ok(
          `V${20 + i}`,
          'primary_rotate',
          {
            by: `pF${i}`,
            chain: [
              { n: 1, prev: crV, by: 'rkV', rk: `rkF${i}`, pk: `pF${i}`, keep: [`V${20 + i}`] },
            ],
            keep: [],
            seen: seenOf(w, P0, ['V1', 'V2']),
          },
          { ap: P0, ts: t() }
        ).id
      )
    const m = w.ok('Vch1', 'mark', {}, { ts: t() })
    w.ok('B1', 'mark', {}, { ts: t() })
    const S = w.state()
    expect([
      BD(w, 'V')?.void,
      flood.every(x => S.X.has(x)),
      flood.some(x => w.ref.anc(m.id).has(x)),
      w.frozenIn('V'),
    ]).toEqual(['chain', true, false, true])
    expect(props(w)).toEqual([])
  })
})
