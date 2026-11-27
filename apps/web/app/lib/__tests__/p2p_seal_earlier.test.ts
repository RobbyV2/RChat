import 'fake-indexeddb/auto'
import { afterEach, describe, expect, test } from 'bun:test'
import { Hub, ManualClock } from './p2p_net'
import type { EventRecord, PartRecord } from '../p2p/db'
import { partRange } from '../p2p/blobs'
import { EARLIER_META, earlierStep, markerOf, resumeEarlier } from '../p2p/seal_earlier'
import { LOCAL } from '../p2p/limits'
import { loadMessages } from '../p2p/dm'
import {
  bodies,
  general,
  joinWithCode,
  makeMember,
  pump,
  stopAll,
  type Member,
} from './p2p_server_net'

afterEach(stopAll)

// The stored form of the events of `room` on `m`'s device, by sealed or plain.
const forms = async (m: Member, room: string) => {
  const rows = (await m.store.sealing.stored.getAll('events')) as {
    room: string
    wire: unknown
  }[]
  const mine = rows.filter(r => r.room === room)
  return {
    sealed: mine.filter(r => ArrayBuffer.isView(r.wire)).length,
    plain: mine.filter(r => !ArrayBuffer.isView(r.wire)).length,
  }
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

const fileOf = async (size: number) => {
  const { hashBytes } = await import('../p2p/hashing')
  const data = new Uint8Array(size).map((_, i) => (i * 3) % 251)
  const h = await hashBytes(data)
  return {
    data,
    hashed: h,
    att: { h: h.h, size: h.size, blocks: h.blocks.length, name: 'old.bin', mime: 'image/png' },
  }
}

type Fn = (...args: unknown[]) => unknown

// The storage lines of `ch`: whether each turned it on.
const storageLines = async (m: Member, room: string, ch: string) =>
  (await m.servers.loadChannel(room, ch, { limit: 1000 })).messages
    .filter(x => x.system?.kind === 'storage')
    .map(x => (x.system as { on?: boolean }).on)

const done = (m: Member, room: string) => async () =>
  markerOf(await m.store.meta(EARLIER_META + room)).phase === 'done'

describe('encrypting the earlier messages of a P2P server', () => {
  test('every device seals what it stored before, its search rows and its files', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const a = await makeMember(hub, 'Alice', clock)
    const b = await makeMember(hub, 'Bob', clock)
    const room = await a.servers.create('Archive')
    const ch = general(a, room)
    await joinWithCode(clock, a, room, b)
    const f = await fileOf(3000)
    await a.dms.blobs.putOwn(new Blob([f.data as BlobPart]), f.hashed, room)
    await a.servers.send(room, { ch, body: 'an earlier needle', att: [f.att] })
    await a.servers.send(room, { ch, body: 'more earlier hay' })
    await pump(clock, async () => (await bodies(b, room, ch)).length >= 2, 'bob has them')
    expect((await forms(a, room)).sealed).toBe(0)
    expect((await a.dms.blobs.record(f.att.h))?.file instanceof Blob).toBe(true)

    await a.servers.setStore(room, true, true)
    for (const m of [a, b]) await pump(clock, done(m, room), `${m.node.ik.slice(0, 4)} done`)
    for (const m of [a, b]) {
      const stored = await forms(m, room)
      expect(stored.plain).toBe(0)
      expect(stored.sealed).toBeGreaterThan(2)
      const hits = (await m.servers.search(query('needle'), null, 100)).hits
      expect(hits.map(h => h.m.body)).toEqual(['an earlier needle'])
      const rows = (await m.store.sealing.stored.getAllKeys('search')) as unknown as string[][]
      expect(rows.filter(k => k[0] === room).every(k => k[1].startsWith('#'))).toBe(true)
    }
    const parts = (await a.store.sealing.stored.getAll(
      'blob_parts',
      partRange(f.att.h)
    )) as PartRecord[]
    expect(parts.map(p => p.sealed)).toEqual([true])
    expect((await a.dms.blobs.record(f.att.h))?.file).toBeUndefined()
    const opened = await a.dms.blobs.file(f.att.h)
    expect(new Uint8Array(await opened!.arrayBuffer())).toEqual(f.data)
    const shown = await bodies(a, room, ch)
    expect(['an earlier needle', 'more earlier hay'].every(t => shown.includes(t))).toBe(true)

    // Asking again for the earlier messages while it is on shows no second line.
    await a.servers.setStore(room, true, true)
    await pump(clock, async () => (await storageLines(b, room, ch)).length >= 1, 'bob has the line')
    for (const m of [a, b]) expect(await storageLines(m, room, ch)).toEqual([true])

    // Off: nothing is opened back to plain, and the job is forgotten.
    await a.servers.setStore(room, false)
    await pump(clock, () => !b.store.sealing.room(room), 'bob follows off')
    expect((await forms(b, room)).plain).toBe(0)
    await pump(
      clock,
      async () => (await b.store.meta(EARLIER_META + room)) === undefined,
      'forgotten'
    )
  }, 90_000)

  test('a job a restart stopped goes on from its marker', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const a = await makeMember(hub, 'Alice', clock)
    const room = await a.servers.create('Resumed')
    const ch = general(a, room)
    for (const body of ['one', 'two', 'three']) await a.servers.send(room, { ch, body })
    await a.servers.setStore(room, true)
    await pump(clock, () => a.store.sealing.room(room), 'sealed')
    const plainBefore = (await forms(a, room)).plain
    expect(plainBefore).toBeGreaterThan(0)
    // A marker as a stopped job leaves it, with no `earlier` on the register.
    await a.store.db.put('meta', { phase: 'events', at: -1 }, EARLIER_META + room)
    await resumeEarlier(a.store, LOCAL.search)
    await pump(clock, done(a, room), 'resumed and done')
    expect((await forms(a, room)).plain).toBe(0)
    const kept = await bodies(a, room, ch)
    expect(['one', 'two', 'three'].every(t => kept.includes(t))).toBe(true)
  }, 90_000)
})

