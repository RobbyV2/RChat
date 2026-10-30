import { afterEach, describe, expect, test } from 'bun:test'
import { authRefs } from '../p2p/auth'
import { buildEvent, type Content, type EvType, type Wire } from '../p2p/event'
import { Gossip } from '../p2p/gossip'
import type { Message } from '../p2p/frames'
import { SERVER, type Servers } from '../p2p/server'
import type { Session } from '../p2p/session'
import { CHAIN, isPowerChain, type StateMap } from '../p2p/state'
import type { Link } from '../p2p/sync'
import { Hub, ManualClock } from './p2p_net'
import {
  bodies,
  general,
  joinWithCode,
  makeMember,
  pump,
  restart,
  stopAll,
  stopMember,
  type Member,
} from './p2p_server_net'

// Abuse and authorization fixes of the Task 22 review, on real members over the in-memory hub.
// Each test failed on e6f0fa9 (noted per test).

afterEach(stopAll)

type Emit = (
  room: string,
  type: EvType,
  content: Content,
  opts?: { skey?: string; code?: string }
) => Promise<string>

const emit = (m: Member): Emit => (m.servers as unknown as { emit: Emit }).emit.bind(m.servers)

type Chain = Awaited<ReturnType<Member['servers']['nextChain']>>

// An event `m` signs on top of `heads`, citing what `state` holds (a stale view), on `m`'s chain
// as its device has it (or on `chain`: an equivocation, or a run of forged events).
const forge = async (
  m: Member,
  room: string,
  state: StateMap,
  heads: { id: string; depth: number }[],
  type: EvType,
  content: Record<string, unknown>,
  ts: number,
  opts: { chain?: Chain; skey?: string; pstate?: string[] } = {}
) => {
  const chain = opts.chain ?? (await m.servers.nextChain(room, ts))
  const state_ = opts.skey !== undefined
  const pprev =
    state_ && isPowerChain({ type, sender: m.node.ik, skey: opts.skey as string, content })
      ? m.servers.resolved(room).power.get(m.node.ik)
      : undefined
  return buildEvent(
    m.node.author()!,
    room,
    type,
    content as unknown as Content,
    heads.map(h => h.id),
    Math.max(...heads.map(h => h.depth)) + 1,
    chain.ts,
    {
      auth: authRefs(state, { type, sender: m.node.ik, skey: opts.skey, content }),
      dseq: chain.dseq,
      dwin: chain.dwin,
      ...(chain.dprev ? { dprev: chain.dprev } : {}),
      ...(state_
        ? {
            skey: opts.skey,
            pstate: opts.pstate ?? m.servers.resolved(room).heads,
            ...(chain.sprev ? { sprev: chain.sprev } : {}),
            ...(pprev ? { pprev } : {}),
          }
        : {}),
    }
  )
}

// The chain after `ev` (for a run of forged events).
const after = (ev: { id: string; wire: Wire }, sprev?: string): Chain => {
  const e = ev.wire.ev
  return {
    dseq: (e.dseq ?? 0) + 1,
    dprev: ev.id,
    dwin: (e.dwin ?? 0) + 1,
    ts: e.ts,
    ...(e.skey !== undefined ? { sprev: ev.id } : sprev ? { sprev } : {}),
  }
}

const deliver = async (to: Member, room: string, ev: { id: string; wire: Wire }, now: number) => {
  const v = await to.servers.check(room, ev.wire)
  if (!v.ok) return v.later ? 'later' : 'refused'
  return (await to.servers.insert(room, v.id, v.wire, now)).status
}

const stored = (m: Member, id: string) => m.store.db.get('events', id)

const membershipAt = (m: Member, room: string, ik: string) =>
  (m.servers as Servers).view(room)?.members.find(x => x.ik === ik)?.m ?? null

