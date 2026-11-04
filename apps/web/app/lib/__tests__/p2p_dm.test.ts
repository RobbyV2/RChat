import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { Hub, makeNode, ManualClock, prng, settle, waitFor } from './p2p_net'
import type { P2pNode } from '../p2p/node'
import type { EventRecord, P2pStore } from '../p2p/db'
import { b64u, concat, utf8 } from '../p2p/canonical'
import { keyId, newKeyPair, sign, signRevocation, type KeyPair } from '../p2p/keys'
import {
  buildEvent,
  effTsOf,
  eventIdBytes,
  isLate,
  TAG_SIG,
  validate,
  type Core,
  type RoomAuth,
  type Wire,
} from '../p2p/event_v1'
import { contentHash, LIMITS as EV, type Content, type EvType } from '../p2p/content'
import {
  deriveMessage,
  Dms,
  dmRoomId,
  FULL_TEXT,
  loadMessages,
  loadPins,
  mentionsIn,
  reactionsOf,
} from '../p2p/dm'
import { DAG, insertEvent } from '../p2p/dag'
import { openDB } from 'idb'
import { DB_VERSION, P2pStore as Store, UPGRADES } from '../p2p/db'
import { SYNC } from '../p2p/sync'

// Real-time tests (sessions, IndexedDB): budgets for a loaded machine.
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
  db: string
}

const makePeer = async (
  hub: Hub,
  name: string,
  clock: ManualClock,
  opts: { db?: string; dms?: Partial<ConstructorParameters<typeof Dms>[0]> } = {}
): Promise<Peer> => {
  const n = await makeNode(hub, name, { clock, db: opts.db })
  const dms = new Dms({ node: n.node, store: n.store, clock, ...opts.dms })
  live.push({ node: n.node, dms })
  return { ...n, dms }
}

// Polls an async condition, like waitFor for synchronous ones, for most of the test budget.
const eventually = async (ok: () => Promise<boolean>, what: string, ms = 50_000) => {
  const end = Date.now() + ms
  while (!(await ok())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await new Promise(r => setTimeout(r, 2))
  }
}

const failure = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e: Error) => e.message
  )

const linked = (a: Peer, b: Peer) =>
  a.dms.online(a.dms.roomFor(b.node.ik)) && b.dms.online(b.dms.roomFor(a.node.ik))

const friends = async (a: Peer, b: Peer) => {
  await a.node.start()
  await b.node.start()
  await a.node.addContact(await b.node.myCard())
  await waitFor(() => b.node.contact(a.node.ik)?.state === 'incoming', 'request')
  await b.node.accept(a.node.ik)
  await waitFor(() => linked(a, b), 'sync links')
  await a.dms.open(b.node.ik)
  await b.dms.open(a.node.ik)
}

const pair = async (opts: Parameters<typeof makePeer>[3] = {}) => {
  const clock = new ManualClock()
  const hub = new Hub()
  const a = await makePeer(hub, 'Alice', clock, opts)
  const b = await makePeer(hub, 'Bob', clock, opts)
  await friends(a, b)
  return { clock, hub, a, b, room: dmRoomId(a.node.ik, b.node.ik) }
}

const timeline = async (p: Peer, peer: Peer) =>
  (
    await loadMessages(p.store.db, p.dms.roomFor(peer.node.ik), p.node.ik, peer.node.ik, {
      limit: 100_000,
    })
  ).messages

// Messages without pin lines.
const view = async (p: Peer, peer: Peer) => (await timeline(p, peer)).filter(m => !m.system)

const bodies = async (p: Peer, peer: Peer) => (await view(p, peer)).map(m => m.body)

const allIds = async (p: Peer, room: string) =>
  (
    await p.store.db.getAllFromIndex(
      'events',
      'room_sort',
      IDBKeyRange.bound([room, ''], [room, '￿'])
    )
  ).map(r => r.id)

const roomOf = async (p: Peer, room: string) => (await p.store.room(room))!

// ----- Signing helpers for the validation table -----

const resign = (core: Core, c: Content | null, dk: KeyPair): Wire => {
  const sig = b64u(sign(dk.sk, concat(utf8(TAG_SIG), eventIdBytes(core))))
  return { ev: core, c, sig }
}

const craft = (
  author: { ik: KeyPair; dk: KeyPair },
  room: string,
  type: EvType,
  content: Content,
  patch: Partial<Core> = {}
) => {
  const base = buildEvent(author, room, type, content, [], 0, 1_700_000_000_000).wire
  const core = { ...base.ev, ch: contentHash(content), ...patch }
  return resign(core, content, author.dk)
}

