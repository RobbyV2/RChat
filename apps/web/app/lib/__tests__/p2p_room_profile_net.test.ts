import { afterEach, describe, expect, test } from 'bun:test'
import { CANT_TEXT } from '../p2p/flows'
import { PROFILE_OFTEN_TEXT } from '../p2p/server/storage'
import { memberOf } from '../p2p/state'
import { Hub, ManualClock } from './p2p_net'
import { joinWithCode, makeMember, pump, stopAll, type Member } from './p2p_server_net'

afterEach(stopAll)

type Inner = {
  emit: (room: string, t: string, make: () => Record<string, unknown>) => Promise<unknown>
  refreshMe: (room: string) => Promise<void>
  sumOf: (room: string) => Parameters<typeof memberOf>[0]
}
const inner = (m: Member) => m.servers as unknown as Inner
const stored = (m: Member, room: string, ik: string) =>
  memberOf(inner(m).sumOf(room), ik)?.profile ?? null

const refusal = (run: Promise<unknown>) =>
  run.then(
    () => null,
    (e: unknown) => (e instanceof Error ? e.message : String(e))
  )

const pair = async () => {
  const clock = new ManualClock()
  const hub = new Hub()
  const a = await makeMember(hub, 'Alice', clock)
  const b = await makeMember(hub, 'Bob', clock)
  const room = await a.servers.create('Club')
  await joinWithCode(clock, a, room, b)
  return { clock, a, b, room }
}

