import { expect, test } from 'bun:test'
import { endpointsFrom, setMediaCookie } from '../instances'
import { me, memoryStorage } from './fixtures'
import { accountStorage } from '../client/keys'
import { testAccount } from './test_account'
import type { MeUpdated } from '../api'
import type { InstanceInfo, Me, SiteSettings } from '../types'

test('authentication completing after disposal cannot start the socket or install credentials', async () => {
  for (const action of ['login', 'register'] as const) {
    const account = testAccount('alice')
    account.store.setState({ me: null })
    const response = Promise.withResolvers<Response>()
    account.api.send = () => response.promise
    let starts = 0
    account.conn.ws.start = () => {
      starts++
    }
    const state = account.store.getState()
    const pending = state[action]({ username: 'alice', password: 'password', avatar_kind: 'color' })
    account.store.dispose()
    response.resolve(Response.json({ token: 'late', user: me('alice') }))
    await pending
    expect(account.store.getState().token).toBeNull()
    expect(account.store.getState().me).toBeNull()
    expect(starts).toBe(0)
  }
})

test('bootstrap ignores a saved account response received after disposal', async () => {
  const account = testAccount('alice')
  const oldStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const arrived = Promise.withResolvers<void>()
  const response = Promise.withResolvers<Me>()
  let starts = 0
  account.credentialTarget = 'alice'
  const key = accountStorage(account.conn).token('alice')
  const previous = memoryStorage.getItem(key)
  memoryStorage.setItem(key, 'saved')
  try {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: memoryStorage,
    })
    account.store.setState({
      me: null,
      loadInstance: async () => true,
      loadSettings: async () => {},
    })
    account.api.me = () => {
      arrived.resolve()
      return response.promise
    }
    account.conn.ws.start = () => {
      starts++
    }
    const pending = account.store.getState().bootstrap()
    await arrived.promise
    account.store.dispose()
    response.resolve(me('alice'))
    await pending
    expect(starts).toBe(0)
    expect(account.store.getState().me).toBeNull()
    expect(account.store.getState().token).toBeNull()
  } finally {
    if (previous === null) memoryStorage.removeItem(key)
    else memoryStorage.setItem(key, previous)
    if (oldStorage) Object.defineProperty(globalThis, 'localStorage', oldStorage)
    else Reflect.deleteProperty(globalThis, 'localStorage')
  }
})

test('authentication cannot commit between a completed response and a queued disposal', async () => {
  for (const action of ['login', 'register'] as const) {
    const account = testAccount('alice')
    account.store.setState({ me: null })
    const body = Promise.withResolvers<unknown>()
    const reading = Promise.withResolvers<void>()
    const response = Response.json({})
    response.json = () => {
      reading.resolve()
      return body.promise
    }
    account.api.send = async () => response
    let disposed = false
    let lateStarts = 0
    account.conn.ws.start = () => {
      if (disposed) lateStarts++
    }
    const state = account.store.getState()
    const pending = state[action]({ username: 'alice', password: 'password', avatar_kind: 'color' })
    await reading.promise
    body.resolve({ token: 'saved', user: me('alice') })
    let tokenAtDisposal: string | null = null
    queueMicrotask(() =>
      queueMicrotask(() => {
        disposed = true
        account.store.dispose()
        tokenAtDisposal = account.store.getState().token
      })
    )
    await pending
    expect(disposed).toBe(true)
    expect(lateStarts).toBe(0)
    expect(account.store.getState().token).toBe(tokenAtDisposal)
  }
})

test('a secondary connection never writes the home media cookie', () => {
  const account = testAccount('bob')
  const oldDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
  const doc = { cookie: 'rchat_token=home' }
  try {
    Object.defineProperty(globalThis, 'document', { configurable: true, value: doc })
    for (const ownOrigin of [false, true]) {
      account.conn.isDefault = ownOrigin
      setMediaCookie(account.conn, 'secondary')
      setMediaCookie(account.conn, null)
    }
    expect(doc.cookie).toBe('rchat_token=home')
  } finally {
    if (oldDocument) Object.defineProperty(globalThis, 'document', oldDocument)
    else Reflect.deleteProperty(globalThis, 'document')
    account.store.dispose()
  }
})