describe('event validation', () => {
  const alice = { ik: newKeyPair(), dk: newKeyPair() }
  const bob = { ik: newKeyPair(), dk: newKeyPair() }
  const eve = { ik: newKeyPair(), dk: newKeyPair() }
  const A = keyId(alice.ik.pk)
  const B = keyId(bob.ik.pk)
  const room = dmRoomId(A, B)
  const certOf = (who: typeof alice, created = 1) => ({
    v: 1 as const,
    ik: keyId(who.ik.pk),
    dk: keyId(who.dk.pk),
    created,
    label: 'Browser',
    sig: '',
  })
  const revoked = signRevocation(bob.ik, keyId(bob.dk.pk), 1_600_000_000_000)
  const auth = (revs = false): RoomAuth => ({
    room,
    members: [A, B],
    devices: ik =>
      ik === A
        ? { certs: [certOf(alice)], revocations: [] }
        : ik === B
          ? { certs: [certOf(bob)], revocations: revs ? [revoked] : [] }
          : null,
  })
  const ok = craft(alice, room, 'msg', { body: 'hello' })
  const id64 = b64u(new Uint8Array(32).fill(7))

  const cases: [string, () => unknown, string, boolean?][] = [
    ['valid message', () => ok, 'ok'],
    // Forward compatibility: what a newer version adds is kept unread, never refused.
    ['extra top-level key', () => ({ ...ok, x: 1 }), 'ok'],
    ['missing signature', () => ({ ev: ok.ev, c: ok.c }), 'shape'],
    ['extra core key', () => resign({ ...ok.ev, x: 1 } as unknown as Core, ok.c, alice.dk), 'ok'],
    ['unknown type', () => craft(alice, room, 'vote' as EvType, { body: 'x' }), 'ok'],
    ['malformed type', () => craft(alice, room, 'Vote!' as EvType, { body: 'x' }), 'shape'],
    ['missing core key', () => ({ ...ok, ev: { ...ok.ev, ch: undefined } }), 'shape'],
    ['float ts', () => ({ ...ok, ev: { ...ok.ev, ts: 1.5 } }), 'shape'],
    ['other room', () => craft(alice, dmRoomId(A, keyId(eve.ik.pk)), 'msg', { body: 'x' }), 'room'],
    ['not a member', () => craft(eve, room, 'msg', { body: 'x' }), 'sender'],
    [
      'device not certified for the sender',
      () => craft({ ik: alice.ik, dk: eve.dk }, room, 'msg', { body: 'x' }),
      'device',
    ],
    [
      'signed by a revoked device after revocation',
      () => craft(bob, room, 'msg', { body: 'x' }),
      'revoked',
      true,
    ],
    [
      'signed by a revoked device before revocation',
      () => craft(bob, room, 'msg', { body: 'x' }, { ts: 1_500_000_000_000 }),
      'ok',
      true,
    ],
    [
      'bad signature',
      () => ({ ...ok, sig: craft(alice, room, 'msg', { body: 'other' }).sig }),
      'signature',
    ],
    ['signature by another key', () => resign(ok.ev, ok.c, bob.dk), 'signature'],
    ['tampered content', () => ({ ...ok, c: { body: 'tampered' } }), 'content'],
    ['redacted copy without content', () => ({ ...ok, c: null }), 'ok'],
    [
      'body too long',
      () => craft(alice, room, 'msg', { body: 'x'.repeat(EV.body + 1) }),
      'content',
    ],
    ['empty body', () => craft(alice, room, 'msg', { body: '  ' }), 'content'],
    [
      'forward with empty body',
      () => craft(alice, room, 'msg', { body: '', fwd: { name: 'Z', ts: 1, body: 'q' } }),
      'ok',
    ],
    ['unknown content key', () => craft(alice, room, 'msg', { body: 'x', y: 1 } as Content), 'ok'],
    [
      'unknown attachment key',
      () =>
        craft(alice, room, 'msg', {
          body: '',
          att: [{ h: id64, size: 1, blocks: 1, name: 'a', mime: 'text/plain', z: 1 }],
        } as unknown as Content),
      'ok',
    ],
    ['reply not an id', () => craft(alice, room, 'msg', { body: 'x', reply: 'nope' }), 'content'],
    [
      'mention not a key',
      () => craft(alice, room, 'msg', { body: 'x', mentions: ['x'] }),
      'content',
    ],
    [
      'reaction key too long',
      () => craft(alice, room, 'react', { target: id64, key: '🙂'.repeat(9), on: true }),
      'content',
    ],
    [
      'reaction key ok',
      () => craft(alice, room, 'react', { target: id64, key: '🙂', on: true }),
      'ok',
    ],
    ['edit without body', () => craft(alice, room, 'edit', { target: id64, body: '' }), 'content'],
    ['pin needs on', () => craft(alice, room, 'pin', { target: id64 } as Content), 'content'],
    ['redact', () => craft(alice, room, 'redact', { target: id64 }), 'ok'],
    ['content for another type', () => craft(alice, room, 'redact', { body: 'x' }), 'content'],
    [
      'too many prevs',
      () =>
        craft(
          alice,
          room,
          'msg',
          { body: 'x' },
          { prev: Array.from({ length: 11 }, (_, i) => b64u(new Uint8Array(32).fill(i))), depth: 1 }
        ),
      'prev',
    ],
    [
      'duplicate prevs',
      () => craft(alice, room, 'msg', { body: 'x' }, { prev: [id64, id64], depth: 1 }),
      'prev',
    ],
    [
      'depth 0 with prevs',
      () => craft(alice, room, 'msg', { body: 'x' }, { prev: [id64], depth: 0 }),
      'prev',
    ],
    ['depth without prevs', () => craft(alice, room, 'msg', { body: 'x' }, { depth: 3 }), 'prev'],
    [
      'prev not an id',
      () => craft(alice, room, 'msg', { body: 'x' }, { prev: ['abc'], depth: 1 }),
      'prev',
    ],
    [
      'oversized core',
      () =>
        craft(
          alice,
          room,
          'msg',
          { body: 'x' },
          { prev: Array.from({ length: 10 }, () => 'a'.repeat(300)), depth: 1 }
        ),
      'size',
    ],
    [
      'oversized content',
      () =>
        craft(alice, room, 'msg', {
          body: 'x'.repeat(4000),
          fwd: { name: 'n', ts: 1, body: '\u{1F600}'.repeat(4000) },
        }),
      'size',
    ],
    ['not an object', () => 'event', 'shape'],
  ]

  for (const [name, make, want, revs] of cases)
    test(name, () => {
      const res = validate(make(), auth(revs))
      expect(res.ok ? 'ok' : res.why).toBe(want)
    })
})

