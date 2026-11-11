import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { dayAt, dayNum, solarTermMs } from '../fx/astro'
import { createClock, localOffset, type ClockDeps } from '../fx/clock'
import { activeSeasons, setTermOffset, type SeasonId } from '../fx/seasons'

// A device clock the test moves: `run` lets time pass with the tab awake (a due timer fires),
// `sleep` jumps it with timers asleep, as in a background tab or after the user sets the clock.
const device = (start: Date) => {
  let now = start.getTime()
  let timer: { id: number; at: number; cb: () => void } | null = null
  let ids = 0
  const shown = new Set<() => void>()
  const deps: ClockDeps = {
    now: () => new Date(now),
    setTimer: (cb, ms) => {
      timer = { id: ++ids, at: now + ms, cb }
      return timer.id
    },
    clearTimer: id => {
      if (timer?.id === id) timer = null
    },
    onVisible: cb => {
      shown.add(cb)
      return () => shown.delete(cb)
    },
  }
  return {
    deps,
    run(ms: number) {
      const end = now + ms
      while (timer && timer.at <= end) {
        const due = timer
        timer = null
        now = due.at
        due.cb()
      }
      now = end
    },
    sleep(to: Date) {
      now = to.getTime()
    },
    fire() {
      const due = timer
      timer = null
      due?.cb()
    },
    show() {
      for (const cb of [...shown]) cb()
    },
    timerIn: () => (timer ? timer.at - now : null),
    watchers: () => shown.size,
  }
}

// Bun follows `process.env.TZ` as it changes. Every test starts in UTC, and the zone the suite
// ran in is put back by name: deleting the variable would leave the machine's zone, not the
// test runner's.
const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
beforeEach(() => {
  process.env.TZ = 'UTC'
})
afterEach(() => {
  process.env.TZ = zone
  setTermOffset(() => 0)
})

describe('the day cache', () => {
  test('today is the local civil day, with a timer for a second past midnight', () => {
    const d = device(new Date(2026, 9, 31, 23, 59, 30))
    const clock = createClock(d.deps)
    expect(clock.today()).toBe(dayNum(2026, 10, 31))
    expect(d.timerIn()).toBe(31_000)
    clock.stop()
  })

  test('the day changes at local midnight, once, and the timer is set again', () => {
    const d = device(new Date(2026, 9, 31, 23, 59, 30))
    const clock = createClock(d.deps)
    const seen: number[] = []
    clock.onDayChange(day => seen.push(day))
    d.run(30_000)
    expect(seen).toEqual([])
    d.run(1_000)
    expect(seen).toEqual([dayNum(2026, 11, 1)])
    expect(clock.today()).toBe(dayNum(2026, 11, 1))
    expect(d.timerIn()).toBe(86_400_000)
    d.run(86_400_000)
    expect(seen).toEqual([dayNum(2026, 11, 1), dayNum(2026, 11, 2)])
    clock.stop()
  })

  test('a timer that fires early changes nothing and waits again', () => {
    const d = device(new Date(2026, 9, 31, 12, 0, 0))
    const clock = createClock(d.deps)
    const seen: number[] = []
    clock.onDayChange(day => seen.push(day))
    d.fire()
    expect(seen).toEqual([])
    expect(clock.today()).toBe(dayNum(2026, 10, 31))
    expect(d.timerIn()).toBe(12 * 3_600_000 + 1_000)
    clock.stop()
  })

  test('a tab asleep over midnight catches up when it is shown', () => {
    const d = device(new Date(2026, 11, 24, 22, 0, 0))
    const clock = createClock(d.deps)
    const seen: number[] = []
    clock.onDayChange(day => seen.push(day))
    d.sleep(new Date(2026, 11, 26, 9, 0, 0))
    expect(clock.today()).toBe(dayNum(2026, 12, 24))
    d.show()
    expect(seen).toEqual([dayNum(2026, 12, 26)])
    expect(clock.today()).toBe(dayNum(2026, 12, 26))
    expect(d.timerIn()).toBe(15 * 3_600_000 + 1_000)
    d.show()
    expect(seen).toEqual([dayNum(2026, 12, 26)])
    clock.stop()
  })

  test('a clock moved back goes back a day', () => {
    const d = device(new Date(2026, 10, 1, 0, 30, 0))
    const clock = createClock(d.deps)
    const seen: number[] = []
    clock.onDayChange(day => seen.push(day))
    d.sleep(new Date(2026, 9, 31, 23, 0, 0))
    d.show()
    expect(seen).toEqual([dayNum(2026, 10, 31)])
    expect(clock.today()).toBe(dayNum(2026, 10, 31))
    expect(d.timerIn()).toBe(3_600_000 + 1_000)
    d.run(3_601_000)
    expect(seen).toEqual([dayNum(2026, 10, 31), dayNum(2026, 11, 1)])
    clock.stop()
  })

  test('a listener can leave, and a stopped clock holds no timer or page listener', () => {
    const d = device(new Date(2026, 9, 31, 23, 59, 30))
    const clock = createClock(d.deps)
    const seen: number[] = []
    const leave = clock.onDayChange(day => seen.push(day))
    expect(d.watchers()).toBe(1)
    leave()
    d.run(31_000)
    expect(seen).toEqual([])
    expect(clock.today()).toBe(dayNum(2026, 11, 1))
    clock.onDayChange(day => seen.push(day))
    clock.stop()
    expect(d.timerIn()).toBeNull()
    expect(d.watchers()).toBe(0)
    d.sleep(new Date(2026, 10, 5, 12, 0, 0))
    d.show()
    expect(seen).toEqual([])
  })

  test('23 and 25 hour days: the timer follows local midnight across a clock change', () => {
    process.env.TZ = 'America/Los_Angeles'
    const spring = device(new Date(2026, 2, 8, 0, 0, 1))
    const clock = createClock(spring.deps)
    expect(clock.today()).toBe(dayNum(2026, 3, 8))
    expect(spring.timerIn()).toBe(23 * 3_600_000)
    clock.stop()
    const autumn = device(new Date(2026, 10, 1, 0, 0, 1))
    const later = createClock(autumn.deps)
    const seen: number[] = []
    later.onDayChange(day => seen.push(day))
    expect(autumn.timerIn()).toBe(25 * 3_600_000)
    autumn.run(24 * 3_600_000)
    expect(seen).toEqual([])
    autumn.run(3_600_000)
    expect(seen).toEqual([dayNum(2026, 11, 2)])
    later.stop()
  })
})

