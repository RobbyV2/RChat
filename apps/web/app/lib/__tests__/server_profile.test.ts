import { expect, test } from 'bun:test'
import { defaultBanner } from '../profile'
import {
  lookOf,
  roomExtras,
  roomMode,
  roomProfile,
  shownBanner,
  shownBio,
  shownParts,
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
  expect(shownUser(bob, null)).toBe(bob)
  expect(shownUser(bob, look())).toEqual(bob)
  expect(shownUser(bob, look({ name: 'Robert' }))).toEqual({ ...bob, display_name: 'Robert' })
  expect(shownUser(bob, look({ avatar_kind: 'color', avatar_color: '#112233' }))).toEqual({
    ...bob,
    avatar_color: '#112233',
  })
})

test('an explicit identicon shows over an account color', () => {
  const shown = shownUser(bob, look({ avatar_kind: 'identicon' }))
  expect(shown).toEqual({ ...bob, avatar_kind: 'identicon', avatar_color: null })
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
