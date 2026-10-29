import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { useStore, resetSessionCaches } from '../store'
import type { Message, WsEvent } from '../types'
import { me, msg, serverDetail, user } from './fixtures'

afterAll(resetSessionCaches)

const st = () => useStore.getState()
const dispatch = (ev: WsEvent) => st().applyWsEvent(ev)
const realFetch = globalThis.fetch
const realWindow = (globalThis as { window?: unknown }).window
let requests: { method: string; url: string }[] = []
let pinsReply: Message[] = []
const tick = async () => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve()
  await new Promise(r => setTimeout(r, 0))
  for (let i = 0; i < 10; i += 1) await Promise.resolve()
}
const scoped = { server: 's', channel_id: 1, dm_id: null, dm_users: null }
const chan = (id: number) => st().messages.c1?.find(m => m.id === id)

beforeEach(() => {
  ;(globalThis as { window?: unknown }).window = {
    location: { pathname: '/', href: 'http://x/', origin: 'http://x', protocol: 'http:' },
    history: { state: null, pushState: () => {}, replaceState: () => {} },
  }
  requests = []
  pinsReply = []
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    requests.push({ method, url })
    const body = url.endsWith('/pins') ? pinsReply : { ok: true }
    return new Response(JSON.stringify(body), { status: 200 })
  }) as typeof fetch
  useStore.setState({
    me: me('bob'),
    token: 't',
    guest: false,
    error: null,
    view: { kind: 'channel', server: 's', channelId: 1 },
    servers: { s: serverDetail('s') },
    messages: {
      c1: [
        msg(9),
        msg(10, { author: user('alice') }),
        msg(11, { kind: 'pin', content: '', pin_message_id: 10 }),
      ],
    },
    panel: null,
    pins: null,
  })
})

afterEach(() => {
  useStore.setState({ pins: null })
  globalThis.fetch = realFetch
  ;(globalThis as { window?: unknown }).window = realWindow
})

describe('pins in the store', () => {
  test('the window loads through the gated list of the open scope', async () => {
    pinsReply = [msg(10, { pinned_at: 100 })]
    st().openPins()
    expect(st().pins).toEqual({ key: 'c1', list: null, failed: false })
    await tick()
    expect(requests.map(r => `${r.method} ${r.url.replace(/^.*\/api/, '')}`)).toEqual([
      'GET /channels/1/pins',
    ])
    expect(st().pins?.list?.map(m => m.id)).toEqual([10])
    st().closePins()
    expect(st().pins).toBeNull()
  })

  test('pin events carry ids only and update held messages', async () => {
    dispatch({
      type: 'message_pinned',
      ...scoped,
      message_id: 10,
      pinned_at: 77,
      pinned_by: 'alice',
    })
    expect(chan(10)?.pinned_at).toBe(77)
    expect(requests).toEqual([])

    pinsReply = [msg(10, { pinned_at: 77 }), msg(9, { pinned_at: 70 })]
    st().openPins()
    await tick()
    expect(st().pins?.list?.map(m => m.id)).toEqual([10, 9])

    dispatch({ type: 'message_unpinned', ...scoped, message_id: 10 })
    expect(chan(10)?.pinned_at).toBeNull()
    expect(st().pins?.list?.map(m => m.id)).toEqual([9])

    requests = []
    pinsReply = [msg(9, { pinned_at: 70 })]
    dispatch({
      type: 'message_pinned',
      ...scoped,
      message_id: 3,
      pinned_at: 80,
      pinned_by: 'alice',
    })
    await tick()
    expect(requests.map(r => r.url.replace(/^.*\/api/, ''))).toEqual(['/channels/1/pins'])
  })

  test('deleting a pinned message drops it and unlinks its notice', async () => {
    pinsReply = [msg(10, { pinned_at: 77 })]
    st().openPins()
    await tick()
    dispatch({ type: 'message_deleted', ...scoped, id: 10, thread_root_id: null })
    expect(st().pins?.list).toEqual([])
    expect(chan(11)?.pin_message_id).toBeNull()
  })

  test('leaving the scope closes the window', async () => {
    st().openPins()
    await tick()
    void st().openDm(4)
    expect(st().pins).toBeNull()
  })

  test('pinning and unpinning call the API', async () => {
    await st().pinMessage(10)
    expect((chan(10)?.pinned_at ?? 0) > 0).toBe(true)
    await st().unpinMessage(10)
    expect(chan(10)?.pinned_at).toBeNull()
    expect(requests.map(r => `${r.method} ${r.url.replace(/^.*\/api/, '')}`)).toEqual([
      'PUT /messages/10/pin',
      'DELETE /messages/10/pin',
    ])
  })
})

describe('opening a pinned message from a notice', () => {
  test('a message outside the readable history gives a toast instead of moving', async () => {
    const realFetchNow = globalThis.fetch
    globalThis.fetch = (async (input: string | URL | Request) => {
      requests.push({ method: 'GET', url: String(input) })
      return new Response(JSON.stringify([msg(40)]), { status: 200 })
    }) as typeof fetch
    useStore.setState({ toast: null })
    await st().openPinned('c1', 3)
    expect(st().toast?.text).toBe("You can't open this message")
    expect(st().messages.c1?.map(m => m.id)).toEqual([9, 10, 11])
    globalThis.fetch = realFetchNow
  })

  test('a held message is focused without a request', async () => {
    await st().openPinned('c1', 10)
    expect(requests).toEqual([])
    expect(st().focus.c1?.id).toBe(10)
  })
})

describe('resync with the window open', () => {
  test('reloads the open list, and does nothing while it is closed', async () => {
    const realRandom = Math.random
    Math.random = () => 0
    const baseFetch = globalThis.fetch
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const res = await baseFetch(input, init)
      if (String(input).endsWith('/pins') || !String(input).includes('/messages')) return res
      return new Response('[]', { status: 200 })
    }) as typeof fetch
    const pinReads = () => requests.filter(r => r.url.endsWith('/pins')).length
    try {
      dispatch({ type: 'resync' })
      await new Promise(r => setTimeout(r, 400))
      expect(pinReads()).toBe(0)
      pinsReply = [msg(10, { pinned_at: 100 })]
      st().openPins()
      await tick()
      expect(pinReads()).toBe(1)
      pinsReply = [msg(10, { pinned_at: 100 }), msg(9, { pinned_at: 90 })]
      dispatch({ type: 'resync' })
      await new Promise(r => setTimeout(r, 400))
      expect(pinReads()).toBe(2)
      expect(st().pins?.list?.map(m => m.id)).toEqual([10, 9])
    } finally {
      globalThis.fetch = baseFetch
      Math.random = realRandom
    }
  })
})
