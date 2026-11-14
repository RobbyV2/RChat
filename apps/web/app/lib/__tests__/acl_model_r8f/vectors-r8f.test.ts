/* eslint-disable */
// @ts-nocheck
// Copy of notes/acl-model-r8f/vectors-r8f.test.ts (the executable reference model of the P2P ACL spec r8f), used only by tests.
import { setDefaultTimeout } from 'bun:test'
setDefaultTimeout(120_000)
// Revision 8 fix round 5 vectors (§7.6 "r8f"; dispatch `spec-r8f-dispatch.md`): the client model's postings (ruling 1:
// client.ts), transfers and recovery (ruling 2: an upgrade dies only through rk-signed carriers; r8e attack review C1),
// servers left and archived (ruling 3: the recorded leave, the precedence, the trusted position, the keep without the
// poster, the fallback poster; r8e attack review C2, I1, I2, completeness review C2, M1), links (ruling 4: the push link;
// attack review I3, completeness review C1) and a rejoin that revives no roles (ruling 6; attack review I5). Each world
// built here also runs the exact G5 oracle and O13-fast (vectors-hook.ts).
import { describe, expect, test } from 'bun:test'
import { World } from './world'
import { KICK, BAN, INVITE, crDigest, recDigest, linkOf, pushOk, devOwner } from './model'
import { Client } from './client'
import type { B3Meta } from './gen'
import { oracleAfterEach } from './vectors-hook'
import { checkCase } from './props'

oracleAfterEach()
let T = 0
const t = () => (T += 4)
const props = (w: World, b3?: B3Meta) =>
  checkCase({ w, equivocation: true, seed: 1, adversarial: [], ...(b3 ? { b3 } : {}) }).map(
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
  return !w.ref.admitted(id) ? 'refused' : S.X.has(id) ? 'X' : S.tail.has(id) ? 'Tail' : 'counts'
}
const L = (w: World, ik: string, dk: string, by?: string, keys?: any[]) =>
  linkOf(w.state(), w.ref, w.ref.order, ik, dk, by, keys)
/** the user's client on a world, with the vector clock */
const client = (ik: string, cr: { rk: string; pk: string }, devices: string[], w: World) => {
  const c = new Client(ik, cr, devices)
  c.clock = t
  c.wait = n => {
    T += n
  }
  for (const id of w.ref.order) if (w.ref.ev(id).a === ik) c.srv(w).own.add(id)
  return c
}
/** the b3 meta the client adds (as gen.ts's templates do) */
const cmeta = (c: Client, w: World) => {
  const m = c.meta(w)
  return {
    postings: m.postings,
    ...(m.leftAt ? { leftAt: m.leftAt, leftDrops: m.leftDrops } : {}),
    keepUp: m.keepUp,
  }
}

const cX = crDigest('X', 'rkX', 'pX0')
/** X protected (rkX, pX0) with X1 and X2 (X2 certified by pX0): the single owner, or a member of A's server with a Kick
 * role; members B and C */
function xworld(member: boolean) {
  T = 0
  const w = new World()
  w.genesis(member ? 'A1' : 'X1', [member ? 'A' : 'X'], 0, 0, {
    rules: 3,
    limits: { devCap: 4, poolU: 60 },
    rks: member ? {} : { X: { rk: 'rkX', pk: 'pX0' } },
  })
  let R = ''
  if (member) {
    w.ok('A1', 'add', { to: 'X' }, { ts: t() })
    w.ok('X1', 'join', { rk: 'rkX', pk: 'pX0', by: 'pX0' }, { ts: t() })
    R = w.ok('A1', 'role_create', { pos: 3, bits: KICK }, { ts: t() }).id
    w.ok('A1', 'assign', { to: 'X', role: R }, { ts: t() })
  }
  w.ok('X2', 'device_add', { by: 'pX0' }, { ts: t() })
  for (const m of ['B', 'C']) {
    w.ok(member ? 'A1' : 'X1', 'add', { to: m }, { ts: t() })
    w.ok(`${m}1`, 'join', {}, { ts: t() })
  }
  w.ok('X1', 'mark', {}, { ts: t() })
  w.ok('X2', 'mark', {}, { ts: t() })
  const cl = client('X', { rk: 'rkX', pk: 'pX0' }, ['X1', 'X2'], w)
  return { w, R, cl }
}

describe("r8f ruling 1 and 3: the client's posting in a server it left goes at the recorded leave, whatever the server shows later (r8e attack review C2; R8-left-thief-*)", () => {
  for (const leaver of ['X1', 'X2'])
    for (const tdev of ['X2', 'X8'])
      for (const after of ['leaves', 'stays'] as const)
        test(`R8-left-thief-${after}: the owner left from ${leaver}; the thief (${tdev}) rejoins, kicks, transfers${after === 'leaves' ? ' and leaves again' : ''} before the posting; the client posts at the recorded leave`, () => {
          const { w, cl } = xworld(false)
          const lv = cl.leave(w, leaver, { ts: t() }).e
          w.ok('B1', 'mark', {}, { ts: t() })
          cl.lose('X2')
          const tj = w.ok(tdev, 'join', { by: 'pX0' }, { ts: t() })
          const tk = w.ok(
            tdev,
            'kick',
            { to: 'C', seen: seenOf(w, w.heads(), ['C1']) },
            { ts: t() }
          )
          const tu = w.ok(tdev, 'upgrade', { g: 'Gt', sigs: { X: { by: 'pX0' } } }, { ts: t() })
          const tl = after === 'leaves' ? w.ok(tdev, 'leave', {}, { ts: t() }) : undefined
          expect(w.state().facts.upgraded).toEqual([tu.id]) // the thief's transfer counts before the posting
          const rec = cl.recover({ maker: 'X5', keep: ['X1', 'X5'], pk: 'pXr', worlds: [w] })
          const [r] = cl.post(w)
          cl.endFlow()
          w.ok('B1', 'mark', {}, { ts: t() })
          const S = w.state()
          // the posting sits at the parents of the recorded leave, signed by the recovery key (X is a genesis owner)
          expect([
            r.v,
            r.link,
            r.e.ap.every(
              (p: string) =>
                lv.ap.includes(p) || w.ref.anc(lv.id).has(p) || p === w.latestOwn('X5')?.id
            ),
            r.e.c.by,
          ]).toEqual([{ s: 'A' }, 'push', true, 'rkX'])
          expect([
            fate(w, tj.id),
            fate(w, tk.id),
            S.facts.mem.has('C'),
            S.facts.upgraded,
            S.facts.mem.has('X'),
            fate(w, lv.id),
          ]).toEqual([
            tdev === 'X2' ? 'Tail' : 'X',
            tdev === 'X2' ? 'Tail' : 'X',
            true,
            [],
            false,
            'counts',
          ])
          expect(
            props(w, {
              kind: 'left',
              x: 'X',
              V1: 'X5',
              V2: 'X2',
              r: r.e.id,
              rDrops: ['X2'],
              thief: [tj.id, tk.id, tu.id, ...(tl ? [tl.id] : [])],
              thiefDevs: [tdev],
              thiefKeys: ['pX0'],
              userRecs: [recDigest(rec)],
              e2e: true,
              leftOut: true,
              ...cmeta(cl, w),
            })
          ).toEqual([])
        })
  test('R8-left-removed-twice: X kicked; a re-add naming no head; the thief rejoins, gets the role back, kicks C; X kicked again; the client recorded the first removal and posts there', () => {
    const { w, R, cl } = xworld(true)
    w.ok('A1', 'kick', { to: 'X', seen: seenOf(w, w.heads(), ['X1', 'X2']) }, { ts: t() })
    cl.sync(w)
    const first = cl.srv(w).left!
    cl.lose('X2')
    w.ok('A1', 'add', { to: 'X' }, { ts: t() })
    const tj = w.ok('X2', 'join', { by: 'pX0' }, { ts: t() })
    w.ok('A1', 'assign', { to: 'X', role: R }, { ts: t() })
    const tk = w.ok('X2', 'kick', { to: 'C', seen: seenOf(w, w.heads(), ['C1']) }, { ts: t() })
    w.ok('A1', 'kick', { to: 'X', seen: seenOf(w, w.heads(), ['X1', 'X2']) }, { ts: t() })
    cl.sync(w)
    expect(cl.srv(w).left).toBe(first) // the recorded removal never moves
    const rec = cl.recover({ maker: 'X5', keep: ['X1', 'X5'], pk: 'pXr', worlds: [w] })
    cl.endFlow()
    const [r] = cl.post(w)
    expect([r.v, r.e.c.by]).toEqual([{ s: 'A' }, 'pXr']) // the sweep without the phrase: an extension (X is no owner)
    const S = w.state()
    expect([fate(w, tj.id), fate(w, tk.id), S.facts.mem.has('C')]).toEqual(['Tail', 'Tail', true])
    expect(
      props(w, {
        kind: 'left',
        x: 'X',
        V1: 'X5',
        V2: 'X2',
        r: r.e.id,
        rDrops: ['X2'],
        thief: [tj.id, tk.id],
        thiefDevs: ['X2'],
        thiefKeys: ['pX0'],
        userRecs: [recDigest(rec)],
        e2e: true,
        ...cmeta(cl, w),
      })
    ).toEqual([])
  })
  test('R8-left-kept-poster (r8e completeness review C2): X2 made the leave; X1 (kept, live in S) posts at its parents with a keep that leaves itself out; the literal keep [X1] is refused', () => {
    const { w, cl } = xworld(true)
    const lvPar = w.heads()
    const lv = cl.leave(w, 'X2', { ap: lvPar, ts: t() }).e
    w.ok('B1', 'mark', {}, { ts: t() })
    cl.lose('X2')
    const rec = cl.recover({ maker: 'X1', keep: ['X1'], pk: 'pX1', worlds: [w] })
    // the literal keep of §1.7 r8e: refused (§1.4: dev ∉ keep)
    expect(
      w.act(
        'X1',
        'primary_rotate',
        {
          by: 'rkX',
          chain: [rec],
          keep: ['X1'],
          seen: { X2: Math.max(maxSeq(w, lvPar, 'X2'), lv.seq) },
        },
        { ap: lvPar, ts: t() }
      ).v
    ).toEqual({ s: 'R', why: 'auth' })
    const [r] = cl.post(w)
    cl.endFlow()
    w.ok('A1', 'add', { to: 'X' }, { ts: t() })
    expect(w.act('X2', 'join', {}, { ts: t() }).v.s).toBe('R')
    expect(w.act('X8', 'join', { by: 'pX0' }, { ts: t() }).v.s).toBe('R')
    const S = w.state()
    expect([
      r.e.dev,
      r.e.c.keep,
      fate(w, r.e.id),
      fate(w, lv.id),
      S.facts.revoked.has('X2'),
      S.facts.mem.has('X'),
      devs(w, 'X'),
    ]).toEqual(['X1', [], 'counts', 'counts', true, false, ['X1']])
    expect(
      props(w, {
        kind: 'left',
        x: 'X',
        V1: 'X1',
        V2: 'X2',
        r: r.e.id,
        rDrops: ['X2'],
        thief: [],
        thiefDevs: ['X2', 'X8'],
        thiefKeys: ['pX0'],
        userRecs: [recDigest(rec)],
        e2e: true,
        leftOut: true,
        ...cmeta(cl, w),
      })
    ).toEqual([])
  })
  test('R8-left-fallback (r8e completeness review M1): X1 made the leave and recovers on its own: the record also keeps a fresh posting device, which posts signed by the recovery key and stays trusted', () => {
    const { w, cl } = xworld(false)
    const lv = cl.leave(w, 'X1', { ts: t() }).e
    w.ok('B1', 'mark', {}, { ts: t() })
    cl.lose('X2')
    const rec = cl.recover({ maker: 'X1', keep: ['X1'], pk: 'pXr', worlds: [w] })
    expect(rec.keep).toEqual(['X1', 'X11'])
    const [r] = cl.post(w)
    cl.endFlow()
    const tj = w.act('X8', 'join', { by: 'pX0' }, { ts: t() })
    const S = w.state()
    expect([
      r.e.dev,
      r.e.c.by,
      r.e.c.keep,
      fate(w, r.e.id),
      fate(w, lv.id),
      tj.v.s,
      S.facts.mem.has('X'),
    ]).toEqual(['X11', 'rkX', ['X1'], 'counts', 'counts', 'R', false])
    expect(
      props(w, {
        kind: 'left',
        x: 'X',
        V1: 'X11',
        V2: 'X2',
        r: r.e.id,
        rDrops: ['X2'],
        thief: [],
        thiefDevs: ['X2', 'X8'],
        thiefKeys: ['pX0'],
        userRecs: [recDigest(rec)],
        e2e: true,
        leftOut: true,
        ...cmeta(cl, w),
      })
    ).toEqual([])
  })
})

