import { describe, expect, test } from 'bun:test'
import {
  IDLE,
  TYPING_EVERY_MS,
  nextExpiry,
  nextTyping,
  parseTyping,
  pruneTypers,
  stopTyping,
  typerNames,
  typingKey,
  typingParts,
  typingText,
  typingValue,
  withTyper,
} from '../typing'

describe('typing setting', () => {
  test('is on unless stored off', () => {
    expect(typingKey('alice')).toBe('rchat_typing:alice')
    expect(typingKey(null)).toBe('rchat_typing:guest')
    expect(parseTyping(null)).toBe(true)
    expect(parseTyping(typingValue(false))).toBe(false)
    expect(parseTyping(typingValue(true))).toBe(true)
    for (const bad of ['{', '"x"', '{"v":2,"on":false}', '{"v":1,"on":"no"}', '[]', 'null'])
      expect(parseTyping(bad)).toBe(true)
  })
})

describe('outgoing', () => {
  test('sends at most every 3 s while typing and stops once', () => {
    let cur = IDLE
    const step = (scope: string, active: boolean, now: number) => {
      const out = nextTyping(cur, scope, active, now)
      cur = out.next
      return out.send
    }
    expect(step('c1', true, 1000)).toEqual([{ type: 'typing', scope: 'c1' }])
    expect(step('c1', true, 1000 + TYPING_EVERY_MS - 1)).toEqual([])
    expect(step('c1', true, 1000 + TYPING_EVERY_MS)).toEqual([{ type: 'typing', scope: 'c1' }])
    expect(step('c1', false, 5000)).toEqual([{ type: 'typing_stop', scope: 'c1' }])
    expect(step('c1', false, 5001)).toEqual([])
    expect(cur).toEqual(IDLE)
  })

  test('moving to another scope stops the old one first', () => {
    let cur = nextTyping(IDLE, 'c1', true, 0).next
    const moved = nextTyping(cur, 't9', true, 10)
    expect(moved.send).toEqual([
      { type: 'typing_stop', scope: 'c1' },
      { type: 'typing', scope: 't9' },
    ])
    cur = moved.next
    expect(nextTyping(cur, 'c1', false, 20)).toEqual({ next: cur, send: [] })
    expect(stopTyping(cur)).toEqual([{ type: 'typing_stop', scope: 't9' }])
    expect(stopTyping(IDLE)).toEqual([])
  })
})

describe('incoming', () => {
  test('tracks typers per scope and prunes expired ones', () => {
    let map = withTyper({}, 'c1', 'alice', { name: 'Alice', until: 100 })
    map = withTyper(map, 'c1', 'bob', { name: 'Bob', until: 50 })
    map = withTyper(map, 'd2', 'carol', { name: 'Carol', until: 200 })
    map = withTyper(map, 'c1', 'alice', { name: 'Alice', until: 300 })
    expect(typerNames(map.c1)).toEqual(['Alice', 'Bob'])
    expect(nextExpiry(map)).toBe(50)
    map = pruneTypers(map, 60)
    expect(typerNames(map.c1)).toEqual(['Alice'])
    expect(pruneTypers(map, 60)).toBe(map)
    map = withTyper(map, 'd2', 'carol', null)
    expect(map.d2).toBeUndefined()
    expect(withTyper(map, 'd2', 'carol', null)).toBe(map)
    expect(pruneTypers(map, 1000)).toEqual({})
    expect(nextExpiry({})).toBeNull()
    expect(typerNames(undefined)).toEqual([])
  })

  test('reads like Discord', () => {
    expect(typingText([])).toBe('')
    expect(typingText(['Alice'])).toBe('Alice is typing…')
    expect(typingText(['Alice', 'Bob'])).toBe('Alice and Bob are typing…')
    expect(typingText(['Alice', 'Bob', 'Carol'])).toBe('Alice, Bob and Carol are typing…')
    expect(typingText(['A', 'B', 'C', 'D'])).toBe('Several people are typing…')
    expect(
      typingParts(['Alice', 'Bob'])
        .filter(p => p.name)
        .map(p => p.text)
    ).toEqual(['Alice', 'Bob'])
    expect(typingParts(['A', 'B', 'C', 'D']).some(p => p.name)).toBe(false)
  })
})
