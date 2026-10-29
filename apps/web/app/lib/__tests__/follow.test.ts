import { describe, expect, test } from 'bun:test'
import {
  BOTTOM_SLACK,
  escapeMarksRead,
  FOLLOWING,
  INTENT_MS,
  nearBottom,
  pillStep,
  placed,
  scrolled,
  upKey,
  userScrolling,
  type Pill,
} from '../follow'

const at = (scrollTop: number, scrollHeight = 2000, clientHeight = 500) => ({
  scrollTop,
  scrollHeight,
  clientHeight,
})

describe('nearBottom', () => {
  test('counts the last 60px as the bottom', () => {
    expect(nearBottom(at(1500))).toBe(true)
    expect(nearBottom(at(1500 - BOTTOM_SLACK + 1))).toBe(true)
    expect(nearBottom(at(1500 - BOTTOM_SLACK))).toBe(false)
    expect(nearBottom(at(0, 300))).toBe(true)
  })
})

describe('placed', () => {
  test('follows when positioned at the bottom of the present', () => {
    expect(placed(at(1500), false)).toEqual({ following: true, top: 1500 })
    expect(placed(at(700), false)).toEqual({ following: false, top: 700 })
  })
  test('never follows a detached window', () => {
    expect(placed(at(1500), true).following).toBe(false)
  })
})

describe('scrolled', () => {
  test('a user scrolling up leaves the bottom', () => {
    const s = scrolled({ following: true, top: 1500 }, at(1300), true, false)
    expect(s).toEqual({ following: false, top: 1300 })
  })
  test('content growing below does not stop following', () => {
    const s = scrolled({ following: true, top: 1500 }, at(1500, 2400), false, false)
    expect(s.following).toBe(true)
  })
  test('a layout shift moving the view up without user input does not stop following', () => {
    const s = scrolled({ following: true, top: 1500 }, at(1200, 2400), false, false)
    expect(s.following).toBe(true)
  })
  test('scrolling down while away from the bottom does not start following', () => {
    const s = scrolled({ following: false, top: 500 }, at(900), true, false)
    expect(s).toEqual({ following: false, top: 900 })
  })
  test('reaching the bottom starts following', () => {
    expect(scrolled({ following: false, top: 900 }, at(1480), true, false).following).toBe(true)
    expect(scrolled({ following: false, top: 900 }, at(1480), false, false).following).toBe(true)
  })
  test('a small upward nudge inside the slack keeps following', () => {
    expect(scrolled({ following: true, top: 1500 }, at(1460), true, false).following).toBe(true)
  })
  test('a detached window never follows', () => {
    expect(scrolled(FOLLOWING, at(1500), true, true).following).toBe(false)
  })
  test('returns the same state when nothing changed', () => {
    const s = { following: true, top: 1500 }
    expect(scrolled(s, at(1500), false, false)).toBe(s)
  })
})

describe('user intent', () => {
  test('lasts while touching and briefly after input', () => {
    expect(userScrolling(true, -Infinity, 10_000)).toBe(true)
    expect(userScrolling(false, 10_000 - INTENT_MS + 1, 10_000)).toBe(true)
    expect(userScrolling(false, 10_000 - INTENT_MS, 10_000)).toBe(false)
  })
  test('upward keys', () => {
    expect(upKey('PageUp', false)).toBe(true)
    expect(upKey('ArrowUp', false)).toBe(true)
    expect(upKey('Home', false)).toBe(true)
    expect(upKey(' ', true)).toBe(true)
    expect(upKey(' ', false)).toBe(false)
    expect(upKey('ArrowDown', false)).toBe(false)
  })
})

describe('pillStep', () => {
  const open = (scope: string | null) =>
    pillStep({ scope: null, ready: null, left: null }, { kind: 'scope', scope })
  const leave = (s: Pill, scope: string, lastId: number) =>
    pillStep(s, { kind: 'follow', scope, following: false, lastId })

  test('scrolling up records where the user left and following again clears it', () => {
    let s = pillStep(open('a'), { kind: 'ready', scope: 'a' })
    s = leave(s, 'a', 7)
    expect(s.left).toBe(7)
    s = pillStep(s, { kind: 'follow', scope: 'a', following: true, lastId: 9 })
    expect(s.left).toBeNull()
  })

  test('switching away and back drops the pill and repositions', () => {
    let s = pillStep(open('a'), { kind: 'ready', scope: 'a' })
    s = leave(s, 'a', 7)
    s = pillStep(s, { kind: 'scope', scope: 'b' })
    expect(s).toEqual({ scope: 'b', ready: null, left: null })
    s = pillStep(s, { kind: 'ready', scope: 'b' })
    s = pillStep(s, { kind: 'scope', scope: 'a' })
    expect(s).toEqual({ scope: 'a', ready: null, left: null })
  })

  test('a scope without messages (voice, closed thread) resets ready', () => {
    let s = pillStep(open('a'), { kind: 'ready', scope: 'a' })
    s = pillStep(s, { kind: 'scope', scope: null })
    s = pillStep(s, { kind: 'scope', scope: 'a' })
    expect(s.ready).toBeNull()
  })

  test('jumping to the bottom clears the pill even without a follow flip', () => {
    let s = pillStep(open('a'), { kind: 'ready', scope: 'a' })
    s = leave(s, 'a', 7)
    s = pillStep(s, { kind: 'bottom' })
    expect(s.left).toBeNull()
  })

  test('ignores follow changes and ready marks for another scope', () => {
    const s = pillStep(open('a'), { kind: 'ready', scope: 'a' })
    expect(leave(s, 'b', 3)).toBe(s)
    expect(pillStep(s, { kind: 'ready', scope: 'b' })).toBe(s)
  })
})

describe('escapeMarksRead', () => {
  const target = (hits: string[]) => ({
    closest: (sel: string) => (hits.some(h => sel.includes(h)) ? {} : null),
  })

  test('marks read for a plain Escape', () => {
    expect(escapeMarksRead({ defaultPrevented: false, target: target([]) })).toBe(true)
    expect(escapeMarksRead({ defaultPrevented: false, target: null })).toBe(true)
  })

  test('handled Escapes opt out', () => {
    expect(escapeMarksRead({ defaultPrevented: true, target: target([]) })).toBe(false)
  })

  test('Escapes from inputs or popovers do not mark read', () => {
    expect(escapeMarksRead({ defaultPrevented: false, target: target(['textarea']) })).toBe(false)
    expect(escapeMarksRead({ defaultPrevented: false, target: target(['[role="listbox"]']) })).toBe(
      false
    )
    expect(escapeMarksRead({ defaultPrevented: false, target: target(['[data-popover]']) })).toBe(
      false
    )
  })
})
