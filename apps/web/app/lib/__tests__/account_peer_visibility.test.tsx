import { AccountSession } from '../client/session'
import { peerStorage } from '../client/keys'
import { InstanceConnection, endpointsFrom } from '../instances'
import 'fake-indexeddb/auto'
import { expect, test } from 'bun:test'
import { openDB } from 'idb'
import { renderToStaticMarkup } from 'react-dom/server'
import SettingsMenu from '../../components/settings_menu'
import { AccountProvider } from '../client/react'
import { p2pKey } from '../p2p/app/store'
import type { TypingMsg } from '../typing'
import type { WsEvent } from '../types'
import { me, msg, user } from './fixtures'
import { testAccount } from './test_account'

test('disabled P2P Settings can remove saved slots only for the live signed-in owner', async () => {
  const owner = testAccount('sam', 'https://offline.test')
  const manifestKey = owner.keys.local('rchat_p2p_identities')
  const other = testAccount('sam', 'https://other-offline.test')
  const render = () =>
    renderToStaticMarkup(
      <AccountProvider session={owner}>
        <SettingsMenu />
      </AccountProvider>
    )
  const db = owner.keys.db()!
  const work = owner.keys.db('work')!
  const otherDb = other.keys.db()!
  let disposed = false
  const saved = JSON.stringify({ v: 1, on: true })
  try {
    for (const account of [owner, other]) {
      const state = {
        settings: { ...account.store.getState().settings, p2p: false },
        activeDialog: { kind: 'settings', section: 'p2p' } as const,
      }
      Object.assign(account.store.getInitialState(), state)
      account.store.setState(state)
      localStorage.setItem(peerStorage(account.conn, 'sam').scoped(p2pKey('sam')), saved)
    }
    localStorage.setItem(manifestKey, '["work"]')
    localStorage.setItem(peerStorage(owner.conn, 'sam', 'work').scoped(p2pKey('sam')), saved)
    for (const name of [db, work, otherDb]) (await openDB(name, 1)).close()
    const html = render()
    expect(html).toContain('data-settings-section="p2p" aria-current="page"')
    expect(html).toContain('Remove P2P data from this browser')
    expect(html).toContain('Remove P2P data for work')
    expect(owner.identities.list()).toEqual([])
    const [main, sibling] = owner.identities.offlineData()
    expect(await sibling.remove()).toBe(true)
    expect((await indexedDB.databases()).map(d => d.name)).not.toContain(work)
    expect(render()).not.toContain('Remove P2P data for work')
    expect(owner.identities.list()).toEqual([])

    owner.store.setState({ guest: true })
    Object.assign(owner.store.getInitialState(), { guest: true })
    expect(render()).not.toContain('data-settings-section="p2p"')
    expect(await main.remove()).toBe(false)
    owner.store.setState({ guest: false, me: null })
    expect(owner.identities.offlineData()).toEqual([])
    owner.store.setState({ me: me('sam') })
    owner.lifetime.endSession()
    expect(await main.remove()).toBe(false)
    const [beforeDisposal] = owner.identities.offlineData()
    owner.store.dispose()
    disposed = true
    expect(await beforeDisposal.remove()).toBe(false)
    const names = (await indexedDB.databases()).map(d => d.name)
    expect(names).toContain(db)
    expect(names).toContain(otherDb)
    expect(localStorage.getItem(peerStorage(other.conn, 'sam').scoped(p2pKey('sam')))).toBe(saved)
  } finally {
    if (!disposed) owner.store.dispose()
    other.store.dispose()
    for (const name of [db, work, otherDb]) indexedDB.deleteDatabase(name)
    localStorage.removeItem(peerStorage(owner.conn, 'sam').scoped(p2pKey('sam')))
    localStorage.removeItem(peerStorage(other.conn, 'sam').scoped(p2pKey('sam')))
    localStorage.removeItem(peerStorage(owner.conn, 'sam', 'work').scoped(p2pKey('sam')))
    localStorage.removeItem(manifestKey)
  }
})