describe('storage', () => {
  test('the current schema upgrades a v1 database and keeps what it had', async () => {
    const name = `upgrade-${Math.random()}`
    const v1 = await openDB(name, 1, {
      upgrade(db, _old, _new, tx) {
        UPGRADES[0](db as never, tx as never)
      },
    })
    await v1.put('contacts', { ik: 'kept', state: 'mutual' })
    await v1.put('meta', 1, 'schema')
    v1.close()
    const store = await Store.open(name)
    expect(DB_VERSION).toBe(8)
    expect(store.db.version).toBe(8)
    expect([...store.db.objectStoreNames].sort()).toEqual([
      'blob_hashes',
      'blob_parts',
      'blobs',
      'children',
      'codes',
      'contacts',
      'dropped',
      'events',
      'idents',
      'meta',
      'outbox',
      'rooms',
      'search',
      'self',
    ])
    expect([...store.db.transaction('events').store.indexNames]).toContain('room_sender_sort')
    expect([...store.db.transaction('events').store.indexNames]).toContain('room_thread_sort')
    expect((await store.contact('kept'))?.state).toBe('mutual')
    expect(await store.meta('schema')).toBe(8)
    expect(await store.rooms()).toEqual([])
    store.close()
    // Opening again changes nothing.
    const again = await Store.open(name)
    expect((await again.contact('kept'))?.state).toBe('mutual')
    again.close()
  })
})

describe('ordering', () => {
  test('effTs clamps a future clock and never goes before its parents', () => {
    const now = 1_000_000
    expect(effTsOf(now + 10 * 60_000, now, [])).toBe(now + EV.futureMs)
    expect(effTsOf(now - 5000, now, [now + 1000])).toBe(now + 1000)
    expect(effTsOf(now - 5000, now, [])).toBe(now - 5000)
  })

  test('the late marker needs more than a minute', () => {
    expect(isLate(1000, 1000 + 60_000)).toBe(false)
    expect(isLate(1000, 1000 + 60_001)).toBe(true)
  })

  test('display order is effTs, then depth, then id; late arrivals are marked', async () => {
    const { a, b, room, clock } = await pair()
    await a.dms.send(room, { body: 'one' })
    await eventually(async () => (await bodies(b, a)).length === 1, 'one')
    // Bob was offline when Alice wrote this: it arrives five minutes after she sent it.
    await b.node.setPaused(true)
    await a.dms.send(room, { body: 'two' })
    await clock.advance(5 * 60_000)
    await b.node.setPaused(false)
    b.node.schedule(true)
    a.node.schedule(true)
    await eventually(async () => (await bodies(b, a)).length === 2, 'two')
    const msgs = await view(b, a)
    expect(msgs.map(m => m.body)).toEqual(['one', 'two'])
    expect(msgs[1].late).toBe(true)
    expect(msgs[0].late).toBe(false)
    expect((await view(a, b))[1].late).toBe(false)
  })
})

