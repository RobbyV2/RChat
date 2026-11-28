import { describe, expect, test } from 'bun:test'
import { genesisBundle } from '../p2p/acl/binding'
import { carriedBits, carriedRule, P, RULES_NEXT, TIMEOUT } from '../p2p/acl/rules'
import type { Summary } from '../p2p/acl/summary'
import { b64u, randomBytes } from '../p2p/canonical'
import { blankRoom } from '../p2p/dag'
import type { RoomRecord } from '../p2p/db'
import { buildEvent2, type WireV2 } from '../p2p/event_v2'
import { keyId } from '../p2p/keys'
import type { Carried } from '../p2p/acl_room'
import { CARRY_MEMBER_REGISTERS, CARRY_REGISTERS } from '../p2p/server/transfer'
import { emptySummary } from '../p2p/acl/summary'
import { Hub, ManualClock } from './p2p_net'
import { joinWithCode, makeMember, pump, type Member } from './p2p_server_net'

const sumOf = (m: Member, room: string) =>
  (m.servers as unknown as { sumOf: (room: string) => Summary }).sumOf(room)

const refusal = (run: Promise<unknown>) =>
  run.then(
    () => null,
    (e: unknown) => (e instanceof Error ? e.message : String(e))
  )

const carried = (over: Partial<Carried>): Carried => ({
  members: [],
  bans: [],
  holds: {},
  roles: {},
  channels: {},
  settings: null,
  ...over,
})

const memberCarry = (type: string) => CARRY_MEMBER_REGISTERS.find(r => r.type === type)!

