import { describe, expect, test } from 'bun:test'
import {
  EDGE,
  MAX_SCROLL,
  OFF_SIDE,
  autoScrollStep,
  layoutSpan,
  nearestSpan,
  offSide,
  ontoBand,
  slotAt,
  type Box,
  type Span,
} from '../drag'

const tiles = (...keys: string[]): Box[] =>
  keys.map((key, i) => ({ key, top: i * 56, bottom: i * 56 + 48 }))

describe('drop slot', () => {
  const rail = tiles('a', 'b', 'c', 'd')

  test('the index counts the other items whose middle is above the pointer', () => {
    expect(slotAt(rail, 0, 'd').index).toBe(0)
    expect(slotAt(rail, 30, 'd').index).toBe(1)
    expect(slotAt(rail, 500, 'a').index).toBe(3)
  })

  test('the line sits in the middle of the gap, or just outside the ends', () => {
    expect(slotAt(rail, 30, 'd').line).toBe((48 + 56) / 2)
    expect(slotAt(rail, -10, 'd').line).toBe(-4)
    expect(slotAt(rail, 500, 'a').line).toBe(3 * 56 + 48 + 4)
  })

  test('hovering the dragged item own slot is a no-op', () => {
    expect(slotAt(rail, 56 + 24, 'b')).toEqual({
      index: 1,
      line: (48 + 112) / 2,
      noop: true,
      onto: null,
    })
    expect(slotAt(rail, 56 + 60, 'b').noop).toBe(true)
    expect(slotAt(rail, 112 + 30, 'b').noop).toBe(false)
  })

  test('items from another zone are never a no-op', () => {
    expect(slotAt(rail, 60, 'zz').noop).toBe(false)
    expect(slotAt(rail, 60, 'zz').index).toBe(1)
  })

  test('an empty zone accepts at index 0 without a line', () => {
    expect(slotAt([], 10, 'a')).toEqual({ index: 0, line: null, noop: false, onto: null })
    expect(slotAt(tiles('a'), 10, 'a')).toEqual({ index: 0, line: null, noop: true, onto: null })
  })
})

describe('drop onto an item', () => {
  const merging = tiles('a', 'b', 'c').map(b => ({ ...b, onto: ontoBand(b.top, b.bottom) }))

  test('the middle half of a tile merges, the edges still reorder', () => {
    expect(ontoBand(0, 48)).toEqual({ top: 12, bottom: 36 })
    expect(slotAt(merging, 56 + 24, 'c')).toEqual({ index: 1, line: null, noop: false, onto: 'b' })
    expect(slotAt(merging, 56 + 13, 'c').onto).toBe('b')
    expect(slotAt(merging, 56 + 6, 'c')).toEqual({
      index: 1,
      line: (48 + 56) / 2,
      noop: false,
      onto: null,
    })
    expect(slotAt(merging, 56 + 44, 'a').onto).toBeNull()
  })

  test('an open folder header merges down to its bottom edge', () => {
    expect(ontoBand(100, 148, true)).toEqual({ top: 112, bottom: 148 })
  })

  test('the dragged item is never its own merge target', () => {
    expect(slotAt(merging, 56 + 24, 'b')).toEqual({
      index: 1,
      line: (48 + 112) / 2,
      noop: true,
      onto: null,
    })
  })

  test('the index of a merge counts only the other items', () => {
    expect(slotAt(merging, 112 + 24, 'a')).toEqual({ index: 1, line: null, noop: false, onto: 'c' })
  })

  test('items without a band never merge', () => {
    expect(slotAt(tiles('a', 'b'), 56 + 24, 'zz').onto).toBeNull()
  })
})

describe('merge highlight geometry', () => {
  const LIT = 0.84
  const scaled = ({ top, bottom }: Span, by: number): Span => {
    const center = (top + bottom) / 2
    const half = ((bottom - top) * by) / 2
    return { top: Math.fround(center - half), bottom: Math.fround(center + half) }
  }
  const rail = tiles('a', 'b', 'c')
  const frame = (y: number, lit: string | null, by = LIT) =>
    slotAt(
      rail.map(b => {
        const { top, bottom } = layoutSpan(b.key === lit ? scaled(b, by) : b, b.bottom - b.top)
        return { key: b.key, top, bottom, onto: ontoBand(top, bottom) }
      }),
      y,
      'c'
    ).onto

  test('a scaled tile measures at its layout size around the same center', () => {
    expect(layoutSpan(scaled({ top: 56, bottom: 104 }, LIT), 48)).toEqual({ top: 56, bottom: 104 })
    expect(layoutSpan(scaled({ top: 0.5, bottom: 47.5 }, 1.04), 47)).toEqual({
      top: 0.5,
      bottom: 47.5,
    })
    expect(layoutSpan({ top: 10, bottom: 58 }, 48)).toEqual({ top: 10, bottom: 58 })
  })

  test('highlighting the target never moves its band under a still pointer', () => {
    for (let y = 40; y <= 120; y += 0.125) {
      const first = frame(y, null)
      let lit = first
      for (let i = 0; i < 4; i++) {
        lit = frame(y, lit)
        expect(lit).toBe(first)
      }
    }
  })

  test('the band edges hold at the offsets that used to flicker', () => {
    const offsets = [11, 11.875, 12, 12.5, 13, 14.5, 24, 35, 35.5, 36, 36.125, 37]
    const expected = [null, null, 'b', 'b', 'b', 'b', 'b', 'b', 'b', 'b', null, null]
    expect(offsets.map(dy => frame(56 + dy, null))).toEqual(expected)
    expect(offsets.map(dy => frame(56 + dy, 'b'))).toEqual(expected)
    for (const by of [0.9, 0.95, 0.99])
      expect(offsets.map(dy => frame(56 + dy, 'b', by))).toEqual(expected)
  })
})

describe('zones and scrolling', () => {
  test('the zone under the pointer wins, otherwise the closest one', () => {
    const spans = [
      { top: 0, bottom: 100 },
      { top: 140, bottom: 400 },
    ]
    expect(nearestSpan(spans, 50)).toBe(0)
    expect(nearestSpan(spans, 150)).toBe(1)
    expect(nearestSpan(spans, 110)).toBe(0)
    expect(nearestSpan(spans, 135)).toBe(1)
    expect(nearestSpan(spans, -500)).toBe(0)
    expect(nearestSpan(spans, 900)).toBe(1)
    expect(nearestSpan([], 0)).toBe(-1)
  })

  test('auto scroll speeds up towards and past the edges', () => {
    expect(autoScrollStep(300, 0, 600)).toBe(0)
    expect(autoScrollStep(EDGE / 2, 0, 600)).toBe(-MAX_SCROLL / 2)
    expect(autoScrollStep(-50, 0, 600)).toBe(-MAX_SCROLL)
    expect(autoScrollStep(600 - EDGE / 2, 0, 600)).toBe(MAX_SCROLL / 2)
    expect(autoScrollStep(900, 0, 600)).toBe(MAX_SCROLL)
  })

  test('short scrollers shrink the edge band', () => {
    expect(autoScrollStep(50, 0, 100)).toBe(0)
    expect(autoScrollStep(10, 0, 100)).toBe(-10)
    expect(autoScrollStep(0, 0, 0)).toBe(0)
  })

  test('dragging far to the side leaves the list', () => {
    expect(offSide(100, 0, 72)).toBe(false)
    expect(offSide(72 + OFF_SIDE + 1, 0, 72)).toBe(true)
    expect(offSide(-OFF_SIDE - 1, 0, 72)).toBe(true)
  })
})
