import { peerStorage } from '../client/keys'
import type { IdentityOptions } from '../p2p/identity_scope'
import { expect, test } from 'bun:test'
import { client } from '../client/client'
import { createP2pApp } from '../p2p/app/runtime'
import { endpointsFrom, readLocal, writeLocal } from '../instances'
import { dumpBytes, parseDump, summarize } from '../p2p/transfer'
import { P2pStore, removeP2pDb } from '../p2p/db'
import { webLeaderDeps, type LeaderDeps } from '../p2p/leader'
import { drain, memoryStorage } from './fixtures'
import { Hub, makeNode, waitFor } from './p2p_net'
import { testAccount } from './test_account'

test('the main identity reads historical storage and a sibling writes its own settings', async () => {
  const user = 'sam'
  memoryStorage.setItem('rchat_p2p:sam@8.8.8.8', '{"v":1,"on":true}')
  const account = testAccount(user, 'https://8.8.8.8')
  const main = createP2pApp(account, 'main')
  const sibling = createP2pApp(account, 'work')
  const scoped = (key: string) => account.conn.scoped(key)
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const session = new Map<string, string>([[scoped('rchat_p2p_home'), user]])
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      sessionStorage: {
        getItem: (key: string) => session.get(key) ?? null,
        setItem: (key: string, value: string) => session.set(key, value),
        removeItem: (key: string) => session.delete(key),
      },
    },
  })
  try {
    expect(main.dbFor(user)).toBe('rchat-p2p:8.8.8.8:sam')
    expect(sibling.dbFor(user)).toBe('rchat-p2p:https://8.8.8.8:sam~work')
    // Set the signed-in views without booting a node for the already-enabled main identity.
    for (const app of [main, sibling]) app.useP2p.setState({ account: user })
    memoryStorage.setItem(scoped('rchat_p2p:sam'), '{"v":1,"on":true}')
    memoryStorage.setItem(scoped('rchat_p2p_imports:sam'), '{"v":1,"ids":["old-transfer"]}')
    memoryStorage.setItem(scoped('rchat_p2p_auto:sam'), '{"v":1,"dm":0}')
    memoryStorage.setItem(scoped('rchat_p2p_layout:sam'), '{"v":2,"servers":["existing"]}')

    expect(main.p2p.hasData(user)).toBe(true)
    expect(sibling.p2p.hasData(user)).toBe(false)
    expect(main.readHome(user)).toBe(true)
    expect(sibling.readHome(user)).toBe(false)
    sibling.writeHome(user)
    main.writeHome(null)
    expect(sibling.readHome(user)).toBe(true)
    expect(session.has(scoped('rchat_p2p_home'))).toBe(false)

    sibling.writeOn(user, true)
    main.writeOn(user, false)
    expect(sibling.p2p.hasData(user)).toBe(true)
    expect(memoryStorage.getItem(scoped('rchat_p2p:sam'))).toBeNull()
    sibling.rememberImport(user, 'work-transfer')
    expect(main.readImports(user)).toEqual(['old-transfer'])
    expect(sibling.readImports(user)).toEqual(['work-transfer'])

    const nonzero = sibling.autoChoices().dm.find(size => size > 0)!
    sibling.p2pFiles.writeAuto({ dm: nonzero })
    expect(main.p2pFiles.readAuto().dm).toBe(0)
    expect(sibling.p2pFiles.readAuto().dm).toBe(nonzero)
    sibling.p2pRail.apply(['work-room'])
    for (const app of [main, sibling]) app.p2pRail.reload()
    expect(main.useP2p.getState().layout.servers).toEqual(['existing'])
    expect(sibling.useP2p.getState().layout.servers).toEqual(['work-room'])
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
    else Reflect.deleteProperty(globalThis, 'window')
    await main.dispose()
    await sibling.dispose()
    account.store.dispose()
    for (let i = memoryStorage.length - 1; i >= 0; i--) {
      const key = memoryStorage.key(i)
      if (key?.includes('@8.8.8.8')) memoryStorage.removeItem(key)
    }
  }
})

