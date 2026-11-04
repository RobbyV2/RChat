import { describe, expect, test } from 'bun:test'
import { AclReplica } from '../p2p/acl/admit'
import { evaluate, FastEval } from '../p2p/acl/eval'
import { orphanDrops } from '../p2p/acl/equivocation'
import type { ProofHeader } from '../p2p/acl/admit'
import {
  BAN,
  canView,
  CHANNELS,
  EVERYONE,
  INVITE,
  KICK,
  MESSAGES,
  P,
  ROLES,
  type AclEv,
} from '../p2p/acl/rules'
import { AGREED, type Agreed } from '../p2p/limits'
import {
  AclWorld,
  devOwner,
  MODEL_LIMITS,
  modelDiffAfterEach,
  NONCE,
  testBinds,
} from './p2p_acl_world'

// Implementation vectors of the P2P ACL spec (§7.6 "Impl"): content visibility (§3.5), content
// admission, history (§3.6), proofs (§2.3) and registers, which the reference model leaves out.
// The ACL part of every universe is still replayed through the model (except where it uses a
// type the model lacks).

modelDiffAfterEach()

function base(everyone = 0, model = true, agreed?: Agreed) {
  const w = new AclWorld({ model, agreed })
  w.genesis('O1', ['O'], everyone)
  w.channel('O1')
  w.ok('O1', 'add', { to: 'Vch' })
  w.ok('Vch1', 'join')
  return w
}
const role = (w: AclWorld, pos: number, bits: number) => w.ok('O1', 'role_create', { pos, bits }).id
const join = (w: AclWorld, dev: string, by = 'O1') => {
  w.ok(by, 'add', { to: devOwner(dev) })
  return w.ok(dev, 'join')
}
const give = (w: AclWorld, to: string, r: string, by = 'O1') => w.ok(by, 'assign', { to, role: r })
const aclMax = (w: AclWorld, dev: string) => w.latestOwn(dev)?.seq ?? -1

