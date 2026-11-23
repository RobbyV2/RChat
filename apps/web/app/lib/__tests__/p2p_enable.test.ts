import { createPeerFixture } from './peer_fixture'
import { AccountSession } from '../client/session'
import { home } from './home_instance'
const peerOwner = new AccountSession(home)
afterAll(() => peerOwner.store.dispose())
const peerApp = createPeerFixture(peerOwner, 'firefox')
const { p2p, p2pAccount, useP2p } = peerApp
import { afterAll, afterEach, describe, expect, test } from 'bun:test'

// Firefox answers navigator.storage.persist() only once the user answers its doorhanger, and a
// dismissed doorhanger never answers: turning P2P on must not wait for it.

const g = globalThis as { navigator?: unknown }
const real = g.navigator

afterEach(async () => {
  g.navigator = real
  await p2pAccount(null)
})

describe('turning P2P on', () => {
  test('starts the node while persistent storage is being asked for', async () => {
    let asked = 0
    g.navigator = {
      storage: {
        persist: () => {
          asked += 1
          return new Promise<boolean>(() => {})
        },
        estimate: async () => ({ usage: 0, quota: 0 }),
      },
    }
    useP2p.setState({ account: 'firefox' })
    const outcome = await Promise.race([
      p2p.enable('Alice').then(() => 'started'),
      new Promise(resolve => setTimeout(() => resolve('waiting'), 200)),
    ])
    expect(asked).toBe(1)
    expect(outcome).toBe('started')
    const st = useP2p.getState()
    expect(st.loading || st.error !== null).toBe(true)
  })
})
