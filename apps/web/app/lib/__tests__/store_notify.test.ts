import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  allPings,
  getHomeSession,
  dmPingCount,
  dmsUnread,
  scopePingCount,
  scopeUnread,
  serverPingCount,
  serverUnread,
  useStore,
  resetSessionCaches,
} from '../store'
import { EMPTY_NOTIFY, muteEnd, notifyValue, setLevel, setMute } from '../notify'
import { setNotifier } from '../platform'
import { resetMasking, setMasking } from '../profanity'
import { webNotifier } from '../platform/web_notifications'
import { home } from '../instances'
import { fakeNotifier } from './fake_notifier'
import { alertBody, context, headline, type Piece } from '../notices'
import type { Ping, WsEvent } from '../types'
import { me, media, memoryStorage, msg, serverDetail, user } from './fixtures'
import { p2p, p2pDm, useP2p } from '../p2p/app'
import { put } from '../p2p/app/store'
import { keyId, newKeyPair } from '../p2p/keys'

afterAll(resetSessionCaches)

const st = () => useStore.getState()
const dispatch = (ev: WsEvent) => st().applyWsEvent(ev)
const realFetch = globalThis.fetch
const realWindow = (globalThis as { window?: unknown }).window
const realWebSocket = globalThis.WebSocket
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// A socket whose host never resolves. A client left running here probes the catch-all fetch,
// polls, and reloads site settings from it, which later files then inherit.
class DeadSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSED = 3
  readyState = 0
  onopen: (() => void) | null = null
  onclose: ((e: { code: number }) => void) | null = null
  onerror: (() => void) | null = null
  onmessage: (() => void) | null = null
  constructor() {
    setTimeout(() => {
      this.readyState = 3
      this.onclose?.({ code: 1006 })
    })
  }
  send() {}
  close() {
    this.readyState = 3
  }
}
let settingsBefore = st().settings

const ping = (over: Partial<Ping> = {}): Ping => ({
  id: 1,
  kind: 'mention',
  scope: 'c1',
  server: 's',
  message_id: 10,
  thread_root_id: null,
  actor: user('alice', { display_name: 'Alice' }),
  emoji: null,
  excerpt: 'hi @bob',
  created_at: 1,
  ...over,
})
const pinged = (p: Ping): WsEvent => ({ type: 'ping', username: 'bob', ping: p })
const inChannel = (id: number, content = 'hello', channel = 1): WsEvent => ({
  type: 'message',
  server: 's',
  channel_id: channel,
  dm_id: null,
  dm_users: null,
  message: msg(id, {
    channel_id: channel,
    content,
    author: user('alice', { display_name: 'Alice' }),
  }),
})
const inDm = (id: number, content = 'hey'): WsEvent => ({
  type: 'message',
  server: null,
  channel_id: null,
  dm_id: 4,
  dm_users: ['alice', 'bob'],
  message: msg(id, {
    channel_id: null,
    dm_id: 4,
    content,
    author: user('alice', { display_name: 'Alice' }),
  }),
})
const line = (pieces: Piece[]) => pieces.map(p => p.text).join('')
const toasts = () =>
  st().notices.map(n => `${line(headline(n))}|${line(context(n))}|${alertBody(n.body, false)}`)

const chan = { kind: 'channel', id: 1, server: 's' } as const
const server = { kind: 'server', name: 's' } as const
const dm = { kind: 'dm', id: 4 } as const

beforeEach(() => {
  resetSessionCaches()
  ;(globalThis as { window?: unknown }).window = {
    location: { pathname: '/', href: 'http://x/', origin: 'http://x', protocol: 'http:' },
    history: { state: null, pushState: () => {}, replaceState: () => {} },
  }
  globalThis.fetch = (async () => new Response('[]', { status: 200 })) as unknown as typeof fetch
  globalThis.WebSocket = DeadSocket as unknown as typeof WebSocket
  settingsBefore = st().settings
  useStore.setState({
    me: me('bob'),
    token: 't',
    guest: false,
    view: { kind: 'channel', server: 's', channelId: 2 },
    servers: {
      s: serverDetail('s', {
        channels: [
          { id: 1, name: 'general', kind: 'text', slowmode_seconds: 0, perms: [] },
          { id: 2, name: 'random', kind: 'text', slowmode_seconds: 0, perms: [] },
        ] as never,
      }),
    },
    dms: [{ id: 4, other: user('alice'), is_self: false }],
    messages: {},
    newer: {},
    reads: {},
    pings: {},
    atBottom: { c2: true },
    panel: null,
    notices: [],
  })
  st().resetAllNotify()
})

