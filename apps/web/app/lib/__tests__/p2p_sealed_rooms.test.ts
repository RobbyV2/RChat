import 'fake-indexeddb/auto'
import { afterEach, describe, expect, test } from 'bun:test'
import { Hub, ManualClock } from './p2p_net'
import { dmRoomId, loadMessages, STORE_TYPE } from '../p2p/dm'
import { CANT_TEXT } from '../p2p/flows'
import type { EventRecord } from '../p2p/db'
import { PING_LOG } from '../p2p/inbox'
import { PING_STORE, PingLog } from '../p2p/ping_log'
import { vaultOf } from '../p2p/sealed_db'
import { dropSealed } from '../p2p/sealed_drop'
import { deviceKeys } from '../platform'
import { deviceAad, openDevice, recordHeader } from '../seal_record'
import { DEVICE_KEYS_META } from '../platform/device_keys'
import {
  bodies,
  general,
  joinWithCode,
  makeMember,
  pump,
  restart,
  stopAll,
  stopMember,
  type Member,
} from './p2p_server_net'

afterEach(stopAll)

const failure = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e: Error) => e.message
  )

// The stored form of every event of `room` on `m`'s device: 'sealed' or 'plain', by event type.
const forms = async (m: Member, room: string) => {
  const raw = m.store.sealing.stored
  const rows = (await raw.getAll('events')) as { room: string; type: string; wire: unknown }[]
  return rows
    .filter(r => r.room === room)
    .map(r => `${r.type}:${ArrayBuffer.isView(r.wire) ? 'sealed' : 'plain'}`)
}

const count = (list: string[], what: string) => list.filter(x => x === what).length

const query = (q: string) => ({
  q,
  from: null,
  room: null,
  ch: null,
  hasFile: false,
  beforeTs: null,
  afterTs: null,
})

const befriend = async (clock: ManualClock, a: Member, b: Member) => {
  await a.node.addContact(await b.node.myCard())
  await pump(clock, () => b.node.contact(a.node.ik)?.state === 'incoming', 'request')
  await b.node.accept(a.node.ik)
  await pump(clock, () => a.node.contact(b.node.ik)?.state === 'mutual', 'mutual')
  await a.dms.open(b.node.ik)
  await b.dms.open(a.node.ik)
  return dmRoomId(a.node.ik, b.node.ik)
}

// The storage lines a member sees in a channel or a conversation: who switched it, and to what.
const lines = (rows: { system?: { kind: string; ik: string; on?: boolean } | null }[]) =>
  rows.filter(x => x.system?.kind === 'storage').map(x => [x.system?.ik, x.system?.on])

const dmLines = async (m: Member, peer: Member) =>
  lines(
    (
      await loadMessages(m.store.db, m.dms.roomFor(peer.node.ik), m.node.ik, peer.node.ik, {
        limit: 1000,
      })
    ).messages
  )

const dmBodies = async (m: Member, peer: Member) =>
  (
    await loadMessages(m.store.db, m.dms.roomFor(peer.node.ik), m.node.ik, peer.node.ik, {
      limit: 1000,
    })
  ).messages
    .filter(x => !x.system)
    .map(x => x.body)

