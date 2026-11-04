import { afterEach, describe, expect, test } from 'bun:test'
import { AclWorld, devOwner, diffProdWorld, TestReplica, toModel } from './p2p_acl_world'
import { AGREED } from '../p2p/limits'
import * as M from './acl_model/model'
import {
  bodies,
  deliver,
  general,
  joinWithCode,
  makeMember,
  pump,
  signed,
  stopAll,
  type Member,
} from './p2p_server_net'
import { Hub, ManualClock, prng } from './p2p_net'
import { CANT_TEXT, slowText } from '../p2p/flows'
import { slowWait } from '../slowmode'
import {
  BAN,
  canSend,
  canView,
  channelPerms,
  CHANNELS,
  EVERYONE,
  INVITE,
  KICK,
  MESSAGES,
  P,
  rank,
  ROLES,
  SEND,
  SERVER,
  VIEW,
} from '../p2p/acl/rules'
import { ContentView, type ContentEv } from '../p2p/acl/visibility'
import { evalSummary } from './p2p_acl_world'
import { ServerWorld } from './p2p_server_world'
import { applySummary, diffSummary, emptySummary, fromStored, toStored } from '../p2p/acl_room'

// Roles and moderation in P2P servers (Task 23) on the production ACL modules: the rank rules,
// races between moderation and role changes, channel registers, slow mode (spec 3.5) and the
// view gate (spec 3.7).

const world = () => {
  const w = new AclWorld({ model: false, agreed: AGREED })
  w.genesis('O1', ['O'])
  w.channel('O1')
  return w
}
const role = (w: AclWorld, pos: number, bits: number, by = 'O1') =>
  w.ok(by, 'role_create', { pos, bits }).id
const join = (w: AclWorld, dev: string, by = 'O1') => {
  w.ok(by, 'add', { to: devOwner(dev) })
  return w.ok(dev, 'join')
}
const give = (w: AclWorld, to: string, r: string, by = 'O1', o = {}) =>
  w.ok(by, 'assign', { to, role: r }, o)
const F = (w: AclWorld) => w.state().facts
const verdict = (w: AclWorld, dev: string, t: string, c: Record<string, unknown>) =>
  w.act(dev, t, c).v.s

describe('the rank rules (spec 1.4, 1.6)', () => {
  test('equal rank cannot kick; nobody grants above their own rank or bits, or edits their own top role', () => {
    const w = world()
    const MOD = role(w, 5, KICK | BAN | ROLES)
    const LOW = role(w, 2, KICK)
    for (const d of ['A1', 'B1', 'C1']) join(w, d)
    give(w, 'A', MOD)
    give(w, 'B', MOD)
    const rows: [string, string, string, Record<string, unknown>, 'A' | 'R'][] = [
      ['equal rank: A cannot kick B', 'A1', 'kick', { to: 'B' }, 'R'],
      ['equal rank: A cannot ban B', 'A1', 'ban', { to: 'B' }, 'R'],
      ['nobody kicks an owner', 'A1', 'kick', { to: 'O' }, 'R'],
      ['a role above A', 'A1', 'role_create', { pos: 6, bits: KICK }, 'R'],
      ['a bit A lacks', 'A1', 'role_create', { pos: 1, bits: SERVER }, 'R'],
      ['own top role: bits', 'A1', 'role_bits', { role: MOD, bit: INVITE, on: true }, 'R'],
      ['own top role: move', 'A1', 'role_move', { role: MOD, pos: 4 }, 'R'],
      ['own top role: delete', 'A1', 'role_del', { role: MOD }, 'R'],
      ['own top role: give it', 'A1', 'assign', { to: 'C', role: MOD }, 'R'],
      ['raise oneself', 'A1', 'assign', { to: 'A', role: LOW }, 'R'],
      ['a lower role: a bit A lacks', 'A1', 'role_bits', { role: LOW, bit: SERVER, on: true }, 'R'],
      ['a lower role: a bit A has', 'A1', 'role_bits', { role: LOW, bit: BAN, on: true }, 'A'],
      ['a lower role, moved, still below A', 'A1', 'role_move', { role: LOW, pos: 4 }, 'A'],
      ['a lower role moved up to A', 'A1', 'role_move', { role: LOW, pos: 5 }, 'R'],
      ['a lower role, given', 'A1', 'assign', { to: 'C', role: LOW }, 'A'],
      ['a new role below A with bits A has', 'A1', 'role_create', { pos: 3, bits: KICK }, 'A'],
      ['C holds a role below A: kick', 'A1', 'kick', { to: 'C' }, 'A'],
    ]
    const got = rows.map(([what, dev, t, c]) => [what, verdict(w, dev, t, c)])
    expect(got).toEqual(rows.map(([what, , , , want]) => [what, want]))
    // B (same top role as A) took no part; C is out, A and B stay.
    expect([...F(w).mem].sort()).toEqual(['A', 'B', 'O'])
    // Dropping one's own role is always allowed.
    expect(verdict(w, 'B1', 'revoke', { to: 'B', role: MOD })).toBe('A')
    expect(F(w).holds.get('B')?.has(MOD) ?? false).toBe(false)
  })
})

describe('dropping a role that holds its holders back in a channel (spec 1.4, 10.21)', () => {
  test('a muted member can’t drop the muting role; a member with Manage channels can, and anyone can once nothing is held back', () => {
    const w = world()
    const MUTED = role(w, 2, 0)
    const CHMOD = role(w, 4, CHANNELS)
    for (const d of ['A1', 'B1', 'C1']) join(w, d)
    give(w, 'A', MUTED)
    give(w, 'B', MUTED)
    give(w, 'B', CHMOD)
    give(w, 'C', MUTED)
    // #c0: the muted role may view, not send (the editor writes an unticked box as a deny).
    w.ok('O1', 'chperm', { ch: 'c0', subj: `r:${MUTED}`, allow: VIEW, deny: SEND })
    expect(verdict(w, 'A1', 'revoke', { to: 'A', role: MUTED })).toBe('R')
    expect(F(w).holds.get('A')?.has(MUTED)).toBe(true)
    expect(verdict(w, 'B1', 'revoke', { to: 'B', role: MUTED })).toBe('A')
    // Someone with Manage roles and no Manage channels can't take it from another either.
    const ROLER = role(w, 5, ROLES)
    give(w, 'C', ROLER)
    w.ok('O1', 'revoke', { to: 'C', role: ROLER })
    const HELP = role(w, 6, ROLES)
    join(w, 'D1')
    give(w, 'D', HELP)
    expect(verdict(w, 'D1', 'revoke', { to: 'A', role: MUTED })).toBe('R')
    // An allow short of view and send holds back too; an allow of both doesn't.
    w.ok('O1', 'chperm', { ch: 'c0', subj: `r:${MUTED}`, allow: VIEW, deny: 0 })
    expect(verdict(w, 'A1', 'revoke', { to: 'A', role: MUTED })).toBe('R')
    w.ok('O1', 'chperm', { ch: 'c0', subj: `r:${MUTED}`, allow: VIEW | SEND, deny: 0 })
    expect(verdict(w, 'A1', 'revoke', { to: 'A', role: MUTED })).toBe('A')
    // Deleting the role takes it from everyone: the same rule.
    w.ok('O1', 'chperm', { ch: 'c0', subj: `r:${MUTED}`, allow: 0, deny: SEND })
    expect(verdict(w, 'D1', 'role_del', { role: MUTED })).toBe('R')
    // A deleted channel's rows hold nobody back.
    w.ok('O1', 'channel', { id: 'c0', name: 'c0', gone: true })
    expect(verdict(w, 'C1', 'revoke', { to: 'C', role: MUTED })).toBe('A')
  })
})

