import { describe, expect, test } from 'bun:test'
import { originAt, originOf } from '../motion/origin'

describe('where a menu grows from', () => {
  const box = { left: 100, top: 200, width: 180, height: 300 }

  test('the point that opened it, inside its box', () => {
    expect(originAt({ x: 100, y: 200 }, box)).toBe('0px 0px')
    expect(originAt({ x: 160.4, y: 350 }, box)).toBe('60px 150px')
  })

  test('a menu moved to stay in the window grows from its nearest edge', () => {
    expect(originAt({ x: 400, y: 900 }, box)).toBe('180px 300px')
    expect(originAt({ x: 20, y: 50 }, box)).toBe('0px 0px')
  })

  test('a popover grows from the corner its place holds', () => {
    expect(originOf({ top: 8, left: 8 })).toBe('top left')
    expect(originOf({ top: 8, right: 8 })).toBe('top right')
    expect(originOf({ bottom: 8, left: 8 })).toBe('bottom left')
    expect(originOf({ bottom: 8, right: 8 })).toBe('bottom right')
    expect(originOf({})).toBe('top left')
  })

  test('a place that names its origin keeps it', () => {
    expect(originOf({ top: 8, left: 8, transformOrigin: '40px top' })).toBe('40px top')
  })
})
