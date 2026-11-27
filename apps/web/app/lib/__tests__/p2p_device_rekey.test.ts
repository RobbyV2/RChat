import 'fake-indexeddb/auto'
import { afterEach, describe, expect, test } from 'bun:test'
import { Hub, ManualClock } from './p2p_net'
import type { PartRecord } from '../p2p/db'
import { partRange } from '../p2p/blobs'
import { REKEY_META, rekeyStep, replaceDeviceKey, resumeRekey } from '../p2p/device_rekey'
import { LOCAL } from '../p2p/limits'
import { vaultOf } from '../p2p/sealed_db'
import { deviceKeys } from '../platform'
import { PING_LOG, logValue, parseLog, type SealedPing } from '../p2p/inbox'
import { PING_STORE, openPings } from '../p2p/ping_log'
import { bodies, general, makeMember, pump, stopAll, type Member } from './p2p_server_net'

afterEach(stopAll)

// The keys the sealed events of `room` on `m`'s device name.
const eventKeys = async (m: Member, room: string) => {
  const rows = (await m.store.sealing.stored.getAll('events')) as {
    room: string
    wire: unknown
  }[]
  const ids = rows
    .filter(r => r.room === room && ArrayBuffer.isView(r.wire))
    .map(r => m.store.sealing.keyOf(r.wire as Uint8Array))
  return [...new Set(ids)]
}

const query = (q: string) => ({
  q,
  from: null,
  room: null,
  ch: null,
  hasFile: false,
  beforeTs: null,
  afterTs: null,
})

const sealedRoom = async (name: string) => {
  const clock = new ManualClock()
  const hub = new Hub()
  const a = await makeMember(hub, 'Alice', clock)
  const room = await a.servers.create(name)
  const ch = general(a, room)
  await a.servers.setStore(room, true)
  await pump(clock, () => a.store.sealing.room(room), 'sealed')
  return { clock, a, room, ch }
}

describe("replacing this device's key", () => {
  test('everything the old key sealed is sealed again and the old key goes', async () => {
    const { clock, a, room, ch } = await sealedRoom('Kept')
    const { hashBytes } = await import('../p2p/hashing')
    const data = new Uint8Array(3000).map((_, i) => (i * 5) % 251)
    const hashed = await hashBytes(data)
    await a.dms.blobs.putOwn(new Blob([data as BlobPart]), hashed, room)
    const att = {
      h: hashed.h,
      size: hashed.size,
      blocks: hashed.blocks.length,
      name: 'a.bin',
      mime: 'image/png',
    }
    await a.servers.send(room, { ch, body: 'a needle with a file', att: [att] })
    await a.servers.send(room, { ch, body: 'more hay' })
    const old = await a.store.sealing.inUse()
    expect(old).not.toBeNull()
    expect(await eventKeys(a, room)).toEqual([old!])
    const parts = async () =>
      (await a.store.sealing.stored.getAll('blob_parts', partRange(hashed.h))) as PartRecord[]
    const partKeys = async () =>
      Promise.all(
        (await parts()).map(async p =>
          a.store.sealing.keyOf(new Uint8Array(await p.data.arrayBuffer()))
        )
      )
    expect(await partKeys()).toEqual([old!])
    const box = await a.store.sealing.box(PING_STORE, 'ev1', room, {
      kind: 'mention',
      emoji: null,
    })
    const ping: SealedPing = {
      id: 'ev1',
      room,
      ch,
      actor: a.node.ik,
      at: 1,
      seq: 1,
      target: null,
      seen: false,
      thread: null,
      box: box!,
    }
    await a.store.db.put('meta', logValue([ping]), PING_LOG)

    expect(await replaceDeviceKey(a.store, LOCAL.search)).toBe(true)
    expect(await replaceDeviceKey(a.store, LOCAL.search)).toBe(false)
    await pump(clock, async () => (await a.store.meta(REKEY_META)) === undefined, 'replaced')
    const fresh = await a.store.sealing.inUse()
    expect(fresh).not.toBe(old)
    expect(await eventKeys(a, room)).toEqual([fresh!])
    expect(await partKeys()).toEqual([fresh!])
    const log = parseLog(await a.store.meta(PING_LOG)) as SealedPing[]
    expect(log.map(p => a.store.sealing.keyOf(p.box))).toEqual([fresh!])
    expect((await openPings(a.store.sealing, log)).map(p => p.kind)).toEqual(['mention'])
    expect(await deviceKeys(vaultOf(a.store.sealing.stored)).byId(old!)).toBeNull()
    expect((await a.servers.search(query('needle'), null, 100)).hits.map(h => h.m.body)).toEqual([
      'a needle with a file',
    ])
    const rows = (await a.store.sealing.stored.getAllKeys('search')) as unknown as string[][]
    expect(rows.filter(k => k[0] === room).every(k => k[1].startsWith('#'))).toBe(true)
    const opened = await a.dms.blobs.file(hashed.h)
    expect(new Uint8Array(await opened!.arrayBuffer())).toEqual(data)
    const shown = await bodies(a, room, ch)
    expect(['a needle with a file', 'more hay'].every(t => shown.includes(t))).toBe(true)
  }, 90_000)

  test('a replacement a restart stopped goes on from its marker', async () => {
    const { clock, a, room, ch } = await sealedRoom('Resumed')
    for (const body of ['one', 'two', 'three']) await a.servers.send(room, { ch, body })
    const old = (await a.store.sealing.inUse())!
    const renewed = await rekeyStep(a.store, { from: old, phase: 'renew', at: null }, LOCAL.search)
    expect(renewed.phase).toBe('events')
    expect(await a.store.sealing.inUse()).not.toBe(old)
    const next = await rekeyStep(a.store, renewed, LOCAL.search)
    await a.store.db.put('meta', next, REKEY_META)
    expect(next.phase).toBe('search')
    await resumeRekey(a.store, LOCAL.search)
    await pump(clock, async () => (await a.store.meta(REKEY_META)) === undefined, 'done')
    expect(await eventKeys(a, room)).toEqual([(await a.store.sealing.inUse())!])
    const kept = await bodies(a, room, ch)
    expect(['one', 'two', 'three'].every(t => kept.includes(t))).toBe(true)
  }, 90_000)

  test('a room of more than one step of events is sealed again whole', async () => {
    const { clock, a, room, ch } = await sealedRoom('Long')
    for (let i = 0; i < 205; i += 1) await a.servers.send(room, { ch, body: `needle ${i}` })
    const old = (await a.store.sealing.inUse())!
    expect(await replaceDeviceKey(a.store, LOCAL.search)).toBe(true)
    await pump(clock, async () => (await a.store.meta(REKEY_META)) === undefined, 'replaced')
    const fresh = (await a.store.sealing.inUse())!
    expect(fresh).not.toBe(old)
    expect(await eventKeys(a, room)).toEqual([fresh])
    expect((await a.servers.search(query('needle'), null, 300)).hits.length).toBe(205)
  }, 120_000)

  test('a device that sealed nothing has nothing to replace', async () => {
    const clock = new ManualClock()
    const a = await makeMember(new Hub(), 'Alice', clock)
    expect(await replaceDeviceKey(a.store, LOCAL.search)).toBe(false)
  }, 30_000)
})
