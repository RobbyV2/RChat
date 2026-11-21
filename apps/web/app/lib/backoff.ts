const BACKOFF_BASE = 1_000
export const BACKOFF_CAP = 30_000
export const BACKOFF_FLOOR = 250
const STABLE_AFTER = 30_000

export const backoffDelay = (
  attempt: number,
  rand: () => number = Math.random,
  base = BACKOFF_BASE,
  cap = BACKOFF_CAP,
  floor = BACKOFF_FLOOR
): number => {
  const ceiling = Math.min(cap, base * 2 ** Math.max(0, Math.min(attempt, 30)))
  return Math.max(floor, Math.floor(rand() * ceiling))
}

// The realtime reconnect timings an instance sets.
export interface ReconnectTimings {
  reconnect_base_ms: number
  reconnect_cap_ms: number
  reconnect_floor_ms: number
}

// The wait before reconnect `attempt` under `timings`.
export const reconnectDelay = (
  attempt: number,
  timings: ReconnectTimings,
  rand: () => number = Math.random
): number =>
  backoffDelay(
    attempt,
    rand,
    timings.reconnect_base_ms,
    timings.reconnect_cap_ms,
    timings.reconnect_floor_ms
  )

export const nextAttempt = (attempt: number, openFor: number | null): number =>
  openFor !== null && openFor >= STABLE_AFTER ? 1 : attempt + 1

export const catchUpDelay = (
  outage: number,
  rand: () => number = Math.random,
  cap = BACKOFF_CAP
): number => Math.floor(rand() * Math.min(cap, Math.max(0, outage)))

export const due = (last: number | null, now: number, every: number): boolean =>
  last === null || now - last >= every
