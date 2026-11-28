import { describe, expect, test } from 'bun:test'
import {
  ANIM_DEFAULT,
  MOTION_CHOICES,
  STYLES,
  STYLE_CHOICES,
  animHeldBack,
  animKey,
  animValue,
  choiceOptions,
  cleanChoices,
  motionLabel,
  motionMode,
  motionPlays,
  parseAnim,
  sameAnim,
  slotChoices,
  styleLabel,
  withChoice,
  type AnimPrefs,
} from '../motion/setting'
import { BUILTIN_NAMES } from '../motion/names'
import type { MotionChoice } from '../fx/gate'
import { reducedMotionNow, watchReducedMotion } from '../motion/use_motion'

const MOTIONS: MotionChoice[] = ['device', 'still', 'always']

describe('the Animations setting', () => {
  test('off by default, following the device, saved per account', () => {
    expect(ANIM_DEFAULT).toEqual({ on: false, motion: 'device', style: 'subtle', custom: {} })
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
        const prefs: AnimPrefs = { on, motion, style: 'subtle', custom: {} }
        expect(parseAnim(animValue(prefs))).toEqual(prefs)
      }
    expect(animValue({ on: true, motion: 'always', style: 'subtle', custom: {} })).toBe(
      '{"v":1,"on":true,"motion":"always","style":"subtle","custom":{}}'
    )
  })

  test('each field falls back alone', () => {
    const saved = { v: 1, on: true, motion: 'always' }
    for (const on of [1, 'true', null])
      expect(parseAnim(JSON.stringify({ ...saved, on }))).toEqual({
        on: false,
        motion: 'always',
        style: 'subtle',
        custom: {},
      })
    for (const motion of ['fast', 1, null, 'Reduced'])
      expect(parseAnim(JSON.stringify({ ...saved, motion }))).toEqual({
        on: true,
        motion: 'device',
        style: 'subtle',
        custom: {},
      })
    expect(parseAnim(JSON.stringify({ ...saved, extra: 3 }))).toEqual({
      on: true,
      motion: 'always',
      style: 'subtle',
      custom: {},
    })
  })
})

describe('whether motion plays', () => {
  test('never with the switch off', () => {
    for (const motion of MOTIONS)
      for (const reduced of [true, false])
        expect(motionPlays({ on: false, motion, style: 'subtle', custom: {} }, reduced)).toBe(false)
  })

  test('on: Reduced never moves, the device decides when followed, anyway always moves', () => {
    expect(motionPlays({ on: true, motion: 'still', style: 'subtle', custom: {} }, false)).toBe(
      false
    )
    expect(motionPlays({ on: true, motion: 'still', style: 'subtle', custom: {} }, true)).toBe(
      false
    )
    expect(motionPlays({ on: true, motion: 'device', style: 'subtle', custom: {} }, false)).toBe(
      true
    )
    expect(motionPlays({ on: true, motion: 'device', style: 'subtle', custom: {} }, true)).toBe(
      false
    )
    expect(motionPlays({ on: true, motion: 'always', style: 'subtle', custom: {} }, true)).toBe(
      true
    )
    expect(motionPlays({ on: true, motion: 'always', style: 'subtle', custom: {} }, false)).toBe(
      true
    )
  })

  test('settings say why nothing moves while the switch is on', () => {
    expect(
      animHeldBack({ on: false, motion: 'device', style: 'subtle', custom: {} }, true)
    ).toBeNull()
    expect(
      animHeldBack({ on: true, motion: 'device', style: 'subtle', custom: {} }, false)
    ).toBeNull()
    expect(
      animHeldBack({ on: true, motion: 'always', style: 'subtle', custom: {} }, true)
    ).toBeNull()
    expect(animHeldBack({ on: true, motion: 'device', style: 'subtle', custom: {} }, true)).toBe(
      'Your device asks for less motion, so things change without moving.'
    )
    expect(animHeldBack({ on: true, motion: 'still', style: 'subtle', custom: {} }, false)).toBe(
      'Motion is set to Reduced, so things change without moving.'
    )
  })

  test('every Motion choice has a label', () => {
    expect(MOTION_CHOICES.map(c => c.value)).toEqual(MOTIONS)
    expect(MOTIONS.map(motionLabel)).toEqual(['Follow my device', 'Reduced', 'Play motion anyway'])
  })
})

