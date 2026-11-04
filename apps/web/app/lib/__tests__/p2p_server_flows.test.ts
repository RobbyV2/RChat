import { afterEach, describe, expect, test } from 'bun:test'
import {
  CONFLICT_TEXT,
  LONE_TEXT,
  lostOthersText,
  QUICK_TEXT,
  CO_OWNER_DECLINED_TEXT,
  UNBAN_TEXT,
  VOUCH_WAIT_TEXT,
} from '../p2p/flows'
import { signDeviceCert2 } from '../p2p/acl/binding'
import { EVERYONE, P } from '../p2p/acl/rules'
import { buildEvent2, signUpgrade } from '../p2p/event'
import { keyId, newKeyPair } from '../p2p/keys'
import { parseCode, encodeCode, REDEEM_TEXT, Servers } from '../p2p/server'
import {
  bodies,
  createWith,
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
import { Hub, ManualClock } from './p2p_net'

// The user-facing flows of P2P servers (spec 8.2, 9) on real members over the in-memory hub.

afterEach(stopAll)

type Emit = (
  room: string,
  t: string,
  make: (plan: { seen?: Record<string, number> }) => Record<string, unknown>,
  opts?: { L?: 'a' | 'c'; to?: string }
) => Promise<string>
const emit = (m: Member): Emit =>
  (m.servers as unknown as { emit: Emit }).emit.bind(m.servers) as Emit

const failure = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e: Error) => e.message
  )

// Mutual contacts: they reach each other whatever links their servers have.
const contacts = async (clock: ManualClock, a: Member, b: Member) => {
  await a.node.addContact(await b.node.myCard())
  await pump(clock, () => b.node.contact(a.node.ik)?.state === 'incoming', 'request')
  await b.node.accept(a.node.ik)
  await pump(clock, () => a.node.contact(b.node.ik)?.state === 'mutual', 'mutual')
}

const memberOf = (m: Member, room: string, ik: string) =>
  m.servers.view(room)?.members.find(x => x.ik === ik)

const state = (m: Member, room: string, ik: string) => m.servers.sumOf(room).members[ik]?.m ?? null

// A role with `bits` at position `pos`, given to `to` by `by`; returns the role id.
const giveRole = async (by: Member, room: string, to: Member, bits: number, pos = 1) => {
  const role = await emit(by)(room, 'role_create', () => ({ pos, bits, name: 'mod' }))
  await emit(by)(room, 'assign', () => ({ to: to.node.ik, role }))
  return role
}

const sees = (clock: ManualClock, m: Member, room: string, ik: string, want: string) =>
  pump(clock, () => state(m, room, ik) === want, `${m.name} sees ${want}`)

describe('moderation waits for sync (spec 8.2, 9 rule 2)', () => {
  test('a kick is signed only after a member sent fresh heads and we hold them; or Apply anyway', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const a = await makeMember(hub, 'Alice', clock)
    const b = await makeMember(hub, 'Bob', clock)
    const c = await makeMember(hub, 'Carol', clock)
    const room = await a.servers.create('Mods')
    await joinWithCode(clock, a, room, b)
    await joinWithCode(clock, a, room, c)
    // Alice is away while Bob makes a change she hasn't seen.
    await a.node.setPaused(true)
    const mark = await emit(b)(room, 'mark', () => ({}))
    await c.node.setPaused(true)
    await b.node.setPaused(true)
    await a.node.setPaused(false)
    const kick = a.servers.moderate(room, { act: 'Kick', who: c.node.ik }, () =>
      a.servers.kick(room, c.node.ik)
    )
    await pump(clock, () => a.servers.view(room)?.mods.length === 1, 'waiting', 1_000)
    await clock.advance(60_000)
    expect(a.servers.view(room)?.mods.map(x => [x.act, x.who])).toEqual([['Kick', c.node.ik]])
    expect(state(a, room, c.node.ik)).toBe('join')
    // Bob comes back: his heads name the mark; the kick goes out once Alice holds it.
    await b.node.setPaused(false)
    const id = (await kick) as string
    expect(a.servers.view(room)?.mods).toEqual([])
    const ev = (await a.store.event(id))!.wire.ev as unknown as { ap: string[] }
    expect(ev.ap).toContain(mark)
    expect(state(a, room, c.node.ik)).toBe('leave')
    // Nobody else around: Apply anyway.
    await b.node.setPaused(true)
    await pump(clock, () => !a.servers.online(room), 'alone')
    const ban = a.servers.moderate(room, { act: 'Ban', who: c.node.ik }, () =>
      a.servers.ban(room, c.node.ik)
    )
    await pump(clock, () => a.servers.view(room)?.mods.length === 1, 'waiting again', 1_000)
    await clock.advance(60_000)
    expect(state(a, room, c.node.ik)).toBe('leave')
    a.servers.applyAnyway(room, a.servers.view(room)!.mods[0].id)
    await ban
    expect(state(a, room, c.node.ik)).toBe('ban')
    // Cancelled: nothing is signed.
    const unban = a.servers.moderate(room, { act: 'Lift the ban of', who: c.node.ik }, () =>
      a.servers.unban(room, c.node.ik)
    )
    await pump(clock, () => a.servers.view(room)?.mods.length === 1, 'waiting once more', 1_000)
    // One applied anyway behind another that waits goes at once.
    const later = a.servers.moderate(room, { act: 'Mark' }, () => emit(a)(room, 'mark', () => ({})))
    await pump(clock, () => a.servers.view(room)?.mods.length === 2, 'two waiting', 1_000)
    a.servers.applyAnyway(room, a.servers.view(room)!.mods[1].id)
    expect(typeof (await later)).toBe('string')
    expect(a.servers.view(room)?.mods.length).toBe(1)
    a.servers.cancelMod(room, a.servers.view(room)!.mods[0].id)
    expect(await unban).toBeNull()
    expect(state(a, room, c.node.ik)).toBe('ban')
  }, 90_000)
})

describe('unban (spec 8.2)', () => {
  test('only someone ranked at least as high as every ban of them can lift it', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const a = await makeMember(hub, 'Alice', clock)
    const b = await makeMember(hub, 'Bob', clock)
    const c = await makeMember(hub, 'Carol', clock)
    const room = await a.servers.create('Bans')
    await joinWithCode(clock, a, room, b)
    await joinWithCode(clock, a, room, c)
    const Ban = 32
    await giveRole(a, room, b, Ban)
    await pump(clock, () => ((b.servers.view(room)?.perms ?? 0) & Ban) !== 0, 'bob may ban')
    // Bob bans Carol and may lift his own ban.
    await b.servers.ban(room, c.node.ik)
    await sees(clock, a, room, c.node.ik, 'ban')
    expect(memberOf(b, room, c.node.ik)?.unban).toBe(true)
    await b.servers.unban(room, c.node.ik)
    await sees(clock, a, room, c.node.ik, 'leave')
    // The owner bans Carol: Bob, a moderator, may not lift it (nor any later ban of her: every
    // ban of her that counts must be outranked).
    await a.servers.ban(room, c.node.ik)
    await sees(clock, b, room, c.node.ik, 'ban')
    expect(memberOf(a, room, c.node.ik)?.unban).toBe(true)
    expect(memberOf(b, room, c.node.ik)?.unban).toBe(false)
    expect(await failure(b.servers.unban(room, c.node.ik))).not.toBe('ok')
    expect(UNBAN_TEXT).toContain('at least as high')
    await a.servers.unban(room, c.node.ik)
    await sees(clock, b, room, c.node.ik, 'leave')
  }, 90_000)
})

describe('limits (spec 8.2 W3)', () => {
  test('too many changes in an hour: the hourly message; leaving still works', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const a = await makeMember(hub, 'Alice', clock)
    const b = await makeMember(hub, 'Bob', clock)
    const c = await makeMember(hub, 'Carol', clock)
    const room = await a.servers.create('Limits')
    await joinWithCode(clock, a, room, b)
    await joinWithCode(clock, a, room, c)
    let why = 'ok'
    let n = 0
    let last = ''
    while (why === 'ok' && n < 80) {
      try {
        last = await emit(b)(room, 'mark', () => ({}))
        n += 1
      } catch (e) {
        why = (e as Error).message
      }
      // Carol acknowledges now and then, so only the hourly window counts (not W3(b)).
      if (why === 'ok' && n % 15 === 0) {
        const mine = last
        await pump(clock, async () => !!(await c.store.event(mine)), 'carol holds them', 1_000)
        const ack = await emit(c)(room, 'mark', () => ({}))
        await pump(clock, async () => !!(await b.store.event(ack)), 'bob holds it', 1_000)
      }
    }
    expect(why).toBe(QUICK_TEXT)
    expect(n).toBeGreaterThan(40)
    expect(n).toBeLessThanOrEqual(60)
    await b.servers.leave(room)
    expect(b.servers.myMembership(room)).toBe('leave')
  }, 120_000)
})

describe('invite codes (spec 8.2)', () => {
  test('a link carries the code id and its secret; a link naming another code with it is refused', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const a = await makeMember(hub, 'Alice', clock)
    const b = await makeMember(hub, 'Bob', clock)
    const room = await a.servers.create('Codes')
    const one = await a.servers.issueCode(room, 60 * 60_000)
    const two = await a.servers.issueCode(room, 60 * 60_000)
    const p1 = parseCode(one)!
    const p2 = parseCode(two)!
    expect(new Set(Object.keys(a.servers.sumOf(room).codes))).toEqual(
      new Set([p1.code as string, p2.code as string])
    )
    // The secret of one with the id of the other.
    const mixed = encodeCode({ ...p1, code: p2.code })
    expect(await failure(b.servers.redeem(mixed))).toBe(REDEEM_TEXT.unknown)
    await b.servers.redeem(one)
    await pump(clock, () => b.servers.myMembership(room) === 'join', 'bob joined')
  }, 60_000)

  test('a code is refused here once its revocation is asked, while that waits for sync', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const a = await makeMember(hub, 'Alice', clock)
    const b = await makeMember(hub, 'Bob', clock)
    const c = await makeMember(hub, 'Carol', clock)
    const room = await a.servers.create('Held')
    await joinWithCode(clock, a, room, b)
    const code = await a.servers.issueCode(room, 60 * 60_000)
    const { h } = a.servers.sumOf(room).codes[parseCode(code)!.code as string]
    await b.node.setPaused(true)
    await pump(clock, () => !a.servers.online(room), 'alone')
    const revoke = a.servers.revokeCodeSynced(room, h)
    await pump(clock, () => a.servers.view(room)?.mods.length === 1, 'waiting', 1_000)
    expect(await failure(c.servers.redeem(code))).toBe(REDEEM_TEXT.revoked)
    expect(c.servers.myMembership(room)).not.toBe('join')
    // Cancelled: the code works again.
    a.servers.cancelMod(room, a.servers.view(room)!.mods[0].id)
    expect(await revoke).toBeNull()
    await c.servers.redeem(code)
    await pump(clock, () => c.servers.myMembership(room) === 'join', 'carol joined')
  }, 60_000)
})

describe('removed members (spec 8.2)', () => {
  test('someone removed from one server who joins another of ours with a code keeps the session', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const a = await makeMember(hub, 'Alice', clock)
    const b = await makeMember(hub, 'Bob', clock)
    const one = await a.servers.create('One')
    await joinWithCode(clock, a, one, b)
    await a.servers.kick(one, b.node.ik)
    await pump(clock, () => b.servers.myMembership(one) === 'leave', 'bob out')
    await b.node.setPaused(true)
    await pump(clock, () => a.node.readySessions(b.node.ik).length === 0, 'no session', 1_000)
    await b.node.setPaused(false)
    const two = await a.servers.create('Two')
    await joinWithCode(clock, a, two, b)
    const open = a.node.readySessions(b.node.ik)
    expect(open.length).toBeGreaterThan(0)
    for (let i = 0; i < 10; i++) await clock.advance(1_000)
    expect(open.some(x => x.state === 'ready')).toBe(true)
  }, 60_000)
})

describe('vouched invites (spec 9 rule 14)', () => {
  test("a join through a member's invite waits for a third member; both sides see it", async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const a = await makeMember(hub, 'Alice', clock)
    const b = await makeMember(hub, 'Bob', clock)
    const d = await makeMember(hub, 'Dave', clock)
    const room = await a.servers.create('Vouch')
    await joinWithCode(clock, a, room, b)
    // Only Bob is around to let Dave in.
    await a.node.setPaused(true)
    const code = await b.servers.issueCode(room, 60 * 60_000)
    await d.servers.redeem(code)
    await pump(clock, () => d.servers.view(room)?.joinWait === VOUCH_WAIT_TEXT, 'dave waits')
    expect(d.servers.myMembership(room)).toBe('invite')
    expect(memberOf(b, room, d.node.ik)?.waits).toBe(true)
    // An invite nobody is using yet doesn't wait for anyone: only Dave, who is joining, does.
    const idle = keyId(crypto.getRandomValues(new Uint8Array(32)))
    await emit(b)(room, 'add', () => ({ to: idle }))
    expect(memberOf(b, room, idle)?.m).toBe('invite')
    expect(memberOf(b, room, idle)?.waits).toBe(false)
    // Alice comes back and acknowledges Bob's invite: Dave is in.
    await a.node.setPaused(false)
    await pump(clock, () => d.servers.myMembership(room) === 'join', 'dave joined', 5_000, 60_000)
    expect(d.servers.view(room)?.joinWait).toBeNull()
    await pump(clock, () => memberOf(b, room, d.node.ik)?.m === 'join', 'bob sees dave')
  }, 90_000)
})

