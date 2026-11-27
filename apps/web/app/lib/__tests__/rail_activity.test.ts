import { expect, test } from 'bun:test'
import { railActivity } from '../client/rail_activity'
import { testAccount } from './test_account'
import { createPeerFixture } from './peer_fixture'
import type { Contact } from '../p2p/contacts'
import type { RoomSummary } from '../p2p/app/store'

const contact: Contact = {
  ik: 'sam',
  name: 'Sam',
  petname: null,
  profile: null,
  certs: [],
  revocations: [],
  state: 'mutual',
  ignored: false,
  intros: [],
  verified: false,
  verifiedAt: null,
  warning: null,
  notice: null,
  host: 'elsewhere',
  added: 0,
  lastSeen: null,
}
const room: RoomSummary = {
  id: 'same-room',
  peer: 'sam',
  seq: 10,
  unread: 1,
  pings: 4,
  lastTs: 1,
  count: 1,
  bytes: 12,
  full: false,
  fullWhy: undefined,
  peerFull: false,
  gap: false,
}

test('same-named rooms contribute once per owner and identity, while an instance DM is counted once per account', () => {
  const a = testAccount('alex', 'https://rail-alpha.test')
  const b = testAccount('alex', 'https://rail-beta.test')
  const alpha = createPeerFixture(a, 'alex')
  const beta = createPeerFixture(b, 'alex')
  const source = railActivity([a, b])
  const off = source.subscribe(() => {})
  try {
    const work = a.identities.add('work')
    for (const app of [alpha, work, beta])
      app.useP2p.setState({
        account: 'alex',
        enabled: true,
        contacts: [contact],
        rooms: { [room.id]: room },
      })
    a.store.setState({
      pings: { d10: { scope: 'd10', server: null, bulk: 2, bulkUntil: 20, ids: [] } },
    })
    expect(source.snapshot().map(s => [s.pings, s.unread, s.peers.length])).toEqual([
      [10, true, 2],
      [4, true, 1],
    ])
    work.useP2p.setState({ contacts: [] })
    expect(source.snapshot().map(s => s.pings)).toEqual([6, 4])
    b.store.setState(s => ({ settings: { ...s.settings, p2p: false } }))
    expect(source.snapshot().map(s => s.pings)).toEqual([6, 0])
  } finally {
    off()
  }
})
