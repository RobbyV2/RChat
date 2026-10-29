import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { home } from '../instances'
import { useStore, resetSessionCaches } from '../store'
import type { TypingMsg } from '../typing'
import type { WsEvent } from '../types'
import { me, memoryStorage, msg, user } from './fixtures'

afterAll(resetSessionCaches)

const st = () => useStore.getState()
const dispatch = (ev: WsEvent) => st().applyWsEvent(ev)
const storage = new Map<string, string>()
const ws = home.ws as unknown as { sendTyping: (m: TypingMsg) => void }
const realSend = ws.sendTyping
let sent: TypingMsg[] = []

const typing = (username: string, scope: string, until: number): WsEvent => ({
  type: 'typing',
  server: 'club',
  channel_id: 1,
  dm_id: null,
  dm_users: null,
  scope,
  username,
  display_name: username.toUpperCase(),
  until,
})

beforeEach(() => {
  storage.clear()
  sent = []
  ws.sendTyping = m => void sent.push(m)
  Object.assign(globalThis, {
    localStorage: {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => void storage.set(k, v),
      removeItem: (k: string) => void storage.delete(k),
    },
  })
  useStore.setState({ me: me('alice'), guest: false, typingOn: true, typing: {} })
})

afterEach(() => {
  ws.sendTyping = realSend
  Object.assign(globalThis, { localStorage: memoryStorage })
  useStore.getState().noteTyping('c1', false)
  useStore.setState({ me: null, typingOn: true, typing: {} })
})

describe('typing in the store', () => {
  test('shows others, never yourself, and clears on stop or their message', () => {
    dispatch(typing('bob', 'c1', 99))
    dispatch(typing('alice', 'c1', 99))
    dispatch(typing('carol', 'c1', 99))
    expect(Object.keys(st().typing.c1)).toEqual(['bob', 'carol'])
    expect(st().typing.c1.bob.name).toBe('BOB')
    dispatch(typing('bob', 'c1', 0))
    expect(Object.keys(st().typing.c1)).toEqual(['carol'])
    dispatch({
      type: 'message',
      server: 'club',
      channel_id: 1,
      dm_id: null,
      dm_users: null,
      message: msg(5, { channel_id: 1, dm_id: null, author: user('carol') }),
    })
    expect(st().typing.c1).toBeUndefined()
  })

  test('off sends nothing, shows nothing, and is saved per account', () => {
    st().noteTyping('c1', true)
    expect(sent).toEqual([{ type: 'typing', scope: 'c1' }])
    dispatch(typing('bob', 'c1', 99))
    st().setTypingOn(false)
    expect(sent.at(-1)).toEqual({ type: 'typing_stop', scope: 'c1' })
    expect(st().typing).toEqual({})
    expect(storage.get('rchat_typing:alice')).toBe('{"v":1,"on":false}')
    sent = []
    st().noteTyping('c1', true)
    dispatch(typing('bob', 'c1', 99))
    expect([sent, st().typing]).toEqual([[], {}])
    storage.set('rchat_typing:alice', '{"v":1,"on":true}')
    st().reloadTyping()
    expect(st().typingOn).toBe(true)
  })

  test('logout forgets the outgoing state', () => {
    const g = globalThis as { window?: unknown; document?: unknown }
    const [win, doc] = [g.window, g.document]
    g.window = {
      location: { pathname: '/', href: 'http://x/', origin: 'http://x', protocol: 'http:' },
      history: { state: null, pushState: () => {}, replaceState: () => {} },
    }
    g.document = { cookie: '' }
    st().noteTyping('c1', true)
    sent = []
    st().logout()
    g.window = win
    g.document = doc
    useStore.setState({ me: me('alice'), guest: false, typingOn: true })
    st().noteTyping('c1', true)
    expect(sent).toEqual([{ type: 'typing', scope: 'c1' }])
  })

  test('guests never send', () => {
    useStore.setState({ me: null, guest: true })
    st().noteTyping('c1', true)
    expect(sent).toEqual([])
  })

  test('an imported config sets it', async () => {
    expect(await st().applyConfig({ v: 1, typing: false }, ['typing'])).toBeNull()
    expect(st().typingOn).toBe(false)
    expect(storage.get('rchat_typing:alice')).toBe('{"v":1,"on":false}')
  })
})
