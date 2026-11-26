import { describe, expect, test } from 'bun:test'
import {
  ANIM_DEFAULT,
  MOTION_CHOICES,
  animHeldBack,
  animKey,
  animValue,
  motionLabel,
  motionPlays,
  parseAnim,
  type AnimPrefs,
} from '../motion/setting'
import type { MotionChoice } from '../fx/gate'
import { reducedMotionNow, watchReducedMotion } from '../motion/use_motion'

const MOTIONS: MotionChoice[] = ['device', 'still', 'always']

describe('the Animations setting', () => {
  test('off by default, following the device, saved per account', () => {
    expect(ANIM_DEFAULT).toEqual({ on: false, motion: 'device' })
    expect(animKey('alice')).toBe('rchat_anim:alice')
    expect(animKey(null)).toBe('rchat_anim:guest')
  })

  test('nothing saved, junk and other versions read as the default', () => {
    for (const raw of [null, '', 'x', '[]', '7', 'null', '{"on":true}', '{"v":2,"on":true}'])
      expect([raw, parseAnim(raw)]).toEqual([raw, ANIM_DEFAULT])
  })

  test('a saved value reads back', () => {
    for (const on of [true, false])
      for (const motion of MOTIONS) {
        const prefs: AnimPrefs = { on, motion }
        expect(parseAnim(animValue(prefs))).toEqual(prefs)
      }
    expect(animValue({ on: true, motion: 'always' })).toBe('{"v":1,"on":true,"motion":"always"}')
  })

  test('each field falls back alone', () => {
    const saved = { v: 1, on: true, motion: 'always' }
    for (const on of [1, 'true', null])
      expect(parseAnim(JSON.stringify({ ...saved, on }))).toEqual({ on: false, motion: 'always' })
    for (const motion of ['fast', 1, null, 'Reduced'])
      expect(parseAnim(JSON.stringify({ ...saved, motion }))).toEqual({
        on: true,
        motion: 'device',
      })
    expect(parseAnim(JSON.stringify({ ...saved, extra: 3 }))).toEqual({
      on: true,
      motion: 'always',
    })
  })
})

describe('whether motion plays', () => {
  test('never with the switch off', () => {
    for (const motion of MOTIONS)
      for (const reduced of [true, false])
        expect(motionPlays({ on: false, motion }, reduced)).toBe(false)
  })

  test('on: Reduced never moves, the device decides when followed, anyway always moves', () => {
    expect(motionPlays({ on: true, motion: 'still' }, false)).toBe(false)
    expect(motionPlays({ on: true, motion: 'still' }, true)).toBe(false)
    expect(motionPlays({ on: true, motion: 'device' }, false)).toBe(true)
    expect(motionPlays({ on: true, motion: 'device' }, true)).toBe(false)
    expect(motionPlays({ on: true, motion: 'always' }, true)).toBe(true)
    expect(motionPlays({ on: true, motion: 'always' }, false)).toBe(true)
  })

  test('settings say why nothing moves while the switch is on', () => {
    expect(animHeldBack({ on: false, motion: 'device' }, true)).toBeNull()
    expect(animHeldBack({ on: true, motion: 'device' }, false)).toBeNull()
    expect(animHeldBack({ on: true, motion: 'always' }, true)).toBeNull()
    expect(animHeldBack({ on: true, motion: 'device' }, true)).toBe(
      'Your device asks for less motion, so things change without moving.'
    )
    expect(animHeldBack({ on: true, motion: 'still' }, false)).toBe(
      'Motion is set to Reduced, so things change without moving.'
    )
  })

  test('every Motion choice has a label', () => {
    expect(MOTION_CHOICES.map(c => c.value)).toEqual(MOTIONS)
    expect(MOTIONS.map(motionLabel)).toEqual(['Follow my device', 'Reduced', 'Play motion anyway'])
  })
})

describe('the device query', () => {
  test('reads and watches prefers-reduced-motion, one query per matchMedia', () => {
    const g = globalThis as { window?: unknown }
    const real = g.window
    const listeners = new Set<() => void>()
    const asked: string[] = []
    let matches = false
    const list = {
      get matches() {
        return matches
      },
      addEventListener: (_: string, l: () => void) => void listeners.add(l),
      removeEventListener: (_: string, l: () => void) => void listeners.delete(l),
    }
    g.window = {
      matchMedia: (q: string) => {
        asked.push(q)
        return list
      },
    }
    try {
      expect(reducedMotionNow()).toBe(false)
      let changes = 0
      const stop = watchReducedMotion(() => (changes += 1))
      matches = true
      for (const l of listeners) l()
      expect([reducedMotionNow(), changes]).toEqual([true, 1])
      stop()
      expect(listeners.size).toBe(0)
      expect(asked).toEqual(['(prefers-reduced-motion: reduce)'])
    } finally {
      g.window = real
    }
    expect(reducedMotionNow()).toBe(false)
  })
})
