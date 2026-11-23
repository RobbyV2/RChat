import { expect, test } from 'bun:test'
import 'fake-indexeddb/auto'
import { startAccountCounts, pollAccountCounts, totalInboxCount } from '../client/account_counts'
import { listedStore } from '../p2p/inbox_source'
import { p2pKey } from '../p2p/app/store'
import { accountStorage, peerStorage } from '../client/keys'
import { PingLog } from '../p2p/ping_log'
import type { LockLike } from '../p2p/leader'
import {
  Hub,
  ManualClock,
  makeMember,
  stopAll,
  joinWithCode,
  general,
  pump,
  eventually,
} from './p2p_server_net'
import { testAccount } from './test_account'
import { memoryStorage } from './fixtures'

function browser() {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const events = Object.assign(new EventTarget(), { location: new URL('https://client.example/') })
  Object.defineProperty(globalThis, 'window', { value: events, configurable: true })
  return {
    events,
    restore() {
      if (descriptor) Object.defineProperty(globalThis, 'window', descriptor)
      else Reflect.deleteProperty(globalThis, 'window')
    },
  }
}

test('the device badge counts each account and sibling inbox source once and follows another tab', () => {
  const a = testAccount('sam', 'https://alpha-counts.example')
  const b = testAccount('sam', 'https://beta-counts.example')
  const tab = browser()
  const offA = startAccountCounts(a),
    offB = startAccountCounts(b)
  try {
    a.inbox.addInboxAdapter({ ...a.inbox.instanceInbox, id: 'p2p:main', count: () => 3 })
    a.inbox.addInboxAdapter({ ...a.inbox.instanceInbox, id: 'p2p:work', count: () => 2 })
    b.inbox.addInboxAdapter({ ...b.inbox.instanceInbox, id: 'p2p:main', count: () => 4 })
    expect(totalInboxCount([a, a, b])).toBe(9)
    expect(a.counts.breakdown()).toEqual({ instance: 0, unread: 0, peers: { main: 3, work: 2 } })
    b.mode = 'lite'
    const key = 'rchat_counts:' + JSON.stringify([b.conn.origin, 'sam'])
    memoryStorage.setItem(key, JSON.stringify({ badge: 8, unread: 3 }))
    tab.events.dispatchEvent(Object.assign(new Event('storage'), { key }))
    expect(totalInboxCount([a, b])).toBe(13)
    memoryStorage.setItem(key, JSON.stringify({ instance: 2, unread: 1, peers: { work: 6 } }))
    tab.events.dispatchEvent(Object.assign(new Event('storage'), { key }))
    expect(b.counts.breakdown()).toEqual({ instance: 2, unread: 1, peers: { work: 6 } })
    memoryStorage.removeItem(key)
    tab.events.dispatchEvent(Object.assign(new Event('storage'), { key }))
    expect(totalInboxCount([a, b])).toBe(9)
  } finally {
    offA()
    offB()
    tab.restore()
    a.store.dispose()
    b.store.dispose()
  }
})

test('parked polling counts only its qualified account and discards a response after sign-out', async () => {
  const a = testAccount('reader', 'https://parked-counts.example')
  a.credentialTarget = 'reader'
  a.store.setState({ me: null })
  a.mode = 'parked'
  const storage = accountStorage(a.conn)
  const name = storage.token('reader')
  const snapshot = 'rchat_counts:' + JSON.stringify([a.conn.origin, 'reader'])
  const original = globalThis.fetch
  const held = a.tabLock.holds
  let ajax = 0,
    alerts = 0
  let latest = 0
  const wait = Promise.withResolvers<Response>()
  const row = () =>
    Response.json({
      items: [
        { scope: 'd1', server: null, latest, last_read: 0, pings: latest, pings_until: latest },
      ],
      more: false,
    })
  const request = async (url: RequestInfo | URL, init?: RequestInit) => {
    expect(new URL(String(url)).origin).toBe(a.conn.origin)
    expect(init?.credentials).toBe('omit')
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer test-reader')
    if (String(url).endsWith('/friends/summary'))
      return Response.json({ incoming: 0, outgoing: 0, pings: 1, pings_until: 9 })
    return ++ajax === 3 ? wait.promise : row()
  }
  a.store.setState({
    alertFrom: () => {
      alerts++
    },
  })
  a.tabLock.holds = () => true
  globalThis.fetch = Object.assign(request, original)
  try {
    memoryStorage.setItem(storage.key('rchat_token'), 'test-sibling')
    await pollAccountCounts(a)
    expect(ajax).toBe(0)
    memoryStorage.setItem(name, 'test-reader')
    await pollAccountCounts(a)
    expect(alerts).toBe(0)
    latest = 2
    await pollAccountCounts(a)
    expect(a.counts.value()).toBe(3)
    expect(alerts).toBe(1)
    latest = 4
    const pending = pollAccountCounts(a)
    memoryStorage.removeItem(name)
    wait.resolve(row())
    await pending
    expect(a.counts.value()).toBe(3)
    expect(alerts).toBe(1)
  } finally {
    globalThis.fetch = original
    a.tabLock.holds = held
    for (const key of [name, storage.key('rchat_token'), snapshot]) memoryStorage.removeItem(key)
    a.store.dispose()
  }
})

