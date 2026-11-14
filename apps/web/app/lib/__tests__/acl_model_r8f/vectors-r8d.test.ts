/* eslint-disable */
// @ts-nocheck
// Copy of notes/acl-model-r8f/vectors-r8d.test.ts (the executable reference model of the P2P ACL spec r8f), used only by tests.
import { setDefaultTimeout } from 'bun:test'
setDefaultTimeout(120_000)
// Revision 8 fix round 3 vectors (§7.6 "r8d"; dispatch `spec-r8d-dispatch.md`): two carriers of one recovery (ruling 2),
// rival resets that freeze an identity (ruling 3), a rejoin after a recovery (ruling 4), upgrades that die by §2.5's
// deaths and `migrate` that sets no membership (ruling 5), content and links of a void or dropped device (ruling 8),
// adds naming unreachable heads, an extension's keep with two heads, closed record formats and the model's absent `by`.
// Each world built here also runs the exact G5 oracle and O13-fast (vectors-hook.ts).
import { describe, expect, test } from 'bun:test'
import { World } from './world'
import {
  KICK,
  INVITE,
  crDigest,
  recDigest,
  resolveProtection,
  voidDevice,
  linkOf,
  projectMembers,
  MUT,
} from './model'
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
const BD = (w: World, a = 'V') => w.state().BD?.get(a)
const devs = (w: World, a = 'V') => [...(w.state().facts.devs.get(a) ?? [])].sort()
const crV = crDigest('V', 'rkV', 'p0')
const R1 = (keep: string[] = ['V1'], pk = 'pV1', by = 'rkV') => ({ n: 1, prev: crV, by, pk, keep })
/** a rules-3 server with owner O, members Vch, B, C, T; V protected (rkV, p0) with V1 and V2 (V2 certified by p0) */
function pworld(o: { roomy?: boolean; everyone?: number; vRole?: number } = {}) {
  T = 0
  const w = new World()
  w.genesis('O1', ['O'], o.everyone ?? 0, 0, {
    rules: 3,
    ...((o.roomy ?? true) ? { limits: { devCap: 4, poolU: 60 } } : {}),
  })
  w.ok('O2', 'device_add', {}, { ts: t() })
  for (const m of ['Vch', 'B', 'C', 'T']) {
    w.ok('O1', 'add', { to: m }, { ts: t() })
    w.ok(`${m}1`, 'join', {}, { ts: t() })
  }
  w.ok('O1', 'add', { to: 'V' }, { ts: t() })
  w.ok('V1', 'join', { rk: 'rkV' }, { ts: t() })
  w.ok('V2', 'device_add', {}, { ts: t() })
  if (o.vRole) {
    const R = w.ok('O1', 'role_create', { pos: 3, bits: o.vRole }, { ts: t() }).id
    w.ok('O1', 'assign', { to: 'V', role: R }, { ts: t() })
  }
  w.ok('O1', 'mark', {}, { ts: t() })
  return w
}
const seenOf = (w: World, ap: string[], ds: string[]) =>
  Object.fromEntries(ds.map(d => [d, maxSeq(w, ap, d)]))

describe('r8d ruling 2: two carriers of one recovery (attack review I1, completeness review C1)', () => {
  // the record keeps V1 and V5; V1 posts it signed by rkV, V5 (fresh) posts it too, at the same position, before any
  // member's ACL event: two concurrent carriers in keep for one head are siblings, not rotation evidence
  const race = (byA: string, byB: string, mut?: string) => {
    const w = pworld()
    const P = w.heads()
    const rec = R1(['V1', 'V5'])
    const a = w.ok(
      'V1',
      'primary_rotate',
      { by: byA, chain: [rec], keep: [], seen: seenOf(w, P, ['V2']) },
      { ap: P, ts: t() }
    )
    const b = w.ok(
      'V5',
      'primary_rotate',
      { by: byB, chain: [rec], keep: [], seen: seenOf(w, P, ['V1', 'V2']) },
      { ap: P, ts: t() }
    )
    // the thief keeps posting from V2 at P (backdated) and the members cite the heads
    const m2 = w.ok('V2', 'mark', {}, { ap: P, ts: t() })
    w.ok('B1', 'mark', {}, { ts: t() })
    const S = w.state()
    return { w, a, b, m2, S, rec }
  }
  test("B3 two devices post the same recovery: rk plus an extension, and two extensions; both in force, the stolen device out, the user's both kept", () => {
    for (const [byA, byB] of [
      ['rkV', 'pV1'],
      ['pV1', 'pV1'],
      ['rkV', 'rkV'],
    ]) {
      const { w, a, b, m2, S, rec } = race(byA, byB)
      expect([
        S.X.has(a.id),
        S.X.has(b.id),
        S.facts.revoked.has('V2'),
        S.tail.has(m2.id) || S.X.has(m2.id),
      ]).toEqual([false, false, true, true])
      expect(devs(w)).toEqual(['V1', 'V5'])
      // a later identity op cites both: one epoch (no identity fork), no pinned pair (W3(f))
      const d = w.ok('V6', 'device_add', { by: 'pV1' }, { ts: t() })
      expect(w.state().X.has(d.id)).toBe(false)
      expect(
        props(w, {
          kind: 'thief',
          x: 'V',
          V1: 'V1',
          V2: 'V2',
          r: a.id,
          rDrops: ['V2'],
          thief: [m2.id],
          thiefKeys: ['p0'],
          userRecs: [recDigest(rec)],
        })
      ).toEqual([])
    }
  })
  test('B3 a fresh recovering device plus an extension from a kept device: neither drops the other (no lockout)', () => {
    const w = pworld()
    const P = w.heads()
    const rec = R1(['V3', 'V1'])
    // V3: a phrase-only restore (new device, signed by rkV); V1 extends (signed by pV1); V3 isn't live at V1's position
    const a = w.ok(
      'V3',
      'primary_rotate',
      { by: 'rkV', chain: [rec], keep: [], seen: seenOf(w, P, ['V1', 'V2']) },
      { ap: P, ts: t() }
    )
    const b = w.ok(
      'V1',
      'primary_rotate',
      { by: 'pV1', chain: [rec], keep: [], seen: seenOf(w, P, ['V2']) },
      { ap: P, ts: t() }
    )
    w.ok('B1', 'mark', {}, { ts: t() })
    const S = w.state()
    expect([
      S.X.has(a.id),
      S.X.has(b.id),
      S.facts.revoked.has('V3'),
      S.facts.revoked.has('V1'),
      S.facts.revoked.has('V2'),
    ]).toEqual([false, false, false, false, true])
    expect(devs(w)).toEqual(['V1', 'V3'])
    expect(w.act('V1', 'mark', {}, { ts: t() }).v.s).toBe('A')
    expect(props(w)).toEqual([])
  })
  test("B3 a carrier from a device the record doesn't name stays contested and doesn't contest the user's; fresh-device carriers of an rk holder mint nothing", () => {
    const w = pworld()
    const P = w.heads()
    const rec = R1(['V1'])
    const a = w.ok(
      'V1',
      'primary_rotate',
      { by: 'rkV', chain: [rec], keep: [], seen: seenOf(w, P, ['V2']) },
      { ap: P, ts: t() }
    )
    const outs = ['V6', 'V7', 'V8'].map(d =>
      w.ok(
        d,
        'primary_rotate',
        { by: 'rkV', chain: [rec], keep: [], seen: seenOf(w, P, ['V1', 'V2']) },
        { ap: P, ts: t() }
      )
    )
    w.ok('B1', 'mark', {}, { ts: t() })
    const S = w.state()
    expect([S.X.has(a.id), ...outs.map(o => S.X.has(o.id))]).toEqual([false, true, true, true])
    expect([devs(w), S.facts.revoked.has('V2')]).toEqual([['V1'], true])
    expect(props(w)).toEqual([])
  })
  test('B3 concurrent same-n recoveries contest each other until the client reconciles them at their merge with the phrase', () => {
    const w = pworld()
    const P = w.heads()
    const ra = R1(['V1'], 'pVa'),
      rb = R1(['V5'], 'pVb')
    const xa = w.ok(
      'V1',
      'primary_rotate',
      { by: 'rkV', chain: [ra], keep: [], seen: seenOf(w, P, ['V2']) },
      { ap: P, ts: t() }
    )
    const xb = w.ok(
      'V5',
      'primary_rotate',
      { by: 'rkV', chain: [rb], keep: [], seen: seenOf(w, P, ['V1', 'V2']) },
      { ap: P, ts: t() }
    )
    const S1 = w.state()
    // the window (N26 (h)): two different records, both contested; the stolen device is still live here
    expect([S1.X.has(xa.id), S1.X.has(xb.id), S1.facts.revoked.has('V2')]).toEqual([
      true,
      true,
      false,
    ])
    const r2 = { n: 2, prev: recDigest(ra), by: 'rkV', pk: 'pV2', keep: ['V1', 'V5'] }
    // V5 was introduced only by a contested rotation, so the reconciling rotation can't keep it: V5 certifies itself
    // again under the new primary
    const x2 = w.ok(
      'V1',
      'primary_rotate',
      { by: 'rkV', chain: [r2], keep: [], seen: seenOf(w, [xa.id, xb.id], ['V2', 'V5']) },
      { ap: [xa.id, xb.id], ts: t() }
    )
    w.ok('V5', 'device_add', { by: 'pV2' }, { ts: t() })
    w.ok('B1', 'mark', {}, { ts: t() })
    const S = w.state()
    expect([S.X.has(x2.id), S.facts.revoked.has('V2'), devs(w)]).toEqual([
      false,
      true,
      ['V1', 'V5'],
    ])
    expect(props(w)).toEqual([])
  })
})

