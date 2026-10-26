import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { useStore } from '../store'
import type { Message, WsEvent } from '../types'
import { me, media, msg, result, serverDetail, user } from './fixtures'

const st = () => useStore.getState()
const dispatch = (ev: WsEvent) => st().applyWsEvent(ev)
const realFetch = globalThis.fetch
const realWindow = (globalThis as { window?: unknown }).window
let requests: string[] = []
let replies: unknown[] = []

const serve = () => {
  globalThis.fetch = (async (input: string | URL | Request) => {
    requests.push(String(input))
    return new Response(JSON.stringify(replies.shift() ?? []), { status: 200 })
  }) as typeof fetch
}
const hang = () => {
  globalThis.fetch = ((input: string | URL | Request) => {
    requests.push(String(input))
    return new Promise<Response>(() => {})
  }) as typeof fetch
}
const range = (from: number, to: number, over: Partial<Message> = {}) =>
  Array.from({ length: to - from + 1 }, (_, i) => msg(from + i, over))
const span = (from: number, to: number) => range(from, to).map(m => m.id)
const ids = (key: string) => (st().messages[key] ?? []).map(m => m.id)
const scoped = { server: 's', channel_id: 1, dm_id: null, dm_users: null }
const live = (id: number, over: Partial<Message> = {}): WsEvent => ({
  type: 'message',
  ...scoped,
  message: msg(id, { author: user('bob'), ...over }),
})
const content = (key: string, id: number) => st().messages[key]?.find(m => m.id === id)?.content

beforeEach(() => {
  requests = []
  replies = []
  serve()
  useStore.setState({
    me: me('alice'),
    token: null,
    guest: false,
    view: { kind: 'channel', server: 's', channelId: 1 },
    servers: {},
    serversMore: false,
    dmsMore: false,
    messages: {},
    older: {},
    newer: {},
    focus: {},
    outbox: {},
    pending: {},
    drafts: {},
    reads: {},
    unreadAnchor: {},
    panel: null,
    invite: null,
    error: null,
  })
})

afterEach(() => {
  globalThis.fetch = realFetch
  ;(globalThis as { window?: unknown }).window = realWindow
})

