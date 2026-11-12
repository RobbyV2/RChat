import type { SlotId } from './slots'
import { spring } from './spring'
import { DURATIONS, EASINGS, SPRINGS } from './tokens'
import type { Animation, Frame, Timing } from './validate'

export const PRESET_NAMES = ['subtle', 'lively'] as const
export type PresetName = (typeof PRESET_NAMES)[number]

export const BUILTIN_NAMES = [
  'core.fade',
  'core.fade-scale',
  'core.slide',
  'core.rise',
  'core.pop',
  'core.jiggle',
  'core.spring-scale',
  'core.crossfade',
] as const
export type BuiltinName = (typeof BUILTIN_NAMES)[number]

const { short, medium } = DURATIONS
const { standard, decelerate } = EASINGS

const eased = (duration: number, easing: string = standard): Timing => ({ duration, easing })
const sprung = ({ stiffness, damping }: { stiffness: number; damping: number }): Timing => {
  const { easing, duration } = spring(stiffness, damping)
  return { duration, easing }
}
const gentle = () => sprung(SPRINGS.gentle)
const bouncy = () => sprung(SPRINGS.bouncy)

const tween = (from: Frame, to: Frame, timing: Timing): Animation => ({
  keyframes: [from, to],
  timing,
})
const fade = (timing: Timing, from = 0) => tween({ opacity: from }, { opacity: 1 }, timing)
const fadeScale = (scale: number, timing: Timing) =>
  tween({ opacity: 0, transform: `scale(${scale})` }, { opacity: 1, transform: 'scale(1)' }, timing)
const slide = (axis: 'X' | 'Y', by: string, timing: Timing) =>
  tween({ transform: `translate${axis}(${by})` }, { transform: `translate${axis}(0)` }, timing)
const slideFade = (axis: 'X' | 'Y', by: string, timing: Timing, from = 0) =>
  tween(
    { opacity: from, transform: `translate${axis}(${by})` },
    { opacity: 1, transform: `translate${axis}(0)` },
    timing
  )
const scaleTo = (scale: number, timing: Timing) =>
  tween({ transform: 'scale(1)' }, { transform: `scale(${scale})` }, timing)
const pop = (timing: Timing) =>
  tween({ transform: 'scale(0.8)' }, { transform: 'scale(1)' }, timing)
const popJiggle = (): Animation => ({
  keyframes: [
    { transform: 'scale(0.8) rotate(0deg)' },
    { offset: 0.4, transform: 'scale(1) rotate(-3deg)' },
    { offset: 0.7, transform: 'scale(1) rotate(3deg)' },
    { transform: 'scale(1) rotate(0deg)' },
  ],
  timing: eased(medium),
})
const lift = (timing: Timing) =>
  tween({ opacity: 1, transform: 'scale(1)' }, { opacity: 0.9, transform: 'scale(1.03)' }, timing)
const flip = (timing: Timing): Animation => ({
  keyframes: [{ transform: 'translate(0, 0)' }],
  timing,
})

// The named animations a slot can be set to.
export const BUILTINS: Record<BuiltinName, Animation> = {
  'core.fade': fade(eased(short)),
  'core.fade-scale': fadeScale(0.96, eased(medium)),
  'core.slide': slideFade('Y', '16px', eased(medium)),
  'core.rise': slideFade('Y', '6px', eased(medium)),
  'core.pop': pop(eased(short)),
  'core.jiggle': {
    keyframes: [
      { transform: 'rotate(-3deg)' },
      { transform: 'rotate(3deg)' },
      { transform: 'rotate(0deg)' },
    ],
    timing: { duration: 240, iterations: 2 },
  },
  'core.spring-scale': fadeScale(0.96, gentle()),
  'core.crossfade': fade(eased(short)),
}

const SUBTLE: Record<SlotId, Animation> = {
  dialog: fadeScale(0.96, eased(medium)),
  sheet: slide('Y', '100%', eased(medium, decelerate)),
  menu: fadeScale(0.96, eased(short)),
  tooltip: fade({ duration: short, delay: 300, easing: standard }),
  panel: slideFade('X', '16px', eased(medium)),
  drawer: slide('X', '-100%', eased(medium)),
  thread: slideFade('X', '16px', eased(medium)),
  route: fade(eased(short)),
  'message.arrive': slideFade('Y', '6px', eased(medium)),
  'message.send': fade(eased(short), 0.6),
  'message.remove': tween({ opacity: 1 }, { opacity: 0 }, eased(short)),
  'reaction.add': pop(eased(short)),
  'reaction.count': slideFade('Y', '100%', eased(short)),
  badge: pop(eased(short)),
  press: scaleTo(0.97, eased(short)),
  hover: scaleTo(1.03, eased(short)),
  reorder: flip(eased(medium)),
  drag: lift(eased(short)),
  toast: slideFade('Y', '16px', eased(medium)),
  typing: fade(eased(short)),
  'call.tile': fadeScale(0.96, eased(medium)),
  palette: fadeScale(0.98, eased(short)),
  toggle: slide('X', '-100%', eased(short)),
  expand: fade(eased(short)),
}

const LIVELY: Record<SlotId, Animation> = {
  dialog: fadeScale(0.96, gentle()),
  sheet: slide('Y', '100%', bouncy()),
  menu: fadeScale(0.96, gentle()),
  tooltip: fade({ duration: short, delay: 300, easing: standard }),
  panel: slideFade('X', '16px', gentle()),
  drawer: slide('X', '-100%', gentle()),
  thread: slideFade('X', '16px', gentle()),
  route: slideFade('Y', '4px', eased(short)),
  'message.arrive': slideFade('Y', '6px', bouncy()),
  'message.send': slideFade('Y', '2px', eased(short), 0.6),
  'message.remove': tween(
    { opacity: 1, transform: 'scale(1)' },
    { opacity: 0, transform: 'scale(0.98)' },
    eased(short)
  ),
  'reaction.add': popJiggle(),
  'reaction.count': tween(
    { opacity: 0, transform: 'translateY(100%) scale(0.8)' },
    { opacity: 1, transform: 'translateY(0) scale(1)' },
    eased(short)
  ),
  badge: popJiggle(),
  press: scaleTo(0.97, eased(short)),
  hover: scaleTo(1.03, gentle()),
  reorder: flip(gentle()),
  drag: lift(bouncy()),
  toast: slideFade('Y', '16px', bouncy()),
  typing: fade(eased(short)),
  'call.tile': fadeScale(0.96, gentle()),
  palette: fadeScale(0.98, gentle()),
  toggle: slide('X', '-100%', bouncy()),
  expand: fade(eased(short)),
}

// Each slot's animation as it plays (see the slot's `plays`).
export const PRESETS: Record<PresetName, Record<SlotId, Animation>> = {
  subtle: SUBTLE,
  lively: LIVELY,
}

// The chevron of the expand slot, beside its content fade. A quarter turn is more than a plugin
// animation may rotate.
export const CHEVRON: Animation = tween(
  { transform: 'rotate(-90deg)' },
  { transform: 'rotate(0deg)' },
  eased(short)
)
