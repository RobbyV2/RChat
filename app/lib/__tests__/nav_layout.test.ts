import { describe, expect, test } from 'bun:test'
import {
  addToFolder,
  bootDms,
  dmSections,
  emptyLayout,
  folderChildren,
  folderTitle,
  forgetServer,
  knownDms,
  layoutKey,
  layoutServers,
  mergeOrder,
  mergeServers,
  moveAmong,
  moveFolder,
  moveIntoFolder,
  moveServer,
  newFolderId,
  parseLayout,
  pinDm,
  placeDm,
  pruneLayout,
  railItems,
  railNames,
  renameFolder,
  renameServer,
  toggleFolder,
  ungroupFolder,
  unpinDm,
  type Folder,
  type Layout,
  type RailEntry,
} from '../nav_layout'

const L = (over: Partial<Layout> = {}): Layout => ({ ...emptyLayout, ...over })
const S = (...servers: RailEntry[]) => L({ servers })
const F = (id: string, servers: string[], over: Partial<Folder> = {}): Folder => ({
  id,
  name: null,
  servers,
  open: false,
  ...over,
})
const ids = (list: { id: number }[]) => list.map(d => d.id)
const dms = (...list: number[]) => list.map(id => ({ id }))
const view = (dmList: { id: number }[], layout: Layout) => {
  const { pinned, recent } = dmSections(dmList, layout)
  return { pinned: ids(pinned), recent: ids(recent) }
}
const keys = (loaded: string[], layout: Layout) =>
  railItems(loaded, n => n, layout.servers).map(i => i.key)

describe('layout storage', () => {
  test('keys are per account with a shared guest key', () => {
    expect(layoutKey('alice')).toBe('rchat_layout:alice')
    expect(layoutKey(null)).toBe('rchat_layout:guest')
  })

  test('garbage, missing and future versions fall back to an empty layout', () => {
    expect(parseLayout(null)).toEqual(emptyLayout)
    expect(parseLayout('{nope')).toEqual(emptyLayout)
    expect(parseLayout('[1,2]')).toEqual(emptyLayout)
    expect(parseLayout(JSON.stringify({ v: 3, servers: ['a'] }))).toEqual(emptyLayout)
  })

  test('a saved layout round trips and bad entries are dropped', () => {
    const good = L({
      servers: ['b', F('f1', ['c', 'd'], { name: 'Games', open: true }), 'a'],
      dmOrder: [3, 1],
      dmPinned: [7],
      dmSeen: 9,
    })
    expect(parseLayout(JSON.stringify(good))).toEqual(good)
    const messy = parseLayout(
      JSON.stringify({
        v: 2,
        servers: ['a', 'a', 3, '', 'b', { id: '' }, null],
        dmOrder: [1, 1, -2, 'x', 2.5, 4],
        dmPinned: 'no',
        dmSeen: -1,
      })
    )
    expect(messy).toEqual(L({ servers: ['a', 'b'], dmOrder: [1, 4] }))
  })

  test('a v1 layout migrates to v2 with the same order and dm fields', () => {
    const v1 = { v: 1, servers: ['b', 'a', 'b', 7], dmOrder: [2], dmPinned: [5], dmSeen: 4 }
    expect(parseLayout(JSON.stringify(v1))).toEqual({
      v: 2,
      servers: ['b', 'a'],
      dmOrder: [2],
      dmPinned: [5],
      dmSeen: 4,
    })
    expect(parseLayout(JSON.stringify({ v: 1, servers: [F('x', ['a', 'b'])] })).servers).toEqual([])
  })

  test('folders are validated: names cleaned, duplicates and tiny folders flattened', () => {
    const raw = {
      v: 2,
      servers: [
        { id: 'f1', name: '  Games  ', servers: ['a', 'b', 'a', 4], open: 'yes' },
        { id: 'f2', name: '   ', servers: ['c'] },
        { id: 'f1', servers: ['d', 'e'] },
        { id: 'f3', name: 'x'.repeat(80), servers: ['b', 'f', 'g'], open: true },
        { id: 'f4', servers: [] },
        'a',
      ],
    }
    expect(parseLayout(JSON.stringify(raw)).servers).toEqual([
      F('f1', ['a', 'b'], { name: 'Games' }),
      'c',
      'd',
      'e',
      F('f3', ['f', 'g'], { name: 'x'.repeat(50), open: true }),
    ])
  })
})

