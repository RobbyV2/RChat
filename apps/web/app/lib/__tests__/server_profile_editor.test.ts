import { expect, test } from 'bun:test'
import { PROFILE_FIELDS } from '../profile_fields'
import {
  EMPTY_DRAFT,
  bioLeft,
  draftError,
  draftFor,
  draftLook,
  draftOfExtras,
  draftOfProfile,
  editsRoomProfile,
  emptyDraft,
  extrasOf,
  patchOf,
  previewUser,
  sameDraft,
  settled,
  type ProfileDraft,
} from '../server_profile_editor'
import type { UserRef } from '../types'

const draft = (over: Partial<ProfileDraft> = {}): ProfileDraft => ({ ...EMPTY_DRAFT, ...over })

const alice: UserRef = {
  username: 'alice',
  display_name: 'Alice',
  avatar_kind: 'color',
  avatar_color: '#336699',
}

test('a stored hosted profile and a room intent read as the same draft', () => {
  const full = draft({
    name: 'Captain',
    bio: 'Sails',
    avatar: { kind: 'color', color: '#112233' },
    banner: '#445566',
  })
  expect(
    draftOfProfile({
      look: { name: 'Captain', avatar_kind: 'color', avatar_color: '#112233' },
      bio: 'Sails',
      banner_color: '#445566',
    })
  ).toEqual(full)
  expect(
    draftOfExtras({
      nick: 'Captain',
      bio: 'Sails',
      av: { kind: 'color', bg: '#112233' },
      bn: '#445566',
    })
  ).toEqual(full)
  expect(
    draftOfProfile({
      look: { name: null, avatar_kind: null, avatar_color: null },
      bio: null,
      banner_color: null,
    })
  ).toEqual(EMPTY_DRAFT)
  expect(draftOfExtras({})).toEqual(EMPTY_DRAFT)
  expect(draftOfExtras({ av: { kind: 'identicon' } }).avatar).toEqual({
    kind: 'identicon',
    color: null,
  })
})

test('a draft settles as it is stored', () => {
  expect(
    settled(
      draft({
        name: '  Captain ',
        bio: '\n\nSails\n\n\n\nfar \n',
        avatar: { kind: 'identicon', color: '#AABBCC' },
        banner: '#DDEEFF',
      })
    )
  ).toEqual({
    name: 'Captain',
    bio: 'Sails\n\nfar',
    avatar: { kind: 'identicon', color: '#aabbcc' },
    banner: '#ddeeff',
  })
  expect(settled(draft({ avatar: { kind: 'color', color: 'red' } })).avatar).toBeNull()
  expect(settled(draft({ avatar: { kind: 'identicon', color: 'red' } })).avatar).toEqual({
    kind: 'identicon',
    color: null,
  })
  expect(settled(draft({ banner: 'blue' })).banner).toBeNull()
})

test('drafts compare as they are stored', () => {
  expect(sameDraft(draft({ name: ' Captain' }), draft({ name: 'Captain' }))).toBe(true)
  expect(sameDraft(draft({ name: 'Captain' }), draft({ name: 'captain' }))).toBe(false)
  expect(
    sameDraft(
      draft({ avatar: { kind: 'identicon', color: null } }),
      draft({ avatar: { kind: 'identicon', color: null } })
    )
  ).toBe(true)
  expect(sameDraft(draft({ avatar: { kind: 'identicon', color: null } }), draft())).toBe(false)
  expect(emptyDraft(draft({ name: '  ', bio: '\n' }))).toBe(true)
  expect(emptyDraft(draft({ banner: '#112233' }))).toBe(false)
})

test('the limits of the shared field table refuse a draft', () => {
  const max = PROFILE_FIELDS.name.max
  expect(draftError(draft({ name: 'n'.repeat(max) }))).toBeNull()
  expect(draftError(draft({ name: 'n'.repeat(max + 1) }))).toBe(
    'Display name must be at most 32 characters'
  )
  expect(draftError(draft({ name: '\u{1F600}'.repeat(max) }))).toBeNull()
  expect(draftError(draft({ bio: 'b'.repeat(PROFILE_FIELDS.bio.max) }))).toBeNull()
  expect(draftError(draft({ bio: 'b'.repeat(PROFILE_FIELDS.bio.max + 1) }))).toBe(
    'Description must be at most 190 characters'
  )
  expect(draftError(draft({ avatar: { kind: 'color', color: null } }))).toBe('Invalid avatar color')
  expect(bioLeft(draft({ bio: ' abc ' }))).toBe(PROFILE_FIELDS.bio.max - 3)
})

