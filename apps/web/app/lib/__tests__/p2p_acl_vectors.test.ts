// Regression vectors of the P2P ACL spec (§7.6), ported from notes/acl-model/vectors.test.ts with
// their names, against the production modules. After each test every world it built is replayed
// through the reference model, which must give the same verdicts, records and states.
import { describe, expect, setDefaultTimeout, test } from 'bun:test'
import { evaluate, FastEval } from '../p2p/acl/eval'
import { Ix } from '../p2p/acl/reach'
import { orphanDrops } from '../p2p/acl/equivocation'
import type { EvalResult } from '../p2p/acl/facts'
import { BAN, EVERYONE, gt, INVITE, KICK, rank, rankOf, ROLES, SERVER } from '../p2p/acl/rules'
import type { Agreed } from '../p2p/limits'
import * as M from './acl_model/model'
import {
  AclWorld,
  devOwner,
  evalSummary,
  MODEL_LIMITS,
  modelDiffAfterEach,
  TestReplica,
  toModel,
} from './p2p_acl_world'

modelDiffAfterEach()
setDefaultTimeout(300_000)

const R3 = true
const R4 = true
const R5 = true
const TOT = true
// the model's unacknowledged day budget of dispatch 5a (24), which the 5b total replaced
const DAY_U = 24
const dayBudget = () => DAY_U

function base(everyone = 0, agreed?: Agreed) {
  const w = new AclWorld({ agreed })
  w.genesis('O1', ['O'], everyone)
  if (VOUCH) {
    // the bystander of vouch() below: a plain member let in by the owner right after genesis
    w.ok('O1', 'add', { to: 'Vch' })
    w.ok('Vch1', 'join')
  }
  return w
}
/**
 * [H18] W3(e) (§4.1, revision 5 dispatch 5b): a join through a non-owner's add needs a good-faith acknowledgement of
 * that add by a third identity. The vectors model it with a bystander, Vch, whose client saw the add (a deceived honest
 * member in the attack vectors): Vch's mark citing the add. Vch joined right after genesis and only ever posts these
 * marks, so its chain carries nothing but the adds it acknowledged and their pasts. On a model without the rule
 * (revision 4 and earlier) vouch() returns the add itself.
 */
const VOUCH = true
const vouch = <E extends { id: string }>(w: AclWorld, ...adds: E[]): { id: string } =>
  VOUCH ? w.ok('Vch1', 'mark', {}, { ap: adds.map(a => a.id) }) : adds[0]
const role = (w: AclWorld, pos: number, bits: number) => w.ok('O1', 'role_create', { pos, bits }).id
const join = (w: AclWorld, dev: string, by = 'O1') => {
  w.ok(by, 'add', { to: devOwner(dev) })
  return w.ok(dev, 'join')
}
const give = (w: AclWorld, to: string, r: string, by = 'O1', o = {}) =>
  w.ok(by, 'assign', { to, role: r }, o)
const F = (w: AclWorld) => w.state().facts
const shuffled = <T>(a: T[], seed: number) => {
  const b = [...a]
  let s = seed
  for (let i = b.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) & 0x7fffffff
    const j = s % (i + 1)
    ;[b[i], b[j]] = [b[j], b[i]]
  }
  return b
}
function orderIndependent(w: AclWorld) {
  const ref = evalSummary(evaluate(w.ref.order, w.ref))
  for (let s = 1; s <= 12; s++)
    expect(evalSummary(evaluate(shuffled(w.ref.order, s), w.ref))).toBe(ref)
}

describe('review Criticals', () => {
  test("S1 / C3: equivocation does not launder a banned member's backdated invite", () => {
    const w = base()
    const R1 = role(w, 1, INVITE)
    join(w, 'V1')
    give(w, 'V', R1)
    const P0 = w.heads()
    w.ok('O1', 'ban', { to: 'V' })
    const add = w.ok('V1', 'add', { to: 'N' }, { ap: P0 })
    w.ok('N1', 'join', {}, { ap: [vouch(w, add).id] })
    // V signs a sibling at the add's seq, same old position
    const sib = w.act('V1', 'mark', {}, { ap: P0, seq: add.seq, aprev: add.aprev ?? null })
    expect(sib.v.s).toBe('A')
    const S = w.state()
    expect(S.X.has(add.id)).toBe(false) // witnessed by N's join
    expect(S.cut.has(add.id)).toBe(true)
    expect(S.facts.mem.has('N')).toBe(false)
    expect(S.facts.ban.has('V')).toBe(true)
  })

  test('C3 B: a demoted moderator cannot void a witnessed ban by equivocating', () => {
    const w = base()
    const MOD = role(w, 3, BAN)
    join(w, 'M1')
    join(w, 'S1')
    give(w, 'M', MOD)
    const P = w.heads()
    const b = w.ok('M1', 'ban', { to: 'S' })
    w.ok('O1', 'mark') // the owner's client witnesses the ban
    w.ok('O1', 'revoke', { to: 'M', role: MOD })
    const sib = w.act('M1', 'mark', {}, { ap: P, seq: b.seq, aprev: b.aprev ?? null })
    expect(sib.v.s).toBe('A')
    expect(F(w).ban.has('S')).toBe(true)
  })

  test("S2 / C2: device revocation cuts the stolen device's backdated grants and their cascade", () => {
    const w = base()
    const R3 = role(w, 3, INVITE)
    join(w, 'A1')
    w.ok('A2', 'device_add')
    give(w, 'A', R3)
    const P = w.heads()
    const a2 = w.latestOwn('A2')!
    w.ok('A1', 'device_revoke', { dk: 'A2', seen: a2.seq })
    const add = w.ok('A2', 'add', { to: 'N' }, { ap: P })
    const j = w.ok('N1', 'join', {}, { ap: [vouch(w, add).id] })
    const S = w.state()
    expect(S.cut.has(add.id)).toBe(true)
    expect(S.cut.has(j.id)).toBe(true)
    expect(S.facts.mem.has('N')).toBe(false)
    expect(S.facts.devs.get('A')!.has('A2')).toBe(false)
  })

  test('S3 / C1: same-author same-stratum denies from two devices are order independent (both stand)', () => {
    const w = base()
    const MOD = role(w, 5, BAN | ROLES | KICK)
    const R1 = role(w, 1, 0)
    join(w, 'M1')
    w.ok('M2', 'device_add')
    join(w, 'T1')
    give(w, 'M', MOD)
    give(w, 'T', R1)
    const P = w.heads()
    const b = w.ok('M1', 'ban', { to: 'T' })
    const r = w.ok('M2', 'revoke', { to: 'T', role: R1 }, { ap: P })
    const S = w.state()
    expect(S.eff.has(b.id) && S.eff.has(r.id)).toBe(true)
    orderIndependent(w)
  })

  test('C1 review example: clear-Kick on laptop vs kick on phone, both at stratum 5', () => {
    const w = base()
    const R5 = role(w, 5, ROLES)
    const R2 = role(w, 3, KICK)
    join(w, 'A1')
    w.ok('A2', 'device_add')
    join(w, 'T1')
    give(w, 'A', R5)
    give(w, 'A', R2)
    const P = w.heads()
    w.ok('A1', 'role_bits', { role: R2, bit: KICK, on: false })
    w.ok('A2', 'kick', { to: 'T' }, { ap: P })
    expect(F(w).mem.has('T')).toBe(false)
    orderIndependent(w)
  })

  test('C4: quiet server, 2 h idle, real-clock invite and ban are admitted', () => {
    const w = base()
    const MOD = role(w, 3, BAN | KICK)
    join(w, 'M1')
    give(w, 'M', MOD)
    const H2 = 2 * 3600_000
    expect(w.act('O1', 'add', { to: 'B' }, { ts: H2 }).v.s).toBe('A')
    expect(w.act('B1', 'join', {}, { ts: H2 + 7200_000 }).v.s).toBe('A')
    expect(w.act('M1', 'ban', { to: 'B' }, { ts: H2 * 5 }).v.s).toBe('A')
    // ts below a parent's ts is the only clock rule
    expect(w.act('O1', 'mark', {}, { ts: 5 }).v).toEqual({ s: 'R', why: 'ts' })
  })

  test('C5: concurrent device_adds fork the identity chain; unwitnessed extra devices are void', () => {
    const w = base()
    join(w, 'A1')
    const P = w.heads()
    const adds = ['A2', 'A3', 'A4'].map(d => w.ok(d, 'device_add', {}, { ap: P }))
    const marks = adds.map(x => w.ok(x.dev, 'mark', {}, { ap: [x.id] }))
    const S = w.state()
    expect([...S.facts.devs.get('A')!]).toEqual(['A1'])
    for (const x of [...adds, ...marks]) expect(S.X.has(x.id)).toBe(true)
    // no further identity ops for A, and the void devices can't post (revision 7: citing the fork
    // explicitly, since an honest client's default parents leave the void events out)
    expect(w.act('A5', 'device_add', {}, { ap: w.heads() }).v).toEqual({
      s: 'R',
      why: 'identity-forked',
    })
    expect(w.act('A2', 'mark', {}, { ap: w.heads() }).v.s).toBe('R')
  })

  test('C5: W3 is per device and deterministic', () => {
    const w = base(INVITE)
    join(w, 'A1')
    const v = [1, 2, 3, 4, 5].map(i => w.act('A1', 'mark', {}, { ts: 100 + i }).v.s)
    expect(v).toEqual(['A', 'A', 'A', 'A', 'R']) // 4 non-exempt events per device per window
  })
})

describe('review Importants', () => {
  test("I1a: a junior's concurrent role move-down loses to the senior's move-up (stratified register)", () => {
    const w = base()
    const Q = role(w, 3, ROLES | KICK)
    const R = role(w, 1, 0)
    join(w, 'Q1')
    join(w, 'T1')
    give(w, 'Q', Q)
    give(w, 'T', R)
    const P = w.heads()
    w.ok('O1', 'role_move', { role: R, pos: 10 })
    w.ok('Q1', 'role_move', { role: R, pos: 0 }, { ap: P })
    w.ok('Q1', 'kick', { to: 'T' }, { ap: P })
    const S = F(w)
    expect(S.pos.get(R)).toBe(10)
    expect(S.mem.has('T')).toBe(true)
  })

  test("I1b: moving a role down is a deny that cuts its holders' backdated ops", () => {
    const w = base()
    const QR = role(w, 8, BAN)
    const WR = role(w, 5, 0)
    join(w, 'Q1')
    join(w, 'W1')
    give(w, 'Q', QR)
    give(w, 'W', WR)
    const P = w.heads()
    w.ok('O1', 'role_move', { role: QR, pos: 2 })
    const b = w.ok('Q1', 'ban', { to: 'W' }, { ap: P })
    const S = w.state()
    expect(S.cut.has(b.id)).toBe(true)
    expect(S.facts.ban.has('W')).toBe(false)
    expect(rank(S.facts, 'Q')).toEqual(rankOf(S.facts, QR))
  })

  test('I2: rank is part of support (revoking the high role cuts a kick that needed it)', () => {
    const w = base()
    const HIGH = role(w, 5, 0)
    const LOW = role(w, 1, KICK)
    const MID = role(w, 3, 0)
    join(w, 'T1')
    join(w, 'X1')
    give(w, 'T', HIGH)
    give(w, 'T', LOW)
    give(w, 'X', MID)
    const P = w.heads()
    w.ok('O1', 'revoke', { to: 'T', role: HIGH })
    const k = w.ok('T1', 'kick', { to: 'X' }, { ap: P })
    const S = w.state()
    expect(S.cut.has(k.id)).toBe(true)
    expect(S.facts.mem.has('X')).toBe(true)
  })

  test('S4 / I3: an ineffective kick stays ineffective when the target is demoted later', () => {
    const w = base()
    const R3 = role(w, 3, KICK)
    const R5 = role(w, 5, 0)
    join(w, 'Q1')
    join(w, 'T1')
    give(w, 'Q', R3)
    const P = w.heads()
    w.ok('O1', 'assign', { to: 'T', role: R5 })
    w.ok('Q1', 'kick', { to: 'T' }, { ap: P })
    expect(F(w).mem.has('T')).toBe(true)
    w.ok('O1', 'revoke', { to: 'T', role: R5 }) // a month later, after everything
    expect(F(w).mem.has('T')).toBe(true)
  })

  test("S5 / I4: the remover's other device can't resurrect a cut invitee by citing it", () => {
    const w = base()
    const R = role(w, 1, INVITE)
    w.ok('O2', 'device_add')
    join(w, 'X1')
    give(w, 'X', R)
    const P = w.heads()
    w.ok('O1', 'kick', { to: 'X' })
    const add = w.ok('X1', 'add', { to: 'N' }, { ap: P })
    const j = w.ok('N1', 'join', {}, { ap: [vouch(w, add).id] })
    expect(F(w).mem.has('N')).toBe(false)
    w.ok('O2', 'mark', {}, { ap: [j.id] })
    expect(F(w).mem.has('N')).toBe(false)
  })

  test("S6 / I5: duel at the same top role: both out, the loser's later grants are cut", () => {
    const w = base()
    const R5 = role(w, 5, KICK | BAN | INVITE)
    w.ok('O2', 'device_add')
    join(w, 'X1')
    join(w, 'Y1')
    join(w, 'Z1')
    const P = w.heads()
    const ax = give(w, 'X', R5, 'O1', { ap: P })
    const ay = give(w, 'Y', R5, 'O2', { ap: P })
    w.ok('X1', 'kick', { to: 'Y' }, { ap: [ax.id] })
    const ky = w.ok('Y1', 'kick', { to: 'X' }, { ap: [ay.id] })
    const bz = w.ok('Y1', 'ban', { to: 'Z' }, { ap: [ky.id] })
    const an = w.ok('Y1', 'add', { to: 'N' }, { ap: [bz.id] })
    w.ok('N1', 'join', {}, { ap: [vouch(w, an).id] })
    const S = w.state()
    expect(S.facts.mem.has('X') || S.facts.mem.has('Y')).toBe(false)
    expect(S.facts.mem.has('N')).toBe(false)
    expect(S.facts.ban.has('Z')).toBe(true) // same-stratum denies stay mutually invisible (documented)
    // the repair: an owner ban cuts everything Y does on its stale branch
    w.ok('O1', 'ban', { to: 'Y' })
    w.ok('Y1', 'ban', { to: 'W' }, { ap: [an.id] })
    expect(F(w).ban.has('W')).toBe(false)
  })

  test("I7: an upgrade can't be voided by owner equivocation; S is frozen except leave", () => {
    const w = base()
    join(w, 'R1')
    const P = w.heads()
    const u = w.ok('O1', 'upgrade', { next: 'G2' })
    const sib = w.act('O1', 'mark', {}, { ap: P, seq: u.seq, aprev: u.aprev ?? null })
    expect(sib.v.s).toBe('A')
    const S = w.state()
    expect(S.X.has(u.id)).toBe(true)
    expect(S.facts.upgraded).toEqual([u.id])
    expect(w.act('R1', 'mark').v).toEqual({ s: 'R', why: 'auth' })
    expect(w.act('R1', 'leave').v.s).toBe('A')
  })

  test('I8 analogue: honest concurrent use of two devices of one identity is never equivocation', () => {
    const w = base(INVITE)
    join(w, 'A1')
    w.ok('A2', 'device_add')
    const P = w.heads()
    w.ok('A1', 'mark', {}, { ap: P })
    w.ok('A2', 'mark', {}, { ap: P })
    w.ok('A1', 'add', { to: 'B' }, { ap: P })
    expect(w.state().X.size).toBe(0)
  })
})

describe('minors and worked outcomes', () => {
  test("M1: a junior unban doesn't lift a senior ban that is effective globally", () => {
    const w = base()
    const H = role(w, 5, BAN)
    const M = role(w, 7, ROLES | BAN)
    const J = role(w, 2, BAN)
    const TOPR = role(w, 9, 0)
    for (const d of ['H1', 'M1', 'J1', 'T1']) join(w, d)
    give(w, 'H', H)
    give(w, 'M', M)
    give(w, 'J', J)
    const P = w.heads()
    const b0 = w.ok('J1', 'ban', { to: 'T' }, { ap: P })
    const b1 = w.ok('H1', 'ban', { to: 'T' }, { ap: P })
    const c = w.ok('M1', 'revoke', { to: 'H', role: H }, { ap: P })
    w.ok('O1', 'assign', { to: 'H', role: TOPR }, { ap: P })
    const u = w.act('J1', 'unban', { to: 'T' }, { ap: [b0.id, b1.id, c.id] })
    expect(u.v.s).toBe('A')
    expect(F(w).ban.has('T')).toBe(true)
  })

  test('P1-M4: unban by someone junior to the banner is rejected', () => {
    const w = base()
    const H = role(w, 5, BAN)
    const J = role(w, 2, BAN)
    join(w, 'H1')
    join(w, 'J1')
    give(w, 'H', H)
    give(w, 'J', J)
    w.ok('H1', 'ban', { to: 'T' })
    expect(w.act('J1', 'unban', { to: 'T' }).v).toEqual({ s: 'R', why: 'auth' })
    expect(w.act('O1', 'unban', { to: 'T' }).v.s).toBe('A')
  })

  test('M2: a revoked device never returns', () => {
    const w = base()
    join(w, 'A1')
    w.ok('A2', 'device_add')
    w.ok('A1', 'device_revoke', { dk: 'A2', seen: w.latestOwn('A2')!.seq })
    expect(w.act('A2', 'device_add', {}, { aprev: w.latestOwn('A2')!.id }).v.s).toBe('R')
  })

  test('M5: an owner device fork never puts genesis in X; owners are constant', () => {
    const w = base()
    const P = w.heads()
    const a = w.ok('O1', 'mark')
    w.act('O1', 'mark', {}, { ap: P, seq: a.seq, aprev: a.aprev ?? null })
    const S = w.state()
    expect(S.X.has(w.ref.order[0])).toBe(false)
    expect([...S.facts.owners]).toEqual(['O'])
    expect(S.facts.mem.has('O')).toBe(true)
  })

  test("§3.4-1: owner's stale phone kicks X; laptop's ban and invite stand", () => {
    const w = base()
    const R = role(w, 1, INVITE)
    w.ok('O2', 'device_add')
    join(w, 'X1')
    join(w, 'S1')
    give(w, 'X', R)
    const P = w.heads()
    w.ok('O1', 'ban', { to: 'S' })
    w.ok('O1', 'add', { to: 'N' })
    w.ok('N1', 'join')
    const xa = w.ok('X1', 'add', { to: 'Q' })
    w.ok('O2', 'kick', { to: 'X' }, { ap: P })
    const S = w.state()
    expect(S.facts.ban.has('S')).toBe(true)
    expect(S.facts.mem.has('N')).toBe(true)
    expect(S.facts.mem.has('X')).toBe(false)
    expect(S.cut.has(xa.id)).toBe(true) // N2: concurrent work by the removed member is cut
  })

  test("§3.4-4 / R2-I2: banned member's backdated invites admit nobody", () => {
    const w = base()
    const R = role(w, 1, INVITE)
    join(w, 'V1')
    w.ok('V2', 'device_add')
    give(w, 'V', R)
    const P = w.heads()
    w.ok('O1', 'ban', { to: 'V' })
    const a1 = w.ok('V1', 'add', { to: 'N' }, { ap: P })
    const a2 = w.ok('V1', 'add', { to: 'M' }, { ap: P })
    w.ok('N1', 'join', {}, { ap: [vouch(w, a1).id] })
    w.ok('M1', 'join', {}, { ap: [vouch(w, a2).id] })
    const S = F(w)
    expect(S.mem.has('N') || S.mem.has('M')).toBe(false)
  })

  test("§3.4-5: a member's later equivocation doesn't unwind its witnessed invitee", () => {
    const w = base(INVITE)
    const MOD = role(w, 4, BAN)
    join(w, 'M1')
    const P = w.heads()
    const add = w.ok('M1', 'add', { to: 'Y' })
    vouch(w, add)
    w.ok('Y1', 'join')
    give(w, 'Y', MOD)
    w.ok('Y1', 'ban', { to: 'Z' })
    w.act('M1', 'mark', {}, { ap: P, seq: add.seq, aprev: add.aprev ?? null })
    const S = w.state()
    expect(S.facts.mem.has('Y')).toBe(true)
    expect(S.facts.holds.get('Y')?.has(MOD)).toBe(true)
    expect(S.facts.ban.has('Z')).toBe(true)
  })

  test('R3-I4a: three siblings at one (dev, seq) converge in all 6 delivery orders', () => {
    const w = base(INVITE)
    join(w, 'A1')
    const P = w.heads()
    const a = w.ok('A1', 'add', { to: 'B' })
    const s1 = w.build('A1', 'mark', {}, { ap: P, seq: a.seq, aprev: a.aprev ?? null })
    const s2 = w.build('A1', 'add', { to: 'C' }, { ap: P, seq: a.seq, aprev: a.aprev ?? null })
    const base0 = w.all.slice()
    const three = [a, s1, s2]
    const perms = [
      [0, 1, 2],
      [0, 2, 1],
      [1, 0, 2],
      [1, 2, 0],
      [2, 0, 1],
      [2, 1, 0],
    ]
    const out = new Set<string>()
    for (const p of perms) {
      const r = new TestReplica()
      for (const e of base0) if (!three.includes(e)) r.receive(e)
      for (const i of p) r.receive(three[i])
      out.add(evalSummary(r.state()))
    }
    expect(out.size).toBe(1)
  })

  test("role priority: a junior can't lift its role above a senior's concurrent demotion", () => {
    const w = base()
    const JR = role(w, 6, ROLES)
    const R2 = role(w, 2, 0)
    join(w, 'J1')
    join(w, 'S1')
    const SR = role(w, 8, ROLES | KICK)
    give(w, 'S', SR)
    give(w, 'J', JR)
    give(w, 'J', R2)
    const P = w.heads()
    w.ok('O1', 'role_move', { role: JR, pos: 1 }) // owner demotes J's top role
    const mv = w.ok('J1', 'role_move', { role: R2, pos: 5 }, { ap: P }) // J lifts its second role
    const S = w.state()
    expect(S.cut.has(mv.id)).toBe(true)
    expect(S.facts.pos.get(R2)).toBe(2)
    expect(rank(S.facts, 'J')).toEqual(rankOf(S.facts, R2))
  })

  test("role priority: concurrent reorders resolve by the writer's stratum first", () => {
    const w = base()
    const MODR = role(w, 8, ROLES)
    const R = role(w, 3, 0)
    join(w, 'M1')
    give(w, 'M', MODR)
    const P = w.heads()
    w.ok('O1', 'role_move', { role: R, pos: 6 }, { ap: P })
    w.ok('M1', 'role_move', { role: R, pos: 1 }, { ap: P })
    expect(F(w).pos.get(R)).toBe(6)
  })

  test('role priority: equal stratum reorders resolve to the lower position, independent of order', () => {
    const w = base()
    const A = role(w, 8, ROLES)
    const R = role(w, 3, 0)
    join(w, 'A1')
    w.ok('A2', 'device_add')
    give(w, 'A', A)
    const P = w.heads()
    w.ok('A1', 'role_move', { role: R, pos: 6 }, { ap: P })
    w.ok('A2', 'role_move', { role: R, pos: 5 }, { ap: P })
    expect(F(w).pos.get(R)).toBe(5)
    orderIndependent(w)
  })
})

