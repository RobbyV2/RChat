import { describe, expect, test } from 'bun:test'
import {
  STATUS_MAX,
  STATUS_TTL,
  chipFor,
  closedForUsers,
  serviceWorks,
  statusCache,
  type HostStatus,
} from '../fed/status'

const status = (over: Partial<HostStatus> = {}): HostStatus => ({
  host: 'chat.b.example',
  name: 'Beta',
  reachable: true,
  services: { letters: true, invites: true, profiles: true, reports: true, directory: true },
  ...over,
})

describe('host chips', () => {
  test('a reachable host and a host never contacted show nothing', () => {
    for (const reachable of [true, null])
      expect(chipFor(status({ reachable }), 'chip')).toEqual({
        dot: false,
        title: null,
        line: null,
      })
    expect(chipFor(null, 'letters')).toEqual({ dot: false, title: null, line: null })
  })

  test('an unreachable host shows the amber dot and one plain line, never a reason', () => {
    const title = "chat.b.example can't be reached from here right now."
    expect(chipFor(status({ reachable: false }), 'chip')).toEqual({ dot: true, title, line: null })
    expect(chipFor(status({ reachable: false }), 'letters')).toEqual({
      dot: true,
      title,
      line: 'Letters wait up to 7 days.',
    })
    expect(chipFor(status({ reachable: false }), 'invite')).toEqual({
      dot: true,
      title,
      line: 'Preview not available from here.',
    })
  })

  test('a service a reachable host does not offer shows nothing: the card falls back to the direct path', () => {
    const noInvites = status({ services: { letters: true, invites: false } })
    for (const context of ['invite', 'letters', 'chip'] as const)
      expect({ context, chip: chipFor(noInvites, context) }).toEqual({
        context,
        chip: { dot: false, title: null, line: null },
      })
    expect(serviceWorks(noInvites, 'invites')).toBe(false)
    expect(serviceWorks(noInvites, 'letters')).toBe(true)
    expect(serviceWorks(noInvites, 'profiles')).toBe(false)
    expect(serviceWorks(status({ reachable: false }), 'letters')).toBe(false)
    expect(serviceWorks(status({ reachable: null }), 'letters')).toBe(false)
    expect(serviceWorks(null, 'letters')).toBe(false)
  })

  test('copy is short plain ASCII with no dashes', () => {
    for (const context of ['chip', 'letters', 'invite'] as const) {
      const chip = chipFor(status({ reachable: false, host: 'xn--caf-dma.example' }), context)
      for (const text of [chip.title, chip.line])
        if (text !== null) {
          expect(/^[\x20-\x7e]*$/.test(text)).toBe(true)
          expect(text.includes(' - ')).toBe(false)
          expect(text.length).toBeLessThanOrEqual(200)
        }
    }
  })

  test('a hold is pacing and a due Hello is asked first: users are shown nothing for them, and every other closed state is unreachable', () => {
    expect(closedForUsers(null)).toBe(false)
    expect(closedForUsers('held')).toBe(false)
    expect(closedForUsers('hello')).toBe(false)
    for (const why of [
      'blocked',
      'identity',
      'unsupported',
      'version',
      'halted',
      'paused',
      'refused_by_them',
      'paused_by_them',
      'identity_by_them',
      'waiting',
    ] as const)
      expect({ why, closed: closedForUsers(why) }).toEqual({ why, closed: true })
  })
})

describe('the per-session status cache', () => {
  const T0 = 1_800_000_000_000

  test('a status is kept for 60 seconds', () => {
    const cache = statusCache()
    expect(cache.get('chat.b.example', T0)).toBeUndefined()
    cache.put(status(), T0)
    expect(cache.get('chat.b.example', T0 + STATUS_TTL - 1)).toEqual(status())
    expect(cache.get('chat.b.example', T0 + STATUS_TTL)).toBeUndefined()
    expect(STATUS_TTL).toBe(60_000)
  })

  test('a letter_outbox event refreshes that host at once', () => {
    const cache = statusCache()
    cache.put(status(), T0)
    cache.put(status({ host: 'chat.c.example' }), T0)
    cache.outbox({ host: 'chat.b.example', reachable: false }, T0 + 5)
    expect(cache.get('chat.b.example', T0 + 6)?.reachable).toBe(false)
    expect(cache.get('chat.b.example', T0 + 5 + STATUS_TTL)).toBeUndefined()
    expect(cache.get('chat.c.example', T0 + 6)?.reachable).toBe(true)
    cache.outbox({ host: 'never.seen.example', reachable: false }, T0 + 7)
    expect(cache.get('never.seen.example', T0 + 8)).toBeUndefined()
    cache.outbox({ host: 'chat.c.example' }, T0 + 9)
    expect(cache.get('chat.c.example', T0 + 10)).toBeUndefined()
  })

  test('a null answer is cached too, so a host without a row is not asked for on every chip', () => {
    const cache = statusCache()
    cache.put(status({ reachable: null, name: null, services: {} }), T0)
    expect(cache.get('chat.b.example', T0 + 1)?.reachable).toBeNull()
  })

  test('the cache is bounded and drops the oldest host', () => {
    const cache = statusCache()
    for (let i = 0; i <= STATUS_MAX; i += 1) cache.put(status({ host: `h${i}.example` }), T0 + i)
    expect(cache.get('h0.example', T0 + STATUS_MAX)).toBeUndefined()
    expect(cache.get('h1.example', T0 + STATUS_MAX)).not.toBeUndefined()
    expect(cache.get(`h${STATUS_MAX}.example`, T0 + STATUS_MAX)).not.toBeUndefined()
  })

  test('two sessions never share a state', () => {
    const a = statusCache()
    const b = statusCache()
    a.put(status({ reachable: false }), T0)
    expect(b.get('chat.b.example', T0)).toBeUndefined()
    b.put(status({ reachable: true }), T0)
    expect(a.get('chat.b.example', T0)?.reachable).toBe(false)
    a.clear()
    expect(a.get('chat.b.example', T0)).toBeUndefined()
    expect(b.get('chat.b.example', T0)?.reachable).toBe(true)
  })
})
