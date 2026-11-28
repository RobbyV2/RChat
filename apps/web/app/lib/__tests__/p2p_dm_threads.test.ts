import { waitUntil } from './helpers/test_clock'
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { Hub, makeNode, ManualClock, waitFor } from './p2p_net'
import type { P2pNode } from '../p2p/node'
import type { P2pStore } from '../p2p/db'
import {
  backfillThreads,
  backfillThreadsSafely,
  Dms,
  dmRoomId,
  loadDmThread,
  loadDmThreadAround,
  loadDmThreads,
  loadMessages,
  THREAD_ROOT_TEXT,
  THREADS_BACKFILL,
} from '../p2p/dm'
import { PingLog } from '../p2p/ping_log'
import { threadKey } from '../p2p/app'
import { threadAct } from '../place/rows'

// Threads in P2P conversations: replies live in their thread, on both sides.

setDefaultTimeout(60_000)

const live: { node: P2pNode; dms: Dms }[] = []
afterEach(() => {
  for (const x of live.splice(0)) {
    x.dms.stop()
    x.node.stop()
  }
})

interface Peer {
  node: P2pNode
  store: P2pStore
  dms: Dms
}

const makePeer = async (hub: Hub, name: string, clock: ManualClock): Promise<Peer> => {
  const n = await makeNode(hub, name, { clock })
  const dms = new Dms({ node: n.node, store: n.store, clock })
  live.push({ node: n.node, dms })
  return { ...n, dms }
}

const eventually = (ok: () => Promise<boolean>, what: string, ms = 50_000) =>
  waitUntil(ok, what, ms)

const failure = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e: Error) => e.message
  )

const pair = async () => {
  const clock = new ManualClock()
  const hub = new Hub()
  const a = await makePeer(hub, 'Alice', clock)
  const b = await makePeer(hub, 'Bob', clock)
  await a.node.start()
  await b.node.start()
  await a.node.addContact(await b.node.myCard())
  await waitFor(() => b.node.contact(a.node.ik)?.state === 'incoming', 'request')
  await b.node.accept(a.node.ik)
  const room = dmRoomId(a.node.ik, b.node.ik)
  await waitFor(() => a.dms.online(room) && b.dms.online(room), 'sync links')
  await a.dms.open(b.node.ik)
  await b.dms.open(a.node.ik)
  return { clock, a, b, room }
}

const other = (p: Peer, a: Peer, b: Peer) => (p === a ? b : a)

const main = async (p: Peer, peer: Peer, room: string) =>
  (await loadMessages(p.store.db, room, p.node.ik, peer.node.ik, { limit: 1000 })).messages

