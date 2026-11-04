import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { Hub, makeNode, ManualClock, settle, waitFor } from './p2p_net'
import type { P2pNode } from '../p2p/node'
import type { P2pStore } from '../p2p/db'
import { b64u } from '../p2p/canonical'
import { keyId, newKeyPair, signRevocation, type KeyPair } from '../p2p/keys'
import { buildEvent, type Wire } from '../p2p/event_v1'
import { LIMITS as EV, type Content, type EvType } from '../p2p/content'
import * as dm from '../p2p/dm'
import { Dms, dmRoomId, loadMessages } from '../p2p/dm'
import * as dag from '../p2p/dag'
import { insertEvent } from '../p2p/dag'

// Real-time tests (sessions, IndexedDB): budgets for a loaded machine.
setDefaultTimeout(60_000)

// Own events go through validation, storage is capped by bytes and survives a quota error,
// revoked devices can't backdate, and the receive-side rules hold for events a peer pushes.

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

type DmOpts = Partial<ConstructorParameters<typeof Dms>[0]>

const makePeer = async (hub: Hub, name: string, clock: ManualClock, opts: DmOpts = {}) => {
  const n = await makeNode(hub, name, { clock })
  const dms = new Dms({ node: n.node, store: n.store, clock, ...opts })
  live.push({ node: n.node, dms })
  return { ...n, dms } as Peer
}

// Waits for the state, for most of the test budget (a loaded run is slow, not wrong).
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

const pair = async (aOpts: DmOpts = {}, bOpts: DmOpts = aOpts) => {
  const clock = new ManualClock()
  const hub = new Hub()
  const a = await makePeer(hub, 'Alice', clock, aOpts)
  const b = await makePeer(hub, 'Bob', clock, bOpts)
  await a.node.start()
  await b.node.start()
  await a.node.addContact(await b.node.myCard())
  await waitFor(() => b.node.contact(a.node.ik)?.state === 'incoming', 'request')
  await b.node.accept(a.node.ik)
  await waitFor(() => linked(a, b), 'sync links')
  await a.dms.open(b.node.ik)
  await b.dms.open(a.node.ik)
  const room = dmRoomId(a.node.ik, b.node.ik)
  return { clock, hub, a, b, room }
}

const view = async (p: Peer, peer: Peer) =>
  (
    await loadMessages(p.store.db, p.dms.roomFor(peer.node.ik), p.node.ik, peer.node.ik, {
      limit: 100_000,
    })
  ).messages.filter(m => !m.system)

const bodies = async (p: Peer, peer: Peer) => (await view(p, peer)).map(m => m.body)

const sessionOf = (p: Peer, room: string) => p.dms.sync.linksOf(room)[0].session

// An event signed by `author` on top of `p`'s current heads, not stored anywhere.
const eventOn = async (
  p: Peer,
  room: string,
  author: { ik: KeyPair; dk: KeyPair },
  type: EvType,
  content: Content,
  patch: { prev?: string[]; depth?: number; ts?: number } = {}
) => {
  const heads = (await p.store.room(room))?.heads ?? []
  const prev = patch.prev ?? heads.map(h => h.id)
  const depth = patch.depth ?? (heads.length ? Math.max(...heads.map(h => h.depth)) + 1 : 0)
  return buildEvent(author, room, type, content, prev, depth, patch.ts ?? Date.now())
}

// Stores an event of `p`'s own that skipped validation, as an older version could have.
const legacyEvent = async (p: Peer, room: string, body: string) => {
  const author = p.node.author()!
  const { id, wire } = await eventOn(p, room, author, 'msg', { body })
  await insertEvent(p.store.db, id, wire, Date.now(), { me: p.node.ik, peer: '' })
  await p.store.db.put('outbox', { id, room, created: Date.now(), deliveredTo: [] })
  return { id, wire }
}

const TOO_LONG = 'This message is too long to send.'

