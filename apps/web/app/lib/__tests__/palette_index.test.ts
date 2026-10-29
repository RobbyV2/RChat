import { afterAll, afterEach, beforeEach, describe, expect, jest, test } from 'bun:test'
import { setBlobs, type BlobStore } from '../platform'
import { webBlobs } from '../platform/web_blobs'
import { PaletteIndex, parseDoc, parseManifest, tokenize, type IndexDoc } from '../palette_index'
import {
  __sync,
  docVisible,
  effectiveMode,
  indexDocs,
  messageDoc,
  paletteIndex,
  setIndexModeNow,
  startIndexSync,
  useIndexStatus,
} from '../palette_sync'
import { resetSessionCaches, useStore } from '../store'
import type { Message, WsEvent } from '../types'
import { advance, me, memoryStorage, msg, serverDetail, user } from './fixtures'

afterAll(resetSessionCaches)

const doc = (id: number, over: Partial<IndexDoc> = {}): IndexDoc => ({
  id: `m${id}`,
  kind: 'message',
  bucket: 'c1',
  source: 'instance',
  server: 's',
  channel: 1,
  dm: null,
  thread: null,
  msg: id,
  author: 'bob',
  name: 'Bob',
  text: `message ${id}`,
  at: id,
  ...over,
})

const memoryBlobs = () => {
  const data = new Map<string, Blob>()
  const store: BlobStore = {
    put: async (k, b) => void data.set(k, b),
    get: async k => data.get(k) ?? null,
    remove: async k => void data.delete(k),
    create: async () => {
      throw new Error('unused')
    },
    clear: async prefix => {
      for (const k of [...data.keys()]) if (k.startsWith(prefix)) data.delete(k)
    },
    room: async () => null,
  }
  return { data, store }
}

