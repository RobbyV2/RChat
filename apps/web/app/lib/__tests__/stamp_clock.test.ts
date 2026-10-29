import { describe, expect, test } from 'bun:test'
import { refresh, snapshot, subscribe, track } from '../stamp_clock'

describe('stamp clock', () => {
  test('tracking a new target refreshes a stale shared now and notifies', () => {
    const real = Date.now
    try {
      Date.now = () => 1_000_000
      refresh()
      expect(snapshot()).toBe(1_000_000)
      Date.now = () => 9_000_000
      let calls = 0
      const off = subscribe(() => calls++)
      const untrack = track(9_005_000)
      expect(snapshot()).toBe(9_000_000)
      expect(calls > 0).toBe(true)
      untrack()
      off()
    } finally {
      Date.now = real
    }
  })
})
