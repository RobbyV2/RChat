import { beforeEach, afterEach, expect, test } from 'bun:test'
import { me, memoryStorage as storage } from './fixtures'
import { endpointsFrom, InstanceConnection } from '../instances'
import {
  confirmCredential,
  forgetCredential,
  accountUpdate,
  storedCredential,
} from '../client/credentials'
import { addInstance, parseBook } from '../client/book'
import { createBookStore } from '../client/book_store'
import { createInstanceRegistry } from '../client/instance_registry'
import { Secret } from '../secret'
import { plain } from './helpers/secret'

const origin = 'https://alpha.example'
const connection = (url = origin, own = false) =>
  new InstanceConnection(endpointsFrom(url, null), null, own)
beforeEach(() => storage.clear())
afterEach(() => storage.clear())
for (const own of [true, false])
  for (const enabled of [true, false])
    test(
      'unverified legacy startup, then verified owner migration ' +
        JSON.stringify({ own, enabled }),
      () => {
        const conn = connection(origin, own)
        const suffix = own ? '' : '@alpha.example'
        if (!own) storage.setItem('rchat_home', origin)
        storage.setItem('rchat_token' + suffix, 'first')
        storage.setItem('rchat_last_dm' + suffix + ':alice', '17')
        storage.setItem('rchat_last_dm' + suffix, '16')
        storage.setItem(
          'rchat_p2p:alice' + (own ? '' : '@' + origin),
          JSON.stringify({ v: 1, on: enabled })
        )
        let book = parseBook(null)
        expect(storedCredential(conn, book, 'alice')).toBeNull()
        expect(plain(storedCredential(conn, book)?.token)).toBe('first')
        expect(storage.getItem('rchat_token:alice' + suffix)).toBeNull()
        confirmCredential(conn, me('alice'), Secret.of('first'), true)
        book = accountUpdate(conn, me('alice'))(book)
        expect(storage.getItem('rchat_token:alice' + suffix)).toBe('first')
        expect(storage.getItem('rchat_last_dm:alice' + suffix)).toBe('17')
        expect(book.instances[0].accounts[0].identities.length).toBe(Number(enabled))
        confirmCredential(conn, me('bob'), Secret.of('second'), false)
        expect(storage.getItem('rchat_token' + suffix)).toBe('first')
        expect(plain(storedCredential(conn, book, 'bob')?.token)).toBe('second')
        expect(storedCredential(conn, book, null)).toBeNull()
        expect(forgetCredential(conn, 'bob', Secret.of('second'))).toBe(false)
        expect(storage.getItem('rchat_token' + suffix)).toBe('first')
        expect(forgetCredential(conn, 'alice', Secret.of('first'))).toBe(true)
      }
    )
test('same authority with a different origin cannot borrow a credential', () => {
  const first = connection(),
    second = connection('http://alpha.example')
  confirmCredential(first, me('alice'), Secret.of('a'), false)
  expect(storedCredential(second, parseBook(null))).toBeNull()
  confirmCredential(second, me('alice'), Secret.of('b'), false)
  expect(plain(storedCredential(first, parseBook(null), 'alice')?.token)).toBe('a')
  forgetCredential(second, 'alice', Secret.of('b'))
  expect(plain(storedCredential(first, parseBook(null))?.token)).toBe('a')
})
test('storage events and local edits re-read the latest persisted book', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const target = new EventTarget()
  Object.defineProperty(globalThis, 'window', { value: target, configurable: true })
  try {
    const { book, updateBook } = createBookStore()
    const other = addInstance(parseBook(null), { origin, id: 'a', name: 'Remote' })
    storage.setItem('rchat_book', JSON.stringify(other))
    target.dispatchEvent(
      Object.assign(new Event('storage'), { key: 'rchat_book', newValue: 'stale' })
    )
    expect(book.getState()).toEqual(other)
    storage.setItem(
      'rchat_book',
      JSON.stringify({ ...other, instances: [{ ...other.instances[0], name: 'Newest' }] })
    )
    updateBook(b => addInstance(b, { origin: 'https://beta.example', id: 'b', name: 'Second' }))
    expect(book.getState().instances.map(i => i.name)).toEqual(['Newest', 'Second'])
  } finally {
    if (original) Object.defineProperty(globalThis, 'window', original)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})

test('unbound remote alias requires previous exact-origin evidence and a new scope survives cache eviction', () => {
  storage.setItem('rchat_token@alpha.example', 'historical')
  const other = connection('http://alpha.example')
  expect(storedCredential(other, parseBook(null))).toBeNull()
  storage.setItem('rchat_home', origin)
  expect(plain(storedCredential(connection(), parseBook(null))?.token)).toBe('historical')
  confirmCredential(other, me('alice'), Secret.of('new'), false)
  storage.removeItem('rchat_home')
  storage.removeItem('rchat_instances')
  expect(plain(storedCredential(other, parseBook(null), 'alice')?.token)).toBe('new')
  expect(storage.getItem('rchat_token:alice@http://alpha.example')).toBe('new')
  expect(storage.getItem('rchat_token@alpha.example')).toBe('historical')
})