describe('races between moderation and role changes (spec 3.1, 8.2)', () => {
  test("a ban racing the banned member's role change: the ban stands and the member's concurrent assign is cut", () => {
    const w = world()
    const MOD = role(w, 5, KICK | BAN)
    const HELP = role(w, 3, ROLES)
    const PERK = role(w, 1, 0)
    for (const d of ['M1', 'C1', 'D1']) join(w, d)
    give(w, 'M', MOD)
    give(w, 'C', HELP)
    const P0 = w.heads()
    const ban = w.ok('M1', 'ban', { to: 'C' })
    // C, not having seen the ban, changes D's roles and drops its own.
    const asg = w.ok('C1', 'assign', { to: 'D', role: PERK }, { ap: P0 })
    const drop = w.ok('C1', 'revoke', { to: 'C', role: HELP }, { ap: [asg.id] })
    const S = w.state()
    expect(S.eff.has(ban.id)).toBe(true)
    expect(F(w).ban.has('C')).toBe(true)
    expect(S.cut.has(asg.id)).toBe(true)
    expect(F(w).holds.get('D')?.has(PERK) ?? false).toBe(false)
    // Her own revoke didn't see the ban either: cut with the rest of what she did after it.
    expect(S.cut.has(drop.id)).toBe(true)
  })

  test('a moderator cannot remove someone who, at the same moment, was given a role above theirs', () => {
    const w = world()
    const MOD = role(w, 5, KICK | BAN)
    const HIGH = role(w, 7, 0)
    for (const d of ['M1', 'C1']) join(w, d)
    give(w, 'M', MOD)
    const P0 = w.heads()
    const up = give(w, 'C', HIGH, 'O1', { ap: P0 })
    const ban = w.ok('M1', 'ban', { to: 'C' }, { ap: P0 })
    const S = w.state()
    expect(S.eff.has(ban.id)).toBe(false)
    expect(F(w).mem.has('C')).toBe(true)
    expect(F(w).holds.get('C')?.has(HIGH)).toBe(true)
    expect(S.cut.has(up.id)).toBe(false)
  })

  test("a demoted admin's concurrent kick is voided", () => {
    const w = world()
    const ADMIN = role(w, 6, KICK | ROLES)
    for (const d of ['A1', 'B1']) join(w, d)
    give(w, 'A', ADMIN)
    const P0 = w.heads()
    w.ok('O1', 'revoke', { to: 'A', role: ADMIN })
    const kick = w.ok('A1', 'kick', { to: 'B' }, { ap: P0 })
    const S = w.state()
    expect(S.cut.has(kick.id)).toBe(true)
    expect(S.eff.has(kick.id)).toBe(false)
    expect(F(w).mem.has('B')).toBe(true)
    // Seen as a member again, A can't kick any more.
    expect(verdict(w, 'A1', 'kick', { to: 'B' })).toBe('R')
  })

  test('two forks renaming a channel resolve the same way in every delivery order', () => {
    const w = world()
    const CH = role(w, 4, CHANNELS)
    const CH2 = role(w, 2, CHANNELS)
    for (const d of ['A1', 'B1', 'C1']) join(w, d)
    give(w, 'A', CH)
    give(w, 'B', CH)
    give(w, 'C', CH2)
    const P0 = w.heads()
    // Equal rank: the lowest event id of the two wins; a junior's rename loses to both.
    const a = w.ok('A1', 'channel', { id: 'c0', name: 'alpha' }, { ap: P0 })
    const b = w.ok('B1', 'channel', { id: 'c0', name: 'beta' }, { ap: P0 })
    w.ok('C1', 'channel', { id: 'c0', name: 'gamma' }, { ap: P0 })
    const want = a.id < b.id ? 'alpha' : 'beta'
    expect(F(w).channels.get('c0')?.name).toBe(want)
    let s = 3
    for (let k = 0; k < 8; k++) {
      const order = [...w.all]
      for (let i = order.length - 1; i > 0; i--) {
        s = (s * 1103515245 + 12345) & 0x7fffffff
        const j = s % (i + 1)
        ;[order[i], order[j]] = [order[j], order[i]]
      }
      const r = new TestReplica(AGREED)
      for (const e of order) r.receive(e)
      expect(r.state().facts.channels.get('c0')?.name).toBe(want)
    }
    // A later rename that saw both wins.
    w.ok('C1', 'channel', { id: 'c0', name: 'delta' })
    expect(F(w).channels.get('c0')?.name).toBe('delta')
  })

  test('ownership transfer racing a kick by the old owner: the kick counts only in the old copy, which then freezes', () => {
    const w = new AclWorld({ model: false, agreed: AGREED })
    w.genesis('O1', ['O'])
    w.channel('O1')
    for (const d of ['R1', 'B1']) join(w, d)
    w.ok('O2', 'device_add')
    w.ok('R1', 'mark')
    const P0 = w.heads()
    // One of the owner's devices posts the upgrade, the other kicks B without having seen it.
    const up = w.ok('O1', 'upgrade', { g: { t: 'genesis' }, sigs: {} }, { ap: P0 })
    const kick = w.ok('O2', 'kick', { to: 'B' }, { ap: P0 })
    const S = w.state()
    expect(F(w).upgraded.length).toBe(1)
    expect(S.eff.has(kick.id)).toBe(true)
    expect(F(w).mem.has('B')).toBe(false)
    // The upgrade's own past (what the new copy carries over) still has B as a member.
    expect(w.ref.acl.stateOf([up.id]).facts.mem.has('B')).toBe(true)
    // Once an event sees the upgrade, nothing but leaving is taken.
    expect(verdict(w, 'O1', 'unban', { to: 'B' })).toBe('R')
    expect(verdict(w, 'R1', 'leave', { seen: {} })).toBe('A')
  })
})