describe("r8f ruling 1: the flow over every server, the recorded leave that never moves, the user's own rejoin, one client per identity", () => {
  test("R8-left-second-leave: the thief rejoined as the owner and kicked C; the user's device leaves again; the recorded leave stays the first, and the posting there cuts the thief (mutant cl-left-moves)", () => {
    const { w, cl } = xworld(false)
    const lv = cl.leave(w, 'X1', { ts: t() }).e
    w.ok('B1', 'mark', {}, { ts: t() })
    cl.lose('X2')
    const tj = w.ok('X2', 'join', { by: 'pX0' }, { ts: t() })
    const tk = w.ok('X2', 'kick', { to: 'C', seen: seenOf(w, w.heads(), ['C1']) }, { ts: t() })
    // the server shows X as a member again (the thief's rejoin), and the user's X1 leaves it once more
    const lv2 = cl.leave(w, 'X1', { ts: t() })
    expect([lv2.v, cl.srv(w).left === lv.id]).toEqual([{ s: 'A' }, true])
    const rec = cl.recover({ maker: 'X5', keep: ['X1', 'X5'], pk: 'pXr', worlds: [w] })
    const [r] = cl.flow([w])
    const S = w.state()
    expect([r.v, r.link, w.ref.anc(r.e.id).has(lv.id), w.ref.anc(r.e.id).has(tj.id)]).toEqual([
      { s: 'A' },
      'push',
      false,
      false,
    ])
    expect([
      fate(w, tj.id),
      fate(w, tk.id),
      S.facts.mem.has('C'),
      S.facts.mem.has('X'),
      fate(w, lv.id),
    ]).toEqual(['Tail', 'Tail', true, false, 'counts'])
    expect(
      props(w, {
        kind: 'left',
        x: 'X',
        V1: 'X5',
        V2: 'X2',
        r: r.e.id,
        rDrops: ['X2'],
        thief: [tj.id, tk.id],
        thiefDevs: ['X2'],
        thiefKeys: ['pX0'],
        userRecs: [recDigest(rec)],
        e2e: true,
        leftOut: true,
        ...cmeta(cl, w),
      })
    ).toEqual([])
  })
  test("R8-left-rejoin: the owner left; the thief rejoined, kicked C and left again; a member invites the owner back; the user recovers and rejoins: the rotation at the recorded leave first, then its join over the pending identity's ACL-only link; the entry leaves the list (mutant cl-rejoin-first)", () => {
    const { w, cl } = xworld(false)
    const RI = w.ok('X1', 'role_create', { pos: 2, bits: INVITE }, { ts: t() }).id
    w.ok('X1', 'assign', { to: 'B', role: RI }, { ts: t() })
    const lv = cl.leave(w, 'X1', { ts: t() }).e
    w.ok('B1', 'mark', {}, { ts: t() })
    cl.lose('X2')
    // a genesis owner that left has no link of its own (its join needs no add to be admitted, but it needs a way in)
    expect([L(w, 'X', 'X1'), L(w, 'X', 'X2'), L(w, 'X', 'X8', 'pX0')]).toEqual([
      'none',
      'none',
      'none',
    ])
    // the thief's events reach the server through an accomplice member; it rejoins, kicks C and leaves again
    const tj = w.ok('X2', 'join', { by: 'pX0' }, { ts: t() })
    const tk = w.ok('X2', 'kick', { to: 'C', seen: seenOf(w, w.heads(), ['C1']) }, { ts: t() })
    const tl = w.ok('X2', 'leave', {}, { ts: t() })
    w.ok('B1', 'add', { to: 'X' }, { ts: t() })
    // pending: an ACL-only link whatever the device (the stolen one too, until the posting: N26 (k))
    expect([L(w, 'X', 'X1'), L(w, 'X', 'X2'), L(w, 'X', 'X9')]).toEqual(['acl', 'acl', 'acl'])
    const rec = cl.recover({ maker: 'X5', keep: ['X1', 'X5'], pk: 'pXr', worlds: [w] })
    const res = cl.rejoin(w)
    cl.endFlow()
    const rot = res.find(x => x.e.t === 'primary_rotate'),
      j = res.find(x => x.e.t === 'join')
    const S = w.state()
    expect([
      rot?.v,
      rot?.e.c.by,
      w.ref.anc(rot!.e.id).has(tj.id),
      j?.v,
      j?.link,
      j?.p.bullet,
      cl.srv(w).rejoined === j?.e.id,
    ]).toEqual([{ s: 'A' }, 'rkX', false, { s: 'A' }, 'acl', 'rejoin', true])
    expect([
      fate(w, tj.id),
      fate(w, tk.id),
      fate(w, tl.id),
      S.facts.mem.has('C'),
      S.facts.mem.has('X'),
      devs(w, 'X'),
      L(w, 'X', 'X2'),
      L(w, 'X', 'X5'),
    ]).toEqual(['Tail', 'Tail', 'Tail', true, true, ['X1', 'X5'], 'none', 'full'])
    // a later recovery goes on the trusted heads (the member bullet): the entry left the list
    const rec2 = cl.recover({ maker: 'X5', keep: ['X5'], pk: 'pXr2', worlds: [w] })
    const [r2] = cl.flow([w])
    expect([r2.v, r2.p.bullet, r2.e.c.by, devs(w, 'X')]).toEqual([
      { s: 'A' },
      'member',
      'rkX',
      ['X5'],
    ])
    expect(
      props(w, {
        kind: 'left',
        x: 'X',
        V1: 'X5',
        V2: 'X2',
        thief: [tj.id, tk.id, tl.id],
        thiefDevs: ['X2'],
        thiefKeys: ['pX0'],
        userRecs: [recDigest(rec), recDigest(rec2)],
        e2e: true,
        memberAt: w.ref.order.length,
        ...cmeta(cl, w),
      })
    ).toEqual([])
  })
  test("R8-flow-servers: one flow posts in every server whose state holds the identity, the owned server first and signed by the recovery key; a stolen old device's backdated transfer there is inert (mutant cl-flow-order)", () => {
    T = 0
    const cr = { rk: 'rkV', pk: 'p0' }
    // S1: V is the single genesis owner; S2: V is a member; S3: V was a member and left
    const mk = (owner: boolean) => {
      const w = new World()
      w.genesis(owner ? 'V1' : 'O1', [owner ? 'V' : 'O'], 0, 0, {
        rules: 3,
        limits: { devCap: 4, poolU: 60 },
        rks: owner ? { V: cr } : {},
      })
      if (!owner) {
        w.ok('O1', 'add', { to: 'V' }, { ts: t() })
        w.ok('V1', 'join', { rk: 'rkV' }, { ts: t() })
      }
      w.ok('V2', 'device_add', owner ? { by: 'p0' } : {}, { ts: t() })
      for (const m of ['B', 'C']) {
        w.ok(owner ? 'V1' : 'O1', 'add', { to: m }, { ts: t() })
        w.ok(`${m}1`, 'join', {}, { ts: t() })
      }
      return w
    }
    const s1 = mk(true),
      s2 = mk(false),
      s3 = mk(false)
    const cl = new Client('V', cr, ['V1', 'V2'])
    cl.clock = t
    cl.wait = n => {
      T += n
    }
    for (const w of [s1, s2, s3])
      for (const id of w.ref.order) if (w.ref.ev(id).a === 'V') cl.srv(w).own.add(id)
    const lv = cl.leave(s3, 'V1', { ts: t() }).e
    const P1 = s1.heads()
    s1.ok('B1', 'mark', {}, { ts: t() })
    cl.lose('V2')
    const rec = cl.recover({ maker: 'V1', keep: ['V1'], pk: 'pV1', worlds: [s1, s2, s3] })
    expect(rec.keep).toEqual(['V1', 'V11']) // S3: V1 made the leave, so the record keeps a fresh posting device
    const res = cl.flow([s3, s2, s1])
    expect(res.map(x => [x.p.srv, x.p.bullet, x.link, x.e.c.by, x.v.s, x.e.dev])).toEqual([
      ['S0', 'member', 'full', 'rkV', 'A', 'V1'],
      ['S2', 'left', 'push', 'rkV', 'A', 'V11'],
      ['S1', 'member', 'full', 'rkV', 'A', 'V1'],
    ])
    expect([cl.phrase, w3left(s3, lv.id)]).toEqual([false, true])
    // the stolen V2, with the epoch-0 primary, backdates its own transfer of S1 to before the posting: inert, since the
    // owner's carrier is signed by the recovery key (as an extension it would count: ruling 2's client rule)
    const tu = s1.act('V2', 'upgrade', { g: 'Gt', sigs: { V: { by: 'p0' } } }, { ap: P1, ts: t() })
    expect([tu.v.s, s1.state().facts.upgraded, fate(s1, tu.e.id)]).toEqual(['A', [], 'X'])
    // the sweep finds nothing left to post
    expect(cl.sweepAll([s1, s2, s3])).toEqual([])
    for (const w of [s1, s2, s3]) expect(props(w)).toEqual([])
    function w3left(w: World, id: string) {
      const S = w.state()
      return !S.facts.mem.has('V') && S.eff.has(id) && S.facts.revoked.has('V2')
    }
  })
  test("R8-client-per-identity: one app runs two identities of its user in one server, each with its own client: V's flow posts V's record only, and W's devices, links and chain are untouched", () => {
    T = 0
    const w = new World()
    w.genesis('O1', ['O'], 0, 0, { rules: 3, limits: { devCap: 4, poolU: 60 } })
    for (const [ik, rk] of [
      ['V', 'rkV'],
      ['W', 'rkW'],
    ] as const) {
      w.ok('O1', 'add', { to: ik }, { ts: t() })
      w.ok(`${ik}1`, 'join', { rk }, { ts: t() })
      w.ok(`${ik}2`, 'device_add', {}, { ts: t() })
    }
    const clV = client('V', { rk: 'rkV', pk: 'p0' }, ['V1', 'V2'], w),
      clW = client('W', { rk: 'rkW', pk: 'p0' }, ['W1', 'W2'], w)
    clV.lose('V2')
    const rec = clV.recover({ maker: 'V1', keep: ['V1'], pk: 'pV1', worlds: [w] })
    const res = [...clV.flow([w]), ...clW.sweepAll([w])]
    expect(res.map(x => [x.e.a, x.e.t, x.v.s])).toEqual([['V', 'primary_rotate', 'A']])
    expect([
      clW.phrase,
      clW.recs.length,
      devs(w, 'V'),
      devs(w, 'W'),
      L(w, 'W', 'W1'),
      L(w, 'W', 'W2'),
      L(w, 'V', 'V2'),
      BD(w, 'W')?.chain?.length ?? 0,
    ]).toEqual([false, 0, ['V1'], ['W1', 'W2'], 'full', 'full', 'none', 0])
    expect(
      props(w, {
        kind: 'thief',
        x: 'V',
        V1: 'V1',
        V2: 'V2',
        r: res[0].e.id,
        rDrops: ['V2'],
        thief: [],
        thiefDevs: [],
        thiefKeys: ['p0'],
        userRecs: [recDigest(rec)],
        ...cmeta(clV, w),
      })
    ).toEqual([])
  })
  for (const owner of [true, false])
    test(`R8-older-beside (${owner ? 'a co-owner that never joined' : 'an invited member'}): the old phrase's holder joins as it first, with a recovery of its own; that branch is not on the client's chain (its reset kills it), so the client joins beside it (${owner ? "at that join's parents: an owner needs no add" : 'at the same add'}) instead of rotating at it, and the identity stays a member (mutant cl-older-nojoin)`, () => {
      T = 0
      const w = new World()
      w.genesis('O1', owner ? ['O', 'Q'] : ['O'], 0, 0, {
        rules: 3,
        limits: { devCap: 4, poolU: 60 },
        rks: owner ? { O: { rk: 'rkO', pk: 'pO0' }, Q: { rk: 'rkQ', pk: 'pQ0' } } : {},
      })
      for (const m of ['B', 'C']) {
        w.ok('O1', 'add', { to: m }, { ts: t() })
        w.ok(`${m}1`, 'join', {}, { ts: t() })
      }
      const cQ = crDigest('Q', 'rkQ', 'pQ0')
      const reset = { n: 1, prev: cQ, by: 'rkQ', rk: 'rkQ2', pk: 'pQ2', keep: ['Q1'] }
      const stale = { n: 1, prev: cQ, by: 'rkQ', pk: 'pT', keep: ['Q9'] }
      const cl = client('Q', { rk: 'rkQ', pk: 'pQ0' }, ['Q1'], w)
      const add = owner ? undefined : w.ok('O1', 'add', { to: 'Q' }, { ts: t() })
      const tj = w.ok(
        'Q9',
        'join',
        { rk: 'rkQ', pk: 'pQ0', chain: [stale], by: 'pT' },
        { ...(add ? { ap: [add.id] } : {}), ts: t() }
      )
      const tk = w.ok('Q9', 'mark', {}, { ts: t() })
      cl.adopt(reset as any, 'Q1')
      const res = cl.flow([w])
      const S = w.state()
      // in a server it owns, a carrier signed by the recovery key follows the join at once (a new record, `ownedRk`): a
      // join is signed by the primary, and only a rotation signed by a recovery key kills a backdated upgrade (ruling 2)
      const jn = res[0].e.id
      expect(res.map(x => [x.p.bullet, x.e.t, x.link, x.v?.s, x.e.c.by, x.e.ap])).toEqual([
        ['beside', 'join', 'push', 'A', 'pQ2', add ? [add.id] : tj.ap],
        ...(owner ? [['owned-member', 'primary_rotate', 'full', 'A', 'rkQ2', [jn]]] : []),
      ])
      expect([cl.recs.length, cl.phrase]).toEqual([owner ? 2 : 1, false])
      expect([
        BD(w, 'Q')?.void ?? null,
        S.facts.mem.has('Q'),
        devs(w, 'Q'),
        fate(w, tj.id),
        fate(w, tk.id),
        L(w, 'Q', 'Q9', 'pT', [stale]),
        L(w, 'Q', 'Q1'),
      ]).toEqual([null, true, ['Q1'], 'X', 'X', 'none', 'full'])
      expect(props(w)).toEqual([])
    })
})

