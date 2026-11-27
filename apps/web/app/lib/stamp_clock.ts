import type { Cancel } from './clock'
import { time } from './platform/time'
import { tickDelay } from './timestamps'

// One clock for every relative timestamp on screen. Each live pill registers its target time;
// the clock ticks every second while one is under a minute away, otherwise every minute.
const targets = new Map<symbol, number>()
const listeners = new Set<() => void>()
let now = time().now()
let timer: Cancel | null = null

const dayListeners = new Set<() => void>()
let dayVersion = 0
let dayTimer: Cancel | null = null

// Milliseconds until shortly after the next local midnight.
const untilTomorrow = () => {
  const t = new Date(time().now())
  const wait = new Date(t.getFullYear(), t.getMonth(), t.getDate() + 1).getTime() - t.getTime()
  return Math.max(1000, wait + 500)
}

export const refreshDay = () => {
  dayTimer?.()
  dayTimer = null
  dayVersion++
  for (const l of dayListeners) l()
  if (!dayListeners.size) return
  dayTimer = time().after(untilTomorrow(), refreshDay)
}

export const subscribeDay = (l: () => void) => {
  dayListeners.add(l)
  if (dayTimer === null) dayTimer = time().after(untilTomorrow(), refreshDay)
  return () => {
    dayListeners.delete(l)
    if (!dayListeners.size && dayTimer !== null) {
      dayTimer()
      dayTimer = null
    }
  }
}

export const daySnapshot = () => dayVersion

const schedule = () => {
  timer?.()
  timer = null
  const wait = tickDelay([...targets.values()], time().now())
  if (wait === null) return
  timer = time().after(wait, () => {
    now = time().now()
    for (const l of listeners) l()
    schedule()
  })
}

export const refresh = () => {
  now = time().now()
  for (const l of listeners) l()
  schedule()
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      refresh()
      refreshDay()
    }
  })
}

export const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => void listeners.delete(l)
}

export const snapshot = () => now

export function track(target: number) {
  const key = Symbol()
  targets.set(key, target)
  refresh()
  return () => {
    targets.delete(key)
    schedule()
  }
}