describe('channel permissions (spec 1.4, Discord order)', () => {
  test('restrictions and overwrites: allow lists, read-only channels, and Manage channels sees all', () => {
    const w = world()
    const STAFF = role(w, 4, 0)
    const CHM = role(w, 3, CHANNELS)
    for (const d of ['A1', 'B1', 'C1', 'M1']) join(w, d)
    give(w, 'A', STAFF)
    give(w, 'M', CHM)
    w.ok('O1', 'channel', { id: 'staff', name: 'staff', restrict_view: true })
    w.ok('O1', 'channel', { id: 'news', name: 'news', restrict_send: true })
    w.ok('O1', 'chperm', { ch: 'staff', subj: `r:${STAFF}`, allow: VIEW | SEND, deny: 0 })
    w.ok('O1', 'chperm', { ch: 'staff', subj: 'u:B', allow: VIEW, deny: SEND })
    w.ok('O1', 'chperm', { ch: 'c0', subj: 'u:C', allow: 0, deny: SEND })
    const f = F(w)
    const row = (ik: string) =>
      ['c0', 'staff', 'news'].map(
        ch => `${canView(f, ik, ch) ? 'v' : '-'}${canSend(f, ik, ch) ? 's' : '-'}`
      )
    expect(row('A')).toEqual(['vs', 'vs', 'v-'])
    expect(row('B')).toEqual(['vs', 'v-', 'v-'])
    expect(row('C')).toEqual(['v-', '--', 'v-'])
    expect(row('M')).toEqual(['vs', 'vs', 'vs'])
    expect(row('O')).toEqual(['vs', 'vs', 'vs'])
    // A role allow lifts a member's own role deny, a member deny beats the role allow.
    w.ok('O1', 'chperm', { ch: 'c0', subj: `r:${STAFF}`, allow: SEND, deny: 0 })
    w.ok('O1', 'chperm', { ch: 'c0', subj: 'u:A', allow: 0, deny: SEND })
    expect(canSend(F(w), 'A', 'c0')).toBe(false)
    // An overwrite is written only by someone ranked above its subject.
    expect(verdict(w, 'M1', 'chperm', { ch: 'c0', subj: `r:${STAFF}`, allow: 0, deny: 0 })).toBe(
      'R'
    )
    expect(verdict(w, 'M1', 'chperm', { ch: 'c0', subj: 'u:C', allow: 0, deny: 0 })).toBe('A')
    expect(canSend(F(w), 'C', 'c0')).toBe(true)
    // Content in a channel the author may not send in is refused at admission.
    const m = w.content('C1', 'msg', { body: 'hi', ch: 'news' })
    expect(w.admitContent(m)).toEqual({ ok: false, why: 'send' })
    expect(channelPerms(F(w), 'O', 'news')).toBe(0x7fffffff)
  })

  test('the view gate serves a view-restricted channel only to members allowed to view it', () => {
    const w = world()
    const STAFF = role(w, 4, 0)
    for (const d of ['A1', 'C1']) join(w, d)
    give(w, 'A', STAFF)
    w.ok('O1', 'channel', { id: 'staff', name: 'staff', restrict_view: true })
    w.ok('O1', 'chperm', { ch: 'staff', subj: `r:${STAFF}`, allow: VIEW | SEND, deny: 0 })
    const f = F(w)
    expect(canView(f, 'A', 'staff')).toBe(true)
    expect(canView(f, 'C', 'staff')).toBe(false)
    expect(canView(f, 'C', 'c0')).toBe(true)
    expect(rank(f, 'A')[0]).toBe(4)
  })
})

describe('slow mode (spec 3.5, a display rule)', () => {
  const S = 1000
  test("a message inside its author's interval is hidden; owners and Manage messages are exempt", () => {
    const w = world()
    const MODR = role(w, 4, MESSAGES)
    for (const d of ['A1', 'B1', 'M1']) join(w, d)
    give(w, 'M', MODR)
    w.ok('O1', 'channel', { id: 'c0', name: 'c0', slow: 10 })
    const base = Math.max(...w.ref.order.map(id => w.ref.ev(id).ts)) + 1
    const at = (dev: string, dt: number, body: string) =>
      w.content(dev, 'msg', { body }, { ts: base + dt * S })
    const a1 = at('A1', 0, 'a1')
    const a2 = at('A1', 5, 'a2')
    const a3 = at('A1', 12, 'a3')
    const a4 = at('A1', 21, 'a4')
    const b1 = at('B1', 1, 'b1')
    const o1 = at('O1', 2, 'o1')
    const o2 = at('O1', 3, 'o2')
    const m1 = at('M1', 2, 'm1')
    const m2 = at('M1', 3, 'm2')
    for (const m of w.contents) expect(w.admitContent(m).ok).toBe(true)
    const v = w.view()
    const hidden = (m: { id: string }) => v.hidden(v.byIdOf(m.id)!)?.why ?? null
    // a2 is 5 s after a1; a3 is 7 s after a2 (held, though hidden), a4 is 9 s after a3.
    expect([a1, a2, a3, a4, b1, o1, o2, m1, m2].map(hidden)).toEqual([
      null,
      'slow',
      'slow',
      'slow',
      null,
      null,
      null,
      null,
      null,
    ])
    // The interval is the channel's at the message's position: once slow mode is off, new
    // messages show; the old ones stay as they were.
    w.ok('O1', 'channel', { id: 'c0', name: 'c0' })
    const a5 = w.content('A1', 'msg', { body: 'a5' }, { ts: base + 22 * S })
    const v2 = w.view()
    expect(v2.hidden(v2.byIdOf(a5.id)!)).toBeNull()
    expect(v2.hidden(v2.byIdOf(a2.id)!)?.why).toBe('slow')
  })

  test("a stolen device's hidden messages never hide its identity's own", () => {
    const w = world()
    join(w, 'A1')
    w.ok('A2', 'device_add')
    w.ok('O1', 'channel', { id: 'c0', name: 'c0', slow: 10 })
    const P = w.heads()
    const base = Math.max(...w.ref.order.map(id => w.ref.ev(id).ts)) + 1
    w.ok('A1', 'device_revoke', { dk: 'A2', seen: w.latestOwn('A2')!.seq })
    // The revoked copy posts just before A's real message.
    const thief = w.content('A2', 'msg', { body: 'spam' }, { ap: P, ts: base + 20 * S })
    const real = w.content('A1', 'msg', { body: 'hi' }, { ts: base + 25 * S })
    const v = w.view()
    expect(v.hidden(thief)?.why).toBe('revoked')
    expect(v.hidden(real)).toBeNull()
    // Our own countdown measures from the same message: a later stolen one doesn't lock us out.
    const later = w.content('A2', 'msg', { body: 'spam' }, { ap: P, ts: base + 40 * S })
    v.add(later)
    expect(v.lastIn('A', 'c0')).toBe(real.ts)
  })

  test('a message arriving late re-decides the next one; other channels and kinds are not counted', () => {
    const w = world()
    join(w, 'A1')
    w.ok('O1', 'channel', { id: 'c0', name: 'c0', slow: 10 })
    w.ok('O1', 'channel', { id: 'c1', name: 'c1', slow: 10 })
    const base = Math.max(...w.ref.order.map(id => w.ref.ev(id).ts)) + 1
    const first = w.content('A1', 'msg', { body: 'x', ch: 'c0' }, { ts: base })
    const other = w.content('A1', 'msg', { body: 'y', ch: 'c1' }, { ts: base + 2 * S })
    const react = w.content(
      'A1',
      'react',
      { target: first.id, key: '👍', on: true, ch: 'c0' },
      { ts: base + 3 * S }
    )
    const later = w.content('A1', 'msg', { body: 'z', ch: 'c0' }, { ts: base + 15 * S })
    const v = new ContentView(
      w.ref.acl,
      [first, other, react, later].filter(m => m !== first)
    )
    const shown = (m: { id: string }) => v.hidden(v.byIdOf(m.id)!) === null
    expect([other, later].map(shown)).toEqual([true, true])
    // A message 4 s before `later` arrives: `later` is inside its interval now.
    const mid = w.content('A1', 'msg', { body: 'w', ch: 'c0' }, { ts: base + 11 * S })
    v.add(first)
    expect(shown(later)).toBe(true)
    v.add(mid)
    expect([first, mid, later, other].map(shown)).toEqual([true, true, false, true])
  })

  test('an arrival re-decides the later messages up to the first that counts, past hidden ones', () => {
    const w = world()
    join(w, 'A1')
    w.ok('A2', 'device_add')
    w.ok('O1', 'channel', { id: 'c0', name: 'c0', slow: 10 })
    const P = w.heads()
    const base = Math.max(...w.ref.order.map(id => w.ref.ev(id).ts)) + 1
    w.ok('A1', 'device_revoke', { dk: 'A2', seen: w.latestOwn('A2')!.seq })
    const x = w.content('A1', 'msg', { body: 'x' }, { ts: base })
    const y = w.content('A2', 'msg', { body: 'stolen' }, { ap: P, ts: base + 12 * S })
    const z = w.content('A1', 'msg', { body: 'z' }, { ts: base + 15 * S })
    const v = new ContentView(w.ref.acl, [x, y, z])
    expect([v.hidden(y)?.why, v.hidden(z)]).toEqual(['revoked', null])
    // m lands between x and the hidden y: z, 7 s after it, is inside its interval now.
    const m = w.content('A1', 'msg', { body: 'm' }, { ts: base + 8 * S })
    v.add(m)
    expect(v.hidden(z)?.why).toBe('slow')
  })

  test("a fork of one device re-decides its identity's messages from its other devices", () => {
    const w = world()
    join(w, 'A1')
    w.ok('A2', 'device_add')
    w.ok('O1', 'channel', { id: 'c0', name: 'c0', slow: 10 })
    const base = Math.max(...w.ref.order.map(id => w.ref.ev(id).ts)) + 1
    const m1 = w.content('A1', 'msg', { body: 'one' }, { ts: base })
    const m2 = w.content('A2', 'msg', { body: 'two' }, { ts: base + 5 * S })
    const v = new ContentView(w.ref.acl, [m1, m2])
    expect(v.hidden(m2)?.why).toBe('slow')
    // A twin of m1 at its seq: A1 forked there, so m1 no longer counts as m2's previous message.
    const twin = w.content('A1', 'msg', { body: 'twin' }, { seq: m1.seq, ts: base + 1 })
    v.add(twin)
    expect(v.hidden(m1)?.why).toBe('fork')
    expect(v.hidden(m2)).toBeNull()
  })
})

