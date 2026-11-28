import { flush } from './helpers/test_clock'
import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test'
import { askKick } from '../place/moderation'
import { HostedServer } from '../place/place'
import { client } from '../client/client'
import { paletteCtx } from '../actions/ctx'
import { registerAppActions } from '../actions/index'
import { actionById } from '../actions/registry'
import { type ConfigDoc, stashConfig } from '../config_transfer'
import { loadApiHistory, noteRequest, sendRequest, useApiDoc } from '../api_console'
import type { InboxView } from '../inbox'
import { instanceInbox } from '../inbox_source'
import { sessionStore } from '../instances'
import { home, api } from './home_instance'
import { saveMedia } from '../media_src'
import { EMPTY_NOTIFY, notifyKey, notifyValue, setLevel } from '../notify'
import { EMPTY_HISTORY, historyKey, type HistoryEntry } from '../openapi'
import { setSharing, sharing } from '../platform'
import { threadItems } from '../palette_results'
import { POLL_FETCH_MS } from '../polls_store'
import { cachedProfile, profileKey, rememberProfile } from '../profile'
import {
  getHomeSession,
  Ended,
  inSession,
  revokeAdminFor,
  useStore,
  resetSessionCaches,
  sessionMark,
  type RChatState,
} from '../store'
import { emptyLayout, layoutKey } from '../nav_layout'
import { exportBackoff } from '../selection_store'
import type { BulkJob, Message, Poll, Profile, VoiceMsg } from '../types'
import {
  advance,
  embed as embedOf,
  me,
  media as mediaOf,
  member,
  memoryStorage,
  msg,
  result,
  serverDetail,
  user,
} from './fixtures'
import { Secret } from '../secret'
import { writeJson } from '../api/masks'

const { files: p2p, relays: relayBook, rtc } = getHomeSession()

const st = () => useStore.getState()
const realFetch = globalThis.fetch
const realWindow = (globalThis as { window?: unknown }).window
const realRandom = Math.random
const ws = home.ws as unknown as { sendVoice: (m: VoiceMsg) => boolean }
const realP2p = {
  stage: p2p.stage,
  posted: p2p.posted,
  removeFile: p2p.removeFile,
  startMedia: p2p.startMedia,
  endMedia: p2p.endMedia,
  peerId: p2p.peerId,
}
const realRtc = { join: rtc.join, camera: rtc.camera }
const realCheck = relayBook.check
const realSend = ws.sendVoice
const tick = async () => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve()
  await flush()
  for (let i = 0; i < 10; i += 1) await Promise.resolve()
}
const settle = async () => {
  for (let i = 0; i < 4; i += 1) await tick()
}

// Every request, as `<who> <METHOD> <path>`; `who` comes from the token it carried (`nobody`
// without one).
let asked: string[] = []
// Who is signed in now, as the requests name them.
let current = 'nobody'
// The requests of `holder` that match `held` (`<METHOD> <path>`) wait until `release()`.
let holder = 'nobody'
type Match = string | RegExp | ((line: string, body: unknown) => boolean)
let held: Match | null = null
let heldAsked = false
let gate: Promise<void> = Promise.resolve()
let release = () => {}
const hold = (match: Match) => {
  holder = current
  held = match
  heldAsked = false
  gate = new Promise<void>(r => {
    release = r
  })
}
const matches = (line: string, body: unknown) =>
  held !== null &&
  (typeof held === 'string'
    ? line.startsWith(held)
    : held instanceof RegExp
      ? held.test(line)
      : held(line, body))

// An answer, or undefined for the default one.
type Reply = (who: string, method: string, path: string, body: unknown) => unknown
let reply: Reply = () => undefined

const json = (body: unknown, status = 200) =>
  body instanceof Response ? body : new Response(writeJson(body), { status })

const channel = { id: 77, name: 'general', kind: 'text' as const, slowmode_seconds: 0 }
const summary = { name: 's', display_name: 's', creator: null, is_admin: false }

const answer: Reply = (who, method, path, body) => {
  const out = reply(who, method, path, body)
  if (out !== undefined) return out
  const line = `${method} ${path}`
  if (line === 'GET /me') return me(who, { servers: [summary] })
  if (line === 'GET /unreads') return { items: [], more: false }
  if (line === 'GET /friends/summary') return { incoming: 0, outgoing: 0, pings: 0 }
  if (line === 'GET /servers/s') return serverDetail('s', { channels: [channel] })
  if (line.startsWith('GET /me/servers?names=')) return [summary]
  return []
}

const signedIn = (name: string, over: Partial<RChatState> = {}) => {
  current = name
  api.setToken(Secret.of(`t-${name}`))
  useStore.setState({
    me: me(name, { servers: [summary] }),
    token: Secret.of(`t-${name}`),
    guest: false,
    error: null,
    toast: null,
    servers: { s: serverDetail('s', { channels: [channel] }) },
    ...over,
  })
}

const guestIn = (over: Partial<RChatState> = {}) => {
  current = 'nobody'
  api.setToken(null)
  useStore.setState({
    me: null,
    token: null,
    guest: true,
    guestServers: ['s'],
    error: null,
    toast: null,
    servers: { s: serverDetail('s', { channels: [channel] }) },
    ...over,
  })
}

// What `logout()` does to the store's queues and caches, then no token.
const signOut = () => {
  resetSessionCaches()
  api.setToken(null)
  current = 'nobody'
}

beforeEach(() => {
  memoryStorage.clear()
  Object.assign(globalThis, { localStorage: memoryStorage })
  ;(globalThis as { window?: unknown }).window = {
    location: { pathname: '/', href: 'http://x/', origin: 'http://x', protocol: 'http:' },
    history: { state: null, pushState: () => {}, replaceState: () => {} },
  }
  asked = []
  held = null
  heldAsked = false
  gate = Promise.resolve()
  reply = () => undefined
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input)
      .replace(/^https?:\/\/[^/]+/, '')
      .replace(/^\/api/, '')
    const method = init?.method ?? 'GET'
    const auth = (init?.headers as Record<string, string> | undefined)?.Authorization ?? ''
    const who = auth.startsWith('Bearer t-') ? auth.slice(9) : 'nobody'
    const line = `${method} ${path}`
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined
    asked.push(`${who} ${line}`)
    if (who === holder && matches(line, body)) {
      heldAsked = true
      await gate
    }
    return json(answer(who, method, path, body))
  }) as typeof fetch
})

afterEach(() => {
  jest.useRealTimers()
  signOut()
  globalThis.fetch = realFetch
  ;(globalThis as { window?: unknown }).window = realWindow
  Math.random = realRandom
  Object.assign(p2p, realP2p)
  Object.assign(rtc, realRtc)
  relayBook.check = realCheck
  ws.sendVoice = realSend
})

const ids = (key: string) => (st().messages[key] ?? []).map(m => m.id)

describe('first pages', () => {
  const lists: Reply = (who, method, path) =>
    method === 'GET' && /^\/(channels\/77|dms\/5|messages\/40\/thread)/.test(path)
      ? who === 'alice'
        ? [msg(500, { channel_id: 77, author: user('alice'), content: 'alice secret' })]
        : [msg(10, { channel_id: 77, author: user('bob'), content: 'bob own' })]
      : undefined

  const opens: [string, string, string, () => Promise<void>][] = [
    ['a channel', 'GET /channels/77/messages', 'c77', () => st().openChannel('s', 77)],
    [
      'a channel at a message',
      'GET /channels/77/messages',
      'c77',
      () => st().openChannel('s', 77, 'push', 500),
    ],
    ['a DM', 'GET /dms/5/messages', 'd5', () => st().openDm(5)],
    [
      'a thread',
      'GET /messages/40/thread',
      't40',
      () => st().openThread(msg(40, { channel_id: 77 })),
    ],
    ['the present', 'GET /channels/77/messages', 'c77', () => st().jumpToPresent('c77')],
  ]

  for (const [what, prefix, key, open] of opens)
    test(`${what}: a first page of the ended session never lands in the next one`, async () => {
      reply = lists
      signedIn('alice')
      hold(prefix)
      void open()
      await tick()
      expect(asked.some(a => a.startsWith(`alice ${prefix}`))).toBe(true)
      signOut()
      signedIn('bob')
      await open()
      await tick()
      expect(ids(key)).toEqual([10])
      const live = msg(11, { channel_id: 77, author: user('carol') })
      if (key === 'c77') {
        useStore.setState({ view: { kind: 'channel', server: 's', channelId: 77 } })
        st().applyWsEvent({
          type: 'message',
          message: live,
          server: 's',
          channel_id: 77,
          dm_id: null,
          dm_users: null,
        })
        expect(ids(key)).toEqual([10, 11])
      }
      release()
      await settle()
      expect(ids(key)).toEqual(key === 'c77' ? [10, 11] : [10])
      expect(st().error).toBeNull()
    })
})