describe("r8f ruling 2, the client's side: in a server its identity owns every carrier of its head is a rotation signed by the recovery key (second restart)", () => {
  test("R8-owned-join: the single owner left and its list lost the entry (N26 (j)); it recovers and rejoins through a member's invite, so its join carries the head; a new record signed by the recovery key follows at once, and a stolen old primary's fresh device that rejoins and transfers before that join is inert (mutant cl-owned-join: it counts until the next sweep)", () => {
    for (const viaFlow of [true, false]) {
      const { w, cl } = xworld(false)
      const RI = w.ok('X1', 'role_create', { pos: 2, bits: INVITE }, { ts: t() }).id
      w.ok('X1', 'assign', { to: 'B', role: RI }, { ts: t() })
      cl.leave(w, 'X1', { ts: t() })
      w.ok('B1', 'mark', {}, { ts: t() })
      const before = w.heads()
      cl.lose('X2')
      cl.srv(w).left = undefined // a restore without the list
      const rec = cl.recover({ maker: 'X5', keep: ['X5'], pk: 'pXr', worlds: [w] })
      w.ok('B1', 'add', { to: 'X' }, { ts: t() })
      // in the flow the phrase is at hand; outside it (the state-triggered posting on a later sync) the client asks for it
      if (!viaFlow) cl.endFlow()
      const res = viaFlow ? cl.flow([w]) : cl.post(w)
      cl.endFlow()
      const j = res[0],
        rot = res[res.length - 1]
      expect(res.map(x => [x.e.t, x.p.bullet, x.link, x.v?.s, x.e.c.by])).toEqual([
        ['join', 'join', 'acl', 'A', 'pXr'],
        ['primary_rotate', 'owned-member', 'full', 'A', 'rkX'],
      ])
      // between them, in the join's signing transaction: the revocations at the join of the devices the head neither keeps
      // nor certified (mutant cl-no-revoke: the stolen X2 stays live after the user's rejoin)
      expect(
        cl.postings.filter(p => p.t === 'device_revoke').map(p => [p.bullet, p.link, p.verdict])
      ).toEqual([
        ['revoke', 'full', 'A'],
        ['revoke', 'full', 'A'],
      ])
      expect(
        w.ref.order
          .filter(id => w.ref.ev(id).t === 'device_revoke')
          .map(id => [w.ref.ev(id).c.dev, w.ref.ev(id).dev, w.ref.anc(id).has(j.e.id)])
      ).toEqual([
        ['X1', 'X5', true],
        ['X2', 'X5', true],
      ])
      expect([cl.recs.length, cl.phrase, w.ref.anc(rot.e.id).has(j.e.id)]).toEqual([2, false, true])
      // the stolen primary pX0: a fresh device rejoins as the owner (no invite needed) and transfers, positioned before the
      // user's join. Its join is dead by epoch death through the user's join; the transfer reads only carriers signed by
      // a recovery key (§2.5), which the rotation after the join is
      const tj = w.act('X8', 'join', { by: 'pX0' }, { ap: before, ts: t() })
      const tu = w.act(
        'X8',
        'upgrade',
        { g: 'Gt', sigs: { X: { by: 'pX0' } } },
        { ap: [tj.e.id], ts: t() }
      )
      const S = w.state()
      expect([
        tj.v.s,
        tu.v.s,
        fate(w, tj.id ?? tj.e.id),
        S.facts.upgraded,
        devs(w, 'X'),
        S.facts.mem.has('X'),
      ]).toEqual(['A', 'A', 'X', [], ['X5'], true])
      expect(
        props(w, {
          kind: 'left',
          x: 'X',
          V1: 'X5',
          V2: 'X2',
          thief: [tj.e.id, tu.e.id],
          thiefDevs: ['X2', 'X8'],
          thiefKeys: ['pX0'],
          userRecs: cl.recs.map(r => recDigest(r)),
          e2e: true,
          memberAt: w.ref.order.length,
          ...cmeta(cl, w),
        })
      ).toEqual([])
      expect(recDigest(rec)).not.toEqual(recDigest(cl.head()!))
    }
  })
  test("R8-owned-sigchain: the owner recovers and transfers S before its posting reached S, so its signature carries record 1; the stolen O2's own transfer by pO0, positioned before, counts beside it (disputed) until the client's next sync posts a new record signed by the recovery key (mutant cl-owned-join)", () => {
    const { w, cl } = xworld(false)
    const P0 = w.heads()
    cl.lose('X2')
    const rec1 = cl.recover({ maker: 'X1', keep: ['X1'], pk: 'pXr', worlds: [w] })
    cl.endFlow() // no peer of S was reachable in the flow
    cl.signG(w, 'G1')
    const u = cl.act(
      w,
      'X1',
      'upgrade',
      { g: 'G1', sigs: { X: { by: 'pXr', chain: [rec1] } } },
      { ts: t() }
    )
    const tu = w.act('X2', 'upgrade', { g: 'Gt', sigs: { X: { by: 'pX0' } } }, { ap: P0, ts: t() })
    // only a carrier that is a rotation signed by a recovery key kills an upgrade signature (§2.5): u's own chain doesn't
    expect([u.v.s, tu.v.s, w.state().facts.upgraded.sort()]).toEqual([
      'A',
      'A',
      [u.e.id, tu.e.id].sort(),
    ])
    const res = cl.sweepAll([w])
    const S = w.state()
    expect(
      res.map(x => [
        x.e.t,
        x.p.bullet,
        x.link,
        x.v?.s,
        x.e.c.by,
        w.ref.anc(x.e.id).has(u.e.id),
        w.ref.anc(x.e.id).has(tu.e.id),
      ])
    ).toEqual([['primary_rotate', 'sweep-archived', 'full', 'A', 'rkX', true, false]])
    expect([S.facts.upgraded, fate(w, tu.e.id), cl.recs.length, devs(w, 'X')]).toEqual([
      [u.e.id],
      'X',
      2,
      ['X1'],
    ])
    expect(
      props(w, {
        kind: 'upgrade',
        x: 'X',
        V1: 'X1',
        V2: 'X2',
        r: res[0].e.id,
        rDrops: ['X2'],
        thief: [tu.e.id],
        thiefDevs: [],
        thiefKeys: ['pX0'],
        userRecs: cl.recs.map(r => recDigest(r)),
        ...cmeta(cl, w),
      })
    ).toEqual([])
  })
  test("R8-owned-sweep-signer: outside the flow (the sweep, the phrase no longer in memory) the client's rotation in a server it owns is still signed by the recovery key: it asks for the phrase (mutant cl-owned-ext: an extension, and the stolen O2's backdated transfer counts); in a server it doesn't own the same sweep posts an extension", () => {
    for (const member of [false, true]) {
      const { w, cl } = xworld(member)
      const P0 = w.heads()
      cl.lose('X2')
      cl.recover({ maker: 'X1', keep: ['X1'], pk: 'pXr', worlds: [w] })
      cl.endFlow()
      const sw = cl.sweepAll([w])
      expect(sw.map(x => [x.e.t, x.p.bullet, x.e.c.by, x.v.s])).toEqual([
        ['primary_rotate', 'member', member ? 'pXr' : 'rkX', 'A'],
      ])
      if (!member) {
        const tu = w.act(
          'X2',
          'upgrade',
          { g: 'Gt', sigs: { X: { by: 'pX0' } } },
          { ap: P0, ts: t() }
        )
        expect([tu.v.s, w.state().facts.upgraded]).toEqual(['A', []])
      }
      expect(props(w)).toEqual([])
    }
  })
})

