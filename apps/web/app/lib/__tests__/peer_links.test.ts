import { expect, test } from 'bun:test'
import { createPeerFixture } from './peer_fixture'
import { testAccount } from './test_account'
import { peerCode, peerLinkRequest, selectPeerActor } from '../client/peer_links'

test('private codes retain exact case and must be standalone', () => {
  expect(peerCode(' rci1.AbC-_9 ')).toEqual({ kind: 'invite', code: 'rci1.AbC-_9' })
  expect(peerCode('rcp1.ZA')).toEqual({ kind: 'contact', code: 'rcp1.ZA' })
  for (const text of ['sample rci1.AbC', '||rcp1.ABC||', 'https://other.test/rcp1.ABC', 'rcp1.'])
    expect(peerCode(text)).toBeNull()
})

test('use the initiating identity or the only eligible identity and never a stale replacement', () => {
  const main = {},
    work = {},
    replacement = {}
  expect(selectPeerActor([main, work], work)).toBe(work)
  expect(selectPeerActor([main, work], null)).toBeNull()
  expect(selectPeerActor([work], null)).toBe(work)
  expect(selectPeerActor([replacement], work)).toBeNull()
  expect(selectPeerActor([], null)).toBeNull()
})

test('prefer the actor account’s sole identity, then offer eligible live identities by exact runtime', () => {
  const a = testAccount('sam', 'https://codes-a.test')
  const b = testAccount('sam', 'https://codes-b.test')
  const main = createPeerFixture(a, 'sam')
  const remote = createPeerFixture(b, 'sam')
  for (const app of [main, remote]) app.useP2p.setState({ enabled: true, account: 'sam' })
  const link = { kind: 'invite' } as const
  expect(peerLinkRequest(a, link, null)?.selected).toBe(main)
  const work = a.identities.add('work')
  work.useP2p.setState({ enabled: true, account: 'sam' })
  const request = peerLinkRequest(a, link, null)!
  expect(request.selected).toBeNull()
  expect(request.choices).toContain(remote)
  expect(request.owner(remote)).toBe(b)
  expect(peerLinkRequest(a, link, remote)).toBeNull()
  b.store.setState({ guest: true })
  expect(request.valid(remote)).toBe(false)
  a.identities.unregister('work')
  a.identities.add('work').useP2p.setState({ enabled: true, account: 'sam' })
  expect(request.valid(work)).toBe(false)
  expect(request.valid(main)).toBe(true)
})
