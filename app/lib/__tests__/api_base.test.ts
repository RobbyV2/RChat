import { describe, expect, test } from 'bun:test'
import { createApi, resolveApiBase } from '../api'
import { wsUrlFrom } from '../ws'

describe('resolveApiBase', () => {
  test('NEXT_PUBLIC_API_URL set, trailing slashes stripped', () => {
    expect(resolveApiBase('https://x.com//', false)).toBe('https://x.com/api')
  })

  test('url wins over window', () => {
    expect(resolveApiBase('https://x.com', true)).toBe('https://x.com/api')
  })

  test('unset with window -> relative', () => {
    expect(resolveApiBase(undefined, true)).toBe('/api')
  })

  test('unset without window -> host/port', () => {
    expect(resolveApiBase(undefined, false, 'srv', '9000')).toBe('http://srv:9000/api')
  })

  test('unset without window, no host/port -> defaults', () => {
    expect(resolveApiBase(undefined, false)).toBe('http://127.0.0.1:3000/api')
    expect(resolveApiBase(undefined, false, '', '')).toBe('http://127.0.0.1:3000/api')
  })
})

describe('wsUrlFrom', () => {
  test('https api base -> wss', () => {
    expect(wsUrlFrom('https://x.com')).toBe('wss://x.com/api/ws')
  })

  test('http api base with port -> ws', () => {
    expect(wsUrlFrom('http://x.com:3000')).toBe('ws://x.com:3000/api/ws')
  })

  test('gateway url wins over api base', () => {
    expect(wsUrlFrom('https://api.x.com', undefined, '', 'https://gw.x.com')).toBe(
      'wss://gw.x.com/api/ws'
    )
    expect(wsUrlFrom(undefined, { protocol: 'https:', host: 'h' }, '', 'ws://gw:4000')).toBe(
      'ws://gw:4000/api/ws'
    )
    expect(wsUrlFrom(undefined, undefined, '', 'wss://gw.x.com')).toBe('wss://gw.x.com/api/ws')
  })

  test('empty gateway url falls back', () => {
    expect(wsUrlFrom('http://x.com:3000', undefined, '', '')).toBe('ws://x.com:3000/api/ws')
  })

  test('no api base derives from location + basePath', () => {
    expect(wsUrlFrom(undefined, { protocol: 'https:', host: 'h:1' }, '/base')).toBe(
      'wss://h:1/base/api/ws'
    )
    expect(wsUrlFrom(undefined, { protocol: 'http:', host: 'h' })).toBe('ws://h/api/ws')
  })
})

describe('mediaUrl', () => {
  test('builds the media path without recursing', () => {
    expect(createApi('/api').mediaUrl('a b')).toBe('/api/media/a%20b')
  })

  test('a guest grant never goes into the URL; guests fetch with the header', async () => {
    const client = createApi('/api')
    client.setGrants({ s: 'g1', t: 'g2' })
    expect(client.mediaUrl('m')).toBe('/api/media/m')
    expect(client.guestMedia('s')).toBe(true)
    expect(client.guestMedia('u')).toBe(false)
    expect(client.guestMedia(undefined)).toBe(false)
    const real = globalThis.fetch
    const seen: [string, Record<string, string>][] = []
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      seen.push([String(input), (init?.headers ?? {}) as Record<string, string>])
      return new Response('x')
    }) as typeof fetch
    try {
      await client.mediaBlob('m', 's')
    } finally {
      globalThis.fetch = real
    }
    expect(seen).toEqual([['/api/media/m', { 'X-Guest-Grant': 'g1' }]])
    client.setToken('tok')
    expect(client.guestMedia('s')).toBe(false)
  })
})
