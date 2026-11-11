import { describe, expect, test } from 'bun:test'
import hko from './fixtures/fx_hko.json'
import {
  dayAt,
  dayNum,
  diwaliNewMoon,
  easter,
  fromDayNum,
  hanukkah,
  holiFullMoon,
  islamicStartsIn,
  nthWeekday,
  orthodoxEaster,
  phasesBetween,
  solarTermMs,
  ymdKey,
} from '../fx/astro'

const key = (n: number) => ymdKey(fromDayNum(n))
const CHINA = 480

describe('moon phases', () => {
  test('every HKO lunar month 2024-2060 starts on the computed new moon date in China', () => {
    const want = new Set(hko.monthStarts)
    const from = Date.UTC(2024, 0, 1) - CHINA * 60_000
    const to = Date.UTC(2061, 0, 1) - CHINA * 60_000
    // The model is good to about a minute: a new moon that close to midnight in China may land
    // on the other date (once in 458 months: 2057-09-28 23:59).
    const near = (ms: number) => {
      const m = (ms + CHINA * 60_000) % 86_400_000
      return m < 300_000 || m > 86_400_000 - 300_000
    }
    const phases = phasesBetween(from, to, 0)
    const got = phases.map(ms => key(dayAt(ms, CHINA)))
    const miss = phases
      .filter((ms, i) => !want.has(got[i]) && !near(ms))
      .map(ms => key(dayAt(ms, CHINA)))
    const fuzzy = phases.filter((ms, i) => !want.has(got[i]) && near(ms))
    const extra = hko.monthStarts.filter(d => !got.includes(d) && d >= '2024-01-11')
    expect(miss).toEqual([])
    expect(fuzzy.length).toBeLessThanOrEqual(1)
    expect(extra.length).toBe(fuzzy.length)
  })
})

describe('solar terms', () => {
  const names = ['Vernal Equinox', 'Summer Solstice', 'Autumnal Equinox', 'Winter Solstice']
  test('every HKO equinox and solstice 2024-2060 matches in China', () => {
    const terms = hko.terms as Record<string, string>
    let n = 0
    for (let y = 2024; y <= 2060; y++)
      for (const w of [0, 1, 2, 3] as const) {
        const want = terms[`${y} ${names[w]}`]
        expect(key(dayAt(solarTermMs(y, w), CHINA))).toBe(want)
        n++
      }
    expect(n).toBe(148)
  })
})

describe('Easter', () => {
  test('western and orthodox Sundays', () => {
    const cases: [number, string, string][] = [
      [2024, '2024-03-31', '2024-05-05'],
      [2025, '2025-04-20', '2025-04-20'],
      [2026, '2026-04-05', '2026-04-12'],
      [2027, '2027-03-28', '2027-05-02'],
      [2028, '2028-04-16', '2028-04-16'],
      [2038, '2038-04-25', '2038-04-25'],
    ]
    for (const [y, w, o] of cases) {
      expect(key(easter(y))).toBe(w)
      expect(key(orthodoxEaster(y))).toBe(o)
    }
  })
  test('always a Sunday between 22 March and 25 April', () => {
    for (let y = 2024; y <= 2100; y++) {
      const e = easter(y)
      expect(new Date(e * 86_400_000).getUTCDay()).toBe(0)
      expect(e).toBeGreaterThanOrEqual(dayNum(y, 3, 22))
      expect(e).toBeLessThanOrEqual(dayNum(y, 4, 25))
    }
  })
})

describe('Thanksgiving', () => {
  test('US: fourth Thursday of November', () => {
    const want: Record<number, string> = {
      2024: '2024-11-28',
      2025: '2025-11-27',
      2026: '2026-11-26',
      2027: '2027-11-25',
      2028: '2028-11-23',
      2029: '2029-11-22',
    }
    for (const [y, d] of Object.entries(want)) expect(key(nthWeekday(+y, 11, 4, 4))).toBe(d)
  })
})

