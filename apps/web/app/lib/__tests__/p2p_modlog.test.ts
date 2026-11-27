import { describe, expect, test } from 'bun:test'
import { joinWithCode, makeMember, pump } from './p2p_server_net'
import { Hub, ManualClock } from './p2p_net'
import { P } from '../p2p/acl/rules'
import { logLines } from '../audit_format'
import { permItems } from '../perm_source'
import { loadPerms } from './helpers/perms'

// The moderation log of a P2P room: admitted changes with the reasons their authors gave, newest
// first, a page at a time, for every member.

const two = async () => {
  await loadPerms()
  const clock = new ManualClock()
  const hub = new Hub()
  const a = await makeMember(hub, 'Alice', clock)
  const b = await makeMember(hub, 'Bob', clock)
  const room = await a.servers.create('Club')
  await joinWithCode(clock, a, room, b)
  return { clock, a, b, room }
}

describe('the moderation log', () => {
  test('lists changes with their reasons, newest first, a page at a time, to every member', async () => {
    const { clock, a, b, room } = await two()
    const bob = b.node.ik
    const mods = await a.servers.createRole(room, { name: 'Mods', color: null, bits: 0 }, 'helpers')
    await a.servers.setRoleBit(room, mods, P.Kick, true, 'they kick')
    await a.servers.setRoleBit(room, mods, P.Ban, true)
    await a.servers.assignRole(room, bob, mods, '  trusted  ')
    const general = a.servers.view(room)!.channels[0].id
    await a.servers.setOverwrite(room, general, `u:${bob}`, 0, P.SendMessages, 'too loud')
    const all = await a.servers.moderationLog(room, null)
    expect(all.next).toBeNull()
    expect(all.events.map(e => [e.t, e.c.reason ?? null])).toEqual([
      ['chperm', 'too loud'],
      ['assign', 'trusted'],
      ['role_bits', null],
      ['role_bits', 'they kick'],
      ['role_create', 'helpers'],
      ['add', null],
      ['code', null],
      ['settings', null],
      ['channel', null],
    ])
    expect(all.events.every(e => e.a === a.node.ik)).toBe(true)
    expect(all.events.map(e => e.aseq)).toEqual(
      [...all.events.map(e => e.aseq)].sort((x, y) => y - x)
    )
    const first = await a.servers.moderationLog(room, null, 3)
    expect(first.events.map(e => e.t)).toEqual(['chperm', 'assign', 'role_bits'])
    expect(first.next).toBe(first.events[2].aseq)
    const second = await a.servers.moderationLog(room, first.next, 3)
    expect(second.events.map(e => e.t)).toEqual(['role_bits', 'role_create', 'add'])
    const third = await a.servers.moderationLog(room, second.next, 3)
    expect(third.events.map(e => e.t)).toEqual(['code', 'settings', 'channel'])
    expect(third.next).toBeNull()

    const lines = logLines(all.events, {
      member: ik => (ik === bob ? 'Bob' : 'Alice'),
      role: id => (id === mods ? 'Mods' : null),
      channel: id => (id === general ? '#general' : null),
      text: t => t,
      items: permItems(a.servers.view(room)!.rules),
    })
    expect(lines.map(l => [l.act, l.target, l.reason, l.facts])).toEqual([
      [
        'Change who may use a channel',
        '#general',
        'too loud',
        [
          ['For', 'Bob'],
          ['Denied', 'Send messages'],
        ],
      ],
      ['Give a role to', 'Bob', 'trusted', [['Role', 'Mods']]],
      ['Change what a role may do', 'Mods', 'they kick', [['Permissions added', 'Kick, Ban']]],
      ['Make a role', 'Mods', 'helpers', []],
      ['Invite', 'Bob', null, []],
      ['Make an invite code', null, null, []],
      ['Change the server settings', null, null, []],
      ['Change a channel', '#general', null, []],
    ])

    await pump(
      clock,
      async () => (await b.servers.moderationLog(room, null)).events.length === all.events.length,
      'bob reads the same log'
    )
    const seen = await b.servers.moderationLog(room, null)
    expect(seen.events.map(e => e.id)).toEqual(all.events.map(e => e.id))

    await a.servers.kick(room, bob, 'spam')
    const after = await a.servers.moderationLog(room, null, 1)
    expect(after.events.map(e => [e.t, e.c.to, e.c.reason])).toEqual([['kick', bob, 'spam']])
  })
})