test('concurrent tabs replay their changes against the book held by the browser lock', async () => {
  let queue = Promise.resolve()
  const target = Object.assign(new EventTarget(), {
    navigator: { locks: { request: (_key: string, fn: () => void) => (queue = queue.then(fn)) } },
  })
  const original = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', { value: target, configurable: true })
  try {
    const first = createBookStore(),
      second = createBookStore()
    const a = first.updateBook(b => addInstance(b, { origin, id: 'alpha', name: 'Alpha' }))
    const b = second.updateBook(b =>
      addInstance(b, { origin: 'https://beta.example', id: 'beta', name: 'Beta' })
    )
    expect(first.book.getState().instances.map(i => i.id)).toEqual(['alpha'])
    expect(second.book.getState().instances.map(i => i.id)).toEqual(['beta'])
    await Promise.all([a, b])
    target.dispatchEvent(
      Object.assign(new Event('storage'), { key: 'rchat_book', newValue: 'old' })
    )
    expect(first.book.getState().instances.map(i => i.id)).toEqual(['alpha', 'beta'])
    expect(second.book.getState()).toEqual(first.book.getState())
  } finally {
    if (original) Object.defineProperty(globalThis, 'window', original)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})

test('transferring an empty token alias never transfers the signed-out user’s last DM', () => {
  const conn = connection(origin, true)
  const book = parseBook(null)
  storage.setItem('rchat_token', 'alice-fixture')
  storage.setItem('rchat_last_dm', '17')
  confirmCredential(conn, me('alice'), Secret.of('alice-fixture'), true)
  expect(forgetCredential(conn, 'alice', Secret.of('alice-fixture'))).toBe(true)
  expect(storage.getItem('rchat_last_dm:alice')).toBe('17')
  expect(storage.getItem('rchat_last_dm')).toBeNull()
  confirmCredential(conn, me('bob'), Secret.of('bob-fixture'), false)
  const saved = storedCredential(conn, book)
  expect(plain(saved?.token)).toBe('bob-fixture')
  confirmCredential(conn, me('bob'), Secret.of('bob-fixture'), true)
  expect(storage.getItem('rchat_last_dm:bob')).toBeNull()
})

test('blocked browser coordination rolls back optimistic admissions and retains the durable book', async () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const blocked = new EventTarget() as IDBOpenDBRequest
  const page = Object.assign(new EventTarget(), {
    document: {},
    navigator: {},
    indexedDB: { open: () => blocked },
  })
  Object.defineProperty(globalThis, 'window', { configurable: true, value: page })
  try {
    const old = addInstance(parseBook(null), { origin, id: 'saved', name: 'Saved' })
    storage.setItem('rchat_book', JSON.stringify(old))
    const add = (b: typeof old) =>
      addInstance(b, { origin: 'https://beta.example', id: 'new', name: 'New' })
    const first = createBookStore()
    let readOnly = false
    const update = first.updateBook(add, () => {
      readOnly = true
    })
    expect(first.book.getState().instances).toHaveLength(2)
    blocked.onblocked!.call(blocked, new Event('blocked') as IDBVersionChangeEvent)
    expect(await update).toEqual(old)
    expect(readOnly).toBe(true)
    expect(first.book.getState()).toEqual(old)
    expect(JSON.parse(storage.getItem('rchat_book')!)).toEqual(old)
    // Denied localStorage plus no IDB/Web Locks leaves each tab its own volatile book.
    Reflect.deleteProperty(page, 'indexedDB')
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new DOMException('Restricted', 'SecurityError')
      },
    })
    const isolated = createBookStore()
    expect((await isolated.updateBook(add)).instances).toHaveLength(1)
    expect(isolated.book.getState().instances[0].id).toBe('new')
    expect(createBookStore().book.getState().instances).toEqual([])
  } finally {
    if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage)
    else Reflect.deleteProperty(globalThis, 'localStorage')
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})

test('client-only home requires a credential scoped to the selected remote or a remembered guest', () => {
  const previousMode = process.env.NEXT_PUBLIC_CLIENT_ONLY
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { localStorage: storage, location: new URL('https://app.example') },
  })
  try {
    process.env.NEXT_PUBLIC_CLIENT_ONLY = 'true'
    const book = parseBook(null)
    const homeWith = (entries: Record<string, string>) => {
      storage.clear()
      storage.setItem('rchat_home', origin)
      for (const [key, value] of Object.entries(entries)) storage.setItem(key, value)
      return createInstanceRegistry(book).home
    }
    expect(homeWith({}).isDefault).toBe(true)
    expect(homeWith({ 'rchat_guest@alpha.example': '0' }).isDefault).toBe(true)
    expect(homeWith({ 'rchat_guest@alpha.example': '1' }).origin).toBe(origin)
    for (const key of ['rchat_token@alpha.example', 'rchat_token:alice@alpha.example']) {
      const home = homeWith({ [key]: 'offline-token' })
      expect(home.origin).toBe(origin)
      expect(plain(storedCredential(home, book)?.token)).toBe('offline-token')
      expect(
        homeWith({ [key]: 'token', 'rchat_auth_origin@alpha.example': 'http://alpha.example' })
          .isDefault
      ).toBe(true)
    }
    for (const username of ['zoë', 'a b', '名前', 'a/b?c#d']) {
      const key = 'rchat_token:' + username + '@alpha.example'
      const home = homeWith({ [key]: 'qualified-token' })
      expect(home.origin).toBe(origin)
      const saved = storedCredential(home, book)
      expect({ ...saved, token: plain(saved?.token) }).toEqual({
        token: 'qualified-token',
        username,
        key,
      })
      const verified = accountUpdate(home, me(username))(book)
      expect(parseBook(JSON.stringify(verified)).instances[0]?.accounts[0]?.username).toBe(username)
    }
    process.env.NEXT_PUBLIC_CLIENT_ONLY = 'false'
    expect(homeWith({}).origin).toBe(origin)
  } finally {
    if (previousMode === undefined) delete process.env.NEXT_PUBLIC_CLIENT_ONLY
    else process.env.NEXT_PUBLIC_CLIENT_ONLY = previousMode
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})
