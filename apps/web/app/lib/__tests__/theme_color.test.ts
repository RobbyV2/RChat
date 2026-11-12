import { describe, expect, test } from 'bun:test'
import {
  channelDiff,
  contrast,
  deltaE,
  gray,
  hex,
  lab,
  lstar,
  lstarOfY,
  toHex,
  yOfLstar,
  type Rgb,
} from '../theme/color'
import vectors from './fixtures/theme_vectors.json'

const REPORT = vectors.report as [string, string, string, string, number, number][]
const near = (a: number, b: number, by: number) => Math.abs(a - b) <= by

describe('colors as hex', () => {
  test('a hex color parses with or without the hash, in either case', () => {
    expect(hex('#6750a4')).toEqual([103, 80, 164])
    expect(hex('6750A4')).toEqual([103, 80, 164])
    expect(hex(' #ffffff ')).toEqual([255, 255, 255])
  })

  test('anything that is not six hex digits is refused', () => {
    for (const bad of ['', '#fff', '#6750a4ff', 'purple', '#67 50a4', '#gggggg'])
      expect(() => hex(bad)).toThrow('bad color')
  })

  test('toHex writes lowercase and pads each channel', () => {
    expect(toHex([0, 10, 255])).toBe('#000aff')
    for (const c of ['#6750a4', '#000000', '#ffffff', '#0061a4'])
      expect(toHex(hex(c.toUpperCase()))).toBe(c)
  })
})

describe('lightness', () => {
  test('black is 0, white is 100, and L* and Y convert both ways', () => {
    expect(lstar([0, 0, 0])).toBe(0)
    expect(near(lstar([255, 255, 255]), 100, 1e-9)).toBe(true)
    for (const l of [0, 1, 8, 20, 50, 77.5, 100])
      expect(near(lstarOfY(yOfLstar(l)), l, 1e-9)).toBe(true)
  })

  test('a gray of a tone has equal channels and that lightness', () => {
    for (const t of [0, 4, 10, 22, 50, 70, 95, 100]) {
      const [r, g, b] = gray(t)
      expect(r === g && g === b).toBe(true)
      expect(near(lstar([r, g, b]), t, 0.6)).toBe(true)
    }
    expect(gray(0)).toEqual([0, 0, 0])
    expect(gray(100)).toEqual([255, 255, 255])
  })

  test("today's purple has the tone the derivation starts from", () => {
    expect(near(lstar(hex(vectors.seed.hex)), vectors.seed.tone, 0.005)).toBe(true)
  })
})

describe('contrast', () => {
  const BLACK: Rgb = [0, 0, 0]
  const WHITE: Rgb = [255, 255, 255]

  test('black on white is 21:1, a color on itself 1:1, and the order does not matter', () => {
    expect(near(contrast(BLACK, WHITE), 21, 1e-6)).toBe(true)
    expect(contrast(hex('#6750a4'), hex('#6750a4'))).toBe(1)
    expect(contrast(hex('#6750a4'), WHITE)).toBe(contrast(WHITE, hex('#6750a4')))
  })

  test("Black's stated ratios on a black background", () => {
    expect(near(contrast(hex('#f5eff7'), BLACK), 18.57, 0.005)).toBe(true)
    expect(near(contrast(hex('#afa9b4'), BLACK), 9.16, 0.005)).toBe(true)
    expect(near(contrast(hex('#6d6973'), BLACK), 3.92, 0.005)).toBe(true)
    expect(near(contrast(hex('#e6e0e9'), hex('#141218')), 14.35, 0.005)).toBe(true)
  })
})

describe('how far two colors are apart', () => {
  test('the largest channel difference and the color difference of every reported token', () => {
    expect(REPORT).toHaveLength(58)
    for (const [mode, token, today, derived, diff, dE] of REPORT) {
      if (channelDiff(hex(today), hex(derived)) !== diff) throw new Error(`${mode} ${token} diff`)
      if (!near(deltaE(hex(today), hex(derived)), dE, 0.005)) throw new Error(`${mode} ${token} dE`)
    }
  })

  test('Lab of white, black and a color against itself', () => {
    const [l, a, b] = lab([255, 255, 255])
    expect(near(l, 100, 1e-6) && near(a, 0, 0.01) && near(b, 0, 0.01)).toBe(true)
    expect(lab([0, 0, 0])).toEqual([0, 0, 0])
    expect(deltaE(hex('#0061a4'), hex('#0061a4'))).toBe(0)
    expect(channelDiff([1, 200, 30], [4, 190, 30])).toBe(10)
  })
})
