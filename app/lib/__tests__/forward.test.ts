import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { useStore, resetSessionCaches } from '../store'
import {
  canForward,
  forwardOrigin,
  clipOf,
  forwardKey,
  forwardPending,
  forwardValue,
  parseForward,
} from '../forward'
import { me, media, memoryStorage, msg, user } from './fixtures'

afterAll(resetSessionCaches)

const st = () => useStore.getState()
const storage = new Map<string, string>()

beforeEach(() => {
  storage.clear()
  Object.assign(globalThis, {
    localStorage: {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => void storage.set(k, v),
      removeItem: (k: string) => void storage.delete(k),
    },
  })
  useStore.setState({ me: me('alice'), guest: false, forwardClip: null, toast: null })
})

afterEach(() => {
  Object.assign(globalThis, { localStorage: memoryStorage })
})

describe('forward clipboard', () => {
  test('clipOf keeps the original author and time of a forwarded copy', () => {
    const plain = clipOf(msg(5, { content: '**Lunch** at noon\nmore', author: user('bob') }))
    expect(plain).toEqual({
      id: 5,
      author: user('bob'),
      snippet: 'Lunch at noon',
      has_media: false,
      created_at: 5,
    })
    const copy = msg(9, {
      author: user('carol'),
      media: media(),
      forward: { author: user('bob'), created_at: 3, source_id: 5, origin: null, dropped: null },
    })
    const fwd = clipOf(copy)
    expect([fwd.id, fwd.author, fwd.created_at, fwd.has_media]).toEqual([9, user('bob'), 3, true])
    expect(clipOf(msg(1, { media: media({ removed: true }) })).has_media).toBe(false)
  })

  test('a forward of a deleted author stays anonymous, never the forwarder', () => {
    const copy = msg(9, {
      author: user('carol'),
      forward: { author: null, created_at: 3, source_id: 5, origin: null, dropped: null },
    })
    const clip = clipOf(copy)
    expect([clip.author, clip.created_at]).toEqual([null, 3])
    expect(parseForward(forwardValue(clip))).toEqual(clip)
    expect(parseForward(JSON.stringify({ v: 1, clip: { ...clip, author: 'bob' } }))).toBeNull()
  })

  test('only sent user messages can be forwarded', () => {
    expect(canForward(msg(1))).toBe(true)
    expect(canForward(msg(1, { kind: 'call' }))).toBe(false)
    expect(canForward(msg(-1))).toBe(false)
  })

  test('the stored value round-trips and bad data reads as empty', () => {
    const clip = clipOf(msg(7))
    expect(parseForward(forwardValue(clip))).toEqual(clip)
    expect(forwardValue(null)).toBeNull()
    for (const raw of [
      null,
      '',
      '{oops',
      '[]',
      JSON.stringify({ v: 2, clip }),
      JSON.stringify({ v: 1, clip: { ...clip, id: 'x' } }),
      JSON.stringify({ v: 1, clip: { ...clip, id: -3 } }),
      JSON.stringify({ v: 1, clip: { ...clip, author: { username: 'a' } } }),
      JSON.stringify({ v: 1, clip: { ...clip, has_media: 'yes' } }),
    ])
      expect(parseForward(raw)).toBeNull()
    const long = parseForward(JSON.stringify({ v: 1, clip: { ...clip, snippet: 'x'.repeat(500) } }))
    expect(long?.snippet.length).toBe(200)
  })

  test('forwardPending sees a queued or failed forward of the same clip', () => {
    const out = (source_id: number) => ({
      msg: msg(-1, {
        forward: { author: user('bob'), created_at: 1, source_id, origin: null, dropped: null },
      }),
    })
    expect(forwardPending(undefined, 4)).toBe(false)
    expect(forwardPending([{ msg: msg(-2) }, out(3)], 4)).toBe(false)
    expect(forwardPending([out(4)], 4)).toBe(true)
  })
})

describe('forward clipboard in the store', () => {
  test('copying replaces the single item, persists per account and toasts', () => {
    st().copyForward(msg(3, { author: user('bob') }))
    st().copyForward(msg(4, { author: user('carol'), content: 'second' }))
    expect(st().forwardClip?.id).toBe(4)
    expect(st().toast?.text).toBe('Message copied for forwarding')
    const saved = parseForward(storage.get(forwardKey('alice')) ?? null)
    expect(saved?.id).toBe(4)
    expect(saved?.snippet).toBe('second')
    expect([...storage.keys()]).toEqual([forwardKey('alice')])
  })

  test('discarding clears storage; reload picks up another tab', () => {
    st().copyForward(msg(3))
    st().clearForward()
    expect(st().forwardClip).toBeNull()
    expect(storage.has(forwardKey('alice'))).toBe(false)
    storage.set(forwardKey('alice'), forwardValue(clipOf(msg(8))) ?? '')
    st().reloadForward()
    expect(st().forwardClip?.id).toBe(8)
    storage.set(forwardKey('alice'), '{oops')
    st().reloadForward()
    expect(st().forwardClip).toBeNull()
  })

  test('another account has its own clipboard; guests cannot copy', () => {
    st().copyForward(msg(3))
    useStore.setState({ me: me('bob'), forwardClip: null })
    st().reloadForward()
    expect(st().forwardClip).toBeNull()
    useStore.setState({ me: null, guest: true })
    st().copyForward(msg(5))
    expect(st().forwardClip).toBeNull()
    expect(parseForward(storage.get(forwardKey('alice')) ?? null)?.id).toBe(3)
    expect(storage.has(forwardKey('bob'))).toBe(false)
  })

  test('call logs are never copied', () => {
    st().copyForward(msg(3, { kind: 'call' }))
    expect(st().forwardClip).toBeNull()
    expect(storage.size).toBe(0)
  })
})

describe('forwardOrigin', () => {
  const base = { origin: null, origin_dm: false, origin_channel: null, origin_server: null }
  test('builds the label from the structured fields', () => {
    expect(forwardOrigin({ ...base, origin_dm: true })).toEqual({
      label: 'Direct message',
      isServer: false,
    })
    expect(forwardOrigin({ ...base, origin_channel: 'general', origin_server: 'Pub' })).toEqual({
      label: '#general · Pub',
      isServer: true,
    })
    expect(forwardOrigin({ ...base, origin_server: 'Pub' })).toEqual({
      label: 'Pub',
      isServer: true,
    })
  })
  test('falls back to origin, or nothing', () => {
    expect(forwardOrigin({ origin: '#a - B' })).toEqual({ label: '#a - B', isServer: true })
    expect(forwardOrigin({ origin: 'Direct message' })).toEqual({
      label: 'Direct message',
      isServer: false,
    })
    expect(forwardOrigin(base)).toBeNull()
  })
})
