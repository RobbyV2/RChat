import 'fake-indexeddb/auto'
import { describe, expect, test } from 'bun:test'
import { memoryRecords } from '../platform/memory_records'
import type { RecordStore, Stored } from '../platform/records'
import { webRecords, webRecordsOn } from '../platform/web_records'

interface Row extends Stored {
  text: string
  tags?: string[]
}

const row = (id: string, at: number, text = id): Row => ({ id, at, text })

let made = 0
const name = () => `records_test_${(made += 1)}`

const ids = (rows: Row[]) => rows.map(r => r.id)

const stores: [string, () => RecordStore][] = [
  ['memory', memoryRecords],
  ['IndexedDB', () => webRecords],
]

for (const [kind, make] of stores) {
  describe(`${kind} record store`, () => {
    test('lists the newest first, a page at a time', async () => {
      const table = make().open<Row>(name())
      expect(await table.list()).toEqual([])
      expect(await table.count()).toBe(0)
      await table.put([row('a', 100), row('b', 300), row('c', 200)])
      await table.put([row('d', 400)])
      expect(ids(await table.list())).toEqual(['d', 'b', 'c', 'a'])
      expect(await table.count()).toBe(4)
      const first = await table.list({ limit: 2 })
      expect(ids(first)).toEqual(['d', 'b'])
      const second = await table.list({ before: first[1], limit: 2 })
      expect(ids(second)).toEqual(['c', 'a'])
      expect(await table.list({ before: second[1] })).toEqual([])
      expect(ids(await table.list({ limit: 0 }))).toEqual([])
    })

    test('records of the same moment page by id, none twice and none lost', async () => {
      const table = make().open<Row>(name())
      await table.put(['a', 'b', 'c', 'd', 'e'].map(id => row(id, 500)))
      await table.put([row('z', 400), row('y', 600)])
      const seen: string[] = []
      let before: Row | undefined
      for (;;) {
        const page = await table.list({ before, limit: 2 })
        if (!page.length) break
        seen.push(...ids(page))
        before = page[page.length - 1]
      }
      expect(seen).toEqual(['y', 'e', 'd', 'c', 'b', 'a', 'z'])
    })

    test('a record with a known id replaces the old one', async () => {
      const table = make().open<Row>(name())
      await table.put([row('a', 100, 'first'), row('b', 200)])
      await table.put([row('a', 300, 'second')])
      expect(await table.count()).toBe(2)
      expect(await table.list()).toEqual([row('a', 300, 'second'), row('b', 200)])
    })

    test('what is stored is a copy', async () => {
      const table = make().open<Row>(name())
      const mine: Row = { id: 'a', at: 1, text: 'kept', tags: ['x'] }
      await table.put([mine])
      mine.text = 'changed'
      mine.tags?.push('y')
      const [got] = await table.list()
      expect(got).toEqual({ id: 'a', at: 1, text: 'kept', tags: ['x'] })
      got.text = 'changed again'
      expect((await table.list())[0].text).toBe('kept')
    })

    test('deletes by id and ignores ids it does not have', async () => {
      const table = make().open<Row>(name())
      await table.put([row('a', 1), row('b', 2), row('c', 3)])
      await table.delete(['a', 'c', 'nope'])
      expect(ids(await table.list())).toEqual(['b'])
      await table.delete([])
      expect(await table.count()).toBe(1)
    })

    test('prunes by age, by count, and by both', async () => {
      const table = make().open<Row>(name())
      const fill = () => table.put([1, 2, 3, 4, 5, 6].map(n => row(`r${n}`, n * 100)))
      await fill()
      expect(await table.prune({ olderThan: 300 })).toBe(2)
      expect(ids(await table.list())).toEqual(['r6', 'r5', 'r4', 'r3'])
      expect(await table.prune({ keep: 3 })).toBe(1)
      expect(ids(await table.list())).toEqual(['r6', 'r5', 'r4'])
      expect(await table.prune({ keep: 3, olderThan: 100 })).toBe(0)
      await fill()
      expect(await table.prune({ olderThan: 250, keep: 2 })).toBe(4)
      expect(ids(await table.list())).toEqual(['r6', 'r5'])
      expect(await table.prune({ keep: 0 })).toBe(2)
      expect(await table.count()).toBe(0)
      expect(await table.prune({})).toBe(0)
    })

    test('clears one table and leaves the others', async () => {
      const store = make()
      const one = store.open<Row>(name())
      const two = store.open<Row>(name())
      await one.put([row('a', 1)])
      await two.put([row('a', 2), row('b', 3)])
      await one.clear()
      expect(await one.count()).toBe(0)
      expect(ids(await two.list())).toEqual(['b', 'a'])
      await one.put([row('c', 4)])
      expect(ids(await one.list())).toEqual(['c'])
    })

    test('a table opened twice is the same table', async () => {
      const store = make()
      const table = name()
      await store.open<Row>(table).put([row('a', 1)])
      expect(ids(await store.open<Row>(table).list())).toEqual(['a'])
    })

    test('removing a table drops its records, and it can be used again', async () => {
      const store = make()
      const table = name()
      await store.open<Row>(table).put([row('a', 1)])
      await store.remove(table)
      expect(await store.open<Row>(table).count()).toBe(0)
      await store.open<Row>(table).put([row('b', 2)])
      expect(ids(await store.open<Row>(table).list())).toEqual(['b'])
      await store.remove(name())
    })

    test('many writes at once all land', async () => {
      const table = make().open<Row>(name())
      await Promise.all(
        Array.from({ length: 40 }, (_, i) => table.put([row(`r${String(i).padStart(2, '0')}`, i)]))
      )
      expect(await table.count()).toBe(40)
      expect(ids(await table.list({ limit: 3 }))).toEqual(['r39', 'r38', 'r37'])
    })
  })
}