test('removing a sibling preserves the historical main identity across sign-in', async () => {
  const user = 'sam'
  memoryStorage.setItem('rchat_p2p:sam@8.8.4.4', '{"v":1,"on":true}')
  const account = testAccount(user, 'https://8.8.4.4')
  account.discovery.done()
  const hub = new Hub()
  const historicalDb = 'rchat-p2p:8.8.4.4:sam'
  const seed = await makeNode(hub, 'Before upgrade', { db: historicalDb, host: account.conn.host })
  const original = seed.node.ik
  seed.node.stop()
  seed.store.close()
  const options = {
    transport: () => hub.transport(),
    leaderDeps: () => ({ ...webLeaderDeps(), locks: null, channel: () => null }),
  }
  const main = createP2pApp(account, 'main', options)
  const sibling = createP2pApp(account, 'work', options)
  try {
    memoryStorage.setItem(account.conn.scoped('rchat_p2p:sam'), '{"v":1,"on":true}')
    await main.p2pAccount(user)
    await sibling.p2pAccount(user)
    await sibling.p2p.enable('Work')
    await waitFor(
      () => main.node?.status === 'online' && sibling.node?.status === 'online',
      'both identities'
    )
    expect(main.node!.ik).toBe(original)
    expect(sibling.node!.ik).not.toBe(original)
    expect(await sibling.p2p.removeData()).toBe(true)
    expect(sibling.p2p.hasData(user)).toBe(false)
    expect(main.p2p.hasData(user)).toBe(true)
    expect(hub.online(main.node!.peerId)).toBe(true)

    await main.p2pAccount(null)
    await main.p2pAccount(user)
    await waitFor(() => main.node?.status === 'online', 'main identity to reopen')
    expect(main.node!.ik).toBe(original)
    expect(main.useP2p.getState().name).toBe('Before upgrade')
  } finally {
    await main.dispose()
    await sibling.dispose()
    memoryStorage.removeItem(account.conn.scoped('rchat_p2p:sam'))
    memoryStorage.removeItem(account.conn.scoped('rchat_p2p:sam~work'))
    await Promise.all([removeP2pDb(historicalDb), removeP2pDb(sibling.dbFor(user))])
    account.store.dispose()
  }
}, 60_000)

test('two factories exchange a DM and disposing the sender releases only its resources', async () => {
  const alice = testAccount('alice', 'https://identity-chat.test')
  const bob = testAccount('bob', alice.conn.origin)
  alice.discovery.done()
  bob.discovery.done()
  const hub = new Hub()
  const held = new Set<string>()
  const channels = new Set<string>()
  const leaderDeps = (): LeaderDeps => ({
    ...webLeaderDeps(),
    locks: {
      async request(name, _opts, callback) {
        if (held.has(name)) throw new Error('unexpected lock contention: ' + name)
        held.add(name)
        try {
          return await callback({ name })
        } finally {
          held.delete(name)
        }
      },
    },
    channel(name) {
      channels.add(name)
      return { onmessage: null, postMessage() {}, close: () => void channels.delete(name) }
    },
  })
  const options = { transport: () => hub.transport(), leaderDeps }
  const a = createP2pApp(alice, 'main', options)
  const b = createP2pApp(bob, 'work', options)
  const aDb = a.dbFor('alice')
  const bDb = b.dbFor('bob')
  const shown = client.shown
  let senderDisposed = false
  try {
    client.shown = () => bob
    await a.p2pAccount('alice')
    await a.p2p.enable('Alice')
    client.shown = () => alice
    await b.p2pAccount('bob')
    await b.p2p.enable('Bob')
    await waitFor(
      () => a.node?.status === 'online' && b.node?.status === 'online',
      'both listeners'
    )
    const sender = a.node!
    const recipient = b.node!
    expect(sender.ik).not.toBe(recipient.ik)
    expect(a.callRtc).not.toBe(b.callRtc)
    expect([...held].sort()).toEqual([aDb, bDb].sort())
    for (const db of [aDb, bDb]) {
      expect(channels.has(db + ':leader')).toBe(true)
      expect(channels.has(db + ':data')).toBe(true)
    }

    alice.relays.consent = async () => 'alice-relay'
    bob.relays.consent = async () => 'bob-relay'
    client.shown = () => bob
    expect(await a.servers!.voice.consent(['relay.test'], recipient.ik)).toBe('alice-relay')
    client.shown = () => alice
    expect(await b.servers!.voice.consent(['relay.test'], sender.ik)).toBe('bob-relay')

    expect((await a.p2p.addContact(await recipient.myCard()))?.ok).toBe(true)
    await waitFor(() => recipient.contact(sender.ik)?.state === 'incoming', 'contact request')
    await b.p2p.accept(sender.ik)
    await waitFor(() => sender.presence(recipient.ik) === 'online', 'mutual contact')
    await a.p2pDm.openDm(recipient.ik)
    await b.p2pDm.openDm(sender.ik)
    const room = a.useP2p.getState().chat!.room
    b.p2pDm.setDraft(room, 'private draft')
    expect(a.useP2p.getState().drafts[room]).toBeUndefined()
    client.shown = () => bob
    expect(await a.p2pDm.send(room, 'hello from Alice')).toBe(true)
    await waitFor(
      () =>
        b.useP2p
          .getState()
          .chat?.messages.some(m => m.body === 'hello from Alice' && m.sender === sender.ik) ===
        true,
      'Bob to receive Alice’s signed message'
    )

    await a.dispose()
    senderDisposed = true
    await waitFor(() => !held.has(aDb), 'sender lock release')
    expect(a.node).toBeNull()
    expect(hub.online(sender.peerId)).toBe(false)
    expect(channels.has(aDb + ':leader')).toBe(false)
    expect(channels.has(aDb + ':data')).toBe(false)
    expect(held.has(bDb)).toBe(true)
    expect(channels.has(bDb + ':data')).toBe(true)
    expect(hub.online(recipient.peerId)).toBe(true)
    expect(b.useP2p.getState().drafts[room]).toBe('private draft')
    await b.p2p.setName('Still online')
    expect(recipient.view().name).toBe('Still online')
  } finally {
    client.shown = shown
    if (!senderDisposed) await a.dispose()
    await b.dispose()
    alice.store.dispose()
    bob.store.dispose()
    memoryStorage.removeItem(peerStorage(alice.conn, 'alice').scoped('rchat_p2p:alice'))
    memoryStorage.removeItem(peerStorage(bob.conn, 'bob', 'work').scoped('rchat_p2p:bob'))
    await Promise.all([removeP2pDb(aDb), removeP2pDb(bDb)])
  }
}, 60_000)

