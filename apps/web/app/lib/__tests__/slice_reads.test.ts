import { afterAll, describe, expect, test } from 'bun:test'
import { pingCount } from '../pings'
import { applyPingCount, applyReadUpdated } from '../slices/reads'
import { resetSessionCaches, useStore, type RChatState } from '../store'

afterAll(resetSessionCaches)

const state = (over: Partial<RChatState>): RChatState => ({ ...useStore.getState(), ...over })
const read = (scope: string, last_read: number, pings_until?: number) => ({
  type: 'read_updated' as const,
  username: 'bob',
  scope,
  last_read,
  pings_until,
})

describe('reads reducers', () => {
  test('read_updated never moves lastRead backwards', () => {
    const s = state({ reads: { c1: { lastRead: 9, latest: 12, server: 's' } }, pings: {} })
    expect(applyReadUpdated(s, read('c1', 5)).reads!.c1).toEqual({
      lastRead: 9,
      latest: 12,
      server: 's',
    })
    expect(applyReadUpdated(s, read('c1', 15)).reads!.c1).toEqual({
      lastRead: 15,
      latest: 15,
      server: 's',
    })
  })

  test('read_updated clears the pings it covers', () => {
    const pings = {
      c1: { scope: 'c1', server: 's', bulk: 0, bulkUntil: 0, ids: [4, 8] },
      t7: { scope: 'c1', server: 's', bulk: 0, bulkUntil: 0, ids: [5] },
    }
    const s = state({ reads: {}, pings })
    expect(applyReadUpdated(s, read('c1', 3, 4)).pings!.c1.ids).toEqual([8])
    const thread = applyReadUpdated(s, read('t7', 0, 5))
    expect(thread.pings!.t7).toBeUndefined()
    expect(thread.reads).toBeUndefined()
  })

  test("ping_count sets the scope's count", () => {
    const s = state({
      reads: { c1: { lastRead: 1, latest: 2, server: 's' } },
      pings: {
        c1: { scope: 'c1', server: 's', bulk: 1, bulkUntil: 3, ids: [5] },
        t9: { scope: 'c1', server: 's', bulk: 2, bulkUntil: 6, ids: [] },
        c2: { scope: 'c2', server: 's', bulk: 1, bulkUntil: 1, ids: [] },
      },
    })
    const out = applyPingCount(s, {
      type: 'ping_count',
      username: 'bob',
      scope: 'c1',
      pings: 4,
      pings_until: 9,
    })
    expect(pingCount(out.pings!.c1)).toBe(4)
    expect(out.pings!.c1.server).toBe('s')
    expect(out.pings!.t9).toBeUndefined()
    expect(out.pings!.c2).toBe(s.pings.c2)
  })

  test('ping_count takes the server from the reads when no ping names it', () => {
    const s = state({ reads: { c3: { lastRead: 1, latest: 2, server: 'x' } }, pings: {} })
    const out = applyPingCount(s, {
      type: 'ping_count',
      username: 'bob',
      scope: 'c3',
      pings: 1,
      pings_until: 2,
    })
    expect(out.pings!.c3.server).toBe('x')
  })
})