describe('the index', () => {
  test('adds, finds by words and prefixes, replaces edits, removes and drops buckets', () => {
    const ix = new PaletteIndex(1e9)
    ix.add([
      doc(1, { text: 'rockets to ||mars|| today' }),
      doc(2, { text: 'zebra crossing', bucket: 'c2', channel: 2 }),
      doc(3, { text: 'walrus plan', bucket: 'd9', dm: 9, server: null, channel: null }),
      { ...doc(0), id: 'us\nbob', kind: 'member', bucket: 'm:s', text: '', msg: null },
    ])
    expect(tokenize('||mars|| @bob #general')).toEqual(['mars', 'bob', 'general'])
    expect(ix.search('mars').map(h => h.doc.id)).toEqual(['m1'])
    expect(ix.search('zeb').map(h => h.doc.id)).toEqual(['m2'])
    expect(ix.search('bob', { kind: 'member' }).map(h => h.doc.id)).toEqual(['us\nbob'])
    expect(ix.search('walrus', { visible: d => d.dm === null })).toEqual([])
    expect(ix.add([doc(1, { text: 'rockets to ||mars|| today' })])).toBe(0)
    ix.add([doc(1, { text: 'edited text' })])
    expect(ix.search('mars')).toEqual([])
    expect(ix.search('edited').map(h => h.doc.id)).toEqual(['m1'])
    ix.remove(['m1'])
    expect(ix.has('m1')).toBe(false)
    ix.dropBucket('c2')
    expect(ix.search('zebra')).toEqual([])
    expect(ix.count).toBe(2)
    expect(ix.dropWhere(d => d.dm === 9)).toBe(1)
    expect(ix.messageCount).toBe(0)
  })

  test('a fetched run of messages reconciles its conversation', () => {
    const ix = new PaletteIndex(1e9)
    ix.add([1, 2, 3, 4, 5].map(i => doc(i)))
    ix.add([doc(9, { bucket: 'c2', channel: 2 })])
    // Loaded 2..5 without 4: only what lies inside the run is checked.
    expect(ix.reconcile('c1', [doc(2), doc(3), doc(5, { text: 'edited five' })], [2, 3, 5])).toBe(2)
    expect(['m1', 'm2', 'm3', 'm4', 'm5'].filter(id => ix.has(id))).toEqual([
      'm1',
      'm2',
      'm3',
      'm5',
    ])
    expect(ix.search('edited').map(h => h.doc.id)).toEqual(['m5'])
    // A refill of the newest page (3..5, 4 gone) also drops what is older than the page.
    ix.reconcile('c1', [doc(3), doc(5)], [3, 5], true)
    expect(['m1', 'm2', 'm3', 'm4', 'm5'].filter(id => ix.has(id))).toEqual(['m3', 'm5'])
    // An empty page: the conversation has nothing left.
    ix.reconcile('c1', [], [], true)
    expect(ix.docsIn('c1')).toEqual([])
    expect(ix.has('m9')).toBe(true)
  })

  test('stays under its size cap by dropping the oldest messages', () => {
    const ix = new PaletteIndex(4000)
    ix.add(Array.from({ length: 40 }, (_, i) => doc(i + 1, { text: `word${i} `.repeat(4) })))
    expect(ix.bytes <= 4000).toBe(true)
    expect(ix.has('m40')).toBe(true)
    expect(ix.has('m1')).toBe(false)
  })

  test('saves per conversation and loads back; bad records are skipped', async () => {
    const { data, store } = memoryBlobs()
    const ix = new PaletteIndex(1e9)
    ix.add([doc(1), doc(2, { bucket: 'd9', dm: 9, server: null, channel: null })])
    ix.filled.c1 = 123
    await ix.save(store, 'palette:alice:')
    expect([...data.keys()].sort()).toEqual([
      'palette:alice:c1',
      'palette:alice:d9',
      'palette:alice:manifest',
    ])
    data.set('palette:alice:c1', new Blob(['[{"id":"m1"},' + JSON.stringify(doc(1)) + ']']))
    const back = new PaletteIndex(1e9)
    expect(await back.load(store, 'palette:alice:')).toBe(2)
    expect(back.filled).toEqual({ c1: 123 })
    expect(back.search('message').length).toBe(2)
    ix.dropBucket('d9')
    await ix.save(store, 'palette:alice:')
    expect(data.has('palette:alice:d9')).toBe(false)
    expect(parseDoc({ id: 'x', kind: 'nope' })).toBeNull()
    expect(parseManifest('{"v":1,"buckets":["a","a",3],"filled":{"a":1,"b":"x"}}')).toEqual({
      v: 1,
      buckets: ['a'],
      filled: { a: 1 },
    })
  })
})

