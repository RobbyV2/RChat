import { describe, expect, test } from 'bun:test'
import { filterSearchPage } from '../store'
import { result } from './fixtures'

const fullPage = () => Array.from({ length: 25 }, (_, i) => result(1000 - i, 1000 - i))

describe('filterSearchPage', () => {
  test('no date bounds keeps every unseen row, full page -> hasMore', () => {
    const raw = fullPage()
    const { filtered, hasMore } = filterSearchPage(raw, new Set(), null, null)
    expect(filtered).toHaveLength(25)
    expect(hasMore).toBe(true)
  })

  test('short page -> hasMore false', () => {
    const raw = [result(3, 3), result(2, 2)]
    expect(filterSearchPage(raw, new Set(), null, null).hasMore).toBe(false)
  })

  test('drops already-seen ids', () => {
    const raw = [result(3, 3), result(2, 2), result(1, 1)]
    const { filtered } = filterSearchPage(raw, new Set([2]), null, null)
    expect(filtered.map(r => r.message.id)).toEqual([3, 1])
  })

  test('before is exclusive upper bound on created_at', () => {
    const raw = [result(3, 30), result(2, 20), result(1, 10)]
    const { filtered } = filterSearchPage(raw, new Set(), 20, null)
    expect(filtered.map(r => r.message.id)).toEqual([1])
  })

  test('after is exclusive lower bound and stops paging (id-desc ordering)', () => {
    const raw = [result(3, 30), result(2, 20), result(1, 10)]
    const { filtered, hasMore } = filterSearchPage(raw, new Set(), null, 20)
    expect(filtered.map(r => r.message.id)).toEqual([3])
    expect(hasMore).toBe(false)
  })

  test('no-stall: a full page entirely outside the date window keeps hasMore true', () => {
    const raw = fullPage()
    const { filtered, hasMore } = filterSearchPage(raw, new Set(), 5, null)
    expect(filtered).toHaveLength(0)
    expect(hasMore).toBe(true)
    const keepPaging = filtered.length === 0 && hasMore
    expect(keepPaging).toBe(true)
  })

  test('past-after full page stops even when nothing matched', () => {
    const raw = fullPage()
    const { filtered, hasMore } = filterSearchPage(raw, new Set(), null, 2000)
    expect(filtered).toHaveLength(0)
    expect(hasMore).toBe(false)
  })
})
