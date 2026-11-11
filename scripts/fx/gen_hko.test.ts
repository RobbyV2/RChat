import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  HKO_FIRST,
  HKO_LAST,
  LUNAR_NEW_YEAR,
  MID_AUTUMN,
} from '../../apps/web/app/lib/fx/hko_table'
import { TABLE, VECTOR, build, parseYear, readTables, tableText, vectorText } from './gen_hko'

// Excerpts of the Hong Kong Observatory's tables for 2051-2053 (header, first and last rows, every
// lunar month start and every solar term). 2052 has a leap 8th month.
const dir = join(import.meta.dir, 'fixtures')
const excerpt = (year: number) => readFileSync(join(dir, `T${year}e.txt`), 'utf8')

describe('one year of the table', () => {
  test('lunar month starts, with the leap month marked', () => {
    const { months } = parseYear(excerpt(2052))
    expect(months).toHaveLength(13)
    expect(months[0]).toEqual({ day: '2052-01-02', month: 12, leap: false })
    expect(months.filter(m => m.month === 8)).toEqual([
      { day: '2052-08-24', month: 8, leap: false },
      { day: '2052-09-23', month: 8, leap: true },
    ])
    expect(parseYear(excerpt(2051)).months.some(m => m.leap)).toBe(false)
  })

  test('only equinoxes and solstices are kept from the solar terms', () => {
    expect(parseYear(excerpt(2052)).terms).toEqual({
      'Vernal Equinox': '2052-03-20',
      'Summer Solstice': '2052-06-20',
      'Autumnal Equinox': '2052-09-22',
      'Winter Solstice': '2052-12-21',
    })
  })

  test('headers, plain days and Windows line ends are read the same', () => {
    const text = [
      'Gregorian-Lunar Calendar Conversion Table of 2030 (Geng-xu  -  year of the Dog)',
      'Gregorian date    Lunar date              Day-of-week    Solar terms',
      '2030/2/2          30                      Saturday                           ',
      '2030/2/3          1st Lunar Month         Sunday                             ',
      '2030/2/4          2                       Monday         Spring Commences    ',
      '2030/3/20         17                      Wednesday      Vernal Equinox      ',
      '',
    ]
    const want = {
      months: [{ day: '2030-02-03', month: 1, leap: false }],
      terms: { 'Vernal Equinox': '2030-03-20' },
    }
    expect(parseYear(text.join('\n'))).toEqual(want)
    expect(parseYear(text.join('\r\n'))).toEqual(want)
  })
})

describe('the generated tables', () => {
  const built = build({ 2051: excerpt(2051), 2052: excerpt(2052), 2053: excerpt(2053) })

  test('Lunar New Year is the first day of the 1st month', () => {
    expect(built.first).toBe(2051)
    expect(built.last).toBe(2053)
    expect(built.lunarNewYear).toEqual({
      2051: '2051-02-11',
      2052: '2052-02-01',
      2053: '2053-02-19',
    })
  })

  test('Mid-Autumn is the 15th of the 8th month, never of a leap 8th month', () => {
    expect(built.midAutumn).toEqual({
      2051: '2051-09-19',
      2052: '2052-09-07',
      2053: '2053-09-26',
    })
  })

  test('month starts and terms match the committed test vector for those years', () => {
    const vector = JSON.parse(readFileSync(VECTOR, 'utf8')) as {
      monthStarts: string[]
      terms: Record<string, string>
    }
    const inRange = (day: string) => day >= '2051' && day < '2054'
    expect(built.monthStarts).toEqual(vector.monthStarts.filter(inRange))
    expect(built.terms).toEqual(
      Object.fromEntries(Object.entries(vector.terms).filter(([name]) => inRange(name)))
    )
  })

  test('years must be consecutive and complete', () => {
    expect(() => build({ 2051: excerpt(2051), 2053: excerpt(2053) })).toThrow('2052')
    expect(() => build({})).toThrow('no tables')
    const noNewYear = excerpt(2051).replace('1st Lunar Month', '2nd Lunar Month')
    expect(() => build({ 2051: noNewYear })).toThrow('2051')
    expect(() => build({ 2051: excerpt(2052) })).toThrow('2051')
  })

  test('tables are read from T<year>e.txt files', () => {
    expect(Object.keys(readTables(dir))).toEqual(['2051', '2052', '2053'])
  })
})

describe('the committed files', () => {
  test('the season table is in the form the generator writes', () => {
    expect(
      tableText({
        first: HKO_FIRST,
        last: HKO_LAST,
        lunarNewYear: LUNAR_NEW_YEAR,
        midAutumn: MID_AUTUMN,
      })
    ).toBe(readFileSync(TABLE, 'utf8'))
  })

  test('and so is the test vector', () => {
    const text = readFileSync(VECTOR, 'utf8')
    expect(vectorText(JSON.parse(text))).toBe(text)
  })

  test('the table holds a day for every year, and the regular 8th month of 2052', () => {
    for (let y = HKO_FIRST; y <= HKO_LAST; y++) {
      expect([y, LUNAR_NEW_YEAR[y]?.slice(0, 4)]).toEqual([y, String(y)])
      expect([y, MID_AUTUMN[y]?.slice(0, 4)]).toEqual([y, String(y)])
    }
    expect(MID_AUTUMN[2052]).toBe('2052-09-07')
  })
})
