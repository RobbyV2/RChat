import { afterEach, describe, expect, test } from 'bun:test'
import { Hub, ManualClock } from './p2p_net'
import {
  deliver,
  general,
  joinWithCode,
  makeMember,
  pump,
  signed,
  stopAll,
  stopMember,
  type Member,
} from './p2p_server_net'
import { b64u, randomBytes } from '../p2p/canonical'
import { PINS_MAX } from '../p2p/dm'
import { blockCount } from '../p2p/hashing'
import { PIN_TEXT, PIN_THREAD_TEXT, THREAD_ROOT_TEXT, type SearchQuery } from '../p2p/server'
import { matches, rebuildStep, rowBytes, searchReady, words } from '../p2p/search'
import { storedSize } from '../p2p/dag'
import { PingLog } from '../p2p/ping_log'
import { applyImport, exportP2p, KDF_MIN, unlockP2p, type Kdf } from '../p2p/transfer'
import { P2pStore } from '../p2p/db'
import { heldKey, purgeServer } from '../p2p/dag'
import { shareKey, shareLive, shareTotal } from '../p2p/shares'
import { threadAct } from '../../components/p2p/p2p_chat'
import { channelReadSkips, threadsSig } from '../p2p/app'
import { SEARCH_META, SEARCH_STALE, SERVER_TOTAL_BYTES } from '../p2p/db'
import {
  byCounter,
  byThreadCounter,
  logValue,
  parseLog,
  pingUnread,
  type PingRec,
} from '../p2p/inbox'

// Threads, pins and local search in P2P servers (Task 24).

afterEach(stopAll)

const failure = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e: Error) => e.message
  )

const query = (q: Partial<SearchQuery> = {}): SearchQuery => ({
  q: '',
  from: null,
  room: null,
  ch: null,
  hasFile: false,
  beforeTs: null,
  afterTs: null,
  ...q,
})

const found = async (m: Member, q: Partial<SearchQuery>) =>
  (await m.servers.search(query(q))).hits.map(h => h.m.body)

const indexRows = (m: Member, room: string, id: string) =>
  m.store.db
    .getAllKeys('search', IDBKeyRange.bound([room], [room, []]))
    .then(keys => keys.filter(k => k[2] === id).length)

const solo = async (name = 'Alice') => {
  const clock = new ManualClock()
  const hub = new Hub()
  const a = await makeMember(hub, name, clock)
  const room = await a.servers.create('Book club')
  return { clock, hub, a, room, ch: general(a, room) }
}

describe('search words', () => {
  test('lowercase NFKD words without marks; a query word matches the words it starts', () => {
    expect(words('Héllo, WÖRLD! foo_bar 123 héllo')).toEqual([
      'hello',
      'world',
      'foo',
      'bar',
      '123',
    ])
    expect(words('ｆｕｌｌ width')).toEqual(['full', 'width'])
    expect(words('x'.repeat(40))[0]).toHaveLength(32)
    expect(matches('The quick brown fox', words('qui BRO'))).toBe(true)
    expect(matches('The quick brown fox', words('uick'))).toBe(false)
    expect(matches('The quick brown fox', words('quick cat'))).toBe(false)
    expect(matches('anything', [])).toBe(true)
  })
})

