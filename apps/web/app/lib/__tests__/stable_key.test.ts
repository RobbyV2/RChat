import { describe, expect, test } from 'bun:test'
import { holder, plainCopy, stableKey } from '../stable_key'

describe('stableKey', () => {
  test('equal content gives equal keys', () => {
    expect(stableKey({ a: [1, 'x'], b: null })).toBe(stableKey({ a: [1, 'x'], b: null }))
    expect(stableKey([1, 2])).not.toBe(stableKey([2, 1]))
  })

  test('a value with no JSON form has an empty key', () => {
    expect(stableKey(undefined)).toBe('')
  })
})

describe('holder', () => {
  test('the first value stays while the content is unchanged', () => {
    const hold = holder<{ ids: number[] }>()
    const first = { ids: [1, 2] }
    expect(hold(first)).toBe(first)
    expect(hold({ ids: [1, 2] })).toBe(first)
  })

  test('changed content replaces the held value', () => {
    const hold = holder<number[]>()
    const first = hold([1])
    const second = [1, 2]
    expect(hold(second)).toBe(second)
    expect(hold([1])).not.toBe(first)
  })

  test('each holder keeps its own value', () => {
    const a = holder<number[]>()
    const b = holder<number[]>()
    expect(a([1])).not.toBe(b([1]))
  })
})

describe('plainCopy', () => {
  test('the copy is equal and shares nothing', () => {
    const from = { v: 1, list: [{ on: true, name: 'a' }], none: null, deep: { map: { k: [1] } } }
    const copy = plainCopy(from)
    expect(copy).toEqual(from)
    expect(copy.list).not.toBe(from.list)
    expect(copy.list[0]).not.toBe(from.list[0])
    expect(copy.deep.map.k).not.toBe(from.deep.map.k)
  })

  test('a field holding undefined is left out', () => {
    const copy = plainCopy({ a: 1, b: undefined as number | undefined })
    expect(Object.keys(copy)).toEqual(['a'])
  })
})
