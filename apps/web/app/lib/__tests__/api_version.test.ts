import { afterEach, describe, expect, test } from 'bun:test'
import { apiRoot, apiTail, prefixOf, versionedBase, versionedUrl } from '../api_version'
import {
  InstanceConnection,
  InstanceRegistry,
  endpointsFrom,
  fetchInstance,
  type Endpoints,
} from '../instances'
import type { InstanceInfo } from '../types'

const g = globalThis as { WebSocket?: unknown }
const real = { fetch: globalThis.fetch, WebSocket: g.WebSocket }
afterEach(() => {
  globalThis.fetch = real.fetch
  g.WebSocket = real.WebSocket
})

const doc = (origin: string, versions?: unknown): InstanceInfo => {
  const url = new URL(origin)
  const ws = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return {
    software: 'rchat',
    id: `id-${url.host}`,
    name: url.host,
    host: url.host,
    version: '0.3.0',
    api_version: '1.1',
    public_url: origin,
    api_url: `${origin}/api`,
    ws_url: `${ws}//${url.host}/api/ws`,
    peerjs_url: `${origin}:9001/peerjs`,
    instance_url: `${origin}/api/instance`,
    jwks_uri: `${origin}/.well-known/jwks.json`,
    features: { guests: true, uploads: true, previews: true, identity_assertions: true },
    ...(versions === undefined ? {} : { api_versions: versions }),
  } as InstanceInfo
}

const jsonReply = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
const page = () =>
  new Response('<!DOCTYPE html><html><body>app</body></html>', {
    headers: { 'content-type': 'text/html; charset=utf-8' },
  })

// An instance as the published images run it (APP_MODE=full). A release from before versions
// sends every path that is not one of its routes to the web app: a GET is redirected to the path
// with a trailing slash and then answered with the app page; anything else gets 405.
const instance = (origin: string, versions: string[] | undefined, seen: string[] = []) => {
  const versioned = versions?.includes('v1') ?? false
  const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    const url = new URL(String(input))
    seen.push(`${method} ${url.pathname}`)
    const routed =
      url.pathname === '/.well-known/rchat' ||
      (url.pathname.startsWith('/api/') &&
        !url.pathname.endsWith('/') &&
        (versioned || !url.pathname.startsWith('/api/v1/')))
    if (routed) {
      const rest = url.pathname.replace(/^\/api(\/v1)?/, '')
      if (rest === '/instance' || url.pathname === '/.well-known/rchat')
        return jsonReply(doc(origin, versions))
      return jsonReply({ ok: true, at: url.pathname })
    }
    if (method !== 'GET') return new Response('Method Not Allowed', { status: 405 })
    if (url.pathname.endsWith('/')) return page()
    if (init?.redirect === 'manual')
      return new Response(null, { status: 308, headers: { location: `${url.pathname}/` } })
    seen.push(`GET ${url.pathname}/`)
    return page()
  }
  globalThis.fetch = fetcher as typeof fetch
  return { seen, fetcher }
}

const fixed = (origin: string): Endpoints => ({
  origin,
  api: '/api',
  url: () => 'ws://page/api/ws',
  probe: () => '/api/health',
  peer: () => ({ host: 'page', port: 9001, path: '/peerjs', secure: false }),
})

const registry = () => {
  const home = new InstanceConnection(fixed('https://page.example'), null, true)
  return new InstanceRegistry(home, () => fixed('https://page.example'))
}

class Dialed {
  static urls: string[] = []
  readyState = 0
  onopen = null
  onclose = null
  onerror = null
  onmessage = null
  constructor(url: string) {
    Dialed.urls.push(url)
  }
  send() {}
  close() {
    this.readyState = 3
  }
}

const dial = (conn: InstanceConnection) => {
  Dialed.urls = []
  g.WebSocket = Dialed
  conn.ws.start(null)
  conn.ws.stop()
  return Dialed.urls
}

describe('api paths', () => {
  test('the instance document says whether to call /api/v1', () => {
    expect(prefixOf(doc('https://x.example', ['v1']))).toBe('v1')
    expect(prefixOf(doc('https://x.example', ['v1', 'v2']))).toBe('v1')
    expect(prefixOf(doc('https://x.example'))).toBe('unversioned')
    for (const odd of ['v1', [1], ['V1'], ['v2'], null, {}])
      expect(prefixOf(doc('https://x.example', odd))).toBe('unversioned')
    expect(prefixOf(null)).toBe('unversioned')
  })

  test('roots, bases and pinned URLs', () => {
    expect(apiRoot('https://x.example/api/v1//')).toBe('https://x.example/api')
    expect(versionedBase('/api', 'v1')).toBe('/api/v1')
    expect(versionedBase('/api', 'unversioned')).toBe('/api')
    expect(versionedUrl('wss://x.example/api/ws', 'v1')).toBe('wss://x.example/api/v1/ws')
    expect(versionedUrl('wss://x.example/api/v1/ws', 'unversioned')).toBe('wss://x.example/api/ws')
    expect(versionedUrl('/base/api/health', 'v1')).toBe('/base/api/v1/health')
    expect(apiTail('/api/v1/servers/{name}')).toBe('/servers/{name}')
    expect(apiTail('/api/servers/{name}')).toBe('/servers/{name}')
    expect(apiTail('/api/v1')).toBeNull()
    expect(apiTail('/.well-known/rchat')).toBeNull()
  })
})