describe('removals that reach invitees (spec 8.2)', () => {
  test('removing Bob takes along whom he let in at the same time; Invite them again brings them back', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const a = await makeMember(hub, 'Alice', clock)
    const b = await makeMember(hub, 'Bob', clock)
    const c = await makeMember(hub, 'Carol', clock)
    const d = await makeMember(hub, 'Dave', clock)
    const room = await a.servers.create('Cascade')
    await joinWithCode(clock, a, room, b)
    await joinWithCode(clock, a, room, c)
    // Alice is away: Bob lets Dave in, Carol acknowledges it.
    await a.node.setPaused(true)
    const code = await b.servers.issueCode(room, 60 * 60_000)
    await d.servers.redeem(code)
    await pump(clock, () => d.servers.myMembership(room) === 'join', 'dave joined', 5_000, 60_000)
    // Meanwhile Alice, who heard of none of it, kicks Bob.
    await a.servers.kick(room, b.node.ik)
    await a.node.setPaused(false)
    await pump(
      clock,
      () => (a.servers.view(room)?.reached.length ?? 0) > 0,
      'alice told',
      5_000,
      60_000
    )
    expect(a.servers.view(room)?.reached).toEqual([{ by: b.node.ik, lost: [d.node.ik] }])
    expect(state(a, room, d.node.ik)).toBe('leave')
    await pump(clock, () => state(d, room, d.node.ik) === 'leave', 'dave out at his')
    await pump(clock, async () => !!(await d.store.room(room))?.cascade, 'dave notes the cascade')
    // Invite them again, refused for now (a limit): Dave stays in the note.
    const s = a.servers as unknown as { emit: (r: string, t: string, ...x: unknown[]) => unknown }
    const real = s.emit.bind(a.servers)
    s.emit = (r, t, ...x) => (t === 'add' ? Promise.reject(new Error('Later')) : real(r, t, ...x))
    expect(await failure(a.servers.inviteAgain(room, b.node.ik))).toBe('Later')
    s.emit = real
    expect(a.servers.view(room)?.reached).toEqual([{ by: b.node.ik, lost: [d.node.ik] }])
    // Invite them again: Dave, out by the cascade, joins again by himself.
    await a.servers.inviteAgain(room, b.node.ik)
    expect(a.servers.view(room)?.reached).toEqual([])
    await pump(clock, () => d.servers.myMembership(room) === 'join', 'dave back', 5_000, 60_000)
    await sees(clock, a, room, d.node.ik, 'join')
    // Bob was kicked (a removal of his own): his device records no cascade, so an invite back
    // would wait for him to accept it.
    await pump(clock, () => state(b, room, b.node.ik) === 'leave', 'bob out at his')
    expect((await b.store.room(room))?.cascade ?? null).toBeNull()
  }, 120_000)
})

describe('cut denies are listed to apply again (spec 9 rule 18, I2)', () => {
  test("a moderator's ban cut by a concurrent demotion comes back once the role does", async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const a = await makeMember(hub, 'Alice', clock)
    const b = await makeMember(hub, 'Bob', clock)
    const c = await makeMember(hub, 'Carol', clock)
    const room = await a.servers.create('Again')
    await joinWithCode(clock, a, room, b)
    await joinWithCode(clock, a, room, c)
    const role = await giveRole(a, room, b, 32)
    await pump(clock, () => ((b.servers.view(room)?.perms ?? 0) & 32) !== 0, 'bob may ban')
    // Bob bans Carol while Alice, not knowing, takes his role away.
    await a.node.setPaused(true)
    await b.servers.ban(room, c.node.ik, 'spam')
    await b.node.setPaused(true)
    await a.node.setPaused(false)
    await emit(a)(room, 'revoke', plan => ({ to: b.node.ik, role, seen: plan.seen ?? {} }), {
      to: b.node.ik,
    })
    await b.node.setPaused(false)
    await sees(clock, b, room, c.node.ik, 'join')
    expect(b.servers.view(room)?.reapply).toEqual([])
    // Alice gives the role back: Bob may ban again, and his cut ban is offered.
    await emit(a)(room, 'assign', () => ({ to: b.node.ik, role }))
    await pump(clock, () => (b.servers.view(room)?.reapply.length ?? 0) === 1, 'offered')
    expect(b.servers.view(room)?.reapply[0].t).toBe('ban')
    expect(b.servers.view(room)?.reapply[0].c.reason).toBe('spam')
    await b.servers.reapplyAll(room)
    expect(state(b, room, c.node.ik)).toBe('ban')
    const bans = await b.store.db.getAllFromIndex(
      'events',
      'room_type_sort',
      IDBKeyRange.bound([room, 'ban', ''], [room, 'ban', '\uffff'])
    )
    expect(bans.map(x => (x.wire.c as { reason?: string } | null)?.reason)).toEqual([
      'spam',
      'spam',
    ])
    expect(b.servers.view(room)?.reapply).toEqual([])
    await sees(clock, a, room, c.node.ik, 'ban')
  }, 120_000)
})

