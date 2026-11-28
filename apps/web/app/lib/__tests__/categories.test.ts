import { describe, expect, test } from 'bun:test'
import {
  applyLayout,
  categoryOfZone,
  categoryStyleOf,
  channelGroups,
  groupChannels,
  itemKey,
  mergeChannelsAndSeparators,
  namesText,
  orderKeys,
  subjectNames,
  roomGroups,
  roomSeparatorStep,
  separatorLabel,
  separatorStyleOf,
  syncConfirmText,
  fullIndex,
  layoutOrder,
  moveCategory,
  moveChannel,
  moveSeparator,
  orderLayout,
  zoneOf,
} from '../categories'
import type { SeparatorView } from '../p2p/server/types'
import type { Channel, Separator, ServerDetail } from '../types'

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
      separators: [],
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

describe('groups of P2P rooms and the sync texts', () => {
  test('rooms group by their category ids, by place; a channel of a gone category shows without one', () => {
    const chan = (id: string, pos: number, cat: string | null) =>
      ({ id, pos, cat, name: id, kind: 'text' }) as never
    const groups = roomGroups(
      {
        channels: [
          chan('b', 1, 'k1'),
          chan('a', 0, null),
          chan('c', 2, 'gone'),
          chan('d', 0, 'k1'),
        ],
        categories: [
          { id: 'k2', name: 'Later', pos: 5, style: 'default', over: {} },
          { id: 'k1', name: 'Team', pos: 1, style: 'default', over: {} },
        ],
      },
      false
    )
    expect(groups.uncategorized.map(c => (c as { id: string }).id)).toEqual(['a', 'c'])
    expect(
      groups.categories.map(g => [g.category.id, g.channels.map(c => (c as { id: string }).id)])
    ).toEqual([['k1', ['d', 'b']]])
    expect(
      groupChannels(
        [{ id: 'x', position: 0, category_id: null }],
        [{ id: 'k9', position: 0 }],
        true
      ).categories.map(g => g.category.id)
    ).toEqual(['k9'])
  })

  test('a moved channel stops copying its category', () => {
    const synced = detail({
      channels: [
        { ...ch(3, 'text', 1, 10), perm_sync: true },
        { ...ch(1, 'text', 0), perm_sync: false },
      ],
    })
    const kept = applyLayout(synced, {
      version: 2,
      uncategorized: [1],
      categories: [{ id: 10, name: 'Games', channels: [3] }],
    })
    expect(kept.channels.find(c => c.id === 3)?.perm_sync).toBe(true)
    const moved = applyLayout(synced, {
      version: 3,
      uncategorized: [1, 3],
      categories: [{ id: 10, name: 'Games', channels: [] }],
    })
    expect(moved.channels.find(c => c.id === 3)?.perm_sync).toBe(false)
  })

  test('the sync confirm names who it lets in', () => {
    expect(namesText([])).toBe('')
    expect(namesText(['@everyone'])).toBe('@everyone')
    expect(namesText(['@everyone', 'Mods', 'bob'])).toBe('@everyone, Mods and bob')
    const names: Record<string, string> = { 'r:1': 'Mods', 'r:2': 'Muted', 'u:bob': 'bob' }
    expect(subjectNames(['r:1+r:2', 'u:bob'], s => names[s])).toEqual(['Mods with Muted', 'bob'])
    expect(syncConfirmText('Team', '#plans', ['Mods'])).toBe(
      'Syncing with Team lets Mods see or send in #plans.'
    )
  })
})

const sep = (id: number, after: number, category_id: number | null = null): Separator => ({
  id,
  label: `s${id}`,
  style: 'dots',
  category_id,
  after,
})