describe('search index', () => {
  test('built as messages arrive, edits count, newest first, paged with a cursor', async () => {
    const { a, room, ch } = await solo()
    await a.servers.send(room, { ch, body: 'Reading Dune tonight' })
    await a.servers.send(room, { ch, body: 'dune part two' })
    const third = await a.servers.send(room, { ch, body: 'Something else' })
    expect(await found(a, { q: 'dune' })).toEqual(['dune part two', 'Reading Dune tonight'])
    expect(await found(a, { q: 'DUN TON' })).toEqual(['Reading Dune tonight'])
    expect(await found(a, { q: 'missing' })).toEqual([])
    // An edit's words find the message; words it took away no longer do.
    await a.servers.edit(room, third, 'Foundation instead')
    expect(await found(a, { q: 'foundation' })).toEqual(['Foundation instead'])
    expect(await found(a, { q: 'something' })).toEqual([])
    // A new message is found at once.
    await a.servers.send(room, { ch, body: 'dune again' })
    const first = await a.servers.search(query({ q: 'dune' }), null, 2)
    expect(first.hits.map(h => h.m.body)).toEqual(['dune again', 'dune part two'])
    expect(first.next).not.toBeNull()
    const second = await a.servers.search(query({ q: 'dune' }), first.next, 2)
    expect(second.hits.map(h => h.m.body)).toEqual(['Reading Dune tonight'])
    expect(second.next).toBeNull()
    expect(first.hits[0]).toMatchObject({ room, ch, thread: null })
  }, 60_000)

  test('a message deleted by its author leaves the index; one a moderator hid is not found', async () => {
    const { clock, hub, a, room, ch } = await solo()
    const b = await makeMember(hub, 'Bob', clock)
    await joinWithCode(clock, a, room, b)
    const mine = await a.servers.send(room, { ch, body: 'secret plans' })
    expect(await indexRows(a, room, mine)).toBeGreaterThan(0)
    await a.servers.redact(room, mine)
    await pump(clock, async () => (await indexRows(a, room, mine)) === 0, 'unindexed')
    expect(await found(a, { q: 'secret' })).toEqual([])
    const theirs = await b.servers.send(room, { ch, body: 'spam spam' })
    await pump(clock, async () => (await found(a, { q: 'spam' })).length === 1, 'a has it')
    await a.servers.redact(room, theirs)
    await pump(clock, async () => (await found(a, { q: 'spam' })).length === 0, 'hidden')
    await pump(clock, async () => (await found(b, { q: 'spam' })).length === 0, 'hidden at b')
  }, 90_000)

  test('filters: from, in channel, has file, before and after', async () => {
    const { clock, hub, a, room, ch } = await solo()
    const b = await makeMember(hub, 'Bob', clock)
    await joinWithCode(clock, a, room, b)
    await a.servers.addChannel(room, 'second')
    await pump(clock, () => (b.servers.view(room)?.channels.length ?? 0) === 2, 'channel')
    const other = a.servers.view(room)!.channels.find(c => c.name === 'second')!.id
    const t0 = clock.now()
    await a.servers.send(room, { ch, body: 'note one' })
    await clock.advance(60_000)
    const t1 = clock.now()
    await b.servers.send(room, { ch, body: 'note two' })
    await clock.advance(60_000)
    const att = {
      h: b64u(randomBytes(32)),
      size: 10,
      blocks: blockCount(10),
      name: 'a.txt',
      mime: 'text/plain',
    }
    await a.servers.send(room, { ch: other, body: 'note three', att: [att] })
    await pump(clock, async () => (await found(a, { q: 'note' })).length === 3, 'all three')
    expect(await found(a, { q: 'note', from: [b.node.ik] })).toEqual(['note two'])
    expect(await found(a, { from: [a.node.ik] })).toEqual(['note three', 'note one'])
    expect(await found(a, { q: 'note', ch: other })).toEqual(['note three'])
    expect(await found(a, { hasFile: true })).toEqual(['note three'])
    expect(await found(a, { q: 'note', beforeTs: Math.floor(t1 / 1000) })).toEqual(['note one'])
    expect(await found(a, { q: 'note', afterTs: Math.floor(t1 / 1000) })).toEqual(['note three'])
    expect(await found(a, { q: 'note', afterTs: Math.floor(t0 / 1000) - 1, room })).toHaveLength(3)
    expect(await found(a, { q: 'note', room: 'elsewhere' })).toEqual([])
  }, 90_000)

  test('short query words match whole words; a query without words looks for its text', async () => {
    const { a, room, ch } = await solo()
    await a.servers.send(room, { ch, body: 'Dune is a book' })
    await a.servers.send(room, { ch, body: 'du jour' })
    await a.servers.send(room, { ch, body: 'wow !!!' })
    await a.servers.send(room, { ch, body: 'plain' })
    expect(await found(a, { q: 'du' })).toEqual(['du jour'])
    expect(await found(a, { q: 'dun' })).toEqual(['Dune is a book'])
    expect(await found(a, { q: 'a book' })).toEqual(['Dune is a book'])
    expect(await found(a, { q: '!!!' })).toEqual(['wow !!!'])
    expect(await found(a, { q: '***' })).toEqual([])
    expect(matches('du jour', words('du'))).toBe(true)
    expect(matches('dune', words('du'))).toBe(false)
  }, 60_000)

  test('the index counts as storage: rows are added to the room and taken off with them', async () => {
    const { clock, hub, a, room, ch } = await solo()
    const b = await makeMember(hub, 'Bob', clock)
    await joinWithCode(clock, a, room, b)
    // Stored bytes: every event, plus every index row.
    const expected = async (m: Member) => {
      const evs = await m.store.db.getAllFromIndex(
        'events',
        'room_seq',
        IDBKeyRange.bound([room, -Infinity], [room, Infinity])
      )
      const range = IDBKeyRange.bound([room], [room, []])
      const keys = await m.store.db.getAllKeys('search', range)
      const heads = await m.store.db.getAll('search', range)
      return {
        rows: keys.length,
        bytes:
          evs.reduce((n, e) => n + storedSize(e.wire), 0) +
          keys.reduce((n, k, i) => n + rowBytes(k, heads[i]), 0),
      }
    }
    const check = async (m: Member) => {
      const want = await expected(m)
      expect((await m.store.room(room))?.bytes).toBe(want.bytes)
      expect(await m.store.meta(SERVER_TOTAL_BYTES)).toBe(want.bytes)
      return want.rows
    }
    const before = await check(a)
    const id = await a.servers.send(room, { ch, body: 'alpha beta gamma delta' })
    await a.servers.edit(room, id, 'alpha beta epsilon')
    expect(await check(a)).toBe(before + 5)
    await pump(clock, async () => (await found(b, { q: 'epsilon' })).length === 1, 'at b')
    await check(b)
    await a.servers.redact(room, id)
    await pump(clock, async () => (await indexRows(a, room, id)) === 0, 'unindexed')
    expect(await check(a)).toBe(before)
    await pump(clock, async () => (await indexRows(b, room, id)) === 0, 'unindexed at b')
    await check(b)
    // A rebuilt index is counted once.
    await a.store.db.put('meta', SEARCH_STALE, SEARCH_META)
    while (!(await rebuildStep(a.store.db, 3))) {
      // again from the start
    }
    await check(a)
    // A meta of another version clears the index and its bytes, then builds it again.
    await a.servers.send(room, { ch, body: 'kept words here' })
    await a.store.db.put('meta', { v: 99 }, SEARCH_META)
    while (!(await rebuildStep(a.store.db, 3))) {
      // cleared, then built
    }
    expect(await check(a)).toBe(before + 3)
  }, 90_000)

  test('a sender pays for its rows: held bytes and its share; edits add 256 words at most, and leave with their words', async () => {
    const { clock, hub, a, room, ch } = await solo()
    const b = await makeMember(hub, 'Bob', clock)
    await joinWithCode(clock, a, room, b)
    const allRows = async () => {
      const range = IDBKeyRange.bound([room], [room, []])
      const keys = await a.store.db.getAllKeys('search', range)
      const heads = await a.store.db.getAll('search', range)
      return keys.map((k, i) => ({ k, b: rowBytes(k, heads[i]) }))
    }
    const many = (p: string, n: number) => Array.from({ length: n }, (_, i) => `${p}${i}`).join(' ')
    const id = await b.servers.send(room, { ch, body: many('alpha', 200) })
    const edit = await b.servers.edit(room, id, many('beta', 200))
    await pump(clock, async () => (await found(a, { q: 'beta10' })).length === 1, 'edit at a')
    const rows = (await allRows()).filter(r => r.k[2] === id)
    // Body words first, then the edit's, 256 in all.
    expect(rows.length).toBe(256)
    expect(rows.filter(r => r.k[1].startsWith('beta')).length).toBe(56)
    // Bob's held bytes at Alice: his content and his rows.
    const bobs = (await a.store.db.getAll('events')).filter(
      e => e.room === room && e.layer === 'c' && e.sender === b.node.ik && !e.redacted
    )
    const content = bobs.reduce((n, e) => n + storedSize(e.wire), 0)
    const ix = rows.reduce((n, r) => n + r.b, 0)
    expect(await a.store.meta(heldKey(room, b.node.ik))).toBe(content + ix)
    const share = shareTotal(shareLive(await a.store.meta(shareKey(room, b.node.ik)), clock.now()))
    expect(share.b).toBeGreaterThanOrEqual(content + ix)
    // The edit purged: its words go, the body's stay.
    await purgeServer(a.store.db, room, [edit], a.node.ik)
    const left = (await allRows()).filter(r => r.k[2] === id)
    expect(left.length).toBe(200)
    expect(left.every(r => r.k[1].startsWith('alpha'))).toBe(true)
    expect(await a.store.meta(heldKey(room, b.node.ik))).toBe(
      content - storedSize(bobs.find(e => e.id === edit)!.wire) + left.reduce((n, r) => n + r.b, 0)
    )
  }, 90_000)

  test('moving to a new browser twice counts the rebuilt index once', async () => {
    const { clock, hub, a, room, ch } = await solo()
    for (let i = 0; i < 20; i++) await a.servers.send(room, { ch, body: `move words ${i} here` })
    // Room bytes, the servers' total, and what events and rows really take, in one snapshot.
    const real = async (m: Member) => {
      const tx = m.store.db.transaction(['events', 'search', 'rooms', 'meta'])
      const evs = await tx
        .objectStore('events')
        .index('room_seq')
        .getAll(IDBKeyRange.bound([room, -Infinity], [room, Infinity]))
      const range = IDBKeyRange.bound([room], [room, []])
      const keys = await tx.objectStore('search').getAllKeys(range)
      const heads = await tx.objectStore('search').getAll(range)
      const bytes = (await tx.objectStore('rooms').get(room))?.bytes
      const total = await tx.objectStore('meta').get(SERVER_TOTAL_BYTES)
      const want =
        evs.filter(e => !e.purged).reduce((n, e) => n + storedSize(e.wire), 0) +
        keys.reduce((n, k, i) => n + rowBytes(k, heads[i]), 0)
      return { bytes, total, want }
    }
    const kdf: Kdf = { alg: 'argon2id', m: KDF_MIN.m, t: KDF_MIN.t, p: 1 }
    let cur = a
    const first = await real(cur)
    expect([first.bytes, first.total]).toEqual([first.want, first.want])
    for (let move = 0; move < 2; move++) {
      const sec = await exportP2p(cur.store.db, 'correct horse battery', kdf)
      await cur.node.markExported(clock.now())
      stopMember(cur)
      const dump = await unlockP2p(sec, 'correct horse battery')
      const db = `test-move-index-${move}-${Math.random()}`
      const store = await P2pStore.open(db)
      await applyImport(store.db, dump, 'new', { now: clock.now() })
      store.close()
      cur = await makeMember(hub, 'Alice', clock, { db })
      await cur.servers.indexing
      expect(await searchReady(cur.store.db)).toBe(true)
      const now = await real(cur)
      expect([now.bytes, now.total]).toEqual([now.want, now.want])
      expect(await found(cur, { q: 'move' })).toHaveLength(20)
    }
  }, 120_000)

  test('edits arriving out of order keep a message at 256 rows', async () => {
    const { clock, hub, a, room, ch } = await solo()
    const b = await makeMember(hub, 'Bob', clock)
    await joinWithCode(clock, a, room, b)
    const many = (p: string, n: number) => Array.from({ length: n }, (_, i) => `${p}${i}`).join(' ')
    const id = await b.servers.send(room, { ch, body: many('alpha', 200) })
    await pump(clock, async () => (await indexRows(a, room, id)) === 200, 'at a')
    const t0 = clock.now() + 10_000
    // Each edit is dated a second before the last and names none of them, so each sorts first.
    for (const [i, p] of ['beta', 'gamma', 'delta'].entries()) {
      const ev = await signed(
        b,
        room,
        'edit',
        { target: id, body: many(p, 200), ch },
        { ts: t0 - i * 1000, prev: [id] }
      )
      expect(await deliver(b, room, ev.wire, clock.now())).toBe('new')
      expect(await deliver(a, room, ev.wire, clock.now())).toBe('new')
      expect(await indexRows(a, room, id)).toBe(256)
    }
  }, 90_000)

  test('servers this build cannot read are left out of the rebuilt index', async () => {
    const { a, room, ch } = await solo()
    await a.servers.send(room, { ch, body: 'skip me' })
    await a.store.db.clear('search')
    await a.store.db.put('meta', SEARCH_STALE, SEARCH_META)
    while (!(await rebuildStep(a.store.db, 100, r => r === room))) {
      // skipping the room
    }
    expect(await a.store.db.count('search')).toBe(0)
  }, 60_000)

  test('a stale index (an import, the v8 upgrade) is built again step by step', async () => {
    const { a, room, ch } = await solo()
    for (let i = 0; i < 5; i++) await a.servers.send(room, { ch, body: `word${i} common` })
    await a.servers.indexing
    expect(await searchReady(a.store.db)).toBe(true)
    await a.store.db.clear('search')
    await a.store.db.put('meta', SEARCH_STALE, SEARCH_META)
    expect(await found(a, { q: 'common' })).toEqual([])
    let steps = 0
    while (!(await rebuildStep(a.store.db, 2))) steps += 1
    expect(steps).toBeGreaterThan(1)
    expect(await found(a, { q: 'common' })).toHaveLength(5)
    expect(await found(a, { q: 'word3' })).toEqual(['word3 common'])
  }, 60_000)
})

