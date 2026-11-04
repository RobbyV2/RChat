import { afterEach, describe, expect, test } from 'bun:test'
import { P } from '../p2p/acl/rules'
import { IMPL, SUM_SHAPE } from '../p2p/acl_room'
import {
  blankRoom,
  cacheKey,
  chainKey,
  SERVER_ACL,
  SERVER_TOTAL,
  storedSize,
  UNKNOWN,
  type DevChain,
} from '../p2p/dag'
import type { RoomRecord, ServerCache } from '../p2p/db'
import { buildEvent2, type Wire, type WireV2 } from '../p2p/event'
import { genesisBundle } from '../p2p/acl/binding'
import { b64u, randomBytes } from '../p2p/canonical'
import { keyId, newKeyPair } from '../p2p/keys'
import { LocalHost, type AclHost } from '../p2p/resolve_host'
import { Gossip } from '../p2p/gossip'
import type { Message } from '../p2p/frames'
import { LONE_TEXT, TOO_BIG_TEXT } from '../p2p/flows'
import { LEGACY_TEXT, parseCode, REDEEM_TEXT, SERVER, UPDATE_TEXT } from '../p2p/server'
import { SHARE } from '../p2p/shares'
import type { Session } from '../p2p/session'
import type { Link } from '../p2p/sync'
import { Hub, ManualClock } from './p2p_net'
import {
  bodies,
  deliver,
  general,
  joinWithCode,
  makeMember,
  planOf,
  pump,
  restart,
  signed,
  stopAll,
  stopMember,
  type Member,
} from './p2p_server_net'

// Abuse limits and local storage of P2P servers (spec 2.1, 4.1, 4.2, 4.3) on real members over
// the in-memory hub.

afterEach(stopAll)

const DAY = 24 * 60 * 60_000

type Emit = (
  room: string,
  t: string,
  make: () => Record<string, unknown>,
  opts?: { L?: 'a' | 'c'; to?: string }
) => Promise<string>
const emit = (m: Member): Emit => (m.servers as unknown as { emit: Emit }).emit.bind(m.servers)

const stored = (m: Member, id: string) => m.store.db.get('events', id)

const membershipAt = (m: Member, room: string, ik: string) =>
  m.servers.view(room)?.members.find(x => x.ik === ik)?.m ?? null

const failure = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e: Error) => e.message
  )

// A run of messages `m` signs on the ACL position `ap` with fresh seqs on its own content chain
// (what a member who didn't hear of something writes), not received anywhere yet.
const run = async (m: Member, room: string, ap: string[], bodies_: string[], ch: string) => {
  const dev = keyId(m.node.author()!.dk.pk)
  const chain = (await m.store.meta<DevChain>(chainKey(room, dev)))!
  let seq = chain.seq
  let cprev = chain.cprev
  const out: { id: string; wire: Wire }[] = []
  for (const body of bodies_) {
    seq += 1
    const ev = await signed(m, room, 'msg', { body, ch }, { ap, seq, ...(cprev ? { cprev } : {}) })
    cprev = ev.id
    out.push(ev)
  }
  return out
}

