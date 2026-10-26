import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { dmView, folderLabel, railOrder, railServers, useStore } from '../store'
import { emptyLayout, type Folder, type Layout } from '../nav_layout'
import type { DmSummary, ServerSummary, WsEvent } from '../types'
import { me, msg, serverDetail, user } from './fixtures'

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

describe('server folders', () => {
  const folder = () => st().layout.servers.find((e): e is Folder => typeof e !== 'string')
  const withServers = (...names: string[]) =>
    useStore.setState({ me: me('alice', { servers: names.map(srv) }) })

  test('merging creates a collapsed folder that persists as layout v2', () => {
    withServers('rchat', 'a', 'b', 'c')
    st().mergeServers('c', 'a')
    const f = folder() as Folder
    expect(f).toEqual({ id: f.id, name: null, servers: ['a', 'c'], open: false })
    expect(/^[0-9a-z]+$/.test(f.id)).toBe(true)
    expect(railOrder(st())).toEqual(['rchat', 'a', 'c', 'b'])
    expect(saved('rchat_layout:alice')).toEqual({
      ...emptyLayout,
      v: 2,
      servers: ['rchat', f, 'b'],
    })
  })

  test('adding, moving inside, toggling, renaming and ungrouping go through the store', () => {
    withServers('rchat', 'a', 'b', 'c')
    st().mergeServers('b', 'a')
    const id = folder()?.id ?? ''
    st().addToFolder('rchat', id)
    expect(folder()?.servers).toEqual(['a', 'b', 'rchat'])
    st().moveIntoFolder('rchat', id, 0)
    expect(folder()?.servers).toEqual(['rchat', 'a', 'b'])
    st().toggleFolder(id)
    st().renameFolder(id, 'Mine')
    expect(folder()).toEqual({ id, name: 'Mine', servers: ['rchat', 'a', 'b'], open: true })
    expect(saved('rchat_layout:alice')?.servers[0]).toEqual(folder())
    st().moveFolder(id, 1)
    expect(st().layout.servers).toEqual(['c', folder() as Folder])
    st().ungroupFolder(id)
    expect(st().layout.servers).toEqual(['c', 'rchat', 'a', 'b'])
  })

  test('dragging a server out of a folder of two dissolves it in place', () => {
    withServers('rchat', 'a', 'b', 'c')
    st().mergeServers('b', 'a')
    st().moveServer('a', 3)
    expect(st().layout.servers).toEqual(['rchat', 'b', 'c', 'a'])
  })

  test('server events rename and remove folder children', () => {
    withServers('rchat', 'a', 'b', 'c', 'd')
    st().mergeServers('b', 'a')
    st().addToFolder('c', folder()?.id ?? '')
    dispatch({
      type: 'server_renamed',
      old_name: 'b',
      server: { name: 'bee', display_name: 'Bee', creator: null, has_password: false },
    })
    expect(folder()?.servers).toEqual(['a', 'bee', 'c'])
    expect(saved('rchat_layout:alice')?.servers[1]).toEqual(folder())
    dispatch({ type: 'member_left', server: 'a', username: 'alice' })
    expect(folder()?.servers).toEqual(['bee', 'c'])
    dispatch({ type: 'server_deleted', name: 'c' })
    expect(folder()).toBeUndefined()
    expect(st().layout.servers).toEqual(['rchat', 'bee', 'd'])
    expect(saved('rchat_layout:alice')?.servers).toEqual(['rchat', 'bee', 'd'])
  })

  test('a kicked or banned server leaves its folder', () => {
    withServers('rchat', 'a', 'b')
    st().mergeServers('b', 'a')
    dispatch({ type: 'member_kicked', server: 'b', username: 'alice', banned: true })
    expect(st().layout.servers).toEqual(['rchat', 'a'])
  })

  test('a v1 layout saved by an older version is migrated on load', () => {
    storage.set('rchat_layout:alice', JSON.stringify({ v: 1, servers: ['b', 'a'], dmOrder: [] }))
    st().reloadLayout()
    expect(st().layout).toEqual({ ...emptyLayout, servers: ['b', 'a'] })
    expect(railOrder(st())).toEqual(['b', 'a', 'rchat'])
  })

  test('the tooltip and rename placeholder list only the loaded servers of a folder', () => {
    useStore.setState({
      me: me('alice', {
        servers: [srv('rchat'), { ...srv('a'), display_name: 'Alpha' }, srv('b')],
      }),
    })
    const f: Folder = { id: 'f', name: null, servers: ['a', 'later', 'b'], open: false }
    expect(folderLabel(st(), f)).toBe('Alpha, b')
    expect(folderLabel(st(), { ...f, name: 'Games' })).toBe('Games')
    expect(folderLabel(st(), { ...f, name: 'Games' }, null)).toBe('Alpha, b')
    useStore.setState({
      me: null,
      guest: true,
      guestServers: ['rchat', 'a', 'b'],
      servers: { a: serverDetail('a', { display_name: 'Alpha', creator: 'bob' }) },
    })
    expect(railServers(st())).toEqual([
      { name: 'rchat', display_name: 'rchat', creator: null },
      { name: 'a', display_name: 'Alpha', creator: 'bob' },
      { name: 'b', display_name: 'b', creator: null },
    ])
    expect(folderLabel(st(), f, null)).toBe('Alpha, b')
  })

  test('guests keep folders under the guest key', () => {
    useStore.setState({ me: null, guest: true, guestServers: ['rchat', 'x', 'y'] })
    st().mergeServers('y', 'rchat')
    expect(railOrder(st())).toEqual(['rchat', 'y', 'x'])
    expect(saved('rchat_layout:guest')?.servers[0]).toEqual(folder())
    expect(st().guestServers).toEqual(['rchat', 'x', 'y'])
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
