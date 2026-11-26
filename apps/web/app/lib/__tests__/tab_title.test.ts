import { describe, expect, test } from 'bun:test'
import { dotGeometry } from '../favicon_badge'
import { hostedPlace, p2pPlace, placeText, tabMark, tabTitle } from '../tab_title'

const channel = {
  kind: 'channel',
  channel: 'general',
  server: 'Club',
  voice: false,
  own: false,
} as const

describe('the tab title', () => {
  test('names the place: a channel with its server, a DM, a server, or the app', () => {
    expect(placeText(channel, 'Chat', false)).toBe('#general · Club')
    expect(placeText({ kind: 'dm', name: 'Alice', own: false }, 'Chat', false)).toBe('@Alice')
    expect(placeText({ kind: 'server', server: 'Club', own: false }, 'Chat', false)).toBe('Club')
    expect(placeText({ kind: 'app' }, 'Chat', false)).toBe('Chat')
  })

  test('names no server, channel or person in streamer mode', () => {
    expect(placeText(channel, 'Chat', true)).toBe('Server')
    expect(placeText({ kind: 'dm', name: 'Alice', own: false }, 'Chat', true)).toBe(
      'Direct message'
    )
    expect(placeText({ kind: 'server', server: 'Club', own: false }, 'Chat', true)).toBe('Server')
  })

  test('leads with a dot while something is unread, and the count of notifications', () => {
    expect(tabTitle(channel, 'Chat', false, 0, false)).toBe('#general · Club')
    expect(tabTitle(channel, 'Chat', false, 0, true)).toBe('• #general · Club')
    expect(tabTitle(channel, 'Chat', false, 3, false)).toBe('(3) • #general · Club')
    expect(tabTitle({ kind: 'app' }, 'Chat', false, 250, true)).toBe('(99+) • Chat')
  })

  test('the favicon mark', () => {
    expect([tabMark(0, false), tabMark(0, true), tabMark(2, false)]).toEqual([
      'none',
      'unread',
      'pings',
    ])
    const { x, y, r, ring } = dotGeometry(64)
    expect(x + r + ring).toBeLessThanOrEqual(64)
    expect(y + r + ring).toBeLessThanOrEqual(64)
    expect(r).toBeGreaterThanOrEqual(12)
  })
})

describe('the place on screen', () => {
  const channels = [
    { id: 1, name: 'general', kind: 'text' },
    { id: 2, name: 'Lounge', kind: 'voice' },
  ]
  const hosted = (over: Partial<Parameters<typeof hostedPlace>[0]> = {}) =>
    hostedPlace({
      view: { kind: 'channel', server: 'club', channelId: 1 },
      home: false,
      dms: [
        {
          id: 7,
          other: {
            username: 'al',
            display_name: 'Al',
            avatar_kind: 'identicon',
            avatar_color: null,
          },
          is_self: false,
        },
        {
          id: 8,
          other: {
            username: 'me',
            display_name: 'Me',
            avatar_kind: 'identicon',
            avatar_color: null,
          },
          is_self: true,
        },
      ] as never,
      servers: { club: { display_name: 'Club', creator: 'me', channels } as never },
      me: { username: 'me', servers: [] },
      ...over,
    })

  test('a hosted channel, a voice channel, a DM, your own DM, a server, Home', () => {
    expect(hosted()).toEqual({
      kind: 'channel',
      channel: 'general',
      server: 'Club',
      voice: false,
      own: true,
    })
    expect(
      placeText(hosted({ view: { kind: 'channel', server: 'club', channelId: 2 } }), 'A', false)
    ).toBe('Lounge · Club')
    expect(hosted({ view: { kind: 'dm', dmId: 7 } })).toEqual({
      kind: 'dm',
      name: 'Al',
      own: false,
    })
    expect(hosted({ view: { kind: 'dm', dmId: 8 } })).toEqual({ kind: 'dm', name: 'Me', own: true })
    expect(hosted({ view: { kind: 'channel', server: 'club', channelId: 99 } })).toEqual({
      kind: 'server',
      server: 'Club',
      own: true,
    })
    expect(hosted({ home: true })).toEqual({ kind: 'app' })
    expect(hosted({ view: null })).toEqual({ kind: 'app' })
    expect(hosted({ view: { kind: 'dm', dmId: 9 } })).toEqual({ kind: 'app' })
  })

  test('P2P: a channel, a server that is loading, a conversation, the home, nothing', () => {
    const v = {
      name: 'Den',
      owner: 'k1',
      owners: [],
      channels: [{ id: 'z', name: 'Lounge', kind: 'voice' }],
    }
    const name = (ik: string) => (ik === 'k2' ? 'Bob' : null)
    const base = { home: false, server: null, servers: { r: v }, chat: null, me: 'k9' }
    expect(p2pPlace({ ...base, server: { room: 'r', ch: '1' } }, name)).toMatchObject({
      kind: 'server',
      server: 'Den',
    })
    const withIds = { ...v, channels: [{ id: 'a', name: 'general', kind: 'text' }] }
    expect(
      p2pPlace({ ...base, servers: { r: withIds }, server: { room: 'r', ch: 'a' } }, name)
    ).toEqual({
      kind: 'channel',
      server: 'Den',
      channel: 'general',
      voice: false,
      own: false,
    })
    expect(p2pPlace({ ...base, server: { room: 'gone', ch: 'a' } }, name)).toEqual({ kind: 'app' })
    expect(p2pPlace({ ...base, home: true, chat: { peer: 'k2' } }, name)).toEqual({
      kind: 'dm',
      name: 'Bob',
      own: false,
    })
    expect(p2pPlace({ ...base, home: true }, name)).toEqual({ kind: 'app' })
    expect(p2pPlace(base, name)).toBeNull()
  })
})
