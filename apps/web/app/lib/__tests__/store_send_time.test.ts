import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { useStore, resetSessionCaches } from '../store'
import { messagePlaces } from '../message_groups'
import { clockSample } from '../send_clock'
import { me, memoryStorage, msg, serverDetail, user } from './fixtures'
import { Secret } from '../secret'

afterAll(resetSessionCaches)

const st = () => useStore.getState()
const realFetch = globalThis.fetch
const realWindow = (globalThis as { window?: unknown }).window
const tick = async () => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve()
  await new Promise(r => setTimeout(r, 0))
  for (let i = 0; i < 10; i += 1) await Promise.resolve()
}

// Unix seconds, in the middle of a day in every time zone the tests run in.
const T0 = 1_800_000_000
const realNow = Date.now
const at = (seconds: number) => {
  Date.now = () => seconds * 1000
}

let serverAhead = 0
let refuse = false
let postGate: Promise<void> | null = null
let uploadGate: Promise<void> | null = null
let posted: { content: string; device: number }[] = []
let nextId = 50

const gate = () => {
  let open = () => {}
  const wait = new Promise<void>(r => {
    open = r
  })
  return { wait, open }
}

const setup = (mineAt: number) =>
  useStore.setState({
    me: me('bob', { servers: [{ name: 's', display_name: 's', creator: null, is_admin: false }] }),
    token: Secret.of('t'),
    guest: false,
    error: null,
    view: { kind: 'channel', server: 's', channelId: 77 },
    servers: {
      s: serverDetail('s', {
        channels: [{ id: 77, name: 'general', kind: 'text', slowmode_seconds: 0 }],
      }),
    },
    messages: {
      c77: [msg(9, { channel_id: 77, author: user('bob'), created_at: mineAt })],
    },
    outbox: {},
    pending: {},
    slowUntil: {},
    panel: null,
  })

const headers = () =>
  messagePlaces(st().messages.c77 ?? [], undefined, st().outbox.c77 ?? []).map(p => p.first)

beforeEach(() => {
  memoryStorage.clear()
  Object.assign(globalThis, { localStorage: memoryStorage })
  ;(globalThis as { window?: unknown }).window = {
    location: { pathname: '/', href: 'http://x/', origin: 'http://x', protocol: 'http:' },
    history: { state: null, pushState: () => {}, replaceState: () => {} },
  }
  resetSessionCaches()
  serverAhead = 0
  refuse = false
  postGate = null
  uploadGate = null
  posted = []
  nextId = 50
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input).replace(/^https?:\/\/[^/]+/, '')
    if (init?.method === 'POST' && url === '/api/channels/77/messages') {
      const { content } = JSON.parse(String(init.body)) as { content: string }
      const device = Math.floor(Date.now() / 1000)
      posted.push({ content, device })
      const wait = postGate
      if (wait) await wait
      if (refuse) return new Response(JSON.stringify({ error: 'Try again' }), { status: 500 })
      nextId += 1
      const created_at = device + serverAhead
      return new Response(
        JSON.stringify(msg(nextId, { channel_id: 77, author: user('bob'), content, created_at })),
        { status: 200 }
      )
    }
    if (init?.method === 'POST' && url === '/api/media') {
      const wait = uploadGate
      if (wait) await wait
      return new Response(JSON.stringify({ id: 'up1' }), { status: 200 })
    }
    return new Response(JSON.stringify([]), { status: 200 })
  }) as typeof fetch
})

afterEach(() => {
  Date.now = realNow
  globalThis.fetch = realFetch
  ;(globalThis as { window?: unknown }).window = realWindow
})