describe('instances from before versions', () => {
  test('a full-mode instance from before versions is never called on /api/v1', async () => {
    const { seen, fetcher } = instance('https://old.example', undefined)
    const info = await fetchInstance('https://old.example', fetcher)
    const conn = registry().add('https://old.example', info)
    await conn.api.getSettings()
    await conn.api.sendChannelMessage(1, 'hi')
    expect(conn.api.mediaUrl('m')).toBe('https://old.example/api/media/m')
    expect(dial(conn)).toEqual(['wss://old.example/api/ws'])
    expect(seen.filter(s => s.includes('/api/v1'))).toEqual([])
    expect(seen).toEqual([
      'GET /api/instance',
      'GET /api/settings',
      'POST /api/channels/1/messages',
    ])
  })

  test('a current instance is called on /api/v1, the socket and health check too', async () => {
    const { seen, fetcher } = instance('https://new.example', ['v1'])
    const info = await fetchInstance('https://new.example', fetcher)
    const conn = registry().add('https://new.example', info)
    await conn.api.getSettings()
    await conn.api.sendChannelMessage(1, 'hi')
    expect(dial(conn)).toEqual(['wss://new.example/api/v1/ws'])
    expect(conn.health()).toBe('https://new.example/api/v1/health')
    expect(seen).toEqual([
      'GET /api/instance',
      'GET /api/v1/settings',
      'POST /api/v1/channels/1/messages',
    ])
  })

  test('discovery takes only JSON and never follows a redirect into the app page', async () => {
    const seen: string[] = []
    const modes: (RequestRedirect | undefined)[] = []
    const fetcher = async (input: string, init?: RequestInit) => {
      const path = new URL(input).pathname
      seen.push(path)
      modes.push(init?.redirect)
      if (path === '/api/instance' && init?.redirect !== 'manual') return page()
      if (path === '/api/instance')
        return new Response(null, { status: 308, headers: { location: '/api/instance/' } })
      return jsonReply(doc('https://odd.example'))
    }
    expect((await fetchInstance('https://odd.example', fetcher)).id).toBe('id-odd.example')
    expect(seen).toEqual(['/api/instance', '/.well-known/rchat'])
    expect(modes).toEqual(['manual', 'manual'])

    const html = async (input: string) =>
      new URL(input).pathname === '/api/instance'
        ? new Response(JSON.stringify(doc('https://odd.example', ['v1'])), {
            headers: { 'content-type': 'text/html' },
          })
        : jsonReply(doc('https://odd.example'))
    expect((await fetchInstance('https://odd.example', html)).api_versions).toBeUndefined()
  })
})

describe('the choice follows the instance document', () => {
  test('a cached document decides at once; a fetched one changes it, nothing else does', async () => {
    const reg = registry()
    const cached = doc('https://flip.example', ['v1'])
    const conn = reg.add('https://flip.example', cached)
    expect(conn.api.base).toBe('https://flip.example/api/v1')

    const rolledBack = instance('https://flip.example', undefined)
    const realNow = Date.now
    Date.now = () => realNow() + 48 * 60 * 60 * 1000
    try {
      await conn.api.getSettings().catch(() => null)
    } finally {
      Date.now = realNow
    }
    expect(rolledBack.seen).toEqual(['GET /api/v1/settings', 'GET /api/v1/settings/'])

    const again = await fetchInstance('https://flip.example', rolledBack.fetcher)
    expect(reg.add('https://flip.example', again)).toBe(conn)
    expect(conn.api.base).toBe('https://flip.example/api')
    expect(dial(conn)).toEqual(['wss://flip.example/api/ws'])

    const upgraded = instance('https://flip.example', ['v1'])
    reg.add('https://flip.example', await fetchInstance('https://flip.example', upgraded.fetcher))
    await conn.api.getSettings()
    expect(upgraded.seen).toEqual(['GET /api/instance', 'GET /api/v1/settings'])
    expect(dial(conn)).toEqual(['wss://flip.example/api/v1/ws'])
  })

  test('re-homing takes the new document; a home without one uses /api', () => {
    const reg = registry()
    expect(reg.home.api.base).toBe('/api')
    reg.setHome('https://other.example', doc('https://other.example', ['v1']))
    expect(reg.home.api.base).toBe('https://other.example/api/v1')
    expect(dial(reg.home)).toEqual(['wss://other.example/api/v1/ws'])
    reg.home.info = doc('https://other.example')
    expect(reg.home.api.base).toBe('https://other.example/api')
    const fromCache = new InstanceConnection(
      endpointsFrom('https://c.example', doc('https://c.example', ['v1'])),
      doc('https://c.example', ['v1'])
    )
    expect(fromCache.api.base).toBe('https://c.example/api/v1')
  })
})
