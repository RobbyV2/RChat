import { afterEach, describe, expect, test } from 'bun:test'
import { signDeviceCert2 } from '../p2p/acl/binding'
import { P } from '../p2p/acl/rules'
import type { AclRoom } from '../p2p/acl_room'
import { buildEvent2, signRevocation2, type ChainFields } from '../p2p/event_v2'
import { type Wire } from '../p2p/event_v1'
import { serverWire } from '../p2p/db'
import type { P2pMessage } from '../p2p/dm'
import { keyId, newKeyPair, type KeyPair } from '../p2p/keys'
import type { LocalHost } from '../p2p/resolve_host'
import { SERVER } from '../p2p/server'
import { SHARE } from '../p2p/shares'
import { oldestBodies } from '../p2p/dag'
import { hashBytes } from '../p2p/hashing'
import {
  bodies,
  deliver,
  general,
  Hub,
  joinWithCode,
  makeMember,
  ManualClock,
  planOf,
  pump,
  restart,
  signed,
  stopAll,
  stopMember,
  type Member,
} from './p2p_server_net'

// Storage of P2P servers on real members over the in-memory hub (spec 2.3 orphan drops, 4.1
// proofs, 4.2 shares and dropped headers, 4.3 stability, purges and restores, 3.7 serving).

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
// What a room's count must be: its stored events that aren't purged.
const countedOf = async (m: Member, room: string) =>
  (await m.store.db.getAll('events')).filter(r => r.room === room && !r.purged).length
const droppedRec = (m: Member, id: string) => m.store.db.get('dropped', id)
// What the content budget counts (ACL events are counted apart).
const contentOf = async (m: Member, room: string) => {
  const r = (await m.store.room(room))!
  return r.count - (r.acount ?? 0)
}
const evaluator = (m: Member, room: string) =>
  (m.servers as unknown as { host: LocalHost }).host.rooms.get(room) as AclRoom
const membershipAt = (m: Member, room: string, ik: string) =>
  m.servers.sumOf(room).members[ik]?.m ?? null

// Someone with no node of its own: its devices sign events that are delivered by hand.
interface Ext {
  ik: KeyPair
  dk: KeyPair
  a: string
  dev: string
}
const ext = (ik = newKeyPair()): Ext => {
  const dk = newKeyPair()
  return { ik, dk, a: keyId(ik.pk), dev: keyId(dk.pk) }
}
const sign = (
  x: Ext,
  room: string,
  t: string,
  L: 'a' | 'c',
  c: Record<string, unknown>,
  f: ChainFields,
  ts: number
) => {
  const out = buildEvent2(x, room, t, L, c, f, ts)
  return { id: out.id, wire: out.wire as unknown as Wire }
}
const heads = async (m: Member, room: string) => (await planOf(m, room, 'mark')).ap

// `x` joins `o`'s server through o's invite: its join, delivered to o.
const extJoin = async (o: Member, room: string, x: Ext, clock: ManualClock) => {
  await emit(o)(room, 'add', () => ({ to: x.a }))
  const j = sign(
    x,
    room,
    'join',
    'a',
    { idb: { ik: x.a, dcert: signDeviceCert2(x.ik, room, x.a, x.dev) } },
    { seq: 0, ap: await heads(o, room) },
    clock.now()
  )
  expect(await deliver(o, room, j.wire, clock.now())).toBe('new')
  return j.id
}