describe('a send takes the time it goes out', () => {
  test('a retry later than the group window starts its own header while it sends', async () => {
    setup(T0 - 60)
    at(T0)
    refuse = true
    st().sendMessage('hi')
    await tick()
    const failed = st().outbox.c77?.[0]
    expect(failed?.status).toBe('failed')
    expect(failed?.msg.created_at).toBe(T0)

    at(T0 + 450)
    refuse = false
    const post = gate()
    postGate = post.wait
    st().retryOutgoing('c77', failed!.tempId)
    const sending = st().outbox.c77?.[0]
    expect(sending?.status).toBe('sending')
    expect(sending?.msg.created_at).toBe(T0 + 450)
    expect(headers()).toEqual([true, true])

    post.open()
    await tick()
    expect(st().outbox.c77).toBeUndefined()
    expect(st().messages.c77?.map(m => m.created_at)).toEqual([T0 - 60, T0 + 450])
    expect(headers()).toEqual([true, true])
  })

  test('a retry within the group window stays in the group while it sends and once sent', async () => {
    setup(T0 - 60)
    at(T0)
    refuse = true
    st().sendMessage('hi')
    await tick()
    const failed = st().outbox.c77![0]
    at(T0 + 200)
    refuse = false
    const post = gate()
    postGate = post.wait
    st().retryOutgoing('c77', failed.tempId)
    expect(st().outbox.c77?.[0]?.msg.created_at).toBe(T0 + 200)
    expect(headers()).toEqual([true, false])
    post.open()
    await tick()
    expect(headers()).toEqual([true, false])
  })

  test('a send with an upload takes the time the upload ends, and so does the send behind it', async () => {
    setup(T0 - 60)
    at(T0)
    const upload = gate()
    uploadGate = upload.wait
    const post = gate()
    postGate = post.wait
    const file = new File(['x'], 'a.png', { type: 'image/png' })
    useStore.setState({ pending: { c77: { file, spoiler: false, mode: 'server', scope: 'c77' } } })
    st().sendMessage('photo')
    st().sendMessage('after')
    await tick()
    expect(st().outbox.c77?.map(o => [o.status, o.msg.created_at])).toEqual([
      ['sending', T0],
      ['queued', T0],
    ])
    expect(headers()).toEqual([true, false, false])

    at(T0 + 480)
    upload.open()
    await tick()
    expect(posted).toEqual([{ content: 'photo', device: T0 + 480 }])
    expect(st().outbox.c77?.map(o => [o.status, o.msg.created_at])).toEqual([
      ['sending', T0 + 480],
      ['queued', T0 + 480],
    ])
    expect(headers()).toEqual([true, true, false])

    at(T0 + 481)
    post.open()
    await tick()
    expect(posted.map(p => p.device)).toEqual([T0 + 480, T0 + 481])
    expect(st().outbox.c77).toBeUndefined()
    expect(st().messages.c77?.map(m => m.created_at)).toEqual([T0 - 60, T0 + 480, T0 + 481])
    expect(headers()).toEqual([true, true, false])
  })

  test('a send queued behind a slow one takes the time it starts sending', async () => {
    setup(T0 - 60)
    at(T0)
    const post = gate()
    postGate = post.wait
    st().sendMessage('one')
    st().sendMessage('two')
    await tick()
    at(T0 + 500)
    const second = gate()
    postGate = second.wait
    post.open()
    await tick()
    expect(st().outbox.c77?.map(o => [o.status, o.msg.created_at])).toEqual([['sending', T0 + 500]])
    expect(headers()).toEqual([true, false, true])
    second.open()
    await tick()
    expect(posted.map(p => p.device)).toEqual([T0, T0 + 500])
    expect(st().messages.c77?.map(m => m.created_at)).toEqual([T0 - 60, T0, T0 + 500])
    expect(headers()).toEqual([true, false, true])
  })
})

describe('the server clock', () => {
  test('a quick answer gives how far the server clock is ahead, from the middle of the request', () => {
    expect(clockSample(1_000_000, 1_000_400, 1600)).toBe(599_800)
    expect(clockSample(1_000_000, 1_000_000, 400)).toBe(-600_000)
    expect(clockSample(1_000_000, 1_010_000, 1000)).toBe(-5000)
  })

  test('an answer slower than ten seconds gives nothing', () => {
    expect(clockSample(1_000_000, 1_010_001, 1600)).toBeNull()
    expect(clockSample(1_000_000, 999_999, 1600)).toBeNull()
  })

  test('a device clock behind the server sends by the server time learned from a send', async () => {
    serverAhead = 600
    setup(T0 + 540)
    at(T0)
    st().sendMessage('one')
    await tick()
    expect(st().messages.c77?.map(m => m.created_at)).toEqual([T0 + 540, T0 + 600])

    at(T0 + 10)
    const post = gate()
    postGate = post.wait
    st().sendMessage('two')
    expect(st().outbox.c77?.[0]?.msg.created_at).toBe(T0 + 610)
    expect(headers()).toEqual([true, false, false])
    post.open()
    await tick()
    expect(st().messages.c77?.map(m => m.created_at)).toEqual([T0 + 540, T0 + 600, T0 + 610])
    expect(headers()).toEqual([true, false, false])
  })

  test('a device clock ahead of the server sends by the server time too', async () => {
    serverAhead = -600
    setup(T0 - 660)
    at(T0)
    st().sendMessage('one')
    await tick()
    at(T0 + 10)
    const post = gate()
    postGate = post.wait
    st().sendMessage('two')
    st().sendMessage('three')
    expect(st().outbox.c77?.map(o => [o.status, o.msg.created_at])).toEqual([
      ['sending', T0 - 590],
      ['queued', T0 - 590],
    ])
    expect(headers()).toEqual([true, false, false, false])
    postGate = null
    post.open()
    await tick()
    expect(st().messages.c77?.map(m => m.created_at)).toEqual([
      T0 - 660,
      T0 - 600,
      T0 - 590,
      T0 - 590,
    ])
    expect(headers()).toEqual([true, false, false, false])
  })

  test('an answer that took longer than ten seconds teaches no clock', async () => {
    serverAhead = 600
    setup(T0)
    at(T0)
    const slow = gate()
    postGate = slow.wait
    st().sendMessage('one')
    await tick()
    at(T0 + 11)
    postGate = null
    slow.open()
    await tick()
    at(T0 + 20)
    const post = gate()
    postGate = post.wait
    st().sendMessage('two')
    expect(st().outbox.c77?.[0]?.msg.created_at).toBe(T0 + 20)
    post.open()
    await tick()
  })

  test('a new session forgets the clock', async () => {
    serverAhead = 600
    setup(T0)
    at(T0)
    st().sendMessage('one')
    await tick()
    resetSessionCaches()
    setup(T0)
    const post = gate()
    postGate = post.wait
    st().sendMessage('two')
    expect(st().outbox.c77?.[0]?.msg.created_at).toBe(T0)
    post.open()
    await tick()
  })
})