describe('r8d ruling 3: rival resets freeze the identity (completeness review I2, attack review M6)', () => {
  const reset = { n: 1, prev: crV, by: 'rkV', rk: 'rkV2', pk: 'pV2', keep: ['V1'] }
  const rival = { n: 1, prev: crV, by: 'rkV', rk: 'rkZ', pk: 'pZ', keep: ['V9'] }
  /** V (with a Kick role) resets its phrase, dropping the stolen V2; the thief holds the old phrase and V2 */
  const setup = (o: { revoke?: boolean } = {}) => {
    const w = pworld({ vRole: KICK })
    const P0 = w.heads()
    // before the reset (and the theft's discovery), V2 kicks B at P0, and V1 kicks C on the heads (the user's own act)
    const k2 = w.ok('V2', 'kick', { to: 'B', seen: seenOf(w, P0, ['B1']) }, { ap: P0, ts: t() })
    const k1 = w.ok('V1', 'kick', { to: 'C', seen: seenOf(w, P0, ['C1']) }, { ap: P0, ts: t() }) // concurrent with V2's
    // the disowning flow (variant): the user revokes V2 with the phrase at P0, then resets
    const rv = o.revoke
      ? w.ok(
          'V1',
          'device_revoke',
          { by: 'rkV', dev: 'V2', seen: maxSeq(w, P0, 'V2') },
          { ap: [k1.id], ts: t() }
        )
      : undefined
    // the reset, positioned at the last position the user trusts (before V2's kick, which it disowns)
    const ap = rv ? [rv.id] : [k1.id]
    const r = w.ok(
      'V1',
      'primary_rotate',
      { by: 'rkV2', chain: [reset], keep: [], seen: seenOf(w, ap, ['V2']) },
      { ap, ts: t() }
    )
    w.ok('Vch1', 'mark', {}, { ts: t() }) // a member acknowledges the reset
    const k3 = w.ok('V1', 'kick', { to: 'T', seen: seenOf(w, w.heads(), ['T1']) }, { ts: t() }) // V acts after its reset
    return { w, P0, k1, k2, k3, r, rv }
  }
  test("B3 without a rival the reset stands: V2's backdated kick is in Tail and B stays", () => {
    const { w, k2, r } = setup()
    const S = w.state()
    expect([
      S.X.has(r.id),
      S.tail.has(k2.id),
      S.facts.mem.has('B'),
      S.facts.mem.has('C'),
      S.facts.mem.has('T'),
    ]).toEqual([false, true, true, false, false])
    expect(props(w)).toEqual([])
  })
  test("B3 rival resets: no grant of either branch counts, every removal keeps its cut, V is no member with no device, and V's later events are refused", () => {
    for (const revoke of [false, true]) {
      const { w, P0, k1, k2, k3, r, rv } = setup({ revoke })
      // the holder of the old phrase posts a rival reset from a fresh device at P0 (backdated)
      const tr = w.ok(
        'V9',
        'primary_rotate',
        { by: 'pZ', chain: [rival], keep: [], seen: seenOf(w, P0, ['V1', 'V2']) },
        { ap: P0, ts: t() }
      )
      // fix round 4 (the verifier's F1): an honest member's next event doesn't cite the rival (it is in X); V's own client is frozen
      const m = w.ok('Vch1', 'mark', {}, { ts: t() })
      expect([w.ref.anc(m.id).has(tr.id), w.frozenIn('V')]).toEqual([false, true])
      const S = w.state()
      expect(BD(w)).toMatchObject({ st: 'unprotected', void: 'chain', rec: [], prim: [] })
      // frozen: no member, no device; the reset's drop of V2 keeps its cut (V2's backdated kick stays in Tail, B stays)
      expect([
        S.facts.mem.has('V'),
        devs(w),
        S.facts.revoked.has('V2'),
        S.tail.has(k2.id),
        S.facts.mem.has('B'),
      ]).toEqual([false, [], true, true, true])
      // grants under either branch count for nothing: the reset carrier and the rival are inert, V9 is no device
      expect([S.X.has(r.id), S.X.has(tr.id)]).toEqual([true, true])
      // V's own acts placed before anyone knew the rival keep their effect; the rival's backdated drop of V1 cuts what
      // V1 did after P0 (fail closed: the old phrase can disown V's acts, never take the identity)
      expect([S.facts.mem.has('C'), S.tail.has(k1.id), S.tail.has(k3.id)]).toEqual([
        true,
        true,
        true,
      ])
      if (rv) expect(S.X.has(rv.id) || S.eff.has(rv.id)).toBe(true)
      // V's next event, positioned on the rival (holding both), is refused
      expect(
        w.act('V1', 'mark', {}, { ap: [...w.heads().filter(h => h !== tr.id), tr.id], ts: t() }).v
      ).toEqual({ s: 'R', why: 'void' })
      expect(props(w)).toEqual([])
    }
  })
  test("B3 a rival reset whose watermarks cover V's acts leaves them standing; nobody cites it and V's own client, frozen in its state, posts nothing (fix round 4, the verifier's F1; mutant frozen-acts)", () => {
    const { w, k1, k3, r } = setup()
    const tr = w.ok(
      'V9',
      'primary_rotate',
      { by: 'rkZ', chain: [rival], keep: [], seen: seenOf(w, w.heads(), ['V1', 'V2']) },
      { ap: w.ref.ev(r.id).ap, ts: t() }
    )
    const m = w.ok('B1', 'mark', {}, { ts: t() })
    const S = w.state()
    expect([S.X.has(tr.id), BD(w)?.void, w.ref.anc(m.id).has(tr.id)]).toEqual([
      true,
      'chain',
      false,
    ])
    // nothing of V is past the rival's watermarks: V's kicks stand (C and T are out)
    expect([
      S.tail.has(k1.id),
      S.facts.mem.has('C'),
      S.tail.has(k3.id),
      S.facts.mem.has('T'),
    ]).toEqual([false, false, false, false])
    expect(w.frozenIn('V')).toBe(true)
    expect(props(w)).toEqual([])
  })
  test("B3 a rival carrier placed on one sibling of a third identity's unacknowledged fork launders nothing: honest members don't cite it, both siblings stay in X (fix round 4, the verifier's F1; r8d completeness review I1; mutant cite-rival)", () => {
    for (const on of [0, 1]) {
      const w = pworld({ vRole: KICK })
      const R = w.ok('O1', 'role_create', { pos: 3, bits: KICK }, { ts: t() }).id
      w.ok('O1', 'assign', { to: 'C', role: R }, { ts: t() })
      w.ok('O1', 'mark', {}, { ts: t() })
      const P0 = w.heads()
      const x = w.ok('C1', 'kick', { to: 'B', seen: seenOf(w, P0, ['B1']) }, { ap: P0, ts: t() })
      const y = w.act('C1', 'mark', {}, { ap: P0, seq: x.seq, aprev: x.aprev ?? null, ts: t() }).e
      w.ok('Vch1', 'mark', {}, { ts: t() })
      w.ok(
        'V1',
        'primary_rotate',
        { by: 'rkV2', chain: [reset], keep: [], seen: seenOf(w, w.heads(), ['V2']) },
        { ts: t() }
      )
      w.ok('Vch1', 'mark', {}, { ts: t() })
      const ap = [on ? y.id : x.id]
      const tr = w.ok(
        'V9',
        'primary_rotate',
        { by: 'pZ', chain: [rival], keep: [], seen: seenOf(w, ap, ['V1', 'V2']) },
        { ap, ts: t() }
      )
      const m = w.ok('Vch1', 'mark', {}, { ts: t() })
      w.ok('O1', 'mark', {}, { ts: t() })
      const S = w.state()
      expect([
        BD(w)?.void,
        w.ref.anc(m.id).has(tr.id),
        S.X.has(x.id),
        S.X.has(y.id),
        S.facts.mem.has('B'),
      ]).toEqual(['chain', false, true, true, true])
      expect(props(w)).toEqual([])
    }
  })
  test("B3 a thief holding a legacy identity's ik makes rival resets of its own made-up key in a server it reached first: L is frozen there until the legacy user's ik-signed join beside it voids the record", () => {
    T = 0
    const w = new World()
    w.genesis('O1', ['O'], 0, 0, { rules: 3, limits: { devCap: 4, poolU: 60 } })
    for (const m of ['Vch', 'B']) {
      w.ok('O1', 'add', { to: m }, { ts: t() })
      w.ok(`${m}1`, 'join', {}, { ts: t() })
    }
    const a = w.ok('O1', 'add', { to: 'L' }, { ts: t() })
    const cZ = crDigest('L', 'rkZ', 'pZ')
    const jz = w.ok('L9', 'join', { rk: 'rkZ', pk: 'pZ', by: 'pZ' }, { ap: [a.id], ts: t() })
    const z1 = { n: 1, prev: cZ, by: 'rkZ', rk: 'rkZ1', pk: 'pZ1', keep: ['L9'] },
      z2 = { n: 1, prev: cZ, by: 'rkZ', rk: 'rkZ2', pk: 'pZ2', keep: ['L8'] }
    w.ok(
      'L9',
      'primary_rotate',
      { by: 'pZ1', chain: [z1], keep: [], seen: {} },
      { ap: [jz.id], ts: t() }
    )
    w.ok(
      'L8',
      'primary_rotate',
      { by: 'pZ2', chain: [z2], keep: [], seen: { L9: maxSeq(w, [jz.id], 'L9') } },
      { ap: [jz.id], ts: t() }
    )
    w.ok('B1', 'mark', {}, { ts: t() })
    expect([BD(w, 'L')?.void, w.state().facts.mem.has('L')]).toEqual(['chain', false])
    // L's own join, signed by ik, beside the thief's at the add (the client joins beside a dead branch, §1.7): ik is
    // always admitted, and it voids the made-up record (it is a legacy identity), so the thief's records are inert
    const j = w.ok('L1', 'join', { by: 'ik' }, { ap: [a.id], ts: t() })
    w.ok('B1', 'mark', {}, { ts: t() })
    const S = w.state()
    expect([
      BD(w, 'L')?.void,
      S.X.has(j.id),
      S.X.has(jz.id),
      S.facts.mem.has('L'),
      devs(w, 'L'),
    ]).toEqual(['ik', false, true, true, ['L1']])
    expect(props(w)).toEqual([])
  })
})

