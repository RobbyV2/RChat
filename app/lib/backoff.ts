export const BACKOFF_BASE = 1_000
export const BACKOFF_CAP = 30_000
export const BACKOFF_FLOOR = 250
export const STABLE_AFTER = 30_000

export const backoffDelay = (
  attempt: number,
  rand: () => number = Math.random,
  base = BACKOFF_BASE,
  cap = BACKOFF_CAP
): number => {
  const ceiling = Math.min(cap, base * 2 ** Math.max(0, Math.min(attempt, 30)))
  return Math.max(BACKOFF_FLOOR, Math.floor(rand() * ceiling))
}

export const nextAttempt = (attempt: number, openFor: number | null): number =>
  openFor !== null && openFor >= STABLE_AFTER ? 1 : attempt + 1

export const catchUpDelay = (
  outage: number,
  rand: () => number = Math.random,
  cap = BACKOFF_CAP
): number => Math.floor(rand() * Math.min(cap, Math.max(0, outage)))

export const due = (last: number | null, now: number, every: number): boolean =>
  last === null || now - last >= every
