// Small helpers the P2P modules share: a sliding-window rate counter and a code-point cut.

// Events in a sliding window: at most `max` (read at each check when a function) within
// `windowMs`. `times` holds them, oldest first, and may be a caller's array (kept in place).
// An event may weigh more than one (`note(now, n)`).
export class RateWindow {
  private sizes: number[] | null = null
  constructor(
    readonly windowMs: number,
    private readonly max: number | (() => number),
    readonly times: number[] = []
  ) {}

  get limit() {
    return typeof this.max === 'function' ? this.max() : this.max
  }

  // Forgets the events older than the window; what the rest weighs.
  count(now: number): number {
    let keep = 0
    for (let i = 0; i < this.times.length; i++)
      if (now - this.times[i] < this.windowMs) {
        this.times[keep] = this.times[i]
        if (this.sizes) this.sizes[keep] = this.sizes[i]
        keep++
      }
    this.times.length = keep
    if (this.sizes) {
      this.sizes.length = keep
      return this.sizes.reduce((a, n) => a + n, 0)
    }
    return keep
  }

  // Records an event at `now` while the window holds fewer than `max`; false (nothing recorded)
  // past it.
  hit(now: number): boolean {
    if (this.count(now) >= this.limit) return false
    this.note(now)
    return true
  }

  // Records an event whatever the count.
  note(now: number, n = 1) {
    if (n !== 1 || this.sizes) (this.sizes ??= this.times.map(() => 1)).push(n)
    this.times.push(now)
  }

  // Takes back the latest event recorded at `at` (one that didn't happen after all).
  drop(at: number) {
    const i = this.times.lastIndexOf(at)
    if (i < 0) return
    this.times.splice(i, 1)
    this.sizes?.splice(i, 1)
  }

  // The oldest event still recorded.
  oldest(): number | undefined {
    return this.times[0]
  }

  // Whether every recorded event is out of the window.
  idle(now: number) {
    return this.times.every(t => now - t >= this.windowMs)
  }
}

// The first `n` code points of `s`.
export const clip = (s: string, n: number) => Array.from(s).slice(0, n).join('')