describe('P2P DMs', () => {
  test('messages, replies, edits, reactions, pins and deletes both ways', async () => {
    const { a, b, room } = await pair()
    const m1 = await a.dms.send(room, { body: 'hi bob' })
    await eventually(async () => (await bodies(b, a)).length === 1, 'first message')
    const m2 = await b.dms.send(room, { body: 'hi alice', reply: m1 })
    await b.dms.react(room, m1, '👍', true)
    await a.dms.edit(room, m1, 'hi bob!')
    await b.dms.pin(room, m1, true)
    await eventually(async () => {
      const v = await view(a, b)
      return v.length === 2 && v[0].pinned !== null && v[0].reactions.length === 1
    }, 'everything at Alice')
    await eventually(async () => (await view(b, a))[0]?.edited !== null, 'edit at Bob')
    for (const p of [a, b]) {
      const v = await view(p, p === a ? b : a)
      expect(v.map(m => m.body)).toEqual(['hi bob!', 'hi alice'])
      expect(v[1].reply).toEqual({ id: m1, sender: a.node.ik, body: 'hi bob!' })
      expect(v[0].reactions.map(r => [r.key, r.count, r.me, r.by])).toEqual([
        ['👍', 1, p === b, [b.node.ik]],
      ])
      expect((await loadPins(p.store.db, room, p.node.ik, '')).map(m => m.id)).toEqual([m1])
      // "Bob pinned a message to this conversation." after the messages, linking it.
      const line = (await timeline(p, p === a ? b : a)).at(-1)
      expect(line?.system).toEqual({ kind: 'pin', ik: b.node.ik, target: m1 })
    }
    // Only the author edits or deletes.
    expect(await failure(b.dms.edit(room, m1, 'mine now'))).toBe("You can't edit this message")
    expect(await failure(b.dms.redact(room, m1))).toBe("You can't delete this message")
    await b.dms.redact(room, m2)
    await eventually(async () => (await view(a, b)).length === 1, 'delete at Alice')
    expect((await view(b, a)).length).toBe(1)
    // The quote of a deleted message says so.
    const m3 = await b.dms.send(room, { body: 'again', reply: m2 })
    await eventually(async () => (await view(a, b)).length === 2, 'quote')
    expect((await view(a, b))[1]).toMatchObject({ id: m3, reply: { id: m2, body: null } })
  })

  test('redaction removes the content on both sides and keeps the event verifiable', async () => {
    const { a, b, room } = await pair()
    const m = await a.dms.send(room, { body: 'secret' })
    await a.dms.edit(room, m, 'secret v2')
    await eventually(async () => (await bodies(b, a))[0] === 'secret v2', 'edit')
    await a.dms.redact(room, m)
    await eventually(async () => (await bodies(b, a)).length === 0, 'redaction')
    for (const p of [a, b]) {
      const all = await p.store.db.getAll('events')
      const msg = all.find(r => r.id === m) as EventRecord
      expect(msg.redacted).toBe(true)
      expect(msg.wire.c).toBeNull()
      expect(JSON.stringify(all)).not.toContain('secret')
      const auth: RoomAuth = {
        room,
        members: [a.node.ik, b.node.ik],
        devices: ik => (p.node.devicesOf(ik) ?? p.node.devicesOf(p.node.ik))!,
      }
      const checked = validate(msg.wire, auth)
      expect(checked.ok && checked.id).toBe(m)
    }
  })

  test('a redaction that arrives before its target: the target is born redacted', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const a = await makePeer(hub, 'Alice', clock)
    const b = await makePeer(hub, 'Bob', clock)
    await friends(a, b)
    const room = dmRoomId(a.node.ik, b.node.ik)
    const author = a.node.author()!
    const msg = buildEvent(author, room, 'msg', { body: 'gone' }, [], 0, clock.now())
    const red = buildEvent(author, room, 'redact', { target: msg.id }, [msg.id], 1, clock.now())
    const ctx = { me: b.node.ik, peer: a.node.ik }
    expect((await insertEvent(b.store.db, red.id, red.wire, clock.now(), ctx)).status).toBe('new')
    expect((await roomOf(b, room)).missing).toEqual([msg.id])
    expect((await insertEvent(b.store.db, msg.id, msg.wire, clock.now(), ctx)).status).toBe('new')
    const stored = (await b.store.event(msg.id))!
    expect(stored.redacted).toBe(true)
    expect(stored.wire.c).toBeNull()
    expect((await roomOf(b, room)).missing).toEqual([])
    expect((await roomOf(b, room)).heads.map(h => h.id)).toEqual([red.id])
    // Someone else's redaction of it would not count.
    const msg2 = buildEvent(author, room, 'msg', { body: 'stays' }, [red.id], 2, clock.now())
    const bobs = buildEvent(
      b.node.author()!,
      room,
      'redact',
      { target: msg2.id },
      [red.id],
      2,
      clock.now()
    )
    await insertEvent(b.store.db, bobs.id, bobs.wire, clock.now(), ctx)
    await insertEvent(b.store.db, msg2.id, msg2.wire, clock.now(), ctx)
    expect((await b.store.event(msg2.id))!.redacted).toBe(false)
  })

  test('edits, reactions and pins: the last writer wins', () => {
    const me = 'ME'
    let n = 0
    const rec = (
      type: EvType,
      sender: string,
      effTs: number,
      c: unknown,
      id?: string
    ): EventRecord => {
      n += 1
      return {
        id: id ?? `e${String(n).padStart(3, '0')}`,
        room: 'r',
        type,
        sender,
        wire: { ev: { ts: effTs } as Core, c: c as Content, sig: '' },
        target: 'm',
        depth: 1,
        effTs,
        sortKey: '',
        receivedAt: effTs,
        seq: n,
        redacted: false,
      }
    }
    const msg = { ...rec('msg', 'A', 1, { body: 'v0' }), id: 'm' }
    const related = [
      rec('edit', 'A', 30, { target: 'm', body: 'v2' }),
      rec('edit', 'A', 20, { target: 'm', body: 'v1' }),
      // Same time: the higher id wins.
      rec('edit', 'A', 30, { target: 'm', body: 'v3' }, 'zz'),
      // Not the author's: ignored.
      rec('edit', 'B', 99, { target: 'm', body: 'hijack' }),
      rec('react', 'A', 5, { target: 'm', key: '👍', on: true }),
      rec('react', 'B', 6, { target: 'm', key: '👍', on: true }),
      rec('react', 'B', 7, { target: 'm', key: '👍', on: false }),
      rec('react', 'B', 2, { target: 'm', key: '🎉', on: true }),
      rec('react', 'ME', 8, { target: 'm', key: '🎉', on: true }),
      rec('pin', 'A', 10, { target: 'm', on: true }),
      rec('pin', 'B', 12, { target: 'm', on: false }),
      rec('pin', 'A', 11, { target: 'm', on: true }),
    ]
    const v = deriveMessage(msg, related, undefined, [], me, new Map(), 'B')!
    expect(v.body).toBe('v3')
    expect(v.edited).toBe(30)
    expect(v.pinned).toBeNull()
    expect(v.reactions.map(r => [r.key, r.count, r.me])).toEqual([
      ['🎉', 2, true],
      ['👍', 1, false],
    ])
    const repinned = deriveMessage(
      msg,
      [...related, rec('pin', 'B', 13, { target: 'm', on: true })],
      undefined,
      [],
      me,
      new Map(),
      'B'
    )!
    expect(repinned.pinned).toBe(13)
    expect(reactionsOf([], me)).toEqual([])
  })

  test('outbox: pending while the other side is away, delivered when it is back', async () => {
    const { a, b, room } = await pair()
    await b.node.setPaused(true)
    await waitFor(() => !a.dms.online(room), 'Bob away')
    for (const t of ['one', 'two', 'three']) await a.dms.send(room, { body: t })
    let v = await view(a, b)
    expect(v.map(m => [m.body, m.pending])).toEqual([
      ['one', true],
      ['two', true],
      ['three', true],
    ])
    expect((await a.store.outbox(room)).length).toBe(3)
    await b.node.setPaused(false)
    b.node.schedule(true)
    await eventually(async () => (await view(a, b)).every(m => !m.pending), 'delivered')
    expect(await bodies(b, a)).toEqual(['one', 'two', 'three'])
    v = await view(a, b)
    expect(v.every(m => !m.pending)).toBe(true)
  })

  test('outbox resend after a session drops before the acks', async () => {
    const { a, b, room } = await pair()
    // Bob's side drops every frame for a while: Alice's pushes are lost.
    const sessA = a.dms.sync.linksOf(room)[0].session
    const realSend = sessA.send.bind(sessA)
    sessA.send = msg => (msg.t === 'push' ? Promise.resolve() : realSend(msg))
    await a.dms.send(room, { body: 'lost in transit' })
    await settle()
    expect((await view(a, b))[0].pending).toBe(true)
    expect((await bodies(b, a)).length).toBe(0)
    sessA.close()
    await waitFor(() => !a.dms.online(room), 'closed')
    a.node.schedule(true)
    b.node.schedule(true)
    await waitFor(() => linked(a, b), 'reconnected')
    await eventually(async () => !(await view(a, b))[0].pending, 'resent and acked')
    expect(await bodies(b, a)).toEqual(['lost in transit'])
  })

  test('pings: mentions, replies and reactions to you; edits never ping', async () => {
    const { a, b, room } = await pair()
    const mine = await b.dms.send(room, { body: 'from bob' })
    await eventually(async () => (await bodies(a, b)).length === 1, 'bob msg')
    await a.dms.markRead(room)
    expect(mentionsIn('hey @bob!', ['Bob'])).toBe(true)
    expect(mentionsIn('mail bob@bob.com', ['bob'])).toBe(false)
    expect(mentionsIn('`@bob`', ['bob'])).toBe(false)
    await a.dms.send(room, { body: 'hey @Bob' })
    await a.dms.send(room, { body: 'reply', reply: mine })
    await a.dms.react(room, mine, '🎉', true)
    // Any short key is admitted, but text (with a bidi override here) is inert: no ping, no chip.
    await a.dms.react(room, mine, 'Pay \u202eher\u202c now', true)
    const plain = await a.dms.send(room, { body: 'plain' })
    await a.dms.edit(room, plain, 'plain @Bob edited')
    await eventually(async () => (await bodies(b, a)).length === 4, 'all')
    await eventually(async () => (await view(b, a))[3].edited !== null, 'edit')
    const r = await roomOf(b, room)
    expect(r.pings).toBe(3)
    expect(r.unread).toBe(3)
    await eventually(
      async () =>
        (await b.store.db.getAllFromIndex('events', 'room_type_sort')).filter(
          e => e.type === 'react'
        ).length === 2,
      'both reactions stored'
    )
    expect((await view(b, a))[0].reactions.map(x => x.key)).toEqual(['🎉'])
    // Alice's own counters stay at zero.
    expect((await roomOf(a, room)).pings).toBe(0)
    expect((await view(b, a))[1].mentions).toEqual([b.node.ik])
    // The inbox marks pings one by one: off the counter, the read position stays.
    await b.dms.unping(room, 1)
    const one = await roomOf(b, room)
    expect([one.pings, one.unread, one.readSeq]).toEqual([2, 3, r.readSeq])
    await b.dms.unping(room, 5)
    expect((await roomOf(b, room)).pings).toBe(0)
    await b.dms.markRead(room)
    const read = await roomOf(b, room)
    expect([read.pings, read.unread, read.readSeq]).toEqual([0, 0, read.lastSeq])
    // Forwarded text never pings.
    await a.dms.send(room, { body: '', fwd: { name: 'Zed', ts: 1, body: '@Bob hi' } })
    await eventually(async () => (await bodies(b, a)).length === 5, 'forward')
    expect((await roomOf(b, room)).pings).toBe(0)
    expect((await roomOf(b, room)).unread).toBe(1)
  })

  test('typing frames show for 8 seconds, until a message, or until they stop', async () => {
    const { a, b, room, clock } = await pair()
    a.dms.typing(room, true)
    await waitFor(() => b.dms.typingIn(room).includes(a.node.ik), 'typing')
    await clock.advance(SYNC.typingMs + 1)
    expect(b.dms.typingIn(room)).toEqual([])
    a.dms.typing(room, true)
    await waitFor(() => b.dms.typingIn(room).length === 1, 'typing again')
    await a.dms.send(room, { body: 'done typing' })
    await waitFor(() => b.dms.typingIn(room).length === 0, 'cleared by the message')
    a.dms.typing(room, true)
    await waitFor(() => b.dms.typingIn(room).length === 1, 'typing a third time')
    a.dms.typing(room, false)
    await waitFor(() => b.dms.typingIn(room).length === 0, 'stopped')
  })

  test('history survives a reload', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const a = await makePeer(hub, 'Alice', clock)
    const b = await makePeer(hub, 'Bob', clock)
    await friends(a, b)
    const room = dmRoomId(a.node.ik, b.node.ik)
    await a.dms.send(room, { body: 'kept' })
    await eventually(async () => (await bodies(b, a)).length === 1, 'kept')
    b.dms.stop()
    b.node.stop()
    b.store.close()
    const again = await makePeer(hub, 'Bob', clock, { db: b.db })
    expect(await bodies(again, a)).toEqual(['kept'])
    expect((await again.store.room(room))?.peer).toBe(a.node.ik)
  })

  test('blocking stops delivery both ways', async () => {
    const { a, b, room } = await pair()
    await a.node.block(b.node.ik)
    await waitFor(() => !a.dms.online(room) && !b.dms.online(room), 'cut')
    await b.dms.send(room, { body: 'let me in' })
    await a.dms.send(room, { body: 'not for you' })
    b.node.schedule(true)
    a.node.schedule(true)
    await settle(50)
    expect(await bodies(a, b)).toEqual(['not for you'])
    expect(await bodies(b, a)).toEqual(['let me in'])
    expect((await view(a, b))[0].pending).toBe(true)
  })

  test('a full room refuses more events with a clear reason', async () => {
    const { a, b, room } = await pair({ dms: { roomCap: 3 } })
    for (const t of ['1', '2', '3']) await a.dms.send(room, { body: t })
    expect(await failure(a.dms.send(room, { body: '4' }))).toBe(FULL_TEXT(3))
    await eventually(async () => (await bodies(b, a)).length === 3, 'three')
    // Bob's room is full too: his own message can't be stored, nor more of Alice's.
    expect(await failure(b.dms.send(room, { body: 'b' }))).toBe(FULL_TEXT(3))
    expect((await roomOf(b, room)).full).toBe(true)
    expect(DAG.roomCap).toBeGreaterThanOrEqual(100_000)
  })
})