test('a retained identity cannot delete data after disposal or retargeting', async () => {
  const user = 'sam'
  const account = testAccount(user, 'https://identity-original.test')
  const app = createP2pApp(account, 'main')
  const original = app.dbFor(user)
  const originalKey = peerStorage(account.conn, user).scoped(app.p2pKey(user))
  const journal = peerStorage(account.conn, user).scoped(app.importsKey(user))
  app.rememberImport(user, 'original-import')
  await app.p2pAccount(user)
  app.writeOn(user, true)
  ;(await P2pStore.open(original)).close()
  account.conn.retarget(endpointsFrom('https://identity-replacement.test', null), null, false)
  const replacement = createP2pApp(account, 'main')
  const next = replacement.dbFor(user)
  try {
    ;(await P2pStore.open(next)).close()
    replacement.writeOn(user, true)
    expect(app.dbFor(user)).toBe(original)
    expect(app.readImports(user)).toEqual(['original-import'])
    expect(replacement.readImports(user)).toEqual([])
    expect(await app.p2p.removeData(user)).toBe(false)
    app.dispose()
    expect(await app.p2p.removeData(user)).toBe(false)
    expect(replacement.p2p.hasData(user)).toBe(true)
    replacement.dispose()
    expect(await replacement.p2p.removeData(user)).toBe(false)
    const databases = (await indexedDB.databases()).map(db => db.name)
    expect(databases).toContain(original)
    expect(databases).toContain(next)
    expect(memoryStorage.getItem(originalKey)).toBe('{"v":1,"on":true}')
  } finally {
    app.dispose()
    replacement.dispose()
    memoryStorage.removeItem(originalKey)
    memoryStorage.removeItem(journal)
    memoryStorage.removeItem(peerStorage(account.conn, user).scoped(app.p2pKey(user)))
    await Promise.all([removeP2pDb(original), removeP2pDb(next)])
    account.store.dispose()
  }
})

