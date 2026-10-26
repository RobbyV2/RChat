import { describe, expect, test } from 'bun:test'
import {
  CLICK_GUARD_MS,
  MOVE_SLOP,
  idlePress,
  pressStep,
  swallowsClick,
  type Press,
  type PressInput,
  type PressOutput,
} from '../long_press'

const run = (inputs: PressInput[], from: Press = idlePress) => {
  let press = from
  const outs: PressOutput[] = []
  for (const input of inputs) {
    const [next, o] = pressStep(press, input)
    press = next
    outs.push(o)
  }
  return { press, outs, opens: outs.filter(o => o.open !== null).map(o => o.open) }
}

const start = (x = 100, y = 200): PressInput => ({ kind: 'start', x, y, touches: 1 })

describe('long press gesture', () => {
  test('a quick tap never opens and lets the click through', () => {
    const { press, outs, opens } = run([start(), { kind: 'end', now: 1000 }])
    expect(opens).toEqual([])
    expect(outs[0].arm).toBe(true)
    expect([outs[1].clear, outs[1].swallow]).toEqual([true, false])
    expect(press.phase).toBe('idle')
    expect(swallowsClick(press, 1001)).toBe(false)
  })

  test('holding opens once at the touch point', () => {
    const { press, opens } = run([start(40, 60), { kind: 'timer' }, { kind: 'timer' }])
    expect(opens).toEqual([{ x: 40, y: 60 }])
    expect(press.phase).toBe('held')
  })

  test('the native contextmenu after the timer is deduped', () => {
    const { opens } = run([
      start(),
      { kind: 'timer' },
      { kind: 'native', x: 1, y: 2, now: 1000 },
      { kind: 'end', now: 1100 },
      { kind: 'native', x: 1, y: 2, now: 1200 },
    ])
    expect(opens).toEqual([{ x: 100, y: 200 }])
  })

  test('a native contextmenu that beats the timer opens once and the timer is ignored', () => {
    const { outs, opens } = run([
      start(),
      { kind: 'native', x: 5, y: 5, now: 1000 },
      { kind: 'timer' },
    ])
    expect(opens).toEqual([{ x: 100, y: 200 }])
    expect(outs[1].clear).toBe(true)
  })

  test('moving past the slop cancels, small jitter does not', () => {
    const jitter = run([start(), { kind: 'move', x: 100 + MOVE_SLOP, y: 200 }, { kind: 'timer' }])
    expect(jitter.opens).toHaveLength(1)
    const moved = run([
      start(),
      { kind: 'move', x: 100, y: 200 + MOVE_SLOP + 1 },
      { kind: 'timer' },
    ])
    expect(moved.opens).toEqual([])
    expect(moved.outs[1].clear).toBe(true)
    expect(moved.press.phase).toBe('idle')
  })

  test('scrolling the container cancels a pending press', () => {
    const { opens, press } = run([start(), { kind: 'cancel', now: 1000 }, { kind: 'timer' }])
    expect(opens).toEqual([])
    expect(press.phase).toBe('idle')
  })

  test('a second finger cancels a pending press but not an opened one', () => {
    const two = run([start(), { kind: 'start', x: 0, y: 0, touches: 2 }, { kind: 'timer' }])
    expect(two.opens).toEqual([])
    const held = run([start(), { kind: 'timer' }, { kind: 'start', x: 0, y: 0, touches: 2 }])
    expect(held.press.phase).toBe('held')
  })

  test('a new single touch recovers if the release of an opened press was never seen', () => {
    const { press, opens } = run([start(), { kind: 'timer' }, start(5, 5)])
    expect(press.phase).toBe('pending')
    expect(swallowsClick(press, 0)).toBe(false)
    expect(opens).toHaveLength(1)
  })

  test('releasing after the menu opened swallows the click for a short window', () => {
    const { press, outs } = run([start(), { kind: 'timer' }, { kind: 'end', now: 1000 }])
    expect(outs[2].swallow).toBe(true)
    expect(press.phase).toBe('idle')
    expect(swallowsClick(press, 1000 + CLICK_GUARD_MS - 1)).toBe(true)
    expect(swallowsClick(press, 1000 + CLICK_GUARD_MS)).toBe(false)
  })

  test('the next touch anywhere ends the click guard early', () => {
    const { press } = run([
      start(),
      { kind: 'timer' },
      { kind: 'end', now: 1000 },
      { kind: 'touch', touches: 1 },
    ])
    expect(swallowsClick(press, 1001)).toBe(false)
  })

  test('a second finger keeps an opened press held', () => {
    const { press } = run([start(), { kind: 'timer' }, { kind: 'touch', touches: 2 }])
    expect(press.phase).toBe('held')
    expect(swallowsClick(press, 0)).toBe(true)
  })

  test('a lone touch anywhere recovers a held press whose release was lost', () => {
    const { press, outs } = run([start(), { kind: 'timer' }, { kind: 'touch', touches: 1 }])
    expect(press.phase).toBe('idle')
    expect(outs[2].open).toBe(null)
    expect(swallowsClick(press, 0)).toBe(false)
    const after = run([{ kind: 'end', now: 2000 }], press)
    expect(after.outs[0].swallow).toBe(false)
    expect(swallowsClick(after.press, 2001)).toBe(false)
  })

  test('a lone touch anywhere drops a pending press whose release was lost', () => {
    const { press, outs, opens } = run([start(), { kind: 'touch', touches: 1 }, { kind: 'timer' }])
    expect(outs[1].clear).toBe(true)
    expect(opens).toEqual([])
    expect(press.phase).toBe('idle')
  })

  test('clicks are swallowed while the finger is still down on an opened menu', () => {
    const { press } = run([start(), { kind: 'timer' }])
    expect(swallowsClick(press, 0)).toBe(true)
  })

  test('a mouse right-click opens at the cursor', () => {
    const { opens } = run([{ kind: 'native', x: 7, y: 9, now: 5000 }])
    expect(opens).toEqual([{ x: 7, y: 9 }])
  })

  test('a fresh press after the guard window opens again', () => {
    const { opens } = run([
      start(),
      { kind: 'timer' },
      { kind: 'end', now: 1000 },
      start(10, 10),
      { kind: 'timer' },
    ])
    expect(opens).toEqual([
      { x: 100, y: 200 },
      { x: 10, y: 10 },
    ])
  })
})
