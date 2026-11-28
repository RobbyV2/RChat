import { flush } from './helpers/test_clock'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { useStore, resetSessionCaches } from '../store'
import type { RChatState } from '../store_types'
import type { Message, WsEvent } from '../types'
import { me, memoryStorage, msg, serverDetail, user } from './fixtures'
import { Secret } from '../secret'

const st = () => useStore.getState()
const dispatch = (ev: WsEvent) => st().applyWsEvent(ev)
const realFetch = globalThis.fetch
const realWindow = (globalThis as { window?: unknown }).window
const tick = async () => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve()
  await flush()
  for (let i = 0; i < 10; i += 1) await Promise.resolve()
}

let open = () => {}
let refuse = false

const sent = (id: number, over: Partial<Message> = {}) =>
  msg(id, { channel_id: 77, author: user('bob'), content: 'hi', created_at: 1000 + id, ...over })
const live = (m: Message): WsEvent => ({
  type: 'message',
  server: 's',
  channel_id: m.channel_id,
  dm_id: null,
  dm_users: null,
  message: m,
})

const setup = () =>
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
    messages: { c77: [sent(9)] },
    outbox: {},
    pending: {},
    slowUntil: {},
    panel: null,
  })

// Every state the store passes through, as which ids the list shows and which sends wait.
let states: { list: number[]; outbox: string[] }[] = []
let stop = () => {}
const record = (key: string) => {
  states = []
  stop = useStore.subscribe((s: RChatState) => {
    states.push({
      list: (s.messages[key] ?? []).map(m => m.id),
      outbox: (s.outbox[key] ?? []).map(o => o.msg.content),
    })
  })
}
const both = (id: number, content: string) =>
  states.filter(s => s.list.includes(id) && s.outbox.includes(content))

beforeEach(() => {
  memoryStorage.clear()
  Object.assign(globalThis, { localStorage: memoryStorage })
  ;(globalThis as { window?: unknown }).window = {
    location: { pathname: '/', href: 'http://x/', origin: 'http://x', protocol: 'http:' },
    history: { state: null, pushState: () => {}, replaceState: () => {} },
  }
  resetSessionCaches()
  refuse = false
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input).replace(/^https?:\/\/[^/]+/, '')
    if (init?.method === 'POST' && /^\/api\/(channels\/77|messages\/9)/.test(url)) {
      const { content } = JSON.parse(String(init.body)) as { content: string }
      await new Promise<void>(r => {
        open = r
      })
      if (refuse) return new Response(JSON.stringify({ error: 'Try again' }), { status: 500 })
      const thread = url.startsWith('/api/messages/9/')
      const m = sent(50, thread ? { channel_id: 77, thread_root_id: 9, content } : { content })
      return new Response(JSON.stringify(m), { status: 200 })
    }
    return new Response(JSON.stringify([]), { status: 200 })
  }) as typeof fetch
})

afterEach(() => {
  stop()
  globalThis.fetch = realFetch
  ;(globalThis as { window?: unknown }).window = realWindow
})