describe('content visibility (§3.5)', () => {
  test('ban default: content the banner held stays, content past its watermark is hidden', () => {
    const w = base()
    join(w, 'U1')
    const t1 = w.content('U1')
    const P = w.heads()
    w.ok('O1', 'ban', { to: 'U' })
    const t2 = w.content('U1', 'msg', { body: 'late' }, { ap: P })
    expect(w.admitContent(t2).ok).toBe(true)
    const v = w.view()
    expect(v.visible(t1)).toBe(true)
    expect(v.hidden(t2)?.why).toBe('removed')
    expect(w.admitContent(w.content('U1')).ok).toBe(false)
  })

  test('ban option "Also hide all their messages" hides everything while the ban stands', () => {
    const w = base()
    join(w, 'U1')
    const t1 = w.content('U1')
    const b = w.ok('O1', 'ban', { to: 'U', wipe: true })
    expect(w.view().hidden(t1)).toEqual({ why: 'wipe', by: b.id })
    w.ok('O1', 'unban', { to: 'U' })
    expect(w.view().visible(t1)).toBe(true)
  })

  test('a wiping ban needs Manage messages', () => {
    const w = base(0, false)
    const MOD = role(w, 5, BAN)
    join(w, 'M1')
    join(w, 'U1')
    give(w, 'M', MOD)
    expect(w.act('M1', 'ban', { to: 'U', wipe: true }).v.s).toBe('R')
    expect(w.act('M1', 'ban', { to: 'U' }).v.s).toBe('A')
  })

  test('P1-M2: a message hidden by a ban stays hidden after unban and rejoin', () => {
    const w = base()
    join(w, 'U1')
    const P = w.heads()
    w.ok('O1', 'ban', { to: 'U' })
    const t = w.content('U1', 'msg', { body: 'x' }, { ap: P })
    expect(w.view().hidden(t)?.why).toBe('removed')
    w.ok('O1', 'unban', { to: 'U' })
    join(w, 'U1')
    expect(w.view().hidden(t)?.why).toBe('removed')
  })

  test('P1-I2 / R2-M5: a moderator demoted with revoke{seen}: its concurrent redaction and pin past seen are hidden, the message shows again', () => {
    const w = base()
    const MOD = role(w, 5, MESSAGES)
    join(w, 'M1')
    join(w, 'U1')
    give(w, 'M', MOD)
    const t = w.content('U1')
    const P = w.heads()
    const r = w.content('M1', 'redact', { target: t.id })
    const pin = w.content('M1', 'pin', { target: t.id, on: true })
    let v = w.view()
    expect(v.hidden(t)).toEqual({ why: 'redacted', by: r.id })
    expect(v.pinOf(t)).toBeNull()
    w.ok('O1', 'revoke', { to: 'M', role: MOD, seen: { M1: aclMax(w, 'M1') } }, { ap: P })
    v = w.view()
    expect(v.hidden(r)?.why).toBe('removed')
    expect(v.hidden(pin)?.why).toBe('removed')
    expect(v.visible(t)).toBe(true)
    expect(v.pinned(t)).toBe(false)
    // after the revoke, a redaction by M has no effect (no Manage messages in its admission state)
    const r2 = w.content('M1', 'redact', { target: t.id })
    expect(w.admitContent(r2).ok).toBe(true)
    expect(w.view().visible(t)).toBe(true)
  })

  test("a cascade never takes a redaction's Manage messages, which is read in its admission state, whatever else the cascade cuts", () => {
    const w = base(INVITE)
    const MOD = role(w, 5, MESSAGES)
    const PR = role(w, 7, ROLES)
    w.ok('O2', 'device_add')
    join(w, 'P1')
    give(w, 'P', PR)
    join(w, 'V1')
    join(w, 'U1')
    const P0 = w.heads()
    w.ok('V1', 'add', { to: 'M' })
    w.ok('Vch1', 'mark')
    w.ok('M1', 'join')
    w.ok('M1', 'leave')
    w.ok('O1', 'add', { to: 'M' })
    w.ok('M2', 'join')
    give(w, 'M', MOD, 'P1')
    const t = w.content('U1')
    const r = w.content('M2', 'redact', { target: t.id })
    // the owner's stale device removes V (cutting M's first join) and P (cutting M's role)
    w.ok('O2', 'kick', { to: 'V' }, { ap: P0 })
    w.ok('O2', 'kick', { to: 'P' }, { ap: P0 })
    const v = w.view()
    expect(v.visible(r)).toBe(true)
    expect(v.hidden(t)).toEqual({ why: 'redacted', by: r.id })
  })

  test('I6: a demoted ex-moderator backdates a redaction and a pin of a message posted after the demotion: no effect', () => {
    const w = base()
    const MOD = role(w, 5, MESSAGES)
    join(w, 'M1')
    join(w, 'U1')
    give(w, 'M', MOD)
    const P = w.heads()
    w.ok('O1', 'revoke', { to: 'M', role: MOD })
    const t = w.content('U1')
    const r = w.content('M1', 'redact', { target: t.id }, { ap: P })
    const pin = w.content('M1', 'pin', { target: t.id, on: true }, { ap: P })
    expect(w.admitContent(r).ok).toBe(true)
    const v = w.view()
    expect(v.visible(t)).toBe(true)
    expect(v.redactedBy(t)).toBeNull()
    expect(v.pinOf(t)).toBeNull()
    expect(v.pinned(t)).toBe(false)
    expect(v.visible(pin)).toBe(false)
  })

  test('redactions: by the author, an owner, or a member with Manage messages ranked above the author', () => {
    const w = base()
    const HI = role(w, 6, MESSAGES)
    const LO = role(w, 3, MESSAGES)
    join(w, 'A1')
    join(w, 'B1')
    join(w, 'U1')
    give(w, 'A', HI)
    give(w, 'B', LO)
    give(w, 'U', LO)
    const t1 = w.content('U1')
    const t2 = w.content('U1')
    const t3 = w.content('U1')
    const t4 = w.content('A1')
    w.content('B1', 'redact', { target: t1.id })
    w.content('A1', 'redact', { target: t2.id })
    w.content('U1', 'redact', { target: t3.id })
    w.content('B1', 'redact', { target: t4.id })
    const v = w.view()
    expect(v.visible(t1)).toBe(true)
    expect(v.visible(t2)).toBe(false)
    expect(v.visible(t3)).toBe(false)
    expect(v.visible(t4)).toBe(true)
  })

  test('R3-M3: content at or past the content fork point is hidden (one seq twice; a position missing its own ACL event)', () => {
    const w = base(INVITE)
    join(w, 'U1')
    const t1 = w.content('U1')
    const t2 = w.content('U1')
    const t3 = w.content('U1', 'msg', { body: 'twin' }, { seq: t2.seq, cprev: t1.id })
    let v = w.view()
    expect(v.visible(t1)).toBe(true)
    expect(v.hidden(t2)?.why).toBe('fork')
    expect(v.hidden(t3)?.why).toBe('fork')
    // E3: an ACL event of the device, then content at a later seq whose position lacks it
    const w2 = base(INVITE)
    const j = join(w2, 'V1')
    const P = w2.heads()
    const a = w2.ok('V1', 'add', { to: 'N' })
    const y = w2.content(
      'V1',
      'msg',
      { body: 'y' },
      { ap: [j.id, ...P], seq: a.seq + 1, keepOwn: false }
    )
    v = w2.view()
    expect(v.forkPoint('V1')).toBe(a.seq)
    expect(v.hidden(y)?.why).toBe('fork')
  })

  test("M7 / R3-C1: a device revocation hides the old copy's content past the watermark, on the heads and from the past", () => {
    const w = base(INVITE)
    join(w, 'A1')
    w.ok('A2', 'device_add')
    const before = w.content('A2')
    const s = before.seq
    const P = w.heads()
    w.ok('A1', 'device_revoke', { dk: 'A2', seen: s })
    const after = w.content('A2', 'msg', { body: 'old copy' }, { ap: P })
    let v = w.view()
    expect(v.visible(before)).toBe(true)
    expect(v.hidden(after)?.why).toBe('revoked')
    // the same after a full re-evaluation (not the head path)
    w.ref.acl.invalidate()
    v = w.view()
    expect(v.visible(before)).toBe(true)
    expect(v.hidden(after)?.why).toBe('revoked')
  })

  test("removals that reach invitees: a banned member's backdated invitee's content is hidden with its cut join", () => {
    const w = base()
    const R1 = role(w, 1, INVITE)
    join(w, 'V1')
    give(w, 'V', R1)
    const P0 = w.heads()
    w.ok('O1', 'ban', { to: 'V' })
    const add = w.ok('V1', 'add', { to: 'N' }, { ap: P0 })
    const ack = w.ok('Vch1', 'mark', {}, { ap: [add.id] })
    const j = w.ok('N1', 'join', {}, { ap: [ack.id] })
    const m = w.content('N1', 'msg', { body: 'hello' }, { ap: [j.id] })
    expect(w.admitContent(m).ok).toBe(true)
    const S = w.state()
    expect(S.cut.has(j.id)).toBe(true)
    expect(w.view().hidden(m)?.why).toBe('cut')
    // a member's content is unaffected
    expect(w.view().visible(w.content('Vch1'))).toBe(true)
  })

  test("a leave does not hide the leaver's earlier content; its other device's stale content past the leave's watermark is hidden", () => {
    const w = base()
    join(w, 'U1')
    w.ok('U2', 'device_add')
    const t1 = w.content('U1')
    const t2 = w.content('U2')
    const P = w.heads()
    w.ok('U1', 'leave', { seen: { U2: t2.seq } })
    const t3 = w.content('U2', 'msg', { body: 'stale' }, { ap: P })
    const v = w.view()
    expect(v.visible(t1)).toBe(true)
    expect(v.visible(t2)).toBe(true)
    expect(v.hidden(t3)?.why).toBe('removed')
    // a stale copy of the leaving device itself is a fork of that device
    const t4 = w.content('U1', 'msg', { body: 'fork' }, { ap: P, keepOwn: false })
    expect(w.view().hidden(t4)?.why).toBe('fork')
  })

  test("a re-invited member's message inside a senior remover's watermark stays visible though a cascade cut its first join", () => {
    const w = base(INVITE)
    const MOD = role(w, 5, BAN)
    join(w, 'Q1')
    give(w, 'Q', MOD)
    join(w, 'V1')
    const P = w.heads()
    w.ok('V1', 'add', { to: 'U' })
    w.ok('Vch1', 'mark')
    const j1 = w.ok('U1', 'join')
    w.ok('U1', 'leave')
    w.ok('O1', 'add', { to: 'U' })
    w.ok('U2', 'join')
    const m = w.content('U2')
    w.ok('Q1', 'ban', { to: 'V' }, { ap: P })
    w.ok('O1', 'kick', { to: 'U' })
    expect(w.state().cut.has(j1.id)).toBe(true)
    expect(w.view().visible(m)).toBe(true)
  })

  test("a stratum's in(x, W) asked after evaluation (content worlds) reads only higher strata in k*", () => {
    const w = base()
    const R5 = role(w, 5, KICK)
    const RB = role(w, 1, ROLES | INVITE)
    join(w, 'Q1')
    join(w, 'A1')
    join(w, 'B1')
    give(w, 'Q', R5)
    give(w, 'A', R5)
    give(w, 'B', RB)
    w.ok('A2', 'device_add')
    const P0 = w.heads()
    w.ok('B1', 'role_bits', { role: EVERYONE, bit: INVITE, on: true })
    const x = w.ok('A1', 'add', { to: 'M' })
    const leave = w.ok('A2', 'leave', {}, { ap: P0 })
    const kick = w.ok('Q1', 'kick', { to: 'B' }, { ap: P0 })
    const ix = w.ref.acl.ix
    const xi = ix.at.get(x.id)!
    const asked = (fe: FastEval) => {
      const info = fe.strataInfo.find(i => i.causes.includes(ix.at.get(kick.id)!))!
      expect(info.causes).toContain(ix.at.get(leave.id)!)
      return info.inW(xi, BigInt(1) << BigInt(info.causes.indexOf(ix.at.get(kick.id)!)))
    }
    let inside: boolean | undefined
    const a = new FastEval(ix)
    a.onStratum = () => {
      if (inside === undefined && a.cutOrd[xi] >= 0) inside = asked(a)
    }
    a.run()
    expect(inside).toBe(false)
    const fe = w.ref.acl.evaluation()
    expect(fe.cutOrd[xi]).toBeGreaterThanOrEqual(0)
    expect(asked(fe)).toBe(false)
  })

  test('R2-S-I3: a ban by a moderator whose role the owner revoked concurrently is ineffective; the message stays visible', () => {
    const w = base()
    const MOD = role(w, 5, BAN | KICK)
    join(w, 'M1')
    join(w, 'U1')
    give(w, 'M', MOD)
    const P = w.heads()
    const t = w.content('U1', 'msg', { body: 'x' }, { ap: P })
    const b = w.ok('M1', 'ban', { to: 'U' }, { ap: P })
    w.ok('O1', 'revoke', { to: 'M', role: MOD }, { ap: P })
    const S = w.state()
    expect(S.cut.has(b.id)).toBe(true)
    expect(S.facts.ban.has('U')).toBe(false)
    expect(w.view().visible(t)).toBe(true)
  })
})