describe('storage (spec 4.2)', () => {
  test('a full room still takes the owner’s ban; the banned member’s hidden content is evicted at once, giving room back', async () => {
    // One sender fills the room here: no share limits this test.
    const share = { ...SHARE }
    SHARE.room = 2
    SHARE.server = 2
    try {
      await fullRoom()
    } finally {
      Object.assign(SHARE, share)
    }
  }, 60_000)

  const fullRoom = async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const a = await makeMember(hub, 'Alice', clock, { servers: { roomCap: 40 } })
    const b = await makeMember(hub, 'Bob', clock)
    const c = await makeMember(hub, 'Carol', clock)
    const room = await a.servers.create('Full')
    const ch = general(a, room)
    await joinWithCode(clock, a, room, b)
    await joinWithCode(clock, a, room, c)
    await c.node.setPaused(true)
    await b.node.setPaused(true)
    // Bob fills the room at Alice's, written after a ban he won't hear of: all of it is past the
    // ban's watermark, so hidden there.
    const at = (await planOf(b, room, 'msg', 'c')).ap
    await a.servers.ban(room, b.node.ik)
    expect(membershipAt(a, room, b.node.ik)).toBe('ban')
    let n = 0
    for (const ev of await run(
      b,
      room,
      at,
      Array.from({ length: 60 }, (_, i) => `spam ${i}`),
      ch
    ))
      if ((await deliver(a, room, ev.wire, clock.now())) === 'new') n += 1
    const rec = (await a.store.room(room))!
    expect(n).toBeGreaterThan(40)
    expect(rec.count).toBeLessThanOrEqual(40)
    // Not stable (nobody else acknowledged the ban), but hidden: evicted under pressure.
    expect((await a.store.db.getAll('events')).some(r => r.purged)).toBe(true)
    // The ACL always fits: the owner can still moderate in a full room.
    await a.servers.unban(room, b.node.ik)
    await a.servers.ban(room, b.node.ik)
    await c.node.setPaused(false)
    await c.servers.send(room, { ch, body: 'still room' })
    await pump(clock, async () => (await bodies(a, room, ch)).includes('still room'), 'a has c')
    const purged = (await a.store.db.getAll('events')).filter(r => r.purged)
    expect(purged.length).toBeGreaterThan(0)
    expect(purged.every(r => r.sender === b.node.ik && r.wire.c === null)).toBe(true)
  }

  test('what waits for its parents is bounded, and refusals take what waits on them along', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const a = await makeMember(hub, 'Alice', clock)
    const b = await makeMember(hub, 'Bob', clock)
    const room = await a.servers.create('Pending')
    const ch = general(a, room)
    await joinWithCode(clock, a, room, b)
    const was = SERVER.pendingEvents
    SERVER.pendingEvents = 5
    try {
      const missing = 'A'.repeat(43)
      for (const ev of await run(b, room, [missing], ['1', '2', '3', '4', '5', '6', '7'], ch))
        expect(await deliver(a, room, ev.wire, clock.now())).toBe('quota')
      expect(a.servers.waiting(room).pending).toBe(5)
    } finally {
      SERVER.pendingEvents = was
    }
    // Refused by the rules (no Manage server): not stored, no strike, and an event built on it is
    // refused with it, even one that waited for it.
    const bad = await signed(b, room, 'settings', { name: 'Mine' })
    const on = await signed(b, room, 'mark', {}, { ap: [bad.id], aprev: bad.id })
    expect(await deliver(a, room, on.wire, clock.now())).toBe('quota')
    expect(await deliver(a, room, bad.wire, clock.now())).toBe('rejected')
    expect(await deliver(a, room, on.wire, clock.now())).toBe('rejected')
    expect(await stored(a, bad.id)).toBeUndefined()
  }, 60_000)

  test('events dated ahead are held until their time, a bounded number per device', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const a = await makeMember(hub, 'Alice', clock)
    const b = await makeMember(hub, 'Bob', clock)
    const room = await a.servers.create('Later')
    const ch = general(a, room)
    await joinWithCode(clock, a, room, b)
    await b.node.setPaused(true)
    const was = SERVER.heldPerDevice
    SERVER.heldPerDevice = 2
    try {
      const ap = (await planOf(b, room, 'msg', 'c')).ap
      const dev = keyId(b.node.author()!.dk.pk)
      const chain = (await b.store.meta<DevChain>(chainKey(room, dev)))!
      const ahead = clock.now() + 20 * 60_000
      const evs = []
      let cprev = chain.cprev
      for (let i = 1; i <= 3; i++) {
        const ev = await signed(
          b,
          room,
          'msg',
          { body: `later ${i}`, ch },
          { ap, seq: chain.seq + i, ts: ahead + i, ...(cprev ? { cprev } : {}) }
        )
        cprev = ev.id
        evs.push(ev)
      }
      for (const ev of evs) expect(await deliver(a, room, ev.wire, clock.now())).toBe('quota')
      expect(a.servers.waiting(room).held).toBe(2)
      expect(await bodies(a, room, ch)).toEqual([])
      clock.t += 20 * 60_000
      await pump(clock, async () => (await bodies(a, room, ch)).length === 2, 'held ones shown')
      expect(await bodies(a, room, ch)).toEqual(['later 1', 'later 2'])
    } finally {
      SERVER.heldPerDevice = was
    }
  }, 60_000)

  test('a device alone can make only so many changes nobody acknowledged; moderation still fits', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const a = await makeMember(hub, 'Alice', clock)
    const b = await makeMember(hub, 'Bob', clock)
    const room = await a.servers.create('Quiet')
    await joinWithCode(clock, a, room, b)
    await a.node.setPaused(true)
    // W3(b): Bob's counted ACL events that no event of another member has in its past.
    let n = 0
    let why = 'ok'
    while (why === 'ok' && n < 40) {
      why = await failure(emit(b)(room, 'mark', () => ({})))
      if (why === 'ok') n += 1
    }
    expect(why).toBe(LONE_TEXT)
    expect(n).toBeLessThan(24)
    // The owner sees them and acknowledges them; Bob can go on.
    await a.node.setPaused(false)
    await pump(
      clock,
      async () => (await failure(emit(a)(room, 'mark', () => ({})))) === 'ok',
      'a marks'
    )
    await pump(
      clock,
      async () => (await failure(emit(b)(room, 'mark', () => ({})))) === 'ok',
      'b goes on'
    )
    // Removing a member is never limited this way.
    await a.servers.kick(room, b.node.ik)
    expect(membershipAt(a, room, b.node.ik)).toBeNull()
  }, 60_000)

  test('a received ACL event that fails to save leaves the page’s copy and the evaluator in step', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const a = await makeMember(hub, 'Alice', clock)
    const b = await makeMember(hub, 'Bob', clock)
    const room = await a.servers.create('Quota')
    await joinWithCode(clock, a, room, b)
    await b.node.setPaused(true)
    const seen = (await planOf(b, room, 'leave')).seen ?? {}
    const leave = await signed(b, room, 'leave', { seen })
    const db = a.store.db as unknown as { transaction: (...x: unknown[]) => unknown }
    const real = db.transaction.bind(db)
    let fail = true
    db.transaction = (names: unknown, mode?: unknown) => {
      if (fail && mode === 'readwrite' && Array.isArray(names) && names.includes('children')) {
        fail = false
        throw Object.assign(new Error('quota'), { name: 'QuotaExceededError' })
      }
      return real(names, mode)
    }
    expect(await failure(deliver(a, room, leave.wire, clock.now()))).toBe('quota')
    expect(membershipAt(a, room, b.node.ik)).toBe('join')
    expect(await deliver(a, room, leave.wire, clock.now())).toBe('new')
    expect(membershipAt(a, room, b.node.ik)).toBeNull()
  }, 60_000)

  test('content that fails to save is let go of by the evaluator, without reloading the room', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const a = await makeMember(hub, 'Alice', clock)
    const b = await makeMember(hub, 'Bob', clock)
    const room = await a.servers.create('Quota')
    const ch = general(a, room)
    await joinWithCode(clock, a, room, b)
    const id = await b.servers.send(room, { ch, body: 'keep' })
    await pump(clock, async () => (await bodies(a, room, ch)).includes('keep'), 'a has it')
    await b.node.setPaused(true)
    // Bob's redaction of it fails to save here: it must not hide the message.
    const r = await signed(b, room, 'redact', { target: id, ch })
    const host = (a.servers as unknown as { host: { load: (...x: unknown[]) => unknown } }).host
    const load = host.load.bind(host)
    let loads = 0
    host.load = (...x: unknown[]) => {
      loads += 1
      return load(...x)
    }
    const db = a.store.db as unknown as { transaction: (...x: unknown[]) => unknown }
    const real = db.transaction.bind(db)
    let fail = true
    db.transaction = (names: unknown, mode?: unknown) => {
      if (fail && mode === 'readwrite' && Array.isArray(names) && names.includes('children')) {
        fail = false
        throw Object.assign(new Error('quota'), { name: 'QuotaExceededError' })
      }
      return real(names, mode)
    }
    expect(await failure(deliver(a, room, r.wire, clock.now()))).toBe('quota')
    expect(await bodies(a, room, ch)).toEqual(['keep'])
    expect(loads).toBe(0)
    // Delivered again, it is stored and counts.
    expect(await deliver(a, room, r.wire, clock.now())).toBe('new')
    expect(await bodies(a, room, ch)).toEqual([])
  }, 60_000)

  test('content storage refuses after the evaluator took it raises no removal watermark: a later kick still hides what comes after what is held', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const a = await makeMember(hub, 'Alice', clock)
    const b = await makeMember(hub, 'Bob', clock)
    const room = await a.servers.create('Mark')
    const other = await a.servers.create('Elsewhere')
    const ch = general(a, room)
    await joinWithCode(clock, a, room, b)
    const away = await a.servers.send(other, { ch: general(a, other), body: 'elsewhere' })
    const id = await b.servers.send(room, { ch, body: 'held' })
    await pump(clock, async () => !!(await stored(a, id)), 'a has it')
    await b.node.setPaused(true)
    const at = (await planOf(b, room, 'msg', 'c')).ap
    const held = (await stored(a, id))!.dseq!
    const dev = keyId(b.node.author()!.dk.pk)
    // A reaction far ahead on Bob's chain, aimed at a message of another room: the evaluator takes
    // it, storage refuses it (a target elsewhere, no strike).
    const far = await signed(
      b,
      room,
      'react',
      { target: away, key: 'x', on: true, ch },
      { seq: held + 400 }
    )
    expect(await deliver(a, room, far.wire, clock.now())).toBe('rejected')
    expect((await planOf(a, room, 'kick', 'a', b.node.ik)).seen?.[dev]).toBe(held)
    // Alice kicks Bob; what Bob writes after what Alice held is hidden, whatever seq it takes.
    await a.servers.kick(room, b.node.ik)
    const late = await signed(b, room, 'msg', { body: 'after', ch }, { ap: at, seq: held + 10 })
    expect(await deliver(a, room, late.wire, clock.now())).toBe('new')
    expect(await bodies(a, room, ch)).toEqual(['held'])
  }, 60_000)

  test('an evaluator that lost a room gets it back from storage before deciding', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const a = await makeMember(hub, 'Alice', clock)
    const b = await makeMember(hub, 'Bob', clock)
    const room = await a.servers.create('Lost')
    await joinWithCode(clock, a, room, b)
    await b.node.setPaused(true)
    ;(a.servers as unknown as { host: { drop: (r: string) => void } }).host.drop(room)
    const mark = await signed(b, room, 'mark', {})
    expect(await deliver(a, room, mark.wire, clock.now())).toBe('new')
    expect(a.servers.waiting(room).pending).toBe(0)
  }, 60_000)

  test('a redaction naming an ACL event leaves it whole', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const a = await makeMember(hub, 'Alice', clock)
    const b = await makeMember(hub, 'Bob', clock)
    const room = await a.servers.create('Whole')
    const ch = general(a, room)
    await joinWithCode(clock, a, room, b)
    const join = (await b.store.db.getAll('events')).find(
      r => r.room === room && r.type === 'join' && r.sender === b.node.ik
    )!
    const red = await signed(b, room, 'redact', { target: join.id, ch })
    await deliver(a, room, red.wire, clock.now())
    expect((await stored(a, join.id))?.wire.c).not.toBeNull()
    expect((await stored(a, join.id))?.redacted).toBe(false)
  }, 60_000)

  test('content a moderator hid is served whole and hidden where it arrives', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const a = await makeMember(hub, 'Alice', clock)
    const b = await makeMember(hub, 'Bob', clock)
    const c = await makeMember(hub, 'Carol', clock)
    const room = await a.servers.create('Redacted')
    const ch = general(a, room)
    await joinWithCode(clock, a, room, b)
    const id = await b.servers.send(room, { ch, body: 'secret' })
    await pump(clock, async () => (await bodies(a, room, ch)).includes('secret'), 'a has it')
    await a.servers.redact(room, id)
    expect(await bodies(a, room, ch)).toEqual([])
    // Not stable: the body stays here and can be fetched again (spec 4.3).
    expect((await stored(a, id))?.wire.c).not.toBeNull()
    await b.node.setPaused(true)
    await joinWithCode(clock, a, room, c)
    await pump(clock, async () => !!(await stored(c, id)), 'c has it')
    expect((await stored(c, id))?.wire.c).not.toBeNull()
    expect(await bodies(c, room, ch)).toEqual([])
  }, 60_000)

  test('only a redaction that counts purges its author’s message', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const a = await makeMember(hub, 'Alice', clock)
    const b = await makeMember(hub, 'Bob', clock)
    const room = await a.servers.create('Counts')
    const ch = general(a, room)
    await joinWithCode(clock, a, room, b)
    const old = (await planOf(b, room, 'msg', 'c')).ap
    await emit(a)(room, 'mark', () => ({}))
    await pump(
      clock,
      async () => (await planOf(b, room, 'msg', 'c')).ap.join() !== old.join(),
      'b moves on'
    )
    const id = await b.servers.send(room, { ch, body: 'keep me' })
    await pump(clock, async () => (await bodies(a, room, ch)).includes('keep me'), 'a has it')
    await b.node.setPaused(true)
    // Positioned before its target: it counts nowhere and purges nothing.
    const early = await signed(b, room, 'redact', { target: id, ch }, { ap: old })
    expect(await deliver(a, room, early.wire, clock.now())).toBe('new')
    expect((await stored(a, id))?.redacted).toBe(false)
    expect(await bodies(a, room, ch)).toEqual(['keep me'])
    // One that counts does.
    const seq = (early.wire.ev as unknown as { seq: number }).seq
    const real = await signed(
      b,
      room,
      'redact',
      { target: id, ch },
      { seq: seq + 1, cprev: early.id }
    )
    expect(await deliver(a, room, real.wire, clock.now())).toBe('new')
    expect((await stored(a, id))?.redacted).toBe(true)
    // On a forked device chain (a seq used twice): void, it purges nothing.
    await b.node.setPaused(false)
    const id2 = await b.servers.send(room, { ch, body: 'also kept' })
    await pump(clock, async () => !!(await stored(a, id2)), 'a has the second')
    await b.node.setPaused(true)
    const m2 = (await stored(a, id2))!.wire.ev as unknown as { seq: number; cprev?: string }
    const forked = await signed(
      b,
      room,
      'redact',
      { target: id2, ch },
      { seq: m2.seq, ...(m2.cprev ? { cprev: m2.cprev } : {}) }
    )
    expect(await deliver(a, room, forked.wire, clock.now())).toBe('new')
    expect((await stored(a, id2))?.redacted).toBe(false)
    expect((await stored(a, id2))?.wire.c).not.toBeNull()
  }, 60_000)

  test('a ban overturned before the purge takes nothing with it', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const a = await makeMember(hub, 'Alice', clock)
    const m = await makeMember(hub, 'Mod', clock)
    const b = await makeMember(hub, 'Bob', clock)
    const room = await a.servers.create('Overturn')
    const ch = general(a, room)
    for (const x of [m, b]) await joinWithCode(clock, a, room, x)
    const role = await emit(a)(room, 'role_create', () => ({ pos: 1, bits: P.Ban | P.Kick }))
    await emit(a)(room, 'assign', () => ({ to: m.node.ik, role }))
    await pump(clock, () => ((m.servers.view(room)?.perms ?? 0) & P.Ban) !== 0, 'm is a mod')
    await pump(clock, () => a.servers.view(room)?.joined === 3, 'a sees all')
    const before = (await planOf(a, room, 'mark')).ap
    await b.servers.send(room, { ch, body: 'X' })
    await pump(clock, async () => (await bodies(m, room, ch)).includes('X'), 'm has X')
    await m.servers.ban(room, b.node.ik)
    await pump(clock, () => membershipAt(a, room, b.node.ik) === 'ban', 'a sees the ban')
    // The owner had demoted the moderator concurrently, from before the ban: the ban falls.
    const seen = (await planOf(a, room, 'revoke', 'a', m.node.ik)).seen ?? {}
    const revoke = await signed(a, room, 'revoke', { to: m.node.ik, role, seen }, { ap: before })
    expect(await deliver(a, room, revoke.wire, clock.now())).toBe('new')
    expect(membershipAt(a, room, b.node.ik)).toBe('join')
    expect(await bodies(a, room, ch)).toContain('X')
    clock.t += 8 * DAY
    await clock.advance(30_000)
    expect(await bodies(a, room, ch)).toContain('X')
    expect((await a.store.db.getAll('events')).some(r => r.purged)).toBe(false)
  }, 90_000)

  test('a ban that stands is purged after a week once others acknowledged it (S1 to S4), not before', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const a = await makeMember(hub, 'Alice', clock)
    const b = await makeMember(hub, 'Bob', clock)
    const c = await makeMember(hub, 'Carol', clock)
    const d = await makeMember(hub, 'Dan', clock)
    const e = await makeMember(hub, 'Eve', clock)
    const room = await a.servers.create('Week')
    const ch = general(a, room)
    for (const x of [b, c, d, e]) await joinWithCode(clock, a, room, x)
    await b.node.setPaused(true)
    await e.node.setPaused(true)
    const atB = (await planOf(b, room, 'msg', 'c')).ap
    const atE = (await planOf(e, room, 'msg', 'c')).ap
    await a.servers.ban(room, b.node.ik)
    // Three ACL events of two others with Bob's ban in their past (S2).
    for (const x of [c, c, d]) {
      await pump(clock, () => membershipAt(x, room, b.node.ik) === 'ban', `${x.name} has the ban`)
      await emit(x)(room, 'mark', () => ({}))
    }
    const marks = async () =>
      (await a.store.db.getAll('events')).filter(r => r.type === 'mark' && r.room === room).length
    await pump(clock, async () => (await marks()) >= 3, 'a has the marks')
    // Eve's ban comes after them: nobody acknowledges it.
    await a.servers.ban(room, e.node.ik)
    const [lateB] = await run(b, room, atB, ['late'], ch)
    const [lateE] = await run(e, room, atE, ['late too'], ch)
    for (const ev of [lateB, lateE])
      expect(await deliver(a, room, ev.wire, clock.now())).toBe('new')
    const count = (await a.store.room(room))!.count
    expect(await bodies(a, room, ch)).toEqual([])
    clock.t += 6 * DAY
    await clock.advance(70_000)
    expect((await stored(a, lateB.id))?.purged).toBeUndefined()
    clock.t += 2 * DAY
    await pump(clock, async () => (await stored(a, lateB.id))?.purged === true, 'purged', 70_000)
    expect((await stored(a, lateB.id))?.wire.c).toBe(null)
    expect((await a.store.room(room))!.count).toBe(count - 1)
    // Eve's ban stood as long, but nobody but its author and target acknowledged it.
    clock.t += 30 * DAY
    await clock.advance(70_000)
    expect((await stored(a, lateE.id))?.purged).toBeUndefined()
    expect((await stored(a, lateE.id))?.wire.c).not.toBeNull()
  }, 90_000)

  test('our own messages no peer has yet are never evicted for space; once one has them, the oldest may go', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const a = await makeMember(hub, 'Alice', clock, { servers: { roomCap: 5 } })
    const room = await a.servers.create('Alone')
    const ch = general(a, room)
    const sent = ['m0', 'm1', 'm2', 'm3', 'm4']
    const ids: string[] = []
    for (const body of sent) ids.push(await a.servers.send(room, { ch, body }))
    expect(await failure(a.servers.send(room, { ch, body: 'one too many' }))).not.toBe('ok')
    expect(await bodies(a, room, ch)).toEqual(sent)
    expect((await a.store.db.getAll('events')).some(r => r.purged)).toBe(false)
    const b = await makeMember(hub, 'Bob', clock)
    await joinWithCode(clock, a, room, b)
    await pump(clock, async () => (await bodies(b, room, ch)).length === 5, 'bob has them')
    await pump(
      clock,
      async () => (await a.store.db.getAll('outbox')).every(o => o.deliveredTo.length > 0),
      'delivered'
    )
    await a.servers.send(room, { ch, body: 'now it fits' })
    expect((await stored(a, ids[0]))?.purged).toBe(true)
  }, 60_000)

  test('ACL events never count against the content budget, and every counter stays in step with what is stored', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const a = await makeMember(hub, 'Alice', clock, { servers: { roomCap: 10 } })
    const room = await a.servers.create('Budget')
    const ch = general(a, room)
    for (let i = 0; i < 12; i += 1)
      await a.servers.createRole(room, { name: `r${i}`, color: null, bits: 0 })
    for (let i = 0; i < 10; i += 1) await a.servers.send(room, { ch, body: `m${i}` })
    expect(await bodies(a, room, ch)).toHaveLength(10)
    const inStep = async () => {
      const rec = (await a.store.room(room))!
      const evs = (await a.store.db.getAll('events')).filter(r => r.room === room && !r.purged)
      expect(rec.count).toBe(evs.length)
      expect(rec.acount).toBe(evs.filter(r => r.layer === 'a').length)
      expect(await a.store.meta<number>(SERVER_TOTAL)).toBe(evs.length)
      expect(await a.store.meta<number>(SERVER_ACL)).toBe(rec.acount)
      return rec
    }
    await inStep()
    // A purged row that turns out not to be admitted takes its bytes along (B1b drift).
    const s = a.servers as unknown as {
      purge(room: string, ids: string[]): Promise<number>
      dropRows(room: string, ids: string[]): Promise<void>
    }
    const msg = (await a.store.db.getAll('events')).find(r => r.room === room && r.type === 'msg')!
    expect(await s.purge(room, [msg.id])).toBe(1)
    const purged = (await stored(a, msg.id))!
    const before = await inStep()
    await s.dropRows(room, [msg.id])
    const after = await inStep()
    expect(after.bytes).toBe(before.bytes! - storedSize(purged.wire))
  }, 60_000)

  test('a cold start of a server whose members came in another order than they first acted reads the stored records once', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const a = await makeMember(hub, 'Alice', clock)
    const b = await makeMember(hub, 'Bob', clock)
    const c = await makeMember(hub, 'Carol', clock)
    const room = await a.servers.create('Order')
    // Invited first, never joins: listed before Bob and Carol here, after them in a fresh
    // replica.
    await emit(a)(room, 'add', () => ({ to: keyId(newKeyPair().pk) }))
    await joinWithCode(clock, a, room, b)
    await joinWithCode(clock, a, room, c)
    await a.servers.send(room, { ch: general(a, room), body: 'a body the evaluator never reads' })
    await clock.advance(5_000)
    // The cache is kept apart from the room record (which every stored event rewrites).
    const cache = (await a.store.meta<ServerCache>(cacheKey(room)))!
    expect(cache.impl).toBe(IMPL)
    expect((await a.store.room(room))?.server ?? null).toBeNull()
    // One an older build kept in the room record is read the same.
    await a.store.db.put('rooms', { ...(await a.store.room(room))!, server: cache })
    await a.store.db.delete('meta', cacheKey(room))
    stopMember(a)
    a.store.close()
    const host = new LocalHost()
    const loads: { records: number; total: number; bodies: number; contents: number }[] = []
    const load = host.load.bind(host)
    host.load = (r, acl, contents, ...rest) => {
      if (r === room)
        loads.push({
          records: acl.filter(x => x.rec).length,
          total: acl.length,
          bodies: contents.filter(m => m.c?.body !== undefined).length,
          contents: contents.length,
        })
      return load(r, acl, contents, ...rest)
    }
    const again = await makeMember(hub, 'Alice', clock, { db: a.db, servers: { resolver: host } })
    expect(again.servers.view(room)?.name).toBe('Order')
    expect(loads.length).toBe(1)
    expect(loads[0].records).toBe(loads[0].total)
    await clock.advance(5_000)
    expect((await again.store.meta<ServerCache>(cacheKey(room)))?.impl).toBe(IMPL)
    expect((await again.store.room(room))?.server ?? null).toBeNull()
    // Content goes to the evaluator trimmed to what it reads.
    expect(loads[0].contents).toBeGreaterThan(0)
    expect(loads[0].bodies).toBe(0)
    expect(await bodies(again, room, general(again, room))).toEqual([
      'a body the evaluator never reads',
    ])
  }, 60_000)

  test('a cold start reads the stored records; a cache of another implementation is ignored', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    let a = await makeMember(hub, 'Alice', clock)
    const b = await makeMember(hub, 'Bob', clock)
    const room = await a.servers.create('Rules')
    await joinWithCode(clock, a, room, b)
    await a.servers.kick(room, b.node.ik)
    const acl = (await a.store.db.getAll('events')).filter(r => r.room === room && r.layer === 'a')
    expect(acl.every(r => typeof r.aseq === 'number' && r.acl)).toBe(true)
    // A cache of an older summary shape is not read either.
    expect(
      (await a.store.meta<ServerCache>(cacheKey(room))) ?? (await a.store.room(room))?.server
    ).not.toBeUndefined()
    await a.store.db.put(
      'meta',
      { impl: IMPL, shape: SUM_SHAPE - 1, rules: 2, count: 0, sum: { nonsense: true } as never },
      cacheKey(room)
    )
    stopMember(a)
    const shaped = await restart(hub, a, clock)
    expect(shaped.servers.view(room)?.name).toBe('Rules')
    await clock.advance(5_000)
    expect((await shaped.store.meta<ServerCache>(cacheKey(room)))?.shape).toBe(SUM_SHAPE)
    stopMember(shaped)
    a = await restart(hub, shaped, clock)
    await a.store.db.put(
      'meta',
      { impl: 0, rules: 2, count: 0, sum: { nonsense: true } as never },
      cacheKey(room)
    )
    // Every record written by another implementation version: not read, admitted again.
    for (const r of acl) await a.store.db.put('events', { ...r, acl: { ...r.acl!, v: IMPL - 1 } })
    stopMember(a)
    const again = await restart(hub, a, clock)
    expect(again.servers.view(room)?.name).toBe('Rules')
    expect(again.servers.myMembership(room)).toBe('join')
    expect(membershipAt(again, room, b.node.ik)).toBeNull()
    await clock.advance(5_000)
    expect((await again.store.meta<ServerCache>(cacheKey(room)))?.impl).toBe(IMPL)
    const after = (await again.store.db.getAll('events')).filter(
      r => r.room === room && r.layer === 'a'
    )
    expect(after.every(r => r.acl?.v === IMPL)).toBe(true)
  }, 60_000)
})