describe('orphan drops in storage (spec 2.3, controller ruling)', () => {
  test('a kicked member’s second device posts content at an old position, each citing 10 void relays: all of it is dropped, the two headers that keep the fork point stay as evidence, and a cold start keeps the state', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const o = await makeMember(hub, 'Olive', clock)
    const room = await o.servers.create('Probe')
    const ch = general(o, room)
    const y = ext()
    const y2 = ext(y.ik)
    const z = ext()
    const w = ext()
    const join = await extJoin(o, room, y, clock)
    const add = sign(
      y2,
      room,
      'device_add',
      'a',
      { dcert: signDeviceCert2(y.ik, room, y.a, y2.dev, join) },
      { seq: 0, ap: await heads(o, room), iprev: join },
      clock.now()
    )
    expect(await deliver(o, room, add.wire, clock.now())).toBe('new')
    await extJoin(o, room, z, clock)
    const wJoin = await extJoin(o, room, w, clock)
    // Y's first device relays Z's revocation record 60 times at one position: void siblings.
    const at = await heads(o, room)
    const rec = { ik: z.a, dk: z.dev, seen: 1000, rec: signRevocation2(z.ik, room, z.dev, 1000) }
    const relays: { id: string; wire: Wire }[] = []
    for (let k = 0; k < 60; k++) {
      const r = sign(
        y,
        room,
        'device_revoke',
        'a',
        rec,
        { seq: 1, ap: at, aprev: join },
        clock.now() + k
      )
      expect(await deliver(o, room, r.wire, clock.now())).toBe('new')
      relays.push(r)
    }
    await o.servers.kick(room, y.a)
    expect(membershipAt(o, room, y.a)).toBe('leave')
    // Y2 writes at the old position, after the kick it never heard of, citing 10 relays each.
    const msgs: string[] = []
    const msgWires: Wire[] = []
    let cprev: string | undefined
    for (let k = 0; k < 6; k++) {
      const f: ChainFields = { seq: 1 + k, ap: relays.slice(10 * k, 10 * k + 10).map(r => r.id) }
      if (cprev) f.cprev = cprev
      const m = sign(y2, room, 'msg', 'c', { body: `hidden ${k}`, ch }, f, clock.now() + 100 + k)
      cprev = m.id
      msgs.push(m.id)
      msgWires.push(m.wire)
    }
    // W's message names the first of them as a content parent before it arrives: a gap.
    const wAt = await heads(o, room)
    const wMsg = (seq: number, prev: string[], cprev?: string) =>
      sign(
        w,
        room,
        'msg',
        'c',
        { body: `w ${seq}`, ch },
        { seq, ap: wAt, prev, ...(cprev ? { cprev } : {}) },
        clock.now()
      )
    const w1 = wMsg(1, [msgs[0]])
    expect(await deliver(o, room, w1.wire, clock.now())).toBe('new')
    expect((await o.store.room(room))!.missing).toContain(msgs[0])
    for (const m of msgWires) expect(await deliver(o, room, m, clock.now())).toBe('new')
    expect(await bodies(o, room, ch)).toEqual(['w 1'])
    const count = (await o.store.room(room))!.count
    await pump(clock, async () => !(await stored(o, relays[0].id)), 'relays dropped')
    // Revision 7: siblings past the fork point go without their headers, but the two that keep
    // Y's fork point where it is.
    const hdrIds: string[] = []
    for (const r of relays) {
      expect(await stored(o, r.id)).toBeUndefined()
      const d = await droppedRec(o, r.id)
      expect(d?.layer).toBe('a')
      if (!d?.hdr) {
        expect(d).toEqual({ id: r.id, room, layer: 'a' })
        continue
      }
      hdrIds.push(r.id)
      expect([d.hdr.ev.dev, d.hdr.c?.dk, typeof d.acl?.v]).toEqual([y.dev, z.dev, 'number'])
      expect(d.hdr.c?.rec).toBe(rec.rec)
    }
    expect(hdrIds.sort()).toEqual(
      relays
        .map(r => r.id)
        .sort()
        .slice(0, 2)
    )
    for (const id of msgs) {
      expect(await stored(o, id)).toBeUndefined()
      expect(await droppedRec(o, id)).toEqual({ id, room, layer: 'c' })
    }
    // Dropped ids are no gaps: they leave `missing` and never come back to it.
    expect((await o.store.room(room))!.missing).not.toContain(msgs[0])
    expect(await deliver(o, room, wMsg(2, [msgs[1]], w1.id).wire, clock.now())).toBe('new')
    expect((await o.store.room(room))!.missing).not.toContain(msgs[1])
    expect((await o.store.room(room))!.count).toBe(count - relays.length - msgs.length + 1)
    // Stored void events: none of the relays, within the pool bound.
    const S = evaluator(o, room).r.state()
    const voidStored = (await o.store.db.getAll('events')).filter(
      r => r.room === room && S.X.has(r.id)
    )
    expect(voidStored.length).toBe(0)
    // Delivered again with nothing citing them: taken as had, not stored, and no longer a gap.
    expect(await deliver(o, room, relays[0].wire, clock.now())).toBe('dropped')
    const rr = (await o.store.room(room))!
    await o.store.db.put('rooms', { ...rr, missing: [...rr.missing, msgs[0]] })
    expect(await deliver(o, room, msgWires[0], clock.now())).toBe('dropped')
    expect((await o.store.room(room))!.missing).not.toContain(msgs[0])
    // Re-fetch path: W cites a dropped relay; it waits for it, and it comes back whole.
    const cite = sign(
      w,
      room,
      'mark',
      'a',
      {},
      { seq: 3, ap: [relays[1].id], aprev: wJoin },
      clock.now() + 1000
    )
    expect(await deliver(o, room, cite.wire, clock.now())).toBe('quota')
    expect(o.servers.waiting(room).pending).toBe(1)
    expect(await deliver(o, room, relays[1].wire, clock.now())).toBe('new')
    await pump(clock, async () => !!(await stored(o, cite.id)), 'the citing event')
    expect(await droppedRec(o, relays[1].id)).toBeUndefined()
    expect((await stored(o, relays[1].id))?.wire.c).toEqual(relays[1].wire.c)
    // A cold start: the dropped headers are evidence again; the same state over what is stored.
    const before = JSON.stringify(evaluator(o, room).summary())
    const gone = new Set(relays.filter(r => r.id !== relays[1].id).map(r => r.id))
    const held = (x: Iterable<string>) => [...x].filter(id => !gone.has(id)).sort()
    const sets = (s: ReturnType<AclRoom['r']['state']>) =>
      JSON.stringify([held(s.X), [...s.F].sort(), held(s.eff), held(s.void)])
    const live = sets(evaluator(o, room).r.state())
    // Imported dropped records (a transfer file) are checked at the next start: one naming an
    // event stored whole goes, one whose header doesn't check out goes, a good one is kept.
    const goodId = hdrIds.find(id => id !== relays[1].id)!
    const good = (await droppedRec(o, goodId))!
    await o.store.db.put('dropped', { ...good, imp: true })
    const whole = (await stored(o, wJoin))!
    await o.store.db.put('dropped', {
      id: wJoin,
      room,
      layer: 'a',
      hdr: { ...serverWire(whole), c: {} },
      acl: whole.acl,
      imp: true,
    })
    const fake = 'F'.repeat(43)
    await o.store.db.put('dropped', { ...good, id: fake, imp: true })
    stopMember(o)
    const again = await restart(hub, o, clock)
    expect(JSON.stringify(evaluator(again, room).summary())).toBe(before)
    expect(sets(evaluator(again, room).r.state())).toBe(live)
    expect(membershipAt(again, room, y.a)).toBe('leave')
    expect(await bodies(again, room, ch)).toEqual(['w 1', 'w 2'])
    expect([await droppedRec(again, wJoin), await droppedRec(again, fake)]).toEqual([
      undefined,
      undefined,
    ])
    expect((await droppedRec(again, goodId))?.imp).toBeUndefined()
    expect((await stored(again, wJoin))?.wire.c).toEqual(serverWire(whole).c)
  }, 120_000)
})

describe('proofs (spec 2.3, 4.1)', () => {
  test('a member that holds content evidence against a device posts a proof after a random delay, at most a few an hour', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const o = await makeMember(hub, 'Olive', clock)
    const room = await o.servers.create('Proofs')
    const ch = general(o, room)
    const per = SERVER.proofsPerHour
    SERVER.proofsPerHour = 1
    try {
      const forked: Ext[] = []
      for (const x of [ext(), ext()]) {
        const join = await extJoin(o, room, x, clock)
        const at = await heads(o, room)
        // Two messages at one seq (spec 2.3 E1), then an ACL event past them.
        for (const body of ['one', 'two'])
          expect(
            await deliver(
              o,
              room,
              sign(x, room, 'msg', 'c', { body, ch }, { seq: 1, ap: at }, clock.now()).wire,
              clock.now()
            )
          ).toBe('new')
        const mark = sign(x, room, 'mark', 'a', {}, { seq: 2, ap: at, aprev: join }, clock.now())
        expect(await deliver(o, room, mark.wire, clock.now())).toBe('new')
        forked.push(x)
      }
      const F = () => evaluator(o, room).r.state().F
      const proofs = async () =>
        (await o.store.db.getAll('events')).filter(r => r.room === room && r.type === 'proof')
      expect(forked.map(x => F().get(x.dev))).toEqual([undefined, undefined])
      await pump(clock, async () => (await proofs()).length === 1, 'one proof', 2_000)
      expect((await proofs())[0].sender).toBe(o.node.ik)
      await clock.advance(20 * 60_000)
      expect((await proofs()).length).toBe(1)
      clock.t += 60 * 60_000
      await pump(clock, async () => (await proofs()).length === 2, 'the second', 2_000)
      expect(forked.map(x => F().get(x.dev))).toEqual([1, 1])
      // Nothing left to prove: no more proofs, whatever the time.
      clock.t += 2 * 60 * 60_000
      await clock.advance(60_000)
      expect((await proofs()).length).toBe(2)
    } finally {
      SERVER.proofsPerHour = per
    }
  }, 90_000)
})