describe('authorization against the current state', () => {
  // e6f0fa9: the redaction stripped Bob's message and the pin counted.
  test('an ex-owner’s redaction and pin built on an old state don’t take effect', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const a = await makeMember(hub, 'Alice', clock)
    const b = await makeMember(hub, 'Bob', clock)
    const room = await a.servers.create('Handover')
    const ch = general(a, room)
    await joinWithCode(clock, a, room, b)
    await b.servers.send(room, { ch, body: 'mine' })
    await pump(clock, async () => (await bodies(a, room, ch)).includes('mine'), 'a has it')
    const msg = (await a.servers.loadChannel(room, ch)).messages.find(x => x.body === 'mine')!
    const old = a.servers.resolved(room).state
    const heads = (await a.store.room(room))!.heads
    // Alice hands the server to Bob; Bob has the transfer.
    await emit(a)(room, 'owner', { ik: b.node.ik } as unknown as Content, { skey: '' })
    await pump(clock, () => b.servers.view(room)?.owner === b.node.ik, 'b owns it')
    // Then Alice, citing the old state, redacts and pins Bob's message.
    const redact = await forge(a, room, old, heads, 'redact', { target: msg.id }, clock.now())
    const pin = await forge(a, room, old, heads, 'pin', { target: msg.id, on: true }, clock.now(), {
      chain: after(redact),
    })
    expect(await deliver(b, room, redact, clock.now())).toBe('new')
    expect(await deliver(b, room, pin, clock.now())).toBe('new')
    expect((await stored(b, msg.id))?.redacted).toBe(false)
    expect(await bodies(b, room, ch)).toContain('mine')
    expect(await b.servers.loadPins(room, ch)).toEqual([])
  }, 60_000)
})

describe('redactions under the current state', () => {
  // e76d0e2: a moderator's redaction refused when it arrived never took effect (M1).
  test('a moderator’s redaction that arrived while they had no power hides the message once they do', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const a = await makeMember(hub, 'Alice', clock)
    const m = await makeMember(hub, 'Mod', clock)
    const b = await makeMember(hub, 'Bob', clock)
    const c = await makeMember(hub, 'Carol', clock)
    const room = await a.servers.create('Again')
    const ch = general(a, room)
    for (const x of [m, b, c]) await joinWithCode(clock, a, room, x)
    await emit(a)(
      room,
      'role',
      { name: 'Cleaner', color: null, perms: 2, pos: 1 } as unknown as Content,
      { skey: 'CLEANCLEANA' }
    )
    await emit(a)(room, 'roles', { ids: ['CLEANCLEANA'] } as unknown as Content, {
      skey: m.node.ik,
    })
    await b.servers.send(room, { ch, body: 'spam' })
    await pump(clock, async () => (await bodies(m, room, ch)).includes('spam'), 'm has it')
    await pump(clock, async () => (await bodies(c, room, ch)).includes('spam'), 'c has it')
    await pump(clock, () => m.servers.view(room)?.perms === (2 | 64), 'm may clean')
    for (const x of [a, m, b, c]) await x.node.setPaused(true)
    const msg = (await m.servers.loadChannel(room, ch)).messages.find(x => x.body === 'spam')!
    await m.servers.redact(room, msg.id)
    const redaction = (await m.store.db.getAll('events')).find(r => r.type === 'redact')!
    // Carol hears of a demotion first, then the redaction (stored, not applied), then the
    // promotion again.
    await emit(a)(room, 'roles', { ids: [] } as unknown as Content, { skey: m.node.ik })
    const demote = (await a.store.db.getAll('events')).find(
      r => r.type === 'roles' && (r.wire.c as { ids: string[] }).ids.length === 0
    )!
    expect(await deliver(c, room, { id: demote.id, wire: demote.wire }, clock.now())).toBe('new')
    expect(await deliver(c, room, { id: redaction.id, wire: redaction.wire }, clock.now())).toBe(
      'new'
    )
    expect(await bodies(c, room, ch)).toContain('spam')
    await emit(a)(room, 'roles', { ids: ['CLEANCLEANA'] } as unknown as Content, {
      skey: m.node.ik,
    })
    const again = (await a.store.db.getAll('events'))
      .filter(r => r.type === 'roles' && r.skey === m.node.ik)
      .sort((x, y) => y.seq - x.seq)[0]
    expect(await deliver(c, room, { id: again.id, wire: again.wire }, clock.now())).toBe('new')
    expect(c.servers.view(room)?.members.length).toBe(4)
    expect(await bodies(c, room, ch)).not.toContain('spam')
  }, 60_000)
})

