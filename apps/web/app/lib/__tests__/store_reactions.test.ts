import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { useStore, resetSessionCaches } from '../store'
import type { Message, Reaction, WsEvent } from '../types'
import { me, msg, serverDetail, user } from './fixtures'

afterAll(resetSessionCaches)

const st = () => useStore.getState()
const dispatch = (ev: WsEvent) => st().applyWsEvent(ev)
const realFetch = globalThis.fetch
const realWindow = (globalThis as { window?: unknown }).window
let requests: { method: string; url: string }[] = []
let respond: (method: string, url: string) => Response = () =>
  new Response(JSON.stringify({ ok: true }), { status: 200 })
const tick = async () => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve()
  await new Promise(r => setTimeout(r, 0))
  for (let i = 0; i < 10; i += 1) await Promise.resolve()
}

const event = (
  type: 'reaction_added' | 'reaction_removed',
  emoji: string,
  username: string,
  message_id = 10,
  count?: number
): WsEvent => ({
  type,
  server: 's',
  channel_id: 1,
  dm_id: null,
  dm_users: null,
  message_id,
  thread_root_id: null,
  emoji,
  username,
  ...(count === undefined ? {} : { count }),
})
const shape = (m: Message | undefined) =>
  (m?.reactions ?? []).map((r: Reaction) => `${r.emoji}${r.count}${r.me ? '*' : ''}`)
const chan = () => st().messages.c1?.find(m => m.id === 10)

beforeEach(() => {
  ;(globalThis as { window?: unknown }).window = {
    location: { pathname: '/', href: 'http://x/', origin: 'http://x', protocol: 'http:' },
    history: { state: null, pushState: () => {}, replaceState: () => {} },
  }
  requests = []
  respond = () => new Response(JSON.stringify({ ok: true }), { status: 200 })
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    requests.push({ method, url })
    return respond(method, url)
  }) as typeof fetch
  useStore.setState({
    me: me('bob'),
    token: 't',
    guest: false,
    error: null,
    view: { kind: 'channel', server: 's', channelId: 1 },
    servers: { s: serverDetail('s') },
    messages: { c1: [msg(9), msg(10, { author: user('alice') })] },
    panel: null,
  })
})

afterEach(() => {
  globalThis.fetch = realFetch
  ;(globalThis as { window?: unknown }).window = realWindow
})

describe('reaction events', () => {
  test('count, mine and chronological order', () => {
    dispatch(event('reaction_added', '😭', 'alice'))
    dispatch(event('reaction_added', '✅', 'bob'))
    dispatch(event('reaction_added', '😭', 'bob'))
    dispatch(event('reaction_added', '💀', 'carol'))
    expect(shape(chan())).toEqual(['😭2*', '✅1*', '💀1'])
    dispatch(event('reaction_removed', '😭', 'alice'))
    dispatch(event('reaction_removed', '💀', 'carol'))
    expect(shape(chan())).toEqual(['😭1*', '✅1*'])
    dispatch(event('reaction_removed', '😭', 'bob'))
    expect(shape(chan())).toEqual(['✅1*'])
    expect(shape(st().messages.c1?.[0])).toEqual([])
  })

  test('a thread root shown only in the panel is updated too', () => {
    useStore.setState({
      messages: {},
      panel: { kind: 'thread', root: msg(10, { channel_id: 1 }) } as never,
    })
    dispatch(event('reaction_added', '🧵', 'alice'))
    const panel = st().panel
    expect(panel?.kind === 'thread' ? shape(panel.root) : []).toEqual(['🧵1'])
  })

  test('message_updated keeps the reactions already shown', () => {
    dispatch(event('reaction_added', '😭', 'alice'))
    dispatch({ type: 'message_updated', message: msg(10, { content: 'edited', reactions: [] }) })
    expect(chan()?.content).toBe('edited')
    expect(shape(chan())).toEqual(['😭1'])
  })
})

