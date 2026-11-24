import { describe, expect, test } from 'bun:test'
import table from '../../../../../assets/profile_fields.json'
import { PROFILE_FIELDS } from '../profile_fields'
import {
  changedParts,
  FOREVER,
  LOCK_CHOICES,
  RESET_FIELDS,
  RESET_LABELS,
  hiddenFields,
  isLockSecs,
  isResetField,
  lockLine,
  lockState,
  lockUntil,
  partOf,
  resetBody,
  resetContent,
  resetContentOk,
  resetFields,
  resetUntil,
  roomLock,
  settleIntent,
  shownExtras,
  shownRoomProfile,
  unlockContent,
  withoutFields,
  type ResetFact,
  type ResetField,
} from '../profile_reset'

const NOW = 1_700_000_000

describe('the reset fields and lock choices', () => {
  test('are the shared table', () => {
    expect<string[]>([...RESET_FIELDS]).toEqual(table.reset_fields)
    expect<number[]>([...PROFILE_FIELDS.lock_secs]).toEqual(table.lock_secs)
    expect<(number | null)[]>(LOCK_CHOICES.map(c => c.secs)).toEqual([null, ...table.lock_secs])
    expect(Object.keys(RESET_LABELS)).toEqual(table.reset_fields)
    expect(LOCK_CHOICES.map(c => c.label)).toEqual([
      'No lock',
      '1 day',
      '7 days',
      '30 days',
      'Until unlocked',
    ])
  })

  test('only known fields and choices pass', () => {
    expect(RESET_FIELDS.every(isResetField)).toBe(true)
    expect(isResetField('pronouns')).toBe(false)
    expect([null, 86400, 604800, 2592000, -1].every(isLockSecs)).toBe(true)
    expect([0, 60, -2, '86400', undefined].some(isLockSecs)).toBe(false)
  })

  test('a hosted request lists the fields in table order and leaves out what is not set', () => {
    expect(resetBody(['avatar', 'name'], null, '  ')).toEqual({ fields: ['name', 'avatar'] })
    expect(resetBody([], -1, ' spam ')).toEqual({ fields: [], lock_secs: -1, reason: 'spam' })
  })
})

describe('a lock', () => {
  test('ends a chosen time from now, or never by itself', () => {
    expect(lockUntil(null, NOW)).toBeNull()
    expect(lockUntil(86400, NOW)).toBe(NOW + 86400)
    expect(lockUntil(-1, NOW)).toBe(FOREVER)
  })

  test('runs until its end on the reader clock', () => {
    expect(lockState(null, NOW)).toEqual({ locked: false })
    expect(lockState(undefined, NOW)).toEqual({ locked: false })
    expect(lockState(0, NOW)).toEqual({ locked: false })
    expect(lockState(NOW, NOW)).toEqual({ locked: false })
    expect(lockState(NOW + 1, NOW)).toEqual({ locked: true, until: NOW + 1 })
    expect(lockState(FOREVER, NOW)).toEqual({ locked: true, until: null })
  })

  test('a hosted lock with no end reads as one, whatever JSON made of the number', () => {
    const sent = JSON.parse('{"locked_until":9223372036854775807}') as { locked_until: number }
    expect(lockState(sent.locked_until, NOW)).toEqual({ locked: true, until: null })
  })

  test('tells its member when they can edit again', () => {
    const when = (until: number) => `t${until - NOW}`
    expect(lockLine({ locked: false }, when)).toBeNull()
    expect(lockLine({ locked: true, until: NOW + 5 }, when)).toBe(
      'A moderator reset your server profile. You can edit it again after t5, or once a moderator unlocks it.'
    )
    expect(lockLine({ locked: true, until: null }, when)).toBe(
      'A moderator reset your server profile. You can edit it again once a moderator unlocks it.'
    )
  })
})