test('only the selected peer identity covers its account’s incoming DM and typing', () => {
  const owner = testAccount('sam', 'https://view.test')
  const manifestKey = owner.keys.local('rchat_p2p_identities')
  const other = testAccount('sam', 'https://other-view.test')
  const sent: TypingMsg[] = []
  owner.conn.ws.sendTyping = message => void sent.push(message)
  const event = (id: number): WsEvent => ({
    type: 'message',
    server: null,
    channel_id: null,
    dm_id: 4,
    dm_users: ['sam', 'alice'],
    message: msg(id, { channel_id: null, dm_id: 4, author: user('alice') }),
  })
  try {
    for (const account of [owner, other]) {
      account.store.setState({ view: { kind: 'dm', dmId: 4 }, atBottom: { d4: true } })
      account.identities.setAccount('sam')
      account.store.getState().applyWsEvent(event(10))
      expect(account.store.getState().reads.d4.lastRead).toBe(10)
    }
    const main = owner.identities.get()!
    const sibling = owner.identities.add('work')
    owner.identities.show(sibling)
    sibling.p2p.openHome()
    main.p2p.openHome()
    main.p2p.closeHome()
    expect(owner.store.getState().atBottom.d4).toBe(true)
    owner.store.getState().applyWsEvent(event(11))
    other.store.getState().applyWsEvent(event(11))
    expect(owner.store.getState().reads.d4.lastRead).toBe(10)
    expect(owner.store.getState().notices).toHaveLength(1)
    expect(other.store.getState().reads.d4.lastRead).toBe(11)
    expect(other.store.getState().notices).toHaveLength(0)
    owner.store.getState().noteTyping('d4', true)
    expect(sent).toEqual([])

    owner.identities.show(main)
    expect(owner.store.getState().atBottom.d4).toBe(false)
    expect(owner.store.getState().unreadAnchor.d4).toBe(10)
    owner.store.getState().setAtBottom('d4', true)
    owner.store.getState().applyWsEvent(event(12))
    expect(owner.store.getState().reads.d4.lastRead).toBe(12)
    owner.store.getState().noteTyping('d4', true)
    expect(sent).toEqual([{ type: 'typing', scope: 'd4' }])

    owner.identities.show(sibling)
    owner.store.setState(s => ({ settings: { ...s.settings, p2p: false } }))
    expect(owner.identities.list()).toEqual([])
    expect(owner.store.getState().atBottom.d4).toBe(false)
  } finally {
    owner.store.dispose()
    other.store.dispose()
    localStorage.removeItem(manifestKey)
  }
})

test('private origins keep separate databases, enable flags and identity settings', async () => {
  const first = testAccount('origin-user', 'http://localhost')
  const other = testAccount('origin-user', 'https://localhost')
  const flag = p2pKey('origin-user')
  const historicalFlag = flag + '@localhost'
  const oldDb = 'rchat-p2p:localhost:origin-user'
  const connect = (account: typeof first) => {
    account.store.setState(s => ({ settings: { ...s.settings, p2p: true } }))
    account.identities.setAccount('origin-user')
    return account.identities.get()!
  }
  const saved = '{"v":1,"on":true}'
  localStorage.setItem(historicalFlag, saved)
  ;(await openDB(oldDb, 1)).close()
  const names = [oldDb]
  try {
    const a = connect(first)
    const b = connect(other)
    for (const app of [a, b]) app.writeOn('origin-user', true)
    const aDb = a.dbFor('origin-user')
    const bDb = b.dbFor('origin-user')
    names.push(aDb, bDb)
    expect(new Set(names).size).toBe(3)
    expect(first.keys.db()).toBe(aDb)
    expect(other.keys.db()).toBe(bDb)
    expect(first.keys.local('rchat_p2p_identities')).not.toBe(
      other.keys.local('rchat_p2p_identities')
    )
    for (const name of [aDb, bDb]) (await openDB(name, 1)).close()
    for (const account of [first, other]) {
      account.store.setState(s => ({ settings: { ...s.settings, p2p: false } }))
      account.identities.setAccount(null)
    }
    expect(await first.identities.offlineData()[0]!.remove()).toBe(true)
    expect(first.identities.offlineData()).toEqual([])
    expect(other.identities.offlineData().map(s => s.id)).toEqual(['main'])
    const remaining = (await indexedDB.databases()).map(d => d.name)
    expect(remaining).not.toContain(aDb)
    expect(remaining).toContain(bDb)
    expect(remaining).toContain(oldDb)
    expect(localStorage.getItem(historicalFlag)).toBe(saved)
  } finally {
    first.store.dispose()
    other.store.dispose()
    for (const key of [historicalFlag, flag + '@http://localhost', flag + '@https://localhost'])
      localStorage.removeItem(key)
    for (const name of names) indexedDB.deleteDatabase(name)
  }
})

