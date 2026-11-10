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
import { useP2p } from '../p2p/app'
import type { Contact } from '../p2p/contacts'
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
const p2pInitial = useP2p.getInitialState()
const p2pSaved = { ...p2pInitial }
const contact = (ik: string, state: Contact['state'] = 'mutual') =>
  ({
    ik,
    name: ik,
    petname: null,
    profile: null,
    certs: [],
    revocations: [],
    state,
    ignored: false,
    intros: [],
    verified: false,
    verifiedAt: null,
    added: 1,
  }) as unknown as Contact

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
  Object.assign(p2pInitial, p2pSaved)
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

  test('counts the text channels the dot counts, once the server is loaded', () => {
    const channel = (id: number, kind: Channel['kind']): Channel =>
      ({ id, name: `c${id}`, kind, slowmode_seconds: 0 }) as Channel
    useStore.setState({
      me: me('alice', {
        servers: [{ name: 'a', display_name: 'A', creator: null, is_admin: false }],
      }),
      servers: { a: serverDetail('a', { channels: [channel(1, 'text'), channel(2, 'voice')] }) },
      reads: {
        c1: { lastRead: 1, latest: 2, server: 'a' },
        c2: { lastRead: 1, latest: 5, server: 'a' },
        c9: { lastRead: 1, latest: 5, server: 'a' },
      },
    })
    expect(parseSummary(unreadSummaryKey(st())).servers).toEqual([
      { name: 'a', pings: 0, channels: 1 },
    ])
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
    for (const word of [
      'Friends',
      'Inbox',
      'Pinned DMs',
      'Jump back in',
      'Message someone',
      'data-p2p-home',
      'P2P',
    ])
      expect(html.includes(word)).toBe(false)
  })
})

describe('P2P on Home', () => {
  const cardTag = (html: string) => /<section[^>]*data-p2p-home[^>]*>/.exec(html)?.[0] ?? ''
  afterEach(() => useStore.setState({ settings: saved.settings }))

  test('P2P that is not turned on gets a dashed card that offers to turn it on', () => {
    const html = render()
    const tag = cardTag(html)
    for (const cls of ['border-2', 'border-dashed', 'border-tertiary/70'])
      expect(tag.split(/[\s"]/)).toContain(cls)
    expect(html).toContain('Peer-to-peer')
    expect(html).toContain('Turn on P2P')
    expect(html).toContain('Add P2P contact')
    expect(html).toContain('Join P2P server')
    for (const word of ['Show my code', 'contacts online', 'data-p2p-home-status'])
      expect(html.includes(word)).toBe(false)
  })

  test('an instance with P2P switched off shows no P2P card or actions', () => {
    useStore.setState({ settings: { ...st().settings, p2p: false } })
    const html = render()
    for (const word of ['data-p2p-home', 'Add P2P contact', 'Join P2P server', 'Turn on P2P'])
      expect(html.includes(word)).toBe(false)
    expect(html).toContain('Create server')
    const order = ['id="home-jump-back-in"', 'id="home-unread"', 'id="home-inbox"'].map(mark =>
      html.indexOf(mark)
    )
    expect(order.every(at => at >= 0)).toBe(true)
    expect(order).toEqual([...order].sort((a, b) => a - b))
    expect(html).toContain('<div class="grid gap-4 lg:grid-cols-2">')
    useStore.setState({ dms: [dm(1, 'alice', true)], layout: emptyLayout })
    expect(
      /<section aria-labelledby="home-get-started" class="[^"]*lg:col-span-2/.test(render())
    ).toBe(true)
  })

  test('running P2P shows its status, what waits for an answer and who is online', () => {
    Object.assign(p2pInitial, {
      enabled: true,
      loading: false,
      status: 'online',
      contacts: [contact('dana'), contact('eve'), contact('asker', 'incoming')],
      presence: { dana: 'online' },
      serverInvites: [{ room: 'r', name: 'Club', from: 'dana', at: 1 }],
      transferAsks: [{ key: 'k', kind: 'take', from: 'dana', room: 'r', to: 'x', name: 'Club' }],
    })
    const html = render()
    expect(html).toContain('data-p2p-home-status="online"')
    expect(html).toContain('Online')
    expect(html).toContain('1 contact online')
    expect(html).toContain('1 message request')
    expect(html).toContain('1 server invite')
    expect(html).toContain('1 co-owner or transfer request')
    expect(html).toContain('data-p2p-home-contact="dana"')
    expect(html.includes('data-p2p-home-contact="eve"')).toBe(false)
    const avatar = /<button[^>]*data-p2p-home-contact="dana"[^>]*>/.exec(html)?.[0] ?? ''
    expect(avatar).toContain('data-long-press=""')
    for (const word of ['Add contact', 'Show my code', 'Join P2P server'])
      expect(html).toContain(word)
    expect(html.includes('Turn on P2P')).toBe(false)
  })

  test('streamer mode keeps contact names out of the card', () => {
    Object.assign(p2pInitial, {
      enabled: true,
      status: 'online',
      contacts: [contact('dana')],
      presence: { dana: 'online' },
    })
    useStore.setState({ streamer: true })
    const html = render()
    expect(html).toContain('data-p2p-home-contact="dana"')
    expect(html.includes('Message dana')).toBe(false)
  })

  test('another tab running P2P is said so, with a way to use it here', () => {
    Object.assign(p2pInitial, { enabled: true, elsewhere: true, status: 'online' })
    const html = render()
    expect(html).toContain('P2P is open in another tab.')
    expect(html).toContain('Use here')
    expect(html.includes('Show my code')).toBe(false)
  })

  test('in one column Unread comes first, then Peer-to-peer, then the rest', () => {
    const html = render()
    const order = [
      'Quick actions',
      'id="home-unread"',
      'data-p2p-home',
      'id="home-jump-back-in"',
      'id="home-inbox"',
      'id="home-pinned-dms"',
      'id="home-friends"',
    ].map(mark => html.indexOf(mark))
    expect(order.every(at => at >= 0)).toBe(true)
    expect(order).toEqual([...order].sort((a, b) => a - b))
  })

  test('a new account keeps Get started above the two columns', () => {
    useStore.setState({ dms: [dm(1, 'alice', true)], layout: emptyLayout })
    const html = render()
    const order = ['id="home-get-started"', 'data-p2p-home', 'id="home-inbox"'].map(mark =>
      html.indexOf(mark)
    )
    expect(order.every(at => at >= 0)).toBe(true)
    expect(order).toEqual([...order].sort((a, b) => a - b))
    expect(html.includes('id="home-unread"')).toBe(false)
  })
})
