import { describe, expect, test } from 'bun:test'
import {
  channelShapes,
  dmShapes,
  memberShapes,
  messageShapes,
  railShapes,
  rowShapes,
  seeded,
} from '../skeletons'

const KEYS = Array.from({ length: 200 }, (_, i) => `k${i}`)

const within = (n: number, lo: number, hi: number) => {
  expect(n).toBeGreaterThanOrEqual(lo)
  expect(n).toBeLessThanOrEqual(hi)
  expect(Number.isInteger(n)).toBe(true)
}

describe('seeded numbers', () => {
  test('a key gives the same numbers every time, in [0, 1)', () => {
    const a = seeded('c12')
    const b = seeded('c12')
    const first = Array.from({ length: 50 }, a)
    expect(Array.from({ length: 50 }, b)).toEqual(first)
    for (const n of first) {
      expect(n).toBeGreaterThanOrEqual(0)
      expect(n).toBeLessThan(1)
    }
  })

  test('different keys give different numbers', () => {
    const a = Array.from({ length: 5 }, seeded('c12'))
    expect(Array.from({ length: 5 }, seeded('c13'))).not.toEqual(a)
    expect(Array.from({ length: 5 }, seeded(''))).not.toEqual(a)
  })
})

describe('placeholder shapes', () => {
  test('each kind is the same for the same key and varies between keys', () => {
    const kinds = [
      (k: string) => messageShapes(k),
      (k: string) => memberShapes(k),
      (k: string) => channelShapes(k),
      (k: string) => dmShapes(k),
      (k: string) => railShapes(k),
      (k: string) => rowShapes(k, 3),
    ]
    for (const shapes of kinds) {
      expect(shapes('d7')).toEqual(shapes('d7'))
      expect(new Set(KEYS.map(k => JSON.stringify(shapes(k)))).size).toBeGreaterThan(50)
    }
  })

  test('messages: 6 to 9 groups of 1 to 4 lines, the last line shortest, some with a card', () => {
    let cards = 0
    let tall = 0
    const lines = new Set<number>()
    for (const key of KEYS) {
      const groups = messageShapes(key)
      within(groups.length, 6, 9)
      for (const g of groups) {
        within(g.name, 64, 140)
        within(g.time, 36, 56)
        within(g.lines.length, 1, 4)
        lines.add(g.lines.length)
        for (const w of g.lines) within(w, 35, 92)
        if (g.lines.length > 1)
          expect(g.lines.at(-1)!).toBeLessThan(Math.min(...g.lines.slice(0, -1)))
        if (g.media) {
          cards += 1
          if (g.media.h > g.media.w) tall += 1
          within(g.media.w, 160, 290)
          within(g.media.h, 96, 250)
        }
      }
    }
    expect([...lines].sort()).toEqual([1, 2, 3, 4])
    const groups = KEYS.reduce((n, k) => n + messageShapes(k).length, 0)
    expect(cards / groups).toBeGreaterThan(0.18)
    expect(cards / groups).toBeLessThan(0.38)
    expect(tall).toBeGreaterThan(0)
    expect(tall).toBeLessThan(cards)
  })

  test('messages without cards keep the same text shapes', () => {
    for (const key of KEYS.slice(0, 20)) {
      const plain = messageShapes(key, false)
      expect(plain.every(g => g.media === null)).toBe(true)
      expect(plain.map(g => g.lines)).toEqual(messageShapes(key).map(g => g.lines))
    }
  })

  test('members: 2 or 3 sections of at least 2, 8 to 12 rows in all, a few pills', () => {
    let pills = 0
    let rows = 0
    for (const key of KEYS) {
      const sections = memberShapes(key)
      within(sections.length, 2, 3)
      within(
        sections.reduce((n, s) => n + s.length, 0),
        8,
        12
      )
      for (const s of sections) {
        expect(s.length).toBeGreaterThanOrEqual(2)
        for (const m of s) {
          rows += 1
          within(m.name, 45, 80)
          if (m.pill !== null) {
            pills += 1
            within(m.pill, 30, 44)
          }
        }
      }
    }
    expect(pills).toBeGreaterThan(0)
    expect(pills / rows).toBeLessThan(0.35)
  })

  test('channels: 2 or 3 categories, at most 2 channels above them, 6 to 10 in all', () => {
    let loose = 0
    for (const key of KEYS) {
      const groups = channelShapes(key)
      const headed = groups.filter(g => g.header)
      within(headed.length, 2, 3)
      expect(groups.slice(1).every(g => g.header)).toBe(true)
      if (!groups[0].header) {
        loose += 1
        within(groups[0].rows.length, 1, 2)
      }
      within(
        groups.reduce((n, g) => n + g.rows.length, 0),
        6,
        10
      )
      for (const g of headed) expect(g.rows.length).toBeGreaterThanOrEqual(1)
      for (const g of groups) for (const w of g.rows) within(w, 40, 78)
    }
    expect(loose).toBeGreaterThan(0)
    expect(loose).toBeLessThan(KEYS.length)
  })

  test('direct messages: 6 to 8 rows or the count asked for, some with a preview line', () => {
    let previews = 0
    for (const key of KEYS) {
      const rows = dmShapes(key)
      within(rows.length, 6, 8)
      for (const d of rows) {
        within(d.name, 45, 75)
        if (d.preview !== null) {
          previews += 1
          within(d.preview, 30, 55)
        }
      }
    }
    expect(previews).toBeGreaterThan(0)
    expect(dmShapes('p2p', 3)).toHaveLength(3)
  })

  test('rail: 5 to 7 tiles, or 2 to 3 when few, some round', () => {
    let round = 0
    for (const key of KEYS) {
      within(railShapes(key).length, 5, 7)
      within(railShapes(key, true).length, 2, 3)
      round += railShapes(key).filter(t => t.round).length
    }
    expect(round).toBeGreaterThan(0)
  })

  test('rows: as many as asked, with a title and a longer line', () => {
    const rows = rowShapes('Loading friends', 4)
    expect(rows).toHaveLength(4)
    for (const r of rows) {
      within(r.title, 30, 55)
      within(r.line, 45, 80)
    }
    expect(rowShapes('Loading friends', 2)).toEqual(rows.slice(0, 2))
  })
})
