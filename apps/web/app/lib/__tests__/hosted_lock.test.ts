import { Ended } from '../slices/ctx'
import { testAccount } from './test_account'
import { createPeerFixture } from './peer_fixture'
import { user } from './fixtures'
import { peerLinkRequest } from '../client/peer_links'
import { linkChoice, routeInstanceLink } from '../client/instance_links'
import { attachShare, shareRooms } from '../client/share_target'
import { afterEach, expect, test } from 'bun:test'
import {
  acceptHostedPolicy,
  allowsAccountOrigin,
  canAddInstance,
  createHostedPolicy,
  hostedPolicyRevision,
  hostedLockMessage,
  refreshHostedPolicy,
  visibleBook,
} from '../client/hosted_policy'
import { client } from '../client/client'
import { createSavedSession } from '../client/saved_session'
import { getHomeSession } from '../store'
import { createBookStore } from '../client/book_store'
import { addInstance, parseBook } from '../client/book'
import { accountStorage } from '../client/keys'
import { readLocal, writeLocal, ownInstance } from '../instances'
import { Secret } from '../secret'

const own = ownInstance()!.origin
const beta = 'https://beta.example'
const book = addInstance(
  addInstance(parseBook(null), { origin: own, name: 'Alpha', id: 'alpha' }),
  { origin: beta, name: 'Beta', id: 'beta' }
)
afterEach(() => acceptHostedPolicy(own, true))

test('only fresh settings from the hosted origin change visibility; storage writes retain hidden rows', () => {
  acceptHostedPolicy(own, true)
  const previous = hostedPolicyRevision()
  const books = createBookStore(visibleBook)
  books.updateBook(() => book)
  acceptHostedPolicy(beta, false)
  expect(canAddInstance()).toBe(true)
  acceptHostedPolicy(own, false)
  acceptHostedPolicy(own, true, previous)
  expect(allowsAccountOrigin(beta)).toBe(false)
  expect(allowsAccountOrigin(own)).toBe(true)
  books.refreshBook()
  expect(books.book.getState().instances.map(i => i.name)).toEqual(['Alpha'])
  books.updateBook(current => ({
    ...current,
    instances: current.instances.map(i => (i.origin === own ? { ...i, name: 'Alpha 2' } : i)),
  }))
  acceptHostedPolicy(own, true)
  books.refreshBook()
  expect(books.book.getState().instances.map(i => i.name)).toEqual(['Alpha 2', 'Beta'])
})
test('first settings republish the book when another tab updated the cache after initialization', () => {
  const key = 'rchat_hosted_lock@' + own
  const previous = readLocal(key)
  try {
    for (const allowed of [false, true]) {
      writeLocal(key, allowed ? '1' : null)
      const policy = createHostedPolicy()
      const books = createBookStore(policy.visibleBook)
      books.updateBook(() => book)
      expect(books.book.getState().instances.length).toBe(allowed ? 1 : 2)
      let changes = 0
      policy.watchHostedPolicy(() => {
        changes++
        books.refreshBook()
      })
      writeLocal(key, allowed ? null : '1')
      policy.acceptHostedPolicy(own, allowed)
      expect(books.book.getState().instances.length).toBe(allowed ? 2 : 1)
      policy.acceptHostedPolicy(own, allowed)
      expect(changes).toBe(1)
    }
  } finally {
    writeLocal(key, previous)
  }
})

test('client-only builds ignore the hosted switch and never probe the page host', async () => {
  const old = process.env.NEXT_PUBLIC_CLIENT_ONLY
  try {
    process.env.NEXT_PUBLIC_CLIENT_ONLY = 'true'
    const previous = hostedPolicyRevision()
    acceptHostedPolicy(own, false)
    await refreshHostedPolicy()
    expect(hostedPolicyRevision()).toBe(previous)
    expect(canAddInstance()).toBe(true)
    expect(visibleBook(book)).toBe(book)
  } finally {
    if (old === undefined) delete process.env.NEXT_PUBLIC_CLIENT_ONLY
    else process.env.NEXT_PUBLIC_CLIENT_ONLY = old
  }
})

test('native shells disregard other-instance settings even without the static build flag', async () => {
  const old = Object.getOwnPropertyDescriptor(globalThis, 'window')
  try {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { __RCHAT_DESKTOP__: { os: 'android', version: 'test' } },
    })
    const before = hostedPolicyRevision()
    acceptHostedPolicy(own, false)
    await refreshHostedPolicy()
    expect(hostedPolicyRevision()).toBe(before)
    expect(canAddInstance()).toBe(true)
    expect(visibleBook(book)).toBe(book)
  } finally {
    if (old) Object.defineProperty(globalThis, 'window', old)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})