describe('encrypted storage of a P2P server', () => {
  test('the switch seals what every member stores from then on, and only its managers turn it', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const a = await makeMember(hub, 'Alice', clock)
    const b = await makeMember(hub, 'Bob', clock)
    const room = await a.servers.create('Vault')
    const ch = general(a, room)
    await joinWithCode(clock, a, room, b)
    await a.servers.send(room, { ch, body: 'before plainword' })
    await pump(clock, async () => (await bodies(b, room, ch)).length === 1, 'b has the first')
    expect(await failure(b.servers.setStore(room, true))).toBe(CANT_TEXT)
    expect(a.servers.sumOf(room).store).toBeNull()

    await a.servers.setStore(room, true)
    await pump(clock, () => b.servers.sumOf(room).store?.on === true, 'b admits the switch')
    await pump(
      clock,
      () => a.store.sealing.room(room) && b.store.sealing.room(room),
      'both devices follow it'
    )
    await a.servers.send(room, { ch, body: 'sealed secretword' })
    await pump(clock, async () => (await bodies(b, room, ch)).length === 2, 'b has the second')
    await b.servers.send(room, { ch, body: 'a sealed answer' })
    await pump(clock, async () => (await bodies(a, room, ch)).length === 3, 'a has the third')
    for (const m of [a, b]) {
      expect(await bodies(m, room, ch)).toEqual([
        'before plainword',
        'sealed secretword',
        'a sealed answer',
      ])
      const stored = await forms(m, room)
      expect(count(stored, 'msg:sealed')).toBe(2)
      expect(count(stored, 'msg:plain')).toBe(1)
    }
    // A sealed room's search rows are keyed: search finds both kinds, and no row holds a word.
    for (const m of [a, b]) {
      expect((await m.servers.search(query('secretword'))).hits.map(h => h.m.body)).toEqual([
        'sealed secretword',
      ])
      expect((await m.servers.search(query('secr'))).hits.map(h => h.m.body)).toEqual([
        'sealed secretword',
      ])
      expect((await m.servers.search(query('plainword'))).hits.map(h => h.m.body)).toEqual([
        'before plainword',
      ])
      const rows = (await m.store.sealing.stored.getAllKeys('search')) as unknown as string[][]
      const words = rows.filter(k => k[0] === room).map(k => k[1])
      expect(words).toContain('plainword')
      expect(words.some(w => w.includes('secret') || w.includes('answer'))).toBe(false)
      expect(words.filter(w => w.startsWith('#')).length).toBeGreaterThan(0)
    }

    await a.servers.setStore(room, false)
    await pump(clock, () => !b.store.sealing.room(room), 'b follows it off')
    await b.servers.send(room, { ch, body: 'plain again' })
    await pump(clock, async () => (await bodies(a, room, ch)).length === 4, 'a has the fourth')
    for (const m of [a, b]) {
      const stored = await forms(m, room)
      expect(count(stored, 'msg:sealed')).toBe(2)
      expect(count(stored, 'msg:plain')).toBe(2)
      expect((await bodies(m, room, ch))[1]).toBe('sealed secretword')
      // The system channel says who switched it, as on a hosted server.
      const shown = await m.servers.loadChannel(room, ch, { limit: 10_000 })
      expect(lines(shown.messages)).toEqual([
        [a.node.ik, true],
        [a.node.ik, false],
      ])
    }
  })

  test('keyed local search finds what plain search finds', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const a = await makeMember(hub, 'Alice', clock)
    const sealed = await a.servers.create('Sealed')
    const plain = await a.servers.create('Plain')
    await a.servers.setStore(sealed, true)
    await pump(clock, () => a.store.sealing.room(sealed), 'sealed')
    const vocabulary = [
      'needle',
      'needles',
      'Needlework',
      'hay',
      'haystack',
      'ab',
      'abc',
      'zoë',
      'Zoe',
      'naïve',
      '日本語',
      'ПРИВЕТ',
      'x',
      '42',
      'stack-overflow',
      'e-mail',
    ]
    let seed = 7
    const next = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31
      return seed % n
    }
    const texts: string[] = []
    for (let i = 0; i < 30; i++) {
      const n = 1 + next(6)
      texts.push(Array.from({ length: n }, () => vocabulary[next(vocabulary.length)]).join(' '))
    }
    for (const body of texts)
      for (const room of [plain, sealed]) await a.servers.send(room, { ch: general(a, room), body })
    await pump(
      clock,
      async () => (await bodies(a, sealed, general(a, sealed))).length === texts.length,
      'all sent'
    )
    const queries = [
      ...vocabulary,
      'ne',
      'nee',
      'NEEDLEW',
      'hay needle',
      'st',
      'sta',
      'zo',
      'zoë',
      'naive',
      '日本',
      'при',
      'e-mail',
      'mail',
      'absent',
    ]
    let found = 0
    for (const q of queries) {
      const hits = (await a.servers.search(query(q), null, 1000)).hits
      const of = (room: string) => hits.filter(h => h.room === room).map(h => h.m.body)
      expect([q, of(sealed)]).toEqual([q, of(plain)])
      found += of(plain).length
    }
    expect(found).toBeGreaterThan(50)
    const rows = (await a.store.sealing.stored.getAllKeys('search')) as unknown as string[][]
    expect(rows.filter(k => k[0] === sealed).every(k => k[1].startsWith('#'))).toBe(true)
    expect(rows.filter(k => k[0] === plain).some(k => k[1] === 'needle')).toBe(true)
  })

  test('a device restarts on its sealed room and reads it', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const a = await makeMember(hub, 'Alice', clock)
    const room = await a.servers.create('Kept')
    const ch = general(a, room)
    await a.servers.setStore(room, true)
    await pump(clock, () => a.store.sealing.room(room), 'sealed')
    await a.servers.send(room, { ch, body: 'kept over a restart' })
    stopMember(a)
    const again = await restart(hub, a, clock)
    await pump(clock, () => again.servers.view(room) !== null, 'the room loads')
    expect(again.store.sealing.room(room)).toBe(true)
    expect(await bodies(again, room, ch)).toEqual(['kept over a restart'])
    expect(again.servers.sumOf(room).store as unknown).toEqual({ on: true })
  })

  test('a site that requires it seals only the stores of its own devices', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const a = await makeMember(hub, 'Alice', clock)
    const b = await makeMember(hub, 'Bob', clock)
    await a.store.sealing.setAll(true)
    const room = await a.servers.create('Mixed')
    const ch = general(a, room)
    await joinWithCode(clock, a, room, b)
    await a.servers.send(room, { ch, body: 'one room, two sites' })
    await pump(clock, async () => (await bodies(b, room, ch)).length === 1, 'b has it')
    expect(a.store.sealing.on(room) && !a.store.sealing.room(room)).toBe(true)
    expect((await forms(a, room)).every(f => f.endsWith(':sealed'))).toBe(true)
    expect((await forms(b, room)).every(f => f.endsWith(':plain'))).toBe(true)
    expect(await bodies(a, room, ch)).toEqual(['one room, two sites'])
    expect(a.servers.sumOf(room).store).toBeNull()
  })
})

