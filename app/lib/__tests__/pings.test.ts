import { describe, expect, test } from 'bun:test'
import {
  addPing,
  badgeText,
  clearPings,
  dmPings,
  forgetPings,
  mergePings,
  pingAction,
  pingAlert,
  pingCount,
  pingTitle,
  pingUntil,
  scopePings,
  serverPings,
  setScopePings,
  totalPings,
  type PingCount,
  type Pings,
  type Watching,
} from '../pings'
import type { Ping } from '../types'
import { user } from './fixtures'

const ping = (over: Partial<Ping> = {}): Ping => ({
  id: 1,
  kind: 'mention',
  scope: 'c1',
  server: 's',
  message_id: 10,
  thread_root_id: null,
  actor: user('alice'),
  emoji: null,
  excerpt: 'hi @bob',
  created_at: 1,
  ...over,
})

const watching = (over: Partial<Watching> = {}): Watching => ({
  view: 'c1',
  thread: null,
  following: () => true,
  visible: true,
  ...over,
})

const bulk = (scope: string, server: string | null, n: number, until: number): PingCount => ({
  scope,
  server,
  bulk: n,
  bulkUntil: until,
  ids: [],
})

describe('ping counts', () => {
  test('live pings add once per id, keyed by scope or thread', () => {
    let p: Pings = {}
    p = addPing(p, ping())
    p = addPing(p, ping({ id: 2 }))
    p = addPing(p, ping({ id: 2 }))
    p = addPing(p, ping({ id: 3, thread_root_id: 7 }))
    p = addPing(p, ping({ id: 4, scope: 'd4', server: null }))
    expect(p).toEqual({
      c1: { scope: 'c1', server: 's', bulk: 0, bulkUntil: 0, ids: [1, 2] },
      t7: { scope: 'c1', server: 's', bulk: 0, bulkUntil: 0, ids: [3] },
      d4: { scope: 'd4', server: null, bulk: 0, bulkUntil: 0, ids: [4] },
    })
    expect(scopePings(p, 'c1')).toBe(3)
    expect(pingCount(p.c1)).toBe(2)
    expect(pingUntil(p.c1)).toBe(2)
    const counted = { c1: bulk('c1', 's', 2, 9) }
    expect(addPing(counted, ping({ id: 9 }))).toBe(counted)
    expect(pingCount(addPing(counted, ping({ id: 10 })).c1)).toBe(3)
  })

  test('clearing up to a bound keeps newer pings', () => {
    const p: Pings = {
      c1: { scope: 'c1', server: 's', bulk: 2, bulkUntil: 5, ids: [8, 12] },
      t7: { scope: 'c1', server: 's', bulk: 0, bulkUntil: 0, ids: [9] },
    }
    expect(clearPings(p, 'c1', 8)).toEqual({
      c1: { scope: 'c1', server: 's', bulk: 0, bulkUntil: 0, ids: [12] },
      t7: p.t7,
    })
    expect(clearPings(p, 'c1', 4)).toBe(p)
    expect(clearPings(p, 'c1')).toEqual({ t7: p.t7 })
    expect(clearPings(p, 't7', 9)).toEqual({ c1: p.c1 })
    expect(clearPings(p, 'zz')).toBe(p)
  })

  test('a scope summary replaces the scope and its threads', () => {
    const p: Pings = {
      c1: bulk('c1', 's', 3, 9),
      t7: bulk('c1', 's', 1, 4),
      c2: bulk('c2', 's', 1, 2),
    }
    expect(
      setScopePings(p, 'c1', 's', {
        pings: 3,
        pings_until: 11,
        thread_pings: [{ root_id: 8, pings: 2, pings_until: 10 }],
      })
    ).toEqual({ c2: p.c2, c1: bulk('c1', 's', 1, 11), t8: bulk('c1', 's', 2, 10) })
    expect(setScopePings(p, 'c1', 's', { pings: 0, pings_until: 0, thread_pings: [] })).toEqual({
      c2: p.c2,
    })
    expect(forgetPings(p, scope => scope === 'c1')).toEqual({ c2: p.c2 })
    expect(forgetPings(p, () => false)).toBe(p)
  })

  test('sums per row, server, DMs and overall', () => {
    const p: Pings = {
      c1: bulk('c1', 's', 2, 1),
      t5: bulk('c1', 's', 1, 1),
      c2: bulk('c2', 's', 3, 1),
      c3: bulk('c3', 't', 1, 1),
      d4: bulk('d4', null, 4, 1),
    }
    expect(scopePings(p, 'c1')).toBe(3)
    expect(serverPings(p, 's')).toBe(6)
    expect(serverPings(p, 'x')).toBe(0)
    expect(dmPings(p)).toBe(4)
    expect(totalPings(p)).toBe(11)
  })

  test('server counts win unless the key changed while loading', () => {
    const c2 = bulk('c2', 's', 5, 5)
    const before: Pings = { c5: bulk('c5', 's', 1, 1), c2 }
    const current: Pings = { c2, c3: bulk('c3', 's', 1, 3) }
    const merged = mergePings(before, current, [
      {
        scope: 'c1',
        server: 's',
        last_read: 0,
        latest: 1,
        pings: 5,
        pings_until: 6,
        thread_pings: [{ root_id: 2, pings: 1, pings_until: 4 }],
      },
      { scope: 'c3', server: 's', last_read: 0, latest: 1, pings: 0 },
      { scope: 'd9', server: null, last_read: 0, latest: 1, pings: 2, pings_until: 8 },
      { scope: 'c8', server: 's', last_read: 0, latest: 1 },
      { scope: 'c5', server: 's', last_read: 0, latest: 1, pings: 1, pings_until: 1 },
    ])
    expect(merged).toEqual({
      c1: bulk('c1', 's', 4, 6),
      t2: bulk('c1', 's', 1, 4),
      c3: bulk('c3', 's', 1, 3),
      d9: bulk('d9', null, 2, 8),
    })
  })

  test('badge and title text', () => {
    expect(badgeText(7)).toBe('7')
    expect(badgeText(100)).toBe('99+')
    expect(pingTitle('RChat', 0)).toBe('RChat')
    expect(pingTitle('RChat', 3)).toBe('(3) RChat')
    expect(pingTitle('RChat', 250)).toBe('(99+) RChat')
  })
})

