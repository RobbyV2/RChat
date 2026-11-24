import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createHomeConnection,
  ownInstance,
  knownInstances,
  InstanceConnection,
  InstanceError,
  apiMajor,
  compatible,
  endpointsFrom,
  fetchInstance,
  homePeer,
  localOrigins,
  shareOrigin,
  lookup,
  normalizeOrigin,
  peerFrom,
  readKnown,
  readLocal,
  rememberInstance,
  resolveInstance,
  savedHome,
  sessionStore,
  validInfo,
  writeLocal,
  fitsHome,
  fromOrigin,
  privateHost,
  remoteAllowed,
  sameSite,
  type Endpoints,
  type StorageLike,
} from '../instances'
import { home } from './home_instance'
import { InstanceRegistry } from '../client/instance_registry'
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

// Storage as a browser hands it out when it is blocked or failing: every call throws.
const fail = (): never => {
  throw new DOMException('The operation is insecure.', 'SecurityError')
}

const failing = (): StorageLike => ({ getItem: fail, setItem: fail, removeItem: fail })

// Runs `f` with console warnings kept off the test output, and returns them.
const quietly = async (f: () => unknown) => {
  const warn = console.warn
  const said: unknown[][] = []
  console.warn = (...a: unknown[]) => void said.push(a)
  try {
    await f()
  } finally {
    console.warn = warn
  }
  return said
}