describe('r8f ruling 2: an upgrade dies only through carriers signed by a recovery key (r8e attack review C1; R8-upgrade-later-epoch*)', () => {
  const cO = crDigest('O', 'rkO', 'pO0')
  const oworld = (dadd: boolean) => {
    T = 0
    const w = new World()
    w.genesis('O1', ['O'], 0, 0, {
      rules: 3,
      limits: { devCap: 4, poolU: 60 },
      rks: { O: { rk: 'rkO', pk: 'pO0' } },
    })
    const Pg = w.heads()
    const da = dadd ? w.ok('O2', 'device_add', { by: 'pO0' }, { ts: t() }) : undefined
    for (const m of ['B', 'C']) {
      w.ok('O1', 'add', { to: m }, { ts: t() })
      w.ok(`${m}1`, 'join', {}, { ts: t() })
    }
    w.ok('B1', 'mark', {}, { ts: t() })
    const cl = client('O', { rk: 'rkO', pk: 'pO0' }, ['O1', ...(dadd ? ['O2'] : [])], w)
    return { w, cl, Pg, da }
  }
  for (const dadd of [false, true])
    test(`R8-upgrade-later-epoch${dadd ? '-device' : ''}: the owner transfers S (u ${dadd ? 'from O2, introduced by a device_add signed by pO0' : 'from O1'}), recovers (record 1 keeps O1 and O3); the thief holding O3 posts an extension of record 1 ${dadd ? 'before that device_add' : 'before u'}: u keeps counting (mutants b3-upg-any-carrier, b3-upg-intro-any)`, () => {
      const { w, cl, Pg, da } = oworld(dadd)
      const P0 = w.heads()
      cl.signG(w, 'G1')
      const u = cl.act(
        w,
        dadd ? 'O2' : 'O1',
        'upgrade',
        { g: 'G1', sigs: { O: { by: 'pO0' } } },
        { ts: t() }
      ).e
      const rec1 = cl.recover({ maker: 'O1', keep: ['O1', 'O2', 'O3'], pk: 'pO1', worlds: [w] })
      const [p1] = cl.post(w)
      cl.endFlow()
      expect([p1.v, p1.e.c.by, p1.link]).toEqual([{ s: 'A' }, 'rkO', 'full']) // in the archived S, after u, by the recovery key
      cl.lose('O3')
      const pos = dadd ? Pg : P0
      const ext = w.ok(
        'O3',
        'primary_rotate',
        { by: 'pO1', chain: [rec1], keep: ['O1'], seen: {} },
        { ap: pos, ts: t() }
      )
      const tr = w.ok('O3', 'role_create', { pos: 5, bits: KICK }, { ap: [ext.id], ts: t() })
      const S = w.state()
      expect([fate(w, ext.id), S.facts.upgraded, ...(da ? [fate(w, da.id)] : [])]).toEqual([
        'counts',
        [u.id],
        ...(dadd ? ['X'] : []),
      ])
      // on the heads the thief's acts are refused: S is archived
      expect(
        w.act('O3', 'kick', { to: 'C', seen: seenOf(w, w.heads(), ['C1']) }, { ts: t() }).v
      ).toEqual({ s: 'R', why: 'auth' })
      // the user sees a record it didn't make and recovers again: record 2 on the trusted heads kills the extension
      const rec2 = cl.recover({ maker: 'O1', keep: ['O1', 'O4'], pk: 'pO2', worlds: [w] })
      const [p2] = cl.post(w)
      cl.endFlow()
      const S2 = w.state()
      expect([
        p2.v,
        w.ref.anc(p2.e.id).has(ext.id),
        w.ref.anc(p2.e.id).has(u.id),
        fate(w, ext.id),
        fate(w, tr.id),
        S2.facts.upgraded,
      ]).toEqual([{ s: 'A' }, false, true, 'X', 'X', [u.id]])
      expect(
        props(w, {
          kind: 'upgrade',
          x: 'O',
          thief: [ext.id, tr.id],
          thiefDevs: ['O3'],
          thiefKeys: ['pO1'],
          userRecs: [recDigest(rec1), recDigest(rec2)],
          e2e: true,
          ...cmeta(cl, w),
          mustAdmit: [p1.e.id, p2.e.id],
        })
      ).toEqual([])
    })
  test("R8-upgrade-later-epoch-conflict: the thief's own transfer at its extension, concurrent with u, makes S disputed (the stated residual); the user's next recovery kills it", () => {
    const { w, cl } = oworld(false)
    const P0 = w.heads()
    cl.signG(w, 'G1')
    const u = cl.act(w, 'O1', 'upgrade', { g: 'G1', sigs: { O: { by: 'pO0' } } }, { ts: t() }).e
    const rec1 = cl.recover({ maker: 'O1', keep: ['O1', 'O3'], pk: 'pO1', worlds: [w] })
    cl.post(w)
    cl.endFlow()
    cl.lose('O3')
    const ext = w.ok(
      'O3',
      'primary_rotate',
      { by: 'pO1', chain: [rec1], keep: ['O1'], seen: {} },
      { ap: P0, ts: t() }
    )
    const tu = w.ok(
      'O3',
      'upgrade',
      { g: 'Gt', sigs: { O: { by: 'pO1' } } },
      { ap: [ext.id], ts: t() }
    )
    expect(w.state().facts.upgraded.sort()).toEqual([u.id, tu.id].sort()) // "Ownership transfer disputed" (§6 N4)
    cl.recover({ maker: 'O1', keep: ['O1', 'O4'], pk: 'pO2', worlds: [w] })
    const [p2] = cl.post(w)
    cl.endFlow()
    expect([p2.v, fate(w, tu.id), w.state().facts.upgraded]).toEqual([{ s: 'A' }, 'X', [u.id]])
    expect(props(w)).toEqual([])
  })
  test("R8-upgrade-stolen (fix round 5): the owner's recovery is signed by the recovery key, so the stolen O2's backdated upgrade by pO0 is inert; posted as an extension (the phrase declined) it is not, until the sweep's carrier signed by the recovery key (the stated residual)", () => {
    for (const declined of [false, true]) {
      const { w, cl } = oworld(true)
      const P0 = w.heads()
      cl.lose('O2')
      cl.recover({ maker: 'O1', keep: ['O1'], pk: 'pO1', worlds: [w] })
      if (declined) {
        cl.endFlow()
        cl.declined = true
      }
      const [r] = cl.post(w)
      cl.endFlow()
      const tu = w.ok('O2', 'upgrade', { g: 'Gt', sigs: { O: { by: 'pO0' } } }, { ap: P0, ts: t() })
      expect([r.e.c.by, w.state().facts.upgraded]).toEqual(
        declined ? ['pO1', [tu.id]] : ['rkO', []]
      )
      if (declined) {
        cl.declined = false
        const sw = cl.sweep(w)
        cl.endFlow()
        expect([sw.length, sw[0]?.e.c.by, w.state().facts.upgraded]).toEqual([1, 'rkO', []])
      }
      expect(props(w)).toEqual([])
    }
  })
})

