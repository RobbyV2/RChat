import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { sessionStore } from '../instances'
import { home, api } from './home_instance'
import { dropStashedInvite, stashInvite, takeStashedInvite } from '../invite'
import { hasStashedConfig, takeStashedConfig } from '../config_transfer'
import { useStore, resetSessionCaches } from '../store'
import { keptSession, restoreStreamer, restoreTheme, startApp } from '../start'
import { drain, me, memoryStorage } from './fixtures'
import { client } from '../client/client'
import { plain } from './helpers/secret'

const st = () => useStore.getState()
const g = globalThis as { window?: unknown; document?: unknown }
const real = { window: g.window, document: g.document, fetch: globalThis.fetch, warn: console.warn }

const refuse = (): never => {
  throw new DOMException('The operation is insecure.', 'SecurityError')
}

// Web Storage as a browser with blocked or failing site data gives it: every call throws, or
// reaching the storage object throws.
const failing = {
  getItem: refuse,
  setItem: refuse,
  removeItem: refuse,
  key: refuse,
  clear: refuse,
  get length() {
    return refuse()
  },
}
const BROWSERS: [string, PropertyDescriptor][] = [
  ['every storage call throws', { value: failing }],
  ['reaching the storage throws', { get: refuse }],
]

let path = '/'
let warned = 0

const install = (storage: PropertyDescriptor) => {
  Object.defineProperty(globalThis, 'localStorage', { ...storage, configurable: true })
  const window = {
    addEventListener: () => {},
    removeEventListener: () => {},
    location: {
      get pathname() {
        return path
      },
      get href() {
        return `http://x${path}`
      },
      origin: 'http://x',
      protocol: 'http:',
      search: '',
      hash: '',
    },
    history: {
      state: null,
      pushState: (_: unknown, __: string, p: string) => void (path = p),
      replaceState: (_: unknown, __: string, p: string) => void (path = p),
    },
  }
  Object.defineProperty(window, 'localStorage', { ...storage, configurable: true })
  Object.defineProperty(window, 'sessionStorage', { ...storage, configurable: true })
  g.window = window
  g.document = {
    cookie: '',
    visibilityState: 'visible',
    addEventListener: () => {},
    removeEventListener: () => {},
    documentElement: { dataset: {} },
    querySelector: () => null,
    body: { classList: { toggle: () => {} } },
  }
}

const reply = (url: string): Response => {
  const route = url.replace(/^https?:\/\/[^/]+/, '').replace(/^\/api/, '')
  if (route === '/auth/login') return Response.json({ token: 'tok', user: me('bob') })
  if (route === '/me') return Response.json(me('bob'))
  if (route === '/instance' || route.startsWith('/.well-known'))
    return new Response('', { status: 404 })
  return Response.json([])
}

// Picking a theme or streamer mode changes the device for every later test file.
const device = { theme: client.device.theme, streamer: client.device.streamer }

beforeEach(() => {
  resetSessionCaches()
  path = '/'
  warned = 0
  console.warn = () => void (warned += 1)
  globalThis.fetch = (async (input: string | URL | Request) => reply(String(input))) as typeof fetch
  useStore.setState({
    token: null,
    me: null,
    guest: false,
    error: null,
    view: null,
    home: false,
    theme: 'dark',
    streamer: false,
  })
})

afterEach(() => {
  Object.assign(client.device, device)
  home.ws.stop()
  api.setToken(null)
  useStore.setState({
    token: null,
    me: null,
    guest: false,
    error: null,
    view: null,
    home: false,
    theme: 'dark',
    streamer: false,
  })
  Object.defineProperty(globalThis, 'localStorage', {
    value: memoryStorage,
    writable: true,
    enumerable: true,
    configurable: true,
  })
  g.window = real.window
  g.document = real.document
  globalThis.fetch = real.fetch
  console.warn = real.warn
})

