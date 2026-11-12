import { describe, expect, test } from 'bun:test'
import { LIMITS, check, reduced, type Animation } from '../motion/validate'
import vectors from './fixtures/motion_vectors.json'

const fade: Animation = { keyframes: [{ opacity: 0 }, { opacity: 1 }], timing: { duration: 200 } }

describe('what an animation may be', () => {
  test('compositor-only, bounded animations pass', () => {
    expect(
      check({
        keyframes: [
          { opacity: 0, transform: 'translateY(8px) scale(0.98)' },
          { opacity: 1, transform: 'translateY(0) scale(1)' },
        ],
        timing: { duration: 200, easing: 'cubic-bezier(0.2, 0, 0, 1)' },
      })
    ).toEqual([])
    expect(
      check({
        keyframes: [
          { transform: 'rotate(-3deg)' },
          { transform: 'rotate(3deg)' },
          { transform: 'rotate(0deg)' },
        ],
        timing: { duration: 240, iterations: 2 },
      })
    ).toEqual([])
  })

  test('layout properties, big moves, long or endless timing are refused', () => {
    const timing = { duration: 200 }
    expect(check({ keyframes: [{ height: '0px' }], timing })).toContain('property height')
    expect(check({ keyframes: [{ transform: 'translateX(400px)' }], timing })[0]).toBe(
      'transform translateX(400px)'
    )
    expect(check({ keyframes: [{ transform: 'skewX(10deg)' }], timing })[0]).toBe(
      'transform skewX(10deg)'
    )
    expect(check({ keyframes: [{ opacity: 1 }], timing: { duration: 5000 } })).toContain('duration')
    expect(
      check({ keyframes: [{ opacity: 1 }], timing: { duration: 200, iterations: Infinity } })
    ).toContain('iterations')
    expect(
      check({ keyframes: [{ opacity: 1 }], timing: { duration: 200, easing: 'steps(4) url(x)' } })
    ).toContain('easing')
  })

  test('every recorded case gets the recorded answer', () => {
    expect(vectors.checks).toHaveLength(76)
    for (const c of vectors.checks) {
      const got = check(c.animation)
      if (JSON.stringify(got) !== JSON.stringify(c.errors))
        throw new Error(`${c.name}: ${JSON.stringify(got)} vs ${JSON.stringify(c.errors)}`)
    }
    expect(vectors.checks.filter(c => c.errors.length === 0)).toHaveLength(31)
  })

  test('the limits', () => {
    expect(LIMITS).toEqual({
      keyframes: 12,
      duration: 1000,
      delay: 500,
      iterations: 3,
      translatePx: 64,
      translatePct: 100,
      scaleMin: 0.5,
      scaleMax: 1.5,
      rotateDeg: 30,
      reducedMs: 150,
      text: 1024,
    })
  })
})

describe('input that is not an animation', () => {
  test('anything but an object with keyframes and timing is refused without throwing', () => {
    for (const bad of [null, undefined, 7, 'fade', true, [], () => fade])
      expect(check(bad)).toEqual(['animation'])
    expect(check({})).toEqual(['keyframes', 'timing'])
    expect(check({ keyframes: 'fade', timing: { duration: 200 } })).toEqual(['keyframes'])
    expect(check({ keyframes: { 0: { opacity: 1 } }, timing: { duration: 200 } })).toEqual([
      'keyframes',
    ])
    expect(check({ keyframes: [{ opacity: 1 }], timing: 200 })).toEqual(['timing'])
    expect(check({ keyframes: [{ opacity: 1 }], timing: [200] })).toEqual(['timing'])
    expect(check({ keyframes: [{ opacity: 1 }], timing: null })).toEqual(['timing'])
  })

  test('a keyframe that is not an object is refused', () => {
    for (const frame of [null, 1, 'opacity: 1', [], undefined])
      expect(check({ keyframes: [{ opacity: 1 }, frame], timing: { duration: 200 } })).toEqual([
        'keyframes',
      ])
  })

  test('values of the wrong type are refused, not compared', () => {
    const timing = { duration: 200 }
    expect(check({ keyframes: [{ opacity: '0.5' }], timing })).toEqual(['opacity'])
    expect(check({ keyframes: [{ opacity: NaN }], timing })).toEqual(['opacity'])
    expect(check({ keyframes: [{ opacity: null }], timing })).toEqual(['opacity'])
    expect(check({ keyframes: [{ transform: 7 }], timing })).toEqual(['transform'])
    expect(check({ keyframes: [{ transform: ['scale(1)'] }], timing })).toEqual(['transform'])
    expect(check({ keyframes: [{ transform: { toString: () => 'scale(1)' } }], timing })).toEqual([
      'transform',
    ])
    expect(check({ keyframes: [{ opacity: 1 }], timing: { duration: '200' } })).toEqual([
      'duration',
    ])
    expect(check({ keyframes: [{ opacity: 1 }], timing: {} })).toEqual(['duration'])
    expect(check({ keyframes: [{ opacity: 1 }], timing: { duration: NaN } })).toEqual(['duration'])
    expect(check({ keyframes: [{ opacity: 1 }], timing: { duration: 200, delay: '0' } })).toEqual([
      'delay',
    ])
    expect(check({ keyframes: [{ opacity: 1 }], timing: { duration: 200, delay: NaN } })).toEqual([
      'delay',
    ])
    expect(
      check({ keyframes: [{ opacity: 1 }], timing: { duration: 200, iterations: '2' } })
    ).toEqual(['iterations'])
    expect(check({ keyframes: [{ opacity: 1 }], timing: { duration: 200, easing: 3 } })).toEqual([
      'easing',
    ])
  })

  test('an offset is a number from 0 to 1', () => {
    const timing = { duration: 200 }
    for (const offset of [0, 0.5, 1]) expect(check({ keyframes: [{ offset }], timing })).toEqual([])
    for (const offset of [-0.1, 1.1, NaN, '0.5', null])
      expect(check({ keyframes: [{ offset }], timing })).toEqual(['offset'])
  })

  test('timing takes only duration, delay, easing and iterations', () => {
    for (const k of ['fill', 'direction', 'endDelay', 'iterationStart', 'composite'])
      expect(check({ keyframes: [{ opacity: 1 }], timing: { duration: 200, [k]: 1 } })).toEqual([
        `timing ${k}`,
      ])
  })

  test('a value left undefined counts as not given', () => {
    expect(
      check({
        keyframes: [{ offset: undefined, opacity: undefined, transform: undefined }],
        timing: { duration: 200, delay: undefined, easing: undefined, iterations: undefined },
      })
    ).toEqual([])
  })
})

