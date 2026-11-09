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

  const text = (e: unknown) => (e instanceof Error ? e.message : String(e))

  const fetched = async (run: () => Promise<unknown>) => {
    const real = globalThis.fetch
    const seen: [string, Record<string, string>][] = []
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      seen.push([String(input), (init?.headers ?? {}) as Record<string, string>])
      return new Response('x')
    }) as typeof fetch
    try {
      await run()
    } finally {
      globalThis.fetch = real
    }
    return seen
  }

  test('an account fetches media and previews with its token, on any API origin', async () => {
    const client = createApi('https://chat.b.com/api')
    expect(client.signedIn()).toBe(false)
    client.setToken('tok')
    client.setGrants({ s: 'g1' })
    expect(client.signedIn()).toBe(true)
    const preview = client.previewUrl('/messages/7/embeds/0/image?v=ab')
    const seen = await fetched(async () => {
      const blob = await client.authedBlob(client.mediaUrl('m'), 's')
      expect(await blob.text()).toBe('x')
      await client.authedBlob(preview, undefined)
      await client.mediaBlob('m', 's')
    })
    const bearer = { Authorization: 'Bearer tok' }
    expect(seen).toEqual([
      ['https://chat.b.com/api/media/m', bearer],
      ['https://chat.b.com/api/messages/7/embeds/0/image?v=ab', bearer],
      ['https://chat.b.com/api/media/m', bearer],
    ])
  })

  test("only the address of one of the instance's media files gives a media id", () => {
    const own = createApi('/api')
    expect(own.mediaId('/api/media/abc')).toBe('abc')
    expect(own.mediaId('http://localhost/api/media/abc')).toBe('abc')
    expect(own.mediaId('/api/media/a%20b')).toBe('a b')
    expect(own.mediaId(own.mediaUrl('a b/c'))).toBe('a b/c')
    const other = createApi('https://chat.b.com/api')
    expect(other.mediaId('https://chat.b.com/api/media/abc')).toBe('abc')
    expect(other.mediaId(other.mediaUrl('x1'))).toBe('x1')
    for (const url of [
      '/api/media/abc',
      'https://chat.b.com/api/media/abc?v=1',
      'https://chat.b.com/api/media/abc#top',
      'https://chat.b.com/api/media/a/b',
      'https://chat.b.com/api/media/',
      'https://chat.b.com/api/media',
      'https://chat.b.com/api/media/../admin/users',
      'https://chat.b.com/api/messages/1/embeds/0/image',
      'https://chat.b.com/apix/media/abc',
      'https://chat.b.com/media/abc',
      'https://evil.example/api/media/abc',
      'https://chat.b.com/api/media/%E0%A4%A',
      'not a url at all://',
      '',
    ])
      expect([url, other.mediaId(url)]).toEqual([url, null])
  })

  test('on API v1 a media address with or without the version names the file', async () => {
    const v1 = createApi('https://chat.b.com/api')
    v1.prefix = 'v1'
    v1.setToken('tok')
    expect(v1.mediaUrl('m')).toBe('https://chat.b.com/api/v1/media/m')
    expect(v1.mediaId('https://chat.b.com/api/media/abc')).toBe('abc')
    expect(v1.mediaId('https://chat.b.com/api/v1/media/abc')).toBe('abc')
    expect(createApi('/api').mediaId('/api/v1/media/abc')).toBe('abc')
    for (const url of [
      'https://chat.b.com/api/v2/media/abc',
      'https://chat.b.com/api/v1/v1/media/abc',
      'https://chat.b.com/api/v1/media/abc?v=1',
      'https://chat.b.com/api/v1/media/a/b',
      'https://chat.b.com/api/v1x/media/abc',
    ])
      expect([url, v1.mediaId(url)]).toEqual([url, null])
    const bearer = { Authorization: 'Bearer tok' }
    expect(
      await fetched(async () => {
        await v1.authedBlob(v1.mediaUrl('m'))
        await v1.authedBlob(v1.previewUrl('/messages/7/embeds/0/image?v=ab'))
        await v1.mediaBlob('m')
      })
    ).toEqual([
      ['https://chat.b.com/api/v1/media/m', bearer],
      ['https://chat.b.com/api/v1/messages/7/embeds/0/image?v=ab', bearer],
      ['https://chat.b.com/api/v1/media/m', bearer],
    ])
    for (const url of [
      'https://evil.example/api/v1/media/m',
      'https://chat.b.com/apix/v1/media/m',
    ]) {
      let refused: string | null = null
      const seen = await fetched(() => v1.authedBlob(url).catch(e => (refused = text(e))))
      expect([url, seen, refused]).toEqual([url, [], 'Could not load the file'])
    }
  })

  test('a fetch that carries the token or a grant never follows a redirect', async () => {
    const client = createApi('https://chat.b.com/api')
    client.setToken('tok')
    const guest = createApi('https://chat.b.com/api')
    guest.setGrants({ s: 'g1' })
    const real = globalThis.fetch
    const seen: [string, RequestRedirect | undefined][] = []
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      seen.push([String(input), init?.redirect])
      if (init?.redirect !== 'error')
        return new Response(null, { status: 302, headers: { Location: 'https://cdn.example/m' } })
      throw new TypeError('Failed to fetch')
    }) as typeof fetch
    const failed = (p: Promise<unknown>) =>
      p.then(
        () => 'loaded',
        () => 'refused'
      )
    try {
      expect(await failed(client.authedBlob(client.mediaUrl('m')))).toBe('refused')
      expect(await failed(client.mediaBlob('m'))).toBe('refused')
      expect(await failed(client.mediaStart('m', undefined, 10))).toBe('refused')
      expect(await failed(guest.mediaBlob('m', 's'))).toBe('refused')
      expect(await failed(guest.mediaStart('m', 's', 10))).toBe('refused')
    } finally {
      globalThis.fetch = real
    }
    expect(seen.map(([, redirect]) => redirect)).toEqual(Array(5).fill('error'))
  })

  test('the token and grants never go to an address outside the API', async () => {
    const client = createApi('https://chat.b.com/api')
    client.setToken('tok')
    client.setGrants({ s: 'g1' })
    for (const url of [
      'https://evil.example/api/media/m',
      'https://chat.b.com.evil.example/api/media/m',
      'https://chat.b.com/apix/media/m',
      'https://chat.b.com/other',
      '/api/media/m',
      'https://chat.b.com/api/../media/m',
      'https://chat.b.com/api/media/%2e%2e/%2e%2e/x',
    ]) {
      let refused: string | null = null
      const seen = await fetched(() => client.authedBlob(url, 's').catch(e => (refused = text(e))))
      expect([url, seen, refused]).toEqual([url, [], 'Could not load the file'])
    }
    const own = createApi('/api')
    own.setGrants({ s: 'g1' })
    for (const url of ['https://evil.example/api/media/m', '//evil.example/api/media/m']) {
      let refused: string | null = null
      const seen = await fetched(() => own.authedBlob(url, 's').catch(e => (refused = text(e))))
      expect([url, seen, refused]).toEqual([url, [], 'Could not load the file'])
    }
    expect(await fetched(() => own.authedBlob('/api/media/m', 's'))).toEqual([
      ['/api/media/m', { 'X-Guest-Grant': 'g1' }],
    ])
  })
})
