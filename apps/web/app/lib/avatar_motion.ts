// When an animated picture plays on this device, for people and servers alike: only while
// something points at it (the pointer over its row or the picture, its person speaking, its
// open profile), always, or never.
export const ANIMATE_MODES = ['hover', 'always', 'never'] as const
export type AnimateMode = (typeof ANIMATE_MODES)[number]

export const ANIMATE_MODE_CHOICES: readonly { value: AnimateMode; label: string }[] = [
  { value: 'hover', label: 'When pointed at' },
  { value: 'always', label: 'Always' },
  { value: 'never', label: 'Never' },
]

export const ANIMATE_MODE_NOTES: Record<AnimateMode, string> = {
  hover:
    'Animated pictures play while the pointer is over them or their row, while that person speaks, and in an open profile.',
  always: 'Animated pictures on screen play, up to 8 at once.',
  never: 'Animated pictures show their first frame.',
}

export const REDUCED_MOTION_NOTE = 'Motion is reduced, so pictures show their first frame.'

// A stored value as a mode: anything else is the default.
export const parseAnimateMode = (raw: unknown): AnimateMode =>
  (ANIMATE_MODES as readonly unknown[]).includes(raw) ? (raw as AnimateMode) : 'hover'

// Whether an animated picture wants to play: never with reduced motion, else by the mode and
// whether something points at it.
export const wantsToPlay = (mode: AnimateMode, moves: boolean, pointed: boolean) =>
  moves && (mode === 'always' || (mode === 'hover' && pointed))

// Animated pictures playing at once in this tab.
export const PLAYING_MAX = 8

// The places among the pictures playing at once: a picture plays only while it holds one.
export const playSlots = (max = PLAYING_MAX) => {
  const held = new Set<object>()
  return {
    take(who: object) {
      if (held.has(who)) return true
      if (held.size >= max) return false
      held.add(who)
      return true
    },
    give(who: object) {
      held.delete(who)
    },
    count: () => held.size,
  }
}

export const slots = playSlots()

// What a pointer over it makes the pictures inside play: a message, a member row, a voice row,
// a tile marked for it, or the picture itself.
export const HOVER_SCOPES =
  '[data-row], [data-member], [data-voice-member], [data-animate], [data-avatar-picture]'

type Listener = () => void

let hovered: Element | null = null
const listeners = new Set<Listener>()
let stop: (() => void) | null = null

const tell = () => {
  for (const fn of listeners) fn()
}

const start = () => {
  const over = (e: PointerEvent) => {
    // A touch points at nothing once it lifts: touch plays in an open profile and for speakers.
    const next =
      e.pointerType === 'touch' || !(e.target instanceof Element)
        ? null
        : e.target.closest(HOVER_SCOPES)
    if (next === hovered) return
    hovered = next
    tell()
  }
  const out = (e: PointerEvent) => {
    if (e.relatedTarget !== null || hovered === null) return
    hovered = null
    tell()
  }
  // A voice row marks who speaks in the page: the pictures in it follow that mark.
  const speaking = new MutationObserver(tell)
  document.addEventListener('pointerover', over, { passive: true })
  document.addEventListener('pointerout', out, { passive: true })
  speaking.observe(document.body, {
    attributes: true,
    attributeFilter: ['data-speaking'],
    subtree: true,
  })
  return () => {
    document.removeEventListener('pointerover', over)
    document.removeEventListener('pointerout', out)
    speaking.disconnect()
    hovered = null
  }
}

// Tells `fn` when what the pointer is over, or who speaks, may have changed. The page is
// watched only while a picture listens.
export const watchPointed = (fn: Listener) => {
  listeners.add(fn)
  if (!stop && typeof document !== 'undefined') stop = start()
  return () => {
    listeners.delete(fn)
    if (listeners.size === 0 && stop) {
      stop()
      stop = null
    }
  }
}

// Whether something points at the picture `el`: the pointer is over it or the row that holds
// it, or it sits in something marked as speaking.
export const pointedAt = (el: Element | null) =>
  !!el && ((hovered !== null && hovered.contains(el)) || el.closest('[data-speaking]') !== null)