describe('the style and the Custom choices', () => {
  const ON: AnimPrefs = { on: true, motion: 'always', style: 'custom', custom: {} }

  test('the style and each choice are saved and read back', () => {
    const prefs: AnimPrefs = { ...ON, custom: { toast: 'off', dialog: 'core.pop', press: 'off' } }
    expect(parseAnim(animValue(prefs))).toEqual(prefs)
    expect(animValue(prefs)).toBe(
      '{"v":1,"on":true,"motion":"always","style":"custom","custom":{"dialog":"core.pop","press":"off","toast":"off"}}'
    )
  })

  test('an unknown style, slot or animation is dropped, each alone', () => {
    const raw = JSON.stringify({
      v: 1,
      on: true,
      motion: 'always',
      style: 'wild',
      custom: {
        dialog: 'core.pop',
        nope: 'off',
        toast: 'plugin.x.wobble',
        press: 'core.pop',
        menu: 3,
      },
    })
    expect(parseAnim(raw)).toEqual({ ...ON, style: 'subtle', custom: { dialog: 'core.pop' } })
    for (const custom of [null, 3, 'x', []]) expect(cleanChoices(custom)).toEqual({})
  })

  test('two settings are the same whatever the order of their choices', () => {
    const a: AnimPrefs = { ...ON, custom: { dialog: 'off', toast: 'off' } }
    const b: AnimPrefs = { ...ON, custom: { toast: 'off', dialog: 'off' } }
    expect(sameAnim(a, b)).toBe(true)
    expect(sameAnim(a, { ...a, style: 'lively' })).toBe(false)
    expect(sameAnim(a, { ...a, custom: { dialog: 'off' } })).toBe(false)
  })

  test('a slot the engine plays takes off or a named animation; one the style sheet moves only off', () => {
    expect(slotChoices('dialog')).toEqual(['off', ...BUILTIN_NAMES])
    expect(slotChoices('press')).toEqual(['off'])
    expect(choiceOptions('press')).toEqual([
      { value: 'own', label: 'On' },
      { value: 'off', label: 'Off' },
    ])
    expect(choiceOptions('dialog').map(o => o.label)).toEqual([
      'Default',
      'Off',
      'Fade',
      'Fade and scale',
      'Slide',
      'Rise',
      'Pop',
      'Jiggle',
      'Spring',
      'Crossfade',
    ])
  })

  test('setting a choice, and setting a slot back to its own animation', () => {
    const set = withChoice(ON, 'dialog', 'core.rise')
    expect(set.custom).toEqual({ dialog: 'core.rise' })
    expect(withChoice(set, 'toast', 'off').custom).toEqual({ dialog: 'core.rise', toast: 'off' })
    expect(withChoice(set, 'dialog', 'own').custom).toEqual({})
    expect(withChoice(ON, 'press', 'core.pop').custom).toEqual({})
  })

  test('how much moves: nothing, fades only, or everything', () => {
    expect(motionMode(ANIM_DEFAULT, false)).toBe('off')
    expect(motionMode({ ...ON, motion: 'device' }, true)).toBe('off')
    expect(motionMode({ ...ON, motion: 'device' }, false)).toBe('full')
    expect(motionMode({ ...ON, motion: 'still' }, false)).toBe('reduced')
    expect(motionMode({ ...ON, motion: 'still' }, true)).toBe('reduced')
    expect(motionMode(ON, true)).toBe('full')
  })

  test('every style has a label', () => {
    expect(STYLE_CHOICES.map(c => c.value)).toEqual([...STYLES])
    expect(STYLES.map(styleLabel)).toEqual(['Subtle', 'Lively', 'Custom'])
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
