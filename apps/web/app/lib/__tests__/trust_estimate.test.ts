import { describe, expect, test } from 'bun:test'
import {
  MAX_WORK,
  QUIET_MS,
  RATES,
  SLOW_CONFIRM_MS,
  estimateMs,
  needsConfirm,
  rateFrom,
  showsProgress,
  tooMuchWork,
  words,
} from '../trust/estimate'

describe('estimateMs', () => {
  test('is the work over what the threads try in a second', () => {
    expect(estimateMs(1_048_576, 5_000_000, 4)).toBe(52)
    expect(estimateMs(1_048_576, 1_500_000, 4)).toBe(175)
    expect(estimateMs(1_048_576, 500_000, 4)).toBe(524)
    expect(estimateMs(8_388_608, 500_000, 4)).toBe(4194)
    expect(estimateMs(1_048_576, RATES.slowPhone, 1)).toBe(2097)
  })

  test('no threads counts as one, and no rate has no estimate', () => {
    expect(estimateMs(1_000_000, 1_000_000, 0)).toBe(1000)
    expect(estimateMs(1_000_000, 0, 4)).toBe(Infinity)
    expect(estimateMs(0, 1_000_000, 4)).toBe(0)
  })
})

describe('rateFrom', () => {
  test('is tries per second', () => {
    expect(rateFrom(65_536, 13)).toBe(5_041_231)
    expect(rateFrom(1_000_000, 2000)).toBe(500_000)
    expect(rateFrom(1000, 0)).toBe(0)
    expect(rateFrom(0, 50)).toBe(0)
  })
})

describe('words', () => {
  test('says a time, at each boundary', () => {
    const table: [number, string][] = [
      [0, 'under a second'],
      [999, 'under a second'],
      [1000, 'about 1 second'],
      [1499, 'about 1 second'],
      [1500, 'about 2 seconds'],
      [2600, 'about 3 seconds'],
      [59_499, 'about 59 seconds'],
      [59_500, 'about 1 minute'],
      [89_999, 'about 1 minute'],
      [90_000, 'about 2 minutes'],
      [120_000, 'about 2 minutes'],
      [3_569_999, 'about 59 minutes'],
      [3_570_000, 'about 1 hour'],
      [7_200_000, 'about 2 hours'],
      [Infinity, 'a long time'],
      [NaN, 'a long time'],
    ]
    for (const [ms, text] of table) expect(words(ms)).toBe(text)
  })

  test('never shows a number of tries', () => {
    for (const work of [1024, 1_048_576, 8_388_608, 33_554_432, 2 ** 32]) {
      const text = words(estimateMs(work, RATES.phone, 4))
      expect(text.includes(String(work))).toBe(false)
      expect(/^(under a second|about \d{1,2} (second|minute|hour)s?|a long time)$/.test(text)).toBe(
        true
      )
    }
  })
})

describe('what a solve shows', () => {
  test('nothing under 1.5 s, a question past 30 s', () => {
    expect(QUIET_MS).toBe(1500)
    expect(SLOW_CONFIRM_MS).toBe(30_000)
    expect(showsProgress(1499)).toBe(false)
    expect(showsProgress(1500)).toBe(true)
    expect(needsConfirm(30_000)).toBe(false)
    expect(needsConfirm(30_001)).toBe(true)
    expect(needsConfirm(Infinity)).toBe(true)
  })

  test('a single solve is capped at 2^32 tries', () => {
    expect(MAX_WORK).toBe(4_294_967_296)
    expect(tooMuchWork(MAX_WORK)).toBe(false)
    expect(tooMuchWork(MAX_WORK + 1)).toBe(true)
    expect(tooMuchWork(NaN)).toBe(true)
  })
})