describe('r2 review (revision 3): every Critical and Important counterexample', () => {
  // [R2V C1] (its RV-3, RV-3b): two moderators share one role (same stratum). P's unrelated earlier deny has the owner's promotion
  // of N in its future; Q's backdated kick of V (N's inviter) must not reach N, whom the owner ranked above Q.
  for (const variant of ['kick', 'leave'] as const) {
    test(`R2V-C1 (${variant}): an unrelated same-stratum deny never strips a senior's protection in the cascade`, () => {
      const w = base(INVITE)
      const QR = role(w, 2, KICK | BAN)
      const R5 = role(w, 5, 0)
      join(w, 'Q1')
      join(w, 'P1')
      if (variant === 'kick') join(w, 'Z1')
      give(w, 'Q', QR)
      give(w, 'P', QR)
      w.ok('O1', 'add', { to: 'V' })
      const jv = w.ok('V1', 'join')
      if (variant === 'kick') w.ok('P1', 'kick', { to: 'Z' })
      else w.ok('P1', 'leave')
      vouch(w, w.ok('V1', 'add', { to: 'N' }))
      w.ok('N1', 'join')
      w.ok('O1', 'assign', { to: 'N', role: R5 }) // N now ranks 5, above stratum 2
      vouch(w, w.ok('N1', 'add', { to: 'M' }))
      w.ok('M1', 'join')
      w.ok('O1', 'mark')
      w.ok('Q1', 'kick', { to: 'V' }, { ap: [jv.id] }) // backdated before N's invite
      const S = F(w)
      expect(S.mem.has('V')).toBe(false)
      expect(S.mem.has('N') && S.mem.has('M')).toBe(true)
      expect(S.holds.get('N')?.has(R5)).toBe(true)
      orderIndependent(w)
    })
  }

  // [R2V C2] (its CV-B): a plain member's backdated own uninvite expels an equal member it invited, with the subtree.
  test('R2V-C2: a backdated own uninvite does not expel a member who joined long ago (no Kick, no rank)', () => {
    const w = base(INVITE)
    join(w, 'A1')
    const add = w.ok('A1', 'add', { to: 'N' })
    vouch(w, add)
    w.ok('N1', 'join')
    vouch(w, w.ok('N1', 'add', { to: 'M' }))
    w.ok('M1', 'join')
    w.ok('O1', 'mark')
    const u = w.ok('A1', 'uninvite', { to: 'N' }, { ap: [add.id] }) // positioned before N's join
    const S = w.state()
    expect(S.facts.mem.has('N') && S.facts.mem.has('M')).toBe(true)
    expect(S.eff.has(u.id)).toBe(false)
    orderIndependent(w)
  })

  // C2, same root (removal needs strictly higher rank): a plain member with @everyone Ban bans an equal member by
  // positioning the ban before the member's join.
  test("R2V-C2b: a plain member can't ban an equal member by backdating to before that member's join", () => {
    const w = base(INVITE | BAN)
    join(w, 'A1')
    const P = w.heads()
    w.ok('O1', 'add', { to: 'N' })
    w.ok('N1', 'join')
    w.ok('O1', 'mark')
    const b = w.ok('A1', 'ban', { to: 'N' }, { ap: P }) // N is a non-member there
    const S = w.state()
    expect(S.eff.has(b.id)).toBe(false)
    expect(S.facts.mem.has('N') && !S.facts.ban.has('N')).toBe(true)
  })

  // C2, same root: a plain member's backdated leave from a second device cuts its own invite and, through the cascade,
  // the equal member who joined through it.
  test("R2V-C2c: a plain member's backdated leave does not expel the equal members it invited", () => {
    const w = base(INVITE)
    join(w, 'A1')
    w.ok('A2', 'device_add')
    const P = w.heads()
    vouch(w, w.ok('A1', 'add', { to: 'N' }))
    w.ok('N1', 'join')
    vouch(w, w.ok('N1', 'add', { to: 'M' }))
    w.ok('M1', 'join')
    w.ok('A2', 'leave', {}, { ap: P }) // positioned before A1's invite
    const S = F(w)
    expect(S.mem.has('A')).toBe(false)
    expect(S.mem.has('N') && S.mem.has('M')).toBe(true)
  })

  // C2, ranked variant: an inviter ranked above the invitee but without Kick.
  test("R2V-C2d: a ranked inviter without Kick can't expel its invitee by a backdated uninvite", () => {
    const w = base()
    const IR = role(w, 3, INVITE)
    join(w, 'A1')
    give(w, 'A', IR)
    const add = w.ok('A1', 'add', { to: 'N' })
    vouch(w, add)
    w.ok('N1', 'join')
    w.ok('O1', 'mark')
    w.ok('A1', 'uninvite', { to: 'N' }, { ap: [add.id] })
    expect(F(w).mem.has('N')).toBe(true)
  })

  // [R2V C3] (its RV-5, REM2): a thief on A's stolen device A2 plants a backdated invite at stratum 8 (N joins), then forks A's
  // identity chain by replaying A2's device certificate at an old position. Recovery must still be admissible and must
  // cut the planted invite and its join.
  for (const remedy of ['device_revoke', 'primary_rotate'] as const) {
    test(`R2V-C3 (${remedy}): an identity fork can't block recovery from a stolen device`, () => {
      const w = base(INVITE)
      const R8 = role(w, 8, 0)
      const ja = join(w, 'A1')
      const a2 = w.ok('A2', 'device_add')
      give(w, 'A', R8)
      const P = w.heads() // A ranks 8 here
      w.ok('O1', 'revoke', { to: 'A', role: R8 }) // the owner demotes A to ⊥
      const Q = w.heads() // the last point A trusts: before anything the thief did
      const add = w.ok('A2', 'add', { to: 'N' }, { ap: P }) // the thief backdates to stratum 8
      const j = w.ok('N1', 'join', {}, { ap: [vouch(w, add).id] })
      // the thief replays A2's introduction at a position before it: same iprev, so A's identity chain forks
      const fork = w.act(
        'A2',
        'device_add',
        {},
        { ap: [ja.id], seq: 50, aprev: null, iprev: ja.id }
      )
      expect(fork.v.s).toBe('A')
      w.ok('O1', 'mark') // the owner's client holds the fork evidence
      // On the heads, a revocation is admitted although the chain is forked (r2: "identity-forked"); its watermark must
      // cover what it holds, so it stops only what the thief signs later.
      const heads =
        remedy === 'device_revoke'
          ? w.build('A1', 'device_revoke', { dk: 'A2', seen: 50 })
          : w.build('A1', 'primary_rotate', { keep: [], seen: { A2: 50 } })
      const hv = new TestReplica()
      for (const e of w.all) hv.receive(e)
      hv.receive(heads)
      expect(hv.status.get(heads.id)?.s).toBe('A')
      // To disown what the thief already signed, the client positions the revocation at the last point it trusts (§3.9).
      const rec =
        remedy === 'device_revoke'
          ? w.act('A1', 'device_revoke', { dk: 'A2', seen: a2.seq }, { ap: Q })
          : w.act('A1', 'primary_rotate', { keep: [], seen: { A2: a2.seq } }, { ap: Q })
      expect(rec.v.s).toBe('A')
      w.ok('O1', 'mark')
      const S = w.state()
      expect([...S.FI.values()].some(d => d < Infinity)).toBe(true) // A's identity chain is forked
      expect(S.cut.has(add.id) && S.cut.has(j.id)).toBe(true)
      expect(S.facts.mem.has('N')).toBe(false)
      expect(S.facts.devs.get('A')?.has('A2') ?? false).toBe(false)
      if (remedy === 'primary_rotate') expect(w.act('A3', 'device_add').v.s).toBe('A') // the new epoch is not forked
      orderIndependent(w)
    })
  }

  // [R2V C4] (its CV-A): genesis owners [O, B]; O posts upgrade as its first act, concurrently with B's first join.
  test("R2V-C4: one co-owner can't transfer the server alone by placing the upgrade before the other's join", () => {
    const w = new AclWorld()
    w.genesis('O1', ['O', 'B'], INVITE)
    const G = w.heads()
    const u = w.act('O1', 'upgrade', { g: 'G2' }, { ap: G })
    const jb = w.act('B1', 'join', {}, { ap: G })
    expect(u.v.s).toBe('R')
    expect(jb.v.s).toBe('A')
    expect(F(w).upgraded).toEqual([])
    expect(F(w).mem.has('B')).toBe(true)
    expect(w.act('O1', 'upgrade', { g: 'G2', sigs: { B: 'sig' } }).v.s).toBe('A') // with B's countersignature
  })

  // [R2V I1] (its RV-2): member A registers its own code with the owner's hash at an older position, then revokes it.
  test("R2V-I1: holding a code's hash grants no authority over it", () => {
    const w = base(INVITE)
    join(w, 'A1')
    const P0 = w.heads()
    const oc = w.ok('O1', 'code', { h: 'h1' })
    const oa = w.ok('O1', 'add', { to: 'N', code: R3 ? oc.id : 'h1' })
    const jn = w.ok('N1', 'join', {}, { ap: [oa.id] })
    const ac = w.ok('A1', 'code', { h: 'h1' }, { ap: P0 }) // a copy of the published hash, positioned before the owner's
    const rv = w.act('A1', 'code_revoke', { h: 'h1', code: ac.id }, { ap: [ac.id] })
    expect(rv.v.s).toBe('A') // A may revoke its own code
    const S = w.state()
    expect(S.facts.codes.has(R3 ? oc.id : 'h1')).toBe(true) // the owner's code is untouched
    expect(S.cut.has(jn.id)).toBe(false)
    expect(S.facts.mem.has('N')).toBe(true)
    expect(w.act('O1', 'add', { to: 'K', code: R3 ? oc.id : 'h1' }).v.s).toBe('A')
  })

  // [R2V I2] (its RV-8): the server runs for 100 windows; a member idle since its join then replays the elapsed ts range.
  // Revision 4 ([R3V I1], [R3V I3]): revision 3 asserted "at most two caps", which only an anchor that blocks quiet servers
  // can give; this burst is the same DAG as a lone member posting at that rate on a server whose others are idle (§4.1).
  // The realized bound: events nobody else acknowledged are within the day budget (dayMul × cap per day of ts span).
  test("R2V-I2: an idle member's backlog is bounded by the day budget per day of its own ts span", () => {
    const w = base(INVITE)
    join(w, 'B1')
    const ja = join(w, 'A1')
    for (let i = 1; i <= 100; i++) {
      w.ok('O1', 'profile', { name: i % 3 }, { ts: 10 * i + 10 })
      w.ok('B1', 'profile', { name: i % 3 }, { ts: 10 * i + 15 })
    }
    let admitted = 0,
      ts = ja.ts + 3
    for (let i = 0; i < 400; i++, ts += 3)
      if (w.act('A1', 'mark', {}, { ap: [ja.id], ts }).v.s === 'A') admitted++
    const days = Math.ceil((ts - ja.ts) / MODEL_LIMITS.day)
    expect(admitted).toBeLessThanOrEqual(R4 ? dayBudget() * days : 2 * MODEL_LIMITS.w3)
    // revision 5 (§7.7, changed assertion): the model's day budget is one event per window for everyone (production 24
    // per day), 24 per model day instead of revision 4's 16 for members; the backlog stays below a third of the burst
    expect(admitted).toBeLessThan(R5 ? 400 / 3 : 400 / 4)
  })

  // [R2V I3] (its RV-9): the owner posts 300 inert events at one ts.
  test('R2V-I3: owners are rate-limited for events that are not moderation', () => {
    const w = base(INVITE)
    // revision 4: the moderation the owner keeps is against a member; a ban of a stranger is charged to W3 ([R3V I2])
    if (R4) join(w, 'T1')
    const t0 = R4 ? 5 + w.state().facts.mem.size : 5
    let admitted = 0
    for (let i = 0; i < 300; i++)
      if (w.act('O1', i % 2 ? 'mark' : 'x_future', {}, { ts: t0 }).v.s === 'A') admitted++
    expect(admitted).toBeLessThanOrEqual(MODEL_LIMITS.w3mod)
    // moderation stays exempt: a ban is admitted at the same ts
    expect(w.act('O1', 'ban', { to: 'T' }, { ts: t0 }).v.s).toBe('A')
  })

  // [R2V I4] (its RV-11): a member with ManageRoles builds a chain of role_creates from a position before the owner's four.
  // Revision 3 corrects the stated bound (§4.1): each device chain stays within the cap on its own, so the live total is
  // at most cap × (device chains creating roles); the next role_create that sees them all is refused.
  test('R2V-I4: a backdated chain can overshoot a global cap only up to cap per device chain, and the next one is refused', () => {
    const w = base()
    const MR = role(w, 9, ROLES)
    join(w, 'M1')
    give(w, 'M', MR)
    const P = w.heads()
    for (let i = 0; i < 4; i++) w.ok('O1', 'role_create', { pos: 1, bits: 0 }, { ts: 100 + 2 * i })
    let mine = 0
    for (let i = 0; i < 6; i++)
      if (w.act('M1', 'role_create', { pos: 2, bits: 0 }, { ap: P, ts: 100 + 2 * i }).v.s === 'A')
        mine++
    const live = F(w).roles.size
    expect(mine).toBe(MODEL_LIMITS.roles - 1) // the chain sees MR plus its own creates
    expect(live).toBeGreaterThan(MODEL_LIMITS.roles)
    expect(live).toBeLessThanOrEqual(MODEL_LIMITS.roles * 2)
    expect(w.act('O1', 'role_create', { pos: 1, bits: 0 }).v).toEqual({ s: 'R', why: 'W5' })
  })
})

describe('revision 3: boundaries of the fixes', () => {
  test('C1 attribution: a join that only two same-stratum causes break together is cut (two removed inviters)', () => {
    const w = base(INVITE)
    const QR = role(w, 3, KICK)
    join(w, 'Q1')
    join(w, 'R1')
    give(w, 'Q', QR)
    give(w, 'R', QR)
    join(w, 'A1')
    join(w, 'B1')
    const P0 = w.heads()
    const aa = w.ok('A1', 'add', { to: 'N' }, { ap: P0 })
    const ba = w.ok('B1', 'add', { to: 'N' }, { ap: P0 }) // concurrent: neither saw the other's invite
    const j = w.ok('N1', 'join', {}, { ap: [vouch(w, aa).id, ba.id] })
    w.ok('Q1', 'kick', { to: 'A' }, { ap: P0 })
    w.ok('R1', 'kick', { to: 'B' }, { ap: P0 })
    const S = w.state()
    expect(S.cut.has(aa.id) && S.cut.has(ba.id) && S.cut.has(j.id)).toBe(true)
    expect(S.facts.mem.has('N')).toBe(false)
    orderIndependent(w)
  })

  test('C1 joint break (revision 4, N19 closed): a support that falls only to two causes together does not reach an author protected against one of them', () => {
    // P holds Invite through two roles given by V1 and V2; two moderators at stratum 3 remove V1 and V2 concurrently, so
    // P's invite falls only to both together. The owner promoted N above 3 concurrently with the first removal but after
    // the second: N is protected against the first. Revision 3 cut N's join (N19, attribution to the second removal);
    // the exact rule keeps it: the causes N is exposed to (the second removal) alone break nothing N relied on.
    const w = base()
    const QR = role(w, 3, KICK)
    const VR = role(w, 2, ROLES)
    const R1 = role(w, 1, INVITE)
    const R2 = role(w, 1, INVITE)
    const HR = role(w, 5, 0)
    for (const d of ['Q1', 'R1', 'V1', 'W1', 'P1']) join(w, d)
    give(w, 'Q', QR)
    give(w, 'R', QR)
    give(w, 'V', VR)
    give(w, 'W', VR)
    const P0 = w.heads()
    const g1 = w.ok('V1', 'assign', { to: 'P', role: R1 }, { ap: P0 })
    const g2 = w.ok('W1', 'assign', { to: 'P', role: R2 }, { ap: P0 })
    const add = w.ok('P1', 'add', { to: 'N' }, { ap: [g1.id, g2.id] })
    const j = w.ok('N1', 'join', {}, { ap: [vouch(w, add).id] })
    w.ok('Q1', 'kick', { to: 'V' }, { ap: P0 })
    const k2 = w.ok('R1', 'kick', { to: 'W' }, { ap: P0 })
    const pr = w.build('O1', 'assign', { to: 'N', role: HR }, { ap: [j.id] }) // control: concurrent with both removals
    w.ok('O1', 'assign', { to: 'N', role: HR }, { ap: [j.id, k2.id] })
    const S = w.state()
    expect(S.cut.has(g1.id) && S.cut.has(g2.id) && S.cut.has(add.id)).toBe(true)
    expect(S.cut.has(j.id)).toBe(!R4) // revision 3: cut (N19); revision 4: kept
    expect(S.facts.mem.has('N')).toBe(R4)
    orderIndependent(w)
    // control: with the promotion concurrent with both removals, N is protected against both and keeps its join
    const c = new TestReplica()
    for (const e of w.all) if (!(e.t === 'assign' && e.c.role === HR)) c.receive(e)
    c.receive(pr)
    expect(c.state().cut.has(add.id)).toBe(true)
    expect(c.state().cut.has(j.id)).toBe(false)
    // control: without any promotion N is exposed to both and its join falls to the two removals together
    const d = new TestReplica()
    for (const e of w.all) if (!(e.t === 'assign' && e.c.role === HR)) d.receive(e)
    expect(d.state().cut.has(j.id)).toBe(true)
  })

  for (const later of ['leave', 'owner kick'] as const) {
    test(`H8 (${later}): a later departure never exposes what a member did while ranked (seed 5263)`, () => {
      const w = base()
      const VR = role(w, 1, INVITE)
      const QR = role(w, 4, BAN)
      const HR = role(w, 6, INVITE)
      join(w, 'A1')
      give(w, 'A', QR)
      const jv = join(w, 'V1')
      give(w, 'V', VR)
      vouch(w, w.ok('V1', 'add', { to: 'N' }))
      w.ok('N1', 'join')
      give(w, 'N', HR) // N now ranks 6, above A's 4
      const an = w.ok('N1', 'add', { to: 'M' })
      vouch(w, an)
      w.ok('M1', 'join')
      if (later === 'leave') w.ok('N1', 'leave')
      else w.ok('O1', 'kick', { to: 'N' })
      w.ok('A1', 'ban', { to: 'V' }, { ap: [jv.id] }) // backdated before V's invite of N
      const S = w.state()
      expect(S.facts.ban.has('V')).toBe(true)
      expect(S.cut.has(an.id)).toBe(false) // N's invite was made at stratum 6
      expect(S.facts.mem.has('M')).toBe(true)
      orderIndependent(w)
    })
  }

  test("H9: a senior's concurrent demotion lowers the effective stratum of what the member did meanwhile (seed 14605)", () => {
    const w = base(INVITE)
    const R7 = role(w, 7, 0)
    const JR = role(w, 5, KICK)
    join(w, 'J1')
    give(w, 'J', JR)
    join(w, 'N1')
    const P0 = w.heads() // N is a plain member here
    const g = give(w, 'N', R7) // N now ranks 7, above J
    const an = w.ok('N1', 'add', { to: 'M' }, { ap: [g.id] }) // k = 7; an invite does not rely on rank
    w.ok('M1', 'join', {}, { ap: [vouch(w, an).id] })
    w.ok('O1', 'role_move', { role: R7, pos: 1 }, { ap: [g.id] }) // the owner concurrently moves N's role below J
    w.ok('J1', 'kick', { to: 'N' }, { ap: P0 })
    const S = w.state()
    expect(S.facts.mem.has('N')).toBe(false)
    expect(S.cut.has(an.id)).toBe(true) // k*(an) fell to 1 with the owner's move, below the kick's stratum 5
    expect(S.facts.mem.has('M')).toBe(false)
    orderIndependent(w)
  })

  test('C2 boundary: an inviter holding Kick and ranked above its invitee still wins the race (N9)', () => {
    const w = base()
    const Q = role(w, 3, INVITE | KICK)
    join(w, 'Q1')
    give(w, 'Q', Q)
    const add = w.ok('Q1', 'add', { to: 'N' })
    vouch(w, add)
    w.ok('N1', 'join')
    w.ok('Q1', 'uninvite', { to: 'N' }, { ap: [add.id] })
    expect(F(w).mem.has('N')).toBe(false)
  })

  test("C2 boundary: a moderator's ban of a non-member beats the concurrent join of a member ranked below it", () => {
    const w = base(INVITE)
    const MOD = role(w, 3, BAN)
    join(w, 'A1')
    give(w, 'A', MOD)
    const P = w.heads()
    w.ok('O1', 'add', { to: 'N' })
    w.ok('N1', 'join')
    w.ok('A1', 'ban', { to: 'N' }, { ap: P })
    const S = F(w)
    expect(S.ban.has('N') && !S.mem.has('N')).toBe(true)
  })

  test("C3 boundary: a revocation's watermark covers what its position holds; thief acts after it are cut (H2 path)", () => {
    const w = base(INVITE)
    join(w, 'A1')
    w.ok('A2', 'device_add')
    const m = w.ok('A2', 'mark')
    expect(w.act('A1', 'primary_rotate', { keep: [], seen: { A2: m.seq - 1 } }).v).toEqual({
      s: 'R',
      why: 'seen',
    })
    w.ok('A1', 'primary_rotate', { keep: [], seen: { A2: m.seq } })
    expect(w.act('A2', 'mark').v.s).toBe('R') // the dropped device is gone
  })

  test("C3 boundary: a rotation's watermark must cover every device it drops, also one revoked before (O3-heads)", () => {
    const w = base(INVITE)
    join(w, 'A1')
    w.ok('A2', 'device_add')
    w.ok('A1', 'mark')
    const m = w.ok('A1', 'mark')
    w.ok('A2', 'device_revoke', { dk: 'A1', seen: m.seq })
    // A1 is already revoked; a rotation on the heads that drops it must not reach back below what it holds
    expect(w.act('A2', 'primary_rotate', { keep: [], seen: { A1: 1 }, pcert: 'p2' }).v).toEqual({
      s: 'R',
      why: 'seen',
    })
    expect(w.act('A2', 'primary_rotate', { keep: [], seen: { A1: m.seq }, pcert: 'p2' }).v.s).toBe(
      'A'
    )
    expect(w.state().cut.size).toBe(0)
  })

  test('M3: two concurrent primary_rotates leave no primary until a rotation that sees both', () => {
    const w = base(INVITE)
    join(w, 'A1')
    w.ok('A2', 'device_add')
    const P = w.heads()
    const r1 = w.ok('A1', 'primary_rotate', { keep: ['A2'], seen: {}, pcert: 'p1' }, { ap: P })
    const r2 = w.ok('A2', 'primary_rotate', { keep: ['A1'], seen: {}, pcert: 'p2' }, { ap: P })
    expect(w.act('A3', 'device_add', {}, { ap: [r1.id, r2.id] }).v).toEqual({
      s: 'R',
      why: 'identity-forked',
    })
    w.ok('A1', 'primary_rotate', { keep: [], seen: { A2: r2.seq } }, { ap: [r1.id, r2.id] })
    expect(w.act('A3', 'device_add').v.s).toBe('A')
  })

  test('C4 boundary: a co-owner who left must still countersign (owners are a genesis constant)', () => {
    const w = new AclWorld()
    w.genesis('O1', ['O', 'B'], INVITE)
    w.ok('B1', 'join')
    w.ok('B1', 'leave')
    expect(w.act('O1', 'upgrade', { g: 'G2' }).v.s).toBe('R')
    expect(w.act('O1', 'upgrade', { g: 'G2', sigs: { B: 'sig' } }).v.s).toBe('A')
  })

  test("I1 boundary: a moderator ranked above the issuer, with ManageServer, may revoke another's code", () => {
    const w = base(INVITE)
    const MS = role(w, 4, SERVER)
    join(w, 'A1')
    join(w, 'M1')
    give(w, 'M', MS)
    const c = w.ok('A1', 'code', { h: 'h1' })
    w.ok('M1', 'code_revoke', { code: c.id })
    expect(F(w).codes.has(c.id)).toBe(false)
  })
})

