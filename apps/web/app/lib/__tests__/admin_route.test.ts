import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { useStore } from '../store'
import { drain, me, memoryStorage, serverDetail } from './fixtures'
import { installPrimaryAccount } from './home_instance'
import { Secret } from '../secret'

const st = () => useStore.getState()
const realFetch = globalThis.fetch
const realWindow = (globalThis as { window?: unknown }).window
const realDocument = (globalThis as { document?: unknown }).document
const chan = { id: 78, name: 'general', kind: 'text' as const, slowmode_seconds: 0 }
let path = '/'
let hash = ''
let entries: { state: unknown; url: string }[] = []
let asked: string[] = []
let went: number[] = []

const at = (url: string) => {
  const [p, h] = url.split('#')
  path = p
  hash = h === undefined ? '' : `#${h}`
}

beforeEach(() => {
  memoryStorage.clear()
  Object.assign(globalThis, { localStorage: memoryStorage })
  installPrimaryAccount('bob')
  asked = []
  went = []
  entries = [{ state: null, url: '/' }]
  at('/')
  ;(globalThis as { window?: unknown }).window = {
    addEventListener: () => {},
    location: {
      get pathname() {
        return path
      },
      get hash() {
        return hash
      },
      href: 'http://x/',
      origin: 'http://x',
      protocol: 'http:',
      search: '',
    },
    history: {
      get state() {
        return entries[entries.length - 1].state
      },
      pushState: (state: unknown, _: string, url: string) => {
        entries.push({ state, url })
        at(url)
      },
      replaceState: (state: unknown, _: string, url: string) => {
        entries[entries.length - 1] = { state, url }
        at(url)
      },
      go: (n: number) => {
        went.push(n)
        entries = entries.slice(0, entries.length + n)
        at(entries[entries.length - 1].url)
        void st().syncFromUrl('none')
      },
    },
  }
  ;(globalThis as { document?: unknown }).document = { cookie: '' }
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input).replace(/^https?:\/\/[^/]+/, '')
    asked.push(url)
    if (url === '/api/servers/rchat')
      return new Response(JSON.stringify(serverDetail('rchat', { channels: [chan] })), {
        status: 200,
      })
    return new Response(JSON.stringify([]), { status: 200 })
  }) as typeof fetch
})

afterEach(() => {
  globalThis.fetch = realFetch
  ;(globalThis as { window?: unknown }).window = realWindow
  ;(globalThis as { document?: unknown }).document = realDocument
})

const signIn = (admin: boolean) =>
  useStore.setState({
    me: me('bob', { is_site_admin: admin }),
    token: Secret.of('t'),
    guest: false,
    error: null,
    view: null,
    home: false,
    adminPage: null,
    activeDialog: null,
    servers: {},
    messages: {},
  })

const settle = async () => {
  for (let i = 0; i < 20; i++) await drain()
}

// What a load at `url` leaves behind: the place, the address and what was asked of the server.
const load = async (url: string, admin: boolean) => {
  signIn(admin)
  entries = [{ state: null, url }]
  at(url)
  asked = []
  await st().syncFromUrl('replace')
  await settle()
  const { view, home, adminPage, activeDialog, error } = st()
  return { view, home, adminPage, activeDialog, error, path, asked: [...asked].sort() }
}

describe('admin paths for someone who is not the site admin', () => {
  test('an admin path acts exactly like a path nobody knows', async () => {
    const unknown = await load('/nowhere/', false)
    for (const url of ['/admin/', '/admin/features/', '/admin/users/bob/', '/admin/servers/x/']) {
      const got = await load(url, false)
      expect(got).toEqual(unknown)
      expect(got.adminPage).toBeNull()
      expect(got.asked.some(a => a.includes('/admin'))).toBe(false)
    }
    expect(unknown.view).toEqual({ kind: 'channel', server: 'rchat', channelId: 78 })
  })

  test('opening the page from code does nothing', () => {
    signIn(false)
    st().openAdmin('features')
    expect(st().adminPage).toBeNull()
    expect(path).toBe('/')
    expect(entries).toHaveLength(1)
  })
})