test("a late first page leaves the next session's own load of that list alone", async () => {
  reply = (who, method, path) =>
    path.startsWith('/channels/77/messages')
      ? [msg(alices(who) ? 500 : 10, { channel_id: 77, author: user(who) })]
      : undefined
  signedIn('alice', { messages: { c77: [msg(9, { channel_id: 77 })] } })
  hold('GET /channels/77/messages')
  void st().openChannel('s', 77)
  await tick()
  signOut()
  signedIn('bob', { messages: { c77: [msg(9, { channel_id: 77 })] } })
  let openBob = () => {}
  const bobGate = new Promise<void>(r => {
    openBob = r
  })
  const inner = globalThis.fetch
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).includes('/channels/77/messages')) await bobGate
    return inner(input, init)
  }) as typeof fetch
  const bobs = st().openChannel('s', 77)
  await tick()
  expect(st().stale.c77).toBe(true)
  release()
  await settle()
  expect(st().stale.c77).toBe(true)
  expect(ids('c77')).toEqual([9])
  openBob()
  await bobs
  expect(ids('c77')).toEqual([10])
  expect(st().stale.c77).toBeUndefined()
})

describe('member lookups', () => {
  const members: Reply = (who, method, path) =>
    method === 'GET' && path.startsWith('/servers/s/members?usernames=')
      ? [member('carol', { display_name: `carol as ${who} sees her` })]
      : undefined

  test('a lookup that answers after the session ended writes nothing and holds up no lookup', async () => {
    reply = members
    signedIn('alice')
    hold('GET /servers/s/members?usernames=carol')
    void st().ensureMembers('s', ['carol'])
    await tick()
    signOut()
    signedIn('bob')
    await st().ensureMembers('s', ['carol'])
    await tick()
    expect(st().memberInfo.s?.carol?.display_name).toBe('carol as bob sees her')
    useStore.setState({ memberInfo: {} })
    release()
    await settle()
    expect(st().memberInfo.s?.carol).toBeUndefined()
    expect(asked.filter(a => a.startsWith('bob ')).length).toBe(1)
  })

  test('a refresh that answers after the session ended writes nothing', async () => {
    reply = members
    signedIn('alice')
    hold('GET /servers/s/members?usernames=carol')
    void st().refreshMember('s', 'carol')
    await tick()
    signOut()
    signedIn('bob')
    release()
    await settle()
    expect(st().memberInfo.s?.carol).toBeUndefined()
  })
})

const poll = (mine: number[] | null): Poll => ({
  kind: 'single',
  question: 'Lunch?',
  options: [
    { id: 1, text: 'Pizza', emoji: null },
    { id: 2, text: 'Soup', emoji: null },
  ],
  anonymous: false,
  show_results: 'always',
  allow_change: true,
  allow_add: false,
  min_choices: 1,
  max_choices: 1,
  scale: null,
  closes_at: null,
  closed: false,
  voters: 1,
  results: {
    counts: [1, 2].map(option_id => ({ option_id, count: 0 })),
    rounds: [],
    winner: null,
    distribution: [],
    average: null,
  },
  mine,
})
const pollMsg = (): Message =>
  msg(10, { channel_id: 77, kind: 'poll', author: user('carol'), poll: poll(null) })
const shown = () => st().messages.c77?.[0]?.poll?.mine ?? null

describe('polls', () => {
  test('the refetch of an ended session is never sent', async () => {
    jest.useFakeTimers()
    reply = (who, method, path) =>
      path === '/polls/10' ? poll(who === 'alice' ? [1] : [2]) : undefined
    signedIn('alice', { messages: { c77: [pollMsg()] } })
    st().applyWsEvent({ type: 'poll_voted', username: 'alice', message_id: 10 })
    signOut()
    signedIn('bob', { messages: { c77: [pollMsg()] } })
    await advance(POLL_FETCH_MS + 50)
    expect(asked.filter(a => a.includes('/polls/'))).toEqual([])
    expect(shown()).toBeNull()
  })

  test('a refetch that answers after the session ended writes nothing', async () => {
    jest.useFakeTimers()
    reply = (who, method, path) =>
      path === '/polls/10' ? poll(who === 'alice' ? [1] : [2]) : undefined
    signedIn('alice', { messages: { c77: [pollMsg()] } })
    hold('GET /polls/10')
    st().applyWsEvent({ type: 'poll_voted', username: 'alice', message_id: 10 })
    await advance(POLL_FETCH_MS + 50, () => asked.length > 0)
    expect(asked).toEqual(['alice GET /polls/10'])
    signOut()
    signedIn('bob', { messages: { c77: [pollMsg()] } })
    release()
    await advance(10)
    expect(shown()).toBeNull()
  })
})

describe('P2P sends', () => {
  const file = () => new File(['hello'], 'a.txt')
  let log: string[] = []
  // Stages after the first one wait for this.
  const stageGate: { wait: Promise<void> | null } = { wait: null }

  const sendAs = (name: string) => {
    signedIn(name, {
      view: { kind: 'channel', server: 's', channelId: 77 },
      messages: { c77: [] },
      outbox: {},
      pending: { c77: { file: file(), spoiler: false, mode: 'p2p', scope: 'c77' } },
    })
    st().sendMessage('')
  }

  beforeEach(() => {
    log = []
    stageGate.wait = null
    p2p.stage = async (id: string) => {
      log.push(`stage ${id.slice(0, 4)}`)
      if (stageGate.wait && log.filter(l => l.startsWith('stage')).length > 1) await stageGate.wait
    }
    p2p.posted = (id: string) => void log.push(`posted ${id.slice(0, 4)}`)
    p2p.removeFile = (id: string) => void log.push(`remove ${id.slice(0, 4)}`)
  })

  const taken = () => new Response(writeJson({ error: 'Invalid p2p_id' }), { status: 400 })
  const posts = () => asked.filter(a => a.includes('POST /channels/77/messages'))

  test('a refusal of the P2P id that answers after the session ended is not retried', async () => {
    reply = (who, method) => (method === 'POST' ? taken() : undefined)
    sendAs('alice')
    hold('POST /channels/77/messages')
    await settle()
    expect(posts()).toEqual(['alice POST /channels/77/messages'])
    signOut()
    signedIn('bob')
    release()
    await settle()
    expect(posts()).toEqual(['alice POST /channels/77/messages'])
    expect(log.filter(l => l.startsWith('stage')).length).toBe(1)
    expect(st().error).toBeNull()
  })

  test('a retry whose new P2P id is staged after the session ended is never posted', async () => {
    reply = (who, method) => (method === 'POST' ? taken() : undefined)
    sendAs('alice')
    let open = () => {}
    stageGate.wait = new Promise<void>(r => {
      open = r
    })
    await settle()
    expect(posts()).toEqual(['alice POST /channels/77/messages'])
    expect(log.filter(l => l.startsWith('stage')).length).toBe(2)
    signOut()
    signedIn('bob')
    reply = (who, method) =>
      method === 'POST' ? msg(90, { channel_id: 77, author: user(who) }) : undefined
    open()
    await settle()
    expect(posts()).toEqual(['alice POST /channels/77/messages'])
    expect(log.filter(l => l.startsWith('posted'))).toEqual([])
    expect(log.filter(l => l.startsWith('remove')).length).toBe(2)
    expect(ids('c77')).toEqual([])
  })
})

interface Late {
  // Alice's request that answers late: `<METHOD> <path>` (a prefix), a pattern or a test.
  hold: Match
  // Alice's session ends once this holds too (after her held request was asked).
  ready?: () => boolean
  // What Alice (or a guest, with `guest`) does before the session ends.
  start: () => unknown
  reply?: Reply
  // The state both sessions start from.
  state?: () => Partial<RChatState>
  // Who signs in next: another account, or the same one again (still a new session).
  next?: 'bob' | 'alice'
  // What the next session does before the late answer lands.
  then?: () => unknown
  guest?: boolean
  // What the late answer must leave as it was.
  keys: (keyof RChatState)[]
  // A resync waits up to 10 s before it asks: fake timers.
  timers?: boolean
}

const pick = (keys: (keyof RChatState)[]) => Object.fromEntries(keys.map(k => [k, st()[k]]))