// Runs `f` with the global `name` set to `value` (a getter when `value` is a function), then
// puts back what was there.
const withGlobal = async (name: string, value: unknown, f: () => unknown) => {
  const before = Object.getOwnPropertyDescriptor(globalThis, name)
  Object.defineProperty(
    globalThis,
    name,
    typeof value === 'function'
      ? { configurable: true, get: value as () => unknown }
      : { configurable: true, writable: true, value }
  )
  try {
    await f()
  } finally {
    if (before) Object.defineProperty(globalThis, name, before)
    else delete (globalThis as Record<string, unknown>)[name]
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
    // No address, or junk: /peerjs on the instance's own origin.
    expect(peerFrom(undefined, 'http://h:1')).toEqual({
      host: 'h',
      port: 1,
      path: '/peerjs',
      secure: false,
    })
    expect(peerFrom('not a url', 'https://chat.example.com')).toEqual({
      host: 'chat.example.com',
      port: 443,
      path: '/peerjs',
      secure: true,
    })
    expect(peerFrom('', 'http://chat.example.com')).toEqual({
      host: 'chat.example.com',
      port: 80,
      path: '/peerjs',
      secure: false,
    })
  })

  test("the web app on the instance's site dials the PeerJS address the instance advertises", () => {
    const page = { hostname: 'chat.example.com', protocol: 'https:' }
    const at = (port: number, path = '/peerjs', secure = true) => ({
      host: 'chat.example.com',
      port,
      path,
      secure,
    })
    // PUBLIC_PEERJS_URL behind a TLS proxy that routes /peerjs on 443.
    expect(homePeer(page, 'https://chat.example.com/peerjs', {})).toEqual(at(443))
    expect(homePeer(page, 'https://chat.example.com:8443/p2p/peerjs/', {})).toEqual(
      at(8443, '/p2p/peerjs')
    )
    // A PeerJS port other than 9001.
    expect(homePeer(page, 'https://chat.example.com:9443/peerjs', {})).toEqual(at(9443))
    // An instance that can't tell it is behind TLS: the page's scheme wins.
    expect(homePeer(page, 'http://chat.example.com:9001/peerjs', {})).toEqual(at(9001))
    expect(homePeer(page, 'http://chat.example.com/peerjs', {})).toEqual(at(443))
    const plain = { hostname: '127.0.0.1', protocol: 'http:' }
    expect(homePeer(plain, 'http://127.0.0.1:3632/peerjs', {})).toEqual({
      host: '127.0.0.1',
      port: 3632,
      path: '/peerjs',
      secure: false,
    })
    // None, or junk: /peerjs on the page's own origin, never another port.
    for (const advertised of [undefined, '', 'not a url', 'ftp://chat.example.com/peerjs']) {
      expect(homePeer(page, advertised, {})).toEqual(at(443))
      expect(homePeer({ ...page, port: '8443' }, advertised, {})).toEqual(at(8443))
      expect(homePeer({ ...plain, port: '3000' }, advertised, {})).toEqual({
        host: '127.0.0.1',
        port: 3000,
        path: '/peerjs',
        secure: false,
      })
    }
    expect(homePeer({ hostname: 'chat.example.com', protocol: 'http:' }, undefined, {})).toEqual(
      at(80, '/peerjs', false)
    )
    // A build with NEXT_PUBLIC_PEERJS_HOST or _PORT keeps it.
    expect(homePeer(page, 'https://chat.example.com/peerjs', { port: '7000' })).toEqual(at(7000))
    expect(homePeer(page, 'https://chat.example.com/peerjs', { host: 'peer.example.com' })).toEqual(
      { ...at(9001), host: 'peer.example.com' }
    )
    expect(homePeer({ ...page, port: '8443' }, undefined, { port: '7000' })).toEqual(at(7000))
  })

  test('an instance that names itself differently from the page means the page host', () => {
    // No PUBLIC_URL and no ALLOWED_HOSTS: the instance calls itself localhost.
    const lan = { hostname: '192.168.1.5', protocol: 'http:', port: '3000' }
    const on = (port: number, path = '/peerjs') => ({
      host: '192.168.1.5',
      port,
      path,
      secure: false,
    })
    expect(homePeer(lan, 'http://localhost/peerjs', {}, 'http://localhost')).toEqual(on(3000))
    expect(homePeer(lan, 'http://localhost:3000/peerjs', {}, 'http://localhost:3000')).toEqual(
      on(3000)
    )
    // A separate PeerJS server on its own port (PEERJS_PORT) keeps that port.
    expect(homePeer(lan, 'http://localhost:9100/peerjs', {}, 'http://localhost')).toEqual(on(9100))
    expect(homePeer(lan, 'http://localhost:9100/p/peerjs/', {}, 'http://localhost:3000')).toEqual(
      on(9100, '/p/peerjs')
    )
    // Behind TLS on another name than PUBLIC_URL: the page's scheme and port.
    const alias = { hostname: 'alias.example.com', protocol: 'https:' }
    expect(
      homePeer(alias, 'https://chat.example.com/peerjs', {}, 'https://chat.example.com')
    ).toEqual({ host: 'alias.example.com', port: 443, path: '/peerjs', secure: true })
    expect(
      homePeer(alias, 'http://chat.example.com:9443/peerjs', {}, 'http://chat.example.com')
    ).toEqual({ host: 'alias.example.com', port: 9443, path: '/peerjs', secure: true })
    expect(homePeer(lan, 'http://localhost:9100/peerjs', {}, 'not a url')).toEqual({
      ...on(9100),
      host: 'localhost',
    })
    // The build's own setting still wins.
    expect(
      homePeer(lan, 'http://localhost:9100/peerjs', { port: '7000' }, 'http://localhost')
    ).toEqual(on(7000))
  })

  test('a PeerJS server the instance names on another host is where its own web app goes too', () => {
    // PUBLIC_PEERJS_URL on another host: everyone registers there, so nobody is split off.
    const page = { hostname: 'chat.example.com', protocol: 'https:' }
    const site = 'https://chat.example.com'
    const peer = (port: number, path = '/peerjs', secure = true) => ({
      host: 'peer.example.com',
      port,
      path,
      secure,
    })
    expect(homePeer(page, 'https://peer.example.com/peerjs', {}, site)).toEqual(peer(443))
    expect(homePeer(page, 'https://peer.example.com:8443/p2p/', {}, site)).toEqual(
      peer(8443, '/p2p')
    )
    // The page's https means wss there as well.
    expect(homePeer(page, 'http://peer.example.com:9001/peerjs', {}, site)).toEqual(peer(9001))
    const plain = { hostname: '127.0.0.1', protocol: 'http:', port: '3950' }
    expect(homePeer(plain, 'http://localhost:3952/peerjs', {}, 'http://127.0.0.1:3950')).toEqual({
      host: 'localhost',
      port: 3952,
      path: '/peerjs',
      secure: false,
    })
    expect(homePeer(plain, 'http://peer.example.com/peerjs', {}, 'http://127.0.0.1:3950')).toEqual(
      peer(80, '/peerjs', false)
    )
    // Without the instance's own name to compare, a named host is still followed.
    expect(homePeer(page, 'https://peer.example.com/peerjs', {})).toEqual(peer(443))
    // The instance's own name stays the page's host (the test above), and a build's setting wins.
    expect(homePeer(page, 'https://chat.internal/peerjs', {}, 'https://chat.internal')).toEqual({
      host: 'chat.example.com',
      port: 443,
      path: '/peerjs',
      secure: true,
    })
    expect(homePeer(page, 'https://peer.example.com/peerjs', { port: '7000' }, site)).toEqual({
      host: 'chat.example.com',
      port: 7000,
      path: '/peerjs',
      secure: true,
    })
  })

  test('the home connection hands its discovery document to the PeerJS address', () => {
    const seen: unknown[] = []
    const ends: Endpoints = {
      ...fixed('https://chat.example.com'),
      peer: got => {
        seen.push(got?.peerjs_url)
        return fixed('x').peer()
      },
    }
    new InstanceConnection(ends, info({ peerjs_url: 'https://chat.example.com/peerjs' })).peer()
    expect(seen).toEqual(['https://chat.example.com/peerjs'])
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

  test('storage that throws reads as nothing saved and keeps no writes', async () => {
    const store = failing()
    expect(savedHome('https://page.example', store)).toBe('https://page.example')
    expect(readKnown(store)).toEqual({})
    const said = await quietly(() =>
      rememberInstance('https://a.example', at('https://a.example'), store)
    )
    expect(said.map(a => a.slice(0, 2))).toEqual([['localStorage write failed', 'rchat_instances']])
  })

  test('a local write reports false when storage throws or cannot be reached', async () => {
    const said = await quietly(async () => {
      await withGlobal('localStorage', failing(), () => {
        expect(writeLocal('rchat_theme', 'light')).toBe(false)
        expect(writeLocal('rchat_theme', null)).toBe(false)
      })
      await withGlobal('localStorage', fail, () => {
        expect(writeLocal('rchat_theme', 'light')).toBe(false)
        expect(writeLocal('rchat_theme', null)).toBe(false)
      })
    })
    expect(said.map(a => a.slice(0, 2))).toEqual(
      Array.from({ length: 4 }, () => ['localStorage write failed', 'rchat_theme'])
    )
    const store = memory()
    await withGlobal('localStorage', store, () => {
      expect(writeLocal('rchat_theme', 'light')).toBe(true)
      expect(store.data.get('rchat_theme')).toBe('light')
      expect(writeLocal('rchat_theme', null)).toBe(true)
      expect(store.data.has('rchat_theme')).toBe(false)
    })
  })

  test('a local read is nothing saved when storage throws or cannot be reached', async () => {
    await withGlobal('localStorage', failing(), () => expect(readLocal('rchat_theme')).toBeNull())
    await withGlobal('localStorage', fail, () => expect(readLocal('rchat_theme')).toBeNull())
    await withGlobal('localStorage', undefined, () => expect(readLocal('rchat_theme')).toBeNull())
    const store = memory()
    store.setItem('rchat_theme', 'light')
    await withGlobal('localStorage', store, () => expect(readLocal('rchat_theme')).toBe('light'))
  })

  test('the session store reads nothing and keeps nothing when sessionStorage throws', async () => {
    const windows = [
      { sessionStorage: failing() },
      Object.defineProperty({}, 'sessionStorage', { get: fail }),
      {},
      undefined,
    ]
    const said = await quietly(async () => {
      for (const window of windows)
        await withGlobal('window', window, () => {
          expect(sessionStore.getItem('rchat_p2p_home')).toBeNull()
          sessionStore.setItem('rchat_p2p_home', 'bob')
          sessionStore.removeItem('rchat_p2p_home')
        })
    })
    expect(said).toEqual([])
    const store = memory()
    await withGlobal('window', { sessionStorage: store }, () => {
      sessionStore.setItem('rchat_p2p_home', 'bob')
      expect(store.data.get('rchat_p2p_home')).toBe('bob')
      expect(sessionStore.getItem('rchat_p2p_home')).toBe('bob')
      sessionStore.removeItem('rchat_p2p_home')
      expect(store.data.has('rchat_p2p_home')).toBe(false)
    })
  })

  test('the app starts at its default home when its storage throws', async () => {
    const started = async (window: unknown) => {
      let seen: unknown[] = []
      await withGlobal('window', window, async () => {
        const home = createHomeConnection()
        seen = [home.isDefault, home.origin, home.info, knownInstances()]
      })
      return seen
    }
    const plain = await started(undefined)
    expect([plain[0], plain[2], plain[3]]).toEqual([true, null, []])
    expect(await started({ localStorage: failing() })).toEqual(plain)
    expect(await started(Object.defineProperty({}, 'localStorage', { get: fail }))).toEqual(plain)
    const store = memory()
    store.setItem('rchat_home', 'chat.example.com')
    expect(await started({ localStorage: store })).toEqual([
      false,
      'https://chat.example.com',
      null,
      [],
    ])
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
  test('a background connection shares and recognizes links for its own instance', async () => {
    const origin = 'https://other.example'
    const conn = new InstanceConnection(fixed(origin), at(origin))
    const page = new URL('https://page.example')
    await withGlobal('window', { location: page }, () => {
      expect(localOrigins(conn)).toEqual([origin])
      expect(shareOrigin(page, false, conn)).toBe(origin)
      expect(localOrigins(home)).toContain(page.origin)
    })
  })

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

// P2P registers once the page has looked up its instance's discovery document (its PeerJS
// address), or after a bound when the lookup hangs.
describe('the home lookup', () => {
  test('waits for the lookup, at most the bound', async () => {
    const l = lookup()
    let waited = false
    const wait = l.settled(5000).then(() => (waited = true))
    await new Promise(r => setTimeout(r, 20))
    expect(waited).toBe(false)
    l.done()
    await wait
    expect(waited).toBe(true)
    const t0 = Date.now()
    await lookup().settled(30)
    expect(Date.now() - t0 < 1000).toBe(true)
    const late = lookup()
    late.done()
    await late.settled(5000)
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

test('the hosted client has an own instance only if discovery succeeds, and client-only builds have none', () => {
  const original = process.env.NEXT_PUBLIC_CLIENT_ONLY
  try {
    process.env.NEXT_PUBLIC_CLIENT_ONLY = 'false'
    expect(typeof ownInstance()?.origin).toBe('string')
    expect(ownInstance(false)).toBeNull()
    process.env.NEXT_PUBLIC_CLIENT_ONLY = 'true'
    expect(ownInstance()).toBeNull()
  } finally {
    if (original === undefined) delete process.env.NEXT_PUBLIC_CLIENT_ONLY
    else process.env.NEXT_PUBLIC_CLIENT_ONLY = original
  }
})