describe('rail items', () => {
  test('without a saved order the api order is kept', () => {
    expect(railNames(['rchat', 'a', 'b'], [])).toEqual(['rchat', 'a', 'b'])
  })

  test('saved order first, unknown servers appended in api order', () => {
    expect(railNames(['rchat', 'a', 'b', 'c', 'd'], ['c', 'rchat', 'a'])).toEqual([
      'c',
      'rchat',
      'a',
      'b',
      'd',
    ])
  })

  test('folders show their loaded servers and unknown servers go after them', () => {
    const layout = S('a', F('f', ['b', 'gone', 'c'], { open: true }), F('empty', ['x', 'y']))
    const items = railItems(['new', 'c', 'a', 'b'], n => n, layout.servers)
    expect(items).toEqual([
      { kind: 'server', key: 'server:a', server: 'a' },
      { kind: 'folder', key: 'folder:f', folder: layout.servers[1] as Folder, servers: ['b', 'c'] },
      { kind: 'server', key: 'server:new', server: 'new' },
    ])
    expect(railNames(['new', 'c', 'a', 'b'], layout.servers)).toEqual(['a', 'b', 'c', 'new'])
    expect(layoutServers(layout.servers)).toEqual(['a', 'b', 'gone', 'c', 'x', 'y'])
  })

  test('folder children are the loaded servers in saved order', () => {
    const byName = new Map([
      ['c', 'C'],
      ['a', 'A'],
    ])
    expect(folderChildren(F('f', ['a', 'gone', 'c']), byName)).toEqual(['A', 'C'])
    expect(folderChildren(F('f', ['x', 'y']), byName)).toEqual([])
  })

  test('works on summary objects', () => {
    const list = [{ name: 'x' }, { name: 'y' }, { name: 'z' }]
    const items = railItems(list, s => s.name, [F('f', ['z', 'x'])])
    expect(
      items.map(i => (i.kind === 'folder' ? i.servers.map(s => s.name) : i.server.name))
    ).toEqual([['z', 'x'], 'y'])
  })

  test('the default folder title lists server names and truncates long lists', () => {
    expect(folderTitle('Games', ['A', 'B'])).toBe('Games')
    expect(folderTitle(null, ['Alpha', 'Bravo'])).toBe('Alpha, Bravo')
    expect(
      folderTitle(null, ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Golf'])
    ).toBe('Alpha, Bravo, Charlie, Delta, Echo, Foxtrot and 1 more')
    const long = 'L'.repeat(60)
    expect(folderTitle(null, [long, 'B'])).toBe(`${'L'.repeat(31)}…, B`)
    expect(folderTitle(null, [long, long, 'C'])).toBe(`${'L'.repeat(31)}… and 2 more`)
  })
})

describe('server order', () => {
  const loaded = ['rchat', 'a', 'b', 'c']

  test('moving stores the full shown order', () => {
    expect(moveServer(L(), loaded, 'c', 0).servers).toEqual(['c', 'rchat', 'a', 'b'])
    expect(moveServer(L(), loaded, 'rchat', 3).servers).toEqual(['a', 'b', 'c', 'rchat'])
    expect(moveServer(L(), loaded, 'a', 2).servers).toEqual(['rchat', 'b', 'a', 'c'])
  })

  test('a newly joined server goes to the bottom after a reorder', () => {
    const saved = moveServer(L(), ['rchat', 'a', 'b'], 'b', 0)
    expect(railNames(['rchat', 'a', 'b', 'new'], saved.servers)).toEqual(['b', 'rchat', 'a', 'new'])
  })

  test('saved servers not loaded yet keep their place when reordering', () => {
    const layout = S('a', 'hidden', 'b', 'c')
    expect(moveServer(layout, ['a', 'b', 'c'], 'c', 1).servers).toEqual(['a', 'hidden', 'c', 'b'])
    expect(moveServer(layout, ['a', 'b', 'c'], 'a', 3).servers).toEqual(['hidden', 'b', 'c', 'a'])
  })

  test('rename keeps the position, forget drops it', () => {
    const layout = S('a', 'b', 'c')
    expect(renameServer(layout, 'b', 'z').servers).toEqual(['a', 'z', 'c'])
    expect(renameServer(layout, 'q', 'z')).toBe(layout)
    expect(forgetServer(layout, 'b').servers).toEqual(['a', 'c'])
    expect(forgetServer(layout, 'q')).toBe(layout)
  })
})

describe('server folders', () => {
  const loaded = ['rchat', 'a', 'b', 'c', 'd']

  test('dropping a server onto another makes a collapsed folder at the target', () => {
    const next = mergeServers(L(), loaded, 'd', 'a', 'f1')
    expect(next.servers).toEqual(['rchat', F('f1', ['a', 'd']), 'b', 'c'])
    expect(keys(loaded, next)).toEqual(['server:rchat', 'folder:f1', 'server:b', 'server:c'])
  })

  test('merging onto itself, a missing server or a folder child does nothing', () => {
    const layout = S('rchat', F('f1', ['a', 'b']), 'c')
    expect(mergeServers(layout, loaded, 'c', 'c', 'f2')).toBe(layout)
    expect(mergeServers(layout, loaded, 'c', 'zz', 'f2')).toBe(layout)
    expect(mergeServers(layout, loaded, 'c', 'a', 'f2')).toBe(layout)
  })

  test('merging a server out of a folder of two dissolves the old folder', () => {
    const layout = S(F('f1', ['a', 'b']), 'c', 'd')
    expect(mergeServers(layout, loaded, 'b', 'd', 'f2').servers).toEqual([
      'a',
      'c',
      F('f2', ['d', 'b']),
      'rchat',
    ])
  })

  test('dropping onto a folder appends to it, unless it is already inside', () => {
    const layout = S('rchat', F('f1', ['a', 'b']), 'c')
    expect(addToFolder(layout, loaded, 'c', 'f1').servers).toEqual([
      'rchat',
      F('f1', ['a', 'b', 'c']),
      'd',
    ])
    expect(addToFolder(layout, loaded, 'a', 'f1')).toBe(layout)
    expect(addToFolder(layout, loaded, 'c', 'nope')).toBe(layout)
  })

  test('moving into an open folder places the server between the shown children', () => {
    const layout = S(F('f1', ['a', 'hidden', 'b'], { open: true }), 'c')
    const into = (name: string, index: number) =>
      moveIntoFolder(layout, loaded, name, 'f1', index).servers[0]
    expect(into('c', 0)).toEqual(F('f1', ['c', 'a', 'hidden', 'b'], { open: true }))
    expect(into('c', 1)).toEqual(F('f1', ['a', 'hidden', 'c', 'b'], { open: true }))
    expect(into('c', 2)).toEqual(F('f1', ['a', 'hidden', 'b', 'c'], { open: true }))
    expect(into('b', 0)).toEqual(F('f1', ['b', 'a', 'hidden'], { open: true }))
    expect(moveIntoFolder(layout, loaded, 'c', 'nope', 0)).toBe(layout)
  })

  test('dragging a server out removes it and a folder left with one server dissolves', () => {
    const three = S(F('f1', ['a', 'b', 'c']), 'd')
    expect(moveServer(three, loaded, 'b', 0).servers).toEqual([
      'b',
      F('f1', ['a', 'c']),
      'd',
      'rchat',
    ])
    const two = S('rchat', F('f1', ['a', 'b']), 'c')
    expect(moveServer(two, loaded, 'a', 3).servers).toEqual(['rchat', 'b', 'c', 'a', 'd'])
    expect(moveServer(two, loaded, 'b', 1).servers).toEqual(['rchat', 'b', 'a', 'c', 'd'])
  })

  test('folders reorder as one entry and keep their servers', () => {
    const layout = S('rchat', F('f1', ['a', 'b'], { open: true }), 'c', F('f2', ['d', 'e']))
    const shown = ['rchat', 'a', 'b', 'c', 'd', 'e']
    expect(moveFolder(layout, shown, 'f1', 0).servers).toEqual([
      F('f1', ['a', 'b'], { open: true }),
      'rchat',
      'c',
      F('f2', ['d', 'e']),
    ])
    expect(moveFolder(layout, shown, 'f2', 1).servers).toEqual([
      'rchat',
      F('f2', ['d', 'e']),
      F('f1', ['a', 'b'], { open: true }),
      'c',
    ])
    expect(moveFolder(layout, shown, 'nope', 0)).toBe(layout)
  })

  test('toggling, renaming and ungrouping a folder', () => {
    const layout = S('rchat', F('f1', ['a', 'b']), 'c')
    const open = toggleFolder(layout, 'f1')
    expect(open.servers[1]).toEqual(F('f1', ['a', 'b'], { open: true }))
    expect(toggleFolder(open, 'f1').servers[1]).toEqual(F('f1', ['a', 'b']))
    const named = renameFolder(layout, 'f1', '  Work stuff ')
    expect(named.servers[1]).toEqual(F('f1', ['a', 'b'], { name: 'Work stuff' }))
    expect(renameFolder(named, 'f1', '   ').servers[1]).toEqual(F('f1', ['a', 'b']))
    expect(ungroupFolder(layout, 'f1').servers).toEqual(['rchat', 'a', 'b', 'c'])
    expect(toggleFolder(layout, 'nope')).toBe(layout)
  })

  test('renamed servers keep their place inside folders', () => {
    const layout = S('rchat', F('f1', ['a', 'b']))
    expect(renameServer(layout, 'b', 'bee').servers).toEqual(['rchat', F('f1', ['a', 'bee'])])
    expect(renameServer(layout, 'b', 'a').servers).toEqual(['rchat', 'a'])
  })

  test('removed servers dissolve folders down to one server or drop empty ones', () => {
    const layout = S('rchat', F('f1', ['a', 'b', 'c']), F('f2', ['d', 'e']))
    const one = forgetServer(layout, 'a')
    expect(one.servers).toEqual(['rchat', F('f1', ['b', 'c']), F('f2', ['d', 'e'])])
    expect(forgetServer(one, 'e').servers).toEqual(['rchat', F('f1', ['b', 'c']), 'd'])
    expect(pruneLayout(layout, ['rchat', 'b', 'd', 'e'], null).servers).toEqual([
      'rchat',
      'b',
      F('f2', ['d', 'e']),
    ])
    expect(pruneLayout(layout, ['rchat'], null).servers).toEqual(['rchat'])
    expect(pruneLayout(layout, ['rchat', 'a', 'b', 'c', 'd', 'e', 'x'], null)).toBe(layout)
  })

  test('new folder ids are random and never reuse an existing id', () => {
    const rolls = [0.5, 0.5, 0.25]
    const random = () => rolls.shift() ?? 0.75
    const taken = (0.5).toString(36).slice(2, 10)
    expect(newFolderId([F(taken, ['a', 'b'])], random)).toBe((0.25).toString(36).slice(2, 10))
    expect(newFolderId([]).length > 0).toBe(true)
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

describe('dm boot', () => {
  const order = Array.from({ length: 120 }, (_, i) => i + 1)
  const layout: Layout = { ...emptyLayout, dmPinned: [200, 3], dmOrder: order }

  test('loads pinned dms and only the first page of the manual order', () => {
    const asked = bootDms(layout, 50)
    expect(asked).toEqual([200, 3, ...order.slice(0, 50).filter(id => id !== 3)])
  })

  test('keeps the unasked part of the order when pruning', () => {
    const asked = bootDms(layout, 50)
    const loaded = asked.filter(id => id !== 7)
    const kept = pruneLayout(layout, null, knownDms(layout, loaded, asked))
    expect(kept.dmOrder).toEqual(order.filter(id => id !== 7))
    expect(kept.dmPinned).toEqual([200, 3])
  })
})