// Alice's request answers after her session ended and the next one began: it changes none of
// `keys`, asks nothing more and shows nothing.
const late = async (c: Late) => {
  if (c.timers) {
    jest.useFakeTimers()
    Math.random = () => 0
  }
  reply = c.reply ?? (() => undefined)
  if (c.guest) guestIn(c.state?.())
  else signedIn('alice', c.state?.())
  hold(c.hold)
  void Promise.resolve(c.start()).catch(() => {})
  const reached = () => heldAsked && (c.ready?.() ?? true)
  if (c.timers) await advance(20_000, reached)
  else for (let i = 0; i < 50 && !reached(); i += 1) await tick()
  expect(reached()).toBe(true)
  if (c.timers) await advance(50)
  else await settle()
  signOut()
  signedIn(c.next ?? 'bob', c.state?.())
  if (c.then) {
    void Promise.resolve(c.then()).catch(() => {})
    if (c.timers) await advance(20_000)
    else await settle()
  }
  const before = pick(c.keys)
  const count = asked.length
  const logged: unknown[] = []
  const realError = console.error
  console.error = (...a: unknown[]) => void logged.push(a)
  try {
    await landLate(c)
  } finally {
    console.error = realError
  }
  expect(logged).toEqual([])
  expect(pick(c.keys)).toEqual(before)
  expect(asked.slice(count)).toEqual([])
}

const landLate = async (c: Late) => {
  const before = pick(c.keys)
  release()
  if (c.timers) await advance(50)
  else await settle()
  expect(st().error).toBeNull()
  expect(st().toast).toBeNull()
  expect(pick(c.keys)).toEqual(before)
  if (c.timers) await advance(20_000)
}

const resync = () => st().applyWsEvent({ type: 'resync' })
const inView = () => ({
  view: { kind: 'channel' as const, server: 's', channelId: 77 },
  messages: { c77: [msg(9, { channel_id: 77, author: user('carol') })] },
})
const alices = (who: string) => who === 'alice'
type Bulk = { dry_run?: boolean; all?: boolean }
const job = (status: BulkJob['status']): BulkJob => ({
  id: 1,
  scope: 'c77',
  status,
  deleted: 0,
  skipped: 0,
  estimate: 9,
  created_at: 1,
  finished_at: null,
  error: null,
})

describe('the session slice', () => {
  test('the account, refetched after a join', () =>
    late({
      hold: /^GET \/me$/,
      start: () => st().joinServer('x'),
      reply: (who, method, path) =>
        path === '/servers/x/join'
          ? serverDetail('x')
          : path.startsWith('/me/servers?names=x')
            ? []
            : path === '/me'
              ? me(who, { display_name: `${who} again` })
              : undefined,
      keys: ['me', 'servers', 'view'],
    }))

  test('a refusal of the account, refetched after a join, signs nobody out', () =>
    late({
      hold: /^GET \/me$/,
      start: () => st().joinServer('x'),
      reply: (who, method, path) =>
        path === '/servers/x/join'
          ? serverDetail('x')
          : path.startsWith('/me/servers?names=x')
            ? []
            : path === '/me'
              ? json({ error: 'Unauthorized' }, 401)
              : undefined,
      keys: ['me', 'token', 'authExpired'],
    }))

  test('the account, refetched by a resync', () =>
    late({
      hold: /^GET \/me$/,
      start: resync,
      timers: true,
      reply: (who, method, path) =>
        path === '/me' ? me(who, { display_name: `${who} again`, servers: [summary] }) : undefined,
      keys: ['me'],
    }))

  test('the account, loaded on a retry after it failed to load', () =>
    late({
      hold: /^GET \/me$/,
      start: () => {
        useStore.setState({ me: null })
        resync()
      },
      timers: true,
      reply: (who, method, path) =>
        path === '/me' ? me(who, { display_name: `${who} again`, servers: [summary] }) : undefined,
      keys: ['me', 'bootError'],
    }))

  test('the account, refused on a retry after it failed to load, signs nobody out', () =>
    late({
      hold: /^GET \/me$/,
      start: () => {
        useStore.setState({ me: null })
        resync()
      },
      timers: true,
      reply: (who, method, path) =>
        path === '/me' ? json({ error: 'Unauthorized' }, 401) : undefined,
      keys: ['me', 'token', 'authExpired', 'bootError'],
    }))

  const retried = (path: string, ready: () => boolean) =>
    late({
      hold: 'GET /unreads',
      ready,
      start: () => {
        ;(window as unknown as { location: { pathname: string } }).location.pathname = path
        useStore.setState({ me: null })
        resync()
      },
      timers: true,
      reply: (who, method, p) =>
        p === '/dms?ids=5' ? [{ id: 5, other: user('carol'), is_self: false }] : undefined,
      keys: ['view', 'messages', 'linkCards'],
    })

  test('a channel address, opened once unread counts answer late', () =>
    retried('/s/s/77', () => asked.includes('alice GET /servers/s')))

  test('a DM address, opened once unread counts answer late', () =>
    retried('/dm/5', () => asked.includes('alice GET /dms?ids=5')))

  test('a message address, opened once unread counts answer late', () =>
    retried('/s/s/77/9', () => true))

  test('the rail, checked once the account loads on a retry', () =>
    late({
      hold: 'GET /me/servers?names=x',
      next: 'alice',
      state: () => ({ layout: { ...emptyLayout, servers: ['gone'] } }),
      start: () => {
        localStorage.setItem(
          home.scoped(layoutKey('alice')),
          JSON.stringify({ ...emptyLayout, servers: ['x'] })
        )
        useStore.setState({ me: null })
        resync()
      },
      timers: true,
      reply: (who, method, path) =>
        path.startsWith('/me/servers?names=x')
          ? [{ name: 'x', display_name: 'x', creator: null, is_admin: false }]
          : undefined,
      keys: ['layout'],
    }))

  test("a detached view's server, refreshed by a resync", () =>
    late({
      hold: /^GET \/servers\/s$/,
      start: resync,
      timers: true,
      state: () => ({ ...inView(), newer: { c77: { more: true, loading: false } } }),
      reply: (who, method, path) =>
        path === '/servers/s'
          ? serverDetail('s', { display_name: `s as ${who} sees it`, channels: [channel] })
          : undefined,
      keys: ['servers'],
    }))

  test('the open view, refreshed by a resync', () =>
    late({
      hold: 'GET /channels/77/messages',
      start: resync,
      timers: true,
      state: inView,
      reply: (who, method, path) =>
        path.startsWith('/channels/77/messages')
          ? [msg(500, { channel_id: 77, author: user(who) })]
          : undefined,
      keys: ['messages', 'older', 'newer'],
    }))

  test('the open server, refreshed by a resync', () =>
    late({
      hold: /^GET \/servers\/s$/,
      start: async () => {
        await st().openChannel('s', 77)
        resync()
      },
      timers: true,
      state: inView,
      reply: (who, method, path) =>
        path === '/servers/s'
          ? serverDetail('s', { display_name: `s as ${who} sees it`, channels: [channel] })
          : undefined,
      keys: ['servers'],
    }))

  test('blocked users, loaded by a resync', () =>
    late({
      hold: 'GET /blocks/usernames',
      start: resync,
      timers: true,
      next: 'alice',
      reply: (who, method, path) => (path === '/blocks/usernames' ? ['carol'] : undefined),
      keys: ['blocked'],
    }))

  test('a new avatar', () =>
    late({
      hold: 'PATCH /me',
      start: () => st().patchMe('color', '#123456'),
      reply: (who, method) =>
        method === 'PATCH' ? user(who, { avatar_color: '#123456' }) : undefined,
      keys: ['me'],
    }))

  test('appearing offline', () =>
    late({
      hold: 'PATCH /me',
      start: () => st().setAppearOffline(true),
      reply: (who, method) => (method === 'PATCH' ? user(who) : undefined),
      keys: ['me'],
    }))

  test('a password change, done', () =>
    late({
      hold: 'POST /me/password',
      start: () => st().changePassword({ password: 'a' }, { password: 'b' }, 'words'),
      reply: (who, method) => (method === 'POST' ? { ok: true } : undefined),
      keys: ['me'],
    }))

  test('a password change, refused, signs nobody out', () =>
    late({
      hold: 'POST /me/password',
      start: () => st().changePassword({ password: 'a' }, { password: 'b' }, 'words'),
      reply: (who, method) =>
        method === 'POST' ? json({ error: 'Unauthorized' }, 401) : undefined,
      keys: ['me', 'token', 'authExpired'],
    }))

  test('the address opened at load', () =>
    late({
      hold: /^GET \/servers\/x$/,
      start: () => {
        ;(window as unknown as { location: { pathname: string } }).location.pathname = '/s/x/5'
        return st().syncFromUrl('replace')
      },
      reply: (who, method, path) =>
        path === '/servers/x'
          ? serverDetail('x', { channels: [{ ...channel, id: 5 }] })
          : undefined,
      keys: ['servers', 'view', 'home'],
    }))

  test('a server opened', () =>
    late({
      hold: /^GET \/servers\/x$/,
      start: () => st().openServer('x'),
      reply: (who, method, path) =>
        path === '/servers/x'
          ? serverDetail('x', { channels: [{ ...channel, id: 5 }] })
          : undefined,
      keys: ['servers', 'view'],
    }))

  test('a server a guest joins', () =>
    late({
      guest: true,
      hold: 'POST /servers/x/guest_access',
      start: () => st().guestJoinServer('x'),
      reply: (who, method, path) =>
        path === '/servers/x/guest_access'
          ? { grant: 'g-x' }
          : path === '/servers/x'
            ? serverDetail('x', { channels: [{ ...channel, id: 5 }] })
            : undefined,
      keys: ['servers', 'view', 'guestGrants', 'guestServers'],
    }))

  test('the last DM', () =>
    late({
      hold: 'GET /dms?ids=5',
      next: 'alice',
      state: () => ({ dms: [{ id: 7, other: user('alice'), is_self: true }] }),
      start: () => {
        localStorage.setItem('rchat_last_dm:alice', '5')
        st().openLastDm()
      },
      reply: (who, method, path) =>
        path === '/dms?ids=5' ? [{ id: 5, other: user('carol'), is_self: false }] : undefined,
      keys: ['view', 'dms'],
    }))

  test('a closed DM opened again', () =>
    late({
      hold: 'POST /dms',
      next: 'alice',
      start: () => st().openDm(5),
      reply: (who, method, path) =>
        path === '/dms?ids=5'
          ? [{ id: 5, other: user('carol'), is_self: false, closed: true }]
          : method === 'POST' && path === '/dms'
            ? { id: 5, other: user('carol'), is_self: false }
            : undefined,
      keys: ['dms'],
    }))

  test('a block', () =>
    late({
      hold: 'POST /blocks',
      next: 'alice',
      start: () => st().blockUser('carol'),
      reply: (who, method, path) =>
        path === '/blocks' ? { user: user('carol'), blocked_at: 1 } : undefined,
      keys: ['blocked', 'blockList'],
    }))

  test('an unblock', () =>
    late({
      hold: 'DELETE /blocks/carol',
      next: 'alice',
      state: () => ({ blocked: { carol: true } }),
      start: () => st().unblockUser('carol', 'Carol'),
      keys: ['blocked'],
    }))
})

