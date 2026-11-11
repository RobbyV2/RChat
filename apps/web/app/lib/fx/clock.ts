// The day cache: the device's local civil day and the seasons on it, worked out once a day.
// The day is checked again at local midnight and when the page is shown (timers sleep in the
// background). The clock, the timer and the page listener are passed in.
import {
  activeSeasons,
  localToday,
  setTermOffset,
  type ActiveSeason,
  type Hemisphere,
  type SeasonId,
} from './seasons'

export interface ClockDeps {
  now(): Date
  setTimer(cb: () => void, ms: number): unknown
  clearTimer(id: unknown): void
  // Calls `cb` when the page becomes visible; returns the way to stop.
  onVisible(cb: () => void): () => void
  // Minutes east of UTC at an instant; the device's zone when left out.
  offsetAt?(ms: number): number
}

export interface FxClock {
  today(): number
  onDayChange(cb: (today: number) => void): () => void
  seasons(hemisphere: Hemisphere, off?: ReadonlySet<SeasonId>): ActiveSeason[]
  stop(): void
}

export const localOffset = (ms: number) => -new Date(ms).getTimezoneOffset()

export function createClock(deps: ClockDeps): FxClock {
  setTermOffset(deps.offsetAt ?? localOffset)
  const listeners = new Set<(today: number) => void>()
  let today = 0
  let timer: unknown = null
  let stopped = false
  let cached: { key: string; active: ActiveSeason[] } | null = null

  const arm = () => {
    const next = localToday(deps.now())
    if (timer !== null) deps.clearTimer(timer)
    timer = deps.setTimer(check, next.msToNext)
    return next.today
  }
  const check = () => {
    if (stopped) return
    const day = arm()
    if (day === today) return
    today = day
    cached = null
    for (const cb of [...listeners]) cb(day)
  }
  today = arm()
  const unwatch = deps.onVisible(check)

  return {
    today: () => today,
    onDayChange(cb) {
      listeners.add(cb)
      return () => {
        listeners.delete(cb)
      }
    },
    seasons(hemisphere, off = new Set()) {
      const key = `${today} ${hemisphere} ${[...off].sort().join(',')}`
      if (cached?.key !== key) cached = { key, active: activeSeasons(today, hemisphere, off) }
      return cached.active
    },
    stop() {
      stopped = true
      if (timer !== null) deps.clearTimer(timer)
      timer = null
      unwatch()
      listeners.clear()
    },
  }
}