test('late profile writes cannot cross an instance change for the same username', async () => {
  const account = testAccount('alice', 'https://first.test')
  const update = Promise.withResolvers<MeUpdated>()
  account.api.setBio = account.api.setDisplayName = () => update.promise
  const first = account.store.getState()
  const pending = [first.setBio('old'), first.setDisplayName('Old')]
  account.store.resetSessionCaches()
  account.conn.retarget(endpointsFrom('https://second.test', null), null, false)
  const current = me('alice', { bio: 'current', display_name: 'Current' })
  account.store.setState({ me: current })
  try {
    update.resolve({ ...current, bio: 'old', display_name: 'Old' })
    await Promise.all(pending)
    expect(account.store.getState().me).toBe(current)
  } finally {
    account.store.dispose()
  }
})

test('stale settings cannot update a reset store or start a brand fetch', async () => {
  const account = testAccount('alice')
  const response = Promise.withResolvers<SiteSettings>()
  account.api.getSettings = () => response.promise
  let brands = 0
  account.api.brand = async () => {
    brands++
    return {}
  }
  const pending = account.store.getState().loadSettings()
  account.store.resetSessionCaches()
  const before = account.store.getState().settings
  try {
    response.resolve({ ...before, guests_enabled: !before.guests_enabled })
    await pending
    expect(account.store.getState().settings).toBe(before)
    expect(brands).toBe(0)
  } finally {
    account.store.dispose()
  }
})

test('a completed profile response cannot commit across a queued account change', async () => {
  const account = testAccount('alice', 'https://first.test')
  const response = Promise.withResolvers<MeUpdated>()
  account.api.setBio = () => response.promise
  const pending = account.store.getState().setBio('old')
  const current = me('alice', { bio: 'current' })
  response.resolve({ ...current, bio: 'old' })
  queueMicrotask(() => {
    account.store.resetSessionCaches()
    account.conn.retarget(endpointsFrom('https://second.test', null), null, false)
    account.store.setState({ me: current })
  })
  try {
    await pending
    expect(account.store.getState().me).toBe(current)
  } finally {
    account.store.dispose()
  }
})

test('instance discovery finishing after sign-in keeps the authenticated connection', async () => {
  const account = testAccount('alice', 'https://first.test')
  const response = Promise.withResolvers<Response>()
  const originalFetch = globalThis.fetch
  globalThis.fetch = (() => response.promise) as typeof fetch
  try {
    const pending = account.store.getState().switchInstance('https://second.test')
    account.store.setState({ token: 'signed-in' })
    response.resolve(
      Response.json({
        software: 'rchat',
        id: 'second',
        name: 'Second',
        host: 'second.test',
        public_url: 'https://second.test',
        api_version: '1.0',
        api_url: 'https://second.test/api',
        ws_url: 'wss://second.test/api/ws',
        features: {},
      })
    )
    expect(await pending).toBe('Log out before switching instances')
    expect(account.conn.host).toBe('first.test')
    expect(account.store.getState().token).toBe('signed-in')
  } finally {
    globalThis.fetch = originalFetch
    account.store.dispose()
  }
})

test('an interrupted initial discovery leaves the picker without a failure result', async () => {
  for (const succeeded of [true, false]) {
    const account = testAccount('alice')
    const response = Promise.withResolvers<InstanceInfo>()
    account.api.instance = () => response.promise
    try {
      const pending = account.store.getState().loadInstance()
      account.store.resetSessionCaches()
      if (succeeded) response.resolve({} as InstanceInfo)
      else response.reject(new Error('connection unavailable'))
      expect(await pending).toBeNull()
    } finally {
      account.store.dispose()
    }
  }
})