describe('our own events (wire checks)', () => {
  test('one over the size limit is refused here and never kept; an edit of a channel with a planted field stays small', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const a = await makeMember(hub, 'Alice', clock)
    const b = await makeMember(hub, 'Bob', clock)
    const room = await a.servers.create('Wire')
    await joinWithCode(clock, a, room, b)
    const count = async () =>
      (await a.store.db.getAll('events')).filter(r => r.room === room).length
    const before = await count()
    const big = b64u(randomBytes(8))
    expect(
      await failure(
        emit(a)(room, 'channel', () => ({
          id: big,
          name: 'big',
          kind: 'text',
          pos: 5,
          x: 'y'.repeat(5000),
        }))
      )
    ).toBe(TOO_BIG_TEXT)
    expect(await count()).toBe(before)
    expect(a.servers.view(room)?.channels.some(c => c.id === big)).toBe(false)
    // A valid channel carrying a field this version doesn't know, near the limit (a member
    // with Manage channels can write one).
    const id = b64u(randomBytes(8))
    await emit(a)(room, 'channel', () => ({
      id,
      name: 'planted',
      kind: 'text',
      pos: 6,
      x: 'y'.repeat(3800),
    }))
    const edit = await a.servers.editChannel(room, id, { topic: 't'.repeat(400) })
    const w = (await stored(a, edit))!.wire
    expect(JSON.stringify(w.c)).not.toContain('yyyy')
    expect((await b.servers.check(room, w)).ok).toBe(true)
    // The next message still reaches Bob.
    await a.servers.send(room, { ch: id, body: 'after the edit' })
    await pump(clock, async () => (await bodies(b, room, id)).includes('after the edit'), 'sent')
  }, 60_000)

  test('a message is sized with every field it carries: thumbnails go first, else it is refused', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const a = await makeMember(hub, 'Alice', clock)
    const b = await makeMember(hub, 'Bob', clock)
    const room = await a.servers.create('Sizes')
    const ch = general(a, room)
    await joinWithCode(clock, a, room, b)
    const att = Array.from({ length: 8 }, (_, i) => ({
      h: b64u(randomBytes(32)),
      size: 10,
      blocks: 1,
      name: `p${i}.png`,
      mime: 'image/png',
      thumb: b64u(randomBytes(6 * 1024)),
    }))
    const body = '\u{1d54f}'.repeat(4000)
    const id = await a.servers.send(room, { ch, body, att })
    const w = (await stored(a, id))!.wire
    const sent = (w.c as { att: { thumb?: string }[] }).att
    expect(sent.length).toBe(8)
    expect(sent.filter(x => x.thumb).length).toBeLessThan(8)
    expect((await b.servers.check(room, w)).ok).toBe(true)
    // Names alone past the limit: refused, and not kept.
    const named = Array.from({ length: 50 }, () => ({
      h: b64u(randomBytes(32)),
      size: 10,
      blocks: 1,
      name: '\u{1d54f}'.repeat(255),
      mime: 'image/png',
    }))
    const n = (await a.store.db.getAll('events')).length
    expect(await failure(a.servers.send(room, { ch, body, att: named }))).toBe(TOO_BIG_TEXT)
    expect((await a.store.db.getAll('events')).length).toBe(n)
  }, 60_000)
})