describe('threads', () => {
  test('replies from both sides, counts, and replies stay out of the channel', async () => {
    const { clock, hub, a, room, ch } = await solo()
    const b = await makeMember(hub, 'Bob', clock)
    await joinWithCode(clock, a, room, b)
    const root = await a.servers.send(room, { ch, body: 'Which book next?' })
    await pump(clock, async () => (await b.servers.loadThread(room, root)) !== null, 'root at b')
    await b.servers.send(room, { ch, body: 'Dune', thread: root })
    await clock.advance(1000)
    await a.servers.send(room, { ch, body: 'Good pick', thread: root })
    await pump(
      clock,
      async () => (await a.servers.loadThread(room, root))?.messages.length === 2,
      'both replies at a'
    )
    await pump(
      clock,
      async () => (await b.servers.loadThread(room, root))?.messages.length === 2,
      'both replies at b'
    )
    const t = (await a.servers.loadThread(room, root))!
    expect(t.root?.body).toBe('Which book next?')
    expect(t.root?.replies).toBe(2)
    expect(t.messages.map(m => [m.body, m.thread])).toEqual([
      ['Dune', root],
      ['Good pick', root],
    ])
    const main = (await a.servers.loadChannel(room, ch)).messages.filter(m => !m.system)
    expect(main.map(m => m.body)).toEqual(['Which book next?'])
    expect(main[0].replies).toBe(2)
    expect(main[0].lastReply).toBe(t.messages[1].ts)
    // Thread replies aren't unread in the channel.
    expect(a.servers.view(room)!.chans[ch]?.unread ?? 0).toBe(0)
    // Search finds thread replies, with their thread.
    const hit = (await a.servers.search(query({ q: 'dune' }))).hits[0]
    expect(hit).toMatchObject({ room, ch, thread: root })
    // Threads start only on top-level messages of the same channel.
    const reply = t.messages[0].id
    expect(await failure(b.servers.send(room, { ch, body: 'nested', thread: reply }))).toBe(
      THREAD_ROOT_TEXT
    )
    await a.servers.addChannel(room, 'other')
    const other = a.servers.view(room)!.channels.find(c => c.name === 'other')!.id
    expect(await failure(a.servers.send(room, { ch: other, body: 'x', thread: root }))).toBe(
      THREAD_ROOT_TEXT
    )
    // A deleted reply comes off the count.
    await b.servers.redact(room, reply)
    await pump(
      clock,
      async () =>
        (await a.servers.loadChannel(room, ch)).messages.find(m => m.id === root)?.replies === 1,
      'count after delete'
    )
  }, 90_000)

  test('a reply naming a root that is missing, elsewhere or itself a reply shows in its channel', async () => {
    const { clock, hub, a, room, ch } = await solo()
    const b = await makeMember(hub, 'Bob', clock)
    await joinWithCode(clock, a, room, b)
    await a.servers.addChannel(room, 'other')
    await pump(clock, () => (b.servers.view(room)?.channels.length ?? 0) === 2, 'channel')
    const other = a.servers.view(room)!.channels.find(c => c.name === 'other')!.id
    const root = await a.servers.send(room, { ch, body: 'root' })
    const reply = await a.servers.send(room, { ch, body: 'real reply', thread: root })
    await pump(
      clock,
      async () => (await b.servers.loadThread(room, root))?.messages.length === 1,
      'b'
    )
    await a.servers.markRead(room, ch)
    const forged = [
      { body: '@Alice ghost', ch, thread: b64u(randomBytes(32)), mentions: [a.node.ik] },
      { body: 'cross', ch: other, thread: root },
      { body: 'nested', ch, thread: reply },
    ]
    // Signed and stored at Bob as a modified client would; Alice gets them by sync.
    for (const c of forged) {
      const ev = await signed(b, room, 'msg', c)
      expect(await deliver(b, room, ev.wire, clock.now())).toBe('new')
    }
    // Bob's next message cites them, so Alice fetches them.
    await b.servers.send(room, { ch, body: 'after' })
    await pump(
      clock,
      async () =>
        (await a.servers.loadChannel(room, ch)).messages.filter(m => !m.system).length === 4 &&
        (await a.servers.loadChannel(room, other)).messages.length === 1,
      'forged at a'
    )
    const main = (await a.servers.loadChannel(room, ch)).messages.filter(m => !m.system)
    expect(main.map(m => [m.body, m.thread ?? null]).sort()).toEqual([
      ['@Alice ghost', null],
      ['after', null],
      ['nested', null],
      ['root', null],
    ])
    expect(main.find(m => m.id === root)?.replies).toBe(1)
    // They show in the channel but start no thread (one rule for every check).
    for (const body of ['@Alice ghost', 'nested']) {
      const m = main.find(x => x.body === body)!
      expect(m.noThread).toBe(true)
      expect(threadAct(m, true)).toBeNull()
      expect(await failure(a.servers.send(room, { ch, body: 'x', thread: m.id }))).toBe(
        THREAD_ROOT_TEXT
      )
    }
    expect(
      threadAct(
        main.find(m => m.id === root)!,
        true
      )
    ).toBe('View thread')
    expect((await a.servers.loadChannel(room, other)).messages.map(m => m.body)).toEqual(['cross'])
    expect((await a.servers.loadThread(room, root))?.messages.map(m => m.body)).toEqual([
      'real reply',
    ])
    // They count as channel messages: unread, and the mention is a channel ping.
    const c = a.servers.view(room)!.chans[ch]
    expect(c).toMatchObject({ unread: 3, pings: 1 })
    expect(c.threads).toBeUndefined()
    expect(await failure(a.servers.pin(room, main.find(m => m.body === 'nested')!.id, true))).toBe(
      'ok'
    )
  }, 90_000)

  test('a root whose body was evicted keeps its reply count and "View thread"', async () => {
    const { clock, hub, a, room, ch } = await solo()
    const b = await makeMember(hub, 'Bob', clock)
    await joinWithCode(clock, a, room, b)
    const root = await a.servers.send(room, { ch, body: 'root' })
    await a.servers.send(room, { ch, body: 'reply', thread: root })
    await pump(
      clock,
      async () => (await b.servers.loadThread(room, root))?.messages.length === 1,
      'b'
    )
    await purgeServer(b.store.db, room, [root], b.node.ik, true)
    const row = (await b.servers.loadChannel(room, ch)).messages.find(m => m.id === root)!
    expect(row).toMatchObject({ unavailable: true, replies: 1 })
    expect(threadAct(row, true)).toBe('View thread')
    const t = (await b.servers.loadThread(room, root))!
    expect(t.root?.unavailable).toBe(true)
    expect(t.messages.map(m => m.body)).toEqual(['reply'])
    // Replying there works too.
    await b.servers.send(room, { ch, body: 'second', thread: root })
    expect((await b.servers.loadThread(room, root))?.messages.map(m => m.body)).toEqual([
      'reply',
      'second',
    ])
  }, 90_000)

  test('typing in a thread shows in that thread only (ttyping), and a reply ends it', async () => {
    const { clock, hub, a, room, ch } = await solo()
    const b = await makeMember(hub, 'Bob', clock)
    await joinWithCode(clock, a, room, b)
    const root = await a.servers.send(room, { ch, body: 'root' })
    await pump(clock, async () => (await b.servers.loadThread(room, root)) !== null, 'root at b')
    a.servers.typing(room, ch, true, root)
    await pump(clock, () => b.servers.typingIn(room, ch, root).includes(a.node.ik), 'typing', 100)
    expect(b.servers.typingIn(room, ch)).toEqual([])
    await a.servers.send(room, { ch, body: 'reply', thread: root })
    await pump(clock, () => b.servers.typingIn(room, ch, root).length === 0, 'stopped', 100)
    // A malformed root is a strike; an op this version doesn't know is ignored.
    const toB = a.node.readySessions(b.node.ik)[0]
    const atB = b.node.readySessions(a.node.ik)[0]
    const strikes = atB.strikes
    await toB.send({ t: 'xtyping', room, ch, root, on: true })
    await clock.advance(1_000)
    expect(atB.strikes).toBe(strikes)
    await toB.send({ t: 'ttyping', room, ch, root: 'nope', on: true })
    await pump(clock, () => atB.strikes === strikes + 1, 'strike', 100)
  }, 90_000)

  test('thread pings stay after the channel is read, and go when the thread is read', async () => {
    const { clock, hub, a, room, ch } = await solo()
    const b = await makeMember(hub, 'Bob', clock)
    await joinWithCode(clock, a, room, b)
    const root = await a.servers.send(room, { ch, body: 'root' })
    await pump(clock, async () => (await b.servers.loadThread(room, root)) !== null, 'root at b')
    const pings: (string | null)[] = []
    a.servers.onArrive(x => void (x.ping && pings.push(x.thread)))
    await b.servers.send(room, { ch, body: '@Alice look', thread: root })
    await b.servers.send(room, { ch, body: 'plain reply', thread: root })
    await b.servers.send(room, { ch, body: 'in the channel' })
    await pump(clock, () => (a.servers.view(room)!.chans[ch]?.unread ?? 0) === 1, 'unread')
    const c = a.servers.view(room)!.chans[ch]
    expect(c).toMatchObject({ unread: 1, pings: 1, threads: { [root]: 1 } })
    expect(pings).toEqual([root])
    await a.servers.markRead(room, ch)
    expect(a.servers.view(room)!.chans[ch]).toMatchObject({
      unread: 0,
      pings: 1,
      threads: { [root]: 1 },
    })
    await a.servers.markThread(room, ch, root)
    const after = a.servers.view(room)!.chans[ch]
    expect(after).toMatchObject({ unread: 0, pings: 0 })
    expect(after.threads).toBeUndefined()
  }, 90_000)
})