describe('the messages slice', () => {
  test('a search page', () =>
    late({
      hold: 'GET /search',
      start: () =>
        st().searchRun(
          { q: 'x', from: '', channelId: null, hasFile: false, beforeTs: null, afterTs: null },
          true
        ),
      reply: (who, method, path) => (path.startsWith('/search') ? [result(500, 1)] : undefined),
      keys: ['search'],
    }))

  test('a DM started', () =>
    late({
      hold: 'POST /dms',
      start: () => st().startDm('carol'),
      reply: (who, method, path) =>
        method === 'POST' && path === '/dms'
          ? { id: 5, other: user('carol'), is_self: false }
          : undefined,
      keys: ['dms', 'view'],
    }))

  test('a message to a user', () =>
    late({
      hold: 'POST /dms',
      next: 'alice',
      start: () => st().messageUser('carol', 'hi'),
      reply: (who, method, path) =>
        method === 'POST' && path === '/dms'
          ? { id: 5, other: user('carol'), is_self: false }
          : undefined,
      keys: ['dms', 'view', 'outbox'],
    }))

  test('a message to a user whose DM opens after the session ended', () =>
    late({
      hold: 'GET /dms/5/messages',
      next: 'alice',
      start: () => st().messageUser('carol', 'hi'),
      reply: (who, method, path) =>
        method === 'POST' && path === '/dms'
          ? { id: 5, other: user('carol'), is_self: false }
          : undefined,
      keys: ['dms', 'view', 'outbox'],
    }))

  test('DMs looked up by id', () =>
    late({
      hold: 'GET /dms?ids=5',
      next: 'alice',
      start: () => st().ensureDms([5]),
      reply: (who, method, path) =>
        path === '/dms?ids=5' ? [{ id: 5, other: user('carol'), is_self: false }] : undefined,
      keys: ['dms'],
    }))

  test('a DM close that fails', () =>
    late({
      hold: 'POST /dms/5/close',
      next: 'alice',
      start: () => {
        useStore.setState({ dms: [{ id: 5, other: user('carol'), is_self: false }] })
        return st().closeDm(5)
      },
      reply: (who, method, path) =>
        path === '/dms/5/close' ? json({ error: 'Try again' }, 500) : undefined,
      keys: ['dms'],
    }))

  test('a pin', () =>
    late({
      hold: 'PUT /messages/9/pin',
      state: inView,
      start: () => st().pinMessage(9),
      keys: ['messages'],
    }))

  test('a delete', () =>
    late({
      hold: 'DELETE /messages/9',
      state: inView,
      start: () => st().deleteMessage(9),
      keys: ['messages'],
    }))

  test('an unpin', () =>
    late({
      hold: 'DELETE /messages/9/pin',
      state: () => ({
        ...inView(),
        messages: { c77: [msg(9, { channel_id: 77, pinned_at: 5 })] },
        pins: { key: 'c77', list: [msg(9, { channel_id: 77, pinned_at: 5 })], failed: false },
      }),
      start: () => st().unpinMessage(9),
      keys: ['messages', 'pins'],
    }))

  test('a file removed', () =>
    late({
      hold: 'DELETE /messages/9/media',
      state: () => ({
        ...inView(),
        messages: { c77: [msg(9, { channel_id: 77, media: { ...mediaOf(), id: 'f9' } })] },
      }),
      start: () => st().deleteMedia(9),
      keys: ['messages'],
    }))

  test('an embed removed', () =>
    late({
      hold: 'DELETE /messages/9/embeds/0',
      state: () => ({
        ...inView(),
        messages: { c77: [msg(9, { channel_id: 77, embeds: [embedOf(0)] })] },
      }),
      start: () => st().deleteEmbed(9, 0, false),
      keys: ['messages'],
    }))

  test('an edit with s/', () =>
    late({
      hold: 'PATCH /messages/9',
      state: () => ({
        ...inView(),
        messages: { c77: [msg(9, { channel_id: 77, author: user('alice'), content: 'hi' })] },
      }),
      start: () => st().sedEdit('c77', { find: 'hi', replace: 'yo', global: false }),
      reply: (who, method, path) =>
        method === 'PATCH' && path === '/messages/9'
          ? msg(9, { channel_id: 77, author: user('alice'), content: 'yo', edited_at: 2 })
          : undefined,
      keys: ['messages'],
    }))

  test('an edit with s/ that waits for a send the session end drops', () =>
    late({
      hold: 'POST /channels/77/messages',
      state: inView,
      start: () => {
        st().sendMessage('hi')
        return st().sedEdit('c77', { find: 'hi', replace: 'yo', global: false })
      },
      keys: ['messages', 'outbox'],
    }))

  test('a refusal that says the account is banned', () =>
    late({
      hold: 'GET /channels/77/messages',
      start: () => st().openChannel('s', 77),
      reply: (who, method, path) =>
        path.startsWith('/channels/77/messages')
          ? json({ error: 'You are banned from this server' }, 403)
          : undefined,
      keys: ['servers', 'me', 'notices', 'view'],
    }))

  test('a message link opened', () =>
    late({
      hold: 'GET /messages/9/location',
      start: () => st().openMessage(9),
      reply: (who, method, path) =>
        path.startsWith('/messages/9/location')
          ? {
              id: 9,
              server: 's',
              channel_id: 77,
              dm_id: null,
              thread_root_id: null,
              author: user('carol'),
              created_at: 1,
              content: 'hi',
              has_media: false,
              kind: 'user',
            }
          : undefined,
      keys: ['linkCards', 'view', 'messages'],
    }))

  test('message link cards', () =>
    late({
      hold: 'POST /messages/locations',
      timers: true,
      start: () => st().resolveLinkCard(9),
      reply: (who, method, path) => (path === '/messages/locations' ? [] : undefined),
      keys: ['linkCards'],
    }))
})

