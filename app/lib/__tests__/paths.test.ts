import { describe, expect, test } from 'bun:test'
import { parsePath, viewPath, type View } from '../store'

describe('viewPath / parsePath round-trips', () => {
  const cases: View[] = [
    { kind: 'channel', server: 'rchat', channelId: 1 },
    { kind: 'channel', server: 'my server', channelId: 42 },
    { kind: 'channel', server: 'a/b?c#d', channelId: 7 },
    { kind: 'dm', dmId: 9 },
  ]
  for (const view of cases) {
    test(JSON.stringify(view), () => {
      expect(parsePath(viewPath(view))).toEqual(view)
    })
  }

  test('null view maps to root and root parses to null', () => {
    expect(viewPath(null)).toBe('/')
    expect(parsePath('/')).toBeNull()
  })

  test('encoded server names decode exactly', () => {
    const path = viewPath({ kind: 'channel', server: 'café & co', channelId: 3 })
    expect(path).toBe('/s/caf%C3%A9%20%26%20co/3/')
    expect(parsePath(path)).toEqual({ kind: 'channel', server: 'café & co', channelId: 3 })
  })

  test('missing trailing slash still parses', () => {
    expect(parsePath('/s/rchat/5')).toEqual({ kind: 'channel', server: 'rchat', channelId: 5 })
    expect(parsePath('/dm/8')).toEqual({ kind: 'dm', dmId: 8 })
  })

  test('a server path without a channel targets the server', () => {
    expect(parsePath('/s/beta/')).toEqual({ kind: 'server', server: 'beta' })
    expect(parsePath('/s/beta')).toEqual({ kind: 'server', server: 'beta' })
    expect(parsePath('/s/caf%C3%A9%20%26%20co/')).toEqual({ kind: 'server', server: 'café & co' })
  })

  test('bad input returns null', () => {
    for (const bad of [
      '',
      '/login',
      '/s/rchat/abc',
      '/s/rchat/1/x',
      '/dm/',
      '/dm/x',
      '/s//1/',
      '/s/%/1/',
    ]) {
      expect(parsePath(bad)).toBeNull()
    }
  })
})