test('signout while opening the import database cancels the write and both journals stay untouched', async () => {
  const user = 'sam'
  const account = testAccount(user, 'https://import-original.test')
  const app = createP2pApp(account, 'work', {
    leaderDeps: () => ({ ...webLeaderDeps(), locks: null }),
  })
  await app.p2pAccount(user)
  const source = await makeNode(new Hub(), 'Exported identity')
  const db = app.dbFor(user)
  const journal = app.importsKey(user) + '~work'
  const originalKey = account.conn.scoped(journal)
  const dump = await parseDump(await dumpBytes(source.store.db))
  const opened = Promise.withResolvers<void>()
  const resume = Promise.withResolvers<void>()
  const open = P2pStore.open
  P2pStore.open = async name => {
    const store = await open(name)
    opened.resolve()
    await resume.promise
    return store
  }
  try {
    const pending = app.p2pTransfer.apply({
      dump,
      summary: summarize(dump),
      kind: 'new',
      already: false,
      files: null,
    })
    await opened.promise
    await app.p2pAccount(null)
    account.conn.retarget(endpointsFrom('https://import-replacement.test', null), null, false)
    resume.resolve()
    expect(await pending).toEqual({ ok: false, error: 'Cancelled' })
    expect(memoryStorage.getItem(originalKey)).toBeNull()
    expect(memoryStorage.getItem(account.conn.scoped(journal))).toBeNull()
    const stored = await open(db)
    try {
      expect(await stored.self()).toBeUndefined()
    } finally {
      stored.close()
    }
    expect(app.useP2p.getState().enabled).toBe(false)
  } finally {
    resume.resolve()
    P2pStore.open = open
    app.dispose()
    source.node.stop()
    source.store.close()
    await Promise.all([removeP2pDb(db), removeP2pDb(source.db)])
    account.store.dispose()
  }
})

test('a previous reader finishing startup leaves the new account’s older chat page open', async () => {
  const alice = 'reader-start-alice'
  const bob = 'reader-start-bob'
  const before = P2pStore.prototype.rooms
  const options: IdentityOptions = {}
  const owner = testAccount(alice)
  const nextOwner = testAccount(bob)
  const oldApp = createP2pApp(owner, 'main', options)
  const app = createP2pApp(nextOwner, 'main', options)
  const deps = options.leaderDeps
  const waiting = Promise.withResolvers<void>()
  const resume = Promise.withResolvers<void>()
  const refreshed = Promise.withResolvers<void>()
  const saved = [alice, bob].map(name => {
    const key = owner.conn.scoped(app.p2pKey(name))
    return { key, raw: readLocal(key), db: app.dbFor(name) }
  })
  const hub = new Hub()
  try {
    for (const name of [alice, bob]) {
      const seed = await makeNode(hub, name, { db: app.dbFor(name) })
      seed.node.stop()
      seed.store.close()
      ;(name === alice ? oldApp : app).writeOn(name, true)
    }
    options.leaderDeps = () => ({
      ...webLeaderDeps(),
      channel: () => null,
      locks: { request: async (_name, opts, cb) => (opts.ifAvailable ? cb(null) : undefined) },
    })
    P2pStore.prototype.rooms = async function () {
      const rows = await before.call(this)
      if (this.db.name === app.dbFor(alice)) {
        waiting.resolve()
        await resume.promise
      } else if (this.db.name === app.dbFor(bob)) refreshed.resolve()
      return rows
    }
    await oldApp.p2pAccount(alice)
    await waiting.promise
    oldApp.dispose()
    await app.p2pAccount(bob)
    await refreshed.promise
    await drain()
    const chat = {
      room: 'older-page',
      peer: 'friend',
      readSeq: 0,
      messages: [],
      more: true,
      newer: true,
      missed: [],
      loading: false,
    }
    app.useP2p.setState({ chat })
    resume.resolve()
    await drain()
    // Drain the same IndexedDB queue a misplaced loadChat would use.
    await app.reader!.store.rooms()
    await app.reader!.store.meta('missed:older-page')
    expect(app.useP2p.getState().chat).toBe(chat)
  } finally {
    resume.resolve()
    P2pStore.prototype.rooms = before
    options.leaderDeps = deps
    await app.p2pAccount(null)
    oldApp.dispose()
    app.dispose()
    nextOwner.store.dispose()
    owner.store.dispose()
    for (const { key, raw, db } of saved) {
      writeLocal(key, raw)
      await removeP2pDb(db)
    }
  }
})