describe('separators', () => {
  test('a list puts each separator below the first `after` channels, in its given order', () => {
    const items = mergeChannelsAndSeparators(
      ['a', 'b'],
      [
        { id: 1, after: 2 },
        { id: 2, after: 0 },
        { id: 3, after: 9 },
        { id: 4, after: 0 },
        { id: 5, after: -1 },
      ]
    )
    expect(items.map(i => (i.kind === 'channel' ? i.channel : i.separator.id))).toEqual([
      2,
      4,
      5,
      'a',
      'b',
      1,
      3,
    ])
    expect(mergeChannelsAndSeparators([], [{ after: 3 }])).toHaveLength(1)
  })

  test('hosted separators group with their lists and hide with an empty category', () => {
    const d = detail({ separators: [sep(7, 1, 10), sep(8, 0), sep(9, 0, 11), sep(6, 2, 99)] })
    const all = channelGroups(d, true)
    expect(all.loose.map(itemKey)).toEqual(['s8', 'c1', 'c4', 's6'])
    expect(all.categories.map(g => g.items.map(itemKey))).toEqual([['c3', 's7', 'c2'], ['s9']])
    const seen = channelGroups(d, false)
    expect(seen.categories.map(g => g.items.map(itemKey))).toEqual([['c3', 's7', 'c2']])
  })

  test('separators move with channels, across lists and keep their place under a channel move', () => {
    const d = detail({ separators: [sep(7, 1, 10), sep(8, 0)] })
    const order = layoutOrder(d)
    expect(order.separators).toEqual([
      { id: 8, category_id: null, after: 0 },
      { id: 7, category_id: 10, after: 1 },
    ])
    expect(orderKeys(order, 10)).toEqual(['c3', 's7', 'c2'])
    const moved = moveChannel(order, 3, 10, 2)
    expect(orderKeys(moved, 10)).toEqual(['s7', 'c2', 'c3'])
    const across = moveSeparator(order, 7, null, 1)
    expect(orderKeys(across, null)).toEqual(['s8', 's7', 'c1', 'c4'])
    expect(orderKeys(across, 10)).toEqual(['c3', 'c2'])
    expect(across.separators).toEqual([
      { id: 8, category_id: null, after: 0 },
      { id: 7, category_id: null, after: 0 },
    ])
    expect(moveSeparator(order, 7, 99, 0)).toBe(order)
    const layout = orderLayout(d, across)
    expect(layout.separators?.map(s => [s.id, s.label, s.category_id, s.after])).toEqual([
      [8, 's8', null, 0],
      [7, 's7', null, 0],
    ])
    expect(layoutOrder(applyLayout(d, layout))).toEqual(across)
  })

  test('a drop among shown rows maps to rows, channels and separators alike', () => {
    expect(fullIndex(['c1', 's2', 'c3'], ['c1', 'c3'], 's2', 1)).toBe(1)
    expect(fullIndex(['c1', 's2', 'c3'], ['c3'], 'c1', 0)).toBe(1)
  })

  test('an older server without separators keeps the cached ones, and styles parse', () => {
    const d = detail({ separators: [sep(8, 0)] })
    const next = applyLayout(d, { version: 9, uncategorized: [1], categories: [] })
    expect(next.separators).toEqual(d.separators)
    expect(
      applyLayout(d, {
        version: 9,
        uncategorized: [1],
        categories: [{ id: 10, name: 'Fun', style: 'dots', channels: [] }],
      }).categories
    ).toEqual([{ id: 10, name: 'Fun', position: 0, style: 'dots' }])
    expect([categoryStyleOf('line'), categoryStyleOf('fancy'), categoryStyleOf(undefined)]).toEqual(
      ['line', 'default', 'default']
    )
    expect([separatorStyleOf('plain'), separatorStyleOf(3)]).toEqual(['plain', 'dots'])
  })

  test('labels keep symbols and case, and refuse what does not fit', () => {
    expect(separatorLabel('  \u27a4 Updates \u2605  ')).toBe('\u27a4 Updates \u2605')
    expect(separatorLabel('')).toBe('')
    expect(separatorLabel('\u2605'.repeat(100))).toBe('\u2605'.repeat(100))
    expect(separatorLabel('x'.repeat(101))).toBeNull()
    expect(separatorLabel('two\nlines')).toBeNull()
  })

  test('room separators sit below the channels placed at or above them, and step between rows', () => {
    const chan = (id: string, pos: number, cat: string | null) =>
      ({ id, pos, cat, name: id, kind: 'text' }) as never
    const rsep = (id: string, pos: number, cat: string | null): SeparatorView => ({
      id,
      label: id,
      style: 'line',
      cat,
      pos,
    })
    const groups = roomGroups(
      {
        channels: [chan('a', 0, null), chan('b', 2, null), chan('c', 1, 'k1')],
        categories: [{ id: 'k1', name: 'Team', pos: 0, style: 'dots', over: {} }],
        separators: [
          rsep('y', 2, null),
          rsep('x', 0.5, null),
          rsep('z', 1, 'k1'),
          rsep('w', 9, 'gone'),
        ],
      },
      true
    )
    const keys = (items: typeof groups.loose) =>
      items.map(i => (i.kind === 'channel' ? i.channel.id : `|${i.separator.id}`))
    expect(keys(groups.loose)).toEqual(['a', '|x', 'b', '|y', '|w'])
    expect(keys(groups.categories[0].items)).toEqual(['c', '|z'])
    expect(roomSeparatorStep(groups.loose, 'x', -1)).toBe(-1)
    expect(roomSeparatorStep(groups.loose, 'x', 1)).toBe(2)
    expect(roomSeparatorStep(groups.loose, 'y', 1)).toBe(10)
    expect(roomSeparatorStep(groups.loose, 'w', 1)).toBeNull()
    expect(roomSeparatorStep(groups.categories[0].items, 'z', -1)).toBe(0)
    expect(roomSeparatorStep(groups.loose, 'q', 1)).toBeNull()
    const hidden = roomGroups(
      {
        channels: [chan('a', 0, null)],
        categories: [{ id: 'k1', name: 'Team', pos: 0, style: 'dots', over: {} }],
        separators: [rsep('z', 1, 'k1')],
      },
      false
    )
    expect(hidden.categories).toEqual([])
    expect(keys(hidden.loose)).toEqual(['a'])
  })
})
