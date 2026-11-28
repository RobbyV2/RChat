// Time as the app sees it. Code that needs the time or a timer takes these from its account
// session (`session.time`, `useClock()`), or from `time()` in `platform/time.ts` where no session
// is at hand, so a test runs all of it on a clock it moves by hand.

export type Cancel = () => void

export interface Clock {
  // Unix milliseconds.
  now(): number
  // Milliseconds that only move forward, for measuring how long something took.
  elapsed(): number
}

export interface Scheduler {
  after(ms: number, fn: () => void): Cancel
  every(ms: number, fn: () => void): Cancel
  // Before the next repaint; `fn` gets the `elapsed` time of that frame.
  frame(fn: (at: number) => void): Cancel
  // A signal that aborts with a `TimeoutError` once `ms` passed.
  deadline(ms: number): AbortSignal
}

export interface Time extends Clock, Scheduler {}

// Resolves once `ms` passed on `on`.
export const sleep = (on: Scheduler, ms: number) => new Promise<void>(done => on.after(ms, done))

export const FRAME_MS = 16