describe('r8f ruling 3: an archived S (r8e attack review I1, I2; R8-upgrade-left-stolen, R8-upgrade-oldphrase-first)', () => {
  const cQ = crDigest('Q', 'rkQ', 'pQ0'),
    cO = crDigest('O', 'rkO', 'pO0')
  const qworld = () => {
    T = 0
    const w = new World()
    w.genesis('O1', ['O', 'Q'], 0, 0, {
      rules: 3,
      limits: { devCap: 4, poolU: 60 },
      rks: { O: { rk: 'rkO', pk: 'pO0' }, Q: { rk: 'rkQ', pk: 'pQ0' } },
    })
    w.ok('Q1', 'join', { rk: 'rkQ', pk: 'pQ0', by: 'pQ0' }, { ts: t() })
    w.ok('Q2', 'device_add', { by: 'pQ0' }, { ts: t() })
    for (const m of ['B', 'C']) {
      w.ok('O1', 'add', { to: m }, { ts: t() })
      w.ok(`${m}1`, 'join', {}, { ts: t() })
    }
    w.ok('B1', 'mark', {}, { ts: t() })
    return w
  }
  for (const at of ['before', 'concurrent'] as const)
    test(`R8-upgrade-left-stolen: co-owner Q leaves ${at === 'before' ? 'before' : 'concurrently with'} the transfer it signs, recovers elsewhere; the thief holding Q2 rejoins and kicks C concurrently with u; the client posts at the frontier of the recorded leave's parents and u (mutant cl-upg-atleave)`, () => {
      const w = qworld()
      const cl = client('Q', { rk: 'rkQ', pk: 'pQ0' }, ['Q1', 'Q2'], w)
      const Pu0 = w.heads()
      const lv = cl.leave(w, 'Q1', { ap: Pu0, ts: t() }).e
      cl.signG(w, 'G1')
      const Pu = at === 'before' ? w.heads() : Pu0
      const u = w.ok(
        'O1',
        'upgrade',
        { g: 'G1', sigs: { O: { by: 'pO0' }, Q: { by: 'pQ0' } } },
        { ap: Pu, ts: t() }
      )
      cl.lose('Q2')
      // the thief as Q, concurrent with u: a rejoin where Q's leave is in its past, then a kick
      const tj =
        at === 'before' ? w.ok('Q2', 'join', { by: 'pQ0' }, { ap: Pu, ts: t() }) : undefined
      const tk = w.ok(
        'Q2',
        'kick',
        { to: 'C', seen: seenOf(w, tj ? [tj.id] : Pu, ['C1']) },
        { ap: tj ? [tj.id] : Pu, ts: t() }
      )
      const rec = cl.recover({ maker: 'Q5', keep: ['Q1', 'Q5'], pk: 'pQr', worlds: [w] })
      const [r] = cl.post(w)
      cl.endFlow()
      const S = w.state()
      expect([
        r.v,
        w.ref.anc(r.e.id).has(u.id),
        S.facts.upgraded,
        tj ? fate(w, tj.id) : 'Tail',
        fate(w, tk.id),
        S.facts.mem.has('Q'),
        fate(w, lv.id),
      ]).toEqual([{ s: 'A' }, true, [u.id], 'Tail', 'Tail', false, 'counts'])
      expect(
        props(w, {
          kind: 'upgrade',
          x: 'Q',
          V1: 'Q5',
          V2: 'Q2',
          r: r.e.id,
          rDrops: ['Q2'],
          thief: [...(tj ? [tj.id] : []), tk.id],
          thiefDevs: ['Q2'],
          thiefKeys: ['pQ0'],
          userRecs: [recDigest(rec)],
          e2e: true,
          leftOut: true,
          ...cmeta(cl, w),
        })
      ).toEqual([])
    })
  for (const flood of [false, true])
    test(`R8-upgrade-oldphrase-first${flood ? ' (a flood on its branch)' : ''}: the old phrase's reset reached the archived S first, on the heads after u; the client posts its reset on the trusted heads from a device that reset doesn't drop: O frozen, the thief's acts inert`, () => {
      T = 0
      const w = new World()
      w.genesis('O1', ['O'], 0, 0, {
        rules: 3,
        limits: { devCap: 4, poolU: 60 },
        rks: { O: { rk: 'rkO', pk: 'pO0' } },
      })
      w.ok('O2', 'device_add', { by: 'pO0' }, { ts: t() })
      for (const m of ['B', 'C']) {
        w.ok('O1', 'add', { to: m }, { ts: t() })
        w.ok(`${m}1`, 'join', {}, { ts: t() })
      }
      const cl = client('O', { rk: 'rkO', pk: 'pO0' }, ['O1', 'O2'], w)
      const P0 = w.heads()
      cl.signG(w, 'G1')
      const u = cl.act(w, 'O1', 'upgrade', { g: 'G1', sigs: { O: { by: 'pO0' } } }, { ts: t() }).e
      const rival = { n: 1, prev: cO, by: 'rkO', rk: 'rkT', pk: 'pT', keep: ['O9'] }
      const thief = [
        w.ok(
          'O9',
          'primary_rotate',
          { by: 'rkT', chain: [rival], keep: [], seen: seenOf(w, w.heads(), ['O1', 'O2']) },
          { ts: t() }
        ).id,
      ]
      let prev: any = rival,
        key = 'rkT'
      if (flood)
        for (let n = 2; n <= 4; n++) {
          const r = { n, prev: recDigest(prev), by: key, rk: `rkT${n}`, pk: `pT${n}`, keep: ['O9'] }
          thief.push(
            w.ok(
              'O9',
              'primary_rotate',
              { by: `rkT${n}`, chain: [r], keep: [], seen: seenOf(w, w.heads(), ['O1', 'O2']) },
              { ts: t() }
            ).id
          )
          prev = r
          key = `rkT${n}`
        }
      // the thief's carrier of its rival before u would kill u by epoch death and revive S as the owner
      const tb = w.ok(
        'O8',
        'primary_rotate',
        { by: 'rkT', chain: [rival], keep: [], seen: seenOf(w, P0, ['O1', 'O2']) },
        { ap: P0, ts: t() }
      )
      thief.push(
        tb.id,
        w.ok('O8', 'kick', { to: 'C', seen: seenOf(w, [tb.id], ['C1']) }, { ap: [tb.id], ts: t() })
          .id
      )
      // as worded in r8e: the maker on the heads is refused (dropped there)
      const reset = cl.recover({
        maker: 'O1',
        keep: ['O1', 'O2'],
        rk: 'rkO2',
        pk: 'pO2',
        worlds: [w],
      })
      expect(
        w.act(
          'O1',
          'primary_rotate',
          { by: 'rkO2', chain: [reset], keep: [], seen: {} },
          { ts: t() }
        ).v.s
      ).toBe('R')
      const [r] = cl.post(w)
      cl.endFlow()
      const S = w.state()
      expect([
        r.v,
        r.link,
        /^O3[1-9]$/.test(r.e.dev),
        w.ref.anc(r.e.id).has(thief[0]),
        BD(w, 'O')?.void,
      ]).toEqual([{ s: 'A' }, 'push', true, false, 'chain'])
      expect([thief.every(x => fate(w, x) !== 'counts'), S.facts.mem.has('C')]).toEqual([
        true,
        true,
      ])
      expect(
        props(w, {
          kind: 'upgrade',
          x: 'O',
          thief,
          thiefDevs: ['O8', 'O9'],
          thiefKeys: ['rkO', 'rkT', 'pT', 'rkT2', 'pT2', 'rkT3', 'pT3', 'rkT4', 'pT4'],
          leaked: true,
          userRecs: [recDigest(reset)],
          e2e: true,
          ...cmeta(cl, w),
          mustAdmit: [r.e.id],
        })
      ).toEqual([])
      void u
    })
  test("R8-member-oldphrase-first: in a live server the old phrase acted first (a plain rotation by the old key, its reset, a plain rotation by its branch key, a kick); the client's reset on the trusted heads freezes V and the kick is inert", () => {
    const crV = crDigest('V', 'rkV', 'p0')
    T = 0
    const w = new World()
    w.genesis('O1', ['O'], 0, 0, { rules: 3, limits: { devCap: 4, poolU: 60 } })
    for (const m of ['B', 'C']) {
      w.ok('O1', 'add', { to: m }, { ts: t() })
      w.ok(`${m}1`, 'join', {}, { ts: t() })
    }
    w.ok('O1', 'add', { to: 'V' }, { ts: t() })
    w.ok('V1', 'join', { rk: 'rkV' }, { ts: t() })
    const R = w.ok('O1', 'role_create', { pos: 3, bits: KICK }, { ts: t() }).id
    w.ok('O1', 'assign', { to: 'V', role: R }, { ts: t() })
    w.ok('B1', 'mark', {}, { ts: t() })
    const cl = client('V', { rk: 'rkV', pk: 'p0' }, ['V1'], w)
    const rival = { n: 1, prev: crV, by: 'rkV', rk: 'rkZ', pk: 'pZ', keep: ['V9'] }
    const thief = [
      w.ok(
        'V7',
        'primary_rotate',
        { by: 'rkV', keep: [], seen: seenOf(w, w.heads(), ['V1']) },
        { ts: t() }
      ).id,
    ]
    thief.push(
      w.ok(
        'V9',
        'primary_rotate',
        { by: 'pZ', chain: [rival], keep: [], seen: seenOf(w, w.heads(), ['V1', 'V7']) },
        { ts: t() }
      ).id
    )
    thief.push(
      w.ok(
        'V26',
        'primary_rotate',
        { by: 'rkZ', keep: [], seen: seenOf(w, w.heads(), ['V1', 'V7', 'V9']) },
        { ts: t() }
      ).id
    )
    thief.push(w.ok('V26', 'kick', { to: 'C', seen: seenOf(w, w.heads(), ['C1']) }, { ts: t() }).id)
    expect(w.state().facts.mem.has('C')).toBe(false)
    const reset = cl.recover({ maker: 'V1', keep: ['V1'], rk: 'rkV2', pk: 'pV2', worlds: [w] })
    const [r] = cl.post(w)
    cl.endFlow()
    const S = w.state()
    expect([
      r.v,
      BD(w, 'V')?.void,
      S.facts.mem.has('C'),
      thief.every(x => fate(w, x) !== 'counts'),
    ]).toEqual([{ s: 'A' }, 'chain', true, true])
    expect(
      props(w, {
        kind: 'leak',
        x: 'V',
        thief,
        thiefDevs: ['V7', 'V9', 'V26'],
        thiefKeys: ['rkV', 'rkZ', 'pZ'],
        leaked: true,
        userRecs: [recDigest(reset)],
        e2e: true,
        ...cmeta(cl, w),
        mustAdmit: [r.e.id],
      })
    ).toEqual([])
  })
  test("R8-succ-oldphrase-flood: B(u) held only the old phrase's reset, so the carry-over's add names that branch; the thief joined S' first and floods its branch with plain rotations; the client's rotation at the thief's introduction freezes V there", () => {
    const crV = crDigest('V', 'rkV', 'p0')
    const rival = { n: 1, prev: crV, by: 'rkV', rk: 'rkZ', pk: 'pZ', keep: ['V9'] }
    const reset = { n: 1, prev: crV, by: 'rkV', rk: 'rkV2', pk: 'pV2', keep: ['V1'] }
    T = 0
    const w = new World()
    w.genesis('R1', ['R'], 0, 0, { rules: 3, from: 'S', limits: { devCap: 4, poolU: 60 } })
    w.ok(
      'R1',
      'migrate',
      {
        chunk: {
          kind: 'members',
          list: [{ ik: 'V', cr: 'rkV|p0', chain: [rival], heads: [recDigest(rival)] }],
        },
      },
      { ts: t() }
    )
    for (const m of ['B', 'C']) {
      w.ok('R1', 'add', { to: m }, { ts: t() })
      w.ok(`${m}1`, 'join', {}, { ts: t() })
    }
    const add = w.ok('R1', 'add', { to: 'V', head: recDigest(rival) }, { ts: t() })
    const cl = client('V', { rk: 'rkV', pk: 'p0' }, ['V1'], w)
    const tj = w.ok(
      'V9',
      'join',
      { rk: 'rkV', chain: [rival], by: 'pZ' },
      { ap: [add.id], ts: t() }
    )
    const thief = [tj.id]
    for (let i = 0; i < 4; i++) {
      const x = w.act(
        `V${26 + i}`,
        'primary_rotate',
        { by: 'rkZ', keep: [], seen: seenOf(w, w.heads(), ['V9', 'V26', 'V27', 'V28']) },
        { ts: t() }
      )
      if (x.v.s === 'A') thief.push(x.e.id)
    }
    cl.adopt(reset as any, 'V1')
    // on the heads, the day cap is full (W3(c) counts the other branch's rotations too)
    expect(
      w.act(
        'V1',
        'primary_rotate',
        {
          by: 'rkV2',
          chain: [reset],
          keep: [],
          seen: seenOf(w, w.heads(), ['V9', 'V26', 'V27', 'V28', 'V29']),
        },
        { ts: t() }
      ).v.s
    ).toBe('R')
    const [r] = cl.post(w)
    cl.endFlow()
    expect([r.v, r.e.ap, BD(w, 'V')?.void, w.state().facts.mem.has('V')]).toEqual([
      { s: 'A' },
      [tj.id],
      'chain',
      false,
    ])
    expect(
      props(w, {
        kind: 'upgrade',
        x: 'V',
        thief,
        thiefDevs: ['V9', 'V26', 'V27', 'V28', 'V29'],
        thiefKeys: ['rkV', 'rkZ', 'pZ'],
        leaked: true,
        userRecs: [recDigest(reset)],
        e2e: true,
        ...cmeta(cl, w),
        mustAdmit: [r.e.id],
      })
    ).toEqual([])
  })
})

