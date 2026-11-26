import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { P2pStore, type EventRecord } from '../p2p/db'
import {
  formatSince,
  hostedUnread,
  p2pUnread,
  p2pUnreadStart,
  unreadBannerText,
  type UnreadCount,
} from '../unread_banner'

const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
beforeEach(() => {
  process.env.TZ = 'America/New_York'
})
afterEach(() => {
  process.env.TZ = zone
})

describe('what the banner says', () => {
  test('the count and when the first one came', () => {
    const at = new Date(2026, 10, 25, 14, 39).getTime()
    expect(formatSince(at, 'en-US')).toBe('11/25/26, 2:39 PM')
    const say = (count: number | null, more = false, since: number | null = at) =>
      unreadBannerText({ count, more, since }, 'en-US')
    expect(say(15)).toBe('15 new messages since 11/25/26, 2:39 PM')
    expect(say(1)).toBe('1 new message since 11/25/26, 2:39 PM')
    expect(say(99)).toBe('99 new messages since 11/25/26, 2:39 PM')
    expect(say(100)).toBe('99+ new messages since 11/25/26, 2:39 PM')
    expect(say(40, true)).toBe('99+ new messages since 11/25/26, 2:39 PM')
    expect(say(null)).toBe('New messages since 11/25/26, 2:39 PM')
    expect(say(3, false, null)).toBe('3 new messages')
    expect(say(null, false, null)).toBe('New messages')
  })
})

const row = (id: number, author: string, created_at = id * 60) => ({ id, author, created_at })

describe('a hosted list', () => {
  const rows = [row(10, 'bob'), row(11, 'carol'), row(12, 'me'), row(13, 'bob')]
  const counted: UnreadCount = { count: 40, more: false, since: 300, latest: 12 }

  test('counts the loaded rows from the first unread one when they reach the newest', () => {
    expect(hostedUnread(rows, 1, true, 'me', 10, counted)).toEqual({
      count: 2,
      more: false,
      since: 660_000,
    })
  })

  test('otherwise takes the server count plus what came after it', () => {
    expect(hostedUnread(rows, -1, true, 'me', 9, counted)).toEqual({
      count: 41,
      more: false,
      since: 300_000,
    })
    expect(hostedUnread(rows, 1, false, 'me', 10, { ...counted, more: true })).toEqual({
      count: 41,
      more: true,
      since: 300_000,
    })
    expect(hostedUnread(rows, -1, true, 'me', 9, null)).toEqual({
      count: null,
      more: false,
      since: null,
    })
  })

  test('a count of nothing adds what arrives after the read marker', () => {
    const none: UnreadCount = { count: 0, more: false, since: null, latest: null }
    expect(hostedUnread(rows, -1, true, 'me', 11, none)).toEqual({
      count: 1,
      more: false,
      since: null,
    })
  })
})

describe('a P2P list', () => {
  const rows = [
    { sender: 'bob', seq: 4, ts: 1000 },
    { sender: 'bob', seq: 5, ts: 1500, system: { kind: 'join' } },
    { sender: 'me', seq: 6, ts: 2000 },
    { sender: 'bob', seq: 7, ts: 3000 },
    { sender: 'bob', seq: 8, ts: 3500, call: {} },
  ]
  const atOpen = { count: 75, seq: 6 }

  test('counts the loaded messages from the first unread one when they reach the newest', () => {
    expect(p2pUnread(rows, 0, true, 'me', atOpen, null)).toEqual({
      count: 2,
      more: false,
      since: 1000,
    })
  })

  test('otherwise the count when it opened plus what arrived since', () => {
    expect(p2pUnread(rows, -1, true, 'me', atOpen, { ts: 500 })).toEqual({
      count: 76,
      more: false,
      since: 500,
    })
    expect(p2pUnread(rows, 0, false, 'me', atOpen, null)).toEqual({
      count: 76,
      more: false,
      since: 1000,
    })
    expect(p2pUnread(rows, -1, true, 'me', atOpen, null).since).toBeNull()
  })

  test('the unread part starts after the read marker and after your own last message', () => {
    expect(p2pUnreadStart(rows, 3, 'me', false)).toEqual({ first: 3, ambiguous: false, sent: true })
    expect(p2pUnreadStart(rows.slice(0, 2), 3, 'me', false)).toEqual({
      first: 0,
      ambiguous: false,
      sent: false,
    })
    expect(p2pUnreadStart(rows.slice(0, 2), 3, 'me', true)).toEqual({
      first: 0,
      ambiguous: true,
      sent: false,
    })
    expect(p2pUnreadStart(rows, 0, 'me', true)).toEqual({
      first: -1,
      ambiguous: false,
      sent: false,
    })
    expect(p2pUnreadStart(rows.slice(0, 3), 6, 'me', false)).toEqual({
      first: -1,
      ambiguous: false,
      sent: false,
    })
  })
})

describe('the first unread message in storage', () => {
  const ev = (seq: number, over: Partial<EventRecord> = {}): EventRecord =>
    ({
      id: `e${seq}`,
      room: 'r',
      type: 'msg',
      sender: 'bob',
      wire: {},
      depth: seq,
      effTs: seq * 1000,
      sortKey: String(seq).padStart(4, '0'),
      receivedAt: seq,
      seq,
      redacted: false,
      ...over,
    }) as EventRecord

  test('is the first message from someone else after the read marker', async () => {
    const store = await P2pStore.open(`unread_banner_${Date.now()}`)
    try {
      for (const e of [
        ev(1),
        ev(2, { sender: 'me' }),
        ev(3, { type: 'react' }),
        ev(4, { redacted: true }),
        ev(5, { chan: 'b' }),
        ev(6, { chan: 'a', thread: 'e1' }),
        ev(7, { chan: 'a' }),
        ev(8, { room: 'other' }),
      ])
        await store.db.put('events', e)
      expect((await store.firstMessageAfter('r', 1, 'me'))?.id).toBe('e5')
      expect(await store.firstMessageAfter('r', 7, 'me')).toBeNull()
      expect(await store.firstMessageAfter('none', 0, 'me')).toBeNull()
      expect((await store.firstMessageAfter('r', 1, 'me', 'a'))?.id).toBe('e7')
      for (const e of [
        ev(9, { chan: 'a' }),
        ev(10, { chan: 'a', sender: 'me' }),
        ev(11, { chan: 'a' }),
      ])
        await store.db.put('events', e)
      expect((await store.firstMessageAfter('r', 8, 'me', 'a'))?.id).toBe('e9')
      expect((await store.firstMessageAfter('r', 9, 'me', 'a'))?.id).toBe('e11')
      expect(await store.firstMessageAfter('r', 11, 'me', 'a')).toBeNull()
      expect((await store.firstMessageAfter('r', 8, 'me', 'a', 1))?.id).toBe('e11')
    } finally {
      store.close()
    }
  })
})
