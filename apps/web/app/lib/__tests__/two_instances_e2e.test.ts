import { testSession } from './test_account'
import { expect, test } from 'bun:test'
import { endpointsFrom, InstanceConnection, rememberInstance } from '../instances'
import { removeP2pDb } from '../p2p/db'
import { PeerTransport } from '../p2p/transport'
import { scopePingCount } from '../store'
import type { WsEvent } from '../types'
import { drain, me, memoryStorage, msg, user } from './fixtures'
import { Hub, waitFor } from './p2p_net'
import { writeJson } from '../api/masks'

test('two instances bootstrap the same username and route messages, badges and peer identities independently', async () => {
  const accounts = ['east', 'west'].map(name =>
    testSession(new InstanceConnection(endpointsFrom(`https://${name}.isolation.test`, null)))
  )
  const [east, west] = accounts
  const sockets = new Map<string, Socket>()
  class Socket {
    static OPEN = 1
    static CONNECTING = 0
    readyState = 0
    frames: unknown[] = []
    onopen: (() => void) | null = null
    onmessage: ((event: { data: string }) => void) | null = null
    constructor(url: string) {
      sockets.set(new URL(url).hostname, this)
    }
    open() {
      this.readyState = Socket.OPEN
      this.onopen?.()
    }
    send(text: string) {
      this.frames.push(JSON.parse(text))
    }
    deliver(event: WsEvent) {
      this.onmessage?.({ data: writeJson(event) })
    }
    close() {
      this.readyState = 3
    }
  }

  const original = new Map(
    ['window', 'document', 'WebSocket', 'fetch', 'localStorage'].map(key => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ])
  )
  const stored = Array.from({ length: memoryStorage.length }, (_, i) => {
    const key = memoryStorage.key(i)!
    return [key, memoryStorage.getItem(key)!] as const
  })
  const room = { id: 4, other: user('friend'), is_self: false }
  const posts: { host: string; auth: string | null; content: string }[] = []
  const peerIds: string[] = []
  const peerNetwork = new Hub()
  const transport = peerNetwork.transport()
  const { listen, dial } = PeerTransport.prototype
  Object.assign(PeerTransport.prototype, { listen: transport.listen, dial: transport.dial })
  const databases: string[] = []
  try {
    Object.assign(globalThis, {
      WebSocket: Socket,
      localStorage: memoryStorage,
      window: Object.assign(new EventTarget(), {
        localStorage: memoryStorage,
        location: new URL('https://client.isolation.test/'),
        history: { state: null, replaceState() {}, pushState() {} },
      }),
      document: Object.assign(new EventTarget(), { visibilityState: 'visible', cookie: '' }),
      fetch: async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input))
        const account = accounts.find(a => a.conn.host === url.host)
        if (!account) throw new Error(`Unexpected origin ${url.origin}`)
        const path = url.pathname.replace(/^\/api(?:\/v1)?/, '')
        const auth = new Headers(init?.headers).get('Authorization')
        const token = `token-${url.host}`
        if (path === '/instance')
          return Response.json({
            software: 'rchat',
            name: url.host,
            id: url.host,
            host: url.host,
            api_version: '1.1',
            public_url: url.origin,
            api_url: url.origin + '/api',
            ws_url: 'wss://' + url.host + '/api/ws',
            features: {},
          })
        if (path === '/settings')
          return Response.json({ ...account.store.getState().settings, p2p: true })
        if (path === '/me')
          return auth === 'Bearer ' + token
            ? Response.json(me('sam', { display_name: url.host, dms: [room] }))
            : new Response(null, { status: 401 })
        if (path === '/dms/4/messages' && init?.method === 'POST') {
          const { content } = JSON.parse(String(init.body)) as { content: string }
          posts.push({ host: url.host, auth, content })
          return Response.json(
            msg(20, { dm_id: 4, channel_id: null, author: user('sam'), content })
          )
        }
        if (path === '/unreads') return Response.json({ items: [], more: false })
        return Response.json([])
      },
    })
    for (const a of accounts) {
      rememberInstance(a.conn.origin, await a.api.instance(), memoryStorage)
      memoryStorage.setItem(a.conn.scoped('rchat_token'), 'token-' + a.conn.host)
    }
    await Promise.all(accounts.map(a => a.store.getState().bootstrap()))
    for (const a of accounts) {
      const socket = sockets.get(a.conn.host)!
      socket.open()
      expect(socket.frames[0]).toEqual({ type: 'auth', token: 'token-' + a.conn.host })
      expect(a.store.getState().me?.display_name).toBe(a.conn.host)
      expect(a.identities.get()?.owner).toBe(a)
    }
    expect(sockets.size).toBe(2)
    await drain()
    const peerApps = accounts.map(a => a.identities.get()!)
    databases.push(...peerApps.map(app => app.dbFor('sam')))
    for (const [i, app] of peerApps.entries()) await app.p2p.enable(accounts[i].conn.host)
    await waitFor(() => peerApps.every(app => app.node?.status === 'online'), 'both peer listeners')
    expect(peerApps[0].node!.ik).not.toBe(peerApps[1].node!.ik)
    expect(east.keys.db()).not.toBe(west.keys.db())
    for (const [i, app] of peerApps.entries()) {
      expect(accounts[i].keys.db()).toBe(app.dbFor('sam'))
      expect(app.useP2p.getState().name).toBe(accounts[i].conn.host)
      expect(app.node!.host).toBe(accounts[i].conn.host)
      peerIds.push(app.node!.peerId)
      expect(peerNetwork.online(app.node!.peerId)).toBe(true)
    }
    for (const [i, a] of accounts.entries()) {
      const socket = sockets.get(a.conn.host)!
      socket.deliver({
        type: 'message',
        server: null,
        channel_id: null,
        dm_id: 4,
        dm_users: ['sam', 'friend'],
        message: msg(10, {
          channel_id: null,
          dm_id: 4,
          author: user('friend'),
          content: 'from ' + a.conn.host,
        }),
      })
      socket.deliver({
        type: 'ping',
        username: 'sam',
        ping: {
          id: 1,
          kind: 'mention',
          scope: 'd4',
          server: null,
          message_id: 10,
          thread_root_id: null,
          actor: user('friend'),
          emoji: null,
          excerpt: 'from ' + a.conn.host,
          created_at: 1,
        },
      })
      const st = a.store.getState()
      expect(st.reads.d4.latest).toBe(10)
      expect(scopePingCount(st, 'd4')).toBeGreaterThan(0)
      expect(st.notices.at(-1)?.body).toBe('from ' + a.conn.host)
      if (i === 0) {
        expect(west.store.getState().reads.d4).toBeUndefined()
        expect(west.store.getState().notices).toEqual([])
        expect(scopePingCount(west.store.getState(), 'd4')).toBe(0)
      }
    }
    for (const a of accounts) {
      const st = a.store.getState()
      expect(st.notices.map(n => n.body)).toEqual(['from ' + a.conn.host])
      expect(st.pings.d4.ids).toEqual([1])
    }
    await Promise.all(accounts.map(a => a.store.getState().openDm(4, 'none')))
    for (const a of accounts) a.store.getState().sendMessage('sent by ' + a.conn.host)
    await waitFor(
      () => accounts.every(a => a.store.getState().messages.d4?.some(m => m.id === 20)),
      'both message acknowledgements'
    )
    for (const a of accounts) {
      expect(posts.filter(p => p.host === a.conn.host)).toEqual([
        {
          host: a.conn.host,
          auth: 'Bearer token-' + a.conn.host,
          content: 'sent by ' + a.conn.host,
        },
      ])
      expect(a.store.getState().messages.d4.find(m => m.id === 20)?.content).toBe(
        'sent by ' + a.conn.host
      )
    }
  } finally {
    for (const a of accounts) a.store.dispose()
    Object.assign(PeerTransport.prototype, { listen, dial })
    await Promise.all(databases.map(removeP2pDb))
    for (const [key, descriptor] of original) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
    memoryStorage.clear()
    for (const [key, value] of stored) memoryStorage.setItem(key, value)
  }
  expect([...sockets.values()].map(socket => socket.readyState)).toEqual([3, 3])
  expect(peerIds.every(id => !peerNetwork.online(id))).toBe(true)
})
