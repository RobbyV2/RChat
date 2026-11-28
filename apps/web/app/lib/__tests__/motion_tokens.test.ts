import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  DISTANCES,
  DURATIONS,
  DURATION_VARS,
  EASINGS,
  SCALES,
  SPRINGS,
  TOKEN_VARS,
} from '../motion/tokens'
import { check } from '../motion/validate'

describe('motion tokens', () => {
  test('durations: short 120 ms, medium 200 ms, long 320 ms', () => {
    expect(DURATIONS).toEqual({ short: 120, medium: 200, long: 320 })
    expect(DURATION_VARS).toEqual({
      '--motion-short': '120ms',
      '--motion-medium': '200ms',
      '--motion-long': '320ms',
    })
  })

  test('easings: standard, decelerate and accelerate', () => {
    expect(EASINGS).toEqual({
      standard: 'cubic-bezier(0.2, 0, 0, 1)',
      decelerate: 'cubic-bezier(0.05, 0.7, 0.1, 1)',
      accelerate: 'cubic-bezier(0.3, 0, 0.8, 0.15)',
    })
    for (const easing of Object.values(EASINGS))
      expect(check({ keyframes: [{ opacity: 1 }], timing: { duration: 200, easing } })).toEqual([])
  })

  test('springs: gentle is stiffness 300 with damping 30, bouncy 300 with 15', () => {
    expect(SPRINGS).toEqual({
      gentle: { stiffness: 300, damping: 30 },
      bouncy: { stiffness: 300, damping: 15 },
    })
  })
})

describe('the style sheet', () => {
  test('holds the same tokens as the engine', () => {
    const css = readFileSync(fileURLToPath(new URL('../../globals.css', import.meta.url)), 'utf8')
    expect(DISTANCES).toEqual({ settle: 2, lift: 4, rise: 6, slide: 16, swap: 24 })
    expect(SCALES).toEqual({ press: 0.97, hover: 1.03 })
    for (const [name, value] of Object.entries(TOKEN_VARS))
      if (!css.includes(`\n  ${name}: ${value};\n`)) throw new Error(`${name}: ${value}`)
    const declared = [...css.matchAll(/^ {2}(--motion-[a-z-]+):/gm)].map(m => m[1])
    expect(declared.sort()).toEqual(Object.keys(TOKEN_VARS).sort())
  })
})