describe('what a room upgrade carries of the registers', () => {
  test('every register has its own step, and a list the member list names follows the roles', () => {
    const s = carried({
      store: { on: true, extra: 1 },
      about: { text: 'hi' },
      profileMode: { mode: 'no_names' },
      memberList: { allow_roles: ['old', 'lost'] },
      categories: { k1: { name: 'Talk', pos: 0 } },
      chcats: { c1: { cat: 'k1', sync: true } },
      separators: {},
    } as unknown as Partial<Carried>)
    const steps = CARRY_REGISTERS.flatMap(r => r.keys(s).map(k => r.step(k)))
    expect(new Set(steps).size).toBe(steps.length)
    expect(steps).toEqual(['store', 'k:k1', 'h:c1', 'profile_mode', 'about', 'l'])
    const content = (type: string, k = '') =>
      CARRY_REGISTERS.find(r => r.type === type)!.content(s, k, { old: 'new' })
    expect(content('store')).toEqual({ on: true, earlier: true, extra: 1 })
    expect(content('member_list')).toEqual({ allow_roles: ['new'] })
    expect(content('category', 'k1')).toEqual({ id: 'k1', name: 'Talk', pos: 0 })
    expect(CARRY_REGISTERS.find(r => r.type === 'member_list')?.afterRoles).toBe(true)
  })

  test('a store that is off or was never set is not written', () => {
    const store = CARRY_REGISTERS.find(r => r.type === 'store')!
    expect(store.keys(carried({ store: { on: false } } as unknown as Partial<Carried>))).toEqual([])
    expect(store.keys(carried({}))).toEqual([])
  })

  test('a reset keeps its cleared parts, and its lock only while it runs', () => {
    const reset = memberCarry('profile_reset')
    const was = carried({
      resets: { b: { last: 'x', hide: ['name'], lock: { until: 500, fields: ['bio'] } } },
    })
    const old = {
      ...emptySummary(),
      members: { b: { reset: was.resets!.b } },
    } as unknown as Summary
    expect(reset.content(was, 'b', old, emptySummary(), 100_000)).toEqual({
      to: 'b',
      fields: ['name', 'bio'],
      until: 500,
    })
    expect(reset.content(was, 'b', old, emptySummary(), 600_000)).toEqual({
      to: 'b',
      fields: ['name'],
    })
    expect(reset.content(was, 'b', emptySummary(), emptySummary(), 100_000)).toBeNull()
    expect(reset.content(was, 'c', old, emptySummary(), 100_000)).toBeNull()
  })

  test('a timeout is kept while it runs, where the rules of the new copy read timeouts', () => {
    const timeout = memberCarry('timeout')
    const was = carried({ timeouts: { b: 9_000 } })
    const old = {
      ...emptySummary(),
      members: { b: { timeoutUntil: 9_000, timeoutReason: 'spam' } },
    } as unknown as Summary
    const at = (rules: number) => ({ ...emptySummary(), rules })
    expect(timeout.content(was, 'b', old, at(5), 1_000)).toEqual({
      to: 'b',
      until: 9_000,
      reason: 'spam',
    })
    expect(timeout.content(was, 'b', old, at(4), 1_000)).toBeNull()
    expect(timeout.content(was, 'b', old, at(5), 9_000)).toBeNull()
    expect(timeout.content(was, 'b', emptySummary(), at(5), 1_000)).toBeNull()
  })

  test('the new copy keeps the store, about, profile mode, categories and a profile lock', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const a = await makeMember(hub, 'Alice', clock)
    const b = await makeMember(hub, 'Bob', clock)
    const c = await makeMember(hub, 'Carol', clock)
    const room = await a.servers.create('Club')
    await joinWithCode(clock, a, room, b)
    await joinWithCode(clock, a, room, c)
    await a.servers.setStore(room, true)
    await a.servers.setAbout(room, { text: 'A club' })
    await a.servers.setProfileMode(room, 'no_names')
    const cat = await a.servers.createCategory(room, 'Talk')
    await a.servers.addChannelIn(room, 'lounge', cat)
    await c.servers.setRoomProfile(room, { bio: 'hello' })
    await pump(clock, () => !!sumOf(a, room).members[c.node.ik]?.profile?.bio, 'her bio')
    await a.servers.resetRoomProfile(room, c.node.ik, ['bio'], -1)
    const chan = Object.keys(sumOf(a, room).chcats)[0]
    await pump(clock, () => !!sumOf(b, room).members[c.node.ik]?.reset, 'bob has it all')

    const handed = refusal(a.servers.transfer(room, b.node.ik))
    await pump(clock, () => b.servers.transferAsks().length === 1, 'bob asked', 500)
    void b.servers.answerTransfer(b.servers.transferAsks()[0].key, true)
    expect(await handed).toBeNull()
    await pump(clock, () => !!a.servers.view(room)?.next, 'new copy', 1_000)
    const next = a.servers.view(room)!.next!
    await pump(clock, () => c.servers.myMembership(next) === 'join', 'carol in', 1_000, 120_000)
    await pump(
      clock,
      () => !!sumOf(a, next).members[c.node.ik]?.reset?.lock,
      'her lock in the new copy',
      1_000,
      120_000
    )
    const s = sumOf(a, next)
    expect(s.store).toMatchObject({ on: true, earlier: true })
    expect(s.about).toMatchObject({ text: 'A club' })
    expect(s.profiles).toBe('no_names')
    expect(s.categories[cat]?.name).toBe('Talk')
    expect(s.chcats[chan]).toMatchObject({ cat, sync: true })
    expect(s.members[c.node.ik]?.reset?.lock?.fields).toContain('bio')
  }, 300_000)
  test('a room of rules 4 upgraded by its owner is a rules-5 room where roles and channel rules hold what they covered', async () => {
    const clock = new ManualClock()
    const a = await makeMember(new Hub(), 'Alice', clock)
    const author = a.node.author()!
    const dk = keyId(author.dk.pk)
    const bare = {
      rules: 4,
      nonce: b64u(randomBytes(16)),
      owners: [{ ik: a.node.ik, dk }],
      everyone_bits: P.ViewChannel | P.SendMessages,
      name: 'Club',
    }
    const { id: room, wire } = buildEvent2(
      author,
      null,
      'genesis',
      'a',
      { ...bare, owners: [genesisBundle(author.ik, dk, bare)] },
      { seq: 0 },
      clock.now()
    )
    const inner = a.servers as unknown as {
      putRoom(r: RoomRecord): Promise<void>
      take(r: string, id: string, w: WireV2, now: number): Promise<{ status: string }>
    }
    await inner.putRoom({
      ...blankRoom(room, '', clock.now()),
      kind: 'server',
      name: 'Club',
      chans: {},
      since: clock.now(),
    })
    expect((await inner.take(room, room, wire as WireV2, clock.now())).status).toBe('new')
    expect(sumOf(a, room).rules).toBe(4)
    const ch = await a.servers.addChannel(room, 'general')
    const mod = await a.servers.createRole(room, {
      name: 'Mods',
      color: null,
      bits: P.ManageMessages | P.Kick,
    })
    await a.servers.setOverwrite(room, ch, 'r:everyone', 0, P.SendMessages)
    await a.servers.setOverwrite(room, ch, `r:${mod}`, P.SendMessages, 0)

    await a.servers.transfer(room, a.node.ik)
    await pump(clock, () => !!a.servers.view(room)?.next, 'new copy')
    const next = a.servers.view(room)!.next!
    await pump(
      clock,
      () => Object.keys(sumOf(a, next).overwrites[ch] ?? {}).length === 2,
      'rules carried',
      1_000,
      120_000
    )
    const s = sumOf(a, next)
    expect(s.rules).toBe(RULES_NEXT)
    expect(s.everyone).toBe(carriedBits(P.ViewChannel | P.SendMessages, true, 4))
    const role = Object.values(s.roles)[0]
    expect(role.bits).toBe(carriedBits(P.ManageMessages | P.Kick, false, 4))
    expect(role.bits & TIMEOUT).toBe(TIMEOUT)
    const made = Object.keys(s.roles)[0]
    expect(s.overwrites[ch]['r:everyone']).toEqual(
      carriedRule({ allow: 0, deny: P.SendMessages }, 4)
    )
    expect(s.overwrites[ch][`r:${made}`]).toEqual(
      carriedRule({ allow: P.SendMessages, deny: 0 }, 4)
    )
    expect(a.servers.view(next)?.timeouts).toBe(true)
  }, 300_000)

  test('a timeout that runs and a ban that ends are kept, and the old copy lists them', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const a = await makeMember(hub, 'Alice', clock)
    const b = await makeMember(hub, 'Bob', clock)
    const c = await makeMember(hub, 'Carol', clock)
    const d = await makeMember(hub, 'Dave', clock)
    const room = await a.servers.create('Club')
    for (const m of [b, c, d]) await joinWithCode(clock, a, room, m)
    expect(sumOf(a, room).rules).toBe(RULES_NEXT)
    await a.servers.timeout(room, c.node.ik, 86_400, 'spam')
    await a.servers.ban(room, d.node.ik, 'ads', false, { seconds: 7 * 86_400 })
    const was = sumOf(a, room)
    const [until, banUntil] = [
      was.members[c.node.ik]?.timeoutUntil,
      was.members[d.node.ik]?.banUntil,
    ]
    expect([typeof until, typeof banUntil]).toEqual(['number', 'number'])
    const log = await a.servers.moderationLog(room, null)
    const logged = log.events.map(e => e.t)
    expect([logged.includes('timeout'), logged.includes('ban')]).toEqual([true, true])
    await pump(clock, () => sumOf(b, room).members[d.node.ik]?.banUntil === banUntil, 'bob sees it')

    const handed = refusal(a.servers.transfer(room, b.node.ik))
    await pump(clock, () => b.servers.transferAsks().length === 1, 'bob asked', 500)
    void b.servers.answerTransfer(b.servers.transferAsks()[0].key, true)
    expect(await handed).toBeNull()
    await pump(clock, () => !!a.servers.view(room)?.next, 'new copy', 1_000)
    const next = a.servers.view(room)!.next!
    await pump(clock, () => c.servers.myMembership(next) === 'join', 'carol in', 1_000, 120_000)
    await pump(
      clock,
      () => sumOf(a, next).members[c.node.ik]?.timeoutUntil !== undefined,
      'her timeout in the new copy',
      1_000,
      120_000
    )
    const s = sumOf(a, next)
    expect(s.members[c.node.ik]?.timeoutUntil).toBe(until)
    expect(s.members[c.node.ik]?.timeoutReason).toBe('spam')
    expect(s.members[d.node.ik]?.m).toBe('ban')
    expect(s.members[d.node.ik]?.banUntil).toBe(banUntil)
    expect(s.members[d.node.ik]?.banReason).toBe('ads')
  }, 300_000)
})