describe('pingAlert', () => {
  test('watching the scope at the bottom shows nothing', () => {
    expect(pingAlert(ping(), watching())).toEqual({ toast: false, badge: false })
  })

  test('elsewhere, scrolled up or hidden it toasts and badges', () => {
    const both = { toast: true, badge: true }
    expect(pingAlert(ping(), watching({ view: 'c2' }))).toEqual(both)
    expect(pingAlert(ping(), watching({ view: null }))).toEqual(both)
    expect(pingAlert(ping(), watching({ following: () => false }))).toEqual(both)
    expect(pingAlert(ping(), watching({ visible: false }))).toEqual(both)
  })

  test('thread pings count as seen only in that open thread', () => {
    const p = ping({ thread_root_id: 5 })
    const at = (key: string) => key === 't5'
    expect(pingAlert(p, watching({ thread: 5, following: at }))).toEqual({
      toast: false,
      badge: false,
    })
    expect(pingAlert(p, watching({ thread: null }))).toEqual({ toast: true, badge: true })
    expect(pingAlert(p, watching({ thread: 5, following: () => false }))).toEqual({
      toast: true,
      badge: true,
    })
  })

  test('toast wording', () => {
    expect(pingAction(ping(), 'general')).toBe('mentioned you in #general')
    expect(pingAction(ping({ scope: 'd1', server: null }), null)).toBe('mentioned you')
    expect(pingAction(ping({ kind: 'reply' }), 'a')).toBe('replied to you in #a')
    expect(pingAction(ping({ kind: 'reaction', emoji: '👍' }), null)).toBe(
      'reacted 👍 to your message'
    )
  })
})