describe('jumping to a message', () => {
  test('an unloaded message loads a window around it and is focused', async () => {
    replies = [range(75, 124)]
    await st().jumpTo('c1', 100)
    expect(requests[0]).toEndWith('/channels/1/messages?around=100&limit=50')
    expect(ids('c1')).toEqual(span(75, 124))
    expect(st().older.c1).toEqual({ more: true, loading: false })
    expect(st().newer.c1).toEqual({ more: true, loading: false })
    expect(st().focus.c1).toEqual({ id: 100, flash: true })
    st().clearFocus('c1')
    expect(st().focus.c1).toBeUndefined()
  })

  test('a window that reaches the newest message stays live', async () => {
    replies = [range(76, 110)]
    await st().jumpTo('c1', 100)
    expect(st().newer.c1).toBeUndefined()
    dispatch(live(111))
    expect(ids('c1')).toEqual(span(76, 111))
  })

  test('a loaded message is only focused', async () => {
    useStore.setState({ messages: { c1: range(1, 10) } })
    await st().jumpTo('c1', 4, false)
    expect(requests).toHaveLength(0)
    expect(st().focus.c1).toEqual({ id: 4, flash: false })
  })

  test('live messages wait while the window is detached and arrive once it catches up', async () => {
    replies = [range(75, 124)]
    await st().jumpTo('c1', 100)
    dispatch(live(300))
    expect(ids('c1')).toEqual(span(75, 124))
    replies = [range(125, 174)]
    await st().loadNewer()
    expect(requests[1]).toEndWith('/channels/1/messages?after=124')
    expect(st().newer.c1).toEqual({ more: true, loading: false })
    replies = [range(175, 180)]
    await st().loadNewer()
    expect(requests[2]).toEndWith('/channels/1/messages?after=174')
    expect(ids('c1')).toEqual([...span(75, 180), 300])
    expect(st().newer.c1).toBeUndefined()
  })

  test('jumping to the present loads the latest page and scrolls to the bottom', async () => {
    replies = [range(75, 124)]
    await st().jumpTo('c1', 100)
    dispatch(live(301))
    replies = [range(251, 300)]
    await st().jumpToPresent('c1')
    expect(requests[1]).toEndWith('/channels/1/messages')
    expect(ids('c1')).toEqual([...span(251, 300), 301])
    expect(st().newer.c1).toBeUndefined()
    expect(st().focus.c1).toEqual({ id: null, flash: false })
  })

  test('a message deleted while detached stays deleted after catching up', async () => {
    replies = [range(75, 124)]
    await st().jumpTo('c1', 100)
    dispatch(live(125))
    dispatch(live(126))
    dispatch({ type: 'message_deleted', id: 125, thread_root_id: null, ...scoped })
    replies = [[]]
    await st().loadNewer()
    expect(requests[1]).toEndWith('/channels/1/messages?after=124')
    expect(ids('c1')).toEqual([...span(75, 124), 126])
    expect(st().newer.c1).toBeUndefined()
  })

  test('edits made while detached are kept when jumping to the present', async () => {
    replies = [range(75, 124)]
    await st().jumpTo('c1', 100)
    dispatch(live(199, { content: 'v1' }))
    dispatch(live(200, { content: 'v1' }))
    dispatch(live(201, { content: 'v1', media: media() }))
    dispatch({ type: 'message_updated', message: msg(200, { author: user('bob'), content: 'v2' }) })
    dispatch({
      type: 'message_updated',
      message: msg(201, { author: user('bob'), content: 'v2', media: media() }),
    })
    dispatch({
      type: 'media_removed',
      message_id: 201,
      filename: 'f.png',
      removed_by_author: true,
      ...scoped,
    })
    replies = [[...range(151, 198), ...range(199, 200, { content: 'v2' })]]
    await st().jumpToPresent('c1')
    expect(ids('c1')).toEqual(span(151, 201))
    expect(content('c1', 199)).toBe('v2')
    expect(content('c1', 200)).toBe('v2')
    expect(content('c1', 201)).toBe('v2')
    expect(st().messages.c1.at(-1)?.media?.removed).toBe(true)
  })

  test('a fetched page replaces held copies of the same messages', async () => {
    replies = [range(75, 124)]
    await st().jumpTo('c1', 100)
    dispatch(live(125, { content: 'old' }))
    dispatch(live(140))
    replies = [range(125, 130, { content: 'new' })]
    await st().loadNewer()
    expect(ids('c1')).toEqual([...span(75, 130), 140])
    expect(content('c1', 125)).toBe('new')
  })

  test('older pages ask for messages before the first loaded one', async () => {
    replies = [range(75, 124), range(25, 74)]
    await st().jumpTo('c1', 100)
    await st().loadOlder()
    expect(requests[1]).toEndWith('/channels/1/messages?before=75')
    expect(ids('c1')).toEqual(span(25, 124))
  })

  test('a thread search result opens the channel at the root and the thread at the reply', async () => {
    ;(globalThis as { window?: unknown }).window = {
      location: { pathname: '/', href: 'http://x/', origin: 'http://x', protocol: 'http:' },
      history: { state: null, pushState: () => {}, replaceState: () => {} },
    }
    useStore.setState({ view: { kind: 'channel', server: 's', channelId: 9 } })
    const root = msg(40, { channel_id: 1, reply_count: 3 })
    const detail = {
      name: 's',
      display_name: 'S',
      creator: null,
      has_password: false,
      channels: [{ id: 1, name: 'general', kind: 'text', slowmode_seconds: 0 }],
      roles: [],
      member_count: 1,
      online_count: 0,
    }
    replies = [detail, [...range(30, 39), root, ...range(41, 45)], range(500, 510)]
    const hit = result(505, 1)
    await st().openResult({
      ...hit,
      server: 's',
      message: { ...hit.message, id: 505, channel_id: 1, thread_root_id: 40 },
    })
    expect(requests[1]).toEndWith('/channels/1/messages?around=40&limit=50')
    expect(requests[2]).toEndWith('/messages/40/thread?around=505&limit=50')
    expect(st().view).toEqual({ kind: 'channel', server: 's', channelId: 1 })
    expect(st().focus.c1).toEqual({ id: 40, flash: true })
    expect(st().focus.t40).toEqual({ id: 505, flash: true })
    expect(st().panel?.kind === 'thread' && st().panel).toEqual({ kind: 'thread', root })
  })
})