describe('per-sender shares (spec 4.2)', () => {
  test('one sender can’t take more than its share of a room’s budget in a day; others still can', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const a = await makeMember(hub, 'Alice', clock, { servers: { roomCap: 40 } })
    const b = await makeMember(hub, 'Bob', clock)
    const c = await makeMember(hub, 'Carol', clock)
    const room = await a.servers.create('Shares')
    const ch = general(a, room)
    await joinWithCode(clock, a, room, b)
    await joinWithCode(clock, a, room, c)
    await b.node.setPaused(true)
    await c.node.setPaused(true)
    const share = Math.floor(40 * SHARE.room)
    const at = await heads(b, room)
    const out: string[] = []
    let seq = (await planOf(b, room, 'msg', 'c')).seq
    for (let i = 0; i < share + 2; i++) {
      seq += 1
      const ev = await signed(b, room, 'msg', { body: `b ${i}`, ch }, { ap: at, seq })
      out.push(await deliver(a, room, ev.wire, clock.now()))
    }
    expect(out.filter(s => s === 'new').length).toBe(share)
    expect(out.slice(share)).toEqual(['quota', 'quota'])
    const cm = await signed(c, room, 'msg', { body: 'carol', ch })
    expect(await deliver(a, room, cm.wire, clock.now())).toBe('new')
    // A day later Bob's share is free again.
    clock.t += DAY + 60 * 60_000
    seq += 1
    const later = await signed(b, room, 'msg', { body: 'next day', ch }, { ap: at, seq })
    expect(await deliver(a, room, later.wire, clock.now())).toBe('new')
  }, 60_000)
})

// Alice's server with a moderator (Ban, Kick, Manage messages) and members.
const modRoom = async (names: string[]) => {
  const clock = new ManualClock()
  const hub = new Hub()
  const a = await makeMember(hub, 'Alice', clock)
  const others: Member[] = []
  for (const n of names) others.push(await makeMember(hub, n, clock))
  const room = await a.servers.create('Mods')
  const ch = general(a, room)
  for (const x of others) await joinWithCode(clock, a, room, x)
  const m = others[0]
  const role = await emit(a)(room, 'role_create', () => ({
    pos: 1,
    bits: P.Ban | P.Kick | P.ManageMessages,
  }))
  await emit(a)(room, 'assign', () => ({ to: m.node.ik, role }))
  await pump(clock, () => ((m.servers.view(room)?.perms ?? 0) & P.ManageMessages) !== 0, 'mod')
  for (const x of [a, ...others])
    await pump(clock, () => x.servers.view(room)?.joined === names.length + 1, `${x.name} sees all`)
  return { clock, hub, a, others, room, ch, role }
}

describe('eviction under pressure (spec 4.2)', () => {
  test('a room at its content budget still takes a member’s message and ours: the oldest bodies of the sender who takes the most go, and come back when viewed', async () => {
    const share = { ...SHARE }
    SHARE.room = 2
    SHARE.server = 2
    // One body at a time, so what goes is visible.
    const batch = SERVER.evictBytes
    SERVER.evictBytes = 1
    try {
      const clock = new ManualClock()
      const hub = new Hub()
      const a = await makeMember(hub, 'Alice', clock, { servers: { roomCap: 40 } })
      const b = await makeMember(hub, 'Bob', clock)
      const c = await makeMember(hub, 'Carol', clock)
      const room = await a.servers.create('Budget')
      const ch = general(a, room)
      await joinWithCode(clock, a, room, b)
      await joinWithCode(clock, a, room, c)
      await b.node.setPaused(true)
      await c.node.setPaused(true)
      // Bob fills Alice's room with messages that show.
      const at = await heads(b, room)
      let seq = (await planOf(b, room, 'msg', 'c')).seq
      const sent: string[] = []
      const wires: Wire[] = []
      const out: string[] = []
      for (let i = 0; i < 50; i++) {
        seq += 1
        const ts = clock.now() + i
        const f = sent.length
          ? { ap: at, seq, ts, cprev: sent[sent.length - 1] }
          : { ap: at, seq, ts }
        const ev = await signed(b, room, 'msg', { body: `b ${i}`, ch }, f)
        sent.push(ev.id)
        wires.push(ev.wire)
        expect(await deliver(b, room, ev.wire, clock.now())).toBe('new')
        out.push(await deliver(a, room, ev.wire, clock.now()))
      }
      expect(out.every(x => x === 'new')).toBe(true)
      expect(await contentOf(a, room)).toBeLessThanOrEqual(40)
      const cm = await signed(c, room, 'msg', { body: 'carol', ch })
      expect(await deliver(a, room, cm.wire, clock.now())).toBe('new')
      await a.servers.send(room, { ch, body: 'alice' })
      expect(await contentOf(a, room)).toBeLessThanOrEqual(40)
      // Bob's oldest went (they showed: evicted, not purged for a cause), Carol's and Alice's stay.
      const first = await stored(a, sent[0])
      expect([first?.purged, first?.evicted, first?.wire.c]).toEqual([true, true, null])
      // Bob edits an evicted message later: the edit waits with it, not asked for at once.
      expect((await stored(a, sent[2]))?.evicted).toBe(true)
      seq += 1
      const edit = await signed(
        b,
        room,
        'edit',
        { target: sent[2], body: 'b 2 again', ch },
        { ap: at, seq, cprev: sent[49] }
      )
      expect(await deliver(b, room, edit.wire, clock.now())).toBe('new')
      expect(await deliver(a, room, edit.wire, clock.now())).toBe('new')
      const e0 = await stored(a, edit.id)
      expect([e0?.purged, e0?.evicted, e0?.wire.c]).toEqual([true, true, null])
      expect(await (a.servers as unknown as { host: LocalHost }).host.wanted(room)).toEqual([])
      expect((await stored(a, sent[49]))?.wire.c).not.toBeNull()
      // Only Bob's first three rows are viewed (rendered).
      type Rows = { rows: (room: string, recs: unknown[]) => Promise<P2pMessage[]> }
      const recs3 = await Promise.all(sent.slice(0, 3).map(x => stored(a, x)))
      const shown = await (a.servers as unknown as Rows).rows(room, recs3)
      expect(shown.map(x => [x.id, x.unavailable])).toEqual(sent.slice(0, 3).map(x => [x, true]))
      expect((await stored(a, cm.id))?.wire.c).not.toBeNull()
      const ours = (await a.store.db.getAll('events')).find(
        x => x.room === room && x.sender === a.node.ik && x.type === 'msg'
      )
      expect(ours?.wire.c).not.toBeNull()
      // Not wanted back by itself; viewed, it is asked for, and Bob sends it.
      const host = (a.servers as unknown as { host: LocalHost }).host
      expect(await host.wanted(room)).toEqual([])
      // One that was viewed and then hidden (Alice deleted it) stays purged when its body comes.
      expect((await stored(a, sent[1]))?.evicted).toBe(true)
      await a.servers.redact(room, sent[1])
      expect(await deliver(a, room, wires[1], clock.now())).toBe('dup')
      expect([(await stored(a, sent[1]))?.purged, (await stored(a, sent[1]))?.wire.c]).toEqual([
        true,
        null,
      ])
      await b.node.setPaused(false)
      await pump(clock, async () => (await stored(a, sent[0]))?.purged === undefined, 'back')
      expect((await stored(a, sent[0]))?.wire.c).not.toBeNull()
      // Its edit is wanted with it once it is back.
      await pump(clock, async () => (await stored(a, edit.id))?.purged === undefined, 'edit back')
      expect(await bodies(a, room, ch)).toContain('b 2 again')
      // What came back isn't evicted again at once: Bob still holds the most, and our next sends
      // take his other bodies.
      await b.node.setPaused(true)
      for (let i = 0; i < 6; i++) await a.servers.send(room, { ch, body: `more ${i}` })
      expect((await stored(a, sent[0]))?.purged).toBeUndefined()
      expect((await a.store.room(room))!.count).toBe(await countedOf(a, room))
    } finally {
      Object.assign(SHARE, share)
      SERVER.evictBytes = batch
    }
  }, 120_000)
})