describe('role_meta (spec 1.4, 1.5): a role keeps its name and color in a register', () => {
  const meta = (w: AclWorld, R: string) => F(w).roleMeta.get(R)?.name ?? null

  test('admitted by the generic rule; only Manage roles ranked above the role changes it', () => {
    const w = world()
    const MOD = role(w, 5, KICK | ROLES)
    const LOW = role(w, 2, 0)
    for (const d of ['A1', 'B1']) join(w, d)
    give(w, 'A', MOD)
    w.ok('O1', 'add', { to: 'C' })
    const rows: [string, string, Record<string, unknown>, string, string | null][] = [
      ['the owner', 'O1', { role: LOW, name: 'Helpers', color: 1 }, 'A', 'Helpers'],
      [
        'a moderator, on a role below theirs',
        'A1',
        { role: LOW, name: 'Crew', color: 2 },
        'A',
        'Crew',
      ],
      ['a moderator, on their own top role', 'A1', { role: MOD, name: 'Boss' }, 'A', null],
      ['a member without Manage roles', 'B1', { role: LOW, name: 'Mine' }, 'A', 'Crew'],
      ['a malformed name, no strike', 'A1', { role: LOW, name: 7 }, 'A', 'Crew'],
      ['@everyone', 'O1', { role: EVERYONE, name: 'All' }, 'A', null],
    ]
    for (const [what, dev, c, verdict, want] of rows) {
      expect([what, w.act(dev, 'role_meta', c).v.s]).toEqual([what, verdict])
      expect([what, meta(w, c.role as string)]).toEqual([what, want])
    }
    // Someone invited but not in yet: refused like any ACL event of a non-member.
    expect(w.act('C1', 'role_meta', { role: LOW, name: 'x' }).v.s).toBe('R')
    expect(F(w).roleMeta.get(LOW)?.color).toBe(2)
  })

  test('concurrent renames resolve by the register rule in every order; a demoted moderator’s is cut', () => {
    const w = world()
    const HIGH = role(w, 6, ROLES)
    const MID = role(w, 4, ROLES)
    const R = role(w, 2, 0)
    for (const d of ['A1', 'B1', 'C1', 'D1']) join(w, d)
    give(w, 'A', HIGH)
    give(w, 'C', HIGH)
    give(w, 'B', MID)
    give(w, 'D', MID)
    const P0 = w.heads()
    const a = w.ok('A1', 'role_meta', { role: R, name: 'alpha' }, { ap: P0 })
    w.ok('B1', 'role_meta', { role: R, name: 'beta' }, { ap: P0 })
    const c = w.ok('C1', 'role_meta', { role: R, name: 'gamma' }, { ap: P0 })
    // The more senior writers win; between equals, the lowest id.
    const want = a.id < c.id ? 'alpha' : 'gamma'
    expect(meta(w, R)).toBe(want)
    let s = 5
    for (let k = 0; k < 8; k++) {
      const order = [...w.all]
      for (let i = order.length - 1; i > 0; i--) {
        s = (s * 1103515245 + 12345) & 0x7fffffff
        const j = s % (i + 1)
        ;[order[i], order[j]] = [order[j], order[i]]
      }
      const r = new TestReplica(AGREED)
      for (const e of order) r.receive(e)
      expect(r.state().facts.roleMeta.get(R)?.name).toBe(want)
    }
    // A later write that saw them wins, junior or not.
    w.ok('B1', 'role_meta', { role: R, name: 'delta' })
    expect(meta(w, R)).toBe('delta')
    // D renames while the owner, concurrently, takes D's role: the rename doesn't count, though
    // it stays live (cuts are the generic rule's, §1.4).
    const P1 = w.heads()
    w.ok('O1', 'revoke', { to: 'D', role: MID })
    const d = w.ok('D1', 'role_meta', { role: R, name: 'epsilon' }, { ap: P1 })
    expect(w.state().cut.has(d.id)).toBe(false)
    expect(meta(w, R)).toBe('delta')
    // Given the role back, D renames while the owner moves it below R: it doesn't count either.
    const P2 = w.heads()
    give(w, 'D', MID)
    const e = w.ok('D1', 'role_meta', { role: R, name: 'zeta' })
    w.ok(
      'O1',
      'role_move',
      { role: MID, pos: 1 },
      { ap: P2.concat(w.heads().filter(h => h !== e.id)) }
    )
    expect(meta(w, R)).toBe('delta')
    // Once MID is above R again, D's next rename counts.
    w.ok('O1', 'role_move', { role: MID, pos: 4 })
    w.ok('D1', 'role_meta', { role: R, name: 'eta' })
    expect(meta(w, R)).toBe('eta')
  })

  // The re-review's reproductions: a role_meta whose liveness differed from an older client's
  // changed sticky code death, so the two admitted different `add`s. Both ways: production and
  // the reference model (an older client) agree on every verdict, record and state.
  const deathWorld = (variant: 'demoted' | 'unauthorized') => {
    const w = new AclWorld({ model: false })
    w.genesis('O1', ['O'])
    const INV = role(w, 2, INVITE)
    const HX = role(w, 6, ROLES)
    const LOW = role(w, 1, 0)
    for (const d of ['I1', 'X1', 'Y1']) join(w, d)
    give(w, 'I', INV)
    give(w, 'X', HX)
    const c = w.ok('I1', 'code', { h: 'h1' })
    w.ok('Y1', 'mark')
    const P0 = w.heads()
    // X takes I's Invite while the owner, concurrently, takes X's Manage roles: X's revoke is cut.
    const v = w.ok('X1', 'revoke', { to: 'I', role: INV }, { ap: P0 })
    if (variant === 'demoted') w.ok('X1', 'role_meta', { role: LOW, name: 'x' })
    w.ok('O1', 'revoke', { to: 'X', role: HX }, { ap: P0 })
    // A plain member writes over v, not having seen what the owner does next: it kicks Y.
    if (variant === 'unauthorized') {
      const y = w.ok('Y1', 'role_meta', { role: LOW, name: 'y' }, { ap: [v.id] })
      w.ok('O1', 'kick', { to: 'Y' }, { ap: P0.concat(w.heads().filter(h => h !== y.id)) })
    }
    const add = w.act('I1', 'add', { to: 'Z', code: c.id })
    return { w, add, c }
  }
  for (const variant of ['demoted', 'unauthorized'] as const)
    test(`role_meta is live exactly as an unknown type is: sticky code death agrees with an older client (${variant})`, () => {
      const { w, add } = deathWorld(variant)
      expect(diffProdWorld(w)).toEqual([])
      // A live write over v keeps the code dead; a cut one (Y kicked) doesn't.
      expect(add.v.s).toBe(variant === 'demoted' ? 'R' : 'A')
    })

  test('a client that does not know role_meta admits it with no effect and no strike', () => {
    const w = new AclWorld({ model: false })
    w.genesis('O1', ['O'])
    const R = role(w, 2, ROLES)
    const LOW = role(w, 1, 0)
    join(w, 'A1')
    give(w, 'A', R)
    const P0 = w.heads()
    const metas = [
      w.ok('O1', 'role_meta', { role: LOW, name: 'Crew', color: 3 }, { ap: P0 }),
      w.ok('A1', 'role_meta', { role: LOW, name: 'Team' }, { ap: P0 }),
      w.ok('A1', 'role_meta', { role: R, name: 7 }),
    ]
    w.ok('O1', 'kick', { to: 'A' })
    // The reference model, which has no role_meta (an older client), reads them as unknown.
    const mr = new M.Replica()
    for (const e of w.all) mr.receive(toModel(e))
    expect(metas.map(e => mr.status.get(e.id)?.s)).toEqual(['A', 'A', 'A'])
    expect(diffProdWorld(w)).toEqual([])
    // Here: the owner's write is the senior one.
    expect(F(w).roleMeta.get(LOW)?.name).toBe('Crew')
  })
})