describe('content aimed at another room', () => {
  test('is refused without a strike where that room’s event is held, and stored by relays that don’t hold it', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const a = await makeMember(hub, 'Alice', clock)
    const b = await makeMember(hub, 'Bob', clock)
    const c = await makeMember(hub, 'Carol', clock)
    const room = await a.servers.create('S')
    const ch = general(a, room)
    await joinWithCode(clock, a, room, b)
    await joinWithCode(clock, a, room, c)
    // Alice's other server: its id is in every invite code of it. Carol isn't in it.
    const other = await a.servers.create('T')
    const ev = await signed(b, room, 'react', { target: other, key: '👍', on: true, ch })
    expect(await deliver(c, room, ev.wire, clock.now())).toBe('new')
    // Carol builds on it, so Alice asks Carol for it.
    await c.servers.send(room, { ch, body: 'after the reaction' })
    await pump(
      clock,
      async () => (await bodies(a, room, ch)).includes('after the reaction'),
      'alice got carol’s message'
    )
    await pump(clock, async () => (await a.store.event(ev.id)) === undefined, 'refused', 5_000)
    expect(await deliver(a, room, ev.wire, clock.now())).toBe('rejected')
    for (const l of a.servers.sync.linksOf(room)) expect(l.session.strikes).toBe(0)
    expect(a.servers.sync.linksOf(room).length).toBeGreaterThan(0)
  }, 60_000)
})

