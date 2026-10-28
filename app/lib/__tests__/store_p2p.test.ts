import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { home } from '../instances'
import { useStore } from '../store'
import { p2p } from '../p2p'
import type { MessageMedia, VoiceMsg, WsEvent } from '../types'
import { me, memoryStorage, msg, serverDetail, user } from './fixtures'

const st = () => useStore.getState()
const dispatch = (ev: WsEvent) => st().applyWsEvent(ev)
const realFetch = globalThis.fetch
const realWindow = (globalThis as { window?: unknown }).window
const realRemove = p2p.removeFile.bind(p2p)
let removed: string[] = []
const tick = async () => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve()
  await new Promise(r => setTimeout(r, 0))
}

const hosted = (id: string, hoster: string): MessageMedia => ({
  id,
  filename: 'a.txt',
  kind: 'p2p',
  hoster,
  expires_at: null,
  size: 1,
  mime: 'text/plain',
  removed: false,
  removed_by_author: false,
  spoiler: false,
})

const scoped = { server: 's', channel_id: 1, dm_id: null, dm_users: null }

beforeEach(() => {
  Object.assign(globalThis, { localStorage: memoryStorage })
  ;(globalThis as { window?: unknown }).window = {
    location: { pathname: '/', href: 'http://x/', origin: 'http://x', protocol: 'http:' },
    history: { state: null, pushState: () => {}, replaceState: () => {} },
  }
  removed = []
  p2p.removeFile = (id: string) => {
    removed.push(id)
  }
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ ok: true }), { status: 200 })) as unknown as typeof fetch
  useStore.setState({
    me: me('bob'),
    token: 't',
    guest: false,
    error: null,
    view: { kind: 'channel', server: 's', channelId: 1 },
    servers: { s: serverDetail('s') },
    messages: {
      c1: [
        msg(10, { author: user('bob'), media: hosted('f10', 'bob') }),
        msg(11, { author: user('bob'), media: hosted('f11', 'bob') }),
        msg(12, { author: user('alice'), media: hosted('f12', 'alice') }),
        msg(13, { author: user('bob'), media: hosted('f13', 'bob') }),
      ],
    },
    outbox: {},
    panel: null,
  })
})

afterEach(() => {
  globalThis.fetch = realFetch
  ;(globalThis as { window?: unknown }).window = realWindow
  p2p.removeFile = realRemove
})

describe('hosted P2P files follow their message', () => {
  test('deleting your own message stops hosting its file', async () => {
    await st().deleteMessage(10)
    await tick()
    expect(removed).toEqual(['f10'])
    expect(st().messages.c1.map(m => m.id)).toEqual([11, 12, 13])
  })

  test('a deletion from elsewhere stops hosting, but only your own files', () => {
    dispatch({ type: 'message_deleted', id: 11, thread_root_id: null, ...scoped })
    dispatch({ type: 'message_deleted', id: 12, thread_root_id: null, ...scoped })
    expect(removed).toEqual(['f11'])
  })

  test('a removed attachment stops being hosted', () => {
    dispatch({
      type: 'media_removed',
      message_id: 13,
      filename: 'a.txt',
      removed_by_author: false,
      ...scoped,
    })
    expect(removed).toEqual(['f13'])
  })
})

describe('P2P call dialing', () => {
  const ws = home.ws as unknown as { sendVoice: (m: VoiceMsg) => boolean }
  const realSend = ws.sendVoice
  const realDial = p2p.dial.bind(p2p)
  let sent: VoiceMsg[] = []
  let dialed: string[] = []
  beforeEach(() => {
    sent = []
    dialed = []
    ws.sendVoice = m => {
      sent.push(m)
      return true
    }
    p2p.dial = (peer: string) => {
      dialed.push(peer)
    }
  })
  afterEach(() => {
    ws.sendVoice = realSend
    p2p.dial = realDial
  })

  test("the caller asks which of the callee's tabs took the call, never dialing a cached peer", () => {
    useStore.setState({
      call: null,
      p2pAvailability: { alice: { peer_id: 'newest-tab', ids: [], online: true } },
    })
    dispatch({
      type: 'call_state',
      dm_id: 5,
      dm_users: ['alice', 'bob'],
      state: 'active',
      from: 'bob',
      kind: 'p2p',
    })
    expect(dialed).toEqual([])
    expect(sent).toEqual([{ type: 'p2p_who', hosters: ['alice'] }])
    dispatch({
      type: 'p2p_availability',
      hoster: 'alice',
      peer_id: 'call-tab',
      ids: [],
      online: true,
    })
    expect(dialed).toEqual(['call-tab'])
  })
})
