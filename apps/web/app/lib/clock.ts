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

// The runtime's own timer, taken before any test can replace it.
const realTimeout = setTimeout

// One turn of the event loop: what is already queued (promise chains, storage callbacks, timers
// that are due) runs.
export const flush = () => new Promise<void>(done => realTimeout(done, 0))

type Due = {
  at: number
  seq: number
  fn: (at: number) => void
  every: number | null
  handed?: Cancel
}

// A clock that stands still until it is moved. `advance` runs what came due on the way, in order,
// with the clock at each timer's own time; `flush` lets pending promises settle.
export class ManualTime implements Time {
  private wall: number
  private mono = 0
  private seq = 0
  private due: Due[] = []

  constructor(start = 1_700_000_000_000) {
    this.wall = start
  }

  now() {
    return this.wall
  }

  elapsed() {
    return this.mono
  }

  // Timers waiting to run.
  get pending() {
    return this.due.length
  }

  // Sets the wall clock without running timers, as when the device's clock is changed.
  set(wall: number) {
    this.wall = wall
  }

  private add(ms: number, fn: (at: number) => void, every: number | null): Cancel {
    const entry: Due = { at: this.mono + Math.max(0, ms), seq: this.seq++, fn, every }
    this.due.push(entry)
    return () => {
      entry.handed?.()
      const i = this.due.indexOf(entry)
      if (i >= 0) this.due.splice(i, 1)
    }
  }

  after(ms: number, fn: () => void) {
    return this.add(ms, () => fn(), null)
  }

  every(ms: number, fn: () => void) {
    return this.add(ms, () => fn(), Math.max(1, ms))
  }

  frame(fn: (at: number) => void) {
    return this.add(FRAME_MS, fn, null)
  }

  deadline(ms: number) {
    const abort = new AbortController()
    this.add(
      ms,
      () => abort.abort(new DOMException('The operation timed out.', 'TimeoutError')),
      null
    )
    return abort.signal
  }

  private next(until: number) {
    let first: Due | null = null
    for (const d of this.due) {
      if (d.at > until) continue
      if (!first || d.at < first.at || (d.at === first.at && d.seq < first.seq)) first = d
    }
    return first
  }

  private move(to: number) {
    this.wall += to - this.mono
    this.mono = to
  }

  private run(entry: Due) {
    this.move(entry.at)
    if (entry.every === null) this.due.splice(this.due.indexOf(entry), 1)
    else {
      entry.at += entry.every
      entry.seq = this.seq++
    }
    entry.fn(this.mono)
  }

  advance(ms: number) {
    const until = this.mono + ms
    for (let d = this.next(until); d; d = this.next(until)) this.run(d)
    this.move(until)
  }

  // Hands the timers still waiting to `to` with the time each has left, so what set them is not
  // left waiting for a clock that no longer moves.
  release(to: Time) {
    for (const d of this.due.splice(0)) {
      const left = d.at - this.mono
      const every = d.every
      if (every === null) d.handed = to.after(left, () => d.fn(to.elapsed()))
      else
        d.handed = to.after(left, () => {
          d.handed = to.every(every, () => d.fn(to.elapsed()))
          d.fn(to.elapsed())
        })
    }
  }

  // Runs the next timer due within `ms`, if any, with the clock at its time.
  step(ms: number) {
    const d = this.next(this.mono + ms)
    if (d) this.run(d)
    return d !== null
  }

  // Like `advance`, letting what is queued run (`idle`) after each timer, so what a timer started
  // and awaits can set the next one. Stops early once `done` holds.
  async pass(ms: number, done = () => false, idle: () => Promise<unknown> = flush) {
    const until = this.mono + ms
    await idle()
    for (let d = this.next(until); d && !done(); d = this.next(until)) {
      this.run(d)
      await idle()
    }
    if (done()) return
    this.move(until)
    await idle()
  }

  flush() {
    return flush()
  }
}
