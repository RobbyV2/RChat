import { describe, expect, test } from 'bun:test'
import { AclReplica, pastOf } from '../p2p/acl/admit'
import type { ProofHeader } from '../p2p/acl/admit'
import { BAN, CHANNELS, EVERYONE, INVITE, KICK, MESSAGES, P, ROLES } from '../p2p/acl/rules'
import { AclWorld, devOwner, modelDiffAfterEach } from './p2p_acl_world'

// Implementation vectors of the P2P ACL spec (§7.6 "Impl"): content visibility (§3.5), content
// admission, history (§3.6), proofs (§2.3) and registers, which the reference model leaves out.
// The ACL part of every universe is still replayed through the model (except where it uses a
// type the model lacks).

modelDiffAfterEach()

function base(everyone = 0, model = true) {
  const w = new AclWorld({ model })
  w.genesis('O1', ['O'], everyone)
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

describe('display rules (§3.5)', () => {
  test("edits: only the author's, latest by (ts, id); reactions: latest per author and key", () => {
    const w = base()
    join(w, 'U1')
    join(w, 'X1')
    const t = w.content('U1')
    w.content('U1', 'edit', { target: t.id, body: 'one' })
    const e2 = w.content('U1', 'edit', { target: t.id, body: 'two' })
    w.content('X1', 'edit', { target: t.id, body: 'not mine' })
    w.content('X1', 'react', { target: t.id, key: '👍', on: true })
    w.content('U1', 'react', { target: t.id, key: '👍', on: true })
    w.content('U1', 'react', { target: t.id, key: '👍', on: false })
    const v = w.view()
    expect(v.editOf(t)?.id).toBe(e2.id)
    expect(v.reactions(t).map(r => r.a)).toEqual(['X'])
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
    w.ok('O1', 'settings', { name: 'Srv', history: 'invited' })
    F = w.state().facts
    expect(F.overwrites.get('c1')?.get(`r:${LO}`)?.deny).toBe(P.SendMessages)
    expect(F.setting?.history).toBe('invited')
    expect(w.act('O1', 'role_create', { pos: 1, bits: 1 << 20 }).v.s).toBe('A')
    expect(w.act('A1', 'x_newer', { anything: [1, 2] }).v.s).toBe('A')
  })

  test('a malformed known field is refused with a strike; a second genesis is refused', () => {
    const r = new AclReplica({ binds: e => devOwner(e.dev) === e.a })
    const g = {
      id: 'g',
      t: 'genesis',
      a: 'O',
      dev: 'O1',
      seq: 0,
      ap: [],
      ts: 0,
      c: { rules: 2, nonce: 'n', owners: [{ ik: 'O' }], everyone_bits: 0, name: 'S' },
    }
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
    expect(pastOf(r.acl.ix, ['g']).bits[0]).toBe(1)
    expect(EVERYONE).toBe('everyone')
  })

  test('content admission: the channel must exist and let the author send (overwrites, restrict_send)', () => {
    const w = base(0, false)
    const SPK = role(w, 3, 0)
    join(w, 'U1')
    join(w, 'X1')
    give(w, 'U', SPK)
    w.ok('O1', 'settings', { name: 'S' })
    const everyoneSend = w.act('O1', 'role_bits', { role: EVERYONE, bit: P.SendMessages, on: true })
    expect(everyoneSend.v.s).toBe('A')
    expect(w.admitContent(w.content('U1', 'msg', { body: 'x', ch: 'nope' }))).toEqual({
      ok: false,
      why: 'channel',
    })
    w.ok('O1', 'channel', { id: 'c1', name: 'general' })
    expect(w.admitContent(w.content('X1', 'msg', { body: 'x', ch: 'c1' })).ok).toBe(true)
    w.ok('O1', 'channel', { id: 'c1', name: 'announcements', restrict_send: true })
    expect(w.admitContent(w.content('X1', 'msg', { body: 'x', ch: 'c1' }))).toEqual({
      ok: false,
      why: 'send',
    })
    w.ok('O1', 'chperm', { ch: 'c1', subj: `r:${SPK}`, allow: P.SendMessages, deny: 0 })
    expect(w.admitContent(w.content('U1', 'msg', { body: 'x', ch: 'c1' })).ok).toBe(true)
    expect(w.admitContent(w.content('X1', 'msg', { body: 'x', ch: 'c1' })).ok).toBe(false)
    w.ok('O1', 'chperm', { ch: 'c1', subj: 'u:U', allow: 0, deny: P.SendMessages })
    expect(w.admitContent(w.content('U1', 'msg', { body: 'x', ch: 'c1' })).ok).toBe(false)
    expect(w.admitContent(w.content('O1', 'msg', { body: 'x', ch: 'c1' })).ok).toBe(true)
  })

  test('an event whose device the author has no certificate for is refused', () => {
    const r = new AclReplica({ binds: () => false })
    const g = {
      id: 'g',
      t: 'genesis',
      a: 'O',
      dev: 'O1',
      seq: 0,
      ap: [],
      ts: 0,
      c: { rules: 2, nonce: 'n', owners: [{ ik: 'O' }], everyone_bits: 0, name: 'S' },
    }
    expect(r.receive(g as never)).toEqual({ s: 'R', why: 'genesis' })
  })
})
