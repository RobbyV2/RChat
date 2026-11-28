import { expect, test } from 'bun:test'
import { defaultBanner } from '../profile'
import {
  byShownName,
  lookIn,
  lookKnown,
  lookOf,
  roomExtras,
  roomLookOf,
  roomLooksKey,
  roomMode,
  roomProfile,
  shownBanner,
  shownActor,
  shownBio,
  shownIn,
  shownParts,
  shownTypers,
  shownUser,
  showsMore,
  withLook,
  type LookSource,
} from '../server_profile'
import type { Member, MemberLook, ProfilesMode, UserRef } from '../types'

const bob: UserRef = {
  username: 'bob',
  display_name: 'Bob',
  avatar_kind: 'color',
  avatar_color: '#336699',
}

const look = (over: Partial<MemberLook> = {}): MemberLook => ({
  name: null,
  avatar_kind: null,
  avatar_color: null,
  ...over,
})

const member = (profile?: MemberLook): Member => ({
  ...bob,
  is_admin: false,
  is_creator: false,
  online: false,
  perms: 0,
  role_ids: [],
  ...(profile ? { profile } : {}),
})

test('each field of a look stands over the account value on its own', () => {
  expect<UserRef>(shownUser(bob, null)).toEqual(bob)
  expect<UserRef>(shownUser(bob, look())).toEqual(bob)
  expect<UserRef>(shownUser(bob, look({ name: 'Robert' }))).toEqual({
    ...bob,
    display_name: 'Robert',
  })
  expect<UserRef>(shownUser(bob, look({ avatar_kind: 'color', avatar_color: '#112233' }))).toEqual({
    ...bob,
    avatar_color: '#112233',
  })
})

test('an explicit identicon shows over an account color', () => {
  const shown = shownUser(bob, look({ avatar_kind: 'identicon' }))
  expect<UserRef>(shown).toEqual({ ...bob, avatar_kind: 'identicon', avatar_color: null })
  expect(shown.username).toBe('bob')
})

test('a look keeps the other fields of what it is laid over', () => {
  const shown = shownUser(member(), look({ name: 'Robert' }))
  expect(shown.role_ids).toEqual([])
  expect(shown.display_name).toBe('Robert')
})

test('the banner falls back from the place to the account to the shown avatar', () => {
  const shown = shownUser(bob, look({ avatar_kind: 'color', avatar_color: '#112233' }))
  expect(shownBanner(shown, { banner_color: '#AAAAAA', server_banner: '#BBBBBB' })).toBe('#bbbbbb')
  expect(shownBanner(shown, { banner_color: '#AAAAAA', server_banner: null })).toBe('#aaaaaa')
  expect(shownBanner(shown, { banner_color: null })).toBe('#112233')
  const plain = shownUser(bob, look({ avatar_kind: 'identicon' }))
  expect(shownBanner(plain, {})).toBe(defaultBanner(plain))
  expect(shownBanner(plain, {})).not.toBe('#336699')
})

test('the description of the place shows over the account description', () => {
  expect(shownBio(bob, { bio: 'account', server_bio: 'here' })).toBe('here')
  expect(shownBio(bob, { bio: 'account', server_bio: null })).toBe('account')
  expect(shownBio(bob, { bio: 'account' })).toBe('account')
  expect(shownBio(bob, {})).toBeNull()
})

test('a hosted look comes from the member lookup, then the member list', () => {
  const robert = look({ name: 'Robert' })
  const page = { list: [member(robert)], hasMore: false, loading: false, q: '' }
  expect(lookOf({ members: { club: page } }, { server: 'club' }, 'bob')).toEqual(robert)
  expect(lookOf({ members: { club: page } }, { server: 'other' }, 'bob')).toBeNull()
  expect(lookOf({ members: { club: page } }, { server: 'club' }, 'carol')).toBeNull()
  const info = { club: { bob: member(look({ name: 'Bobby' })), gone: null } }
  expect(lookOf({ members: { club: page }, memberInfo: info }, { server: 'club' }, 'bob')).toEqual(
    look({ name: 'Bobby' })
  )
  expect(lookOf({ memberInfo: info }, { server: 'club' }, 'gone')).toBeNull()
  expect(
    lookOf(
      { memberInfo: { club: { bob: member() } }, members: { club: page } },
      { server: 'club' },
      'bob'
    )
  ).toBeNull()
})

