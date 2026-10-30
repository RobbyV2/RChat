import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime'
import type { AppRouterInstance } from 'next/dist/shared/lib/app-router-context.shared-runtime'
import { resetSessionCaches, useStore } from '../store'
import { home } from '../instances'
import { emptyLayout } from '../nav_layout'
import { loadHome, noteVisit, parseSummary, unreadSummaryKey, useHome } from '../home_store'
import { registerPalette, usePalette } from '../palette'
import { HomePage } from '../../components/home'
import type { Channel, DmSummary } from '../types'
import { me, memoryStorage, serverDetail, user } from './fixtures'

afterAll(resetSessionCaches)

const st = () => useStore.getState()
const storage = new Map<string, string>()
let pushed: string[] = []
let fetched: string[] = []
const realFetch = globalThis.fetch
const g = globalThis as { window?: unknown; document?: unknown }
const real = { window: g.window, document: g.document }
const loc = { pathname: '/', href: 'http://x/', origin: 'http://x', protocol: 'http:' }
const dm = (id: number, other: string, is_self = false): DmSummary => ({
  id,
  other: user(other),
  is_self,
  closed: false,
})

const router = {
  push: () => {},
  replace: () => {},
  back: () => {},
  forward: () => {},
  refresh: () => {},
  prefetch: () => {},
} as unknown as AppRouterInstance

// Server rendering reads each store's initial state, so the test state goes there.
const initial = useStore.getInitialState()
const saved = { ...initial }
const paletteInitial = usePalette.getInitialState()
const homeInitial = useHome.getInitialState()
const homeSaved = { ...homeInitial }

const render = () => {
  Object.assign(initial, useStore.getState())
  Object.assign(paletteInitial, usePalette.getState())
  Object.assign(homeInitial, useHome.getState())
  return renderToStaticMarkup(
    <AppRouterContext.Provider value={router}>
      <HomePage onMenu={() => {}} />
    </AppRouterContext.Provider>
  )
}

beforeEach(() => {
  storage.clear()
  pushed = []
  fetched = []
  loc.pathname = '/'
  globalThis.fetch = (async (input: string | URL | Request) => {
    fetched.push(String(input))
    return new Response(JSON.stringify([]), { status: 200 })
  }) as typeof fetch
  Object.assign(globalThis, {
    localStorage: {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => void storage.set(k, v),
      removeItem: (k: string) => void storage.delete(k),
    },
  })
  g.window = {
    location: loc,
    history: {
      state: null,
      pushState: (_: unknown, __: string, path: string) => {
        pushed.push(path)
        loc.pathname = path
      },
      replaceState: (_: unknown, __: string, path: string) => {
        loc.pathname = path
      },
    },
  }
  g.document = { cookie: '' }
  useStore.setState({
    token: 'tok',
    me: me('alice', { display_name: 'Alice A' }),
    guest: false,
    streamer: false,
    view: null,
    home: false,
    servers: {},
    reads: {},
    readsReady: false,
    pings: {},
    groupPings: {},
    dms: [dm(1, 'alice', true), dm(2, 'bob')],
    dmsMore: false,
    layout: { ...emptyLayout, dmPinned: [2] },
  })
  loadHome('alice')
})

afterEach(() => {
  home.ws.stop()
  globalThis.fetch = realFetch
  Object.assign(globalThis, { localStorage: memoryStorage })
  g.window = real.window
  g.document = real.document
  registerPalette(null)
  Object.assign(initial, saved)
  Object.assign(paletteInitial, { open: null })
  Object.assign(homeInitial, homeSaved)
  useStore.setState({ token: null, view: null, home: false })
  loadHome(null)
})

describe('going home', () => {
  test('the root address shows Home instead of opening a server', async () => {
    await st().syncFromUrl('replace')
    expect(st().home).toBe(true)
    expect(st().view).toBe(null)
    expect(fetched.some(u => u.includes('/api/servers/'))).toBe(false)
  })

  test('the Home button leaves the open view and pushes the root address', () => {
    loc.pathname = '/dm/2/'
    useStore.setState({ view: { kind: 'dm', dmId: 2 }, home: false })
    st().goHome()
    expect(st().view).toBe(null)
    expect(st().home).toBe(true)
    expect(pushed).toEqual(['/'])
  })
})