describe('r3 review (revision 4): every Critical and Important counterexample', () => {
  // [R3V C1] (its RV3-C1): moderators Q and P share role QR (stratum 2). Z posts an ACL event; P removes Z (or leaves) from a
  // position before it, so that event is cut at stratum 2. After that, U invites V, V invites N, the owner promotes N
  // above stratum 2, N invites M. Q kicks U from before U's invite. N is protected against Q's kick (the promotion is
  // concurrent with it); it is exposed to P's unrelated cut only (the promotion is after it). Revision 3 relabelled the
  // cuts of V's join and invite with P's cause, because Z's cut event lay in their causal past, and so cut N and M.
  type C1 = {
    hi?: number
    sibling?: 'kick' | 'ban' | 'leave'
    twoSiblings?: boolean
    depth?: 2 | 3
    promote?: boolean
  }
  function rv3c1(o: C1 = {}) {
    const w = base(INVITE)
    const QR = role(w, 2, KICK | BAN)
    const RH = role(w, o.hi ?? 5, 0)
    for (const d of ['Q1', 'P1', 'Z1', 'U1']) join(w, d)
    if (o.twoSiblings) {
      join(w, 'R1')
      join(w, 'Y1')
    }
    if (o.sibling === 'leave') w.ok('P2', 'device_add')
    give(w, 'Q', QR)
    give(w, 'P', QR)
    if (o.twoSiblings) give(w, 'R', QR)
    const Z0 = w.heads()
    if (o.sibling === 'leave') {
      w.ok('P1', 'profile', { name: 1 })
      w.ok('P2', 'leave', {}, { ap: Z0 }) // P's own profile write did not see the leave: cut at stratum 2
    } else {
      w.ok('Z1', 'profile', { name: 1 })
      w.ok('P1', o.sibling ?? 'kick', { to: 'Z' }, { ap: Z0 })
    }
    if (o.twoSiblings) {
      const Y0 = w.heads()
      w.ok('Y1', 'mark')
      w.ok('R1', 'ban', { to: 'Y' }, { ap: Y0 })
    }
    const P0 = w.heads() // holds the unrelated cut and the event it cut
    const chain = (o.depth ?? 2) === 3 ? ['V', 'W', 'N'] : ['V', 'N']
    let prev = 'U'
    for (const x of chain) {
      vouch(w, w.ok(`${prev}1`, 'add', { to: x }))
      w.ok(`${x}1`, 'join')
      prev = x
    }
    if (o.promote !== false) w.ok('O1', 'assign', { to: 'N', role: RH }) // N now ranks above stratum 2
    const am = w.ok('N1', 'add', { to: 'M' })
    vouch(w, am)
    w.ok('M1', 'join')
    w.ok('O1', 'mark')
    w.ok('Q1', 'kick', { to: 'U' }, { ap: P0 }) // backdated before U's invite
    return { w, RH, am }
  }
  const cases: [string, C1][] = [
    ['kick, N at pos 5', {}],
    ['kick, N at pos 9', { hi: 9 }],
    ['ban', { sibling: 'ban' }],
    ['leave', { sibling: 'leave' }],
    [
      'two unrelated cuts by two other moderators, three-level chain',
      { twoSiblings: true, depth: 3 },
    ],
  ]
  for (const [name, o] of cases) {
    test(`RV3-C1 (${name}): an unrelated same-stratum cut in the shared past never strips a senior's protection`, () => {
      const { w, RH, am } = rv3c1(o)
      const S = w.state()
      expect(S.facts.mem.has('U') || S.facts.mem.has('V')).toBe(false) // the chain above N falls to Q's kick
      expect(S.facts.mem.has('N') && S.facts.mem.has('M')).toBe(true)
      expect(S.facts.holds.get('N')?.has(RH)).toBe(true)
      expect(S.cut.has(am.id)).toBe(false)
      orderIndependent(w)
    })
  }
  test('RV3-C1 control: without the promotion, N and M are exposed and fall with the chain', () => {
    const { w } = rv3c1({ promote: false })
    const S = w.state()
    expect(S.facts.mem.has('N') || S.facts.mem.has('M')).toBe(false)
    orderIndependent(w)
  })

  // [R3V I1] (its RV3-I2): the server is busy for 100 windows; a member idle since its join emits 400 marks across the
  // elapsed range, each citing the newest honest event dated at or before it. Revision 3's anchor followed the cited
  // events, so 344 were admitted (7 with a fixed anchor). The budget must not depend on what the backlog cites.
  test('RV3-I1: anchor-shopping grants nothing: a backlog gets the same budget whatever honest events it cites', () => {
    const run = (shop: boolean) => {
      const w = base(INVITE)
      join(w, 'B1')
      const ja = join(w, 'A1')
      const honest: { id: string; ts: number }[] = []
      for (let i = 1; i <= 100; i++) {
        honest.push(w.ok('O1', 'profile', { name: i % 3 }, { ts: 10 * i + 10 }))
        honest.push(w.ok('B1', 'profile', { name: i % 3 }, { ts: 10 * i + 15 }))
      }
      let admitted = 0,
        ts = ja.ts + 3
      for (let i = 0; i < 400; i++, ts += 3) {
        const anchor = shop ? [...honest].reverse().find(h => h.ts <= ts) : undefined
        if (w.act('A1', 'mark', {}, { ap: [anchor?.id ?? ja.id], ts }).v.s === 'A') admitted++
      }
      return { admitted, days: Math.ceil((ts - ja.ts) / MODEL_LIMITS.day) }
    }
    const shop = run(true),
      fixed = run(false)
    if (TOT) {
      // revision 5, dispatch 5b: a total of totU unacknowledged events per device, whatever the backlog cites. The only
      // difference is A's join, which the honest events (made after it, citing it) really acknowledged in the shopping
      // run and nobody acknowledged in the other; none of the 400 marks is ever acknowledged in either
      expect(fixed.admitted).toBe(MODEL_LIMITS.totU - 1)
      expect(shop.admitted).toBe(MODEL_LIMITS.totU)
    } else {
      expect(shop.admitted).toBe(fixed.admitted)
      expect(shop.admitted).toBeLessThanOrEqual(dayBudget() * shop.days)
    }
  })

  // [R3V I3] (its RV3-live): an owner alone posting profile writes, and a member whose only peer (the owner) is idle,
  // were capped for good by revision 3's anchor (8 of 100, 4 of 100).
  test('RV3-I3: a quiet server never blocks honestly spaced posting (owner alone; a member whose only peer is idle)', () => {
    const own = (spacing: number) => {
      const w = base(INVITE)
      let n = 0
      for (let i = 1; i <= 100; i++)
        if (w.act('O1', 'profile', { name: i % 3 }, { ts: spacing * i }).v.s === 'A') n++
      return n
    }
    if (!TOT) {
      expect(own(100)).toBe(100) // the reviewer's spacing
      expect(own(10)).toBe(100) // one per window, no other author ever
    } else {
      // revision 5, dispatch 5b (controller ruling on growth): a lone device is blocked after totU ACL events that no
      // other identity acknowledged, however they are spaced; the first event of another identity that has them in its
      // past lets it go on (spec §4.1, §6.2 N12)
      expect(own(100)).toBe(MODEL_LIMITS.totU)
      expect(own(10)).toBe(MODEL_LIMITS.totU)
    }
    const w = base(INVITE)
    const ja = join(w, 'A1')
    let n = 0
    for (let i = 1; i <= 100; i++)
      if (w.act('A1', 'mark', {}, { ts: ja.ts + 20 * i }).v.s === 'A') n++
    if (!TOT)
      expect(n).toBe(100) // a member posting every second window while the owner is idle
    else {
      expect(n).toBe(MODEL_LIMITS.totU - 1) // its join and totU − 1 marks, then blocked while the owner is idle
      const last = w.latestOwn('A1')!
      w.ok('O1', 'mark', {}, { ap: [last.id], ts: last.ts + 1 }) // the owner comes back: one ACL event citing A's
      let m = 0
      for (let i = 1; i <= 100; i++)
        if (w.act('A1', 'mark', {}, { ts: last.ts + 1 + 20 * i }).v.s === 'A') m++
      expect(m).toBe(MODEL_LIMITS.totU)
    }
  })

  // [R3V I2] (its RV3-I2-ban): a moderator bans 60 never-seen principals at one ts; a member posts 500 no-op rotations.
  test('RV3-I2: bans of principals never seen are charged to W3; bans and kicks of members stay exempt', () => {
    const w = base(INVITE)
    const MOD = role(w, 5, BAN | KICK)
    join(w, 'M1')
    give(w, 'M', MOD)
    const mem: string[] = []
    for (let i = 0; i < 20; i++) {
      join(w, `T${i}x1`)
      mem.push(`T${i}x`)
    }
    const ts = Math.max(...w.ref.order.map(id => w.ref.ev(id).ts)) + 1
    let strangers = 0
    for (let i = 0; i < 60; i++)
      if (w.act('M1', 'ban', { to: `stranger${i}` }, { ts }).v.s === 'A') strangers++
    expect(strangers).toBeLessThanOrEqual(MODEL_LIMITS.w3mod)
    let members = 0,
      acks = 0
    for (const T of mem) {
      let r = w.act('M1', T < 'T5' ? 'kick' : 'ban', { to: T }, { ts })
      if (TOT && r.v.s === 'R' && (r.v as { why?: string }).why === 'W3b') {
        // revision 5, dispatch 5b ([H18]): moderation is exempt from the hourly cap but counted in the unacknowledged
        // total; another member's ACL event that has the removals in its past lets the moderator go on
        w.ok('O1', 'mark', {}, { ap: [w.latestOwn('M1')!.id], ts })
        acks++
        r = w.act('M1', T < 'T5' ? 'kick' : 'ban', { to: T }, { ts })
      }
      if (r.v.s === 'A') members++
    }
    expect(members).toBe(mem.length) // all 20 in one window: more than the moderators' hourly cap
    expect(members).toBeGreaterThan(MODEL_LIMITS.w3mod)
    if (TOT) expect(acks).toBeGreaterThan(0)
  })
  test('RV3-M2: a no-op primary_rotate is refused (W6); rotations and device churn are capped per identity', () => {
    const w = base(INVITE)
    join(w, 'A1')
    w.ok('A2', 'device_add')
    expect(w.act('A1', 'primary_rotate', { keep: ['A2'], seen: {} }).v.s).toBe('R') // changes nothing
    let rot = 0
    for (let i = 0; i < 500; i++)
      if (w.act('A1', 'primary_rotate', { keep: ['A2'], seen: {}, pcert: `p${i}` }).v.s === 'A')
        rot++
    expect(rot).toBeLessThanOrEqual(MODEL_LIMITS.rotCap ?? 0)
    // device churn through fresh devices: each new device has an empty chain, so only a per-identity cap bounds it
    const c = base(INVITE)
    join(c, 'B1')
    let adds = 0
    for (let i = 2; i < 40; i++) {
      const r = c.act(`B${i}`, 'device_add')
      if (r.v.s !== 'A') continue
      adds++
      c.ok('B1', 'device_revoke', { dk: `B${i}`, seen: r.e.seq })
    }
    expect(adds).toBeLessThanOrEqual(MODEL_LIMITS.idCap ?? 0)
  })

  // boundary of the exact rule: inside the world of P's invite (the causes P is exposed to), X's grant counts only through
  // the causes X itself is exposed to. Q and S kick A, R kicks B (all stratum 3), concurrently with A's and B's grants
  // of ManageRoles roles to X, X's grant of an Invite role to P, and P's invite. The owner promotes X concurrently with
  // Q's kick only, and P concurrently with S's kick only. X's grant falls (to R and S together). P is exposed to Q and R;
  // in that world X keeps A's grant (only Q, which X is protected against, takes it), so X's grant to P stands and P's
  // invite stays. Judging X in P's world without X's own exposure cuts the invite (mutant world-flat).
  test('C1 exact boundary: an earlier op counts in a world only through causes its own author is exposed to', () => {
    const w = base()
    w.ok('O2', 'device_add')
    const QR = role(w, 3, KICK)
    const AR = role(w, 2, ROLES)
    const R1 = role(w, 1, ROLES)
    const R2 = role(w, 1, ROLES)
    const R3 = role(w, 0, INVITE)
    const HR = role(w, 5, 0)
    for (const d of ['Q1', 'R1', 'S1', 'A1', 'B1', 'X1', 'P1']) join(w, d)
    for (const m of ['Q', 'R', 'S']) give(w, m, QR)
    give(w, 'A', AR)
    give(w, 'B', AR)
    const P0 = w.heads()
    const y1 = w.ok('A1', 'assign', { to: 'X', role: R1 }, { ap: P0 })
    const y2 = w.ok('B1', 'assign', { to: 'X', role: R2 }, { ap: P0 })
    const x = w.ok('X1', 'assign', { to: 'P', role: R3 }, { ap: [y1.id, y2.id] })
    const p = w.ok('P1', 'add', { to: 'N' }, { ap: [x.id] })
    const g1 = w.ok('Q1', 'kick', { to: 'A' }, { ap: P0 })
    const g3 = w.ok('S1', 'kick', { to: 'A' }, { ap: P0 })
    const g2 = w.ok('R1', 'kick', { to: 'B' }, { ap: P0 })
    w.ok('O1', 'assign', { to: 'X', role: HR }, { ap: [x.id, g2.id, g3.id] }) // X: protected against Q only
    w.ok('O2', 'assign', { to: 'P', role: HR }, { ap: [p.id, g1.id, g2.id] }) // P: protected against S only
    const S = w.state()
    expect(S.cut.has(y1.id) && S.cut.has(y2.id) && S.cut.has(x.id)).toBe(true)
    expect(S.cut.has(p.id)).toBe(false)
    expect(S.facts.pending.has('N')).toBe(true)
    orderIndependent(w)
  })

  // the class cap (§3.1 step 4): beyond MODEL_LIMITS.classes protection classes at one stratum, the sound fallback. Q kicks A, who
  // gave X a ManageRoles role; X gave P an Invite role; P invites N. R and S remove Z and Y, who gave K and L an Invite
  // role concurrently; K and L invite. The owner promotes P after Q's kick, concurrently with R's and S's: P is exposed
  // to Q's kick only, which breaks P's support, so the exact rule cuts P's invite. With K and L promoted concurrently with
  // different removals, their invites (which the removals of Z and Y can cut) make 3 classes; the fallback then counts
  // X's cut grant for P only if X's own world lies inside P's, which it doesn't (X is exposed to all three), so P's
  // invite stays: the documented residual (fail-open for an author a senior protected against some cause of the stratum;
  // N19). The fallback never cuts what the exact rule keeps. (Revision 5, dispatch 5b, [H16]: classes are counted among
  // the ops the causes could cut; K's and L's invites are such ops, the marks of the revision-4 version were not.)
  // Revision 5, dispatch 5b ([H17] (c)): the fallback's subset test is projected onto G(x), the causes with a direct cut
  // in x's causal past (an op's cut in a world depends only on that part). Revision 7c (r7 re-review C1): classes are
  // U ∩ Γ⁺ for the whole stratum, no longer U ∩ G(q) per op (which an author picks with its parents, vectors "r7c"). In
  // the "extra" shape P, K and L are each protected against two of the three kicks: three classes, the fallback, which
  // still cuts P's invite because X's grant, cut in its own world {Q's kick}, lies inside P's (mutant class-proj-off,
  // whose fallback test is unprojected, keeps it; revisions 5–7 counted no class here and ran the exact rule). In the
  // "multi" shape the invites and X's grant cite the other removed members' grants too: X's world is all three kicks, not
  // inside P's, and the fallback keeps P's invite (N19).
  for (const [extra, multi] of [
    [false, false],
    [true, false],
    [true, true],
  ]) {
    test(`C1 class cap (${multi ? "3 classes: fallback keeps P's invite" : extra ? "3 classes: the projected fallback still cuts P's invite" : "1 class: exact rule cuts P's invite"})`, () => {
      const w = base(INVITE)
      w.ok('O2', 'device_add')
      const QR = role(w, 3, KICK | BAN)
      const AR = role(w, 2, ROLES)
      const R1 = role(w, 1, ROLES)
      const R3 = role(w, 0, INVITE)
      const HR = role(w, 5, 0)
      for (const d of ['Q1', 'R1', 'S1', 'A1', 'X1', 'P1', 'Z1', 'Y1', 'K1', 'L1']) join(w, d)
      for (const m of ['Q', 'R', 'S']) give(w, m, QR)
      for (const m of ['A', 'Z', 'Y']) give(w, m, AR)
      w.ok('O1', 'role_bits', { role: EVERYONE, bit: INVITE, on: false })
      const P0 = w.heads()
      const z = w.ok('Z1', 'assign', { to: 'K', role: R3 }, { ap: P0 })
      const y = w.ok('Y1', 'assign', { to: 'L', role: R3 }, { ap: P0 })
      const g1 = w.ok('A1', 'assign', { to: 'X', role: R1 }, { ap: P0 })
      const x = w.ok('X1', 'assign', { to: 'P', role: R3 }, { ap: multi ? [g1.id, z.id] : [g1.id] })
      const p = w.ok('P1', 'add', { to: 'N' }, { ap: multi ? [x.id, y.id] : [x.id] })
      const k = w.ok('K1', 'add', { to: 'N2' }, { ap: multi ? [z.id, g1.id] : [z.id] }) // relies on Z's grant, which R's kick cuts
      const l = w.ok('L1', 'add', { to: 'N3' }, { ap: multi ? [y.id, g1.id] : [y.id] })
      const c1 = w.ok('Q1', 'kick', { to: 'A' }, { ap: P0 })
      const c2 = w.ok('R1', 'kick', { to: 'Z' }, { ap: P0 })
      const c3 = w.ok('S1', 'kick', { to: 'Y' }, { ap: P0 })
      w.ok('O1', 'assign', { to: 'P', role: HR }, { ap: [p.id, c1.id] }) // P: exposed to Q's kick only
      if (extra) {
        w.ok('O2', 'assign', { to: 'K', role: HR }, { ap: [k.id, c2.id] }) // K: exposed to R's kick only
        w.ok('O2', 'assign', { to: 'L', role: HR }, { ap: [l.id, c3.id] }) // L: exposed to S's kick only
      }
      const S = w.state()
      expect(S.cut.has(g1.id) && S.cut.has(x.id)).toBe(true)
      expect(S.cut.has(k.id) && S.cut.has(l.id)).toBe(true) // K's and L's invites relied on the removed members' grants
      expect(S.cut.has(p.id)).toBe(!extra || !MODEL_LIMITS.classes || (TOT && !multi))
      const fe = new FastEval(Ix.of(w.ref.order, w.ref))
      fe.run()
      expect([fe.stats.maxClasses, fe.stats.fallbacks]).toEqual(extra ? [3, 1] : [1, 0])
      orderIndependent(w)
    })
  }

  // [H16] (revision 5, dispatch 5b): an event on the heads can never be cut, so it must not decide which branch of step 4
  // runs. Counted over the whole region (revisions 4 and 5a), L's mark on the heads gave the stratum a third protection
  // class (L was promoted concurrently with Q's and R's kicks, after S's): the stratum switched to the fallback and P's
  // invite, cut before, came back, although nothing was concurrent with the mark (O3-heads, G4). Now classes are counted
  // among the ops the causes could cut (the flat closure) and causes without direct cuts are left out of Γ.
  test('Class cap: an event on the heads never changes the branch or any earlier status ([H16])', () => {
    const w = base(INVITE)
    w.ok('O2', 'device_add')
    const QR = role(w, 3, KICK | BAN),
      AR = role(w, 2, ROLES),
      R1 = role(w, 1, ROLES),
      R3 = role(w, 0, INVITE),
      HR = role(w, 5, 0)
    for (const d of ['Q1', 'R1', 'S1', 'A1', 'X1', 'P1', 'Z1', 'Y1', 'K1', 'L1']) join(w, d)
    for (const m of ['Q', 'R', 'S']) give(w, m, QR)
    give(w, 'A', AR)
    w.ok('O1', 'role_bits', { role: EVERYONE, bit: INVITE, on: false })
    const P0 = w.heads()
    const z = w.ok('Z1', 'mark'),
      y = w.ok('Y1', 'mark')
    const g1 = w.ok('A1', 'assign', { to: 'X', role: R1 }, { ap: P0 })
    const x = w.ok('X1', 'assign', { to: 'P', role: R3 }, { ap: [g1.id] })
    const p = w.ok('P1', 'add', { to: 'N' }, { ap: [x.id] })
    const k = w.ok('K1', 'mark', {}, { ap: [z.id] })
    const c1 = w.ok('Q1', 'kick', { to: 'A' }, { ap: P0 })
    const c2 = w.ok('R1', 'kick', { to: 'Z' }, { ap: P0 })
    const c3 = w.ok('S1', 'kick', { to: 'Y' }, { ap: P0 })
    w.ok('O1', 'assign', { to: 'P', role: HR }, { ap: [p.id, c1.id] })
    w.ok('O2', 'assign', { to: 'K', role: HR }, { ap: [k.id, c2.id] })
    w.ok('O2', 'assign', { to: 'L', role: HR }, { ap: [y.id, c3.id] }) // L: exposed to S's kick only, no event yet
    const before = w.state()
    expect(before.cut.has(p.id)).toBe(true)
    const h = w.ok('L1', 'mark') // on the heads
    expect(w.ref.order.slice(0, -1).every(id => w.ref.anc(h.id).has(id))).toBe(true)
    const after = w.state()
    expect(after.cut.has(p.id)).toBe(true)
    expect([...after.cut.keys()].sort()).toEqual([...before.cut.keys()].sort())
    orderIndependent(w)
  })

  // [H11] a role_move can step a role down through unboundedly many positions, each a deny that changes a fact (W6);
  // revision 4 charges every role_move to W3, while demoting a member stays exempt through revoke or kick.
  test('H11: role moves are charged to W3; a revoke of the role from its holder stays exempt', () => {
    const w = base(INVITE)
    const SR = role(w, 900, ROLES | KICK)
    const R = role(w, 800, 0)
    join(w, 'M1')
    join(w, 'T1')
    give(w, 'M', SR)
    give(w, 'T', R)
    const ts = Math.max(...w.ref.order.map(id => w.ref.ev(id).ts)) + 1
    let moves = 0
    for (let p = 799; p > 700; p--)
      if (w.act('M1', 'role_move', { role: R, pos: p }, { ts }).v.s === 'A') moves++
    expect(moves).toBeLessThanOrEqual(MODEL_LIMITS.w3mod)
    expect(w.act('M1', 'revoke', { to: 'T', role: R }, { ts }).v.s).toBe('A')
  })

  // "newly broken" (§3.1), the shape of seed 70137 rebuilt by hand: revision 4's rules change that saved universe, so the
  // mutant uses-stale was no longer caught there. V invites N; the owner promotes N to pos 6 and later revokes it. M (pos
  // 5) kicks V from before V's invite, so N's join is broken at stratum 5; N is protected there by its standing when it
  // joined ([H8]: the later revoke doesn't count for the earlier join), so the join stays uncut. A (pos 3) bans N from
  // before its join: the ban is effective (in its view the revoke has demoted N), but the join is not newly broken.
  test("Newly broken (seed 70137 shape): a lower ban never cuts its target's join that a higher cut already broke", () => {
    const w = base(INVITE)
    const M5 = role(w, 5, KICK)
    const A3 = role(w, 3, KICK | BAN)
    const HR = role(w, 6, 0)
    for (const d of ['M1', 'A1', 'V1']) join(w, d)
    give(w, 'M', M5)
    give(w, 'A', A3)
    const P0 = w.heads()
    const add = w.ok('V1', 'add', { to: 'N' }, { ap: P0 })
    const jn = w.ok('N1', 'join', {}, { ap: [vouch(w, add).id] })
    w.ok('O1', 'assign', { to: 'N', role: HR }, { ap: [jn.id] })
    w.ok('O1', 'revoke', { to: 'N', role: HR })
    w.ok('M1', 'kick', { to: 'V' }, { ap: P0 })
    const b = w.ok('A1', 'ban', { to: 'N' }, { ap: P0 })
    const S = w.state()
    expect(S.cut.has(add.id)).toBe(true)
    expect(S.eff.has(b.id)).toBe(true)
    expect(S.cut.has(jn.id)).toBe(false)
    expect(S.facts.mem.has('N')).toBe(false)
    orderIndependent(w)
  })

  // boundary: a busy server's honest devices are bound by W3(a) alone; acknowledged events never count for the day
  test('W3(b) boundary: events another identity acknowledged within a window are bound by the hourly window alone', () => {
    const w = base(INVITE)
    join(w, 'A1')
    join(w, 'B1')
    let a = 0,
      t = 100
    for (let i = 0; i < 150; i++, t += 3) {
      if (w.act('A1', 'mark', {}, { ts: t }).v.s === 'A') a++
      w.ok('B1', 'profile', { name: i % 3 }, { ts: t + 1 }) // B's client sees A's mark at once and posts
    }
    expect(a).toBe(150) // 3.3 per window over 45 windows: far above the day budget, all acknowledged
  })
})