describe('r8f ruling 4: the push link (r8e attack review I3, completeness review C1; R8-link-restore, R8-link-push)', () => {
  const crV = crDigest('V', 'rkV', 'p0')
  const vworld = () => {
    T = 0
    const w = new World()
    w.genesis('O1', ['O'], 0, 0, { rules: 3, limits: { devCap: 4, poolU: 60 } })
    for (const m of ['B', 'C']) {
      w.ok('O1', 'add', { to: m }, { ts: t() })
      w.ok(`${m}1`, 'join', {}, { ts: t() })
    }
    w.ok('O1', 'add', { to: 'V' }, { ts: t() })
    w.ok('V1', 'join', { rk: 'rkV' }, { ts: t() })
    w.ok('V2', 'device_add', {}, { ts: t() })
    w.ok('B1', 'mark', {}, { ts: t() })
    return w
  }
  test("R8-link-restore: a phrase-only restore's device pushes its rotation while the server holds only the creation record; one certified under the old primary, or presenting a prefix, gets none", () => {
    const w = vworld()
    const rec = { n: 1, prev: crV, by: 'rkV', pk: 'pV1', keep: ['V5'] }
    // before the rotation the server's head is the creation record: a device certified by p0 still gets an ACL-only
    // link there (the server doesn't know the recovery yet), and loses it once the rotation is in
    expect([
      L(w, 'V', 'V5', 'pV1', [rec]),
      L(w, 'V', 'V5', 'pV1'),
      L(w, 'V', 'V5', 'p0', []),
      L(w, 'V', 'V8', 'p0', [rec]),
    ]).toEqual(['push', 'none', 'acl', 'acl'])
    const cl = client('V', { rk: 'rkV', pk: 'p0' }, ['V1', 'V2'], w)
    cl.adopt(rec as any, 'V5')
    const [r] = cl.post(w)
    cl.endFlow()
    expect([
      r.link,
      r.v,
      L(w, 'V', 'V5', 'pV1', [rec]),
      L(w, 'V', 'V1'),
      L(w, 'V', 'V8', 'p0'),
    ]).toEqual(['push', { s: 'A' }, 'full', 'none', 'none'])
    expect(props(w)).toEqual([])
  })
  test("R8-link-push: a left identity's poster, the stolen device after the leave, a banned identity, a dead or unattached record, re-gating, and what the link carries", () => {
    const w = vworld()
    const rec = { n: 1, prev: crV, by: 'rkV', pk: 'pV1', keep: ['V1', 'V5'] }
    const lvPar = w.heads()
    w.ok('V1', 'leave', {}, { ts: t() })
    // left: the poster (fresh, or kept and live) pushes; the stolen V2 with nothing new gets none, and with the user's
    // record copied too (the new head doesn't trust it); a record that doesn't attach gives none
    const bad = { n: 1, prev: crV, by: 'rkZ', pk: 'pZ', keep: ['V9'] }
    expect([
      L(w, 'V', 'V5', 'pV1', [rec]),
      L(w, 'V', 'V1', 'pV1', [rec]),
      L(w, 'V', 'V2'),
      L(w, 'V', 'V2', 'p0', [rec]),
      L(w, 'V', 'V9', 'pZ', [bad]),
    ]).toEqual(['push', 'push', 'none', 'none', 'none'])
    // what a push link accepts: the identity's rotation or join carrying the presented record; not a kick, a plain join,
    // or a rotation carrying nothing new
    const S = w.state()
    const ev = (t2: string, c: any, a = 'V') =>
      ({ id: 'x', t: t2, a, dev: `${a}5`, seq: 1, ap: [], ts: 0, c }) as any
    expect([
      pushOk(S, ev('primary_rotate', { chain: [rec] }), 'V', [rec]),
      pushOk(S, ev('join', { rk: 'rkV', chain: [rec] }), 'V', [rec]),
      pushOk(S, ev('kick', { to: 'C' }), 'V', [rec]),
      pushOk(S, ev('join', {}), 'V', [rec]),
      pushOk(S, ev('primary_rotate', { chain: [] }), 'V', [rec]),
      pushOk(S, ev('primary_rotate', { chain: [rec] }, 'B'), 'V', [rec]),
    ]).toEqual([true, true, false, false, false, false])
    const cl = client('V', { rk: 'rkV', pk: 'p0' }, ['V1', 'V2'], w)
    cl.srv(w).left = w.ref.order.find(id => w.ref.ev(id).t === 'leave')!
    cl.lose('V2')
    cl.adopt(rec as any, 'V5')
    const [r] = cl.post(w)
    cl.endFlow()
    // after its rotation the non-member re-gates: nothing new to present, so none
    expect([
      r.link,
      r.v,
      w.ref.anc(r.e.id).has(cl.srv(w).left!),
      r.e.ap.every((p: string) => w.closure(lvPar).has(p) || p === w.latestOwn('V5')?.id),
      L(w, 'V', 'V5', 'pV1', [rec]),
      L(w, 'V', 'V2'),
    ]).toEqual(['push', { s: 'A' }, false, true, 'none', 'none'])
    // banned: a push link all the same (the posting at a ban's parents)
    const w2 = vworld()
    w2.ok('O1', 'ban', { to: 'V', seen: seenOf(w2, w2.heads(), ['V1', 'V2']) }, { ts: t() })
    expect([L(w2, 'V', 'V5', 'pV1', [rec]), L(w2, 'V', 'V1')]).toEqual(['push', 'none'])
    // a record dead by key death (signed by the old key after the server holds a reset of it): none
    const w3 = vworld()
    const reset = { n: 1, prev: crV, by: 'rkV', rk: 'rkV2', pk: 'pV2', keep: ['V1'] }
    w3.ok(
      'V1',
      'primary_rotate',
      { by: 'rkV2', chain: [reset], keep: [], seen: seenOf(w3, w3.heads(), ['V2']) },
      { ts: t() }
    )
    const dead = { n: 1, prev: crV, by: 'rkV', pk: 'pD', keep: ['V8'] }
    expect(L(w3, 'V', 'V8', 'pD', [dead])).toBe('none')
    expect([props(w), props(w2), props(w3)]).toEqual([[], [], []])
  })
  test("R8-link-archived and R8-link-branch: a co-owner that left before signing pushes its reset into the archived S; where the old phrase's reset arrived first, the user's reset device pushes, and its reset freezes V", () => {
    T = 0
    const w = new World()
    w.genesis('O1', ['O', 'Q'], 0, 0, {
      rules: 3,
      limits: { devCap: 4, poolU: 60 },
      rks: { O: { rk: 'rkO', pk: 'pO0' }, Q: { rk: 'rkQ', pk: 'pQ0' } },
    })
    w.ok('Q1', 'join', { rk: 'rkQ', pk: 'pQ0', by: 'pQ0' }, { ts: t() })
    for (const m of ['B', 'C']) {
      w.ok('O1', 'add', { to: m }, { ts: t() })
      w.ok(`${m}1`, 'join', {}, { ts: t() })
    }
    w.ok('Q1', 'leave', {}, { ts: t() })
    w.ok('O1', 'upgrade', { g: 'G1', sigs: { O: { by: 'pO0' }, Q: { by: 'pQ0' } } }, { ts: t() })
    const resetQ = {
      n: 1,
      prev: crDigest('Q', 'rkQ', 'pQ0'),
      by: 'rkQ',
      rk: 'rkQ2',
      pk: 'pQ2',
      keep: ['Q1'],
    }
    // (a genesis owner that left has no link of its own: only what it presents gives one)
    expect([
      L(w, 'Q', 'Q5', 'pQ2', [resetQ]),
      L(w, 'Q', 'Q1', 'pQ2', [resetQ]),
      L(w, 'Q', 'Q1'),
      L(w, 'Q', 'Q7', 'pQ9'),
    ]).toEqual(['push', 'push', 'none', 'none'])
    const w2 = vworld()
    const reset = { n: 1, prev: crV, by: 'rkV', rk: 'rkV2', pk: 'pV2', keep: ['V1', 'V5'] }
    const rival = { n: 1, prev: crV, by: 'rkV', rk: 'rkT', pk: 'pT', keep: ['V9'] }
    w2.ok(
      'V9',
      'primary_rotate',
      { by: 'rkT', chain: [rival], keep: [], seen: seenOf(w2, w2.heads(), ['V1', 'V2']) },
      { ts: t() }
    )
    expect([L(w2, 'V', 'V5', 'pV2', [reset]), L(w2, 'V', 'V1', 'pV2', [reset])]).toEqual([
      'push',
      'none',
    ])
    const cl = client('V', { rk: 'rkV', pk: 'p0' }, ['V1', 'V2'], w2)
    cl.lose('V2')
    cl.adopt(reset as any, 'V1')
    const [r] = cl.post(w2)
    cl.endFlow()
    expect([
      r.e.dev,
      r.link,
      r.v,
      BD(w2, 'V')?.void,
      L(w2, 'V', 'V5', 'pV2', [reset]),
      L(w2, 'V', 'V9', 'pT', [rival]),
    ]).toEqual(['V5', 'push', { s: 'A' }, 'chain', 'none', 'none'])
    expect([props(w), props(w2)]).toEqual([[], []])
  })
  test("R8-link-rejoin: a kept device that S introduced before rejoins over the ACL-only link of a pending identity (mutant link-pending-fresh); a join beside a thief's introduction pushes its new record", () => {
    const w = vworld()
    w.ok('V1', 'leave', {}, { ts: t() })
    w.ok('O1', 'add', { to: 'V' }, { ts: t() })
    expect([L(w, 'V', 'V1'), L(w, 'V', 'V2'), L(w, 'V', 'V7')]).toEqual(['acl', 'acl', 'acl'])
    // R8-link-cascade: a member whose join a cascade cut, invited again: its old devices (introduced only by events that
    // are cut now) get the pending identity's ACL-only link, and its rejoin is admitted
    {
      const wc = new World()
      wc.genesis('O1', ['O'], 0)
      wc.ok('O1', 'add', { to: 'Vch' })
      wc.ok('Vch1', 'join')
      const vouch = (a: { id: string }) => wc.ok('Vch1', 'mark', {}, { ap: [a.id] })
      const RA = wc.ok('O1', 'role_create', { pos: 9, bits: KICK | BAN | INVITE }).id,
        RU = wc.ok('O1', 'role_create', { pos: 1, bits: INVITE }).id
      for (const m of ['A', 'U']) {
        wc.ok('O1', 'add', { to: m })
        wc.ok(`${m}1`, 'join')
      }
      wc.ok('O1', 'assign', { to: 'A', role: RA })
      wc.ok('O1', 'assign', { to: 'U', role: RU })
      const P = wc.heads()
      const j = wc.ok(
        'N1',
        'join',
        {},
        { ap: [vouch(wc.ok('U1', 'add', { to: 'N' }, { ap: P })).id] }
      )
      wc.ok('N2', 'device_add', {}, { ap: [j.id] })
      wc.ok('A1', 'kick', { to: 'U' }, { ap: P }) // the cascade cuts N's join
      const v2 = vouch(wc.ok('A1', 'add', { to: 'N' }))
      const Lc = (dk: string) => linkOf(wc.state(), wc.ref, wc.ref.order, 'N', dk)
      expect([
        wc.state().cut.has(j.id),
        [...(wc.state().facts.devs.get('N') ?? [])],
        Lc('N1'),
        Lc('N2'),
        Lc('N9'),
      ]).toEqual([true, [], 'acl', 'acl', 'acl'])
      expect(wc.act('N1', 'join', {}, { ap: [v2.id] }).v).toEqual({ s: 'A' })
      expect(props(wc)).toEqual([])
    }
    // the thief holding p0 joined a new server first; the user's join beside it at the same add carries record 1
    T = 0
    const w2 = new World()
    w2.genesis('O1', ['O'], 0, 0, { rules: 3, limits: { devCap: 4, poolU: 60 } })
    for (const m of ['B', 'C']) {
      w2.ok('O1', 'add', { to: m }, { ts: t() })
      w2.ok(`${m}1`, 'join', {}, { ts: t() })
    }
    const add = w2.ok('O1', 'add', { to: 'V' }, { ts: t() })
    w2.ok('V8', 'join', { rk: 'rkV', by: 'p0' }, { ap: [add.id], ts: t() })
    const rec = { n: 1, prev: crV, by: 'rkV', pk: 'pV1', keep: ['V1'] }
    expect(L(w2, 'V', 'V1', 'pV1', [rec])).toBe('push')
    const j = w2.build(
      'V1',
      'join',
      { rk: 'rkV', chain: [rec], by: 'pV1' },
      { ap: [add.id], ts: t() }
    )
    expect(pushOk(w2.state(), j, 'V', [rec])).toBe(true)
    expect([props(w), props(w2)]).toEqual([[], []])
  })
})

