import { describe, expect, test } from 'bun:test'
import {
  canDeleteChannel,
  canModerate,
  charCount,
  memberPerms,
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
