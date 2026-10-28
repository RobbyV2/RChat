import { describe, expect, test } from 'bun:test'
import {
  findTrigger,
  inCode,
  keepDismissal,
  placePopover,
  scrollToShow,
  spliceText,
} from '../autocomplete'

const at = (s: string) => {
  const caret = s.indexOf('|')
  const text = s.replace('|', '')
  return findTrigger(text, caret, ':', 2)
}

describe('emoji trigger', () => {
  test('needs a colon at a word start and two characters', () => {
    expect(at(':sm|')).toEqual({ start: 0, end: 3, query: 'sm' })
    expect(at('hi :smi|')).toEqual({ start: 3, end: 7, query: 'smi' })
    expect(at('hi (:+1|')).toEqual({ start: 4, end: 7, query: '+1' })
    expect(at(':s|')).toBeNull()
    expect(at('hi :|')).toBeNull()
    expect(at('hi sm|')).toBeNull()
    expect(at('12:30|')).toBeNull()
    expect(at('a:bc|')).toBeNull()
  })

  test('uses the text before the caret only', () => {
    expect(at(':sm| later')).toEqual({ start: 0, end: 3, query: 'sm' })
    expect(at(':sm |')).toBeNull()
    expect(at(':smile:|')).toBeNull()
  })

  test('ignores urls', () => {
    expect(at('see http://sm|')).toBeNull()
    expect(at('https://x.org/:sm|')).toBeNull()
    expect(at('mailto:smith|')).toBeNull()
  })

  test('ignores code spans and blocks', () => {
    expect(at('`:sm|')).toBeNull()
    expect(at('`x` :sm|')).toEqual({ start: 4, end: 7, query: 'sm' })
    expect(at('``a ` :sm|')).toBeNull()
    expect(at('```\n:sm|')).toBeNull()
    expect(at('```\ncode\n```\n:sm|')).toEqual({ start: 13, end: 16, query: 'sm' })
    expect(at('~~~js\n  :sm|')).toBeNull()
  })

  test('other trigger characters work the same way', () => {
    expect(findTrigger('hey @al', 7, '@', 0)).toEqual({ start: 4, end: 7, query: 'al' })
    expect(findTrigger('hey @', 5, '@', 0)).toEqual({ start: 4, end: 5, query: '' })
    expect(findTrigger('me@al', 5, '@', 0)).toBeNull()
  })

  test('inCode tracks fences and inline spans', () => {
    expect(inCode('a `b', 4)).toBe(true)
    expect(inCode('a `b` c', 7)).toBe(false)
    expect(inCode('```\n', 4)).toBe(true)
  })

  test('spliceText replaces a range', () => {
    expect(spliceText('hi :sm there', 3, 6, '😄')).toBe('hi 😄 there')
    expect(spliceText('ab', 1, 1, 'x')).toBe('axb')
  })
})

describe('popover placement', () => {
  const vp = { width: 1280, height: 800 }
  const size = { width: 440, height: 440 }
  const r = (top: number, left: number, w = 32, h = 32) => ({
    top,
    left,
    right: left + w,
    bottom: top + h,
  })

  test('opens above, right aligned with the trigger', () => {
    expect(placePopover(r(700, 1000), size, vp)).toEqual({ top: 252, left: 592 })
  })

  test('flips below when there is no room above', () => {
    expect(placePopover(r(100, 1000), size, vp)).toEqual({ top: 140, left: 592 })
    expect(placePopover(r(100, 1000), size, vp, 'bottom', 'start')).toEqual({ top: 140, left: 832 })
    expect(placePopover(r(100, 300), size, vp, 'bottom', 'start')).toEqual({ top: 140, left: 300 })
  })

  test('clamps inside the viewport', () => {
    expect(placePopover(r(700, 10), size, vp)).toEqual({ top: 252, left: 8 })
    expect(placePopover(r(300, 1260), size, vp, 'bottom', 'start')).toEqual({ top: 340, left: 832 })
    expect(placePopover(r(300, 600), size, { width: 1280, height: 500 })).toEqual({
      top: 8,
      left: 192,
    })
  })
})

describe('dismissal', () => {
  const run = (scopes: (string | null)[], escapeAt: number) => {
    let dismissed: string | null = null
    return scopes.map((scope, i) => {
      dismissed = keepDismissal(dismissed, scope)
      const open = scope !== null && dismissed !== scope
      if (i === escapeAt) dismissed = scope
      return open
    })
  }

  test('stays dismissed while the same trigger is typed', () => {
    expect(run(['d:0', 'd:0', 'd:0'], 0)).toEqual([true, false, false])
  })

  test('escape, send, then a new trigger at the same position opens again', () => {
    expect(run(['c1:0', 'c1:0', null, 'c1:0'], 0)).toEqual([true, false, false, true])
  })

  test('a trigger elsewhere or in another draft clears it', () => {
    expect(run(['c1:0', 'c1:5', 'c1:0'], 0)).toEqual([true, true, true])
    expect(run(['c1:0', 'c2:0', 'c1:0'], 0)).toEqual([true, true, true])
  })
})

describe('list scrolling', () => {
  test('only scrolls when the row is outside the view', () => {
    expect(scrollToShow(40, 40, 0, 200)).toBe(0)
    expect(scrollToShow(200, 40, 0, 200)).toBe(40)
    expect(scrollToShow(0, 40, 120, 200)).toBe(0)
    expect(scrollToShow(160, 40, 0, 200)).toBe(0)
  })
})
