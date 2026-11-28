import type { BuiltinName } from './names'
import type { PlaySlot } from './slots'
import { spring } from './spring'
import { DISTANCES, DURATIONS, EASINGS, SPRINGS } from './tokens'
import type { Animation, Frame, Timing } from './validate'

export const PRESET_NAMES = ['subtle', 'lively'] as const
export type PresetName = (typeof PRESET_NAMES)[number]

export { BUILTIN_NAMES, type BuiltinName } from './names'

const { short, medium, long } = DURATIONS
const { settle, lift, rise, slide: slideBy, swap } = DISTANCES
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
const flip = (timing: Timing): Animation => ({
  keyframes: [{ transform: 'translate(0, 0)' }],
  timing,
})

// The named animations a slot can be set to.
export const BUILTINS: Record<BuiltinName, Animation> = {
  'core.fade': fade(eased(short)),
  'core.fade-scale': fadeScale(0.96, eased(medium)),
  'core.slide': slideFade('Y', `${slideBy}px`, eased(medium)),
  'core.rise': slideFade('Y', `${rise}px`, eased(medium)),
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

const SUBTLE: Record<PlaySlot, Animation> = {
  dialog: fadeScale(0.96, eased(medium)),
  sheet: slide('Y', '100%', eased(medium, decelerate)),
  menu: fadeScale(0.96, eased(short)),
  tooltip: fade({ duration: short, delay: 300, easing: standard }),
  panel: slideFade('X', `${slideBy}px`, eased(medium)),
  drawer: slide('X', '-100%', eased(medium)),
  thread: slideFade('X', `${slideBy}px`, eased(medium)),
  route: fade(eased(short)),
  'message.arrive': slideFade('Y', `${rise}px`, eased(medium)),
  'message.send': fade(eased(short), 0.6),
  'message.remove': tween({ opacity: 1 }, { opacity: 0 }, eased(short)),
  'reaction.add': pop(eased(short)),
  'reaction.count': slideFade('Y', '100%', eased(short)),
  badge: pop(eased(short)),
  reorder: flip(eased(medium)),
  toast: slideFade('Y', `${slideBy}px`, eased(medium)),
  typing: fade(eased(short)),
  'call.tile': fadeScale(0.96, eased(medium)),
  palette: fadeScale(0.98, eased(short)),
  lightbox: fadeScale(0.94, eased(medium, decelerate)),
  'lightbox.slide': slideFade('X', `${swap}px`, eased(short)),
  'image.reveal': fade(eased(medium)),
  'banner.unread': slideFade('Y', '-100%', eased(medium, decelerate)),
}

const LIVELY: Record<PlaySlot, Animation> = {
  dialog: fadeScale(0.96, gentle()),
  sheet: slide('Y', '100%', bouncy()),
  menu: fadeScale(0.96, gentle()),
  tooltip: fade({ duration: short, delay: 300, easing: standard }),
  panel: slideFade('X', `${slideBy}px`, gentle()),
  drawer: slide('X', '-100%', gentle()),
  thread: slideFade('X', `${slideBy}px`, gentle()),
  route: slideFade('Y', `${lift}px`, eased(short)),
  'message.arrive': slideFade('Y', `${rise}px`, bouncy()),
  'message.send': slideFade('Y', `${settle}px`, eased(short), 0.6),
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
  reorder: flip(gentle()),
  toast: slideFade('Y', `${slideBy}px`, bouncy()),
  typing: fade(eased(short)),
  'call.tile': fadeScale(0.96, gentle()),
  palette: fadeScale(0.98, gentle()),
  lightbox: fadeScale(0.9, gentle()),
  'lightbox.slide': tween(
    { opacity: 0, transform: `translateX(${swap}px) scale(0.98)` },
    { opacity: 1, transform: 'translateX(0) scale(1)' },
    gentle()
  ),
  'image.reveal': tween(
    { opacity: 0, transform: 'scale(1.015)' },
    { opacity: 1, transform: 'scale(1)' },
    eased(long)
  ),
  'banner.unread': slideFade('Y', '-100%', gentle()),
}

// Each slot's animation as it plays (see the slot's `plays`).
export const PRESETS: Record<PresetName, Record<PlaySlot, Animation>> = {
  subtle: SUBTLE,
  lively: LIVELY,
}
