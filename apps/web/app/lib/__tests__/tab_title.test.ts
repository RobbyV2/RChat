import { describe, expect, test } from 'bun:test'
import { dotGeometry } from '../favicon_badge'
import {
  conversationPlace,
  dmPlace,
  placeText,
  roomPlace,
  serverPlace,
  tabMark,
  tabTitle,
} from '../tab_title'

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

describe('the name of a place', () => {
  const channels = [
    { id: 1, name: 'general', kind: 'text' },
    { id: 2, name: 'Lounge', kind: 'voice' },
  ]
  const account = {
    dms: [
      {
        id: 7,
        other: { username: 'al', display_name: 'Al', avatar_kind: 'identicon', avatar_color: null },
        is_self: false,
      },
      {
        id: 8,
        other: { username: 'me', display_name: 'Me', avatar_kind: 'identicon', avatar_color: null },
        is_self: true,
      },
    ] as never,
    servers: { club: { display_name: 'Club', creator: 'me', channels } as never },
    me: { username: 'me', servers: [] },
  }

  test('a hosted channel, a voice channel, a server, a DM, your own DM, an unknown DM', () => {
    expect(serverPlace(account, 'club', 1)).toEqual({
      kind: 'channel',
      channel: 'general',
      server: 'Club',
      voice: false,
      own: true,
    })
    expect(placeText(serverPlace(account, 'club', 2), 'A', false)).toBe('Lounge · Club')
    expect(serverPlace(account, 'club', 99)).toEqual({ kind: 'server', server: 'Club', own: true })
    expect(serverPlace(account, 'club', null)).toEqual({
      kind: 'server',
      server: 'Club',
      own: true,
    })
    expect(dmPlace(account, 7)).toEqual({ kind: 'dm', name: 'Al', own: false })
    expect(dmPlace(account, 8)).toEqual({ kind: 'dm', name: 'Me', own: true })
    expect(dmPlace(account, 9)).toEqual({ kind: 'app' })
  })

  test('P2P: a channel, a room without that channel, a room that is loading, a conversation', () => {
    const v = {
      name: 'Den',
      owner: 'k1',
      owners: [],
      channels: [{ id: 'a', name: 'general', kind: 'text' }],
    }
    const identity = { servers: { r: v }, me: 'k9' }
    expect(roomPlace(identity, 'r', '1')).toMatchObject({ kind: 'server', server: 'Den' })
    expect(roomPlace(identity, 'r', 'a')).toEqual({
      kind: 'channel',
      server: 'Den',
      channel: 'general',
      voice: false,
      own: false,
    })
    expect(roomPlace({ ...identity, me: 'k1' }, 'r', null)).toMatchObject({ own: true })
    expect(roomPlace(identity, 'gone', 'a')).toEqual({ kind: 'app' })
    expect(conversationPlace('Bob')).toEqual({ kind: 'dm', name: 'Bob', own: false })
    expect(conversationPlace(null)).toEqual({ kind: 'app' })
  })
})
