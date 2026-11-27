import 'fake-indexeddb/auto'
import { afterAll, describe, expect, test } from 'bun:test'
import { openP2pDb, P2pStore, type EventRecord, type P2pDatabase } from '../p2p/db'
import { rebuildStep } from '../p2p/search'
import { LOCAL } from '../p2p/limits'
import { SEALED_META, Sealing, followSiteSeal, sealingOf, vaultOf } from '../p2p/sealed_db'
import { DEVICE_KEYS_META, webDeviceKeys, type DeviceKeys } from '../platform/device_keys'
import { recordHeader, DEVICE_RECORD } from '../seal_record'
import { resetSessionCaches, useStore } from '../store'

afterAll(resetSessionCaches)

let n = 0
const fresh = () => openP2pDb(`sealed-db-${(n += 1)}-${Math.random()}`)

const rec = (id: string, room: string, text: string, sort = id): EventRecord =>
  ({
    id,
    room,
    type: 'msg',
    sender: 'ik-a',
    wire: { ev: { v: 1, room, type: 'msg', sender: 'ik-a', prev: [] }, c: { text }, sig: 's' },
    depth: 1,
    effTs: 1,
    sortKey: sort,
    receivedAt: 1,
    seq: 1,
    redacted: false,
  }) as unknown as EventRecord

// What the database itself holds, read past the handle the app uses.
const stored = (db: P2pDatabase, id: string) =>
  new Promise<{ wire: unknown } | undefined>((resolve, reject) => {
    const open = indexedDB.open(db.name)
    open.onerror = () => reject(open.error)
    open.onsuccess = () => {
      const req = open.result.transaction('events').objectStore('events').get(id)
      req.onerror = () => reject(req.error)
      req.onsuccess = () => {
        open.result.close()
        resolve(req.result as { wire: unknown } | undefined)
      }
    }
  })

const text = (r: EventRecord | undefined) => (r?.wire.c as { text?: string } | null)?.text

