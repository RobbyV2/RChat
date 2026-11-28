import { useSyncExternalStore } from 'react'
import { useStore } from '../client/react'
import { motionAllowed, type MotionMode } from './setting'
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

// How much may move for the shown account on this device (see `motionAllowed`).
export function useMotionAllowed(): MotionMode {
  const motion = useStore(s => s.anim.motion)
  return motionAllowed(motion, useReducedMotion(motion === 'device'))
}

// Whether `slot` moves now: a screen picks its moving or still look with it.
export function useSlotPlays(slot: SlotId) {
  const plays = () => liveNow().has(slot)
  return useSyncExternalStore(watchLive, plays, plays)
}

// Whether the backdrop of `slot` blurs now.
export function useSlotBlurs(slot: SlotId) {
  const blurs = () => blurringNow().has(slot)
  return useSyncExternalStore(watchLive, blurs, blurs)
}
