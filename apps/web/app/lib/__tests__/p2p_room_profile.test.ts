import { describe, expect, test } from 'bun:test'
import { AclWorld, devOwner, TestReplica } from './p2p_acl_world'
import { AGREED } from '../p2p/limits'
import { KICK, RULES_NEXT, RULES_VERSION, SERVER } from '../p2p/acl/rules'
import { applySummary, diffSummary, emptySummary } from '../p2p/acl/summary'
import { cleanName } from '../p2p/keys'
import {
  PROFILE_FIELDS,
  recentWrites,
  roomExtras,
  roomMode,
  roomProfile,
  sameExtras,
  writeFits,
} from '../profile_fields'

const world = () => {
  const w = new AclWorld({ model: false, agreed: AGREED })
  w.genesis('O1', ['O'])
  w.channel('O1')
  return w
}
const role = (w: AclWorld, pos: number, bits: number) => w.ok('O1', 'role_create', { pos, bits }).id
const join = (w: AclWorld, dev: string) => {
  w.ok('O1', 'add', { to: devOwner(dev) })
  return w.ok(dev, 'join')
}
const F = (w: AclWorld) => w.state().facts
const extrasOf = (w: AclWorld, who: string) => roomExtras(F(w).profile.get(who), cleanName)
const modeOf = (w: AclWorld) => roomMode(F(w).profileMode) ?? 'all'

describe('room profile extras', () => {
  test('a profile write with extras is admitted, and a malformed extra is left out without a strike', () => {
    const w = world()
    join(w, 'A1')
    const good = { name: 'Al', nick: ' Ali ', bio: 'here', av: { kind: 'color', bg: '#AA0000' } }
    expect(w.act('A1', 'profile', good).v.s).toBe('A')
    expect(extrasOf(w, 'A')).toEqual({
      nick: 'Ali',
      bio: 'here',
      av: { kind: 'color', bg: '#aa0000' },
    })
    const odd = { name: 'Al', nick: 7, bio: 'x'.repeat(191), av: { kind: 'photo' }, bn: '#112233' }
    expect(w.act('A1', 'profile', odd).v.s).toBe('A')
    expect(extrasOf(w, 'A')).toEqual({ bn: '#112233' })
    expect(F(w).profile.get('A')?.name).toBe('Al')
    expect(w.state().cut.size).toBe(0)
  })

  test('a write without the extras takes them away until they are written again', () => {
    const w = world()
    join(w, 'A1')
    const mine = { name: 'Al', nick: 'Ali', bn: '#112233' }
    w.ok('A1', 'profile', mine)
    w.ok('A1', 'profile', { name: 'Alfred' })
    expect(extrasOf(w, 'A')).toEqual({})
    expect(sameExtras(extrasOf(w, 'A'), roomExtras(mine))).toBe(false)
    w.ok('A1', 'profile', { ...mine, name: 'Alfred' })
    expect(sameExtras(extrasOf(w, 'A'), roomExtras(mine))).toBe(true)
  })
})

describe('profile_mode: what room profiles may hold is a register read at display', () => {
  test('an owner or a member with Manage server sets it; anyone else is admitted and not read', () => {
    const w = world()
    const ADMIN = role(w, 5, SERVER)
    const MOD = role(w, 3, KICK)
    for (const d of ['A1', 'B1', 'C1']) join(w, d)
    w.ok('O1', 'assign', { to: 'A', role: ADMIN })
    w.ok('O1', 'assign', { to: 'B', role: MOD })
    expect(modeOf(w)).toBe('all')
    const rows: [string, string, Record<string, unknown>, string][] = [
      ['the owner', 'O1', { mode: 'no_names' }, 'no_names'],
      ['a member with Kick only', 'B1', { mode: 'off' }, 'no_names'],
      ['a plain member', 'C1', { mode: 'all' }, 'no_names'],
      ['a mode nobody knows', 'O1', { mode: 'some' }, 'no_names'],
      ['a member with Manage server', 'A1', { mode: 'off', later: 1 }, 'off'],
      ['the owner again', 'O1', { mode: 'all' }, 'all'],
    ]
    for (const [what, dev, c, want] of rows) {
      expect([what, w.act(dev, 'profile_mode', c).v.s]).toEqual([what, 'A'])
      expect([what, modeOf(w)]).toEqual([what, want])
    }
    expect(w.state().cut.size).toBe(0)
  })

  test('a write concurrent with its author losing Manage server does not count, in any order', () => {
    const w = world()
    const ADMIN = role(w, 5, SERVER)
    join(w, 'A1')
    w.ok('O1', 'assign', { to: 'A', role: ADMIN })
    w.ok('O1', 'profile_mode', { mode: 'no_names' })
    const before = w.heads()
    w.ok('O1', 'revoke', { to: 'A', role: ADMIN })
    const late = w.ok('A1', 'profile_mode', { mode: 'off' }, { ap: before })
    expect(w.state().cut.has(late.id)).toBe(false)
    expect(modeOf(w)).toBe('no_names')
    const r = new TestReplica(AGREED)
    for (const e of [...w.all].reverse()) r.receive(e)
    expect(roomMode(r.state().facts.profileMode)).toBe('no_names')
  })

  test('a mode that stops counting reaches the page as no mode', () => {
    const sent = { ...emptySummary(), profiles: 'no_names' as const }
    expect(applySummary(sent, diffSummary(sent, emptySummary())).profiles).toBeNull()
    expect(applySummary(emptySummary(), diffSummary(emptySummary(), sent)).profiles).toBe(
      'no_names'
    )
    expect(roomProfile({ nick: 'Ali' }, null).look?.name).toBe('Ali')
  })

  test('readers leave out the nickname under no_names and every extra under off', () => {
    const extras = roomExtras({ nick: 'Ali', bio: 'here', av: { kind: 'identicon' } })
    expect(roomProfile(extras, 'all').look?.name).toBe('Ali')
    expect(roomProfile(extras, 'no_names')).toEqual({
      look: { name: null, avatar_kind: 'identicon', avatar_color: null },
      bio: 'here',
      banner: null,
    })
    expect(roomProfile(extras, 'off')).toEqual({ look: null, bio: null, banner: null })
  })
})

describe('profile writes of one device in a room', () => {
  test('ten fit in an hour and the next waits for the oldest to age out', () => {
    const start = 1_000_000
    const times = Array.from({ length: PROFILE_FIELDS.writes_per_hour }, (_, i) => start + i)
    expect(writeFits(undefined, start)).toBe(true)
    expect(writeFits(times.slice(1), start + 20)).toBe(true)
    expect(writeFits(times, start + 20)).toBe(false)
    expect(writeFits(times, start + 3_600_000)).toBe(true)
    expect(recentWrites(times, start + 3_600_001)).toEqual(times.slice(2))
    expect(recentWrites([start + 50], start)).toEqual([])
  })
})

test('the next rules version is one past the current', () => {
  expect(RULES_NEXT).toBe(RULES_VERSION + 1)
})
