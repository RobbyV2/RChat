import { describe, expect, test } from 'bun:test'
import { dayNum } from '../fx/astro'
import {
  SEASONS,
  SEASON_IDS,
  activeSeasons,
  accentGlyph,
  hemisphereOf,
  localToday,
  nextSeason,
  rainPlan,
  type SeasonId,
} from '../fx/seasons'

const ids = (y: number, m: number, d: number, h: 'north' | 'south' = 'north') =>
  activeSeasons(dayNum(y, m, d), h).map(a => a.season.id)

describe('month-long seasons (owner, 2026-11-09)', () => {
  test('Halloween is every day of October and nothing either side', () => {
    for (let d = 1; d <= 31; d++) expect(ids(2026, 10, d)).toContain('halloween')
    expect(ids(2026, 9, 30)).not.toContain('halloween')
    expect(ids(2026, 11, 1)).not.toContain('halloween')
  })
  test('Christmas is every day of December', () => {
    for (let d = 1; d <= 31; d++) expect(ids(2026, 12, d)).toContain('christmas')
    expect(ids(2026, 11, 30)).not.toContain('christmas')
    expect(ids(2027, 1, 1)).not.toContain('christmas')
  })
  test('Thanksgiving: Monday of the week before through the Sunday after', () => {
    // US Thanksgiving 2026 is 26 November.
    expect(ids(2026, 11, 15)).not.toContain('thanksgiving')
    for (let d = 16; d <= 29; d++) expect(ids(2026, 11, d)).toContain('thanksgiving')
    expect(ids(2026, 11, 30)).not.toContain('thanksgiving')
    // 2028: 23 November.
    expect(ids(2028, 11, 13)).toContain('thanksgiving')
    expect(ids(2028, 11, 26)).toContain('thanksgiving')
    expect(ids(2028, 11, 27)).not.toContain('thanksgiving')
  })
})

describe('specificity and mixing', () => {
  test('New Year spans the year line and outranks Christmas', () => {
    expect(ids(2026, 12, 31).slice(0, 2)).toEqual(['new_year', 'christmas'])
    expect(ids(2027, 1, 1)[0]).toBe('new_year')
    const plan = rainPlan(activeSeasons(dayNum(2026, 12, 31), 'north'))!
    expect(plan.ids).toEqual(['new_year', 'christmas'])
    expect(plan.motion).toBe('burst')
    expect(plan.glyphs.slice(0, 4)).toEqual(['🎆', '🎄', '🎇', '❄️'])
  })
  test('Hanukkah mixes with Christmas', () => {
    // 25 Kislev 5787 = 5 December 2026; the first candle on the evening of the 4th.
    expect(ids(2026, 12, 3)).not.toContain('hanukkah')
    expect(ids(2026, 12, 4).slice(0, 2)).toEqual(['hanukkah', 'christmas'])
    expect(ids(2026, 12, 12)).toContain('hanukkah')
    expect(ids(2026, 12, 13)).not.toContain('hanukkah')
  })
  test('Diwali 2026 and Halloween stay apart; Diwali on 9 November 2026', () => {
    expect(ids(2026, 11, 8)).toContain('diwali')
    expect(accentGlyph(activeSeasons(dayNum(2026, 11, 8), 'north'))).toBe('🪔')
  })
  test('a day without seasons has no plan', () => {
    expect(rainPlan(activeSeasons(dayNum(2026, 8, 5), 'north'))).toBeNull()
  })
  test('April Fools does not rain', () => {
    expect(ids(2027, 4, 1)).toContain('april_fools')
    expect(rainPlan(activeSeasons(dayNum(2027, 4, 1), 'north'))?.ids ?? []).not.toContain(
      'april_fools'
    )
  })
  test('turning a season off removes it', () => {
    const off = new Set<SeasonId>(['christmas'])
    expect(activeSeasons(dayNum(2026, 12, 15), 'north', off).map(a => a.season.id)).toEqual([])
  })
})