describe('r4 review (revision 5): every Critical and Important counterexample', () => {
  // [R4V C1] NM1/NM2: SA and SB (role RS, pos 18, each with a second device) raise Rs (P's and Y's role) to 15 and Ry
  // to 6 at one position. Y (Rs, and RY5 at 5) gives T the role Ry; P (Rs) then gives T the Invite role RI (NM2) or
  // kicks T (NM1); T invites N, N joins. SA leaves from a stale device; the owner promotes P after that leave and before
  // SB's, which SB posts from its stale device. Revision 4 kept Y's grant (in the result SB's leave also moves Ry back
  // below Y) and cut P's operation, which no set of causes P is exposed to cut on its own (O5-safe). Revision 5 judges
  // obstacles (T's rank, Ry's position) before this stratum's cuts: SA's leave alone takes P's and Y's rank (Rs back to
  // 3, below T at 6 and Ry at 6), so both grants fall to a cause their authors are exposed to.
  function nm2(kick: boolean) {
    const w = base()
    w.ok('O2', 'device_add')
    const RS = role(w, 18, ROLES),
      Rs = role(w, 3, KICK | ROLES),
      Ry = role(w, 4, 0),
      RY5 = role(w, 5, 0)
    const RH = role(w, 25, 0),
      RI = role(w, 2, INVITE)
    for (const d of ['SA1', 'SB1', 'P1', 'Y1', 'T1']) join(w, d)
    w.ok('SA2', 'device_add')
    w.ok('SB2', 'device_add')
    give(w, 'SA', RS)
    give(w, 'SB', RS)
    give(w, 'P', Rs)
    give(w, 'Y', Rs)
    give(w, 'Y', RY5)
    const H0 = w.heads()
    const z = w.ok('SA1', 'role_move', { role: Rs, pos: 15 }, { ap: H0 })
    const z2 = w.ok('SB1', 'role_move', { role: Ry, pos: 6 }, { ap: H0 })
    const y = w.ok('Y1', 'assign', { to: 'T', role: Ry }, { ap: [z.id, z2.id] })
    const p = kick
      ? w.ok('P1', 'kick', { to: 'T' }, { ap: [y.id] })
      : w.ok('P1', 'assign', { to: 'T', role: RI }, { ap: [y.id] })
    const add = kick ? undefined : w.ok('T1', 'add', { to: 'N' }, { ap: [p.id] })
    const jn = add ? w.ok('N1', 'join', {}, { ap: [vouch(w, add).id] }) : undefined
    const l1 = w.ok('SA2', 'leave', {}, { ap: H0 })
    w.ok('O1', 'assign', { to: 'P', role: RH }, { ap: [(jn ?? p).id, l1.id] })
    w.ok('SB2', 'leave', {}, { ap: H0 })
    w.ok('O1', 'mark')
    return { w, z, z2, y, p, add, jn }
  }
  for (const kick of [false, true]) {
    test(`NM${kick ? 1 : 2}: an obstacle is judged before the stratum's cuts, so the world of P's own cause decides P's ${kick ? 'kick' : 'grant'}`, () => {
      const { w, z, z2, y, p, jn } = nm2(kick)
      const S = w.state()
      expect(S.cut.has(z.id) && S.cut.has(z2.id)).toBe(true)
      expect(S.cut.has(y.id)).toBe(true) // revision 4: live (Ry also fell back, to 4 < Y's 5, through SB's leave)
      expect(S.cut.has(p.id)).toBe(true)
      if (jn) expect(S.facts.mem.has('N')).toBe(false)
      orderIndependent(w)
    })
  }
  // [R4V C1] NM3: as NM2 without P; Ry carries Invite; the owner promotes T after SA's leave, concurrently with SB's.
  // T is exposed to SA's leave only, which alone takes Y's grant of Ry (Y at 5 against Ry at 6): T's invite falls.
  // Revision 4 kept it although the causes T is exposed to alone cut it (O5-complete).
  test('NM3: everything the causes an author is exposed to cut on their own is cut', () => {
    const w = base()
    w.ok('O2', 'device_add')
    const RS = role(w, 18, ROLES),
      Rs = role(w, 3, KICK | ROLES),
      Ry = role(w, 4, INVITE),
      RY5 = role(w, 5, 0),
      RH = role(w, 25, 0)
    for (const d of ['SA1', 'SB1', 'Y1', 'T1']) join(w, d)
    w.ok('SA2', 'device_add')
    w.ok('SB2', 'device_add')
    give(w, 'SA', RS)
    give(w, 'SB', RS)
    give(w, 'Y', Rs)
    give(w, 'Y', RY5)
    const H0 = w.heads()
    const z = w.ok('SA1', 'role_move', { role: Rs, pos: 15 }, { ap: H0 })
    const z2 = w.ok('SB1', 'role_move', { role: Ry, pos: 6 }, { ap: H0 })
    const y = w.ok('Y1', 'assign', { to: 'T', role: Ry }, { ap: [z.id, z2.id] })
    const add = w.ok('T1', 'add', { to: 'N' }, { ap: [y.id] })
    const jn = w.ok('N1', 'join', {}, { ap: [vouch(w, add).id] })
    const l1 = w.ok('SA2', 'leave', {}, { ap: H0 })
    w.ok('O1', 'assign', { to: 'T', role: RH }, { ap: [jn.id, l1.id] })
    w.ok('SB2', 'leave', {}, { ap: H0 })
    w.ok('O1', 'mark')
    const S = w.state()
    expect(S.cut.has(y.id) && S.cut.has(add.id) && S.cut.has(jn.id)).toBe(true)
    expect(S.facts.mem.has('N')).toBe(false) // revision 4: N stayed a member
    expect(S.facts.holds.get('T')?.has(RH)).toBe(true)
    orderIndependent(w)
  })
  // [R4V C1] NM4/NM5: moderators QA, QB, QC (pos 20) kick SA (who raised Rs to 15), Z and V at one position. Y (Rs) gave
  // T the role Ry (6); P (Rs) then gives T the Invite role RI (NM5) or kicks T (NM4); T invites N. The owner promotes P
  // after QA's kick; with `KL`, also K and L (who cited Z's and V's marks) after QB's and QC's kicks: 3 protection
  // classes, above the model's cap. Revision 4: with KL the fallback cut P's grant and N (O5-sound), without KL the exact
  // rule kept them, so N's membership depended on unrelated promotions. Revision 5: QA's kick alone takes P's rank
  // (3, below T's 6), both branches cut, and the outcome no longer depends on K and L.
  function nm5(kl: boolean, kick: boolean) {
    const w = base()
    w.ok('O2', 'device_add')
    const Mr = role(w, 20, KICK | BAN),
      RS = role(w, 18, ROLES),
      Rs = role(w, 3, KICK | ROLES),
      Ry = role(w, 6, 0)
    const RH = role(w, 25, 0),
      RI = role(w, 2, INVITE)
    for (const d of ['QA1', 'QB1', 'QC1', 'SA1', 'P1', 'Y1', 'T1', 'Z1', 'V1', 'K1', 'L1'])
      join(w, d)
    for (const m of ['QA', 'QB', 'QC']) give(w, m, Mr)
    give(w, 'SA', RS)
    give(w, 'P', Rs)
    give(w, 'Y', Rs)
    const H0 = w.heads()
    const z = w.ok('SA1', 'role_move', { role: Rs, pos: 15 }, { ap: H0 })
    const y = w.ok('Y1', 'assign', { to: 'T', role: Ry }, { ap: [z.id] })
    const p = kick
      ? w.ok('P1', 'kick', { to: 'T' }, { ap: [y.id] })
      : w.ok('P1', 'assign', { to: 'T', role: RI }, { ap: [y.id] })
    const add = kick ? undefined : w.ok('T1', 'add', { to: 'N' }, { ap: [p.id] })
    const jn = add ? w.ok('N1', 'join', {}, { ap: [vouch(w, add).id] }) : undefined
    const zm = w.ok('Z1', 'mark', {}, { ap: H0 }),
      vm = w.ok('V1', 'mark', {}, { ap: H0 })
    const km = w.ok('K1', 'mark', {}, { ap: [zm.id] }),
      lm = w.ok('L1', 'mark', {}, { ap: [vm.id] })
    const qa = w.ok('QA1', 'kick', { to: 'SA' }, { ap: H0 })
    const qb = w.ok('QB1', 'kick', { to: 'Z' }, { ap: H0 })
    const qc = w.ok('QC1', 'kick', { to: 'V' }, { ap: H0 })
    w.ok('O1', 'assign', { to: 'P', role: RH }, { ap: [(jn ?? p).id, qa.id] })
    if (kl) {
      w.ok('O2', 'assign', { to: 'K', role: RH }, { ap: [km.id, qb.id] })
      w.ok('O2', 'assign', { to: 'L', role: RH }, { ap: [lm.id, qc.id] })
    }
    w.ok('O1', 'mark')
    return { w, p, jn }
  }
  for (const kick of [false, true]) {
    test(`NM${kick ? 4 : 5}: the class-cap fallback and the exact rule agree; unrelated promotions don't decide P's ${kick ? 'kick' : 'grant'}`, () => {
      const out = [true, false].map(kl => {
        const { w, p, jn } = nm5(kl, kick)
        const S = w.state()
        orderIndependent(w)
        return { cutP: S.cut.has(p.id), memN: jn ? S.facts.mem.has('N') : undefined }
      })
      expect(out[0]).toEqual(out[1]) // revision 4: different (fallback with K and L, exact without)
      expect(out[0].cutP).toBe(true)
    })
  }
  // [R4V C1] the position register's tie-break: role R (pos 1) is held by H. Movers MA and MB (pos 10) raise R to 4 and
  // 2 concurrently (equal strata: the lower wins); senior SV (pos 15) raises it to 9 after MA's write. H kicks T (role at
  // pos 3). Moderator Q (pos 20) kicks SV and MB from before their writes. Cutting SV's write alone leaves R at 2, cutting
  // both leaves it at 4: the plain rank is not monotone in the cut set. Revision 5's resource rank is the lowest
  // position any subset of the world's cuts could leave R at (2), so H's kick falls; revision 4 (and the review's
  // proposed clamp, mutant clamp-r4) kept it.
  test("Position hull: more cuts never raise the author's rank, whatever the register's tie-break", () => {
    const w = base()
    const R = role(w, 1, KICK | ROLES),
      MV = role(w, 10, ROLES),
      SV = role(w, 15, ROLES),
      QV = role(w, 20, KICK),
      TG = role(w, 3, 0)
    for (const d of ['MA1', 'MB1', 'SV1', 'Q1', 'H1', 'T1']) join(w, d)
    give(w, 'MA', MV)
    give(w, 'MB', MV)
    give(w, 'SV', SV)
    give(w, 'Q', QV)
    give(w, 'H', R)
    give(w, 'T', TG)
    const H0 = w.heads()
    const w1 = w.ok('MA1', 'role_move', { role: R, pos: 4 }, { ap: H0 })
    const w2 = w.ok('MB1', 'role_move', { role: R, pos: 2 }, { ap: H0 })
    const w4 = w.ok('SV1', 'role_move', { role: R, pos: 9 }, { ap: [w1.id] })
    const k = w.ok('H1', 'kick', { to: 'T' }, { ap: [w4.id, w2.id] })
    w.ok('Q1', 'kick', { to: 'SV' }, { ap: H0 })
    w.ok('Q1', 'kick', { to: 'MB' }, { ap: H0 })
    const S = w.state()
    expect(S.cut.has(w4.id) && S.cut.has(w2.id) && !S.cut.has(w1.id)).toBe(true)
    expect(S.cut.has(k.id)).toBe(true)
    expect(S.facts.mem.has('T')).toBe(true)
    orderIndependent(w)
  })
  // [R4V M2] S (pos 10) moves T's role R from 8 to 3; J (pos 5), having seen it, turns Kick on for R (or gives R to U);
  // the owner kicks S from before the move. The move is cut, R is back at 8 above J: J's operation relied on the move
  // and falls with it (revision 4 kept it: views never removed a cut deny).
  for (const variant of ['role_bits', 'assign'] as const) {
    test(`M2 (${variant}): an operation that relied on a deny loses its effect when a senior cuts the deny`, () => {
      const w = base()
      const RSr = role(w, 10, ROLES),
        RJ = role(w, 5, ROLES | KICK),
        R = role(w, 8, 0)
      for (const d of ['S1', 'J1', 'T1', 'U1']) join(w, d)
      give(w, 'S', RSr)
      give(w, 'J', RJ)
      give(w, 'T', R)
      const H0 = w.heads()
      const mv = w.ok('S1', 'role_move', { role: R, pos: 3 })
      const g =
        variant === 'role_bits'
          ? w.ok('J1', 'role_bits', { role: R, bit: KICK, on: true })
          : w.ok('J1', 'assign', { to: 'U', role: R })
      w.ok('O1', 'kick', { to: 'S' }, { ap: H0 })
      const S = w.state()
      expect(S.cut.has(mv.id)).toBe(true)
      expect(S.cut.has(g.id)).toBe(true)
      expect((S.facts.bits.get(R) ?? 0) & KICK).toBe(0)
      expect(S.facts.holds.get('U')?.has(R) ?? false).toBe(false)
      orderIndependent(w)
    })
  }
  // [R4V C2] TD: B's device forks (an assign of R1 to T and a sibling mark at the same seq); A's second device A2 posts a
  // mark citing the assign; A1 revokes A2 with a watermark below that mark. The mark is in Tail. Revision 4 let it
  // witness B's assign (T held R1) and §4.2 dropped it, after which the assign was in X: dropping changed Eval. Revision
  // 5: an event past an admitted revocation's watermark of its device is never a witness, so the tail mark is inert and
  // the assign is in X with or without it; tail events are not dropped (§4.2).
  test("TD: a revoked device's tail event witnesses nothing, so its presence never changes X or the facts", () => {
    const w = base()
    w.ok('O1', 'role_bits', { role: EVERYONE, bit: INVITE, on: true })
    const RR = role(w, 3, ROLES),
      R1 = role(w, 1, 0)
    for (const d of ['B1', 'A1', 'T1']) join(w, d)
    w.ok('A2', 'device_add')
    give(w, 'B', RR)
    const H = w.heads()
    const x = w.ok('B1', 'assign', { to: 'T', role: R1 }, { ap: H })
    const sib = w.act('B1', 'mark', {}, { ap: H, seq: x.seq, aprev: x.aprev ?? null })
    expect(sib.v.s).toBe('A')
    const tw = w.ok('A2', 'mark', {}, { ap: [x.id] })
    const rv = w.ok('A1', 'device_revoke', { dk: 'A2', seen: tw.seq - 1 }, { ap: H })
    w.ok('O1', 'mark', {}, { ap: [rv.id, sib.e.id] })
    const S = w.state()
    expect(S.tail.has(tw.id)).toBe(true)
    expect(S.X.has(x.id)).toBe(true) // revision 4: false (witnessed by the tail mark)
    expect(S.facts.holds.get('T')?.has(R1) ?? false).toBe(false)
    const S2 = evaluate(
      w.ref.order.filter(id => id !== tw.id),
      w.ref
    )
    expect(evalSummary({ ...S2 })).toBe(
      evalSummary({
        ...S,
        X: new Set([...S.X].filter(id => id !== tw.id)),
        tail: new Set([...S.tail].filter(id => id !== tw.id)),
        cut: new Map([...S.cut].filter(([id]) => id !== tw.id)),
        eff: S.eff,
      })
    )
    orderIndependent(w)
  })
  // [R4V I2] the unacknowledged day budget is the same for every author: an owner (or moderator) alone, posting every 3
  // units, gets dayU per day (revision 4: 4 × the moderators' hourly cap, 32 per model day, 2,400 in production).
  test('I2: the unacknowledged day budget has no moderator multiplier (owner alone, burst)', () => {
    const w = base(INVITE)
    let n = 0
    for (let i = 1; i <= 160; i++)
      if (w.act('O1', 'profile', { name: i % 3 }, { ts: 3 * i }).v.s === 'A') n++
    const days = Math.ceil((3 * 160) / MODEL_LIMITS.day)
    expect(n).toBeLessThanOrEqual((DAY_U ?? 24) * days) // revision 4 admits 64
  })
  // [R4V I2] device churn: device_adds are counted per identity per day across epochs. Revision 4 counted the current
  // epoch only, so each rotation opened a new allowance of fresh devices.
  test('I2: a rotation does not reset the device_add allowance of the day', () => {
    const w = base(INVITE)
    join(w, 'A1')
    let adds = 0,
      dev = 2
    const seen: Record<string, number> = {}
    for (let r = 0; r < 3; r++) {
      for (let i = 0; i < 4; i++, dev++) {
        const a = w.act(`A${dev}`, 'device_add')
        if (a.v.s !== 'A') continue
        adds++
        w.ok('O1', 'mark', {}, { ap: [a.e.id] }) // the owner acknowledges it (W3(d) never applies)
        seen[`A${dev}`] = a.e.seq
        w.ok('A1', 'device_revoke', { dk: `A${dev}`, seen: a.e.seq })
      }
      expect(
        w.act('A1', 'primary_rotate', { keep: [], seen: { ...seen }, pcert: `p${r}` }).v.s
      ).toBe('A')
    }
    expect(adds).toBeLessThanOrEqual(MODEL_LIMITS.idCap) // revision 4 admits 3 per epoch
  })
  // [R4V I2] W3(d): a removed member's fresh devices dated early would each backfill the whole idle range at dayU per day
  // (the backlog grew with the square of the idle time). A device whose device_add no other identity acknowledged posts
  // at most freshU non-exempt events in total. A device the server acknowledged keeps the day budget.
  test('I2: an unacknowledged fresh device posts at most freshU events in total; an acknowledged one keeps the day budget', () => {
    const w = base(INVITE)
    const ja = join(w, 'A1')
    const P0 = w.heads()
    w.ok('O1', 'kick', { to: 'A' })
    // A, removed, adds a fresh device at its old position and posts across a long idle range
    const da = w.ok('A3', 'device_add', {}, { ap: P0, ts: ja.ts + 1 })
    let n = 0
    for (let i = 1; i <= 120; i++)
      if (w.act('A3', 'mark', {}, { ap: [da.id], ts: ja.ts + 1 + 20 * i }).v.s === 'A') n++
    expect(n).toBeLessThanOrEqual((TOT ? MODEL_LIMITS.totU : 24) - 1) // the device_add is the first; revision 4 admits 120
    // and A can mint at most freshCap such devices in total, whatever their dates (revision 4: 3 per day of the range)
    let fresh = 1
    for (let i = 4; i < 30; i++) {
      const last = w.latestOwn('A3')!
      if (w.act(`A${i}`, 'device_add', {}, { ap: [last.id], ts: last.ts + 300 * i }).v.s === 'A')
        fresh++
    }
    expect(fresh).toBeLessThanOrEqual(MODEL_LIMITS.freshCap ?? 2)
    // a member's device that the owner acknowledged (the owner cited its device_add) keeps dayU per day
    const v = base(INVITE)
    join(v, 'B1')
    const db = v.ok('B2', 'device_add')
    v.ok('O1', 'mark', {}, { ap: [db.id] })
    let m = 0
    for (let i = 1; i <= 60; i++)
      if (v.act('B2', 'mark', {}, { ts: db.ts + 20 * i }).v.s === 'A') m++
    if (!TOT) expect(m).toBe(60)
    else {
      // revision 5, dispatch 5b: there is no day budget left; every device, acknowledged or not, has totU events that no
      // other identity acknowledged (the device_add itself is acknowledged by the owner's mark)
      expect(m).toBe(MODEL_LIMITS.totU)
    }
  })
})

