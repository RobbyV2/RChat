import { FRAME_MS, type Cancel, type Time } from '../../clock'
import { deviceTime, setTime } from '../../platform/time'
import { own } from './fixture'

// The runtime's own timer, taken before any test can replace it.
const realTimeout = setTimeout

// One turn of the event loop: what is already queued (promise chains, storage callbacks, timers
// that are due) runs.
export const flush = () => new Promise<void>(done => realTimeout(done, 0))

// Waits until `ok()` holds, however slow the machine is, looking again every 2 ms of device time
// so the checks leave the work they wait for room to run. A wait that never ends fails with
// `what` after `ms`, so it cannot outlive its test.
export const waitUntil = async (
  ok: () => boolean | Promise<boolean>,
  what = 'condition',
  ms = 50_000
) => {
  const end = Date.now() + ms
  while (!(await ok())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await new Promise<void>(done => realTimeout(done, 2))
  }
}

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

// A clock the test moves by hand, in use until the test (or the file, made outside a test) ends.
// Every session runs on it, also the ones made before. It starts at the device's time, and the
// timers it still holds at the end go on with the device's.
export function testClock(start = Date.now()) {
  const clock = new ManualTime(start)
  setTime(clock)
  active = clock
  return own(clock, () => {
    setTime()
    active = null
    clock.release(deviceTime)
  })
}

let active: ManualTime | null = null

// The test clock in use, if the test set one.
export const activeClock = () => active