afterEach(() => {
  st().resetAllNotify()
  globalThis.fetch = realFetch
  globalThis.WebSocket = realWebSocket
  ;(globalThis as { window?: unknown }).window = realWindow
  expect(st().settings).toBe(settingsBefore)
})

describe('muting', () => {
  test('a muted channel: no dot and no toast, but pings badge', () => {
    st().muteScope(chan, 'forever')
    dispatch(inChannel(10))
    expect(scopeUnread(st(), 'c1')).toBe(false)
    expect(serverUnread(st(), 's')).toBe(false)
    dispatch(pinged(ping()))
    expect(st().notices).toEqual([])
    expect(scopePingCount(st(), 'c1')).toBe(1)
    expect(serverPingCount(st(), 's')).toBe(1)
    st().muteScope(chan, null)
    expect(scopeUnread(st(), 'c1')).toBe(true)
    expect(serverUnread(st(), 's')).toBe(true)
  })

  test('a muted server hides its dot even when channel details are not loaded', () => {
    useStore.setState({ servers: {} })
    dispatch(inChannel(10))
    expect(serverUnread(st(), 's')).toBe(true)
    st().muteScope(server, 'forever')
    expect(serverUnread(st(), 's')).toBe(false)
    st().muteScope(server, null)
    st().muteScope(chan, 'forever')
    expect(serverUnread(st(), 's')).toBe(false)
  })

  test('a muted DM: no dot, no toast for messages or mentions', () => {
    st().muteScope(dm, 'forever')
    dispatch(inDm(11))
    expect(dmsUnread(st())).toBe(false)
    dispatch(pinged(ping({ scope: 'd4', server: null })))
    expect(st().notices).toEqual([])
    expect(dmPingCount(st())).toBe(1)
  })

  test('mutes end on their own: one timer prunes them', async () => {
    dispatch(inChannel(10))
    st().muteScope(chan, Date.now() + 30)
    expect(scopeUnread(st(), 'c1')).toBe(false)
    await sleep(120)
    expect(st().notifyPrefs.channels).toEqual({})
    expect(scopeUnread(st(), 'c1')).toBe(true)
  })

  test('folder mute mutes every server in it', () => {
    st().muteServers(['s', 't'], 'forever')
    expect(Object.keys(st().notifyPrefs.servers)).toEqual(['s', 't'])
    st().muteServers(['s', 't'], null)
    expect(st().notifyPrefs).toEqual(EMPTY_NOTIFY)
  })

  test('folder mute never shortens a longer mute', () => {
    const now = Date.now()
    st().muteScope({ kind: 'server', name: 't' }, 'forever')
    st().muteScope({ kind: 'server', name: 'u' }, now + 3_600_000)
    st().muteServers(['s', 't', 'u'], now + 900_000)
    const end = (name: string) => muteEnd(st().notifyPrefs, { kind: 'server', name }, now)
    expect([end('s'), end('t'), end('u')]).toEqual([now + 900_000, 'forever', now + 3_600_000])
  })
})

