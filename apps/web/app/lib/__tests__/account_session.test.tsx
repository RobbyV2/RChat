import { afterAll, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { client } from '../client/client'
import { AccountProvider, useAccount, useApi, useConn, useStoreApi } from '../client/react'
import { home } from '../instances'
import { resetSessionCaches, useStore } from '../store'
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
  }
})

test('account keys follow the signed-in name and connection', () => {
  const account = testAccount('alice')
  expect(account.id).toBe('alice@instance.test')
  expect(account.keys.local('rchat_token')).toBe('rchat_token:alice@instance.test')
  expect(account.keys.db()).toBe('rchat-p2p:instance.test:alice')
  expect(account.keys.db('work')).toBe('rchat-p2p:instance.test:alice~work')
  account.store.setState({ me: null })
  expect(account.keys.db()).toBe(null)
  expect(account.id).toBe('~guest@instance.test')
  expect(account.keys.local('rchat_guest')).toBe('rchat_guest@instance.test')
})

test('a fixture action cannot write to the shown account', () => {
  const alice = testAccount('alice')
  const before = useStore.getState()
  expect(alice.store.getState().servers).not.toBe(before.servers)
  expect(() => alice.store.getState().showToast('from Alice')).toThrow('Unsupported fixture action')
  expect(useStore.getState()).toBe(before)
})