test('parked polls retain peer badges, concurrent clears and subsequent parked periods', async () => {
  const a = testAccount('sam', 'https://park-period.example')
  const tab = browser()
  a.tabLock.holds = () => true
  const stop = startAccountCounts(a)
  const token = accountStorage(a.conn).token('sam')
  const snapshot = 'rchat_counts:' + JSON.stringify([a.conn.origin, 'sam'])
  const original = globalThis.fetch
  const summary = {
    scope: 'c1',
    latest: 3,
    last_read: 0,
    server: null,
    pings: 1,
    pings_until: 3,
    group_pings: [{ message_id: 3, kinds: ['everyone'] }],
  }
  let batch = Promise.withResolvers<Response>()
  globalThis.fetch = Object.assign(
    async (url: RequestInfo | URL) =>
      String(url).endsWith('/friends/summary')
        ? Response.json({ incoming: 0, outgoing: 0, pings: 1, pings_until: 1 })
        : batch.promise,
    original
  )
  const reply = () => batch.resolve(Response.json({ items: [summary], more: false }))
  try {
    memoryStorage.setItem(token, 'test-reader')
    a.inbox.addInboxAdapter({ ...a.inbox.instanceInbox, id: 'p2p:work', count: () => 4 })
    a.mode = 'parked'
    a.counts.modeChanged()
    a.inbox.removeInboxAdapter('p2p:work')
    let pending = a.counts.poll()
    reply()
    await pending
    expect(a.counts.breakdown().peers).toEqual({ work: 4 })
    expect(!!a.store.getState().pings.friends).toBe(true)
    expect(!!a.store.getState().groupPings.c1).toBe(true)
    batch = Promise.withResolvers<Response>()
    pending = a.counts.poll()
    a.store.setState({
      pings: {},
      groupPings: {},
      reads: {
        c1: { lastRead: 3, latest: 3 },
        d2: { lastRead: 0, latest: 7 },
      },
    })
    reply()
    await pending
    expect(a.counts.breakdown()).toEqual({ instance: 0, unread: 1, peers: { work: 4 } })
    expect(a.store.getState().pings).toEqual({})
    expect(a.store.getState().groupPings).toEqual({})
    batch = Promise.withResolvers<Response>()
    pending = a.counts.poll()
    a.mode = 'shown'
    a.counts.modeChanged()
    a.mode = 'parked'
    a.counts.modeChanged()
    reply()
    await pending
    expect(a.store.getState().pings).toEqual({})
    expect(a.store.getState().reads.d2?.latest).toBe(7)
  } finally {
    stop()
    tab.restore()
    globalThis.fetch = original
    memoryStorage.removeItem(token)
    memoryStorage.removeItem(snapshot)
    a.store.dispose()
  }
})