describe('thread pings that stop counting', () => {
  test('reading the channel takes off pings whose reply or root no longer shows', async () => {
    const { clock, hub, a, room, ch } = await solo()
    const b = await makeMember(hub, 'Bob', clock)
    await joinWithCode(clock, a, room, b)
    const roots = [
      await b.servers.send(room, { ch, body: 'r1' }),
      await b.servers.send(room, { ch, body: 'r2' }),
      await b.servers.send(room, { ch, body: 'r3' }),
    ]
    const replies: string[] = []
    for (const [i, r] of roots.entries())
      replies.push(await b.servers.send(room, { ch, body: `@Alice reply ${i}`, thread: r }))
    await pump(
      clock,
      () => Object.keys(a.servers.view(room)!.chans[ch]?.threads ?? {}).length === 3,
      'three thread pings'
    )
    await b.servers.redact(room, replies[0])
    await b.servers.redact(room, roots[1])
    await pump(
      clock,
      async () =>
        (await a.servers.loadThread(room, roots[0]))?.messages.length === 0 &&
        !(await a.servers.loadChannel(room, ch)).messages.some(m => m.id === roots[1]),
      'deletes at a'
    )
    expect(a.servers.view(room)!.chans[ch]).toMatchObject({ pings: 3 })
    const log = replies.map((id, i) => ({ id, thread: roots[i] }))
    expect(await a.servers.readChannel(room, ch, log)).toEqual([replies[0], replies[1]])
    expect(a.servers.view(room)!.chans[ch]).toMatchObject({
      unread: 0,
      pings: 1,
      threads: { [roots[2]]: 1 },
    })
    // A counted ping the log no longer has goes too.
    expect(await a.servers.readChannel(room, ch, [])).toEqual([])
    expect(a.servers.view(room)!.chans[ch]).toMatchObject({ pings: 0 })
    expect(a.servers.view(room)!.chans[ch].threads).toBeUndefined()
  }, 90_000)
})

