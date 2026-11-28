import { afterEach, describe, expect, test } from 'bun:test'
import { AclWorld, devOwner } from './p2p_acl_world'
import { AGREED } from '../p2p/limits'
import { KICK, SERVER, type AclContent } from '../p2p/acl/rules'
import { CANT_TEXT, actParts, effectHolds } from '../p2p/flows'
import { emptySummary } from '../p2p/acl/summary'
import { RESIGN_ACL } from '../p2p/server/types'
import { parseP2pMemberList } from '../member_list'
import { Hub, ManualClock } from './p2p_net'
import { joinWithCode, makeMember, pump, stopAll } from './p2p_server_net'

afterEach(stopAll)

const world = () => {
  const w = new AclWorld({ model: false, agreed: AGREED })
  w.genesis('O1', ['O'])
  w.channel('O1')
  return w
}
const role = (w: AclWorld, pos: number, bits: number) => w.ok('O1', 'role_create', { pos, bits }).id
const join = (w: AclWorld, dev: string) => {
  w.ok('O1', 'add', { to: devOwner(dev) })
  return w.ok(dev, 'join')
}
const list = (w: AclWorld) => parseP2pMemberList(w.state().facts.memberList ?? null)

describe('member_list: who sees the member list is a register', () => {
  test('admitted by the generic rule; only owners and Manage server holders change it', () => {
    const w = world()
    const MGR = role(w, 5, SERVER)
    const MOD = role(w, 4, KICK)
    for (const d of ['A1', 'B1']) join(w, d)
    w.ok('O1', 'assign', { to: 'A', role: MGR })
    w.ok('O1', 'assign', { to: 'B', role: MOD })
    expect(list(w)).toEqual({ hide: false, roles: null, channels: [] })
    w.ok('O1', 'member_list', { hide: true })
    expect(list(w).hide).toBe(true)
    w.ok('A1', 'member_list', { hide: false, allow_roles: [MOD] })
    expect(list(w)).toEqual({ hide: false, roles: [MOD], channels: [] })
    expect(w.act('B1', 'member_list', { hide: true }).v.s).toBe('A')
    expect(list(w).hide).toBe(false)
    expect(w.act('A1', 'member_list', { hide: 3, ch_hide: 'x', more: 1 }).v.s).toBe('A')
    expect(list(w)).toEqual({ hide: false, roles: null, channels: [] })
    expect(w.state().facts.memberList as unknown).toEqual({ hide: 3, ch_hide: 'x', more: 1 })
    w.ok('O1', 'add', { to: 'C' })
    expect(w.act('C1', 'member_list', { hide: true }).v.s).toBe('R')
  })

  test('a writer demoted concurrently with its write does not count', () => {
    const w = world()
    const MGR = role(w, 5, SERVER)
    join(w, 'B1')
    w.ok('O1', 'assign', { to: 'B', role: MGR })
    const P1 = w.heads()
    w.ok('O1', 'revoke', { to: 'B', role: MGR })
    const late = w.ok('B1', 'member_list', { hide: true }, { ap: P1 })
    expect(w.state().cut.has(late.id)).toBe(false)
    expect(list(w).hide).toBe(false)
  })

  test('it is signed again after a lost device and named in the list of changes', () => {
    expect(RESIGN_ACL).toContain('member_list')
    const c = { hide: true }
    const s = { ...emptySummary(), memberList: c as unknown as AclContent }
    expect(effectHolds('member_list', c, 'x', 'me', s, 0)).toBe(true)
    expect(effectHolds('member_list', { hide: false }, 'x', 'me', s, 0)).toBe(false)
    expect(actParts('member_list')).toEqual({ act: 'Change who can view the member list' })
  })
})

describe('member_list between devices', () => {
  test('an owner hides the list from members, and a member may not change it', async () => {
    const hub = new Hub()
    const clock = new ManualClock()
    const a = await makeMember(hub, 'Alice', clock)
    const b = await makeMember(hub, 'Bob', clock)
    const room = await a.servers.create('Readers')
    await joinWithCode(clock, a, room, b)
    const ch = 'c1'
    await a.servers.setMemberList(room, { hide: true })
    await a.servers.setMemberList(room, { channel: ch, hide: true })
    expect(a.servers.view(room)?.memberList).toEqual({ hide: true, roles: null, channels: [ch] })
    await pump(clock, () => b.servers.view(room)?.memberList.hide === true, 'b sees it hidden')
    expect(b.servers.view(room)?.memberList.channels).toEqual([ch])
    const refused = await b.servers.setMemberList(room, { hide: false }).then(
      () => 'ok',
      (e: Error) => e.message
    )
    expect(refused).toBe(CANT_TEXT)
    await a.servers.setMemberList(room, { hide: false })
    expect(a.servers.sumOf(room).memberList as unknown).toEqual({
      hide: false,
      ch_hide: { [ch]: true },
    })
  })
})
