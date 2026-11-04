import { describe, expect, test } from 'bun:test'
import { clip, RateWindow } from '../p2p/rate'

describe('RateWindow', () => {
  test('RateWindow allows max hits per window, then frees one per expiry', () => {
    const w = new RateWindow(60_000, 3)
    expect([0, 1, 2, 3].map(t => w.hit(t))).toEqual([true, true, true, false])
    expect(w.hit(60_000)).toBe(true)
  })

  test('counts what the window holds, notes past the max, takes one back, and goes idle', () => {
    const w = new RateWindow(1000, 2)
    w.note(0)
    w.note(10)
    w.note(20)
    expect(w.count(500)).toBe(3)
    expect(w.hit(500)).toBe(false)
    w.drop(10)
    expect([w.count(500), w.oldest()]).toEqual([2, 0])
    expect(w.count(1005)).toBe(1)
    expect([w.idle(1019), w.idle(1020)]).toEqual([false, true])
  })

  test('weighs events, reads a live max, and keeps a caller array in place', () => {
    const w = new RateWindow(1000, Infinity)
    w.note(0, 5)
    w.note(1)
    expect(w.count(2)).toBe(6)
    let max = 1
    const times = [0]
    const v = new RateWindow(1000, () => max, times)
    expect(v.hit(1)).toBe(false)
    max = 2
    expect(v.hit(1)).toBe(true)
    expect(times).toEqual([0, 1])
    v.count(1000)
    expect(times).toEqual([1])
  })
})

describe('clip', () => {
  test('clip cuts by code points', () => {
    expect(clip('a😀b', 2)).toBe('a😀')
    expect(clip('abc', 5)).toBe('abc')
  })
})