describe('r8d ruling 4: a rejoin after a recovery elsewhere (attack review C2, completeness review M7)', () => {
  const build = (how: 'leave' | 'kick', named: boolean, revoke: boolean, via = 'V1') => {
    const w = pworld({ everyone: 0 })
    const hs = w.heads()
    if (how === 'leave') w.ok('V1', 'leave', { seen: seenOf(w, hs, ['V2']) }, { ts: t() })
    else w.ok('O1', 'kick', { to: 'V', seen: seenOf(w, hs, ['V1', 'V2']) }, { ts: t() })
    w.ok('O1', 'mark', {}, { ts: t() })
    // V recovered elsewhere: record 1 keeps V1 (or V5, a phrase-only restore)
    const rec = R1([via])
    const add = w.ok(
      'O1',
      'add',
      { to: 'V', ...(named ? { head: recDigest(rec) } : {}) },
      { ts: t() }
    )
    const j = w.ok(via, 'join', { rk: 'rkV', chain: [rec], by: 'pV1' }, { ap: [add.id], ts: t() })
    const before = w.state()
    // the prescribed fix-round-2 extension at the join is refused (its position holds the head); beside it, V is no member
    expect(
      w.act(
        via,
        'primary_rotate',
        {
          by: 'pV1',
          chain: [rec],
          keep: [],
          seen: seenOf(
            w,
            [j.id],
            ['V1', 'V2'].filter(d => d !== via)
          ),
        },
        { ap: [j.id], ts: t() }
      ).v
    ).toEqual({ s: 'R', why: 'sig' })
    const revs = revoke
      ? ['V1', 'V2']
          .filter(v => v !== via && before.facts.devs.get('V')?.has(v))
          .map(v =>
            w.ok(
              via,
              'device_revoke',
              { by: 'pV1', dev: v, seen: maxSeq(w, [j.id], v) },
              { ap: [j.id], ts: t() }
            )
          )
      : []
    // the thief from V2 on the heads afterwards
    const m = w.act('V2', 'mark', {}, { ts: t() })
    w.ok('B1', 'mark', {}, { ts: t() })
    return { w, j, before, revs, m, rec }
  }
  test("B3 without the client's revocations the stolen device is live again after the rejoin", () => {
    for (const how of ['leave', 'kick'] as const)
      for (const named of [false, true]) {
        const { before } = build(how, named, false)
        expect(before.facts.devs.get('V')?.has('V2')).toBe(true)
      }
  })
  test("B3 the client's revocations at its join (under the head's primary, seen at the device's last seq) drop the stolen device; its later events are refused or in Tail", () => {
    for (const how of ['leave', 'kick'] as const)
      for (const named of [false, true])
        for (const via of ['V1', 'V5']) {
          const { w, revs, m, rec, j } = build(how, named, true, via)
          const S = w.state()
          expect([
            revs.every(r => !S.X.has(r.id)),
            S.facts.revoked.has('V2'),
            m.v.s === 'R' || S.tail.has(m.e.id),
            devs(w),
          ]).toEqual([true, true, true, [via]])
          expect(
            props(w, {
              kind: 'rejoin',
              x: 'V',
              V1: via,
              thief: m.v.s === 'A' ? [m.e.id] : [],
              thiefKeys: ['p0'],
              userRecs: [recDigest(rec)],
            })
          ).toEqual([])
          void j
        }
  })
  test('B3 without the revocations O15-recovery fails (the property kills the missing client step)', () => {
    const { w, rec } = build('leave', true, false)
    expect(
      props(w, {
        kind: 'rejoin',
        x: 'V',
        V1: 'V1',
        thief: [],
        thiefKeys: ['p0'],
        userRecs: [recDigest(rec)],
      }).some(x => x.startsWith('O15-recovery'))
    ).toBe(true)
  })
})