describe('reading a channel again', () => {
  test('a deletion after the last read moves the position, so Mark as read checks again', async () => {
    const { clock, hub, a, room, ch } = await solo()
    const b = await makeMember(hub, 'Bob', clock)
    await joinWithCode(clock, a, room, b)
    const root = await b.servers.send(room, { ch, body: 'root' })
    const reply = await b.servers.send(room, { ch, body: '@Alice look', thread: root })
    await pump(clock, () => a.servers.view(room)!.chans[ch]?.threads?.[root] === 1, 'pinged')
    // Alice reads the channel: the ping is live and stays; the check is remembered.
    const log = [{ id: reply, thread: root }]
    expect(await a.servers.readChannel(room, ch, log)).toEqual([])
    let v = a.servers.view(room)!
    const checked = threadsSig(v.chans[ch], v.seq)
    expect(channelReadSkips(v.chans[ch], v.seq, checked)).toBe(true)
    // Bob deletes the reply: the counters stay the same, the stored position moves.
    await b.servers.redact(room, reply)
    await pump(
      clock,
      async () => (await a.servers.loadThread(room, root))?.messages.length === 0,
      'deleted at a'
    )
    v = a.servers.view(room)!
    expect(v.chans[ch].threads).toEqual({ [root]: 1 })
    expect(channelReadSkips(v.chans[ch], v.seq, checked)).toBe(false)
    expect(await a.servers.readChannel(room, ch, log)).toEqual([reply])
    expect(a.servers.view(room)!.chans[ch]).toMatchObject({ pings: 0 })
    // A ping counted after the counters were taken (and after the log was read) stays.
    await b.servers.send(room, { ch, body: '@Alice again', thread: root })
    await pump(clock, () => a.servers.view(room)!.chans[ch]?.threads?.[root] === 1, 'again')
    expect(await a.servers.readChannel(room, ch, [], {})).toEqual([])
    expect(a.servers.view(room)!.chans[ch]).toMatchObject({ pings: 1, threads: { [root]: 1 } })
    // Unread messages always read; with nothing left there is nothing to do.
    expect(channelReadSkips({ unread: 1, pings: 0 }, 5, undefined)).toBe(false)
    expect(channelReadSkips({ unread: 0, pings: 0 }, 5, undefined)).toBe(true)
  }, 90_000)
})