describe('conversation threads', () => {
  test('replies show in their thread, not the conversation, with counts on both sides', async () => {
    const { clock, a, b, room } = await pair()
    const root = await a.dms.send(room, { body: 'Plans for Saturday' })
    const other1 = await a.dms.send(room, { body: 'Unrelated' })
    await eventually(async () => (await main(b, a, room)).length === 2, 'roots at Bob')
    const r1 = await b.dms.send(room, { body: 'Hiking?', thread: root })
    await clock.advance(1000)
    const r2 = await a.dms.send(room, { body: 'Yes', thread: root, reply: r1 })
    for (const p of [a, b]) {
      const peer = other(p, a, b)
      await eventually(
        async () =>
          (await loadDmThread(p.store.db, room, root, p.node.ik, peer.node.ik))?.messages.length ===
          2,
        'both replies'
      )
      const list = await main(p, peer, room)
      expect(list.map(m => m.id)).toEqual([root, other1])
      expect(list[0]).toMatchObject({ replies: 2 })
      expect(list[1].replies).toBeUndefined()
      const t = (await loadDmThread(p.store.db, room, root, p.node.ik, peer.node.ik))!
      expect(t.root?.body).toBe('Plans for Saturday')
      expect(t.messages.map(m => [m.id, m.thread])).toEqual([
        [r1, root],
        [r2, root],
      ])
      expect(t.messages[1].reply?.id).toBe(r1)
      expect(list[0].lastReply).toBe(t.messages[1].ts)
      const threads = await loadDmThreads(p.store.db, room, p.node.ik, peer.node.ik)
      expect(threads.map(x => [x.root.id, x.root.replies])).toEqual([[root, 2]])
      expect(threads[0].last).toBe((await p.store.event(r2))!.sortKey)
      const around = await loadDmThreadAround(p.store.db, room, root, p.node.ik, peer.node.ik, r1)
      expect(around?.messages.map(m => m.id)).toEqual([r1, r2])
    }
    // The first unread message of the conversation is never a thread reply.
    const first = await a.store.firstMessageAfter(room, 0, a.node.ik)
    expect(first).toBeNull()
    // A deleted reply comes off the count; the thread stays while one shows.
    await b.dms.redact(room, r1)
    await eventually(
      async () => (await main(a, b, room))[0].replies === 1,
      'count after the delete'
    )
  })

  test('threads start only on top-level messages of the same conversation', async () => {
    const { a, room } = await pair()
    const root = await a.dms.send(room, { body: 'root' })
    const reply = await a.dms.send(room, { body: 'reply', thread: root })
    expect(await failure(a.dms.send(room, { body: 'nested', thread: reply }))).toBe(
      THREAD_ROOT_TEXT
    )
    expect(await failure(a.dms.send(room, { body: 'nowhere', thread: 'x'.repeat(43) }))).toBe(
      THREAD_ROOT_TEXT
    )
    expect(await loadDmThread(a.store.db, room, reply, a.node.ik, '')).toBeNull()
  })

  test('rows of a conversation offer threads like a channel', () => {
    const row = {
      id: 'm',
      sender: 's',
      ts: 1,
      sentTs: 1,
      sortKey: 'k',
      seq: 1,
      body: 'x',
      reply: null,
      mentions: [],
      fwd: null,
      att: [],
      edited: null,
      reactions: [],
      pinned: null,
      late: false,
      pending: false,
      failed: false,
      call: null,
    }
    expect(threadAct(row, true)).toBe('Create thread')
    expect(threadAct({ ...row, replies: 2 }, false)).toBe('View thread')
    expect(threadAct({ ...row, thread: 'r' }, true)).toBeNull()
    expect(threadAct({ ...row, noThread: true }, true)).toBeNull()
  })

  test('draft keys of conversation threads have no channel', () => {
    expect(threadKey({ room: 'r', ch: null, root: 'x' })).toBe('r#x')
    expect(threadKey({ room: 'r', ch: 'c', root: 'x' })).toBe('r/c#x')
  })

  test('thread replies count in their thread: reading the conversation, then the thread', async () => {
    const { clock, a, b, room } = await pair()
    const log = new PingLog({
      store: a.store,
      dms: a.dms,
      servers: { unping: async () => {} },
      now: clock.now,
    })
    const arrivals: (string | null)[] = []
    a.dms.onArrive(x => {
      arrivals.push(x.thread)
      if (x.ping) log.note(x.room, null, x.ping, x.rec, x.thread)
    })
    const root = await a.dms.send(room, { body: 'root' })
    await eventually(async () => (await main(b, a, room)).length === 1, 'root at Bob')
    const mention = await b.dms.send(room, { body: '@Alice look', thread: root })
    await b.dms.send(room, { body: 'plain reply', thread: root })
    const counts = async () => {
      const r = (await a.store.room(room))!
      return { unread: r.unread, pings: r.pings, threads: r.threads ?? {} }
    }
    await eventually(async () => (await counts()).threads[root] === 1, 'thread ping at Alice')
    await eventually(async () => arrivals.length === 2, 'arrivals')
    expect(arrivals).toEqual([root, root])
    expect(await counts()).toEqual({ unread: 0, pings: 0, threads: { [root]: 1 } })
    // Reading the conversation leaves the thread's ping.
    await a.dms.markRead(room)
    expect(await counts()).toEqual({ unread: 0, pings: 0, threads: { [root]: 1 } })
    const top = await b.dms.send(room, { body: '@Alice and here' })
    await eventually(async () => (await counts()).pings === 1, 'top-level ping')
    expect(await counts()).toEqual({ unread: 1, pings: 1, threads: { [root]: 1 } })
    // Reading the thread takes off its ping only.
    const ids = await log.ofThread(room, null, root)
    expect(ids).toEqual([mention])
    expect(await log.mark(ids)).toBe(1)
    await a.dms.markThread(room, root)
    expect(await counts()).toEqual({ unread: 1, pings: 1, threads: {} })
    expect(await log.threadPings(room, null)).toEqual([])
    expect((await log.read()).list.find(p => p.id === top)?.thread).toBeNull()
    log.stop()
  })

  test('a reply naming a root that is not in the conversation is a plain message', async () => {
    const { a, b, room } = await pair()
    const nowhere = 'A'.repeat(43)
    const create = (
      b.dms as unknown as {
        create: (room: string, type: 'msg', c: Record<string, unknown>) => Promise<string>
      }
    ).create.bind(b.dms)
    const id = await create(room, 'msg', { body: 'stray', thread: nowhere })
    await eventually(async () => (await main(a, b, room)).some(m => m.id === id), 'stray at Alice')
    const row = (await main(a, b, room)).find(m => m.id === id)!
    expect(row.noThread).toBe(true)
    expect((await a.store.room(room))!.unread).toBe(1)
    expect(await loadDmThreads(a.store.db, room, a.node.ik, b.node.ik)).toEqual([])
  })

  test('typing in a thread shows in that thread only', async () => {
    const { a, b, room } = await pair()
    const root = await a.dms.send(room, { body: 'root' })
    b.dms.typing(room, true, root)
    await eventually(async () => a.dms.typingIn(room, root).length === 1, 'typing in the thread')
    expect(a.dms.typingIn(room, root)).toEqual([b.node.ik])
    expect(a.dms.typingIn(room)).toEqual([])
    b.dms.typing(room, true)
    await eventually(async () => a.dms.typingIn(room).length === 1, 'typing in the conversation')
  })

  test('a deleted root takes no replies', async () => {
    const { a, room } = await pair()
    const root = await a.dms.send(room, { body: 'root' })
    await a.dms.redact(room, root)
    expect(await failure(a.dms.send(room, { body: 'late', thread: root }))).toBe(THREAD_ROOT_TEXT)
  })

  test('replies stored without their thread mark move into their thread, each once', async () => {
    const { a, b, room } = await pair()
    const root = await a.dms.send(room, { body: 'root' })
    const first = await a.dms.send(room, { body: 'first', thread: root })
    const second = await a.dms.send(room, { body: 'second', thread: root })
    const unmark = async (id: string) => {
      const old = { ...(await a.store.event(id))! }
      delete old.thread
      await a.store.db.put('events', old)
    }
    await unmark(first)
    await unmark(second)
    await a.store.db.delete('meta', THREADS_BACKFILL)
    expect((await main(a, b, room)).map(m => m.id)).toEqual([root, first, second])
    // A run that stopped after fixing one record leaves the flag unset: the next run fixes only
    // what is left.
    await a.store.db.put('events', { ...(await a.store.event(first))!, thread: root })
    expect(await backfillThreads(a.store.db)).toEqual([room])
    expect((await main(a, b, room)).map(m => m.id)).toEqual([root])
    expect((await a.store.event(second))!.thread).toBe(root)
    await a.store.db.delete('meta', THREADS_BACKFILL)
    expect(await backfillThreads(a.store.db)).toEqual([])
    expect(await a.store.db.get('meta', THREADS_BACKFILL)).toBe(true)
    expect(await backfillThreads(a.store.db)).toEqual([])
  })

  test('a backfill that fails leaves P2P starting, and tries again next start', async () => {
    const puts: unknown[] = []
    const broken = {
      get: async () => undefined,
      getAll: async () => {
        throw new DOMException('full', 'QuotaExceededError')
      },
      put: async (...args: unknown[]) => void puts.push(args),
    } as unknown as Parameters<typeof backfillThreadsSafely>[0]
    expect(await backfillThreadsSafely(broken)).toEqual([])
    expect(puts).toEqual([])
  })

  test('a thread ping whose reply is deleted comes off when the conversation is read', async () => {
    const { clock, a, b, room } = await pair()
    const log = new PingLog({
      store: a.store,
      dms: a.dms,
      servers: { unping: async () => {} },
      now: clock.now,
    })
    a.dms.onArrive(x => x.ping && log.note(x.room, null, x.ping, x.rec, x.thread))
    const root = await a.dms.send(room, { body: 'root' })
    const other = await a.dms.send(room, { body: 'other root' })
    await eventually(async () => (await main(b, a, room)).length === 2, 'roots at Bob')
    const gone = await b.dms.send(room, { body: '@Alice gone soon', thread: root })
    const kept = await b.dms.send(room, { body: '@Alice still here', thread: other })
    const threads = async () => (await a.store.room(room))!.threads ?? {}
    await eventually(async () => Object.keys(await threads()).length === 2, 'thread pings')
    await b.dms.redact(room, gone)
    await eventually(async () => !!(await a.store.event(gone))?.redacted, 'deleted at Alice')
    const counts = await a.dms.threadCounts(room)
    const pings = await log.threadPings(room, null)
    expect(await a.dms.readConversation(room, pings, counts)).toEqual([gone])
    expect(await threads()).toEqual({ [other]: 1 })
    await log.seen([gone])
    expect((await log.threadPings(room, null)).map(p => p.id)).toEqual([kept])
    log.stop()
  })

  test('a thread ping whose root is deleted comes off when the conversation is read', async () => {
    const { a, b, room } = await pair()
    const root = await a.dms.send(room, { body: 'root' })
    await eventually(async () => (await main(b, a, room)).length === 1, 'root at Bob')
    const reply = await b.dms.send(room, { body: '@Alice look', thread: root })
    const threads = async () => (await a.store.room(room))!.threads ?? {}
    await eventually(async () => (await threads())[root] === 1, 'thread ping')
    await a.dms.redact(room, root)
    const counts = await a.dms.threadCounts(room)
    const dead = await a.dms.readConversation(room, [{ id: reply, thread: root }], counts)
    expect(dead).toEqual([reply])
    expect(await threads()).toEqual({})
  })

  test('a reaction to a thread reply counts in its thread', async () => {
    const { a, b, room } = await pair()
    const root = await a.dms.send(room, { body: 'root' })
    const reply = await a.dms.send(room, { body: 'mine', thread: root })
    await eventually(
      async () =>
        !!(await loadDmThread(b.store.db, room, root, b.node.ik, a.node.ik))?.messages.length,
      'reply at Bob'
    )
    const arrived: (string | null)[] = []
    a.dms.onArrive(x => void (x.ping === 'reaction' && arrived.push(x.thread)))
    await b.dms.react(room, reply, '👍', true)
    await eventually(async () => arrived.length === 1, 'reaction at Alice')
    expect(arrived).toEqual([root])
    expect(await a.store.room(room)).toMatchObject({ pings: 0, threads: { [root]: 1 } })
    // A reaction ping that still counts stays when the conversation is read.
    const counts = await a.dms.threadCounts(room)
    const rec = (await a.dms.db.getAllFromIndex('events', 'room_target', [room, reply])).find(
      r => r.type === 'react'
    )!
    expect(await a.dms.readConversation(room, [{ id: rec.id, thread: root }], counts)).toEqual([])
    expect((await a.store.room(room))!.threads).toEqual({ [root]: 1 })
  })

  test('a typing frame with a malformed thread costs a strike', async () => {
    const { a, b, room } = await pair()
    const sessA = a.dms.sync.linksOf(room)[0].session
    const sessB = b.dms.sync.linksOf(room)[0].session
    await sessA.send({ t: 'typing', room, on: true, thread: 42 })
    await waitFor(() => sessB.strikes === 1, 'strike')
    expect(b.dms.typingIn(room)).toEqual([])
    await sessA.send({ t: 'typing', room, on: true, thread: 'A'.repeat(43) })
    await eventually(async () => b.dms.typingIn(room, 'A'.repeat(43)).length === 1, 'typing')
    expect(sessB.strikes).toBe(1)
  })
})
