import 'fake-indexeddb/auto'
import { afterEach, describe, expect, test } from 'bun:test'
import { Hub, ManualClock } from './p2p_net'
import { dmRoomId, loadMessages, STORE_TYPE } from '../p2p/dm'
import { CANT_TEXT } from '../p2p/flows'
import { dropSealed } from '../p2p/sealed_drop'
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
    // A sealed room is left out of the device's search index; what was indexed before stays.
    expect((await a.servers.search(query('secretword'))).hits).toEqual([])
    expect((await a.servers.search(query('plainword'))).hits.map(h => h.m.body)).toEqual([
      'before plainword',
    ])

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
    await a.dms.send(room, { body: 'plain first' })
    await pump(clock, async () => (await dmBodies(b, a)).length === 1, 'b has the first')
    expect(await a.dms.storeOf(room)).toEqual({ on: false, earlier: false })

    await b.dms.setStore(room, true)
    await pump(clock, () => a.store.sealing.room(room), 'a follows bob')
    expect(b.store.sealing.room(room)).toBe(true)
    expect(await a.dms.storeOf(room)).toEqual({ on: true, earlier: false })
    await a.dms.send(room, { body: 'sealed second' })
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
    await b.dms.send(room, { body: 'plain third' })
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
    await a.dms.send(room, { body: 'held by both' })
    await b.dms.send(room, { body: 'and this' })
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
