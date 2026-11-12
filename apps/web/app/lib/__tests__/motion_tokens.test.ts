import { describe, expect, test } from 'bun:test'
import { DURATIONS, DURATION_VARS, EASINGS, SPRINGS } from '../motion/tokens'
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
