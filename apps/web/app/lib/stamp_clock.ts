import { tickDelay } from './timestamps'

// One clock for every relative timestamp on screen. Each live pill registers its target time;
// the clock ticks every second while one is under a minute away, otherwise every minute.
const targets = new Map<symbol, number>()
const listeners = new Set<() => void>()
let now = Date.now()
let timer: ReturnType<typeof setTimeout> | null = null

const dayListeners = new Set<() => void>()
let dayVersion = 0
let dayTimer: ReturnType<typeof setTimeout> | null = null

export const refreshDay = () => {
  if (dayTimer !== null) clearTimeout(dayTimer)
  dayTimer = null
  dayVersion++
  for (const l of dayListeners) l()
  if (!dayListeners.size) return
  const t = new Date()
  const wait = new Date(t.getFullYear(), t.getMonth(), t.getDate() + 1).getTime() - t.getTime()
  dayTimer = setTimeout(refreshDay, Math.max(1000, wait + 500))
}

export const subscribeDay = (l: () => void) => {
  dayListeners.add(l)
  if (dayTimer === null) {
    const t = new Date()
    const wait = new Date(t.getFullYear(), t.getMonth(), t.getDate() + 1).getTime() - t.getTime()
    dayTimer = setTimeout(refreshDay, Math.max(1000, wait + 500))
  }
  return () => {
    dayListeners.delete(l)
    if (!dayListeners.size && dayTimer !== null) {
      clearTimeout(dayTimer)
      dayTimer = null
    }
  }
}

export const daySnapshot = () => dayVersion

const schedule = () => {
  if (timer !== null) clearTimeout(timer)
  timer = null
  const wait = tickDelay([...targets.values()], Date.now())
  if (wait === null) return
  timer = setTimeout(() => {
    now = Date.now()
    for (const l of listeners) l()
    schedule()
  }, wait)
}

export const refresh = () => {
  now = Date.now()
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