describe('following the app', () => {
  const g = globalThis as { window?: unknown; document?: unknown }
  const real = { window: g.window, document: g.document, fetch: globalThis.fetch }
  let blobs = memoryBlobs()
  let stop: (() => void) | null = null
  let fetched: string[] = []
  const general: Message[] = [
    msg(1, { content: 'rockets launch', author: user('bob') }),
    msg(2, { content: 'zebra crossing', author: user('carol') }),
  ]
  const random = [msg(3, { channel_id: 2, content: 'random giraffe' })]
  const other = [msg(4, { channel_id: 5, content: 'otherworld notes' })]
  const dm = [
    msg(5, { channel_id: null, dm_id: 9, content: 'private walrus', author: user('bob') }),
  ]
  const st = () => useStore.getState()
  const ids = (q: string) => (paletteIndex()?.search(q) ?? []).map(h => h.doc.id)
  const tick = () => new Promise(r => setTimeout(r, 0))

  const state = () => ({
    token: 'tok',
    me: me('alice', {
      servers: [
        { name: 's', display_name: 'S', creator: null, is_admin: false },
        { name: 't', display_name: 'T', creator: null, is_admin: false },
      ],
    }),
    guest: false,
    guestServers: [],
    servers: {
      s: serverDetail('s', {
        channels: [
          { id: 1, name: 'general', kind: 'text' as const, slowmode_seconds: 0 },
          { id: 2, name: 'random', kind: 'text' as const, slowmode_seconds: 0 },
        ],
      }),
      t: serverDetail('t', {
        channels: [{ id: 5, name: 'x', kind: 'text' as const, slowmode_seconds: 0 }],
      }),
    },
    dms: [{ id: 9, other: user('bob'), is_self: false }],
    blocked: {},
    members: {},
    memberInfo: {},
    messages: { c1: general, c2: random, c5: other, d9: dm },
  })

  let onHide: (() => void) | null = null
  let pages: Record<string, Message[]> = {}

  const start = (mode: 'loaded' | 'full') => {
    memoryStorage.setItem('rchat_palette:alice', JSON.stringify({ v: 1, used: {}, index: mode }))
    useStore.setState(state())
    stop = startIndexSync()
  }

  const aliceKeys = () => [...blobs.data.keys()].filter(k => k.startsWith('palette:alice:'))

  beforeEach(() => {
    blobs = memoryBlobs()
    setBlobs(blobs.store)
    fetched = []
    Object.assign(globalThis, { localStorage: memoryStorage })
    g.window = { location: { pathname: '/', href: 'http://x/', origin: 'http://x' } }
    onHide = null
    pages = {}
    g.document = {
      visibilityState: 'visible',
      addEventListener: (_: string, f: () => void) => void (onHide = f),
      removeEventListener: () => {},
    }
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input)
      fetched.push(url.replace(/^https?:\/\/[^/]+/, ''))
      if (/\/servers\/gone$/.test(url))
        return new Response('{"error":"Server not found"}', { status: 404 })
      if (/\/servers\/s$/.test(url)) return new Response(JSON.stringify(state().servers.s))
      const page = /\/(channels|dms)\/(\d+)\/messages/.exec(url)
      const key = page && `${page[1] === 'dms' ? 'd' : 'c'}${page[2]}`
      if (key && pages[key]) return new Response(JSON.stringify(pages[key]))
      return new Response('[]')
    }) as typeof fetch
  })

  afterEach(() => {
    jest.useRealTimers()
    stop?.()
    stop = null
    setBlobs(webBlobs)
    globalThis.fetch = real.fetch
    g.window = real.window
    g.document = real.document
    memoryStorage.clear()
    useStore.setState({ token: null, me: null, messages: {}, servers: {}, dms: [], blocked: {} })
  })

  test('loaded only: indexes what is loaded and drops access losses as they happen', async () => {
    start('loaded')
    await tick()
    expect(useIndexStatus.getState().mode).toBe('loaded')
    expect(ids('rockets')).toEqual(['m1'])
    expect(ids('walrus')).toEqual(['m5'])
    expect(ids('otherworld')).toEqual(['m4'])
    // a new message loads
    useStore.setState({
      messages: { ...st().messages, c1: [...general, msg(6, { content: 'fresh comet' })] },
    })
    expect(ids('comet')).toEqual(['m6'])
    // deleted messages
    __sync.onEvent({ type: 'message_deleted', id: 6, thread_root_id: null } as WsEvent)
    __sync.onEvent({ type: 'messages_deleted', ids: [2], thread_root_id: null } as WsEvent)
    expect(ids('comet')).toEqual([])
    expect(ids('zebra')).toEqual([])
    // a channel hidden
    const s = st().servers.s
    useStore.setState({
      servers: { ...st().servers, s: { ...s, channels: s.channels.slice(0, 1) } },
    })
    expect(ids('giraffe')).toEqual([])
    // left a server
    useStore.setState({
      me: { ...st().me!, servers: st().me!.servers.filter(x => x.name !== 't') },
    })
    expect(ids('otherworld')).toEqual([])
    // blocked someone: their messages and the DM with them
    useStore.setState({ blocked: { bob: true } })
    expect(ids('rockets')).toEqual([])
    expect(ids('walrus')).toEqual([])
    expect(blobs.data.size).toBe(0)
  })

  test('kicked, banned, deleted servers and permission changes drop too', async () => {
    start('loaded')
    await tick()
    __sync.onEvent({
      type: 'member_kicked',
      server: 't',
      username: 'alice',
      banned: true,
    } as WsEvent)
    expect(ids('otherworld')).toEqual([])
    __sync.onEvent({
      type: 'member_kicked',
      server: 's',
      username: 'bob',
      banned: false,
    } as WsEvent)
    expect(ids('rockets')).toEqual(['m1'])
    __sync.onEvent({ type: 'channel_perms_changed', server: 's', channel_id: 1 } as WsEvent)
    expect(ids('rockets')).toEqual([])
    __sync.onEvent({ type: 'server_deleted', name: 's' } as WsEvent)
    expect(ids('giraffe')).toEqual([])
    expect(ids('walrus')).toEqual(['m5'])
  })

  test('what may be shown is checked again at query time', () => {
    useStore.setState(state())
    const s = st()
    expect(docVisible(s, doc(1))).toBe(true)
    expect(docVisible(s, doc(1, { channel: 77 }))).toBe(false)
    expect(docVisible(s, doc(1, { server: 'unknown' }))).toBe(false)
    expect(docVisible(s, doc(5, { server: null, channel: null, dm: 9 }))).toBe(true)
    expect(
      docVisible(
        { ...s, blocked: { bob: true } },
        doc(5, { server: null, channel: null, dm: 9, author: 'alice' })
      )
    ).toBe(false)
    expect(docVisible(s, doc(1, { source: 'p2p' }))).toBe(false)
    expect(messageDoc(s, 'c1', msg(1, { kind: 'call' }), 's')).toBeNull()
    expect(messageDoc(s, 'c1', msg(1, { content: '  ' }), 's')).toBeNull()
    expect(messageDoc(s, 'c1', msg(1), null)).toBeNull()
    expect(effectiveMode('full', true)).toBe('loaded')
  })

  test('full: kept on the device, checked on start against the server, removed when off', async () => {
    jest.useFakeTimers()
    const saved = new PaletteIndex(1e9)
    saved.add([
      doc(10, { text: 'kept words', bucket: 'c1' }),
      doc(11, { text: 'hidden words', bucket: 'c99', channel: 99 }),
      doc(12, { text: 'gone words', bucket: 'c50', server: 'gone', channel: 50 }),
    ])
    // Conversations refilled recently are not fetched again.
    for (const b of ['c1', 'c2', 'c5', 'd9']) saved.filled[b] = Date.now()
    await saved.save(blobs.store, 'palette:alice:')
    start('full')
    await advance(200, () => fetched.some(u => u.includes('/servers/gone')))
    await advance(10)
    expect(ids('words')).toEqual(['m10'])
    expect(fetched).toContain('/api/servers/gone')
    expect(ids('rockets')).toEqual(['m1'])
    await advance(1700)
    const manifest = await blobs.data.get('palette:alice:manifest')?.text()
    expect(manifest).toContain('"c1"')
    expect(blobs.data.has('palette:alice:c50')).toBe(false)
    setIndexModeNow('off')
    await advance(10)
    expect(paletteIndex()).toBeNull()
    expect([...blobs.data.keys()].some(k => k.startsWith('palette:alice:'))).toBe(false)
  })

  test('edits replace the indexed text, also where the conversation is not loaded', async () => {
    start('loaded')
    await tick()
    indexDocs([doc(77, { text: 'the old secret plan', bucket: 'c2', channel: 2, at: 77 })])
    expect(ids('secret')).toEqual(['m77'])
    __sync.onEvent({
      type: 'message_updated',
      message: msg(77, { channel_id: 2, content: 'nothing to see', author: user('bob') }),
    } as WsEvent)
    expect(ids('secret')).toEqual([])
    expect(ids('nothing')).toEqual(['m77'])
    // Edited to nothing: gone.
    __sync.onEvent({
      type: 'message_updated',
      message: msg(77, { channel_id: 2, content: '   ', author: user('bob') }),
    } as WsEvent)
    expect(ids('nothing')).toEqual([])
    // A stub carries no text: the old text goes.
    expect(ids('rockets')).toEqual(['m1'])
    __sync.onEvent({
      type: 'message_updated',
      stub: true,
      id: 1,
      server: 's',
      channel_id: 1,
      thread_root_id: null,
      edited_at: 5,
    } as WsEvent)
    expect(ids('rockets')).toEqual([])
    // A reloaded list without a message (deleted while away) drops it.
    expect(ids('zebra')).toEqual(['m2'])
    useStore.setState({
      messages: { ...st().messages, c1: [general[0], msg(3, { content: 'newer one' })] },
    })
    expect(ids('zebra')).toEqual([])
  })

  test('full: a refill drops what was deleted or edited meanwhile', async () => {
    const saved = new PaletteIndex(1e9)
    const old = (id: number, text: string) =>
      doc(id, { text, bucket: 'c5', server: 't', channel: 5, at: id })
    saved.add([
      old(41, 'alpha one'),
      old(42, 'alpha two'),
      old(43, 'alpha three'),
      old(44, 'alpha deleted'),
      old(45, 'alpha before edit'),
    ])
    for (const b of ['c1', 'c2', 'd9']) saved.filled[b] = Date.now()
    await saved.save(blobs.store, 'palette:alice:')
    pages.c5 = [
      msg(43, { channel_id: 5, content: 'alpha three', author: user('bob') }),
      msg(45, { channel_id: 5, content: 'alpha after', author: user('bob') }),
    ]
    start('full')
    for (let i = 0; i < 50 && !fetched.some(u => u.includes('/channels/5/messages')); i++)
      await tick()
    for (let i = 0; i < 5; i++) await tick()
    expect(ids('alpha').sort()).toEqual(['m43', 'm45'])
    expect(ids('edit')).toEqual([])
    expect(ids('after')).toEqual(['m45'])
    // What is loaded in that conversation stays.
    expect(ids('otherworld')).toEqual(['m4'])
  })

  test('logout and account switch remove the device copy and never save it again', async () => {
    const saved = new PaletteIndex(1e9)
    saved.add([doc(10, { text: 'kept words', bucket: 'c1' })])
    for (const b of ['c1', 'c2', 'c5', 'd9']) saved.filled[b] = Date.now()
    await saved.save(blobs.store, 'palette:alice:')
    start('full')
    for (let i = 0; i < 10; i++) await tick()
    expect(ids('words')).toEqual(['m10'])
    const puts: string[] = []
    const put = blobs.store.put
    blobs.store.put = (k, b, live) => {
      puts.push(k)
      return put(k, b, live)
    }
    useStore.setState({ me: null, token: null })
    await __sync.settled()
    expect(aliceKeys()).toEqual([])
    useStore.setState({ token: 'tok', me: me('bob') })
    await __sync.settled()
    for (let i = 0; i < 5; i++) await tick()
    expect(aliceKeys()).toEqual([])
    expect(puts.filter(k => k.startsWith('palette:alice:'))).toEqual([])
    expect(paletteIndex()).toBeNull()
  })

  test('a save in progress writes nothing more once the index is turned off', async () => {
    const waiting: (() => void)[] = []
    // Like IndexedDB: `live` is asked when the write's transaction is made.
    blobs.store.put = (k, b, live) => {
      if (live && !live()) return Promise.resolve()
      return new Promise<void>(res =>
        waiting.push(() => {
          blobs.data.set(k, b)
          res()
        })
      )
    }
    start('full')
    for (let i = 0; i < 10; i++) await tick()
    ;(g.document as { visibilityState: string }).visibilityState = 'hidden'
    onHide?.()
    await tick()
    expect(waiting.length).toBe(1)
    setIndexModeNow('off')
    for (let i = 0; i < 20; i++) {
      waiting.shift()?.()
      await tick()
    }
    await __sync.settled()
    expect(aliceKeys()).toEqual([])
  })
})