describe("today's seasons", () => {
  test('are worked out once a day', () => {
    const d = device(new Date(2026, 9, 31, 23, 59, 30))
    const clock = createClock(d.deps)
    const first = clock.seasons('north')
    expect(first[0].season.id).toBe('halloween')
    expect(clock.seasons('north')).toBe(first)
    d.run(31_000)
    const next = clock.seasons('north')
    expect(next).not.toBe(first)
    expect(next.map(a => a.season.id)).toEqual(
      activeSeasons(dayNum(2026, 11, 1), 'north').map(a => a.season.id)
    )
    expect(next.map(a => a.season.id)).toContain('day_of_the_dead')
    clock.stop()
  })

  test('and again for another hemisphere or other switched-off seasons', () => {
    const d = device(new Date(2026, 11, 21, 12, 0, 0))
    const clock = createClock(d.deps)
    const north = clock.seasons('north')
    const south = clock.seasons('south')
    expect(south).not.toBe(north)
    expect(clock.seasons('south')).toBe(south)
    const ids = (off: SeasonId[]) => clock.seasons('north', new Set(off)).map(a => a.season.id)
    expect(ids([])).toContain('christmas')
    expect(ids(['christmas'])).not.toContain('christmas')
    expect(ids(['christmas'])).toContain('december_solstice')
    clock.stop()
  })
})

describe('solar terms on the local date', () => {
  const equinox = solarTermMs(2026, 0)
  const on = (m: number, d: number) =>
    activeSeasons(dayNum(2026, m, d), 'north').some(a => a.season.id === 'march_equinox')

  test('the offset is minutes east of UTC at that instant', () => {
    process.env.TZ = 'Pacific/Auckland'
    expect(localOffset(equinox)).toBe(13 * 60)
    expect(localOffset(Date.UTC(2026, 5, 21))).toBe(12 * 60)
    process.env.TZ = 'America/Los_Angeles'
    expect(localOffset(equinox)).toBe(-7 * 60)
    expect(localOffset(Date.UTC(2026, 0, 21))).toBe(-8 * 60)
  })

  test('the 2026 March equinox is 21 March in Auckland and 20 March in Los Angeles', () => {
    expect(dayAt(equinox, 13 * 60)).toBe(dayNum(2026, 3, 21))
    expect(dayAt(equinox, -7 * 60)).toBe(dayNum(2026, 3, 20))
  })

  test('Pacific/Auckland: the window is 19 to 23 March', () => {
    process.env.TZ = 'Pacific/Auckland'
    const clock = createClock(device(new Date(2026, 2, 1, 12, 0, 0)).deps)
    expect([on(3, 18), on(3, 19), on(3, 23), on(3, 24)]).toEqual([false, true, true, false])
    clock.stop()
  })

  test('America/Los_Angeles: the window is 18 to 22 March', () => {
    process.env.TZ = 'America/Los_Angeles'
    const clock = createClock(device(new Date(2026, 2, 1, 12, 0, 0)).deps)
    expect([on(3, 17), on(3, 18), on(3, 22), on(3, 23)]).toEqual([false, true, true, false])
    clock.stop()
  })

  test('an injected offset wins over the device zone', () => {
    const d = device(new Date(2026, 2, 1, 12, 0, 0))
    const clock = createClock({ ...d.deps, offsetAt: () => 14 * 60 })
    expect([on(3, 18), on(3, 19), on(3, 23), on(3, 24)]).toEqual([false, true, true, false])
    clock.stop()
  })
})
