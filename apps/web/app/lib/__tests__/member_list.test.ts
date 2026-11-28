import { describe, expect, test } from 'bun:test'
import { jsBuild, loadPerms, wasmBuild } from './helpers/perms'
import {
  MEMBERS_HIDDEN_LINE,
  VIEW_MEMBERS,
  hostedMembersHidden,
  p2pMembersHidden,
  p2pMemberListContent,
  parseP2pMemberList,
  type P2pListPlace,
} from '../member_list'
import { baseBits, maskAnd, maskNot, maskOr } from '../perms'
import { Perm } from '../types'
import { P } from '../p2p/state'

const OPEN = { hide_members: false, members_visible: true }

describe('the member list words', () => {
  test('each reason has its line, without em dashes', () => {
    expect(MEMBERS_HIDDEN_LINE).toEqual({
      site: 'Member lists are turned off on this site.',
      server: "You can't view the members of this server.",
      channel: "You can't view the members of this channel in this server.",
      outside: 'Only members can see who is in this server.',
    })
    for (const line of Object.values(MEMBERS_HIDDEN_LINE)) expect(line).not.toContain('—')
  })
})

describe('the P2P member list register', () => {
  test('malformed fields read as unset, and only hidden channels count', () => {
    expect(parseP2pMemberList(null)).toEqual({ hide: false, roles: null, channels: [] })
    expect(parseP2pMemberList({ hide: 'yes', allow_roles: [1, 'a'], ch_hide: [] })).toEqual({
      hide: false,
      roles: null,
      channels: [],
    })
    expect(
      parseP2pMemberList({
        hide: true,
        allow_roles: ['r1', 'r2'],
        ch_hide: { c1: true, c2: false, c3: 'x' },
        later: 7,
      })
    ).toEqual({ hide: true, roles: ['r1', 'r2'], channels: ['c1'] })
    expect(parseP2pMemberList({ allow_roles: Array(251).fill('r') }).roles).toBeNull()
  })

  test('a change keeps every field it does not change, unknown ones too', () => {
    const now = { hide: false, later: { x: 1 }, ch_hide: { c1: true } }
    expect(p2pMemberListContent(now, { hide: true })).toEqual({ ...now, hide: true })
    expect(p2pMemberListContent(now, { channel: 'c2', hide: true })).toEqual({
      ...now,
      ch_hide: { c1: true, c2: true },
    })
    expect(p2pMemberListContent(now, { channel: 'c1', hide: false })).toEqual({
      ...now,
      ch_hide: {},
    })
    const listed = p2pMemberListContent(now, { roles: ['r1', 'r1', 'r2'] })
    expect(listed.allow_roles).toEqual(['r1', 'r2'])
    expect(p2pMemberListContent(listed, { roles: null })).toEqual(now)
    expect(p2pMemberListContent(null, { hide: true })).toEqual({ hide: true })
  })
})

const builds = [
  ['WebAssembly', wasmBuild],
  ['JavaScript', jsBuild],
] as const