describe('an instance view under P2P', () => {
  const p2pSaved = { ...useP2p.getState() }
  const BOB = keyId(newKeyPair().pk)
  const CAROL = keyId(newKeyPair().pk)
  const onDm = () => {
    useStore.setState({ view: { kind: 'dm', dmId: 4 }, atBottom: { d4: true } })
    dispatch(inDm(10))
    expect(st().reads.d4.lastRead).toBe(10)
  }
  // What a covered view must not do: its new messages are read and alert nothing.
  const notSeen = (id: number) => {
    useStore.setState({ notices: [] })
    dispatch(inDm(id))
    expect(st().reads.d4.lastRead).toBe(10)
    expect(scopeUnread(st(), 'd4')).toBe(true)
    expect(toasts()).toEqual(['Alice|Direct message|hey'])
  }

  beforeEach(() => {
    getHomeSession().identities.setAccount('bob')
    put.reader({ store: { room: async () => undefined } as never, me: BOB })
    useP2p.setState({ ...p2pSaved, enabled: true, account: 'bob' })
  })
  afterEach(() => {
    put.reader(null)
    getHomeSession().identities.setAccount(null)
    useP2p.setState(p2pSaved)
  })

  test('a P2P conversation open beside the DM list leaves the DM under it unread', async () => {
    onDm()
    await p2pDm.openDm(CAROL, 'dms')
    expect(useP2p.getState()).toMatchObject({ home: true, dmList: true })
    notSeen(11)
    dispatch(pinged(ping({ id: 2, scope: 'd4', server: null, message_id: 12 })))
    expect(dmPingCount(st())).toBe(1)
  })

  test('the P2P home over the DM leaves it unread too', () => {
    onDm()
    p2p.openHome()
    notSeen(11)
    dispatch(pinged(ping({ id: 2, scope: 'd4', server: null, message_id: 12 })))
    expect(dmPingCount(st())).toBe(1)
  })

  test('a P2P server shown in its place leaves it unread too', () => {
    onDm()
    useP2p.setState({ server: { room: 'r', ch: null } })
    notSeen(11)
  })

  test('closed again, the DM counts as seen only once its pane is back on screen', async () => {
    onDm()
    await p2pDm.openDm(CAROL, 'dms')
    notSeen(11)
    p2p.closeHome()
    expect(st().unreadAnchor.d4).toBe(10)
    notSeen(12)
    st().setAtBottom('d4', true)
    useStore.setState({ notices: [] })
    dispatch(inDm(13))
    expect(st().reads.d4.lastRead).toBe(13)
    expect(st().notices).toEqual([])
  })

  const own = (id: number): WsEvent => {
    const ev = inDm(id, 'from me')
    return ev.type === 'message' ? { ...ev, message: { ...ev.message, author: user('bob') } } : ev
  }
  // Sends in DM 4; the server answers with message `id` only once `answer` runs.
  const slowSend = async (id: number) => {
    const answers: (() => void)[] = []
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'POST' && String(input).includes('/api/dms/4/messages')) {
        await new Promise<void>(r => answers.push(r))
        const ev = own(id)
        return Response.json(ev.type === 'message' ? ev.message : null)
      }
      return Response.json([])
    }) as typeof fetch
    st().sendMessage('from me')
    await sleep(0)
    expect(answers.length).toBe(1)
    return async () => {
      answers[0]()
      await sleep(0)
      expect(st().outbox.d4).toBeUndefined()
    }
  }
  const mention = (id: number, pingId: number) => {
    dispatch(inDm(id, 'hey @bob'))
    dispatch(pinged(ping({ id: pingId, scope: 'd4', server: null, message_id: id })))
  }
  const unseen = (lastRead: number, pings: number) => {
    expect(st().reads.d4.lastRead).toBe(lastRead)
    expect(scopeUnread(st(), 'd4')).toBe(true)
    expect(dmPingCount(st())).toBe(pings)
  }

  test('a send answered under P2P leaves what came in before it unread', async () => {
    onDm()
    useStore.setState({ outbox: {} })
    const answer = await slowSend(12)
    p2p.openHome()
    mention(11, 2)
    await answer()
    unseen(10, 1)
  })

  test('a send answered under P2P after a newer mention keeps that mention unread', async () => {
    onDm()
    useStore.setState({ outbox: {} })
    const answer = await slowSend(11)
    await p2pDm.openDm(CAROL, 'dms')
    mention(12, 2)
    await answer()
    unseen(10, 1)
  })

  test('my message from another device under P2P leaves what came in before it unread', () => {
    onDm()
    p2p.openHome()
    mention(11, 2)
    dispatch(own(12))
    unseen(10, 1)
  })

  test('an older message of mine arriving under P2P keeps a newer mention unread', async () => {
    onDm()
    await p2pDm.openDm(CAROL, 'dms')
    mention(12, 2)
    dispatch(own(11))
    unseen(10, 1)
  })

  test('my own messages alone under P2P make no unread dot and keep the pings', async () => {
    onDm()
    useStore.setState({ outbox: {} })
    const answer = await slowSend(12)
    p2p.openHome()
    dispatch(pinged(ping({ id: 2, kind: 'reaction', scope: 'd4', server: null, message_id: 9 })))
    expect(dmPingCount(st())).toBe(1)
    dispatch(own(11))
    await answer()
    dispatch(own(12))
    expect(scopeUnread(st(), 'd4')).toBe(false)
    expect(st().reads.d4).toMatchObject({ lastRead: 10, latest: 10 })
    expect(dmPingCount(st())).toBe(1)
  })

  test('a read from another device clears what P2P covers', () => {
    onDm()
    p2p.openHome()
    mention(11, 2)
    dispatch(own(12))
    dispatch({ type: 'read_updated', username: 'bob', scope: 'd4', last_read: 12, pings_until: 2 })
    expect(st().reads.d4.lastRead).toBe(12)
    expect(scopeUnread(st(), 'd4')).toBe(false)
    expect(dmPingCount(st())).toBe(0)
  })

  test('a read from another device of what came before my message clears the DM', () => {
    onDm()
    p2p.openHome()
    mention(11, 2)
    dispatch(own(12))
    dispatch({ type: 'read_updated', username: 'bob', scope: 'd4', last_read: 11, pings_until: 2 })
    expect(st().reads.d4.lastRead).toBe(11)
    expect(scopeUnread(st(), 'd4')).toBe(false)
    expect(dmPingCount(st())).toBe(0)
  })

  test('a read from another device of what came before a send answered under P2P clears the DM', async () => {
    onDm()
    useStore.setState({ outbox: {} })
    const answer = await slowSend(12)
    p2p.openHome()
    mention(11, 2)
    await answer()
    dispatch({ type: 'read_updated', username: 'bob', scope: 'd4', last_read: 11, pings_until: 2 })
    expect(st().reads.d4.lastRead).toBe(11)
    expect(scopeUnread(st(), 'd4')).toBe(false)
    expect(dmPingCount(st())).toBe(0)
  })

  test('back on screen, my messages read the DM once its pane follows the bottom', async () => {
    onDm()
    await p2pDm.openDm(CAROL, 'dms')
    mention(11, 2)
    dispatch(own(12))
    p2p.closeHome()
    dispatch(own(13))
    unseen(10, 1)
    st().setAtBottom('d4', true)
    useStore.setState({ outbox: {} })
    const answer = await slowSend(14)
    await answer()
    expect(st().reads.d4.lastRead).toBe(14)
    expect(scopeUnread(st(), 'd4')).toBe(false)
    expect(dmPingCount(st())).toBe(0)
  })

  test('a send answered under P2P before an earlier incoming message arrives leaves it unread', async () => {
    onDm()
    useStore.setState({ outbox: {} })
    const answer = await slowSend(12)
    p2p.openHome()
    await answer()
    dispatch(inDm(11, 'are you there?'))
    unseen(10, 0)
  })

  // The address bar starts at `path` and records what is pushed; the server answers the server's
  // details and the location of message 11 (in DM 4).
  const opening = (path: string) => {
    const pushed: string[] = []
    let at = path
    ;(globalThis as { window?: unknown }).window = {
      location: {
        get pathname() {
          return at
        },
        href: 'http://x/',
        origin: 'http://x',
        protocol: 'http:',
      },
      history: {
        state: null,
        pushState: (_: unknown, __: string, p: string) => {
          at = p
          pushed.push(p)
        },
        replaceState: (_: unknown, __: string, p: string) => {
          at = p
        },
      },
    }
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input).replace(/^https?:\/\/[^/]+/, '')
      if (url === '/api/servers/s') return Response.json(st().servers.s)
      if (url === '/api/messages/11/location' || url === '/api/messages/11/location?preview=false')
        return Response.json({
          id: 11,
          server: null,
          channel_id: null,
          dm_id: 4,
          thread_root_id: null,
          author: user('alice'),
          created_at: 1,
          content: 'hey @bob',
          has_media: false,
          kind: 'user',
          forwarded: false,
        })
      return Response.json([])
    }) as typeof fetch
    useStore.setState({ error: null })
    return pushed
  }

  test("a mention's alert for the DM under a P2P conversation enters the DM again", async () => {
    onDm()
    const pushed = opening('/dm/4/')
    await p2pDm.openDm(CAROL, 'dms')
    const covered = st().view
    mention(11, 2)
    expect(st().notices).toHaveLength(1)
    await st().openPing(ping({ id: 2, scope: 'd4', server: null, message_id: 11 }))
    expect(st().view).not.toBe(covered)
    expect(st().view).toEqual({ kind: 'dm', dmId: 4 })
    expect(st().error).toBeNull()
    expect(pushed).toEqual([])
  })

  test("a mention's alert for the channel under the P2P home enters the channel again", async () => {
    useStore.setState({
      view: { kind: 'channel', server: 's', channelId: 1 },
      atBottom: { c1: true },
    })
    dispatch(inChannel(10))
    const pushed = opening('/s/s/1/')
    p2p.openHome()
    const covered = st().view
    const p = ping({ id: 3, scope: 'c1', server: 's', message_id: 11 })
    dispatch(inChannel(11, 'hi @bob'))
    dispatch(pinged(p))
    expect(st().notices).toHaveLength(1)
    await st().openPing(p)
    expect(st().view).not.toBe(covered)
    expect(st().view).toEqual({ kind: 'channel', server: 's', channelId: 1 })
    expect(st().error).toBeNull()
    expect(pushed).toEqual([])
  })

  test('a link to a message in the DM under a P2P server enters the DM again', async () => {
    onDm()
    const pushed = opening('/dm/4/')
    useP2p.setState({ server: { room: 'r', ch: null } })
    const covered = st().view
    await st().openMessage(11)
    expect(st().view).not.toBe(covered)
    expect(st().view).toEqual({ kind: 'dm', dmId: 4 })
    expect(st().error).toBeNull()
    expect(pushed).toEqual([])
  })

  test('with nothing over it, the alert for the DM on screen shows the message in place', async () => {
    onDm()
    opening('/dm/4/')
    const shown = st().view
    mention(11, 2)
    await st().openPing(ping({ id: 2, scope: 'd4', server: null, message_id: 11 }))
    expect(st().view).toBe(shown)
    expect(st().focus.d4).toEqual({ id: 11, flash: true })
  })
})