describe('the ping log with thread pings', () => {
  test('marking a thread ping takes it off its thread and channel; seen ones leave the list', async () => {
    const { clock, hub, a, room, ch } = await solo()
    const b = await makeMember(hub, 'Bob', clock)
    await joinWithCode(clock, a, room, b)
    const log = new PingLog({ store: a.store, dms: a.dms, servers: a.servers, now: clock.now })
    a.servers.onArrive(x => x.ping && log.note(x.room, x.ch, x.ping, x.rec, x.thread))
    const root = await b.servers.send(room, { ch, body: 'root' })
    const one = await b.servers.send(room, { ch, body: '@Alice one', thread: root })
    const two = await b.servers.send(room, { ch, body: '@Alice two', thread: root })
    await pump(clock, () => a.servers.view(room)!.chans[ch]?.threads?.[root] === 2, 'pinged')
    await a.servers.markRead(room, ch)
    expect((await log.threadPings(room, ch)).map(p => [p.id, p.thread]).sort()).toEqual(
      [
        [one, root],
        [two, root],
      ].sort()
    )
    expect(await log.mark([one])).toBe(1)
    expect(a.servers.view(room)!.chans[ch]).toMatchObject({ pings: 1, threads: { [root]: 1 } })
    await log.seen([two])
    expect(await log.threadPings(room, ch)).toEqual([])
    expect(a.servers.view(room)!.chans[ch]).toMatchObject({ pings: 1 })
    log.stop()
  }, 90_000)
})

