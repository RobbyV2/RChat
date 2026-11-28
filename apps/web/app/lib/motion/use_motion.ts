import { useSyncExternalStore } from 'react'
import { useStore } from '../client/react'
import type { SlotId } from './slots'
import { blurringNow, liveNow, watchLive } from './wire'

const REDUCED = '(prefers-reduced-motion: reduce)'

let cached: { match: Window['matchMedia']; list: MediaQueryList } | null = null

// The device's reduced-motion query, made once per `matchMedia`.
const reducedQuery = (): MediaQueryList | null => {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return null
  if (cached?.match !== window.matchMedia)
    cached = { match: window.matchMedia, list: window.matchMedia(REDUCED) }
  return cached.list
}

export const watchReducedMotion = (changed: () => void) => {
  const mq = reducedQuery()
  mq?.addEventListener('change', changed)
  return () => mq?.removeEventListener('change', changed)
}
export const reducedMotionNow = () => reducedQuery()?.matches ?? false

const watchNothing = () => () => {}
const no = () => false

// Whether the device asks for reduced motion; watched only while `asked`.
export function useReducedMotion(asked = true) {
  return useSyncExternalStore(
    asked ? watchReducedMotion : watchNothing,
    asked ? reducedMotionNow : no,
    no
  )
}

const never = () => false

// Whether `slot` moves now: a screen picks its moving or still look with it.
export function useSlotPlays(slot: SlotId) {
  return useSyncExternalStore(watchLive, () => liveNow().has(slot), never)
}

// Whether the backdrop of `slot` blurs now.
export function useSlotBlurs(slot: SlotId) {
  return useSyncExternalStore(watchLive, () => blurringNow().has(slot), never)
}

// Whether the shown account's animations play: callers pick their animated or still look with it.
export function useMotionPlays() {
  const motion = useStore(s => (s.anim.on ? s.anim.motion : null))
  const reduced = useReducedMotion(motion === 'device')
  return motion !== null && motion !== 'still' && !(motion === 'device' && reduced)
}