describe('production evaluator (§5.4)', () => {
  test("B: a concurrent bit clear cuts a reader whose rank bound is above the stratum when the reader's author is exposed to it", () => {
    const w = base()
    const MOD = role(w, 5, ROLES)
    const R = role(w, 2, INVITE)
    const HI = role(w, 8, 0)
    join(w, 'M1')
    give(w, 'M', MOD)
    join(w, 'H1')
    give(w, 'H', R)
    give(w, 'H', HI)
    w.ok('O1', 'revoke', { to: 'H', role: HI })
    const P = w.heads()
    const o = w.ok('H1', 'add', { to: 'N' })
    const clr = w.ok('M1', 'role_bits', { role: R, bit: INVITE, on: false }, { ap: P })
    const S = w.state()
    expect(S.eff.has(clr.id)).toBe(true)
    expect(S.cut.get(o.id)).toEqual([5, MOD])
  })

  test('C: the world memo answers "not broken" only for subsets of a world known not to break', () => {
    const w = base()
    const MOD = role(w, 5, KICK)
    const VA = role(w, 3, ROLES)
    const VB = role(w, 4, ROLES)
    const RA = role(w, 1, INVITE)
    const RB = role(w, 2, INVITE)
    for (const d of ['Q1', 'S1', 'T1']) {
      join(w, d)
      give(w, devOwner(d), MOD)
    }
    join(w, 'A1')
    join(w, 'B1')
    join(w, 'Z1')
    join(w, 'P1')
    give(w, 'A', VA)
    give(w, 'B', VB)
    const P0 = w.heads()
    w.ok('A1', 'assign', { to: 'P', role: RA })
    w.ok('B1', 'assign', { to: 'P', role: RB })
    w.ok('Z1', 'mark')
    const x = w.ok('P1', 'add', { to: 'N' })
    const g1 = w.ok('Q1', 'kick', { to: 'A' }, { ap: P0 })
    const g2 = w.ok('S1', 'kick', { to: 'B' }, { ap: P0 })
    const g3 = w.ok('T1', 'kick', { to: 'Z' }, { ap: P0 })
    const ix = w.ref.acl.ix
    const xi = ix.at.get(x.id)!
    // in(x, W) of the stratum of the three kicks, for the world of the kicks `gs`
    const asker = (fe: FastEval) => {
      const info = fe.strataInfo.find(i => i.causes.includes(ix.at.get(g1.id)!))!
      expect(info.causes.length).toBe(3)
      return (gs: AclEv[]) => {
        let W = BigInt(0)
        for (const g of gs) W |= BigInt(1) << BigInt(info.causes.indexOf(ix.at.get(g.id)!))
        return info.inW(xi, W)
      }
    }
    // x falls only to both of its supports, which g1 and g2 cut; g3 cuts something else
    const fe = w.ref.acl.evaluation()
    expect(fe.cutOrd[xi]).toBeGreaterThanOrEqual(0)
    const ask = asker(fe)
    expect(ask([g1, g2, g3])).toBe(true)
    expect(ask([g1])).toBe(false)
    expect(ask([g1, g2])).toBe(true)
    // a run whose memo never saw the smaller world
    const fresh = new FastEval(ix)
    fresh.run()
    expect(asker(fresh)([g1, g2])).toBe(true)
  })
})

describe('display rules (§3.5)', () => {
  test("edits: only the author's, latest by (ts, id); reactions: latest per author and key", () => {
    const w = base()
    join(w, 'U1')
    join(w, 'X1')
    const t = w.content('U1')
    const e1 = w.content('U1', 'edit', { target: t.id, body: 'one' })
    const e2 = w.content('U1', 'edit', { target: t.id, body: 'two' }, { ts: e1.ts + 1 })
    w.content('X1', 'edit', { target: t.id, body: 'not mine' })
    w.content('X1', 'react', { target: t.id, key: '👍', on: true })
    w.content('U1', 'react', { target: t.id, key: '👍', on: true })
    w.content('U1', 'react', { target: t.id, key: '👍', on: false })
    const v = w.view()
    expect(v.editOf(t)?.id).toBe(e2.id)
    expect(v.reactions(t).map(r => r.a)).toEqual(['X'])
  })

  test("edits, reactions, pins and redactions act only in their target's channel", () => {
    const w = base()
    const MOD = role(w, 5, MESSAGES)
    join(w, 'M1')
    join(w, 'U1')
    give(w, 'M', MOD)
    w.ok('O1', 'channel', { id: 'c1', name: 'other' })
    const t = w.content('U1')
    const c1 = { ch: 'c1', target: t.id }
    w.content('U1', 'edit', { ...c1, body: 'moved' })
    w.content('U1', 'react', { ...c1, key: 'x', on: true })
    w.content('M1', 'pin', { ...c1, on: true })
    w.content('M1', 'redact', c1)
    let v = w.view()
    expect([v.editOf(t), v.reactions(t), v.pinned(t), v.visible(t)]).toEqual([
      null,
      [],
      false,
      true,
    ])
    w.content('M1', 'redact', { target: t.id })
    v = w.view()
    expect(v.visible(t)).toBe(false)
  })

  test('pins need Manage messages; the latest visible pin of a target decides', () => {
    const w = base()
    const MOD = role(w, 5, MESSAGES)
    join(w, 'M1')
    join(w, 'U1')
    give(w, 'M', MOD)
    const t = w.content('U1')
    w.content('U1', 'pin', { target: t.id, on: true })
    expect(w.view().pinned(t)).toBe(false)
    w.content('M1', 'pin', { target: t.id, on: true })
    expect(w.view().pinned(t)).toBe(true)
    w.content('M1', 'pin', { target: t.id, on: false })
    expect(w.view().pinned(t)).toBe(false)
  })

  test("a mention of everyone counts only with Mention everyone at the message's position", () => {
    const w = base()
    const ME = role(w, 5, P.MentionEveryone)
    join(w, 'U1')
    const a = w.content('U1', 'msg', { body: '@everyone', everyone: true })
    give(w, 'U', ME)
    const b = w.content('U1', 'msg', { body: '@everyone', everyone: true })
    const v = w.view()
    expect(v.mentionsEveryone(a)).toBe(false)
    expect(v.mentionsEveryone(b)).toBe(true)
  })

  test("history joined (§3.6): content belongs to X's history iff its position holds X's join, or X wrote it", () => {
    const w = base()
    join(w, 'U1')
    const before = w.content('U1')
    join(w, 'X1')
    const after = w.content('U1')
    const own = w.content('X1')
    const v = w.view()
    expect(v.inHistory(before, 'X')).toBe(false)
    expect(v.inHistory(after, 'X')).toBe(true)
    expect(v.inHistory(own, 'X')).toBe(true)
  })
})