describe('own events are validated before they are stored or sent', () => {
  test('oversized bodies, edits and forwarded names are refused locally', async () => {
    const { a, b, room } = await pair()
    const sessB = sessionOf(b, room)
    // Short enough in characters, too big once control characters are escaped.
    const heavy = '\u0001'.repeat(3000)
    expect(await failure(a.dms.send(room, { body: heavy }))).toBe(TOO_LONG)
    expect(dm.bodyTooLong(heavy)).toBe(true)
    expect(dm.bodyTooLong('x'.repeat(EV.body))).toBe(false)
    const ok = await a.dms.send(room, { body: 'short' })
    expect(await failure(a.dms.edit(room, ok, 'x'.repeat(EV.body + 1)))).toBe(TOO_LONG)
    const longName = 'n'.repeat(100)
    expect(
      await failure(a.dms.send(room, { body: '', fwd: { name: longName, ts: 1, body: 'q' } }))
    ).toBe(TOO_LONG)
    expect(Array.from(dm.clipName(longName)).length).toBe(EV.name)
    await a.dms.send(room, { body: '', fwd: { name: dm.clipName(longName), ts: 1, body: 'q' } })
    await eventually(async () => (await bodies(b, a)).length === 2, 'two messages')
    expect(await bodies(a, b)).toEqual(['short', ''])
    expect((await view(b, a))[1].fwd?.name).toBe('n'.repeat(EV.name))
    expect(sessB.strikes).toBe(0)
    expect((await a.store.outbox(room)).length).toBe(2)
  })

  test('a stored event that can never be accepted shows as failed; Delete heals the DAG', async () => {
    const { a, b, room } = await pair()
    await b.node.setPaused(true)
    await waitFor(() => !a.dms.online(room), 'Bob away')
    const bad = await legacyEvent(a, room, '\u0001'.repeat(3000))
    await a.dms.recheckOutbox()
    const v = await view(a, b)
    expect(v.map(m => [m.pending, m.failed])).toEqual([[true, true]])
    expect(await failure(a.dms.retry(room, bad.id))).toBe(
      "This message can't be sent. Delete it instead."
    )
    await a.dms.redact(room, bad.id)
    expect(await view(a, b)).toEqual([])
    expect(await a.store.db.get('outbox', bad.id)).toBeUndefined()
    await a.dms.send(room, { body: 'after' })
    await b.node.setPaused(false)
    b.node.schedule(true)
    await waitFor(() => linked(a, b), 'back')
    // Bob gets the redacted copy, which validates, and nothing is struck.
    await eventually(async () => (await b.store.event(bad.id))?.redacted === true, 'redacted copy')
    await eventually(async () => (await bodies(b, a)).join() === 'after', 'after')
    expect(sessionOf(b, room).strikes).toBe(0)
  })

  test('an event the other side refuses is marked failed, not left pending', async () => {
    const { a, b, room } = await pair()
    const bad = await legacyEvent(a, room, '\u0001'.repeat(3000))
    a.dms.sync.push(room, bad.id, bad.wire)
    await eventually(async () => (await view(a, b))[0]?.failed === true, 'failed')
    expect(a.dms.sync.linksOf(room)[0].inFlight).toEqual([])
    expect(sessionOf(b, room).strikes).toBe(1)
    expect(await bodies(b, a)).toEqual([])
  })
})