describe('own messages and the read mark', () => {
  const own = (id: number): WsEvent => {
    const ev = inDm(id, 'from me')
    return ev.type === 'message' ? { ...ev, message: { ...ev.message, author: user('bob') } } : ev
  }

  test('in the DM on screen at the bottom, my message from another device reads it', () => {
    useStore.setState({ view: { kind: 'dm', dmId: 4 }, atBottom: { d4: false } })
    dispatch(inDm(10))
    dispatch(pinged(ping({ id: 2, scope: 'd4', server: null, message_id: 10 })))
    st().setAtBottom('d4', true)
    dispatch(own(11))
    expect(st().reads.d4.lastRead).toBe(11)
    expect(dmPingCount(st())).toBe(0)
  })

  test('in another view, my message from another device leaves what came before it unread', () => {
    dispatch(inDm(10))
    dispatch(own(11))
    expect(st().reads.d4.lastRead).toBe(9)
    expect(scopeUnread(st(), 'd4')).toBe(true)
  })

  test('in another view, a read from another device of everything before my message clears the dot', () => {
    useStore.setState({ reads: { d4: { lastRead: 10, latest: 10 } } })
    dispatch(inDm(11))
    dispatch(own(12))
    dispatch({ type: 'read_updated', username: 'bob', scope: 'd4', last_read: 11, pings_until: 0 })
    expect(st().reads.d4).toMatchObject({ lastRead: 11, latest: 11 })
    expect(scopeUnread(st(), 'd4')).toBe(false)
  })

  test('in another view, my message after everything was read makes no unread dot', () => {
    useStore.setState({ reads: { d4: { lastRead: 10, latest: 10 } } })
    dispatch(own(11))
    expect(st().reads.d4).toMatchObject({ lastRead: 10, latest: 10 })
    expect(scopeUnread(st(), 'd4')).toBe(false)
  })

  test('in another view, my message handled before an earlier incoming one leaves that one unread', () => {
    useStore.setState({ reads: { d4: { lastRead: 10, latest: 10 } } })
    dispatch(own(12))
    dispatch(inDm(11))
    expect(st().reads.d4).toMatchObject({ lastRead: 10, latest: 11 })
    expect(scopeUnread(st(), 'd4')).toBe(true)
  })
})

