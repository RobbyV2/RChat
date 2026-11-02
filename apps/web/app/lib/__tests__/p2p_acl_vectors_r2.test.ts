// Regression vectors added in revision 2 of the P2P ACL spec (§7.6), ported from
// notes/acl-model/vectors-r2.test.ts with their names, against the production modules. After each
// test every world it built is replayed through the reference model, which must agree.
import { describe, expect, setDefaultTimeout, test } from 'bun:test'
import { evaluate } from '../p2p/acl/eval'
import { BAN, EVERYONE, INVITE, KICK, rank, rankOf, ROLES, SERVER } from '../p2p/acl/rules'
import { AclWorld, devOwner, evalSummary, modelDiffAfterEach, TestReplica } from './p2p_acl_world'

modelDiffAfterEach()
setDefaultTimeout(300_000)

function base(everyone = 0) {
  const w = new AclWorld()
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
function orderIndependent(w: AclWorld) {
  const ref = evalSummary(evaluate(w.ref.order, w.ref))
  let s = 7
  for (let n = 0; n < 12; n++) {
    const b = [...w.ref.order]
    for (let i = b.length - 1; i > 0; i--) {
      s = (s * 1103515245 + 12345) & 0x7fffffff
      const j = s % (i + 1)
      ;[b[i], b[j]] = [b[j], b[i]]
    }
    expect(evalSummary(evaluate(b, w.ref))).toBe(ref)
  }
}
/** Every delivery order of the universe gives the same verdicts and state as the reference replica. */
function converges(w: AclWorld, n = 6) {
  const ref = evalSummary(w.state())
  let s = 11
  for (let k = 0; k < n; k++) {
    const b = [...w.all]
    for (let i = b.length - 1; i > 0; i--) {
      s = (s * 1103515245 + 12345) & 0x7fffffff
      const j = s % (i + 1)
      ;[b[i], b[j]] = [b[j], b[i]]
    }
    const r = new TestReplica()
    for (const e of b) r.receive(e)
    expect(evalSummary(r.state())).toBe(ref)
  }
}

describe('r2 model findings', () => {
  test('H1: equivocation never shields from a deny (X events are still cut, and the cut cascades)', () => {
    const w = base()
    const MODV = role(w, 6, ROLES)
    const R = role(w, 2, BAN)
    w.ok('O2', 'device_add')
    join(w, 'V1')
    join(w, 'A1')
    join(w, 'Z1')
    give(w, 'V', MODV)
    const P0 = w.heads()
    const d2 = w.ok('A2', 'device_add', {}, { ap: P0 })
    const d3 = w.ok('A3', 'device_add', {}, { ap: P0 }) // A's identity chain forks at depth 1
    w.ok('O1', 'mark', {}, { ap: [d2.id] }) // each fork branch is witnessed in good faith by a different owner device
    w.ok('O2', 'mark', {}, { ap: [d3.id] })
    const P = w.heads()
    w.ok('O1', 'kick', { to: 'V' })
    const asg = w.ok('V1', 'assign', { to: 'A', role: R }, { ap: P }) // backdated past the kick
    expect(w.act('V1', 'mark', {}, { ap: P, seq: asg.seq, aprev: asg.aprev ?? null }).v.s).toBe('A') // V forks below it
    const bz = w.ok('A2', 'ban', { to: 'Z' }, { ap: [asg.id] }) // A2 can't witness: introduced at A's fork depth
    const S = w.state()
    expect(S.X.has(asg.id)).toBe(true)
    expect(S.cut.has(asg.id)).toBe(true) // X does not shield it from the kick
    expect(S.cut.has(bz.id)).toBe(true) // and the cut cascades to what was built on it
    expect(S.facts.ban.has('Z')).toBe(false)
    converges(w)
  })

  test('H2: a stolen device acting at a higher stratum than its revocation is still cut', () => {
    const w = base(INVITE)
    const R8 = role(w, 8, 0)
    join(w, 'A1')
    w.ok('A2', 'device_add')
    give(w, 'A', R8)
    const P = w.heads() // A ranks 8 here
    w.ok('O1', 'revoke', { to: 'A', role: R8 }) // A is demoted to ⊥
    w.ok('A1', 'device_revoke', { dk: 'A2', seen: w.latestOwn('A2')!.seq }) // revocation at stratum ⊥
    const add = w.ok('A2', 'add', { to: 'N' }, { ap: P }) // the thief backdates to stratum 8 (uses @everyone Invite)
    const j = w.ok('N1', 'join', {}, { ap: [vouch(w, add).id] })
    expect(w.ref.rec(add.id).k).toEqual(rankOf(w.ref.rec(add.id).local.facts, R8))
    const S = w.state()
    expect(S.tail.has(add.id)).toBe(true)
    expect(S.cut.has(add.id) && S.cut.has(j.id)).toBe(true)
    expect(S.facts.mem.has('N')).toBe(false)
  })

  test('H3: ops built on a deny that was ineffective in their view are cut once it is effective', () => {
    const w = base(INVITE)
    const M7 = role(w, 7, ROLES)
    const Q3 = role(w, 3, KICK)
    const R5 = role(w, 5, 0)
    join(w, 'M1')
    join(w, 'Q1')
    join(w, 'T1')
    give(w, 'M', M7)
    give(w, 'Q', Q3)
    const P = w.heads()
    w.ok('O1', 'revoke', { to: 'M', role: M7 }) // the owner demotes M
    const asg = w.ok('M1', 'assign', { to: 'T', role: R5 }, { ap: P }) // M promotes T concurrently (cut by the owner)
    const kick = w.ok('Q1', 'kick', { to: 'T' }, { ap: P }) // Q kicks T concurrently
    // T saw the promotion and the kick; in T's view the kick was ineffective (T ranked 5 > 3)
    const add = w.ok('T1', 'add', { to: 'N' }, { ap: [asg.id, kick.id] })
    expect(w.ref.rec(add.id).local.eff.has(kick.id)).toBe(false)
    const j = w.ok('N1', 'join', {}, { ap: [vouch(w, add).id] })
    const S = w.state()
    expect(S.eff.has(kick.id)).toBe(true)
    expect(S.cut.has(add.id) && S.cut.has(j.id)).toBe(true) // k*(add) fell to ⊥ when the promotion was cut
    expect(S.facts.mem.has('T') || S.facts.mem.has('N')).toBe(false)
    converges(w)
  })

  test('H4: good-faith witnessing: after a backup restore the original branch stands, the restored copy is void', () => {
    const w = base()
    join(w, 'A1')
    const P = w.heads()
    const r1 = w.ok('O1', 'role_create', { pos: 3, bits: KICK }) // original branch
    w.ok('A1', 'mark') // A acknowledges it in good faith
    const r2 = w.act(
      'O1',
      'role_create',
      { pos: 4, bits: BAN },
      { ap: P, seq: r1.seq, aprev: r1.aprev ?? null }
    ) // restored copy
    expect(r2.v.s).toBe('A')
    w.ok('A1', 'mark') // A now holds both siblings: this is not a good-faith witness of the restored one
    const S = w.state()
    expect(S.X.has(r1.id)).toBe(false)
    expect(S.X.has(r2.e.id)).toBe(true)
    expect(S.facts.roles.has(r1.id) && !S.facts.roles.has(r2.e.id)).toBe(true)
  })

  test("H5: a fork's extra branches count only as far as distinct devices acknowledged them in good faith", () => {
    const w = base(INVITE)
    join(w, 'V1')
    join(w, 'Q1')
    w.ok('Q2', 'device_add')
    const P = w.heads()
    const a1 = w.ok('V1', 'add', { to: 'N' })
    const a2 = w.ok('V1', 'add', { to: 'M' })
    const b1 = w.act('V1', 'add', { to: 'K' }, { ap: P, seq: a1.seq, aprev: a1.aprev ?? null }).e
    const b2 = w.act('V1', 'add', { to: 'L' }, { ap: [b1.id], seq: a2.seq, aprev: b1.id }).e
    w.ok('Q1', 'mark', {}, { ap: [a2.id] }) // Q1 acknowledges branch a
    w.ok('Q1', 'mark', {}, { ap: [b2.id] }) // Q1 then sees branch b too: not good faith for b
    expect([...F(w).pending.keys()].sort()).toEqual(['M', 'N'])
    w.ok('Q2', 'mark', {}, { ap: [b2.id], keepOwn: false }) // a second colluding device can carry branch b (bounded, §6.2 N14)
    expect([...F(w).pending.keys()].sort()).toEqual(['K', 'L', 'M', 'N'])
  })

  test('H6: mutual witnessing between two forked identities has one outcome (static cleanliness): both void', () => {
    const w = base()
    join(w, 'P1')
    join(w, 'Q1')
    const P0 = w.heads()
    const p2 = w.ok('P2', 'device_add', {}, { ap: P0 })
    w.ok('P3', 'device_add', {}, { ap: P0 }) // P's identity forks
    const q2 = w.ok('Q2', 'device_add', {}, { ap: P0 })
    w.ok('Q3', 'device_add', {}, { ap: P0 }) // Q's identity forks
    const wp = w.ok('P2', 'mark', {}, { ap: [p2.id, q2.id] }) // P2 "witnesses" Q2's intro
    const wq = w.ok('Q2', 'mark', {}, { ap: [q2.id, p2.id] }) // Q2 "witnesses" P2's intro
    const S = w.state()
    // A recursive witness rule has two fixed points here ({} and {p2, q2, wp, wq}); the static rule picks the void one.
    for (const x of [p2.id, q2.id, wp.id, wq.id]) expect(S.X.has(x)).toBe(true)
    orderIndependent(w)
  })
})

describe('invites, codes, registers, unknown types', () => {
  test('U1: an own uninvite needs no Kick; it cuts a concurrent join only with Kick and a rank above the joiner (r3, [RV C2])', () => {
    // plain inviter: the uninvite withdraws the pending invite, but a join that consumed it concurrently stands
    const w = base(INVITE)
    join(w, 'A1')
    vouch(w, w.ok('A1', 'add', { to: 'N' }))
    const P = w.heads()
    w.ok('A1', 'uninvite', { to: 'N' })
    const j = w.ok('N1', 'join', {}, { ap: P })
    expect(w.state().cut.has(j.id)).toBe(false)
    expect(F(w).mem.has('N')).toBe(true)
    // without a concurrent join the uninvite withdraws the invite
    w.ok('A1', 'add', { to: 'K' })
    w.ok('A1', 'uninvite', { to: 'K' })
    expect(F(w).pending.has('K') || F(w).invited.has('K')).toBe(false)
    // an inviter holding Kick and ranked above the joiner wins the race (as a kick of the new member would)
    const w2 = base()
    const Q = role(w2, 3, KICK | INVITE)
    join(w2, 'Q1')
    give(w2, 'Q', Q)
    vouch(w2, w2.ok('Q1', 'add', { to: 'N' }))
    const P2 = w2.heads()
    w2.ok('Q1', 'uninvite', { to: 'N' })
    const j2 = w2.ok('N1', 'join', {}, { ap: P2 })
    expect(w2.state().cut.has(j2.id)).toBe(true)
    expect(F(w2).mem.has('N') || F(w2).pending.has('N')).toBe(false)
    converges(w2)
  })

  test("U2: uninviting someone else's invite needs Kick and a rank above the inviter's stratum", () => {
    const w = base(INVITE)
    const Q = role(w, 2, KICK)
    join(w, 'Q1')
    join(w, 'A1')
    give(w, 'Q', Q)
    w.ok('O1', 'add', { to: 'N' })
    expect(w.act('Q1', 'uninvite', { to: 'N' }).v).toEqual({ s: 'R', why: 'auth' }) // the owner's invite is above Q
    w.ok('O1', 'uninvite', { to: 'N' })
    w.ok('A1', 'add', { to: 'M' })
    expect(w.act('Q1', 'uninvite', { to: 'M' }).v.s).toBe('A') // a plain member's invite (stratum ⊥) is below Q
  })

  test("U3: the invitee's later operations fall with its cut join once k* is re-read with the same-stratum cut", () => {
    // Q (pos 3, Kick) withdraws its invite of N from before N's join. N had meanwhile been promoted twice: by M (cut by
    // the owner's concurrent demotion of M) and, on the owner's stale second device, by the owner while the uninvite was
    // still ineffective. N's later mark has k = 6, but once N's join is cut at stratum 3 its k* is −∞ (§1.6, §3.1).
    const w = base(INVITE)
    const M7 = role(w, 7, ROLES)
    const R5 = role(w, 5, 0)
    const R6 = role(w, 6, 0)
    const Q3 = role(w, 3, KICK | INVITE)
    w.ok('O2', 'device_add')
    join(w, 'M1')
    join(w, 'Q1')
    give(w, 'M', M7)
    give(w, 'Q', Q3)
    const qa = w.ok('Q1', 'add', { to: 'N' })
    vouch(w, qa)
    const jn = w.ok('N1', 'join')
    const P = w.heads()
    w.ok('O1', 'revoke', { to: 'M', role: M7 }) // the owner demotes M
    const g1 = w.ok('M1', 'assign', { to: 'N', role: R5 }, { ap: P }) // M promotes N concurrently (cut at ⊤)
    const u = w.ok('Q1', 'uninvite', { to: 'N' }, { ap: [qa.id] }) // backdated before N's join
    const g2 = w.ok('O2', 'assign', { to: 'N', role: R6 }, { ap: [g1.id, u.id] }) // the uninvite looked ineffective here
    const m = w.ok('N1', 'mark', {}, { ap: [g2.id] })
    expect(w.ref.rec(m.id).k).toEqual(rankOf(w.ref.rec(g2.id).local.facts, R6))
    const S = w.state()
    expect(S.eff.has(u.id)).toBe(true)
    expect(S.cut.has(jn.id) && S.cut.has(m.id)).toBe(true)
    expect(S.facts.mem.has('N')).toBe(false)
    converges(w)
  })

  test("C-a / P1-M4: an add via a code concurrent with the code's revocation admits nobody", () => {
    const w = base(INVITE)
    const IR = role(w, 3, INVITE | KICK)
    join(w, 'I1')
    join(w, 'M1')
    give(w, 'I', IR)
    const c = w.ok('I1', 'code', { h: 'h1' })
    const P = w.heads()
    w.ok('I1', 'code_revoke', { code: c.id })
    const add = w.ok('M1', 'add', { to: 'N', code: c.id }, { ap: P })
    const j = w.ok('N1', 'join', {}, { ap: [vouch(w, add).id] })
    const S = w.state()
    expect(S.cut.has(add.id) && S.cut.has(j.id)).toBe(true)
    expect(S.facts.mem.has('N') || S.facts.invited.has('N')).toBe(false)
    converges(w)
  })

  test("C-a2 / [RV C2]: a Kick-less issuer's revocation does not undo the join of a member admitted through the code", () => {
    const w = base(INVITE)
    join(w, 'I1')
    join(w, 'M1')
    const c = w.ok('I1', 'code', { h: 'h1' })
    const P = w.heads()
    w.ok('I1', 'code_revoke', { code: c.id })
    const add = w.ok('M1', 'add', { to: 'N', code: c.id }, { ap: P })
    const j = w.ok('N1', 'join', {}, { ap: [vouch(w, add).id] })
    const S = w.state()
    expect(S.cut.has(j.id)).toBe(false) // the membership needs Kick and a higher rank to undo (§6.2 N17)
    expect(S.facts.mem.has('N')).toBe(true)
    converges(w)
  })

  test("C-b / R3-I5: a join concurrent with the code's revocation is cut even if the revoker saw the add", () => {
    const w = base(INVITE)
    const IR = role(w, 3, INVITE | KICK)
    join(w, 'I1')
    join(w, 'M1')
    give(w, 'I', IR)
    const c = w.ok('I1', 'code', { h: 'h1' })
    vouch(w, w.ok('M1', 'add', { to: 'N', code: c.id }))
    const P = w.heads()
    w.ok('I1', 'code_revoke', { code: c.id })
    const j = w.ok('N1', 'join', {}, { ap: P })
    expect(w.state().cut.has(j.id)).toBe(true)
    expect(F(w).mem.has('N')).toBe(false)
  })

  test('C-c / M7: a code whose issuer lost Invite stays dead after the issuer regains it', () => {
    const w = base()
    const R = role(w, 2, INVITE)
    const R2 = role(w, 3, INVITE)
    join(w, 'I1')
    give(w, 'I', R)
    const c = w.ok('I1', 'code', { h: 'h1' })
    w.ok('O1', 'revoke', { to: 'I', role: R })
    give(w, 'I', R2) // this assign's admission state saw the issuer without Invite
    expect(F(w).codes.has(c.id)).toBe(false)
    expect(w.act('O1', 'add', { to: 'N', code: c.id }).v).toEqual({ s: 'R', why: 'auth' })
  })

  test("C-d: a revoked code never returns, and a junior can't revoke a senior's code", () => {
    const w = base()
    const S5 = role(w, 5, SERVER | INVITE)
    const S2 = role(w, 2, SERVER)
    join(w, 'A1')
    join(w, 'B1')
    give(w, 'A', S5)
    give(w, 'B', S2)
    const c = w.ok('A1', 'code', { h: 'h1' })
    expect(w.act('B1', 'code_revoke', { code: c.id }).v).toEqual({ s: 'R', why: 'auth' })
    w.ok('A1', 'code_revoke', { code: c.id })
    const c2 = w.ok('A1', 'code', { h: 'h1' }) // the same hash again is a new, separate code
    expect(F(w).codes.has(c.id)).toBe(false) // the revoked code event stays dead (absorbing)
    expect(F(w).codes.has(c2.id)).toBe(true)
    expect(w.act('O1', 'add', { to: 'N', code: c.id }).v).toEqual({ s: 'R', why: 'auth' })
  })

  test('R-a / R3-M1: concurrent register writes resolve by stratum, then id, in any order', () => {
    const w = base()
    const S5 = role(w, 5, SERVER)
    const S2 = role(w, 2, SERVER)
    join(w, 'A1')
    join(w, 'B1')
    give(w, 'A', S5)
    give(w, 'B', S2)
    const P = w.heads()
    w.ok('B1', 'settings', { name: 1 }, { ap: P })
    w.ok('A1', 'settings', { name: 2 }, { ap: P })
    expect(F(w).setting?.name).toBe(2)
    orderIndependent(w)
    converges(w)
  })

  test("R-b: a demoted moderator's concurrent register write is cut", () => {
    const w = base()
    const S5 = role(w, 5, SERVER)
    join(w, 'A1')
    give(w, 'A', S5)
    w.ok('O1', 'settings', { name: 1 })
    const P = w.heads()
    w.ok('O1', 'revoke', { to: 'A', role: S5 })
    const s = w.ok('A1', 'settings', { name: 2 }, { ap: P })
    expect(w.state().cut.has(s.id)).toBe(true)
    expect(F(w).setting?.name).toBe(1)
  })

  test('P1-I4 / R2-I4 / R2-M2: an unknown ACL type is admitted with no effect, and its descendants are admitted', () => {
    const w = base()
    join(w, 'A1')
    const before = JSON.stringify([...F(w).mem])
    const x = w.ok('A1', 'x_future', { anything: [1, 2, 3] })
    w.ok('O1', 'mark', {}, { ap: [x.id] })
    expect(JSON.stringify([...F(w).mem])).toBe(before)
  })

  test('P1-C2 / S1-C1 / FA-3: W3 and W5 are deterministic; identical writes are rejected (W6), nothing is truncated', () => {
    const w = base(INVITE)
    join(w, 'A1')
    expect(w.act('A1', 'add', { to: 'N' }).v.s).toBe('A')
    expect(w.act('A1', 'add', { to: 'M' }).v.s).toBe('A')
    expect(w.act('A1', 'add', { to: 'K' }).v).toEqual({ s: 'R', why: 'W5' }) // 2 pending per device (model scale)
    w.ok('A1', 'uninvite', { to: 'N' }) // a deny: exempt from W3, frees a slot
    w.ok('A1', 'profile', { name: 1 })
    expect(w.act('A1', 'profile', { name: 1 }).v).toEqual({ s: 'R', why: 'auth' }) // W6: changes nothing
    expect(F(w).owners.has('O') && F(w).mem.has('O')).toBe(true)
  })
})

describe('limits', () => {
  test('W3 moderator multiplier and W5 role cap (model scale: 4 and 8 per window, 6 roles)', () => {
    const w = base()
    const MOD = role(w, 5, KICK | ROLES)
    join(w, 'A1')
    join(w, 'M1')
    give(w, 'M', MOD)
    const t0 = w.latestOwn('M1')!.ts + 20 // past the window of M's join
    const vm = Array.from({ length: 9 }, (_, i) => w.act('M1', 'mark', {}, { ts: t0 + i }).v.s)
    expect(vm.filter(x => x === 'A').length).toBe(8)
    for (let i = 0; i < 5; i++) w.ok('O1', 'role_create', { pos: 1, bits: 0 })
    expect(w.act('O1', 'role_create', { pos: 1, bits: 0 }).v).toEqual({ s: 'R', why: 'W5' }) // owners are exempt from W3, not W5 caps
  })
})

describe('review findings (rest)', () => {
  test('I8: two tabs signing from stale in-memory state are equivocation (why §3.9 builds events in the store transaction)', () => {
    const w = base(INVITE)
    join(w, 'A1')
    const P = w.heads()
    const x = w.ok('A1', 'mark')
    w.act('A1', 'mark', {}, { ap: P, seq: x.seq + 1, aprev: x.aprev ?? null }) // tab 2: same aprev, next seq
    expect(w.state().F.get('A1')).toBe(x.seq)
  })

  test("M7 / R3-C1: a device move is never equivocation; the old copy's later ACL events are cut by the revocation", () => {
    const w = base(INVITE)
    const R = role(w, 3, KICK)
    join(w, 'A1')
    join(w, 'T1')
    give(w, 'A', R)
    w.ok('A1', 'mark')
    const old = w.latestOwn('A1')!
    w.ok('A2', 'device_add') // import on a new device
    w.ok('A2', 'device_revoke', { dk: 'A1', seen: old.seq })
    const late = w.ok('A1', 'kick', { to: 'T' }, { ap: [old.id] }) // the old browser keeps going
    const k2 = w.ok('A2', 'kick', { to: 'T' })
    const S = w.state()
    expect(S.X.size).toBe(0)
    expect(S.cut.has(late.id) && S.eff.has(k2.id)).toBe(true)
    expect(rank(S.facts, 'A')).toEqual(rankOf(S.facts, R)) // moderator power intact on the new device
  })

  test('M7: a revocation watermark below an event the revoker holds is rejected', () => {
    const w = base()
    join(w, 'A1')
    w.ok('A2', 'device_add')
    const m = w.ok('A2', 'mark')
    expect(w.act('A1', 'device_revoke', { dk: 'A2', seen: m.seq - 1 }).v).toEqual({
      s: 'R',
      why: 'seen',
    })
  })

  test("§3.4-2: a senior's concurrent promotion protects the target from a junior's kick", () => {
    const w = base()
    const Q = role(w, 2, KICK)
    const R5 = role(w, 5, 0)
    join(w, 'Q1')
    join(w, 'T1')
    give(w, 'Q', Q)
    const P = w.heads()
    w.ok('O1', 'assign', { to: 'T', role: R5 })
    const kq = w.ok('Q1', 'kick', { to: 'T' }, { ap: P })
    const S = w.state()
    expect(S.eff.has(kq.id)).toBe(false)
    expect(S.facts.holds.get('T')?.has(R5) && S.facts.mem.has('T')).toBe(true)
  })

  test('§3.4-3 / O13: the canonical duel: both kicks stand', () => {
    const w = base()
    const R5 = role(w, 5, KICK)
    w.ok('O2', 'device_add')
    join(w, 'X1')
    join(w, 'Y1')
    const P = w.heads()
    const ax = give(w, 'X', R5, 'O1', { ap: P })
    const ay = give(w, 'Y', R5, 'O2', { ap: P })
    const kx = w.ok('X1', 'kick', { to: 'Y' }, { ap: [ax.id] })
    const ky = w.ok('Y1', 'kick', { to: 'X' }, { ap: [ay.id] })
    const S = w.state()
    expect(S.eff.has(kx.id) && S.eff.has(ky.id)).toBe(true)
    expect(S.facts.mem.has('X') || S.facts.mem.has('Y')).toBe(false)
  })

  test("ERA Fig. 3/5: a leave cuts the author's own concurrent same-stratum deny", () => {
    const w = base()
    const R5 = role(w, 5, KICK)
    join(w, 'A1')
    w.ok('A2', 'device_add')
    join(w, 'T1')
    give(w, 'A', R5)
    const P = w.heads()
    w.ok('A1', 'leave')
    const k = w.ok('A2', 'kick', { to: 'T' }, { ap: P })
    const S = w.state()
    expect(S.cut.has(k.id)).toBe(true)
    expect(S.facts.mem.has('T')).toBe(true)
  })
})

describe('previous-design findings', () => {
  const subtree = () => {
    const w = base(INVITE)
    const P0 = w.heads()
    w.ok('O1', 'add', { to: 'V' })
    const jv = w.ok('V1', 'join')
    vouch(w, w.ok('V1', 'add', { to: 'N' }))
    w.ok('N1', 'join')
    vouch(w, w.ok('N1', 'add', { to: 'M' }))
    w.ok('M1', 'join')
    return { w, P0, jv }
  }
  test('P1-C1b (i): the owner acted after the subtree joined, so a kick of V cuts nothing of it', () => {
    const { w } = subtree()
    w.ok('O1', 'mark')
    w.ok('O1', 'kick', { to: 'V' })
    expect(['N', 'M'].every(x => F(w).mem.has(x))).toBe(true)
  })
  test("P1-C1b (ii): a kick from a position right after V's join cuts V's invite subtree (N9, documented)", () => {
    const { w, jv } = subtree()
    w.ok('O1', 'kick', { to: 'V' }, { ap: [jv.id] })
    expect(['V', 'N', 'M'].some(x => F(w).mem.has(x))).toBe(false)
  })
  test("P1-C1b (iii): a promotion by the owner protects N from a moderator's backdated kick of V; N's invitee stays", () => {
    const w = base(INVITE)
    const Q = role(w, 2, KICK)
    const R5 = role(w, 5, 0)
    join(w, 'Q1')
    give(w, 'Q', Q)
    w.ok('O1', 'add', { to: 'V' })
    const jv = w.ok('V1', 'join')
    vouch(w, w.ok('V1', 'add', { to: 'N' }))
    w.ok('N1', 'join')
    w.ok('O1', 'assign', { to: 'N', role: R5 })
    vouch(w, w.ok('N1', 'add', { to: 'M' }))
    w.ok('M1', 'join')
    w.ok('Q1', 'kick', { to: 'V' }, { ap: [jv.id] })
    const S = F(w)
    expect(S.mem.has('V')).toBe(false)
    expect(S.mem.has('N') && S.mem.has('M')).toBe(true)
  })

  test("P1-I1: a member's op at a position before @everyone lost the bit is cut, and so is its cascade", () => {
    const w = base(INVITE)
    join(w, 'M1')
    const P = w.heads()
    w.ok('O1', 'role_bits', { role: EVERYONE, bit: INVITE, on: false })
    expect(w.act('M1', 'add', { to: 'N' }, { ap: P, ts: 0 }).v).toEqual({ s: 'R', why: 'ts' }) // a forged ts is rejected (A2)
    const add = w.ok('M1', 'add', { to: 'N' }, { ap: P }) // the old position alone backdates
    const j = w.ok('N1', 'join', {}, { ap: [vouch(w, add).id] })
    const S = w.state()
    expect(S.cut.has(add.id) && S.cut.has(j.id)).toBe(true)
  })

  test('P1-M1: rank and permission come from different roles', () => {
    const w = base()
    const HIGH = role(w, 5, 0)
    const LOW = role(w, 1, KICK)
    join(w, 'A1')
    join(w, 'X1')
    give(w, 'A', HIGH)
    give(w, 'A', LOW)
    expect(w.act('A1', 'kick', { to: 'X' }).v.s).toBe('A')
  })

  test('R2-C1a/b: kick, re-invite and rejoin; a stale event from before the kick undoes nothing', () => {
    const w = base()
    const ADMIN = role(w, 5, BAN | KICK)
    join(w, 'M1')
    join(w, 'B1')
    join(w, 'C1')
    const fork = w.heads()
    w.ok('O1', 'kick', { to: 'M' })
    join(w, 'M1')
    give(w, 'M', ADMIN)
    w.ok('M1', 'ban', { to: 'C' })
    w.ok('O1', 'kick', { to: 'B' })
    const stale = w.ok('B1', 'mark', {}, { ap: fork }) // B's stale device acts from before the kick
    join(w, 'B1')
    give(w, 'B', ADMIN)
    expect(w.act('C1', 'profile', { name: 2 }, { ap: fork }).v.s).toBe('A') // C's stale refresh
    const S = w.state()
    expect(S.facts.ban.has('C') && S.facts.mem.has('M')).toBe(true)
    expect(S.facts.holds.get('B')?.has(ADMIN)).toBe(true)
    expect(S.cut.has(stale.id)).toBe(true) // B's stale op was concurrent with B's kick
  })

  test('R2-S-C1 / FA-4: forked leaves before a ban are equivocation; a leave after the ban is rejected', () => {
    const w = base()
    join(w, 'B1')
    const P = w.heads()
    w.ok('O1', 'ban', { to: 'B' })
    const l1 = w.ok('B1', 'leave', {}, { ap: P })
    const l2 = w.act('B1', 'leave', {}, { ap: P, seq: l1.seq, aprev: l1.aprev ?? null })
    expect(l2.v.s).toBe('A')
    expect(w.state().F.get('B1')).toBe(l1.seq)
    expect(w.act('B1', 'leave', {}, { aprev: l1.id }).v.s).toBe('R')
    expect(F(w).ban.has('B')).toBe(true)
  })
})
