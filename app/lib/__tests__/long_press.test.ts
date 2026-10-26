import { describe, expect, test } from 'bun:test'
import {
  CLICK_GUARD_MS,
  DRAG_SLOP,
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
const grab = (x = 100, y = 200): PressInput => ({ kind: 'start', x, y, touches: 1, drag: true })
const mouse = (x = 100, y = 200): PressInput => ({ kind: 'mouse', x, y })
const move = (x: number, y: number): PressInput => ({ kind: 'move', x, y })
const drags = (outs: PressOutput[]) => outs.map(o => o.drag).filter(d => d !== null)

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

describe('drag gesture on touch', () => {
  test('a hold on a draggable item lifts it instead of opening the menu', () => {
    const { press, outs, opens } = run([grab(), { kind: 'timer' }])
    expect(opens).toEqual([])
    expect(outs[1].lift).toBe(true)
    expect(outs[1].clear).toBe(true)
    expect(press.phase).toBe('lifted')
    expect(swallowsClick(press, 0)).toBe(true)
  })

  test('releasing a lifted item without moving opens the menu and swallows the click', () => {
    const { press, outs, opens } = run([
      grab(40, 60),
      { kind: 'timer' },
      move(42, 61),
      { kind: 'end', now: 1000 },
    ])
    expect(opens).toEqual([{ x: 40, y: 60 }])
    expect(outs[3].swallow).toBe(true)
    expect(drags(outs)).toEqual([])
    expect(swallowsClick(press, 1000 + CLICK_GUARD_MS - 1)).toBe(true)
  })

  test('moving a lifted item starts a drag, releasing drops it', () => {
    const { press, outs, opens } = run([
      grab(),
      { kind: 'timer' },
      move(100, 200 + MOVE_SLOP + 1),
      move(100, 300),
      { kind: 'end', now: 1000 },
    ])
    expect(opens).toEqual([])
    expect(outs[2].drag).toBe('start')
    expect(outs[3].drag).toBe(null)
    expect(outs[4]).toEqual({
      arm: false,
      clear: false,
      open: null,
      swallow: true,
      lift: false,
      drag: 'drop',
    })
    expect(press.phase).toBe('idle')
    expect(swallowsClick(press, 1001)).toBe(true)
  })

  test('a plain swipe before the hold scrolls and never lifts or drags', () => {
    const { press, outs } = run([grab(), move(100, 260), { kind: 'timer' }, move(100, 400)])
    expect(outs.some(o => o.lift)).toBe(false)
    expect(drags(outs)).toEqual([])
    expect(press.phase).toBe('idle')
  })

  test('scrolling before the hold cancels it', () => {
    const { outs, press } = run([grab(), { kind: 'cancel', now: 10 }, { kind: 'timer' }])
    expect(outs.some(o => o.lift)).toBe(false)
    expect(press.phase).toBe('idle')
  })

  test('a quick tap on a draggable item is still a click', () => {
    const { press, outs } = run([grab(), { kind: 'end', now: 1000 }])
    expect(outs[1].swallow).toBe(false)
    expect(swallowsClick(press, 1001)).toBe(false)
  })

  test('the native contextmenu lifts a draggable item once', () => {
    const { outs, opens, press } = run([
      grab(),
      { kind: 'native', x: 1, y: 1, now: 500 },
      { kind: 'timer' },
      { kind: 'native', x: 1, y: 1, now: 600 },
    ])
    expect(outs.filter(o => o.lift)).toHaveLength(1)
    expect(opens).toEqual([])
    expect(press.phase).toBe('lifted')
  })

  test('a touch cancel while dragging cancels the drop', () => {
    const { outs } = run([grab(), { kind: 'timer' }, move(100, 300), { kind: 'cancel', now: 9 }])
    expect(drags(outs)).toEqual(['start', 'cancel'])
    expect(outs[3].swallow).toBe(false)
  })

  test('a lost release is recovered by the next touch, cancelling the drag', () => {
    const { outs, press } = run([
      grab(),
      { kind: 'timer' },
      move(100, 300),
      { kind: 'touch', touches: 1 },
    ])
    expect(drags(outs)).toEqual(['start', 'cancel'])
    expect(press.phase).toBe('idle')
    expect(swallowsClick(press, 0)).toBe(false)
  })

  test('a second finger does not interrupt a drag', () => {
    const { press, outs } = run([
      grab(),
      { kind: 'timer' },
      move(100, 300),
      { kind: 'touch', touches: 2 },
      { kind: 'start', x: 0, y: 0, touches: 2 },
    ])
    expect(press.phase).toBe('dragging')
    expect(drags(outs)).toEqual(['start'])
  })
})

describe('drag gesture with a mouse', () => {
  test('a click without movement is a normal click', () => {
    const { press, outs } = run([mouse(), move(102, 201), { kind: 'end', now: 1000 }])
    expect(drags(outs)).toEqual([])
    expect(outs[2].swallow).toBe(false)
    expect(swallowsClick(press, 1001)).toBe(false)
  })

  test('moving past the drag slop starts a drag right away, no hold needed', () => {
    const { outs } = run([mouse(), move(100 + DRAG_SLOP, 200), move(100 + DRAG_SLOP + 1, 200)])
    expect(drags(outs)).toEqual(['start'])
    expect(outs[1].drag).toBe(null)
  })

  test('the hold timer never applies to the mouse', () => {
    const { press, outs } = run([mouse(), { kind: 'timer' }])
    expect(press.phase).toBe('pending')
    expect(outs[0].arm).toBe(false)
    expect(outs[1].lift).toBe(false)
  })

  test('releasing after a drag drops and swallows the click on the source', () => {
    const { press, outs } = run([mouse(), move(100, 260), { kind: 'end', now: 1000 }])
    expect(drags(outs)).toEqual(['start', 'drop'])
    expect(swallowsClick(press, 1000)).toBe(true)
  })

  test('escape cancels the drag and keeps swallowing until the button is released', () => {
    const { press, outs } = run([mouse(), move(100, 260), { kind: 'escape' }])
    expect(drags(outs)).toEqual(['start', 'cancel'])
    expect(press.phase).toBe('held')
    expect(swallowsClick(press, 0)).toBe(true)
    const after = run([{ kind: 'end', now: 2000 }], press)
    expect(drags(after.outs)).toEqual([])
    expect(after.outs[0].swallow).toBe(true)
    expect(after.press.phase).toBe('idle')
  })

  test('escape does nothing when nothing is being dragged', () => {
    const { press, outs } = run([mouse(), { kind: 'escape' }])
    expect(press.phase).toBe('pending')
    expect(drags(outs)).toEqual([])
  })

  test('the next press anywhere ends the click guard after a drop', () => {
    const { press } = run([
      mouse(),
      move(100, 260),
      { kind: 'end', now: 1000 },
      { kind: 'touch', touches: 1 },
    ])
    expect(swallowsClick(press, 1001)).toBe(false)
  })

  test('a key press ends a hold whose release was lost, so keyboard clicks go through', () => {
    const aborted = run([mouse(), move(100, 260), { kind: 'escape' }])
    expect(swallowsClick(aborted.press, 0)).toBe(true)
    const keyed = run([{ kind: 'key' }], aborted.press)
    expect(keyed.press.phase).toBe('idle')
    expect(drags(keyed.outs)).toEqual([])
    expect(swallowsClick(keyed.press, 0)).toBe(false)
    const dropped = run([mouse(), move(100, 260), { kind: 'end', now: 1000 }, { kind: 'key' }])
    expect(swallowsClick(dropped.press, 1001)).toBe(false)
  })

  test('a key press leaves a press that is still down alone', () => {
    const pending = run([start(), { kind: 'key' }])
    expect(pending.press.phase).toBe('pending')
    const dragging = run([mouse(), move(100, 260), { kind: 'key' }])
    expect(dragging.press.phase).toBe('dragging')
    expect(drags(dragging.outs)).toEqual(['start'])
  })

  test('a right click still opens the menu at the cursor', () => {
    const { opens } = run([{ kind: 'native', x: 7, y: 9, now: 5000 }])
    expect(opens).toEqual([{ x: 7, y: 9 }])
  })
})