describe('devices (spec 3.9, 8.2)', () => {
  test('a copy whose history conflicts stops signing; set up as a new device it signs again', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const a = await makeMember(hub, 'Alice', clock)
    let b = await makeMember(hub, 'Bob', clock)
    const room = await a.servers.create('Copies')
    const ch = general(a, room)
    await joinWithCode(clock, a, room, b)
    await b.servers.send(room, { ch, body: 'one' })
    // Another copy of Bob's device (restored from a backup) signed the same seq.
    const twin = await signed(b, room, 'mark', {}, {})
    const dev = keyId(b.node.author()!.dk.pk)
    await emit(b)(room, 'mark', () => ({}))
    expect(await deliver(b, room, twin.wire, clock.now())).toBe('new')
    await pump(clock, () => b.servers.view(room)?.conflict === true, 'bob sees the conflict')
    expect(await failure(b.servers.send(room, { ch, body: 'two' }))).toBe(CONFLICT_TEXT)
    // A reload doesn't forget it.
    stopMember(b)
    b = await restart(hub, b, clock)
    expect(b.servers.view(room)?.conflict).toBe(true)
    expect(await failure(b.servers.send(room, { ch, body: 'two' }))).toBe(CONFLICT_TEXT)
    await b.servers.newDevice()
    const dev2 = keyId(b.node.author()!.dk.pk)
    expect(dev2).not.toBe(dev)
    expect(b.servers.view(room)?.conflict).toBe(false)
    await pump(
      clock,
      () => a.servers.sumOf(room).members[b.node.ik]?.devs.includes(dev2) === true,
      'alice takes the new device'
    )
    await b.servers.send(room, { ch, body: 'three' })
    // Both devices are Bob's now; recovery keeps only this one.
    expect(new Set(b.servers.myDevices().map(x => x.dk))).toEqual(new Set([dev, dev2]))
    await b.servers.recover([])
    await pump(
      clock,
      () => a.servers.sumOf(room).members[b.node.ik]?.devs.join() === dev2,
      'the old device is signed out'
    )
    expect(b.node.lostDevices()).toEqual([dev])
    // Contacts learn it too: a revocation without a successor.
    const revs = (await b.store.self())!.revocations
    expect(revs.some(r => r.dk === dev && r.successor === undefined)).toBe(true)
  }, 120_000)

  test('a copy that receives what its key signed elsewhere, past its own chain, stops signing', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const a = await makeMember(hub, 'Alice', clock)
    let b = await makeMember(hub, 'Bob', clock)
    const room = await a.servers.create('Copies')
    const ch = general(a, room)
    await joinWithCode(clock, a, room, b)
    // Another copy of Bob's device signs a message here first (no fork: the next seq).
    const other = await signed(b, room, 'msg', { body: 'from the other copy', ch })
    expect(await deliver(b, room, other.wire, clock.now())).toBe('new')
    expect(b.servers.view(room)?.conflict).toBe(true)
    expect(await failure(b.servers.send(room, { ch, body: 'mine' }))).toBe(CONFLICT_TEXT)
    // A reload doesn't forget it (the evidence is a continuation, no fork to find again).
    stopMember(b)
    b = await restart(hub, b, clock)
    expect(b.servers.view(room)?.conflict).toBe(true)
    expect(await failure(b.servers.send(room, { ch, body: 'mine' }))).toBe(CONFLICT_TEXT)
    // Its own events coming back change nothing.
    const c = await makeMember(hub, 'Carol', clock)
    await joinWithCode(clock, a, room, c)
    expect(c.servers.view(room)?.conflict).toBe(false)
  }, 60_000)

  // Bob's second device introduces itself (a device_add it signs, certified by his key), and
  // Carol acknowledges it, so it is trusted up to there.
  const secondDevice = async (clock: ManualClock, room: string, b: Member, all: Member[]) => {
    const other = newKeyPair()
    const dk = keyId(other.pk)
    const plan = await planOf(b, room, 'device_add')
    const add = buildEvent2(
      { ik: b.node.author()!.ik, dk: other },
      room,
      'device_add',
      'a',
      { dcert: signDeviceCert2(b.node.author()!.ik, room, b.node.ik, dk, plan.iprev) },
      { seq: 0, ap: plan.ap, ...(plan.iprev ? { iprev: plan.iprev } : {}) },
      plan.ts + 1
    )
    for (const m of all) expect(await deliver(m, room, add.wire as never, clock.now())).toBe('new')
    const ack = await emit(all[2])(room, 'mark', () => ({}))
    await pump(clock, async () => !!(await b.store.event(ack)), 'bob holds the acknowledgement')
    return { other, dk, add }
  }

  // An event of the stolen device, dated as early as its parents allow (a thief backdates).
  const stolen = (
    b: Member,
    other: ReturnType<typeof newKeyPair>,
    room: string,
    t: string,
    L: 'a' | 'c',
    c: Record<string, unknown>,
    seq: number,
    after: { id: string; wire: { ev: { ts: number } } }
  ) =>
    buildEvent2(
      { ik: b.node.author()!.ik, dk: other },
      room,
      t,
      L,
      c,
      L === 'a' ? { seq, ap: [after.id], aprev: after.id } : { seq, ap: [after.id], prev: [] },
      after.wire.ev.ts + 1
    )

  test("recovery signs a device out: what it signs later isn't offered to re-apply as ours", async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const a = await makeMember(hub, 'Alice', clock)
    const b = await makeMember(hub, 'Bob', clock)
    const c = await makeMember(hub, 'Carol', clock)
    const room = await a.servers.create('Recovered')
    await joinWithCode(clock, a, room, b)
    await joinWithCode(clock, a, room, c)
    const Kick = 4
    await giveRole(a, room, b, Kick)
    await pump(clock, () => ((b.servers.view(room)?.perms ?? 0) & Kick) !== 0, 'bob may kick')
    const all = [a, b, c]
    const { other, dk, add } = await secondDevice(clock, room, b, all)
    expect(await b.servers.recover([])).toEqual([])
    await pump(
      clock,
      () => a.servers.sumOf(room).members[b.node.ik]?.devs.includes(dk) === false,
      'signed out'
    )
    expect(b.node.lostDevices()).toEqual([dk])
    // The thief kicks Carol with it, positioned before the rotation.
    const carolDev = keyId(c.node.author()!.dk.pk)
    const kick = stolen(
      b,
      other,
      room,
      'kick',
      'a',
      { to: c.node.ik, seen: { [carolDev]: 1000 } },
      1,
      add
    )
    for (const m of all)
      expect(['new', 'dup']).toContain(await deliver(m, room, kick.wire as never, clock.now()))
    await clock.advance(10_000)
    expect(state(a, room, c.node.ik)).toBe('join')
    expect(b.servers.view(room)?.reapply).toEqual([])
    // A kept device of Bob's never hears of the recovery: the room itself says the device was
    // dropped, and what it signed past that isn't offered either.
    await (
      b.node as unknown as {
        writeSelf: (
          f: (cur: { revocations: { successor?: string }[] }) => Record<string, unknown>
        ) => Promise<void>
      }
    ).writeSelf(cur => ({
      ...cur,
      lost: [],
      revocations: cur.revocations.filter(r => r.successor !== undefined),
    }))
    expect(b.node.lostDevices()).toEqual([])
    await emit(a)(room, 'mark', () => ({}))
    await pump(clock, async () => !!(await b.store.event(kick.id)), 'bob holds the kick')
    await clock.advance(10_000)
    expect(b.servers.view(room)?.reapply).toEqual([])
  }, 120_000)

  test('a copy whose event arrives before its parents, past its own chain, stops signing once they do', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const a = await makeMember(hub, 'Alice', clock)
    const b = await makeMember(hub, 'Bob', clock)
    const c = await makeMember(hub, 'Carol', clock)
    const room = await a.servers.create('Parked')
    const ch = general(a, room)
    await joinWithCode(clock, a, room, b)
    await joinWithCode(clock, a, room, c)
    // Carol changes something Bob hasn't seen; another copy of Bob's device writes on top of it.
    await b.node.setPaused(true)
    await pump(clock, () => !b.servers.online(room), 'bob away')
    const x = await emit(c)(room, 'mark', () => ({}))
    const xw = (await c.store.event(x))!.wire
    const ts = (xw as unknown as { ev: { ts: number } }).ev.ts + 1
    const copy = await signed(b, room, 'msg', { body: 'from the other copy', ch }, { ap: [x], ts })
    expect(await deliver(b, room, copy.wire, clock.now())).toBe('quota')
    expect(b.servers.view(room)?.conflict).toBe(false)
    expect(await deliver(b, room, xw as never, clock.now())).toBe('new')
    expect(b.servers.view(room)?.conflict).toBe(true)
  }, 60_000)

  test('a lost device: the preview names our other devices added on top of what it did, which the rotation signs out', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const a = await makeMember(hub, 'Alice', clock)
    const b = await makeMember(hub, 'Bob', clock)
    const c = await makeMember(hub, 'Carol', clock)
    const room = await a.servers.create('Third')
    await joinWithCode(clock, a, room, b)
    await joinWithCode(clock, a, room, c)
    const all = [a, b, c]
    const { other, dk, add } = await secondDevice(clock, room, b, all)
    const trusted = clock.now()
    await clock.advance(60_000)
    // The stolen device makes a code; another device of Bob's introduces itself on top of it.
    const h = keyId(crypto.getRandomValues(new Uint8Array(32)))
    const code = stolen(b, other, room, 'code', 'a', { h, exp: clock.now() + 3_600_000 }, 1, add)
    for (const m of all)
      expect(['new', 'dup']).toContain(await deliver(m, room, code.wire as never, clock.now()))
    const third = newKeyPair()
    const plan = await planOf(b, room, 'device_add')
    const intro = buildEvent2(
      { ik: b.node.author()!.ik, dk: third },
      room,
      'device_add',
      'a',
      { dcert: signDeviceCert2(b.node.author()!.ik, room, b.node.ik, keyId(third.pk), plan.iprev) },
      { seq: 0, ap: [code.id], ...(plan.iprev ? { iprev: plan.iprev } : {}) },
      code.wire.ev.ts + 1
    )
    for (const m of all)
      expect(await deliver(m, room, intro.wire as never, clock.now())).toBe('new')
    const [p] = await b.servers.lostPreview(dk, trusted)
    expect(p.ap).not.toBeNull()
    expect(p.others).toEqual([keyId(third.pk)])
    expect(lostOthersText(1)).toContain('set it up again')
  }, 60_000)

  test('a lost device in none of our servers is revoked for contacts, and this browser keeps its key', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const a = await makeMember(hub, 'Alice', clock)
    const b = await makeMember(hub, 'Bob', clock)
    const room = await a.servers.create('Elsewhere')
    await joinWithCode(clock, a, room, b)
    const lost = keyId(newKeyPair().pk)
    const before = keyId(b.node.author()!.dk.pk)
    expect(await b.servers.disownDevice(lost, clock.now())).toEqual({
      late: [],
      failed: [],
      unsent: 0,
    })
    expect(keyId(b.node.author()!.dk.pk)).toBe(before)
    const revs = (await b.store.self())!.revocations
    expect(revs.some(r => r.dk === lost && r.successor === undefined)).toBe(true)
    expect(revs.some(r => r.dk === before)).toBe(false)
    expect(b.node.lostDevices()).toContain(lost)
  }, 60_000)

  test('a lost device: a fork of it already seen here is undone too', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const a = await makeMember(hub, 'Alice', clock)
    const b = await makeMember(hub, 'Bob', clock)
    const c = await makeMember(hub, 'Carol', clock)
    const room = await a.servers.create('Forked')
    await joinWithCode(clock, a, room, b)
    await joinWithCode(clock, a, room, c)
    const all = [a, b, c]
    const { other, dk, add } = await secondDevice(clock, room, b, all)
    const exp = clock.now() + 3_600_000
    const hash = () => keyId(crypto.getRandomValues(new Uint8Array(32)))
    const one = stolen(b, other, room, 'code', 'a', { h: hash(), exp }, 1, add)
    for (const m of all)
      expect(['new', 'dup']).toContain(await deliver(m, room, one.wire as never, clock.now()))
    const ack = await emit(c)(room, 'mark', () => ({}))
    await pump(clock, async () => !!(await b.store.event(ack)), 'bob holds the acknowledgement')
    const trusted = clock.now()
    await clock.advance(60_000)
    // The same seq signed twice: evidence of a fork at it.
    const twin = stolen(b, other, room, 'code', 'a', { h: hash(), exp }, 1, add)
    for (const m of all) await deliver(m, room, twin.wire as never, clock.now())
    await pump(clock, () => b.servers.sumOf(room).forks.includes(dk), 'bob sees the fork')
    const [p] = await b.servers.lostPreview(dk, trusted)
    expect(p.seq).toBe(0)
    expect(p.acts.map(x => x.id)).toContain(one.id)
  }, 60_000)

  test('a lost device: what it did after its last acknowledged event is undone, however it dates it; this browser keeps its work', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const a = await makeMember(hub, 'Alice', clock)
    const b = await makeMember(hub, 'Bob', clock)
    const c = await makeMember(hub, 'Carol', clock)
    const room = await a.servers.create('Lost')
    const ch = general(a, room)
    await joinWithCode(clock, a, room, b)
    await joinWithCode(clock, a, room, c)
    const Kick = 4
    await giveRole(a, room, b, Kick)
    await pump(clock, () => ((b.servers.view(room)?.perms ?? 0) & Kick) !== 0, 'bob may kick')
    const all = [a, b, c]
    const { other, dk, add } = await secondDevice(clock, room, b, all)
    const trusted = clock.now()
    await clock.advance(60_000)
    // Then it is stolen: an invite code, a kick of Carol and a message, each dated before the
    // cut-off.
    const h = keyId(crypto.getRandomValues(new Uint8Array(32)))
    const code = stolen(b, other, room, 'code', 'a', { h, exp: clock.now() + 3_600_000 }, 1, add)
    const carolDev = keyId(c.node.author()!.dk.pk)
    const kick = stolen(
      b,
      other,
      room,
      'kick',
      'a',
      { to: c.node.ik, seen: { [carolDev]: 1000 } },
      2,
      code
    )
    const msg = stolen(b, other, room, 'msg', 'c', { body: 'not me', ch }, 3, kick)
    expect(code.wire.ev.ts).toBeLessThan(trusted)
    for (const m of all)
      for (const e of [code, kick, msg])
        expect(['new', 'dup']).toContain(await deliver(m, room, e.wire as never, clock.now()))
    expect(state(a, room, c.node.ik)).toBe('leave')
    // Meanwhile this browser goes on: a message and an invite code on top of it.
    await b.servers.send(room, { ch, body: 'still mine' })
    await b.servers.issueCode(room, 60 * 60_000)
    const mineCode = Object.entries(b.servers.sumOf(room).codes).find(([id]) => id !== code.id)?.[0]
    expect(mineCode).not.toBeUndefined()
    const [p] = await b.servers.lostPreview(dk, trusted)
    expect(p.room).toBe(room)
    expect(p.acts.map(x => x.t)).toEqual(['code', 'kick'])
    expect(p.content).toBe(1)
    expect(p.resign).toEqual([])
    expect(Object.keys(p.at).sort()).toEqual([code.id, kick.id].sort())
    const before = keyId(b.node.author()!.dk.pk)
    // A first try fails in the room (a limit, say): the key it made stays for the retry.
    const s = b.servers as unknown as { emit: (r: string, t: string, ...x: unknown[]) => unknown }
    const real = s.emit.bind(b.servers)
    s.emit = (r, t, ...x) =>
      t === 'primary_rotate' ? Promise.reject(new Error('Try again later')) : real(r, t, ...x)
    const first = await b.servers.disownDevice(dk, trusted)
    s.emit = real
    expect(first.failed.map(f => f.room)).toEqual([room])
    const made = keyId(b.node.author()!.dk.pk)
    expect(made).not.toBe(before)
    expect(await b.servers.disownDevice(dk, trusted)).toEqual({ late: [], failed: [], unsent: 0 })
    const fresh = keyId(b.node.author()!.dk.pk)
    expect(fresh).toBe(made)
    for (const m of [a, c])
      await pump(
        clock,
        () => m.servers.sumOf(room).members[b.node.ik]?.devs.join() === fresh,
        `${m.name} keeps only the new key`
      )
    await sees(clock, a, room, c.node.ik, 'join')
    const codes = Object.keys(a.servers.sumOf(room).codes)
    expect(codes).not.toContain(code.id)
    expect(codes).toContain(mineCode)
    const shown = await bodies(a, room, ch)
    expect(shown).toContain('still mine')
    expect(shown).not.toContain('not me')
    // The thief's kick isn't offered back as ours.
    expect(b.servers.view(room)?.reapply).toEqual([])
    await b.servers.send(room, { ch, body: 'new key' })
    await pump(clock, async () => (await bodies(a, room, ch)).includes('new key'), 'a has it')
  }, 120_000)

  test("a lost device: this browser's own changes before the cut-off stay, though nobody acknowledged them", async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const a = await makeMember(hub, 'Alice', clock)
    const b = await makeMember(hub, 'Bob', clock)
    const c = await makeMember(hub, 'Carol', clock)
    const room = await a.servers.create('Own')
    const ch = general(a, room)
    await joinWithCode(clock, a, room, b)
    await joinWithCode(clock, a, room, c)
    const Kick = 4
    await giveRole(a, room, b, Kick)
    await pump(clock, () => ((b.servers.view(room)?.perms ?? 0) & Kick) !== 0, 'bob may kick')
    const dk = keyId(b.node.author()!.dk.pk)
    // Bob kicks Carol while nobody is around to acknowledge it.
    await a.node.setPaused(true)
    await c.node.setPaused(true)
    await pump(clock, () => !b.servers.online(room), 'bob alone')
    await b.servers.kick(room, c.node.ik)
    await clock.advance(60_000)
    const t = clock.now()
    await clock.advance(60_000)
    // A copy of this browser goes on with that key, and this browser moves to a new one.
    const copy = await signed(b, room, 'msg', { body: 'from the copy', ch })
    await b.servers.newDevice()
    await a.node.setPaused(false)
    await sees(clock, a, room, c.node.ik, 'leave')
    expect(await deliver(a, room, copy.wire, clock.now())).toBe('new')
    expect(await deliver(b, room, copy.wire, clock.now())).toBe('new')
    const [p] = await b.servers.lostPreview(dk, t)
    expect(p.acts).toEqual([])
    expect(p.content).toBe(1)
    expect(await b.servers.disownDevice(dk, t)).toEqual({ late: [], failed: [], unsent: 0 })
    // Lost after this browser moved from it: both revocations count, and it is lost.
    expect(b.node.lostDevices()).toContain(dk)
    const fresh = keyId(b.node.author()!.dk.pk)
    await pump(
      clock,
      () => a.servers.sumOf(room).members[b.node.ik]?.devs.join() === fresh,
      'alice keeps only the new key'
    )
    await pump(
      clock,
      async () => !(await bodies(a, room, ch)).includes('from the copy'),
      'the copy is undone'
    )
    await clock.advance(30_000)
    expect(state(a, room, c.node.ik)).toBe('leave')
    expect(b.servers.view(room)?.reapply).toEqual([])
  }, 120_000)

  test("a lost device: this browser's key that came after the cut-off can't be kept, so what of its work still holds is signed again", async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const a = await makeMember(hub, 'Alice', clock)
    const b = await makeMember(hub, 'Bob', clock)
    const c = await makeMember(hub, 'Carol', clock)
    const room = await a.servers.create('Lost again')
    const ch = general(a, room)
    await joinWithCode(clock, a, room, b)
    await joinWithCode(clock, a, room, c)
    const all = [a, b, c]
    const k1 = keyId(b.node.author()!.dk.pk)
    const { other, dk, add } = await secondDevice(clock, room, b, all)
    const trusted = clock.now()
    await clock.advance(60_000)
    const h = keyId(crypto.getRandomValues(new Uint8Array(32)))
    const code = stolen(b, other, room, 'code', 'a', { h, exp: clock.now() + 3_600_000 }, 1, add)
    for (const m of all)
      expect(['new', 'dup']).toContain(await deliver(m, room, code.wire as never, clock.now()))
    // This browser moved to a new key after the cut-off, and wrote with it.
    await b.servers.newDevice()
    const k2 = keyId(b.node.author()!.dk.pk)
    await pump(
      clock,
      () => a.servers.sumOf(room).members[b.node.ik]?.devs.includes(k2) === true,
      'k2'
    )
    await b.servers.send(room, { ch, body: 'from k2' })
    await pump(clock, async () => (await bodies(a, room, ch)).includes('from k2'), 'a has it')
    // And an invite code: an ACL change the rotation's race with k2 cuts.
    await b.servers.issueCode(room, 60 * 60_000)
    const k2code = Object.entries(b.servers.sumOf(room).codes).find(
      ([id, x]) => id !== code.id && x.a === b.node.ik
    )!
    const k2h = k2code[1].h
    await pump(clock, () => !!a.servers.sumOf(room).codes[k2code[0]], 'a has the code')
    // A second message the owner redacts, and a second code she revokes: neither comes back.
    const gone = (await b.servers.send(room, { ch, body: 'redacted from k2' })) as string
    await pump(clock, async () => !!(await a.store.event(gone)), 'a has the second message')
    await a.servers.redact(room, gone)
    await b.servers.issueCode(room, 60 * 60_000)
    const k2code2 = Object.entries(b.servers.sumOf(room).codes).find(
      ([id, x]) => id !== code.id && id !== k2code[0] && x.a === b.node.ik
    )!
    await pump(clock, () => !!a.servers.sumOf(room).codes[k2code2[0]], 'a has the second code')
    await a.servers.revokeCode(room, k2code2[1].h)
    await pump(
      clock,
      async () =>
        !b.servers.sumOf(room).codes[k2code2[0]] &&
        !(await bodies(b, room, ch)).includes('redacted from k2'),
      'bob sees both undone'
    )
    const [p] = await b.servers.lostPreview(dk, trusted)
    // Exactly what is signed again: the code that still works.
    expect(p.resign.map(x => [x.id, x.t])).toEqual([[k2code[0], 'code']])
    expect(await b.servers.disownDevice(dk, trusted)).toEqual({ late: [], failed: [], unsent: 0 })
    const k3 = keyId(b.node.author()!.dk.pk)
    // The stolen device and k2 go (k2 came after the cut-off); the first key and the newest stay.
    await pump(
      clock,
      () =>
        [...(a.servers.sumOf(room).members[b.node.ik]?.devs ?? [])].sort().join() ===
        [k1, k3].sort().join(),
      'the first and the newest key'
    )
    await pump(
      clock,
      async () => (await bodies(a, room, ch)).filter(x => x === 'from k2').length === 1,
      'the message shows once, signed again'
    )
    expect(Object.keys(a.servers.sumOf(room).codes)).not.toContain(code.id)
    // The code k2 made still works: signed again from the newest key where it stopped counting.
    await pump(
      clock,
      () => Object.values(a.servers.sumOf(room).codes).some(x => x.h === k2h && x.a === b.node.ik),
      'the code made with k2 still counts'
    )
    await clock.advance(30_000)
    expect((await bodies(a, room, ch)).filter(x => x === 'from k2').length).toBe(1)
    expect(await bodies(a, room, ch)).not.toContain('redacted from k2')
    expect(Object.values(a.servers.sumOf(room).codes).some(x => x.h === k2code2[1].h)).toBe(false)
  }, 120_000)
})