describe('what the browser would refuse or choke on', () => {
  const timing = { duration: 200 }

  test('offsets never go backwards', () => {
    expect(check({ keyframes: [{ offset: 0.8 }, { offset: 0.2 }], timing })).toEqual(['offset'])
    expect(
      check({ keyframes: [{ offset: 0.2 }, { opacity: 1 }, { offset: 0.1 }], timing })
    ).toEqual(['offset'])
    expect(
      check({ keyframes: [{ offset: 0 }, { offset: 0.5 }, { offset: 0.5 }, { offset: 1 }], timing })
    ).toEqual([])
    expect(check({ keyframes: [{ offset: 1 }, { opacity: 0 }, { opacity: 1 }], timing })).toEqual(
      []
    )
  })

  test('an easing or a transform is at most 1,024 characters', () => {
    const easing = `linear(${'0, '.repeat(338)}1)`
    expect(easing.length).toBeLessThanOrEqual(LIMITS.text)
    expect(check({ keyframes: [{ opacity: 1 }], timing: { duration: 200, easing } })).toEqual([])
    const long = `linear(${'0, '.repeat(339)}1)`
    expect(long.length).toBeGreaterThan(LIMITS.text)
    expect(check({ keyframes: [{ opacity: 1 }], timing: { duration: 200, easing: long } })).toEqual(
      ['easing']
    )
    const moves = (n: number) => Array.from({ length: n }, () => 'translateX(1px)').join(' ')
    expect(check({ keyframes: [{ transform: moves(64) }], timing })).toEqual([])
    expect(check({ keyframes: [{ transform: moves(65) }], timing })).toEqual(['transform'])
    expect(check({ keyframes: [{ transform: 'x'.repeat(1_000_000) }], timing })).toEqual([
      'transform',
    ])
  })

  test('keyframes past the twelfth are not read', () => {
    const bad = Array.from({ length: 100_000 }, () => ({ left: '1px', opacity: 2 }))
    expect(check({ keyframes: bad, timing })).toHaveLength(25)
    const thirteenth = [...Array.from({ length: 12 }, () => ({ opacity: 1 })), { left: '1px' }]
    expect(check({ keyframes: thirteenth, timing })).toEqual(['keyframes'])
  })
})

describe('the reduced variant', () => {
  test('keeps opacity only and lasts at most 150 ms', () => {
    const r = reduced({
      keyframes: [
        { opacity: 0, transform: 'translateY(8px)' },
        { opacity: 1, transform: 'translateY(0)' },
      ],
      timing: { duration: 300 },
    })
    expect(r.keyframes.every(k => !('transform' in k) || k.transform === undefined)).toBe(true)
    expect(r.timing.duration).toBe(150)
  })

  test('every recorded case reduces as recorded', () => {
    expect(vectors.reduced).toHaveLength(3)
    for (const c of vectors.reduced)
      expect(reduced(c.animation as Animation)).toEqual(c.reduced as Animation)
  })

  test('a move with no opacity stays fully shown, offsets stay, delay and repeats go', () => {
    const r = reduced({
      keyframes: [
        { transform: 'scale(0.8)' },
        { offset: 0.6, transform: 'scale(1.05)' },
        { transform: 'scale(1)' },
      ],
      timing: { duration: 120, delay: 300, easing: 'ease-out', iterations: 2 },
    })
    expect(r).toEqual({
      keyframes: [{ opacity: 1 }, { offset: 0.6, opacity: 1 }, { opacity: 1 }],
      timing: { duration: 120, easing: 'linear' },
    })
    expect(Object.keys(r.keyframes[0])).toEqual(['opacity'])
  })

  test('the reduced variant of an allowed animation is allowed', () => {
    for (const c of vectors.checks.filter(c => c.errors.length === 0)) {
      const r = reduced(c.animation as Animation)
      expect(check(r)).toEqual([])
      expect(r.timing.duration).toBeLessThanOrEqual(LIMITS.reducedMs)
    }
  })
})