describe('a lost device key in a P2P server', () => {
  test('the member drops the sealed room and takes it from the others again', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const a = await makeMember(hub, 'Alice', clock)
    const b = await makeMember(hub, 'Bob', clock)
    const room = await a.servers.create('Vault')
    const ch = general(a, room)
    await joinWithCode(clock, a, room, b)
    await a.servers.setStore(room, true)
    await pump(clock, () => b.store.sealing.room(room), 'b follows')
    await a.servers.send(room, { ch, body: 'sealed one' })
    await b.servers.send(room, { ch, body: 'sealed two' })
    await pump(clock, async () => (await bodies(a, room, ch)).length === 2, 'a has both')
    await pump(clock, async () => (await bodies(b, room, ch)).length === 2, 'b has both')
    stopMember(b)
    await b.store.sealing.stored.delete('meta', DEVICE_KEYS_META)
    b.store.close()
    const { P2pStore } = await import('../p2p/db')
    const opened = await P2pStore.create(b.db)
    expect(await opened.sealing.lost()).toBe(true)
    expect(await dropSealed(opened.db)).toEqual([room])
    opened.close()

    const again = await makeMember(hub, 'Bob', clock, { db: b.db })
    await pump(
      clock,
      async () => (await bodies(again, room, ch)).length === 2,
      'bob has the room again'
    )
    expect((await bodies(again, room, ch)).sort()).toEqual(['sealed one', 'sealed two'])
    expect(again.servers.myMembership(room)).toBe('join')
    await pump(clock, () => again.store.sealing.room(room), 'and seals it again')
    await again.servers.send(room, { ch, body: 'after the loss' })
    await pump(clock, async () => (await bodies(a, room, ch)).length === 3, 'a has the new one')
  }, 40_000)
})

