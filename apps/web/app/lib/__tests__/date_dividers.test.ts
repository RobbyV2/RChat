import { beforeEach, describe, expect, test } from 'bun:test'
import { dayLines, dayStarts, formatDateBanner, localDayKey, sameDay } from '../date_dividers'
import { continues } from '../message_groups'

beforeEach(() => {
  process.env.TZ = 'America/New_York'
})

// Seconds of a local wall-clock time in the zone under test.
const at = (y: number, mo: number, d: number, h = 12, mi = 0) =>
  new Date(y, mo - 1, d, h, mi).getTime() / 1000

describe('local days', () => {
  test('a day key is the local calendar day, not the UTC one', () => {
    expect(localDayKey(at(2026, 11, 24, 23, 30) * 1000)).toBe('2026-11-24')
    expect(localDayKey(at(2026, 11, 25, 0, 5) * 1000)).toBe('2026-11-25')
    expect(localDayKey(at(2026, 1, 3) * 1000)).toBe('2026-01-03')
  })

  test('two times are on the same day only before local midnight', () => {
    expect(sameDay(at(2026, 11, 24, 0, 1), at(2026, 11, 24, 23, 59))).toBe(true)
    expect(sameDay(at(2026, 11, 24, 23, 59), at(2026, 11, 25, 0, 0))).toBe(false)
  })

  test('the banner spells out the weekday and the date', () => {
    expect(formatDateBanner(at(2026, 11, 24) * 1000, 'en-US')).toBe('Tuesday, November 24, 2026')
  })
})

describe('which rows start a day', () => {
  test('the first row and each change of day', () => {
    const times = [
      at(2026, 11, 23, 22),
      at(2026, 11, 23, 23, 50),
      at(2026, 11, 24, 0, 10),
      at(2026, 11, 24, 9),
      at(2026, 11, 27, 9),
    ]
    expect([...dayStarts(times)]).toEqual([0, 2, 4])
  })

  test('a row above the list on the same day takes the first line away', () => {
    const times = [at(2026, 11, 24, 10), at(2026, 11, 25, 10)]
    expect([...dayStarts(times, at(2026, 11, 24, 8))]).toEqual([1])
    expect([...dayStarts(times, at(2026, 11, 23, 8))]).toEqual([0, 1])
    expect([...dayStarts([])]).toEqual([])
  })

  test('folded rows are skipped, and the next shown row compares with the last line', () => {
    const times = [at(2026, 11, 23), at(2026, 11, 24), at(2026, 11, 25), at(2026, 11, 25, 18)]
    expect([...dayLines(times, [true, true, false, true])]).toEqual([0, 1, 3])
    expect([...dayLines(times, [true, false, false, true])]).toEqual([0, 3])
    expect([...dayLines(times, [false, false, false, false])]).toEqual([])
  })

  test('messages on two days never share a group', () => {
    const cue = (t: number) => ({ who: 'alice', at: t, head: false, end: false })
    expect(continues(cue(at(2026, 11, 24, 23, 58)), cue(at(2026, 11, 25, 0, 1)))).toBe(false)
    expect(continues(cue(at(2026, 11, 24, 23, 50)), cue(at(2026, 11, 24, 23, 55)))).toBe(true)
  })
})
