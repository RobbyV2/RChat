import { flush } from './helpers/test_clock'
import {
  channelTarget,
  canView,
  markPersonally,
  personallyMarked,
  requestViewing,
  leaveVisit,
  endViewing,
  forgetViewing,
  useViewing,
} from '../viewing'
import { afterEach, expect, test } from 'bun:test'
import { parseForward, forwardKey } from '../forward'
import { getHomeSession, resetSessionCaches, useStore } from '../store'
import { me, serverDetail, textChannel, msg, user, memoryStorage } from './fixtures'

const { files: p2p } = getHomeSession()

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
  resetSessionCaches()
  memoryStorage.clear()
})

test('opening a sensitive channel asks before reading history or displaying a cached message', async () => {
  const calls: string[] = []
  globalThis.fetch = (async u => {
    calls.push(String(u))
    return Response.json([])
  }) as typeof fetch
  const ordinary = { id: 1, kind: 'text' as const, name: 'general', slowmode_seconds: 0 }
  const privateRoom = { ...ordinary, id: 2, sensitive: true }
  useStore.setState({
    me: me('alice'),
    servers: { club: serverDetail('club', { channels: [ordinary, privateRoom] }) },
    view: { kind: 'channel', server: 'club', channelId: 1 },
  })
  const opening = useStore.getState().openChannel('club', 2, 'none')
  await Promise.resolve()
  expect(calls.filter(url => url.includes('/messages'))).toEqual([])
  expect(useStore.getState().view).toEqual({ kind: 'channel', server: 'club', channelId: 1 })
  useViewing.getState().prompt?.answer(false, false)
  await opening
  expect(calls).toEqual([])
})

test('local marks and remembered choices are isolated by account, server, transport and guest profile', async () => {
  const ch = { id: 3, name: 'room', sensitive: false }
  const t = channelTarget('reader', 'instance', 'garden', ch)
  const others = [
    channelTarget('writer', 'instance', 'garden', ch),
    channelTarget('reader', 'instance', 'club', ch),
    channelTarget('reader', 'p2p', 'garden', ch),
    channelTarget(null, 'instance', 'garden', ch),
  ]
  markPersonally(t, true)
  expect(canView(t)).toBe(false)
  expect(others.every(o => !personallyMarked(o))).toBe(true)
  const once = requestViewing(t)
  useViewing.getState().prompt!.answer(true, false)
  expect(await once).toBe(true)
  leaveVisit()
  expect(canView(t)).toBe(false)
  const always = requestViewing(t)
  useViewing.getState().prompt!.answer(true, true)
  await always
  endViewing()
  expect(canView({ ...t, name: 'changed' })).toBe(true)
  expect(others.every(o => !canView({ ...o, sensitive: true }))).toBe(true)
  forgetViewing(t)
  expect(canView(t)).toBe(false)
})

test('cancel, open, and re-hide work in a tab with blocked storage', async () => {
  const storage = globalThis.localStorage
  Object.assign(globalThis, {
    localStorage: {
      getItem() {
        throw Error('denied')
      },
      setItem() {
        throw Error('denied')
      },
      removeItem() {
        throw Error('denied')
      },
    },
  })
  try {
    const target = channelTarget('reader', 'instance', 'garden', {
      id: 5,
      name: 'voice',
      sensitive: true,
    })
    const cancelled = requestViewing(target)
    useViewing.getState().prompt!.answer(false, false)
    expect(await cancelled).toBe(false)
    const opening = requestViewing(target)
    useViewing.getState().prompt!.answer(true, true)
    expect(await opening).toBe(true)
    leaveVisit()
    expect(canView(target)).toBe(true)
    forgetViewing(target)
    expect(canView(target)).toBe(false)
  } finally {
    Object.assign(globalThis, { localStorage: storage })
  }
})

