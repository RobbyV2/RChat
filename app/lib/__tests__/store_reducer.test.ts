import { beforeEach, describe, expect, test } from 'bun:test'
import { useStore } from '../store'
import type { WsEvent } from '../types'
import { embed, me, media, member, msg, paged, serverDetail, user } from './fixtures'

const dispatch = (ev: WsEvent) => useStore.getState().applyWsEvent(ev)
const st = () => useStore.getState()
const scoped = { server: 's', channel_id: 1, dm_id: null, dm_users: null }

beforeEach(() => {
  useStore.setState({
    me: null,
    messages: {},
    servers: {},
    members: {},
    interacted: {},
    dms: [],
    panel: null,
    adminOverview: null,
    adminUsers: paged([]),
  })
})

describe('message', () => {
  test('channel message appends to the channel cache', () => {
    useStore.setState({ messages: { c1: [msg(10)] } })
    dispatch({ type: 'message', ...scoped, message: msg(11, { channel_id: 1 }) })
    expect(st().messages.c1.map(m => m.id)).toEqual([10, 11])
  })

  test('thread reply bumps root reply_count and stays out of the channel list', () => {
    useStore.setState({
      messages: {
        c1: [msg(50, { reply_count: 1 })],
        t50: [msg(51, { thread_root_id: 50 })],
      },
      panel: { kind: 'thread', root: msg(50, { reply_count: 1 }) },
    })
    dispatch({
      type: 'message',
      ...scoped,
      message: msg(52, { channel_id: 1, thread_root_id: 50 }),
    })
    const s = st()
    expect(s.messages.t50.map(m => m.id)).toEqual([51, 52])
    expect(s.messages.c1.map(m => m.id)).toEqual([50])
    expect(s.messages.c1[0].reply_count).toBe(2)
    expect(s.panel?.kind === 'thread' && s.panel.root.reply_count).toBe(2)
  })
})

describe('message_deleted', () => {
  beforeEach(() => {
    useStore.setState({
      messages: {
        c1: [msg(50, { reply_count: 2 }), msg(60)],
        t50: [msg(51, { thread_root_id: 50 }), msg(52, { thread_root_id: 50 })],
      },
      panel: { kind: 'thread', root: msg(50, { reply_count: 2 }) },
    })
  })

  test('deleting a reply filters caches and decrements reply_count', () => {
    dispatch({ type: 'message_deleted', ...scoped, id: 51, thread_root_id: 50 })
    const s = st()
    expect(s.messages.t50.map(m => m.id)).toEqual([52])
    expect(s.messages.c1.find(m => m.id === 50)?.reply_count).toBe(1)
    expect(s.messages.c1.map(m => m.id)).toEqual([50, 60])
    expect(s.panel?.kind === 'thread' && s.panel.root.reply_count).toBe(1)
  })

  test('deleting the root drops the thread cache and closes the panel', () => {
    dispatch({ type: 'message_deleted', ...scoped, id: 50, thread_root_id: null })
    const s = st()
    expect(s.messages.t50).toBeUndefined()
    expect(s.messages.c1.map(m => m.id)).toEqual([60])
    expect(s.panel).toBeNull()
  })
})