describe('what the stores say about themselves', () => {
  test('memory records do not outlive the page; IndexedDB ones do', async () => {
    expect(await memoryRecords().open<Row>(name()).durable()).toBe(false)
    expect(await webRecords.open<Row>(name()).durable()).toBe(true)
  })

  test('two memory stores share nothing', async () => {
    const table = name()
    await memoryRecords()
      .open<Row>(table)
      .put([row('a', 1)])
    expect(await memoryRecords().open<Row>(table).count()).toBe(0)
  })

  test('IndexedDB records are there for a store made later', async () => {
    const table = name()
    await webRecordsOn(() => indexedDB)
      .open<Row>(table)
      .put([row('a', 1)])
    expect(
      ids(
        await webRecordsOn(() => indexedDB)
          .open<Row>(table)
          .list()
      )
    ).toEqual(['a'])
  })
})

describe('IndexedDB tables open in two tabs', () => {
  test('removing a table in one tab deletes it while the other has it open', async () => {
    const tabA = webRecordsOn(() => indexedDB)
    const tabB = webRecordsOn(() => indexedDB)
    const table = name()
    await tabA.open<Row>(table).put([row('a', 1)])
    expect(await tabB.open<Row>(table).count()).toBe(1)
    await tabA.remove(table)
    expect((await indexedDB.databases()).map(d => d.name)).not.toContain(table)
    expect(await tabA.open<Row>(table).count()).toBe(0)
    expect(await tabB.open<Row>(table).count()).toBe(0)
    await tabA.open<Row>(table).put([row('b', 2)])
    expect(ids(await tabB.open<Row>(table).list())).toEqual(['b'])
    expect(await tabB.open<Row>(table).durable()).toBe(true)
  })
})

describe('a browser without IndexedDB', () => {
  const broken: [string, () => IDBFactory | undefined][] = [
    ['none at all', () => undefined],
    [
      'one that throws',
      () => {
        throw new Error('denied')
      },
    ],
    [
      'one whose open throws',
      () =>
        ({
          open: () => {
            throw new Error('SecurityError')
          },
        }) as unknown as IDBFactory,
    ],
    [
      'one whose open fails',
      () =>
        ({
          open: () => {
            const req = { error: new Error('InvalidStateError') } as unknown as IDBOpenDBRequest
            queueMicrotask(() => req.onerror?.(new Event('error')))
            return req
          },
        }) as unknown as IDBFactory,
    ],
  ]

  for (const [what, factory] of broken) {
    test(`${what}: records are held in memory and the table says so`, async () => {
      const store = webRecordsOn(factory)
      const table = store.open<Row>(name())
      expect(await table.durable()).toBe(false)
      await table.put([row('a', 1), row('b', 2)])
      expect(ids(await table.list())).toEqual(['b', 'a'])
      expect(await table.prune({ keep: 1 })).toBe(1)
      expect(await table.count()).toBe(1)
      await table.clear()
      expect(await table.count()).toBe(0)
    })
  }

  test('the same table keeps its memory records for as long as the page lives', async () => {
    const store = webRecordsOn(() => undefined)
    const table = name()
    await store.open<Row>(table).put([row('a', 1)])
    expect(ids(await store.open<Row>(table).list())).toEqual(['a'])
    await store.remove(table)
    expect(await store.open<Row>(table).count()).toBe(0)
  })
})
