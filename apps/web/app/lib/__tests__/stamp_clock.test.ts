import { describe, expect, test } from 'bun:test'
import { daySnapshot, refresh, snapshot, subscribe, subscribeDay, track } from '../stamp_clock'
import { testClock } from './helpers/test_clock'

describe('stamp clock', () => {
  test('tracking a new target refreshes a stale shared now and notifies', () => {
    const clock = testClock(1_000_000)
    refresh()
    expect(snapshot()).toBe(1_000_000)
    clock.set(9_000_000)
    let calls = 0
    const off = subscribe(() => calls++)
    const untrack = track(9_005_000)
    expect(snapshot()).toBe(9_000_000)
    expect(calls > 0).toBe(true)
    untrack()
    off()
  })

  test('ticks each second while a target is under a minute away, and stops untracked', () => {
    const clock = testClock(1_000_000)
    const seen: number[] = []
    const off = subscribe(() => seen.push(snapshot()))
    const untrack = track(1_030_000)
    seen.length = 0
    clock.advance(3_000)
    expect(seen).toEqual([1_001_000, 1_002_000, 1_003_000])
    untrack()
    off()
    expect(clock.pending).toBe(0)
  })

  test('the day changes shortly after local midnight while someone listens', () => {
    const clock = testClock(new Date(2026, 0, 5, 23, 59, 0).getTime())
    const before = daySnapshot()
    const off = subscribeDay(() => {})
    clock.advance(59_000)
    expect(daySnapshot()).toBe(before)
    clock.advance(2_000)
    expect(daySnapshot()).toBe(before + 1)
    expect(clock.pending).toBe(1)
    off()
    expect(clock.pending).toBe(0)
  })
})