describe('levels', () => {
  test('server default: mentions toast, plain channel messages do not', () => {
    dispatch(inChannel(10))
    expect(st().notices).toEqual([])
    dispatch(pinged(ping()))
    expect(toasts()).toEqual(['Alice mentioned you|s · #general|hi @bob'])
  })

  test('All messages on a channel toasts every message, not while watching it', () => {
    st().setNotifyLevel(chan, 'all')
    dispatch(inChannel(10))
    expect(toasts()).toEqual(['Alice|s · #general|hello'])
    st().setNotifyLevel({ kind: 'channel', id: 2, server: 's' }, 'all')
    dispatch(inChannel(11, 'here', 2))
    expect(toasts()).toEqual(['Alice|s · #general|hello'])
  })

  test('join and leave rows: unread, a toast with their line under All messages, no ping', () => {
    const system = (id: number, kind: 'join' | 'leave'): WsEvent => {
      const ev = inChannel(id, '')
      return ev.type === 'message' ? { ...ev, message: { ...ev.message, kind } } : ev
    }
    dispatch(system(12, 'join'))
    expect(st().notices).toEqual([])
    expect(scopeUnread(st(), 'c1')).toBe(true)
    expect(scopePingCount(st(), 'c1')).toBe(0)
    st().setNotifyLevel(chan, 'all')
    dispatch(system(13, 'leave'))
    expect(toasts()).toEqual(['Alice|s · #general|Alice left the server.'])
  })

  test('a mention under All messages toasts once, as the ping', () => {
    st().setNotifyLevel(server, 'all')
    dispatch(inChannel(10, 'hi @bob'))
    expect(st().notices).toEqual([])
  })

  test('Nothing: no toasts and no badges, the dot stays', () => {
    st().setNotifyLevel(server, 'nothing')
    dispatch(inChannel(10))
    dispatch(pinged(ping()))
    expect(st().notices).toEqual([])
    expect(Object.keys(st().pings)).toEqual(['c1'])
    expect(scopePingCount(st(), 'c1')).toBe(0)
    expect(serverPingCount(st(), 's')).toBe(0)
    expect(allPings(st())).toBe(0)
    expect(scopeUnread(st(), 'c1')).toBe(true)
    st().setNotifyLevel(chan, 'mentions')
    expect(scopePingCount(st(), 'c1')).toBe(1)
  })

  test('DMs default to all messages; Only @mentions keeps just the pings', () => {
    dispatch(inDm(11))
    expect(toasts()).toEqual(['Alice|Direct message|hey'])
    st().setNotifyLevel(dm, 'mentions')
    dispatch(inDm(12, 'again'))
    expect(toasts()).toEqual(['Alice|Direct message|hey'])
    dispatch(pinged(ping({ id: 2, scope: 'd4', server: null })))
    expect(toasts()).toEqual(['2 new messages from Alice|Direct message|hi @bob'])
  })

  test('thread replies toast in DMs, not under a server channel set to All messages', () => {
    st().setNotifyLevel(chan, 'all')
    const reply = inChannel(11, 'in thread')
    if (reply.type === 'message') reply.message.thread_root_id = 5
    dispatch(reply)
    expect(st().notices).toEqual([])
    const dmReply = inDm(12, 'dm thread')
    if (dmReply.type === 'message') dmReply.message.thread_root_id = 6
    dispatch(dmReply)
    expect(toasts()).toEqual(['Alice|Direct message|dm thread'])
  })

  test('DM set to Nothing: silent, no badge', () => {
    st().setNotifyLevel(dm, 'nothing')
    dispatch(inDm(11))
    dispatch(pinged(ping({ scope: 'd4', server: null })))
    expect(st().notices).toEqual([])
    expect(dmPingCount(st())).toBe(0)
    expect(dmsUnread(st())).toBe(true)
  })
})