for (const [browser, storage] of BROWSERS)
  describe(`start-up when ${browser}`, () => {
    test('the signed-out start reads nothing kept and goes to the login page', async () => {
      install(storage)
      expect(keptSession()).toBe(false)
      let toLogin = 0
      await startApp(() => (toLogin += 1))
      expect(toLogin).toBe(1)
      restoreTheme()
      await st().bootstrap()
      expect([st().theme, st().streamer, st().token, st().guest, st().error]).toEqual([
        'dark',
        false,
        null,
        false,
        null,
      ])
      expect(st().syncInvite()).toBe(false)
      expect(st().syncConfigLink()).toBe(false)
      expect(takeStashedInvite('rchat', null, sessionStore)).toBeNull()
      expect(takeStashedConfig(sessionStore)).toBeNull()
      expect(hasStashedConfig(sessionStore)).toBe(false)
      stashInvite({ server: 'rchat', password: null }, sessionStore)
      dropStashedInvite(sessionStore)
    })

    test('an invite link opens signed out', async () => {
      install(storage)
      path = '/invite/rchat/'
      let toLogin = 0
      await startApp(() => (toLogin += 1))
      expect(toLogin).toBe(0)
      expect(st().invite?.server).toBe('rchat')
      expect(st().error).toBeNull()
    })

    test('an invite code link opens signed out', async () => {
      install(storage)
      path = '/i/k7m2p9xq4tzr/'
      let toLogin = 0
      await startApp(() => (toLogin += 1))
      expect(toLogin).toBe(0)
      expect(st().invite).toEqual({ server: '', password: null, code: 'k7m2p9xq4tzr', join: false })
      expect(st().error).toBeNull()
    })

    test('signing in starts the app signed in for this tab', async () => {
      install(storage)
      await st().login({ username: 'bob', password: 'x' } as never)
      expect([plain(st().token), st().me?.username, st().error]).toEqual(['tok', 'bob', null])
      let toLogin = 0
      await startApp(() => (toLogin += 1))
      await drain()
      expect(toLogin).toBe(0)
      expect([plain(st().token), st().me?.username, st().error]).toEqual(['tok', 'bob', null])
      st().openLastDm()
      expect(warned).toBeGreaterThan(0)
    })

    test('a theme and streamer mode picked in this tab stay as pages start', async () => {
      install(storage)
      st().setTheme('light')
      st().setStreamer(true)
      restoreTheme()
      restoreStreamer()
      await startApp(() => {})
      expect([st().theme, st().streamer]).toEqual(['light', true])
    })

    test('a guest visit starts and ends', async () => {
      install(storage)
      await st().enterGuest()
      expect([st().guest, st().error]).toEqual([true, null])
      let toLogin = 0
      await startApp(() => (toLogin += 1))
      expect(toLogin).toBe(0)
      st().logout()
      expect([st().guest, st().token]).toEqual([false, null])
    })
  })

describe('start-up with working storage', () => {
  test('the Animations setting is read at sign-in and for a guest, and reset at sign-out', async () => {
    install({ value: memoryStorage })
    memoryStorage.setItem('rchat_anim:bob', '{"v":1,"on":true,"motion":"always"}')
    memoryStorage.setItem('rchat_anim:guest', '{"v":1,"on":true,"motion":"still"}')
    try {
      await st().login({ username: 'bob', password: 'x' } as never)
      expect(st().anim).toEqual({ on: true, motion: 'always', style: 'subtle', custom: {} })
      st().logout()
      expect(st().anim).toEqual({ on: false, motion: 'device', style: 'subtle', custom: {} })
      await st().enterGuest()
      expect(st().anim).toEqual({ on: true, motion: 'still', style: 'subtle', custom: {} })
      st().logout()
      expect(st().anim).toEqual({ on: false, motion: 'device', style: 'subtle', custom: {} })
    } finally {
      memoryStorage.removeItem('rchat_anim:bob')
      memoryStorage.removeItem('rchat_anim:guest')
    }
  })

  test('the kept theme and streamer mode win over this tab, and nothing kept keeps it', () => {
    install({ value: memoryStorage })
    memoryStorage.setItem('rchat_theme', 'light')
    memoryStorage.setItem('rchat_streamer', '1')
    restoreTheme()
    restoreStreamer()
    expect([st().theme, st().streamer]).toEqual(['light', true])
    memoryStorage.clear()
    restoreTheme()
    restoreStreamer()
    expect([st().theme, st().streamer]).toEqual(['light', true])
    memoryStorage.setItem('rchat_theme', 'dark')
    memoryStorage.setItem('rchat_streamer', '0')
    restoreTheme()
    restoreStreamer()
    expect([st().theme, st().streamer]).toEqual(['dark', false])
    memoryStorage.clear()
  })
})
