import 'fake-indexeddb/auto'
import { expect, test } from 'bun:test'
import {
  moveIdentity,
  setConnected,
  setIdentityBackground,
  type Book,
  type BookAccount,
} from '../client/book'
import {
  liveSwitcherRows,
  moveSwitcherRow,
  signOutSwitcherAccount,
  switcherRows,
} from '../client/switcher_rows'
import { switchActor } from '../client/switch_actor'
import { blank, accept, ignore } from '../p2p/contacts'
import { me, memoryStorage } from './fixtures'
import { client } from '../client/client'
import { accountStorage } from '../client/keys'
import { testAccount } from './test_account'

const alpha = 'https://alpha.test'
const beta = 'https://beta.test'
const alice: BookAccount = {
  username: 'alice',
  display: 'Alice',
  avatar: null,
  added: 1,
  connect: true,
  identities: ['main', 'work'].map(local => ({
    local,
    ik: local + '-key',
    name: local,
    added: 1,
    background: true,
  })),
}
const book: Book = {
  v: 1,
  instances: [
    {
      origin: alpha,
      id: 'a',
      name: 'Alpha',
      accounts: [alice, { ...alice, username: 'bob', identities: [] }],
      guest: true,
    },
    { origin: beta, id: 'b', name: 'Beta', accounts: [alice], guest: false },
    { origin: 'https://public.test', id: 'pub', name: 'Public', accounts: [], guest: false },
  ],
}
const seat = (origin: string, local: string | null = null) => ({ origin, username: 'alice', local })

test('rows follow book order, preserve signed-out accounts and their identities, and skip discovery-only entries', () => {
  const model = switcherRows(book, [], null)
  expect(model.groups.map(g => g.name)).toEqual(['Alpha', 'Beta'])
  expect(model.groups[0].rows.map(r => [r.username, r.local, r.status])).toEqual([
    ['alice', null, 'Signed out'],
    ['alice', 'main', 'Signed out'],
    ['alice', 'work', 'Signed out'],
    ['bob', null, 'Signed out'],
    [null, null, 'Read only'],
  ])
  expect(model.otherBadge).toBe(0)
})

test('the other-accounts badge excludes only the acting row, including when it is a peer identity', () => {
  const snapshots = [
    { ...seat(alpha), status: 'Appear offline', badge: 3, unread: false },
    { ...seat(alpha, 'work'), status: 'Online', badge: 4, unread: true },
    { ...seat(beta), status: 'Connecting', badge: 5, unread: true },
    { ...seat(beta, 'work'), status: 'Paused', badge: 7, unread: false },
  ] as const
  const account = switcherRows(book, snapshots, seat(alpha))
  expect(account.otherBadge).toBe(16)
  const peer = switcherRows(book, snapshots, seat(alpha, 'work'))
  expect(peer.otherBadge).toBe(15)
  expect(
    peer.groups.flatMap(g => g.rows.filter(r => r.active)).map(r => [r.origin, r.local])
  ).toEqual([[alpha, 'work']])
  expect(peer.groups[1].rows[2].active).toBe(false)
  expect(peer.groups[1].rows[1].status).toBe('Paused')
})

test('reorder and connection preference updates are limited to the chosen instance, account and identity', () => {
  let changed = moveIdentity(book, beta, 'alice', 'work', 0)
  changed = setIdentityBackground(changed, beta, 'alice', 'work', false)
  changed = setConnected(changed, beta, 'alice', false)
  expect(changed.instances[0]).toEqual(book.instances[0])
  const entry = changed.instances[1].accounts[0]
  expect(entry.connect).toBe(false)
  expect(entry.identities.map(i => [i.local, i.background])).toEqual([
    ['work', false],
    ['main', true],
  ])
  expect(book.instances[1].accounts[0].identities[0].local).toBe('main')
})

test('signing out a parked account revokes its own credential and retains both book rows', () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const data = new Map<string, string>()
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      get length() {
        return data.size
      },
      key: (i: number) => Array.from(data.keys())[i] ?? null,
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => data.set(k, v),
      removeItem: (k: string) => data.delete(k),
    },
  })
  const previous = client.book.getState()
  const shown = client.shown()
  const a = testAccount('alice', alpha)
  const b = testAccount('alice', beta)
  const sent: string[] = []
  try {
    const ka = accountStorage(a.conn)
    const kb = accountStorage(b.conn)
    data.set(ka.token('alice'), 'alpha-fixture')
    data.set(kb.token('alice'), 'beta-fixture')
    data.set(kb.key('rchat_token'), 'beta-fixture')
    a.store.setState({ token: 'alpha-fixture' })
    b.store.setState({ me: null, token: null })
    b.credentialTarget = 'alice'
    b.mode = 'parked'
    b.api.logout = async token => {
      sent.push(token)
      return { ok: true }
    }
    client.book.setState(book, true)
    client.show(a, 'none')
    signOutSwitcherAccount(beta, 'alice')
    expect(sent).toEqual(['beta-fixture'])
    expect(data.get(ka.token('alice'))).toBe('alpha-fixture')
    expect(data.has(kb.token('alice'))).toBe(false)
    expect(data.has(kb.key('rchat_token'))).toBe(false)
    expect(client.shown()).toBe(a)
    expect(client.book.getState()).toEqual(book)
  } finally {
    client.show(shown, 'none')
    a.store.dispose()
    b.store.dispose()
    client.book.setState(previous, true)
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor)
    else Reflect.deleteProperty(globalThis, 'localStorage')
  }
})