test('a hosted save sends only what changed, null for a part given back to the account', () => {
  const from = draft({ name: 'Captain', bio: 'Sails', banner: '#445566' })
  expect(patchOf(from, from)).toEqual({})
  expect(patchOf(from, draft({ ...from, name: 'Skipper' }))).toEqual({ name: 'Skipper' })
  expect(patchOf(from, draft())).toEqual({ name: null, bio: null, banner_color: null })
  expect(patchOf(draft(), draft({ avatar: { kind: 'color', color: '#112233' } }))).toEqual({
    avatar_kind: 'color',
    avatar_color: '#112233',
  })
  expect(patchOf(draft(), draft({ avatar: { kind: 'identicon', color: null } }))).toEqual({
    avatar_kind: 'identicon',
    avatar_color: null,
  })
  expect(patchOf(draft({ avatar: { kind: 'color', color: '#112233' } }), draft())).toEqual({
    avatar_kind: null,
  })
})

test('a room save writes the whole intent, without the parts left to the P2P profile', () => {
  expect(extrasOf(draft())).toEqual({})
  expect(
    extrasOf(
      draft({
        name: ' Captain ',
        bio: 'Sails',
        avatar: { kind: 'color', color: '#112233' },
        banner: '#445566',
      })
    )
  ).toEqual({
    nick: 'Captain',
    bio: 'Sails',
    av: { kind: 'color', bg: '#112233' },
    bn: '#445566',
  })
  expect(extrasOf(draft({ avatar: { kind: 'identicon', color: null } }))).toEqual({
    av: { kind: 'identicon' },
  })
  const kept = draft({ name: 'Captain', bio: 'Sails' })
  expect(draftOfExtras(extrasOf(kept))).toEqual(kept)
})

test('a mode without names leaves the name out of what is edited and shown', () => {
  const full = draft({ name: 'Captain', avatar: { kind: 'color', color: '#112233' } })
  expect(draftFor(full, true)).toBe(full)
  expect(draftFor(full, false)).toEqual({ ...full, name: '' })
  expect(draftLook(full, 'all')).toEqual({
    name: 'Captain',
    avatar_kind: 'color',
    avatar_color: '#112233',
  })
  expect(draftLook(full, 'no_names')?.name).toBeNull()
  expect(draftLook(full, 'all', false)?.name).toBeNull()
  expect(draftLook(full, 'off')).toBeNull()
  expect(draftLook(draft({ bio: 'Sails' }), 'all')).toBeNull()
})

test('the preview is the account under the draft', () => {
  expect(previewUser(alice, draft(), 'all')).toBe(alice)
  expect(previewUser(alice, draft({ name: 'Captain' }), 'all')).toEqual({
    ...alice,
    display_name: 'Captain',
  })
  expect(previewUser(alice, draft({ name: 'Captain' }), 'no_names')).toBe(alice)
  expect(previewUser(alice, draft({ avatar: { kind: 'identicon', color: null } }), 'all')).toEqual({
    ...alice,
    avatar_kind: 'identicon',
    avatar_color: null,
  })
})

test('your profile of a P2P server opens while you are in it, it takes writes and shows profiles', () => {
  const v = { me: 'join', readOnly: null, upgraded: false, profiles: 'all' as const }
  expect(editsRoomProfile(v)).toBe(true)
  expect(editsRoomProfile({ ...v, profiles: 'no_names' })).toBe(true)
  expect(editsRoomProfile({ ...v, profiles: 'off' })).toBe(false)
  expect(editsRoomProfile({ ...v, me: 'invite' })).toBe(false)
  expect(editsRoomProfile({ ...v, me: null })).toBe(false)
  expect(editsRoomProfile({ ...v, readOnly: 'Newer rules' })).toBe(false)
  expect(editsRoomProfile({ ...v, upgraded: true })).toBe(false)
})