describe('the fuzz of Task 22 with role, channel and overwrite events', () => {
  // Random universes: members, roles and their moves, bits and holders, kicks, bans, channel
  // registers (names, restrictions, slow mode), overwrites and messages, a third of them signed at
  // an older position (concurrent). Every delivery order must give the same state, the same
  // channel permissions for everyone and the same visibility for every message.
  const SEEDS = 300
  const people = ['A', 'B', 'C', 'D']
  const devs = ['O1', 'A1', 'B1', 'C1', 'D1']
  const chans = ['c0', 'c1']
  const picture = (r: TestReplica, contents: ContentEv[]) => {
    const st = r.state()
    const f = st.facts
    const v = new ContentView(r.acl, contents)
    return JSON.stringify({
      ev: evalSummary(st),
      channels: chans.map(ch => f.channels.get(ch) ?? null),
      over: chans.map(ch => [...(f.overwrites.get(ch) ?? new Map())].sort()),
      meta: [...f.roleMeta].sort(),
      perms: ['O', ...people].map(ik => chans.map(ch => channelPerms(f, ik, ch))),
      vis: contents.map(m => [m.id, v.hidden(m)?.why ?? null]).sort(),
    })
  }
  const universe = (seed: number) => {
    const rnd = prng(seed)
    const pick = <T>(xs: readonly T[]) => xs[Math.floor(rnd() * xs.length)]
    const w = world()
    w.ok('O1', 'channel', { id: 'c0', name: 'c0', slow: 10 })
    w.ok('O1', 'channel', { id: 'c1', name: 'c1' })
    for (const p of people) join(w, `${p}1`)
    const MOD = role(w, 6, P.Kick | P.Ban | P.ManageRoles | P.ManageChannels | P.ManageMessages)
    const HELP = role(w, 3, P.Kick | P.ManageChannels | P.ManageRoles)
    give(w, 'A', MOD)
    give(w, 'B', MOD)
    give(w, 'C', HELP)
    const roles: string[] = [MOD, HELP]
    const snaps: string[][] = [w.heads()]
    let ts = Math.max(...w.ref.order.map(id => w.ref.ev(id).ts)) + 1
    for (let n = 0; n < 60; n++) {
      const dev = pick(devs)
      const ap = rnd() < 0.35 ? pick(snaps) : undefined
      const to = pick(people)
      const role = () => pick(roles)
      const r = rnd()
      ts += Math.floor(rnd() * 6_000)
      const o = { ap, ts }
      if (r < 0.12) {
        const bits = pick([P.Kick, P.Ban, P.ManageRoles, P.ManageChannels, P.ManageMessages, 0])
        const x = w.act(
          dev,
          'role_create',
          { pos: Math.floor(rnd() * 8), bits: bits | (rnd() < 0.3 ? P.ManageRoles : 0) },
          o
        )
        if (x.v.s === 'A') roles.push(x.e.id)
      } else if (r < 0.24 && roles.length) w.act(dev, 'assign', { to, role: role() }, o)
      else if (r < 0.3 && roles.length) w.act(dev, 'revoke', { to, role: role() }, o)
      else if (r < 0.36 && roles.length)
        w.act(dev, 'role_move', { role: role(), pos: Math.floor(rnd() * 8) }, o)
      else if (r < 0.42 && roles.length)
        w.act(
          dev,
          'role_bits',
          {
            role: pick([...roles, EVERYONE]),
            bit: pick([P.Kick, P.SendMessages, P.ViewChannel, P.ManageChannels]),
            on: rnd() < 0.5,
          },
          o
        )
      else if (r < 0.45 && roles.length) w.act(dev, 'role_del', { role: role() }, o)
      else if (r < 0.5 && roles.length)
        w.act(dev, 'role_meta', { role: role(), name: pick(['a', 'b', 'c']), color: n }, o)
      else if (r < 0.53) w.act(dev, 'kick', { to }, o)
      else if (r < 0.55) w.act(dev, 'ban', { to }, o)
      else if (r < 0.58) w.act(dev, 'unban', { to }, o)
      else if (r < 0.66)
        w.act(
          dev,
          'channel',
          {
            id: pick(chans),
            name: pick(['x', 'y', 'z']),
            ...(rnd() < 0.3 ? { restrict_view: true } : {}),
            ...(rnd() < 0.3 ? { restrict_send: true } : {}),
            ...(rnd() < 0.5 ? { slow: pick([5, 10, 30]) } : {}),
          },
          o
        )
      else if (r < 0.74)
        w.act(
          dev,
          'chperm',
          {
            ch: pick(chans),
            subj: roles.length && rnd() < 0.5 ? `r:${role()}` : `u:${to}`,
            allow: pick([0, VIEW, SEND, VIEW | SEND]),
            deny: pick([0, VIEW, SEND]),
          },
          o
        )
      else {
        const m = w.content(dev, 'msg', { body: `m${n}`, ch: pick(chans) }, { ap, ts })
        if (!w.admitContent(m).ok) w.contents.pop()
      }
      if (rnd() < 0.3) snaps.push(w.heads())
    }
    return w
  }

  test(`${SEEDS} universes converge in every delivery order`, () => {
    const fails: string[] = []
    let hidden = 0
    let slow = 0
    let refused = 0
    let metas = 0
    for (let seed = 1; seed <= SEEDS && fails.length < 3; seed++) {
      const w = universe(seed)
      const want = picture(w.ref, w.contents)
      const vis = (JSON.parse(want).vis as [string, string | null][]).map(([, why]) => why)
      hidden += vis.filter(x => x !== null).length
      slow += vis.filter(x => x === 'slow').length
      refused += w.all.filter(e => w.ref.status.get(e.id)?.s === 'R').length
      metas += w.state().facts.roleMeta.size
      let s = seed
      for (let k = 0; k < 3; k++) {
        const order = [...w.all]
        for (let i = order.length - 1; i > 0; i--) {
          s = (s * 1103515245 + 12345) & 0x7fffffff
          const j = s % (i + 1)
          ;[order[i], order[j]] = [order[j], order[i]]
        }
        const r = new TestReplica(AGREED)
        for (const e of order) r.receive(e)
        const held = [...w.contents].sort((x, y) => (x.id < y.id === (k % 2 === 0) ? -1 : 1))
        const got = picture(r, held)
        if (got !== want) fails.push(`seed ${seed} order ${k}`)
        // The same messages arriving one by one into a live view, with queries in between.
        const live = new ContentView(r.acl, [])
        for (const [i, m] of held.entries()) {
          live.add(m)
          if (i % 3 === 0) for (const x of held.slice(0, i + 1)) live.hidden(x)
        }
        const fresh = new ContentView(r.acl, held)
        for (const m of held)
          if ((live.hidden(m)?.why ?? null) !== (fresh.hidden(m)?.why ?? null)) {
            fails.push(`seed ${seed} order ${k}: ${m.id} live ${live.hidden(m)?.why}`)
            break
          }
      }
    }
    expect(fails).toEqual([])
    if (process.env.REACH) console.log({ refused, hidden, slow, metas })
    // The universes reach what they test: refusals, hidden messages, slow mode among them.
    expect(refused).toBeGreaterThan(SEEDS)
    expect(hidden).toBeGreaterThan(SEEDS / 4)
    expect(slow).toBeGreaterThan(10)
    expect(metas).toBeGreaterThan(SEEDS / 2)
  }, 600_000)
})

