import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  allPings,
  dmPingCount,
  dmsUnread,
  scopePingCount,
  scopeUnread,
  serverPingCount,
  serverUnread,
  useStore,
} from '../store'
import { EMPTY_NOTIFY, muteEnd, notifyValue, setLevel, setMute } from '../notify'
import { setNotifier } from '../platform'
import { webNotifier } from '../platform/web_notifications'
import { home } from '../instances'
import { fakeNotifier } from './fake_notifier'
import type { Ping, WsEvent } from '../types'
import { me, memoryStorage, msg, serverDetail, user } from './fixtures'

const st = () => useStore.getState()
const dispatch = (ev: WsEvent) => st().applyWsEvent(ev)
const realFetch = globalThis.fetch
const realWindow = (globalThis as { window?: unknown }).window
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

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
const toasts = () => st().notices.map(n => `${n.name}|${n.title}|${n.body}`)

const chan = { kind: 'channel', id: 1, server: 's' } as const
const server = { kind: 'server', name: 's' } as const
const dm = { kind: 'dm', id: 4 } as const

beforeEach(() => {
  ;(globalThis as { window?: unknown }).window = {
    location: { pathname: '/', href: 'http://x/', origin: 'http://x', protocol: 'http:' },
    history: { state: null, pushState: () => {}, replaceState: () => {} },
  }
  globalThis.fetch = (async () => new Response('[]', { status: 200 })) as unknown as typeof fetch
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
  ;(globalThis as { window?: unknown }).window = realWindow
})

describe('muting', () => {
  test('a muted channel: no dot and no toast, but pings still badge', () => {
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

describe('levels', () => {
  test('server default: mentions toast, plain channel messages do not', () => {
    dispatch(inChannel(10))
    expect(st().notices).toEqual([])
    dispatch(pinged(ping()))
    expect(toasts()).toEqual(['Alice|mentioned you in #general|hi @bob'])
  })

  test('All messages on a channel toasts every message, not while watching it', () => {
    st().setNotifyLevel(chan, 'all')
    dispatch(inChannel(10))
    expect(toasts()).toEqual(['Alice|in #general|hello'])
    st().setNotifyLevel({ kind: 'channel', id: 2, server: 's' }, 'all')
    dispatch(inChannel(11, 'here', 2))
    expect(toasts()).toEqual(['Alice|in #general|hello'])
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
    expect(toasts()).toEqual(['Alice|in #general|Alice left the server.'])
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
    expect(toasts()).toEqual(['Alice||hey'])
    st().setNotifyLevel(dm, 'mentions')
    dispatch(inDm(12, 'again'))
    expect(toasts()).toEqual(['Alice||hey'])
    dispatch(pinged(ping({ id: 2, scope: 'd4', server: null })))
    expect(toasts()).toEqual(['Alice||hey', 'Alice|mentioned you|hi @bob'])
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
    expect(toasts()).toEqual(['Alice||dm thread'])
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
    st().setDesktopNotify(true)
  })
  afterEach(() => {
    setNotifier(webNotifier)
    g.document = realDocument
    useStore.setState({ streamer: false })
  })

  test('go through the platform layer with the scope tag and renotify', () => {
    dispatch(pinged(ping()))
    dispatch(pinged(ping({ id: 2, excerpt: 'again @bob' })))
    expect(fake.shown.map(n => [n.title, n.body, n.tag, n.renotify])).toEqual([
      ['Alice mentioned you in #general', 'hi @bob', 'c1', true],
      ['Alice mentioned you in #general', 'again @bob', 'c1', true],
    ])
  })

  test('streamer mode leaves out names and text; muted scopes stay quiet', () => {
    useStore.setState({ streamer: true })
    dispatch(inDm(11))
    expect(fake.shown.map(n => [n.title, n.body, n.tag])).toEqual([['New message', '', 'd4']])
    st().muteScope(dm, 'forever')
    dispatch(inDm(12))
    expect(fake.shown.length).toBe(1)
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
    expect(toasts().length).toBe(3)
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

  test('signing in drops rules for servers and DMs the account is no longer in', async () => {
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
      home.ws.stop()
      useStore.setState({ token: null })
      g.document = realDocument
      Object.assign(globalThis, { localStorage: memoryStorage })
    }
  })
})