describe('content admission (§2.2)', () => {
  test('the device chain, W4, the causal ts bound and Mem and Dev at the position', () => {
    const w = base()
    join(w, 'U1')
    const own = w.latestOwn('U1')!
    expect(w.admitContent(w.content('U1', 'msg', { body: 'a' }, { seq: own.seq })).ok).toBe(false)
    expect(w.admitContent(w.content('U1', 'msg', { body: 'b' }, { seq: own.seq + 501 }))).toEqual({
      ok: false,
      why: 'W4',
    })
    expect(w.admitContent(w.content('U1', 'msg', { body: 'c' }, { seq: own.seq + 500 })).ok).toBe(
      true
    )
    expect(
      w.admitContent(w.content('U1', 'msg', { body: 'd' }, { ts: 0, seq: own.seq + 3 }))
    ).toEqual({
      ok: false,
      why: 'ts',
    })
    expect(w.admitContent(w.content('Z1')).ok).toBe(false)
  })
})

describe('production-only types (not in the model)', () => {
  test('M4: a proof is admitted only if it lowers a fork point below an admitted event in its past, and E3 needs the content position in it', () => {
    const w = base(INVITE, false)
    join(w, 'U1')
    const P = w.heads()
    const a = w.ok('U1', 'add', { to: 'N' })
    const twin = w.build('U1', 'mark', {}, { ap: P, seq: a.seq, aprev: a.aprev ?? null })
    const hx = (e: { id: string; dev: string; seq: number; aprev?: string }): ProofHeader => ({
      id: e.id,
      dev: e.dev,
      seq: e.seq,
      aprev: e.aprev,
      L: 'a',
    })
    // the twin is never delivered, only its header in a proof
    const p = w.act('Vch1', 'proof', { x: hx(a), y: hx(twin) })
    expect(p.v.s).toBe('A')
    expect(w.state().F.get('U1')).toBe(a.seq)
    expect(w.state().X.has(a.id)).toBe(false) // the proof's author holds it in good faith
    // a second proof of the same pair lowers nothing
    expect(w.act('O1', 'proof', { x: hx(a), y: hx(twin) }).v).toEqual({ s: 'R', why: 'proof' })
    // E3 with the content header's position outside B(proof)
    const w2 = base(INVITE, false)
    const j = join(w2, 'V1')
    const Q = w2.heads()
    const x = w2.ok('V1', 'mark')
    const later = w2.ok('O1', 'mark')
    const y: ProofHeader = { id: 'c.V1.9', dev: 'V1', seq: x.seq + 1, L: 'c', ap: [later.id] }
    expect(w2.act('Vch1', 'proof', { x: hx(x), y }, { ap: Q }).v).toEqual({ s: 'R', why: 'proof' })
    const y2: ProofHeader = { id: 'c.V1.9', dev: 'V1', seq: x.seq + 1, L: 'c', ap: [j.id] }
    expect(w2.act('Vch1', 'proof', { x: hx(x), y: y2 }).v.s).toBe('A')
  })

  test('the orphan rule keeps a void proof: its header alone would not keep the evidence it carries', () => {
    const w = base(INVITE, false)
    join(w, 'U1')
    join(w, 'W1')
    const w1 = w.ok('W1', 'mark')
    const twin = w.build('W1', 'mark', { other: 1 }, { seq: w1.seq, aprev: w1.aprev ?? null })
    const P = w.heads()
    const ua = w.ok('U1', 'mark', {}, { ap: P })
    w.ok('U1', 'mark', { other: 1 }, { ap: P, seq: ua.seq, aprev: ua.aprev ?? null })
    const hx = (e: AclEv): ProofHeader => ({
      id: e.id,
      dev: e.dev,
      seq: e.seq,
      aprev: e.aprev,
      L: 'a',
    })
    const p = w.ok('U1', 'proof', { x: hx(w1), y: hx(twin) }, { ap: [ua.id] })
    const S = w.state()
    expect(S.X.has(p.id)).toBe(true)
    expect(S.F.get('W1')).toBe(w1.seq)
    const drops = orphanDrops(w.ref.order, S, w.ref)
    expect(drops.has(p.id)).toBe(false)
    const kept = w.ref.order.filter(id => !drops.has(id))
    expect(evaluate(kept, w.ref, [...drops]).F.get('W1')).toBe(w1.seq)
  })

  test('P1-I4: channels, overwrites and settings are registers; unknown enum values and bits are inert', () => {
    const w = base(0, false)
    const CH = role(w, 5, CHANNELS | ROLES)
    const LO = role(w, 2, 0)
    join(w, 'A1')
    join(w, 'B1')
    give(w, 'A', CH)
    expect(w.act('B1', 'channel', { id: 'c1', name: 'general' }).v).toEqual({ s: 'R', why: 'auth' })
    w.ok('A2', 'device_add')
    w.ok('A1', 'channel', { id: 'c1', name: 'general', kind: 'stage' })
    const H = w.heads()
    w.ok('A1', 'channel', { id: 'c1', name: 'news' }, { ap: H })
    w.ok('O1', 'channel', { id: 'c1', name: 'owners', restrict_send: false }, { ap: H })
    w.ok('A2', 'channel', { id: 'c1', name: 'x', restrict_view: true }, { ap: H })
    let F = w.state().facts
    expect(F.channels.get('c1')?.name).toBe('owners')
    expect(F.channels.get('c1')?.restrict_view).toBe(true)
    w.ok('A1', 'chperm', { ch: 'c1', subj: `r:${LO}`, allow: 0, deny: P.SendMessages })
    expect(w.act('A1', 'chperm', { ch: 'c1', subj: `r:${CH}`, allow: 0, deny: 1 }).v.s).toBe('R')
    // history: restrict-wins among the maximal writes, an unknown value reading as `joined`
    w.ok('O2', 'device_add')
    const S0 = w.heads()
    w.ok('O1', 'settings', { name: 'Srv', history: 'shared' }, { ap: S0 })
    w.ok('O2', 'settings', { name: 'Srv', history: 'invited' }, { ap: S0 })
    F = w.state().facts
    expect(F.overwrites.get('c1')?.get(`r:${LO}`)?.deny).toBe(P.SendMessages)
    expect(F.setting?.history).toBe('joined')
    w.ok('O1', 'settings', { name: 'Srv', history: 'shared' })
    expect(w.state().facts.setting?.history).toBe('shared')
    expect(w.act('O1', 'role_create', { pos: 1, bits: 1 << 20 }).v.s).toBe('A')
    expect(w.act('A1', 'x_newer', { anything: [1, 2] }).v.s).toBe('A')
  })

  test("P1-M5: a device revocation known only to contacts changes nothing until a member relays it; then it acts for the record's identity", () => {
    const w = base(INVITE, false)
    const HI = role(w, 7, KICK)
    join(w, 'A1')
    give(w, 'A', HI)
    w.ok('A2', 'device_add')
    join(w, 'R1')
    const P = w.heads()
    const s = w.latestOwn('A2')!.seq
    expect(w.state().facts.devs.get('A')?.has('A2')).toBe(true)
    const m1 = w.ok('R1', 'mark')
    const rel = w.ok('R1', 'device_revoke', { dk: 'A2', seen: s }, { actor: 'A' })
    expect([rel.a, rel.relay, rel.dev]).toEqual(['A', 'R', 'R1'])
    const rec = w.ref.rec(rel.id)
    expect([rec.k, rec.cls, rec.self, rec.exempt]).toEqual([[7, HI], 'D', true, false])
    expect(w.state().facts.devs.get('A')?.has('A2')).toBe(false)
    expect(w.act('A2', 'mark').v).toEqual({ s: 'R', why: 'auth' })
    const old = w.content('A2', 'msg', { body: 'old copy' }, { ap: P })
    expect(w.view().hidden(old)?.why).toBe('revoked')
    // the relay is in its relayer's pool, acknowledges none of the relayer's own events, and is in
    // no pool of the record's identity
    const m2 = w.ok('R1', 'mark')
    expect([rec.pool?.includes(m1.id), rec.pool?.includes(rel.id)]).toEqual([true, true])
    expect(w.ref.rec(m2.id).pool).toContain(rel.id)
    expect(w.ref.rec(m2.id).pool).toContain(m1.id)
    expect(w.ref.rec(w.ok('A1', 'mark', {}, { ap: [rel.id] }).id).pool).not.toContain(rel.id)
    // a relay of a record the position already holds is a duplicate
    expect(w.act('Vch1', 'device_revoke', { dk: 'A2', seen: s }, { actor: 'A' }).v).toEqual({
      s: 'R',
      why: 'dup',
    })
  })

  test('a primary_rotate is never relayed: two relays of one record would contest it (§2.3)', () => {
    const w = base(INVITE, false)
    join(w, 'A1')
    w.ok('A2', 'device_add')
    join(w, 'R1')
    join(w, 'T1')
    const s = w.latestOwn('A2')!.seq
    const c = { keep: ['A1'], seen: { A2: s }, pcert: 'p2' }
    const P = w.heads()
    expect(w.act('R1', 'primary_rotate', c, { actor: 'A', ap: P }).v).toEqual({
      s: 'R',
      why: 'auth',
    })
    expect(w.act('T1', 'primary_rotate', c, { actor: 'A', ap: P }).v).toEqual({
      s: 'R',
      why: 'auth',
    })
    expect(w.state().RF.size).toBe(0)
    expect(w.act('A1', 'primary_rotate', { ...c, keep: [] }).v).toEqual({ s: 'A' })
  })

  // forked copies of one identity's revocation record, posted by another member from one old
  // position: they are the relayer's events, in its pool, not in the record's identity's
  const copies = (w: AclWorld, n: number, P: string[], s: number) => {
    const y = w.latestOwn('Y1')!
    for (let k = 0; k < n; k++)
      expect(
        w.act(
          'Y1',
          'device_revoke',
          { dk: 'A2', seen: s },
          { actor: 'A', ap: P, seq: y.seq + 1 + k, aprev: y.id }
        ).v
      ).toEqual({ s: 'A' })
  }
  test("32 forked relays of a member's revocation record void nothing of its own: its kick stands, its next event is admitted", () => {
    const w = base(INVITE, false)
    const MOD = role(w, 5, KICK)
    join(w, 'A1')
    give(w, 'A', MOD)
    w.ok('A2', 'device_add')
    join(w, 'Y1')
    join(w, 'T1')
    const s = w.latestOwn('A2')!.seq
    const P = w.heads()
    w.ok('A1', 'device_revoke', { dk: 'A2', seen: s })
    const kick = w.ok('A1', 'kick', { to: 'T' })
    copies(w, 32, P, s)
    const S = w.state()
    expect([S.X.has(kick.id), S.PC.has(kick.id), S.facts.mem.has('T')]).toEqual([
      false,
      false,
      false,
    ])
    // the copies are past their relayer's device fork point: void whatever the pool, and in no
    // P(x) (revision 7), so none is a pool candidate
    const ys = w.ref.order.filter(id => w.ref.ev(id).relay === 'Y')
    expect([ys.length, ys.every(id => S.X.has(id)), ys.some(id => S.PC.has(id))]).toEqual([
      32,
      true,
      false,
    ])
    expect(w.act('A1', 'mark').v).toEqual({ s: 'A' })
  })

  test("two forked relays of a member's revocation record do not pin it (W3(f))", () => {
    const w = base(INVITE, false)
    join(w, 'A1')
    w.ok('A2', 'device_add')
    join(w, 'Y1')
    const s = w.latestOwn('A2')!.seq
    copies(w, 2, w.heads(), s)
    expect(w.act('A1', 'mark').v).toEqual({ s: 'A' })
  })

  test("a relay counts against its relayer's W3(b) total; a relayer's other device doesn't witness its forked relays", () => {
    const w = base(INVITE, false)
    join(w, 'A1')
    w.ok('A2', 'device_add')
    join(w, 'Y1')
    const s = w.latestOwn('A2')!.seq
    let ts = 1000
    for (let k = 0; k < MODEL_LIMITS.totU - 2; k++) w.ok('Y1', 'mark', {}, { ts: (ts += 100) })
    const r = w.ok('Y1', 'device_revoke', { dk: 'A2', seen: s }, { actor: 'A', ts: (ts += 100) })
    expect(w.ref.rec(r.id).exempt).toBe(false)
    expect(w.act('Y1', 'mark', {}, { ts: ts + 100 }).v).toEqual({ s: 'R', why: 'W3b' })
    const w2 = base(INVITE, false)
    join(w2, 'A1')
    w2.ok('A2', 'device_add')
    join(w2, 'Y1')
    w2.ok('Y2', 'device_add')
    const s2 = w2.latestOwn('A2')!.seq
    const P = w2.heads()
    copies(w2, 2, P, s2)
    const c1 = w2.ref.order.find(id => w2.ref.ev(id).relay === 'Y')!
    w2.ok('Y2', 'mark', {}, { ap: [c1] })
    expect(w2.state().X.has(c1)).toBe(true)
  })

  test("forked relays layered over the relayer's devices pin it (W3(f)): a held event keeps one chain of them, a kicked relayer's too", () => {
    for (const kicked of [false, true]) {
      const w = base(INVITE, false, AGREED)
      join(w, 'A1')
      w.ok('A2', 'device_add')
      join(w, 'B1')
      w.ok('B2', 'device_add')
      join(w, 'Y1')
      w.ok('Y2', 'device_add')
      w.ok('O1', 'mark')
      w.ok('Y3', 'device_add')
      const P = w.heads()
      const sA = w.latestOwn('A2')!.seq
      const sB = w.latestOwn('B2')!.seq
      w.ok('A1', 'device_revoke', { dk: 'A2', seen: sA })
      w.ok('B1', 'device_revoke', { dk: 'B2', seen: sB })
      if (kicked) w.ok('O1', 'kick', { to: 'Y' })
      const relay = (dev: string, ik: string, ap: string[]) =>
        w.act(
          dev,
          'device_revoke',
          { dk: `${ik}2`, seen: ik === 'A' ? sA : sB },
          { actor: ik, ap, keepOwn: false }
        )
      const L1 = Array.from({ length: 100 }, () => {
        const r = relay('Y1', 'A', P)
        expect(r.v).toEqual({ s: 'A' })
        return r.e.id
      })
      const w3f = { s: 'R' as const, why: 'W3f' }
      expect(relay('Y2', 'B', L1.slice(0, 10)).v).toEqual(w3f)
      expect(relay('Y2', 'B', L1.slice(0, 2)).v).toEqual(w3f)
      expect(w.act('Y2', 'mark', {}, { ap: L1.slice(0, 2), keepOwn: false }).v).toEqual(w3f)
      const L2 = L1.slice(0, 10).map(p => {
        const r = relay('Y2', 'B', [p])
        expect(r.v).toEqual({ s: 'A' })
        return r.e.id
      })
      expect(w.act('Y3', 'mark', {}, { ap: L2 }).v).toEqual(w3f)
      expect(w.act('Y3', 'mark', {}, { ap: L2.slice(0, 2) }).v).toEqual(w3f)
      const m = w.ok('Y3', 'mark', {}, { ap: [L2[0]] })
      const S = w.state()
      expect([...L1, ...L2].every(id => S.X.has(id))).toBe(true)
      expect(S.X.has(m.id)).toBe(false)
      const drops = orphanDrops(w.ref.order, S, w.ref)
      const keptY = w.ref.order.filter(id => devOwner(w.ref.ev(id).dev) === 'Y' && !drops.has(id))
      expect(keptY.filter(id => w.ref.ev(id).relay === 'Y')).toEqual([L1[0], L2[0]])
      expect(keptY.length).toBeLessThanOrEqual(AGREED.poolU)
      if (kicked) continue
      // an acknowledged relay pins nothing
      const ack = w.ok('O1', 'mark', {}, { ap: [L1[0]] })
      expect(w.act('Y2', 'mark', {}, { ap: [ack.id, L1[1]], keepOwn: false }).v).toEqual({
        s: 'A',
      })
    }
  })

  test("forked relays beside the relayer's acknowledged events count in its W3(g) pool: gathering them stops at the cap, a kicked relayer's too", () => {
    for (const kicked of [false, true]) {
      const w = base(INVITE, false, AGREED)
      join(w, 'A1')
      w.ok('A2', 'device_add')
      join(w, 'B1')
      w.ok('B2', 'device_add')
      join(w, 'Y1')
      w.ok('Y2', 'device_add')
      w.ok('O1', 'mark')
      w.ok('Y3', 'device_add')
      const sA = w.latestOwn('A2')!.seq
      const sB = w.latestOwn('B2')!.seq
      let ack = w.ok('O1', 'mark')
      let ts = ack.ts
      const ys: AclEv[] = []
      for (let k = 0; k < 400; k++) {
        ys.push(w.ok('Y1', 'mark', {}, { ap: [ack.id], ts: (ts += 61_000) }))
        if (k % 20 === 19) ack = w.ok('O1', 'mark', {}, { ap: [ys[k].id] })
      }
      const L = ys.map(y => {
        const r = w.act(
          'Y1',
          'device_revoke',
          { dk: 'A2', seen: sA },
          { actor: 'A', ap: y.ap, seq: y.seq, ts: y.ts }
        )
        expect(r.v).toEqual({ s: 'A' })
        return r.e.id
      })
      if (kicked) w.ok('O1', 'kick', { to: 'Y' }, { ap: [ack.id] })
      let held = ack.id
      let n = 0
      let total = 0
      let refused = false
      const gathered: string[] = []
      const gather = (dev: string, r: number) => {
        const v = w.act(dev, 'mark', {}, { ap: [held, ...L.slice(n, n + r)] })
        const over = total + 1 + r > AGREED.poolU
        expect(v.v).toEqual(over ? { s: 'R', why: 'W3g' } : { s: 'A' })
        if (over) return false
        held = v.e.id
        gathered.push(held)
        n += r
        total += 1 + r
        return true
      }
      for (let j = 0; j < 24; j++) expect(gather('Y2', 8)).toBe(true)
      for (let j = 0; j < 23 && !refused; j++) refused = !gather('Y3', j ? 9 : 8)
      expect([refused, n < L.length]).toEqual([true, true])
      expect(gather('Y3', AGREED.poolU - total - 1)).toBe(true)
      expect(total).toBe(AGREED.poolU)
      expect(gather('Y3', 0)).toBe(false)
      const rB = { dk: 'B2', seen: sB }
      expect(w.act('Y3', 'device_revoke', rB, { actor: 'B', ap: [held] }).v).toEqual({
        s: 'R',
        why: 'W3g',
      })
      // the relays it left out are concurrent with the held head, but past Y1's fork point: they
      // count in no pool (revision 7), so the head is no candidate; they are void and dropped
      const S = w.state()
      expect([L.every(id => S.X.has(id)), S.PC.has(held), S.X.has(held)]).toEqual([
        true,
        false,
        false,
      ])
      expect(w.act('A1', 'mark', {}, { ap: [held] }).v).toEqual({ s: 'A' })
      if (kicked) continue
      // acknowledged relays count nothing: the rest of them can be gathered
      held = w.ok('O1', 'mark', {}, { ap: [held] }).id
      total = 0
      while (n < L.length) expect(gather('Y3', Math.min(9, L.length - n))).toBe(true)
    }
  })

  // A relayer's forked relays beside its acknowledged marks, gathered by its other devices in
  // separate views (W3(b) stops each at 24 marks): its relays are its own events across devices
  const gatherViews = (devs: string[], kicked: boolean) => {
    const w = base(INVITE, false, AGREED)
    join(w, 'A1')
    w.ok('A2', 'device_add')
    join(w, 'Y1')
    for (const d of devs) {
      w.ok(d, 'device_add')
      w.ok('O1', 'mark')
    }
    const sA = w.latestOwn('A2')!.seq
    // O acknowledges each of Y1's marks, so a relay beside one has only itself in its pool
    let ack = w.ok('O1', 'mark')
    let ts = ack.ts
    const ys: AclEv[] = []
    for (let k = 0; k < 360; k++) {
      ys.push(w.ok('Y1', 'mark', {}, { ap: [ack.id], ts: (ts += 61_000) }))
      ack = w.ok('O1', 'mark', {}, { ap: [ys[k].id] })
    }
    if (kicked) w.ok('O1', 'kick', { to: 'Y' }, { ap: [ack.id] })
    const heads = new Map(devs.map(d => [d, ack.id]))
    // Y4, revoked afterwards, gathers at old positions (its events past the watermark are kept)
    const rv = { dk: 'Y4', seen: w.latestOwn('Y4')?.seq }
    if (devs.includes('Y4')) heads.set('Y2', w.ok('Y2', 'device_revoke', rv, { ap: [ack.id] }).id)
    const rel: string[] = []
    const marks: string[] = []
    const gather = (dev: string, k: number) => {
      for (let j = 0; j < k; j++) {
        const rs = ys.slice(rel.length, rel.length + 9).map(y => {
          const c = { dk: 'A2', seen: sA }
          const r = w.act('Y1', 'device_revoke', c, { actor: 'A', ap: y.ap, seq: y.seq, ts: y.ts })
          expect(r.v).toEqual({ s: 'A' })
          return r.e.id
        })
        rel.push(...rs)
        const m = w.ok(dev, 'mark', {}, { ap: [heads.get(dev)!, ...rs] })
        heads.set(dev, m.id)
        marks.push(m.id)
      }
    }
    const state = () => {
      const S = w.state()
      const drops = orphanDrops(w.ref.order, S, w.ref)
      const h = [...heads.values()]
      return {
        heads: [h.some(x => S.PC.has(x)), h.every(x => S.PC.has(x) && S.X.has(x))],
        // forked relays: past their device's fork point, void whatever the pool (revision 7)
        rel: rel.every(x => S.X.has(x)),
        kept: [...rel, ...marks].filter(x => !drops.has(x)).length,
      }
    }
    const ik = () => {
      const a = w.ok('A1', 'mark', {}, { ap: [...heads.values()] })
      return w.state().PC.has(a.id)
    }
    return { gather, state, ik, all: () => rel.length + marks.length }
  }
  test("a relayer's relays share its pool across devices: two views past poolU make the heads pool candidates, which stay stored (revision 7); a kicked relayer's too", () => {
    for (const kicked of [false, true]) {
      const v = gatherViews(['Y2', 'Y3'], kicked)
      v.gather('Y2', 24)
      v.gather('Y3', 13)
      expect(v.state()).toMatchObject({ heads: [false, false], kept: 370 })
      v.gather('Y3', 3)
      const S = v.state()
      expect([S.heads, S.rel]).toEqual([[true, true], true])
      // revision 7: a candidate only by pool evidence stays stored, with its past; each view is
      // bounded by W3(g) at admission (spec 4.1 growth bound, per device chain)
      expect([S.kept, S.kept <= 2 * AGREED.poolU]).toEqual([v.all(), true])
      expect(v.ik()).toBe(false)
    }
  }, 120_000)

  test("a relayer's relays share its pool across devices: three views, one on a device revoked later, past poolU make the heads pool candidates, which stay stored (revision 7); a kicked relayer's too", () => {
    for (const kicked of [false, true]) {
      const v = gatherViews(['Y2', 'Y3', 'Y4'], kicked)
      for (const d of ['Y2', 'Y3', 'Y4']) v.gather(d, 12)
      expect(v.state()).toMatchObject({ heads: [false, false], kept: 360 })
      v.gather('Y4', 4)
      const S = v.state()
      expect([S.heads, S.rel]).toEqual([[true, true], true])
      expect([S.kept, S.kept <= 3 * AGREED.poolU]).toEqual([v.all(), true])
      expect(v.ik()).toBe(false)
    }
  }, 120_000)

  test('a relay of a record whose forked, unwitnessed copy is in its past is a duplicate, though the void copy left the device live', () => {
    const w = base(INVITE, false)
    join(w, 'A1')
    w.ok('A2', 'device_add')
    join(w, 'Y1')
    join(w, 'R1')
    const s = w.latestOwn('A2')!.seq
    const P = w.heads()
    const rec = { dk: 'A2', seen: s }
    const copy = w.ok('Y1', 'device_revoke', rec, { actor: 'A', ap: P, keepOwn: false })
    const twin = w.ok('Y1', 'mark', {}, { ap: P, keepOwn: false })
    const ap = [copy.id, twin.id]
    const St = w.ref.acl.stateOf(ap)
    expect([St.X.has(copy.id), St.facts.devs.get('A')?.has('A2')]).toEqual([true, true])
    expect(w.act('R1', 'device_revoke', rec, { actor: 'A', ap }).v).toEqual({ s: 'R', why: 'dup' })
    expect(w.act('R1', 'device_revoke', { ...rec, seen: s + 1 }, { actor: 'A', ap }).v).toEqual({
      s: 'A',
    })
  })

  test("a relay counts in its relayer's W3(a) hour: at the cap, the relayer's next relay is refused; an identity's own revocation is exempt", () => {
    const w = base(INVITE, false)
    join(w, 'A1')
    w.ok('A2', 'device_add')
    join(w, 'B1')
    w.ok('B2', 'device_add')
    join(w, 'Y1')
    const sA = w.latestOwn('A2')!.seq
    const sB = w.latestOwn('B2')!.seq
    let ts = 1000
    for (let k = 0; k < MODEL_LIMITS.w3 - 1; k++) w.ok('Y1', 'mark', {}, { ts: (ts += 1) })
    w.ok('Y1', 'device_revoke', { dk: 'A2', seen: sA }, { actor: 'A', ts: (ts += 1) })
    const rB = { dk: 'B2', seen: sB }
    expect(w.act('Y1', 'device_revoke', rB, { actor: 'B', ts: ts + 1 }).v).toEqual({
      s: 'R',
      why: 'W3',
    })
    for (let k = 0; k < MODEL_LIMITS.w3; k++) w.ok('B1', 'mark', {}, { ts: ts + 1 + k })
    expect(w.act('B1', 'device_revoke', rB, { ts: ts + 1 + MODEL_LIMITS.w3 }).v).toEqual({ s: 'A' })
    const w2 = base(INVITE, false)
    join(w2, 'A1')
    w2.ok('A2', 'device_add')
    join(w2, 'Y1')
    for (let k = 0; k < MODEL_LIMITS.w3; k++) w2.ok('Y1', 'mark', {}, { ts: 1000 + k })
    const r = { dk: 'A2', seen: w2.latestOwn('A2')!.seq }
    const last = 1000 + MODEL_LIMITS.w3 - 1
    expect(w2.act('Y1', 'device_revoke', r, { actor: 'A', ts: last + 1 }).v).toEqual({
      s: 'R',
      why: 'W3',
    })
    expect(w2.act('Y1', 'device_revoke', r, { actor: 'A', ts: last + MODEL_LIMITS.win }).v.s).toBe(
      'A'
    )
  })

  test("relaying needs a member's live device; a forged relayer is refused", () => {
    const w = base(INVITE, false)
    join(w, 'A1')
    w.ok('A2', 'device_add')
    join(w, 'R1')
    join(w, 'L1')
    const s = w.latestOwn('A2')!.seq
    const forged = w.build('R1', 'device_revoke', { dk: 'A2', seen: s }, { actor: 'A' })
    expect(w.ref.receive({ ...forged, relay: 'L' })).toEqual({ s: 'R', why: 'dev' })
    w.ok('L1', 'leave')
    expect(w.act('L1', 'device_revoke', { dk: 'A2', seen: s }, { actor: 'A' }).v).toEqual({
      s: 'R',
      why: 'auth',
    })
    expect(w.act('R1', 'device_revoke', { dk: 'A2', seen: s }, { actor: 'A' }).v.s).toBe('A')
  })

  test('W5: the channel cap counts live channels; a channel that is gone makes room', () => {
    const w = base(0, false, { ...MODEL_LIMITS, channels: 2 })
    let ts = 100
    const ch = (c: Record<string, unknown>) =>
      w.act('O1', 'channel', { name: 'x', ...c }, { ts: (ts += 100) }).v.s
    expect(ch({ id: 'c1' })).toBe('A')
    expect(ch({ id: 'c2' })).toBe('R')
    expect(ch({ id: 'c0', gone: true })).toBe('A')
    expect(ch({ id: 'c2' })).toBe('A')
    expect(ch({ id: 'c1', name: 'renamed' })).toBe('A')
    expect(ch({ id: 'c0' })).toBe('R')
  })

  test('admission limits are fixed: the production ones frozen, a replica keeps the ones it was built with', () => {
    expect(Object.isFrozen(AGREED)).toBe(true)
    expect(new AclReplica().lim).toBe(AGREED)
    expect(new AclReplica({ agreed: MODEL_LIMITS }).lim.w3).toBe(MODEL_LIMITS.w3)
  })

  test("the remover's watermark: a kick, ban or revoke of another member covers every live device of the target; a leave covers the devices it lists", () => {
    const w = base(0, false)
    const MOD = role(w, 5, KICK | BAN | ROLES)
    const LO = role(w, 1, 0)
    join(w, 'M1')
    give(w, 'M', MOD)
    join(w, 'U1')
    w.ok('U2', 'device_add')
    give(w, 'U', LO)
    const u1 = aclMax(w, 'U1')
    const u2 = aclMax(w, 'U2')
    for (const [t, c] of [
      ['kick', { to: 'U' }],
      ['ban', { to: 'U' }],
      ['revoke', { to: 'U', role: LO }],
    ] as const) {
      expect(w.act('M1', t, { ...c, seen: {} }).v).toEqual({ s: 'R', why: 'seen' })
      expect(w.act('M1', t, { ...c, seen: { U1: u1 } }).v).toEqual({ s: 'R', why: 'seen' })
      expect(w.act('M1', t, { ...c, seen: { U1: u1, U2: u2 - 1 } }).v).toEqual({
        s: 'R',
        why: 'seen',
      })
    }
    expect(w.act('U1', 'leave', { seen: { U2: u2 - 1 } }).v).toEqual({ s: 'R', why: 'seen' })
    expect(w.act('U1', 'leave', {}).v.s).toBe('A')
  })

  test('an event whose device belongs to another identity is refused (dev)', () => {
    const w = base()
    join(w, 'U1')
    join(w, 'X1')
    expect(w.ref.receive({ ...w.build('X1', 'mark'), a: 'U' })).toEqual({ s: 'R', why: 'dev' })
  })

  test('a malformed known field (a genesis nonce of other than 16 bytes, a kick target) is refused with a strike; a second genesis is refused', () => {
    const r = new AclReplica({ binds: testBinds, agreed: MODEL_LIMITS })
    const g = {
      id: 'g',
      t: 'genesis',
      a: 'O',
      dev: 'O1',
      seq: 0,
      ap: [],
      ts: 0,
      c: { rules: 2, nonce: NONCE, owners: [{ ik: 'O' }], everyone_bits: 0, name: 'S' },
    }
    for (const nonce of [undefined, 'n', 'AAAAAAAAAAAAAAAAAAAAAAAA', 16])
      expect(
        new AclReplica({ binds: testBinds, agreed: MODEL_LIMITS }).receive({
          ...g,
          c: { ...g.c, nonce },
        } as never)
      ).toEqual({
        s: 'M',
        why: 'content',
      })
    expect(r.receive(g as never).s).toBe('A')
    expect(r.receive({ ...g, id: 'g2' } as never)).toEqual({ s: 'R', why: 'genesis' })
    const bad = {
      id: 'k',
      t: 'kick',
      a: 'O',
      dev: 'O1',
      seq: 1,
      ap: ['g'],
      aprev: 'g',
      ts: 1,
      c: { to: 5 },
    }
    expect(r.receive(bad as never)).toEqual({ s: 'M', why: 'content' })
  })

  test('a genesis of a rules version this client does not know earns no strike: the replica reports it and stores the server read-only', () => {
    const r = new AclReplica({ binds: testBinds, agreed: MODEL_LIMITS })
    const g = {
      id: 'g',
      t: 'genesis',
      a: 'O',
      dev: 'O1',
      seq: 0,
      ap: [],
      ts: 0,
      c: { rules: 3, nonce: 'n', owners: 'a newer format', name: 'S' },
    }
    expect(r.receive(g as never)).toEqual({ s: 'U', rules: 3 })
    const k = { id: 'k', t: 'kick', a: 'O', dev: 'O1', seq: 1, ap: ['g'], ts: 1, c: { to: 5 } }
    expect(r.receive(k as never)).toEqual({ s: 'U', rules: 3 })
    expect(r.order).toEqual([])
    const r2 = new AclReplica({ binds: testBinds, agreed: MODEL_LIMITS })
    expect(r2.receive({ ...g, c: { ...g.c, rules: 2.5 } } as never)).toEqual({
      s: 'M',
      why: 'content',
    })
  })

  test('content admission: channel content needs a channel `ch` that exists and lets the author send, in Discord order', () => {
    const w = base(0, false)
    const SPK = role(w, 3, 0)
    const MUTE = role(w, 2, 0)
    const CH = role(w, 4, CHANNELS)
    join(w, 'U1')
    join(w, 'X1')
    join(w, 'C1')
    give(w, 'U', SPK)
    give(w, 'C', CH)
    const send = (dev: string, c: Record<string, unknown>, t = 'msg') =>
      w.admitContent(w.content(dev, t, { body: 'x', ...c }))
    const no = (why: string) => ({ ok: false as const, why })
    let ts = 1000
    const own = (t: string, c: Record<string, unknown>) => {
      w.ok('O1', t, c, { ts: (ts += 100) })
      w.ok('Vch1', 'mark', {}, { ts: (ts += 100) })
    }
    // the known kinds need a string ch naming a live channel; other kinds are opaque
    expect(send('X1', { ch: undefined })).toEqual(no('channel'))
    expect(send('X1', { ch: 5 })).toEqual(no('channel'))
    expect(send('X1', { ch: 'nope' })).toEqual(no('channel'))
    expect(send('X1', { ch: undefined, target: 't' }, 'react')).toEqual(no('channel'))
    expect(send('X1', { ch: undefined }, 'x_newer').ok).toBe(true)
    own('channel', { id: 'c1', name: 'general' })
    expect(send('X1', { ch: 'c1' }).ok).toBe(true)
    // restrict_send: the channel's @everyone baseline lacks Send messages, even with an @everyone
    // allow; a role's or the member's allow gives it back, a member deny takes it again
    own('channel', { id: 'c1', name: 'announcements', restrict_send: true })
    own('chperm', { ch: 'c1', subj: `r:${EVERYONE}`, allow: P.SendMessages, deny: 0 })
    expect(send('X1', { ch: 'c1' })).toEqual(no('send'))
    own('chperm', { ch: 'c1', subj: `r:${SPK}`, allow: P.SendMessages, deny: 0 })
    expect(send('U1', { ch: 'c1' }).ok).toBe(true)
    own('chperm', { ch: 'c1', subj: 'u:X', allow: P.SendMessages, deny: 0 })
    expect(send('X1', { ch: 'c1' }).ok).toBe(true)
    own('chperm', { ch: 'c1', subj: 'u:U', allow: 0, deny: P.SendMessages })
    expect(send('U1', { ch: 'c1' })).toEqual(no('send'))
    expect(send('O1', { ch: 'c1' }).ok).toBe(true)
    expect(send('C1', { ch: 'c1' }).ok).toBe(true)
    // role denies come before role allows; an @everyone deny is lifted by a role allow
    own('channel', { id: 'c2', name: 'quiet' })
    own('chperm', { ch: 'c2', subj: `r:${EVERYONE}`, allow: 0, deny: P.SendMessages })
    expect(send('X1', { ch: 'c2' })).toEqual(no('send'))
    give(w, 'U', MUTE)
    own('chperm', { ch: 'c2', subj: `r:${MUTE}`, allow: 0, deny: P.SendMessages })
    own('chperm', { ch: 'c2', subj: `r:${SPK}`, allow: P.SendMessages, deny: 0 })
    expect(send('U1', { ch: 'c2' }).ok).toBe(true)
    // restrict_view: sending needs View channel too
    own('channel', { id: 'c3', name: 'staff', restrict_view: true })
    expect(send('X1', { ch: 'c3' })).toEqual(no('send'))
    own('chperm', { ch: 'c3', subj: `r:${SPK}`, allow: P.ViewChannel, deny: 0 })
    expect(send('U1', { ch: 'c3' }).ok).toBe(true)
    const F = w.state().facts
    expect([canView(F, 'X', 'c3'), canView(F, 'U', 'c3'), canView(F, 'O', 'c3')]).toEqual([
      false,
      true,
      true,
    ])
    // a channel that is gone takes no content
    own('channel', { id: 'c1', name: 'announcements', gone: true })
    expect(send('O1', { ch: 'c1' })).toEqual(no('channel'))
  })

  test('an event whose device the author has no certificate for is refused', () => {
    const r = new AclReplica({ binds: () => false, agreed: MODEL_LIMITS })
    const g = {
      id: 'g',
      t: 'genesis',
      a: 'O',
      dev: 'O1',
      seq: 0,
      ap: [],
      ts: 0,
      c: { rules: 2, nonce: NONCE, owners: [{ ik: 'O' }], everyone_bits: 0, name: 'S' },
    }
    expect(r.receive(g as never)).toEqual({ s: 'R', why: 'genesis' })
  })
})