describe('the servers slice', () => {
  test('a server reloaded after an event', () =>
    late({
      hold: /^GET \/servers\/s$/,
      start: () => st().applyWsEvent({ type: 'upload_expiry_changed', server: 's' }),
      reply: (who, method, path) =>
        path === '/servers/s'
          ? serverDetail('s', { display_name: `s as ${who} sees it`, channels: [channel] })
          : undefined,
      keys: ['servers'],
    }))

  test('a join', () =>
    late({
      hold: 'POST /servers/x/join',
      start: () => st().joinServer('x'),
      reply: (who, method, path) => (path === '/servers/x/join' ? serverDetail('x') : undefined),
      keys: ['me', 'servers', 'view'],
    }))

  test('a server created', () =>
    late({
      hold: 'POST /servers',
      start: () => st().createServer('x'),
      reply: (who, method, path) =>
        method === 'POST' && path === '/servers' ? serverDetail('x') : undefined,
      keys: ['me', 'servers', 'view'],
    }))

  test('a server created, whose account list answers late', () =>
    late({
      hold: 'GET /me/servers?names=x',
      start: () => st().createServer('x'),
      reply: (who, method, path) =>
        method === 'POST' && path === '/servers'
          ? serverDetail('x')
          : path.startsWith('/me/servers?names=x')
            ? []
            : undefined,
      keys: ['me', 'servers', 'view'],
    }))

  test('a topic', () =>
    late({
      hold: 'PATCH /channels/77',
      start: () => st().setChannelTopic('s', 77, 'new topic'),
      reply: (who, method, path) =>
        method === 'PATCH' && path === '/channels/77'
          ? { ...channel, topic: 'new topic' }
          : undefined,
      keys: ['servers'],
    }))

  test('a timeout lifted', () =>
    late({
      hold: 'DELETE /servers/s/timeouts/carol',
      state: () => ({
        timeouts: { s: { carol: { ends: 9_999_999_999_000, reason: null } } },
      }),
      start: () => st().removeTimeout('s', 'carol'),
      keys: ['timeouts'],
    }))

  test('a ban', () =>
    late({
      hold: 'POST /servers/s/bans',
      state: () => ({ bans: { s: { list: [], hasMore: false, loading: false, q: '' } } }),
      start: () => st().banMember('s', 'carol'),
      keys: ['bans'],
    }))

  test('an unban', () =>
    late({
      hold: 'DELETE /servers/s/bans/carol',
      state: () => ({
        bans: {
          s: {
            list: [{ username: 'carol', display_name: 'carol', banned_at: 1 }] as never[],
            hasMore: false,
            loading: false,
            q: '',
          },
        },
      }),
      start: () => st().unbanMember('s', 'carol'),
      keys: ['bans'],
    }))

  test('a backup phrase removed', () =>
    late({
      hold: 'DELETE /admin/users/carol/recovery',
      start: () => st().adminRemovePhrase('carol'),
      reply: (who, method, path) =>
        path === '/admin/users/carol/recovery' ? { removed: true } : undefined,
      keys: [],
    }))

  test('a refusal of a member list that says the account is banned', () =>
    late({
      hold: 'GET /servers/s/interacted',
      start: () => st().loadInteracted('s', true),
      reply: (who, method, path) =>
        path.startsWith('/servers/s/interacted')
          ? json({ error: 'You are banned from this server' }, 403)
          : undefined,
      keys: ['servers', 'me', 'notices', 'interacted'],
    }))

  test('a leave', () =>
    late({
      hold: 'POST /servers/s/leave',
      start: () => st().leaveServer('s'),
      keys: ['me', 'servers'],
    }))

  test('servers looked up by name', () =>
    late({
      hold: 'GET /me/servers?names=x',
      next: 'alice',
      start: () => st().ensureServers(['x']),
      reply: (who, method, path) =>
        path.startsWith('/me/servers?names=x')
          ? [{ name: 'x', display_name: 'x', creator: null, is_admin: false }]
          : undefined,
      keys: ['me'],
    }))

  test('servers checked by a resync', () =>
    late({
      hold: 'GET /me/servers?names=s',
      start: resync,
      timers: true,
      next: 'alice',
      state: inView,
      reply: (who, method, path) => (path.startsWith('/me/servers?names=s') ? [] : undefined),
      keys: ['me', 'servers', 'notices'],
    }))

  test('a server a resync found gone, whose lookup answers late', () =>
    late({
      hold: /^GET \/servers\/s$/,
      start: resync,
      timers: true,
      next: 'alice',
      reply: (who, method, path) => (path.startsWith('/me/servers?names=s') ? [] : undefined),
      keys: ['me', 'servers', 'notices'],
    }))

  test('the member list, reloaded by a resync', () =>
    late({
      hold: 'GET /servers/s/members?limit',
      start: resync,
      timers: true,
      state: () => ({
        ...inView(),
        members: { s: { list: [member('dave')], hasMore: false, loading: false, q: '' } },
      }),
      reply: (who, method, path) =>
        path.startsWith('/servers/s/members?limit')
          ? [
              {
                ...member('carol', { display_name: `carol as ${who} sees her` }),
                timeout: { until: 9_999_999_999, remaining: 60, reason: null },
              },
            ]
          : undefined,
      keys: ['members', 'timeouts'],
    }))

  test('a kick that fails', () =>
    late({
      hold: 'POST /servers/s/kick',
      start: () => st().kickMember('s', 'carol'),
      reply: (who, method, path) =>
        path === '/servers/s/kick' ? json({ error: 'Not allowed' }, 403) : undefined,
      keys: ['servers', 'members'],
    }))

  test('a timeout', () =>
    late({
      hold: 'PUT /servers/s/timeouts/carol',
      start: () => st().timeoutMember('s', 'carol', 60, ''),
      reply: (who, method) =>
        method === 'PUT' ? { until: 9_999_999_999, remaining: 60, reason: null } : undefined,
      keys: ['timeouts'],
    }))

  test('the admin overview', () =>
    late({
      hold: 'GET /admin/overview',
      start: () => st().loadAdminOverview(),
      reply: (who, method, path) =>
        path === '/admin/overview' ? { server_count: 3, user_count: 40 } : undefined,
      keys: ['adminOverview'],
    }))

  test('a page of an admin list', () =>
    late({
      hold: 'GET /admin/users',
      start: () => st().loadAdminUsers('', true),
      reply: (who, method, path) => (path.startsWith('/admin/users') ? [user('zed')] : undefined),
      keys: ['adminUsers'],
    }))
})

