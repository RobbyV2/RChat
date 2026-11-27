import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { resetSessionCaches, useStore } from '../store'
import { ChannelPermBit as B, type Channel, type ChannelPerm, type WsEvent } from '../types'
import { me, member, role, serverDetail, until } from './fixtures'
import { loadPerms } from './helpers/perms'

afterAll(resetSessionCaches)
beforeAll(() => loadPerms())

const st = () => useStore.getState()
const realFetch = globalThis.fetch
let requests: string[] = []
let channelRules: ChannelPerm[] = []
let categoryRules: ChannelPerm[] = []
let confirms: string[] = []
let syncAnswer = 200

const rule = (subject: string, allow: number, deny: number): ChannelPerm => ({
  subject,
  can_view: true,
  can_send: true,
  can_read_history: true,
  allow,
  deny,
  mode: 'override',
})

const plans: Channel = {
  id: 5,
  name: 'plans',
  kind: 'text',
  slowmode_seconds: 0,
  category_id: 7,
  perm_sync: false,
}

beforeEach(() => {
  resetSessionCaches()
  requests = []
  confirms = []
  syncAnswer = 200
  channelRules = []
  categoryRules = []
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    requests.push(`${init?.method ?? 'GET'} ${url.pathname}${init?.body ? ` ${init.body}` : ''}`)
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 })
    if (url.pathname === '/api/channels/5/perms') return json(channelRules)
    if (url.pathname === '/api/categories/7/perms') return json(categoryRules)
    if (url.pathname.endsWith('/sync'))
      return syncAnswer === 200
        ? json({ ok: true })
        : new Response(JSON.stringify({ error: 'Syncing lets r:9 see or send here.' }), {
            status: syncAnswer,
          })
    if (url.pathname === '/api/servers/s/members' && url.searchParams.getAll('usernames').length)
      return json([member('carol', { role_ids: [1] })])
    return json(useStore.getState().servers.s)
  }) as typeof fetch
  useStore.setState({
    guest: false,
    me: me('alice', {
      servers: [{ name: 's', display_name: 's', creator: null, is_admin: true }],
    }),
    servers: {
      s: serverDetail('s', {
        channels: [plans],
        categories: [{ id: 7, name: 'Team', position: 0 }],
        roles: [{ ...role(1, '#000001', 0), name: 'Mods' }],
      }),
    },
    askConfirm: c => {
      confirms.push(c.body)
      c.action('')
    },
  })
})

afterEach(() => {
  globalThis.fetch = realFetch
})

const syncs = () => requests.filter(r => r.startsWith('POST'))

describe('syncing a channel with its category', () => {
  test('a sync that lets nobody new in goes ahead without asking', async () => {
    channelRules = [rule('r:1', B.ViewChannels, 0)]
    await st().syncChannelPerms('s', 5)
    expect(confirms).toEqual([])
    expect(syncs()).toEqual(['POST /api/channels/5/perms/sync {"confirm":false}'])
  })

  test('a sync that lets someone in names them first, then confirms it', async () => {
    channelRules = [rule('r:1', 0, B.ViewChannels)]
    categoryRules = []
    await st().syncChannelPerms('s', 5)
    await until(() => syncs().length > 0)
    expect(confirms).toEqual(['Syncing with Team lets Mods see or send in #plans.'])
    expect(syncs()).toEqual(['POST /api/channels/5/perms/sync {"confirm":true}'])
  })

  test('a member subject counts with the roles they hold', async () => {
    channelRules = [
      rule('everyone', 0, B.ViewChannels),
      rule('r:1', B.ViewChannels, 0),
      rule('u:carol', 0, B.ViewChannels),
    ]
    categoryRules = [rule('everyone', 0, B.ViewChannels), rule('r:1', B.ViewChannels, 0)]
    await st().syncChannelPerms('s', 5)
    await until(() => syncs().length > 0)
    expect(confirms).toEqual(['Syncing with Team lets carol see or send in #plans.'])
  })

  test('when the server finds more than this device did, it asks with no names', async () => {
    syncAnswer = 409
    await st().syncChannelPerms('s', 5)
    await until(() => confirms.length > 0)
    expect(confirms).toEqual(['Syncing with Team lets more people see or send in #plans.'])
  })

  test('a channel outside a category is left alone', async () => {
    useStore.setState(s => ({
      servers: { s: { ...s.servers.s, channels: [{ ...plans, category_id: null }] } },
    }))
    await st().syncChannelPerms('s', 5)
    expect(requests).toEqual([])
  })
})

test('rules of several channels changing reload the server', async () => {
  st().applyWsEvent({
    type: 'channels_perms_changed',
    server: 's',
    channel_ids: [5],
  } as WsEvent)
  await until(() => requests.includes('GET /api/servers/s'))
  expect(requests).toContain('GET /api/servers/s')
})