// Revision 5, dispatch 5b: the growth bound for a removed identity ([H17], [H18]). Each vector fails under the mutant
// that restores the dispatch-5a rule (named in the test and in spec §7.7).
describe('revision 5, dispatch 5b: growth bound (H17, H18)', () => {
  const kicked = (everyone = 0) => {
    const w = base(everyone)
    const ax = w.ok('O1', 'add', { to: 'X' })
    w.ok('X1', 'join')
    w.ok('O1', 'mark')
    const P = w.heads()
    w.ok('O1', 'kick', { to: 'X' })
    return { w, ax, P, start: w.ref.order.length }
  }
  const storedOf = (w: AclWorld, from: number, a = 'X') => {
    const drops = orphanDrops(w.ref.order, w.state(), w.ref)
    return w.ref.order.slice(from).filter(id => w.ref.ev(id).a === a && !drops.has(id))
  }
  // [H17] every introduction is the first event of a fresh device, so nothing it is concurrent with is in its B(e): a
  // removed member could post any number of rotations, device_adds or joins at one position, each with a fresh device's
  // budget. Concurrent rotations are rotation evidence, concurrent device_adds and joins identity evidence (FI): all are
  // candidates, nobody witnesses them, and the orphan rule drops them with their devices' events, except the two lowest
  // ids of each group (mutants orphan-5a, no-rot-evidence).
  for (const kind of ['primary_rotate', 'device_add', 'join'] as const) {
    test(`H17: concurrent ${kind}s of a removed member are void and dropped`, () => {
      const { w, ax, P, start } = kicked()
      let intro = 0,
        marks = 0
      for (let i = 0; i < 12; i++) {
        const dev = `X${10 + i}`
        const r =
          kind === 'primary_rotate'
            ? w.act(
                dev,
                kind,
                { keep: [], seen: { X1: w.latestOwn('X1')!.seq }, pcert: `p${i}` },
                { ap: P, seq: 0 }
              )
            : kind === 'device_add'
              ? w.act(dev, kind, {}, { ap: P })
              : w.act(dev, kind, {}, { ap: [ax.id] })
        if (r.v.s !== 'A') continue
        intro++
        for (let k = 0; k < 20; k++)
          if (
            w.act(dev, 'mark', {}, { ap: [w.latestOwn(dev)!.id], ts: r.e.ts + 1 + 30 * k }).v.s ===
            'A'
          )
            marks++
      }
      expect(intro).toBe(12) // admission alone can't refuse them: none sees the others
      expect(marks).toBeGreaterThan(100)
      const S = w.state()
      expect(w.ref.order.slice(start).every(id => S.X.has(id))).toBe(true)
      expect(storedOf(w, start).length).toBeLessThanOrEqual(2)
    })
  }
  // [H17] a device's events are candidates when every introduction of the device is a candidate (structural), not when
  // every introduction is in X (dispatch 5a): a deceived member that saw one of two concurrent device_adds witnesses it
  // in good faith, so it is not in X, but it stays a candidate; the device's later events, which nobody witnessed, stay
  // void and droppable. With "in X", that one citation of the introduction kept every later event of the device
  // (mutant intro-x).
  test("H17: a witnessed but contested introduction does not make its device's later events non-void", () => {
    const { w, P, start } = kicked()
    join(w, 'G1')
    const a1 = w.ok('X10', 'device_add', {}, { ap: P })
    w.ok('X11', 'device_add', {}, { ap: P })
    w.ok('G1', 'mark', {}, { ap: [a1.id, w.latestOwn('G1')!.id] }) // G saw a1 only
    const marks: string[] = []
    for (let k = 0; k < 8; k++) {
      const r = w.act('X10', 'mark', {}, { ap: [w.latestOwn('X10')!.id], ts: a1.ts + 1 + 30 * k })
      if (r.v.s === 'A') marks.push(r.e.id)
    }
    expect(marks.length).toBe(8)
    const S = w.state()
    expect(S.X.has(a1.id)).toBe(false)
    expect(marks.every(id => S.X.has(id))).toBe(true)
    expect(storedOf(w, start).length).toBeLessThanOrEqual(2)
  })
  // [H17] a rotation in X (two of one identity over one iprev, nobody witnessed either) is not in force: it drops no
  // device. Before, every admitted rotation was in force, so a member's void rotations still cut its other devices'
  // concurrent events as tails (mutant drops-all).
  test('H17: void concurrent rotations drop no device', () => {
    const w = base(INVITE)
    join(w, 'M1')
    const m0 = w.ok('M1', 'mark')
    for (const d of ['M10', 'M11']) {
      const r = w.act(
        d,
        'primary_rotate',
        { keep: [], seen: { M1: m0.seq }, pcert: d },
        { ap: [m0.id], seq: 0 }
      )
      expect(r.v.s).toBe('A')
    }
    const a = w.ok('M1', 'add', { to: 'Y' }, { ap: [m0.id] })
    const S = w.state()
    expect(S.cut.has(a.id)).toBe(false)
    expect(S.facts.devs.get('M')?.has('M1')).toBe(true)
  })
  // [H17] (b) a clean rotation concurrent with three void device_adds: the orphan rule drops the third (FI stays defined
  // by the two lowest). If a rotation also dropped devices that only an X event introduced, that drop would change its
  // revoked set and Eval(S) ≠ Eval(S \ dropped) (mutant drops-all). The rule: rotations drop only devices with a
  // non-X introduction.
  test('H17: an orphan drop of a void introduction leaves Eval unchanged next to a concurrent rotation', () => {
    const w = base(INVITE)
    join(w, 'M1')
    const m0 = w.ok('M1', 'mark')
    for (const d of ['M10', 'M11', 'M12'])
      expect(w.act(d, 'device_add', {}, { ap: [m0.id] }).v.s).toBe('A')
    expect(
      w.act(
        'M20',
        'primary_rotate',
        { keep: ['M1'], seen: { M1: m0.seq }, pcert: 'r' },
        { ap: [m0.id], seq: 0 }
      ).v.s
    ).toBe('A')
    const order = w.ref.order,
      S = w.state()
    const drops = orphanDrops(order, S, w.ref)
    expect(drops.size).toBeGreaterThan(0)
    const kept = order.filter(id => !drops.has(id)),
      keptSet = new Set(kept)
    const R = evaluate(kept, w.ref, [...drops])
    const restrict = (r: typeof S) =>
      evalSummary({
        ...r,
        X: new Set([...r.X].filter(x => keptSet.has(x))),
        tail: new Set([...r.tail].filter(x => keptSet.has(x) && !S.X.has(x))),
        cut: new Map([...r.cut].filter(([id]) => keptSet.has(id) && !S.X.has(id))),
        eff: new Set([...r.eff].filter(id => keptSet.has(id))),
      })
    expect(restrict(R)).toBe(restrict(S))
  })
  // [H19] the identity chain as a tree: at each position a removed member posts one rotation child and one device_add
  // child (each from a fresh device that then posts its budget), down to the per-view caps (freshCap adds, rotTot
  // rotations). No view holds two siblings, so admission takes every node (23 fresh devices at model scale, 54 at
  // production values), and before [H19] nothing was evidence: a rotation and a device_add over one iprev never paired,
  // and rotations over different iprevs neither. Now any two concurrent rotations are rotation evidence (mutant
  // rot-same-iprev), and the orphan rule need not keep FI of an epoch whose rotation is contested (mutant fi-all).
  test("H19: a removed member's identity-chain tree is void and dropped", () => {
    const { w, start } = kicked()
    let fresh = 0,
      n = 30,
      ts = 1000
    const grow = (tip: string[], adds: number, rots: number) => {
      for (const kind of ['rot', 'add'] as const) {
        if (kind === 'rot' ? rots >= MODEL_LIMITS.rotTot : adds >= MODEL_LIMITS.freshCap) continue
        const dev = `X${n++}`
        const seen: Record<string, number> = {}
        for (const id of w.closure(tip)) {
          const x = w.ref.ev(id)
          if (x.a === 'X') seen[x.dev] = Math.max(seen[x.dev] ?? -1, x.seq)
        }
        const r =
          kind === 'add'
            ? w.act(dev, 'device_add', {}, { ap: tip, ts: (ts += 11) })
            : w.act(
                dev,
                'primary_rotate',
                { keep: [], seen, pcert: `p${dev}` },
                { ap: tip, seq: 0, ts: (ts += 11) }
              )
        if (r.v.s !== 'A') continue
        fresh++
        // revision 5, dispatch 5b-ii: 2 marks per node (11 before); a root-to-leaf path is one view, which W3(g) caps at
        // poolU unacknowledged events, and the shape is about the identity chain, not the marks
        for (let i = 0; i < 2; i++)
          w.act(dev, 'mark', {}, { ap: [w.latestOwn(dev)!.id], ts: (ts += 11) })
        grow(
          [w.latestOwn(dev)!.id],
          adds + (kind === 'add' ? 1 : 0),
          rots + (kind === 'rot' ? 1 : 0)
        )
      }
    }
    grow([w.latestOwn('X1')!.id], 0, 0)
    expect(fresh).toBeGreaterThanOrEqual(20)
    expect(storedOf(w, start).length).toBeLessThanOrEqual(2 * MODEL_LIMITS.totU)
  })
  // [H19] race: a device_add over the same iprev as a rotation of its identity lost the race to the recovery key. Before,
  // it stayed non-void; the rotation dropped its device, so the device's events were tails, cut and stored for good, one
  // full budget per position of the identity chain. Now it is identity evidence for its own epoch (the rotation is not
  // affected): the add and its device's events are void and dropped (mutant no-race).
  test("H19: a device_add that races a rotation of its identity is void; its device's events are dropped", () => {
    const { w, P, start } = kicked()
    const r = w.act(
      'X10',
      'primary_rotate',
      { keep: ['X1'], seen: { X1: w.latestOwn('X1')!.seq }, pcert: 'r' },
      { ap: P, seq: 0 }
    )
    expect(r.v.s).toBe('A')
    const d = w.act('X11', 'device_add', {}, { ap: P })
    expect(d.v.s).toBe('A')
    for (let k = 0; k < 8; k++)
      w.act('X11', 'mark', {}, { ap: [w.latestOwn('X11')!.id], ts: d.e.ts + 1 + 30 * k })
    const S = w.state()
    expect(S.X.has(r.e.id)).toBe(false)
    expect(S.X.has(d.e.id)).toBe(true)
    expect(storedOf(w, start).filter(id => w.ref.ev(id).dev === 'X11').length).toBeLessThanOrEqual(
      1
    )
  })
  // [H18] W3(f) no pinning: the concurrent device_adds above are dropped because nothing held cites them. A later event
  // of the identity that cites them all (here a rotation, the one kind W3(d) never refuses) would pin every one with its
  // device's events, each with a full budget. W3(f) refuses an event whose B(e) holds more than one unacknowledged
  // evidence pair per key of its own identity (a rotation may resolve one: recovery); mutant pin-ok.
  test("H18: a removed member can't pin its concurrent introductions by citing them (W3(f))", () => {
    const { w, P, start } = kicked()
    for (let i = 0; i < 6; i++) {
      const dev = `X${10 + i}`
      const r = w.act(dev, 'device_add', {}, { ap: P })
      expect(r.v.s).toBe('A')
      for (let k = 0; k < 8; k++)
        w.act(dev, 'mark', {}, { ap: [w.latestOwn(dev)!.id], ts: r.e.ts + 1 + 30 * k })
    }
    const heads = w.heads().filter(h => w.ref.ev(h).a === 'X')
    const seen: Record<string, number> = {}
    for (const id of w.closure(heads)) {
      const x = w.ref.ev(id)
      if (x.a === 'X') seen[x.dev] = Math.max(seen[x.dev] ?? -1, x.seq)
    }
    const r = w.act(
      'X30',
      'primary_rotate',
      { keep: [], seen, pcert: 'pin' },
      { ap: heads, seq: 0 }
    )
    expect(r.v).toEqual({ s: 'R', why: 'W3f' })
    expect(storedOf(w, start).length).toBeLessThanOrEqual(2)
  })
  // [H17] sequential rotations: W3(d) never refuses a rotation (recovery), so a removed member could rotate rotCap times a
  // day over its whole idle range, each rotation a fresh device with a full budget. W3(c) now caps the rotations nobody
  // else acknowledged at rotTot in total; acknowledged ones don't count (mutant id-totals-off).
  test("H17: a removed member's sequential rotations are capped in total; a member others acknowledge is not", () => {
    const { w, P } = kicked()
    let rots = 0,
      ap = P,
      ts = 100
    for (let i = 0; i < 12; i++, ts += MODEL_LIMITS.day) {
      const seen: Record<string, number> = {}
      for (const id of w.closure(ap)) {
        const x = w.ref.ev(id)
        if (x.a === 'X') seen[x.dev] = Math.max(seen[x.dev] ?? -1, x.seq)
      }
      const r = w.act(
        `X${10 + i}`,
        'primary_rotate',
        { keep: [], seen, pcert: `p${i}` },
        { ap, ts }
      )
      if (r.v.s === 'A') {
        rots++
        ap = [r.e.id]
      }
    }
    expect(rots).toBe(MODEL_LIMITS.rotTot)
    const v = base(INVITE)
    join(v, 'B1')
    let ok = 0
    for (let i = 0; i < 6; i++) {
      const last = v.ref.order[v.ref.order.length - 1]
      const ts2 = v.ref.ev(last).ts + MODEL_LIMITS.day
      const seen: Record<string, number> = {}
      for (const id of v.ref.order) {
        const x = v.ref.ev(id)
        if (x.a === 'B') seen[x.dev] = Math.max(seen[x.dev] ?? -1, x.seq)
      }
      const r = v.act(
        `B${10 + i}`,
        'primary_rotate',
        { keep: [], seen, pcert: `q${i}` },
        { ts: ts2 }
      )
      if (r.v.s === 'A') {
        ok++
        v.ok('O1', 'mark', {}, { ts: ts2 + 1 })
      } // the owner's next ACL event acknowledges it
    }
    expect(ok).toBe(6)
  })
  // [H18] a kicked member that held Invite (through @everyone) at its old position adds a sybil there; the two would
  // acknowledge each other's events, so the W3(b) total would never bind (800 of 800 marks admitted before). W3(e): the
  // sybil's join needs a third identity's acknowledgement of the add, which honest members never give (mutant sybil-join).
  test("H18: a removed member can't let in a sybil at its old position (W3(e)); alone it posts at most totU events", () => {
    const { w, P, start } = kicked(INVITE)
    const ay = w.ok('X1', 'add', { to: 'Y' }, { ap: P })
    expect(w.act('Y1', 'join', {}, { ap: [ay.id] }).v.s).toBe('R')
    let n = 0
    for (let i = 0; i < 100; i++)
      if (
        w.act('X1', 'mark', {}, { ap: [w.latestOwn('X1')!.id], ts: ay.ts + 1 + 11 * i }).v.s === 'A'
      )
        n++
    expect(n + 1).toBeLessThanOrEqual(MODEL_LIMITS.totU) // the add and the marks; its join and first mark were acknowledged before
    expect(storedOf(w, start).length).toBeLessThanOrEqual(MODEL_LIMITS.totU)
  })
  // [H18] a member forks its device into branches and lets in sybils on each; each sybil's join witnessed its branch in
  // good faith, so every branch kept its budgets and its sybils: unboundedly many members at once, no removal needed
  // (N14 claimed one extra branch per deceived or colluding witness device). With W3(e) no sybil joins, every branch is
  // void and dropped (mutant sybil-join).
  for (const removed of [false, true]) {
    test(`H18: fork branches can't let in their own witnesses (${removed ? 'removed member' : 'live member'})`, () => {
      const w = base(INVITE)
      w.ok('O1', 'add', { to: 'M' })
      w.ok('M1', 'join')
      const m0 = w.ok('M1', 'mark')
      if (removed) w.ok('O1', 'kick', { to: 'M' })
      const start = w.ref.order.length
      let joins = 0
      for (let b = 0; b < 6; b++) {
        let prev = m0.id,
          seq = m0.seq,
          ts = m0.ts + 1 + b
        for (let k = 0; k < MODEL_LIMITS.pendingPerDev; k++) {
          const who = `Y${b}q${k}z`
          const a = w.act(
            'M1',
            'add',
            { to: who },
            { ap: [prev], seq: ++seq, aprev: prev, keepOwn: false, ts: (ts += 11) }
          )
          if (a.v.s !== 'A') break
          prev = a.e.id
          if (w.act(`${who}1`, 'join', {}, { ap: [a.e.id], ts: (ts += 1) }).v.s === 'A') joins++
        }
      }
      const S = w.state()
      expect(joins).toBe(0)
      expect([...S.facts.mem].filter(m => m.startsWith('Y')).length).toBe(0)
      expect(w.ref.order.slice(start).every(id => S.X.has(id))).toBe(true)
      expect(storedOf(w, start, 'M').length).toBeLessThanOrEqual(2)
    })
  }
  // [H18] good faith: a member whose view already shows the fork does not vouch for a branch's invites by citing the
  // heads (honest clients cite every head); only a member that saw one branch before the fork evidence does, which is
  // N14's deceived witness. W3(e) needs a live add in St(e), and a live candidate add has a good-faith witness in B(e),
  // so good faith needs no separate test (§4.1 W3(e)).
  test("H18: a member that saw the fork does not vouch for a branch's invite", () => {
    const w = base(INVITE)
    join(w, 'M1')
    join(w, 'H1')
    join(w, 'G1')
    const m0 = w.ok('M1', 'mark')
    const a1 = w.ok('M1', 'add', { to: 'Y' }, { ap: [m0.id] })
    const a2 = w.ok(
      'M1',
      'add',
      { to: 'Z' },
      { ap: [m0.id], seq: a1.seq, aprev: m0.id, keepOwn: false }
    )
    const h = w.ok('H1', 'mark', {}, { ap: [a1.id, a2.id] }) // sees both branches: the adds are candidates in St(h)
    expect(w.act('Y1', 'join', {}, { ap: [h.id] }).v.s).toBe('R')
    expect(w.act('Z1', 'join', {}, { ap: [h.id] }).v.s).toBe('R')
    // a member that saw only one branch vouches for it in good faith (N14)
    const g = w.ok('G1', 'mark', {}, { ap: [a1.id] })
    expect(w.act('Y1', 'join', {}, { ap: [g.id] }).v.s).toBe('A')
  })
  // [H18] moderation is exempt from the hourly cap, but a removed moderator's removals at its old position were bounded
  // only by the members it outranked there, per device chain. The W3(b) total counts them (mutant w3b-mod).
  test("H18: a removed moderator's removals at its old position are counted in the unacknowledged total", () => {
    const w = base(INVITE)
    const MOD = role(w, 3, KICK | BAN)
    join(w, 'X1')
    const mem = 'ABCDEFGHIJKLMNQR'.split('')
    for (const m of mem) join(w, `${m}1`)
    give(w, 'X', MOD)
    w.ok('O1', 'mark')
    const P = w.heads()
    w.ok('O1', 'kick', { to: 'X' })
    let n = 0,
      ap = P,
      ts = 1000
    for (const m of mem) {
      const r = w.act('X1', 'kick', { to: m }, { ap, ts: (ts += 1) })
      if (r.v.s === 'A') {
        n++
        ap = [r.e.id]
      }
    }
    expect(n).toBeLessThanOrEqual(MODEL_LIMITS.totU)
    expect(n).toBeLessThan(mem.length)
    expect(w.state().facts.mem.size).toBe(mem.length + 2) // every member stays (the kicks are cut with X's removal)
  })
  // [H20] (revision 5, dispatch 5b-ii, controller ruling: the bound must not grow with device churn). A device the
  // identity revoked while a member still posts from its own chain tip after the removal: its B(e) is that of an honest
  // device that went offline at the tip, so admission gives every such chain its own W3(b) budget (dispatch 5b-i: one
  // budget per device ever acknowledged, I in §4.1). W3(g) pools them: every event lies in its own U, so an event is a
  // pool candidate once its concurrent events of the identity and their pools exceed poolU (mutant pool-off).
  const oldDevices = (n: number) => {
    const w = base()
    w.ok('O1', 'add', { to: 'X' })
    w.ok('X1', 'join')
    let ts = 100
    const olds: { dev: string; ack: string }[] = []
    for (let i = 2; i < 2 + n; i++) {
      ts += MODEL_LIMITS.day
      w.ok(`X${i}`, 'device_add', {}, { ts })
      w.ok(`X${i}`, 'mark', {}, { ts: ts + 1 })
      const ack = w.ok('O1', 'mark', {}, { ts: ts + 2 })
      w.ok('X1', 'device_revoke', { dk: `X${i}`, seen: w.latestOwn(`X${i}`)!.seq }, { ts: ts + 3 })
      w.ok('O1', 'mark', {}, { ts: ts + 4 })
      olds.push({ dev: `X${i}`, ack: ack.id })
    }
    w.ok('O1', 'kick', { to: 'X' }, { ts: (ts += 10) })
    // the attacker's best anchor: its old tip and the owner's acknowledgement of it, which is before the revocation
    const post = (d: { dev: string; ack: string }) =>
      w.act(d.dev, 'mark', {}, { ap: [w.latestOwn(d.dev)!.id, d.ack], ts: (ts += 11) })
    return { w, olds, post, start: w.ref.order.length }
  }
  // Revision 7 (controller ruling on r6.1, C1 option 2): a candidate only by pool evidence is never dropped, so the
  // pool no longer caps what a removed member stores: each old device keeps its own W3(b) total (about 24 per old device
  // at production values; revision 6: poolU in total). Mutant pool-drop (drop pool candidates) keeps poolU.
  test("H20 (revision 7): a removed member's old devices each keep their W3(b) total stored (totU per old device, cut)", () => {
    const { w, olds, post, start } = oldDevices(6)
    let admitted = 0
    for (const d of olds) for (let k = 0; k < 30; k++) if (post(d).v.s === 'A') admitted++
    const stored = storedOf(w, start)
    const S = w.state()
    expect(admitted).toBe(6 * MODEL_LIMITS.totU) // each chain keeps its own W3(b) budget at admission
    expect(stored.every(id => S.cut.has(id))).toBe(true)
    expect(stored.length).toBe(6 * MODEL_LIMITS.totU) // revision 6: at most poolU; dispatch 5b-i: 6 × totU = 72
    expect(stored.filter(x => S.PC.has(x)).length).toBeGreaterThan(0)
  })
  // The boundary, restated independently from the recorded pools: x is a pool candidate iff |U(x) ∪ ⋃ U(y)| > poolU over
  // the events y of its identity concurrent with x. A backdated chain is also concurrent with the identity's own later
  // events before the removal (here the revocations and the later devices), which count too. Posting round-robin, the
  // first overflow voids only maximal events, and the stored events never exceed poolU.
  test('H20: the pool boundary: an event is a pool candidate iff its concurrent pool exceeds poolU; stored ≤ totU per old device throughout', () => {
    const { w, olds, post, start } = oldDevices(3)
    let firstPC = -1
    for (let k = 0; k < MODEL_LIMITS.totU; k++)
      for (const d of olds) {
        post(d)
        const S = w.state()
        // revision 7: pool candidates stay stored (revision 6: stored ≤ poolU)
        expect(storedOf(w, start).length).toBeLessThanOrEqual(olds.length * MODEL_LIMITS.totU)
        if (firstPC < 0 && S.PC?.size) {
          firstPC = w.ref.order.length
          // only events with no later event of their own chain can overflow first
          for (const x of S.PC) expect(olds.some(o => w.latestOwn(o.dev)!.id === x)).toBe(true)
        }
      }
    expect(firstPC).toBeGreaterThan(0)
    const S = w.state(),
      ref = w.ref
    const xs = ref.order.filter(id => ref.ev(id).a === 'X' && ref.rec(id).pool)
    for (const x of xs) {
      // revision 6 (r5 review C1 (c)): device_revokes are never pool candidates, as rotations
      if (ref.ev(x).t === 'primary_rotate' || ref.ev(x).t === 'device_revoke') continue
      const P = new Set(ref.rec(x).pool)
      // revision 7: only concurrent events before their device's fork point count
      const pre = (y: string) => ref.ev(y).seq < (S.F.get(ref.ev(y).dev) ?? Infinity)
      for (const y of xs)
        if (y !== x && pre(y) && !ref.anc(x).has(y) && !ref.anc(y).has(x))
          for (const z of ref.rec(y).pool!) P.add(z)
      expect(S.PC?.has(x) ?? false).toBe(P.size > MODEL_LIMITS.poolU)
    }
  })
  test('W3(g): one view of an identity holds at most poolU events nobody else acknowledged', () => {
    const { w, olds, post } = oldDevices(3)
    for (const d of olds) for (let k = 0; k < MODEL_LIMITS.poolU / 3; k++) post(d)
    // a merge of the three chains would hold all of them (and itself) unacknowledged: refused (mutant pool-cap-off)
    const r = w.act('X1', 'mark', {}, { ap: olds.map(d => w.latestOwn(d.dev)!.id) })
    expect(r.v.s).toBe('R')
    expect((r.v as { why?: string }).why).toBe('W3g')
  })
  // [H20] a dropped event's header counts as every kind of evidence (F, FI, RF and the pool), so the orphan rule drops the
  // events that define an identity fork point too (dispatch 5b-i kept the lowest ids of each such group, with their
  // unacknowledged ancestors; mutant ghost-dev)
  test("H20: the events that define a removed member's identity fork are dropped; their headers stay as evidence", () => {
    const { w, start } = kicked()
    let ts = 1000
    for (let k = 0; k < 6; k++)
      w.act('X1', 'mark', {}, { ap: [w.latestOwn('X1')!.id], ts: (ts += 11) })
    const tip = w.latestOwn('X1')!.id
    const a = w.ok('X5', 'device_add', {}, { ap: [tip], ts: (ts += 11) })
    const b = w.ok('X6', 'device_add', {}, { ap: [tip], ts: (ts += 11) })
    for (const d of ['X5', 'X6'])
      for (let k = 0; k < 4; k++) w.act(d, 'mark', {}, { ap: [w.latestOwn(d)!.id], ts: (ts += 11) })
    const S = w.state()
    expect(S.X.has(a.id) && S.X.has(b.id)).toBe(true)
    const stored = storedOf(w, start)
    expect(stored.includes(a.id) || stored.includes(b.id)).toBe(false)
    expect(stored.length).toBe(6) // X1's marks
  })
  // [H20] the honest cost: an event is a pool candidate when its concurrent events of the same identity exceed the pool,
  // acknowledged or not. A device offline while its sibling posted more than poolU ACL events loses the ACL events it
  // made meanwhile (nobody can acknowledge them in good faith: every member already holds the sibling's events). Devices
  // that are online, or offline together, are never pool candidates.
  test('H20 (cost): a device offline while its sibling posted more than poolU ACL events loses its offline ACL events', () => {
    for (const many of [false, true]) {
      const w = base(INVITE)
      join(w, 'M1')
      w.ok('M2', 'device_add')
      const m0 = w.ok('O1', 'mark')
      const n = many ? MODEL_LIMITS.poolU : MODEL_LIMITS.poolU - 3
      let ts = m0.ts
      for (let k = 0; k < n; k++) {
        w.ok('M1', 'mark', {}, { ts: (ts += 11) })
        if (k % 4 === 3) w.ok('O1', 'mark', {}, { ts: (ts += 1) })
      }
      // M2 was offline since m0: it changes its profile and posts a mark there, then syncs and posts again
      const p = w.ok('M2', 'profile', { name: 7 }, { ap: [m0.id], ts: (ts += 11) })
      const q = w.ok('M2', 'mark', {}, { ap: [p.id], ts: (ts += 11) })
      const S = w.state()
      expect(S.X.has(p.id)).toBe(many)
      expect(S.X.has(q.id)).toBe(many)
      expect(S.facts.profile.get('M')?.name).toBe(many ? undefined : 7)
      const r = w.ok('M2', 'profile', { name: 8 }, { ts: ts + 11 }) // on the heads: never a pool candidate
      expect(w.state().X.has(r.id)).toBe(false)
    }
  })
  // The bound itself (spec §4.1): every route of dispatch 5b-i (live devices, fresh devices, rotations, leaves and
  // revocations, concurrent introductions, fork branches); with W3(g) a removed identity alone keeps at most poolU
  // unacknowledged events ([H20]).
  for (const forks of [false, true]) {
    test(`Growth bound: a removed member alone leaves at most poolU stored events (${forks ? 'with' : 'without'} forks and concurrent joins)`, () => {
      const w = base(INVITE)
      const MOD = role(w, 3, KICK | BAN)
      const ax = w.ok('O1', 'add', { to: 'X' })
      w.ok('X1', 'join')
      w.ok('X2', 'device_add')
      const mem = 'ABCDEFGHIJKLMNQR'.split('')
      for (const m of mem) join(w, `${m}1`)
      give(w, 'X', MOD)
      w.ok('O1', 'mark')
      const P = w.heads()
      w.ok('O1', 'kick', { to: 'X' })
      const start = w.ref.order.length
      let ts = 1000
      const spam = (dev: string, n = 40) => {
        for (let k = 0; k < n; k++) {
          const t = k % 3 === 0 ? 'kick' : k % 3 === 1 ? 'mark' : 'profile'
          const last = w.latestOwn(dev)
          w.act(
            dev,
            t,
            t === 'kick' ? { to: mem[k % mem.length] } : t === 'profile' ? { name: k % 3 } : {},
            { ap: last ? [last.id] : P, ts: (ts += 11) }
          )
        }
        const last = w.latestOwn(dev)
        for (const v of [...(w.state().facts.devs.get('X') ?? [])])
          if (v !== dev)
            w.act(
              dev,
              'device_revoke',
              { dk: v, seen: w.latestOwn(v)?.seq ?? -1 },
              { ap: last ? [last.id] : P, ts: (ts += 11) }
            )
      }
      for (const d of ['X1', 'X2']) {
        w.act(d, 'mark', {}, { ap: P, ts: (ts += 11) })
        spam(d)
      }
      for (let i = 3; i < 8; i++) {
        const r = w.act(`X${i}`, 'device_add', {}, { ap: [w.latestOwn('X1')!.id], ts: (ts += 11) })
        if (r.v.s === 'A') spam(`X${i}`)
      }
      for (let i = 10; i < 16; i++) {
        const heads = w.heads().filter(h => w.ref.ev(h).a === 'X')
        const ap = heads.length ? heads : P
        const seen: Record<string, number> = {}
        for (const id of w.closure(ap)) {
          const x = w.ref.ev(id)
          if (x.a === 'X') seen[x.dev] = Math.max(seen[x.dev] ?? -1, x.seq)
        }
        if (
          w.act(
            `X${i}`,
            'primary_rotate',
            { keep: [], seen, pcert: `p${i}` },
            { ap, ts: (ts += 11) }
          ).v.s === 'A'
        )
          spam(`X${i}`)
      }
      for (const d of ['X1', 'X2']) {
        const last = w.latestOwn(d)!
        w.act(d, 'leave', {}, { ap: [last.id], ts: (ts += 11) })
      }
      if (forks) {
        for (let i = 20; i < 26; i++) {
          const r = w.act(`X${i}`, 'join', {}, { ap: [ax.id], ts: (ts += 11) })
          if (r.v.s === 'A') spam(`X${i}`, 10)
        }
        const f0 = w.ref.order.find(
          id => w.ref.ev(id).dev === 'X2' && w.ref.order.indexOf(id) >= start
        )!
        for (let b = 0; b < 8; b++) {
          let prev = f0,
            seq = w.ref.ev(f0).seq
          for (let k = 0; k < 10; k++) {
            const r = w.act(
              'X2',
              'mark',
              {},
              { ap: [prev], seq: ++seq, aprev: prev, keepOwn: false, ts: (ts += 11) }
            )
            if (r.v.s === 'A') prev = r.e.id
          }
        }
      }
      const admitted = w.ref.order.slice(start).filter(id => w.ref.ev(id).a === 'X').length
      const stored = storedOf(w, start)
      expect(admitted).toBeGreaterThan(stored.length)
      // [H20]: poolU (spec §4.1), whatever the devices; dispatch 5b-i's per-device bound was D × (totU + 1 + DEV) + rotTot
      expect(stored.length).toBeLessThanOrEqual(MODEL_LIMITS.poolU)
      expect(w.state().facts.mem.has('X')).toBe(false)
    })
  }
})

