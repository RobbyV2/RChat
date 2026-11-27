import { describe, expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'
import { P } from '../p2p/state'
import { publicMembersOf, typeExportsOf } from './api_surface'
import api from './fixtures/p2p_servers_api.json'
import { Hub, joinWithCode, makeMember, ManualClock, pump, type Member } from './p2p_server_net'

// The member list a server's view gives (server/views.ts): an owner, a moderator and three
// members, seen by the owner and by the moderator. The expectation is a pinned view()
// with identity keys and role ids replaced by names, join times by whether there is one and
// the codes members joined with by their label ("code" without one).

const world = async () => {
  const clock = new ManualClock()
  const hub = new Hub()
  const [a, b, c, d, e] = await Promise.all(
    ['Alice', 'Bob', 'Carol', 'Dave', 'Erin'].map(n => makeMember(hub, n, clock))
  )
  const room = await a.servers.create('Views')
  for (const m of [b, c, d, e]) await joinWithCode(clock, a, room, m)
  const mod = await a.servers.createRole(room, { name: 'Moderator', color: 0x2e7d32, bits: P.Kick })
  await a.servers.assignRole(room, b.node.ik, mod)
  await pump(clock, () => ((b.servers.view(room)?.perms ?? 0) & P.Kick) !== 0, 'bob may kick')
  await pump(
    clock,
    () => b.servers.view(room)?.members.filter(m => m.m === 'join').length === 5,
    'bob sees everyone'
  )
  return { clock, members: [a, b, c, d, e], room, mod }
}

const rows = (who: Member, all: Member[], room: string, roles: Record<string, string>) => {
  const name = (ik: string) => all.find(m => m.node.ik === ik)?.name ?? ik
  return who.servers.view(room)!.members.map(({ joinedAt, via, ...m }) => ({
    ...m,
    ik: name(m.ik),
    roles: m.roles.map(r => roles[r] ?? r),
    top: m.top === null ? null : (roles[m.top] ?? m.top),
    joined: joinedAt !== undefined,
    ...(via ? { via: via.label || 'code' } : {}),
  }))
}

describe('server views', () => {
  test('the member list of an owner, a moderator and three members', async () => {
    const { members, room, mod } = await world()
    const [a, b] = members
    const roles = { [mod]: 'Moderator' }
    const base = { m: 'join' as const, online: true, contact: false, waits: false, myInvite: false }
    const plain = { ...base, unban: false, roles: [], top: null, joined: true }
    const coded = { ...plain, via: 'code' }
    expect(rows(a, members, room, roles)).toEqual([
      { ...plain, ik: 'Alice', name: 'Alice', owner: true, below: false },
      {
        ...coded,
        ik: 'Bob',
        name: 'Bob',
        owner: false,
        below: true,
        resetProfile: true,
        roles: ['Moderator'],
        top: 'Moderator',
      },
      { ...coded, ik: 'Carol', name: 'Carol', owner: false, below: true, resetProfile: true },
      { ...coded, ik: 'Dave', name: 'Dave', owner: false, below: true, resetProfile: true },
      { ...coded, ik: 'Erin', name: 'Erin', owner: false, below: true, resetProfile: true },
    ])
    expect(rows(b, members, room, roles)).toEqual([
      { ...plain, ik: 'Alice', name: 'Alice', owner: true, below: false },
      {
        ...coded,
        ik: 'Bob',
        name: 'Bob',
        owner: false,
        below: false,
        roles: ['Moderator'],
        top: 'Moderator',
      },
      { ...coded, ik: 'Carol', name: 'Carol', owner: false, below: true, resetProfile: true },
      { ...coded, ik: 'Dave', name: 'Dave', owner: false, below: true, resetProfile: true },
      { ...coded, ik: 'Erin', name: 'Erin', owner: false, below: true, resetProfile: true },
    ])
  }, 120_000)
})

describe('the server facade', () => {
  test('keeps the surface server.ts had: its exports and the public members of Servers', async () => {
    const index = fileURLToPath(new URL('../p2p/server/index.ts', import.meta.url))
    expect(Object.keys(await import('../p2p/server')).sort()).toEqual(api.values)
    expect(typeExportsOf(index)).toEqual(api.types)
    expect(publicMembersOf(index, 'Servers')).toEqual(api.members)
  })
})
