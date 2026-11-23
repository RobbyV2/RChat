import { expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { SignedOutAccount } from '../../login/account_login'
import { AccountManager } from '../client/account_manager'
import { accountStorage, peerStorage } from '../client/keys'
import { addAccount, addInstance, parseBook } from '../client/book'
import { client } from '../client/client'
import { memoryStorage, msg, me, drain } from './fixtures'
import { testAccount } from './test_account'
import type { AccountSession } from '../client/session'

test('live budget, lock handover, lite trimming, owner-specific polling and storage removal', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const target = Object.assign(new EventTarget(), {
    location: new URL('https://client.test'),
    localStorage: memoryStorage,
  })
  Object.defineProperty(globalThis, 'window', { value: target, configurable: true })
  const clock = Date.now
  let now = clock()
  Date.now = () => now
  const alpha = testAccount('alice', 'https://alpha.test')
  const second = testAccount('alice2', 'https://alpha.test')
  const beta = testAccount('alice', 'https://beta.test')
  const cold = testAccount('offline', 'https://beta.test')
  const sessions = [alpha, second, beta, cold]
  let shown = alpha
  let active: AccountSession | undefined
  let book = parseBook(null)
  let signal = () => {}
  const held = new Set(sessions)
  const polls: AccountSession[] = []
  const boots: AccountSession[] = []
  const resumed: AccountSession[] = []
  const sockets = new Map<AccountSession, boolean>()
  const peers = new Map<AccountSession, ReadonlySet<string>>()
  let stop = () => {}
  try {
    for (const a of sessions) {
      const username = a.store.getState().me!.username
      a.credentialTarget = username
      memoryStorage.setItem(a.keys.local('rchat_p2p_identities'), JSON.stringify(['work']))
      for (const id of ['main', 'work'])
        memoryStorage.setItem(
          peerStorage(a.conn, username, id).scoped('rchat_p2p:' + username),
          '{"v":1,"on":true}'
        )
      a.identities.setRunning = ids => {
        peers.set(a, ids)
      }
      a.store.setState({
        bootstrap: async () => {
          boots.push(a)
        },
      })
      a.store.resumeView = () => {
        resumed.push(a)
      }
      a.store.setSocket = (on: boolean) => {
        a.socketAllowed = on
        sockets.set(a, on)
      }
      Object.assign(a.tabLock, {
        start() {},
        stop() {},
        holds: () => held.has(a),
        subscribe: () => () => {},
      })
      if (a !== cold)
        memoryStorage.setItem(accountStorage(a.conn).token(username), 'saved-' + username)
      book = addInstance(book, { origin: a.conn.origin, id: a.conn.host, name: a.conn.host })
      book = addAccount(
        book,
        a.conn.origin,
        { username, avatar: null, display: null, connect: true, added: now, identities: [] },
        null
      )
    }
    const manager = new AccountManager({
      book: () => book,
      shown: () => shown,
      live: () => client.live(),
      protected: () => active,
      protectedIdentity: () => (active ? 'work' : undefined),
      watch: fn => {
        signal = fn
        return () => {}
      },
      publish: () => {},
    })
    stop = manager.start(a => {
      polls.push(a)
    })
    expect([alpha.mode, second.mode, beta.mode]).toEqual(['shown', 'live', 'live'])
    expect(boots).toEqual([second, beta])
    expect(sockets.has(cold)).toBe(false)
    expect(peers.get(alpha)).toEqual(new Set(['main', 'work']))
    manager.setBudget(2)
    await Promise.resolve()
    expect(beta.mode).toBe('parked')
    shown = beta
    now += 1
    manager.reconcile()
    expect(beta.mode).toBe('shown')
    expect(resumed).toContain(beta)
    expect(second.mode).toBe('parked')
    active = second
    signal()
    await Promise.resolve()
    expect(sockets.get(second)).toBe(true)
    expect(peers.get(second)).toEqual(new Set(['work']))
    expect(peers.get(beta)).toEqual(new Set(['main']))
    // Beta's saved flags remain in storage while its operator prohibits peers.
    beta.store.setState(s => ({ settings: { ...s.settings, p2p: false } }))
    await Promise.resolve()
    expect(peers.get(beta)).toEqual(new Set())
    expect(peers.get(second)).toEqual(new Set(['main', 'work']))
    beta.store.setState(s => ({ settings: { ...s.settings, p2p: true } }))
    await Promise.resolve()
    expect(peers.get(beta)).toEqual(new Set(['main']))
    expect(alpha.mode).toBe('parked')
    active = undefined
    manager.setBudget(3)
    await Promise.resolve()
    alpha.store.setState({ messages: { d1: [msg(1)] }, drafts: { d1: 'keep' } })
    now += 10 * 60_000
    manager.reconcile()
    expect(alpha.mode).toBe('lite')
    expect(sockets.get(alpha)).toBe(true)
    expect(alpha.store.getState().messages).toEqual({})
    expect(alpha.store.getState().drafts).toEqual({ d1: 'keep' })
    alpha.store.getState().markRead('d1', 55)
    expect(alpha.store.getState().reads.d1).toBeUndefined()
    alpha.store.setState({ messages: { d1: [msg(2)] } })
    expect(alpha.store.getState().messages).toEqual({})
    held.delete(alpha)
    manager.reconcile()
    expect(sockets.get(alpha)).toBe(false)
    held.add(alpha)
    manager.reconcile()
    expect(sockets.get(alpha)).toBe(true)
    book = {
      ...book,
      instances: book.instances.map(i => ({
        ...i,
        accounts: i.accounts.map(a => (a.username === 'alice2' ? { ...a, connect: false } : a)),
      })),
    }
    manager.reconcile()
    expect(second.mode).toBe('parked')
    now += 5 * 60_000
    manager.reconcile()
    expect(polls).toContain(second)
    const tokenKey = accountStorage(alpha.conn).token('alice')
    memoryStorage.removeItem(tokenKey)
    target.dispatchEvent(Object.assign(new Event('storage'), { key: tokenKey }))
    await Promise.resolve()
    expect(client.live()).not.toContain(alpha)
    expect(client.live()).toContain(beta)
    expect(shown).toBe(beta)
  } finally {
    stop()
    for (const a of sessions) if (client.live().includes(a)) a.store.dispose()
    Date.now = clock
    memoryStorage.clear()
    if (descriptor) Object.defineProperty(globalThis, 'window', descriptor)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})

test('reconciliation creates pinned sessions, keeps a guest distinct, and ignores a removed pending account response', async () => {
  const desc = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const page = Object.assign(new EventTarget(), {
    location: new URL('https://client.test/'),
    localStorage: memoryStorage,
  })
  Object.defineProperty(globalThis, 'window', { value: page, configurable: true })
  const originalFetch = globalThis.fetch
  const originalShown = client.shown
  const alpha = testAccount('alice', 'https://alpha.test')
  client.shown = () => alpha
  let pending = Promise.withResolvers<Response>()
  let arrived = Promise.withResolvers<void>()
  const requests: string[] = []
  let starts = 0
  let cleanup = () => {}
  try {
    const origin = alpha.conn.origin
    const keys = accountStorage(alpha.conn)
    memoryStorage.setItem(keys.token('alice'), 'alice-token')
    memoryStorage.setItem(keys.token('bob'), 'bob-token')
    memoryStorage.setItem(keys.key('rchat_token'), 'alice-token')
    memoryStorage.setItem(keys.key('rchat_guest'), '1')
    let book = addInstance(parseBook(null), { origin, id: 'Alpha', name: 'Alpha' })
    for (const username of ['alice', 'bob', 'forgotten']) {
      book = addAccount(
        book,
        origin,
        { username, display: null, avatar: null, connect: true, added: 0, identities: [] },
        null
      )
    }
    book.instances[0].guest = true
    memoryStorage.setItem('rchat_live_budget', '2')
    globalThis.fetch = (async (input, init) => {
      const path = new URL(String(input)).pathname
      if (path.endsWith('/me')) {
        requests.push(new Headers(init?.headers).get('Authorization') ?? '')
        arrived.resolve()
        return pending.promise
      }
      return Response.json({})
    }) as typeof fetch
    const manager = new AccountManager({
      book: () => book,
      shown: () => alpha,
      live: client.live,
      protected: () => undefined,
      protectedIdentity: () => undefined,
      watch: () => () => {},
      publish: () => {},
    })
    cleanup = manager.start()
    await arrived.promise
    const users = client.live().filter(s => s.conn.origin === origin)
    expect(users).toHaveLength(3)
    const bob = users.find(s => s.credentialTarget === 'bob')!
    const guest = users.find(s => s.credentialTarget === null)!
    guest.conn.ws.start = () => {}
    expect(requests).toEqual(['Bearer bob-token'])
    expect(bob.conn).not.toBe(alpha.conn)
    expect(guest.mode).toBe('parked')
    expect(guest.store.getState().token).toBeNull()
    bob.conn.ws.start = () => {
      starts++
    }
    memoryStorage.removeItem(keys.token('bob'))
    page.dispatchEvent(Object.assign(new Event('storage'), { key: keys.token('bob') }))
    await Promise.resolve()
    expect(client.live()).not.toContain(bob)
    expect(client.live()).toContain(alpha)
    pending.resolve(Response.json(me('bob')))
    await drain()
    expect(bob.store.getState().me).toBeNull()
    expect(starts).toBe(0)
    expect(memoryStorage.getItem(keys.token('bob'))).toBeNull()
    expect(memoryStorage.getItem(keys.key('rchat_token'))).toBe('alice-token')
    // Another tab signs Bob back in while Alice remains shown. Keep Bob's saved
    // book row, reconstruct his connection, and send only Bob's replacement token.
    pending = Promise.withResolvers<Response>()
    arrived = Promise.withResolvers<void>()
    manager.setBudget(3)
    memoryStorage.setItem(keys.token('bob'), 'replacement')
    page.dispatchEvent(Object.assign(new Event('storage'), { key: keys.token('bob') }))
    await arrived.promise
    const next = client.live().find(a => a.conn.origin === origin && a.credentialTarget === 'bob')!
    expect(next).not.toBe(bob)
    const opened: string[] = []
    next.conn.ws.start = token => {
      if (token) opened.push(token)
    }
    pending.resolve(Response.json(me('bob')))
    await drain()
    expect(next.store.getState().me?.username).toBe('bob')
    expect(next.mode).toBe('live')
    expect(opened).toEqual(['replacement'])
    expect(requests).toEqual(['Bearer bob-token', 'Bearer replacement'])
    expect(client.shown()).toBe(alpha)
    expect(memoryStorage.getItem(keys.key('rchat_token'))).toBe('alice-token')
  } finally {
    cleanup()
    for (const a of client.live()) if (a.conn.origin === alpha.conn.origin) a.store.dispose()
    client.shown = originalShown
    globalThis.fetch = originalFetch
    if (desc) Object.defineProperty(globalThis, 'window', desc)
    else Reflect.deleteProperty(globalThis, 'window')
    memoryStorage.clear()
  }
})

test('a shown account retires its credential and resumes only the newest replacement', async () => {
  const desc = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const page = Object.assign(new EventTarget(), {
    location: new URL('https://client.test/@sam@shown.test/'),
    localStorage: memoryStorage,
    history: { replaceState() {} },
  })
  Object.defineProperty(globalThis, 'window', { value: page, configurable: true })
  const originalFetch = globalThis.fetch
  const originalShown = client.shown
  const originalBook = client.book.getState()
  const shown = testAccount('sam', 'https://shown.test')
  const other = testAccount('sam', 'https://other.test')
  client.shown = () => shown
  const tokenKey = (a: AccountSession) => accountStorage(a.conn).token('sam')
  const change = (token: string | null) => {
    const key = tokenKey(shown)
    if (token) memoryStorage.setItem(key, token)
    else memoryStorage.removeItem(key)
    page.dispatchEvent(Object.assign(new Event('storage'), { key }))
  }
  const opened: string[] = []
  shown.conn.ws.start = token => {
    if (token) opened.push(token)
  }
  const stale = Promise.withResolvers<Response>()
  const newest = Promise.withResolvers<Response>()
  const requested: string[] = []
  let cleanup = () => {}
  try {
    let book = parseBook(null)
    for (const a of [shown, other]) {
      const origin = a.conn.origin
      book = addInstance(book, { origin, id: origin, name: origin })
      book = addAccount(
        book,
        origin,
        {
          username: 'sam',
          display: null,
          avatar: null,
          added: 0,
          connect: false,
          identities: [],
        },
        null
      )
      memoryStorage.setItem(tokenKey(a), origin)
      a.store.setState({ token: origin, drafts: { d1: origin } })
    }
    memoryStorage.setItem('rchat_book', JSON.stringify(book))
    client.book.setState(book, true)
    memoryStorage.setItem(accountStorage(shown.conn).key('rchat_token'), 'unrelated-alias')
    globalThis.fetch = (async (input, init) => {
      if (new URL(String(input)).pathname.endsWith('/me')) {
        const bearer = new Headers(init?.headers).get('Authorization')!
        requested.push(bearer)
        return bearer === 'Bearer stale' ? stale.promise : newest.promise
      }
      return Response.json({})
    }) as typeof fetch
    const manager = new AccountManager({
      book: () => book,
      shown: () => shown,
      live: client.live,
      protected: () => undefined,
      protectedIdentity: () => undefined,
      watch: () => () => {},
      publish: () => {},
    })
    cleanup = manager.start()
    change(null)
    await drain()
    expect(shown.store.getState()).toMatchObject({
      signedOut: true,
      me: null,
      token: null,
      drafts: {},
    })
    expect(shown.credentialTarget).toBe('sam')
    const html = renderToStaticMarkup(createElement(SignedOutAccount, { account: shown }))
    expect(html).toContain('You’re signed out')
    expect(html).toContain('href="/login?next=%2F%40sam%40shown.test%2F"')
    expect(shown.tabLock.holds(shown.conn.origin, 'sam')).toBe(false)
    expect(other.store.getState().drafts.d1).toBe(other.conn.origin)
    expect(requested).toEqual([])
    change('stale')
    await drain()
    expect(requested).toEqual(['Bearer stale'])
    change('newest')
    await drain()
    expect(requested).toEqual(['Bearer stale', 'Bearer newest'])
    newest.resolve(Response.json(me('sam', { display_name: 'New session' })))
    await drain()
    stale.resolve(Response.json(me('sam', { display_name: 'Old session' })))
    await drain()
    expect(shown.store.getState()).toMatchObject({
      signedOut: false,
      token: 'newest',
      me: { username: 'sam', display_name: 'New session' },
    })
    expect(opened).toEqual(['newest'])
    expect(memoryStorage.getItem(tokenKey(shown))).toBe('newest')
    expect(memoryStorage.getItem(tokenKey(other))).toBe(other.conn.origin)
    expect(memoryStorage.getItem(accountStorage(shown.conn).key('rchat_token'))).toBe(
      'unrelated-alias'
    )
  } finally {
    cleanup()
    await Promise.resolve()
    shown.store.dispose()
    other.store.dispose()
    client.shown = originalShown
    client.book.setState(originalBook, true)
    globalThis.fetch = originalFetch
    if (desc) Object.defineProperty(globalThis, 'window', desc)
    else Reflect.deleteProperty(globalThis, 'window')
    memoryStorage.clear()
  }
})