describe('a room profile over the global one', () => {
  test('the nickname shows after our own name and a contact name, before the global name', async () => {
    const { clock, a, b, room } = await pair()
    await b.servers.setRoomProfile(room, {
      nick: 'Robert',
      bio: 'here',
      av: { kind: 'color', bg: '#aa0000' },
    })
    await pump(clock, () => a.servers.nameOf(b.node.ik, room) === 'Robert', 'nickname')
    expect(b.servers.nameOf(b.node.ik, room)).toBe('Bob')
    expect(a.servers.nameOf(b.node.ik)).toBe('Bob')
    expect(a.servers.profileName(b.node.ik, room)).toBe('Bob')
    expect(a.servers.roomProfileOf(room, b.node.ik)).toEqual({
      look: { name: 'Robert', avatar_kind: 'color', avatar_color: '#aa0000' },
      bio: 'here',
      banner: null,
    })
    const row = a.servers.view(room)?.members.find(m => m.ik === b.node.ik)
    expect([row?.name, row?.nick, row?.av]).toEqual([
      'Robert',
      'Robert',
      { kind: 'color', bg: '#aa0000' },
    ])
  }, 60_000)

  test('our name for a contact stays ahead of their nickname', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const a = await makeMember(hub, 'Alice', clock)
    const b = await makeMember(hub, 'Bob', clock)
    await a.node.addContact(await b.node.myCard())
    await pump(clock, () => b.node.contact(a.node.ik)?.state === 'incoming', 'request')
    await b.node.accept(a.node.ik)
    await pump(clock, () => a.node.contact(b.node.ik)?.state === 'mutual', 'mutual')
    const room = await a.servers.create('Club')
    await joinWithCode(clock, a, room, b)
    await b.servers.setRoomProfile(room, { nick: 'Robert' })
    const nick = () => a.servers.view(room)?.members.find(m => m.ik === b.node.ik)?.nick
    await pump(clock, () => nick() === 'Robert', 'nickname')
    expect(a.servers.nameOf(b.node.ik, room)).toBe('Bob')
    await a.node.rename(b.node.ik, 'Bobby')
    expect(a.servers.nameOf(b.node.ik, room)).toBe('Bobby')
  }, 60_000)

  test('the room mode takes the nickname, then every extra, out of what readers show', async () => {
    const { clock, a, b, room } = await pair()
    await b.servers.setRoomProfile(room, { nick: 'Robert', bn: '#001122' })
    await pump(clock, () => a.servers.nameOf(b.node.ik, room) === 'Robert', 'nickname')
    expect(await refusal(b.servers.setProfileMode(room, 'off'))).toBe(CANT_TEXT)
    await a.servers.setProfileMode(room, 'no_names')
    await pump(clock, () => b.servers.roomProfileOf(room, b.node.ik).look === null, 'no names')
    expect(a.servers.nameOf(b.node.ik, room)).toBe('Bob')
    expect(a.servers.roomProfileOf(room, b.node.ik).banner).toBe('#001122')
    await a.servers.setProfileMode(room, 'off')
    expect(a.servers.roomProfileOf(room, b.node.ik)).toEqual({
      look: null,
      bio: null,
      banner: null,
    })
    await a.servers.setProfileMode(room, 'all')
    expect(a.servers.nameOf(b.node.ik, room)).toBe('Robert')
  }, 60_000)

  test('a write that drops the extras is put right by the device that holds the intent', async () => {
    const { clock, a, b, room } = await pair()
    await b.servers.setRoomProfile(room, { nick: 'Robert' })
    await pump(clock, () => a.servers.nameOf(b.node.ik, room) === 'Robert', 'nickname')
    await inner(b).emit(room, 'profile', () => ({ name: 'Bob' }))
    await pump(clock, () => a.servers.nameOf(b.node.ik, room) === 'Bob', 'dropped')
    expect(Object.entries(stored(b, room, b.node.ik) ?? {})).toEqual([['name', 'Bob']])
    await inner(b).refreshMe(room)
    await pump(clock, () => a.servers.nameOf(b.node.ik, room) === 'Robert', 'restored')
    expect(stored(a, room, b.node.ik)).toMatchObject({ name: 'Bob', nick: 'Robert' })
    const before = stored(b, room, b.node.ik)
    await inner(b).refreshMe(room)
    expect(stored(b, room, b.node.ik)).toBe(before)
  }, 60_000)

  test('an empty intent goes back to the global profile, and the eleventh write of an hour is refused', async () => {
    const { clock, a, b, room } = await pair()
    await b.servers.setRoomProfile(room, { nick: 'Robert' })
    await pump(clock, () => a.servers.nameOf(b.node.ik, room) === 'Robert', 'nickname')
    await b.servers.setRoomProfile(room, {})
    await pump(clock, () => a.servers.nameOf(b.node.ik, room) === 'Bob', 'cleared')
    expect(stored(a, room, b.node.ik)?.nick).toBeUndefined()
    expect((await b.store.room(room))?.profile).toBeUndefined()
    for (let i = 0; i < 8; i++) await b.servers.setRoomProfile(room, { nick: `Rob${i}` })
    expect(await refusal(b.servers.setRoomProfile(room, { nick: 'Late' }))).toBe(PROFILE_OFTEN_TEXT)
    expect((await b.store.room(room))?.profile).toEqual({ nick: 'Rob7' })
  }, 60_000)

  test('an upgrade carries what each member set for themselves into the new copy', async () => {
    const { clock, a, b, room } = await pair()
    await a.servers.setRoomProfile(room, { nick: 'Ali' })
    await b.servers.setRoomProfile(room, { nick: 'Robert', bn: '#001122' })
    await pump(clock, () => a.servers.nameOf(b.node.ik, room) === 'Robert', 'nickname')
    const handed = refusal(a.servers.transfer(room, b.node.ik))
    await pump(clock, () => b.servers.transferAsks().length === 1, 'bob asked', 500)
    void b.servers.answerTransfer(b.servers.transferAsks()[0].key, true)
    expect(await handed).toBeNull()
    await pump(clock, () => !!a.servers.view(room)?.next, 'new copy', 1_000)
    const next = a.servers.view(room)!.next!
    await pump(clock, () => a.servers.myMembership(next) === 'join', 'alice in', 1_000, 90_000)
    await pump(
      clock,
      () => a.servers.nameOf(b.node.ik, next) === 'Robert',
      'his nickname in the new copy',
      1_000,
      90_000
    )
    await pump(clock, () => b.servers.nameOf(a.node.ik, next) === 'Ali', 'hers', 1_000, 90_000)
    expect(a.servers.roomProfileOf(next, b.node.ik).banner).toBe('#001122')
    expect((await b.store.room(next))?.profile).toEqual({ nick: 'Robert', bn: '#001122' })
  }, 120_000)

  test('a removal ends the room profile: back in, a member starts from the global one', async () => {
    const { clock, a, b, room } = await pair()
    await b.servers.setRoomProfile(room, { nick: 'Robert' })
    await pump(clock, () => a.servers.nameOf(b.node.ik, room) === 'Robert', 'nickname')
    await a.servers.kick(room, b.node.ik)
    await pump(clock, () => b.servers.myMembership(room) === 'leave', 'kicked')
    await pump(clock, async () => !(await b.store.room(room))?.profile, 'intent gone')
    await joinWithCode(clock, a, room, b)
    await clock.advance(60_000)
    expect(a.servers.nameOf(b.node.ik, room)).toBe('Bob')
    expect(a.servers.view(room)?.members.find(m => m.ik === b.node.ik)?.nick).toBeUndefined()
    expect(stored(a, room, b.node.ik)?.nick).toBe('Robert')
    await b.servers.setRoomProfile(room, { nick: 'Robert' })
    await pump(clock, () => a.servers.nameOf(b.node.ik, room) === 'Robert', 'set again')
  }, 60_000)
})