describe('unread anchor', () => {
  test('stays where it was while catching up, and follows reads when nothing was unread', async () => {
    useStore.setState({
      reads: {
        c1: { lastRead: 10, latest: 20 },
        c2: { lastRead: 20, latest: 20 },
      },
    })
    replies = [range(1, 20), range(1, 20)]
    await st().openChannel('s', 1, 'none')
    expect(st().unreadAnchor.c1).toBe(10)
    st().markRead('c1', 20)
    dispatch({ type: 'read_updated', username: 'alice', scope: 'c1', last_read: 20 })
    expect(st().unreadAnchor.c1).toBe(10)
    expect(st().reads.c1.lastRead).toBe(20)
    st().dismissUnread('c1')
    expect(st().unreadAnchor.c1).toBe(20)
    await st().openChannel('s', 2, 'none')
    expect(st().unreadAnchor.c2).toBe(20)
    st().markRead('c2', 25)
    expect(st().unreadAnchor.c2).toBe(25)
  })

  test('a never-read channel has no anchor', async () => {
    replies = [range(1, 50)]
    await st().openChannel('s', 3, 'none')
    expect(st().unreadAnchor.c3).toBe(0)
  })

  test('opening at a message loads around it', async () => {
    replies = [range(76, 125)]
    await st().openChannel('s', 1, 'none', 100)
    expect(requests[0]).toEndWith('/channels/1/messages?around=100&limit=50')
    expect(st().focus.c1).toEqual({ id: 100, flash: true })
  })
})

describe('pending uploads', () => {
  test('an attachment stays with the conversation it was added to', () => {
    hang()
    const file = new File(['x'], 'notes.txt')
    useStore.setState({ view: { kind: 'dm', dmId: 5 } })
    st().uploadFile('d5', file)
    useStore.setState({ view: { kind: 'channel', server: 's', channelId: 1 } })
    expect(st().pending.c1).toBeUndefined()
    st().sendMessage('hello')
    expect(st().outbox.c1[0].pending).toBeNull()
    expect(st().pending.d5?.file.name).toBe('notes.txt')
    st().toggleSpoiler('d5')
    st().toggleUploadMode('d5')
    expect(st().pending.d5?.spoiler).toBe(true)
    expect(st().pending.d5?.mode).toBe('p2p')
    useStore.setState({ view: { kind: 'dm', dmId: 5 } })
    st().sendMessage('')
    expect(st().outbox.d5[0].pending?.file.name).toBe('notes.txt')
    expect(st().pending.d5).toBeUndefined()
  })

  test('attachments go away with their server, channel, dm or thread', () => {
    hang()
    const chan = (id: number) => ({
      id,
      name: `c${id}`,
      kind: 'text' as const,
      slowmode_seconds: 0,
    })
    const thread = (root: Message) => useStore.setState({ panel: { kind: 'thread', root } })
    useStore.setState({
      view: { kind: 'dm', dmId: 6 },
      servers: {
        s: serverDetail('s', { channels: [chan(1), chan(2)] }),
        o: serverDetail('o', { channels: [chan(9)] }),
      },
      dms: [
        { id: 5, other: user('bob'), is_self: false },
        { id: 6, other: user('carol'), is_self: false },
      ],
      messages: {
        c9: [msg(70, { channel_id: 9, author: user('bob') }), msg(80, { channel_id: 9 })],
      },
    })
    for (const key of ['c1', 'c2', 'c9', 'd5', 'd6']) st().uploadFile(key, new File(['x'], key))
    thread(msg(40, { channel_id: 2 }))
    st().uploadFile('t40', new File(['x'], 't40'))
    thread(msg(70, { channel_id: 9, author: user('bob') }))
    st().uploadFile('t70', new File(['x'], 't70'))
    thread(msg(80, { channel_id: 9 }))
    st().uploadFile('t80', new File(['x'], 't80'))
    useStore.setState({ panel: null })
    expect(st().pending.t40?.scope).toBe('c2')
    const keys = () => Object.keys(st().pending).sort()
    dispatch({ type: 'member_left', server: 's', username: 'alice' })
    expect(keys()).toEqual(['c9', 'd5', 'd6', 't70', 't80'])
    dispatch({ type: 'message_deleted', id: 80, thread_root_id: null, ...scoped, channel_id: 9 })
    expect(keys()).toEqual(['c9', 'd5', 'd6', 't70'])
    dispatch({ type: 'banned', username: 'bob' })
    expect(keys()).toEqual(['c9', 'd6'])
    dispatch({ type: 'channel_deleted', server: 'o', channel_id: 9 })
    expect(keys()).toEqual(['d6'])
  })

  test('thread attachments are kept per thread', () => {
    hang()
    const file = new File(['x'], 'pic.png')
    st().uploadFile('t7', file)
    useStore.setState({ panel: { kind: 'thread', root: msg(8) } })
    st().sendThreadMessage('hi')
    expect(st().outbox.t8[0].pending).toBeNull()
    expect(st().pending.t7?.file.name).toBe('pic.png')
    st().uploadFile('t7', null)
    expect(st().pending.t7).toBeUndefined()
  })
})