describe('r8f ruling 6: a rejoin revives none of the roles of a membership a cascade cut (r8e attack review I5; seed 91,025,433; mutant holds-dormant)', () => {
  type Shape =
    'dormant' | 'below' | 'concurrent-assign' | 'join-first' | 'senior-ban' | 'fresh-assign'
  function build(shape: Shape) {
    T = 0
    const w = new World()
    w.genesis('O1', ['O'], 0)
    w.ok('O1', 'add', { to: 'Vch' })
    w.ok('Vch1', 'join')
    const vouch = (...adds: { id: string }[]) =>
      w.ok('Vch1', 'mark', {}, { ap: adds.map(a => a.id) })
    const role = (pos: number, bits: number) => w.ok('O1', 'role_create', { pos, bits }).id
    const join = (dev: string) => {
      w.ok('O1', 'add', { to: devOwner(dev) })
      return w.ok(dev, 'join')
    }
    const give = (to: string, r: string, o = {}) => w.ok('O1', 'assign', { to, role: r }, o)
    const RA = role(9, KICK | BAN | INVITE),
      RB = role(2, KICK | BAN),
      RU = role(1, INVITE),
      RN = role(shape === 'below' ? 1 : 5, 0)
    join('A1')
    join('B1')
    join('U1')
    give('A', RA)
    give('B', RB)
    give('U', RU)
    const P = w.heads()
    const v1 = vouch(w.ok('U1', 'add', { to: 'N' }, { ap: P }))
    const j1 = w.ok('N1', 'join', {}, { ap: [v1.id] })
    if (shape !== 'concurrent-assign' && shape !== 'fresh-assign') give('N', RN, { ap: [j1.id] })
    const kick = w.ok('A1', 'kick', { to: 'U' }, { ap: P }) // cuts U's add and N's join (N at 5 < 9): no kick of N
    const add2 = w.ok(
      'A1',
      'add',
      { to: 'N' },
      { ap: shape === 'concurrent-assign' ? [kick.id] : undefined }
    )
    const v2 = vouch(add2)
    if (shape === 'concurrent-assign') give('N', RN, { ap: [j1.id] }) // concurrent with the re-add, the ban and the rejoin
    const banner = shape === 'senior-ban' ? 'A1' : 'B1'
    let ban, rejoin
    if (shape === 'join-first') {
      rejoin = w.ok('N1', 'join', {}, { ap: [v2.id] })
      ban = w.ok(banner, 'ban', { to: 'N' }, { ap: [v2.id] })
    } else {
      ban = w.ok(banner, 'ban', { to: 'N' }, { ap: [v2.id] })
      rejoin = w.ok('N1', 'join', {}, { ap: [v2.id] })
    }
    // fresh-assign: the owner assigns the role after the rejoin, concurrently with the ban: a senior's promotion protects
    if (shape === 'fresh-assign') give('N', RN, { ap: [rejoin.id] })
    return { w, j1, ban, rejoin, RN }
  }
  for (const shape of [
    'dormant',
    'below',
    'concurrent-assign',
    'join-first',
    'senior-ban',
  ] as const)
    test(`${shape}: the ban of pending N is effective, the racing rejoin cut, N banned with no role`, () => {
      const { w, j1, ban, rejoin } = build(shape)
      const S = w.state()
      expect([
        S.cut.has(j1.id),
        S.eff.has(ban.id),
        S.cut.has(rejoin.id),
        S.facts.ban.has('N'),
        S.facts.mem.has('N'),
        [...(S.facts.holds.get('N') ?? [])],
      ]).toEqual([true, true, true, true, false, []])
      expect(props(w)).toEqual([])
    })
  test("two-joins: N joined through the owner's add and left; U re-added it, the owner gave it a role at 5, and a cascade cut that second join; the first join, of the membership the leave ended, revives nothing, also in the ban's view, which doesn't hold that leave as effective yet (mutant holds-any-join)", () => {
    T = 0
    const w = new World()
    w.genesis('O1', ['O'], 0)
    w.ok('O1', 'add', { to: 'Vch' })
    w.ok('Vch1', 'join')
    const vouch = (...adds: { id: string }[]) =>
      w.ok('Vch1', 'mark', {}, { ap: adds.map(a => a.id) })
    const role = (pos: number, bits: number) => w.ok('O1', 'role_create', { pos, bits }).id
    const RA = role(9, KICK | BAN | INVITE),
      RB = role(2, KICK | BAN),
      RU = role(1, INVITE),
      RN = role(5, 0)
    for (const m of ['A', 'B', 'U']) {
      w.ok('O1', 'add', { to: m })
      w.ok(`${m}1`, 'join')
    }
    w.ok('O1', 'assign', { to: 'A', role: RA })
    w.ok('O1', 'assign', { to: 'B', role: RB })
    w.ok('O1', 'assign', { to: 'U', role: RU })
    w.ok('O1', 'add', { to: 'N' })
    const j1 = w.ok('N1', 'join')
    const lv = w.ok('N1', 'leave')
    const P = w.heads()
    const v1 = vouch(w.ok('U1', 'add', { to: 'N' }, { ap: P }))
    const j2 = w.ok('N1', 'join', {}, { ap: [v1.id] })
    const g = w.ok('O1', 'assign', { to: 'N', role: RN }, { ap: [j2.id] })
    const kick = w.ok('A1', 'kick', { to: 'U' }, { ap: P }) // cuts U's add and N's second join
    const v2 = vouch(w.ok('A1', 'add', { to: 'N' }, { ap: [kick.id, g.id] }))
    const ban = w.ok('B1', 'ban', { to: 'N' }, { ap: [v2.id] })
    const j3 = w.ok('N1', 'join', {}, { ap: [v2.id] })
    const S = w.state()
    // j1 is live and in the assign's past, but N's leave ended that membership; the role was given in the second one
    expect([
      S.cut.has(j1.id),
      S.eff.has(lv.id),
      S.cut.has(j2.id),
      S.eff.has(ban.id),
      S.cut.has(j3.id),
      S.facts.ban.has('N'),
      S.facts.mem.has('N'),
      [...(S.facts.holds.get('N') ?? [])],
    ]).toEqual([false, true, true, true, true, true, false, []])
    expect(props(w)).toEqual([])
    // and without the ban N is a member again with no role: someone gives it again
    const w2 = new World()
    for (const id of w.ref.order) if (id !== ban.id) w2.ref.receive(w.ref.ev(id))
    const S2 = w2.ref.evalSet(w2.ref.order)
    expect([S2.facts.mem.has('N'), [...(S2.facts.holds.get('N') ?? [])]]).toEqual([true, []])
  })
  test("fresh-assign: the owner's promotion after the rejoin, concurrent with the ban, protects N (G6's exception: a senior's concurrent promotion)", () => {
    const { w, ban, rejoin, RN } = build('fresh-assign')
    const S = w.state()
    expect([
      S.eff.has(ban.id),
      S.cut.has(rejoin.id),
      S.facts.mem.has('N'),
      [...(S.facts.holds.get('N') ?? [])],
    ]).toEqual([false, false, true, [RN]])
    expect(props(w)).toEqual([])
  })
})

