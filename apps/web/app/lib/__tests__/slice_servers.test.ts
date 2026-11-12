import { afterAll, describe, expect, test } from 'bun:test'
import { applyServerChange, dropMemberRow } from '../slices/servers'
import { resetSessionCaches, useStore, type RChatState } from '../store'
import type { Channel, ServerSummaryLite } from '../types'
import { me, member, paged, role, serverDetail, user } from './fixtures'

afterAll(resetSessionCaches)

const state = (over: Partial<RChatState>): RChatState => ({ ...useStore.getState(), ...over })
const channel: Channel = { id: 1, name: 'general', kind: 'text', slowmode_seconds: 0 }
const lite = (over: Partial<ServerSummaryLite> = {}): ServerSummaryLite => ({
  name: 's',
  display_name: 'New',
  creator: null,
  has_password: true,
  banner_color: '#222222',
  name_color: '#333333',
  ...over,
})

describe('servers reducers', () => {
  test('server_updated patches only the named fields', () => {
    const detail = serverDetail('s', {
      display_name: 'Old',
      channels: [channel],
      roles: [role(1, '#ff0000', 0)],
      member_count: 4,
      online_count: 2,
      banner_color: '#111111',
    })
    const s = state({
      servers: { s: detail, t: serverDetail('t') },
      me: me('bob', {
        servers: [
          { name: 's', display_name: 'Old', creator: null, is_admin: true },
          { name: 't', display_name: 't', creator: null, is_admin: false },
        ],
      }),
      view: null,
      voice: null,
    })
    const out = applyServerChange(s, { type: 'server_updated', server: lite() })
    expect(out.servers!.s).toEqual({
      ...detail,
      display_name: 'New',
      has_password: true,
      banner_color: '#222222',
      name_color: '#333333',
      public_read: null,
    })
    for (const public_read of [true, false, null]) {
      const read = applyServerChange(s, {
        type: 'server_updated',
        server: { ...lite(), public_read },
      })
      expect(read.servers!.s.public_read).toBe(public_read)
    }
    expect(out.servers!.t).toBe(s.servers.t)
    expect(out.me!.servers).toEqual([
      {
        name: 's',
        display_name: 'New',
        creator: null,
        is_admin: true,
        banner_color: '#222222',
        name_color: '#333333',
      },
      s.me!.servers[1],
    ])
  })

  test('server_renamed moves the server and its cached state to the new name', () => {
    const t = { name: 't', display_name: 't', creator: null, is_admin: false }
    const s = state({
      servers: { s: serverDetail('s') },
      members: { s: paged([member('bob')]) },
      memberInfo: { s: { bob: member('bob') } },
      interacted: { s: paged([user('carol')]) },
      reads: { c1: { lastRead: 1, latest: 2, server: 's' } },
      pings: { c1: { scope: 'c1', server: 's', bulk: 1, bulkUntil: 2, ids: [] } },
      groupPings: { c1: { server: 's', items: [{ message_id: 2, kinds: ['everyone'] }] } },
      me: me('bob', {
        servers: [{ name: 's', display_name: 'Old', creator: null, is_admin: true }, t],
      }),
      view: { kind: 'channel', server: 's', channelId: 1 },
      voice: { server: 's', channelId: 2 },
      adminServers: paged([lite({ name: 's', display_name: 'Old' }), lite({ name: 't' })]),
    })
    const renamed = lite({ name: 'z' })
    const out = applyServerChange(s, { type: 'server_renamed', old_name: 's', server: renamed })
    expect(Object.keys(out.servers!)).toEqual(['z'])
    expect(out.servers!.z.name).toBe('z')
    expect(out.members!.z).toBe(s.members.s)
    expect(out.memberInfo!.z).toBe(s.memberInfo.s)
    expect(out.interacted).toEqual({ z: s.interacted.s })
    expect(out.reads!.c1.server).toBe('z')
    expect(out.pings).toEqual({ c1: { ...s.pings.c1, server: 'z' } })
    expect(out.groupPings).toEqual({ c1: { ...s.groupPings.c1, server: 'z' } })
    expect(out.view).toEqual({ kind: 'channel', server: 'z', channelId: 1 })
    expect(out.voice).toEqual({ server: 'z', channelId: 2 })
    expect(out.me!.servers).toEqual([
      {
        name: 'z',
        display_name: 'New',
        creator: null,
        is_admin: true,
        banner_color: '#222222',
        name_color: '#333333',
      },
      t,
    ])
    expect(out.adminServers!.list).toEqual([renamed, s.adminServers.list[1]])
  })

  test('member_left drops the cached row', () => {
    const s = state({
      members: { s: paged([member('bob'), member('carol')]), t: paged([member('bob')]) },
    })
    const out = dropMemberRow(s, 's', 'bob')
    expect(out.members!.s.list.map(m => m.username)).toEqual(['carol'])
    expect(out.members!.t).toBe(s.members.t)
    expect(dropMemberRow(s, 's', 'zed').members!.s.list).toEqual(s.members.s.list)
    expect(dropMemberRow(s, 'x', 'bob')).toEqual({})
  })
})