describe("r8d ruling 5: upgrades die by §2.5's deaths; migrate sets no membership (attack review C4, I5; completeness review I1, I4 (b))", () => {
  const cO = crDigest('O', 'rkO', 'pO0')
  const RO = (keep: string[]) => ({ n: 1, prev: cO, by: 'rkO', pk: 'pO1', keep })
  /** owner O protected (rkO, pO0), O2 certified by pO0; members B and V; optionally a co-owner Q */
  const oworld = (co?: 'prot' | 'legacy') => {
    T = 0
    const w = new World()
    const owners = co ? ['O', 'Q'] : ['O']
    w.genesis('O1', owners, 0, 0, {
      rules: 3,
      limits: { devCap: 4, poolU: 60 },
      rks: {
        O: { rk: 'rkO', pk: 'pO0' },
        ...(co === 'prot' ? { Q: { rk: 'rkQ', pk: 'pQ0' } } : {}),
      },
    })
    w.ok('O2', 'device_add', { by: 'pO0' }, { ts: t() })
    if (co)
      w.ok(
        'Q1',
        'join',
        { ...(co === 'prot' ? { rk: 'rkQ', pk: 'pQ0', by: 'pQ0' } : {}) },
        { ts: t() }
      )
    for (const m of ['B', 'C']) {
      w.ok('O1', 'add', { to: m }, { ts: t() })
      w.ok(`${m}1`, 'join', {}, { ts: t() })
    }
    w.ok('B1', 'mark', {}, { ts: t() })
    return w
  }
  test("B3 a stolen owner device's backdated upgrade after the owner's recovery is inert: S isn't frozen, and the owner's own upgrade is admitted", () => {
    // fix round 5 (ruling 2; r8e attack review C1): an upgrade dies only through a carrier signed by a recovery key, and
    // where its identity is a genesis owner the client always signs its carriers with it; posted as an extension (the
    // phrase declined), the stolen device's backdated upgrade counts until such a carrier arrives (vectors-r8f)
    for (const rot of ['rkO']) {
      const w = oworld()
      const P0 = w.heads()
      const r = w.ok(
        'O1',
        'primary_rotate',
        { by: rot, chain: [RO(['O1'])], keep: [], seen: seenOf(w, w.heads(), ['O2']) },
        { ts: t() }
      )
      w.ok('B1', 'mark', {}, { ts: t() })
      const u = w.ok('O2', 'upgrade', { g: 'Gt', sigs: { O: { by: 'pO0' } } }, { ap: P0, ts: t() })
      w.ok('B1', 'mark', {}, { ts: t() })
      let S = w.state()
      expect([S.X.has(r.id), S.X.has(u.id), S.facts.upgraded]).toEqual([false, true, []])
      expect(w.act('O1', 'role_create', { pos: 2, bits: KICK }, { ts: t() }).v.s).toBe('A')
      const u2 = w.ok('O1', 'upgrade', { g: 'G1', sigs: { O: { by: 'pO1' } } }, { ts: t() })
      S = w.state()
      expect(S.facts.upgraded).toEqual([u2.id])
      expect(
        props(w, {
          kind: 'upgrade',
          x: 'O',
          V1: 'O1',
          V2: 'O2',
          r: r.id,
          rDrops: ['O2'],
          thief: [u.id],
          thiefKeys: ['pO0'],
          userRecs: [recDigest(RO(['O1']))],
        })
      ).toEqual([])
    }
  })
  test("B3 the former owner's backdated revocations of its own device never undo an honest upgrade (by pO0 or by the recovery key)", () => {
    for (const by of ['pO0', 'rkO']) {
      const w = oworld()
      const P0 = w.heads()
      const u = w.ok('O1', 'upgrade', { g: 'G1', sigs: { O: { by: 'pO0' } } }, { ts: t() })
      const rv = w.ok(
        'O2',
        'device_revoke',
        { by, dev: 'O1', seen: maxSeq(w, P0, 'O1') },
        { ap: P0, ts: t() }
      )
      const S = w.state()
      expect([S.facts.upgraded, S.X.has(rv.id) ? 'X' : 'in force']).toEqual([[u.id], 'in force'])
      expect(w.act('O1', 'role_create', { pos: 2, bits: KICK }, { ts: t() }).v).toEqual({
        s: 'R',
        why: 'auth',
      })
      expect(props(w)).toEqual([])
    }
  })
  test("B3 the stated cost: the owner's own recovery positioned before its own upgrade, with the phrase, revives S", () => {
    const w = oworld()
    const P0 = w.heads()
    const u = w.ok('O1', 'upgrade', { g: 'G1', sigs: { O: { by: 'pO0' } } }, { ts: t() })
    w.ok(
      'O3',
      'primary_rotate',
      { by: 'rkO', chain: [RO(['O3'])], keep: [], seen: seenOf(w, P0, ['O1', 'O2']) },
      { ap: P0, ts: t() }
    )
    const S = w.state()
    expect([S.X.has(u.id), S.facts.upgraded]).toEqual([true, []])
    expect(w.act('O3', 'role_create', { pos: 2, bits: KICK }, { ts: t() }).v.s).toBe('A')
    expect(props(w)).toEqual([])
  })
  test("B3 countersignatures on rules 3: a protected co-owner signs with its head's primary, carrying a chain S lacks; its old primary after its recovery is dead; a legacy co-owner signs with ik; ik for a protected one voids it", () => {
    const cQ = crDigest('Q', 'rkQ', 'pQ0')
    const rq = { n: 1, prev: cQ, by: 'rkQ', pk: 'pQ1', keep: ['Q1'] }
    // Q recovered elsewhere (S lacks rq): its signature carries it
    {
      const w = oworld('prot')
      const u = w.act(
        'O1',
        'upgrade',
        { g: 'G1', sigs: { O: { by: 'pO0' }, Q: { by: 'pQ1', chain: [rq] } } },
        { ts: t() }
      )
      expect(u.v.s).toBe('A')
      expect(w.state().facts.upgraded).toEqual([u.e.id])
      expect(
        w.act(
          'O1',
          'upgrade',
          { g: 'G2', sigs: { O: { by: 'pO0' }, Q: { by: 'pQ1' } } },
          { ts: t() }
        ).v.s
      ).toBe('R')
    }
    // Q's recovery is in S; a signature by its old primary positioned before it dies by epoch death
    {
      const w = oworld('prot')
      const P0 = w.heads()
      w.ok('Q1', 'primary_rotate', { by: 'rkQ', chain: [rq], keep: [], seen: {} }, { ts: t() })
      w.ok('B1', 'mark', {}, { ts: t() })
      const u = w.ok(
        'O2',
        'upgrade',
        { g: 'Gt', sigs: { O: { by: 'pO0' }, Q: { by: 'pQ0' } } },
        { ap: P0, ts: t() }
      )
      expect([w.state().X.has(u.id), w.state().facts.upgraded]).toEqual([true, []])
      expect(props(w)).toEqual([])
    }
    // a legacy co-owner signs with ik (the rules-2 form, a string); a protected owner's ik signature voids its record
    {
      const w = oworld('legacy')
      const u = w.ok(
        'O1',
        'upgrade',
        { g: 'G1', sigs: { O: { by: 'pO0' }, Q: 'sig' } },
        { ts: t() }
      )
      expect(w.state().facts.upgraded).toEqual([u.id])
      expect(
        w.act(
          'O1',
          'upgrade',
          { g: 'G2', sigs: { O: { by: 'pO0' }, Q: { by: 'pQ0' } } },
          { ts: t() }
        ).v
      ).toEqual({ s: 'R', why: 'sig' })
      const w2 = oworld()
      w2.ok('O1', 'upgrade', { g: 'G1', sigs: { O: { by: 'ik' } } }, { ts: t() })
      expect(BD(w2, 'O')).toMatchObject({ st: 'unprotected', void: 'ik' })
      expect(props(w2)).toEqual([])
    }
    // the rules-2 array form is refused on rules 3, and so is a missing signature of the author
    {
      const w = oworld('legacy')
      expect(w.act('O1', 'upgrade', { g: 'G1', sigs: ['Q'] }, { ts: t() }).v).toEqual({
        s: 'R',
        why: 'sig',
      })
      expect(w.act('O1', 'upgrade', { g: 'G1', sigs: { Q: 'sig' } }, { ts: t() }).v).toEqual({
        s: 'R',
        why: 'sig',
      })
    }
  })
  test("B3 migrate in a rules-3 S' sets no membership or device: members join S' through the carry-over's adds, which name the heads B(u) holds (R8-upgrade, -reset, -stale-head)", () => {
    // S: V protected, recovered in S (record 1 keeps V1; V2 dropped); B a plain member
    const S0 = pworld()
    S0.ok(
      'V1',
      'primary_rotate',
      { by: 'rkV', chain: [R1(['V1'])], keep: [], seen: seenOf(S0, S0.heads(), ['V2']) },
      { ts: t() }
    )
    S0.ok('B1', 'mark', {}, { ts: t() })
    const u = S0.ok('O1', 'upgrade', { g: 'Gx', sigs: { O: {} } }, { ts: t() })
    const entries = projectMembers(S0.ref.rec(u.id).local)
    const ve = entries.find(x => x.ik === 'V')!
    expect([ve.cr, ve.heads]).toEqual(['rkV|p0', [recDigest(R1(['V1']))]])
    // S': the new owner R; migrate carries the entries; nobody is a member through it
    T = 0
    const w = new World()
    w.genesis('R1', ['R'], 0, 0, { rules: 3, from: 'S', limits: { devCap: 4, poolU: 60 } })
    w.ok('R1', 'migrate', { chunk: { kind: 'members', list: entries } }, { ts: t() })
    expect([w.state().facts.mem.has('V'), w.state().facts.devs.get('V')]).toEqual([
      false,
      undefined,
    ])
    // the carry-over: an add naming V's head in B(u); V's client joins with its own chain
    w.ok('R1', 'add', { to: 'V', head: ve.heads[0] }, { ts: t() })
    expect(w.act('V8', 'join', { rk: 'rkV', by: 'p0' }, { ts: t() }).v).toEqual({
      s: 'R',
      why: 'rk',
    }) // the stolen p0
    const j = w.ok('V1', 'join', { rk: 'rkV', chain: [R1(['V1'])], by: 'pV1' }, { ts: t() })
    expect([w.state().X.has(j.id), BD(w)?.prim, devs(w)]).toEqual([false, ['pV1'], ['V1']])
    // a migrate outside a successor server is refused
    const w2 = pworld()
    expect(
      w2.act('O1', 'migrate', { chunk: { kind: 'members', list: [] } }, { ts: t() }).v
    ).toEqual({ s: 'R', why: 'auth' })
    expect(props(w)).toEqual([])
  })
  test("B3 a stale head in S': B(u) lacked the member's recovery; its join in S' carries its newer chain, and a thief holding the stale primary that joins first ends when the user joins beside it", () => {
    T = 0
    const w = new World()
    w.genesis('R1', ['R'], 0, 0, { rules: 3, from: 'S', limits: { devCap: 4, poolU: 60 } })
    w.ok(
      'R1',
      'migrate',
      { chunk: { kind: 'members', list: [{ ik: 'V', cr: 'rkV|p0', chain: [], heads: [crV] }] } },
      { ts: t() }
    )
    for (const m of ['B', 'C']) {
      w.ok('R1', 'add', { to: m }, { ts: t() })
      w.ok(`${m}1`, 'join', {}, { ts: t() })
    }
    const a = w.ok('R1', 'add', { to: 'V', head: crV }, { ts: t() }) // the head B(u) held: the creation record
    const tj = w.ok('V2', 'join', { rk: 'rkV', by: 'p0' }, { ap: [a.id], ts: t() }) // the thief holding p0, first
    const tm = w.ok('V2', 'mark', {}, { ap: [tj.id], ts: t() })
    const uj = w.ok(
      'V1',
      'join',
      { rk: 'rkV', chain: [R1(['V1'])], by: 'pV1' },
      { ap: [a.id], ts: t() }
    ) // beside it
    w.ok('B1', 'mark', {}, { ts: t() })
    const S = w.state()
    expect([S.X.has(tj.id), S.X.has(tm.id), S.X.has(uj.id), devs(w), BD(w)?.prim]).toEqual([
      true,
      true,
      false,
      ['V1'],
      ['pV1'],
    ])
    expect(
      props(w, {
        kind: 'newsrv',
        x: 'V',
        thief: [tj.id, tm.id],
        thiefDevs: ['V2'],
        thiefKeys: ['p0'],
        userRecs: [recDigest(R1(['V1']))],
      })
    ).toEqual([])
  })
})