describe('a channel that becomes viewable', () => {
  test('its history arrives as nothing new: no pings, unread or alerts for it', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const a = await makeMember(hub, 'Alice', clock)
    const b = await makeMember(hub, 'Bob', clock)
    const room = await a.servers.create('Later')
    await joinWithCode(clock, a, room, b)
    const mods = await a.servers.addChannel(room, 'mods', { restrictView: true })
    await pump(clock, () => b.servers.sumOf(room).channels[mods] !== undefined, 'bob has it')
    await a.servers.send(room, { ch: mods, body: '@Bob before you could see this' })
    const arrivals: string[] = []
    b.servers.onArrive(x =>
      arrivals.push(String(x.rec.wire.c && (x.rec.wire.c as { body?: string }).body))
    )
    await a.servers.setOverwrite(room, mods, `u:${b.node.ik}`, P.ViewChannel | P.SendMessages, 0)
    await pump(clock, async () => (await bodies(b, room, mods)).length === 1, 'bob gets history')
    await clock.advance(1_000)
    expect(arrivals).toEqual([])
    const c = b.servers.view(room)!.chans[mods] ?? { unread: 0, pings: 0 }
    expect([c.unread, c.pings]).toEqual([0, 0])
    // What comes after counts.
    await a.servers.send(room, { ch: mods, body: '@Bob now' })
    await pump(clock, () => arrivals.length === 1, 'the new one alerts')
    expect(b.servers.view(room)!.chans[mods]?.pings).toBe(1)
  }, 60_000)
})

describe('the summary is safe from keys a member picks', () => {
  test('a channel, an overwrite or a ban keyed __proto__ or constructor pollutes no prototype', () => {
    const w = ServerWorld.create('O')
    w.channel('O')
    for (const id of ['__proto__', 'constructor'])
      expect(w.post('O', 'channel', { id, name: 'x', kind: 'text', pos: 9 }).out.s).toBe('A')
    expect(
      w.post('O', 'chperm', { ch: '__proto__', subj: 'u:polluted', allow: 1, deny: 0 }).out.s
    ).toBe('A')
    expect(
      w.post('O', 'chperm', { ch: 'constructor', subj: 'u:viaCtor', allow: 1, deny: 0 }).out.s
    ).toBe('A')
    expect(w.post('O', 'ban', { to: '__proto__', seen: {} }).out.s).toBe('A')
    const sum = w.room.summary()
    expect(({} as Record<string, unknown>)['u:polluted']).toBeUndefined()
    expect((Object as unknown as Record<string, unknown>)['u:viaCtor']).toBeUndefined()
    expect(Object.getPrototypeOf(sum.channels)).toBeNull()
    expect(Object.keys(sum.channels)).toContain('__proto__')
    expect(sum.overwrites['__proto__']?.['u:polluted']).toEqual({ allow: 1, deny: 0 })
    expect(sum.overwrites['constructor']?.['u:viaCtor']).toEqual({ allow: 1, deny: 0 })
    expect(sum.members['__proto__']?.m).toBe('ban')
    // The page's copy, through a delta, keeps those entries as plain keys.
    const page = applySummary(emptySummary(), diffSummary(emptySummary(), sum))
    expect(page.overwrites['__proto__']?.['u:polluted']).toEqual({ allow: 1, deny: 0 })
    expect(page.members['__proto__']?.m).toBe('ban')
    expect(Object.keys(page.channels).sort()).toEqual(Object.keys(sum.channels).sort())
    expect(({} as Record<string, unknown>)['u:polluted']).toBeUndefined()
    // A delta to a state without them deletes them, against a stored (plain) copy too.
    expect(Object.getPrototypeOf(emptySummary().channels)).toBeNull()
    for (const to of [emptySummary(), fromStored(toStored(emptySummary()))]) {
      const gone = diffSummary(sum, to)
      expect(gone?.del?.channels).toContain('__proto__')
      expect(gone?.del?.channels).toContain('constructor')
      expect(gone?.del?.members).toContain('__proto__')
      expect(gone?.del?.overwrites).toContain('__proto__')
      expect(gone?.del?.overwrites).toContain('constructor')
    }
  })
})