describe('sealed event storage', () => {
  test('a database that never sealed anything is used as it is', async () => {
    const db = await fresh()
    await db.put('events', rec('a', 'room', 'plain'))
    expect((await stored(db, 'a'))?.wire).toEqual(rec('a', 'room', 'plain').wire)
    expect(text(await db.get('events', 'a'))).toBe('plain')
    expect(await db.get('meta', DEVICE_KEYS_META)).toBeUndefined()
    db.close()
  })

  test('a sealed room stores records the app reads as whole events', async () => {
    const db = await fresh()
    const sealing = sealingOf(db)!
    await db.put('events', rec('before', 'room', 'written before'))
    await sealing.setRoom('room', true)
    expect(sealing.on('room') && !sealing.on('other')).toBe(true)
    await db.put('events', rec('a', 'room', 'sealed one', 'k1'))
    await db.add('events', rec('b', 'room', 'sealed two', 'k2'))
    await db.put('events', rec('c', 'other', 'another room', 'k3'))

    const raw = (await stored(db, 'a'))?.wire as Uint8Array
    expect(ArrayBuffer.isView(raw)).toBe(true)
    expect(recordHeader(raw)?.version).toBe(DEVICE_RECORD)
    expect(new TextDecoder().decode(raw)).not.toContain('sealed one')
    expect((await stored(db, 'c'))?.wire).toEqual(rec('c', 'other', 'another room').wire)
    expect((await stored(db, 'before'))?.wire).toEqual(rec('before', 'room', 'written before').wire)

    expect(text(await db.get('events', 'a'))).toBe('sealed one')
    expect((await db.getAll('events')).map(text).sort()).toEqual([
      'another room',
      'sealed one',
      'sealed two',
      'written before',
    ])
    const sorted = await db.getAllFromIndex(
      'events',
      'room_sort',
      IDBKeyRange.bound(['room', ''], ['room', '￿'])
    )
    expect(sorted.map(text)).toEqual(['written before', 'sealed one', 'sealed two'])
    expect(text(await db.getFromIndex('events', 'room_sort', ['room', 'k2']))).toBe('sealed two')

    await sealing.setRoom('room', false)
    await db.put('events', rec('d', 'room', 'plain again', 'k4'))
    expect((await stored(db, 'd'))?.wire).toEqual(rec('d', 'room', 'plain again').wire)
    expect(text(await db.get('events', 'a'))).toBe('sealed one')
    db.close()
  })

  test('transactions read, walk and rewrite sealed records without closing early', async () => {
    const db = await fresh()
    const sealing = sealingOf(db)!
    await sealing.setRoom('room', true)
    const tx = db.transaction(['events', 'rooms', 'meta'], 'readwrite')
    const events = tx.objectStore('events')
    for (let i = 0; i < 20; i += 1)
      await events.put(rec(`e${i}`, 'room', `text ${i}`, `s${String(i).padStart(2, '0')}`))
    void events.put(rec('late', 'room', 'not awaited', 's99'))
    expect(text(await events.get('e3'))).toBe('text 3')
    await tx.objectStore('meta').put(1, 'marker')
    await tx.done
    expect(await db.count('events')).toBe(21)
    expect(ArrayBuffer.isView((await stored(db, 'late'))?.wire)).toBe(true)

    const walk = db.transaction('events', 'readwrite')
    const seen: (string | undefined)[] = []
    let cursor = await walk.store
      .index('room_sort')
      .openCursor(IDBKeyRange.bound(['room', ''], ['room', '￿']))
    while (cursor) {
      seen.push(text(cursor.value))
      if (cursor.value.id === 'e5')
        await cursor.update({ ...cursor.value, wire: rec('e5', 'room', 'rewritten').wire })
      if (cursor.value.id === 'e6') await cursor.delete()
      cursor = await cursor.continue()
    }
    await walk.done
    expect(seen).toHaveLength(21)
    expect(seen[0]).toBe('text 0')
    expect(seen[20]).toBe('not awaited')
    expect(text(await db.get('events', 'e5'))).toBe('rewritten')
    expect(ArrayBuffer.isView((await stored(db, 'e5'))?.wire)).toBe(true)
    expect(await db.get('events', 'e6')).toBeUndefined()

    const read = db.transaction('events')
    const all = await read.store.getAll()
    const one = await read.store.index('room_sort').get(['room', 's07'])
    await read.done
    expect(all).toHaveLength(20)
    expect(all.every(r => typeof r.wire === 'object' && !ArrayBuffer.isView(r.wire))).toBe(true)
    expect(text(one)).toBe('text 7')
    db.close()
  })

  test('what is sealed is remembered, and the site can require every room', async () => {
    const name = `sealed-db-keep-${Math.random()}`
    const first = await P2pStore.create(name)
    await first.sealing.setRoom('dm', true)
    await first.db.put('events', rec('a', 'dm', 'kept'))
    first.close()
    const again = await P2pStore.create(name)
    expect(again.sealing.on('dm') && again.sealing.room('dm')).toBe(true)
    expect(text(await again.event('a'))).toBe('kept')
    expect(await again.meta<{ rooms: string[] }>(SEALED_META)).toMatchObject({
      v: 1,
      all: false,
      rooms: ['dm'],
    })
    await again.sealing.setAll(true)
    expect(again.sealing.on('anything') && !again.sealing.room('anything')).toBe(true)
    await again.db.put('events', rec('b', 'anything', 'required'))
    expect(ArrayBuffer.isView((await stored(again.db, 'b'))?.wire)).toBe(true)
    await again.sealing.setAll(false)
    expect(again.sealing.on('anything')).toBe(false)
    expect(again.sealing.on('dm')).toBe(true)
    again.close()
  })

  test('a record whose device key is gone is reported as lost', async () => {
    const name = `sealed-db-lost-${Math.random()}`
    const first = await P2pStore.create(name)
    await first.sealing.setRoom('room', true)
    await first.db.put('events', rec('a', 'room', 'sealed'))
    expect(await first.sealing.lost()).toBe(false)
    await first.db.delete('meta', DEVICE_KEYS_META)
    first.close()
    const again = await P2pStore.create(name)
    expect(await again.sealing.lost()).toBe(true)
    const left = await again.event('a')
    expect(left).toMatchObject({ id: 'a', room: 'room', unreadable: true, wire: { c: null } })
    expect(again.sealing.unreadable).toBe(1)
    again.close()
  })

  test('a key that fails to open is asked for again before it counts as lost', async () => {
    const db = await fresh()
    const first = sealingOf(db)!
    await first.setRoom('room', true)
    await db.put('events', rec('a', 'room', 'sealed'))
    const keys = webDeviceKeys(vaultOf(first.stored))
    await keys.rotate()
    const failing = (misses: number): DeviceKeys => ({
      ...keys,
      byId: async id => ((misses -= 1) >= 0 ? null : keys.byId(id)),
    })
    const pauses: number[] = []
    const pause = async (ms: number) => void pauses.push(ms)
    // Missed by the read when the database opens and by the first check, found by the next.
    const flaky = failing(2)
    const once = new Sealing(first.stored, () => flaky)
    await once.load()
    expect(await once.lost(pause)).toBe(false)
    expect(pauses).toEqual([250])
    const gone = failing(Infinity)
    const always = new Sealing(first.stored, () => gone)
    await always.load()
    expect(await always.lost(pause)).toBe(true)
    expect(pauses).toEqual([250, 250, 500])
    db.close()
  })

  test('a handle opened before anything was sealed reads what another one sealed since', async () => {
    const name = `sealed-db-two-${Math.random()}`
    const reader = await openP2pDb(name)
    const leader = await openP2pDb(name)
    await sealingOf(leader)!.setRoom('room', true)
    await leader.put('events', rec('a', 'room', 'sealed by the other tab'))
    expect(ArrayBuffer.isView((await stored(leader, 'a'))?.wire)).toBe(true)
    expect(text(await reader.get('events', 'a'))).toBe('sealed by the other tab')
    expect((await reader.getAll('events')).map(text)).toEqual(['sealed by the other tab'])
    const walk = reader.transaction('events')
    const cursor = await walk.store.openCursor()
    expect(text(cursor?.value)).toBe('sealed by the other tab')
    await walk.done
    reader.close()
    leader.close()
  })

  test('one record that does not open leaves every read of the room working', async () => {
    const db = await fresh()
    const sealing = sealingOf(db)!
    await sealing.setRoom('room', true)
    for (const [id, words] of [
      ['a', 'first words'],
      ['b', 'damaged words'],
      ['c', 'third words'],
    ])
      await db.put('events', rec(id, 'room', words, `k-${id}`))
    const raw = sealing.stored
    const b = (await raw.get('events', 'b')) as { wire: Uint8Array }
    const bad = new Uint8Array(b.wire)
    bad[bad.length - 1] ^= 1
    await raw.put('events', { ...b, wire: bad })

    const all = await db.getAll('events')
    expect(all.map(r => [r.id, text(r) ?? null, r.unreadable ?? false])).toEqual([
      ['a', 'first words', false],
      ['b', null, true],
      ['c', 'third words', false],
    ])
    expect(all[1]).toMatchObject({ sender: 'ik-a', sortKey: 'k-b', wire: { c: null, sig: '' } })
    const seen: [string, boolean][] = []
    const tx = db.transaction('events')
    let cursor = await tx.store
      .index('room_sort')
      .openCursor(IDBKeyRange.bound(['room', ''], ['room', '￿']))
    while (cursor) {
      seen.push([cursor.value.id, cursor.value.unreadable === true])
      cursor = await cursor.continue()
    }
    await tx.done
    expect(seen).toEqual([
      ['a', false],
      ['b', true],
      ['c', false],
    ])
    while (!(await rebuildStep(db, { ...LOCAL.search, step: 2 }))) {
      /* the next step */
    }
    expect(sealing.unreadable).toBeGreaterThanOrEqual(3)
    db.close()
  })

  test('what is stored sealed stays sealed when it is written after the switch is off', async () => {
    const db = await fresh()
    const sealing = sealingOf(db)!
    await sealing.setRoom('room', true)
    await db.put('events', rec('a', 'room', 'kept sealed', 's1'))
    await db.put('events', rec('b', 'room', 'also sealed', 's2'))
    await sealing.setRoom('room', false)
    const a = (await db.get('events', 'a'))!
    await db.put('events', { ...a, seq: 2 })
    const walk = db.transaction('events', 'readwrite')
    const cur = await walk.store.openCursor('b')
    await cur?.update({ ...cur.value, seq: 3 })
    await walk.done
    await db.put('events', rec('c', 'room', 'plain now', 's3'))
    for (const id of ['a', 'b']) {
      const raw = (await stored(db, id))?.wire as Uint8Array
      expect(ArrayBuffer.isView(raw)).toBe(true)
      expect(new TextDecoder().decode(raw)).not.toContain('sealed')
    }
    expect((await stored(db, 'c'))?.wire).toEqual(rec('c', 'room', 'plain now').wire)
    expect((await db.getAll('events')).map(r => [text(r), r.seq])).toEqual([
      ['kept sealed', 2],
      ['also sealed', 3],
      ['plain now', 1],
    ])
    db.close()
  })

  test('a record that does not open stays as stored until a whole event replaces it', async () => {
    const db = await fresh()
    const sealing = sealingOf(db)!
    await sealing.setRoom('room', true)
    await db.put('events', rec('b', 'room', 'damaged words'))
    const raw = sealing.stored
    const b = (await raw.get('events', 'b')) as { wire: Uint8Array }
    const bad = new Uint8Array(b.wire)
    bad[bad.length - 1] ^= 1
    await raw.put('events', { ...b, wire: bad })
    const left = (await db.get('events', 'b'))!
    expect(left.unreadable).toBe(true)

    await db.put('events', { ...left, redacted: true, wire: { ...left.wire, c: null } })
    const walk = db.transaction('events', 'readwrite')
    const cur = await walk.store.openCursor('b')
    await cur?.update({ ...cur.value, seq: 9 })
    await walk.done
    expect((await stored(db, 'b'))?.wire).toEqual(bad)
    await sealing.setRoom('room', false)
    await db.put('events', { ...left, redacted: true })
    expect((await stored(db, 'b'))?.wire).toEqual(bad)

    const back = rec('b', 'room', 'sent again by a peer')
    await db.put('events', { ...left, wire: back.wire })
    const now = await db.get('events', 'b')
    expect(text(now)).toBe('sent again by a peer')
    expect(now && 'unreadable' in now).toBe(false)
    db.close()
  })

  test('a database sealed for the site stays sealed while the settings are not loaded', async () => {
    const name = `sealed-db-site-${Math.random()}`
    const first = await P2pStore.create(name)
    await followSiteSeal(first.sealing, true)
    expect(first.sealing.everything).toBe(true)
    first.close()
    const again = await P2pStore.create(name)
    expect(useStore.getState().settings.encryption_required).toBeUndefined()
    await followSiteSeal(again.sealing, useStore.getState().settings.encryption_required)
    expect(again.sealing.everything).toBe(true)
    await again.db.put('events', rec('a', 'offline', 'kept sealed'))
    expect(ArrayBuffer.isView((await stored(again.db, 'a'))?.wire)).toBe(true)
    await followSiteSeal(again.sealing, false)
    expect(again.sealing.everything).toBe(false)
    again.close()
  })
})