describe('imports', () => {
  test('imported rows are checked and decided on the next start like events from a peer', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const a = await makeMember(hub, 'Alice', clock)
    const b = await makeMember(hub, 'Bob', clock)
    const x = await makeMember(hub, 'Xena', clock)
    const room = await a.servers.create('Imported')
    const ch = general(a, room)
    await joinWithCode(clock, a, room, b)
    const ok = await signed(b, room, 'msg', { body: 'fine', ch })
    // Xena is no member: her message would be refused from a peer.
    const outsider = buildEvent2(
      x.node.author()!,
      room,
      'msg',
      'c',
      { body: 'sneaked in', ch },
      { seq: 1, ap: (await planOf(b, room, 'msg', 'c')).ap },
      clock.now() + 1
    )
    const forged = await signed(b, room, 'mark', { n: 1 })
    const bad = { ...forged.wire, sig: forged.wire.sig.replace(/^./, c => (c === 'A' ? 'B' : 'A')) }
    stopMember(a)
    const row = (id: string, wire: unknown, layer: 'a' | 'c') => ({
      id,
      room,
      type: (wire as { ev: { t: string } }).ev.t,
      sender: (wire as { ev: { a: string } }).ev.a,
      wire: wire as Wire,
      depth: 0,
      effTs: clock.now(),
      sortKey: `${clock.now()}`,
      receivedAt: clock.now(),
      seq: 10_000 + Math.floor(Math.random() * 1000),
      redacted: false,
      layer,
      chan: ch,
      imp: true as const,
    })
    await a.store.db.put('events', row(ok.id, ok.wire, 'c'))
    await a.store.db.put('events', row(outsider.id, outsider.wire, 'c'))
    await a.store.db.put('events', row(forged.id, bad, 'a'))
    const again = await restart(hub, a, clock)
    await pump(clock, async () => !(await stored(again, outsider.id)), 'refused content dropped')
    expect(await stored(again, forged.id)).toBeUndefined()
    expect((await stored(again, ok.id))?.imp).toBeUndefined()
    expect(await bodies(again, room, ch)).toEqual(['fine'])
  }, 60_000)
})