// ----- On real members over the in-memory hub -----

afterEach(stopAll)

const failure = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e: Error) => e.message
  )

const three = async (name: string) => {
  const clock = new ManualClock()
  const hub = new Hub()
  const a = await makeMember(hub, 'Alice', clock)
  const b = await makeMember(hub, 'Bob', clock)
  const c = await makeMember(hub, 'Carol', clock)
  const room = await a.servers.create(name)
  await joinWithCode(clock, a, room, b)
  await joinWithCode(clock, a, room, c)
  return { clock, hub, a, b, c, room }
}

const chOf = (m: Member, room: string, name: string) =>
  m.servers.view(room)?.channels.find(x => x.name === name)

describe('roles in the app (server.ts)', () => {
  test('the owner makes Bob a moderator; Bob kicks Carol, not the owner; the views say who may do what', async () => {
    const { clock, a, b, c, room } = await three('Mods')
    const mod = await a.servers.createRole(room, {
      name: 'Moderator',
      color: 0x2e7d32,
      bits: P.Kick,
    })
    await a.servers.assignRole(room, b.node.ik, mod)
    await pump(clock, () => ((b.servers.view(room)?.perms ?? 0) & P.Kick) !== 0, 'bob may kick')
    const vb = b.servers.view(room)!
    expect(vb.roles.map(r => [r.name, r.color, r.holders, r.below])).toEqual([
      ['Moderator', 0x2e7d32, 1, false],
    ])
    const at = (ik: string) => vb.members.find(m => m.ik === ik)!
    expect([at(b.node.ik).top, at(b.node.ik).roles]).toEqual([mod, [mod]])
    expect(at(a.node.ik).below).toBe(false)
    expect(at(c.node.ik).below).toBe(true)
    // Bob can't edit his own top role, nor kick the owner.
    expect(await failure(b.servers.setRoleBit(room, mod, P.Ban, true))).not.toBe('ok')
    expect(await failure(b.servers.kick(room, a.node.ik))).not.toBe('ok')
    await b.servers.kick(room, c.node.ik)
    await pump(clock, () => a.servers.sumOf(room).members[c.node.ik]?.m === 'leave', 'carol out')
    // A second role below it: Bob, now with Manage roles, may give it but not the first.
    await a.servers.setRoleBit(room, mod, P.ManageRoles, true)
    const vip = await a.servers.createRole(room, { name: 'VIP', color: null, bits: 0 })
    await pump(clock, () => b.servers.view(room)?.roles.length === 2, 'bob sees both roles')
    const roles = b.servers.view(room)!.roles
    expect(roles.map(r => [r.name, r.below])).toEqual([
      ['Moderator', false],
      ['VIP', true],
    ])
    expect(roles[0].pos).toBeGreaterThan(roles[1].pos)
    expect(roles[1].id).toBe(vip)
    // The owner takes the role from Bob (a removal: it carries Bob's watermark).
    await a.servers.revokeRole(room, b.node.ik, mod)
    await pump(clock, () => ((b.servers.view(room)?.perms ?? 0) & P.Kick) === 0, 'bob demoted')
    expect(b.servers.view(room)!.members.find(m => m.ik === b.node.ik)!.top).toBeNull()
    // Bob, without the role now, may give none.
    expect(b.servers.view(room)!.roles.find(r => r.id === vip)?.below).toBe(false)
  }, 120_000)

  test('a role is renamed and recolored; someone who may not change it is told so', async () => {
    const { clock, a, b, room } = await three('Names')
    const r = await a.servers.createRole(room, { name: 'Crew', color: 0x112233, bits: 0 })
    await a.servers.assignRole(room, b.node.ik, r)
    await a.servers.editRole(room, r, { name: 'Staff', color: 0x445566 })
    await pump(clock, () => b.servers.view(room)?.roles[0]?.name === 'Staff', 'bob sees the name')
    expect(b.servers.view(room)!.roles[0].color).toBe(0x445566)
    expect(await failure(b.servers.editRole(room, r, { name: 'Mine', color: null }))).toBe(
      CANT_TEXT
    )
    // A rename keeps the color it is given; the role keeps its holders and position.
    await a.servers.editRole(room, r, { name: 'Team', color: 0x445566 })
    await pump(clock, () => b.servers.view(room)?.roles[0]?.name === 'Team', 'renamed again')
    expect(b.servers.view(room)!.roles.map(x => [x.color, x.holders])).toEqual([[0x445566, 1]])
  }, 120_000)

  test('a moved role changes the order; a deleted role is gone from its holders', async () => {
    const { clock, a, b, room } = await three('Order')
    const low = await a.servers.createRole(room, { name: 'Low', color: null, bits: 0 })
    const high = await a.servers.createRole(room, { name: 'High', color: null, bits: 0 })
    // New roles go to the bottom.
    expect(a.servers.view(room)!.roles.map(r => r.name)).toEqual(['Low', 'High'])
    await a.servers.moveRole(room, high, a.servers.view(room)!.roles[0].pos + 10)
    expect(a.servers.view(room)!.roles.map(r => r.name)).toEqual(['High', 'Low'])
    await a.servers.assignRole(room, b.node.ik, low)
    await a.servers.assignRole(room, b.node.ik, high)
    await pump(
      clock,
      () => b.servers.view(room)?.members.find(m => m.ik === b.node.ik)?.top === high,
      'top is high'
    )
    await a.servers.deleteRole(room, high)
    await pump(clock, () => b.servers.view(room)?.roles.length === 1, 'one role left')
    expect(b.servers.view(room)!.members.find(m => m.ik === b.node.ik)!.roles).toEqual([low])
  }, 120_000)
})