describe('reads, friends, selection and polls', () => {
  test('unread counts, loaded by a resync', () =>
    late({
      hold: 'GET /unreads',
      start: resync,
      timers: true,
      reply: (who, method, path) =>
        path === '/unreads'
          ? {
              items: [{ scope: 'c77', server: 's', last_read: 1, latest: 900, pings: 2 }],
              more: false,
            }
          : undefined,
      keys: ['reads', 'pings', 'readsReady'],
    }))

  test('a read mark that failed', () =>
    late({
      hold: 'POST /read/batch',
      timers: true,
      state: () => ({ reads: { c77: { lastRead: 1, latest: 9, server: 's' } } }),
      start: () => st().markScopesRead(['c77']),
      reply: (who, method, path) =>
        path === '/read/batch' ? json({ error: 'Try again' }, 500) : undefined,
      keys: [],
    }))

  test('marking all read, while the next session has more unread', () =>
    late({
      hold: 'POST /read/batch',
      timers: true,
      state: () => ({ reads: { c77: { lastRead: 1, latest: 9, server: 's' } } }),
      start: () => st().markAllRead(),
      then: resync,
      reply: (who, method, path) =>
        path === '/unreads'
          ? {
              items: alices(who) ? [] : [{ scope: 'c77', server: 's', last_read: 1, latest: 9 }],
              more: !alices(who),
            }
          : undefined,
      keys: ['reads'],
    }))

  test('marking all read, whose next round of unread counts answers late', () => {
    let unreads = 0
    return late({
      hold: line => line === 'GET /unreads' && ++unreads === 2,
      timers: true,
      state: () => ({ reads: { c77: { lastRead: 1, latest: 9, server: 's' } } }),
      start: () => {
        resync()
        setTimeout(() => void st().markAllRead(), 5_000)
      },
      reply: (who, method, path) =>
        path === '/unreads'
          ? { items: [{ scope: 'c77', server: 's', last_read: 1, latest: 9 }], more: true }
          : undefined,
      keys: ['reads'],
    })
  })

  test('friend counts, loaded by a resync', () =>
    late({
      hold: 'GET /friends/summary',
      start: resync,
      timers: true,
      next: 'alice',
      reply: (who, method, path) =>
        path === '/friends/summary' ? { incoming: 3, outgoing: 1, pings: 0 } : undefined,
      keys: ['friendCounts', 'pings'],
    }))

  test('friend requests sent one by one', () =>
    late({
      hold: 'POST /friends/requests',
      start: () => st().sendFriendRequests(['carol', 'dave']),
      reply: (who, method, path, body) =>
        path === '/friends/requests'
          ? { status: 'sent', user: user((body as { username: string }).username) }
          : undefined,
      keys: [],
    }))

  test('a friend request accepted', () =>
    late({
      hold: 'POST /friends/requests/carol/accept',
      start: () => st().acceptFriend(user('carol')),
      keys: [],
    }))

  test('a friend removed', () =>
    late({
      hold: 'DELETE /users/carol/friendship',
      start: () => st().removeFriend(user('carol')),
      keys: [],
    }))

  test('privacy settings changed', () =>
    late({
      hold: 'PATCH /me/privacy',
      next: 'alice',
      state: () => ({ privacy: { dm: 'everyone', friend_requests: 'everyone' } as never }),
      start: () => st().setPrivacy({ dm: 'friends' } as never),
      reply: (who, method, path) =>
        path === '/me/privacy' ? { dm: 'friends', friend_requests: 'everyone' } : undefined,
      keys: ['privacy'],
    }))

  test('privacy settings changed, refused', () =>
    late({
      hold: 'PATCH /me/privacy',
      next: 'alice',
      state: () => ({ privacy: { dm: 'friends', friend_requests: 'friends' } as never }),
      start: () => {
        useStore.setState({ privacy: { dm: 'everyone', friend_requests: 'everyone' } as never })
        return st().setPrivacy({ dm: 'nobody' } as never)
      },
      reply: (who, method, path) =>
        path === '/me/privacy' ? json({ error: 'Try again' }, 500) : undefined,
      keys: ['privacy'],
    }))

  test('privacy settings that fail to load', () =>
    late({
      hold: 'GET /me/privacy',
      start: () => st().loadPrivacy(),
      reply: (who, method, path) =>
        path === '/me/privacy' ? json({ error: 'Try again' }, 500) : undefined,
      keys: ['privacy'],
    }))

  test('privacy settings', () =>
    late({
      hold: 'GET /me/privacy',
      next: 'alice',
      start: () => st().loadPrivacy(),
      reply: (who, method, path) =>
        path === '/me/privacy' ? { dm: 'friends', friend_requests: 'nobody' } : undefined,
      keys: ['privacy'],
    }))

  test('running bulk deletes, loaded by a resync', () =>
    late({
      hold: 'GET /messages/bulk_delete/jobs',
      start: resync,
      timers: true,
      reply: (who, method, path) =>
        path === '/messages/bulk_delete/jobs' ? [job('running')] : undefined,
      keys: ['bulkJobs'],
    }))

  test('a bulk delete stopped', () =>
    late({
      hold: 'DELETE /messages/bulk_delete/jobs/1',
      state: () => ({ bulkJobs: { c77: job('running') } }),
      start: () => st().cancelBulkJob('c77'),
      reply: (who, method, path) =>
        path === '/messages/bulk_delete/jobs/1' ? job('cancelled') : undefined,
      keys: ['bulkJobs'],
    }))

  test('pins of a selection, one by one', () => {
    const dm = (id: number) => msg(id, { channel_id: null, dm_id: 5, author: user('carol') })
    return late({
      hold: 'PUT /messages/1/pin',
      state: () => ({
        view: { kind: 'dm', dmId: 5 },
        messages: { d5: [dm(1), dm(2)] },
        selection: null,
      }),
      start: () => {
        st().startSelection('d5')
        st().toggleSelect('d5', dm(1))
        st().toggleSelect('d5', dm(2))
        return st().pinSelection(true)
      },
      keys: ['messages'],
    })
  })

  test('the count before deleting everything selected', () =>
    late({
      hold: (line, body) => line === 'POST /messages/bulk_delete' && !!(body as Bulk).dry_run,
      state: () => ({ ...inView(), selection: null }),
      start: () => {
        st().startSelection('c77')
        st().selectAllMessages()
        st().askDeleteSelection()
      },
      reply: (who, method, path) =>
        path === '/messages/bulk_delete'
          ? { total: 9, deletable: 9, others: 0, upto: 9 }
          : undefined,
      keys: ['confirm', 'selection'],
    }))

  test("the count before deleting one author's messages", () =>
    late({
      hold: (line, body) => line === 'POST /messages/bulk_delete' && !!(body as Bulk).dry_run,
      state: () => ({ ...inView(), selection: null }),
      start: () => {
        st().startSelection('c77')
        st().selectAuthorMessages('carol')
        st().askDeleteSelection()
      },
      reply: (who, method, path) =>
        path === '/messages/bulk_delete'
          ? { total: 9, deletable: 9, others: 0, upto: 9 }
          : undefined,
      keys: ['confirm', 'selection'],
    }))

  test('a delete of everything selected', () =>
    late({
      hold: (line, body) =>
        line === 'POST /messages/bulk_delete' && !(body as Bulk).dry_run && !!(body as Bulk).all,
      state: () => ({ ...inView(), selection: null }),
      start: async () => {
        st().startSelection('c77')
        st().selectAllMessages()
        st().askDeleteSelection()
        for (let i = 0; i < 50 && !st().confirm; i += 1) await tick()
        st().confirm?.action('')
      },
      reply: (who, method, path) =>
        path === '/messages/bulk_delete'
          ? { total: 9, deletable: 9, others: 0, upto: 9, job: job('running') }
          : undefined,
      keys: ['bulkJobs'],
    }))

  test('the estimate of a selection', () =>
    late({
      hold: 'POST /messages/bulk_delete',
      state: () => ({ ...inView(), selection: null }),
      start: () => {
        st().startSelection('c77')
        st().selectAllMessages()
      },
      then: () => {
        st().startSelection('c77')
        st().selectAllMessages()
      },
      reply: (who, method, path) =>
        path === '/messages/bulk_delete'
          ? { total: alices(who) ? 999 : 5, deletable: 0, others: 0 }
          : undefined,
      keys: ['selection'],
    }))

  test('a bulk delete in parts', () => {
    const mine = Array.from({ length: 201 }, (_, i) =>
      msg(i + 1, { channel_id: 77, author: user('alice') })
    )
    return late({
      hold: 'POST /messages/bulk_delete',
      state: () => ({ ...inView(), messages: { c77: mine }, selection: null }),
      start: () => {
        st().startSelection('c77')
        for (const m of mine) st().toggleSelect('c77', m)
        st().askDeleteSelection()
        st().confirm?.action('')
      },
      reply: (who, method, path, body) =>
        path === '/messages/bulk_delete'
          ? { deleted: 0, ids: (body as { ids?: number[] }).ids ?? [], job: null }
          : undefined,
      keys: ['messages', 'selection', 'selectionBusy'],
    })
  })

  test('an export in pages', () => {
    const page = Array.from({ length: 100 }, (_, i) =>
      msg(i + 1, { channel_id: 77, author: user('carol') })
    )
    return late({
      hold: 'GET /channels/77/messages?after=0',
      state: () => ({ ...inView(), selection: null }),
      start: () => {
        st().startSelection('c77')
        st().selectAuthorMessages('carol')
        return st().exportSelection('json')
      },
      then: () => useStore.setState({ selectionBusy: 'Exporting' }),
      reply: (who, method, path) =>
        path.startsWith('/channels/77/messages')
          ? page
          : path === '/messages/bulk_delete'
            ? { total: 1 }
            : undefined,
      keys: ['selectionBusy'],
    })
  })

  test('a vote', () =>
    late({
      hold: 'PUT /polls/10/vote',
      state: () => ({
        view: { kind: 'channel', server: 's', channelId: 77 },
        messages: { c77: [pollMsg()] },
      }),
      start: () => st().votePoll(10, { options: [1] }),
      reply: (who, method, path) => (path === '/polls/10/vote' ? poll([1]) : undefined),
      keys: ['messages'],
    }))
})

test('a profile that answers after the session ended is not kept', () => {
  const profile = { user: user('carol'), bio: 'as alice sees her' } as unknown as Profile
  signedIn('alice')
  const at = sessionMark()
  signOut()
  signedIn('bob')
  rememberProfile(profileKey('carol', 's'), profile, at)
  expect(cachedProfile(profileKey('carol', 's'))).toBeNull()
  rememberProfile(profileKey('carol', 's'), profile, sessionMark())
  expect(cachedProfile(profileKey('carol', 's'))).toBe(profile)
})