test('a locked account relinquishes its live session and call while own accounts remain selectable', async () => {
  const home = getHomeSession()
  const sibling = createSavedSession(own, 'second')
  const remote = createSavedSession(beta, 'traveler')
  let left = false
  const key = accountStorage(remote.conn).token('traveler')
  const previous = readLocal(key)
  try {
    writeLocal(key, 'fixture-login')
    remote.api.setToken(Secret.of('fixture-login'))
    remote.api.setGrants({ garden: Secret.of('fixture-grant') })
    remote.store.setState({
      token: Secret.of('fixture-login'),
      guestGrants: { garden: 'fixture-grant' },
    })

    expect(client.show(remote, 'none')).toBe(true)
    const claim = await client.calls.request(
      { account: remote, identity: 'work', kind: 'p2p-call' },
      () => {
        left = true
      },
      () => true
    )
    expect(claim?.current()).toBe(true)
    acceptHostedPolicy(own, false)
    expect(client.live()).not.toContain(remote)
    expect(client.show(remote, 'none')).toBe(false)
    expect(claim?.current()).toBe(false)
    expect(left).toBe(true)
    expect(remote.api.hasToken(Secret.of('fixture-login'))).toBe(false)
    expect(remote.api.guestMedia('garden')).toBe(false)
    expect(remote.store.getState().token).toBeNull()
    expect(remote.store.getState().guestGrants).toEqual({})
    expect(readLocal(key)).toBe('fixture-login')
    expect(client.show(sibling, 'none')).toBe(true)
    acceptHostedPolicy(own, true)
    expect(client.show(remote, 'none')).toBe(false)
  } finally {
    acceptHostedPolicy(own, true)
    writeLocal(key, previous)
    client.show(home, 'none')
    for (const account of [remote, sibling])
      if (client.live().includes(account)) account.store.dispose()
  }
})

test('revoking access retires the foreign link chooser, peer identity and pending attachment', async () => {
  const source = testAccount('sam', own)
  const remote = testAccount('sam', beta)
  const second = testAccount('second', beta)
  const file = new File(['private fixture'], 'test.txt')
  const wait = Promise.withResolvers<void>()
  try {
    client.show(source, 'none')
    const localApp = createPeerFixture(source, 'sam'),
      remoteApp = createPeerFixture(remote, 'sam')
    for (const app of [localApp, remoteApp]) app.useP2p.setState({ enabled: true, account: 'sam' })
    const request = peerLinkRequest(source, { kind: 'invite' }, null)!
    expect(request.valid(remoteApp)).toBe(true)
    const audience = source.invites.watch(beta).snapshot()
    remote.store.setState(s => ({
      settings: { ...s.settings, asset_uploads: true },
      dms: [{ id: 7, is_self: false, other: user('recipient') }],
      openDm: async id => {
        await wait.promise
        remote.store.setState({ view: { kind: 'dm', dmId: id } })
      },
    }))
    const owner = { account: remote, identity: null }
    const dm = shareRooms(owner, [file]).find(r => r.kind === 'dm')!
    const pending = attachShare(owner, dm.key, { files: [file], text: 'fixture' }, () => true)
    client.show(source, 'none')
    const routing = routeInstanceLink(source, { origin: beta, path: '/invite/test/' })
    const dialog = source.store.getState().activeDialog
    expect(dialog?.kind).toBe('instance_link')
    acceptHostedPolicy(own, false)
    expect(source.store.getState().activeDialog).toBeNull()
    if (dialog?.kind === 'instance_link') dialog.accept('second', true)
    await routing
    expect(request.valid(remoteApp)).toBe(false)
    expect(request.valid(localApp)).toBe(true)
    expect(audience.current()).toBe(false)
    expect(linkChoice(source, beta).users).toEqual([])
    expect(shareRooms(owner, [file])).toEqual([])
    wait.resolve()
    expect(await pending).toBe(false)
    expect(remote.store.getState().pending.d7).toBeUndefined()
    await routeInstanceLink(source, { origin: beta, path: '/dm/7/' })
    expect(source.store.getState().error).toBe(hostedLockMessage())
  } finally {
    wait.resolve()
    acceptHostedPolicy(own, true)
    for (const account of [source, remote, second]) account.store.dispose()
  }
})

test('a locked remote invite preview uses anonymous discovery and metadata, independent of the saved account', async () => {
  const source = testAccount('sam', own)
  const saved = testAccount('sam', beta)
  const previous = globalThis.fetch
  const calls: string[] = []
  try {
    saved.api.setToken(Secret.of('fixture-only'))
    acceptHostedPolicy(own, false)
    globalThis.fetch = (async (url, init) => {
      const path = new URL(String(url)).pathname
      expect(new URL(String(url)).origin).toBe(beta)
      expect(new Headers(init?.headers).has('Authorization')).toBe(false)
      expect(init?.credentials).toBe('omit')
      calls.push(path)
      return Response.json(
        path === '/api/instance'
          ? {
              software: 'rchat',
              id: 'beta',
              name: 'Beta',
              host: new URL(beta).host,
              public_url: beta,
              api_url: beta + '/api',
              ws_url: 'wss://' + new URL(beta).host + '/api/ws',
              api_version: '1.0',
              features: {},
            }
          : { server: { name: 'club' } }
      )
    }) as typeof fetch
    const audience = source.invites.watch(beta).snapshot()
    expect(
      await audience.read(saved.conn, 'club', null, 'metadata').then(
        () => false,
        error => error instanceof Ended
      )
    ).toBe(true)
    expect((await source.invites.remoteInvite(beta, 'club', null)).server.name).toBe('club')
    expect(calls).toEqual(['/api/instance', '/api/invites/club/metadata'])
    expect(client.live()).not.toContain(saved)
  } finally {
    globalThis.fetch = previous
    acceptHostedPolicy(own, true)
    source.store.dispose()
    saved.store.dispose()
  }
})