describe('the content of a room reset', () => {
  test('lists every field when it has no list, and only the ones it knows otherwise', () => {
    expect(resetFields(undefined)).toEqual(['name', 'bio', 'avatar', 'banner'])
    expect(resetFields([])).toEqual([])
    expect(resetFields(['banner', 'pronouns', 7, 'name', 'name'])).toEqual(['name', 'banner'])
    for (const bad of ['name', null, 7, { 0: 'name' }]) expect(resetFields(bad)).toBeUndefined()
  })

  test('carries a lock end in whole seconds, or none', () => {
    expect(resetUntil(undefined)).toBeNull()
    expect(resetUntil(0)).toBe(0)
    expect(resetUntil(NOW)).toBe(NOW)
    expect(resetUntil(FOREVER)).toBe(FOREVER)
    for (const bad of [-1, 1.5, '5', null, Infinity, FOREVER + 2])
      expect(resetUntil(bad)).toBeUndefined()
  })

  test('is well formed only with a member and readable fields', () => {
    expect(resetContentOk({ to: 'A' })).toBe(true)
    expect(resetContentOk({ to: 'A', fields: ['name'], until: 5, later: true } as never)).toBe(true)
    expect(resetContentOk({ fields: ['name'] })).toBe(false)
    expect(resetContentOk({ to: 'A', fields: 'name' })).toBe(false)
    expect(resetContentOk({ to: 'A', until: -5 })).toBe(false)
  })

  test('a moderator signs the fields, and a lock end only with a lock', () => {
    expect(resetContent('A', ['bio', 'name'], null, NOW)).toEqual({
      to: 'A',
      fields: ['name', 'bio'],
    })
    expect(resetContent('A', [], 604800, NOW)).toEqual({ to: 'A', fields: [], until: NOW + 604800 })
    expect(resetContent('A', ['name'], -1, NOW)).toEqual({
      to: 'A',
      fields: ['name'],
      until: FOREVER,
    })
    expect(unlockContent('A')).toEqual({ to: 'A', fields: [], until: 0 })
    expect(resetContentOk(unlockContent('A'))).toBe(true)
  })
})

describe('what the resets of a room profile hide', () => {
  const extras = {
    nick: 'Ali',
    bio: 'here',
    av: { kind: 'color' as const, bg: '#aa0000' },
    bn: '#112233',
  }

  test('nothing without a reset', () => {
    expect(hiddenFields(undefined, NOW)).toEqual([])
    expect(shownExtras(extras, null, NOW)).toEqual(extras)
  })

  test('the hidden parts, each on its own', () => {
    expect(withoutFields(extras, ['name'])).toEqual({ bio: 'here', av: extras.av, bn: '#112233' })
    expect(withoutFields(extras, ['avatar', 'banner'])).toEqual({ nick: 'Ali', bio: 'here' })
    expect(withoutFields(extras, [...RESET_FIELDS])).toEqual({})
    expect(extras.nick).toBe('Ali')
  })

  test('a running lock hides its parts whenever they were written, and an ended one nothing', () => {
    const reset: ResetFact = {
      last: 'r1',
      hide: ['bio'],
      lock: { until: NOW + 10, fields: ['name'] },
    }
    expect(hiddenFields(reset, NOW)).toEqual(['name', 'bio'])
    expect(shownExtras(extras, reset, NOW)).toEqual({ av: extras.av, bn: '#112233' })
    expect(roomLock(reset, NOW)).toEqual({ locked: true, until: NOW + 10 })
    expect(hiddenFields(reset, NOW + 10)).toEqual(['bio'])
    expect(roomLock(reset, NOW + 10)).toEqual({ locked: false })
    expect(roomLock({ last: 'r2', hide: [] }, NOW)).toEqual({ locked: false })
  })

  test('a member shows without the hidden parts, under the room mode', () => {
    const m = {
      joinId: 'j1',
      profile: { name: 'Al', ...extras, in: 'j1' },
      reset: { last: 'r1', hide: ['name', 'banner'] } as ResetFact,
    }
    expect(shownRoomProfile(m, 'all', NOW * 1000)).toEqual({
      look: { name: null, avatar_kind: 'color', avatar_color: '#aa0000' },
      bio: 'here',
      banner: null,
    })
    expect(shownRoomProfile({ ...m, reset: undefined }, 'all', NOW * 1000).look?.name).toBe('Ali')
    expect(shownRoomProfile(m, 'off', NOW * 1000)).toEqual({ look: null, bio: null, banner: null })
    const locked = {
      ...m,
      reset: { last: 'r1', hide: [], lock: { until: NOW + 1, fields: ['name'] } },
    }
    expect(shownRoomProfile(locked as never, 'all', NOW * 1000).look?.name).toBeNull()
    expect(shownRoomProfile(locked as never, 'all', (NOW + 1) * 1000).look?.name).toBe('Ali')
  })
})

