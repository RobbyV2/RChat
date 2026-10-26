import { describe, expect, test } from 'bun:test'
import {
  dmSections,
  emptyLayout,
  forgetServer,
  layoutKey,
  mergeOrder,
  moveAmong,
  orderServers,
  parseLayout,
  pinDm,
  placeDm,
  pruneLayout,
  renameServer,
  reorderServers,
  unpinDm,
  type Layout,
} from '../nav_layout'

const L = (over: Partial<Layout> = {}): Layout => ({ ...emptyLayout, ...over })
const ids = (list: { id: number }[]) => list.map(d => d.id)
const dms = (...list: number[]) => list.map(id => ({ id }))
const view = (dmList: { id: number }[], layout: Layout) => {
  const { pinned, recent } = dmSections(dmList, layout)
  return { pinned: ids(pinned), recent: ids(recent) }
}
const names = (list: string[], saved: string[]) => orderServers(list, n => n, saved)

describe('layout storage', () => {
  test('keys are per account with a shared guest key', () => {
    expect(layoutKey('alice')).toBe('rchat_layout:alice')
    expect(layoutKey(null)).toBe('rchat_layout:guest')
  })

  test('garbage, missing and future versions fall back to an empty layout', () => {
    expect(parseLayout(null)).toEqual(emptyLayout)
    expect(parseLayout('{nope')).toEqual(emptyLayout)
    expect(parseLayout('[1,2]')).toEqual(emptyLayout)
    expect(parseLayout(JSON.stringify({ v: 2, servers: ['a'] }))).toEqual(emptyLayout)
  })

  test('a saved layout round trips and bad entries are dropped', () => {
    const good = L({ servers: ['b', 'a'], dmOrder: [3, 1], dmPinned: [7], dmSeen: 9 })
    expect(parseLayout(JSON.stringify(good))).toEqual(good)
    const messy = parseLayout(
      JSON.stringify({
        v: 1,
        servers: ['a', 'a', 3, '', 'b'],
        dmOrder: [1, 1, -2, 'x', 2.5, 4],
        dmPinned: 'no',
        dmSeen: -1,
      })
    )
    expect(messy).toEqual(L({ servers: ['a', 'b'], dmOrder: [1, 4] }))
  })
})

describe('server order', () => {
  test('without a saved order the api order is kept', () => {
    expect(names(['rchat', 'a', 'b'], [])).toEqual(['rchat', 'a', 'b'])
  })

  test('saved order first, unknown servers appended in api order', () => {
    expect(names(['rchat', 'a', 'b', 'c', 'd'], ['c', 'rchat', 'a'])).toEqual([
      'c',
      'rchat',
      'a',
      'b',
      'd',
    ])
  })

  test('saved servers that are no longer present are skipped', () => {
    expect(names(['rchat', 'b'], ['gone', 'b', 'rchat'])).toEqual(['b', 'rchat'])
  })

  test('works on summary objects', () => {
    const list = [{ name: 'x' }, { name: 'y' }]
    expect(orderServers(list, s => s.name, ['y']).map(s => s.name)).toEqual(['y', 'x'])
  })

  test('reordering stores the full shown order', () => {
    const shown = ['rchat', 'a', 'b', 'c']
    expect(reorderServers(L(), shown, 'c', 0).servers).toEqual(['c', 'rchat', 'a', 'b'])
    expect(reorderServers(L(), shown, 'rchat', 3).servers).toEqual(['a', 'b', 'c', 'rchat'])
    expect(reorderServers(L(), shown, 'a', 2).servers).toEqual(['rchat', 'b', 'a', 'c'])
  })

  test('a newly joined server goes to the bottom after a reorder', () => {
    const saved = reorderServers(L(), ['rchat', 'a', 'b'], 'b', 0)
    expect(names(['rchat', 'a', 'b', 'new'], saved.servers)).toEqual(['b', 'rchat', 'a', 'new'])
  })

  test('saved servers not loaded yet keep their place when reordering', () => {
    const layout = L({ servers: ['a', 'hidden', 'b', 'c'] })
    const shown = names(['a', 'b', 'c'], layout.servers)
    expect(reorderServers(layout, shown, 'c', 1).servers).toEqual(['a', 'hidden', 'c', 'b'])
    expect(reorderServers(layout, shown, 'a', 3).servers).toEqual(['hidden', 'b', 'c', 'a'])
  })

  test('rename keeps the position, forget drops it', () => {
    const layout = L({ servers: ['a', 'b', 'c'] })
    expect(renameServer(layout, 'b', 'z').servers).toEqual(['a', 'z', 'c'])
    expect(renameServer(layout, 'q', 'z')).toBe(layout)
    expect(forgetServer(layout, 'b').servers).toEqual(['a', 'c'])
    expect(forgetServer(layout, 'q')).toBe(layout)
  })
})