describe('media / embeds patching via patchMessage', () => {
  test('media_removed marks removed across every cache', () => {
    useStore.setState({
      messages: {
        c1: [msg(70, { media: media() })],
        t70: [msg(70, { media: media() })],
      },
    })
    dispatch({
      type: 'media_removed',
      ...scoped,
      message_id: 70,
      filename: 'f.png',
      removed_by_author: true,
    })
    for (const key of ['c1', 't70']) {
      const m = st().messages[key][0].media
      expect(m?.removed).toBe(true)
      expect(m?.removed_by_author).toBe(true)
    }
  })

  test('embeds_resolved sets the embed list', () => {
    useStore.setState({ messages: { c1: [msg(80)] } })
    dispatch({ type: 'embeds_resolved', ...scoped, message_id: 80, embeds: [embed(0)] })
    expect(st().messages.c1[0].embeds.map(e => e.ord)).toEqual([0])
  })

  test('embeds_removed banner marks banner_removed; full removes the embed', () => {
    useStore.setState({ messages: { c1: [msg(90, { embeds: [embed(0), embed(1)] })] } })
    dispatch({ type: 'embeds_removed', ...scoped, message_id: 90, ord: 0, banner: true })
    let embeds = st().messages.c1[0].embeds
    expect(embeds.find(e => e.ord === 0)?.banner_removed).toBe(true)
    expect(embeds.find(e => e.ord === 1)?.banner_removed).toBe(false)
    dispatch({ type: 'embeds_removed', ...scoped, message_id: 90, ord: 1, banner: false })
    embeds = st().messages.c1[0].embeds
    expect(embeds.map(e => e.ord)).toEqual([0])
  })
})

describe('presence_changed', () => {
  test('patches loaded rows and adjusts online_count', () => {
    useStore.setState({
      servers: { s: serverDetail('s', { online_count: 0 }) },
      members: { s: paged([member('bob', { online: false })]) },
    })
    dispatch({ type: 'presence_changed', server: 's', username: 'bob', online: true })
    expect(st().servers.s.online_count).toBe(1)
    expect(st().members.s.list[0].online).toBe(true)
    dispatch({ type: 'presence_changed', server: 's', username: 'bob', online: false })
    expect(st().servers.s.online_count).toBe(0)
    expect(st().members.s.list[0].online).toBe(false)
  })
})

describe('membership count math', () => {
  test('member_joined bumps member_count and adds the row', () => {
    useStore.setState({
      me: me('alice'),
      servers: { s: serverDetail('s', { member_count: 1 }) },
      members: { s: paged([member('alice')]) },
    })
    dispatch({ type: 'member_joined', server: 's', member: member('bob') })
    expect(st().servers.s.member_count).toBe(2)
    expect(st().members.s.list.map(m => m.username)).toEqual(['alice', 'bob'])
  })

  test('member_left decrements member_count and removes the row', () => {
    useStore.setState({
      me: me('alice'),
      servers: { s: serverDetail('s', { member_count: 2 }) },
      members: { s: paged([member('alice'), member('bob')]) },
    })
    dispatch({ type: 'member_left', server: 's', username: 'bob' })
    expect(st().servers.s.member_count).toBe(1)
    expect(st().members.s.list.map(m => m.username)).toEqual(['alice'])
  })

  test('member_kicked mirrors member_left', () => {
    useStore.setState({
      me: me('alice'),
      servers: { s: serverDetail('s', { member_count: 2 }) },
      members: { s: paged([member('alice'), member('bob')]) },
    })
    dispatch({ type: 'member_kicked', server: 's', username: 'bob' })
    expect(st().servers.s.member_count).toBe(1)
    expect(st().members.s.list.map(m => m.username)).toEqual(['alice'])
  })

  test('banned purges the user everywhere but leaves member_count to member events', () => {
    useStore.setState({
      me: me('alice'),
      servers: { s: serverDetail('s', { member_count: 3 }) },
      members: { s: paged([member('alice'), member('bob')]) },
      dms: [{ id: 1, other: user('bob'), is_self: false }],
      messages: { c1: [msg(1, { author: user('bob') }), msg(2, { author: user('alice') })] },
      adminOverview: { user_count: 5, server_count: 2 },
      adminUsers: paged([user('bob')]),
    })
    dispatch({ type: 'banned', username: 'bob' })
    const s = st()
    expect(s.members.s.list.map(m => m.username)).toEqual(['alice'])
    expect(s.adminUsers.list.map(u => u.username)).toEqual([])
    expect(s.dms).toHaveLength(0)
    expect(s.messages.c1.map(m => m.id)).toEqual([2])
    expect(s.adminOverview?.user_count).toBe(4)
    expect(s.servers.s.member_count).toBe(3)
  })
})
