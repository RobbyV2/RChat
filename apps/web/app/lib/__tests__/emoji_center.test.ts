import { describe, expect, test } from 'bun:test'
import { SHIFT_MAX, emojiShift, glyphInk, inkRows } from '../emoji_center'

const near = (a: number, b: number) => Math.abs(a - b) < 0.0005

// Segoe UI Emoji on Linux, as measured: a 16px box with line-height 1 puts the baseline 12px down
// in Chromium and 12.5px down in WebKit, and 😀 drawn at 100px paints 85px above its baseline and
// 14px below. Both draw it about 1.5px above the box's middle.
const SEGOE = { size: 16, baseline: 12, inkTop: 85, inkBottom: 14, inkSize: 100 }

describe('emoji shift', () => {
  test('a glyph above the middle of its box moves down, by what the engine measures', () => {
    expect(near(emojiShift(SEGOE), 0.105)).toBe(true)
    expect(near(emojiShift({ ...SEGOE, baseline: 12.5 }), 0.074)).toBe(true)
  })

  test('a centered glyph stays put', () => {
    expect(emojiShift({ size: 16, baseline: 12.8, inkTop: 80, inkBottom: 20, inkSize: 100 })).toBe(
      0
    )
  })

  test('a glyph below the middle moves up', () => {
    expect(emojiShift({ size: 100, baseline: 90, inkTop: 70, inkBottom: 30, inkSize: 100 })).toBe(
      -0.2
    )
  })

  test('the ink scales from the size it was measured at', () => {
    const big = { ...SEGOE, inkTop: 170, inkBottom: 28, inkSize: 200 }
    expect(near(emojiShift(big), emojiShift(SEGOE))).toBe(true)
  })

  test('a broken measurement moves nothing or at most a fifth of an em', () => {
    expect(SHIFT_MAX).toBeLessThanOrEqual(0.2)
    expect(emojiShift({ ...SEGOE, size: 0 })).toBe(0)
    expect(emojiShift({ ...SEGOE, baseline: Number.NaN })).toBe(0)
    expect(emojiShift({ ...SEGOE, baseline: -100 })).toBe(SHIFT_MAX)
    expect(emojiShift({ ...SEGOE, baseline: 100 })).toBe(-SHIFT_MAX)
  })
})

describe('ink rows', () => {
  const image = (rows: number[][]) => rows.flatMap(row => row.flatMap(alpha => [0, 0, 0, alpha]))

  test('finds the first and last painted rows', () => {
    const img = image([
      [0, 0, 0],
      [0, 9, 0],
      [0, 0, 0],
      [1, 0, 0],
      [0, 0, 0],
    ])
    expect(inkRows(img, 3, 5)).toEqual({ top: 1, bottom: 3 })
  })

  test('nothing painted is no ink', () => {
    expect(inkRows(image([[0, 0]]), 2, 1)).toBeNull()
  })
})

describe('glyph ink', () => {
  const canvas = (size: number, paint: (x: number, y: number) => boolean) => {
    const out: number[] = []
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) out.push(0, 0, 0, paint(x, y) ? 255 : 0)
    return out
  }

  test('a glyph is measured around its baseline', () => {
    const img = canvas(200, (x, y) => x > 30 && x < 120 && y >= 75 && y < 174)
    expect(glyphInk(img, 200, 200, 160, 100)).toEqual({ top: 85, bottom: 14 })
  })

  test('a blocked canvas readback is no measurement', () => {
    expect(
      glyphInk(
        canvas(200, () => true),
        200,
        200,
        160,
        100
      )
    ).toBeNull()
  })

  test('ink at the canvas edge or far taller than the glyph is no measurement', () => {
    expect(
      glyphInk(
        canvas(200, (x, y) => x === 5 && y > 150),
        200,
        200,
        160,
        100
      )
    ).toBeNull()
    expect(
      glyphInk(
        canvas(200, (x, y) => x === 5 && y < 30),
        200,
        200,
        160,
        100
      )
    ).toBeNull()
    expect(
      glyphInk(
        canvas(200, (x, y) => x === 5 && y > 4 && y < 190),
        200,
        200,
        160,
        100
      )
    ).toBeNull()
  })
})