test('a live label rejects delayed history and suppresses subsequent messages and notifications', async () => {
  const ch = textChannel(4),
    other = textChannel(8)
  const data = {
    me: me('alice'),
    servers: { garden: serverDetail('garden', { channels: [ch, other] }) },
    view: { kind: 'channel' as const, server: 'garden', channelId: 8 },
  }
  const w = globalThis.window
  Object.assign(globalThis, {
    window: {
      location: { pathname: '/', href: 'http://x/', origin: 'http://x' },
      history: { pushState() {}, replaceState() {} },
    },
  })
  try {
    useStore.setState(data)
    let reply!: (r: Response) => void
    const calls: string[] = []
    globalThis.fetch = (async (u: RequestInfo | URL) => {
      calls.push(String(u))
      return new Promise<Response>(r => {
        reply = r
      })
    }) as typeof fetch
    const pending = useStore.getState().openChannel('garden', 4, 'none')
    expect(calls.some(u => u.includes('/channels/4/messages'))).toBe(true)
    useStore.getState().applyWsEvent({
      type: 'channel_updated',
      server: 'garden',
      channel: { ...ch, sensitive: true },
    })
    expect(useStore.getState().view).toBeNull()
    const secret = msg(102, { channel_id: 4, content: 'withheld', author: user('bob') })
    reply(Response.json([secret]))
    await pending
    useStore.getState().applyWsEvent({
      type: 'message',
      server: 'garden',
      channel_id: 4,
      dm_id: null,
      dm_users: null,
      message: secret,
    })
    expect(useStore.getState().messages.c4 ?? []).toEqual([])
    expect(useStore.getState().notices).toEqual([])
  } finally {
    Object.assign(globalThis, { window: w })
  }
})

test('a disconnected channel rail refreshes metadata before admission', async () => {
  const channels = [textChannel(1), textChannel(2)]
  const club = serverDetail('club', { channels })
  useStore.setState({ me: me('reader'), servers: { club }, channelLabelEpoch: 1, wsStatus: 'red' })
  const calls: string[] = []
  globalThis.fetch = (async u => {
    calls.push(String(u))
    return Response.json({ ...club, channels: [channels[0], { ...channels[1], sensitive: true }] })
  }) as typeof fetch
  const opened = useStore.getState().openChannel('club', 2)
  await flush()
  expect(useViewing.getState().prompt?.target.name).toBe(channels[1].name)
  useViewing.getState().prompt!.answer(false, false)
  await opened
  expect(calls.filter(p => p.includes('/servers/club'))).toHaveLength(1)
  expect(calls.some(p => p.includes('/messages'))).toBe(false)
})

test('a hidden forward source clears its saved clip and accepts file cleanup', () => {
  const channel = textChannel(2)
  useStore.setState({
    me: me('reader'),
    servers: { club: serverDetail('club', { channels: [channel] }) },
  })
  useStore.getState().copyForward(msg(12, { channel_id: 2, content: 'seashell' }))
  const key = forwardKey('reader')
  expect(parseForward(memoryStorage.getItem(key))?.source).toEqual({
    kind: 'channel',
    server: 'club',
    id: 2,
  })
  markPersonally(channelTarget('reader', 'instance', 'club', channel), true)
  expect(useStore.getState().forwardClip).toBeNull()
  expect(memoryStorage.getItem(key)).toBeNull()
  const forgotten: number[] = []
  const previous = p2p.forgetMessage
  p2p.forgetMessage = id => {
    forgotten.push(id)
  }
  const room = { server: 'club', channel_id: 2, dm_id: null, dm_users: [], thread_root_id: null }
  try {
    for (const ev of [
      { ...room, type: 'media_removed' as const, message_id: 10, removed_by_author: true },
      { ...room, type: 'message_deleted' as const, id: 11 },
      { ...room, type: 'messages_deleted' as const, ids: [12, 13] },
    ])
      useStore.getState().applyWsEvent(ev)
    expect(forgotten).toEqual([10, 11, 12, 13])
    expect(useStore.getState().messages.c2).toBeUndefined()
  } finally {
    p2p.forgetMessage = previous
  }
  const legacy = {
    v: 1,
    clip: {
      id: 11,
      author: null,
      snippet: 'staged',
      body: 'staged',
      created_at: 10,
      has_media: false,
    },
  }
  expect(parseForward(JSON.stringify(legacy))).toBeNull()
})
