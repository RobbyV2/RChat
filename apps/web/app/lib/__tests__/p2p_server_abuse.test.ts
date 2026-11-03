import { afterEach, describe, expect, test } from 'bun:test'
import { P } from '../p2p/acl/rules'
import { IMPL } from '../p2p/acl_room'
import { chainKey, UNKNOWN, type DevChain } from '../p2p/dag'
import { buildEvent2, type Wire } from '../p2p/event'
import { genesisBundle } from '../p2p/acl/binding'
import { b64u, randomBytes } from '../p2p/canonical'
import { keyId } from '../p2p/keys'
import { Gossip } from '../p2p/gossip'
import type { Message } from '../p2p/frames'
import { LONE_TEXT } from '../p2p/flows'
import { LEGACY_TEXT, SERVER, UPDATE_TEXT } from '../p2p/server'
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
    // it, storage refuses it (a target elsewhere).
    const far = await signed(
      b,
      room,
      'react',
      { target: away, key: 'x', on: true, ch },
      { seq: held + 400 }
    )
    expect(await deliver(a, room, far.wire, clock.now())).toBe('invalid')
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

  test('a cold start reads the stored records; a cache of another implementation is ignored', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const a = await makeMember(hub, 'Alice', clock)
    const b = await makeMember(hub, 'Bob', clock)
    const room = await a.servers.create('Rules')
    await joinWithCode(clock, a, room, b)
    await a.servers.kick(room, b.node.ik)
    const acl = (await a.store.db.getAll('events')).filter(r => r.room === room && r.layer === 'a')
    expect(acl.every(r => typeof r.aseq === 'number' && r.acl)).toBe(true)
    const rec = (await a.store.room(room))!
    await a.store.db.put('rooms', {
      ...rec,
      server: { impl: 0, rules: 2, count: 0, sum: { nonsense: true } as never },
    })
    // Every record written by another implementation version: not read, admitted again.
    for (const r of acl) await a.store.db.put('events', { ...r, acl: { ...r.acl!, v: IMPL - 1 } })
    stopMember(a)
    const again = await restart(hub, a, clock)
    expect(again.servers.view(room)?.name).toBe('Rules')
    expect(again.servers.myMembership(room)).toBe('join')
    expect(membershipAt(again, room, b.node.ik)).toBeNull()
    expect((await again.store.room(room))?.server?.impl).toBe(IMPL)
    const after = (await again.store.db.getAll('events')).filter(
      r => r.room === room && r.layer === 'a'
    )
    expect(after.every(r => r.acl?.v === IMPL)).toBe(true)
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
