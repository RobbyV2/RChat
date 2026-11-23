import { afterAll, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { client } from '../client/client'
import { AccountProvider, useAccount, useApi, useConn, useStoreApi } from '../client/react'
import { home } from '../instances'
import { resetSessionCaches, useStore } from '../store'
import { serverDetail, textChannel, user } from './fixtures'
import { testAccount } from './test_account'

afterAll(resetSessionCaches)

function Reader() {
  const account = useAccount()
  expect(useStoreApi()).toBe(account.store)
  expect(useApi()).toBe(account.conn.api)
  expect(useConn()).toBe(account.conn)
  expect(useStore()).toBe(account.store.getInitialState())
  return <span>{useStore(s => s.me?.username ?? 'guest')}</span>
}

test('the chat uses the shown account outside a provider and the nearest account inside', () => {
  expect(client.shown().conn).toBe(home)
  const alice = testAccount('alice')
  const bob = testAccount('bob')
  const shown = client.shown
  client.shown = () => alice
  try {
    expect(renderToStaticMarkup(<Reader />)).toBe('<span>alice</span>')
    expect(
      renderToStaticMarkup(
        <AccountProvider session={bob}>
          <Reader />
        </AccountProvider>
      )
    ).toBe('<span>bob</span>')
  } finally {
    client.shown = shown
    alice.store.dispose()
    bob.store.dispose()
  }
})

test('static store methods resolve the shown account when called', () => {
  const alice = testAccount('alice')
  const bob = testAccount('bob')
  const shown = client.shown
  client.shown = () => alice
  try {
    const { getState, getInitialState, setState, subscribe } = useStore
    expect(getState()).toBe(alice.store.getState())
    client.shown = () => bob
    expect(getInitialState()).toBe(bob.store.getInitialState())
    const errors: (string | null)[] = []
    const off = subscribe(s => errors.push(s.error))
    setState({ error: 'read only' })
    off()
    setState(getInitialState(), true)
    expect(errors).toEqual(['read only'])
    expect(getState()).toBe(bob.store.getInitialState())
    expect(alice.store.getState().error).toBe(null)
  } finally {
    client.shown = shown
    alice.store.dispose()
    bob.store.dispose()
  }
})

test('account keys follow the signed-in name and connection', () => {
  const account = testAccount('alice')
  expect(account.id).toBe('alice@instance.test')
  expect(account.keys.local('rchat_token')).toBe('rchat_token:alice@instance.test')
  expect(account.keys.db()).toBe('rchat-p2p:https://instance.test:alice')
  expect(account.keys.db('work')).toBe('rchat-p2p:https://instance.test:alice~work')
  account.store.setState({ me: null })
  expect(account.keys.db()).toBe(null)
  expect(account.id).toBe('~guest@instance.test')
  expect(account.keys.local('rchat_guest')).toBe('rchat_guest@instance.test')
  account.store.dispose()
})

test('a fixture action cannot write to the shown account', () => {
  const alice = testAccount('alice')
  const before = useStore.getState()
  expect(alice.store.getState().servers).not.toBe(before.servers)
  alice.store.getState().showToast('from Alice')
  expect(alice.store.getState().toast?.text).toBe('from Alice')
  expect(useStore.getState()).toBe(before)
  alice.store.dispose()
})

test('message caches, pending requests and menu actions belong to their account', async () => {
  const alice = testAccount('alice')
  const bob = testAccount('bob')
  try {
    expect(alice.store.eventTables()[0]).not.toBe(bob.store.eventTables()[0])
    const first = user('alice')
    const second = user('bob')
    alice.api.reactors = async () => [first]
    bob.api.reactors = async () => [second]
    const aliceRows = () => alice.store.getState().loadReactors(1, 'wave')
    const bobRows = () => bob.store.getState().loadReactors(1, 'wave')
    const cached = bobRows()
    expect(await aliceRows()).toEqual([first])
    expect(await cached).toEqual([second])
    const aliceRequest = Promise.withResolvers<unknown>()
    const bobRequest = Promise.withResolvers<unknown>()
    alice.api.brand = () => aliceRequest.promise
    bob.api.brand = () => bobRequest.promise
    const pending = [alice.store.getState().loadBrand(), bob.store.getState().loadBrand()]
    alice.store.resetSessionCaches()
    alice.api.reactors = async () => []
    expect(await aliceRows()).toEqual([])
    expect(bobRows()).toBe(cached)
    aliceRequest.resolve({ instance_name: 'Alice' })
    bobRequest.resolve({ instance_name: 'Bob' })
    await Promise.all(pending)
    expect(alice.store.getState().brand).toBeNull()
    expect(bob.store.getState().brand?.instance_name).toBe('Bob')
    bob.store.menu.confirmDeleteMessage(9)
    expect(bob.store.getState().confirm?.confirm).toBe('Delete')
    expect(alice.store.getState().confirm).toBeNull()
  } finally {
    alice.store.dispose()
    bob.store.dispose()
  }
})

test('a socket delivers events and invokes taps only in its account', async () => {
  const alice = testAccount('alice')
  const bob = testAccount('bob')
  try {
    const received: string[] = []
    alice.conn.ws.start = bob.conn.ws.start = () => {}
    alice.store.tapWs(() => received.push('alice'))
    const offBob = bob.store.tapWs(() => received.push('bob'))
    await alice.store.getState().enterGuest()
    await bob.store.getState().enterGuest()
    const event = {
      type: 'typing',
      scope: 'd1',
      server: null,
      channel_id: null,
      dm_id: 1,
      dm_users: null,
      username: 'jane',
      display_name: 'Jane',
      until: Date.now() / 1000 + 8,
    } as const
    alice.conn.ws.onEvent(event)
    expect(alice.store.getState().typing.d1?.jane?.name).toBe('Jane')
    expect(bob.store.getState().typing).toEqual({})
    bob.conn.ws.onEvent(event)
    offBob()
    bob.conn.ws.onEvent(event)
    expect(received).toEqual(['alice', 'bob'])
  } finally {
    alice.store.dispose()
    bob.store.dispose()
  }
})

test('ending one session preserves the other account’s viewing consent', async () => {
  const alice = testAccount('alice', 'https://a.test')
  const bob = testAccount('alice', 'https://b.test')
  try {
    const servers = {
      club: serverDetail('club', { channels: [{ ...textChannel(1), sensitive: true }] }),
    }
    alice.store.setState({ servers })
    bob.store.setState({ servers })
    const a = alice.viewing.instanceTarget(alice.store.getState(), 'club', 1)!
    const b = bob.viewing.instanceTarget(bob.store.getState(), 'club', 1)!
    expect(a.key).not.toBe(b.key)
    const first = alice.viewing.requestViewing(a)
    const second = bob.viewing.requestViewing(b)
    bob.viewing.useViewing.getState().prompt!.answer(true, false)
    alice.store.resetSessionCaches()
    expect(await first).toBe(false)
    expect(await second).toBe(true)
    expect(bob.viewing.canView(b)).toBe(true)
  } finally {
    alice.store.dispose()
    bob.store.dispose()
  }
})
