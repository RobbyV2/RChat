import { expect, test } from 'bun:test'
import { ApiError } from '../api'
import { me } from './fixtures'
import { client } from '../client/client'
import { stashInvite } from '../invite'
import { testAccount } from './test_account'

function historyFixture() {
  const a = testAccount('reader', 'https://first.test')
  const b = testAccount('reader', 'https://second.test')
  const real = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const original = client.shown
  const location = new URL('https://client.test/')
  const storage = new Map<string, string>()
  const history = {
    state: null as unknown,
    replaceState(state: unknown, _: string, path: string) {
      history.state = state
      location.href = new URL(path, location).href
    },
    pushState(state: unknown, title: string, path: string) {
      history.replaceState(state, title, path)
    },
  }
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      location,
      history,
      sessionStorage: {
        getItem: (k: string) => storage.get(k) ?? null,
        setItem: (k: string, v: string) => storage.set(k, v),
        removeItem: (k: string) => storage.delete(k),
      },
    },
  })
  client.shown = () => a
  return {
    a,
    b,
    history,
    location,
    restore() {
      client.shown = original
      a.store.dispose()
      b.store.dispose()
      if (real) Object.defineProperty(globalThis, 'window', real)
      else Reflect.deleteProperty(globalThis, 'window')
    },
  }
}

test('an invite password follows its browser history entry only within the owning login', async () => {
  const { a, b, history, location, restore } = historyFixture()
  try {
    location.pathname = '/invite/club/'
    const saved = { server: 'club', password: 'ticket' }
    stashInvite(saved, a.handoff)
    a.store.getState().syncInvite()
    client.shown = () => b
    await Promise.resolve()
    expect(history.state).toBeNull()
    expect(b.store.getState().syncInvite()).toBe(true)
    expect(b.store.getState().invite?.password).toBeNull()

    client.shown = () => a
    stashInvite(saved, a.handoff)
    a.store.getState().syncInvite()
    await Promise.resolve()
    expect(typeof (history.state as { rchatInviteOwner?: string } | null)?.rchatInviteOwner).toBe(
      'string'
    )
    expect(a.store.getState().syncInvite()).toBe(true)
    expect(a.store.getState().invite?.password).toBe('ticket')
    client.shown = () => b
    b.store.getState().syncInvite()
    expect(b.store.getState().invite?.password).toBeNull()

    client.shown = () => a
    a.store.resetSessionCaches()
    a.store.getState().syncInvite()
    expect(a.store.getState().invite?.password).toBeNull()
  } finally {
    restore()
  }
})

test('a pending message link and a background config import preserve the shown account’s URL', async () => {
  const { a, b, location, restore } = historyFixture()
  try {
    a.store.setState({ view: { kind: 'dm', dmId: 1 } })
    location.pathname = '/dm/1/90/'
    const pending = Promise.withResolvers<Awaited<ReturnType<typeof a.api.messagePlace>>>()
    const requested = Promise.withResolvers<void>()
    a.api.messagePlace = () => {
      requested.resolve()
      return pending.promise
    }
    const sync = a.store.getState().syncFromUrl('none')
    await requested.promise
    client.shown = () => b
    location.pathname = '/dm/42/'
    pending.resolve({ server: null, channel_id: null, dm_id: 1, thread_root_id: null })
    await sync
    expect(location.pathname).toBe('/dm/42/')
    a.store.setState({ configLink: 'share' })
    a.store.getState().closeConfigLink()
    expect(a.store.getState().configLink).toBeNull()
    expect(location.pathname).toBe('/dm/42/')
  } finally {
    restore()
  }
})

test('a new login retires the previous history nonce after bootstrap expires before identifying its user', async () => {
  const { a, history, location, restore } = historyFixture()
  const reload = testAccount('reader', a.conn.origin)
  try {
    location.pathname = '/invite/club/'
    a.store.getState().openInvite('club', 'old-ticket')
    const oldEntry = history.state
    client.shown = () => reload
    reload.store.setState({
      me: null,
      loadInstance: async () => true,
      loadSettings: async () => {},
    })
    localStorage.setItem(reload.conn.scoped('rchat_token'), 'expired')
    reload.api.me = async () => {
      throw new ApiError('Unauthorized', 401)
    }
    reload.conn.ws.start = () => {}
    await reload.store.getState().bootstrap()
    reload.api.send = async () => Response.json({ token: 'new', user: me('reader') })
    await reload.store.getState().login({ username: 'reader', password: 'password' })
    expect(reload.store.getState().token).toBe('new')
    history.replaceState(oldEntry, '', '/invite/club/')
    reload.store.getState().syncInvite()
    expect(reload.store.getState().invite?.password).toBeNull()
  } finally {
    localStorage.removeItem(reload.conn.scoped('rchat_token'))
    reload.store.dispose()
    restore()
  }
})

test('a later invite stays open when an older message lookup finishes on the same account', async () => {
  const { a, location, restore } = historyFixture()
  try {
    a.store.setState({ view: { kind: 'dm', dmId: 1 } })
    location.pathname = '/dm/1/90/'
    const result = Promise.withResolvers<Awaited<ReturnType<typeof a.api.messagePlace>>>()
    const pending = Promise.withResolvers<void>()
    a.api.messagePlace = () => {
      pending.resolve()
      return result.promise
    }
    const first = a.store.getState().syncFromUrl('none')
    await pending.promise
    a.store.getState().openInvite('club')
    result.resolve({ server: null, channel_id: null, dm_id: 1, thread_root_id: null })
    await first
    expect(location.pathname).toBe('/invite/club/')
    expect(a.store.getState().invite?.server).toBe('club')
  } finally {
    restore()
  }
})