describe('encrypted storage of a P2P conversation', () => {
  test('either participant switches it, and both devices follow', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const a = await makeMember(hub, 'Alice', clock)
    const b = await makeMember(hub, 'Bob', clock)
    const room = await befriend(clock, a, b)
    await a.dms.send(await a.dms.room(room), { body: 'plain first' })
    await pump(clock, async () => (await dmBodies(b, a)).length === 1, 'b has the first')
    expect(await a.dms.storeOf(room)).toEqual({ on: false, earlier: false })

    await b.dms.setStore(room, true)
    await pump(clock, () => a.store.sealing.room(room), 'a follows bob')
    expect(b.store.sealing.room(room)).toBe(true)
    expect(await a.dms.storeOf(room)).toEqual({ on: true, earlier: false })
    await a.dms.send(await a.dms.room(room), { body: 'sealed second' })
    await pump(clock, async () => (await dmBodies(b, a)).length === 2, 'b has the second')
    for (const m of [a, b]) {
      const stored = await forms(m, room)
      expect(count(stored, 'msg:sealed')).toBe(1)
      expect(count(stored, 'msg:plain')).toBe(1)
      expect(count(stored, `${STORE_TYPE}:sealed`) + count(stored, `${STORE_TYPE}:plain`)).toBe(1)
    }
    expect(await dmBodies(a, b)).toEqual(['plain first', 'sealed second'])
    expect(await dmBodies(b, a)).toEqual(['plain first', 'sealed second'])

    await a.dms.setStore(room, false)
    await pump(clock, () => !b.store.sealing.room(room), 'b follows alice')
    expect(await b.dms.storeOf(room)).toEqual({ on: false, earlier: false })
    await b.dms.send(await b.dms.room(room), { body: 'plain third' })
    await pump(clock, async () => (await dmBodies(a, b)).length === 3, 'a has the third')
    expect(count(await forms(a, room), 'msg:plain')).toBe(2)
    expect(await dmBodies(a, b)).toEqual(['plain first', 'sealed second', 'plain third'])
    for (const [m, peer] of [
      [a, b],
      [b, a],
    ])
      expect(await dmLines(m, peer)).toEqual([
        [b.node.ik, true],
        [a.node.ik, false],
      ])
  })

  test('a device that lost its key drops what it sealed and takes it from its peer again', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const a = await makeMember(hub, 'Alice', clock)
    const b = await makeMember(hub, 'Bob', clock)
    const room = await befriend(clock, a, b)
    await a.dms.setStore(room, true)
    await pump(clock, () => b.store.sealing.room(room), 'b follows')
    await a.dms.send(await a.dms.room(room), { body: 'held by both' })
    await b.dms.send(await b.dms.room(room), { body: 'and this' })
    await pump(clock, async () => (await dmBodies(a, b)).length === 2, 'a has both')
    await pump(clock, async () => (await dmBodies(b, a)).length === 2, 'b has both')
    expect(await b.store.sealing.lost()).toBe(false)
    stopMember(b)
    await b.store.sealing.stored.delete('meta', DEVICE_KEYS_META)
    b.store.close()

    const { P2pStore } = await import('../p2p/db')
    const opened = await P2pStore.create(b.db)
    expect(await opened.sealing.lost()).toBe(true)
    expect(await dropSealed(opened.db)).toEqual([room])
    expect(await opened.sealing.lost()).toBe(false)
    expect(await forms({ store: opened } as Member, room)).toEqual([])
    opened.close()

    const again = await makeMember(hub, 'Bob', clock, { db: b.db })
    await again.dms.open(a.node.ik)
    await pump(clock, async () => (await dmBodies(again, a)).length === 2, 'bob has them again')
    expect(await dmBodies(again, a)).toEqual(await dmBodies(a, b))
    expect((await dmBodies(again, a)).sort()).toEqual(['and this', 'held by both'])
    await pump(clock, () => again.store.sealing.room(room), 'and seals the conversation again')
  })
})