describe('desktop notifications', () => {
  const g = globalThis as { document?: unknown }
  const realDocument = g.document
  let fake = fakeNotifier('granted')
  beforeEach(() => {
    fake = fakeNotifier('granted')
    setNotifier(fake)
    g.document = { visibilityState: 'hidden', hasFocus: () => false }
    useStore.setState({ streamer: false })
    st().setDesktopNotify(true)
  })
  afterEach(() => {
    st().setDesktopNotify(false)
    setNotifier(webNotifier)
    g.document = realDocument
    useStore.setState({ streamer: false })
  })

  test('go through the platform layer with the scope tag and renotify', () => {
    dispatch(pinged(ping()))
    dispatch(pinged(ping({ id: 2, excerpt: 'again @bob' })))
    expect(fake.shown.map(n => [n.title, n.body, n.tag, n.renotify])).toEqual([
      ['Alice mentioned you in #general', 'hi @bob', 'c1', true],
      ['2 new messages from Alice in #general', 'again @bob', 'c1', true],
    ])
  })

  test('an outstanding notification cannot navigate a replacement session', () => {
    const opened: unknown[][] = []
    const original = st().openDm
    useStore.setState({ openDm: (...args: unknown[]) => void opened.push(args) } as never)
    try {
      dispatch(inDm(11))
      const click = fake.shown[0].onClick
      click()
      expect(opened.length).toBe(1)
      resetSessionCaches()
      click()
      expect(opened.length).toBe(1)
    } finally {
      useStore.setState({ openDm: original })
    }
  })

  test('streamer mode leaves out names and text; muted scopes stay quiet', () => {
    useStore.setState({ streamer: true })
    dispatch(inDm(11))
    expect(fake.shown.map(n => [n.title, n.body, n.tag])).toEqual([['New message', '', 'd4']])
    st().muteScope(dm, 'forever')
    dispatch(inDm(12))
    expect(fake.shown.length).toBe(1)
  })

  test('spoilers never reach a system notification', () => {
    dispatch(inDm(11, 'it was ||the butler|| all along'))
    dispatch(pinged(ping({ id: 3, excerpt: 'hey @bob ||the end is cut' })))
    expect(fake.shown.map(n => n.body)).toEqual(['it was ████████ all along', 'hey @bob ████████'])
  })

  test('a forwarded copy from a closed room alerts without its text', () => {
    useStore.setState({
      servers: {
        s: serverDetail('s', {
          channels: [
            { id: 1, name: 'general', kind: 'text', slowmode_seconds: 0 },
            { id: 3, name: 'proofs', kind: 'text', slowmode_seconds: 0, sensitive: true },
          ],
        }),
      },
    })
    const copy = (id: number, origin: number): WsEvent => {
      const ev = inChannel(id, 'Amber folio')
      if (ev.type === 'message')
        ev.message.forward = {
          author: user('carol'),
          created_at: 1,
          source_id: 5,
          origin: null,
          origin_channel_id: origin,
          dropped: null,
        }
      return ev
    }
    st().setNotifyLevel(chan, 'all')
    dispatch(copy(11, 3))
    dispatch(copy(12, 1))
    expect(fake.shown.map(n => n.body)).toEqual(['Forwarded message', 'Amber folio'])
  })

  test('a spoilered attachment without text is "Attachment", never its filename', () => {
    const file = (id: number, spoiler: boolean): WsEvent => {
      const ev = inDm(id, '')
      if (ev.type === 'message')
        ev.message.media = media({ id: `m${id}`, filename: `plot${id}.png`, spoiler })
      return ev
    }
    dispatch(file(11, true))
    dispatch(file(12, false))
    expect(fake.shown.map(n => n.body)).toEqual(['Attachment', 'plot12.png'])
  })

  test('the name of a file without text is masked as a file name', async () => {
    const readings = {
      text: (t: string) => t.replace(/plot/g, '****'),
      file: (t: string) => t.replace(/png/g, '***'),
    }
    await setMasking(true, () => Promise.resolve(readings))
    const ev = inDm(11, '')
    if (ev.type === 'message') ev.message.media = media({ filename: 'plot.png' })
    dispatch(ev)
    expect(st().notices.at(-1)?.file).toBe(true)
    dispatch(inDm(12, 'plot.png'))
    expect(st().notices.at(-1)?.file).toBe(false)
    expect(fake.shown.map(n => n.body)).toEqual(['plot.***', '****.png'])
    resetMasking()
  })

  test('none while the tab has focus, without permission, or switched off', () => {
    g.document = { visibilityState: 'visible', hasFocus: () => true }
    dispatch(inDm(11))
    g.document = { visibilityState: 'hidden', hasFocus: () => false }
    fake.grant('denied')
    dispatch(inDm(12))
    fake.grant('granted')
    st().setDesktopNotify(false)
    dispatch(inDm(13))
    expect(fake.shown).toEqual([])
    expect(toasts()).toEqual(['3 new messages from Alice|Direct message|hey'])
  })
})