describe('restricted channels (spec 1.4, 3.7)', () => {
  test('a view-restricted channel is served only to members allowed to view it, and absent for others', async () => {
    const { clock, a, b, c, room } = await three('Staff')
    const staff = await a.servers.createRole(room, { name: 'Staff', color: null, bits: 0 })
    await a.servers.assignRole(room, b.node.ik, staff)
    const ch = await a.servers.addChannel(room, 'staff')
    await a.servers.editChannel(room, ch, { restrict_view: true })
    await a.servers.setOverwrite(room, ch, `r:${staff}`, P.ViewChannel | P.SendMessages, 0)
    await pump(clock, () => !!chOf(b, room, 'staff'), 'bob sees staff')
    await pump(
      clock,
      () => c.servers.sumOf(room).channels[ch]?.restrict_view === true,
      'carol has the state'
    )
    expect(chOf(c, room, 'staff')).toBeUndefined()
    expect(chOf(a, room, 'staff')?.over).toEqual({
      [`r:${staff}`]: { allow: P.ViewChannel | P.SendMessages, deny: 0 },
    })
    const secret = await a.servers.send(room, { ch, body: 'staff only' })
    const open = await a.servers.send(room, { ch: general(a, room), body: 'for all' })
    await pump(clock, async () => !!(await b.store.event(secret)), 'bob holds it')
    await pump(clock, async () => !!(await c.store.event(open)), 'carol holds the open one')
    for (let i = 0; i < 5; i++) await clock.advance(5_000)
    expect(await c.store.event(secret)).toBeUndefined()
    expect(await bodies(b, room, ch)).toEqual(['staff only'])
    expect((await c.servers.loadChannel(room, ch)).messages).toEqual([])
    // Carol is let in by a member overwrite: the channel shows and its messages arrive.
    await a.servers.setOverwrite(room, ch, `u:${c.node.ik}`, P.ViewChannel, 0)
    await pump(clock, () => !!chOf(c, room, 'staff'), 'carol sees staff')
    expect(chOf(c, room, 'staff')?.send).toBe(true)
    await pump(
      clock,
      async () => (await bodies(c, room, ch)).length > 0,
      'carol has it',
      5_000,
      60_000
    )
    expect(await bodies(c, room, ch)).toEqual(['staff only'])
  }, 120_000)

  test('a read-only channel: the composer state follows the channel, and a send is refused', async () => {
    const { clock, a, c, room } = await three('News')
    const ch = general(a, room)
    await a.servers.editChannel(room, ch, { restrict_send: true })
    await pump(clock, () => chOf(c, room, 'general')?.send === false, 'carol may not send')
    expect(chOf(a, room, 'general')?.send).toBe(true)
    expect(await failure(c.servers.send(room, { ch, body: 'hi' }))).not.toBe('ok')
    await a.servers.editChannel(room, ch, { restrict_send: false })
    await pump(clock, () => chOf(c, room, 'general')?.send === true, 'carol may send again')
    await c.servers.send(room, { ch, body: 'hi' })
  }, 120_000)
})

describe('transfer (spec 3.8)', () => {
  test('a restricted channel keeps its allow list in the new copy, mapped to the new roles', async () => {
    const { clock, a, b, c, room } = await three('Moved')
    const staff = await a.servers.createRole(room, { name: 'Staff', color: null, bits: 0 })
    await a.servers.assignRole(room, c.node.ik, staff)
    const ch = await a.servers.addChannel(room, 'staff')
    await a.servers.editChannel(room, ch, { restrict_view: true, slow: 60 })
    await a.servers.setOverwrite(room, ch, `r:${staff}`, P.ViewChannel | P.SendMessages, 0)
    await pump(clock, () => !!chOf(c, room, 'staff'), 'carol sees staff')
    const t = failure(a.servers.transfer(room, b.node.ik))
    await pump(clock, () => b.servers.transferAsks().length === 1, 'bob asked', 1_000)
    void b.servers.answerTransfer(b.servers.transferAsks()[0].key, true)
    expect(await t).toBe('ok')
    await pump(clock, () => !!c.servers.view(room)?.next, 'carol follows', 1_000)
    const next = c.servers.view(room)!.next!
    for (const m of [a, c])
      await pump(
        clock,
        () => m.servers.myMembership(next) === 'join',
        `${m.name} in`,
        5_000,
        90_000
      )
    await pump(clock, () => b.servers.view(next)?.carry === null, 'carried over', 5_000, 90_000)
    await pump(
      clock,
      () => !!chOf(c, next, 'staff'),
      'carol sees staff in the new copy',
      5_000,
      60_000
    )
    const moved = chOf(b, next, 'staff')!
    expect(moved.restrict_view).toBe(true)
    expect(moved.slow).toBe(60)
    const [subj] = Object.keys(moved.over)
    expect(subj).not.toBe(`r:${staff}`)
    expect(b.servers.view(next)!.roles.map(r => `r:${r.id}`)).toEqual([subj])
    expect(chOf(a, next, 'staff')).toBeUndefined()
  }, 240_000)
})

describe('slow mode (spec 3.5)', () => {
  test('our client refuses a message inside the interval; one signed anyway is hidden everywhere', async () => {
    const { clock, a, b, c, room } = await three('Slow')
    const ch = general(a, room)
    await a.servers.editChannel(room, ch, { slow: 30 })
    await pump(clock, () => chOf(b, room, 'general')?.slow === 30, 'bob has slow mode')
    expect(chOf(b, room, 'general')?.exempt).toBe(false)
    expect(chOf(a, room, 'general')?.exempt).toBe(true)
    await b.servers.send(room, { ch, body: 'one' })
    const left = await b.servers.slowLeft(room, ch)
    expect(left).toBeGreaterThan(29_000)
    const why = await failure(b.servers.send(room, { ch, body: 'two' }))
    expect(why).toBe(slowText(left))
    expect(slowWait(why)).toBe(30)
    // The owner is exempt.
    await a.servers.send(room, { ch, body: 'a1' })
    await a.servers.send(room, { ch, body: 'a2' })
    expect(await a.servers.slowLeft(room, ch)).toBe(0)
    // A message Carol's device signs inside her interval anyway shows nowhere.
    const c1 = await c.servers.send(room, { ch, body: 'c1' })
    const t1 = ((await c.store.event(c1))!.wire.ev as unknown as { ts: number }).ts
    const forced = await signed(c, room, 'msg', { ch, body: 'forced' }, { ts: t1 + 1_000 })
    await pump(clock, async () => (await bodies(a, room, ch)).includes('c1'), 'alice has c1')
    expect(await deliver(a, room, forced.wire, clock.now())).toBe('new')
    await clock.advance(31_000)
    expect(await b.servers.slowLeft(room, ch)).toBe(0)
    await b.servers.send(room, { ch, body: 'three' })
    await pump(clock, async () => (await bodies(a, room, ch)).includes('three'), 'alice has three')
    expect((await bodies(a, room, ch)).sort()).toEqual(['a1', 'a2', 'c1', 'one', 'three'])
    // Carol, its author, sees a line saying why it's gone; nobody else does.
    await pump(clock, async () => !!(await c.store.event(forced.id)), 'carol holds it')
    const at = async (m: Member) =>
      (await m.servers.loadChannel(room, ch, { limit: 100 })).messages.filter(x => x.slowHidden)
    expect((await at(c)).map(x => x.id)).toEqual([forced.id])
    expect(await at(a)).toEqual([])
  }, 120_000)
})
