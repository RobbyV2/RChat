import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  InstanceConnection,
  InstanceError,
  InstanceRegistry,
  apiMajor,
  compatible,
  endpointsFrom,
  fetchInstance,
  home,
  normalizeOrigin,
  peerFrom,
  readKnown,
  rememberInstance,
  resolveInstance,
  savedHome,
  validInfo,
  fitsHome,
  fromOrigin,
  privateHost,
  remoteAllowed,
  sameSite,
  type Endpoints,
  type StorageLike,
} from '../instances'
import { ApiClient, createApi } from '../api'
import type { InstanceInfo } from '../types'

const info = (over: Partial<InstanceInfo> = {}): InstanceInfo => ({
  software: 'rchat',
  id: 'abc123',
  name: 'Lobby',
  host: 'chat.example.com',
  version: '0.2.0',
  api_version: '1.0',
  public_url: 'https://chat.example.com',
  api_url: 'https://chat.example.com/api',
  ws_url: 'wss://chat.example.com/api/ws',
  peerjs_url: 'https://chat.example.com:9001/peerjs',
  instance_url: 'https://chat.example.com/api/instance',
  jwks_uri: 'https://chat.example.com/.well-known/jwks.json',
  features: { guests: true, uploads: true, previews: true, identity_assertions: true },
  limits: {
    message_chars: 4000,
    name_chars: 100,
    upload_bytes: 26214400,
    media_retention_secs: 86400,
    page_size: 50,
    assertion_ttl_secs: 300,
  },
  ...over,
})

const at = (origin: string, over: Partial<InstanceInfo> = {}) => {
  const url = new URL(origin)
  const ws = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return info({
    host: url.host,
    public_url: origin,
    api_url: `${origin}/api`,
    ws_url: `${ws}//${url.host}/api/ws`,
    peerjs_url: `${url.protocol}//${url.hostname}:9001/peerjs`,
    ...over,
  })
}

const memory = (): StorageLike & { data: Map<string, string> } => {
  const data = new Map<string, string>()
  return {
    data,
    getItem: k => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: k => void data.delete(k),
  }
}