describe('dm sections', () => {
  const list = dms(1, 5, 3, 2)

  test('never reordered: recent is the api order', () => {
    expect(view(list, L())).toEqual({ pinned: [], recent: [1, 5, 3, 2] })
  })

  test('never reordered: the self dm stays first', () => {
    const list = [{ id: 4 }, { id: 2, is_self: true }, { id: 3 }]
    expect(ids(dmSections(list, L()).recent)).toEqual([2, 4, 3])
    const manual = L({ dmOrder: [4, 3, 2], dmSeen: 4 })
    expect(ids(dmSections(list, manual).recent)).toEqual([4, 3, 2])
  })

  test('pinned dms keep their own order and never repeat in recent', () => {
    expect(view(list, L({ dmPinned: [3, 1] }))).toEqual({ pinned: [3, 1], recent: [5, 2] })
  })

  test('pinned dms that are not loaded are skipped', () => {
    expect(view(list, L({ dmPinned: [99, 2] }))).toEqual({ pinned: [2], recent: [1, 5, 3] })
  })

  test('after a manual order: new dms on top newest first, then the order, then older unknowns', () => {
    const layout = L({ dmOrder: [3, 1], dmSeen: 5 })
    const loaded = dms(1, 9, 3, 4, 7, 5)
    expect(view(loaded, layout).recent).toEqual([9, 7, 3, 1, 4, 5])
  })

  test('activity does not reorder a manual order', () => {
    const layout = L({ dmOrder: [2, 1, 3], dmSeen: 3 })
    expect(view(dms(3, 1, 2), layout).recent).toEqual([2, 1, 3])
  })

  test('pinned dms are removed from the manual order too', () => {
    const layout = L({ dmOrder: [2, 1, 3], dmSeen: 3, dmPinned: [1] })
    expect(view(dms(1, 2, 3), layout)).toEqual({ pinned: [1], recent: [2, 3] })
  })
})

describe('dm placement', () => {
  const loaded = dms(1, 4, 3, 2)
  const place = (layout: Layout, id: number, zone: 'pinned' | 'recent', index: number) =>
    placeDm(layout, view(loaded, layout), id, zone, index, 4)

  test('dropping in recent saves the manual order and the newest id', () => {
    const next = place(L(), 2, 'recent', 0)
    expect(next.dmOrder).toEqual([2, 1, 4, 3])
    expect(next.dmSeen).toBe(4)
    expect(view(loaded, next).recent).toEqual([2, 1, 4, 3])
  })

  test('dropping in pinned pins at that position and leaves recent untouched', () => {
    const one = place(L(), 3, 'pinned', 0)
    expect(one).toEqual(L({ dmPinned: [3] }))
    const two = place(one, 2, 'pinned', 0)
    expect(two.dmPinned).toEqual([2, 3])
    expect(view(loaded, two)).toEqual({ pinned: [2, 3], recent: [1, 4] })
    expect(place(two, 4, 'pinned', 1).dmPinned).toEqual([2, 4, 3])
  })

  test('reordering within pinned', () => {
    const layout = L({ dmPinned: [1, 2, 3] })
    expect(place(layout, 1, 'pinned', 2).dmPinned).toEqual([2, 3, 1])
  })

  test('dragging a pinned dm into recent unpins it at that spot', () => {
    const layout = L({ dmPinned: [3, 1] })
    const next = place(layout, 3, 'recent', 1)
    expect(view(loaded, next)).toEqual({ pinned: [1], recent: [4, 3, 2] })
  })

  test('a new dm arriving after a manual reorder goes to the top', () => {
    const next = place(L(), 1, 'recent', 3)
    expect(view(dms(1, 4, 3, 2), next).recent).toEqual([4, 3, 2, 1])
    expect(view(dms(1, 4, 3, 2, 8, 6), next).recent).toEqual([8, 6, 4, 3, 2, 1])
  })

  test('the context menu pins to the end and unpins to the top of a manual order', () => {
    expect(pinDm(L({ dmPinned: [2, 1] }), 2).dmPinned).toEqual([1, 2])
    expect(pinDm(L({ dmPinned: [2] }), 5).dmPinned).toEqual([2, 5])
    const auto = unpinDm(L({ dmPinned: [2, 1] }), 2)
    expect(auto).toEqual(L({ dmPinned: [1] }))
    const manual = unpinDm(L({ dmPinned: [2], dmOrder: [1, 2, 3], dmSeen: 3 }), 2)
    expect(manual.dmOrder).toEqual([2, 1, 3])
    expect(view(dms(1, 2, 3), manual).recent).toEqual([2, 1, 3])
  })
})

describe('order helpers', () => {
  test('merge keeps hidden saved entries between their shown neighbours', () => {
    expect(mergeOrder(['a', 'x', 'b', 'y'], ['n', 'a', 'b'])).toEqual(['n', 'a', 'x', 'b', 'y'])
    expect(mergeOrder([], ['a', 'b'])).toEqual(['a', 'b'])
    expect(mergeOrder(['x'], [])).toEqual(['x'])
  })

  test('move inserts before the shown item at the index, or after the last shown one', () => {
    const full = ['a', 'x', 'b', 'y']
    const shown = ['a', 'b']
    expect(moveAmong(full, shown, 'b', 0)).toEqual(['b', 'a', 'x', 'y'])
    expect(moveAmong(full, shown, 'a', 1)).toEqual(['x', 'b', 'a', 'y'])
    expect(moveAmong(['a'], [], 'n', 0)).toEqual(['a', 'n'])
  })

  test('prune drops entries that no longer exist and keeps identity when nothing changes', () => {
    const layout = L({ servers: ['a', 'b'], dmOrder: [1, 2], dmPinned: [3], dmSeen: 3 })
    expect(pruneLayout(layout, ['a', 'b'], [1, 2, 3])).toBe(layout)
    expect(pruneLayout(layout, ['b'], null)).toEqual({ ...layout, servers: ['b'] })
    expect(pruneLayout(layout, null, [2])).toEqual({ ...layout, dmOrder: [2], dmPinned: [] })
  })
})