describe('sync limits', () => {
  test('a slow receiver gets everything with less than about 1 MiB in flight', async () => {
    const slow = () => new Promise<void>(r => setTimeout(r, 15))
    const clock = new ManualClock()
    const hub = new Hub()
    const a = await makePeer(hub, 'Alice', clock)
    const b = await makePeer(hub, 'Bob', clock, { dms: { pace: slow } })
    await friends(a, b)
    const room = dmRoomId(a.node.ik, b.node.ik)
    await b.node.setPaused(true)
    await waitFor(() => !a.dms.online(room), 'away')
    const text = (i: number) => `${i} `.padEnd(3900, 'x')
    // About 1.6 MiB of messages wait in Alice's outbox.
    for (let i = 0; i < 400; i += 1) await a.dms.send(room, { body: text(i) })
    await b.node.setPaused(false)
    b.node.schedule(true)
    await waitFor(() => linked(a, b), 'back')
    const linkB = b.dms.sync.linksOf(room)[0]
    const sessB = linkB.session
    const sessA = a.dms.sync.linksOf(room)[0].session
    // Live messages on top, while the backlog is pulled.
    for (let i = 400; i < 460; i += 1) await a.dms.send(room, { body: text(i) })
    // Time passes for the session rate limits too.
    await eventually(
      async () => {
        await clock.advance(50)
        return (await bodies(b, a)).length === 460
      },
      'all 460',
      60_000
    )
    await eventually(
      async () => {
        await clock.advance(50)
        return (await view(a, b)).every(m => !m.pending)
      },
      'all delivered',
      30_000
    )
    expect(sessB.state).toBe('ready')
    expect(sessA.state).toBe('ready')
    expect(sessB.strikes).toBe(0)
    expect(sessA.strikes).toBe(0)
    expect(linkB.maxBacklog).toBeLessThan(1024 * 1024)
    expect(a.dms.sync.linksOf(room)[0].inFlight.length).toBeLessThanOrEqual(SYNC.pushEvents)
    expect((await bodies(b, a)).slice(0, 3)).toEqual([text(0), text(1), text(2)])
  }, 90_000)

  test('unasked answers, oversized requests and invalid events are struck', async () => {
    const { a, b, room } = await pair()
    const sessA = a.dms.sync.linksOf(room)[0].session
    const sessB = b.dms.sync.linksOf(room)[0].session
    await sessA.send({ t: 'events', rid: 99, room, evs: [], more: false })
    await sessA.send({ t: 'want', rid: 1, room, from: Array(21).fill(room), have: [], limit: 5 })
    await sessA.send({ t: 'heads', room: dmRoomId(a.node.ik, keyId(newKeyPair().pk)), heads: [] })
    await waitFor(() => sessB.strikes === 3, 'three strikes')
    // A forged event: Bob drops it and strikes Alice's session.
    const fake = craft({ ik: newKeyPair(), dk: newKeyPair() }, room, 'msg', { body: 'x' })
    await sessA.send({ t: 'push', room, ev: fake })
    await waitFor(() => sessB.strikes === 4, 'forgery struck')
    expect(await bodies(b, a)).toEqual([])
    // Pushes beyond the window Bob grants are refused.
    for (let i = 0; i < SYNC.pushQueueEvents + 10; i += 1)
      void sessA.send({ t: 'push', room, ev: fake })
    await waitFor(() => sessB.state === 'closed', 'flood closed')
    expect(sessB.reason).toBe('strikes')
  })

  test('a newer peer: unknown messages, fields and event types cost no strike and are not shown', async () => {
    const { a, b, room } = await pair()
    const sessA = a.dms.sync.linksOf(room)[0].session
    const sessB = b.dms.sync.linksOf(room)[0].session
    const author = a.node.author()!
    const now = 1_700_000_000_000
    // A session message type and fields this version doesn't know.
    await sessA.send({ t: 'sync_v2', room })
    await sessA.send({ t: 'typing', room, on: true, mood: 'happy' })
    // An event of a newer type, then a message on top of it with a new content field and a new
    // core field (both signed and hashed, so they must be kept as they are).
    const vote = buildEvent(
      author,
      room,
      'vote' as EvType,
      { choice: 2 } as unknown as Content,
      [],
      0,
      now
    )
    const content = { body: 'after the vote', poll: { q: 'x' } } as Content
    const core = {
      ...buildEvent(author, room, 'msg', content, [vote.id], 1, now).wire.ev,
      flags: 1,
    } as Core
    const msg = resign(core, content, author.dk)
    await sessA.send({ t: 'push', room, ev: vote.wire, hint: 1 })
    await sessA.send({ t: 'push', room, ev: msg })
    await eventually(async () => (await bodies(b, a)).includes('after the vote'), 'message shown')
    expect(await bodies(b, a)).toEqual(['after the vote'])
    expect((await b.store.event(vote.id))?.type).toBe('vote')
    expect((await roomOf(b, room)).missing).toEqual([])
    expect(sessB.strikes).toBe(0)
    expect(sessB.state).toBe('ready')
  })

  test('backfill stops at the horizon until "Load older"', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const limits = { horizon: 50, wantLimit: 20 }
    const a = await makePeer(hub, 'Alice', clock, { dms: { limits } })
    const b = await makePeer(hub, 'Bob', clock, { dms: { limits } })
    await friends(a, b)
    const room = dmRoomId(a.node.ik, b.node.ik)
    await b.node.setPaused(true)
    await waitFor(() => !a.dms.online(room), 'away')
    for (let i = 0; i < 120; i += 1) await a.dms.send(room, { body: `m${i}` })
    await b.node.setPaused(false)
    b.node.schedule(true)
    await waitFor(() => linked(a, b), 'back')
    await eventually(
      async () => (await bodies(b, a)).length >= 50 && !b.dms.sync.pulling(room),
      'horizon'
    )
    await settle(30)
    const first = (await bodies(b, a)).length
    expect(first).toBeGreaterThanOrEqual(50)
    expect(first).toBeLessThan(120)
    expect(b.dms.sync.horizonReached(room)).toBe(true)
    expect((await roomOf(b, room)).missing.length).toBeGreaterThan(0)
    // The newest arrive first.
    expect((await bodies(b, a)).at(-1)).toBe('m119')
    // Each "Load older" brings up to one more horizon.
    await eventually(
      async () => {
        if (!b.dms.sync.pulling(room)) b.dms.loadOlder(room)
        await settle(5)
        return (await bodies(b, a)).length === 120
      },
      'the rest',
      30_000
    )
    expect((await roomOf(b, room)).missing).toEqual([])
  })
})