test('reordering targets the visible neighbor across discovery-only entries', () => {
  const [a, b, hidden] = book.instances
  for (const instances of [
    [hidden, a, b],
    [a, hidden, b],
  ]) {
    const start = { ...book, instances }
    for (const [from, to] of [
      [alpha, beta],
      [beta, alpha],
    ]) {
      const moved = moveSwitcherRow(start, { origin: from }, { origin: to })
      expect(switcherRows(moved, [], null).groups.map(g => g.origin)).toEqual([beta, alpha])
      expect(moved.instances).toContain(hidden)
    }
  }
})

test('a delayed parent bootstrap cannot select an earlier sibling or reopen its settings', async () => {
  const previous = client.book.getState()
  const shown = client.shown()
  const a = testAccount('alice', alpha)
  a.credentialTarget = 'alice'
  const wait = Promise.withResolvers<void>()
  const selected: string[] = []
  try {
    client.book.setState(book, true)
    a.store.setState({ me: null, token: 'token', bootstrap: () => wait.promise })
    const rows = liveSwitcherRows().groups[0].rows
    const pending = switchActor(rows[1], a, () => selected.push('main'))
    a.store.setState({ me: me('alice'), settings: { ...a.store.getState().settings, p2p: true } })
    a.identities.setAccount('alice')
    a.identities.add('work')
    await switchActor(rows[2], a)
    wait.resolve()
    await pending
    expect(a.identities.viewed()?.localId).toBe('work')
    expect(a.identities.coversView()).toBe(true)
    expect(selected).toEqual([])

    const retry = Promise.withResolvers<void>()
    a.store.setState({ me: null, bootstrap: () => retry.promise })
    const dialing = switchActor(rows[1], a, () => selected.push('main'))
    a.store.setState({ me: me('alice') })
    // Opening a peer conversation can explicitly reselect the current identity.
    a.identities.show(a.identities.get('work')!)
    retry.resolve()
    await dialing
    expect(a.identities.viewed()?.localId).toBe('work')
    expect(selected).toEqual([])

    const teardown = Promise.withResolvers<void>()
    a.store.setState({ me: null, bootstrap: () => teardown.promise })
    const ending = switchActor(rows[0], a, () => selected.push('retired'))
    a.store.retireCredentials()
    teardown.resolve()
    await ending
    expect(selected).toEqual([])
  } finally {
    client.show(shown, 'none')
    a.store.dispose()
    client.book.setState(previous, true)
    memoryStorage.clear()
  }
})

test('incoming requests stay on their identity across parking and clear on resolution or deletion', async () => {
  const previous = client.book.getState()
  const shown = client.shown()
  const a = testAccount('alice', alpha)
  const b = testAccount('alice', beta)
  try {
    client.book.setState(book, true)
    client.show(a, 'none')
    for (const owner of [a, b]) {
      owner.store.setState({
        token: 'token',
        settings: { ...owner.store.getState().settings, p2p: true },
      })
      owner.identities.setAccount('alice')
      owner.identities.add('work')
    }
    const work = a.identities.get('work')!
    const incoming = { ...blank('sender', 1), state: 'incoming' as const }
    const mirror = (contacts: ReturnType<typeof blank>[]) =>
      work.useP2p.setState({ enabled: true, me: 'work-key', account: 'alice', contacts })
    const badges = () => {
      const model = liveSwitcherRows()
      return [
        model.otherBadge,
        ...model.groups.flatMap(g =>
          g.rows.filter(r => r.badge).map(r => [r.origin, r.local, r.badge])
        ),
      ]
    }
    const pending = [1, [alpha, 'work', 1]]
    mirror([incoming])
    expect(badges()).toEqual(pending)
    work.park()
    expect(work.useP2p.getState().contacts).toEqual([])
    expect(badges()).toEqual(pending)
    for (const resolve of [accept, ignore]) {
      mirror([incoming])
      expect(badges()).toEqual(pending)
      mirror([resolve(incoming)])
      work.park()
      expect(badges()).toEqual([0])
    }
    mirror([incoming])
    a.identities.show(work)
    work.p2p.openHome()
    expect(badges()).toEqual([0, [alpha, 'work', 1]])
    work.park()
    expect(await work.p2p.removeData('alice')).toBe(true)
    expect(badges()).toEqual([0])
  } finally {
    client.show(shown, 'none')
    a.store.dispose()
    b.store.dispose()
    client.book.setState(previous, true)
    memoryStorage.clear()
  }
})