describe("r8f ruling 1: the client's other bullets (N26 (f) repair; resetting on one device; joins)", () => {
  const crV = crDigest('V', 'rkV', 'p0')
  test("R8-n26f-repair: a stolen device holding the reset's primary posts the chain at an old position, killing the user's recovery signed by the replaced key; the client's repair with the phrase, at the dead record, disowns again what it disowned (mutant cl-n26f-heads)", () => {
    T = 0
    const w = new World()
    w.genesis('O1', ['O'], 0, 0, { rules: 3, limits: { devCap: 4, poolU: 60 } })
    for (const m of ['B', 'C', 'Vch']) {
      w.ok('O1', 'add', { to: m }, { ts: t() })
      w.ok(`${m}1`, 'join', {}, { ts: t() })
    }
    w.ok('O1', 'add', { to: 'V' }, { ts: t() })
    w.ok('V1', 'join', { rk: 'rkV' }, { ts: t() })
    w.ok('V2', 'device_add', {}, { ts: t() })
    const R = w.ok('O1', 'role_create', { pos: 3, bits: KICK }, { ts: t() }).id
    w.ok('O1', 'assign', { to: 'V', role: R }, { ts: t() })
    const cl = client('V', { rk: 'rkV', pk: 'p0' }, ['V1', 'V2'], w)
    const P = w.heads()
    cl.lose('V2')
    const k2 = w.ok('V2', 'kick', { to: 'B', seen: seenOf(w, P, ['B1']) }, { ap: P, ts: t() })
    const rec1 = cl.recover({ maker: 'V1', keep: ['V1'], pk: 'pV1', worlds: [w] })
    const [x1] = cl.post(w, { at: P })
    cl.endFlow()
    w.ok('Vch1', 'mark', {}, { ts: t() })
    expect([x1.v, w.state().tail.has(k2.id)]).toEqual([{ s: 'A' }, true])
    // the user reset elsewhere (record 2: rkV -> rkV2, primary pV2); a device holding pV2 is stolen, and the thief posts
    // the chain at P as an extension signed by pV2 (N26 (f))
    const rec2 = {
      n: 2,
      prev: recDigest(rec1),
      by: 'rkV',
      rk: 'rkV2',
      pk: 'pV2',
      keep: ['V1', 'V6'],
    }
    cl.adopt(rec2 as any, 'V1')
    cl.endFlow()
    const ext = w.ok(
      'V9',
      'primary_rotate',
      { by: 'pV2', chain: [rec1, rec2], keep: [], seen: { V1: maxSeq(w, P, 'V1'), V2: 1e9 } },
      { ap: P, ts: t() }
    )
    expect([fate(w, x1.e.id), w.state().tail.has(k2.id), w.state().facts.mem.has('B')]).toEqual([
      'X',
      false,
      false,
    ])
    const [rp] = cl.repairKeyDeath(w, 'pV3')
    w.ok('Vch1', 'mark', {}, { ts: t() })
    const S = w.state()
    // V1 is dropped by the thief's extension here, so a fresh device the new record keeps posts the repair (push)
    expect([
      rp.v,
      rp.e.c.by,
      rp.e.dev,
      rp.link,
      S.tail.has(k2.id),
      S.facts.mem.has('B'),
      fate(w, ext.id),
    ]).toEqual([{ s: 'A' }, 'rkV2', 'V12', 'push', true, true, 'X'])
    expect(props(w)).toEqual([])
  })
  test("R8-reset-one-device (r8d attack review M2, r8e completeness review M7): a reset whose flow fetched no head is refused, except on a lone device (the head's keep and certificates name only it) (mutant cl-reset-unfetched)", () => {
    const { w, cl } = xworld(true)
    expect(() =>
      cl.recover({ maker: 'X1', keep: ['X1', 'X2'], rk: 'rkX2', pk: 'pX2', fetched: false })
    ).toThrow('Reset only on one device.')
    expect(
      cl.recover({ maker: 'X1', keep: ['X1', 'X2'], rk: 'rkX2', pk: 'pX2', fetched: true }).rk
    ).toBe('rkX2')
    const lone = client('Y', { rk: 'rkY', pk: 'pY0' }, ['Y1'], w)
    expect(
      lone.recover({ maker: 'Y1', keep: ['Y1'], rk: 'rkY2', pk: 'pY2', fetched: false }).rk
    ).toBe('rkY2')
  })
  test("R8-join-chain: the client's join carries its chain and goes around a member's add naming a head its chain doesn't reach (mutants cl-join-heads, cl-join-nochain)", () => {
    T = 0
    const w = new World()
    w.genesis('O1', ['O'], INVITE, 0, { rules: 3, limits: { devCap: 4, poolU: 60 } })
    for (const m of ['B', 'C', 'Vb']) {
      w.ok('O1', 'add', { to: m }, { ts: t() })
      w.ok(`${m}1`, 'join', {}, { ts: t() })
    }
    const rec1 = { n: 1, prev: crV, by: 'rkV', pk: 'pV1', keep: ['V5'] }
    const pre = w.heads()
    w.ok('O1', 'add', { to: 'V', head: recDigest(rec1) }, { ts: t() })
    const bogus = w.ok('B1', 'add', { to: 'V', head: 'kBOGUS' }, { ap: pre, ts: t() })
    w.ok('Vb1', 'mark', {}, { ap: [bogus.id], ts: t() })
    const cl = client('V', { rk: 'rkV', pk: 'p0' }, ['V1'], w)
    cl.adopt(rec1 as any, 'V5')
    const [j] = cl.post(w)
    cl.endFlow()
    expect([
      j.e.t,
      j.v,
      w.ref.anc(j.e.id).has(bogus.id),
      j.e.c.chain?.length,
      BD(w, 'V')?.prim,
    ]).toEqual(['join', { s: 'A' }, false, 1, ['pV1']])
    expect(
      props(w, {
        kind: 'newsrv',
        x: 'V',
        thief: [],
        thiefKeys: ['p0'],
        userRecs: [recDigest(rec1)],
        ...cmeta(cl, w),
        mustAdmit: [j.e.id],
      })
    ).toEqual([])
  })
})
