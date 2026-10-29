import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { useStore, resetSessionCaches } from '../store'
import type { Message, WsEvent } from '../types'
import { me, memoryStorage, msg, serverDetail, user } from './fixtures'

afterAll(resetSessionCaches)

const st = () => useStore.getState()
const dispatch = (ev: WsEvent) => st().applyWsEvent(ev)
const realFetch = globalThis.fetch
const realWindow = (globalThis as { window?: unknown }).window
const storage = new Map<string, string>()
let posts: { url: string; body: Record<string, unknown> }[] = []
let nextId = 100
const tick = async () => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve()
  await new Promise(r => setTimeout(r, 0))
  for (let i = 0; i < 10; i += 1) await Promise.resolve()
}

const alice = msg(10, { author: user('alice'), content: '**hello** there' })

beforeEach(() => {
  storage.clear()
  Object.assign(globalThis, {
    localStorage: {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => void storage.set(k, v),
      removeItem: (k: string) => void storage.delete(k),
    },
  })
  ;(globalThis as { window?: unknown }).window = {
    location: { pathname: '/', href: 'http://x/', origin: 'http://x', protocol: 'http:' },
    history: { state: null, pushState: () => {}, replaceState: () => {} },
  }
  posts = []
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input).replace(/^https?:\/\/[^/]+/, '')
    if (init?.method === 'POST' && /messages|thread/.test(url)) {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>
      posts.push({ url, body })
      nextId += 1
      const sent: Message = msg(nextId, { author: user('bob'), content: String(body.content) })
      return new Response(JSON.stringify(sent), { status: 200 })
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 })
  }) as typeof fetch
  useStore.setState({
    me: me('bob'),
    token: 't',
    guest: false,
    error: null,
    view: { kind: 'channel', server: 's', channelId: 1 },
    servers: { s: serverDetail('s') },
    messages: { c1: [msg(9), alice] },
    outbox: {},
    replying: {},
    composerFocus: null,
    notices: [],
    panel: null,
  })
})

afterEach(() => {
  globalThis.fetch = realFetch
  ;(globalThis as { window?: unknown }).window = realWindow
  Object.assign(globalThis, { localStorage: memoryStorage })
})

describe('replying state', () => {
  test('per view, focuses the composer, mention defaults on and is remembered per account', () => {
    st().startReply('c1', alice)
    expect(st().replying.c1).toEqual({ message: alice, mention: true })
    expect(st().composerFocus).toEqual({ key: 'c1', n: 1 })
    st().toggleReplyMention('c1')
    expect(st().replying.c1?.mention).toBe(false)
    expect(storage.get('rchat_reply_mention:bob')).toBe(JSON.stringify({ v: 1, mention: false }))
    st().startReply('d4', msg(3, { channel_id: null, dm_id: 4 }))
    expect(st().replying.d4?.mention).toBe(false)
    expect(st().replying.c1?.message.id).toBe(10)
    useStore.setState({ me: me('carol') })
    st().startReply('c2', alice)
    expect(st().replying.c2?.mention).toBe(true)
    st().cancelReply('c1')
    expect(st().replying.c1).toBeUndefined()
    expect(st().replying.d4 === undefined).toBe(false)
  })

  test('sending carries reply_to and mention_reply, shows the quote, then clears', async () => {
    useStore.setState({
      view: { kind: 'channel', server: 's', channelId: 7 },
      messages: { c7: [alice] },
    })
    st().startReply('c7', alice)
    st().toggleReplyMention('c7')
    st().sendMessage('sure')
    expect(st().replying.c7).toBeUndefined()
    const queued = st().outbox.c7?.[0]
    expect(queued?.msg.reply_to).toEqual({
      id: 10,
      author: alice.author,
      content: 'hello there',
      has_media: false,
      deleted: false,
      mention: false,
    })
    await tick()
    expect(posts).toEqual([
      {
        url: '/api/channels/7/messages',
        body: { content: 'sure', reply_to: 10, mention_reply: false },
      },
    ])
    st().sendMessage('plain')
    await tick()
    expect(posts[1].body).toEqual({ content: 'plain' })
  })

  test('thread replies send the thread reply target', async () => {
    const root = msg(10, { author: user('alice') })
    const inThread = msg(12, { thread_root_id: 10, author: user('carol') })
    useStore.setState({
      panel: { kind: 'thread', root },
      messages: { c1: [root], t10: [inThread] },
    })
    st().startReply('t10', inThread)
    st().sendThreadMessage('ok')
    await tick()
    expect(posts.at(-1)).toEqual({
      url: '/api/messages/10/thread',
      body: { content: 'ok', reply_to: 12, mention_reply: true },
    })
    expect(st().replying.t10).toBeUndefined()
  })
})