describe('storage limits', () => {
  test('bytes are capped per room; the sender hears "full" and stops pushing', async () => {
    const { a, b, room } = await pair({}, { roomBytes: 6000 })
    for (let i = 0; i < 6; i += 1) await a.dms.send(room, { body: `${i}`.padEnd(1500, 'x') })
    await eventually(async () => !!(await a.store.room(room))?.peerFull, 'their storage is full')
    const rb = (await b.store.room(room))!
    expect(rb.full).toBe(true)
    expect(rb.fullWhy).toBe('bytes')
    expect(rb.bytes ?? 0).toBeLessThanOrEqual(6000)
    expect((await bodies(b, a)).length).toBeLessThan(6)
    expect(a.dms.sync.peerFull(room)).toBe(true)
    expect(a.dms.sync.linksOf(room)[0].inFlight).toEqual([])
    expect((await view(a, b)).some(m => m.pending)).toBe(true)
    expect(sessionOf(a, room).strikes + sessionOf(b, room).strikes).toBe(0)
    // Bob's own messages are refused with a clear reason.
    expect(await failure(b.dms.send(room, { body: 'b' }))).toBe(
      'This conversation reached the storage limit of 6 KB on this device.'
    )
    expect(dag.DAG.roomBytes).toBe(200 * 1024 * 1024)
    expect(dag.DAG.totalBytes).toBe(1024 * 1024 * 1024)
  })

  test('a quota error is acked as full, the window drains, and delivery resumes', async () => {
    const { a, b, room, clock } = await pair({ limits: { peerFullMs: 2000 } })
    let quota = true
    const db = b.store.db
    const real = db.transaction.bind(db)
    ;(db as unknown as { transaction: unknown }).transaction = (
      names: string | string[],
      mode?: IDBTransactionMode
    ) => {
      if (quota && mode === 'readwrite' && [names].flat().includes('events'))
        throw new DOMException('The quota has been exceeded.', 'QuotaExceededError')
      return real(names as never, mode)
    }
    await a.dms.send(room, { body: 'one' })
    await eventually(async () => b.dms.storageFull, 'quota noticed')
    await eventually(async () => a.dms.sync.linksOf(room)[0].inFlight.length === 0, 'drained')
    await eventually(async () => !!(await a.store.room(room))?.peerFull, 'peer full')
    expect(sessionOf(b, room).strikes).toBe(0)
    expect(await failure(b.dms.send(room, { body: 'b' }))).toBe(
      "Storage on this device is full. New messages can't be saved."
    )
    quota = false
    await clock.advance(61_000)
    await a.dms.send(room, { body: 'two' })
    await eventually(async () => (await bodies(b, a)).join() === 'one,two', 'both arrive')
    expect(b.dms.storageFull).toBe(false)
    await eventually(async () => !(await a.store.room(room))?.peerFull, 'cleared')
    await eventually(async () => (await view(a, b)).every(m => !m.pending), 'delivered')
  })
})

describe('storage limits, after a full pause', () => {
  test('what waited goes out when the pause ends, with nothing new sent', async () => {
    // Longer than the receiver waits before it tries its storage again (like the default).
    const { a, b, room, clock } = await pair({ limits: { peerFullMs: 61_000 } })
    let quota = true
    const db = b.store.db
    const real = db.transaction.bind(db)
    ;(db as unknown as { transaction: unknown }).transaction = (
      names: string | string[],
      mode?: IDBTransactionMode
    ) => {
      if (quota && mode === 'readwrite' && [names].flat().includes('events'))
        throw new DOMException('The quota has been exceeded.', 'QuotaExceededError')
      return real(names as never, mode)
    }
    await a.dms.send(room, { body: 'one' })
    await eventually(async () => !!(await a.store.room(room))?.peerFull, 'peer full')
    quota = false
    await clock.advance(61_001)
    await eventually(async () => (await bodies(b, a)).join() === 'one', 'arrives')
  })
})