describe('computed dates', () => {
  test('Lunar New Year 2027 (Goat): 5 to 20 February', () => {
    expect(ids(2027, 2, 4)).not.toContain('lunar_new_year')
    expect(ids(2027, 2, 5)).toContain('lunar_new_year')
    expect(ids(2027, 2, 20)).toContain('lunar_new_year')
    expect(ids(2027, 2, 21)).not.toContain('lunar_new_year')
    const a = activeSeasons(dayNum(2027, 2, 6), 'north').find(
      x => x.season.id === 'lunar_new_year'
    )!
    expect(a.glyphs).toContain('🐐')
  })
  test('shorter windows outrank longer ones: 14 February 2029', () => {
    // Valentine's (1 day), Eid al-Fitr 2029 (3 days from 14 Feb) and Lunar New Year (13 Feb,
    // 16 days) all meet; the rain mixes the first two.
    expect(ids(2029, 2, 14).slice(0, 3)).toEqual(['valentines', 'eid_al_fitr', 'lunar_new_year'])
    expect(rainPlan(activeSeasons(dayNum(2029, 2, 14), 'north'))!.ids).toEqual([
      'valentines',
      'eid_al_fitr',
    ])
  })
  test('Easter 2026: western 3-6 April, orthodox 10-13 April', () => {
    expect(ids(2026, 4, 3)).toContain('easter')
    expect(ids(2026, 4, 6)).toContain('easter')
    expect(ids(2026, 4, 8)).not.toContain('easter')
    expect(ids(2026, 4, 12)).toContain('easter')
  })
  test('Holi 2026: 3-4 March', () => {
    expect(ids(2026, 3, 4)).toContain('holi')
  })
  test('Mid-Autumn 2026: 25 September, plus a day either side', () => {
    expect(ids(2026, 9, 24)).toContain('mid_autumn')
    expect(ids(2026, 9, 26)).toContain('mid_autumn')
    expect(ids(2026, 9, 27)).not.toContain('mid_autumn')
  })
  test('Mid-Autumn 2052 is in the regular 8th month (7 September), not the leap one', () => {
    expect(ids(2052, 9, 6)).toContain('mid_autumn')
    expect(ids(2052, 9, 8)).toContain('mid_autumn')
    expect(ids(2052, 10, 7)).not.toContain('mid_autumn')
  })
  test('Friday the 13th', () => {
    expect(ids(2026, 11, 13)).toContain('friday_13')
    expect(ids(2026, 12, 13)).not.toContain('friday_13')
  })
  test('leap day only in leap years', () => {
    expect(ids(2028, 2, 29)).toContain('leap_day')
    expect(SEASONS.find(s => s.id === 'leap_day')!.windows(2027)).toEqual([])
  })
})

describe('hemispheres', () => {
  test('time zones', () => {
    expect(hemisphereOf('Australia/Sydney')).toBe('south')
    expect(hemisphereOf('America/Argentina/Buenos_Aires')).toBe('south')
    expect(hemisphereOf('Pacific/Auckland')).toBe('south')
    expect(hemisphereOf('America/New_York')).toBe('north')
    expect(hemisphereOf('Europe/London')).toBe('north')
    expect(hemisphereOf('UTC')).toBe('north')
    expect(hemisphereOf(undefined)).toBe('north')
  })
  test('the south gets autumn in March and summer at Christmas', () => {
    const march = activeSeasons(dayNum(2027, 3, 20), 'south').find(
      a => a.season.id === 'march_equinox'
    )!
    expect(march.glyphs).toContain('🍂')
    const xmas = activeSeasons(dayNum(2026, 12, 10), 'south').find(
      a => a.season.id === 'christmas'
    )!
    expect(xmas.glyphs).toContain('☀️')
    expect(xmas.glyphs).not.toContain('❄️')
  })
})

