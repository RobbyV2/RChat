import { describe, expect, test } from 'bun:test'
import { AclWorld, devOwner, TestReplica } from './p2p_acl_world'
import { AGREED } from '../p2p/limits'
import {
  CHANGE_PROFILE,
  changesProfile,
  KICK,
  PROFILES,
  profileResetOk,
  resetBit,
  ROLES,
  RULES_NEXT,
  RULES_TEXT_ONLY,
  SERVER,
  type AclEv,
} from '../p2p/acl/rules'
import type { FactsQ } from '../p2p/acl/facts'
import { mayChangeProfile, mayResetProfile } from '../p2p/state'
import { FOREVER, hiddenFields, roomLock, settleIntent, shownExtras } from '../profile_reset'
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

describe('Change server profile: who may set a room profile, read at display', () => {
  const next = (everyone = 0) => {
    const w = new AclWorld({ model: false, agreed: AGREED })
    w.genesisNext('O1', ['O'], everyone)
    return w
  }
  const mine = (w: AclWorld, dev: string, nick: string) => ({
    name: 'Al',
    nick,
    in: join(w, dev).id,
  })
  const shown = (w: AclWorld, who: string) => {
    const c = F(w).profile.get(who)
    return [c?.name, c?.in === undefined ? {} : roomExtras(c, cleanName)]
  }

  test('the bit has its wire value and is asked for from the next rules version on', () => {
    expect(CHANGE_PROFILE).toBe(4194304)
    const none = { owners: new Set<string>(), bits: new Map(), holds: new Map() }
    expect([2, RULES_TEXT_ONLY, null, undefined].map(r => changesProfile(r, none, 'A'))).toEqual(
      Array(4).fill(true)
    )
    expect(changesProfile(RULES_NEXT, none, 'A')).toBe(false)
    expect(changesProfile(RULES_NEXT, { ...none, owners: new Set(['A']) }, 'A')).toBe(true)
  })

  test('a write of a member without it shows the global name only; with it, the room profile', () => {
    const w = next()
    const a = mine(w, 'A1', 'Ali')
    w.ok('A1', 'profile', a)
    expect(shown(w, 'A')).toEqual(['Al', {}])
    w.ok('O1', 'role_bits', { role: 'everyone', bit: CHANGE_PROFILE, on: true })
    expect(shown(w, 'A')).toEqual(['Al', {}])
    w.ok('A1', 'profile', { ...a, nick: 'Again' })
    expect(shown(w, 'A')).toEqual(['Al', { nick: 'Again' }])
  })

  test('everyone holding it sets a room profile, and a role gives it to its holders', () => {
    const w = next(CHANGE_PROFILE)
    const a = mine(w, 'A1', 'Ali')
    w.ok('A1', 'profile', a)
    expect(shown(w, 'A')).toEqual(['Al', { nick: 'Ali' }])
    w.ok('O1', 'role_bits', { role: 'everyone', bit: CHANGE_PROFILE, on: false })
    expect(shown(w, 'A')).toEqual(['Al', { nick: 'Ali' }])
    w.ok('A1', 'profile', { ...a, nick: 'Later' })
    expect(shown(w, 'A')).toEqual(['Al', {}])
    const r = role(w, 5, CHANGE_PROFILE)
    w.ok('O1', 'assign', { to: 'A', role: r })
    w.ok('A1', 'profile', { ...a, nick: 'Named' })
    expect(shown(w, 'A')).toEqual(['Al', { nick: 'Named' }])
  })

  test('earlier rules keep showing what every member set', () => {
    const w = world()
    w.ok('A1', 'profile', mine(w, 'A1', 'Ali'))
    expect(shown(w, 'A')).toEqual(['Al', { nick: 'Ali' }])
  })

  test('the page offers the editor to those whose write would show', () => {
    const member = (perms: number) => ({
      m: 'join' as const,
      rank: [-1, ''] as [number, string],
      perms,
      roles: [] as string[],
      devs: [] as string[],
      profile: null,
    })
    const s = (rules: number, perms: number) => ({
      ...emptySummary(),
      rules,
      owners: ['O'],
      members: { O: member(0x7fffffff), A: member(perms) },
    })
    expect(mayChangeProfile(s(RULES_NEXT, 768), 'O')).toBe(true)
    expect(mayChangeProfile(s(RULES_NEXT, 768), 'A')).toBe(false)
    expect(mayChangeProfile(s(RULES_NEXT, 768 | CHANGE_PROFILE), 'A')).toBe(true)
    expect(mayChangeProfile(s(RULES_TEXT_ONLY, 768), 'A')).toBe(true)
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

describe('profile_reset: a moderator clears parts of a room profile, read at display', () => {
  const NOW = 1_700_000_000
  const resetOf = (w: AclWorld, who: string) => F(w).profileReset.get(who)
  const shown = (w: AclWorld, who: string, now = NOW) =>
    shownExtras(extrasOf(w, who), resetOf(w, who), now)
  const mine = { name: 'Al', nick: 'Ali', bio: 'here', av: { kind: 'identicon' }, bn: '#112233' }
  // O owns; A holds Kick at 5, B holds Kick at 3, C and D are plain.
  const club = () => {
    const w = world()
    const HIGH = role(w, 5, KICK)
    const LOW = role(w, 3, KICK)
    for (const d of ['A1', 'B1', 'C1', 'D1']) join(w, d)
    w.ok('O1', 'assign', { to: 'A', role: HIGH })
    w.ok('O1', 'assign', { to: 'B', role: LOW })
    for (const d of ['A1', 'B1', 'C1', 'D1']) w.ok(d, 'profile', mine)
    return { w, HIGH, LOW }
  }

  test('an owner, or a member with Kick who outranks the member, resets; anyone else is admitted and not read', () => {
    const { w } = club()
    const rows: [string, string, Record<string, unknown>, string, boolean][] = [
      ['a plain member', 'D1', { to: 'C', fields: ['name'] }, 'C', false],
      ['a member on themselves', 'A1', { to: 'A', fields: ['name'] }, 'A', false],
      ['a moderator on one above', 'B1', { to: 'A', fields: ['name'] }, 'A', false],
      ['a moderator on an owner', 'A1', { to: 'O', fields: ['name'] }, 'O', false],
      ['someone who is not in', 'A1', { to: 'Z', fields: ['name'] }, 'Z', false],
      ['fields that are no list', 'O1', { to: 'C', fields: 'name' }, 'C', false],
      ['a lock end that is no time', 'O1', { to: 'C', fields: ['name'], until: -4 }, 'C', false],
      ['a moderator on a plain member', 'B1', { to: 'C', fields: ['name'], later: 1 }, 'C', true],
      ['a moderator on one below', 'A1', { to: 'B', fields: ['bio'] }, 'B', true],
      ['the owner on a moderator', 'O1', { to: 'A' }, 'A', true],
    ]
    for (const [what, dev, c, who, counts] of rows) {
      expect([what, w.act(dev, 'profile_reset', c).v.s]).toEqual([what, 'A'])
      expect([what, resetOf(w, who) !== undefined]).toEqual([what, counts])
    }
    expect(shown(w, 'C')).toEqual({ bio: 'here', av: { kind: 'identicon' }, bn: '#112233' })
    expect(shown(w, 'B')).toEqual({ nick: 'Ali', av: { kind: 'identicon' }, bn: '#112233' })
    expect(shown(w, 'A')).toEqual({})
    expect(shown(w, 'D')).toEqual(extrasOf(w, 'D'))
    expect(extrasOf(w, 'C').nick).toBe('Ali')
    expect(w.state().cut.size).toBe(0)
  })

  test('it hides what was written before it or at the same time, and nothing written after', () => {
    const { w } = club()
    const before = w.heads()
    const reset = w.ok('O1', 'profile_reset', { to: 'C', fields: ['name', 'banner'] })
    expect(resetOf(w, 'C')).toEqual({ last: reset.id, hide: ['name', 'banner'] })
    w.ok('C1', 'profile', { ...mine, nick: 'Sly' }, { ap: before })
    expect(extrasOf(w, 'C').nick).toBe('Sly')
    expect(shown(w, 'C')).toEqual({ bio: 'here', av: { kind: 'identicon' } })
    w.ok('C1', 'profile', { ...mine, nick: 'Fair' })
    expect(resetOf(w, 'C')).toEqual({ last: reset.id, hide: [] })
    expect(shown(w, 'C').nick).toBe('Fair')
    const second = w.ok('A1', 'profile_reset', { to: 'C', fields: ['bio'] })
    expect(resetOf(w, 'C')).toEqual({ last: second.id, hide: ['bio'] })
    expect(shown(w, 'C')).toEqual({ nick: 'Fair', av: { kind: 'identicon' }, bn: '#112233' })
  })

  test('a lock hides its parts of later writes until its end on the reader clock, or until it is lifted', () => {
    const { w } = club()
    const lock = w.ok('O1', 'profile_reset', { to: 'C', fields: ['name'], until: NOW + 600 })
    w.ok('C1', 'profile', { ...mine, nick: 'Again' })
    expect(resetOf(w, 'C')).toEqual({
      last: lock.id,
      hide: [],
      lock: { until: NOW + 600, fields: ['name'] },
    })
    expect(shown(w, 'C').nick).toBeUndefined()
    expect(shown(w, 'C').bio).toBe('here')
    expect(roomLock(resetOf(w, 'C'), NOW)).toEqual({ locked: true, until: NOW + 600 })
    expect(shown(w, 'C', NOW + 600).nick).toBe('Again')
    w.ok('A1', 'profile_reset', { to: 'C', fields: ['bio'] })
    expect(resetOf(w, 'C')?.lock).toEqual({ until: NOW + 600, fields: ['name'] })
    expect(hiddenFields(resetOf(w, 'C'), NOW)).toEqual(['name', 'bio'])
    w.ok('C1', 'profile_reset', { to: 'C', fields: [], until: 0 })
    w.ok('D1', 'profile_reset', { to: 'C', fields: [], until: 0 })
    expect(roomLock(resetOf(w, 'C'), NOW).locked).toBe(true)
    const lifted = w.ok('B1', 'profile_reset', { to: 'C', fields: [], until: 0 })
    expect(resetOf(w, 'C')).toEqual({ last: lifted.id, hide: ['bio'] })
    expect(roomLock(resetOf(w, 'C'), NOW)).toEqual({ locked: false })
    expect(shown(w, 'C').nick).toBe('Again')
    w.ok('O1', 'profile_reset', { to: 'C', fields: [], until: FOREVER })
    expect(roomLock(resetOf(w, 'C'), NOW * 1000)).toEqual({ locked: true, until: null })
  })

  test('a lock alone holds the profile as it was: a part changed while it runs shows once it ends', () => {
    const { w } = club()
    const lock = w.ok('O1', 'profile_reset', { to: 'C', fields: [], until: NOW + 600 })
    expect(shown(w, 'C')).toEqual(extrasOf(w, 'C'))
    w.ok('C1', 'profile', { ...mine, nick: 'Sneaky', bio: 'new' })
    expect(resetOf(w, 'C')).toEqual({
      last: lock.id,
      hide: [],
      lock: { until: NOW + 600, fields: ['name', 'bio'] },
    })
    expect(roomLock(resetOf(w, 'C'), NOW).locked).toBe(true)
    expect(shown(w, 'C')).toEqual({ av: { kind: 'identicon' }, bn: '#112233' })
    expect(shown(w, 'C', NOW + 600)).toMatchObject({ nick: 'Sneaky', bio: 'new' })
    w.ok('C1', 'profile', { name: 'Al', bio: 'here', bn: '#445566' })
    expect(shown(w, 'C')).toEqual({ bio: 'here' })
  })

  test('a part the lock does not list, written while it runs, shows once it ends', () => {
    const { w } = club()
    w.ok('O1', 'profile_reset', { to: 'C', fields: ['name'], until: NOW + 600 })
    w.ok('C1', 'profile', { ...mine, bio: 'new' })
    expect(resetOf(w, 'C')?.lock?.fields).toEqual(['name', 'bio'])
    expect(shown(w, 'C')).toEqual({ av: { kind: 'identicon' }, bn: '#112233' })
    expect(shown(w, 'C', NOW + 600)).toEqual({ ...extrasOf(w, 'C'), bio: 'new' })
  })

  test('our write without what a lock cleared keeps the rest showing while it runs', () => {
    const { w } = club()
    w.ok('O1', 'profile_reset', { to: 'C', fields: ['name'], until: NOW + 600 })
    w.ok('C1', 'profile', { name: 'Al', bio: 'here', av: { kind: 'identicon' }, bn: '#112233' })
    expect(resetOf(w, 'C')?.hide).toEqual(['name'])
    expect(resetOf(w, 'C')?.lock?.fields).toEqual(['name'])
    expect(shown(w, 'C')).toEqual({ bio: 'here', av: { kind: 'identicon' }, bn: '#112233' })
  })

  test('a part we took out stays out, and comes back once its reset stops counting', () => {
    const { w, LOW } = club()
    const before = w.heads()
    w.ok('B1', 'profile_reset', { to: 'C', fields: ['name'] })
    const set = roomExtras(mine, cleanName)
    const out = settleIntent(set, {}, extrasOf(w, 'C'), resetOf(w, 'C'))
    expect(out).toEqual({ intent: roomExtras({ ...mine, nick: undefined }), gone: { nick: 'Ali' } })
    if (!out) return
    w.ok('C1', 'profile', { name: 'Al', ...out.intent })
    expect(resetOf(w, 'C')?.hide).toEqual(['name'])
    expect(settleIntent(out.intent, out.gone, extrasOf(w, 'C'), resetOf(w, 'C'))).toBeNull()
    w.ok('O1', 'revoke', { to: 'B', role: LOW }, { ap: before })
    expect(resetOf(w, 'C')).toBeUndefined()
    expect(settleIntent(out.intent, out.gone, extrasOf(w, 'C'), resetOf(w, 'C'))).toEqual({
      intent: set,
      gone: {},
    })
  })

  test('a reset concurrent with its author losing the role does not count, in any order', () => {
    const { w, LOW } = club()
    const before = w.heads()
    w.ok('O1', 'revoke', { to: 'B', role: LOW })
    const late = w.ok('B1', 'profile_reset', { to: 'C', fields: ['name'] }, { ap: before })
    expect(w.state().cut.has(late.id)).toBe(false)
    expect(resetOf(w, 'C')).toBeUndefined()
    expect(shown(w, 'C').nick).toBe('Ali')
    const r = new TestReplica(AGREED)
    for (const e of [...w.all].reverse()) r.receive(e)
    expect(r.state().facts.profileReset.get('C')).toBeUndefined()
  })

  test('a reset concurrent with its author moving below the member does not count', () => {
    const { w, HIGH } = club()
    const MID = role(w, 4, 0)
    w.ok('O1', 'assign', { to: 'C', role: MID })
    const before = w.heads()
    w.ok('O1', 'role_move', { role: HIGH, pos: 2 })
    w.ok('A1', 'profile_reset', { to: 'C', fields: ['name'] }, { ap: before })
    expect(resetOf(w, 'C')).toBeUndefined()
    w.ok('O1', 'profile_reset', { to: 'C', fields: ['name'] })
    expect(shown(w, 'C').nick).toBeUndefined()
  })

  test('a reset and its lock end with the membership', () => {
    const { w } = club()
    w.ok('O1', 'profile_reset', { to: 'C', until: FOREVER })
    expect(roomLock(resetOf(w, 'C'), NOW).locked).toBe(true)
    w.ok('C1', 'leave')
    expect(resetOf(w, 'C')).toBeUndefined()
    join(w, 'C2')
    expect(F(w).mem.has('C')).toBe(true)
    w.ok('C2', 'profile', { ...mine, nick: 'Back' })
    expect(resetOf(w, 'C')).toBeUndefined()
    expect(shown(w, 'C')).toEqual(extrasOf(w, 'C'))
  })

  test('from the next rules version the bit of its own is asked for, and Kick alone is not enough', () => {
    expect([2, RULES_TEXT_ONLY, null, undefined, '5'].map(resetBit)).toEqual(Array(5).fill(KICK))
    expect([RULES_NEXT, RULES_NEXT + 1].map(resetBit)).toEqual([PROFILES, PROFILES])
    expect(PROFILES).toBe(8388608)
    const St = (bits: number): FactsQ =>
      ({
        owners: new Set(['O']),
        mem: new Set(['O', 'A', 'C']),
        bits: new Map([
          ['everyone', 0],
          ['R', bits],
        ]),
        pos: new Map([['R', 5]]),
        holds: new Map([['A', new Set(['R'])]]),
      }) as unknown as FactsQ
    const e = (a: string, to: string) => ({ a, c: { to, fields: ['name'] } }) as unknown as AclEv
    expect(profileResetOk(e('A', 'C'), St(KICK), resetBit(RULES_TEXT_ONLY))).toBe(true)
    expect(profileResetOk(e('A', 'C'), St(KICK | ROLES), resetBit(RULES_NEXT))).toBe(false)
    expect(profileResetOk(e('A', 'C'), St(PROFILES), resetBit(RULES_NEXT))).toBe(true)
    expect(profileResetOk(e('A', 'C'), St(PROFILES), resetBit(RULES_TEXT_ONLY))).toBe(false)
    expect(profileResetOk(e('O', 'C'), St(0), resetBit(RULES_NEXT))).toBe(true)
    expect(profileResetOk(e('A', 'O'), St(PROFILES), resetBit(RULES_NEXT))).toBe(false)
    expect(profileResetOk(e('C', 'A'), St(PROFILES), resetBit(RULES_NEXT))).toBe(false)
  })

  test('the page offers a reset to those whose reset would count', () => {
    const member = (rank: [number, string], perms: number, m: 'join' | 'leave' = 'join') => ({
      m,
      rank,
      perms,
      roles: [] as string[],
      devs: [] as string[],
      profile: null,
    })
    const s = (rules: number) => ({
      ...emptySummary(),
      rules,
      owners: ['O'],
      members: {
        O: member([Infinity, ''], 0x7fffffff),
        A: member([5, 'R'], KICK),
        P: member([5, 'S'], PROFILES),
        C: member([-1, ''], 0),
        Gone: member([-1, ''], 0, 'leave'),
      },
    })
    const may = (rules: number, by: string, to: string) => mayResetProfile(s(rules), by, to)
    expect(may(RULES_TEXT_ONLY, 'A', 'C')).toBe(true)
    expect(may(RULES_TEXT_ONLY, 'P', 'C')).toBe(false)
    expect(may(RULES_NEXT, 'A', 'C')).toBe(false)
    expect(may(RULES_NEXT, 'P', 'C')).toBe(true)
    expect(may(RULES_TEXT_ONLY, 'O', 'A')).toBe(true)
    expect(may(RULES_TEXT_ONLY, 'A', 'A')).toBe(false)
    expect(may(RULES_TEXT_ONLY, 'A', 'P')).toBe(false)
    expect(may(RULES_TEXT_ONLY, 'A', 'O')).toBe(false)
    expect(may(RULES_TEXT_ONLY, 'O', 'O')).toBe(false)
    expect(may(RULES_TEXT_ONLY, 'O', 'Gone')).toBe(false)
    expect(may(RULES_TEXT_ONLY, 'C', 'A')).toBe(false)
  })

  test('a reset that stops counting leaves the page summary of its member', () => {
    const m = {
      m: 'join' as const,
      rank: [-1, ''] as const,
      perms: 0,
      roles: [],
      devs: [],
      profile: null,
    }
    const plain = { ...emptySummary(), members: { C: m } }
    const reset = { ...emptySummary(), members: { C: { ...m, reset: { last: 'r', hide: [] } } } }
    expect(applySummary(reset, diffSummary(reset, plain)).members.C.reset).toBeUndefined()
    expect(applySummary(plain, diffSummary(plain, reset)).members.C.reset).toEqual({
      last: 'r',
      hide: [],
    })
  })
})

test('the rules that read profile permissions come right after the text-only rules', () => {
  expect(RULES_NEXT).toBe(RULES_TEXT_ONLY + 1)
})