for (const [name, build] of builds)
  describe(`who sees the member list, through the ${name} build`, () => {
    test('a hosted member follows View members, and a channel decides inside it', async () => {
      await loadPerms(build)
      const base = baseBits()
      const without = maskAnd(base, maskNot(VIEW_MEMBERS))
      const member = (my: number, here?: number) =>
        hostedMembersHidden({
          siteOn: true,
          siteAdmin: false,
          member: true,
          detail: { ...OPEN, my_perms: my, everyone_perms: base },
          channel: here === undefined ? null : { my_perms: here },
        })
      expect(member(base)).toBeNull()
      expect(member(without)).toBe('server')
      expect(member(base, without)).toBe('channel')
      expect(member(without, base)).toBeNull()
      expect(member(without, without)).toBe('server')
      expect(member(maskOr(without, Perm.Kick), 0)).toBeNull()
    })

    test('a hidden list stays with moderators and the site admin, the site switch with staff', async () => {
      await loadPerms(build)
      const base = baseBits()
      const ask = (p: { my?: number; admin?: boolean; site?: boolean; member?: boolean }) =>
        hostedMembersHidden({
          siteOn: p.site ?? true,
          siteAdmin: p.admin ?? false,
          member: p.member ?? true,
          detail: { hide_members: true, members_visible: true, my_perms: p.my ?? base },
        })
      expect(ask({})).toBe('server')
      expect(ask({ my: maskOr(base, Perm.TimeoutMembers) })).toBe('server')
      for (const bit of [Perm.ManageServer, Perm.ManageRoles, Perm.Kick])
        expect(ask({ my: maskOr(base, bit) })).toBeNull()
      expect(ask({ admin: true, member: false })).toBeNull()
      expect(ask({ my: maskOr(base, Perm.Kick), site: false })).toBe('site')
      expect(ask({ admin: true, site: false })).toBeNull()
    })

    test('people outside follow the outside option, and older servers keep their rule', async () => {
      await loadPerms(build)
      const base = baseBits()
      const outside = (detail: Parameters<typeof hostedMembersHidden>[0]['detail']) =>
        hostedMembersHidden({ siteOn: true, siteAdmin: false, member: false, detail })
      expect(outside({ ...OPEN, everyone_perms: base })).toBeNull()
      expect(outside({ ...OPEN, members_visible: false, everyone_perms: base })).toBe('outside')
      expect(outside({ ...OPEN, everyone_perms: maskAnd(base, maskNot(VIEW_MEMBERS)) })).toBe(
        'server'
      )
      expect(outside({ members_visible: false })).toBe('outside')
      expect(outside({ members_visible: true })).toBeNull()
      expect(
        hostedMembersHidden({
          siteOn: false,
          siteAdmin: false,
          member: true,
          detail: { members_visible: false },
        })
      ).toBeNull()
    })

    test('a P2P room reads its register: the switch, its roles and its channels', async () => {
      await loadPerms(build)
      const place = (over: Partial<P2pListPlace> = {}): P2pListPlace => ({
        memberList: { hide: false, roles: null, channels: [] },
        me: 'join',
        owners: ['O'],
        perms: P.ViewChannel | P.SendMessages,
        rules: 5,
        members: [
          { ik: 'A', roles: ['r1'] },
          { ik: 'O', roles: [] },
        ],
        ...over,
      })
      const list = (l: Partial<P2pListPlace['memberList']>) => ({
        memberList: { hide: false, roles: null, channels: [], ...l },
      })
      expect(p2pMembersHidden(place(), 'A', null, true)).toBeNull()
      expect(p2pMembersHidden(place(list({ hide: true })), 'A', null, true)).toBe('server')
      expect(p2pMembersHidden(place(list({ hide: true })), 'O', null, true)).toBeNull()
      expect(
        p2pMembersHidden(place({ ...list({ hide: true }), perms: P.Kick }), 'A', null, true)
      ).toBeNull()
      expect(p2pMembersHidden(place(list({ roles: ['r1'] })), 'A', 'c1', true)).toBeNull()
      expect(p2pMembersHidden(place(list({ roles: ['r2'] })), 'A', 'c1', true)).toBe('server')
      expect(p2pMembersHidden(place(list({ channels: ['c1'] })), 'A', 'c1', true)).toBe('channel')
      expect(p2pMembersHidden(place(list({ channels: ['c1'] })), 'A', 'c2', true)).toBeNull()
      expect(p2pMembersHidden(place(), 'A', null, false)).toBe('site')
      expect(p2pMembersHidden(place(), 'O', null, false)).toBe('site')
      expect(p2pMembersHidden(place({ me: 'invite' }), 'A', null, true)).toBeNull()
      expect(
        p2pMembersHidden(place({ me: 'invite', ...list({ hide: true }) }), 'A', null, true)
      ).toBe('server')
    })
  })
