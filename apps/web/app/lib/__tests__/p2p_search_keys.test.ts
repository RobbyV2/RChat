import 'fake-indexeddb/auto'
import { afterAll, describe, expect, test } from 'bun:test'
import {
  openP2pDb,
  SEARCH_META,
  SEARCH_STALE,
  SEARCH_V,
  type EventRecord,
  type P2pDatabase,
} from '../p2p/db'
import { LOCAL } from '../p2p/limits'
import { candidates, indexEvent, rebuildStep, searchReady, unindex } from '../p2p/search'
import { KEYED_MARK, keyedWords } from '../p2p/search_keys'
import { sealingOf, searchForm } from '../p2p/sealed_db'
import { deviceSearchKey } from '../seal_record'
import { resetSessionCaches } from '../store'

afterAll(resetSessionCaches)

const aes = () => crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt'])

const msg = (id: string, room: string, body: string): EventRecord =>
  ({
    id,
    room,
    type: 'msg',
    layer: 'c',
    sender: 'ik-a',
    chan: 'ch1',
    wire: {
      ev: { v: 2, srv: room, t: 'msg', L: 'c', a: 'ik-a', prev: [] },
      c: { ch: 'ch1', body },
      sig: 's',
    },
    depth: 1,
    effTs: 1,
    sortKey: `000.${id}`,
    receivedAt: 1,
    seq: 1,
    redacted: false,
  }) as unknown as EventRecord

const edit = (id: string, room: string, target: string, body: string): EventRecord =>
  ({
    ...msg(id, room, body),
    type: 'edit',
    target,
    wire: {
      ev: { v: 2, srv: room, t: 'edit', L: 'c', a: 'ik-a', prev: [] },
      c: { ch: 'ch1', target, body },
      sig: 's',
    },
    depth: 2,
    sortKey: `001.${id}`,
  }) as unknown as EventRecord

// Stores an event and indexes it in one transaction, as storing a P2P server event does.
const store = async (db: P2pDatabase, r: EventRecord) => {
  const tx = db.transaction(['events', 'search'], 'readwrite')
  await tx.objectStore('events').put(r)
  const form = searchForm(db, LOCAL.search.exact)
  await indexEvent(tx.objectStore('search'), tx.objectStore('events'), r, LOCAL.search, form)
  await tx.done
}

const rows = async (db: P2pDatabase) => (await db.getAllKeys('search')) as unknown as string[][]

const find = async (db: P2pDatabase, room: string, q: string) =>
  (await candidates(db, room, [q], null, 10, LOCAL.search.exact)).list.map(x => x.id)

// Builds the index again from the stored events, as after a change of the local search cut.
const rebuild = async (db: P2pDatabase) => {
  await db.put('meta', SEARCH_STALE, SEARCH_META)
  while (!(await rebuildStep(db, { ...LOCAL.search, step: 1 }))) {
    /* the next step */
  }
}