describe('eviction details (spec 4.2)', () => {
  type Purge = { purge: (room: string, ids: string[], evict?: boolean) => Promise<number> }
  const lifted = async (fn: () => Promise<void>) => {
    const share = { ...SHARE }
    SHARE.room = 4
    SHARE.server = 4
    try {
      await fn()
    } finally {
      Object.assign(SHARE, share)
    }
  }

  test(
    'copies without their bodies never stall eviction, and a room counts what it stores',
    () =>
      lifted(async () => {
        const clock = new ManualClock()
        const hub = new Hub()
        const a = await makeMember(hub, 'Alice', clock, { servers: { roomCap: 40 } })
        const b = await makeMember(hub, 'Bob', clock)
        const c = await makeMember(hub, 'Carol', clock)
        const room = await a.servers.create('Bare')
        const ch = general(a, room)
        for (const x of [b, c]) await joinWithCode(clock, a, room, x)
        await b.node.setPaused(true)
        await c.node.setPaused(true)
        const out: string[] = []
        // Bob's messages with their bodies, then many more bytes of Carol's without theirs.
        let prev: string | undefined
        for (let i = 0; i < 10; i++) {
          const m = await signed(
            b,
            room,
            'msg',
            { body: `b ${i}`, ch },
            prev ? { cprev: prev } : {}
          )
          prev = m.id
          expect(await deliver(b, room, m.wire, clock.now())).toBe('new')
          out.push(await deliver(a, room, m.wire, clock.now()))
        }
        const bare: string[] = []
        for (let i = 0; i < 20; i++) {
          const m = await signed(c, room, 'msg', { body: `c ${i} ${'x'.repeat(200)}`, ch })
          bare.push(m.id)
          out.push(await deliver(a, room, { ...m.wire, c: null } as Wire, clock.now()))
        }
        for (let i = 0; i < 5; i++) await a.servers.send(room, { ch, body: `a ${i}` })
        expect(out.every(x => x === 'new')).toBe(true)
        expect(await contentOf(a, room)).toBeLessThanOrEqual(40)
        expect((await a.store.room(room))!.count).toBe(await countedOf(a, room))
        // A copy without its body purged here: the count follows.
        expect(await (a.servers as unknown as Purge).purge(room, [bare[0]])).toBe(1)
        expect((await a.store.room(room))!.count).toBe(await countedOf(a, room))
      }),
    90_000
  )

  test(
    'an eviction keeps our own uploads, and another file while another message carries it',
    () =>
      lifted(async () => {
        const clock = new ManualClock()
        const hub = new Hub()
        const a = await makeMember(hub, 'Alice', clock)
        const b = await makeMember(hub, 'Bob', clock)
        const room = await a.servers.create('Files')
        const ch = general(a, room)
        await joinWithCode(clock, a, room, b)
        const file = async (body: string) => {
          const bytes = new TextEncoder().encode(body)
          const hashed = await hashBytes(bytes)
          return {
            bytes,
            hashed,
            att: { h: hashed.h, size: bytes.length, blocks: 1, name: 'f.txt', mime: 'text/plain' },
          }
        }
        // Ours: an upload of ours in our own message.
        const own = await file('our upload')
        await a.dms.blobs.putOwn(new Blob([own.bytes as BlobPart]), own.hashed)
        const mine = await a.servers.send(room, { ch, body: 'ours', att: [own.att] })
        // Bob's: a file held here, once in two messages, once in one.
        const two = await file('carried twice')
        const one = await file('carried once')
        for (const f of [two, one])
          await a.store.db.put('blobs', {
            h: f.hashed.h,
            size: f.bytes.length,
            hashed: false,
            have: 0,
            done: false,
            type: null,
            own: false,
            wanted: false,
            created: clock.now(),
            lastUsed: clock.now(),
          })
        await b.node.setPaused(true)
        let prev: string | undefined
        const bob: string[] = []
        // The last carries our upload too (a forward of it).
        for (const att of [[two.att], [two.att], [one.att], [own.att]]) {
          const m = await signed(
            b,
            room,
            'msg',
            { body: 'file', ch, att },
            prev ? { cprev: prev } : {}
          )
          prev = m.id
          bob.push(m.id)
          expect(await deliver(a, room, m.wire, clock.now())).toBe('new')
        }
        const purge = (ids: string[]) => (a.servers as unknown as Purge).purge(room, ids, true)
        expect(await purge([mine, bob[0], bob[2], bob[3]])).toBe(4)
        await clock.advance(1_000)
        const has = async (h: string) => !!(await a.store.db.get('blobs', h))
        expect([await has(own.hashed.h), await has(two.hashed.h), await has(one.hashed.h)]).toEqual(
          [true, true, false]
        )
      }),
    90_000
  )

  // Alice's room at a cap of 30 that Bob filled with 40 messages (also stored at Bob's), one body
  // evicted at a time.
  const budgetRoom = async (clock: ManualClock, hub: Hub) => {
    const a = await makeMember(hub, 'Alice', clock, { servers: { roomCap: 30 } })
    const b = await makeMember(hub, 'Bob', clock)
    const room = await a.servers.create('Budget')
    const ch = general(a, room)
    await joinWithCode(clock, a, room, b)
    await b.node.setPaused(true)
    const at = await heads(b, room)
    let seq = (await planOf(b, room, 'msg', 'c')).seq
    const sent: string[] = []
    const batch = SERVER.evictBytes
    SERVER.evictBytes = 1
    try {
      for (let i = 0; i < 40; i++) {
        seq += 1
        const f = { ap: at, seq, ts: clock.now() + i, ...(i ? { cprev: sent[i - 1] } : {}) }
        const m = await signed(b, room, 'msg', { body: `b ${i}`, ch }, f)
        sent.push(m.id)
        expect(await deliver(b, room, m.wire, clock.now())).toBe('new')
        expect(await deliver(a, room, m.wire, clock.now())).toBe('new')
      }
    } finally {
      SERVER.evictBytes = batch
    }
    return { a, b, room, ch, sent }
  }
  const evictedOf = async (m: Member, room: string) =>
    (await m.store.db.getAll('events')).filter(r => r.room === room && r.evicted).map(r => r.id)
  // The room's cap lowered to what it holds: what comes next needs room.
  const capNow = async (m: Member, room: string) => {
    const deps = (m.servers as unknown as { deps: { roomCap: number } }).deps
    deps.roomCap = await contentOf(m, room)
  }

  test(
    'a body stored below where its sender’s last eviction walk stopped is still the first to go',
    () =>
      lifted(async () => {
        const clock = new ManualClock()
        const hub = new Hub()
        const { a, b, room, ch, sent } = await budgetRoom(clock, hub)
        const starts = (
          a.servers as unknown as { ensureRt(r: string): { evictFrom: Map<string, string> } }
        ).ensureRt(room).evictFrom
        expect(starts.has(b.node.ik)).toBe(true)
        // A body of Bob's stored below the start (another of his devices can date one there)
        // moves it back.
        starts.set(b.node.ik, '\uffff')
        const next = await signed(b, room, 'msg', { body: 'next', ch })
        expect(await deliver(b, room, next.wire, clock.now())).toBe('new')
        await capNow(a, room)
        expect(await deliver(a, room, next.wire, clock.now())).toBe('new')
        expect(starts.get(b.node.ik)).not.toBe('\uffff')
        // A start past every body: the walk goes again from the beginning.
        starts.set(b.node.ik, '\uffff')
        const kept: string[] = []
        for (const id of [...sent, next.id]) if (!(await stored(a, id))?.evicted) kept.push(id)
        expect(kept.length).toBeGreaterThan(0)
        await capNow(a, room)
        // Past Bob's share window.
        clock.t += DAY
        const more = await signed(b, room, 'msg', { body: 'more', ch })
        expect(await deliver(a, room, more.wire, clock.now())).toBe('new')
        expect((await stored(a, kept[0]))?.evicted).toBe(true)
      }),
    90_000
  )

  test(
    'a start doesn’t fetch back evicted bodies nobody viewed: a room at its budget stays within it across two reloads',
    () =>
      lifted(async () => {
        const clock = new ManualClock()
        const hub = new Hub()
        const { a, b, room } = await budgetRoom(clock, hub)
        const before = await evictedOf(a, room)
        expect(before.length).toBeGreaterThan(5)
        expect(await contentOf(a, room)).toBeLessThanOrEqual(30)
        await b.node.setPaused(false)
        let x = a
        for (let i = 0; i < 2; i++) {
          stopMember(x)
          x = await restart(hub, x, clock)
          for (let k = 0; k < 4; k++) await clock.advance(SERVER.causesMs)
          expect(await contentOf(x, room)).toBeLessThanOrEqual(30)
          expect((await evictedOf(x, room)).sort()).toEqual([...before].sort())
          expect(await (x.servers as unknown as { host: LocalHost }).host.wanted(room)).toEqual([])
        }
      }),
    120_000
  )

  test(
    'a body fetched back on view takes just the room it needs, and the sender’s index is walked once',
    () =>
      lifted(async () => {
        const clock = new ManualClock()
        const hub = new Hub()
        const { a, b, room } = await budgetRoom(clock, hub)
        // Bob's own index: a walk sees only his records, and one walk gives both kinds.
        const his = (await a.store.db.getAll('events')).filter(
          r => r.room === room && r.sender === b.node.ik
        )
        const got = await oldestBodies(a.store.db, room, b.node.ik, 1, clock.now())
        expect(got.seen).toBeLessThanOrEqual(his.length)
        expect(got.ids.length).toBe(1)
        const before = await evictedOf(a, room)
        // Two evicted rows are viewed and fetched back from Bob; each restore evicts one body.
        type Rows = { rows: (room: string, recs: unknown[]) => Promise<P2pMessage[]> }
        const two = before.slice(0, 2)
        await (a.servers as unknown as Rows).rows(
          room,
          await Promise.all(two.map(x => stored(a, x)))
        )
        await b.node.setPaused(false)
        await pump(
          clock,
          async () => (await Promise.all(two.map(x => stored(a, x)))).every(r => !r?.purged),
          'both back'
        )
        const after = await evictedOf(a, room)
        expect(after.length).toBe(before.length)
        expect(after.filter(x => two.includes(x))).toEqual([])
        // In their grace now: a walk lists them apart.
        const again = await oldestBodies(a.store.db, room, b.node.ik, 1e9, clock.now())
        expect([...again.late].sort()).toEqual([...two].sort())
        // Walking all of them reads Bob's records and nobody else's.
        const hisNow = (await a.store.db.getAll('events')).filter(
          r => r.room === room && r.sender === b.node.ik
        )
        expect(again.seen).toBe(hisNow.length)
      }),
    120_000
  )

  test(
    'when every server’s budget is full, the sender who holds the most across servers goes first',
    () =>
      lifted(async () => {
        const clock = new ManualClock()
        const hub = new Hub()
        const a = await makeMember(hub, 'Alice', clock)
        const b = await makeMember(hub, 'Bob', clock)
        const c = await makeMember(hub, 'Carol', clock)
        const r1 = await a.servers.create('One')
        const r2 = await a.servers.create('Two')
        for (const x of [b, c]) await joinWithCode(clock, a, r1, x)
        await joinWithCode(clock, a, r2, b)
        await b.node.setPaused(true)
        await c.node.setPaused(true)
        const fill = async (who: Member, room: string, n: number) => {
          const ch = general(a, room)
          let prev: string | undefined
          const ids: string[] = []
          for (let i = 0; i < n; i++) {
            const m = await signed(
              who,
              room,
              'msg',
              { body: `${who.name} ${i}`, ch },
              prev ? { cprev: prev } : {}
            )
            prev = m.id
            ids.push(m.id)
            expect(await deliver(a, room, m.wire, clock.now())).toBe('new')
          }
          return ids
        }
        const b1 = await fill(b, r1, 6)
        const b2 = await fill(b, r2, 7)
        const c1 = await fill(c, r1, 8)
        // Bob holds 13 bodies across servers, Carol 8 in one: in One, Carol holds the most.
        const total =
          ((await a.store.db.get('meta', 'sevents')) as number) -
          ((await a.store.db.get('meta', 'sacl')) as number)
        ;(a.servers as unknown as { deps: { serverCap: number } }).deps.serverCap = total
        const m = await signed(
          c,
          r1,
          'msg',
          { body: 'one more', ch: general(a, r1) },
          { cprev: c1[7] }
        )
        expect(await deliver(a, r1, m.wire, clock.now())).toBe('new')
        expect((await stored(a, b2[0]))?.evicted).toBe(true)
        expect((await stored(a, c1[0]))?.evicted).toBeUndefined()
        void b1
      }),
    120_000
  )

  test(
    'a sender’s oldest bodies go first across its devices, in the order the room shows them',
    () =>
      lifted(async () => {
        const clock = new ManualClock()
        const hub = new Hub()
        const a = await makeMember(hub, 'Alice', clock)
        const room = await a.servers.create('Devices')
        const ch = general(a, room)
        const y = ext()
        const y2 = ext(y.ik)
        const join = await extJoin(a, room, y, clock)
        const add = sign(
          y2,
          room,
          'device_add',
          'a',
          { dcert: signDeviceCert2(y.ik, room, y.a, y2.dev, join) },
          { seq: 0, ap: await heads(a, room), iprev: join },
          clock.now()
        )
        expect(await deliver(a, room, add.wire, clock.now())).toBe('new')
        const at = await heads(a, room)
        const t0 = clock.now()
        await clock.advance(60_000)
        // The first device's messages, then the second device's: their seqs interleave, their
        // times don't.
        const post = async (x: Ext, n: number, ts: number) => {
          const ids: string[] = []
          for (let i = 0; i < n; i++) {
            const f: ChainFields = { seq: 1 + i, ap: at, ...(i ? { cprev: ids[i - 1] } : {}) }
            const m = sign(x, room, 'msg', 'c', { body: `${ts} ${i}`, ch }, f, ts + i)
            expect(await deliver(a, room, m.wire, clock.now())).toBe('new')
            ids.push(m.id)
          }
          return ids
        }
        const old = await post(y, 20, t0 + 1_000)
        const newer = await post(y2, 5, t0 + 30_000)
        await capNow(a, room)
        const batch = SERVER.evictBytes
        SERVER.evictBytes = 1
        try {
          for (let i = 0; i < 4; i++) await a.servers.send(room, { ch, body: `a ${i}` })
        } finally {
          SERVER.evictBytes = batch
        }
        const gone = await evictedOf(a, room)
        expect(gone.length).toBeGreaterThanOrEqual(4)
        expect([...gone].sort()).toEqual(old.slice(0, gone.length).sort())
        const rest = await oldestBodies(a.store.db, room, y.a, 1e9, clock.now())
        expect(rest.ids).toEqual([...old.slice(gone.length), ...newer])
      }),
    90_000
  )

  test(
    'a purge under pressure of hidden bodies whose cause isn’t stable keeps our own uploads, as an eviction does',
    () =>
      lifted(async () => {
        const clock = new ManualClock()
        const hub = new Hub()
        const o = await makeMember(hub, 'Olive', clock)
        const a = await makeMember(hub, 'Alice', clock)
        const b = await makeMember(hub, 'Bob', clock)
        const room = await o.servers.create('Files')
        const ch = general(o, room)
        for (const x of [a, b]) await joinWithCode(clock, o, room, x)
        const bytes = new TextEncoder().encode('our upload')
        const hashed = await hashBytes(bytes)
        await a.dms.blobs.putOwn(new Blob([bytes as BlobPart]), hashed)
        const att = {
          h: hashed.h,
          size: bytes.length,
          blocks: 1,
          name: 'f.txt',
          mime: 'text/plain',
        }
        // Our upload in our message, and in Bob's forward of it.
        const mine = await a.servers.send(room, { ch, body: 'ours', att: [att] })
        const fwd = await signed(b, room, 'msg', { body: 'forwarded', ch, att: [att] })
        for (const x of [b, o, a]) expect(await deliver(x, room, fwd.wire, clock.now())).toBe('new')
        await pump(clock, async () => !!(await stored(o, mine)), 'the owner has it')
        // The owner deletes both; with one other member to acknowledge each, neither is stable.
        await o.servers.redact(room, mine)
        await o.servers.redact(room, fwd.id)
        await pump(
          clock,
          async () => (await bodies(a, room, ch)).every(x => x !== 'ours' && x !== 'forwarded'),
          'hidden'
        )
        const host = (a.servers as unknown as { host: LocalHost }).host
        const p = await host.purgeable(room)
        expect(p.causes.every(c => c.kind === 'redact' && !c.stable)).toBe(true)
        expect(p.causes.flatMap(c => c.ids).sort()).toEqual([mine, fwd.id].sort())
        const has = async () => !!(await a.store.db.get('blobs', hashed.h))
        expect(await has()).toBe(true)
        await capNow(a, room)
        await a.servers.send(room, { ch, body: 'more' })
        for (const id of [mine, fwd.id]) {
          const r = await stored(a, id)
          expect([r?.purged, r?.evicted, r?.wire.c]).toEqual([true, undefined, null])
        }
        await clock.advance(1_000)
        expect(await has()).toBe(true)
      }),
    90_000
  )
})