const rejection = async (p: Promise<unknown>) => {
  try {
    await p
    return null
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

describe('instance addresses', () => {
  test('normalizeOrigin accepts hosts and URLs and keeps only the origin', () => {
    expect(normalizeOrigin('chat.example.com')).toBe('https://chat.example.com')
    expect(normalizeOrigin(' https://Chat.Example.com/invite/x/?password=y ')).toBe(
      'https://chat.example.com'
    )
    expect(normalizeOrigin('localhost:3811')).toBe('http://localhost:3811')
    expect(normalizeOrigin('127.0.0.1:3811/x')).toBe('http://127.0.0.1:3811')
    expect(normalizeOrigin('http://chat.example.com:80')).toBe('http://chat.example.com')
    expect(normalizeOrigin('')).toBeNull()
    expect(normalizeOrigin('ftp://x.example')).toBeNull()
    expect(normalizeOrigin('https://u:p@x.example')).toBeNull()
    expect(normalizeOrigin('javascript:alert(1)')).toBeNull()
  })

  test('discovery documents are validated and versions checked by major', () => {
    expect(validInfo(info())).toBe(true)
    expect(validInfo({ ...info(), software: 'other' })).toBe(false)
    expect(validInfo({ ...info(), api_url: 'javascript:x' })).toBe(false)
    expect(validInfo({ ...info(), ws_url: 'https://x' })).toBe(false)
    expect(validInfo(null)).toBe(false)
    expect(apiMajor('1.7')).toBe(1)
    expect(compatible(info({ api_version: '1.9' }))).toBe(true)
    expect(compatible(info({ api_version: '2.0' }))).toBe(false)
  })

  test('endpoints come from the discovery document with origin fallbacks', () => {
    const ends = endpointsFrom('https://chat.example.com', info({ api_url: 'https://api.x/api/' }))
    expect(ends.api).toBe('https://api.x/api')
    expect(ends.url()).toBe('wss://chat.example.com/api/ws')
    expect(ends.probe()).toBe('https://api.x/api/health')
    expect(ends.peer()).toEqual({
      host: 'chat.example.com',
      port: 9001,
      path: '/peerjs',
      secure: true,
    })
    const bare = endpointsFrom('http://127.0.0.1:3811', null)
    expect(bare.api).toBe('http://127.0.0.1:3811/api')
    expect(bare.url()).toBe('ws://127.0.0.1:3811/api/ws')
    expect(peerFrom('https://p.example/peerjs/', 'https://x')).toEqual({
      host: 'p.example',
      port: 443,
      path: '/peerjs',
      secure: true,
    })
    expect(peerFrom(undefined, 'http://h:1')).toEqual({
      host: 'h',
      port: 9001,
      path: '/peerjs',
      secure: false,
    })
  })
})

describe('runtime instance resolution', () => {
  test('documents must name the origin they were fetched from', async () => {
    const real = 'https://evil.example'
    expect(fromOrigin(real, at(real))).toBe(true)
    expect(fromOrigin('https://Evil.example:443', at(real))).toBe(true)
    expect(fromOrigin(real, at(real, { host: 'bank.example' }))).toBe(false)
    expect(fromOrigin(real, at(real, { public_url: 'https://bank.example' }))).toBe(false)
    expect(fromOrigin(real, at(real, { public_url: 'http://evil.example' }))).toBe(false)
    expect(fromOrigin(real, at(real, { host: 'evil.example:8443' }))).toBe(false)
    expect(fromOrigin(real, at(real, { public_url: 'nope' }))).toBe(false)
    expect(validInfo(at(real), real)).toBe(true)
    expect(validInfo(at(real, { host: 'bank.example' }), real)).toBe(false)
    expect(validInfo({ ...at(real), host: 7 })).toBe(false)
    expect(validInfo({ ...at(real), public_url: 'javascript:x' })).toBe(false)
    for (const over of [{ host: 'bank.example' }, { public_url: 'https://bank.example' }])
      expect(await rejection(fetchInstance(real, async () => json(at(real, over))))).toBe(
        'evil.example claims to be another site'
      )
    expect(
      await rejection(
        resolveInstance('evil.example', async () =>
          json(at(real, { host: 'bank.example', api_version: '9.0' }))
        )
      )
    ).toBe('evil.example claims to be another site')
    expect(
      await rejection(
        resolveInstance('evil.example', async () => json(at(real, { api_version: '9.0' })))
      )
    ).toBe('evil.example needs a newer RChat client (API 9.0)')
  })

  test('fetches /api/instance and falls back to /.well-known/rchat', async () => {
    const asked: string[] = []
    const fetcher = async (url: string) => {
      asked.push(url)
      return url.endsWith('/.well-known/rchat') ? json(info()) : json({ error: 'nope' }, 404)
    }
    expect((await fetchInstance('https://chat.example.com', fetcher)).id).toBe('abc123')
    expect(asked).toEqual([
      'https://chat.example.com/api/instance',
      'https://chat.example.com/.well-known/rchat',
    ])
  })

  test('resolve normalizes, validates and explains failures', async () => {
    const ok = await resolveInstance('chat.example.com/', async () => json(info()))
    expect(ok.origin).toBe('https://chat.example.com')
    expect(ok.info.name).toBe('Lobby')
    expect(await rejection(resolveInstance('  ', async () => json(info())))).toBe(
      'Enter an instance address, like chat.example.com'
    )
    expect(await rejection(resolveInstance('x.example', async () => json({ hi: 1 })))).toBe(
      'No RChat instance at x.example'
    )
    expect(
      await rejection(
        resolveInstance('x.example', async () => {
          throw new TypeError('offline')
        })
      )
    ).toBe("Can't reach x.example")
    expect(
      await rejection(
        resolveInstance('chat.example.com', async () => json(info({ api_version: '2.1' })))
      )
    ).toBe('chat.example.com needs a newer RChat client (API 2.1)')
    expect(
      await rejection(
        resolveInstance('chat.example.com', async () => json(info({ api_version: '0.9' })))
      )
    ).toBe("chat.example.com runs an older RChat API (0.9) this client can't use")
  })

  test('known instances and the saved home persist in storage', () => {
    const store = memory()
    expect(savedHome('https://page.example', store)).toBe('https://page.example')
    store.setItem('rchat_home', 'chat.example.com')
    expect(savedHome('https://page.example', store)).toBe('https://chat.example.com')
    rememberInstance('https://a.example', at('https://a.example', { id: 'a' }), store)
    rememberInstance('https://b.example', at('https://b.example', { id: 'b' }), store)
    rememberInstance('https://a.example', at('https://a.example', { id: 'a2' }), store)
    rememberInstance('https://c.example', info({ id: 'c' }), store)
    const known = readKnown(store)
    expect(Object.keys(known)).toEqual(['https://a.example', 'https://b.example'])
    expect(known['https://a.example'].id).toBe('a2')
    rememberInstance('https://d.example', at('https://e.example'), store)
    expect(Object.keys(readKnown(store))).toEqual(['https://a.example', 'https://b.example'])
    store.setItem('rchat_instances', '{"https://x":{"software":"evil"},"broken":1}')
    expect(readKnown(store)).toEqual({})
    store.setItem('rchat_instances', 'not json')
    expect(readKnown(store)).toEqual({})
  })
})

const fixed = (origin: string): Endpoints => ({
  origin,
  api: '/api',
  url: () => 'ws://page/api/ws',
  probe: () => '/api/health',
  peer: () => ({ host: 'page', port: 9001, path: '/peerjs', secure: false }),
})

describe('instance origin checks', () => {
  test('an instance must keep its api, ws and peer endpoints on its own site', async () => {
    const origin = 'https://chat.example.com'
    expect(sameSite(origin, info())).toBe(true)
    expect(sameSite('http://127.0.0.1:3821', at('http://127.0.0.1:3821'))).toBe(true)
    for (const over of [
      { api_url: 'https://api.chat.example.com/api' },
      { api_url: 'http://chat.example.com/api' },
      { api_url: 'https://chat.example.com:8443/api' },
      { api_url: 'https://10.0.0.5/api' },
      { ws_url: 'ws://chat.example.com/api/ws' },
      { ws_url: 'wss://ws.chat.example.com/api/ws' },
      { ws_url: 'wss://chat.example.com:444/api/ws' },
      { peerjs_url: 'https://192.168.1.1:9001/peerjs' },
    ])
      expect(sameSite(origin, info(over))).toBe(false)
    expect(sameSite('http://127.0.0.1:3821', at('http://127.0.0.1:3831'))).toBe(false)
    expect(
      await rejection(
        resolveInstance('chat.example.com', async () =>
          json(info({ api_url: 'http://intranet.local/api' }))
        )
      )
    ).toBe('chat.example.com advertises endpoints on another site')
    expect(await rejection(resolveInstance('x.example', async () => json(info())))).toBe(
      'x.example claims to be another site'
    )
  })

  test('the default home ignores its advertised endpoints, others must match', () => {
    const page = new InstanceConnection(fixed('https://page.example'), null, true)
    const other = new InstanceConnection(endpointsFrom('https://b.example', null), null)
    expect(fitsHome(info(), page)).toBe(true)
    expect(fitsHome(info(), other)).toBe(false)
    expect(fitsHome(at('https://b.example'), other)).toBe(true)
    expect(fitsHome(at('https://b.example', { host: 'c.example' }), other)).toBe(false)
  })

  test('private and loopback hosts are recognized', () => {
    for (const host of [
      'localhost',
      'LOCALHOST.',
      'app.localhost',
      'printer.local',
      '127.0.0.1',
      '127.9.9.9',
      '10.1.2.3',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.0.10',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '[::1]',
      '[::]',
      '[fc00::1]',
      '[fd12:3456::1]',
      '[fe80::1]',
      '[febf::1]',
      '[::ffff:7f00:1]',
      '[::ffff:10.0.0.1]',
      new URL('http://0x7f.1/').hostname,
      new URL('http://[::ffff:192.168.1.1]/').hostname,
    ])
      expect(privateHost(host)).toBe(true)
    for (const host of [
      'chat.example.com',
      'local.example',
      '8.8.8.8',
      '172.32.0.1',
      '100.128.0.1',
      '[2001:db8::1]',
      '[fec0::1]',
      '[::ffff:808:808]',
    ])
      expect(privateHost(host)).toBe(false)
  })

  test('remote invites need https and a public host unless home is local', () => {
    const prod = 'https://chat.example.com'
    const dev = 'http://127.0.0.1:3821'
    expect(remoteAllowed('https://b.example', prod)).toBe(true)
    expect(remoteAllowed('https://b.example:8443', prod)).toBe(true)
    for (const origin of [
      'http://b.example',
      'https://127.0.0.1:3831',
      'http://127.0.0.1:3831',
      'https://localhost',
      'https://10.0.0.5',
      'https://192.168.1.4',
      'https://[::1]:3000',
      'https://[fd00::2]',
      'https://nas.local',
      'ftp://b.example',
      'nonsense',
    ])
      expect(remoteAllowed(origin, prod)).toBe(false)
    expect(remoteAllowed('http://127.0.0.1:3831', dev)).toBe(true)
    expect(remoteAllowed('https://192.168.1.4', dev)).toBe(true)
    expect(remoteAllowed('https://b.example', dev)).toBe(true)
    expect(remoteAllowed('http://b.example', dev)).toBe(false)
    expect(remoteAllowed('http://localhost:3831', 'http://localhost:3000')).toBe(true)
  })
})

describe('instance registry', () => {
  test('api clients trim trailing slashes from their base', () => {
    expect(new InstanceConnection(fixed('https://p.example'), null, true).api.base).toBe('/api')
    expect(createApi('https://p.example/api///').base).toBe('https://p.example/api')
    expect(new ApiClient('https://p.example/api/').base).toBe('https://p.example/api')
  })

  test('the home instance is the default one and scopes nothing', () => {
    const conn = new InstanceConnection(fixed('https://page.example'), null, true)
    expect(conn.host).toBe('page.example')
    expect(conn.name).toBe('RChat')
    expect(conn.scoped('rchat_token')).toBe('rchat_token')
    expect(conn.api.base).toBe('/api')
  })

  test('add, get, remove and re-home keep one client per instance', () => {
    const conn = new InstanceConnection(fixed('https://page.example'), null, true)
    const registry = new InstanceRegistry(conn, () => fixed('https://page.example'))
    expect(registry.get('page.example')).toBe(conn)
    const other = registry.add('https://Other.example/invite/x/', info({ id: 'o' }))
    expect(other.origin).toBe('https://other.example')
    expect(other.api.base).toBe('https://chat.example.com/api')
    expect(registry.add('other.example')).toBe(other)
    expect(registry.list()).toHaveLength(2)
    expect(registry.byHost('OTHER.example')).toBe(other)
    expect(registry.isHome('page.example')).toBe(true)
    expect(registry.isHome('https://other.example')).toBe(false)
    expect(registry.remove('https://page.example')).toBe(false)
    expect(registry.remove('other.example')).toBe(true)
    expect(registry.get('other.example')).toBeNull()

    conn.api.setToken('secret')
    const moved = registry.setHome('http://127.0.0.1:3811', info({ name: 'Local' }))
    expect(moved).toBe(conn)
    expect(conn.isDefault).toBe(false)
    expect(conn.origin).toBe('http://127.0.0.1:3811')
    expect(conn.api.base).toBe('https://chat.example.com/api')
    expect(conn.name).toBe('Local')
    expect(conn.scoped('rchat_token')).toBe('rchat_token@127.0.0.1:3811')
    const back = registry.setHome('https://page.example', null)
    expect(back.isDefault).toBe(true)
    expect(back.api.base).toBe('/api')
    expect(back.scoped('rchat_token')).toBe('rchat_token')
  })

  test('re-homing drops the old token so it never reaches another instance', async () => {
    const conn = new InstanceConnection(fixed('https://page.example'), null, true)
    const registry = new InstanceRegistry(conn, () => fixed('https://page.example'))
    conn.api.setToken('page-token')
    registry.setHome('https://other.example', info())
    const sent: Headers[] = []
    const real = globalThis.fetch
    globalThis.fetch = (async (_: string, init?: RequestInit) => {
      sent.push(new Headers(init?.headers))
      return json({})
    }) as typeof fetch
    try {
      await conn.api.getSettings()
    } finally {
      globalThis.fetch = real
    }
    expect(sent[0].get('authorization')).toBeNull()
  })

  test('the module home connection exists without a window', () => {
    expect(home.isDefault).toBe(true)
    expect(home.api.base).toBe('http://127.0.0.1:3000/api')
    expect(home.scoped('rchat_layout:alice')).toBe('rchat_layout:alice')
  })

  test('errors are typed', () => {
    expect(new InstanceError('x').name).toBe('InstanceError')
  })
})

describe('portability boundary', () => {
  test('app/lib never imports Next.js or React DOM', () => {
    const dir = join(dirname(fileURLToPath(import.meta.url)), '..')
    const files = readdirSync(dir).filter(f => /\.tsx?$/.test(f))
    expect(files.length > 10).toBe(true)
    const offenders = files.filter(f =>
      /from ['"](next|next\/[^'"]*|react-dom[^'"]*)['"]/.test(readFileSync(join(dir, f), 'utf8'))
    )
    expect(offenders).toEqual([])
  })
})
