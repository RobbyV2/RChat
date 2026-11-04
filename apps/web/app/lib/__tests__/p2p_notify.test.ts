import { describe, expect, test } from 'bun:test'
import {
  EMPTY_NOTIFY,
  notifyValue,
  parseNotify,
  pingShown,
  pruneNotify,
  resolve,
  scopeOfKey,
  setLevel,
  setMute,
  unreadShown,
  type NotifyScope,
} from '../notify'
import { badgePings, p2pAlert, p2pOverride } from '../p2p/alerts'
import type { Arrival } from '../p2p/dm'
import type { EventRecord } from '../p2p/db'
import type { Content, EvType } from '../p2p/event'

const NOW = new Date(2026, 9, 28, 14, 0).getTime()
const ROOM = 'A'.repeat(43)
const scope: NotifyScope = { kind: 'p2p', room: ROOM }
const actor = {
  username: 'ik',
  display_name: 'Bob',
  avatar_kind: 'identicon' as const,
  avatar_color: null,
}

const arrival = (
  type: EvType,
  c: Content,
  ping: Arrival['ping'],
  unread = type === 'msg'
): Arrival => ({
  room: ROOM,
  peer: 'ik',
  ping,
  unread,
  rec: { type, wire: { c } } as EventRecord,
})

describe('P2P conversations in the notification resolver', () => {
  test('default: all messages, unmuted; overrides are stored per room', () => {
    expect(resolve(EMPTY_NOTIFY, scope, NOW)).toEqual({ level: 'all', muted: false })
    // Setting the default stores nothing.
    expect(setLevel(EMPTY_NOTIFY, scope, 'all')).toBe(EMPTY_NOTIFY)
    const p = setMute(setLevel(EMPTY_NOTIFY, scope, 'mentions'), scope, NOW + 60_000)
    expect(p.p2p[ROOM]).toEqual({ level: 'mentions', muteUntil: NOW + 60_000 })
    expect(resolve(p, scope, NOW)).toEqual({ level: 'mentions', muted: true })
    // Other tables are untouched.
    expect(Object.keys(p.dms)).toEqual([])
  })

  test('stored and parsed with the rest; bad room keys and expired mutes go', () => {
    const p = setLevel(EMPTY_NOTIFY, scope, 'nothing')
    expect(parseNotify(notifyValue(p), NOW)).toEqual(p)
    const raw = JSON.stringify({
      v: 1,
      p2p: {
        [ROOM]: { level: 'mentions' },
        short: { level: 'all' },
        ['B'.repeat(43)]: { muteUntil: NOW - 1 },
      },
    })
    expect(parseNotify(raw, NOW).p2p).toEqual({ [ROOM]: { level: 'mentions' } })
    const muted = setMute(EMPTY_NOTIFY, scope, NOW + 10)
    expect(pruneNotify(muted, NOW + 20).p2p).toEqual({})
  })

  test('badges and unread dots by scope key', () => {
    expect(scopeOfKey(`p2p:${ROOM}`, null)).toEqual(scope)
    expect(scopeOfKey('p2p:nope', null)).toBeNull()
    const nothing = setLevel(EMPTY_NOTIFY, scope, 'nothing')
    expect(pingShown(nothing, `p2p:${ROOM}`, null)).toBe(false)
    expect(pingShown(EMPTY_NOTIFY, `p2p:${ROOM}`, null)).toBe(true)
    expect(unreadShown(setMute(EMPTY_NOTIFY, scope, 'forever'), `p2p:${ROOM}`, null, NOW)).toBe(
      false
    )
    const rooms = {
      [ROOM]: { id: ROOM, peer: 'bob', pings: 2 },
      x: { id: 'B'.repeat(43), peer: 'carol', pings: 3 },
      y: { id: 'C'.repeat(43), peer: 'blocked', pings: 7 },
    }
    const listed = new Set(['bob', 'carol'])
    expect(badgePings(rooms, EMPTY_NOTIFY, listed)).toBe(5)
    expect(badgePings(rooms, nothing, listed)).toBe(3)
    // A muted conversation still badges its pings.
    expect(badgePings(rooms, setMute(EMPTY_NOTIFY, scope, 'forever'), listed)).toBe(5)
  })

  test('alerts follow the level: pings unless muted or Nothing, messages only under All', () => {
    const go = () => {}
    const msg = arrival('msg', { body: 'hello' }, null)
    const mention = arrival('msg', { body: '@Bob hi', mentions: ['me'] }, 'mention')
    const reaction = arrival('react', { target: 'x', key: '🎉', on: true }, 'reaction', false)
    const all = resolve(EMPTY_NOTIFY, scope, NOW)
    expect(p2pAlert(msg, all, actor, go)).toMatchObject({
      key: `p2p:${ROOM}`,
      action: '',
      body: 'hello',
      message: true,
      dm: true,
    })
    expect(p2pAlert(mention, all, actor, go)).toMatchObject({
      action: 'mentioned you',
      body: '@Bob hi',
    })
    expect(p2pAlert(reaction, all, actor, go)).toMatchObject({
      action: 'reacted 🎉 to your message',
      message: false,
    })
    const mentions = resolve(setLevel(EMPTY_NOTIFY, scope, 'mentions'), scope, NOW)
    expect(p2pAlert(msg, mentions, actor, go)).toBeNull()
    expect(p2pAlert(mention, mentions, actor, go)?.action).toBe('mentioned you')
    const muted = resolve(setMute(EMPTY_NOTIFY, scope, 'forever'), scope, NOW)
    expect(p2pAlert(msg, muted, actor, go)).toBeNull()
    expect(p2pAlert(mention, muted, actor, go)).toBeNull()
    const nothing = resolve(setLevel(EMPTY_NOTIFY, scope, 'nothing'), scope, NOW)
    expect(p2pAlert(mention, nothing, actor, go)).toBeNull()
    // An edit or a reaction that isn't a ping never alerts.
    expect(
      p2pAlert(arrival('edit', { target: 'x', body: 'y' }, null, false), all, actor, go)
    ).toBeNull()
  })
})

describe('P2P overrides in the settings list', () => {
  const servers = {
    srv: { name: 'Club', channels: [{ id: 'ch1', name: 'general' }] },
  } as unknown as Parameters<typeof p2pOverride>[1]
  const dm = (room: string) => (room === 'dm' ? 'Alice' : null)
  test('a channel, a server and a conversation each get their own scope and name', () => {
    expect(p2pOverride('srv/ch1', servers, dm)).toEqual({
      scope: { kind: 'p2pc', room: 'srv', ch: 'ch1' },
      name: 'general',
      prefix: '#',
      hint: 'Club',
    })
    expect(p2pOverride('srv', servers, dm)).toEqual({
      scope: { kind: 'p2ps', room: 'srv' },
      name: 'Club',
    })
    expect(p2pOverride('dm', servers, dm)).toEqual({
      scope: { kind: 'p2p', room: 'dm' },
      name: 'Alice',
    })
    // Gone from here: generic names, never a prototype key's value.
    expect(p2pOverride('srv/gone', servers, dm).name).toBe('Channel')
    expect(p2pOverride('constructor', servers, dm)).toEqual({
      scope: { kind: 'p2p', room: 'constructor' },
      name: 'P2P conversation',
    })
  })
})