describe("r8d: a stolen reset primary, adds naming unreachable heads, an extension's keep, closed records, absent by (attack review I2, M2, M4; completeness review I4, I5)", () => {
  test("B3 a stolen reset primary kills an earlier recovery (N26 (f)): a recovery on the heads doesn't repair it; one positioned at the dead record does", () => {
    const run = (fix: 'none' | 'heads' | 'positioned') => {
      const w = pworld({ vRole: KICK })
      const P = w.heads()
      const k2 = w.ok('V2', 'kick', { to: 'B', seen: seenOf(w, P, ['B1']) }, { ap: P, ts: t() })
      const rec1 = R1(['V1'])
      const x1 = w.ok(
        'V1',
        'primary_rotate',
        { by: 'rkV', chain: [rec1], keep: [], seen: seenOf(w, P, ['V2']) },
        { ap: P, ts: t() }
      )
      w.ok('B1', 'mark', {}, { ts: t() })
      expect(w.state().tail.has(k2.id)).toBe(true)
      // the user reset elsewhere (record 2, new primary pV2); a device holding pV2 is stolen, and the thief posts the
      // chain here at P as an extension signed by pV2: it holds the head's primary (N26 (f))
      const rec2 = {
        n: 2,
        prev: recDigest(rec1),
        by: 'rkV',
        rk: 'rkV2',
        pk: 'pV2',
        keep: ['V1', 'V6'],
      }
      const ext = w.ok(
        'V9',
        'primary_rotate',
        { by: 'pV2', chain: [rec1, rec2], keep: [], seen: { V1: maxSeq(w, P, 'V1'), V2: 1e9 } },
        { ap: P, ts: t() }
      )
      const S1 = w.state()
      expect([S1.X.has(x1.id), S1.tail.has(k2.id), S1.facts.mem.has('B')]).toEqual([
        true,
        false,
        false,
      ])
      const rec3 = {
        n: 3,
        prev: recDigest(rec2),
        by: 'rkV2',
        pk: 'pV3',
        keep: [fix === 'heads' ? 'V3' : 'V1'],
      }
      // on the heads V1 is dropped (the thief's extension keeps nothing): a fresh device recovers there
      if (fix === 'heads')
        w.ok(
          'V3',
          'primary_rotate',
          { by: 'rkV2', chain: [rec3], keep: [], seen: seenOf(w, w.heads(), ['V1', 'V2', 'V9']) },
          { ts: t() }
        )
      // positioned at the dead record (concurrent with the thief's extension), with its watermarks
      if (fix === 'positioned')
        w.ok(
          'V1',
          'primary_rotate',
          { by: 'rkV2', chain: [rec2, rec3], keep: [], seen: seenOf(w, [...P, x1.id], ['V2']) },
          { ap: [...P, x1.id], ts: t() }
        )
      w.ok('Vch1', 'mark', {}, { ts: t() })
      const S = w.state()
      return { tail: S.tail.has(k2.id), B: S.facts.mem.has('B'), ext: S.X.has(ext.id), p: props(w) }
    }
    expect(run('none')).toEqual({ tail: false, B: false, ext: false, p: [] })
    expect(run('heads')).toMatchObject({ tail: false, B: false, p: [] })
    expect(run('positioned')).toMatchObject({ tail: true, B: true, ext: true, p: [] })
  })
  test("B3 a member's add naming a head no chain reaches: a join with it in its past is refused; the client joins outside it, or an owner withdraws every pending add and invites again", () => {
    const d1 = recDigest(R1(['V1']))
    T = 0
    const w = new World()
    w.genesis('O1', ['O'], INVITE, 0, { rules: 3, limits: { devCap: 4, poolU: 60 } })
    for (const m of ['Z', 'B']) {
      w.ok('O1', 'add', { to: m }, { ts: t() })
      w.ok(`${m}1`, 'join', {}, { ts: t() })
    }
    const P = w.heads()
    const a = w.ok('O1', 'add', { to: 'V', head: d1 }, { ap: P, ts: t() })
    w.ok('Z1', 'add', { to: 'V', head: 'kBOGUS' }, { ap: P, ts: t() }) // beside it
    w.ok('B1', 'mark', {}, { ts: t() }) // acknowledges both
    expect(
      w.act('V1', 'join', { rk: 'rkV', chain: [R1(['V1'])], by: 'pV1' }, { ts: t() }).v
    ).toEqual({ s: 'R', why: 'rk' })
    const j = w.ok(
      'V1',
      'join',
      { rk: 'rkV', chain: [R1(['V1'])], by: 'pV1' },
      { ap: [a.id], ts: t() }
    )
    expect(w.state().X.has(j.id)).toBe(false)
    // sequential: the bogus add is the only one; the owner withdraws it and invites again
    const { w: w2 } = (() => {
      T = 0
      const x = new World()
      x.genesis('O1', ['O'], INVITE, 0, { rules: 3 })
      for (const m of ['Z', 'B']) {
        x.ok('O1', 'add', { to: m }, { ts: t() })
        x.ok(`${m}1`, 'join', {}, { ts: t() })
      }
      return { w: x }
    })()
    w2.ok('Z1', 'add', { to: 'V', head: 'kBOGUS' }, { ts: t() })
    w2.ok('B1', 'mark', {}, { ts: t() })
    expect(w2.act('O1', 'add', { to: 'V', head: d1 }, { ts: t() }).v).toEqual({
      s: 'R',
      why: 'auth',
    })
    expect(
      w2.act('V1', 'join', { rk: 'rkV', chain: [R1(['V1'])], by: 'pV1' }, { ts: t() }).v
    ).toEqual({ s: 'R', why: 'rk' })
    w2.ok('O1', 'uninvite', { to: 'V' }, { ts: t() })
    w2.ok('O1', 'add', { to: 'V', head: d1 }, { ts: t() })
    expect(
      w2.act('V1', 'join', { rk: 'rkV', chain: [R1(['V1'])], by: 'pV1' }, { ts: t() }).v.s
    ).toBe('A')
    expect(props(w)).toEqual([])
    expect(props(w2)).toEqual([])
  })
  test('B3 an extension keeps only devices of the record whose primary signs it, also with two same-n heads (attack review M2)', () => {
    const ra = R1(['V1'], 'pVa'),
      rb = R1(['V5'], 'pVb')
    // only ra was posted here; V4 was certified under pVa; the holder of pVb (it stole V5) posts rb as an extension:
    // after it the server holds two heads, and the extension may keep only what rb keeps
    T = 0
    const w = new World()
    w.genesis('O1', ['O'], 0, 0, { rules: 3, limits: { devCap: 4, poolU: 60 } })
    w.ok('O1', 'add', { to: 'B' }, { ts: t() })
    w.ok('B1', 'join', {}, { ts: t() })
    w.ok('O1', 'add', { to: 'V' }, { ts: t() })
    w.ok('V1', 'join', { rk: 'rkV' }, { ts: t() })
    w.ok('V2', 'device_add', {}, { ts: t() })
    w.ok('B1', 'mark', {}, { ts: t() })
    w.ok(
      'V1',
      'primary_rotate',
      { by: 'rkV', chain: [ra], keep: [], seen: seenOf(w, w.heads(), ['V2']) },
      { ts: t() }
    )
    w.ok('B1', 'mark', {}, { ts: t() })
    w.ok('V4', 'device_add', { by: 'pVa' }, { ts: t() })
    w.ok('B1', 'mark', {}, { ts: t() })
    const hs = w.heads()
    expect(
      w.act(
        'V5',
        'primary_rotate',
        { by: 'pVb', chain: [rb], keep: ['V4'], seen: seenOf(w, hs, ['V1', 'V2']) },
        { ts: t() }
      ).v
    ).toEqual({ s: 'R', why: 'rk' })
    expect(
      w.act(
        'V5',
        'primary_rotate',
        { by: 'pVb', chain: [rb], keep: [], seen: seenOf(w, hs, ['V1', 'V2', 'V4']) },
        { ts: t() }
      ).v.s
    ).toBe('A')
    expect(props(w)).toEqual([])
  })
  test("B3 records are closed formats: a chain record with an unknown field is refused, and a copy of V's creation record (its signed fields) never voids it (attack review M4)", () => {
    const w = pworld()
    expect(
      w.act(
        'V1',
        'primary_rotate',
        {
          by: 'rkV',
          chain: [{ ...R1(['V1']), note: 1 }],
          keep: [],
          seen: seenOf(w, w.heads(), ['V2']),
        },
        { ts: t() }
      ).v
    ).toEqual({ s: 'R', why: 'rk' })
    // a thief holding p0 joins a new server through an add naming no head with V's own creation record and an extra
    // field: the same record (its identity is the digest of its signed fields), so nothing is void
    T = 0
    const w2 = new World()
    w2.genesis('O1', ['O'], 0, 0, { rules: 3, limits: { devCap: 4, poolU: 60 } })
    const a = w2.ok('O1', 'add', { to: 'V' }, { ts: t() })
    w2.ok(
      'V8',
      'join',
      { rk: 'rkV', pk: 'p0', by: 'p0', crx: 're-encoded' },
      { ap: [a.id], ts: t() }
    )
    w2.ok('V1', 'join', { rk: 'rkV', chain: [R1(['V1'])], by: 'pV1' }, { ap: [a.id], ts: t() })
    expect(BD(w2)).toMatchObject({ st: 'protected', prim: ['pV1'] })
  })
  test("B3 the model's absent by is the honest key of the record's position (a shorthand only the model has; on rules 3 the wire's absent by means ik)", () => {
    const w = pworld()
    const d = w.ok('V5', 'device_add', {}, { ts: t() })
    expect([w.ref.rec(d.id).by, BD(w)?.st]).toEqual(['p0', 'protected'])
    const d2 = w.ok('V6', 'device_add', { by: 'ik' }, { ts: t() })
    expect([w.ref.rec(d2.id).by, BD(w)?.void]).toEqual(['ik', 'ik'])
    // a join that carries a creation record and is signed by ik: admitted, and it voids the record (§2.2 A1, §2.5)
    T = 0
    const w3 = new World()
    w3.genesis('O1', ['O'], 0, 0, { rules: 3 })
    w3.ok('O1', 'add', { to: 'N' }, { ts: t() })
    w3.ok('N1', 'join', { rk: 'rkN', by: 'ik' }, { ts: t() })
    expect(BD(w3, 'N')).toMatchObject({ st: 'unprotected', void: 'ik' })
  })
})