describe('deleted originals', () => {
  test('quotes become placeholders and a reply bar to it closes', () => {
    const reply = msg(11, {
      author: user('carol'),
      reply_to: {
        id: 10,
        author: user('alice'),
        content: 'hello there',
        has_media: false,
        deleted: false,
        mention: true,
      },
    })
    useStore.setState({ messages: { c1: [msg(9), alice, reply] } })
    st().startReply('c1', alice)
    st().startReply('c2', msg(9))
    dispatch({
      type: 'message_deleted',
      server: 's',
      channel_id: 1,
      dm_id: null,
      dm_users: null,
      id: 10,
      thread_root_id: null,
    })
    const quoted = st().messages.c1?.find(m => m.id === 11)?.reply_to
    expect(quoted?.deleted).toBe(true)
    expect(quoted?.author).toBeNull()
    expect(st().replying.c1).toBeUndefined()
    expect(st().replying.c2 === undefined).toBe(false)
  })
})

describe('jumping to the original', () => {
  test('a thread root jumps in place without loading', async () => {
    const root = msg(10, { author: user('alice') })
    useStore.setState({ panel: { kind: 'thread', root }, messages: { t10: [msg(12)] } })
    let fetched = 0
    globalThis.fetch = (async () => {
      fetched += 1
      return new Response('[]', { status: 200 })
    }) as typeof fetch
    await st().jumpTo('t10', 10)
    expect(st().focus.t10).toEqual({ id: 10, flash: true })
    expect(fetched).toBe(0)
  })
})

describe('DM replies that ping you', () => {
  test('toast once, as the ping, not also as a DM message', () => {
    useStore.setState({ me: me('alice'), view: null, dms: [] })
    dispatch({
      type: 'message',
      server: null,
      channel_id: null,
      dm_id: 4,
      dm_users: ['alice', 'bob'],
      message: msg(20, {
        channel_id: null,
        dm_id: 4,
        author: user('bob'),
        content: 'yes',
        reply_to: {
          id: 3,
          author: user('alice'),
          content: 'q',
          has_media: false,
          deleted: false,
          mention: true,
        },
      }),
    })
    expect(st().notices).toEqual([])
    dispatch({
      type: 'message',
      server: null,
      channel_id: null,
      dm_id: 4,
      dm_users: ['alice', 'bob'],
      message: msg(21, { channel_id: null, dm_id: 4, author: user('bob'), content: 'plain' }),
    })
    expect(st().notices.map(n => n.body)).toEqual(['plain'])
  })
})