describe('the steps of the job', () => {
  test('a search step that stops part way leaves every message findable', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const a = await makeMember(hub, 'Alice', clock)
    const room = await a.servers.create('Long')
    const ch = general(a, room)
    for (let i = 0; i < 205; i += 1) await a.servers.send(room, { ch, body: `needle ${i}` })
    await a.servers.setStore(room, true)
    await pump(clock, () => a.store.sealing.room(room), 'sealed')
    let m = markerOf(undefined)
    while (m.phase === 'events') m = await earlierStep(a.store, room, m, LOCAL.search)
    expect((await forms(a, room)).plain).toBe(0)
    m = await earlierStep(a.store, room, m, LOCAL.search)
    expect(m.phase).toBe('search')
    expect(m.at).toBeGreaterThan(-1)
    const hits = (await a.servers.search(query('needle'), null, 300)).hits
    expect(hits.length).toBe(205)
  }, 90_000)

  test('a redaction stored between reading and writing a step stays', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const a = await makeMember(hub, 'Alice', clock)
    const room = await a.servers.create('Racing')
    const ch = general(a, room)
    for (const body of ['one', 'two']) await a.servers.send(room, { ch, body })
    await a.servers.setStore(room, true)
    await pump(clock, () => a.store.sealing.room(room), 'sealed')
    const sealing = a.store.sealing
    const raw = sealing.stored
    let changed: string | null = null
    Object.defineProperty(sealing, 'stored', {
      configurable: true,
      get: () =>
        new Proxy(raw, {
          get(target, prop) {
            const value = Reflect.get(target, prop) as unknown
            if (prop !== 'getAllFromIndex' || changed !== null)
              return typeof value === 'function' ? (value as Fn).bind(target) : value
            return async (...args: unknown[]) => {
              const rows = (await (value as Fn).apply(target, args)) as EventRecord[]
              const rec = rows.find(r => r.type === 'msg')!
              changed = rec.id
              await target.put('events', { ...rec, redacted: true })
              return rows
            }
          },
        }),
    })
    try {
      await earlierStep(a.store, room, markerOf(undefined), LOCAL.search)
    } finally {
      delete (sealing as unknown as { stored?: unknown }).stored
    }
    expect(changed).not.toBeNull()
    const stored = (await a.store.sealing.stored.get('events', changed!)) as EventRecord
    expect(ArrayBuffer.isView(stored.wire)).toBe(true)
    expect(((await a.store.db.get('events', changed!)) as EventRecord).redacted).toBe(true)
  }, 90_000)
})

describe('encrypting the earlier messages of a P2P conversation', () => {
  test('either device seals what it stored before', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const a = await makeMember(hub, 'Alice', clock)
    const b = await makeMember(hub, 'Bob', clock)
    await a.node.addContact(await b.node.myCard())
    await pump(clock, () => b.node.contact(a.node.ik)?.state === 'incoming', 'request')
    await b.node.accept(a.node.ik)
    await pump(clock, () => a.node.contact(b.node.ik)?.state === 'mutual', 'mutual')
    await a.dms.open(b.node.ik)
    await b.dms.open(a.node.ik)
    const room = a.dms.roomFor(b.node.ik)
    await a.dms.send(room, { body: 'said before' })
    await pump(clock, async () => (await forms(b, room)).plain > 0, 'bob has it')
    await b.dms.setStore(room, true, true)
    for (const m of [a, b]) await pump(clock, done(m, room), 'done')
    for (const m of [a, b]) expect((await forms(m, room)).plain).toBe(0)
    await b.dms.setStore(room, true, true)
    const dmLines = async (m: Member, peer: Member) =>
      (await loadMessages(m.store.db, room, m.node.ik, peer.node.ik, { limit: 1000 })).messages
        .filter(x => x.system?.kind === 'storage')
        .map(x => (x.system as { on?: boolean }).on)
    await pump(clock, async () => (await forms(a, room)).sealed >= 3, 'alice has the second')
    expect([await dmLines(a, b), await dmLines(b, a)]).toEqual([[true], [true]])
  }, 90_000)
})
