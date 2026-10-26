import { describe, expect, test } from 'bun:test'
import {
  EDGE,
  MAX_SCROLL,
  OFF_SIDE,
  autoScrollStep,
  nearestSpan,
  offSide,
  slotAt,
  type Box,
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
    expect(slotAt(rail, 56 + 24, 'b')).toEqual({ index: 1, line: (48 + 112) / 2, noop: true })
    expect(slotAt(rail, 56 + 60, 'b').noop).toBe(true)
    expect(slotAt(rail, 112 + 30, 'b').noop).toBe(false)
  })

  test('items from another zone are never a no-op', () => {
    expect(slotAt(rail, 60, 'zz').noop).toBe(false)
    expect(slotAt(rail, 60, 'zz').index).toBe(1)
  })

  test('an empty zone accepts at index 0 without a line', () => {
    expect(slotAt([], 10, 'a')).toEqual({ index: 0, line: null, noop: false })
    expect(slotAt(tiles('a'), 10, 'a')).toEqual({ index: 0, line: null, noop: true })
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
