import { describe, expect, test } from 'bun:test'
import { BUILTINS, BUILTIN_NAMES, PRESETS, PRESET_NAMES } from '../motion/presets'
import { PLAY_IDS, type PlaySlot } from '../motion/slots'
import { spring } from '../motion/spring'
import { DURATIONS, EASINGS, SPRINGS } from '../motion/tokens'
import { LIMITS, check, reduced, type Animation } from '../motion/validate'

const gentle = spring(SPRINGS.gentle.stiffness, SPRINGS.gentle.damping)
const bouncy = spring(SPRINGS.bouncy.stiffness, SPRINGS.bouncy.damping)
const first = (a: Animation) => a.keyframes[0]
const last = (a: Animation) => a.keyframes[a.keyframes.length - 1]
const sprung = (a: Animation, s: { easing: string; duration: number }) =>
  a.timing.easing === s.easing && a.timing.duration === s.duration

describe('the presets', () => {
  test('Subtle and Lively each cover the slots the engine plays and nothing else', () => {
    expect(PRESET_NAMES).toEqual(['subtle', 'lively'])
    for (const p of PRESET_NAMES)
      expect(Object.keys(PRESETS[p]).sort()).toEqual([...PLAY_IDS].sort())
  })

  test('every animation moves only transform and opacity, within the limits', () => {
    for (const p of PRESET_NAMES)
      for (const slot of PLAY_IDS) {
        const errors = check(PRESETS[p][slot])
        if (errors.length) throw new Error(`${p} ${slot}: ${errors.join(', ')}`)
      }
  })

  test('every slot has a reduced variant: opacity only, at most 150 ms', () => {
    for (const p of PRESET_NAMES)
      for (const slot of PLAY_IDS) {
        const r = reduced(PRESETS[p][slot])
        if (check(r).length) throw new Error(`${p} ${slot}`)
        if (r.keyframes.some(k => 'transform' in k)) throw new Error(`${p} ${slot} moves`)
        if (r.timing.duration > LIMITS.reducedMs) throw new Error(`${p} ${slot} is long`)
      }
  })

  test('nothing repeats', () => {
    for (const p of PRESET_NAMES)
      for (const slot of PLAY_IDS) expect(PRESETS[p][slot].timing.iterations ?? 1).toBe(1)
  })

  test('Subtle takes its durations and easings from the tokens, with no spring', () => {
    const medium: PlaySlot[] = ['dialog', 'sheet', 'panel', 'drawer', 'thread', 'message.arrive']
    medium.push('reorder', 'toast', 'call.tile', 'lightbox', 'image.reveal', 'banner.unread')
    for (const slot of PLAY_IDS) {
      const { duration, easing } = PRESETS.subtle[slot].timing
      expect(duration).toBe(medium.includes(slot) ? DURATIONS.medium : DURATIONS.short)
      if (!(Object.values(EASINGS) as string[]).includes(easing ?? ''))
        throw new Error(`subtle ${slot} ${easing}`)
    }
  })

  test('Lively uses the gentle spring, the bouncy spring, or stays as Subtle, as the catalog says', () => {
    const GENTLE: PlaySlot[] = ['dialog', 'menu', 'panel', 'drawer', 'thread', 'reorder']
    GENTLE.push('call.tile', 'palette', 'lightbox', 'lightbox.slide', 'banner.unread')
    const BOUNCY: PlaySlot[] = ['sheet', 'message.arrive', 'toast']
    const SAME: PlaySlot[] = ['tooltip', 'typing']
    for (const slot of PLAY_IDS) {
      const a = PRESETS.lively[slot]
      if (GENTLE.includes(slot)) expect(sprung(a, gentle)).toBe(true)
      else if (BOUNCY.includes(slot)) expect(sprung(a, bouncy)).toBe(true)
      else if (SAME.includes(slot)) expect(a).toEqual(PRESETS.subtle[slot])
      else {
        expect(a).not.toEqual(PRESETS.subtle[slot])
        expect(a.timing.easing).toBe(EASINGS.standard)
      }
    }
  })
})