describe('revoked devices', () => {
  const setup = async () => {
    const p = await pair()
    const { a, b, clock } = p
    const B = b.node.ik
    const bob = b.node.author()!
    const old = newKeyPair()
    const revokedAt = clock.now()
    const rev = signRevocation(bob.ik, keyId(old.pk), revokedAt)
    const oldCert = { v: 1 as const, ik: B, dk: keyId(old.pk), created: 1, label: 'Old', sig: '' }
    // Alice knows the old device and its revocation (its cert is kept here, so only the
    // revocation rule stands between a backdated event and the conversation).
    for (const n of [a.node, b.node]) {
      const orig = n.devicesOf.bind(n)
      n.devicesOf = (ik: string) => {
        const d = orig(ik)
        return ik === B && d
          ? { certs: [...d.certs, oldCert], revocations: [...d.revocations, rev] }
          : d
      }
    }
    return { ...p, bob, oldAuthor: { ik: bob.ik, dk: old }, revokedAt }
  }

  test('a backdated event from a revoked device is refused', async () => {
    const { a, b, room, oldAuthor, revokedAt } = await setup()
    const sessB = sessionOf(b, room)
    const sessA = sessionOf(a, room)
    const back = await eventOn(
      b,
      room,
      oldAuthor,
      'msg',
      { body: 'backdated' },
      { ts: revokedAt - 1000 }
    )
    await sessB.send({ t: 'push', room, ev: back.wire })
    await settle(30)
    expect(await a.store.event(back.id)).toBeUndefined()
    // Claimed before the revocation: dropped without a strike.
    expect(sessA.strikes).toBe(0)
    const after = await eventOn(
      b,
      room,
      oldAuthor,
      'msg',
      { body: 'after' },
      { ts: revokedAt + 1000 }
    )
    await sessB.send({ t: 'push', room, ev: after.wire })
    await waitFor(() => sessA.strikes === 1, 'struck')
    expect(await bodies(a, b)).toEqual([])
  })

  test('a pre-revocation event that a good device built on is kept', async () => {
    const { a, b, room, bob, oldAuthor, revokedAt } = await setup()
    const sessB = sessionOf(b, room)
    const ctx = { me: b.node.ik, peer: a.node.ik }
    const early = await eventOn(
      b,
      room,
      oldAuthor,
      'msg',
      { body: 'early' },
      { ts: revokedAt - 5000 }
    )
    await insertEvent(b.store.db, early.id, early.wire, revokedAt - 5000, ctx)
    const good = await eventOn(b, room, bob, 'msg', { body: 'good' }, { ts: revokedAt + 10 })
    expect(good.wire.ev.prev).toEqual([early.id])
    await insertEvent(b.store.db, good.id, good.wire, revokedAt + 10, ctx)
    await sessB.send({ t: 'push', room, ev: good.wire })
    await eventually(async () => (await bodies(a, b)).join() === 'early,good', 'both kept')
    expect(sessionOf(a, room).strikes).toBe(0)
  })

  test('one pulled before the good device built on it comes once that head arrives', async () => {
    const { a, b, room, bob, oldAuthor, revokedAt } = await setup()
    const ctx = { me: b.node.ik, peer: a.node.ik }
    const early = await eventOn(
      b,
      room,
      oldAuthor,
      'msg',
      { body: 'early' },
      { ts: revokedAt - 5000 }
    )
    await insertEvent(b.store.db, early.id, early.wire, revokedAt - 5000, ctx)
    // Bob's heads name it: Alice pulls it, can't keep it yet, and stops asking.
    const linkB = b.dms.sync.linksOf(room)[0]
    await (b.dms.sync as unknown as { sendHeads: (l: unknown) => Promise<void> }).sendHeads(linkB)
    const linkA = a.dms.sync.linksOf(room)[0]
    await eventually(async () => linkA.unavailable.has(early.id), 'not stored yet')
    const good = await eventOn(b, room, bob, 'msg', { body: 'good' }, { ts: revokedAt + 10 })
    await insertEvent(b.store.db, good.id, good.wire, revokedAt + 10, ctx)
    await sessionOf(b, room).send({ t: 'push', room, ev: good.wire })
    await eventually(async () => (await bodies(a, b)).join() === 'early,good', 'both kept')
    expect(sessionOf(a, room).strikes).toBe(0)
  })
})