describe('toggling', () => {
  test('optimistic add, encoded PUT, and the echo does not double count', async () => {
    st().toggleReaction(chan()!, '👍🏽')
    expect(shape(chan())).toEqual(['👍🏽1*'])
    await tick()
    expect(requests.map(r => `${r.method} ${r.url.replace(/^https?:\/\/[^/]+/, '')}`)).toEqual([
      `PUT /api/messages/10/reactions/${encodeURIComponent('👍🏽')}`,
    ])
    dispatch(event('reaction_added', '👍🏽', 'bob'))
    expect(shape(chan())).toEqual(['👍🏽1*'])
    st().toggleReaction(chan()!, '👍🏽')
    expect(shape(chan())).toEqual([])
    await tick()
    expect(requests.at(-1)?.method).toBe('DELETE')
    dispatch(event('reaction_removed', '👍🏽', 'bob'))
    expect(shape(chan())).toEqual([])
  })

  test('a failed request rolls back and shows the error', async () => {
    respond = () => new Response(JSON.stringify({ error: 'Too many reactions' }), { status: 400 })
    dispatch(event('reaction_added', '😭', 'alice'))
    st().toggleReaction(chan()!, '😭')
    expect(shape(chan())).toEqual(['😭2*'])
    await tick()
    expect(shape(chan())).toEqual(['😭1'])
    expect(st().error).toBe('Too many reactions')
  })

  test('quick toggles reach the server in order', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>(r => (release = r))
    respond = (method: string) => {
      if (method === 'PUT') {
        return gate.then(() => new Response('{"ok":true}')) as unknown as Response
      }
      return new Response('{"ok":true}')
    }
    st().toggleReaction(chan()!, '🎉')
    st().toggleReaction(chan()!, '🎉')
    await tick()
    expect(requests.map(r => r.method)).toEqual(['PUT'])
    release()
    await tick()
    expect(requests.map(r => r.method)).toEqual(['PUT', 'DELETE'])
    expect(shape(chan())).toEqual([])
  })

  test('guests cannot react', () => {
    useStore.setState({ guest: true })
    st().toggleReaction(chan()!, '👍')
    expect(shape(chan())).toEqual([])
  })

  test('reactors are cached per emoji until a change', async () => {
    respond = () => new Response(JSON.stringify([user('alice')]), { status: 200 })
    expect((await st().loadReactors(10, '😭')).map(u => u.username)).toEqual(['alice'])
    await st().loadReactors(10, '😭')
    expect(requests.length).toBe(1)
    dispatch(event('reaction_added', '😭', 'carol'))
    await st().loadReactors(10, '😭')
    expect(requests.length).toBe(2)
    expect(requests[0].url).toEndWith(
      `/api/messages/10/reactions/${encodeURIComponent('😭')}?limit=100`
    )
  })
})

describe('events with counts', () => {
  test('an event already included in a fresh page is not counted twice', () => {
    useStore.setState({
      messages: {
        c1: [
          msg(10, {
            author: user('alice'),
            reactions: [{ emoji: '😭', count: 2, me: false, first_at: 1 }],
          }),
        ],
      },
    })
    dispatch(event('reaction_added', '😭', 'carol', 10, 2))
    dispatch(event('reaction_added', '😭', 'carol', 10, 2))
    expect(shape(chan())).toEqual(['😭2'])
    dispatch(event('reaction_added', '😭', 'dave', 10, 3))
    expect(shape(chan())).toEqual(['😭3'])
    dispatch(event('reaction_removed', '😭', 'dave', 10, 2))
    dispatch(event('reaction_removed', '😭', 'dave', 10, 2))
    expect(shape(chan())).toEqual(['😭2'])
  })

  test('own echoes of an in-flight toggle keep the local state and the others count', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>(r => (release = r))
    respond = () => gate.then(() => new Response('{"ok":true}')) as unknown as Response
    dispatch(event('reaction_added', '🎉', 'alice', 10, 1))
    st().toggleReaction(chan()!, '🎉')
    st().toggleReaction(chan()!, '🎉')
    expect(shape(chan())).toEqual(['🎉1'])
    dispatch(event('reaction_added', '🎉', 'carol', 10, 2))
    dispatch(event('reaction_added', '🎉', 'bob', 10, 3))
    expect(shape(chan())).toEqual(['🎉2'])
    dispatch(event('reaction_removed', '🎉', 'bob', 10, 2))
    release()
    await tick()
    expect(shape(chan())).toEqual(['🎉2'])
  })

  test('the server form of an emoji replaces the picked one', async () => {
    st().toggleReaction(chan()!, '❤')
    expect(shape(chan())).toEqual(['❤1*'])
    await tick()
    dispatch(event('reaction_added', '❤️', 'bob', 10, 1))
    expect(shape(chan())).toEqual(['❤️1*'])
    st().toggleReaction(chan()!, '❤️')
    expect(shape(chan())).toEqual([])
  })

  test('a full message refuses a new emoji without a request', async () => {
    const reactions = Array.from({ length: 20 }, (_, i) => ({
      emoji: String.fromCodePoint(0x1f600 + i),
      count: 1,
      me: false,
      first_at: 1,
    }))
    useStore.setState({ messages: { c1: [msg(10, { author: user('alice'), reactions })] } })
    st().toggleReaction(chan()!, '🦀')
    await tick()
    expect(requests).toEqual([])
    expect(chan()?.reactions?.length).toBe(20)
    st().toggleReaction(chan()!, '😀')
    await tick()
    expect(requests.map(r => r.method)).toEqual(['PUT'])
  })
})
