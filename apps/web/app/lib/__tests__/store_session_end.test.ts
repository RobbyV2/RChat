import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test'
import { useStore, resetSessionCaches } from '../store'
import { me, memoryStorage, msg, serverDetail, user } from './fixtures'

afterAll(resetSessionCaches)

const st = () => useStore.getState()
const realFetch = globalThis.fetch
const realWindow = (globalThis as { window?: unknown }).window
const tick = async () => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve()
  await new Promise(r => setTimeout(r, 0))
  for (let i = 0; i < 10; i += 1) await Promise.resolve()
}

let sent: string[] = []
let reacts: string[] = []
let uploads = 0
let gate: Promise<void> | null = null
let refuse = false

const signedIn = (name: string) =>
  useStore.setState({
    me: me(name, { servers: [{ name: 's', display_name: 's', creator: null, is_admin: false }] }),
    token: `t-${name}`,
    guest: false,
    error: null,
    toast: null,
    view: { kind: 'channel', server: 's', channelId: 77 },
    servers: {
      s: serverDetail('s', {
        channels: [{ id: 77, name: 'general', kind: 'text', slowmode_seconds: 0 }],
      }),
    },
    messages: { c77: [msg(9, { channel_id: 77 })] },
    outbox: {},
    panel: null,
  })

beforeEach(() => {
  memoryStorage.clear()
  Object.assign(globalThis, { localStorage: memoryStorage })
  ;(globalThis as { window?: unknown }).window = {
    location: { pathname: '/', href: 'http://x/', origin: 'http://x', protocol: 'http:' },
    history: { state: null, pushState: () => {}, replaceState: () => {} },
  }
  sent = []
  reacts = []
  uploads = 0
  gate = null
  refuse = false
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input).replace(/^https?:\/\/[^/]+/, '')
    if (init?.method === 'POST' && url === '/api/channels/77/messages') {
      const { content } = JSON.parse(String(init.body)) as { content: string }
      sent.push(content)
      const id = 50 + sent.length
      const wait = gate
      if (wait) await wait
      if (refuse) return new Response(JSON.stringify({ error: 'Not allowed' }), { status: 403 })
      return new Response(
        JSON.stringify(msg(id, { channel_id: 77, author: user(content), content })),
        { status: 200 }
      )
    }
    if (init?.method === 'POST' && url === '/api/media') {
      uploads += 1
      const wait = gate
      if (wait) await wait
      return new Response(JSON.stringify({ id: `m${uploads}` }), { status: 200 })
    }
    if (url.startsWith('/api/messages/9/reactions/')) {
      reacts.push(`${init?.method} ${decodeURIComponent(url.slice(26))}`)
      const wait = gate
      if (wait) await wait
      if (refuse) return new Response(JSON.stringify({ error: 'Not allowed' }), { status: 403 })
      return new Response(JSON.stringify({}), { status: 200 })
    }
    return new Response(JSON.stringify([]), { status: 200 })
  }) as typeof fetch
})

afterEach(() => {
  globalThis.fetch = realFetch
  ;(globalThis as { window?: unknown }).window = realWindow
})

test('a send that answers after the session ended lands nowhere and holds up no later send', async () => {
  signedIn('alice')
  let open = () => {}
  gate = new Promise<void>(r => {
    open = r
  })
  st().sendMessage('alice')
  await tick()
  expect(sent).toEqual(['alice'])
  resetSessionCaches()
  signedIn('bob')
  gate = null
  st().sendMessage('bob')
  await tick()
  expect(sent).toEqual(['alice', 'bob'])
  expect(st().messages.c77.map(m => m.id)).toEqual([9, 52])
  open()
  await tick()
  await tick()
  expect(st().messages.c77.map(m => m.id)).toEqual([9, 52])
  expect(st().outbox).toEqual({})
  expect(st().error).toBeNull()
})

test('a send that fails after the session ended says nothing to the next one', async () => {
  signedIn('alice')
  let open = () => {}
  gate = new Promise<void>(r => {
    open = r
  })
  st().sendMessage('alice')
  await tick()
  resetSessionCaches()
  signedIn('bob')
  refuse = true
  open()
  await tick()
  await tick()
  expect(st().error).toBeNull()
  expect(st().toast).toBeNull()
  expect(st().messages.c77.map(m => m.id)).toEqual([9])
})

test('an upload that answers after the session ended is never posted', async () => {
  signedIn('alice')
  let open = () => {}
  gate = new Promise<void>(r => {
    open = r
  })
  const file = new File(['x'], 'a.txt', { type: 'text/plain' })
  useStore.setState({ pending: { c77: { file, spoiler: false, mode: 'server', scope: 'c77' } } })
  st().sendMessage('alice')
  await tick()
  expect(uploads).toBe(1)
  resetSessionCaches()
  signedIn('bob')
  open()
  await tick()
  await tick()
  expect(sent).toEqual([])
  expect(st().messages.c77.map(m => m.id)).toEqual([9])
  expect(st().error).toBeNull()
})

test('reactions still queued when the session ends are never sent, nor a failure shown', async () => {
  signedIn('alice')
  let open = () => {}
  gate = new Promise<void>(r => {
    open = r
  })
  const m = st().messages.c77[0]
  st().toggleReaction(m, 'x', false)
  st().toggleReaction(m, 'x', false)
  await tick()
  expect(reacts).toEqual(['PUT x'])
  resetSessionCaches()
  signedIn('bob')
  refuse = true
  open()
  await tick()
  await tick()
  expect(reacts).toEqual(['PUT x'])
  expect(st().error).toBeNull()
})