// The vectors of revisions 6, 7, 7b and 7c (notes/acl-model vectors.test.ts, same names). The
// model's own property checks (checkCase) stay in the model; here every world is replayed
// through the model after each test, and header evaluations are compared with it directly.
const modelOf = (w: AclWorld) => {
  const mr = new M.Replica()
  for (const e of w.all) mr.receive(toModel(e))
  return mr
}
const withHeaders = (w: AclWorld, kept: string[], hdrs: string[]) => {
  const p = evaluate(kept, w.ref, hdrs)
  const m = M.evaluate(kept, modelOf(w), { ghosts: hdrs })
  return { p, m }
}
const classStats = (w: AclWorld) => {
  const fe = new FastEval(Ix.of(w.ref.order, w.ref))
  const S = fe.run()
  return { S, st: [fe.stats.maxClasses, fe.stats.fallbacks] }
}

// Revision 6: the r5 review. C1 (c) [device_revoke], M2 [ap cap] and I1 fail on revision 5 and
// pass here; I2 pins today's outcome (N21); "I3 (b)" pins why the ruled work bound is not adopted.
describe('r5 review (revision 6)', () => {
  test('C1 (c): a thief’s sibling flood does not void the revocation of the stolen device (device_revoke is no pool candidate)', () => {
    const w = base(INVITE)
    const MOD = role(w, 3, KICK | BAN)
    for (const d of ['A1', 'B1', 'C1']) join(w, d)
    w.ok('A2', 'device_add')
    give(w, 'A', MOD)
    const m0 = w.ok('O1', 'mark')
    const a2 = w.latestOwn('A2')!
    const sibs: string[] = []
    for (let i = 0; i < MODEL_LIMITS.poolU + 1; i++)
      sibs.push(
        w.ok('A2', 'mark', {}, { ap: [m0.id], seq: a2.seq + 1, aprev: a2.id, ts: m0.ts + 1 + i }).id
      )
    const noSib = () =>
      w.heads(w.ref.order.filter(x => !sibs.includes(x))).slice(0, MODEL_LIMITS.ap)
    w.ok('A1', 'ban', { to: 'B' }, { ap: noSib() })
    const rev = w.ok('A1', 'device_revoke', { dk: 'A2', seen: a2.seq }, { ap: noSib() })
    w.ok('C1', 'mark', {}, { ap: w.heads().slice(0, MODEL_LIMITS.ap) })
    w.ok('O1', 'mark')
    const S = w.state()
    expect(S.PC.has(rev.id)).toBe(false)
    expect(S.X.has(rev.id)).toBe(false)
    expect(S.facts.devs.get('A')?.has('A2') ?? false).toBe(false)
    for (const x of sibs) expect(S.tail.has(x)).toBe(true)
    orderIndependent(w)
  })

  test('M2 (C1 b): at most 10 ACL parents; an honest client caps its heads and keeps its own chain', () => {
    const w = base(INVITE)
    for (const d of ['A1', 'B1']) join(w, d)
    for (let i = 0; i < 12; i++) join(w, `m${i}x1`)
    const P0 = w.heads()
    const a = w.ok('A1', 'mark', {}, { ap: P0 })
    const ms: string[] = []
    for (let i = 0; i < 12; i++) ms.push(w.ok(`m${i}x1`, 'mark', {}, { ap: P0 }).id)
    expect(w.heads().length).toBeGreaterThan(MODEL_LIMITS.ap)
    const e = w.ok('A1', 'mark')
    expect(e.ap.length).toBeLessThanOrEqual(MODEL_LIMITS.ap)
    expect(e.aprev).toBe(a.id)
    expect(w.state().F.get('A1') ?? Infinity).toBe(Infinity)
    const r = w.act('B1', 'mark', {}, { ap: ms.slice(0, 11) })
    expect(r.v).toEqual({ s: 'R', why: 'ap' })
    expect(w.act('B1', 'mark', {}, { ap: ms.slice(0, 10) }).v.s).toBe('A')
  })

  test('poolmono (revision 7): pool candidacy can end, so a candidate only by pool evidence is never dropped and replicas agree', () => {
    const w = base(INVITE)
    join(w, 'A1')
    const a2 = w.ok('A2', 'device_add')
    w.ok('O1', 'mark')
    const preRev = w.heads()
    w.ok('A1', 'device_revoke', { dk: 'A2', seen: a2.seq })
    w.ok('O1', 'mark')
    const a3 = w.ok('A3', 'device_add')
    w.ok('O1', 'mark')
    const P0 = w.heads()
    let ts = 1000
    const chain = (dev: string, start: string[], profileLast = false) => {
      const ids: string[] = []
      let ap = start
      for (let i = 0; i < MODEL_LIMITS.totU - 1; i++) {
        const prof = profileLast && i === MODEL_LIMITS.totU - 2
        const e = w.ok(dev, prof ? 'profile' : 'mark', prof ? { name: 9 } : {}, {
          ap,
          ts: (ts += 11),
        })
        ids.push(e.id)
        ap = [e.id]
      }
      return ids
    }
    const c1 = chain('A1', P0, true)
    const c3 = chain('A3', P0)
    chain('A2', preRev)
    const S1 = w.ref.order.slice()
    const st1 = evaluate(S1, w.ref)
    const prof = c1[c1.length - 1]
    expect(st1.PC.has(prof) && st1.X.has(prof)).toBe(true)
    const bare = new Set<string>()
    const drops = orphanDrops(S1, st1, w.ref, [], bare)
    expect(drops.has(prof)).toBe(false)
    w.ok('A3', 'mark', {}, { ap: P0, seq: w.ref.ev(c3[0]).seq, aprev: a3.id, ts: (ts += 11) })
    const S2 = w.ref.order.slice()
    const st2 = evaluate(S2, w.ref)
    expect(st2.X.has(prof)).toBe(false)
    expect(st2.facts.profile.get('A')?.name).toBe(9)
    const kept = S2.filter(x => !drops.has(x))
    const st3 = evaluate(
      kept,
      w.ref,
      [...drops].filter(x => !bare.has(x))
    )
    expect(st3.facts.profile.get('A')?.name).toBe(9)
    for (const x of [...st2.X].filter(x => !drops.has(x))) expect(st3.X.has(x)).toBe(true)
    orderIndependent(w)
  })

  for (const kicked of [false, true]) {
    test(`I1 (GH${kicked ? ', kicked' : ''}): kept headers count as identity, rotation and pool evidence, as the reference does`, () => {
      const w = base(INVITE)
      join(w, 'X1')
      w.ok('O1', 'mark')
      if (kicked) w.ok('O1', 'kick', { to: 'X' })
      let ts = 1000
      for (let k = 0; k < 3; k++)
        w.ok('X1', 'mark', {}, { ap: [w.latestOwn('X1')!.id], ts: (ts += 11) })
      const tip = w.latestOwn('X1')!.id
      for (const d of ['X5', 'X6', 'X7']) w.ok(d, 'device_add', {}, { ap: [tip], ts: (ts += 11) })
      const m7 = w.ok('X7', 'mark', {}, { ap: [w.latestOwn('X7')!.id], ts: (ts += 11) })
      w.act('X1', 'mark', {}, { ap: [m7.id], ts: ts + 11 })
      const S = w.state()
      const drops = orphanDrops(w.ref.order, S, w.ref)
      expect(drops.size).toBeGreaterThan(0)
      const kept = w.ref.order.filter(x => !drops.has(x))
      const { p, m } = withHeaders(w, kept, [...drops])
      expect(evalSummary(p)).toBe(M.evalSummary(m))
      if (!kicked) expect([...(p.facts.devs.get('X') ?? [])]).toEqual(['X1'])
    })
  }

  test('I2 (N21-ban): a senior’s stale-device leave undoes a ban that relied on its promotions; the moderator re-applies it (N21: fail-open for denies)', () => {
    const w = base(INVITE)
    const RS = role(w, 20, ROLES)
    const R15 = role(w, 15, 0)
    const R10 = role(w, 10, 0)
    const RK = role(w, 2, BAN | KICK)
    for (const d of ['S1', 'P1', 'T1']) join(w, d)
    w.ok('S2', 'device_add')
    give(w, 'S', RS)
    give(w, 'P', RK)
    const H0 = w.heads()
    const gP = w.ok('S1', 'assign', { to: 'P', role: R15 })
    const gT = w.ok('S1', 'assign', { to: 'T', role: R10 })
    const ban = w.ok('P1', 'ban', { to: 'T' })
    w.ok('O1', 'mark')
    w.ok('S2', 'leave', {}, { ap: H0 })
    w.ok('O1', 'mark')
    const S = w.state()
    expect(S.cut.has(gP.id) && S.cut.has(gT.id) && S.cut.has(ban.id)).toBe(true)
    expect(S.eff.has(ban.id)).toBe(false)
    expect(S.facts.ban.has('T')).toBe(false)
    expect(S.facts.mem.has('T')).toBe(true)
    expect(gt(rank(S.facts, 'P'), rank(S.facts, 'T'))).toBe(true)
    const again = w.ok('P1', 'ban', { to: 'T' })
    const S2 = w.state()
    expect(S2.eff.has(again.id)).toBe(true)
    expect(S2.facts.ban.has('T') && !S2.facts.mem.has('T')).toBe(true)
    orderIndependent(w)
  })

  test('I3 (b): a junior’s ops never switch a senior stratum to the fallback (no work bound on the flat closure)', () => {
    const w = base(INVITE)
    w.ok('O2', 'device_add')
    const QR = role(w, 3, KICK | BAN)
    const AR = role(w, 2, ROLES)
    const R1 = role(w, 1, ROLES)
    const R3 = role(w, 0, INVITE)
    const HR = role(w, 5, 0)
    for (const d of 'Q1 R1 S1 A1 X1 P1 Z1 Y1 K1 L1 E1 F1 G1 H1 I1 J1'.split(' ')) join(w, d)
    for (const m of ['Q', 'R', 'S']) give(w, m, QR)
    for (const m of ['A', 'Z', 'Y']) give(w, m, AR)
    w.ok('O1', 'role_bits', { role: EVERYONE, bit: INVITE, on: false })
    const P0 = w.heads()
    const z = w.ok('Z1', 'assign', { to: 'K', role: R3 }, { ap: P0 })
    const y = w.ok('Y1', 'assign', { to: 'L', role: R3 }, { ap: P0 })
    const g1 = w.ok('A1', 'assign', { to: 'X', role: R1 }, { ap: P0 })
    const x = w.ok('X1', 'assign', { to: 'P', role: R3 }, { ap: [g1.id, z.id] })
    const p = w.ok('P1', 'add', { to: 'N' }, { ap: [x.id, y.id] })
    w.ok('K1', 'add', { to: 'N2' }, { ap: [z.id, g1.id] })
    w.ok('L1', 'add', { to: 'N3' }, { ap: [y.id, g1.id] })
    const c1 = w.ok('Q1', 'kick', { to: 'A' }, { ap: P0 })
    w.ok('R1', 'kick', { to: 'Z' }, { ap: P0 })
    w.ok('S1', 'kick', { to: 'Y' }, { ap: P0 })
    w.ok('O1', 'assign', { to: 'P', role: HR }, { ap: [p.id, c1.id] })
    expect(w.state().cut.has(p.id)).toBe(true)
    let last = x.id
    for (let i = 0; i < 6; i++)
      last = w.ok(
        'X1',
        'assign',
        { to: 'EFGHIJ'[i], role: R3 },
        { ap: [last], ts: 1000 + i * 11 }
      ).id
    const S = w.state()
    expect(S.cut.has(p.id)).toBe(true)
    expect(w.ref.rec(last).k[0]).toBeLessThan(w.ref.rec(c1.id).k[0])
    orderIndependent(w)
  })
})