describe('calls', () => {
  let sent: VoiceMsg[] = []
  let ended = 0
  let open = () => {}
  const media = () =>
    new Promise<void>(r => {
      open = r
    })
  beforeEach(() => {
    sent = []
    ended = 0
    ws.sendVoice = m => {
      sent.push(m)
      return true
    }
    p2p.endMedia = () => {
      ended += 1
    }
    p2p.peerId = () => 'alice-tab'
  })

  const call = async (start: () => Promise<void>) => {
    signedIn('alice', { call: null, voice: null })
    const done = start()
    await settle()
    signOut()
    signedIn('bob', { call: null, voice: null })
    const before = ended
    open()
    await done
    await settle()
    expect(sent).toEqual([])
    expect(st().call).toBeNull()
    expect(st().error).toBeNull()
    return ended - before
  }

  test('a P2P call whose media starts after the session ended never rings', async () => {
    p2p.startMedia = () => media()
    expect(await call(() => st().startP2pCall(5, false))).toBe(1)
  })

  test('a P2P call whose relay check answers after the session ended starts no media', async () => {
    let started = 0
    p2p.startMedia = async () => {
      started += 1
    }
    const check = relayBook.check.bind(relayBook)
    relayBook.check = async (...a) => {
      await media()
      return check(...a)
    }
    await call(() => st().startP2pCall(5, false))
    expect(started).toBe(0)
  })

  const inVoice = async (start: () => Promise<void>, fails: () => void) => {
    signedIn('alice', { call: null, voice: null })
    const done = start()
    await settle()
    signOut()
    const voice = { server: 's', channelId: 78 }
    signedIn('bob', { call: null, voice })
    fails()
    await done
    await settle()
    expect(sent).toEqual([])
    expect(st().voice).toEqual(voice)
    expect(st().error).toBeNull()
  }

  test('a P2P call whose media fails after the session ended leaves the next one alone', () => {
    let fail = () => {}
    p2p.startMedia = () =>
      new Promise<void>((_, no) => {
        fail = () => no(new Error('No microphone'))
      })
    return inVoice(
      () => st().startP2pCall(5, false),
      () => fail()
    )
  })

  test('a call whose media fails after the session ended leaves the next one alone', () => {
    let fail = () => {}
    rtc.join = () =>
      new Promise<void>((_, no) => {
        fail = () => no(new Error('No microphone'))
      })
    return inVoice(
      () => st().startCall(5, false),
      () => fail()
    )
  })

  test('voice whose media fails after the session ended leaves the next one alone', () => {
    let fail = () => {}
    rtc.join = () =>
      new Promise<void>((_, no) => {
        fail = () => no(new Error('No microphone'))
      })
    return inVoice(
      () => st().joinVoice('s', 78),
      () => fail()
    )
  })

  test('a call whose camera starts after the session ended never rings', async () => {
    rtc.join = async () => {}
    rtc.camera = () => media()
    await call(() => st().startCall(5, true))
  })
})

test('an export page retried after a refusal is not asked once the session ended', async () => {
  jest.useFakeTimers()
  const page = Array.from({ length: 100 }, (_, i) =>
    msg(i + 1, { channel_id: 77, author: user('carol') })
  )
  reply = (who, method, path) =>
    path.startsWith('/channels/77/messages')
      ? alices(who)
        ? json({ error: 'Too many requests' }, 429)
        : page
      : path === '/messages/bulk_delete'
        ? { total: 1 }
        : undefined
  signedIn('alice', { ...inView(), selection: null })
  st().startSelection('c77')
  st().selectAuthorMessages('carol')
  void st().exportSelection('json')
  await advance(10, () => asked.some(a => a.startsWith('alice GET /channels/77/messages')))
  expect(asked.some(a => a.startsWith('alice GET /channels/77/messages'))).toBe(true)
  signOut()
  signedIn('bob', { ...inView(), selectionBusy: 'Exporting' })
  const count = asked.length
  await advance(exportBackoff.ms * 64)
  expect(asked.slice(count)).toEqual([])
  expect(st().selectionBusy).toBe('Exporting')
  expect(st().toast).toBeNull()
  expect(st().error).toBeNull()
})

describe('outside the store', () => {
  let saved: string[] = []
  const realSharing = sharing()
  beforeEach(() => {
    saved = []
    setSharing({
      ...realSharing,
      saveBlob: (name: string) => {
        saved.push(name)
        return true
      },
    })
  })
  afterEach(() => setSharing(realSharing))

  test('a download that answers after the session ended is not saved', async () => {
    await late({
      hold: 'GET /media/m1',
      start: () => saveMedia('m1', undefined, 'alice.txt'),
      keys: [],
    })
    expect(saved).toEqual([])
  })

  test('a download that fails after the session ended fails as ended', async () => {
    let failed: Promise<unknown> = Promise.resolve()
    await late({
      hold: 'GET /media/m1',
      start: () => {
        failed = saveMedia('m1', undefined, 'alice.txt').then(
          () => null,
          (e: unknown) => e
        )
      },
      reply: (who, method, path) =>
        path === '/media/m1' && alices(who) ? json({ error: 'Not found' }, 404) : undefined,
      keys: [],
    })
    expect((await failed) instanceof Ended).toBe(true)
    expect(saved).toEqual([])
  })

  const jumpToDate = () => {
    registerAppActions()
    actionById('jump_date')?.run(paletteCtx(st()), { value: '2026-01-01' })
  }
  const searched = (found: unknown) =>
    late({
      hold: 'GET /search',
      state: inView,
      start: jumpToDate,
      reply: (who, method, path) => (path.startsWith('/search') ? found : undefined),
      keys: ['focus', 'messages', 'view'],
    })

  test('a jump to a date whose search answers after the session ended', () =>
    searched([result(900, 1)]))

  test('a jump to a date whose search finds nothing after the session ended', () => searched([]))

  test('a jump to a date whose search fails after the session ended', () =>
    searched(json({ error: 'Search failed' }, 500)))

  const view: InboxView = { unread: true, kind: null, place: null }
  const bound = (n: number) => ({ pings: n, groups: n, friends: n })
  let posted: unknown[] = []
  const inbox: Reply = (who, method, path, body) => {
    if (method === 'GET' && path.startsWith('/inbox'))
      return { items: [], next: null, until: bound(alices(who) ? 9000 : 10) }
    if (method === 'POST' && path === '/inbox/read_all') {
      posted.push((body as { until: unknown }).until)
      return {}
    }
    return undefined
  }
  beforeEach(() => {
    posted = []
  })

  test('a first inbox page that answers after the session ended leaves "Mark all as read" alone', async () => {
    await late({
      hold: 'GET /inbox',
      start: () => instanceInbox.load(view, null),
      then: () => instanceInbox.load(view, null),
      reply: inbox,
      keys: [],
    })
    await instanceInbox.markAll?.(view, [])
    expect(posted).toEqual([bound(10)])
  })

  test('"Mark all as read" of the next session goes no further than what it was shown', async () => {
    reply = inbox
    signedIn('alice')
    await instanceInbox.load(view, null)
    signOut()
    signedIn('bob')
    await instanceInbox.markAll?.(view, [])
    expect(posted).toEqual([bound(0)])
  })

  test('an API console request that answers after the session ended is not in the next history', async () => {
    const entry = (status: number): HistoryEntry => ({
      op: 'me',
      method: 'GET',
      path: '/api/me',
      status,
      at: 1,
      values: { params: {}, body: '' },
    })
    await late({
      hold: 'GET /me',
      start: async () => {
        loadApiHistory('alice')
        const at = sessionMark()
        const out = await sendRequest({
          method: 'GET',
          path: '/api/me',
          query: '',
          headers: {},
          body: undefined,
        })
        noteRequest(entry(out.status), at)
      },
      then: () => loadApiHistory('bob'),
      keys: [],
    })
    expect(useApiDoc.getState().history).toEqual(EMPTY_HISTORY)
    expect(localStorage.getItem(home.scoped(historyKey('bob')))).toBeNull()
    loadApiHistory(null)
  })
})