test('a hosted look shows only what the server mode and the site switches let through', () => {
  const full = look({ name: 'Robert', avatar_kind: 'color', avatar_color: '#112233' })
  const avatar = look({ avatar_kind: 'color', avatar_color: '#112233' })
  const at = (
    profile: MemberLook,
    profiles_mode?: ProfilesMode,
    settings?: LookSource['settings']
  ) =>
    lookOf(
      {
        members: { club: { list: [member(profile)], hasMore: false, loading: false, q: '' } },
        servers: { club: { profiles_mode } },
        settings,
      },
      { server: 'club' },
      'bob'
    )
  expect(at(full, 'all')).toBe(full)
  expect(at(full)).toBe(full)
  expect(at(full, 'no_names')).toEqual(avatar)
  expect(at(look({ name: 'Robert' }), 'no_names')).toBeNull()
  expect(at(full, 'off')).toBeNull()
  expect(at(full, 'all', { server_profiles: false, display_names: true })).toBeNull()
  expect(at(full, 'all', { server_profiles: true, display_names: false })).toEqual(avatar)
  expect(at(avatar, 'no_names')).toBe(avatar)
})

test('a part that shows again means the looks fetched without it are fetched again', () => {
  const parts = (profiles_mode: ProfilesMode, server_profiles = true) =>
    shownParts({ servers: { club: { profiles_mode } }, settings: { server_profiles } }, 'club')
  expect(parts('all')).toEqual({ names: true, rest: true })
  expect(shownParts({}, 'club')).toEqual({ names: true, rest: true })
  expect(showsMore(parts('off'), parts('all'))).toBe(true)
  expect(showsMore(parts('no_names'), parts('all'))).toBe(true)
  expect(showsMore(parts('off'), parts('no_names'))).toBe(true)
  expect(showsMore(parts('all', false), parts('all'))).toBe(true)
  expect(showsMore(parts('all'), parts('no_names'))).toBe(false)
  expect(showsMore(parts('all'), parts('all', false))).toBe(false)
  expect(showsMore(parts('off'), parts('all', false))).toBe(false)
})

test('a server whose detail is not loaded shows what its summary says', () => {
  const me = { servers: [{ name: 'club', profiles_mode: 'off' as const }, { name: 'old' }] }
  expect(shownParts({ me }, 'club')).toEqual({ names: false, rest: false })
  expect(shownParts({ me }, 'old')).toEqual({ names: true, rest: true })
  expect(shownParts({ me, servers: { club: { profiles_mode: 'no_names' } } }, 'club')).toEqual({
    names: false,
    rest: true,
  })
  expect(shownParts({ me, servers: { club: {} } }, 'club')).toEqual({ names: true, rest: true })
})

test('the looks of a room change only with what its rows draw of a member', () => {
  const rows = [
    { ik: 'k1', name: 'Skipper', nick: 'Skipper', av: { kind: 'color' as const, bg: '#112233' } },
    { ik: 'k2', name: 'Carol', online: true },
  ]
  const key = roomLooksKey(rows)
  expect(roomLooksKey(rows.map(m => ({ ...m, online: false })))).toBe(key)
  expect(roomLooksKey([rows[0], { ...rows[1], name: 'Caroline' }])).not.toBe(key)
  expect(roomLooksKey([{ ...rows[0], nick: undefined }, rows[1]])).not.toBe(key)
  expect(roomLooksKey([{ ...rows[0], av: { kind: 'color', bg: '#445566' } }, rows[1]])).not.toBe(
    key
  )
  expect(roomLooksKey([{ ...rows[0], av: { kind: 'identicon' } }, rows[1]])).not.toBe(key)
  expect(roomLooksKey([rows[1], rows[0]])).not.toBe(key)
  expect(roomLooksKey(undefined)).toBe('')
})

test('a name that is not loaded reads as no look, so the account name shows', () => {
  const typer = { ...bob }
  expect(shownUser(typer, lookOf({}, { server: 'club' }, 'bob')).display_name).toBe('Bob')
})