describe('the parts of room extras', () => {
  const extras = {
    nick: 'Ali',
    bio: 'here',
    av: { kind: 'color' as const, bg: '#aa0000' },
    bn: '#112233',
  }

  test('compare by value, an avatar by its kind and color', () => {
    expect(RESET_FIELDS.map(f => partOf(extras, f))).toEqual([
      'Ali',
      'here',
      'color #aa0000',
      '#112233',
    ])
    expect(partOf({ av: { kind: 'identicon' } }, 'avatar')).toBe('identicon ')
    expect(partOf({}, 'name')).toBeUndefined()
  })

  test('a part changed when it is set to another value', () => {
    expect(changedParts(extras, extras)).toEqual([])
    expect(changedParts({ ...extras, av: { kind: 'color', bg: '#aa0000' } }, extras)).toEqual([])
    expect(
      changedParts({ ...extras, nick: 'Sly', av: { kind: 'color', bg: '#bb0000' } }, extras)
    ).toEqual(['name', 'avatar'])
    expect(changedParts({ bio: 'here' }, extras)).toEqual([])
    expect(changedParts(extras, {})).toEqual([...RESET_FIELDS])
  })
})

describe('what our device sets for itself under the resets of a room', () => {
  const mine = { nick: 'Ali', bio: 'here', bn: '#112233' }
  const reset = (hide: ResetField[]): ResetFact => ({ last: 'r1', hide })

  test('a part a reset cleared from our write goes aside, once', () => {
    const first = settleIntent(mine, {}, mine, reset(['name', 'banner']))
    expect(first).toEqual({ intent: { bio: 'here' }, gone: { nick: 'Ali', bn: '#112233' } })
    expect(settleIntent(mine, {}, mine, reset([]))).toBeNull()
    expect(settleIntent(mine, {}, mine, undefined)).toBeNull()
    if (!first) return
    expect(settleIntent(first.intent, first.gone, mine, reset(['name', 'banner']))).toBeNull()
    expect(
      settleIntent(first.intent, first.gone, { bio: 'here' }, reset(['name', 'banner']))
    ).toBeNull()
  })

  test('a value we set that the room does not show yet stays', () => {
    expect(settleIntent({ ...mine, nick: 'Sly' }, {}, mine, reset(['name']))).toBeNull()
    expect(settleIntent({ bio: 'new' }, {}, mine, reset(['bio']))).toBeNull()
  })

  test('a part comes back once no reset clears it, unless it was set again', () => {
    const gone = { nick: 'Ali' }
    expect(settleIntent({ bio: 'here' }, gone, { bio: 'here' }, undefined)).toEqual({
      intent: { bio: 'here', nick: 'Ali' },
      gone: {},
    })
    expect(settleIntent({ bio: 'here' }, gone, { bio: 'here' }, reset(['bio']))).toEqual({
      intent: { nick: 'Ali' },
      gone: { bio: 'here' },
    })
    expect(settleIntent({ nick: 'Bo' }, gone, { nick: 'Bo' }, undefined)).toEqual({
      intent: { nick: 'Bo' },
      gone: {},
    })
    expect(settleIntent({ bio: 'here' }, gone, { nick: 'Sly', bio: 'here' }, undefined)).toEqual({
      intent: { bio: 'here' },
      gone: {},
    })
    expect(settleIntent({ bio: 'here' }, gone, { bio: 'here' }, reset(['name']))).toBeNull()
  })
})
