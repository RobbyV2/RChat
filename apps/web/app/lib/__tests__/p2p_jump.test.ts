import { afterEach, describe, expect, test } from 'bun:test'
import { Hub, makeNode, ManualClock, waitFor } from './p2p_net'
import { makeMember, stopAll, general } from './p2p_server_net'
import { Dms, dmRoomId, loadAround, loadMessages } from '../p2p/dm'
import { JUMP } from '../p2p/jump'
import type { P2pNode } from '../p2p/node'

// Jumping to a message (pins, search, reply quotes, links): the next JUMP.after messages after
// it, never the newest ones, and `newer` while more follow.

const COUNT = JUMP.after + 100
const AT = 10

const live: { node: P2pNode; dms: Dms }[] = []
afterEach(() => {
  for (const p of live.splice(0)) {
    p.dms.stop()
    p.node.stop()
  }
  stopAll()
})

const bodiesOf = (rows: { body?: string; system?: unknown; call?: unknown }[]) =>
  rows.filter(r => !r.system && !r.call).map(r => r.body)

const expected = (from: number, to: number) =>
  Array.from({ length: to - from }, (_, i) => `m${from + i}`)

describe('jumping to a message', () => {
  test('in a conversation: the next messages after it, then the rest on request', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const make = async (name: string) => {
      const n = await makeNode(hub, name, { clock })
      const dms = new Dms({ node: n.node, store: n.store, clock })
      live.push({ node: n.node, dms })
      await n.node.start()
      return { ...n, dms }
    }
    const a = await make('Alice')
    const b = await make('Bob')
    await a.node.addContact(await b.node.myCard())
    await waitFor(() => b.node.contact(a.node.ik)?.state === 'incoming', 'request')
    await b.node.accept(a.node.ik)
    await a.dms.open(b.node.ik)
    const room = dmRoomId(a.node.ik, b.node.ik)
    await b.node.setPaused(true)
    const ids: string[] = []
    for (let i = 0; i < COUNT; i += 1) {
      clock.t += 1
      ids.push((await a.dms.send(room, { body: `m${i}` })) as string)
    }
    const got = await loadAround(a.store.db, room, a.node.ik, b.node.ik, ids[AT])
    expect(got).not.toBeNull()
    expect(bodiesOf(got!.messages)).toEqual(expected(0, AT + 1 + JUMP.after))
    expect(got!.more).toBe(false)
    expect(got!.newer).toBe(true)
    const last = got!.messages.at(-1)!
    const rest = await loadMessages(a.store.db, room, a.node.ik, b.node.ik, {
      after: last.sortKey,
      limit: JUMP.after,
      newer: true,
    })
    expect(bodiesOf(rest.messages)).toEqual(expected(AT + 1 + JUMP.after, COUNT))
    expect(rest.more).toBe(false)
    // The window reloads in place, from its first message.
    const again = await loadMessages(a.store.db, room, a.node.ik, b.node.ik, {
      from: got!.messages[0].sortKey,
      limit: 30,
      newer: true,
    })
    expect(bodiesOf(again.messages)).toEqual(expected(0, 30))
    expect(again.more).toBe(true)
    // Near the end: nothing missing, no gap.
    const end = await loadAround(a.store.db, room, a.node.ik, b.node.ik, ids[COUNT - 5])
    expect(end!.newer).toBe(false)
    expect(bodiesOf(end!.messages)).toEqual(expected(COUNT - 5 - JUMP.before, COUNT))
    expect(end!.more).toBe(true)
  }, 120_000)

  test('in a channel: the same', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const a = await makeMember(hub, 'Alice', clock)
    const room = await a.servers.create('Book club')
    const ch = general(a, room)
    const ids: string[] = []
    for (let i = 0; i < COUNT; i += 1) {
      clock.t += 1
      ids.push((await a.servers.send(room, { ch, body: `m${i}` })) as string)
    }
    const got = await a.servers.loadAround(room, ch, ids[AT])
    expect(got).not.toBeNull()
    expect(bodiesOf(got!.messages)).toEqual(expected(0, AT + 1 + JUMP.after))
    expect(got!.newer).toBe(true)
    const rest = await a.servers.loadChannel(room, ch, {
      after: got!.messages.at(-1)!.sortKey,
      limit: JUMP.after,
      newer: true,
    })
    expect(bodiesOf(rest.messages)).toEqual(expected(AT + 1 + JUMP.after, COUNT))
    expect(rest.more).toBe(false)
    const end = await a.servers.loadAround(room, ch, ids[COUNT - 1])
    expect(end!.newer).toBe(false)
  }, 180_000)
})