test('a room look comes from the room', () => {
  const robert = look({ name: 'Robert' })
  const source = {
    roomLook: (room: string, who: string) => (room === 'r1' && who === 'ik1' ? robert : null),
  }
  expect(lookOf(source, { room: 'r1' }, 'ik1')).toEqual(robert)
  expect(lookOf(source, { room: 'r2' }, 'ik1')).toBeNull()
  expect(lookOf({}, { room: 'r1' }, 'ik1')).toBeNull()
})

test('an account update merged into a member keeps the look', () => {
  const robert = look({ name: 'Robert' })
  const renamed: UserRef = { ...bob, display_name: 'Bobby' }
  const merged = { ...member(robert), ...renamed }
  expect(merged.profile).toEqual(robert)
  expect(shownUser(merged, merged.profile).display_name).toBe('Robert')
})

test('a look event sets or takes away the look of one member', () => {
  const robert = look({ name: 'Robert' })
  expect(withLook(member(), robert).profile).toEqual(robert)
  const cleared = withLook(member(robert), null)
  expect('profile' in cleared).toBe(false)
  expect(cleared.username).toBe('bob')
})

test('room extras are read field by field and a malformed one is left out', () => {
  expect(
    roomExtras({
      name: 'Bob',
      nick: '  Robert ',
      bio: ' hi ',
      av: { kind: 'color', bg: '#AABBCC' },
      bn: '#001122',
      later: { any: 1 },
    })
  ).toEqual({ nick: 'Robert', bio: 'hi', av: { kind: 'color', bg: '#aabbcc' }, bn: '#001122' })
  expect(roomExtras({ nick: 7, bio: 'x'.repeat(191), av: { kind: 'color' }, bn: 'blue' })).toEqual(
    {}
  )
  expect(roomExtras({ nick: 'n'.repeat(33), bio: 'kept', av: 'identicon' })).toEqual({
    bio: 'kept',
  })
  expect(roomExtras({ nick: '   ', av: { kind: 'photo', bg: '#000000' } })).toEqual({})
  expect(roomExtras({ av: { kind: 'identicon', bg: 'red' } })).toEqual({
    av: { kind: 'identicon' },
  })
  expect(roomExtras({ av: { kind: 'identicon', bg: '#123456' } })).toEqual({
    av: { kind: 'identicon', bg: '#123456' },
  })
  for (const odd of [null, undefined, 'profile', 4, []]) expect(roomExtras(odd)).toEqual({})
  expect(roomExtras({ nick: 'a\u200bb' }, raw => raw.replace('\u200b', ''))).toEqual({ nick: 'ab' })
})

test('a room shows extras under its mode', () => {
  const extras = roomExtras({ nick: 'Robert', bio: 'hi', av: { kind: 'identicon' }, bn: '#001122' })
  expect(roomProfile(extras)).toEqual({
    look: { name: 'Robert', avatar_kind: 'identicon', avatar_color: null },
    bio: 'hi',
    banner: '#001122',
  })
  expect(roomProfile(extras, 'no_names')).toEqual({
    look: { name: null, avatar_kind: 'identicon', avatar_color: null },
    bio: 'hi',
    banner: '#001122',
  })
  expect(roomProfile({ nick: 'Robert' }, 'no_names').look).toBeNull()
  expect(roomProfile(extras, 'off')).toEqual({ look: null, bio: null, banner: null })
  expect(roomProfile({})).toEqual({ look: null, bio: null, banner: null })
})

test('a room mode write is one of the three modes or nothing', () => {
  expect(roomMode({ mode: 'no_names' })).toBe('no_names')
  expect(roomMode({ mode: 'off', later: true })).toBe('off')
  for (const odd of [{ mode: 'some' }, { mode: 1 }, {}, null, 'off'])
    expect(roomMode(odd)).toBeUndefined()
})

const robert = look({ name: 'Robert' })
const loaded: LookSource = { memberInfo: { s: { bob: member(robert), gone: null } } }