describe('transfer (spec 3.8)', () => {
  test('every co-owner must approve; then everyone follows to the new copy with what it had', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    let a = await makeMember(hub, 'Alice', clock)
    const d = await makeMember(hub, 'Dora', clock)
    const b = await makeMember(hub, 'Bob', clock)
    const c = await makeMember(hub, 'Carol', clock)
    await a.node.addContact(await d.node.myCard())
    await pump(clock, () => d.node.contact(a.node.ik)?.state === 'incoming', 'request')
    await d.node.accept(a.node.ik)
    await pump(clock, () => a.node.contact(d.node.ik)?.state === 'mutual', 'mutual')
    const room = await createWith(clock, a, 'Old', [d])
    const ch = general(a, room)
    await joinWithCode(clock, a, room, b)
    await joinWithCode(clock, a, room, c)
    await a.servers.send(room, { ch, body: 'before' })
    await clock.advance(1_000)
    await c.servers.send(room, { ch, body: 'carol before' })
    await pump(clock, async () => (await bodies(b, room, ch)).length === 2, 'bob has both')
    const role = await giveRole(a, room, c, 32)
    const talk = (await a.servers.addChannel(room, 'talk', { kind: 'voice' })) as string
    const stranger = keyId(crypto.getRandomValues(new Uint8Array(32)))
    await a.servers.ban(room, stranger)
    await pump(clock, () => ((c.servers.view(room)?.perms ?? 0) & 32) !== 0, 'carol holds the role')
    const ask = async (m: Member, kind: 'take' | 'cosign') => {
      await pump(
        clock,
        () => m.servers.transferAsks().some(x => x.kind === kind),
        `${m.name} asked`,
        1_000
      )
      return m.servers.transferAsks().find(x => x.kind === kind)!
    }
    // Dora, a co-owner who never joined, declines: no transfer.
    let t = failure(a.servers.transfer(room, b.node.ik))
    void b.servers.answerTransfer((await ask(b, 'take')).key, true)
    const q = await ask(d, 'cosign')
    expect([q.to, q.name]).toEqual([b.node.ik, 'Old'])
    void d.servers.answerTransfer(q.key, false)
    expect(await t).toBe(CO_OWNER_DECLINED_TEXT)
    expect(a.servers.view(room)?.upgraded).toBe(false)
    // She approves.
    const preAp = c.servers.sumOf(room).heads
    t = failure(a.servers.transfer(room, b.node.ik))
    void b.servers.answerTransfer((await ask(b, 'take')).key, true)
    void d.servers.answerTransfer((await ask(d, 'cosign')).key, true)
    expect(await t).toBe('ok')
    expect(a.servers.view(room)?.upgraded).toBe(true)
    expect(await failure(a.servers.send(room, { ch, body: 'after' }))).not.toBe('ok')
    // No voice in the old copy any more.
    expect(a.servers.isVoiceChannel(room, talk)).toBe(false)
    // Everyone follows: Bob owns the new copy, Alice and Carol are members of it.
    await pump(clock, () => !!a.servers.view(room)?.next, 'alice follows', 1_000)
    const next = a.servers.view(room)!.next!
    // Within seconds: the new owner asks them to link once they are invited.
    const t0 = clock.now()
    for (const m of [a, b, c])
      await pump(
        clock,
        () => m.servers.myMembership(next) === 'join',
        `${m.name} in`,
        1_000,
        90_000
      )
    expect(clock.now() - t0).toBeLessThan(30_000)
    const s = b.servers.sumOf(next)
    expect(s.owners).toEqual([b.node.ik])
    expect(b.servers.view(next)?.prev).toBe(room)
    expect(general(b, next)).toBe(ch)
    // The voice channel moved over with its id, and works there.
    await pump(
      clock,
      () => b.servers.isVoiceChannel(next, talk),
      'the voice channel carried',
      1_000
    )
    expect(s.members[stranger]?.m).toBe('ban')
    await pump(
      clock,
      () => ((c.servers.view(next)?.perms ?? 0) & 32) !== 0,
      'carol has her role again',
      5_000,
      60_000
    )
    expect(Object.values(s.roles).map(r => r.bits)).toContain(32)
    expect(role).not.toBe('')
    // The old copy's messages show above the new one's, read-only.
    await c.servers.send(next, { ch, body: 'new' })
    const rows = async (m: Member) =>
      (await m.servers.loadChannel(next, ch)).messages
        .filter(x => !x.system)
        .map(x => [x.body, !!x.archived])
    await pump(clock, async () => (await rows(c)).length === 3, 'carol has the archive')
    // The archive brings no join and leave lines of the old copy.
    const shown = (await c.servers.loadChannel(next, ch)).messages
    expect(shown.filter(x => x.archived && x.system)).toEqual([])
    expect(shown.some(x => !x.archived && x.system)).toBe(true)
    expect(await rows(c)).toEqual([
      ['before', true],
      ['carol before', true],
      ['new', false],
    ])
    // The member list moved over as it was; one the new owner changed shows (spec 3.8 step 5).
    expect(a.servers.view(next)?.migrateDiff).toBeNull()
    const list = Object.entries(a.servers.sumOf(room).members)
      .filter(([ik, x]) => x.m === 'join' && ik !== c.node.ik)
      .map(([ik]) => ik)
    await emit(b)(next, 'migrate', () => ({ chunk: { kind: 'members', n: 0, of: 1, list } }))
    await pump(
      clock,
      () => a.servers.view(next)?.migrateDiff?.removed.join() === c.node.ik,
      'alice sees the changed list'
    )
    expect(a.servers.view(next)?.migrateDiff?.added).toEqual([])
    // Spec 3.8 step 6: a message put into the old copy after the transfer, at a position from
    // before it, doesn't show; nor does anything by someone the new copy bans.
    const late = await signed(c, room, 'msg', { body: 'late in the old copy', ch }, { ap: preAp })
    for (const m of [a, b]) await deliver(m, room, late.wire, clock.now())
    // Stored in the old copy, shown nowhere (the old copy shows only its archive too).
    expect(await a.store.event(late.id)).not.toBeUndefined()
    expect((await bodies(a, room, ch)).includes('late in the old copy')).toBe(false)
    expect((await rows(a)).map(x => x[0])).not.toContain('late in the old copy')
    await b.servers.ban(next, c.node.ik)
    await sees(clock, a, next, c.node.ik, 'ban')
    expect(await rows(a)).toEqual([
      ['before', true],
      ['new', false],
    ])
    // The old copy is out of the device flows: recovery leaves it alone.
    expect(a.servers.myDevices().flatMap(x => x.rooms)).not.toContain(room)
    expect(await a.servers.recover([])).toEqual([])
    // After a restart the changed list shows again (once the old copy is loaded).
    stopMember(a)
    a = await restart(hub, a, clock)
    await pump(
      clock,
      () => a.servers.view(next)?.migrateDiff?.removed.join() === c.node.ik,
      'alice sees the changed list again',
      1_000
    )
  }, 180_000)

  test('a transfer to a member we have no session with links to them first', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const a = await makeMember(hub, 'Alice', clock)
    const b = await makeMember(hub, 'Bob', clock)
    const room = await a.servers.create('Linked')
    await joinWithCode(clock, a, room, b)
    for (const s of a.node.readySessions(b.node.ik)) s.close('closed')
    expect(a.node.readySessions(b.node.ik)).toEqual([])
    const t = failure(a.servers.transfer(room, b.node.ik))
    await pump(clock, () => b.servers.transferAsks().length === 1, 'bob asked', 500)
    void b.servers.answerTransfer(b.servers.transferAsks()[0].key, true)
    expect(await t).toBe('ok')
  }, 60_000)

  test('leaving the archive changes nothing in the new copy: the member list is checked as the upgrade carried it', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const a = await makeMember(hub, 'Alice', clock)
    const b = await makeMember(hub, 'Bob', clock)
    const c = await makeMember(hub, 'Carol', clock)
    const room = await a.servers.create('Archive')
    await joinWithCode(clock, a, room, b)
    await joinWithCode(clock, a, room, c)
    const t = failure(a.servers.transfer(room, b.node.ik))
    await pump(clock, () => b.servers.transferAsks().length === 1, 'bob asked', 1_000)
    void b.servers.answerTransfer(b.servers.transferAsks()[0].key, true)
    expect(await t).toBe('ok')
    await pump(clock, () => !!a.servers.view(room)?.next, 'alice follows', 1_000)
    const next = a.servers.view(room)!.next!
    for (const m of [a, b, c])
      await pump(clock, () => m.servers.myMembership(next) === 'join', `${m.name} in`, 1_000)
    await pump(clock, () => b.servers.view(next)?.carry === null, 'carried over', 1_000)
    expect(a.servers.view(next)?.migrateDiff).toBeNull()
    await c.servers.leave(room)
    await pump(clock, () => state(a, room, c.node.ik) === 'leave', 'carol left the old copy')
    await emit(b)(next, 'mark', () => ({}))
    await clock.advance(10_000)
    expect(a.servers.view(next)?.migrateDiff).toBeNull()
  }, 90_000)

  // A transfer of `room` from a to b, everyone in the new copy and the carry-over done.
  const transferred = async (
    clock: ManualClock,
    room: string,
    a: Member,
    b: Member,
    all: Member[]
  ) => {
    const t = failure(a.servers.transfer(room, b.node.ik))
    await pump(clock, () => b.servers.transferAsks().length === 1, 'bob asked', 1_000)
    void b.servers.answerTransfer(b.servers.transferAsks()[0].key, true)
    expect(await t).toBe('ok')
    await pump(clock, () => !!a.servers.view(room)?.next, 'alice follows', 1_000)
    const next = a.servers.view(room)!.next!
    for (const m of all)
      await pump(clock, () => m.servers.myMembership(next) === 'join', `${m.name} in`, 1_000)
    return next
  }

  test('the old copy shows, counts and announces nothing injected at positions from before the upgrade', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const a = await makeMember(hub, 'Alice', clock)
    const b = await makeMember(hub, 'Bob', clock)
    const c = await makeMember(hub, 'Carol', clock)
    const room = await a.servers.create('Old')
    const ch = general(a, room)
    await joinWithCode(clock, a, room, b)
    await joinWithCode(clock, a, room, c)
    await giveRole(a, room, c, P.ManageMessages)
    await a.servers.send(room, { ch, body: 'before' })
    await pump(clock, async () => (await bodies(c, room, ch)).includes('before'), 'carol has it')
    const kept = (await a.servers.loadChannel(room, ch, { limit: 10 })).messages.find(
      m => m.body === 'before'
    )!
    await a.servers.pin(room, kept.id, true)
    await pump(clock, () => ((c.servers.view(room)?.perms ?? 0) & P.ManageMessages) !== 0, 'carol')
    const plan = await planOf(c, room, 'msg', 'c')
    const at = plan.ap
    const next = await transferred(clock, room, a, b, [a, b, c])
    await pump(clock, () => b.servers.view(next)?.carry === null, 'carried over', 1_000)
    await b.servers.ban(next, c.node.ik)
    await pump(clock, () => state(a, next, c.node.ik) === 'ban', 'alice sees the ban', 1_000)
    const arrivals: string[] = []
    a.servers.onArrive(x => arrivals.push(x.rec.id))
    const before = a.servers.view(room)!.chans[ch] ?? { unread: 0, pings: 0 }
    // Carol, banned in the new copy, writes in the old one at a position from before the upgrade.
    const spam = await signed(
      c,
      room,
      'msg',
      { body: '@Alice zebraspam in the old copy', ch, mentions: [a.node.ik] },
      { ap: at }
    )
    expect(await deliver(a, room, spam.wire, clock.now())).toBe('new')
    await clock.advance(1_000)
    expect(arrivals).toEqual([])
    const after = a.servers.view(room)!.chans[ch] ?? { unread: 0, pings: 0 }
    expect([after.unread, after.pings]).toEqual([before.unread, before.pings])
    expect(await bodies(a, room, ch)).toEqual(['before'])
    expect(await bodies(a, next, ch)).toEqual(['before'])
    // Nor is it a search hit, or shown by a jump to it.
    const q = {
      q: 'zebraspam',
      from: null,
      room: null,
      ch: null,
      hasFile: false,
      beforeTs: null,
      afterTs: null,
    }
    expect((await a.servers.search(q)).hits).toEqual([])
    expect(await a.servers.loadAround(room, ch, spam.id)).toBeNull()
    const ok = (await a.servers.search({ ...q, q: 'before' })).hits.map(h => h.m.body)
    expect(ok).toContain('before')
    // Nor pinned: Carol (Manage messages at that position) pins it there too.
    const pin = await signed(
      c,
      room,
      'pin',
      { target: spam.id, on: true, ch },
      { ap: at, seq: plan.seq + 2, cprev: spam.id }
    )
    expect(await deliver(a, room, pin.wire, clock.now())).toBe('new')
    await clock.advance(1_000)
    expect((await a.servers.loadPins(room, ch)).map(m => m.body)).toEqual(['before'])
  }, 120_000)

  test('a ban made at the same time as the transfer is offered to re-apply in the new copy (spec 3.8 step 7)', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const a = await makeMember(hub, 'Alice', clock)
    const b = await makeMember(hub, 'Bob', clock)
    const c = await makeMember(hub, 'Carol', clock)
    const d = await makeMember(hub, 'Dave', clock)
    const room = await a.servers.create('Step7')
    for (const m of [b, c, d]) await joinWithCode(clock, a, room, m)
    await giveRole(a, room, c, 32)
    await pump(clock, () => ((c.servers.view(room)?.perms ?? 0) & 32) !== 0, 'carol may ban')
    // Carol bans Dave while away: the transfer doesn't have it in its past.
    await c.node.setPaused(true)
    await pump(clock, () => !c.servers.online(room), 'carol away')
    await c.servers.ban(room, d.node.ik)
    const t = failure(a.servers.transfer(room, b.node.ik))
    await pump(clock, () => b.servers.transferAsks().length === 1, 'bob asked', 1_000)
    void b.servers.answerTransfer(b.servers.transferAsks()[0].key, true)
    expect(await t).toBe('ok')
    await c.node.setPaused(false)
    await pump(clock, () => !!c.servers.view(room)?.next, 'carol follows', 1_000)
    const next = c.servers.view(room)!.next!
    await pump(clock, () => c.servers.myMembership(next) === 'join', 'carol in', 1_000)
    await pump(
      clock,
      () => ((c.servers.view(next)?.perms ?? 0) & 32) !== 0,
      'carol has her role again',
      5_000,
      60_000
    )
    await pump(clock, () => state(c, next, d.node.ik) !== null, 'dave carried', 1_000)
    expect(state(c, next, d.node.ik)).not.toBe('ban')
    await pump(
      clock,
      () => c.servers.view(next)?.reapply.some(r => r.t === 'ban' && r.c.to === d.node.ik) === true,
      'offered',
      1_000
    )
    await c.servers.reapplyAll(next)
    expect(state(c, next, d.node.ik)).toBe('ban')
    expect(c.servers.view(next)?.reapply).toEqual([])
  }, 120_000)

  test('a demotion made at the same time as the transfer stays; a role change then is offered to re-apply (spec 3.8 step 7)', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const a = await makeMember(hub, 'Alice', clock)
    const b = await makeMember(hub, 'Bob', clock)
    const c = await makeMember(hub, 'Carol', clock)
    const d = await makeMember(hub, 'Dave', clock)
    const room = await a.servers.create('Demoted')
    for (const m of [b, c, d]) await joinWithCode(clock, a, room, m)
    await giveRole(a, room, c, 16, 5)
    const helper = await giveRole(a, room, d, 4 | 32, 1)
    await pump(clock, () => ((c.servers.view(room)?.perms ?? 0) & 16) !== 0, 'carol manages roles')
    await pump(clock, () => ((d.servers.view(room)?.perms ?? 0) & 4) !== 0, 'dave may kick')
    // Carol, away, takes Helper from Dave and Ban off Helper; Dave is away for the transfer too.
    await c.node.setPaused(true)
    await d.node.setPaused(true)
    await pump(clock, () => !c.servers.online(room), 'carol away')
    await c.servers.revokeRole(room, d.node.ik, helper)
    await c.servers.setRoleBit(room, helper, 32, false)
    const t = failure(a.servers.transfer(room, b.node.ik))
    await pump(clock, () => b.servers.transferAsks().length === 1, 'bob asked', 1_000)
    void b.servers.answerTransfer(b.servers.transferAsks()[0].key, true)
    expect(await t).toBe('ok')
    await c.node.setPaused(false)
    await pump(
      clock,
      () => !b.servers.sumOf(room).members[d.node.ik]?.roles.includes(helper),
      'bob holds the demotion',
      1_000
    )
    await d.node.setPaused(false)
    await pump(clock, () => !!c.servers.view(room)?.next, 'carol follows', 1_000)
    const next = c.servers.view(room)!.next!
    for (const m of [b, c, d])
      await pump(
        clock,
        () => m.servers.myMembership(next) === 'join',
        `${m.name} in`,
        5_000,
        90_000
      )
    await pump(clock, () => b.servers.view(next)?.carry === null, 'carried over', 5_000, 90_000)
    await pump(
      clock,
      () => ((c.servers.view(next)?.perms ?? 0) & 16) !== 0,
      'carol has her role again',
      5_000,
      60_000
    )
    await clock.advance(10_000)
    // The demotion stands in the new copy.
    expect(b.servers.sumOf(next).members[d.node.ik]?.roles ?? []).toEqual([])
    // Ban off Helper, made during the transfer: offered for the new copy's Helper.
    const newHelper = Object.entries(b.servers.sumOf(next).roles).find(([, r]) => r.pos === 1)![0]
    await pump(
      clock,
      () =>
        c.servers.view(next)?.reapply.some(r => r.t === 'role_bits' && r.c.role === newHelper) ===
        true,
      'offered',
      1_000
    )
    await c.servers.reapplyAll(next)
    expect((c.servers.sumOf(next).roles[newHelper].bits & 32) === 0).toBe(true)
  }, 120_000)

  // Carol, away, changes something while Alice transfers the server to Bob; Carol joins the new
  // copy once it is carried over. Roles: Helper at position 1 and Other at 2, both with Ban.
  const changedAway = async (
    name: string,
    change: (c: Member, room: string, helper: string) => Promise<unknown>
  ) => {
    const clock = new ManualClock()
    const hub = new Hub()
    const a = await makeMember(hub, 'Alice', clock)
    const b = await makeMember(hub, 'Bob', clock)
    const c = await makeMember(hub, 'Carol', clock)
    const room = await a.servers.create(name)
    for (const m of [b, c]) await joinWithCode(clock, a, room, m)
    await giveRole(a, room, c, 16, 5)
    const helper = await emit(a)(room, 'role_create', () => ({ pos: 1, bits: 32, name: 'Helper' }))
    const other = await emit(a)(room, 'role_create', () => ({ pos: 2, bits: 32, name: 'Other' }))
    await pump(
      clock,
      () => !!c.servers.sumOf(room).roles[other] && ((c.servers.view(room)?.perms ?? 0) & 16) !== 0,
      'carol manages roles'
    )
    await c.node.setPaused(true)
    await pump(clock, () => !c.servers.online(room), 'carol away')
    await change(c, room, helper)
    const t = failure(a.servers.transfer(room, b.node.ik))
    await pump(clock, () => b.servers.transferAsks().length === 1, 'bob asked', 1_000)
    void b.servers.answerTransfer(b.servers.transferAsks()[0].key, true)
    expect(await t).toBe('ok')
    await c.node.setPaused(false)
    await pump(clock, () => !!c.servers.view(room)?.next, 'carol follows', 1_000)
    const next = c.servers.view(room)!.next!
    await pump(clock, () => c.servers.myMembership(next) === 'join', 'carol in', 5_000, 90_000)
    await pump(clock, () => b.servers.view(next)?.carry === null, 'carried over', 5_000, 90_000)
    await pump(
      clock,
      () => ((c.servers.view(next)?.perms ?? 0) & 16) !== 0,
      'carol manages roles again',
      1_000
    )
    const made = (role: string) =>
      Object.entries(b.servers.sumOf(next).roles).find(([, r]) => r.name === role)![0]
    const offered = () => c.servers.view(next)?.reapply.filter(r => r.t === 'role_bits') ?? []
    return { clock, b, c, next, made, offered }
  }

  test('a role change made during a transfer is offered for the role made from it, after the new copy moved its roles', async () => {
    const { clock, b, c, next, made, offered } = await changedAway('Moved', (c, room, helper) =>
      c.servers.setRoleBit(room, helper, 32, false)
    )
    const [newHelper, newOther] = [made('Helper'), made('Other')]
    // Other takes the position Helper had.
    await b.servers.moveRole(next, newHelper, 3)
    await b.servers.moveRole(next, newOther, 1)
    await pump(
      clock,
      () => c.servers.sumOf(next).roles[newOther]?.pos === 1,
      'carol sees the move',
      1_000
    )
    await clock.advance(10_000)
    await pump(clock, () => offered().length > 0, 'offered', 1_000)
    const named = offered().map(r =>
      r.c.role === newHelper ? 'Helper' : r.c.role === newOther ? 'Other' : r.c.role
    )
    expect(named).toEqual(['Helper'])
    await c.servers.reapplyAll(next)
    const roles = c.servers.sumOf(next).roles
    expect([roles[newHelper].bits & 32, roles[newOther].bits & 32]).toEqual([0, 32])
  }, 120_000)

  test('a role change made during a transfer is not offered once the new copy deleted that role, not even for a new one just like it', async () => {
    const { clock, b, c, next, made, offered } = await changedAway('Deleted', (c, room, helper) =>
      c.servers.setRoleBit(room, helper, 32, false)
    )
    const newHelper = made('Helper')
    await pump(clock, () => offered().some(r => r.c.role === newHelper), 'offered', 1_000)
    await b.servers.deleteRole(next, newHelper)
    // The owner makes a role with Helper's position, bits and name, after the carry-over.
    const fresh = await emit(b)(next, 'role_create', () => ({ pos: 1, bits: 32, name: 'Helper' }))
    await pump(
      clock,
      () => !c.servers.sumOf(next).roles[newHelper] && !!c.servers.sumOf(next).roles[fresh],
      'carol sees both',
      1_000
    )
    await clock.advance(10_000)
    expect(offered()).toEqual([])
  }, 120_000)

  test('a lockdown made during a transfer (@everyone may no longer send) is offered and applied in the new copy', async () => {
    const { c, next, clock } = await changedAway('Locked', (c, room) =>
      c.servers.setRoleBit(room, EVERYONE, P.SendMessages, false)
    )
    expect((c.servers.view(next)!.everyone & P.SendMessages) !== 0).toBe(true)
    await pump(
      clock,
      () =>
        c.servers.view(next)?.reapply.some(r => r.t === 'role_bits' && r.c.role === EVERYONE) ===
        true,
      'offered',
      1_000
    )
    await c.servers.reapplyAll(next)
    await pump(
      clock,
      () => (c.servers.view(next)!.everyone & P.SendMessages) === 0,
      'locked',
      1_000
    )
  }, 120_000)

  test('a role taken and given back during a transfer is not offered to take again', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const a = await makeMember(hub, 'Alice', clock)
    const b = await makeMember(hub, 'Bob', clock)
    const c = await makeMember(hub, 'Carol', clock)
    const d = await makeMember(hub, 'Dave', clock)
    const room = await a.servers.create('Undone')
    for (const m of [b, c, d]) await joinWithCode(clock, a, room, m)
    await giveRole(a, room, c, 16, 5)
    const helper = await giveRole(a, room, d, 4, 1)
    await pump(clock, () => ((c.servers.view(room)?.perms ?? 0) & 16) !== 0, 'carol manages roles')
    await pump(
      clock,
      () => c.servers.sumOf(room).members[d.node.ik]?.roles.includes(helper) === true,
      'carol sees dave helper'
    )
    await c.node.setPaused(true)
    await pump(clock, () => !c.servers.online(room), 'carol away')
    await c.servers.revokeRole(room, d.node.ik, helper)
    await c.servers.assignRole(room, d.node.ik, helper)
    const t = failure(a.servers.transfer(room, b.node.ik))
    await pump(clock, () => b.servers.transferAsks().length === 1, 'bob asked', 1_000)
    void b.servers.answerTransfer(b.servers.transferAsks()[0].key, true)
    expect(await t).toBe('ok')
    await c.node.setPaused(false)
    await pump(clock, () => !!c.servers.view(room)?.next, 'carol follows', 1_000)
    const next = c.servers.view(room)!.next!
    for (const m of [b, c, d])
      await pump(
        clock,
        () => m.servers.myMembership(next) === 'join',
        `${m.name} in`,
        5_000,
        90_000
      )
    await pump(clock, () => b.servers.view(next)?.carry === null, 'carried over', 5_000, 90_000)
    const newHelper = Object.entries(b.servers.sumOf(next).roles).find(([, r]) => r.pos === 1)![0]
    await pump(
      clock,
      () =>
        c.servers.sumOf(next).members[d.node.ik]?.roles.includes(newHelper) === true &&
        ((c.servers.view(next)?.perms ?? 0) & 16) !== 0,
      'dave has it again',
      5_000,
      60_000
    )
    await clock.advance(10_000)
    expect(c.servers.view(next)!.reapply.filter(r => r.t === 'revoke')).toEqual([])
  }, 120_000)

  test('older messages the new owner never held stay in the archive', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const a = await makeMember(hub, 'Alice', clock)
    const b = await makeMember(hub, 'Bob', clock)
    const c = await makeMember(hub, 'Carol', clock)
    const room = await a.servers.create('Joined')
    const ch = general(a, room)
    await a.servers.setHistory(room, 'joined')
    await joinWithCode(clock, a, room, c)
    await c.servers.send(room, { ch, body: 'carol early' })
    await pump(clock, async () => (await bodies(a, room, ch)).includes('carol early'), 'sent')
    // A channel Bob can't view, where only Alice and Carol write.
    const mods = await a.servers.addChannel(room, 'mods', { restrictView: true })
    await a.servers.setOverwrite(room, mods, `u:${c.node.ik}`, P.ViewChannel, 0)
    await pump(clock, () => !!c.servers.view(room)?.channels.some(x => x.id === mods), 'carol')
    await c.servers.send(room, { ch: mods, body: 'carol in mods' })
    await pump(clock, async () => (await bodies(a, room, mods)).length === 1, 'mods sent')
    await joinWithCode(clock, a, room, b)
    await a.servers.send(room, { ch, body: 'alice later' })
    await pump(clock, async () => (await bodies(b, room, ch)).includes('alice later'), 'bob has')
    // Bob holds nothing of Carol's: her messages are older than his join, or in a channel he
    // can't view.
    expect(await bodies(b, room, ch)).toEqual(['alice later'])
    const next = await transferred(clock, room, a, b, [a, b, c])
    await pump(clock, () => b.servers.view(next)?.carry === null, 'carried over', 1_000)
    // Carol's allow row comes along: she sees #mods in the new copy, with its archive.
    await pump(
      clock,
      () => !!c.servers.view(next)?.channels.some(x => x.id === mods),
      'mods carried',
      1_000
    )
    for (const m of [a, c])
      expect(await bodies(m, next, ch)).toEqual(['carol early', 'alice later'])
    expect(await bodies(c, next, mods)).toEqual(['carol in mods'])
  }, 120_000)

  const updateRoom = (m: Member) =>
    (
      m.servers as unknown as {
        updateRoom: (room: string, f: (r: Record<string, unknown>) => unknown) => Promise<void>
      }
    ).updateRoom.bind(m.servers)

  test("resuming the carry-over doesn't undo what changed in the new copy since", async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const a = await makeMember(hub, 'Alice', clock)
    let b = await makeMember(hub, 'Bob', clock)
    const c = await makeMember(hub, 'Carol', clock)
    const d = await makeMember(hub, 'Dan', clock)
    const room = await a.servers.create('Resume')
    for (const m of [b, c, d]) await joinWithCode(clock, a, room, m)
    await giveRole(a, room, c, 32, 1)
    await giveRole(a, room, c, 4, 2)
    await pump(
      clock,
      () => ((c.servers.view(room)?.perms ?? 0) & 36) === 36,
      'carol has both roles'
    )
    const preAp = a.servers.sumOf(room).heads
    const next = await transferred(clock, room, a, b, [a, b, c, d])
    await pump(clock, () => b.servers.view(next)?.carry === null, 'carried over', 1_000)
    await pump(
      clock,
      () => (b.servers.sumOf(next).members[c.node.ik]?.roles.length ?? 0) === 2,
      'carol has her roles back',
      1_000
    )
    // Since then: Dan is kicked, one role is deleted and the other taken from Carol.
    const [r1, r2] = b.servers.sumOf(next).members[c.node.ik]!.roles
    await b.servers.kick(next, d.node.ik)
    await emit(b)(next, 'role_del', () => ({ role: r1 }))
    await emit(b)(next, 'revoke', p => ({ to: c.node.ik, role: r2, seen: p.seen ?? {} }), {
      to: c.node.ik,
    })
    // And a moderator's ban put into the old copy after the transfer, at a position from before it.
    const seen = (await planOf(c, room, 'ban', 'a', d.node.ik)).seen ?? {}
    const late = await signed(c, room, 'ban', { to: d.node.ik, seen }, { ap: preAp })
    expect(await deliver(b, room, late.wire, clock.now())).toBe('new')
    // The carry-over runs again (it stopped before it was done, and the user tries again).
    await updateRoom(b)(next, cur => ({
      ...cur,
      carry: { ...(cur.carry as object), state: 'failed', why: 'x' },
    }))
    stopMember(b)
    b = await restart(hub, b, clock)
    b.servers.retryCarry(next)
    await pump(clock, () => b.servers.view(next)?.carry === null, 'done again', 1_000)
    await emit(a)(next, 'mark', () => ({}))
    await clock.advance(30_000)
    const s = b.servers.sumOf(next)
    expect(s.members[d.node.ik]?.m).toBe('leave')
    expect(Object.keys(s.roles)).toEqual([r2])
    expect(s.members[c.node.ik]?.roles).toEqual([])
  }, 120_000)

  test('members acknowledge the carry-over as long as it runs, and stop once it is done', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const a = await makeMember(hub, 'Alice', clock)
    const b = await makeMember(hub, 'Bob', clock)
    const c = await makeMember(hub, 'Carol', clock)
    const room = await a.servers.create('Long')
    await joinWithCode(clock, a, room, b)
    await joinWithCode(clock, a, room, c)
    for (let i = 0; i < 60; i++) {
      await a.servers.addChannel(room, `room-${i}`)
      if (i % 10 === 9) {
        const ack = await emit(c)(room, 'mark', () => ({}))
        await pump(clock, async () => !!(await a.store.event(ack)), 'alice holds it', 1_000)
      }
    }
    const t = failure(a.servers.transfer(room, b.node.ik))
    await pump(clock, () => b.servers.transferAsks().length === 1, 'bob asked', 1_000)
    void b.servers.answerTransfer(b.servers.transferAsks()[0].key, true)
    expect(await t).toBe('ok')
    await pump(clock, () => !!a.servers.view(room)?.next, 'alice follows', 500)
    const next = a.servers.view(room)!.next!
    // Alice and Carol join, then go away while it runs: it waits for them.
    for (const m of [a, c])
      await pump(clock, () => m.servers.myMembership(next) === 'join', `${m.name} in`, 500)
    for (const m of [a, c]) await m.node.setPaused(true)
    await pump(clock, () => b.servers.view(next)?.carry?.state === 'waiting', 'it waits', 5_000)
    expect(b.servers.view(next)?.carry?.why).toBe(LONE_TEXT)
    // When they come back they joined long ago (a big carry-over outlasts an hour): they
    // acknowledge all the same, and it finishes.
    for (const m of [a, c]) {
      await updateRoom(m)(next, cur => ({ ...cur, since: (cur.since as number) - 2 * 3_600_000 }))
      await m.node.setPaused(false)
    }
    await pump(clock, () => b.servers.view(next)?.carry === null, 'carried over', 5_000, 120_000)
    expect(b.servers.view(next)!.channels.length).toBe(61)
    // Done: the owner's next changes are acknowledged by nobody for the carry-over's sake.
    await clock.advance(120_000)
    const before = (await a.store.outbox(next)).length
    for (let i = 0; i < 22; i++) await b.servers.addChannel(next, `more-${i}`).catch(() => {})
    await clock.advance(120_000)
    expect((await a.store.outbox(next)).length).toBe(before)
  }, 240_000)

  test('roles are given back once each, however many runs of it overlap', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const a = await makeMember(hub, 'Alice', clock)
    const b = await makeMember(hub, 'Bob', clock)
    const c = await makeMember(hub, 'Carol', clock)
    const room = await a.servers.create('Roles')
    await joinWithCode(clock, a, room, b)
    await joinWithCode(clock, a, room, c)
    await giveRole(a, room, c, 32, 1)
    await giveRole(a, room, c, 4, 2)
    await pump(clock, () => ((c.servers.view(room)?.perms ?? 0) & 36) === 36, 'carol has both')
    const next = await transferred(clock, room, a, b, [a, b, c])
    await pump(clock, () => b.servers.view(next)?.carry === null, 'carried over', 1_000)
    const held = () => b.servers.sumOf(next).members[c.node.ik]?.roles ?? []
    await pump(clock, () => held().length === 2, 'carol has her roles back', 1_000)
    // Count the grants from here on.
    const srv = b.servers as unknown as {
      emit: (...x: unknown[]) => Promise<string>
      carryRoles: (room: string) => Promise<void>
    }
    let assigns = 0
    const emitNow = srv.emit.bind(b.servers)
    srv.emit = (...x: unknown[]) => {
      if (x[1] === 'assign') assigns++
      return emitNow(...x)
    }
    // Taken from her (so they stay taken), then as if never given: three runs of it at once.
    const roles = [...held()]
    for (const role of roles)
      await emit(b)(next, 'revoke', p => ({ to: c.node.ik, role, seen: p.seen ?? {} }), {
        to: c.node.ik,
      })
    await pump(clock, () => held().length === 0, 'taken', 1_000)
    await clock.advance(10_000)
    expect(held()).toEqual([])
    await updateRoom(b)(next, cur => ({
      ...cur,
      carry: { ...(cur.carry as object), given: [] },
    }))
    await Promise.all([1, 2, 3].map(() => srv.carryRoles(next).catch(() => {})))
    await pump(clock, () => held().length === 2, 'given back', 1_000)
    await clock.advance(10_000)
    expect(assigns).toBe(2)
    expect(held().length).toBe(2)
  }, 120_000)

  test("a follower gets the new copy from the old copy's members while the new owner is away", async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const a = await makeMember(hub, 'Alice', clock)
    const b = await makeMember(hub, 'Bob', clock)
    const c = await makeMember(hub, 'Carol', clock)
    const d = await makeMember(hub, 'Dan', clock)
    await contacts(clock, a, b)
    const room = await a.servers.create('Away')
    for (const m of [b, c, d]) await joinWithCode(clock, a, room, m)
    // Dan is away for the transfer, and Bob goes once he has invited everyone and Carol holds it.
    await d.node.setPaused(true)
    const t = failure(a.servers.transfer(room, b.node.ik))
    await pump(clock, () => b.servers.transferAsks().length === 1, 'bob asked', 500)
    void b.servers.answerTransfer(b.servers.transferAsks()[0].key, true)
    expect(await t).toBe('ok')
    await pump(clock, () => !!b.servers.view(room)?.next, 'bob follows', 500)
    const next = b.servers.view(room)!.next!
    const invited = (m: Member) =>
      m.servers.view(next)?.members.some(x => x.ik === d.node.ik && x.m === 'invite') === true
    for (const m of [a, c])
      await pump(clock, () => m.servers.myMembership(next) === 'join', `${m.name} in`, 1_000)
    await pump(clock, () => invited(c), 'carol holds dan invited', 1_000)
    await b.node.setPaused(true)
    await d.node.setPaused(false)
    await pump(clock, () => d.servers.myMembership(next) === 'join', 'dan in', 1_000, 60_000)
  }, 120_000)

  test('once in the new copy, the old one keeps a link or two; the new one links with old members for a while', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const all: Member[] = []
    for (const n of ['Alice', 'Bob', 'Carol', 'Dan', 'Erin', 'Fay'])
      all.push(await makeMember(hub, n, clock))
    const [a, b] = all
    const room = await a.servers.create('Budget')
    for (const m of all.slice(1)) await joinWithCode(clock, a, room, m)
    await pump(
      clock,
      () => all.some(m => m.servers.sync.linksOf(room).length > 2),
      'the old copy linked',
      1_000
    )
    // Fay is away: only invited in the new copy.
    await all[5].node.setPaused(true)
    const next = await transferred(clock, room, a, b, all.slice(0, 5))
    const fay = all[5].node.ik
    await pump(clock, () => state(a, next, fay) === 'invite', 'fay invited', 1_000)
    const live = all.slice(0, 5)
    await pump(
      clock,
      () => live.every(m => m.servers.sync.linksOf(room).length <= 2),
      'old copy links trimmed',
      5_000
    )
    for (const m of live) expect(m.servers.sync.linksOf(next).length).toBeGreaterThan(0)
    type Wb = { linkCandidates(r: string): string[]; joinedOthers(r: string): string[] }
    const wa = a.servers as unknown as Wb
    expect(wa.joinedOthers(next)).not.toContain(fay)
    expect(wa.linkCandidates(next)).toContain(fay)
    await b.servers.ban(next, fay)
    await pump(clock, () => state(a, next, fay) === 'ban', 'alice sees the ban', 1_000)
    expect(wa.linkCandidates(next)).not.toContain(fay)
  }, 120_000)

  test('an old copy whose links all go to members who moved still lets in one who was away', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    // No re-sampling, which could free a link by chance.
    const still = { servers: { gossip: { resampleMs: 24 * 60 * 60_000 } } }
    const a = await makeMember(hub, 'Alice', clock, still)
    const b = await makeMember(hub, 'Bob', clock, still)
    const c = await makeMember(hub, 'Carol', clock, still)
    const d = await makeMember(hub, 'Dave', clock)
    const room = await a.servers.create('Away')
    for (const m of [b, c, d]) await joinWithCode(clock, a, room, m)
    await d.node.setPaused(true)
    const moved = [a, b, c]
    const next = await transferred(clock, room, a, b, moved)
    // Each who moved keeps two links in the old copy, both with the other two.
    await pump(
      clock,
      () => moved.every(m => m.servers.sync.linksOf(room).length === 2),
      'old copy links full',
      1_000
    )
    await d.node.setPaused(false)
    // At his first contact, not once a link frees up by chance.
    const back = clock.now()
    await pump(
      clock,
      () => !!d.servers.view(room)?.next || clock.now() - back > 30_000,
      'dave hears',
      1_000
    )
    expect(d.servers.view(room)?.next).toBe(next)
    for (const m of moved) expect(m.servers.sync.linksOf(room).length).toBeLessThanOrEqual(2)
  }, 120_000)

  test('members who never join the new copy hold an old-copy link only for a while', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    // A minute for the window (and for preferring who let us in), to keep the test short.
    const short = { servers: { gossip: { preferMs: 60_000 } } }
    const a = await makeMember(hub, 'Alice', clock, short)
    const b = await makeMember(hub, 'Bob', clock, short)
    // Clients that never take the new copy.
    const stay: Member[] = []
    for (const n of ['Xena', 'Yuri', 'Zoe', 'Dave']) {
      const m = await makeMember(hub, n, clock)
      ;(m.servers as unknown as { follow: () => Promise<void> }).follow = async () => {}
      stay.push(m)
    }
    const [x, , z, d] = stay
    const room = await a.servers.create('Stay')
    for (const m of [b, ...stay]) await joinWithCode(clock, a, room, m)
    await d.node.setPaused(true)
    const next = await transferred(clock, room, a, b, [a, b])
    expect(x.servers.myMembership(next)).toBeNull()
    // Past the window those links count like any other: back to two each.
    const end = clock.now() + 2 * 60_000
    await pump(clock, () => clock.now() >= end, 'the window', 5_000)
    for (const m of [a, b]) expect(m.servers.sync.linksOf(room).length).toBeLessThanOrEqual(2)
    // Dave, away until now, takes one of them at his first contact.
    await d.node.setPaused(false)
    const back = clock.now()
    const linked = () =>
      [a, b].some(m => m.servers.sync.linksOf(room).some(l => l.ik === d.node.ik))
    await pump(clock, () => linked() || clock.now() - back > 30_000, 'dave linked', 1_000)
    expect(linked()).toBe(true)
    // Someone banned in the new copy is no longer needed in the old one.
    type Wg = { deps: { needs: (r: string, ik: string) => boolean } }
    const needs = (a.servers.gossip as unknown as Wg).deps.needs
    expect(needs(room, z.node.ik)).toBe(true)
    await b.servers.ban(next, z.node.ik)
    await pump(clock, () => state(a, next, z.node.ik) === 'ban', 'alice sees the ban', 1_000)
    expect(needs(room, z.node.ik)).toBe(false)
  }, 240_000)

  test("members acknowledge only the new owner's events: others' marks never set them off", async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const a = await makeMember(hub, 'Alice', clock)
    const b = await makeMember(hub, 'Bob', clock)
    const c = await makeMember(hub, 'Carol', clock)
    // Fewer than the 8 links a member keeps per server: everyone links with everyone.
    const rest: Member[] = []
    for (let i = 0; i < 5; i++) rest.push(await makeMember(hub, `M${i}`, clock))
    await contacts(clock, a, b)
    const room = await a.servers.create('Crowd')
    for (const m of [b, c, ...rest]) await joinWithCode(clock, a, room, m)
    for (let i = 0; i < 30; i++) {
      await a.servers.addChannel(room, `room-${i}`)
      if (i % 10 === 9) {
        const ack = await emit(c)(room, 'mark', () => ({}))
        await pump(clock, async () => !!(await a.store.event(ack)), 'alice holds it', 1_000)
      }
    }
    // Bob's carry-over stops partway (his changes refused as if nobody acknowledged them), and he
    // stays online, so all he posted reaches everyone.
    const bs = b.servers as unknown as { emit: (r: string, ...x: unknown[]) => Promise<string> }
    const post = bs.emit.bind(b.servers)
    let held = false
    bs.emit = (r, ...x) => {
      if (r === room || b.servers.sumOf(r).ownerCount < 40) return post(r, ...x)
      held = true
      return Promise.reject(new Error(LONE_TEXT))
    }
    // For each quiet member: the ACL count its last acknowledgement check saw, and its posts
    // under way.
    const quiet = [a, ...rest]
    const seen = new Map<Member, number>()
    const busy = new Map<Member, number>()
    for (const m of quiet) {
      const s = m.servers as unknown as {
        ackCarry: (r: string, rt: AckRt) => void
        emit: (r: string, ...x: unknown[]) => Promise<string>
      }
      const ack = s.ackCarry.bind(m.servers)
      s.ackCarry = (r, rt) => {
        ack(r, rt)
        seen.set(m, m.servers.sumOf(r).count)
      }
      const send = s.emit.bind(m.servers)
      s.emit = (r, ...x) => {
        busy.set(m, (busy.get(m) ?? 0) + 1)
        return send(r, ...x).finally(() => busy.set(m, (busy.get(m) ?? 1) - 1))
      }
    }
    const t = failure(a.servers.transfer(room, b.node.ik))
    await pump(clock, () => b.servers.transferAsks().length === 1, 'bob asked', 500)
    void b.servers.answerTransfer(b.servers.transferAsks()[0].key, true)
    expect(await t).toBe('ok')
    await pump(clock, () => !!b.servers.view(room)?.next, 'bob follows', 500)
    const next = b.servers.view(room)!.next!
    for (const m of [c, ...quiet])
      await pump(clock, () => m.servers.myMembership(next) === 'join', `${m.name} in`, 500, 120_000)
    const rtOf = (m: Member) => (m.servers as unknown as { rt: (r: string) => AckRt }).rt(next)
    // Everyone holds all of Bob's, has checked what it holds, and owes him nothing.
    const settled = (m: Member) => {
      const s = m.servers.sumOf(next)
      return (
        s.ownerCount === b.servers.sumOf(next).ownerCount &&
        seen.get(m) === s.count &&
        !busy.get(m) &&
        rtOf(m).carryAckLater === undefined
      )
    }
    await pump(
      clock,
      () => held && quiet.every(settled),
      'bob stopped, and everyone settled',
      5_000,
      120_000
    )
    const state = () =>
      Promise.all(
        quiet.map(async m => [
          m.name,
          (await m.store.outbox(next)).length,
          rtOf(m).carryAckAt,
          rtOf(m).carryAckLater,
          m.servers.sumOf(next).ownerCount,
        ])
      )
    const before = await state()
    const counts = quiet.map(m => m.servers.sumOf(next).count)
    // Carol is busy: 20 marks of hers. Once each quiet member checked with all of them in hand,
    // none has posted, decided or put off a mark.
    for (let i = 0; i < 20; i++) await emit(c)(next, 'mark', () => ({}))
    await pump(
      clock,
      () => quiet.every((m, i) => (seen.get(m) ?? 0) >= counts[i] + 20 && !busy.get(m)),
      'everyone checked her marks',
      1_000,
      120_000
    )
    expect(await state()).toEqual(before)
  }, 300_000)

  type AckRt = { carryAckAt: number; carryAckCount: number | null; carryAckLater?: unknown }
  const saveCache = (m: Member, room: string) =>
    (m.servers as unknown as { saveCache: (room: string) => Promise<void> }).saveCache(room)
  // Closed: nothing of its own runs or writes until it starts again.
  const closeApp = (m: Member) => {
    stopMember(m)
    m.store.close()
  }
  const marksOf = async (m: Member, room: string) => {
    let n = 0
    for (const o of await m.store.outbox(room))
      if ((await m.store.event(o.id))?.type === 'mark') n++
    return n
  }

  // Alice and Bob with 80 channels, transferred to Bob: Alice alone acknowledges his carry-over.
  // `check` runs in place of each of her acknowledgement checks, `run` being the check itself.
  const loneCarry = async (
    clock: ManualClock,
    hub: Hub,
    check: (run: () => void, a: Member, room: string, rt: AckRt) => void
  ) => {
    const a = await makeMember(hub, 'Alice', clock)
    const b = await makeMember(hub, 'Bob', clock)
    const room = await a.servers.create('Two of us')
    await joinWithCode(clock, a, room, b)
    for (let i = 0; i < 80; i++) {
      await a.servers.addChannel(room, `room-${i}`)
      if (i % 10 === 9) {
        const ack = await emit(b)(room, 'mark', () => ({}))
        await pump(clock, async () => !!(await a.store.event(ack)), 'alice holds it', 1_000)
      }
    }
    const srv = a.servers as unknown as { ackCarry: (room: string, rt: AckRt) => void }
    const ack = srv.ackCarry.bind(a.servers)
    srv.ackCarry = (r, rt) => check(() => ack(r, rt), a, r, rt)
    const next = await transferred(clock, room, a, b, [a, b])
    return { a, b, next }
  }

  // Once she holds 10 of Bob's carry-over events since her first mark she goes away, and Bob goes
  // on until he waits for her.
  const awayAt10 = (clock: ManualClock, hub: Hub) => {
    let due = false
    const lone = loneCarry(clock, hub, (run, m, r, rt) => {
      run()
      if (!due && rt.carryAckAt > -Infinity && rt.carryAckCount !== null)
        if (m.servers.sumOf(r).ownerCount - rt.carryAckCount >= 10) {
          due = true
          void m.node.setPaused(true)
        }
    })
    return { lone, due: () => due }
  }

  test('a lone member who reloads mid-carry still acknowledges it, and it finishes', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const away = awayAt10(clock, hub)
    const { b, next, ...rest } = await away.lone
    let { a } = rest
    await pump(clock, away.due, 'alice holds 10 unacknowledged', 200, 120_000)
    await pump(clock, () => b.servers.view(next)?.carry?.state === 'waiting', 'bob waits', 5_000)
    // Her page's copy of the state is up to date when she reloads.
    await saveCache(a, next)
    stopMember(a)
    a = await restart(hub, a, clock)
    await a.node.setPaused(false)
    await pump(clock, () => b.servers.view(next)?.carry === null, 'carried over', 5_000, 120_000)
    expect(b.servers.view(next)!.channels.length).toBe(81)
  }, 300_000)

  test('a carry-over goes on after both apps were closed for more than a day', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const away = awayAt10(clock, hub)
    const { next, ...rest } = await away.lone
    let { a, b } = rest
    await pump(clock, away.due, 'alice holds 10 unacknowledged', 200, 120_000)
    await pump(clock, () => b.servers.view(next)?.carry?.state === 'waiting', 'bob waits', 5_000)
    for (const m of [a, b]) await saveCache(m, next)
    closeApp(a)
    closeApp(b)
    await clock.advance(25 * 60 * 60_000)
    a = await restart(hub, a, clock)
    b = await restart(hub, b, clock)
    await a.node.setPaused(false)
    await pump(clock, () => b.servers.view(next)?.carry === null, 'carried over', 5_000, 120_000)
    expect(b.servers.view(next)!.channels.length).toBe(81)
  }, 300_000)

  test('a mark due when the app closed is posted when it opens again, a day later', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    // Her mark falls due within a minute of her last one and the app closes before it is posted:
    // she holds all Bob posted, and he waits for her.
    let shut = false
    const { next, ...rest } = await loneCarry(clock, hub, (run, _m, _r, rt) => {
      if (shut) return
      run()
      if (rt.carryAckLater === undefined) return
      shut = true
      clock.clear(rt.carryAckLater)
      rt.carryAckLater = undefined
    })
    let { a, b } = rest
    await pump(clock, () => shut, 'her mark falls due', 200, 120_000)
    await pump(
      clock,
      () =>
        b.servers.view(next)?.carry?.state === 'waiting' &&
        a.servers.sumOf(next).ownerCount === b.servers.sumOf(next).ownerCount,
      'bob waits, alice holds it all',
      5_000
    )
    for (const m of [a, b]) await saveCache(m, next)
    closeApp(a)
    closeApp(b)
    await clock.advance(25 * 60 * 60_000)
    a = await restart(hub, a, clock)
    b = await restart(hub, b, clock)
    await pump(clock, () => b.servers.view(next)?.carry === null, 'carried over', 5_000, 120_000)
    expect(b.servers.view(next)!.channels.length).toBe(81)
  }, 300_000)

  test('a mark that fails to post is tried again, and the carry-over finishes', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const { a, b, next } = await loneCarry(clock, hub, run => run())
    // Her second mark fails (as a sync under way would make it).
    const srv = a.servers as unknown as {
      emit: (room: string, t: string, ...x: unknown[]) => Promise<string>
    }
    const post = srv.emit.bind(a.servers)
    let n = 0
    srv.emit = (room, t, ...x) =>
      t === 'mark' && n++ === 1 ? Promise.reject(new Error('Not now')) : post(room, t, ...x)
    await pump(clock, () => b.servers.view(next)?.carry === null, 'carried over', 5_000, 120_000)
    expect(n).toBeGreaterThan(2)
    expect(b.servers.view(next)!.channels.length).toBe(81)
  }, 300_000)

  test('a carry-over of 200 overwrites is acknowledged to its end', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const a = await makeMember(hub, 'Alice', clock)
    const b = await makeMember(hub, 'Bob', clock)
    const c = await makeMember(hub, 'Carol', clock)
    const room = await a.servers.create('Rows')
    await joinWithCode(clock, a, room, b)
    await joinWithCode(clock, a, room, c)
    // Carol acknowledges what Alice did (spec 4.1 W3(b)), so Alice can go on.
    const ack = async () => {
      await pump(
        clock,
        () => c.servers.sumOf(room).count === a.servers.sumOf(room).count,
        'carol holds it',
        1_000
      )
      const n = a.servers.sumOf(room).count
      await emit(c)(room, 'mark', () => ({}))
      await pump(clock, () => a.servers.sumOf(room).count > n, 'alice holds the mark', 1_000)
    }
    let n = 0
    for (const name of ['one', 'two']) {
      const ch = await a.servers.addChannel(room, name, { restrictView: true })
      for (let i = 0; i < 100; i += 1) {
        await a.servers.setOverwrite(room, ch, `u:${keyId(newKeyPair().pk)}`, P.ViewChannel, 0)
        if (++n % 20 === 0) await ack()
      }
    }
    expect(
      Object.values(a.servers.sumOf(room).overwrites).reduce((k, o) => k + Object.keys(o).length, 0)
    ).toBe(200)
    await ack()
    const next = await transferred(clock, room, a, b, [a, b, c])
    await pump(clock, () => b.servers.view(next)?.carry === null, 'carried over', 5_000, 240_000)
    expect(
      Object.values(b.servers.sumOf(next).overwrites).reduce((k, o) => k + Object.keys(o).length, 0)
    ).toBe(200)
  }, 400_000)

  test('an owner who goes on past what the carry-over holds gets no more acknowledgements', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    let a = await makeMember(hub, 'Alice', clock)
    const b = await makeMember(hub, 'Bob', clock)
    const c = await makeMember(hub, 'Carol', clock)
    const room = await a.servers.create('Small')
    await joinWithCode(clock, a, room, b)
    await joinWithCode(clock, a, room, c)
    const next = await transferred(clock, room, a, b, [a, b, c])
    await pump(clock, () => b.servers.view(next)?.carry === null, 'carried over', 1_000)
    // As if Bob never said it was done (a new owner who goes on and on): the clients read the
    // chunks without the last one, and Bob keeps changing the server. Alice's app reloads halfway.
    const proto = Servers.prototype as unknown as {
      migratedOf: (room: string) => Promise<{ done: boolean } | null>
    }
    const read = proto.migratedOf
    proto.migratedOf = async function (this: Servers, r: string) {
      const m = await read.call(this, r)
      return m && { ...m, done: false }
    }
    try {
      await emit(b)(next, 'mark', () => ({}))
      await clock.advance(5_000)
      for (let i = 0; i < 200; i++) {
        await b.servers.addChannel(next, `more-${i}`).catch(() => {})
        if (i % 20 === 19) await clock.advance(61_000)
        if (i === 99) {
          stopMember(a)
          a = await restart(hub, a, clock)
        }
      }
      await clock.advance(5 * 61_000)
    } finally {
      proto.migratedOf = read
    }
    const max = (a.servers as unknown as { rt: (r: string) => { carryMax?: number } }).rt(
      next
    ).carryMax!
    expect(max).toBeLessThan(8)
    // All her marks in the new copy, the one at her join too.
    expect(await marksOf(a, next)).toBeLessThanOrEqual(max)
  }, 180_000)

  test('a carry-over stalled for a day stops with the limit it waits for', async () => {
    let fired = 0
    const fake = {
      rooms: new Map([['r', {}]]),
      clock: {
        set: (fn: () => void) => {
          fired++
          fn()
        },
      },
    }
    const until = (
      Servers.prototype as unknown as {
        untilAllowed: (
          room: string,
          step: () => Promise<unknown>,
          waiting: (why: string) => Promise<void>
        ) => Promise<string | null>
      }
    ).untilAllowed
    const why = await until.call(
      fake,
      'r',
      () => Promise.reject(new Error(LONE_TEXT)),
      async () => {}
    )
    expect(why).toBe(LONE_TEXT)
    expect(fired).toBe(24 * 60)
  })

  test('two upgrades: the transfer is disputed and the user picks the copy to follow', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const a = await makeMember(hub, 'Alice', clock)
    const d = await makeMember(hub, 'Dora', clock)
    const b = await makeMember(hub, 'Bob', clock)
    await a.node.addContact(await d.node.myCard())
    await pump(clock, () => d.node.contact(a.node.ik)?.state === 'incoming', 'request')
    await d.node.accept(a.node.ik)
    await pump(clock, () => a.node.contact(d.node.ik)?.state === 'mutual', 'mutual')
    const room = await createWith(clock, a, 'Two', [d])
    await joinWithCode(clock, a, room, d)
    await joinWithCode(clock, a, room, b)
    const preAp = d.servers.sumOf(room).heads
    const ask = async (m: Member, kind: 'take' | 'cosign') => {
      await pump(
        clock,
        () => m.servers.transferAsks().some(x => x.kind === kind),
        `${m.name} asked`,
        1_000
      )
      return m.servers.transferAsks().find(x => x.kind === kind)!
    }
    const t = failure(a.servers.transfer(room, b.node.ik))
    void b.servers.answerTransfer((await ask(b, 'take')).key, true)
    void d.servers.answerTransfer((await ask(d, 'cosign')).key, true)
    expect(await t).toBe('ok')
    // Dora, a co-owner, upgraded too from before the first upgrade (owners racing).
    const g2 = await (
      b.servers as unknown as { successorOf: (r: string) => Promise<never> }
    ).successorOf(room)
    const sigs = { [a.node.ik]: signUpgrade(a.node.author()!.ik, room, g2) }
    const up2 = await signed(d, room, 'upgrade', { g: g2, sigs }, { ap: preAp })
    for (const m of [a, b, d]) await deliver(m, room, up2.wire, clock.now())
    await pump(clock, () => a.servers.view(room)?.disputed === true, 'disputed')
    const list = await a.servers.successors(room)
    expect(list.length).toBe(2)
    expect(new Set(list.map(x => x.owner))).toEqual(new Set([b.node.ik]))
    // Same owner: told apart by who transferred it.
    expect(new Set(list.map(x => x.by))).toEqual(new Set([a.node.ik, d.node.ik]))
  }, 120_000)

  test('the carry-over posts invites first, waits out the limits, and resumes after a restart', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const a = await makeMember(hub, 'Alice', clock)
    let b = await makeMember(hub, 'Bob', clock)
    const c = await makeMember(hub, 'Carol', clock)
    const room = await a.servers.create('Big')
    await joinWithCode(clock, a, room, b)
    await joinWithCode(clock, a, room, c)
    for (let i = 0; i < 30; i++) {
      await a.servers.addChannel(room, `room-${i}`)
      // Others acknowledge now and then (spec 4.1 W3(b)).
      if (i % 10 === 9) {
        const ack = await emit(c)(room, 'mark', () => ({}))
        await pump(clock, async () => !!(await a.store.event(ack)), 'alice holds it', 1_000)
      }
    }
    const r1 = await giveRole(a, room, c, 32, 1)
    const r2 = await giveRole(a, room, c, 4, 2)
    await pump(clock, () => ((c.servers.view(room)?.perms ?? 0) & 4) !== 0, 'carol has both roles')
    const channels = a.servers.view(room)!.channels.length
    expect(channels).toBe(31)
    const t = failure(a.servers.transfer(room, b.node.ik))
    await pump(clock, () => b.servers.transferAsks().length === 1, 'bob asked', 1_000)
    void b.servers.answerTransfer(b.servers.transferAsks()[0].key, true)
    expect(await t).toBe('ok')
    // Bob stops partway and starts again: the carry-over resumes.
    await pump(clock, () => !!b.servers.view(room)?.next, 'bob follows', 1_000)
    const next = b.servers.view(room)!.next!
    await pump(clock, () => (b.servers.view(next)?.channels.length ?? 0) >= 1, 'a channel', 500)
    stopMember(b)
    await clock.advance(1_000)
    b = await restart(hub, b, clock)
    for (const m of [a, c])
      await pump(
        clock,
        () => m.servers.myMembership(next) === 'join',
        `${m.name} in`,
        5_000,
        90_000
      )
    await pump(
      clock,
      () => (b.servers.view(next)?.channels.length ?? 0) === channels,
      'every channel carried',
      5_000,
      120_000
    )
    await pump(clock, () => b.servers.view(next)?.carry === null, 'carried over', 5_000, 60_000)
    expect(Object.keys(b.servers.sumOf(next).roles).length).toBe(2)
    await pump(
      clock,
      () => ((c.servers.view(next)?.perms ?? 0) & 36) === 36,
      'carol has her roles',
      5_000,
      60_000
    )
    expect([r1, r2].length).toBe(2)
  }, 240_000)
})
