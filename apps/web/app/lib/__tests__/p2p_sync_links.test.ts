import { expect, test } from 'bun:test'
import { Sync, type SyncDeps } from '../p2p/sync'
import { P2pStore, removeP2pDb } from '../p2p/db'
import type { Message } from '../p2p/frames'
import type { Session } from '../p2p/session'
import { ManualClock } from './p2p_net'
import { b64u } from '../p2p/canonical'

// Event ids as the wire carries them.
const E1 = b64u(new Uint8Array(32).fill(1))
const E2 = b64u(new Uint8Array(32).fill(2))
const X = b64u(new Uint8Array(32).fill(3))

// A ready session that sends into nothing; what the sync listens for lands in `handlers`.
const session = (ik: string) => {
  const handlers = new Map<string, (m: Message) => void>()
  const s = {
    remote: { ik },
    state: 'ready',
    onClose: () => {},
    on: (t: string, fn: (m: Message) => void) => void handlers.set(t, fn),
    send: async () => {},
  } as unknown as Session
  return { s, handlers }
}

const sync = (onState: (room: string) => void, more: Partial<SyncDeps> = {}) =>
  new Sync({
    store: { room: async () => undefined },
    clock: new ManualClock(),
    me: () => 'me',
    devices: () => null,
    contact: () => undefined,
    onStored: () => {},
    onDelivered: () => {},
    onTyping: () => {},
    onState,
    dag: () => ({}),
    ...more,
  } as unknown as SyncDeps)

test('a link that opens says the room changed, as one that closes does', () => {
  const seen: [string, boolean][] = []
  const s: Sync = sync(room => seen.push([room, s.online(room)]))
  const { s: peer } = session('peer')
  s.link(peer, 'room')
  expect(seen).toEqual([['room', true]])
  expect(s.link(peer, 'room') === s.linkOf(peer, 'room')).toBe(true)
  expect(seen).toHaveLength(1)
  s.unlink(peer, 'room')
  expect(seen).toEqual([
    ['room', true],
    ['room', false],
  ])
})

// Our events `ids` (and `X`, never pushed) in the outbox of room `r`, the first ones pushed on a
// link to `peer` that the test then acts on.
const pushed = async (allowed: () => boolean, ids: string[]) => {
  const name = `sync-links-${Math.random()}`
  const store = await P2pStore.create(name)
  for (const id of [...ids, X])
    await store.db.put('outbox', { id, room: 'r', created: 1, deliveredTo: [] })
  const s = sync(() => {}, { store, allowed: () => allowed() })
  const peer = session('peer')
  s.attach(peer.s)
  s.link(peer.s, 'r')
  for (const id of ids) s.push('r', id, { id } as never)
  const ack = async (ids: string[]) => {
    peer.handlers.get('ack')!({ t: 'ack', room: 'r', ids })
    for (let i = 0; i < 20; i += 1) await new Promise(r => setTimeout(r, 0))
  }
  const to = async (id: string) => (await store.db.get('outbox', id))?.deliveredTo ?? []
  const done = async () => {
    store.close()
    await removeP2pDb(name)
  }
  return { s, peer, ack, to, done }
}

test('an ack after the link closed counts for what was pushed on it, and nothing else', async () => {
  const t = await pushed(() => true, [E1, E2])
  t.s.unlink(t.peer.s, 'r')
  await t.ack([E1, X])
  expect([await t.to(E1), await t.to(X), await t.to(E2)]).toEqual([['peer'], [], []])
  await t.ack([E2])
  expect(await t.to(E2)).toEqual(['peer'])
  await t.done()
})

test('a new link drops what a closed one waited for', async () => {
  const t = await pushed(() => true, [E1])
  t.s.unlink(t.peer.s, 'r')
  t.s.link(t.peer.s, 'r')
  t.s.unlink(t.peer.s, 'r')
  await t.ack([E1])
  expect(await t.to(E1)).toEqual([])
  await t.done()
})

test('an ack on an open link counts for our pushes when the peer may not talk about the room', async () => {
  let allowed = true
  const t = await pushed(() => allowed, [E1])
  allowed = false
  await t.ack([E1])
  expect(await t.to(E1)).toEqual(['peer'])
  await t.done()
})