describe('admin paths for the site admin', () => {
  test('a load at an admin path opens that place over home', async () => {
    const got = await load('/admin/features/#p2p', true)
    expect(got.adminPage).toEqual({ section: 'features', item: null, row: 'p2p' })
    expect(got.home).toBe(true)
    expect(got.view).toBeNull()
    expect(got.path).toBe('/admin/features/')
    expect((await load('/admin/', true)).adminPage).toEqual({
      section: null,
      item: null,
      row: null,
    })
    expect((await load('/admin/servers/my%20place/', true)).adminPage).toEqual({
      section: 'servers',
      item: 'my place',
      row: null,
    })
  })

  test('an admin path that does not exist is a path nobody knows', async () => {
    const got = await load('/admin/nowhere/', true)
    expect(got.adminPage).toBeNull()
    expect(got.view).toEqual({ kind: 'channel', server: 'rchat', channelId: 78 })
  })

  test('opened in the app, close goes back to where it was opened', async () => {
    signIn(true)
    useStore.setState({ home: true })
    st().openAdmin()
    expect(path).toBe('/admin/')
    st().openAdmin('features')
    st().openAdmin('users', 'dana')
    expect(path).toBe('/admin/users/dana/')
    expect(st().adminPage).toEqual({ section: 'users', item: 'dana', row: null })
    expect(entries).toHaveLength(4)
    st().closeAdmin()
    await settle()
    expect(went).toEqual([-3])
    expect(path).toBe('/')
    expect(st().adminPage).toBeNull()
    expect(st().home).toBe(true)
  })

  test('a row of the open section replaces the address instead of adding one', () => {
    signIn(true)
    st().openAdmin('features')
    st().openAdmin('features', null, 'p2p')
    expect(entries).toHaveLength(2)
    expect(`${path}${hash}`).toBe('/admin/features/#p2p')
    expect(st().adminPage?.row).toBe('p2p')
  })

  test('loaded at its own address, close goes home', async () => {
    await load('/admin/features/', true)
    st().openAdmin('users')
    st().closeAdmin()
    expect(went).toEqual([])
    expect(path).toBe('/')
    expect(st().adminPage).toBeNull()
    expect(st().home).toBe(true)
  })

  test('the place under the page can change without closing it', async () => {
    signIn(true)
    useStore.setState({ home: true })
    st().openAdmin('servers')
    await st().openServer('rchat', undefined, 'replace')
    await settle()
    expect(st().adminPage).not.toBeNull()
    expect(path).toBe('/admin/servers/')
    expect(st().view).toEqual({ kind: 'channel', server: 'rchat', channelId: 78 })
    st().closeAdmin()
    expect(went).toEqual([])
    expect(path).toBe('/s/rchat/78/')
    expect(st().adminPage).toBeNull()
  })

  test('going somewhere on purpose leaves the page', async () => {
    signIn(true)
    useStore.setState({ home: true })
    st().openAdmin('servers')
    await st().openServer('rchat')
    await settle()
    expect(st().adminPage).toBeNull()
    expect(path).toBe('/s/rchat/78/')
  })

  test('opening the page closes the dialog under it, and a dialog opened over it stays', () => {
    signIn(true)
    useStore.setState({ activeDialog: { kind: 'settings' } })
    st().openAdmin()
    expect(st().activeDialog).toBeNull()
    useStore.setState({ activeDialog: { kind: 'ban_confirm', username: 'dana' } })
    st().openAdmin('users', 'dana')
    expect(st().activeDialog).toEqual({ kind: 'ban_confirm', username: 'dana' })
  })

  test('signing out closes it', () => {
    signIn(true)
    st().openAdmin()
    st().logout()
    expect(st().adminPage).toBeNull()
  })
})