// Revision 7: P(x) counts only concurrent events before their device's fork point, a candidate
// only by pool evidence is never dropped, events past their device's fork point that are not
// identity ops go without their headers, and honest clients never cite a candidate, X or Tail
// event (§2.3, §1.2, §4.1).
describe('revision 7 (C1, option 2)', () => {
  test('r7 C1 (a): a removed member’s sibling flood is dropped with at most two headers; honest clients don’t cite it', () => {
    const w = base(INVITE)
    w.ok('O1', 'add', { to: 'X' })
    w.ok('X1', 'join')
    w.ok('O1', 'mark')
    const P = w.heads()
    w.ok('O1', 'kick', { to: 'X' })
    for (let i = 0; i < 5; i++) w.ok('O1', 'mark', {}, { ts: 100 + 20 * i })
    const last = w.latestOwn('X1')!
    const sibs: string[] = []
    for (let k = 0; k < 200; k++) {
      const r = w.act(
        'X1',
        'profile',
        { name: k },
        { ap: P, seq: last.seq + 1, aprev: last.id, ts: 1000 + k }
      )
      if (r.v.s === 'A') sibs.push(r.e.id)
    }
    expect(sibs.length).toBe(200)
    const marks = [0, 1, 2].map(i => w.ok('O1', 'mark', {}, { ts: 3000 + 20 * i }))
    for (const m of marks) for (const x of sibs) expect(w.closure(m.ap).has(x)).toBe(false)
    const S = w.state()
    for (const x of sibs) expect(S.X.has(x)).toBe(true)
    const bare = new Set<string>()
    const drops = orphanDrops(w.ref.order, S, w.ref, [], bare)
    for (const x of sibs) expect(drops.has(x)).toBe(true)
    expect(sibs.filter(x => !bare.has(x)).length).toBeLessThanOrEqual(2)
    orderIndependent(w)
  })

  for (const cite of ['all heads', 'client rule'] as const) {
    test(`r7 C1 (c): a thief’s sibling flood no longer voids the victim’s ACL events (honest marks cite ${cite})`, () => {
      const w = base(INVITE)
      const MOD = role(w, 3, KICK | BAN)
      for (const d of ['A1', 'B1', 'C1']) join(w, d)
      w.ok('A2', 'device_add')
      give(w, 'A', MOD)
      const m0 = w.ok('O1', 'mark')
      const a2 = w.latestOwn('A2')!
      const sibs: string[] = []
      for (let i = 0; i < MODEL_LIMITS.poolU + 1; i++)
        sibs.push(
          w.ok('A2', 'mark', {}, { ap: [m0.id], seq: a2.seq + 1, aprev: a2.id, ts: m0.ts + 1 + i })
            .id
        )
      const noSib = () =>
        w.heads(w.ref.order.filter(x => !sibs.includes(x))).slice(0, MODEL_LIMITS.ap)
      const ban = w.ok('A1', 'ban', { to: 'B' }, { ap: noSib() })
      const rev = w.ok('A1', 'device_revoke', { dk: 'A2', seen: a2.seq }, { ap: noSib() })
      const o = () => (cite === 'all heads' ? { ap: w.heads().slice(-MODEL_LIMITS.ap) } : {})
      w.ok('C1', 'mark', {}, o())
      w.ok('O1', 'mark', {}, o())
      const S = w.state()
      expect(S.PC.has(ban.id)).toBe(false)
      expect(S.X.has(ban.id) || S.X.has(rev.id)).toBe(false)
      expect(S.facts.ban.has('B')).toBe(true)
      expect(S.facts.devs.get('A')?.has('A2') ?? false).toBe(false)
      orderIndependent(w)
    })
  }

  test('r7 C1 (c), after a rotation: a batch positioned before it voids neither the new primary’s kick nor the leave', () => {
    const w = base(INVITE)
    const MOD = role(w, 3, KICK | BAN)
    for (const d of ['A1', 'B1', 'C1', 'D1', 'E1']) join(w, d)
    w.ok('A2', 'device_add')
    give(w, 'A', MOD)
    const m0 = w.ok('O1', 'mark')
    const a2 = w.latestOwn('A2')!
    w.ok('A3', 'primary_rotate', { keep: ['A1'], seen: { A2: a2.seq }, pcert: 'p2' })
    w.ok('O1', 'mark')
    const sibs: string[] = []
    const batch = () => {
      for (let i = 0; i < MODEL_LIMITS.poolU + 1; i++)
        sibs.push(
          w.ok('A2', 'mark', {}, { ap: [m0.id], seq: a2.seq + 1, aprev: a2.id, ts: m0.ts + 1 }).id
        )
    }
    const noSib = () =>
      w.heads(w.ref.order.filter(x => !sibs.includes(x))).slice(0, MODEL_LIMITS.ap)
    batch()
    w.ok('C1', 'mark')
    w.ok('O1', 'mark')
    const ban = w.ok('A3', 'ban', { to: 'B' }, { ap: noSib() })
    w.ok('D1', 'mark')
    w.ok('O1', 'mark')
    batch()
    const kick = w.ok('A3', 'kick', { to: 'D' }, { ap: noSib() })
    const lv = w.ok('A1', 'leave', {}, { ap: noSib() })
    w.ok('E1', 'mark')
    w.ok('O1', 'mark')
    const S = w.state()
    for (const x of [ban.id, kick.id, lv.id]) expect(S.X.has(x)).toBe(false)
    expect(S.facts.ban.has('B')).toBe(true)
    expect(S.facts.mem.has('D')).toBe(false)
    expect(S.facts.mem.has('A')).toBe(false)
  })

  test('r7: a dropped identity op keeps its header (a later rotation concurrent with it is contested on every replica)', () => {
    const w = base(INVITE)
    join(w, 'X1')
    w.ok('O1', 'mark')
    const P = w.heads()
    const rs = [0, 1, 2].map(i =>
      w.ok(
        'X9',
        'primary_rotate',
        { keep: ['X1'], seen: {}, pcert: `q${i}` },
        { ap: P, seq: 1, aprev: null, ts: 50 + i }
      )
    )
    const S1 = w.state()
    for (const r of rs) expect(S1.X.has(r.id)).toBe(true)
    const bare = new Set<string>()
    const drops = orphanDrops(w.ref.order, S1, w.ref, [], bare)
    for (const r of rs) expect(drops.has(r.id)).toBe(true)
    expect(rs.some(r => bare.has(r.id))).toBe(false)
    const lo = rs
      .map(r => r.id)
      .sort()
      .slice(0, 2)
    const r4 = w.ok(
      'X10',
      'primary_rotate',
      { keep: ['X1'], seen: { X9: 1 }, pcert: 'q9' },
      { ap: lo }
    )
    const full = w.state()
    const kept = w.ref.order.filter(x => !drops.has(x) || lo.includes(x))
    const hdr = [...drops].filter(x => !bare.has(x) && !lo.includes(x))
    const { p, m } = withHeaders(w, kept, hdr)
    expect(full.RF.has(r4.id)).toBe(true)
    expect(p.RF.has(r4.id)).toBe(true)
    expect(p.X.has(r4.id)).toBe(full.X.has(r4.id))
    expect(evalSummary(p)).toBe(M.evalSummary(m))
  })
})

// r7.6: colluding identities layer their forked events; the proposed admission rule is not
// adopted. This pins today's outcome (spec §2.3, §6.2 N22).
describe('r7.6 (colluders layering forked events)', () => {
  test('r7.6: one held event keeps 110 void siblings of two colluders (10 per parent, two layers)', () => {
    const w = base(INVITE)
    let ts = 10
    for (const x of ['Y', 'Z']) {
      w.ok('O1', 'add', { to: x }, { ts: (ts += 3) })
      w.ok(`${x}1`, 'join', {}, { ts: (ts += 3) })
      w.ok(`${x}2`, 'device_add', {}, { ts: (ts += 3) })
    }
    const m0 = w.ok('O1', 'mark', {}, { ts: (ts += 3) })
    ts = 1000
    const sib = (dev: string, n: number, parents: (k: number) => string[]) => {
      const last = w.latestOwn(dev)!
      return Array.from({ length: n }, (_, k) => {
        const ap = parents(k)
        const full = w.closure(ap).has(last.id) ? ap : [...ap, last.id]
        return w.ok(dev, 'mark', {}, { ap: full, seq: last.seq + 1, aprev: last.id, ts: (ts += 1) })
          .id
      })
    }
    const y = sib('Y1', 100, () => [m0.id])
    const z = sib('Z1', 10, k => y.slice(10 * k, 10 * k + 10))
    const top = w.ok('Y2', 'mark', {}, { ap: z, ts: (ts += 1) })
    const S = w.state()
    expect(S.X.has(top.id)).toBe(false)
    const drops = orphanDrops(w.ref.order, S, w.ref)
    expect([...y, ...z].filter(x => S.X.has(x) && !drops.has(x)).length).toBe(110)
  })
})

// r7.9: the witness search may stop only at a structural candidacy (a pool candidacy can end).
describe('r7.9 (witness search)', () => {
  test('r7.9: a witness in good faith after an event where the candidate was only a pool candidate counts', () => {
    const w = base(INVITE)
    for (const d of ['A1', 'B1', 'C1']) join(w, d)
    const a2 = w.ok('A2', 'device_add')
    w.ok('O1', 'mark')
    const preRev = w.heads()
    w.ok('A1', 'device_revoke', { dk: 'A2', seen: a2.seq })
    w.ok('O1', 'mark')
    const a3 = w.ok('A3', 'device_add')
    w.ok('O1', 'mark')
    const P0 = w.heads()
    let ts = 1000
    const chain = (dev: string, start: string[]) => {
      const ids: string[] = []
      let ap = start
      for (let i = 0; i < MODEL_LIMITS.totU - 1; i++) {
        const e = w.ok(dev, 'mark', {}, { ap, ts: (ts += 11) })
        ids.push(e.id)
        ap = [e.id]
      }
      return ids
    }
    const c1 = chain('A1', P0)
    const c3 = chain('A3', P0)
    const c2 = chain('A2', preRev)
    const x = c1[c1.length - 1]
    const wv = w.ok(
      'B1',
      'mark',
      {},
      { ap: [x, c2[c2.length - 1], c3[c3.length - 1]], ts: (ts += 11) }
    )
    const s1 = w.ok(
      'A3',
      'mark',
      {},
      { ap: P0, seq: w.ref.ev(c3[0]).seq, aprev: a3.id, ts: (ts += 11) }
    )
    const wp = w.ok('C1', 'mark', {}, { ap: [wv.id, s1.id], ts: (ts += 11) })
    const f0 = w.ref.ev(c1[0])
    w.ok('A1', 'mark', {}, { ap: P0, seq: f0.seq, aprev: f0.aprev ?? null, ts: (ts += 11) })
    expect(w.ref.rec(wv.id).local.PC.has(x)).toBe(true)
    expect(w.ref.rec(wp.id).local.PC.has(x)).toBe(false)
    const S = w.state()
    expect(S.X.has(x)).toBe(false)
    expect(evalSummary(evaluate(w.ref.order, w.ref))).toBe(evalSummary(S))
  })
})

// r7.3's shape keeps the device_revoke exemption necessary: concurrent introductions of fresh
// devices fill the pool.
describe('r7.3 (concurrent introductions)', () => {
  test('r7.3: a device_revoke stays out of pool candidacy when concurrent introductions fill the pool', () => {
    const w = base(INVITE)
    for (const d of ['A1', 'B1', 'C1']) join(w, d)
    const m0 = w.ok('O1', 'mark')
    let ts = 500
    const fresh: string[] = []
    for (let i = 0; i < 20; i++) {
      const d = w.ok(`A${10 + i}`, 'device_add', {}, { ap: [m0.id], ts: (ts += 1) })
      fresh.push(w.ok(`A${10 + i}`, 'mark', {}, { ap: [d.id], ts: (ts += 1) }).id)
    }
    const ap = [...w.heads().filter(h => !/^A[1-9][0-9]$/.test(w.ref.ev(h).dev)), fresh[0]].slice(
      -MODEL_LIMITS.ap
    )
    const rev = w.ok(
      'A1',
      'device_revoke',
      { dk: 'A10', seen: w.ref.ev(fresh[0]).seq },
      { ap, ts: ts + 1 }
    )
    w.ok('C1', 'mark')
    const S = w.state()
    expect(S.PC.has(rev.id)).toBe(false)
    expect(S.X.has(rev.id)).toBe(false)
    expect(S.facts.devs.get('A')?.has('A10') ?? false).toBe(false)
  })
})

