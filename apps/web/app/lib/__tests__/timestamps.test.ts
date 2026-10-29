import { describe, expect, test } from 'bun:test'
import {
  STYLES,
  acceptStamp,
  findStampTrigger,
  formatStamp,
  fullTime,
  messageStampToken,
  messageTime,
  plainStamps,
  relativeTime,
  splitStamps,
  stampChoices,
  tickDelay,
} from '../timestamps'
import { alertBody } from '../notices'

const o = { locale: 'en-US', timeZone: 'UTC' }
// Thursday, October 29, 2026 16:20:30 UTC
const T = 1793290830
const MS = T * 1000

describe('splitStamps', () => {
  test('finds tokens with and without a style', () => {
    expect(splitStamps(`a <t:${T}> b <t:${T}:R>`)).toEqual([
      { text: 'a ', stamp: null },
      { text: `<t:${T}>`, stamp: { ms: MS, style: 'f' } },
      { text: ' b ', stamp: null },
      { text: `<t:${T}:R>`, stamp: { ms: MS, style: 'R' } },
    ])
  })

  test('every style parses', () => {
    for (const s of STYLES) expect(splitStamps(`<t:1:${s}>`)[0].stamp?.style).toBe(s)
  })

  test('negative seconds are allowed', () => {
    expect(splitStamps('<t:-86400:d>')[0].stamp).toEqual({ ms: -86400000, style: 'd' })
  })

  test('invalid tokens stay text', () => {
    for (const bad of ['<t:>', '<t:abc>', '<t:12:x>', '<t:12:RR>', '<t: 12>', '<t:1.5>', 't:12'])
      expect(splitStamps(bad)).toEqual([{ text: bad, stamp: null }])
  })

  test('out of range stays text', () => {
    expect(splitStamps('<t:8640000000000>')[0].stamp?.ms).toBe(8.64e15)
    expect(splitStamps('<t:-8640000000000>')[0].stamp?.ms).toBe(-8.64e15)
    expect(splitStamps('<t:8640000000001>')[0].stamp).toBeNull()
    expect(splitStamps('<t:99999999999999>')[0].stamp).toBeNull()
  })
})

describe('formatStamp', () => {
  test('styles in the given locale and zone', () => {
    const now = MS
    expect(formatStamp(MS, 't', now, o)).toBe('4:20 PM')
    expect(formatStamp(MS, 'T', now, o)).toBe('4:20:30 PM')
    expect(formatStamp(MS, 'd', now, o)).toBe('10/29/2026')
    expect(formatStamp(MS, 'D', now, o)).toBe('October 29, 2026')
    expect(formatStamp(MS, 'f', now, o)).toContain('October 29, 2026')
    expect(formatStamp(MS, 'f', now, o)).toContain('4:20 PM')
    expect(formatStamp(MS, 'F', now, o)).toContain('Thursday, October 29, 2026')
    expect(fullTime(MS, o)).toContain('Thursday, October 29, 2026')
  })

  test('time zone changes the result', () => {
    expect(formatStamp(MS, 't', MS, { locale: 'en-US', timeZone: 'Asia/Tokyo' })).toBe('1:20 AM')
    expect(formatStamp(MS, 'd', MS, { locale: 'en-GB', timeZone: 'UTC' })).toBe('29/10/2026')
  })

  test('relative', () => {
    expect(relativeTime(MS, MS, o)).toBe('now')
    expect(relativeTime(MS + 30000, MS, o)).toBe('in 30 seconds')
    expect(relativeTime(MS - 59999, MS, o)).toBe('59 seconds ago')
    expect(relativeTime(MS - 5 * 60000, MS, o)).toBe('5 minutes ago')
    expect(relativeTime(MS + 2 * 3600000, MS, o)).toBe('in 2 hours')
    expect(relativeTime(MS - 3 * 86400000, MS, o)).toBe('3 days ago')
    expect(relativeTime(MS + 90 * 86400000, MS, o)).toBe('in 3 months')
    expect(relativeTime(MS - 3 * 365 * 86400000, MS, o)).toBe('3 years ago')
    expect(formatStamp(MS, 'R', MS - 3600000, o)).toBe('in 1 hour')
  })
})

describe('messageTime', () => {
  test('today shows the time only', () => {
    expect(messageTime(MS, MS + 60000, o)).toBe('4:20 PM')
  })
  test('yesterday is labelled', () => {
    expect(messageTime(MS, MS + 86400000, o)).toBe('Yesterday at 4:20 PM')
  })
  test('older shows the date', () => {
    expect(messageTime(MS, MS + 3 * 86400000, o)).toBe('10/29/2026 4:20 PM')
  })
})