describe('table health', () => {
  test('every season has an occurrence in every year 2024-2060 (leap day in leap years)', () => {
    for (let y = 2024; y <= 2060; y++)
      for (const s of SEASONS) {
        const n = s.windows(y).length
        if (s.id === 'leap_day') expect(n).toBe(y % 4 === 0 ? 1 : 0)
        else expect([s.id, y, n > 0]).toEqual([s.id, y, true])
      }
  })
  test('windows are ordered and at most 31 days', () => {
    for (let y = 2024; y <= 2060; y++)
      for (const s of SEASONS)
        for (const [a, b] of s.windows(y)) {
          expect(b).toBeGreaterThanOrEqual(a)
          expect(b - a).toBeLessThanOrEqual(30)
        }
  })
  test('ids are unique and glyph lists short', () => {
    expect(new Set(SEASON_IDS).size).toBe(SEASON_IDS.length)
    expect(SEASONS.map(s => s.id)).toEqual([...SEASON_IDS])
    for (const s of SEASONS) {
      const g = s.glyphs('north', 2026)
      expect(g.length).toBeGreaterThan(0)
      expect(g.length).toBeLessThanOrEqual(8)
    }
  })
  test('a whole year of lookups stays fast (the app caches per day anyway)', () => {
    const t = performance.now()
    for (let d = 0; d < 366; d++) activeSeasons(dayNum(2026, 1, 1) + d, 'north')
    expect(performance.now() - t).toBeLessThan(500)
  })
})

describe('clock', () => {
  test('next season and next midnight', () => {
    expect(nextSeason(dayNum(2026, 11, 9), 'north')?.season.id).toBe('friday_13')
    const { msToNext } = localToday(new Date(2026, 10, 9, 23, 59, 30))
    expect(msToNext).toBe(31_000)
  })
})

describe('the named seasons on their own days', () => {
  const named: [SeasonId, number, number, string][] = [
    ['halloween', 10, 31, '🎃'],
    ['christmas', 12, 24, '🎄'],
    ['christmas', 12, 25, '🎄'],
  ]
  test('31 Oct and 24-25 Dec, 2024-2060: first, in the rain, and the empty-state glyph', () => {
    for (let y = 2024; y <= 2060; y++)
      for (const [id, m, d, glyph] of named) {
        const active = activeSeasons(dayNum(y, m, d), 'north')
        expect([y, m, d, active[0].season.id]).toEqual([y, m, d, id])
        expect([y, m, d, rainPlan(active)!.ids.includes(id)]).toEqual([y, m, d, true])
        expect([y, m, d, accentGlyph(active)]).toEqual([y, m, d, glyph])
      }
  })
  test('every day of October and December keeps its season in the rain', () => {
    for (let y = 2024; y <= 2060; y++)
      for (const [id, m, days] of [
        ['halloween', 10, 31],
        ['christmas', 12, 31],
      ] as const)
        for (let d = 1; d <= days; d++) {
          const plan = rainPlan(activeSeasons(dayNum(y, m, d), 'north'))!
          expect([y, m, d, plan.ids.includes(id)]).toEqual([y, m, d, true])
        }
  })
  test('a solstice never gives the empty-state glyph while a celebration is on', () => {
    for (let y = 2024; y <= 2060; y++)
      for (let d = 1; d <= 31; d++) {
        const active = activeSeasons(dayNum(y, 12, d), 'north')
        const lead = active.find(a => a.glyphs[0] === accentGlyph(active))!
        expect([y, d, lead.season.minor === true]).toEqual([y, d, false])
      }
  })
  test('the south keeps the tree too', () => {
    const active = activeSeasons(dayNum(2027, 12, 24), 'south')
    expect(accentGlyph(active)).toBe('🎄')
  })
})

describe('Eid windows end a day later', () => {
  test('Eid al-Adha 2026 is observed 27-30 May; 2028 from 5 May', () => {
    for (const d of [27, 28, 29, 30]) expect(ids(2026, 5, d)).toContain('eid_al_adha')
    for (const d of [5, 6, 7, 8]) expect(ids(2028, 5, d)).toContain('eid_al_adha')
  })
  test('Eid al-Fitr 2027 (9 or 10 March) and 2028 (26 February), with the last day', () => {
    for (const d of [9, 10, 11, 12]) expect(ids(2027, 3, d)).toContain('eid_al_fitr')
    for (const d of [26, 27, 28]) expect(ids(2028, 2, d)).toContain('eid_al_fitr')
  })
})
