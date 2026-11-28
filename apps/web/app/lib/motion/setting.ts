// The account's Animations setting on this device (`rchat_anim:{username|guest}` through
// `writeLocal`): the switch, off by default, the style, the Custom style's choice per slot, and
// the Motion choice, which fun effects read too (their gate's `motion`). Versioned and parsed
// field by field. Pure.
import type { MotionChoice } from '../fx/gate'
import { BUILTIN_LABELS, BUILTIN_NAMES, isBuiltin, type BuiltinName } from './names'
import { SLOT_IDS, isLook, type SlotId } from './slots'
import { defineSetting } from '../settings'

export const STYLES = ['subtle', 'lively', 'custom'] as const
export type AnimStyle = (typeof STYLES)[number]

// What a slot is set to in the Custom style: nothing, or a named animation in place of its own.
// A slot the style sheet moves is only ever on or off.
export type SlotChoice = 'off' | BuiltinName
export type CustomChoices = Readonly<Partial<Record<SlotId, SlotChoice>>>

export interface AnimPrefs {
  on: boolean
  motion: MotionChoice
  style: AnimStyle
  custom: CustomChoices
}

const NO_CHOICES: CustomChoices = Object.freeze({})

export const ANIM_DEFAULT: AnimPrefs = {
  on: false,
  motion: 'device',
  style: 'subtle',
  custom: NO_CHOICES,
}

export const animKey = (username: string | null) => `rchat_anim:${username ?? 'guest'}`

export const isMotionChoice = (x: unknown): x is MotionChoice =>
  x === 'device' || x === 'still' || x === 'always'

export const isStyle = (x: unknown): x is AnimStyle =>
  typeof x === 'string' && (STYLES as readonly string[]).includes(x)

const isSlot = (x: string): x is SlotId => (SLOT_IDS as readonly string[]).includes(x)

// The choices a slot can take, besides its own animation.
export const slotChoices = (slot: SlotId): readonly SlotChoice[] =>
  isLook(slot) ? ['off'] : ['off', ...BUILTIN_NAMES]

// Known slots with a choice they can take; the rest is dropped.
export const cleanChoices = (x: unknown): CustomChoices => {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return NO_CHOICES
  const out: Partial<Record<SlotId, SlotChoice>> = {}
  for (const [slot, choice] of Object.entries(x as Record<string, unknown>)) {
    if (!isSlot(slot)) continue
    if (choice === 'off' || (isBuiltin(choice) && !isLook(slot))) out[slot] = choice
  }
  return Object.keys(out).length ? out : NO_CHOICES
}

export const parseAnim = (raw: string | null): AnimPrefs => {
  try {
    const data = raw ? (JSON.parse(raw) as unknown) : null
    if (typeof data !== 'object' || data === null || Array.isArray(data)) return ANIM_DEFAULT
    const { v, on, motion, style, custom } = data as Record<string, unknown>
    if (v !== 1) return ANIM_DEFAULT
    return {
      on: typeof on === 'boolean' ? on : ANIM_DEFAULT.on,
      motion: isMotionChoice(motion) ? motion : ANIM_DEFAULT.motion,
      style: isStyle(style) ? style : ANIM_DEFAULT.style,
      custom: cleanChoices(custom),
    }
  } catch {
    return ANIM_DEFAULT
  }
}

const sorted = (c: CustomChoices) =>
  Object.fromEntries(Object.entries(c).sort(([a], [b]) => (a < b ? -1 : 1)))

export const animValue = ({ on, motion, style, custom }: AnimPrefs) =>
  JSON.stringify({ v: 1, on, motion, style, custom: sorted(custom) })

export const animSetting = defineSetting<AnimPrefs, [string | null]>({
  scope: 'account',
  key: animKey,
  decode: parseAnim,
  encode: animValue,
})

export const sameAnim = (a: AnimPrefs, b: AnimPrefs) => animValue(a) === animValue(b)

// How much may move on this device: the Motion choice with what the device asks for. Nothing
// while Motion follows a device that asks for reduced motion, fades and still pictures with
// Motion at Reduced, everything otherwise. Animated pictures and video that plays by itself read
// this, whatever the Animations switch says.
export type MotionMode = 'off' | 'reduced' | 'full'
export const motionAllowed = (motion: MotionChoice, reducedMotion: boolean): MotionMode =>
  motion === 'device' && reducedMotion ? 'off' : motion === 'still' ? 'reduced' : 'full'

// How much the Animations setting moves: nothing with the switch off, else what Motion allows.
export const motionMode = ({ on, motion }: AnimPrefs, reducedMotion: boolean): MotionMode =>
  on ? motionAllowed(motion, reducedMotion) : 'off'

// Whether things move.
export const motionPlays = (p: AnimPrefs, reducedMotion: boolean) =>
  motionMode(p, reducedMotion) === 'full'

export const MOTION_CHOICES: readonly { value: MotionChoice; label: string }[] = [
  { value: 'device', label: 'Follow my device' },
  { value: 'still', label: 'Reduced' },
  { value: 'always', label: 'Play motion anyway' },
]

export const motionLabel = (m: MotionChoice) => MOTION_CHOICES.find(c => c.value === m)?.label ?? m

export const STYLE_CHOICES: readonly { value: AnimStyle; label: string }[] = [
  { value: 'subtle', label: 'Subtle' },
  { value: 'lively', label: 'Lively' },
  { value: 'custom', label: 'Custom' },
]

export const styleLabel = (s: AnimStyle) => STYLE_CHOICES.find(c => c.value === s)?.label ?? s

// A slot's row in Customize: its own animation first, then what else it can be set to.
export const OWN = 'own'
export const choiceOptions = (slot: SlotId): readonly { value: string; label: string }[] => [
  { value: OWN, label: isLook(slot) ? 'On' : 'Default' },
  ...slotChoices(slot).map(c => ({ value: c, label: c === 'off' ? 'Off' : BUILTIN_LABELS[c] })),
]

export const withChoice = (p: AnimPrefs, slot: SlotId, choice: string): AnimPrefs => {
  const { [slot]: _, ...rest } = p.custom
  void _
  const taken = slotChoices(slot).find(c => c === choice)
  return { ...p, custom: taken ? { ...rest, [slot]: taken } : rest }
}

// What Settings says under the Motion choice while the switch is on and nothing moves, or null.
export const animHeldBack = (p: AnimPrefs, reducedMotion: boolean): string | null => {
  if (!p.on) return null
  if (p.motion === 'still') return 'Motion is set to Reduced, so things change without moving.'
  if (p.motion === 'device' && reducedMotion)
    return 'Your device asks for less motion, so things change without moving.'
  return null
}
