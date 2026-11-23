import { expect, test } from 'bun:test'
import { activeOnArrival, guestDismissals, refreshDelay } from '../announcements'

test('banner refresh follows the instance clock and checks for changes on other copies', () => {
  const feed = { announcements: [], server_time: 3000, next_change: 3003 }
  expect(refreshDelay(feed)).toBe(3000)
  expect(refreshDelay({ ...feed, next_change: null })).toBe(30000)
  expect(refreshDelay({ ...feed, next_change: 2999 })).toBeGreaterThan(0)
})

test('guest dismissals expire at the exclusive end and ignore malformed settings', () => {
  expect(guestDismissals('{"past":1,"now":5,"active":6,"broken":"10"}', 5)).toEqual({ active: 6 })
  for (const raw of [null, '[10]', 'true', '{']) expect(guestDismissals(raw, 0)).toEqual({})
})

test('a delayed response omits expired notices and refreshes at the remaining boundary', () => {
  const first = { id: 'first', message: 'one', starts_at: 10, ends_at: 22 }
  const second = { ...first, id: 'second', ends_at: 30 }
  const feed = { server_time: 20, next_change: 22, announcements: [first, second] }
  expect(activeOnArrival(feed, 2500)).toEqual([second])
  expect(refreshDelay(feed, 1500)).toBe(500)
})