describe('the inbox of an encrypted P2P conversation', () => {
  test('its rows keep what pinged sealed, and rows from before stay as they were', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const a = await makeMember(hub, 'Alice', clock)
    const b = await makeMember(hub, 'Bob', clock)
    const room = await befriend(clock, a, b)
    const arrived: EventRecord[] = []
    b.dms.onArrive(x => {
      if (x.ping) arrived.push(x.rec)
    })
    const log = new PingLog({
      store: b.store,
      dms: b.dms,
      servers: b.servers,
      now: () => clock.now(),
    })
    const stored = async () =>
      ((await b.store.sealing.stored.get('meta', PING_LOG)) as { list: Record<string, unknown>[] })
        .list
    const shape = (row: Record<string, unknown> | undefined) =>
      row && [ArrayBuffer.isView(row.box), row.kind ?? null, row.emoji ?? null]

    await a.dms.send(await a.dms.room(room), { body: 'plain @Bob' })
    await pump(clock, () => arrived.length === 1, 'the plain ping')
    log.note(room, null, 'mention', arrived[0])
    expect(await log.flush()).toBe(true)
    await b.dms.setStore(room, true)
    await pump(clock, () => a.store.sealing.room(room), 'alice follows')
    await a.dms.send(await a.dms.room(room), { body: 'sealed @Bob' })
    await pump(clock, () => arrived.length === 2, 'the sealed ping')
    log.note(room, null, 'mention', arrived[1])
    const mine = await b.dms.send(await b.dms.room(room), { body: 'react to this' })
    await pump(clock, async () => (await dmBodies(a, b)).length === 3, 'alice has it')
    await a.dms.react(await a.dms.room(room), mine, '🦊', true)
    await pump(clock, () => arrived.length === 3, 'the reaction')
    log.note(room, null, 'reaction', arrived[2])
    expect(await log.flush()).toBe(true)

    const byId = async (id: string) => (await stored()).find(r => r.id === id)
    expect(shape(await byId(arrived[0].id))).toEqual([false, 'mention', null])
    expect(shape(await byId(arrived[1].id))).toEqual([true, null, null])
    expect(shape(await byId(arrived[2].id))).toEqual([true, null, null])
    expect(JSON.stringify(await stored())).not.toContain('🦊')
    const boxed = (await byId(arrived[2].id))!
    expect(boxed).toMatchObject({ room, actor: a.node.ik, target: mine, seen: false })
    const box = boxed.box as Uint8Array
    expect(recordHeader(box)?.version).toBe(2)
    const { key } = await deviceKeys(vaultOf(b.store.sealing.stored)).current()
    const opened = await openDevice(key, deviceAad(PING_STORE, boxed.id as string, room), box)
    expect(JSON.parse(new TextDecoder().decode(opened!))).toEqual({ kind: 'reaction', emoji: '🦊' })
    expect(await openDevice(key, deviceAad(PING_STORE, arrived[1].id, room), box)).toBeNull()

    // The inbox reads every row whole, and marking a sealed one keeps it sealed.
    const read = (await log.read()).list
    expect(read.map(p => [p.id, p.kind, p.emoji]).sort()).toEqual(
      [
        [arrived[0].id, 'mention', null],
        [arrived[1].id, 'mention', null],
        [arrived[2].id, 'reaction', '🦊'],
      ].sort()
    )
    expect(await log.mark([arrived[1].id])).toBe(1)
    expect(shape(await byId(arrived[1].id))).toEqual([true, null, null])
    expect((await byId(arrived[1].id))?.seen).toBe(true)

    // Turned off: new rows are plain, sealed ones stay sealed.
    await b.dms.setStore(room, false)
    await pump(clock, () => !a.store.sealing.room(room), 'alice follows again')
    await a.dms.send(await a.dms.room(room), { body: 'plain again @Bob' })
    await pump(clock, () => arrived.length === 4, 'the last ping')
    log.note(room, null, 'mention', arrived[3])
    expect(await log.flush()).toBe(true)
    expect(shape(await byId(arrived[3].id))).toEqual([false, 'mention', null])
    expect(shape(await byId(arrived[2].id))).toEqual([true, null, null])

    // Without its device key the device keeps no sealed row.
    stopMember(b)
    await b.store.sealing.stored.delete('meta', DEVICE_KEYS_META)
    b.store.close()
    const { P2pStore } = await import('../p2p/db')
    const again = await P2pStore.create(b.db)
    expect(await dropSealed(again.db)).toEqual([room])
    const left = ((await again.meta<{ list: { id: string }[] }>(PING_LOG))?.list ?? []).map(
      p => p.id
    )
    expect(left.sort()).toEqual([arrived[0].id, arrived[3].id].sort())
    again.close()
  })
})