describe('Hanukkah', () => {
  const hebrew = new Intl.DateTimeFormat('en-u-ca-hebrew', {
    timeZone: 'UTC',
    month: 'long',
    day: 'numeric',
  })
  test('25 Kislev matches the Intl Hebrew calendar 2024-2100', () => {
    for (let y = 2024; y <= 2100; y++) {
      const n = hanukkah(y)
      const parts = Object.fromEntries(
        hebrew.formatToParts(new Date(n * 86_400_000)).map(p => [p.type, p.value])
      )
      expect(`${y} ${parts.day} ${parts.month}`).toBe(`${y} 25 Kislev`)
    }
  })
  test('published first days', () => {
    expect(key(hanukkah(2024))).toBe('2024-12-26')
    expect(key(hanukkah(2025))).toBe('2025-12-15')
    expect(key(hanukkah(2026))).toBe('2026-12-05')
  })
})

describe('Eid', () => {
  // Saudi announcements: Eid al-Fitr 2024-04-10, 2025-03-30, 2026-03-20; Eid al-Adha
  // 2024-06-16, 2025-06-06, 2026-05-27. The window is [start, start + 2] for al-Fitr and
  // [start, start + 3] for al-Adha, start = the new moon's date at Mecca + 1 (+ 9 for al-Adha).
  test('the observed first day falls inside the window', () => {
    const fitr: [number, string][] = [
      [2024, '2024-04-10'],
      [2025, '2025-03-30'],
      [2026, '2026-03-20'],
    ]
    for (const [y, d] of fitr) {
      const [s] = islamicStartsIn(y, 10)
      expect(dayNum(+d.slice(0, 4), +d.slice(5, 7), +d.slice(8))).toBeGreaterThanOrEqual(s)
      expect(dayNum(+d.slice(0, 4), +d.slice(5, 7), +d.slice(8))).toBeLessThanOrEqual(s + 2)
    }
    const adha: [number, string][] = [
      [2024, '2024-06-16'],
      [2025, '2025-06-06'],
      [2026, '2026-05-27'],
    ]
    for (const [y, d] of adha) {
      const [s] = islamicStartsIn(y, 12)
      const n = dayNum(+d.slice(0, 4), +d.slice(5, 7), +d.slice(8))
      expect(n).toBeGreaterThanOrEqual(s + 9)
      expect(n).toBeLessThanOrEqual(s + 9 + 3)
    }
  })
  test('two Eids al-Fitr in 2033 and one in 2034', () => {
    expect(islamicStartsIn(2033, 10).length).toBe(2)
    expect(islamicStartsIn(2034, 10).length).toBe(1)
  })
})

describe('Diwali and Holi', () => {
  // Majority dates from testbook, Drik Panchang, dekhopanchang and calendar-yearly (searched
  // 2026-11-09). Diwali's window is new moon - 2 .. + 2; Holi's is full moon .. + 1.
  test('Diwali main day inside the window', () => {
    const want: Record<number, string> = {
      2025: '2025-10-20',
      2026: '2026-11-08',
      2027: '2027-10-29',
      2028: '2028-10-17',
      2029: '2029-11-05',
      2030: '2030-10-26',
      2031: '2031-11-14',
      2032: '2032-11-02',
      2033: '2033-10-22',
      2034: '2034-11-10',
      2035: '2035-10-30',
    }
    for (const [y, d] of Object.entries(want)) {
      const nm = diwaliNewMoon(+y)
      const n = dayNum(+d.slice(0, 4), +d.slice(5, 7), +d.slice(8))
      expect([y, n - nm >= -2 && n - nm <= 2]).toEqual([y, true])
    }
  })
  test('Rangwali Holi inside the window', () => {
    const want: Record<number, string> = {
      2025: '2025-03-14',
      2026: '2026-03-04',
      2027: '2027-03-22',
      2028: '2028-03-11',
      2029: '2029-03-01',
      2030: '2030-03-20',
      2031: '2031-03-09',
      2032: '2032-03-27',
      2033: '2033-03-16',
    }
    for (const [y, d] of Object.entries(want)) {
      const fm = holiFullMoon(+y)
      const n = dayNum(+d.slice(0, 4), +d.slice(5, 7), +d.slice(8))
      expect([y, n - fm >= 0 && n - fm <= 1]).toEqual([y, true])
    }
  })
})
