import { expect, test } from 'bun:test'
import { openAccountNotice } from '../client/notice_owner'
import { ApiError } from '../api'
import { me } from './fixtures'
import { accountPath } from '../view'
import { routeOwnerFor } from '../client/account_paths'
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
  const previous: { state: unknown; href: string }[] = []
  const history = {
    state: null as unknown,
    replaceState(state: unknown, _: string, path: string) {
      history.state = state
      location.href = new URL(path, location).href
    },
    pushState(state: unknown, title: string, path: string) {
      previous.push({ state: history.state, href: location.href })
      history.replaceState(state, title, path)
    },
    go(delta: number) {
      for (let i = 0; i > delta; i--) history.back()
    },
    back() {
      const entry = previous.pop()
      if (entry) history.replaceState(entry.state, '', entry.href)
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
    expect(a.store.getState().syncInvite()).toBe(false)
    a.store.setState({ me: me('reader') })
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
    expect(location.pathname).toBe(accountPath('/invite/club/', routeOwnerFor(a)))
    expect(a.store.getState().invite?.server).toBe('club')
  } finally {
    restore()
  }
})

test('account invite opens above its own home and Back returns to that history entry', () => {
  const { b, history, location, restore } = historyFixture()
  try {
    client.shown = () => b
    b.store.setState({ view: { kind: 'dm', dmId: 4 } })
    b.store.getState().goHome()
    const prefix = '/@reader@second.test'
    expect(location.pathname).toBe(prefix + '/')
    expect(history.state).toMatchObject({ acct: b.id, rchatOrigin: b.conn.origin })
    b.store.getState().openInvite('club', 'ticket')
    expect(location.pathname).toBe(prefix + '/invite/club/')
    expect(history.state).toMatchObject({ acct: b.id, rchatOrigin: b.conn.origin })
    b.store.getState().closeInvite()
    expect(location.pathname).toBe(prefix + '/')
    expect(history.state).toMatchObject({ acct: b.id, rchatOrigin: b.conn.origin })
  } finally {
    restore()
  }
})

test('only the addressed account consumes a prefixed invite or config link', async () => {
  const { a, b, history, location, restore } = historyFixture()
  try {
    const prefix = '/@reader@second.test'
    location.href = location.origin + prefix + '/invite/club/?ref=nav&password=ticket#row'
    expect(a.store.getState().syncInvite()).toBe(false)
    client.shown = () => b
    b.store.setState({ me: null })
    expect(b.store.getState().syncInvite()).toBe(false)
    b.store.setState({ me: me('reader') })
    expect(b.store.getState().syncInvite()).toBe(true)
    expect(b.store.getState().invite?.password).toBe('ticket')
    await Promise.resolve()
    expect(location.href).toBe(location.origin + prefix + '/invite/club/?ref=nav#row')
    expect(history.state).toMatchObject({ acct: b.id, rchatOrigin: b.conn.origin })
    location.pathname = prefix + '/config/aB1234567890/'
    expect(b.store.getState().syncConfigLink()).toBe(true)
    expect(b.store.getState().configLink).toBe('aB1234567890')
    client.shown = () => a
    expect(a.store.getState().syncConfigLink()).toBe(false)
    location.pathname = '/@second.test/i/acde23/'
    client.shown = () => b
    expect(b.store.getState().syncInvite()).toBe(false)
    b.store.setState({ me: null, guest: true })
    expect(b.store.getState().syncInvite()).toBe(true)
    expect(b.store.getState().invite?.code).toBe('acde23')
    client.shown = () => a
    for (const malformed of ['/@reader@/invite/club/', '/@reader@/config/aB1234567890/']) {
      location.pathname = malformed
      expect(a.store.getState().syncInvite()).toBe(false)
      expect(a.store.getState().syncConfigLink()).toBe(false)
    }
  } finally {
    restore()
  }
})

test('an admin row updates its scoped history entry and closing returns to the underlying DM', () => {
  const { b, history, location, restore } = historyFixture()
  try {
    client.shown = () => b
    b.store.setState({ me: me('reader', { is_site_admin: true }), view: { kind: 'dm', dmId: 4 } })
    location.pathname = '/@reader@second.test/dm/4/'
    b.store.getState().openAdmin('users', 'reader')
    b.store.getState().openAdmin('users', 'reader', 'row one')
    expect(location.pathname + location.hash).toBe(
      '/@reader@second.test/admin/users/reader/#row%20one'
    )
    expect(history.state).toMatchObject({
      acct: b.id,
      rchatOrigin: b.conn.origin,
      rchatAdmin: { depth: 1, from: '/@reader@second.test/dm/4/' },
    })
    b.store.getState().closeAdmin()
    expect(location.pathname).toBe('/@reader@second.test/dm/4/')
    expect(location.hash).toBe('')
  } finally {
    restore()
  }
})

test('denied, expired and superseded channel notices preserve the current history entry', async () => {
  const { a, b, history, location, restore } = historyFixture()
  try {
    client.bindHome(() => a)
    client.show(a, 'none')
    const source = '/@reader@first.test/dm/5/'
    history.replaceState({ source: true }, '', source)
    b.store.setState({ view: { kind: 'dm', dmId: 2 } })
    const open = () => openAccountNotice(b, () => b.store.getState().openChannel('club', 9))
    b.store.setState({ discoverChannels: async () => {} })
    await open()
    expect(location.pathname).toBe(source)
    expect(history.state).toEqual({ source: true })
    expect(client.shown()).toBe(a)
    b.store.setState({ authExpired: true })
    await openAccountNotice(b, () => {
      throw Error('Expired notice ran')
    })
    expect(client.shown()).toBe(a)
    b.store.setState({ authExpired: false })
    const response = Promise.withResolvers<void>()
    b.store.setState({ discoverChannels: () => response.promise })
    const pending = open()
    expect(client.noticePending(b)).toBe(true)
    b.store.getState().goHome()
    const current = location.pathname
    expect(current).toBe('/@reader@second.test/')
    response.resolve()
    await pending
    expect(client.noticePending(b)).toBe(false)
    expect(client.shown()).toBe(b)
    expect(location.pathname).toBe(current)
    history.back()
    expect(location.pathname).toBe(source)
  } finally {
    restore()
  }
})