describe('a send the server confirms', () => {
  test('its echo waits for the answer, so no state shows it twice', async () => {
    setup()
    st().sendMessage('hi')
    await tick()
    record('c77')
    dispatch(live(sent(50)))
    expect(st().messages.c77?.map(m => m.id)).toEqual([9])
    expect(st().outbox.c77?.map(o => o.status)).toEqual(['sending'])
    open()
    await tick()
    expect(both(50, 'hi')).toEqual([])
    expect(states.some(s => s.list.includes(50) && s.outbox.length === 0)).toBe(true)
    expect(st().messages.c77?.map(m => m.id)).toEqual([9, 50])
    expect(st().outbox.c77).toBeUndefined()
  })

  test('the answer before its echo swaps the send in one step too', async () => {
    setup()
    st().sendMessage('hi')
    await tick()
    record('c77')
    open()
    await tick()
    dispatch(live(sent(50)))
    expect(both(50, 'hi')).toEqual([])
    expect(st().messages.c77?.map(m => m.id)).toEqual([9, 50])
  })

  test("someone else's message shows at once while a send waits", async () => {
    setup()
    st().sendMessage('hi')
    await tick()
    dispatch(live(sent(49, { author: user('alice'), content: 'yo' })))
    expect(st().messages.c77?.map(m => m.id)).toEqual([9, 49])
    open()
    await tick()
    expect(st().messages.c77?.map(m => m.id)).toEqual([9, 49, 50])
  })

  test('my message from another device shows once the send is answered', async () => {
    setup()
    st().sendMessage('hi')
    await tick()
    dispatch(live(sent(49, { content: 'from my phone' })))
    dispatch(live(sent(50)))
    expect(st().messages.c77?.map(m => m.id)).toEqual([9])
    open()
    await tick()
    expect(st().messages.c77?.map(m => m.id)).toEqual([9, 49, 50])
    dispatch(live(sent(51, { content: 'later' })))
    expect(st().messages.c77?.map(m => m.id)).toEqual([9, 49, 50, 51])
  })

  test('a message deleted or edited before the answer shows that way', async () => {
    setup()
    st().sendMessage('hi')
    await tick()
    dispatch(live(sent(48, { content: 'gone soon' })))
    dispatch(live(sent(49, { content: 'typo' })))
    dispatch({
      type: 'message_deleted',
      id: 48,
      thread_root_id: null,
      server: 's',
      channel_id: 77,
      dm_id: null,
      dm_users: null,
    })
    dispatch({ type: 'message_updated', message: sent(49, { content: 'fixed', edited_at: 1100 }) })
    open()
    await tick()
    expect(st().messages.c77?.map(m => [m.id, m.content])).toEqual([
      [9, 'hi'],
      [49, 'fixed'],
      [50, 'hi'],
    ])
  })

  test('a send that fails lets the messages it held back show', async () => {
    setup()
    st().sendMessage('hi')
    await tick()
    refuse = true
    dispatch(live(sent(49, { content: 'from my phone' })))
    open()
    await tick()
    expect(st().outbox.c77?.map(o => o.status)).toEqual(['failed'])
    expect(st().messages.c77?.map(m => m.id)).toEqual([9, 49])
  })

  for (const key of ['c77', 't9']) {
    test(`a text-only destination rejects new and pending files in ${key}`, async () => {
      setup()
      const file = new File(['a'], 'note.txt')
      useStore.setState({
        servers: {
          s: serverDetail('s', {
            channels: [
              { id: 77, name: 'general', kind: 'text', slowmode_seconds: 0, text_only: true },
            ],
          }),
        },
        panel: { kind: 'thread', root: sent(9) },
      })
      st().uploadFile(key, file)
      expect(st().pending[key]).toBeUndefined()
      useStore.setState({
        pending: { [key]: { file, spoiler: false, mode: 'server', scope: 'c77' } },
      })
      if (key === 'c77') st().sendMessage('https://example.org')
      else st().sendThreadMessage('https://example.org')
      await tick()
      expect(st().outbox[key]?.[0]?.msg.no_previews).toBe(true)
      expect(st().outbox[key]?.[0]?.pending).toBeNull()
      open()
      await tick()
    })
  }

  test('a thread reply swaps in one step', async () => {
    setup()
    useStore.setState({
      panel: { kind: 'thread', root: sent(9) },
      messages: { c77: [sent(9)], t9: [] },
    })
    st().sendThreadMessage('in thread')
    await tick()
    record('t9')
    dispatch(live(sent(50, { thread_root_id: 9, content: 'in thread' })))
    expect(st().messages.t9?.map(m => m.id)).toEqual([])
    open()
    await tick()
    expect(both(50, 'in thread')).toEqual([])
    expect(st().messages.t9?.map(m => m.id)).toEqual([50])
    expect(st().outbox.t9).toBeUndefined()
  })
})