describe('rules versions (spec 1.2, 8)', () => {
  test('a server of unknown rules is stored unchecked within its limits, and read-only', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const a = await makeMember(hub, 'Alice', clock)
    const author = a.node.author()!
    const dk = keyId(author.dk.pk)
    const bare = { rules: 3, nonce: b64u(randomBytes(16)), owners: [{ ik: a.node.ik, dk }] }
    const g = buildEvent2(
      author,
      null,
      'genesis',
      'a',
      { ...bare, owners: [genesisBundle(author.ik, dk, bare)], future: { x: 1 } },
      { seq: 0 },
      clock.now()
    )
    const room = g.id
    const putRoom = (a.servers as unknown as { putRoom: (r: unknown) => Promise<void> }).putRoom
    const { blankRoom } = await import('../p2p/dag')
    await putRoom.call(a.servers, { ...blankRoom(room, '', 0), kind: 'server', name: 'Future' })
    // Before its genesis a server's rules version is unknown: what rules 2 would call malformed
    // waits, without a strike.
    const early = buildEvent2(author, room, 'kick', 'a', { to: 0 }, { seq: 9, ap: [room] }, 1)
    expect(await deliver(a, room, early.wire as unknown as Wire, clock.now())).toBe('later')
    expect(await deliver(a, room, g.wire as unknown as Wire, clock.now())).toBe('new')
    const was = UNKNOWN.events
    UNKNOWN.events = 3
    try {
      const out: string[] = []
      for (let i = 1; i <= 4; i++) {
        const e = buildEvent2(author, room, 'kick', 'a', { to: i }, { seq: i, ap: [room] }, 1)
        out.push(await deliver(a, room, e.wire as unknown as Wire, clock.now()))
      }
      expect(out).toEqual(['new', 'new', 'full', 'full'])
    } finally {
      UNKNOWN.events = was
    }
    expect(a.servers.view(room)?.readOnly).toBe(UPDATE_TEXT)
    // They count against the budget of every server here too.
    const meta = a.store.db
    const total = ((await meta.get('meta', 'sevents')) as number) ?? 0
    const capped = await makeMember(hub, 'Capped', clock, { servers: { serverCap: total } })
    await (capped.servers as unknown as { putRoom: (r: unknown) => Promise<void> }).putRoom({
      ...blankRoom(room, '', 0),
      kind: 'server',
      name: 'Future',
    })
    for (const e of [g])
      expect(await deliver(capped, room, e.wire as unknown as Wire, clock.now())).toBe('new')
    await capped.store.db.put('meta', total, 'sevents')
    const one = buildEvent2(author, room, 'kick', 'a', { to: 9 }, { seq: 9, ap: [room] }, 1)
    expect(await deliver(capped, room, one.wire as unknown as Wire, clock.now())).toBe('full')
    expect(await failure(a.servers.send(room, { ch: 'AAAAAAAAAAA', body: 'x' }))).toBe(UPDATE_TEXT)
  }, 60_000)

  test('a server made under the old test rules is read-only and can be removed', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const a = await makeMember(hub, 'Alice', clock)
    const { blankRoom } = await import('../p2p/dag')
    const room = 'L'.repeat(43)
    await a.store.db.put('rooms', {
      ...blankRoom(room, '', 0),
      kind: 'server',
      name: 'Old',
      count: 1,
    })
    await a.store.db.put('events', {
      id: 'E'.repeat(43),
      room,
      type: 'create',
      sender: a.node.ik,
      wire: { ev: { v: 1, room, type: 'create' }, c: {}, sig: '' } as never,
      depth: 0,
      effTs: 0,
      sortKey: '0',
      receivedAt: 0,
      seq: 1,
      redacted: false,
    })
    stopMember(a)
    const again = await restart(hub, a, clock)
    expect(again.servers.view(room)?.readOnly).toBe(LEGACY_TEXT)
    expect(again.servers.view(room)?.channels).toEqual([])
    await again.servers.forget(room)
    expect(again.servers.isServer(room)).toBe(false)
  }, 60_000)
})