describe('storage', () => {
  // e76d0e2 kept the purged events' count: the room stayed full (S-I2).
  test('a full room still takes the owner’s ban; the banned member’s hidden events are purged at once, giving room back', async () => {
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
    // Bob fills the room at Alice's, written after a ban he won't hear of (forged on the view
    // before it), so all of it is hidden there.
    const s = b.servers.resolved(room).state
    const heads = (await b.store.room(room))!.heads
    await a.servers.ban(room, b.node.ik)
    expect(a.servers.view(room)?.members.find(m => m.ik === b.node.ik)?.m).toBe('ban')
    let chain: Chain | undefined
    let stored = 0
    for (let i = 0; i < 60; i += 1) {
      const ev = await forge(b, room, s, heads, 'msg', { body: `spam ${i}`, ch }, clock.now(), {
        chain,
      })
      chain = after(ev)
      if ((await deliver(a, room, ev, clock.now())) === 'new') stored += 1
    }
    const rec = (await a.store.room(room))!
    // Out of space, the hidden ones were purged at once (bytes and count back), so the room
    // keeps taking what is shown.
    expect(stored).toBeGreaterThan(40)
    expect(rec.count).toBeLessThanOrEqual(40)
    expect(Object.values(rec.bans ?? {})[0]?.purged).toBe(true)
    await c.node.setPaused(false)
    await c.servers.send(room, { ch, body: 'still room' })
    await pump(clock, async () => (await bodies(a, room, ch)).includes('still room'), 'a has c')
    const purged = (await a.store.db.getAll('events')).filter(r => r.purged)
    expect(purged.length).toBeGreaterThan(0)
    expect(purged.every(r => r.sender === b.node.ik && r.wire.c === null && r.soft)).toBe(true)
  }, 60_000)

  // e76d0e2: a lifetime count divided by members (S-I1).
  test('each member’s share is a daily window along their chain: past it refused, the next day fine', async () => {
    const was = CHAIN.perDay
    CHAIN.perDay = 30
    try {
      const clock = new ManualClock()
      const hub = new Hub()
      const a = await makeMember(hub, 'Alice', clock)
      const b = await makeMember(hub, 'Bob', clock)
      const c = await makeMember(hub, 'Carol', clock)
      const room = await a.servers.create('Share')
      const ch = general(a, room)
      await joinWithCode(clock, a, room, b)
      await joinWithCode(clock, a, room, c)
      const s = b.servers.resolved(room).state
      let heads = (await b.store.room(room))!.heads
      let chain: Chain | undefined
      let last: Chain | undefined
      const got: string[] = []
      for (let i = 0; i < 40; i += 1) {
        const ev = await forge(b, room, s, heads, 'msg', { body: `b ${i}`, ch }, clock.now(), {
          chain,
        })
        chain = after(ev)
        heads = [{ id: ev.id, depth: ev.wire.ev.depth }]
        const r = await deliver(a, room, ev, clock.now())
        if (r === 'new') last = chain
        got.push(r)
      }
      expect(got.filter(x => x === 'new').length).toBeLessThanOrEqual(CHAIN.perDay)
      expect(got.filter(x => x === 'later').length).toBeGreaterThan(0)
      // Claiming a fresh window on the same day doesn't work: the claim is checked against the
      // previous event.
      const liar = await forge(b, room, s, heads, 'msg', { body: 'liar', ch }, clock.now(), {
        chain: { ...(last as Chain), dwin: 0 },
      })
      expect(await deliver(a, room, liar, clock.now())).toBe('later')
      expect((await stored(a, liar.id)) === undefined).toBe(true)
      // Carol still gets in.
      await c.servers.send(room, { ch, body: 'carol here' })
      await pump(clock, async () => (await bodies(a, room, ch)).includes('carol here'), 'a has c')
      // The next day Bob has a window again.
      clock.t += CHAIN.day
      await clock.advance(10_000)
      await b.servers.send(room, { ch, body: 'next day' })
      await pump(clock, async () => (await bodies(a, room, ch)).includes('next day'), 'a has it')
    } finally {
      CHAIN.perDay = was
    }
  }, 60_000)

  // e76d0e2: local per-device caps; every forked leave of a banned member stored (S-C1,
  // autoscan 4).
  test('state floods stop at the hourly window, leaving is exempt only once, moderation still fits', async () => {
    const was = CHAIN.statePerHour
    CHAIN.statePerHour = 6
    try {
      const clock = new ManualClock()
      const hub = new Hub()
      const a = await makeMember(hub, 'Alice', clock)
      const b = await makeMember(hub, 'Bob', clock)
      const room = await a.servers.create('Flood')
      await joinWithCode(clock, a, room, b)
      // Bob's own client stops at the window.
      let issued = 0
      for (let i = 0; i < 12; i += 1)
        try {
          await b.servers.issueCode(room, 60 * 60_000)
          issued += 1
        } catch {
          break
        }
      expect(issued).toBeLessThanOrEqual(CHAIN.statePerHour)
      for (let i = 0; i < 6; i += 1) await clock.advance(5_000)
      await a.servers.ban(room, b.node.ik)
      expect(a.servers.view(room)?.members.find(m => m.ik === b.node.ik)?.m).toBe('ban')
      // Bob, banned, forges leaves (each a fork of his state from before the ban): the first
      // leave since he joined is exempt, the rest count against the window.
      const s = b.servers.resolved(room).state
      const heads = (await b.store.room(room))!.heads
      const pstate = b.servers.resolved(room).heads
      let chain: Chain | undefined
      let stored = 0
      for (let i = 0; i < 30; i += 1) {
        const ev = await forge(
          b,
          room,
          s,
          heads,
          'member',
          { m: 'leave', pad: 'x'.repeat(2000) },
          clock.now(),
          {
            chain,
            skey: b.node.ik,
            pstate,
          }
        )
        chain = after(ev)
        if ((await deliver(a, room, ev, clock.now())) === 'new') stored += 1
      }
      expect(stored).toBeLessThanOrEqual(1)
      expect(a.servers.view(room)?.members.find(m => m.ik === b.node.ik)?.m).toBe('ban')
      // The owner's own state events are never refused for the window here.
      for (let i = 0; i < 3; i += 1) await a.servers.setName(room, `n${i}`)
      expect(a.servers.view(room)?.name).toBe('n2')
    } finally {
      CHAIN.statePerHour = was
    }
  }, 60_000)

  // e76d0e2 kept per-device counters (room count, hourly times): two devices took different
  // events from one flood and disagreed for good (I5).
  test('two devices given one flood in different orders store the same events', async () => {
    const was = CHAIN.statePerHour
    CHAIN.statePerHour = 5
    try {
      const clock = new ManualClock()
      const hub = new Hub()
      const a = await makeMember(hub, 'Alice', clock)
      const b = await makeMember(hub, 'Bob', clock)
      const c = await makeMember(hub, 'Carol', clock)
      const room = await a.servers.create('Same')
      await joinWithCode(clock, a, room, b)
      await joinWithCode(clock, a, room, c)
      await pump(clock, () => c.servers.view(room)?.joined === 3, 'c sees all')
      await b.node.setPaused(true)
      await c.node.setPaused(true)
      const s = b.servers.resolved(room).state
      const heads = (await b.store.room(room))!.heads
      let chain: Chain | undefined
      let pstate = b.servers.resolved(room).heads
      const flood: { id: string; wire: Wire }[] = []
      for (let i = 0; i < 12; i += 1) {
        const ev = await forge(
          b,
          room,
          s,
          heads,
          'member',
          { m: 'join', profile: { ...b.node.profile, updated: b.node.profile.updated } },
          clock.now() + i * 60_000,
          { chain, skey: b.node.ik, pstate }
        )
        chain = after(ev)
        pstate = [ev.id]
        flood.push(ev)
      }
      const take = async (m: Member, order: { id: string; wire: Wire }[]) => {
        const out = new Set<string>()
        // Retried until nothing more goes in (an event waiting for its chain link).
        for (let round = 0; round < 3; round += 1)
          for (const ev of order)
            if ((await deliver(m, room, ev, clock.now() + 12 * 60_000)) === 'new') out.add(ev.id)
        return out
      }
      const atA = await take(a, flood)
      const atC = await take(c, [...flood].reverse())
      expect([...atA].sort()).toEqual([...atC].sort())
      expect(atA.size).toBeLessThanOrEqual(CHAIN.statePerHour)
    } finally {
      CHAIN.statePerHour = was
    }
  }, 60_000)

  // e76d0e2: purged on the first view with the ban, for good (S-I3).
  test('a ban overturned before the purge takes nothing with it', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const a = await makeMember(hub, 'Alice', clock)
    const m = await makeMember(hub, 'Mod', clock)
    const b = await makeMember(hub, 'Bob', clock)
    const c = await makeMember(hub, 'Carol', clock)
    const room = await a.servers.create('Overturn')
    const ch = general(a, room)
    for (const x of [m, b, c]) await joinWithCode(clock, a, room, x)
    const roleId = 'MODMODMODMM'
    await emit(a)(
      room,
      'role',
      { name: 'Mod', color: null, perms: 32 | 4, pos: 1 } as unknown as Content,
      { skey: roleId }
    )
    await emit(a)(room, 'roles', { ids: [roleId] } as unknown as Content, { skey: m.node.ik })
    await pump(clock, () => m.servers.view(room)?.perms === (32 | 4 | 64), 'm is a mod')
    await pump(clock, () => c.servers.view(room)?.joined === 4, 'c sees all')
    // Everyone stops listening; then, on one snapshot: Bob's message, Mod's ban of Bob, and the
    // owner's demotion of Mod.
    for (const x of [a, m, b, c]) await x.node.setPaused(true)
    const x = await forge(
      b,
      room,
      b.servers.resolved(room).state,
      (await b.store.room(room))!.heads,
      'msg',
      { body: 'X', ch },
      clock.now()
    )
    await m.servers.ban(room, b.node.ik)
    const ban = (await m.store.db.getAll('events')).find(
      r => r.type === 'member' && r.skey === b.node.ik && (r.wire.c as { m?: string })?.m === 'ban'
    )!
    await a.servers.setName(room, 'pre')
    await emit(a)(room, 'roles', { ids: [] } as unknown as Content, { skey: m.node.ik })
    const demote = (await a.store.db.getAll('events')).find(
      r =>
        r.type === 'roles' &&
        r.skey === m.node.ik &&
        (r.wire.c as { ids: string[] }).ids.length === 0
    )!
    // Carol gets the message, then the ban: hidden; then the demotion: the ban is overturned and
    // the message shows again.
    const toC = async (id: string, wire: Wire) =>
      expect(await deliver(c, room, { id, wire }, clock.now())).toBe('new')
    // What the ban and the demotion build on.
    for (const r of await m.store.db.getAll('events'))
      if (r.room === room && !(await c.store.db.get('events', r.id)))
        await deliver(c, room, { id: r.id, wire: r.wire }, clock.now())
    for (const r of await a.store.db.getAll('events'))
      if (r.room === room && r.id !== demote.id && !(await c.store.db.get('events', r.id)))
        await deliver(c, room, { id: r.id, wire: r.wire }, clock.now())
    expect(await c.store.db.get('events', ban.id)).not.toBeUndefined()
    await toC(x.id, x.wire)
    expect(c.servers.view(room)?.members.find(y => y.ik === b.node.ik)?.m).toBe('ban')
    expect(await bodies(c, room, ch)).not.toContain('X')
    expect((await c.store.db.get('events', x.id))?.soft).toBe(ban.id)
    // Long enough for a purge if the ban stood; it doesn't, so nothing goes.
    await toC(demote.id, demote.wire)
    expect(c.servers.view(room)?.members.find(y => y.ik === b.node.ik)?.m).toBe('join')
    expect(await bodies(c, room, ch)).toContain('X')
    clock.t += 8 * 24 * 60 * 60_000
    await clock.advance(30_000)
    expect((await c.store.db.get('events', x.id))?.purged).toBeUndefined()
    expect(await bodies(c, room, ch)).toContain('X')
  }, 90_000)

  test('a ban that stands is purged after a week, not before', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const a = await makeMember(hub, 'Alice', clock)
    const b = await makeMember(hub, 'Bob', clock)
    const room = await a.servers.create('Week')
    const ch = general(a, room)
    await joinWithCode(clock, a, room, b)
    const s = b.servers.resolved(room).state
    const heads = (await b.store.room(room))!.heads
    await a.servers.ban(room, b.node.ik)
    const late = await forge(b, room, s, heads, 'msg', { body: 'late', ch }, clock.now())
    expect(await deliver(a, room, late, clock.now())).toBe('new')
    const count = (await a.store.room(room))!.count
    expect(!!(await stored(a, late.id))?.soft).toBe(true)
    clock.t += 6 * 24 * 60 * 60_000
    await clock.advance(30_000)
    expect((await stored(a, late.id))?.purged).toBeUndefined()
    clock.t += 2 * 24 * 60 * 60_000
    await pump(clock, async () => (await stored(a, late.id))?.purged === true, 'purged')
    expect((await stored(a, late.id))?.wire.c).toBe(null)
    expect((await a.store.room(room))!.count).toBe(count - 1)
  }, 60_000)

  // e76d0e2: a stale cache (same count) was reused after an upgrade.
  test('a resolution cache made under other rules is replayed', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const a = await makeMember(hub, 'Alice', clock)
    const room = await a.servers.create('Rules')
    const rec = (await a.store.room(room))!
    await a.store.db.put('rooms', {
      ...rec,
      server: { ...rec.server!, rules: 1, entries: [] },
    })
    stopMember(a)
    const again = await restart(hub, a, clock)
    expect(again.servers.view(room)?.name).toBe('Rules')
    expect(again.servers.myMembership(room)).toBe('join')
  }, 60_000)
})