describe('keyed search rows', () => {
  test('a device key gives one search key, and another key another', async () => {
    const key = await aes()
    const one = await deviceSearchKey(key)
    expect(one.length).toBe(32)
    expect(await deviceSearchKey(key)).toEqual(one)
    expect(await deviceSearchKey(await aes())).not.toEqual(one)
  })

  test('a word is held as each start a query word may name', () => {
    const k = keyedWords(new Uint8Array(32).fill(7), 3, 2)
    const rows = k.rows('room', 'needle')
    expect(rows).toEqual(['nee', 'need', 'needl', 'needle'].map(s => k.row('room', s)))
    expect(rows.every(r => r.startsWith(`${KEYED_MARK}3.`) && r.length === 35)).toBe(true)
    expect(rows.some(r => r.includes('nee'))).toBe(false)
    expect(k.rows('room', 'ab')).toEqual([k.row('room', 'ab')])
    expect(k.rows('room', 'ne')).toEqual([k.row('room', 'ne')])
    expect(k.rows('room', 'needle')).not.toContain(k.row('room', 'ne'))
    expect(k.rows('room', '日本語')).toEqual([k.row('room', '日本語')])
    expect(k.row('room', 'needle')).not.toBe(k.row('other', 'needle'))
    expect(k.row('room', 'needle')).not.toBe(
      keyedWords(new Uint8Array(32), 3, 2).row('room', 'needle')
    )
    expect(keyedWords(new Uint8Array(32).fill(7), 3, 1).rows('room', 'abc')).toEqual(
      ['ab', 'abc'].map(s => k.row('room', s))
    )
  })

  test('an index that does not say it holds keyed rows is built again where a room is sealed', async () => {
    const db = await openP2pDb(`search-keys-${Math.random()}`)
    const sealing = sealingOf(db)!
    expect(searchForm(db, 2)).toEqual({ keyed: null, every: [] })
    await sealing.setRoom('vault', true)
    const form = searchForm(db, 2)
    expect(form.keyed !== null && form.every.length === 1).toBe(true)
    await db.put('events', msg('a', 'vault', 'sealed needle'))
    await db.put('events', msg('b', 'open', 'plain needle'))
    await db.put('meta', { v: SEARCH_V, done: true, at: 'b', word: 32, words: 256 }, SEARCH_META)
    expect(await searchReady(db)).toBe(false)
    while (!(await rebuildStep(db, { ...LOCAL.search, step: 1 }))) {
      /* the next step */
    }
    expect(await searchReady(db)).toBe(true)
    expect(await find(db, 'vault', 'needle')).toEqual(['a'])
    expect(await find(db, 'vault', 'nee')).toEqual(['a'])
    expect(await find(db, 'open', 'needle')).toEqual(['b'])
    const held = await rows(db)
    expect(held.filter(k => k[0] === 'vault').every(k => k[1].startsWith(KEYED_MARK))).toBe(true)
    expect(held.filter(k => k[0] === 'open').map(k => k[1])).toEqual(['needle', 'plain'])

    await sealing.setRoom('vault', false)
    expect(await find(db, 'vault', 'needle')).toEqual(['a'])
    db.close()
  })

  test('what was stored sealed keeps keyed rows after its switch is off', async () => {
    const db = await openP2pDb(`search-keys-${Math.random()}`)
    const sealing = sealingOf(db)!
    await sealing.setRoom('vault', true)
    const sealed = msg('a', 'vault', 'secretword')
    await db.put('events', sealed)
    await sealing.setRoom('vault', false)
    await db.put('events', msg('b', 'vault', 'plainword'))
    await rebuild(db)
    const held = (await rows(db)).filter(k => k[0] === 'vault')
    expect(held.filter(k => k[2] === 'a').every(k => k[1].startsWith(KEYED_MARK))).toBe(true)
    expect(held.filter(k => k[2] === 'b').map(k => k[1])).toEqual(['plainword'])
    expect(await find(db, 'vault', 'secretword')).toEqual(['a'])

    // Indexed after the switch changed, from the record the store wrote sealed.
    const form = searchForm(db, 2)
    const tx = db.transaction(['events', 'search'], 'readwrite')
    await unindex(tx.objectStore('search'), tx.objectStore('events'), sealed, LOCAL.search, form)
    await indexEvent(tx.objectStore('search'), tx.objectStore('events'), sealed, LOCAL.search, form)
    await tx.done
    expect((await rows(db)).some(k => k[1] === 'secretword')).toBe(false)
    expect(await find(db, 'vault', 'secretword')).toEqual(['a'])

    await sealing.setRoom('vault', true)
    await db.put('events', edit('e', 'vault', 'b', 'hidden addition'))
    await rebuild(db)
    const after = (await rows(db)).filter(k => k[2] === 'b').map(k => k[1])
    expect(after.length > 0 && after.every(k => k.startsWith(KEYED_MARK))).toBe(true)
    expect(await find(db, 'vault', 'hidden')).toEqual(['b'])
    expect(await find(db, 'vault', 'plainword')).toEqual(['b'])
    db.close()
  })

  test('keyed rows are found, taken out and kept keyed after a restart with every switch off', async () => {
    const name = `search-keys-${Math.random()}`
    let db = await openP2pDb(name)
    await sealingOf(db)!.setRoom('vault', true)
    await store(db, msg('a', 'vault', 'sealed needle'))
    await store(db, msg('c', 'vault', 'another needle'))
    await sealingOf(db)!.setRoom('vault', false)
    db.close()

    db = await openP2pDb(name)
    expect(searchForm(db, 2).every).toHaveLength(1)
    expect(await find(db, 'vault', 'needle')).toEqual(['c', 'a'])
    await store(db, edit('e', 'vault', 'a', 'other words'))
    expect((await rows(db)).every(k => k[1].startsWith(KEYED_MARK))).toBe(true)
    expect(await find(db, 'vault', 'other')).toEqual(['a'])

    const tx = db.transaction(['events', 'search'], 'readwrite')
    const a = (await tx.objectStore('events').get('a'))!
    const freed = await unindex(
      tx.objectStore('search'),
      tx.objectStore('events'),
      a,
      LOCAL.search,
      searchForm(db, 2)
    )
    await tx.done
    expect(freed).toBeGreaterThan(0)
    expect((await rows(db)).every(k => k[2] === 'c')).toBe(true)
    expect(await find(db, 'vault', 'needle')).toEqual(['c'])
    db.close()
  })

  test('an index built where nothing was sealed is complete for keyed rows', async () => {
    const db = await openP2pDb(`search-keys-${Math.random()}`)
    await db.put('events', msg('b', 'open', 'plain needle'))
    await db.put('meta', { v: SEARCH_V, done: true, at: 'b', word: 32, words: 256 }, SEARCH_META)
    expect(await rebuildStep(db)).toBe(true)
    expect(await db.get('meta', SEARCH_META)).toMatchObject({ keyed: true, exact: 2 })
    await sealingOf(db)!.setRoom('vault', true)
    expect(await searchReady(db)).toBe(true)
    db.close()
  })
})
