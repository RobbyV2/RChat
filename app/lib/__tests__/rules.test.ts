import { describe, expect, test } from 'bun:test'
import {
  PROFANITY_TARGETS,
  canDeleteChannel,
  canModerate,
  charCount,
  expiryText,
  mediaError,
  memberPerms,
  passwordDone,
  passwordPrompt,
  profanityTargetLocked,
  profanityTargetOn,
  sameOriginImage,
  serverInitial,
} from '../rules'
import { ALL_PERMS, Perm, type Channel } from '../types'

const ch = (id: number, kind: Channel['kind']): Channel => ({
  id,
  name: `c${id}`,
  kind,
  slowmode_seconds: 0,
})

describe('canDeleteChannel', () => {
  test('mirrors the server rule', () => {
    const text = ch(1, 'text')
    const voice = ch(2, 'voice')
    expect(canDeleteChannel([text], text)).toBe(false)
    expect(canDeleteChannel([text, voice], text)).toBe(false)
    expect(canDeleteChannel([text, voice], voice)).toBe(true)
    expect(canDeleteChannel([voice], voice)).toBe(false)
    expect(canDeleteChannel([text, ch(3, 'text')], text)).toBe(true)
  })
})

describe('memberPerms', () => {
  const roles = [
    { id: 1, perms: Perm.Kick },
    { id: 2, perms: Perm.ManageChannels },
  ]
  const row = (is_admin: boolean, perms: number, role_ids: number[] = []) => ({
    is_admin,
    perms,
    role_ids,
  })

  test('mirrors the server: admin perms 0 means all, roles only for non-admins', () => {
    expect(memberPerms(null, roles)).toBe(0)
    expect(memberPerms(undefined, roles)).toBe(0)
    expect(memberPerms(row(true, 0, [2]), roles)).toBe(ALL_PERMS)
    expect(memberPerms(row(true, Perm.Kick, [2]), roles)).toBe(Perm.Kick)
    expect(memberPerms(row(false, 0, [1, 2]), roles)).toBe(Perm.Kick | Perm.ManageChannels)
    expect(memberPerms(row(false, ALL_PERMS, [3]), roles)).toBe(0)
  })
})

describe('canModerate', () => {
  test('needs a strict superset of the target perms', () => {
    const kick = Perm.Kick
    const channels = Perm.ManageChannels
    expect(canModerate(kick, false, 0)).toBe(true)
    expect(canModerate(kick, false, kick)).toBe(false)
    expect(canModerate(kick, false, ALL_PERMS)).toBe(false)
    expect(canModerate(kick, false, channels)).toBe(false)
    expect(canModerate(kick | channels, false, channels)).toBe(true)
    expect(canModerate(kick | channels, false, kick)).toBe(true)
    expect(canModerate(ALL_PERMS, false, ALL_PERMS)).toBe(false)
    expect(canModerate(ALL_PERMS, false, ALL_PERMS & ~channels)).toBe(true)
  })

  test('site admins bypass the rule', () => {
    expect(canModerate(ALL_PERMS, true, ALL_PERMS)).toBe(true)
  })
})

describe('serverInitial', () => {
  test('uses the first grapheme', () => {
    expect(serverInitial('  party')).toBe('P')
    expect(serverInitial('😀 party')).toBe('😀')
    expect(serverInitial('👩‍💻 devs')).toBe('👩‍💻')
    expect(serverInitial('éclair')).toBe('É')
    expect(serverInitial('   ')).toBe('?')
  })
})

describe('charCount', () => {
  test('counts code points, not UTF-16 units', () => {
    expect(charCount('😀😀')).toBe(2)
    expect(charCount('abc')).toBe(3)
  })
})

describe('sameOriginImage', () => {
  const base = 'https://chat.example/s/rchat/1/'
  const origins = ['https://chat.example']
  test('only same-origin http(s) sources load', () => {
    expect(sameOriginImage('/api/media/abc', base, origins)).toBe(true)
    expect(sameOriginImage('https://chat.example/x.png', base, origins)).toBe(true)
    expect(sameOriginImage('https://evil.example/x.png', base, origins)).toBe(false)
    expect(sameOriginImage('//evil.example/x.png', base, origins)).toBe(false)
    expect(sameOriginImage('data:image/png;base64,AAAA', base, origins)).toBe(false)
    expect(sameOriginImage(undefined, base, origins)).toBe(false)
    expect(sameOriginImage('http://[bad', base, origins)).toBe(false)
  })
})

describe('expiryText', () => {
  test('a freshly posted one-day file reads 1 day, not 24 hours', () => {
    expect(expiryText(86400)).toBe('Expires in 1 day')
    expect(expiryText(86390)).toBe('Expires in 1 day')
    expect(expiryText(84600)).toBe('Expires in 1 day')
    expect(expiryText(84500)).toBe('Expires in 23 hours')
  })

  test('picks the largest unit that rounds to at least one', () => {
    expect(expiryText(7 * 86400)).toBe('Expires in 7 days')
    expect(expiryText(3600)).toBe('Expires in 1 hour')
    expect(expiryText(3599)).toBe('Expires in 1 hour')
    expect(expiryText(90)).toBe('Expires in 2 minutes')
    expect(expiryText(59.6)).toBe('Expires in 1 minute')
    expect(expiryText(12)).toBe('Expires in 12 seconds')
    expect(expiryText(0)).toBe('Expired')
  })
})

