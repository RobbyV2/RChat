import { describe, expect, test } from 'bun:test'
import { spring } from '../motion/spring'
import { check } from '../motion/validate'
import vectors from './fixtures/motion_vectors.json'

const stops = (easing: string) => easing.slice('linear('.length, -1).split(', ').map(Number)

describe('springs', () => {
  test('a spring becomes a linear() easing that ends at 1 and settles within a second', () => {
    const s = spring(300, 20)
    expect(s.easing.startsWith('linear(0, ')).toBe(true)
    expect(s.easing.endsWith(', 1)')).toBe(true)
    expect(s.duration).toBeGreaterThan(50)
    expect(s.duration).toBeLessThanOrEqual(1000)
    expect(
      check({
        keyframes: [{ transform: 'scale(0.9)' }, { transform: 'scale(1)' }],
        timing: { duration: s.duration, easing: s.easing },
      })
    ).toEqual([])
  })

  test('every recorded spring comes out as recorded', () => {
    expect(vectors.springs).toHaveLength(9)
    for (const v of vectors.springs) {
      const got =
        v.points === null
          ? spring(v.stiffness, v.damping)
          : spring(v.stiffness, v.damping, v.points)
      if (got.easing !== v.easing || got.duration !== v.duration)
        throw new Error(`${v.stiffness} ${v.damping}: ${got.duration} ${got.easing}`)
    }
  })

  test('24 steps by default, or as many as asked, from 0 to 1', () => {
    expect(stops(spring(300, 30).easing)).toHaveLength(25)
    expect(stops(spring(300, 30, 8).easing)).toHaveLength(9)
    for (const s of [spring(300, 30), spring(300, 15), spring(50, 2, 40)]) {
      const xs = stops(s.easing)
      expect(xs[0]).toBe(0)
      expect(xs[xs.length - 1]).toBe(1)
      expect(xs.every(x => Number.isFinite(x))).toBe(true)
    }
  })

  test('a light damping overshoots, a heavy one never does', () => {
    expect(Math.max(...stops(spring(300, 15).easing))).toBeGreaterThan(1.1)
    expect(Math.max(...stops(spring(300, 40).easing))).toBe(1)
    expect(Math.max(...stops(spring(300, 2 * Math.sqrt(300)).easing))).toBe(1)
  })

  test('a spring that never settles is cut at one second', () => {
    expect(spring(50, 2).duration).toBe(1000)
    expect(spring(100, 10).duration).toBe(1000)
    expect(spring(600, 50).duration).toBeLessThan(400)
  })

  test('every spring easing passes the validator', () => {
    for (const v of vectors.springs)
      expect(
        check({
          keyframes: [{ opacity: 0 }, { opacity: 1 }],
          timing: { duration: v.duration, easing: v.easing },
        })
      ).toEqual([])
  })
})