test('a registered identity retains its badge through park and resume until its stored counters reload', async () => {
  const a = testAccount('sam', 'https://peer-park.example')
  a.store.setState({ readsReady: true, settings: { ...a.store.getState().settings, p2p: true } })
  a.deliveryLock.holds = () => true
  const tab = browser()
  const stop = startAccountCounts(a)
  const snapshot = 'rchat_counts:' + JSON.stringify([a.conn.origin, 'sam'])
  const flag = peerStorage(a.conn, 'sam', 'work').scoped(p2pKey('sam'))
  try {
    a.identities.setAccount('sam')
    const peer = a.identities.add('work')
    const adapter = a.inbox.inboxAdapters().find(i => i.id === 'p2p:work')!
    const listed = listedStore(peer)
    const room = {
      id: 'dm',
      peer: 'friend',
      seq: 3,
      unread: 2,
      pings: 2,
      lastTs: 10,
      count: 3,
      bytes: 10,
      full: false,
      fullWhy: undefined,
      peerFull: false,
      gap: false,
    }
    const loaded = {}
    peer.useP2p.setState({ enabled: true, rooms: { dm: room }, countsLoaded: loaded })
    listed.setState({ by: new Map([['dm', 2]]), loaded })
    memoryStorage.setItem(flag, JSON.stringify({ v: 1, on: true }))
    expect(adapter.count!()).toBe(2)
    expect(a.counts.value()).toBe(2)
    a.identities.setRunning(new Set())
    expect(a.inbox.inboxAdapters().includes(adapter)).toBe(true)
    expect(adapter.count!()).toBe(0)
    expect(a.counts.value()).toBe(2)
    a.identities.setRunning(new Set(['work']))
    expect(a.counts.value()).toBe(2)
    const resumed = {}
    peer.useP2p.setState({ enabled: true, rooms: { dm: room }, countsLoaded: resumed })
    expect(adapter.countReady!()).toBe(false)
    expect(a.counts.value()).toBe(2)
    listed.setState({ by: new Map([['dm', 2]]), loaded: resumed })
    expect(adapter.countReady!()).toBe(true)
    peer.useP2p.setState({ rooms: { dm: { ...room, pings: 0, unread: 0 } } })
    expect(a.counts.value()).toBe(0)
    peer.useP2p.setState({ rooms: { dm: room } })
    expect(a.counts.value()).toBe(2)
    a.identities.setRunning(new Set())
    expect(await peer.p2p.removeData('sam')).toBe(true)
    expect(a.counts.value()).toBe(0)
    a.identities.unregister('work')
    expect(a.counts.breakdown().peers.work).toBeUndefined()
    expect(a.counts.value()).toBe(0)
  } finally {
    stop()
    a.store.dispose()
    tab.restore()
    memoryStorage.removeItem(snapshot)
    memoryStorage.removeItem(flag)
  }
})

test('a registered P2P reader counts visible channel mentions across resume, read and leave', async () => {
  const a = testAccount('bob', 'https://reader-counts.example')
  const tab = browser()
  const locks = Object.getOwnPropertyDescriptor(navigator, 'locks')
  const restoreLocks = () => {
    if (locks) Object.defineProperty(navigator, 'locks', locks)
    else Reflect.deleteProperty(navigator, 'locks')
  }
  const snapshot = 'rchat_counts:' + JSON.stringify([a.conn.origin, 'bob'])
  a.store.setState({ readsReady: true, settings: { ...a.store.getState().settings, p2p: true } })
  a.identities.setAccount('bob')
  const peer = a.identities.add('work')
  const adapter = a.inbox.inboxAdapters().find(i => i.id === 'p2p:work')!
  const clock = new ManualClock()
  const hub = new Hub()
  const alice = await makeMember(hub, 'Alice', clock)
  const bob = await makeMember(hub, 'Bob', clock, { db: peer.dbFor('bob') })
  const data = new BroadcastChannel(peer.dbFor('bob') + ':data')
  const log = new PingLog({
    store: bob.store,
    dms: bob.dms,
    servers: bob.servers,
    now: () => clock.now(),
    onWrite: () => data.postMessage({ inbox: true }),
  })
  const stop = startAccountCounts(a)
  try {
    const room = await alice.servers.create('Pings')
    const ch = general(alice, room)
    await joinWithCode(clock, alice, room, bob)
    bob.servers.onArrive(x => {
      if (x.ping) log.note(x.room, x.ch, x.ping, x.rec)
    })
    bob.servers.onChange(room => data.postMessage({ room }))
    const mention = async () => {
      await alice.servers.send(room, { ch, body: 'hey @Bob' })
      await pump(clock, () => bob.servers.view(room)?.chans[ch]?.pings === 1, 'mention arrival')
      await log.flush()
    }
    await mention()
    peer.writeOn('bob', true)
    a.identities.setRunning(new Set())
    memoryStorage.setItem(snapshot, JSON.stringify({ instance: 0, peers: { work: 1 }, unread: 0 }))
    tab.events.dispatchEvent(Object.assign(new Event('storage'), { key: snapshot }))
    a.deliveryLock.start(a.conn.origin, 'bob')
    expect(a.counts.value()).toBe(1)
    // Another tab holds this identity's Web Lock.
    const held: LockLike = {
      request: (_key, opts, cb) => (opts.ifAvailable ? cb(null) : new Promise(() => {})),
    }
    Object.defineProperty(navigator, 'locks', { configurable: true, value: held })
    const resumeCounts = [a.counts.value()]
    const offCounts = a.counts.subscribe(() => resumeCounts.push(a.counts.value()))
    a.identities.setRunning(new Set(['work']))
    await eventually(() => adapter.countReady!(), 'reader recount', 3000)
    offCounts()
    expect(resumeCounts.every(n => n === 1)).toBe(true)
    restoreLocks()
    expect(peer.useP2p.getState().reader).toBe(true)
    expect(adapter.count!()).toBe(1)
    expect(a.counts.value()).toBe(1)
    await bob.servers.markRead(room, ch)
    await eventually(() => a.counts.value() === 0, 'reader sees channel read', 3000)
    await mention()
    await eventually(() => a.counts.value() === 1, 'reader sees next mention', 3000)
    await bob.servers.leave(room)
    await eventually(() => a.counts.value() === 0, 'reader sees membership loss', 3000)
    expect(JSON.parse(memoryStorage.getItem(snapshot)!).peers.work).toBe(0)
  } finally {
    stop()
    log.stop()
    a.store.dispose()
    stopAll()
    data.close()
    bob.store.close()
    alice.store.close()
    restoreLocks()
    tab.restore()
    memoryStorage.removeItem(snapshot)
    memoryStorage.removeItem(peerStorage(a.conn, 'bob', 'work').scoped(p2pKey('bob')))
  }
}, 20000)