for (const replacement of [false, true]) {
  test(
    'blocked deletion completes after logout' +
      (replacement ? ' while preserving a new owner write' : ''),
    async () => {
      const user = replacement ? 'replaced' : 'logged-out'
      const account = testAccount(user, 'https://pinned-cleanup.test')
      account.store.setState(s => ({ settings: { ...s.settings, p2p: false } }))
      const flag = peerStorage(account.conn, user).scoped(p2pKey(user))
      const name = account.keys.db()!
      const saved = '{"v":1,"on":true}'
      localStorage.setItem(flag, saved)
      const blocked = Promise.withResolvers<void>()
      const connection = await openDB(name, 1, { blocking: () => blocked.resolve() })
      try {
        const pending = account.identities.offlineData()[0]!.remove()
        await blocked.promise
        account.store.setState({ me: null })
        account.lifetime.endSession()
        const newer = replacement ? openDB(name, 1) : null
        if (replacement) localStorage.setItem(flag, saved)
        connection.close()
        expect(await pending).toBe(true)
        const db = await newer
        db?.close()
        expect(localStorage.getItem(flag)).toBe(replacement ? saved : null)
        const names = (await indexedDB.databases()).map(d => d.name)
        expect(names.includes(name)).toBe(replacement)
        expect(account.identities.list()).toEqual([])
      } finally {
        connection.close()
        account.store.dispose()
        localStorage.removeItem(flag)
        indexedDB.deleteDatabase(name)
      }
    }
  )
}

test('default adoption and the sibling manifest stay pinned independently of later main flags', async () => {
  const user = 'proven-default'
  const flag = p2pKey(user)
  const conn = new InstanceConnection(
    endpointsFrom('http://dev.example.test:8080', null),
    null,
    true
  )
  const remote = testAccount(user, 'https://dev.example.test:8080')
  const manifest = 'rchat_p2p_identities:' + user
  localStorage.setItem(manifest, '["work"]')
  localStorage.setItem(flag, '{"v":1,"on":true}')
  localStorage.setItem(flag + '~work', '{"v":1,"on":true}')
  const owner = new AccountSession(conn)
  try {
    owner.store.setState(s => ({ me: me(user), settings: { ...s.settings, p2p: false } }))
    const main = peerStorage(conn, user)
    const work = peerStorage(conn, user, 'work')
    expect(main.scoped(flag)).toBe(flag)
    expect(main.db).not.toBe(remote.keys.db())
    expect(owner.keys.local('rchat_p2p_identities')).toBe(manifest)
    localStorage.setItem(flag + '@' + conn.host, '{"v":1,"on":true}')
    const reload = new InstanceConnection(endpointsFrom(conn.origin, null), null, true)
    expect(peerStorage(reload, user).db).toBe(main.db)
    expect(peerStorage(reload, user, 'work').db).toBe(work.db)
    expect(owner.identities.offlineData().map(s => s.id)).toEqual(['main', 'work'])
    expect(owner.keys.local('rchat_p2p_identities')).toBe(manifest)
    const remoteStorage = peerStorage(remote.conn, user)
    localStorage.setItem(remoteStorage.scoped(flag), '{"v":1,"on":true}')
    for (const db of [main.db!, remoteStorage.db!]) (await openDB(db, 1)).close()
    remote.store.setState(s => ({ settings: { ...s.settings, p2p: false } }))
    expect(await remote.identities.offlineData()[0]!.remove()).toBe(true)
    expect((await indexedDB.databases()).map(d => d.name)).toContain(main.db)
    expect(localStorage.getItem(flag)).toBe('{"v":1,"on":true}')
    indexedDB.deleteDatabase(main.db!)
  } finally {
    owner.store.dispose()
    remote.store.dispose()
    for (const key of [manifest, flag, flag + '~work', flag + '@' + conn.host])
      localStorage.removeItem(key)
  }
})

