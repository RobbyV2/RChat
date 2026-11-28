import { describe, expect, test } from 'bun:test'
import { FRAME_MS } from '../clock'
import { deviceTime, time } from '../platform/time'
import { ManualTime, testClock } from './helpers/test_clock'
import { testAccount } from './test_account'

describe('manual time', () => {
  test('moves only when advanced, both clocks together', () => {
    const t = new ManualTime(5_000)
    expect([t.now(), t.elapsed()]).toEqual([5_000, 0])
    t.advance(250)
    expect([t.now(), t.elapsed()]).toEqual([5_250, 250])
    t.set(9_000)
    expect([t.now(), t.elapsed()]).toEqual([9_000, 250])
  })

  test('runs due timers in time order, then in the order they were set', () => {
    const t = new ManualTime(0)
    const ran: string[] = []
    t.after(30, () => ran.push(`c@${t.now()}`))
    t.after(10, () => ran.push(`a@${t.now()}`))
    t.after(10, () => ran.push(`b@${t.now()}`))
    t.after(31, () => ran.push('late'))
    t.advance(30)
    expect(ran).toEqual(['a@10', 'b@10', 'c@30'])
    expect(t.pending).toBe(1)
  })

  test('a cancelled timer never runs', () => {
    const t = new ManualTime()
    let ran = 0
    const cancel = t.after(10, () => ran++)
    const stop = t.every(10, () => ran++)
    cancel()
    stop()
    cancel()
    t.advance(100)
    expect(ran).toBe(0)
    expect(t.pending).toBe(0)
  })

  test('a timer set by a timer runs in the same advance when it comes due', () => {
    const t = new ManualTime(0)
    const ran: number[] = []
    t.after(10, () => {
      ran.push(t.now())
      t.after(5, () => ran.push(t.now()))
      t.after(50, () => ran.push(t.now()))
    })
    t.advance(20)
    expect(ran).toEqual([10, 15])
    t.advance(40)
    expect(ran).toEqual([10, 15, 60])
  })

  test('a repeating timer runs once per period until cancelled, even by itself', () => {
    const t = new ManualTime(0)
    const ran: number[] = []
    const stop = t.every(10, () => {
      ran.push(t.now())
      if (ran.length === 3) stop()
    })
    t.advance(25)
    expect(ran).toEqual([10, 20])
    t.advance(100)
    expect(ran).toEqual([10, 20, 30])
  })

  test('a frame runs one frame later with the elapsed time', () => {
    const t = new ManualTime()
    const at: number[] = []
    t.frame(a => at.push(a))
    const cancel = t.frame(a => at.push(a))
    cancel()
    t.advance(FRAME_MS - 1)
    expect(at).toEqual([])
    t.advance(1)
    expect(at).toEqual([FRAME_MS])
  })

  test('a deadline aborts with a TimeoutError once its time passed', () => {
    const t = new ManualTime()
    const signal = t.deadline(1_000)
    t.advance(999)
    expect(signal.aborted).toBe(false)
    t.advance(1)
    expect(signal.aborted).toBe(true)
    expect((signal.reason as DOMException).name).toBe('TimeoutError')
  })

  test('released timers go on with the other time and can be cancelled', () => {
    const t = new ManualTime()
    const to = new ManualTime()
    const ran: string[] = []
    t.after(30, () => ran.push('once'))
    t.every(20, () => ran.push('each'))
    const cancel = t.after(5, () => ran.push('cancelled'))
    t.advance(10 - 5 - 1)
    t.release(to)
    expect(t.pending).toBe(0)
    cancel()
    to.advance(60)
    expect(ran).toEqual(['each', 'once', 'each', 'each'])
  })

  test('flush settles pending promises', async () => {
    const t = new ManualTime()
    let seen = 0
    void (async () => {
      for (let i = 0; i < 20; i++) await Promise.resolve()
      seen = 1
    })()
    expect(seen).toBe(0)
    await t.flush()
    expect(seen).toBe(1)
  })

  test('pass lets what a timer awaits set the next timer', async () => {
    const t = new ManualTime(0)
    const ran: number[] = []
    const step = async () => {
      ran.push(t.now())
      await Promise.resolve()
      if (ran.length < 3) t.after(10, () => void step())
    }
    t.after(10, () => void step())
    t.advance(100)
    expect(ran).toEqual([10])
    await t.pass(100)
    expect(ran).toEqual([10, 110, 120])
    expect(t.now()).toBe(200)
  })
})

describe('the time in use', () => {
  test('is the device time unless a test clock is set', () => {
    const before = Date.now()
    expect(time().now()).toBeGreaterThanOrEqual(before)
    expect(time().now()).toBeLessThanOrEqual(Date.now())
  })

  test('a session runs on the test clock, whether made before or after it was set', () => {
    const early = testAccount('ada')
    const clock = testClock(42_000)
    const late = testAccount('bob')
    expect([early.time.now(), late.time.now(), time().now()]).toEqual([42_000, 42_000, 42_000])
    let ran = 0
    early.time.after(10, () => ran++)
    late.time.every(10, () => ran++)
    clock.advance(20)
    expect(ran).toBe(3)
  })

  test('a test clock ends with its test', () => {
    expect(time().now()).toBeGreaterThan(1_000_000_000_000 + 42_000)
    expect(time().elapsed()).toBeGreaterThan(0)
  })

  test('device timers run and cancel', async () => {
    const ran: string[] = []
    const done = new Promise<void>(resolve => {
      deviceTime.after(0, () => ran.push('after'))
      deviceTime.after(0, () => ran.push('cancelled'))()
      deviceTime.every(1, () => ran.push('every'))()
      deviceTime.frame(() => ran.push('cancelled frame'))()
      deviceTime.frame(() => resolve())
    })
    await done
    expect(ran).toEqual(['after'])
    expect(deviceTime.deadline(60_000).aborted).toBe(false)
  })
})
