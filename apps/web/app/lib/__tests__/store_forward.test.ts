import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { previewServer, useStore, resetSessionCaches } from '../store'
import { clipOf, forwardKey } from '../forward'
import type { Message } from '../types'
import { me, memoryStorage, msg, serverDetail, user } from './fixtures'

afterAll(resetSessionCaches)

const st = () => useStore.getState()
const realFetch = globalThis.fetch
const realWindow = (globalThis as { window?: unknown }).window
let posts: { url: string; body: Record<string, unknown> }[] = []
let status = 200
let located: Record<string, unknown> | null = null
let joins: string[] = []
let hidden: unknown = null
let joinStatus = 401
let joinError = 'Password required'
const tick = async () => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve()
  await new Promise(r => setTimeout(r, 0))
  for (let i = 0; i < 10; i += 1) await Promise.resolve()
}

const source = msg(40, { author: user('carol'), content: 'look at this', created_at: 7 })

beforeEach(() => {
  memoryStorage.clear()
  Object.assign(globalThis, { localStorage: memoryStorage })
  ;(globalThis as { window?: unknown }).window = {
    location: { pathname: '/', href: 'http://x/', origin: 'http://x', protocol: 'http:' },
    history: { state: null, pushState: () => {}, replaceState: () => {} },
  }
  posts = []
  status = 200
  located = null
  joins = []
  hidden = null
  joinStatus = 401
  joinError = 'Password required'
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input).replace(/^https?:\/\/[^/]+/, '')
    if (url.includes('/location')) {
      return located
        ? new Response(JSON.stringify(located), { status: 200 })
        : new Response(JSON.stringify({ error: 'Not found' }), { status: 404 })
    }
    if (hidden && url === '/api/servers/lounge')
      return new Response(JSON.stringify(hidden), { status: 200 })
    if (init?.method === 'POST' && url.endsWith('/join')) {
      joins.push(url)
      return new Response(JSON.stringify({ error: joinError }), { status: joinStatus })
    }
    if (init?.method === 'POST' && url.endsWith('/messages')) {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>
      posts.push({ url, body })
      if (status !== 200)
        return new Response(JSON.stringify({ error: 'Cannot forward that message' }), { status })
      const sent: Message = msg(50, {
        author: user('bob'),
        content: 'look at this',
        forward: {
          author: user('carol'),
          created_at: 7,
          source_id: 40,
          origin: 'Direct message',
          dropped: null,
        },
      })
      return new Response(JSON.stringify(sent), { status: 200 })
    }
    return new Response(JSON.stringify([]), { status: 200 })
  }) as typeof fetch
  useStore.setState({
    me: me('bob', { servers: [{ name: 's', display_name: 's', creator: null, is_admin: false }] }),
    token: 't',
    guest: false,
    error: null,
    toast: null,
    activeDialog: null,
    forwardClip: null,
    view: { kind: 'channel', server: 's', channelId: 77 },
    servers: {
      s: serverDetail('s', {
        channels: [{ id: 77, name: 'general', kind: 'text', slowmode_seconds: 0 }],
      }),
    },
    messages: { c77: [msg(9)] },
    outbox: {},
    panel: null,
  })
})

afterEach(() => {
  globalThis.fetch = realFetch
  ;(globalThis as { window?: unknown }).window = realWindow
})

describe('sending a forward', () => {
  test('posts only forward_of, then clears the clipboard and toasts', async () => {
    st().copyForward(source)
    st().sendForward('c77')
    st().sendForward('c77')
    await tick()
    expect(posts).toEqual([
      { url: '/api/channels/77/messages', body: { content: '', forward_of: 40 } },
    ])
    expect(st().forwardClip).toBeNull()
    expect(memoryStorage.getItem(forwardKey('bob'))).toBeNull()
    expect(st().toast?.text).toBe('Forwarded to #general')
    expect(st().messages.c77?.some(m => m.id === 50 && m.forward?.source_id === 40)).toBe(true)
  })

  test('a failed forward keeps the clipboard', async () => {
    status = 400
    st().copyForward(source)
    st().sendForward('c77')
    await tick()
    expect(st().forwardClip?.id).toBe(40)
    expect(st().outbox.c77?.[0]?.status).toBe('failed')
  })

  test('a forward sent while another was copied keeps the newer one', async () => {
    st().copyForward(source)
    st().sendForward('d3')
    useStore.setState({ forwardClip: clipOf(msg(41)) })
    await tick()
    expect(posts[0]?.url).toBe('/api/dms/3/messages')
    expect(st().forwardClip?.id).toBe(41)
  })
})

describe('opening the original', () => {
  const copy = msg(50, {
    forward: { author: user('carol'), created_at: 7, source_id: 40, origin: null, dropped: null },
  })

  test('an unreadable original gives a neutral toast, never an error or prompt', async () => {
    await st().openForward(copy)
    expect(st().toast?.text).toBe("You can't open this message")
    expect(st().error).toBeNull()
    expect(st().activeDialog).toBeNull()
  })
})

describe('previewServer', () => {
  test('is the open server only while not a member', () => {
    expect(previewServer(st())).toBeNull()
    useStore.setState({ view: { kind: 'channel', server: 'other', channelId: 2 } })
    expect(previewServer(st())).toBe('other')
    useStore.setState({ view: { kind: 'dm', dmId: 1 } })
    expect(previewServer(st())).toBeNull()
    useStore.setState({ view: { kind: 'channel', server: 'other', channelId: 2 }, guest: true })
    expect(previewServer(st())).toBeNull()
  })
})

describe('leaving a preview', () => {
  const lounge = () =>
    serverDetail('lounge', {
      channels: [{ id: 88, name: 'lobby', kind: 'text', slowmode_seconds: 0 }],
    })
  const previewing = () =>
    useStore.setState({
      view: { kind: 'channel', server: 'lounge', channelId: 88 },
      servers: { ...st().servers, lounge: lounge() },
      messages: { ...st().messages, c88: [msg(60, { channel_id: 88 })] },
    })

  test('a deleted last channel forgets the previewed server', () => {
    previewing()
    expect(previewServer(st())).toBe('lounge')
    st().applyWsEvent({ type: 'channel_deleted', server: 'lounge', channel_id: 88 })
    expect(st().view).toBeNull()
    expect(st().servers.lounge).toBeUndefined()
    expect(st().messages.c88).toBeUndefined()
    expect(Object.keys(st().servers)).toEqual(['s'])
  })

  test('losing sight of every channel forgets the previewed server', async () => {
    previewing()
    hidden = serverDetail('lounge', { channels: [] })
    st().applyWsEvent({ type: 'channel_perms_changed', server: 'lounge', channel_id: 88 })
    await tick()
    expect(st().view).toBeNull()
    expect(st().servers.lounge).toBeUndefined()
    expect(st().messages.c88).toBeUndefined()
  })
})

describe('joining from the preview tile', () => {
  test('a server that wants a password opens the join dialog with its name', async () => {
    await st().joinPreview('lounge')
    expect(joins).toEqual(['/api/servers/lounge/join'])
    expect(st().activeDialog).toEqual({ kind: 'add_server', join: 'lounge', locked: true })
    expect(st().error).toBeNull()
  })

  test('other failures show the error', async () => {
    joinStatus = 403
    joinError = 'You are banned from this server'
    await st().joinPreview('lounge')
    expect(st().activeDialog).toBeNull()
    expect(st().error).toBe('You are banned from this server')
  })
})