describe('invite codes', () => {
  // e76d0e2: the invite carried nothing of the code (autoscan 7).
  test('a redeem leaves an invite that names the code and lapses; a join after that is refused', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const a = await makeMember(hub, 'Alice', clock)
    const x = await makeMember(hub, 'Xavier', clock)
    const room = await a.servers.create('Quiet')
    const code = await a.servers.issueCode(room, 60 * 60_000)
    // Xavier's client takes the code but doesn't join (yet).
    ;(x.servers as unknown as { postJoin: () => Promise<void> }).postJoin = async () => {}
    await x.servers.redeem(code)
    for (let i = 0; i < 4; i += 1) await clock.advance(5_000)
    const inv = a.servers.resolved(room).state.get(`member\n${x.node.ik}`)!
    expect(inv.content.m).toBe('invite')
    expect(typeof inv.content.code).toBe('string')
    expect(inv.content.exp).toBeLessThanOrEqual(clock.now() + SERVER.redeemTtl)
    await pump(clock, () => x.servers.myMembership(room) === 'invite', 'x has its invite')
    await clock.advance(SERVER.redeemTtl + 1)
    // Too late now: the join is stored but rejected where it sits.
    const join = await forge(
      x,
      room,
      x.servers.resolved(room).state,
      (await x.store.room(room))!.heads,
      'member',
      { m: 'join', cert: x.node.cert, profile: x.node.profile },
      clock.now(),
      { skey: x.node.ik }
    )
    expect(await deliver(a, room, join, clock.now())).toBe('refused')
    expect(membershipAt(a, room, x.node.ik)).toBe('invite')
  }, 60_000)

  // e76d0e2: a code naming a DM room id overwrote the DM record, and a failed redeem deleted it
  // (autoscan 5, 6).
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
    const ev = buildEvent(
      a.node.author()!,
      empty,
      'member',
      { m: 'invite' } as unknown as Content,
      ['A'.repeat(43)],
      1,
      clock.now(),
      { skey: e.node.ik, auth: [], pstate: ['A'.repeat(43)], dseq: 0, dwin: 0 }
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
