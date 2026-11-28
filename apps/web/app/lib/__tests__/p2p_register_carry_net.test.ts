import { describe, expect, test } from 'bun:test'
import type { Summary } from '../p2p/acl/summary'
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
})
