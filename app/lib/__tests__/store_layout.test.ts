import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { dmView, railOrder, useStore } from '../store'
import { emptyLayout, type Layout } from '../nav_layout'
import type { DmSummary, ServerSummary, WsEvent } from '../types'
import { me, msg, user } from './fixtures'

const st = () => useStore.getState()
const dispatch = (ev: WsEvent) => st().applyWsEvent(ev)
const dm = (id: number, other: string, is_self = false): DmSummary => ({
  id,
  other: user(other),
  is_self,
})
const srv = (name: string): ServerSummary => ({
  name,
  display_name: name,
  creator: null,
  is_admin: false,
})
const recent = () => dmView(st()).recent.map(d => d.id)
const pinned = () => dmView(st()).pinned.map(d => d.id)
const tick = () => new Promise(r => setTimeout(r, 0))

const storage = new Map<string, string>()
const saved = (key: string): Layout | null => {
  const raw = storage.get(key)
  return raw ? (JSON.parse(raw) as Layout) : null
}

const realFetch = globalThis.fetch
const serve = (body: unknown) => {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch
}

beforeEach(() => {
  storage.clear()
  Object.assign(globalThis, {
    localStorage: {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => void storage.set(k, v),
      removeItem: (k: string) => void storage.delete(k),
    },
  })
  useStore.setState({
    me: me('alice', { servers: [srv('rchat'), srv('a'), srv('b')] }),
    guest: false,
    guestServers: ['rchat'],
    view: null,
    servers: {},
    reads: {},
    dms: [dm(1, 'alice', true), dm(2, 'bob'), dm(3, 'carol')],
    dmsMore: false,
    layout: emptyLayout,
  })
})

afterEach(() => {
  globalThis.fetch = realFetch
  delete (globalThis as { localStorage?: unknown }).localStorage
})

describe('rail order', () => {
  test('moving a server reorders the rail and persists per account', () => {
    st().moveServer('b', 0)
    expect(railOrder(st())).toEqual(['b', 'rchat', 'a'])
    expect(saved('rchat_layout:alice')?.servers).toEqual(['b', 'rchat', 'a'])
  })

  test('joined servers append, renames keep the slot, leaving drops it', () => {
    st().moveServer('rchat', 2)
    useStore.setState({
      me: me('alice', { servers: [srv('rchat'), srv('a'), srv('b'), srv('c')] }),
    })
    expect(railOrder(st())).toEqual(['a', 'b', 'rchat', 'c'])
    dispatch({
      type: 'server_renamed',
      old_name: 'b',
      server: { name: 'bee', display_name: 'Bee', creator: null, has_password: false },
    })
    expect(railOrder(st())).toEqual(['a', 'bee', 'rchat', 'c'])
    expect(saved('rchat_layout:alice')?.servers).toEqual(['a', 'bee', 'rchat'])
    dispatch({ type: 'member_left', server: 'a', username: 'alice' })
    expect(st().layout.servers).toEqual(['bee', 'rchat'])
    expect(saved('rchat_layout:alice')?.servers).toEqual(['bee', 'rchat'])
  })

  test('guests reorder their local server list under the guest key', () => {
    useStore.setState({ me: null, guest: true, guestServers: ['rchat', 'x', 'y'] })
    st().moveServer('y', 0)
    expect(railOrder(st())).toEqual(['y', 'rchat', 'x'])
    expect(saved('rchat_layout:guest')?.servers).toEqual(['y', 'rchat', 'x'])
    expect(st().guestServers).toEqual(['rchat', 'x', 'y'])
  })

  test('reloadLayout picks up a change made in another tab', () => {
    storage.set('rchat_layout:alice', JSON.stringify({ ...emptyLayout, servers: ['a'] }))
    st().reloadLayout()
    expect(railOrder(st())).toEqual(['a', 'rchat', 'b'])
  })
})

describe('dm order', () => {
  test('before any reorder activity moves dms below the self dm', () => {
    dispatch({
      type: 'message',
      server: null,
      channel_id: null,
      dm_id: 3,
      dm_users: ['alice', 'carol'],
      message: msg(50, { channel_id: null, dm_id: 3, author: user('carol') }),
    })
    expect(recent()).toEqual([1, 3, 2])
  })

  test('after a manual reorder activity no longer moves dms but a new dm goes on top', async () => {
    st().placeDm(1, 'recent', 2)
    expect(recent()).toEqual([2, 3, 1])
    expect(saved('rchat_layout:alice')).toEqual({
      ...emptyLayout,
      dmOrder: [2, 3, 1],
      dmSeen: 3,
    })
    dispatch({
      type: 'message',
      server: null,
      channel_id: null,
      dm_id: 3,
      dm_users: ['alice', 'carol'],
      message: msg(50, { channel_id: null, dm_id: 3, author: user('carol') }),
    })
    expect(recent()).toEqual([2, 3, 1])
    serve([dm(9, 'dave')])
    dispatch({ type: 'dm_created', dm_id: 9, dm_users: ['alice', 'dave'] })
    await tick()
    expect(recent()).toEqual([9, 2, 3, 1])
  })

  test('pinning by drag or menu moves dms out of recent and back', () => {
    st().placeDm(3, 'pinned', 0)
    st().pinDm(1)
    expect(pinned()).toEqual([3, 1])
    expect(recent()).toEqual([2])
    expect(saved('rchat_layout:alice')?.dmPinned).toEqual([3, 1])
    st().placeDm(1, 'pinned', 0)
    expect(pinned()).toEqual([1, 3])
    st().unpinDm(3)
    expect(pinned()).toEqual([1])
    expect(recent()).toEqual([2, 3])
    st().placeDm(1, 'recent', 0)
    expect(pinned()).toEqual([])
    expect(recent()).toEqual([1, 2, 3])
  })
})