test('a DNS trailing dot cannot share a peer database or a destructive operation', async () => {
  const user = 'dotted-origin'
  const owners = ['https://localhost:80', 'https://localhost.:80'].map(origin =>
    testAccount(user, origin)
  )
  const flag = p2pKey(user)
  localStorage.setItem(flag + '@localhost:80', '{"v":1,"on":true}')
  try {
    for (const a of owners) {
      a.store.setState(s => ({ settings: { ...s.settings, p2p: false } }))
      const storage = peerStorage(a.conn, user)
      expect(storage.host).toBe(a.conn.origin)
      localStorage.setItem(storage.scoped(flag), '{"v":1,"on":true}')
      ;(await openDB(storage.db!, 1)).close()
    }
    expect(await owners[0].identities.offlineData()[0]!.remove()).toBe(true)
    expect((await indexedDB.databases()).map(d => d.name)).toContain(owners[1].keys.db())
    expect(owners[1].identities.offlineData().length).toBe(1)
    expect(localStorage.getItem(flag + '@localhost:80')).toBe('{"v":1,"on":true}')
  } finally {
    localStorage.removeItem(flag + '@localhost:80')
    for (const a of owners) {
      const storage = peerStorage(a.conn, user)
      localStorage.removeItem(storage.scoped(flag))
      indexedDB.deleteDatabase(storage.db!)
      a.store.dispose()
    }
  }
})

test('an ambiguous historical main never hides a separately owned work slot at upgrade', async () => {
  const user = 'ambiguous-at-upgrade'
  const primary = new InstanceConnection(
    endpointsFrom('http://dev.example.test:8080', null),
    null,
    true
  )
  const flag = p2pKey(user)
  const manifest = 'rchat_p2p_identities:' + user
  const saved = '{"v":1,"on":true}'
  const legacyDb = 'rchat-p2p:' + primary.host + ':' + user
  localStorage.setItem(manifest, '["work"]')
  localStorage.setItem(flag, saved)
  localStorage.setItem(flag + '@' + primary.host, saved)
  localStorage.setItem(flag + '~work', saved)
  const owner = new AccountSession(primary)
  try {
    owner.store.setState(s => ({ me: me(user), settings: { ...s.settings, p2p: false } }))
    for (const name of [legacyDb, legacyDb + '~work']) (await openDB(name, 1)).close()
    expect(owner.keys.db()).not.toBe(legacyDb)
    expect(owner.keys.db('work')).toBe(legacyDb + '~work')
    const slots = owner.identities.offlineData()
    expect(slots.map(s => s.id)).toEqual(['work'])
    expect(await slots[0].remove()).toBe(true)
    expect((await indexedDB.databases()).map(d => d.name)).toContain(legacyDb)
    expect(localStorage.getItem(flag)).toBe(saved)
  } finally {
    owner.store.dispose()
    for (const name of [legacyDb, legacyDb + '~work']) indexedDB.deleteDatabase(name)
    for (const key of [manifest, flag, flag + '~work', flag + '@' + primary.host])
      localStorage.removeItem(key)
  }
})

for (const remoteFirst of [false, true]) {
  test(`historical main databases on distinct hosts survive ${remoteFirst ? 'remote' : 'default'}-first sign-in`, async () => {
    const user = remoteFirst ? 'legacy-remote-first' : 'legacy-default-first'
    const flag = p2pKey(user)
    const primary = new InstanceConnection(endpointsFrom('http://127.0.0.1:3000', null), null, true)
    const remote = new InstanceConnection(endpointsFrom('https://8.8.4.4', null))
    const saved = '{"v":1,"on":true}'
    const db = (conn: InstanceConnection) => `rchat-p2p:${conn.host}:${user}`
    const accounts = new Map<InstanceConnection, AccountSession>()
    try {
      for (const conn of [primary, remote]) {
        localStorage.setItem(conn.scoped(flag), saved)
        ;(await openDB(db(conn), 1)).close()
      }
      for (const conn of remoteFirst ? [remote, primary] : [primary, remote]) {
        const account = new AccountSession(conn)
        accounts.set(conn, account)
        account.store.setState(s => ({ me: me(user), settings: { ...s.settings, p2p: false } }))
        expect(account.keys.db()).toBe(db(conn))
        expect(account.identities.offlineData().map(slot => slot.id)).toEqual(['main'])
      }
      expect(await accounts.get(remote)!.identities.offlineData()[0]!.remove()).toBe(true)
      const remaining = (await indexedDB.databases()).map(row => row.name)
      expect(remaining).toContain(db(primary))
      expect(remaining).not.toContain(db(remote))
      expect(localStorage.getItem(flag)).toBe(saved)
      expect(
        accounts
          .get(primary)!
          .identities.offlineData()
          .map(slot => slot.id)
      ).toEqual(['main'])
    } finally {
      for (const account of accounts.values()) account.store.dispose()
      for (const conn of [primary, remote]) {
        localStorage.removeItem(conn.scoped(flag))
        indexedDB.deleteDatabase(db(conn))
      }
    }
  })
}