describe("the catalog's numbers", () => {
  const { subtle, lively } = PRESETS

  test('dialogs fade and scale from 0.96, the palette from 0.98', () => {
    expect(first(subtle.dialog)).toEqual({ opacity: 0, transform: 'scale(0.96)' })
    expect(last(subtle.dialog)).toEqual({ opacity: 1, transform: 'scale(1)' })
    expect(first(subtle.palette)).toEqual({ opacity: 0, transform: 'scale(0.98)' })
    expect(lively.dialog.keyframes).toEqual(subtle.dialog.keyframes)
  })

  test('sheets slide up their own height; tooltips wait 300 ms', () => {
    expect(first(subtle.sheet)).toEqual({ transform: 'translateY(100%)' })
    expect(last(subtle.sheet)).toEqual({ transform: 'translateY(0)' })
    expect(subtle.sheet.timing.easing).toBe(EASINGS.decelerate)
    expect(subtle.tooltip.timing).toEqual({ duration: 120, delay: 300, easing: EASINGS.standard })
    expect(subtle.tooltip.keyframes).toEqual([{ opacity: 0 }, { opacity: 1 }])
  })

  test('panels and the thread panel slide 16 px and fade', () => {
    for (const a of [subtle.panel, subtle.thread, lively.panel, lively.thread])
      expect(a.keyframes).toEqual([
        { opacity: 0, transform: 'translateX(16px)' },
        { opacity: 1, transform: 'translateX(0)' },
      ])
  })

  test('routes crossfade, and rise 4 px when Lively', () => {
    expect(subtle.route.keyframes).toEqual([{ opacity: 0 }, { opacity: 1 }])
    expect(first(lively.route)).toEqual({ opacity: 0, transform: 'translateY(4px)' })
    expect(lively.route.timing.duration).toBe(DURATIONS.short)
  })

  test('messages rise 6 px, go from 0.6 when sent with a 2 px settle, and fade out', () => {
    expect(first(subtle['message.arrive'])).toEqual({ opacity: 0, transform: 'translateY(6px)' })
    expect(lively['message.arrive'].keyframes).toEqual(subtle['message.arrive'].keyframes)
    expect(subtle['message.send'].keyframes).toEqual([{ opacity: 0.6 }, { opacity: 1 }])
    expect(first(lively['message.send'])).toEqual({ opacity: 0.6, transform: 'translateY(2px)' })
    expect(subtle['message.remove'].keyframes).toEqual([{ opacity: 1 }, { opacity: 0 }])
    expect(last(lively['message.remove'])).toEqual({ opacity: 0, transform: 'scale(0.98)' })
  })

  test('reactions and badges pop from 0.8, and jiggle when Lively', () => {
    for (const slot of ['reaction.add', 'badge'] as const) {
      expect(subtle[slot].keyframes).toEqual([
        { transform: 'scale(0.8)' },
        { transform: 'scale(1)' },
      ])
      expect(first(lively[slot]).transform).toBe('scale(0.8) rotate(0deg)')
      expect(lively[slot].keyframes.map(k => k.transform).join(' ')).toContain('rotate(-3deg)')
      expect(last(lively[slot]).transform).toBe('scale(1) rotate(0deg)')
    }
    expect(first(subtle['reaction.count']).transform).toBe('translateY(100%)')
    expect(first(lively['reaction.count']).transform).toBe('translateY(100%) scale(0.8)')
  })

  test('reorders hold only their end state, the start is measured', () => {
    expect(subtle.reorder.keyframes).toEqual([{ transform: 'translate(0, 0)' }])
    expect(lively.reorder.keyframes).toEqual(subtle.reorder.keyframes)
  })

  test('the media viewer scales from 0.94, or springs from 0.9, and swaps sideways by 24 px', () => {
    expect(first(subtle.lightbox)).toEqual({ opacity: 0, transform: 'scale(0.94)' })
    expect(first(lively.lightbox)).toEqual({ opacity: 0, transform: 'scale(0.9)' })
    expect(first(subtle['lightbox.slide'])).toEqual({ opacity: 0, transform: 'translateX(24px)' })
    expect(first(lively['lightbox.slide']).transform).toBe('translateX(24px) scale(0.98)')
  })

  test('images fade in, and settle from 1.015 when Lively', () => {
    expect(subtle['image.reveal'].keyframes).toEqual([{ opacity: 0 }, { opacity: 1 }])
    expect(first(lively['image.reveal'])).toEqual({ opacity: 0, transform: 'scale(1.015)' })
    expect(lively['image.reveal'].timing.duration).toBe(DURATIONS.long)
  })

  test('the new messages banner drops in from its own height', () => {
    for (const a of [subtle['banner.unread'], lively['banner.unread']])
      expect(a.keyframes).toEqual([
        { opacity: 0, transform: 'translateY(-100%)' },
        { opacity: 1, transform: 'translateY(0)' },
      ])
  })
})

describe('the named animations', () => {
  test('eight built-ins', () => {
    expect(BUILTIN_NAMES).toEqual([
      'core.fade',
      'core.fade-scale',
      'core.slide',
      'core.rise',
      'core.pop',
      'core.jiggle',
      'core.spring-scale',
      'core.crossfade',
    ])
    expect(Object.keys(BUILTINS)).toEqual([...BUILTIN_NAMES])
  })

  test('each is allowed and has an allowed reduced variant', () => {
    for (const name of BUILTIN_NAMES) {
      if (check(BUILTINS[name]).length) throw new Error(name)
      if (check(reduced(BUILTINS[name])).length) throw new Error(`${name} reduced`)
    }
  })

  test('the presets are made of them', () => {
    expect(PRESETS.subtle.typing).toEqual(BUILTINS['core.fade'])
    expect(PRESETS.subtle.dialog).toEqual(BUILTINS['core.fade-scale'])
    expect(PRESETS.subtle.toast).toEqual(BUILTINS['core.slide'])
    expect(PRESETS.subtle['message.arrive']).toEqual(BUILTINS['core.rise'])
    expect(PRESETS.subtle['reaction.add']).toEqual(BUILTINS['core.pop'])
    expect(PRESETS.lively.dialog).toEqual(BUILTINS['core.spring-scale'])
    expect(PRESETS.subtle.route).toEqual(BUILTINS['core.crossfade'])
  })

  test('the jiggle turns 3 degrees each way, twice, in 240 ms', () => {
    expect(BUILTINS['core.jiggle']).toEqual({
      keyframes: [
        { transform: 'rotate(-3deg)' },
        { transform: 'rotate(3deg)' },
        { transform: 'rotate(0deg)' },
      ],
      timing: { duration: 240, iterations: 2 },
    })
  })

  test('no animation is shared between the tables', () => {
    const all = [...Object.values(BUILTINS)]
    for (const p of PRESET_NAMES) all.push(...Object.values(PRESETS[p]))
    expect(all).toHaveLength(54)
    expect(new Set(all).size).toBe(54)
    expect(new Set(all.map(a => a.timing)).size).toBe(54)
  })
})