describe('simulation', () => {
  test('two nodes with random sends and offline periods converge', async () => {
    for (const seed of [7, 4242]) {
      const rand = prng(seed)
      const clock = new ManualClock()
      const hub = new Hub()
      const a = await makePeer(hub, 'Alice', clock)
      const b = await makePeer(hub, 'Bob', clock)
      await friends(a, b)
      const room = dmRoomId(a.node.ik, b.node.ik)
      const peers = [a, b]
      const sent: string[][] = [[], []]
      try {
        for (let step = 0; step < 60; step += 1) {
          const who = rand() < 0.5 ? 0 : 1
          const p = peers[who]
          const r = rand()
          if (r < 0.12) {
            await p.node.setPaused(!p.node.paused)
            if (!p.node.paused) for (const q of peers) q.node.schedule(true)
          } else if (r < 0.2 && sent[who].length) {
            const target = sent[who][Math.floor(rand() * sent[who].length)]
            await p.dms.react(room, target, rand() < 0.5 ? '👍' : '❤️', rand() < 0.7)
          } else if (r < 0.25 && sent[who].length) {
            const target = sent[who][Math.floor(rand() * sent[who].length)]
            await p.dms.edit(room, target, `edited ${step}`)
          } else {
            sent[who].push(await p.dms.send(room, { body: `${who}:${step}` }))
          }
          await clock.advance(Math.floor(rand() * 3000))
          if (rand() < 0.3) await settle(5)
        }
        for (const p of peers) if (p.node.paused) await p.node.setPaused(false)
        for (const p of peers) p.node.schedule(true)
        await waitFor(() => linked(a, b), 'final link')
        await eventually(async () => {
          await clock.advance(300)
          const [x, y] = [await allIds(a, room), await allIds(b, room)]
          return x.length === y.length && x.length > 0 && new Set([...x, ...y]).size === x.length
        }, `same events (seed ${seed})`)
        const [x, y] = [await allIds(a, room), await allIds(b, room)]
        expect(y).toEqual(x)
        const [va, vb] = [await view(a, b), await view(b, a)]
        expect(vb.map(m => [m.id, m.body, m.reactions.map(r => [r.key, r.count])])).toEqual(
          va.map(m => [m.id, m.body, m.reactions.map(r => [r.key, r.count])])
        )
        expect((await roomOf(a, room)).heads).toEqual((await roomOf(b, room)).heads)
      } catch (e) {
        throw new Error(`seed ${seed}: ${e instanceof Error ? e.message : String(e)}`, { cause: e })
      } finally {
        for (const p of peers) {
          p.dms.stop()
          p.node.stop()
        }
      }
    }
  }, 120_000)
})