describe('stability and purges (spec 4.3)', () => {
  test('a moderator’s redaction purges its target and its author’s edits only once S1 to S4 hold: holders acknowledge it with a mark naming it, and it stood a week', async () => {
    const { clock, a, others, room, ch } = await modRoom(['Mod', 'Zoe', 'Carol', 'Dan'])
    const [m, z, c, d] = others
    const id = await z.servers.send(room, { ch, body: 'rude' })
    const edit = await z.servers.edit(room, id, 'still rude')
    for (const x of [a, m, c, d])
      await pump(clock, async () => !!(await stored(x, edit)), `${x.name} has the edit`)
    expect(await bodies(a, room, ch)).toEqual(['still rude'])
    const marks = async (x: Member) =>
      (await x.store.db.getAll('events')).filter(r => r.room === room && r.type === 'mark')
    const before = (await marks(a)).length
    const r = await m.servers.redact(room, id)
    await pump(clock, async () => !(await bodies(a, room, ch)).includes('still rude'), 'hidden')
    // Each holder other than the two authors names it in one mark within a minute.
    await pump(clock, async () => (await marks(a)).length >= before + 3, 'acknowledged', 10_000)
    const acks = (await marks(a)).slice(before)
    expect(new Set(acks.map(x => x.sender))).toEqual(new Set([a.node.ik, c.node.ik, d.node.ik]))
    expect(acks.every(x => JSON.stringify(serverWire(x).c) === JSON.stringify({ ack: [r] }))).toBe(
      true
    )
    expect((await stored(a, id))?.wire.c).not.toBeNull()
    clock.t += 6 * DAY
    await clock.advance(70_000)
    expect((await stored(a, id))?.purged).toBeUndefined()
    clock.t += 2 * DAY
    await pump(clock, async () => (await stored(a, id))?.purged === true, 'purged', 70_000)
    // The text is gone from the message and from its author's edit, and neither is served.
    for (const x of [id, edit])
      expect([(await stored(a, x))?.purged, (await stored(a, x))?.wire.c]).toEqual([true, null])
    expect(await bodies(a, room, ch)).toEqual([])
    // An edit that comes later is stored without its text.
    const late = await z.servers.edit(room, id, 'rude again')
    await pump(clock, async () => !!(await stored(a, late)), 'a has the late edit')
    expect([(await stored(a, late))?.purged, (await stored(a, late))?.wire.c]).toEqual([true, null])
    // Acknowledged: no more marks, however long.
    const after = (await marks(a)).length
    clock.t += 30 * 60_000
    await clock.advance(70_000)
    expect((await marks(a)).length).toBe(after)
  }, 150_000)

  test('a self-redaction purges at once, edits included, even when a moderator’s redaction came first; if it stops counting the body can come back', async () => {
    const { clock, a, others, room, ch } = await modRoom(['Mod', 'Zoe'])
    const [m, z] = others
    const id = await z.servers.send(room, { ch, body: 'oops' })
    const edit = await z.servers.edit(room, id, 'oops twice')
    const id2 = await z.servers.send(room, { ch, body: 'second' })
    for (const x of [a, m])
      await pump(clock, async () => !!(await stored(x, id2)), `${x.name} has them`)
    const whole = (await stored(z, id2))!.wire
    // Alice's kick of Zoe from here, with Zoe's watermark here: it will be concurrent with
    // Zoe's redactions, which come past the watermark.
    const before = await heads(a, room)
    const seen = (await planOf(a, room, 'kick', 'a', z.node.ik)).seen ?? {}
    await m.servers.redact(room, id)
    await pump(clock, async () => !(await bodies(a, room, ch)).includes('oops twice'), 'hidden')
    expect((await stored(a, id))?.purged).toBeUndefined()
    await z.servers.redact(room, id)
    await z.servers.redact(room, id2)
    await pump(clock, async () => (await stored(a, id2))?.purged === true, 'purged at a')
    for (const x of [id, edit, id2])
      expect([(await stored(a, x))?.purged, (await stored(a, x))?.wire.c]).toEqual([true, null])
    // The kick arrives: Zoe's redactions no longer count. The moderator's still hides the first;
    // the second shows again, without its body here until someone sends it back.
    await z.node.setPaused(true)
    await m.node.setPaused(true)
    const kick = await signed(a, room, 'kick', { to: z.node.ik, seen }, { ap: before })
    expect(await deliver(a, room, kick.wire, clock.now())).toBe('new')
    const host = (a.servers as unknown as { host: LocalHost }).host
    expect(await host.wanted(room)).toEqual([id2])
    const row = async (x: string) =>
      (await a.servers.loadChannel(room, ch, { limit: 100 })).messages.find(y => y.id === x)
    expect([await row(id), (await row(id2))?.unavailable]).toEqual([undefined, true])
    // As if a peer that still holds it answered the page's request for it.
    await pump(
      clock,
      async () =>
        (await deliver(a, room, whole, clock.now())) === 'dup' &&
        (await stored(a, id2))?.purged === undefined,
      'restored'
    )
    expect(await bodies(a, room, ch)).toEqual(['second'])
  }, 90_000)

  test('a purge that a later event overturns gets its body back from a peer that still holds it; until then it is unavailable', async () => {
    const { clock, a, others, room, ch, role } = await modRoom([
      'Mod',
      'Bob',
      'Carol',
      'Dan',
      'Eve',
    ])
    const [m, b, c, d, e] = others
    const before = await heads(a, room)
    const id = await b.servers.send(room, { ch, body: 'X' })
    for (const x of [a, m, c, d, e])
      await pump(clock, async () => (await bodies(x, room, ch)).includes('X'), `${x.name} has X`)
    await e.node.setPaused(true)
    await b.node.setPaused(true)
    await m.servers.ban(room, b.node.ik, undefined, true)
    for (const x of [c, c, d]) {
      await pump(clock, () => membershipAt(x, room, b.node.ik) === 'ban', `${x.name} has the ban`)
      await emit(x)(room, 'mark', () => ({}))
    }
    await pump(clock, () => membershipAt(a, room, b.node.ik) === 'ban', 'a has the ban')
    expect(await bodies(a, room, ch)).toEqual([])
    clock.t += 8 * DAY
    await pump(clock, async () => (await stored(a, id))?.purged === true, 'purged at a', 70_000)
    // The owner had deleted the moderator's role concurrently, from before the ban: it falls. No
    // removal is in effect after it, so nothing else in the room asks for bodies again.
    const del = await signed(a, room, 'role_del', { role }, { ap: before })
    expect(await deliver(a, room, del.wire, clock.now())).toBe('new')
    expect(membershipAt(a, room, b.node.ik)).toBe('join')
    const row = async () =>
      (await a.servers.loadChannel(room, ch, { limit: 100 })).messages.find(x => x.id === id)
    expect((await row())?.unavailable).toBe(true)
    // The page asks the members online, who purged it too; then nothing happens in the room.
    for (let i = 0; i < 3; i++) await clock.advance(SERVER.storeMs)
    expect((await stored(a, id))?.purged).toBe(true)
    // Eve never heard of the ban: she holds X whole and sends it back once she is online.
    await e.node.setPaused(false)
    await pump(
      clock,
      async () => (await bodies(a, room, ch)).includes('X'),
      'X back',
      5_000,
      60_000
    )
    expect((await stored(a, id))?.purged).toBeUndefined()
    expect((await row())?.unavailable).toBeUndefined()
  }, 150_000)

  test('a ban that also hides all their messages hides everything they wrote, and stays so after a reload', async () => {
    const { clock, hub, a, others, room, ch } = await modRoom(['Mod', 'Bob', 'Carol'])
    const [, b, c] = others
    await b.servers.send(room, { ch, body: 'first' })
    await c.servers.send(room, { ch, body: 'kept' })
    for (const x of [a, c])
      await pump(clock, async () => (await bodies(x, room, ch)).length === 2, `${x.name} has both`)
    await a.servers.ban(room, b.node.ik, undefined, true)
    await pump(clock, async () => (await bodies(c, room, ch)).join() === 'kept', 'hidden at c')
    expect(await bodies(a, room, ch)).toEqual(['kept'])
    stopMember(a)
    const again = await restart(hub, a, clock)
    expect(await bodies(again, room, ch)).toEqual(['kept'])
    expect(membershipAt(again, room, b.node.ik)).toBe('ban')
  }, 90_000)
})

