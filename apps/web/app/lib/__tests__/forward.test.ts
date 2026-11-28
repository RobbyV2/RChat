import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { useStore } from '../store'
import {
  canForward,
  clipOf,
  forwardKey,
  forwardPending,
  forwardSourceDefault,
  forwardValue,
  fwdSource,
  hostedSourceNames,
  instanceServer,
  p2pDestination,
  p2pForward,
  p2pSourceNames,
  parseForward,
  shownSource,
  type ForwardClip,
} from '../forward'
import { b64u } from '../p2p/canonical'
import { me, media, memoryStorage, msg, serverDetail, user } from './fixtures'

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
      source: { kind: 'channel', id: 1 },
      id: 5,
      author: user('bob'),
      snippet: 'Lunch at noon',
      has_media: false,
      created_at: 5,
      body: '**Lunch** at noon\nmore',
    })
    const copy = msg(9, {
      author: user('carol'),
      media: media(),
      forward: {
        author: user('bob'),
        created_at: 3,
        source_id: 5,
        origin: null,
        dropped: null,
        origin_channel: null,
        origin_channel_id: null,
        origin_server: null,
        origin_server_channel: null,
      },
    })
    const fwd = clipOf(copy)
    expect([fwd.id, fwd.author, fwd.created_at, fwd.has_media]).toEqual([9, user('bob'), 3, true])
    expect(clipOf(msg(1, { media: media({ removed: true }) })).has_media).toBe(false)
  })

  test('a forward of a deleted author stays anonymous, never the forwarder', () => {
    const copy = msg(9, {
      author: user('carol'),
      forward: {
        author: null,
        created_at: 3,
        source_id: 5,
        origin: null,
        dropped: null,
        origin_channel: null,
        origin_channel_id: null,
        origin_server: null,
        origin_server_channel: null,
      },
    })
    const clip = clipOf(copy)
    expect([clip.author, clip.created_at]).toEqual([null, 3])
    expect(parseForward(forwardValue(clip))).toEqual(clip)
    expect(parseForward(JSON.stringify({ v: 1, clip: { ...clip, author: 'bob' } }))).toBeNull()
  })

  test('a clip from a P2P conversation keeps its text and its mark', () => {
    const clip = { ...clipOf(msg(7, { content: 'hi' })), p2p: true }
    expect(parseForward(forwardValue(clip))).toEqual(clip)
    expect(parseForward(JSON.stringify({ v: 1, clip: { ...clip, p2p: 'yes' } }))).toBeNull()
    const long = parseForward(forwardValue({ ...clip, body: 'x'.repeat(5000) }))
    expect(long?.body?.length).toBe(4000)
  })

  test('a P2P clip keeps the event id of its original, and only a valid one', () => {
    const ev = b64u(new Uint8Array(32).fill(7))
    const clip: ForwardClip = { ...clipOf(msg(7, { content: 'hi' })), p2p: true, ev }
    expect(parseForward(forwardValue(clip))).toEqual(clip)
    const bad = parseForward(forwardValue({ ...clip, ev: 'nope' }))
    expect(bad === null || bad.ev === undefined).toBe(true)
    expect(bad?.id).toBe(7)
  })

  test('a P2P clip keeps when its original was sent, and its copy carries that time', () => {
    const clip: ForwardClip = { ...clipOf(msg(7, { content: 'hi' })), p2p: true, sent_ts: 7_123 }
    expect(parseForward(forwardValue(clip))).toEqual(clip)
    expect(parseForward(forwardValue({ ...clip, sent_ts: 1.5 }))?.sent_ts).toBeUndefined()
    expect(parseForward(forwardValue({ ...clip, sent_ts: -1 }))?.sent_ts).toBeUndefined()
    expect(p2pForward(clip, undefined).ts).toBe(7_123)
    expect(p2pForward({ ...clip, sent_ts: undefined }, undefined).ts).toBe(7_000)
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
        forward: {
          author: user('bob'),
          created_at: 1,
          source_id,
          origin: null,
          dropped: null,
          origin_channel: null,
          origin_channel_id: null,
          origin_server: null,
          origin_server_channel: null,
        },
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

describe('where a forward is from', () => {
  const site = { server_joining: 'everyone', public_reading: true, guests_enabled: false } as const
  const closed = { ...site, public_reading: false } as const
  const text = (id: number, name: string, over = {}) => ({
    category_id: null,
    my_perms: null,
    topic: null,
    id,
    name,
    kind: 'text' as const,
    slowmode_seconds: 0,
    ...over,
  })
  const s = {
    servers: {
      club: serverDetail('club', {
        display_name: 'Book Club',
        channels: [text(1, 'general'), text(2, 'staff', { restrict_view: true })],
      }),
      pub: serverDetail('pub', { display_name: 'Pub Hall', channels: [text(3, 'bar')] }),
      vault: serverDetail('vault', {
        display_name: 'Vault',
        has_password: true,
        channels: [text(4, 'lobby')],
      }),
      shut: serverDetail('shut', { display_name: 'Shut', public_read: false, channels: [] }),
    },
  }
  const hosted = (id: number): Pick<ForwardClip, 'source'> => ({
    source: { kind: 'channel', id },
  })
  const room = { kind: 'p2p', room: 'R', ch: 'c1' } as const
  const inClub = { kind: 'instance', server: 'club' } as const
  const inDm = { kind: 'instance', server: null } as const

  test('the default of "Show where it\'s from", or no choice', () => {
    const cases: [
      Pick<ForwardClip, 'source'>,
      Parameters<typeof forwardSourceDefault>[1],
      boolean | null,
    ][] = [
      [{ source: { kind: 'direct' } }, inClub, null],
      [
        { source: { kind: 'direct', identity: 'second' } },
        { kind: 'p2p', room: 'D', ch: null },
        null,
      ],
      [{ source: undefined }, inClub, null],
      [hosted(1), inClub, true],
      [hosted(2), inClub, true],
      [hosted(1), inDm, true],
      [hosted(3), inClub, true],
      [hosted(4), inClub, false],
      [hosted(4), { kind: 'p2p', room: 'D', ch: null }, false],
      [hosted(3), { kind: 'p2p', room: 'D', ch: null }, true],
      [{ source: { kind: 'channel', id: 99, server: 'gone' } }, inClub, false],
      [
        { source: { room: 'R', ch: 'c1', kind: 'p2p' } },
        { kind: 'p2p', room: 'R', ch: 'c2' },
        true,
      ],
      [{ source: room }, { kind: 'p2p', room: 'R', ch: null }, false],
      [{ source: room }, { kind: 'p2p', room: 'S', ch: 'c1' }, false],
      [{ source: room }, inClub, null],
    ]
    for (const [clip, to, want] of cases)
      expect([clip.source, to, forwardSourceDefault(clip, to, s, site)]).toEqual([
        clip.source,
        to,
        want,
      ])
    expect(forwardSourceDefault(hosted(3), inDm, s, closed)).toBe(false)
    expect(forwardSourceDefault({ source: { kind: 'channel', id: 9 } }, inDm, s, site)).toBe(false)
  })

  test('the names the sender sees, and the channel only when everyone sees it', () => {
    expect(hostedSourceNames({ server: 'Book Club', channel: 'general' })).toEqual({
      server: 'Book Club',
      channel: 'general',
      restricted: false,
    })
    expect(hostedSourceNames({ server: 'Book Club' })).toEqual({
      server: 'Book Club',
      channel: null,
      restricted: true,
    })
    expect(hostedSourceNames(null)).toBeNull()
    const ch = (id: string, everyoneSees: boolean) => ({ id, name: id, everyoneSees })
    const garden = { name: 'Garden', channels: [ch('open', true), ch('mods', false)] }
    const restricted = (id: string) => p2pSourceNames(garden, id)?.restricted
    expect(['open', 'mods', 'gone'].map(restricted)).toEqual([false, true, true])
    expect(p2pSourceNames(undefined, 'open')).toBeNull()
    expect(shownSource({ server: 'A', channel: 'b', restricted: true }, true)).toEqual({
      server: 'A',
      channel: null,
    })
    expect(shownSource({ server: 'A', channel: 'b', restricted: false }, true)).toEqual({
      server: 'A',
      channel: 'b',
    })
    expect(shownSource({ server: 'A', channel: 'b', restricted: false }, false)).toBeNull()
  })

  test('a P2P copy carries its event id, and its place as the sender shows it', () => {
    const names = { server: 'Garden', channel: 'beds', restricted: false }
    expect(fwdSource({ kind: 'direct' }, names, false)).toEqual({ dm: true })
    expect(fwdSource({ kind: 'direct', identity: 'x' }, null, true)).toEqual({ dm: true })
    expect(fwdSource(undefined, names, true)).toBeUndefined()
    expect(fwdSource(room, names, false)).toBeUndefined()
    expect(fwdSource(room, names, true)).toEqual({ rn: 'Garden', cn: 'beds' })
    expect(fwdSource(room, { ...names, restricted: true }, true)).toEqual({ rn: 'Garden' })
    expect(fwdSource(room, null, true)).toBeUndefined()
    expect(fwdSource({ kind: 'channel', id: 1 }, names, true)).toEqual({ rn: 'Garden', cn: 'beds' })
    expect(fwdSource({ kind: 'channel', id: 1 }, null, true)).toBeUndefined()
    const long = fwdSource(room, { ...names, server: 'g'.repeat(100) }, true)
    expect(long && 'rn' in long ? long.rn.length : 0).toBe(64)
    const clip: ForwardClip = {
      source: room,
      id: 3,
      author: user('bob', { display_name: 'Bob' }),
      snippet: 'hi',
      has_media: false,
      created_at: 5,
      body: 'hi there',
      p2p: true,
      ev: 'e'.repeat(43),
    }
    expect(p2pForward(clip, { dm: true })).toEqual({
      name: 'Bob',
      ts: 5000,
      body: 'hi there',
      ev: 'e'.repeat(43),
      src: { dm: true },
    })
    expect(
      p2pForward({ ...clip, ev: undefined, author: null, body: undefined }, undefined)
    ).toEqual({
      name: 'Deleted user',
      ts: 5000,
      body: 'hi',
    })
  })

  test('the destination of a draft', () => {
    const view = { kind: 'channel', server: 'club', channelId: 1 } as const
    const state = { ...s, panel: null, view }
    expect(instanceServer(state, 'c3')).toBe('pub')
    expect(instanceServer(state, 'd9')).toBeNull()
    expect(instanceServer(state, 't50')).toBe('club')
    expect(
      instanceServer(
        { ...state, panel: { kind: 'thread', root: msg(50, { channel_id: 4 }) } },
        't50'
      )
    ).toBe('vault')
    expect(p2pDestination('R')).toEqual({ kind: 'p2p', room: 'R', ch: null })
    expect(p2pDestination('R/c1')).toEqual({ kind: 'p2p', room: 'R', ch: 'c1' })
    expect(p2pDestination('R/c1#root')).toEqual({ kind: 'p2p', room: 'R', ch: 'c1' })
  })
})