describe('membership', () => {
  test("leaving a server forgets its rules and its channels' rules", () => {
    st().muteScope(server, 'forever')
    st().muteScope(chan, 'forever')
    st().setNotifyLevel({ kind: 'channel', id: 7, server: 'other' }, 'all')
    dispatch({ type: 'member_left', server: 's', username: 'bob' })
    expect(Object.keys(st().notifyPrefs.servers)).toEqual([])
    expect(Object.keys(st().notifyPrefs.channels)).toEqual(['7'])
  })

  test('a deleted channel drops its rule; a renamed server keeps its rule', () => {
    st().muteScope(chan, 'forever')
    st().muteScope(server, 'forever')
    dispatch({ type: 'channel_deleted', server: 's', channel_id: 1 } as WsEvent)
    expect(Object.keys(st().notifyPrefs.channels)).toEqual([])
    dispatch({
      type: 'server_renamed',
      old_name: 's',
      server: { name: 'z', display_name: 'Z', creator: null, has_password: false },
    })
    expect(Object.keys(st().notifyPrefs.servers)).toEqual(['z'])
  })

  test('signing in drops rules for servers and DMs the account has left', async () => {
    const g = globalThis as { document?: unknown }
    const realDocument = g.document
    g.document = { cookie: '' }
    const storage = new Map<string, string>()
    Object.assign(globalThis, {
      localStorage: {
        getItem: (k: string) => storage.get(k) ?? null,
        setItem: (k: string, v: string) => void storage.set(k, v),
        removeItem: (k: string) => void storage.delete(k),
      },
    })
    let p = setMute(EMPTY_NOTIFY, { kind: 'server', name: 's' }, 'forever')
    p = setMute(p, { kind: 'server', name: 'gone' }, 'forever')
    p = setLevel(p, { kind: 'server', name: 'later' }, 'all')
    p = setLevel(p, dm, 'nothing')
    p = setLevel(p, { kind: 'dm', id: 99 }, 'nothing')
    p = setLevel(p, { kind: 'channel', id: 1, server: 's' }, 'all')
    p = setLevel(p, { kind: 'channel', id: 50, server: null }, 'all')
    storage.set('rchat_notify:bob', notifyValue(p))
    const srv = (name: string) => ({ name, display_name: name, creator: null, is_admin: false })
    globalThis.fetch = (async (url: string) => {
      const u = String(url)
      const bob = me('bob', { servers: [srv('s')], dms: [] })
      const body = u.includes('/auth/login')
        ? { token: 'tok', user: bob }
        : /\/me(\?|$)/.test(u)
          ? bob
          : u.includes('/me/servers?names=')
            ? u.includes('later')
              ? [srv('later')]
              : []
            : u.includes('/dms?ids=')
              ? [{ id: 4, other: user('alice'), is_self: false }]
              : []
      return new Response(JSON.stringify(body), { status: 200 })
    }) as unknown as typeof fetch
    useStore.setState({ me: null, dms: [], servers: {}, reads: {} })
    const { start } = home.ws
    home.ws.start = () => {}
    try {
      await st().login({ username: 'bob', password: 'x' } as never)
      await sleep(30)
      const now = st().notifyPrefs
      expect(Object.keys(now.servers).sort()).toEqual(['later', 's'])
      expect(Object.keys(now.dms)).toEqual(['4'])
      expect(Object.keys(now.channels).sort()).toEqual(['1', '50'])
      expect(JSON.parse(storage.get('rchat_notify:bob') ?? '{}').dms).toEqual({
        4: { level: 'nothing' },
      })
    } finally {
      home.ws.start = start
      home.ws.stop()
      useStore.setState({ token: null })
      g.document = realDocument
      Object.assign(globalThis, { localStorage: memoryStorage })
    }
  })
})

describe('toasts', () => {
  test('one conversation stacks, clicking opens its newest message', () => {
    const opened: unknown[][] = []
    const realOpen = st().openDm
    useStore.setState({ openDm: (...args: unknown[]) => void opened.push(args) } as never)
    dispatch(inDm(11, 'one'))
    dispatch(inDm(12, 'two'))
    expect(toasts()).toEqual(['2 new messages from Alice|Direct message|two'])
    st().notices[0].go()
    expect(opened).toEqual([[4, 'push', 12]])
    useStore.setState({ openDm: realOpen })
  })

  test('pausing stops the timers until resumed; dismiss removes one', () => {
    dispatch(inDm(11))
    st().pauseNotices(true)
    expect(st().noticesPaused).toBe(true)
    expect(st().notices[0].timer.since).toBeNull()
    dispatch(pinged(ping({ id: 5 })))
    expect(st().notices.map(n => n.timer.since)).toEqual([null, null])
    st().pauseNotices(false)
    expect(st().notices.every(n => n.timer.since !== null)).toBe(true)
    st().dismissNotice(st().notices[0].id)
    expect(toasts()).toEqual(['Alice mentioned you|s · #general|hi @bob'])
  })
})
