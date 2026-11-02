import { afterEach, describe, expect, test } from 'bun:test'
import { Hub, ManualClock, waitFor } from './p2p_net'
import { eventually, general, joinWithCode, makeMember, pump, stopAll } from './p2p_server_net'
import type { Member } from './p2p_server_net'
import type { EventRecord } from '../p2p/db'
import { dmRoomId } from '../p2p/dm'
import { PING_LOG, type PingRec } from '../p2p/inbox'
import { PING_BATCH_MS, PingLog, pingAlive, pingOf, pingText } from '../p2p/ping_log'

afterEach(stopAll)

const later = (ms: number) => new Promise(r => setTimeout(r, ms))

const friends = async (a: Member, b: Member) => {
  await a.node.addContact(await b.node.myCard())
  await waitFor(() => b.node.contact(a.node.ik)?.state === 'incoming', 'request')
  await b.node.accept(a.node.ik)
  const room = dmRoomId(a.node.ik, b.node.ik)
  await waitFor(() => a.dms.online(room) && b.dms.online(room), 'sync links')
  await a.dms.open(b.node.ik)
  await b.dms.open(a.node.ik)
  return room
}

const logOf = (m: Member, clock: ManualClock) => {
  let writes = 0
  const log = new PingLog({
    store: m.store,
    dms: m.dms,
    servers: m.servers,
    now: () => clock.now(),
    onWrite: () => (writes += 1),
  })
  return { log, writes: () => writes }
}

const stored = async (m: Member) => (await m.store.meta<{ list: PingRec[] }>(PING_LOG))?.list ?? []

describe('the P2P ping log against real conversations', () => {
  test('pings are noted in one batch, at their arrival time, and marked with their counter', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const a = await makeMember(hub, 'Alice', clock)
    const b = await makeMember(hub, 'Bob', clock)
    const room = await friends(a, b)
    const arrived: EventRecord[] = []
    b.dms.onArrive(x => x.ping && arrived.push(x.rec))
    for (const body of ['hey @Bob', 'and @Bob again', 'one more @Bob'])
      await a.dms.send(room, { body })
    await eventually(async () => (await b.store.room(room))?.pings === 3, 'pinged')
    await eventually(() => arrived.length === 3, 'arrivals')

    // Noted together, written once after the batch delay.
    const { log, writes } = logOf(b, clock)
    for (const rec of arrived) log.note(room, null, 'mention', rec)
    expect(await stored(b)).toEqual([])
    await later(PING_BATCH_MS * 3)
    expect(writes()).toBe(1)
    const list = await stored(b)
    expect(list.map(p => p.id).sort()).toEqual(arrived.map(r => r.id).sort())
    for (const p of list) {
      const rec = arrived.find(r => r.id === p.id)!
      expect([p.at, p.seq, p.actor, p.seen]).toEqual([rec.receivedAt, rec.seq, a.node.ik, false])
    }

    // Marking one: its row is seen and its counter goes down; the read position stays.
    const before = (await b.store.room(room))!
    expect(await log.mark([arrived[0].id])).toBe(1)
    const after = (await b.store.room(room))!
    expect([after.pings, after.unread, after.readSeq]).toEqual([2, before.unread, before.readSeq])
    expect((await log.read()).list.find(p => p.id === arrived[0].id)?.seen).toBe(true)
    // Marked already: nothing more comes off.
    expect(await log.mark([arrived[0].id])).toBe(0)
    expect((await b.store.room(room))!.pings).toBe(2)

    // A failed write cuts no counter.
    const realTx = b.store.db.transaction.bind(b.store.db)
    b.store.db.transaction = ((...args: Parameters<typeof realTx>) => {
      if (args[0] === 'meta') throw new Error('refused')
      return realTx(...args)
    }) as typeof realTx
    expect(await log.mark([arrived[1].id])).toBe(0)
    b.store.db.transaction = realTx
    expect((await b.store.room(room))!.pings).toBe(2)
    expect((await log.read()).list.find(p => p.id === arrived[1].id)?.seen).toBe(false)

    // Reading the conversation reads its rows: marking them then cuts nothing.
    await b.dms.markRead(room)
    const { readSeq } = await log.read()
    expect(readSeq.get(room)).toBe((await b.store.room(room))!.lastSeq)
    expect(await log.mark([arrived[1].id, arrived[2].id])).toBe(0)
  })

  test('a reading tab sees the pings noted so far, and the sender clock never sets the time', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const a = await makeMember(hub, 'Alice', clock)
    const b = await makeMember(hub, 'Bob', clock)
    const room = await friends(a, b)
    const arrived: EventRecord[] = []
    b.dms.onArrive(x => x.ping && arrived.push(x.rec))
    await a.dms.send(room, { body: 'hi @Bob' })
    await eventually(() => arrived.length === 1, 'arrival')
    const { log } = logOf(b, clock)
    // Sent while we were offline: an hour old by the sender's clock, arriving now.
    const late = { ...arrived[0], effTs: arrived[0].receivedAt - 3_600_000 }
    expect(pingOf(room, null, 'mention', late).at).toBe(arrived[0].receivedAt)
    log.note(room, null, 'mention', late)
    // Read right away (before the batch delay): the noted ping is there.
    const { list } = await log.read()
    expect(list.map(p => [p.id, p.at])).toEqual([[late.id, late.receivedAt]])
    expect(await pingAlive(b.store, list[0])).toBe(true)
    expect((await pingText(b.store, list[0]))?.content).toBe('hi @Bob')
    // Deleted by its author: the list can no longer show it.
    await a.dms.redact(room, late.id)
    await eventually(async () => !(await pingAlive(b.store, list[0])), 'deleted here')
    expect(await pingText(b.store, list[0])).toBe(null)
  })

  test('server channel pings come off the channel counter', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const a = await makeMember(hub, 'Alice', clock)
    const b = await makeMember(hub, 'Bob', clock)
    const room = await a.servers.create('Pings')
    const ch = general(a, room)
    await joinWithCode(clock, a, room, b)
    const { log } = logOf(b, clock)
    b.servers.onArrive(x => x.ping && log.note(x.room, x.ch, x.ping, x.rec))
    await a.servers.send(room, { ch, body: 'hey @Bob' })
    await a.servers.send(room, { ch, body: 'again @Bob' })
    await pump(clock, () => b.servers.view(room)?.chans[ch]?.pings === 2, 'b pinged')
    const { list } = await log.read()
    expect(list.map(p => [p.room, p.ch, p.kind])).toEqual([
      [room, ch, 'mention'],
      [room, ch, 'mention'],
    ])
    const readSeq = b.servers.view(room)!.chans[ch].readSeq
    expect(await log.mark([list[0].id])).toBe(1)
    const c = b.servers.view(room)!.chans[ch]
    expect([c.pings, c.readSeq]).toEqual([1, readSeq])
    expect(b.servers.view(room)!.seq).toBe((await b.store.room(room))!.lastSeq)
  })
})