describe('plainStamps', () => {
  test('replaces tokens outside code', () => {
    expect(plainStamps(`at <t:${T}:t> ok`, MS, o)).toBe('at 4:20 PM ok')
    expect(plainStamps(`\`<t:${T}:t>\` <t:${T}:t>`, MS, o)).toBe(`\`<t:${T}:t>\` 4:20 PM`)
    expect(plainStamps('```\n<t:1:t>\n```', MS, o)).toBe('```\n<t:1:t>\n```')
    expect(plainStamps('<t:x>', MS, o)).toBe('<t:x>')
  })
  test('notification bodies show formatted text', () => {
    expect(alertBody('<t:0:R>', false).includes('<t:')).toBe(false)
  })
})

test('message token copies the long form', () => {
  expect(messageStampToken(T)).toBe(`<t:${T}:F>`)
})

describe('tickDelay', () => {
  test('nothing to watch', () => {
    expect(tickDelay([], 0)).toBeNull()
  })
  test('seconds while close', () => {
    expect(tickDelay([10_000], 500)).toBe(500)
    expect(tickDelay([-30_000], 2_000)).toBe(1000)
  })
  test('minutes when far', () => {
    expect(tickDelay([-3_600_000], 15_000)).toBe(45_000)
  })
  test('wakes when a future time comes within a minute', () => {
    expect(tickDelay([90_000], 0)).toBe(30_000)
  })
})

describe('findStampTrigger', () => {
  const at = (s: string) => findStampTrigger(s.replace('|', ''), s.indexOf('|'))
  test('opens on <t:', () => {
    expect(at('see <t:|')).toEqual({ start: 4, end: 7, seconds: null })
    expect(at('<t:123|')).toEqual({ start: 0, end: 6, seconds: 123 })
    expect(at('<t:123:|')).toEqual({ start: 0, end: 7, seconds: 123 })
    expect(at('<t:123:R|')).toEqual({ start: 0, end: 8, seconds: 123 })
  })
  test('not elsewhere', () => {
    expect(at('<t|')).toBeNull()
    expect(at('<t:123>|')).toBeNull()
    expect(at('`<t:|')).toBeNull()
    expect(at('<t:x|')).toBeNull()
  })
})

test('stampChoices gives every style', () => {
  const list = stampChoices(T, MS, o)
  expect(list.map(c => c.style)).toEqual([...STYLES])
  expect(list[0]).toEqual({ style: 't', token: `<t:${T}:t>`, preview: '4:20 PM' })
  expect(list[6].preview).toBe('now')
})

describe('messageTime across daylight saving', () => {
  const ny = { locale: 'en-US', timeZone: 'America/New_York' }
  test('yesterday is the previous calendar day on a 23h day', () => {
    const now = Date.parse('2026-03-08T20:00:00-04:00')
    const ms = Date.parse('2026-03-07T23:30:00-05:00')
    expect(messageTime(ms, now, ny)).toBe('Yesterday at 11:30 PM')
  })
  test('yesterday is the previous calendar day on a 25h day', () => {
    const now = Date.parse('2026-11-01T00:30:00-04:00')
    const ms = Date.parse('2026-10-31T00:10:00-04:00')
    expect(messageTime(ms, now, ny)).toBe('Yesterday at 12:10 AM')
  })
  test('two days back is a date', () => {
    const now = Date.parse('2026-11-02T00:30:00-05:00')
    const ms = Date.parse('2026-10-31T23:00:00-04:00')
    expect(messageTime(ms, now, ny)).toBe('10/31/2026 11:00 PM')
  })
})

describe('acceptStamp', () => {
  test('swallows the closing bracket of a partly typed token', () => {
    const text = 'at <t:123:> ok'
    const trigger = findStampTrigger(text, 10)!
    expect(trigger === null).toBe(false)
    const out = acceptStamp(text, trigger, '<t:123:F>')
    expect(out.text).toBe('at <t:123:F> ok')
    expect(out.caret).toBe(12)
  })
  test('partly typed token at the end gets a space', () => {
    const text = '<t:123:'
    const out = acceptStamp(text, findStampTrigger(text, 7)!, '<t:123:R>')
    expect(out.text).toBe('<t:123:R> ')
    expect(out.caret).toBe(10)
  })
})