describe('r8d ruling 8: content and links of void and dropped devices (attack review C3, I3)', () => {
  test("B3 a void device: certified by the stolen primary concurrently with the recovery, or the thief's join beside the user's; certification again under the new primary ends it", () => {
    const w = pworld()
    const P0 = w.heads()
    w.ok(
      'V1',
      'primary_rotate',
      { by: 'rkV', chain: [R1(['V1'])], keep: [], seen: seenOf(w, w.heads(), ['V2']) },
      { ts: t() }
    )
    w.ok('B1', 'mark', {}, { ts: t() })
    const d3 = w.ok('V3', 'device_add', { by: 'p0' }, { ap: P0, ts: t() })
    w.ok('V3', 'mark', {}, { ap: [d3.id], ts: t() })
    let S = w.state()
    expect([
      voidDevice(S, w.ref, w.ref.order, 'V', 'V3'),
      voidDevice(S, w.ref, w.ref.order, 'V', 'V1'),
      voidDevice(S, w.ref, w.ref.order, 'V', 'V2'),
    ]).toEqual([true, false, false])
    // V2 is not void but dropped: its content past the watermark is hidden by the watermark rule
    expect(S.facts.revoked.has('V2')).toBe(true)
    T = 100
    const w2 = new World()
    w2.genesis('O1', ['O'], 0, 0, { rules: 3, limits: { devCap: 4, poolU: 60 } })
    w2.ok('O1', 'add', { to: 'B' }, { ts: t() })
    w2.ok('B1', 'join', {}, { ts: t() })
    const a = w2.ok('O1', 'add', { to: 'V' }, { ts: t() })
    const tj = w2.ok('V8', 'join', { rk: 'rkV', by: 'p0' }, { ap: [a.id], ts: t() })
    w2.ok('V8', 'mark', {}, { ap: [tj.id], ts: t() })
    w2.ok('V1', 'join', { rk: 'rkV', chain: [R1(['V1'])], by: 'pV1' }, { ap: [a.id], ts: t() })
    w2.ok('B1', 'mark', {}, { ts: t() })
    S = w2.state()
    expect([
      voidDevice(S, w2.ref, w2.ref.order, 'V', 'V8'),
      voidDevice(S, w2.ref, w2.ref.order, 'V', 'V1'),
    ]).toEqual([true, false])
    // the user's client never certifies again a device it didn't create; a device it did create (V3 here, the user's
    // own whose certificate came under the old primary) gets a certificate under the new one, and its messages return
    const w3 = pworld()
    const Q0 = w3.heads()
    w3.ok(
      'V1',
      'primary_rotate',
      { by: 'rkV', chain: [R1(['V1'])], keep: [], seen: seenOf(w3, w3.heads(), ['V2']) },
      { ts: t() }
    )
    w3.ok('V3', 'device_add', { by: 'p0' }, { ap: Q0, ts: t() })
    w3.ok('B1', 'mark', {}, { ts: t() })
    expect(voidDevice(w3.state(), w3.ref, w3.ref.order, 'V', 'V3')).toBe(true)
    w3.ok('V3', 'device_add', { by: 'pV1' }, { ts: t() })
    expect(voidDevice(w3.state(), w3.ref, w3.ref.order, 'V', 'V3')).toBe(false)
  })
  test('B3 links read the session device: a dropped device gets none, a kept one a full link, a restored device an ACL-only link until its rotation, and a plain revocation of an unprotected identity the same', () => {
    const w = pworld()
    const S0 = w.state()
    expect([
      linkOf(S0, w.ref, w.ref.order, 'V', 'V1'),
      linkOf(S0, w.ref, w.ref.order, 'V', 'V2'),
    ]).toEqual(['full', 'full'])
    // a phrase-only restore on V3: never introduced here, certified under the head's primary (after the recovery)
    w.ok(
      'V1',
      'primary_rotate',
      { by: 'rkV', chain: [R1(['V1', 'V3'])], keep: [], seen: seenOf(w, w.heads(), ['V2']) },
      { ts: t() }
    )
    let S = w.state()
    expect([
      linkOf(S, w.ref, w.ref.order, 'V', 'V2'),
      linkOf(S, w.ref, w.ref.order, 'V', 'V1'),
      linkOf(S, w.ref, w.ref.order, 'V', 'V3', 'pV1'),
      linkOf(S, w.ref, w.ref.order, 'V', 'V3', 'p0'),
    ]).toEqual(['none', 'full', 'acl', 'none'])
    w.ok('V3', 'device_add', { by: 'pV1' }, { ts: t() })
    S = w.state()
    expect(linkOf(S, w.ref, w.ref.order, 'V', 'V3', 'pV1')).toBe('full')
    // an unprotected member's plain revocation
    w.ok('B2', 'device_add', {}, { ts: t() })
    w.ok('B1', 'device_revoke', { dev: 'B2', seen: maxSeq(w, w.heads(), 'B2') }, { ts: t() })
    S = w.state()
    expect([
      linkOf(S, w.ref, w.ref.order, 'B', 'B2'),
      linkOf(S, w.ref, w.ref.order, 'B', 'B1'),
    ]).toEqual(['none', 'full'])
  })
})