describe('mediaError', () => {
  const named = (name: string) => Object.assign(new Error('Permission denied'), { name })
  test('maps permission and device errors to friendly text', () => {
    expect(mediaError(named('NotAllowedError'), 'microphone', 'join voice').message).toBe(
      'Allow microphone access to join voice'
    )
    expect(mediaError(named('NotFoundError'), 'camera', 'turn on video').message).toBe(
      'No camera found'
    )
    expect(mediaError(named('NotReadableError'), 'microphone', 'call').message).toBe(
      'Your microphone is busy in another app'
    )
  })

  test('keeps other errors as they are', () => {
    const other = named('AbortError')
    expect(mediaError(other, 'microphone', 'call')).toBe(other)
    expect(mediaError('boom', 'microphone', 'call').message).toBe('boom')
  })
})

describe('passwordPrompt', () => {
  const values = (p: ReturnType<typeof passwordPrompt>) => p.choices.map(c => c.value)

  test('names the change and defaults to keeping everyone', () => {
    expect(passwordPrompt(false, 'pw', true, false).title).toBe('Set Password')
    expect(passwordPrompt(true, 'pw', true, false).title).toBe('Change Password')
    const clear = passwordPrompt(true, '', true, false)
    expect([clear.title, clear.confirm]).toEqual(['Clear Password', 'Clear'])
    expect(clear.body).toBe('Anyone will be able to join with the server name.')
    expect(values(clear)).toEqual(['keep', 'remove'])
    expect(clear.choices.map(c => c.danger)).toEqual([false, true])
  })

  test('hides removal without the kick permission', () => {
    expect(values(passwordPrompt(true, 'pw', false, false))).toEqual(['keep'])
  })

  test('explains who stays', () => {
    const change = passwordPrompt(true, 'pw', true, false)
    expect(change.choices[0].detail).toBe(
      'Current members stay. Guests who entered the old password lose access unless you also keep guest access.'
    )
    expect(change.choices[1].detail).toBe(
      'Other members are removed, not banned, and can rejoin with the new password. Guests who entered the old password lose access. Members with equal or higher permissions stay.'
    )
    expect(passwordPrompt(false, 'pw', true, false).choices[0].detail).toBe('Current members stay.')
    expect(passwordPrompt(true, '', true, true).choices[1].detail).toBe(
      'Other members are removed, not banned, and can rejoin.'
    )
  })
})

describe('passwordDone', () => {
  test('summarizes the counts', () => {
    expect(passwordDone('Change', 'keep', 0, 4)).toBe('Password changed. Everyone stayed.')
    expect(passwordDone('Set', 'remove', 3, 1)).toBe(
      'Password set. Removed 3 members. 1 member with equal or higher permissions stayed.'
    )
    expect(passwordDone('Clear', 'remove', 1, 0)).toBe('Password cleared. Removed 1 member.')
    expect(passwordDone('Change', 'remove', 0, 2)).toBe(
      'Password changed. No one was removed. 2 members with equal or higher permissions stayed.'
    )
  })
})

describe('profanity targets', () => {
  const all = {
    messages: true,
    links: true,
    usernames: true,
    server_names: true,
    channel_names: true,
    role_names: true,
    file_names: true,
    bios: true,
  }

  test('lists every target once', () => {
    expect(PROFANITY_TARGETS.map(t => t.key as string).sort()).toEqual(Object.keys(all).sort())
  })

  test('reads stored values and defaults missing ones on', () => {
    const settings = { profanity_filter: true, profanity_targets: { ...all, role_names: false } }
    expect(profanityTargetOn(settings, 'role_names')).toBe(false)
    expect(profanityTargetOn(settings, 'messages')).toBe(true)
    expect(profanityTargetOn({ profanity_filter: true }, 'file_names')).toBe(true)
  })

  test('locks every target while the filter is off and links while messages are off', () => {
    for (const { key } of PROFANITY_TARGETS) {
      expect(profanityTargetLocked({ profanity_filter: false, profanity_targets: all }, key)).toBe(
        true
      )
      expect(profanityTargetLocked({ profanity_filter: true, profanity_targets: all }, key)).toBe(
        false
      )
    }
    const noMessages = { profanity_filter: true, profanity_targets: { ...all, messages: false } }
    expect(profanityTargetLocked(noMessages, 'links')).toBe(true)
    expect(profanityTargetLocked(noMessages, 'messages')).toBe(false)
    expect(profanityTargetLocked(noMessages, 'usernames')).toBe(false)
  })
})
