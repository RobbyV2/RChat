import { describe, expect, test } from 'bun:test'
import { channelDiff, gray, hex, lstar, toHex } from '../theme/color'
import { hctOf, solve } from '../theme/hct'
import vectors from './fixtures/theme_vectors.json'

const near = (a: number, b: number, by: number) => Math.abs(a - b) <= by

describe('HCT', () => {
  test('round trip keeps tone and hue', () => {
    for (const h of ['#6750a4', '#0061a4', '#386a20', '#b3261e', '#7c5800']) {
      const c = hctOf(hex(h))
      const back = solve(c.hue, c.chroma, c.tone)
      expect(channelDiff(back, hex(h))).toBeLessThanOrEqual(1)
    }
  })

  test('the solved tone is the asked L*', () => {
    for (const t of [4, 10, 30, 50, 80, 96])
      expect(Math.abs(lstar(solve(282, 48, t)) - t)).toBeLessThan(0.6)
  })

  test("today's purple measures hue 298.98, chroma 47.86, tone 40.08", () => {
    const { hue, chroma, tone } = hctOf(hex(vectors.seed.hex))
    expect(near(hue, vectors.seed.hue, 0.005)).toBe(true)
    expect(near(chroma, vectors.seed.chroma, 0.005)).toBe(true)
    expect(near(tone, vectors.seed.tone, 0.005)).toBe(true)
  })

  test('every accent preset measures as recorded', () => {
    expect(vectors.presets).toHaveLength(8)
    for (const p of vectors.presets) {
      const got = hctOf(hex(p.seed))
      for (const k of ['hue', 'chroma', 'tone'] as const)
        if (!near(got[k], p.hct[k], 0.005)) throw new Error(`${p.name} ${k} ${got[k]}`)
    }
  })

  test('grays have next to no chroma', () => {
    for (const g of ['#000000', '#808080', '#ffffff']) expect(hctOf(hex(g)).chroma).toBeLessThan(3)
  })
})

describe('the tone-keeping solver', () => {
  test('tone 0 is black, tone 100 is white, no chroma is a gray', () => {
    expect(solve(120, 60, 0)).toEqual([0, 0, 0])
    expect(solve(120, 60, 100)).toEqual([255, 255, 255])
    for (const t of [10, 45, 90]) expect(solve(200, 0.4, t)).toEqual(gray(t))
  })

  test('a chroma out of gamut is lowered and the tone is kept', () => {
    for (const hue of [0, 60, 120, 180, 240, 300])
      for (const t of [10, 50, 90]) {
        const c = solve(hue, 200, t)
        expect(Math.abs(lstar(c) - t)).toBeLessThan(0.6)
        expect(hctOf(c).chroma).toBeLessThan(200)
        expect(hctOf(c).chroma).toBeGreaterThan(4)
      }
  })

  test('the 296 accents of the sweep come out as recorded', () => {
    const seeds = ['#000000', '#ffffff', '#808080', '#5e5e62']
    seeds.push('#ffff00', '#00ffff', '#ff00ff', '#00ff00')
    for (let h = 0; h < 360; h += 15)
      for (const c of [16, 36, 60, 90])
        for (const t of [30, 50, 70]) seeds.push(toHex(solve(h, c, t)))
    expect(seeds).toHaveLength(296)
    expect(seeds).toEqual(vectors.sweep.seeds)
  })
})