describe('recent visits', () => {
  test('visits are stored per account with the names seen, previews are not', () => {
    useStore.setState({
      me: me('alice', {
        servers: [{ name: 's', display_name: 'Space', creator: null, is_admin: false }],
      }),
      servers: {
        s: serverDetail('s', { channels: [{ id: 1, name: 'general', kind: 'text' } as Channel] }),
        p: serverDetail('p'),
      },
      view: { kind: 'channel', server: 's', channelId: 1 },
    })
    noteVisit(st(), 10)
    useStore.setState({ view: { kind: 'channel', server: 'p', channelId: 1 } })
    noteVisit(st(), 11)
    const saved = JSON.parse(storage.get('rchat_home:alice') ?? 'null') as {
      recents: unknown[]
    }
    expect(saved.recents).toEqual([
      {
        kind: 'channel',
        server: 's',
        channelId: 1,
        channel: 'general',
        serverName: 'Space',
        at: 10,
      },
    ])
    expect(useHome.getState().prefs.recents).toHaveLength(1)
  })
})

describe('unread summary', () => {
  test('lists servers with unread channels or pings and the DMs', () => {
    useStore.setState({
      me: me('alice', {
        servers: [
          { name: 'a', display_name: 'A', creator: null, is_admin: false },
          { name: 'b', display_name: 'B', creator: null, is_admin: false },
          { name: 'c', display_name: 'C', creator: null, is_admin: false },
        ],
      }),
      reads: {
        c1: { lastRead: 1, latest: 2, server: 'a' },
        c2: { lastRead: 1, latest: 5, server: 'a' },
        c3: { lastRead: 5, latest: 5, server: 'b' },
        c4: { lastRead: 1, latest: 5, server: 'c' },
        d2: { lastRead: 1, latest: 5 },
      },
      pings: { c4: { scope: 'c4', server: 'c', bulk: 2, bulkUntil: 0, ids: [] } },
    })
    const summary = parseSummary(unreadSummaryKey(st()))
    expect(summary.servers).toEqual([
      { name: 'c', pings: 2, channels: 1 },
      { name: 'a', pings: 0, channels: 2 },
    ])
    expect(summary.dms).toEqual({ pings: 0, unread: true })
  })
})

describe('home markup', () => {
  test('signed in: greeting by name, sections load with skeletons, no palette yet', () => {
    const html = render()
    expect(html).toContain('<span class="streamer">Alice A</span>')
    expect(html).toContain('Quick actions')
    expect(html).toContain('Create server')
    expect(html).toContain('Join server')
    expect(html).toContain('Message someone')
    expect(html.includes('Command palette')).toBe(false)
    expect(html).toContain('Loading notifications')
    expect(html).toContain('Loading friends')
    expect(html).toContain('Loading unread messages')
    expect(html).toContain('Pinned DMs')
    expect(html).toContain('data-pinned-dm="2"')
    expect(html).toContain('title="Dismiss tip"')
  })

  test('the palette action shows once the palette registers', () => {
    registerPalette(() => {})
    expect(render()).toContain('Command palette')
  })

  test('streamer mode greets without the name', () => {
    useStore.setState({ streamer: true })
    const html = render()
    expect(html).toContain('Welcome back')
    expect(html.includes('Alice A')).toBe(false)
    expect(
      /data-pinned-dm="2"[^>]*title="Direct message"|title="Direct message"[^>]*data-pinned-dm="2"/.test(
        html
      )
    ).toBe(true)
  })

  test('pinned DM rows name the person outside streamer mode', () => {
    const html = render()
    expect(html.includes('title="Direct message"')).toBe(false)
  })

  test('a new account gets the get started card', () => {
    useStore.setState({ dms: [dm(1, 'alice', true)], layout: emptyLayout })
    const html = render()
    expect(html).toContain('Get started')
    expect(html.includes('Jump back in')).toBe(false)
  })

  test('guests get the guest state without friends, inbox or DMs', () => {
    useStore.setState({ me: null, guest: true })
    const html = render()
    expect(html).toContain('Find a server')
    expect(html).toContain('Sign up')
    for (const word of ['Friends', 'Inbox', 'Pinned DMs', 'Jump back in', 'Message someone'])
      expect(html.includes(word)).toBe(false)
  })
})
