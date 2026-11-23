import { afterEach, expect, test } from 'bun:test'
import { client } from '../client/client'
import { accountHistoryState, routeOwnerFor, selectPageAccount } from '../client/account_paths'
import {
  addAccount,
  addInstance,
  parseBook,
  removeInstance,
  setGuest,
  type Book,
} from '../client/book'
import { defaultEndpoints } from '../instances'
import { getHomeSession } from '../store'
import { me } from './fixtures'

function instance(book: Book, origin: string, usernames: string[]) {
  let next = addInstance(book, { id: origin, name: 'Test', origin })
  for (const username of usernames) {
    next = addAccount(
      next,
      origin,
      {
        username,
        display: null,
        avatar: null,
        identities: [],
        added: 0,
        connect: true,
      },
      defaultEndpoints().origin
    )
  }
  return next
}

const restore: Array<() => void> = []
afterEach(() => {
  while (restore.length) restore.pop()?.()
})
function fixture() {
  const home = getHomeSession()
  const shown = client.shown()
  const previous = client.book.getState()
  const live = new Set(client.live())
  const oldTarget = home.credentialTarget
  restore.push(() => {
    client.show(shown, 'none')
    for (const account of client.live()) if (!live.has(account)) account.store.dispose()
    home.credentialTarget = oldTarget
    client.book.setState(previous, true)
  })
  return home
}

test('ambiguous account paths require an exact known origin in the history entry', () => {
  const home = fixture()
  const a = 'http://localhost:51427'
  const b = 'https://localhost:51427'
  let book = instance(instance(parseBook(null), a, ['reader']), b, ['reader'])
  client.book.setState(book, true)
  const path = '/@reader@localhost:51427/dm/1/'
  const history = { acct: 'reader@localhost:51427', rchatOrigin: a }
  const before = client.live().length
  expect(selectPageAccount(path, null)).toBeNull()
  expect(selectPageAccount(path, { ...history, acct: 'another@localhost:51427' })).toBeNull()
  expect(selectPageAccount(path, { ...history, rchatOrigin: 'http://removed.test' })).toBeNull()
  expect(client.live().length).toBe(before)
  const observed: (string | null | undefined)[] = []
  const off = client.subscribe(() => {
    const attaching = client.live().find(account => account.conn.origin === a)
    if (attaching) observed.push(attaching.credentialTarget)
  })
  const first = selectPageAccount(path, history)
  off()
  expect(first?.conn.origin).toBe(a)
  expect(observed[0]).toBe('reader')
  const second = selectPageAccount(path, { ...history, rchatOrigin: b })
  expect(second?.conn.origin).toBe(b)
  expect(first?.api === second?.api).toBe(false)
  expect(selectPageAccount(path, history)).toBe(first)
  client.show(home, 'none')
  first?.store.dispose()
  book = removeInstance(book, a)
  client.book.setState(book, true)
  expect(selectPageAccount(path, history)).toBeNull()
  expect(client.shown()).toBe(home)
  expect(client.canWritePage(home)).toBe(false)
  expect(selectPageAccount(path, null)).toBe(second)
  if (second) expect(client.canWritePage(second)).toBe(true)
})

test('named, guest and primary paths select separate stores and record their own history', () => {
  fixture()
  const own = defaultEndpoints().origin
  const target = 'https://route-owner.example'
  const book = setGuest(
    instance(instance(parseBook(null), own, ['reader', 'second']), target, ['reader']),
    target,
    true
  )
  client.book.setState(book, true)
  const primary = selectPageAccount('/dm/1/', null)
  expect(primary?.conn.origin).toBe(own)
  expect(primary?.credentialTarget ?? primary?.store.getState().me?.username).toBe('reader')
  if (!primary) throw new Error('Missing primary account')
  expect(routeOwnerFor(primary)).toBeNull()
  const remote = selectPageAccount('/@reader@route-owner.example/dm/1/', null)
  if (!remote) throw new Error('Missing secondary account')
  remote.store.setState({ me: me('reader'), view: { kind: 'dm', dmId: 1 } })
  const guest = selectPageAccount('/@route-owner.example/', null)
  if (!guest) throw new Error('Missing guest')
  expect(guest.credentialTarget).toBeNull()
  expect(guest === remote).toBe(false)
  expect(accountHistoryState(guest, { saved: 3 })).toEqual({
    saved: 3,
    acct: '~guest@route-owner.example',
    rchatOrigin: target,
  })
  expect(selectPageAccount('/@absent@route-owner.example/dm/1/', null)).toBeNull()
  expect(client.shown()).toBe(guest)
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const location = new URL('/', own)
  const entries: unknown[] = []
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      location,
      history: {
        pushState(state: unknown, _: string, path: string) {
          entries.push(state)
          location.href = new URL(path, location).href
        },
      },
    },
  })
  try {
    expect(client.show(remote)).toBe(true)
    expect(location.pathname).toBe('/@reader@route-owner.example/dm/1/')
    expect(entries).toEqual([{ acct: 'reader@route-owner.example', rchatOrigin: target }])
    expect(selectPageAccount('/dm/1/', accountHistoryState(primary, null))).toBe(primary)
    expect(selectPageAccount(location.pathname, entries[0])).toBe(remote)
    expect(selectPageAccount('/dm/1/', entries[0])).toBeNull()
    expect(client.shown()).toBe(remote)
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'window', descriptor)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})