describe('partial quotes in live events', () => {
  const ref = (id: number, mention = true) => ({
    id,
    author: null,
    content: '',
    has_media: false,
    deleted: false,
    mention,
    partial: true,
  })
  const live = (m: Message): WsEvent => ({
    type: 'message',
    server: 's',
    channel_id: m.channel_id,
    dm_id: m.dm_id,
    dm_users: null,
    message: m,
  })
  let gets: string[] = []
  const serve = (reply: (url: string) => Message[]) => {
    gets = []
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input).replace(/^https?:\/\/[^/]+/, '')
      gets.push(url)
      return new Response(JSON.stringify(reply(url)), { status: 200 })
    }) as typeof fetch
  }

  test('a loaded original fills the quote without a request', async () => {
    serve(() => [])
    dispatch(live(msg(30, { author: user('carol'), reply_to: ref(10) })))
    await tick()
    expect(st().messages.c1?.at(-1)?.reply_to).toEqual({
      id: 10,
      author: alice.author,
      content: 'hello there',
      has_media: false,
      deleted: false,
      mention: true,
    })
    expect(gets).toEqual([])
  })

  test('an unloaded original is read through the reply, once, and cached', async () => {
    const full = {
      id: 3,
      author: user('alice'),
      content: 'old news',
      has_media: false,
      deleted: false,
      mention: true,
    }
    serve(() => [msg(31, { author: user('carol'), reply_to: full })])
    dispatch(live(msg(31, { author: user('carol'), reply_to: ref(3) })))
    expect(st().messages.c1?.at(-1)?.reply_to?.partial).toBe(true)
    await tick()
    expect(gets).toEqual(['/api/channels/1/messages?around=31&limit=1'])
    expect(st().messages.c1?.at(-1)?.reply_to).toEqual(full)
    dispatch({
      type: 'message_updated',
      message: msg(31, { author: user('carol'), content: 'x', reply_to: ref(3) }),
    })
    await tick()
    expect(gets.length).toBe(1)
    expect(st().messages.c1?.at(-1)?.reply_to).toEqual(full)
    expect(st().messages.c1?.at(-1)?.content).toBe('x')
  })

  test('a quote the viewer may not read shows the placeholder REST gives', async () => {
    serve(() => [
      msg(32, {
        author: user('carol'),
        reply_to: { ...ref(3), partial: undefined, deleted: true },
      }),
    ])
    dispatch(live(msg(32, { author: user('carol'), reply_to: ref(3) })))
    await tick()
    const quote = st().messages.c1?.at(-1)?.reply_to
    expect(quote?.deleted).toBe(true)
    expect(quote?.author).toBeNull()
    expect(quote?.partial).toBeUndefined()
  })

  test('thread replies are read from the thread, unseen messages are not read', async () => {
    serve(() => [])
    const root = msg(10, { author: user('alice') })
    useStore.setState({ panel: { kind: 'thread', root }, messages: { c1: [root], t10: [msg(12)] } })
    dispatch(live(msg(33, { thread_root_id: 10, author: user('carol'), reply_to: ref(12) })))
    dispatch(live(msg(34, { channel_id: 5, author: user('carol'), reply_to: ref(2) })))
    await tick()
    expect(gets).toEqual([])
    dispatch(live(msg(35, { thread_root_id: 10, author: user('carol'), reply_to: ref(4) })))
    await tick()
    expect(gets).toEqual(['/api/messages/10/thread?around=35&limit=1'])
    expect(st().messages.t10?.find(m => m.id === 35)?.reply_to?.deleted).toBe(true)
  })

  test('a DM reply that pings you toasts once even before its quote is known', () => {
    serve(() => [])
    useStore.setState({ me: me('alice'), view: null, dms: [] })
    dispatch({
      type: 'message',
      server: null,
      channel_id: null,
      dm_id: 4,
      dm_users: ['alice', 'bob'],
      message: msg(40, { channel_id: null, dm_id: 4, author: user('bob'), reply_to: ref(3) }),
    })
    expect(st().notices).toEqual([])
  })
})

describe('deleted thread roots', () => {
  test('close the reply bar of that thread', () => {
    const root = msg(10, { author: user('alice') })
    useStore.setState({ messages: { c1: [root], t10: [msg(12, { thread_root_id: 10 })] } })
    st().startReply('t10', msg(12, { thread_root_id: 10 }))
    st().startReply('c1', msg(9))
    dispatch({
      type: 'message_deleted',
      server: 's',
      channel_id: 1,
      dm_id: null,
      dm_users: null,
      id: 10,
      thread_root_id: null,
    })
    expect(st().replying.t10).toBeUndefined()
    expect(st().replying.c1 === undefined).toBe(false)
  })
})