describe('serving (spec 3.7)', () => {
  test('content of a view-restricted channel goes only to who may view it; a copy without its body only to who may view every channel', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const a = await makeMember(hub, 'Alice', clock)
    const b = await makeMember(hub, 'Bob', clock)
    const c = await makeMember(hub, 'Carol', clock)
    const d = await makeMember(hub, 'Dan', clock)
    const e = await makeMember(hub, 'Eve', clock)
    const room = await a.servers.create('Private')
    const ch = general(a, room)
    const priv = await a.servers.addChannel(room, 'mods', { restrictView: true })
    for (const x of [b, c]) await joinWithCode(clock, a, room, x)
    const role = await emit(a)(room, 'role_create', () => ({ pos: 1, bits: P.ManageChannels }))
    await emit(a)(room, 'assign', () => ({ to: c.node.ik, role }))
    await pump(clock, () => ((c.servers.view(room)?.perms ?? 0) & P.ManageChannels) !== 0, 'c')
    const secret = await a.servers.send(room, { ch: priv, body: 'secret' })
    const hello = await a.servers.send(room, { ch, body: 'hello' })
    await pump(clock, async () => !!(await stored(c, secret)) && !!(await stored(b, hello)), 'sync')
    await clock.advance(30_000)
    // Pushed and pulled: Bob has the public message, never the private one.
    expect(await stored(b, secret)).toBeUndefined()
    expect((await stored(c, secret))?.wire.c).not.toBeNull()
    // Files: one in the private channel goes only to who may view it.
    const att = async (body: string) => {
      const { h } = await hashBytes(new TextEncoder().encode(body))
      return { h, size: body.length, blocks: 1, name: `${body}.txt`, mime: 'text/plain' }
    }
    const fPriv = await att('private file')
    const fPub = await att('public file')
    await a.servers.send(room, { ch: priv, body: 'file', att: [fPriv] })
    await a.servers.send(room, { ch, body: 'file', att: [fPub] })
    expect([
      await a.servers.entitled(b.node.ik, fPriv.h),
      await a.servers.entitled(c.node.ik, fPriv.h),
      await a.servers.entitled(b.node.ik, fPub.h),
    ]).toEqual([false, true, true])
    // Alice holds a message of Bob's only without its body (it came so): its channel can't be read.
    await b.node.setPaused(true)
    await c.node.setPaused(true)
    const bare = await signed(b, room, 'msg', { body: 'unseen', ch })
    expect(await deliver(a, room, { ...bare.wire, c: null } as Wire, clock.now())).toBe('new')
    const hello2 = bare.id
    await joinWithCode(clock, a, room, d)
    const role2 = await emit(a)(room, 'role_create', () => ({ pos: 2, bits: P.ManageChannels }))
    await joinWithCode(clock, a, room, e)
    await emit(a)(room, 'assign', () => ({ to: e.node.ik, role: role2 }))
    await pump(clock, () => ((e.servers.view(room)?.perms ?? 0) & P.ManageChannels) !== 0, 'e')
    e.servers.sync.loadOlder(room)
    d.servers.sync.loadOlder(room)
    await pump(clock, async () => !!(await stored(e, hello2)), 'e has the copy')
    expect((await stored(e, hello2))?.wire.c).toBeNull()
    expect(await stored(e, secret)).not.toBeUndefined()
    const late = await a.servers.send(room, { ch, body: 'late' })
    await pump(clock, async () => !!(await stored(d, late)), 'd has what it may see')
    await clock.advance(30_000)
    expect(await stored(d, hello)).not.toBeUndefined()
    expect(await stored(d, hello2)).toBeUndefined()
    expect(await stored(d, secret)).toBeUndefined()
  }, 120_000)
})