describe('flows that wait on a step that drops a late answer', () => {
  const x = { name: 'x', display_name: 'x', creator: null, is_admin: false }
  const detail = (who: string) =>
    serverDetail('x', {
      channels: [{ ...channel, id: 5, name: alices(who) ? 'alice only' : 'general' }],
    })
  const root = () => msg(40, { channel_id: 77, author: user('carol'), reply_count: 2 })

  test('a server opened, whose membership lookup answers late', () =>
    late({
      hold: 'GET /me/servers?names=x',
      state: () => ({ serversMore: true }),
      start: () => st().openServer('x'),
      reply: (who, method, path) => (path === '/servers/x' ? detail(who) : undefined),
      keys: ['servers', 'view'],
    }))

  test('the address opened at load, whose membership lookup answers late', () =>
    late({
      hold: 'GET /me/servers?names=x',
      state: () => ({ serversMore: true }),
      start: () => {
        ;(window as unknown as { location: { pathname: string } }).location.pathname = '/s/x/5'
        return st().syncFromUrl('replace')
      },
      reply: (who, method, path) => (path === '/servers/x' ? detail(who) : undefined),
      keys: ['servers', 'view', 'home'],
    }))

  test("a thread from the palette, whose channel's first page answers late", () =>
    late({
      hold: 'GET /channels/77/messages',
      state: () => ({ messages: { c77: [root()] } }),
      start: () => threadItems(st(), t => t)[0].run(),
      keys: ['panel', 'view', 'messages'],
    }))

  test('a ping in a thread, whose server answers late', () =>
    late({
      hold: /^GET \/servers\/s$/,
      state: () => ({ messages: { c77: [root()] } }),
      start: () =>
        st().openPing({
          id: 1,
          scope: 'c77',
          server: 's',
          thread_root_id: 40,
          message_id: 41,
        } as never),
      keys: ['panel', 'view', 'messages'],
    }))

  test('a DM not listed yet, whose lookup answers late', () =>
    late({
      hold: 'GET /dms?ids=5',
      start: () => st().openDm(5),
      reply: (who, method, path) =>
        path === '/dms?ids=5'
          ? [{ id: 5, other: user(alices(who) ? 'bob' : 'alice'), is_self: false, closed: true }]
          : method === 'POST' && path === '/dms'
            ? { id: 5, other: user(alices(who) ? 'bob' : 'alice'), is_self: false }
            : undefined,
      then: () => st().ensureDms([5]),
      keys: ['dms'],
    }))

  test('a DM moved up once its lookup answers', () =>
    late({
      hold: 'GET /dms?ids=5',
      start: () => st().applyWsEvent({ type: 'dm_created', dm_id: 5, dm_users: ['alice', 'bob'] }),
      reply: (who, method, path) =>
        path === '/dms?ids=5' ? [{ id: 5, other: user('carol'), is_self: false }] : undefined,
      then: () =>
        useStore.setState({
          dms: [
            { id: 6, other: user('carol'), is_self: false },
            { id: 5, other: user('alice'), is_self: false },
          ],
        }),
      keys: ['dms'],
    }))

  const blocked = (answer: unknown) =>
    late({
      hold: 'POST /blocks',
      start: () => {
        st().askBlock(user('carol'))
        st().confirm?.action('')
      },
      reply: (who, method, path) => (path === '/blocks' ? answer : undefined),
      keys: ['blocked'],
    })

  test('a block confirmed, done after the session ended', () =>
    blocked({ user: user('carol'), blocked_at: 1 }))

  test('a block confirmed, refused after the session ended', () =>
    blocked(json({ error: 'You can not block carol' }, 400)))

  test('the member list, reloaded once a resync checked the servers', () =>
    late({
      hold: 'GET /me/servers?names=s',
      start: resync,
      timers: true,
      state: () => ({
        ...inView(),
        members: { s: { list: [member('dave')], hasMore: false, loading: false, q: '' } },
      }),
      keys: ['members', 'memberInfo'],
    }))

  test('an edit that fails after the session ended', () =>
    late({
      hold: 'PATCH /messages/9',
      state: () => ({
        ...inView(),
        messages: { c77: [msg(9, { channel_id: 77, author: user('alice'), content: 'hi' })] },
      }),
      start: () => {
        st().startEdit('c77', msg(9, { channel_id: 77, author: user('alice'), content: 'hi' }))
        st().setEditText('yo')
        st().saveEdit(false)
      },
      reply: (who, method) =>
        method === 'PATCH' ? json({ error: 'You can not edit this message' }, 403) : undefined,
      keys: ['messages', 'editing'],
    }))

  test('an edit that is saved after the session ended', () =>
    late({
      hold: 'PATCH /messages/9',
      state: () => ({
        ...inView(),
        messages: { c77: [msg(9, { channel_id: 77, author: user('alice'), content: 'hi' })] },
      }),
      start: () => {
        st().startEdit('c77', msg(9, { channel_id: 77, author: user('alice'), content: 'hi' }))
        st().setEditText('yo')
        st().saveEdit(false)
      },
      then: () =>
        useStore.setState({
          messages: {
            c77: [msg(9, { channel_id: 77, author: user('alice'), content: 'yo', edited_at: 1 })],
          },
        }),
      reply: (who, method) =>
        method === 'PATCH'
          ? msg(9, { channel_id: 77, author: user('alice'), content: 'yo', edited_at: 2 })
          : undefined,
      keys: ['messages', 'editing'],
    }))

  const preview = (answer: unknown) =>
    late({
      hold: 'POST /servers/x/join',
      start: () => st().joinPreview('x'),
      reply: (who, method, path) => (path === '/servers/x/join' ? answer : undefined),
      keys: ['activeDialog', 'me', 'servers', 'view'],
    })

  test('a join from a preview, done after the session ended', () => preview(serverDetail('x')))

  test('a join from a preview, refused after the session ended', () =>
    preview(json({ error: 'Wrong password' }, 403)))

  test('a server renamed after the session ended fails as ended', async () => {
    let out: Promise<unknown> = Promise.resolve()
    await late({
      hold: 'PATCH /servers/s',
      start: () => {
        out = st()
          .renameServer('s', 'New name')
          .then(
            () => null,
            (e: unknown) => e
          )
      },
      reply: (who, method) => (method === 'PATCH' ? serverDetail('s') : undefined),
      keys: [],
    })
    expect((await out) instanceof Ended).toBe(true)
  })

  test('what a kick runs next, once the kick answers after the session ended', async () => {
    let ran = 0
    await late({
      hold: 'POST /servers/s/kick',
      start: () => {
        askKick(HostedServer.open(client.shown(), 's'), 'carol', () => (ran += 1))
        st().confirm?.action('')
      },
      keys: [],
    })
    expect(ran).toBe(0)
  })

  test('what a revoke runs next, once the revoke answers after the session ended', async () => {
    let ran = 0
    await late({
      hold: /^(POST|DELETE) \/servers\/s\/admins/,
      start: () => revokeAdminFor('s', 'carol', () => (ran += 1)),
      keys: [],
    })
    expect(ran).toBe(0)
  })

  test('a callback made in a session does nothing once it ended', () => {
    signedIn('alice')
    let ran = 0
    const later = inSession((n: number) => (ran += n))
    expect(later(2)).toBe(2)
    signOut()
    signedIn('bob')
    expect(later(3)).toBeUndefined()
    expect(ran).toBe(2)
  })

  const prefsWithX = () => setLevel(EMPTY_NOTIFY, { kind: 'server', name: 'x' }, 'all')
  // The account loads again on a retry: its layout, rules and stashed config are synced.
  const reload = () => {
    useStore.setState({ me: null })
    resync()
  }
  // The next session's own lookup of `x` waits until `open()`.
  const waitForX = () => {
    let open = () => {}
    const gate = new Promise<void>(r => {
      open = r
    })
    const inner = globalThis.fetch
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).includes('/me/servers?names=x')) await gate
      return inner(input, init)
    }) as typeof fetch
    return () => open()
  }
  const once = (prefix: string) => (line: string) => line.startsWith(prefix) && !heldAsked

  test('notification rules, pruned once a lookup answers after the session ended', async () => {
    let open = () => {}
    await late({
      hold: once('GET /me/servers?names=x'),
      next: 'alice',
      timers: true,
      start: () => {
        localStorage.setItem(home.scoped(notifyKey('alice')), notifyValue(prefsWithX()))
        reload()
      },
      reply: (who, method, path) => (path.startsWith('/me/servers?names=x') ? [x] : undefined),
      then: () => {
        open = waitForX()
        reload()
      },
      keys: ['notifyPrefs', 'layout'],
    })
    open()
  })

  const doc = (): ConfigDoc => ({
    v: 1,
    layout: { servers: ['x', 's'], dmOrder: [], dmPinned: [], selfPin: 'unpinned' },
  })

  test('an imported layout, whose server lookup answers after the session ended', () =>
    late({
      hold: 'GET /me/servers?names=x',
      next: 'alice',
      start: () => st().applyConfig(doc(), ['layout']),
      reply: (who, method, path) => (path.startsWith('/me/servers?names=x') ? [x] : undefined),
      keys: ['layout', 'me'],
    }))

  const stashed = () => {
    const kept = new Map<string, string>()
    ;(window as unknown as { sessionStorage: unknown }).sessionStorage = {
      getItem: (k: string) => kept.get(k) ?? null,
      setItem: (k: string, v: string) => void kept.set(k, v),
      removeItem: (k: string) => void kept.delete(k),
    }
    stashConfig(doc(), ['layout'], sessionStore)
    return kept
  }

  test('a config stashed for the next login, applied by a session that ended', async () => {
    await late({
      hold: 'GET /me/servers?names=x',
      timers: true,
      start: () => {
        stashed()
        reload()
      },
      reply: (who, method, path) => (path.startsWith('/me/servers?names=x') ? [x] : undefined),
      keys: ['layout', 'me'],
    })
  })

  test('a config stashed for the next login is left for it when the session ends first', async () => {
    let kept = new Map<string, string>()
    await late({
      hold: once('GET /me/servers?names=x'),
      timers: true,
      start: () => {
        localStorage.setItem(home.scoped(notifyKey('alice')), notifyValue(prefsWithX()))
        kept = stashed()
        reload()
      },
      reply: (who, method, path) => (path.startsWith('/me/servers?names=x') ? [x] : undefined),
      keys: ['layout', 'me', 'notifyPrefs'],
    })
    expect(kept.size).toBe(1)
  })
})