describe('events a peer pushes', () => {
  const id64 = b64u(new Uint8Array(32).fill(9))

  test("edits and deletes of someone else's message are refused and struck", async () => {
    const { a, b, room } = await pair()
    const mine = await a.dms.send(room, { body: 'mine' })
    await eventually(async () => (await bodies(b, a)).length === 1, 'arrived')
    const bob = b.node.author()!
    const sessB = sessionOf(b, room)
    const sessA = sessionOf(a, room)
    const edit = await eventOn(b, room, bob, 'edit', { target: mine, body: 'hacked' })
    await sessB.send({ t: 'push', room, ev: edit.wire })
    await waitFor(() => sessA.strikes === 1, 'edit struck')
    const del = await eventOn(b, room, bob, 'redact', { target: mine })
    await sessB.send({ t: 'push', room, ev: del.wire })
    await waitFor(() => sessA.strikes === 2, 'redact struck')
    // Reactions and pins only go on messages.
    const react = await a.dms.react(room, mine, '🎉', true)
    for (const [type, content] of [
      ['react', { target: react, key: '👍', on: true }],
      ['pin', { target: react, on: true }],
    ] as const) {
      const ev = await eventOn(b, room, bob, type, content)
      await sessB.send({ t: 'push', room, ev: ev.wire })
    }
    await waitFor(() => sessA.strikes === 4, 'reaction and pin struck')
    expect(await bodies(a, b)).toEqual(['mine'])
    expect(await a.store.event(edit.id)).toBeUndefined()
  })

  test('an edit that arrives before its target from someone else is ignored', async () => {
    const { a, b, room } = await pair()
    await b.node.setPaused(true)
    await waitFor(() => !a.dms.online(room), 'away')
    const alice = a.node.author()!
    const bob = b.node.author()!
    const msg = await eventOn(a, room, alice, 'msg', { body: 'original' })
    const edit = await eventOn(a, room, bob, 'edit', { target: msg.id, body: 'hacked' })
    const ctx = { me: a.node.ik, peer: b.node.ik }
    expect((await insertEvent(a.store.db, edit.id, edit.wire, Date.now(), ctx)).status).toBe('new')
    expect((await insertEvent(a.store.db, msg.id, msg.wire, Date.now(), ctx)).status).toBe('new')
    expect(await bodies(a, b)).toEqual(['original'])
  })

  test('unknown parents with a depth near the limit are refused', async () => {
    const { a, b, room } = await pair()
    const sessA = sessionOf(a, room)
    const deep = await eventOn(
      b,
      room,
      b.node.author()!,
      'msg',
      { body: 'deep' },
      {
        prev: [id64],
        depth: EV.depth - 1,
      }
    )
    await sessionOf(b, room).send({ t: 'push', room, ev: deep.wire })
    await waitFor(() => sessA.strikes === 1, 'struck')
    expect(await a.store.event(deep.id)).toBeUndefined()
    // Alice can still send, and Bob accepts it.
    await a.dms.send(room, { body: 'still fine' })
    await eventually(async () => (await bodies(b, a)).join() === 'still fine', 'delivered')
  })

  test('a peer clock ahead does not push our new messages into the future', async () => {
    const { a, b, room, clock } = await pair()
    const ahead = await eventOn(
      b,
      room,
      b.node.author()!,
      'msg',
      { body: 'ahead' },
      {
        ts: clock.now() + 4 * 60_000,
      }
    )
    await sessionOf(b, room).send({ t: 'push', room, ev: ahead.wire })
    await eventually(async () => (await bodies(a, b)).length === 1, 'ahead')
    await a.dms.send(room, { body: 'now' })
    const v = await view(a, b)
    expect(v.find(m => m.body === 'now')?.ts).toBe(clock.now())
  })

  test('a reply to something that is not a message never pings', async () => {
    const { a, b, room } = await pair()
    const mine = await a.dms.send(room, { body: 'mine' })
    const react = await a.dms.react(room, mine, '🎉', true)
    await eventually(async () => (await bodies(b, a)).length === 1, 'arrived')
    await a.dms.markRead(room)
    await b.dms.send(room, { body: 'odd reply', reply: react })
    await eventually(async () => (await bodies(a, b)).length === 2, 'reply')
    expect((await a.store.room(room))?.pings).toBe(0)
  })

  test('deleting a message that still waits to go out drops its content', async () => {
    const { a, room } = await pair({ limits: { pushEvents: 1 } })
    const sess = sessionOf(a, room)
    const realSend = sess.send.bind(sess)
    sess.send = msg => (msg.t === 'push' ? Promise.resolve() : realSend(msg))
    await a.dms.send(room, { body: 'first' })
    const secret = await a.dms.send(room, { body: 'secret' })
    const link = a.dms.sync.linksOf(room)[0]
    expect(link.waiting.find(w => w.id === secret)?.wire.c).not.toBeNull()
    await a.dms.redact(room, secret)
    expect((link.waiting.find(w => w.id === secret)?.wire as Wire).c).toBeNull()
  })
})
