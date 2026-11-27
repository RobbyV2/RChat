import { expect, test } from 'bun:test'
import { Sync, type SyncDeps } from '../p2p/sync'
import type { Session } from '../p2p/session'
import { ManualClock } from './p2p_net'

// A ready session that sends into nothing.
const session = (ik: string) =>
  ({
    remote: { ik },
    state: 'ready',
    onClose: () => {},
    on: () => {},
    send: async () => {},
  }) as unknown as Session

const sync = (onState: (room: string) => void) =>
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
  } as unknown as SyncDeps)

test('a link that opens says the room changed, as one that closes does', () => {
  const seen: [string, boolean][] = []
  const s: Sync = sync(room => seen.push([room, s.online(room)]))
  const peer = session('peer')
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