describe('thread pings in the inbox', () => {
  test('stay unread past the channel read position, and count per thread', () => {
    const p: PingRec = {
      id: 'x',
      room: 'r',
      ch: 'c',
      kind: 'mention',
      actor: 'a',
      at: 1,
      seq: 5,
      emoji: null,
      target: null,
      seen: false,
      thread: 't',
    }
    const read = new Map([['r/c', 10]])
    expect(pingUnread(p, read)).toBe(true)
    expect(pingUnread({ ...p, seen: true }, read)).toBe(false)
    expect(pingUnread({ ...p, thread: null }, read)).toBe(false)
    expect([...byCounter([p, { ...p, id: 'y', thread: null }])]).toEqual([['r/c', 2]])
    expect([...byThreadCounter([p, { ...p, id: 'y', thread: null }])]).toEqual([
      ['r/c#t', 1],
      ['r/c', 1],
    ])
    expect(parseLog(logValue([p]))[0].thread).toBe('t')
    expect(parseLog({ v: 1, list: [{ ...p, thread: 7 }] })[0].thread).toBeNull()
  })
})

describe('pins', () => {
  test('a pin signed by a member without Manage messages makes no pin and no line', async () => {
    const { clock, hub, a, room, ch } = await solo()
    const b = await makeMember(hub, 'Bob', clock)
    await joinWithCode(clock, a, room, b)
    const m = await a.servers.send(room, { ch, body: 'pin me' })
    await pump(clock, async () => (await b.servers.loadThread(room, m)) !== null, 'at b')
    const ev = await signed(b, room, 'pin', { target: m, on: true, ch })
    expect(await deliver(b, room, ev.wire, clock.now())).toBe('new')
    await b.servers.send(room, { ch, body: 'after' })
    await pump(
      clock,
      async () => (await a.servers.loadChannel(room, ch)).messages.some(x => x.body === 'after'),
      'after at a'
    )
    expect(await a.store.event(ev.id)).not.toBeUndefined()
    const rows = (await a.servers.loadChannel(room, ch)).messages
    expect(rows.filter(x => x.system?.kind === 'pin')).toEqual([])
    expect(rows.find(x => x.id === m)?.pinned).toBeNull()
    expect(await a.servers.loadPins(room, ch)).toEqual([])
  }, 90_000)

  test('Manage messages pins top-level messages, at most 100 a channel, with a line each', async () => {
    const { clock, hub, a, room, ch } = await solo()
    const b = await makeMember(hub, 'Bob', clock)
    await joinWithCode(clock, a, room, b)
    const ids: string[] = []
    for (let i = 0; i <= PINS_MAX; i++) ids.push(await a.servers.send(room, { ch, body: `m${i}` }))
    await pump(clock, async () => (await b.servers.loadThread(room, ids[0])) !== null, 'at b')
    expect(await failure(b.servers.pin(room, ids[0], true))).toBe(PIN_TEXT)
    const reply = await a.servers.send(room, { ch, body: 'in thread', thread: ids[0] })
    expect(await failure(a.servers.pin(room, reply, true))).toBe(PIN_THREAD_TEXT)
    for (let i = 0; i < PINS_MAX; i++) await a.servers.pin(room, ids[i], true)
    expect(await a.servers.loadPins(room, ch)).toHaveLength(PINS_MAX)
    expect(await failure(a.servers.pin(room, ids[PINS_MAX], true))).toBe(
      `You can pin up to ${PINS_MAX} messages`
    )
    // The latest pin event of a message decides (by time, then id).
    await clock.advance(1000)
    await a.servers.pin(room, ids[0], false)
    await a.servers.pin(room, ids[PINS_MAX], true)
    expect(await a.servers.loadPins(room, ch)).toHaveLength(PINS_MAX)
    const lines = (await a.servers.loadChannel(room, ch, { limit: 1000 })).messages.filter(
      m => m.system?.kind === 'pin'
    )
    // One line per pin that went on (the unpin adds none), each linking its message.
    expect(lines).toHaveLength(PINS_MAX + 1)
    expect(lines.every(l => l.system?.ik === a.node.ik)).toBe(true)
    expect(lines[lines.length - 1].system?.target).toBe(ids[PINS_MAX])
    // A pin line's message that is gone shows no link.
    await a.servers.redact(room, ids[1])
    const gone = (await a.servers.loadChannel(room, ch, { limit: 1000 })).messages.find(
      m => m.system?.kind === 'pin' && m.system.target === null
    )
    expect(gone).not.toBeUndefined()
  }, 180_000)
})

