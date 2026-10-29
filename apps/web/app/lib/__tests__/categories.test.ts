import { describe, expect, test } from 'bun:test'
import {
  applyLayout,
  categoryOfZone,
  channelGroups,
  fullIndex,
  layoutOrder,
  moveCategory,
  moveChannel,
  orderLayout,
  zoneOf,
} from '../categories'
import type { Channel, ServerDetail } from '../types'

const ch = (
  id: number,
  kind: Channel['kind'],
  position: number,
  category_id: number | null = null
) => ({ id, name: `c${id}`, kind, slowmode_seconds: 0, position, category_id }) as Channel

const detail = (over: Partial<ServerDetail> = {}): ServerDetail => ({
  name: 'club',
  display_name: 'Club',
  creator: 'alice',
  has_password: false,
  banner_color: null,
  name_color: null,
  channels: [ch(1, 'text', 0), ch(2, 'voice', 3, 10), ch(3, 'text', 1, 10), ch(4, 'voice', 2)],
  categories: [
    { id: 11, name: 'Empty', position: 1 },
    { id: 10, name: 'Games', position: 0 },
  ],
  layout_version: 4,
  roles: [],
  member_count: 1,
  online_count: 1,
  ...over,
})

const ids = (list: { id: number }[]) => list.map(x => x.id)

describe('channel groups', () => {
  test('uncategorized first, categories by position, text and voice mixed', () => {
    const g = channelGroups(detail(), true)
    expect(ids(g.uncategorized)).toEqual([1, 4])
    expect(g.categories.map(c => [c.category.id, ids(c.channels)])).toEqual([
      [10, [3, 2]],
      [11, []],
    ])
  })

  test('empty categories are hidden unless the viewer manages channels', () => {
    expect(channelGroups(detail(), false).categories.map(c => c.category.id)).toEqual([10])
  })

  test('channels of an unknown category and old servers without categories are uncategorized', () => {
    const old = detail({ categories: undefined, layout_version: undefined })
    expect(ids(channelGroups(old, false).uncategorized)).toEqual([1, 3, 4, 2])
    const legacy = detail({
      categories: [],
      channels: [
        { id: 7, name: 'b', kind: 'voice', slowmode_seconds: 0 },
        { id: 5, name: 'a', kind: 'text', slowmode_seconds: 0 },
      ],
    })
    expect(ids(channelGroups(legacy, false).uncategorized)).toEqual([5, 7])
  })
})

describe('moves', () => {
  test('a channel moves within and across categories', () => {
    const order = layoutOrder(detail())
    expect(order).toEqual({
      uncategorized: [1, 4],
      categories: [
        { id: 10, channels: [3, 2] },
        { id: 11, channels: [] },
      ],
    })
    expect(moveChannel(order, 4, 10, 1).categories[0].channels).toEqual([3, 4, 2])
    expect(moveChannel(order, 4, 10, 1).uncategorized).toEqual([1])
    expect(moveChannel(order, 3, null, 0).uncategorized).toEqual([3, 1, 4])
    expect(moveChannel(order, 2, 11, 5).categories[1].channels).toEqual([2])
    expect(moveChannel(order, 2, 99, 0)).toBe(order)
  })

  test('a category moves', () => {
    const order = layoutOrder(detail())
    expect(moveCategory(order, 11, 0).categories.map(c => c.id)).toEqual([11, 10])
    expect(moveCategory(order, 99, 0)).toBe(order)
  })

  test('a drop index among shown items maps into the full list', () => {
    expect(fullIndex([1, 2, 3, 4], [1, 2, 3, 4], 2, 2)).toBe(2)
    expect(fullIndex([1, 2, 3, 4], [3], 1, 0)).toBe(1)
    expect(fullIndex([1, 2, 3, 4], [3], 1, 1)).toBe(2)
    expect(fullIndex([1, 2, 3], [], 9, 0)).toBe(3)
  })

  test('zones name categories', () => {
    expect(categoryOfZone(zoneOf(null))).toBeNull()
    expect(categoryOfZone(zoneOf(12))).toBe(12)
    expect(categoryOfZone('cats')).toBeUndefined()
  })
})

describe('layouts', () => {
  test('a layout places listed channels and keeps the rest', () => {
    const d = detail()
    const next = applyLayout(d, {
      version: 5,
      uncategorized: [2],
      categories: [{ id: 10, name: 'Fun', channels: [1, 3] }],
    })
    expect(next.layout_version).toBe(5)
    expect(next.categories).toEqual([{ id: 10, name: 'Fun', position: 0 }])
    expect(ids(channelGroups(next, true).uncategorized)).toEqual([2, 4])
    expect(ids(channelGroups(next, true).categories[0].channels)).toEqual([1, 3])
    expect(next.channels.find(c => c.id === 4)).toBe(d.channels[3])
  })

  test('an optimistic layout keeps the version and names', () => {
    const d = detail()
    const order = moveCategory(layoutOrder(d), 11, 0)
    const layout = orderLayout(d, order)
    expect(layout.version).toBe(4)
    expect(layout.categories.map(c => c.name)).toEqual(['Empty', 'Games'])
    expect(layoutOrder(applyLayout(d, layout))).toEqual(order)
  })
})