describe('invite codes', () => {
  test('a redeem posts an invite naming the code; unused, it is withdrawn after the redeem time', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const a = await makeMember(hub, 'Alice', clock)
    const x = await makeMember(hub, 'Xavier', clock)
    const room = await a.servers.create('Quiet')
    const code = await a.servers.issueCode(room, 60 * 60_000)
    // Xavier's client takes the code but doesn't join.
    ;(x.servers as unknown as { postJoin: () => Promise<void> }).postJoin = async () => {}
    await x.servers.redeem(code)
    await pump(clock, () => membershipAt(a, room, x.node.ik) === 'invite', 'invited')
    const add = a.servers.sumOf(room).members[x.node.ik].adds![0]
    const c = (await stored(a, add))!.wire.c as { code?: string }
    expect(Object.values(a.servers.sumOf(room).codes)).toHaveLength(1)
    expect(Object.keys(a.servers.sumOf(room).codes)).toContain(c.code!)
    clock.t += SERVER.redeemTtl + 1
    await pump(clock, () => membershipAt(a, room, x.node.ik) === null, 'withdrawn')
  }, 60_000)

  test('ten people joining through one code within an hour all get in while its issuer is online', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const a = await makeMember(hub, 'Alice', clock)
    const room = await a.servers.create('Class')
    const code = await a.servers.issueCode(room, DAY)
    for (let i = 0; i < 10; i += 1) {
      const x = await makeMember(hub, `Student${i}`, clock)
      expect(await failure(x.servers.redeem(code))).toBe('ok')
      await pump(clock, () => x.servers.myMembership(room) === 'join', `student ${i} joined`, 1_000)
      await pump(
        clock,
        () =>
          a.servers.view(room)?.members.some(m => m.ik === x.node.ik && m.m === 'join') === true,
        `alice sees student ${i}`,
        1_000
      )
    }
    expect(a.servers.view(room)?.joined).toBe(11)
  }, 120_000)

  test('a code busy at one member is taken by another it names', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const a = await makeMember(hub, 'Alice', clock)
    const b = await makeMember(hub, 'Bob', clock)
    const room = await a.servers.create('Two doors')
    await joinWithCode(clock, a, room, b)
    // Everyone may invite: the code names Alice, then Bob.
    const code = await a.servers.issueCode(room, DAY)
    expect(parseCode(code)?.peers.length).toBe(2)
    // Alice has no slot left for the code right now; Bob, the code's next member, has.
    const use = (
      a.servers as unknown as { codeUseOf(r: string, c: string): { adds: number[] } }
    ).codeUseOf(room, parseCode(code)!.code!)
    use.adds.push(...Array.from({ length: SERVER.codeAddsPerHour }, () => clock.now()))
    const x = await makeMember(hub, 'Xena', clock)
    expect(await failure(x.servers.redeem(code))).toBe('ok')
    await pump(clock, () => x.servers.myMembership(room) === 'join', 'xena joined', 1_000)
    // Bob let her in.
    expect(a.servers.sumOf(room).members[x.node.ik]?.via).toBe(b.node.ik)
  }, 60_000)

  test('one code makes us post a few invites an hour; after several lapse unused it stops working here for a while', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const a = await makeMember(hub, 'Alice', clock)
    const room = await a.servers.create('Leaked')
    const code = await a.servers.issueCode(room, 30 * DAY)
    const adds = () => Object.values(a.servers.sumOf(room).members).filter(m => m.m === 'invite')
    // Fresh identities that take the code and never join.
    const fresh = async (i: number) => {
      const x = await makeMember(hub, `Fresh${i}`, clock)
      ;(x.servers as unknown as { postJoin: () => Promise<void> }).postJoin = async () => {}
      return failure(x.servers.redeem(code))
    }
    for (let i = 0; i < SERVER.codeAddsPerHour; i += 1) expect(await fresh(i)).toBe('ok')
    expect(adds().length).toBe(SERVER.codeAddsPerHour)
    expect(await fresh(10)).toBe(REDEEM_TEXT.busy)
    expect(adds().length).toBe(SERVER.codeAddsPerHour)
    // Their invites lapse: withdrawn, and the code is paused here.
    clock.t += SERVER.redeemTtl + 1
    await pump(clock, () => adds().length === 0, 'withdrawn')
    expect((await a.servers.codes(room))[0].paused).toBe(true)
    clock.t += 60 * 60_000
    expect(await fresh(11)).toBe(REDEEM_TEXT.busy)
    // A real joiner after the pause gets in.
    clock.t += SERVER.codePauseMs
    const b = await makeMember(hub, 'Bob', clock)
    await b.servers.redeem(code)
    await pump(clock, () => b.servers.myMembership(room) === 'join', 'bob joined')
    expect((await a.servers.codes(room))[0].paused).toBeUndefined()
  }, 90_000)

  test('an invite handed over before the server’s first event is here waits for it', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const a = await makeMember(hub, 'Alice', clock)
    const x = await makeMember(hub, 'Xavier', clock)
    const room = await a.servers.create('Early')
    const add = await emit(a)(room, 'add', () => ({ to: x.node.ik }))
    const wire = (await stored(a, add))!.wire as unknown as WireV2
    const now = clock.now()
    const xs = x.servers as unknown as {
      putRoom(r: RoomRecord): Promise<void>
      takeInvite(room: string): Promise<void>
    }
    await xs.putRoom({
      ...blankRoom(room, '', now),
      kind: 'server',
      name: 'Early',
      chans: {},
      server: null,
      joining: { at: now, via: 'code', ev: wire },
      since: now,
    })
    await xs.takeInvite(room)
    expect((await x.store.room(room))?.joining?.ev).not.toBeUndefined()
    // What it sits on arrives (here by hand): the next try takes it.
    const acl = (await a.store.db.getAll('events'))
      .filter(r => r.room === room && r.layer === 'a' && r.id !== add)
      .sort((p, q) => (p.aseq ?? 0) - (q.aseq ?? 0))
    for (const r of acl) expect(await deliver(x, room, r.wire, now)).toBe('new')
    await xs.takeInvite(room)
    expect(x.servers.myMembership(room)).toBe('invite')
    expect((await x.store.room(room))?.joining?.ev).toBeUndefined()
  }, 60_000)

  test('codes and invites naming a DM’s room id never touch the DM', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const a = await makeMember(hub, 'Alice', clock)
    const d = await makeMember(hub, 'Dave', clock)
    await a.node.addContact(await d.node.myCard())
    await pump(clock, () => d.node.contact(a.node.ik)?.state === 'incoming', 'request')
    await d.node.accept(a.node.ik)
    await pump(clock, () => a.node.contact(d.node.ik)?.state === 'mutual', 'mutual')
    const dm = await d.dms.send((await d.dms.open(a.node.ik)).id, { body: 'hi' })
    const rec = await d.store.db.getAll('rooms')
    const dmRoom = rec.find(r => r.kind === 'dm')!
    const { encodeCode } = await import('../p2p/server')
    const fake = encodeCode({
      v: 1,
      room: dmRoom.id,
      name: 'x',
      secret: 'A'.repeat(22),
      peers: [a.node.peerId],
    })
    await d.servers.redeem(fake).catch(() => {})
    expect((await d.store.room(dmRoom.id))?.kind).toBe('dm')
    expect((await d.store.room(dmRoom.id))?.peer).toBe(a.node.ik)
    // A DM room that holds nothing yet (no record): refused too.
    const { dmRoomId } = await import('../p2p/dm')
    const e = await makeMember(hub, 'Eve', clock)
    await a.node.addContact(await e.node.myCard())
    await pump(clock, () => e.node.contact(a.node.ik)?.state === 'incoming', 'request e')
    await e.node.accept(a.node.ik)
    await pump(clock, () => a.node.contact(e.node.ik)?.state === 'mutual', 'mutual e')
    const empty = dmRoomId(e.node.ik, a.node.ik)
    const fake2 = encodeCode({
      v: 1,
      room: empty,
      name: 'x',
      secret: 'A'.repeat(22),
      peers: [a.node.peerId],
    })
    expect(
      await e.servers.redeem(fake2).then(
        () => 'ok',
        (err: Error) => err.message
      )
    ).not.toBe('ok')
    expect(await e.store.room(empty)).toBeUndefined()
    // An invite naming it: ignored.
    const onInvite = (
      e.servers as unknown as { onInvite: (m: unknown, s: unknown) => Promise<void> }
    ).onInvite.bind(e.servers)
    const s = e.node.readySessions(a.node.ik)[0]
    const ev = buildEvent2(
      a.node.author()!,
      empty,
      'add',
      'a',
      { to: e.node.ik },
      { seq: 1, ap: ['A'.repeat(43)] },
      clock.now()
    )
    await onInvite({ t: 'ginvite', room: empty, name: 'x', ev: ev.wire }, s)
    expect(await e.store.room(empty)).toBeUndefined()
    expect(e.servers.invites()).toEqual([])
    expect(!!dm).toBe(true)
  }, 60_000)
})

