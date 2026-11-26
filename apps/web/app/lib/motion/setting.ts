// The account's Animations setting on this device (`rchat_anim:{username|guest}` through
// `writeLocal`): the switch, off by default, and the Motion choice, which fun effects read too
// (their gate's `motion`). Versioned and parsed field by field. Pure.
import type { MotionChoice } from '../fx/gate'

export interface AnimPrefs {
  on: boolean
  motion: MotionChoice
}

export const ANIM_DEFAULT: AnimPrefs = { on: false, motion: 'device' }

export const animKey = (username: string | null) => `rchat_anim:${username ?? 'guest'}`

export const isMotionChoice = (x: unknown): x is MotionChoice =>
  x === 'device' || x === 'still' || x === 'always'

export const parseAnim = (raw: string | null): AnimPrefs => {
  try {
    const data = raw ? (JSON.parse(raw) as unknown) : null
    if (typeof data !== 'object' || data === null || Array.isArray(data)) return ANIM_DEFAULT
    const { v, on, motion } = data as Record<string, unknown>
    if (v !== 1) return ANIM_DEFAULT
    return {
      on: typeof on === 'boolean' ? on : ANIM_DEFAULT.on,
      motion: isMotionChoice(motion) ? motion : ANIM_DEFAULT.motion,
    }
  } catch {
    return ANIM_DEFAULT
  }
}

export const animValue = ({ on, motion }: AnimPrefs) => JSON.stringify({ v: 1, on, motion })

export const sameAnim = (a: AnimPrefs, b: AnimPrefs) => a.on === b.on && a.motion === b.motion

// Whether things move: never with the switch off or Motion at Reduced, and not while Motion
// follows a device that asks for reduced motion.
export const motionPlays = ({ on, motion }: AnimPrefs, reducedMotion: boolean) =>
  on && motion !== 'still' && !(motion === 'device' && reducedMotion)

export const MOTION_CHOICES: readonly { value: MotionChoice; label: string }[] = [
  { value: 'device', label: 'Follow my device' },
  { value: 'still', label: 'Reduced' },
  { value: 'always', label: 'Play motion anyway' },
]

export const motionLabel = (m: MotionChoice) => MOTION_CHOICES.find(c => c.value === m)?.label ?? m

// What Settings says under the Motion choice while the switch is on and nothing moves, or null.
export const animHeldBack = (p: AnimPrefs, reducedMotion: boolean): string | null => {
  if (!p.on) return null
  if (p.motion === 'still') return 'Motion is set to Reduced, so things change without moving.'
  if (p.motion === 'device' && reducedMotion)
    return 'Your device asks for less motion, so things change without moving.'
  return null
}