// r7b: the two older oracle findings of revision 7's final fuzz, and two readings.
describe('r7b (older oracle findings, readings)', () => {
  for (const via of ['revoke', 'kick'] as const) {
    test(`r7b O5-senior (seed 9043909, ${via}): removing the grant that protected C lets a junior ban cut C’s stratum-9 profile`, () => {
      const w = base()
      const RA = role(w, 7, ROLES | INVITE)
      const RC = role(w, 4, INVITE)
      const RB = role(w, 3, KICK | BAN)
      const RD = role(w, 8, KICK | BAN)
      join(w, 'A1')
      const a2 = w.ok('A2', 'device_add')
      for (const d of ['B1', 'C1', 'D1']) join(w, d)
      give(w, 'A', RA)
      give(w, 'B', RB)
      give(w, 'D', RD)
      const P = w.heads()
      const g = w.ok('A1', 'assign', { to: 'C', role: RC }, { ap: P })
      const ban = w.ok('B1', 'ban', { to: 'C' }, { ap: P })
      const mv = w.ok('O1', 'role_move', { role: RC, pos: 9 }, { ap: [ban.id] })
      const prof = w.ok('C1', 'profile', { name: 1 }, { ap: [g.id, ban.id, mv.id] })
      expect(w.ref.rec(prof.id).k[0]).toBe(9)
      expect(w.state().eff.has(ban.id)).toBe(false)
      if (via === 'revoke')
        w.ok('A2', 'device_revoke', { dk: 'A1', seen: w.latestOwn('A1')!.seq - 1 }, { ap: [a2.id] })
      else w.ok('D1', 'kick', { to: 'A' }, { ap: P })
      const S = w.state()
      expect(S.cut.get(g.id)?.[0]).toBe(via === 'revoke' ? 7 : 8)
      expect(S.tail.has(g.id)).toBe(via === 'revoke')
      expect(S.eff.has(ban.id)).toBe(true)
      expect(S.cut.get(prof.id)?.[0]).toBe(3)
      expect(S.facts.ban.has('C')).toBe(true)
      expect(S.facts.mem.has('C')).toBe(false)
    })
  }
  for (const shape of ['rejoin', 'fork'] as const) {
    test(`r7b O6-join (seed 8868407, ${shape}): a duel ban keeps its target’s racing join uncut; it gives no membership and keeps its add consumed`, () => {
      const w = base()
      const o2 = w.ok('O2', 'device_add')
      const R = role(w, 8, KICK | BAN | ROLES | INVITE)
      join(w, 'A1')
      w.ok('O1', 'add', { to: 'T' })
      const addT = w.latestOwn('O1')!
      w.ok('T1', 'join')
      give(w, 'A', R)
      let ban: { id: string }
      let racing: { id: string }
      if (shape === 'rejoin') {
        const P = w.heads()
        ban = w.ok('A1', 'ban', { to: 'T' }, { ap: P })
        const lv = w.ok('T1', 'leave', {}, { ap: P })
        const add2 = w.ok('O1', 'add', { to: 'T' }, { ap: [lv.id] })
        racing = w.ok('T1', 'join', {}, { ap: [add2.id] })
        give(w, 'T', R, 'O1', { ap: [racing.id] })
      } else {
        give(w, 'T', R)
        const sr = w.ok('T1', 'revoke', { to: 'T', role: R })
        ban = w.ok('A1', 'ban', { to: 'T' }, { ap: [sr.id] })
        racing = w.ok('T2', 'join', {}, { ap: [addT.id] })
        w.ok('O2', 'mark', {}, { ap: [racing.id, o2.id] })
      }
      let S = w.state()
      expect(S.eff.has(ban.id)).toBe(true)
      expect(S.cut.has(racing.id) || S.X.has(racing.id)).toBe(false)
      expect(S.facts.ban.has('T')).toBe(true)
      expect(S.facts.mem.has('T')).toBe(false)
      w.ok('A1', 'unban', { to: 'T' })
      S = w.state()
      expect(S.facts.ban.has('T')).toBe(false)
      expect(S.facts.mem.has('T')).toBe(false)
      if (shape === 'rejoin') expect(w.act('T1', 'join').v).toEqual({ s: 'R', why: 'auth' })
      else expect(S.facts.devs.get('T')?.has('T2') ?? false).toBe(true)
    })
  }
  test('r7b reading 1: the client rule’s upgrade exception (honest clients cite an upgrade in X, so the old server freezes)', () => {
    const w = base()
    join(w, 'R1')
    join(w, 'Q1')
    const P = w.heads()
    const u = w.ok('O1', 'upgrade', { next: 'G2' })
    const sib = w.ok('O1', 'mark', {}, { ap: P, seq: u.seq, aprev: u.aprev ?? null })
    expect(w.state().X.has(u.id)).toBe(true)
    expect(w.excluded().has(u.id)).toBe(false)
    expect(w.excluded().has(sib.id)).toBe(true)
    const m = w.act('R1', 'mark')
    expect(m.e.ap).toContain(u.id)
    expect(m.v).toEqual({ s: 'R', why: 'auth' })
    const lv = w.ok('R1', 'leave')
    expect(lv.ap).toContain(u.id)
    expect(w.ref.anc(lv.id).has(sib.id)).toBe(false)
    const S = w.state()
    expect(S.X.has(sib.id)).toBe(true)
    expect(S.facts.upgraded).toEqual([u.id])
    expect(w.act('Q1', 'mark').v).toEqual({ s: 'R', why: 'auth' })
  })
  test('r7b reading 2: W3(e) counts a vouch made where the add was a pool candidate; structural fork evidence still blocks', () => {
    {
      const w = base(INVITE)
      join(w, 'A1')
      join(w, 'V1')
      const a2 = w.ok('A2', 'device_add')
      w.ok('O1', 'mark')
      const preRev = w.heads()
      w.ok('A1', 'device_revoke', { dk: 'A2', seen: a2.seq })
      w.ok('O1', 'mark')
      const a3 = w.ok('A3', 'device_add')
      w.ok('O1', 'mark')
      const P0 = w.heads()
      let ts = 1000
      const chain = (dev: string, start: string[], addLast = false) => {
        const ids: string[] = []
        let ap = start
        for (let i = 0; i < MODEL_LIMITS.totU - 1; i++) {
          const last = addLast && i === MODEL_LIMITS.totU - 2
          const e = w.ok(dev, last ? 'add' : 'mark', last ? { to: 'Z' } : {}, {
            ap,
            ts: (ts += 11),
          })
          ids.push(e.id)
          ap = [e.id]
        }
        return ids
      }
      const c1 = chain('A1', P0, true)
      const c3 = chain('A3', P0)
      const c2 = chain('A2', preRev)
      const add = c1[c1.length - 1]
      const f = w.ok(
        'V1',
        'mark',
        {},
        { ap: [add, c3[c3.length - 1], c2[c2.length - 1]], ts: (ts += 11) }
      )
      expect(w.ref.rec(f.id).local.PC.has(add)).toBe(true)
      const sib = w.ok(
        'A3',
        'mark',
        {},
        { ap: P0, seq: w.ref.ev(c3[0]).seq, aprev: a3.id, ts: (ts += 11) }
      )
      const j = w.act('Z1', 'join', {}, { ap: [f.id, sib.id] })
      expect(j.v.s).toBe('A')
      expect(w.ref.rec(j.e.id).local.PC.has(add)).toBe(false)
      const S = w.state()
      expect(S.X.has(add)).toBe(false)
      expect(S.facts.mem.has('Z')).toBe(true)
    }
    {
      const w = base(INVITE)
      join(w, 'A1')
      join(w, 'V1')
      const P = w.heads()
      const add = w.ok('A1', 'add', { to: 'Z' }, { ap: P })
      const sib = w.ok('A1', 'mark', {}, { ap: P, seq: add.seq, aprev: add.aprev ?? null })
      const f = w.ok('V1', 'mark', {}, { ap: [add.id, sib.id] })
      expect(w.act('Z1', 'join', {}, { ap: [f.id] }).v.s).toBe('R')
      expect(w.state().X.has(add.id)).toBe(true)
    }
  })
})

// r7c: protection classes are distinct U(p) ∩ Γ⁺ over Fl \ X, Γ⁺ = the causes with a direct cut
// on an event outside X (the r7 re-review's C1). Revisions 5–7 projected each op's exposure onto
// G(p), which its author picks with its parents.
describe('r7c (class count from senior-made data)', () => {
  for (const cap of [2, 3]) {
    test(`r7c pclass (cap ${cap}): a protected author’s extra invites citing other cut grants make no class; the exact rule still cuts P’s invite`, () => {
      const w = base(0, { ...MODEL_LIMITS, classes: cap })
      const QR = role(w, 3, KICK | BAN)
      const AR = role(w, 2, ROLES)
      const R1 = role(w, 1, ROLES)
      const R3 = role(w, 0, INVITE)
      const HR = role(w, 5, 0)
      for (const d of 'Q1 R1 S1 T1 A1 Z1 Y1 W1 X1 P1 K1 L1 M1'.split(' ')) join(w, d)
      w.ok('P2', 'device_add')
      for (const m of ['Q', 'R', 'S', 'T']) give(w, m, QR)
      for (const m of ['A', 'Z', 'Y', 'W']) give(w, m, AR)
      const P0 = w.heads()
      const g1 = w.ok('A1', 'assign', { to: 'X', role: R1 }, { ap: P0 })
      const z = w.ok('Z1', 'assign', { to: 'K', role: R3 }, { ap: P0 })
      const y = w.ok('Y1', 'assign', { to: 'L', role: R3 }, { ap: P0 })
      const wv = w.ok('W1', 'assign', { to: 'M', role: R3 }, { ap: P0 })
      const x = w.ok('X1', 'assign', { to: 'P', role: R3 }, { ap: [g1.id, wv.id] })
      const p = w.ok('P1', 'add', { to: 'N' }, { ap: [x.id] })
      const cs = (['Q1', 'R1', 'S1', 'T1'] as const).map((d, i) =>
        w.ok(d, 'kick', { to: ['A', 'Z', 'Y', 'W'][i] }, { ap: P0 })
      )
      w.ok('O1', 'assign', { to: 'P', role: HR }, { ap: [p.id, cs[0].id, cs[1].id, cs[2].id] })
      expect(w.state().cut.has(p.id)).toBe(true)
      const plan = [
        ['P1', [p.id, z.id]],
        ['P2', [x.id, y.id]],
        ['P2', [x.id, y.id, z.id]],
      ] as const
      const ex: string[] = []
      for (let i = 0; i < cap; i++) {
        const [dev, ap] = plan[i]
        const own = w.latestOwn(dev)
        const full = own && !ap.includes(own.id) ? [...ap, own.id] : [...ap]
        ex.push(w.ok(dev, 'add', { to: `E${'abc'[i]}` }, { ap: full, ts: 2000 + 20 * i }).id)
      }
      const { S, st } = classStats(w)
      expect(st).toEqual([1, 0])
      expect(S.cut.has(g1.id) && S.cut.has(x.id) && S.cut.has(p.id)).toBe(true)
      expect(ex.map(e => S.cut.has(e))).toEqual(ex.map(() => true))
    })
  }
  test('r7c jclass: three juniors’ revoked devices give their two-hop invitees’ joins one class at ⊥; the exact rule cuts them all', () => {
    const w = base(INVITE)
    join(w, 'L1')
    w.ok('L2', 'device_add')
    const before = w.ok('O1', 'mark')
    const ids = ['b', 'c', 'd']
    for (const i of ids) {
      join(w, `J${i}1`)
      w.ok(`J${i}2`, 'device_add')
    }
    w.ok('O1', 'mark')
    w.ok('Vch1', 'mark')
    const pL = w.ok('L1', 'profile', { name: 'l' })
    const out: Record<string, string[]> = {}
    for (const i of ids) {
      const j2 = w.latestOwn(`J${i}2`)!
      const a1 = w.ok(`J${i}2`, 'add', { to: `M${i}` })
      const jm = w.ok(`M${i}1`, 'join', {}, { ap: [vouch(w, a1).id] })
      const a2 = w.ok(`M${i}1`, 'add', { to: `N${i}` }, { ap: [jm.id, pL.id] })
      const jn = w.ok(`N${i}1`, 'join', {}, { ap: [vouch(w, a2).id] })
      w.ok(
        `J${i}1`,
        'device_revoke',
        { dk: `J${i}2`, seen: j2.seq },
        { ap: [w.latestOwn(`J${i}1`)!.id, j2.id] }
      )
      out[i] = [a1.id, jm.id, a2.id, jn.id]
    }
    const lv = w.ok('L2', 'leave', {}, { ap: [before.id] })
    w.ok('O1', 'mark')
    const { st } = classStats(w)
    expect([st[0] <= 1, st[1]]).toEqual([true, 0])
    const S = w.state()
    expect(S.eff.has(lv.id) && S.cut.has(pL.id)).toBe(true)
    for (const i of ids) {
      const [a1, jm, a2, jn] = out[i]
      expect([
        S.cut.has(a1) || S.tail.has(a1),
        S.cut.has(jm),
        S.cut.has(a2),
        S.cut.has(jn),
      ]).toEqual([true, true, true, true])
      expect(S.facts.mem.has(`M${i}`) || S.facts.mem.has(`N${i}`)).toBe(false)
    }
  })
  test('r7c header read: a header is read only against its own identity’s events, through its maximal held ancestors, equal to the reference', () => {
    const w = base(INVITE)
    join(w, 'X1')
    join(w, 'Y1')
    for (let i = 0; i < 3; i++) w.ok('X1', 'mark')
    const P = w.ok('O1', 'mark')
    w.ok('O1', 'kick', { to: 'X' })
    for (let i = 0; i < 3; i++) {
      w.ok('O1', 'mark')
      w.ok('Y1', 'mark')
    }
    let ts = P.ts + 1
    for (let i = 0; i < 6; i++) {
      const d = w.act(`X${10 + i}`, 'device_add', {}, { ap: [P.id], ts: (ts += 20) })
      if (d.v.s !== 'A') continue
      let prev = d.e.id
      for (let j = 0; j < 4; j++) {
        const m = w.act(`X${10 + i}`, 'mark', {}, { ap: [prev], ts: (ts += 20) })
        if (m.v.s !== 'A') break
        prev = m.e.id
      }
    }
    const R0 = w.ok(
      'X1',
      'primary_rotate',
      { keep: [], seen: {}, pcert: 'p0' },
      { ap: [P.id], ts: (ts += 20) }
    )
    const m0 = w.ok('X1', 'mark', {}, { ap: [R0.id], ts: (ts += 20) })
    for (let b = 0; b < 3; b++) {
      let prev = m0
      let ap = [m0.id]
      for (let k = 0; k < 3; k++) {
        const r = w.act(
          'X1',
          'mark',
          {},
          { ap: [...ap], seq: prev.seq + 1, aprev: prev.id, ts: (ts += 20) }
        )
        if (r.v.s !== 'A') break
        prev = r.e
        ap = [r.e.id]
      }
      w.act(
        'X1',
        'primary_rotate',
        { keep: [], seen: {}, pcert: `p${b}` },
        { ap: [...ap], seq: prev.seq + 1, aprev: prev.id, ts: (ts += 20) }
      )
    }
    w.ok('Y1', 'mark')
    const S = w.state()
    const bare = new Set<string>()
    const drops = orphanDrops(w.ref.order, S, w.ref, [], bare)
    const hdrs = [...drops].filter(x => !bare.has(x))
    expect(hdrs.length).toBeGreaterThan(20)
    expect(hdrs.filter(x => w.ref.rec(x).depth >= 0).length).toBeGreaterThan(5)
    const rest = w.ref.order.filter(x => !drops.has(x))
    expect(rest.includes(R0.id) && rest.includes(m0.id) && !S.X.has(R0.id)).toBe(true)
    expect(hdrs.filter(x => w.ref.ev(x).t === 'primary_rotate').length).toBeGreaterThanOrEqual(2)
    const held = (id: string) => !drops.has(id)
    const { p, m } = withHeaders(w, rest, hdrs)
    const sum = (r: EvalResult | M.EvalResult, s: string) => [
      s,
      [...r.F].sort().join(';'),
      [...r.FI].sort().join(';'),
      [...(r.RF ?? [])].sort().join(),
      [...(r.PC ?? [])].filter(held).sort().join(),
    ]
    expect(sum(p, evalSummary(p))).toEqual(sum(m, M.evalSummary(m)))
    const RF = [...p.RF]
    expect(RF.length).toBeGreaterThanOrEqual(2)
    expect(RF.includes(R0.id)).toBe(false)
  })
  test('r7c N19 residual (realization): above the cap, a protected author’s backdated op that adds a senior-made class switches the stratum', () => {
    const w = base(INVITE)
    w.ok('O2', 'device_add')
    const QR = role(w, 3, KICK | BAN)
    const AR = role(w, 2, ROLES)
    const R1 = role(w, 1, ROLES)
    const R3 = role(w, 0, INVITE)
    const HR = role(w, 5, 0)
    for (const d of 'Q1 R1 S1 A1 X1 P1 Z1 Y1 K1 L1'.split(' ')) join(w, d)
    for (const m of ['Q', 'R', 'S']) give(w, m, QR)
    for (const m of ['A', 'Z', 'Y']) give(w, m, AR)
    w.ok('O1', 'role_bits', { role: EVERYONE, bit: INVITE, on: false })
    const P0 = w.heads()
    const z = w.ok('Z1', 'assign', { to: 'K', role: R3 }, { ap: P0 })
    const y = w.ok('Y1', 'assign', { to: 'L', role: R3 }, { ap: P0 })
    const g1 = w.ok('A1', 'assign', { to: 'X', role: R1 }, { ap: P0 })
    const x = w.ok('X1', 'assign', { to: 'P', role: R3 }, { ap: [g1.id, z.id] })
    const p = w.ok('P1', 'add', { to: 'N' }, { ap: [x.id, y.id] })
    const k = w.ok('K1', 'add', { to: 'N2' }, { ap: [z.id, g1.id] })
    const cs = (['Q1', 'R1', 'S1'] as const).map((d, i) =>
      w.ok(d, 'kick', { to: ['A', 'Z', 'Y'][i] }, { ap: P0 })
    )
    w.ok('O1', 'assign', { to: 'P', role: HR }, { ap: [p.id, cs[0].id] })
    w.ok('O2', 'assign', { to: 'K', role: HR }, { ap: [k.id, cs[1].id] })
    w.ok('O2', 'assign', { to: 'L', role: HR }, { ap: [y.id, cs[2].id] })
    expect(w.state().cut.has(p.id)).toBe(true)
    const l = w.ok('L1', 'add', { to: 'N3' }, { ap: [y.id, g1.id] })
    const { S, st } = classStats(w)
    expect(st).toEqual([3, 1])
    expect(S.cut.has(p.id)).toBe(false)
    expect(S.cut.has(l.id)).toBe(true)
  })
  test('r7c N19 residual (refinement): above the cap, a junior’s op that a quiet cause cuts makes the cause count and switches the stratum', () => {
    const w = new AclWorld()
    w.genesis('O1', ['O', 'B'], 0)
    w.ok('O1', 'add', { to: 'Vch' })
    w.ok('Vch1', 'join')
    w.ok('O2', 'device_add')
    w.ok('B1', 'join')
    const QR = role(w, 3, KICK | BAN)
    const AR = role(w, 2, ROLES)
    const R1 = role(w, 1, ROLES)
    const R3 = role(w, 0, INVITE)
    const HR = role(w, 5, 0)
    for (const d of 'Q1 R1 V1 A1 Z1 J1 X1 P1 Pq1 K1'.split(' ')) join(w, d)
    for (const m of ['Q', 'R', 'V']) give(w, m, QR)
    for (const m of ['A', 'Z']) give(w, m, AR)
    const P0 = w.heads()
    const g1 = w.ok('A1', 'assign', { to: 'X', role: R1 }, { ap: P0 })
    const gq = w.ok('A1', 'assign', { to: 'Pq', role: R3 })
    const z = w.ok('Z1', 'assign', { to: 'K', role: R3 }, { ap: P0 })
    const x = w.ok('X1', 'assign', { to: 'P', role: R3 }, { ap: [g1.id, z.id] })
    const p = w.ok('P1', 'add', { to: 'N' }, { ap: [x.id] })
    const pq = w.ok('Pq1', 'add', { to: 'Nq' }, { ap: [gq.id] })
    const k = w.ok('K1', 'add', { to: 'Nk' }, { ap: [z.id] })
    const c1 = w.ok('Q1', 'kick', { to: 'A' }, { ap: P0 })
    const c2 = w.ok('R1', 'kick', { to: 'Z' }, { ap: P0 })
    const g5 = w.ok('V1', 'kick', { to: 'J' }, { ap: P0 })
    w.ok('O1', 'assign', { to: 'P', role: HR }, { ap: [p.id, c1.id] })
    w.ok('O2', 'assign', { to: 'Pq', role: HR }, { ap: [pq.id, c1.id, g5.id] })
    w.ok('B1', 'assign', { to: 'K', role: HR }, { ap: [k.id, c2.id] })
    const a = classStats(w)
    expect(a.S.cut.has(p.id)).toBe(true)
    expect(a.st).toEqual([2, 0])
    const j = w.ok('J1', 'profile', { name: 'j' }, { ap: P0 })
    const { S, st } = classStats(w)
    expect(st).toEqual([3, 1])
    expect(S.cut.has(j.id) && S.cut.has(x.id) && S.cut.has(pq.id) && S.cut.has(k.id)).toBe(true)
    expect(S.cut.has(p.id)).toBe(false)
  })
})