test('a connected tab clearing counts invalidates a parked poll even if delivery is idle by commit', async () => {
  const a = testAccount('sam', 'https://count-handoff.example')
  const connected = testAccount('sam', a.conn.origin)
  a.mode = 'parked'
  const tab = browser()
  a.tabLock.start(a.conn.origin, 'sam')
  expect(a.tabLock.holds(a.conn.origin, 'sam')).toBe(true)
  const key = 'rchat_counts:' + JSON.stringify([a.conn.origin, 'sam'])
  const token = accountStorage(a.conn).token('sam')
  const original = globalThis.fetch
  const stop = startAccountCounts(a)
  const stopConnected = startAccountCounts(connected)
  let alerts = 0
  a.store.setState({
    alertFrom: () => {
      alerts++
    },
  })
  try {
    memoryStorage.setItem(token, 'test-reader')
    for (const deliverStorageEvent of [true, false]) {
      connected.deliveryLock.start(a.conn.origin, 'sam')
      connected.store.setState({ readsReady: true, pings: {}, reads: {} })
      expect(connected.counts.value()).toBe(0)
      tab.events.dispatchEvent(Object.assign(new Event('storage'), { key }))
      const zero = memoryStorage.getItem(key)
      const gate = Promise.withResolvers<Response>()
      let requested = false
      globalThis.fetch = Object.assign(async (url: RequestInfo | URL) => {
        if (String(url).endsWith('/friends/summary'))
          return Response.json({ incoming: 0, outgoing: 0, pings: 0, pings_until: 0 })
        requested = true
        return gate.promise
      }, original)
      const pending = a.counts.poll()
      expect(requested).toBe(true)
      connected.store.setState({
        readsReady: true,
        pings: { c1: { scope: 'c1', server: null, bulk: 3, bulkUntil: 3, ids: [] } },
        reads: { c1: { lastRead: 0, latest: 3 } },
      })
      expect(connected.counts.value()).toBe(3)
      connected.store.setState({ pings: {}, reads: { c1: { lastRead: 3, latest: 3 } } })
      expect(connected.counts.value()).toBe(0)
      const cleared = memoryStorage.getItem(key)
      expect(cleared).not.toBe(zero)
      expect(JSON.parse(cleared!)).toMatchObject({ instance: 0, peers: {}, unread: 0 })
      connected.store.setState({ pings: {} })
      expect(memoryStorage.getItem(key)).toBe(cleared)
      connected.deliveryLock.stop()
      expect(connected.deliveryLock.holds(a.conn.origin, 'sam')).toBe(false)
      if (deliverStorageEvent)
        tab.events.dispatchEvent(Object.assign(new Event('storage'), { key }))
      gate.resolve(
        Response.json({
          items: [{ scope: 'c1', server: null, latest: 7, last_read: 0, pings: 7, pings_until: 7 }],
          more: false,
        })
      )
      await pending
      expect(memoryStorage.getItem(key)).toBe(cleared)
      expect(a.store.getState().pings).toEqual({})
      expect(alerts).toBe(0)
      tab.events.dispatchEvent(Object.assign(new Event('storage'), { key }))
      expect(a.counts.value()).toBe(0)
    }
  } finally {
    stop()
    stopConnected()
    connected.store.dispose()
    a.store.dispose()
    tab.restore()
    globalThis.fetch = original
    memoryStorage.removeItem(key)
    memoryStorage.removeItem(token)
  }
})