test('a member row counts as loaded from the lookup or the list, a row of someone gone included', () => {
  expect(lookKnown(loaded, 's', 'bob')).toBe(true)
  expect(lookKnown(loaded, 's', 'gone')).toBe(true)
  expect(lookKnown(loaded, 's', 'carol')).toBe(false)
  expect(lookKnown(loaded, 'other', 'bob')).toBe(false)
  const listed: LookSource = { members: { s: { list: [member()] } as never } }
  expect(lookKnown(listed, 's', 'bob')).toBe(true)
})

test('a look is cut down to the parts that show', () => {
  const full = look({ name: 'Robert', avatar_kind: 'color', avatar_color: '#112233' })
  expect(lookIn(full, { names: true, rest: true })).toBe(full)
  expect(lookIn(full, { names: false, rest: true })).toEqual({ ...full, name: null })
  expect(lookIn(full, { names: false, rest: false })).toBeNull()
})

test('someone in a notification shows under the server name, and is asked for when not loaded', () => {
  expect<{ user: UserRef; ask: boolean }>(shownIn(loaded, 's', bob)).toEqual({
    user: { ...bob, display_name: 'Robert' },
    ask: false,
  })
  const carol = { ...bob, username: 'carol', display_name: 'Carol' }
  expect<{ user: UserRef; ask: boolean }>(shownIn(loaded, 's', carol)).toEqual({
    user: carol,
    ask: true,
  })
  expect<{ user: UserRef; ask: boolean }>(shownIn(loaded, null, bob)).toEqual({
    user: bob,
    ask: false,
  })
})

test('a notification asks once for a member row it lacks, never for a webhook or a DM', () => {
  const asked: [string, string[]][] = []
  const source = () => ({
    ...loaded,
    ensureMembers: (server: string, names: string[]) => void asked.push([server, names]),
  })
  const carol = { ...bob, username: 'carol', display_name: 'Carol' }
  expect(shownActor(source, 's', bob).display_name).toBe('Robert')
  expect<UserRef>(shownActor(source, 's', carol)).toEqual(carol)
  expect<UserRef>(shownActor(source, null, carol)).toEqual(carol)
  expect(asked).toEqual([['s', ['carol']]])
})

test('the typing line shows server names, and the account name until the row is loaded', () => {
  const here = {
    bob: { name: 'Bob', until: 1 },
    carol: { name: 'Carol (carol)', until: 1 },
    dave: { name: 'Dave', until: 1 },
  }
  expect(shownTypers(loaded, 's', here, { dave: true })).toEqual({
    names: ['Robert (bob)', 'Carol (carol)'],
    ask: ['carol'],
  })
  const later: LookSource = {
    memberInfo: { s: { ...loaded.memberInfo!.s, carol: member(look({ name: 'Caz' })) } },
  }
  expect(shownTypers(later, 's', here, {})).toEqual({
    names: ['Robert (bob)', 'Caz (carol)', 'Dave'],
    ask: ['dave'],
  })
  expect(shownTypers(loaded, null, here, {})).toEqual({
    names: ['Bob', 'Carol (carol)', 'Dave'],
    ask: [],
  })
  expect(shownTypers(loaded, 's', undefined, {})).toEqual({ names: [], ask: [] })
})

test('people sort by the name the place shows', () => {
  const zed = shownUser({ ...bob, username: 'amy', display_name: 'Amy' }, look({ name: 'Zed' }))
  expect([zed, bob].sort(byShownName).map(u => u.username)).toEqual(['bob', 'amy'])
})

test('a room member shows the nickname only when no name of ours for them comes first', () => {
  expect(roomLookOf(undefined)).toBeNull()
  expect(roomLookOf({ name: 'Bob' })).toBeNull()
  expect(roomLookOf({ name: 'Bobby', nick: 'Bobby' })).toEqual(look({ name: 'Bobby' }))
  expect(roomLookOf({ name: 'My friend', nick: 'Bobby' })).toBeNull()
  expect(
    roomLookOf({ name: 'My friend', nick: 'Bobby', av: { kind: 'color', bg: '#112233' } })
  ).toEqual(look({ avatar_kind: 'color', avatar_color: '#112233' }))
  expect(roomLookOf({ name: 'Bob', av: { kind: 'identicon' } })).toEqual(
    look({ avatar_kind: 'identicon' })
  )
})