describe('storage v8', () => {
  test('a v7 store with data upgrades to v8: every row kept, the thread index and the search index built after', async () => {
    const { openDB } = await import('idb')
    const { UPGRADES, P2pStore: Store, DB_VERSION } = await import('../p2p/db')
    const name = `upgrade-v8-${Math.random()}`
    const v7 = await openDB(name, 7, {
      upgrade(db, _old, _new, tx) {
        for (const up of UPGRADES.slice(0, 7)) up(db as never, tx as never)
      },
    })
    const id = () => b64u(randomBytes(32))
    const [root, reply, edit, dm] = [id(), id(), id(), id()]
    const ev = (eid: string, t: string, c: Record<string, unknown>, extra = {}) => ({
      id: eid,
      room: 'srv',
      type: t,
      sender: 'alice',
      wire: { ev: { t, L: 'c' }, c, sig: '' },
      depth: 1,
      effTs: 1,
      sortKey: `k${eid}`,
      receivedAt: 1,
      seq: 1,
      redacted: false,
      layer: 'c',
      chan: 'ch',
      ...extra,
    })
    await v7.put('rooms', { id: 'srv', kind: 'server', peer: '', heads: [], missing: [] })
    await v7.put('events', ev(root, 'msg', { body: 'Hello world', ch: 'ch' }))
    await v7.put('events', ev(reply, 'msg', { body: 'In a thread', ch: 'ch', thread: root }))
    await v7.put(
      'events',
      ev(edit, 'edit', { target: root, body: 'Hello there', ch: 'ch' }, { target: root })
    )
    await v7.put('events', {
      id: dm,
      room: 'dm',
      type: 'msg',
      sender: 'alice',
      wire: { ev: { type: 'msg' }, c: { body: 'direct hello' }, sig: '' },
      sortKey: 'kd',
      seq: 1,
      redacted: false,
    })
    await v7.put('meta', 7, 'schema')
    await v7.put('meta', 4, 'events')
    v7.close()
    const store = await Store.open(name)
    expect(DB_VERSION).toBe(8)
    expect(store.db.version).toBe(8)
    expect(await store.meta('schema')).toBe(8)
    expect(await store.meta('events')).toBe(4)
    expect(await store.db.count('events')).toBe(4)
    expect(await store.db.count('search')).toBe(0)
    expect(await store.meta(SEARCH_META)).toEqual(SEARCH_STALE)
    expect((await store.room('srv'))?.kind).toBe('server')
    while (!(await rebuildStep(store.db, 1))) {
      // one event a step
    }
    expect(await searchReady(store.db)).toBe(true)
    // Rows written before threads existed get their root; nothing else changes.
    expect((await store.event(reply))?.thread).toBe(root)
    expect((await store.event(root))?.thread).toBeUndefined()
    expect((await store.event(dm))?.wire.c).toEqual({ body: 'direct hello' })
    expect(
      await store.db.countFromIndex(
        'events',
        'room_thread_sort',
        IDBKeyRange.bound(['srv', root, ''], ['srv', root, '￿'])
      )
    ).toBe(1)
    const tokens = (await store.db.getAllKeys('search')).map(k => `${k[1]}:${k[2] === root}`)
    expect(tokens.sort()).toEqual(
      ['hello:true', 'world:true', 'there:true', 'in:false', 'a:false', 'thread:false'].sort()
    )
    store.close()
    // Opening again changes nothing.
    const again = await Store.open(name)
    expect(again.db.version).toBe(8)
    expect(await again.db.count('events')).toBe(4)
    expect(await again.db.count('search')).toBe(6)
    expect(await searchReady(again.db)).toBe(true)
    expect(await rebuildStep(again.db)).toBe(true)
    again.close()
  })
})