describe('names', () => {
  test('a member’s own name for forwards skips our petname for them', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const a = await makeMember(hub, 'Alice', clock)
    const b = await makeMember(hub, 'Bob', clock)
    await a.node.addContact(await b.node.myCard())
    await pump(clock, () => b.node.contact(a.node.ik)?.state === 'incoming', 'request')
    await b.node.accept(a.node.ik)
    await pump(clock, () => a.node.contact(b.node.ik)?.state === 'mutual', 'mutual')
    await a.node.rename(b.node.ik, 'Bobby')
    const room = await a.servers.create('Names')
    await joinWithCode(clock, a, room, b)
    expect(a.servers.nameOf(b.node.ik, room)).toBe('Bobby')
    expect(a.servers.profileName(b.node.ik, room)).toBe('Bob')
    expect(a.servers.profileName(b.node.ik)).toBe('Bob')
    expect(a.servers.profileName(a.node.ik, room)).toBe('Alice')
  }, 60_000)
})

describe('view answers', () => {
  test('one asked for a state that changed meanwhile is not kept', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const a = await makeMember(hub, 'Alice', clock)
    const b = await makeMember(hub, 'Bob', clock)
    const room = await a.servers.create('Views')
    const ch = general(a, room)
    await joinWithCode(clock, a, room, b)
    const s = a.servers as unknown as {
      host: AclHost
      fillViews(room: string, ch: string): Promise<void>
      ensureRt(room: string): { views: Map<string, boolean>; sum: object }
    }
    const rt = s.ensureRt(room)
    rt.views.clear()
    const real = s.host.viewable.bind(s.host)
    let release = () => {}
    const gate = new Promise<void>(r => (release = r))
    s.host.viewable = async (...args) => {
      const out = await real(...args)
      await gate
      return out
    }
    const asked = s.fillViews(room, ch)
    // The state moves on while the answer is on its way.
    rt.sum = { ...rt.sum }
    release()
    await asked
    expect(rt.views.has(`${b.node.ik}\n${ch}`)).toBe(false)
    s.host.viewable = real
    await s.fillViews(room, ch)
    expect(rt.views.get(`${b.node.ik}\n${ch}`)).toBe(true)
  }, 60_000)
})

describe('removals sent to us directly', () => {
  test('are taken once per room per session, and not once we are out', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const a = await makeMember(hub, 'Alice', clock)
    const b = await makeMember(hub, 'Bob', clock)
    const room = await a.servers.create('Direct')
    await joinWithCode(clock, a, room, b)
    await a.node.setPaused(true)
    const kick = await signed(a, room, 'kick', {
      to: b.node.ik,
      seen: (await planOf(a, room, 'kick', 'a', b.node.ik)).seen ?? {},
    })
    const bs = b.servers as unknown as { onMember(m: Message, s: Session): Promise<void> }
    let checks = 0
    const check = b.servers.check.bind(b.servers)
    b.servers.check = (r, raw) => {
      checks += 1
      return check(r, raw)
    }
    let strikes = 0
    const session = (): Session => ({ strike: () => (strikes += 1) }) as unknown as Session
    const s1 = session()
    await bs.onMember({ t: 'gmember', room, ev: kick.wire }, s1)
    expect(b.servers.myMembership(room)).toBe('leave')
    await bs.onMember({ t: 'gmember', room, ev: kick.wire }, s1)
    await bs.onMember({ t: 'gmember', room, ev: kick.wire }, session())
    expect(checks).toBe(1)
    expect(strikes).toBe(0)
  }, 60_000)
})

describe('gossip abuse', () => {
  // e6f0fa9: every gtyping frame was relayed to every other link.
  test('a typing flood is relayed at most once per few seconds', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const a = await makeMember(hub, 'Alice', clock)
    const b = await makeMember(hub, 'Bob', clock)
    const c = await makeMember(hub, 'Carol', clock)
    const room = await a.servers.create('Typing')
    const ch = general(a, room)
    await joinWithCode(clock, a, room, b)
    await joinWithCode(clock, a, room, c)
    await pump(
      clock,
      () =>
        a.servers.sync.linksOf(room).some(l => l.ik === b.node.ik) &&
        a.servers.sync.linksOf(room).some(l => l.ik === c.node.ik),
      'a links both'
    )
    let relayed = 0
    for (const s of c.node.readySessions(a.node.ik))
      s.on('gtyping', (m: Message) => {
        if (m.ik === b.node.ik) relayed += 1
      })
    const toA = b.node.readySessions(a.node.ik)[0]
    for (let i = 0; i < 100; i += 1) {
      void toA.send({ t: 'gtyping', room, ch, on: i % 2 === 0 })
      if (i % 10 === 0) await clock.advance(100)
    }
    await clock.advance(1_000)
    expect(relayed).toBeLessThanOrEqual(6)
    expect(toA.state).toBe('ready')
  }, 60_000)

  // e6f0fa9: invited members got presence and typing over their state link.
  test('someone invited who never joins gets no presence or typing', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const a = await makeMember(hub, 'Alice', clock)
    const d = await makeMember(hub, 'Dave', clock)
    await a.node.addContact(await d.node.myCard())
    await pump(clock, () => d.node.contact(a.node.ik)?.state === 'incoming', 'request')
    await d.node.accept(a.node.ik)
    await pump(clock, () => a.node.contact(d.node.ik)?.state === 'mutual', 'mutual')
    const room = await a.servers.create('Invited')
    const ch = general(a, room)
    // Dave's client never joins.
    ;(d.servers as unknown as { postJoin: () => Promise<void> }).postJoin = async () => {}
    await a.servers.invite(room, d.node.ik)
    await pump(clock, () => d.servers.invites().length === 1, 'd sees the invite')
    await d.servers.acceptInvite(room)
    await pump(clock, () => d.servers.myMembership(room) === 'invite', 'd invited')
    const seen: string[] = []
    for (const s of d.node.readySessions(a.node.ik)) {
      s.on('gpresence', () => void seen.push('presence'))
      s.on('gtyping', () => void seen.push('typing'))
    }
    a.servers.typing(room, ch, true)
    for (let i = 0; i < 6; i += 1) await clock.advance(10_000)
    expect(a.servers.sync.linksOf(room).some(l => l.ik === d.node.ik)).toBe(true)
    expect(seen).toEqual([])
  }, 60_000)

  // e6f0fa9: the list named every member we had any session with (DM contacts included).
  test('a presence report names only members linked in that room', () => {
    const clock = new ManualClock()
    const room = 'R'.repeat(43)
    const sent: Message[] = []
    const linked = {
      remote: { ik: 'linked' },
      send: (m: Message) => (sent.push(m), Promise.resolve()),
    }
    const dm = { remote: { ik: 'contact' }, send: () => Promise.resolve() }
    const link = { session: linked, ik: 'linked', room } as unknown as Link
    const g = new Gossip({
      clock,
      random: () => 0.5,
      me: () => 'me',
      rooms: () => [room],
      members: () => ['linked', 'contact'],
      may: () => 'full',
      shared: () => 1,
      moderator: () => false,
      sessions: ik =>
        ik === 'linked' ? [linked as unknown as Session] : [dm as unknown as Session],
      certs: () => null,
      link: () => null,
      unlink: () => {},
      links: () => [link],
      linksOn: () => [link],
      onPresence: () => {},
      onTyping: () => {},
    })
    ;(g as unknown as { sendPresence: () => void }).sendPresence()
    expect(sent.map(m => m.on)).toEqual([['linked']])
    // Shown here, though: we do have a session with the contact.
    expect([...g.online(room)].sort()).toEqual(['contact', 'linked', 'me'])
  })
})
