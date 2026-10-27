import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  PRESENCE_LOG_MAX,
  byCodePoint,
  freshPresence,
  notePresence,
  presenceSnap,
  snapOnline,
  onlineTotals,
  overlayPresence,
  presenceDelta,
  type PresenceLog,
} from '../presence'
import { useStore } from '../store'
import type { Member, WsEvent } from '../types'
import { member, paged, serverDetail } from './fixtures'

const st = () => useStore.getState()
const dispatch = (ev: WsEvent) => st().applyWsEvent(ev)
const frame = () => new Promise(r => setTimeout(r, 20))
const presence = (username: string, online: boolean): WsEvent => ({
  type: 'presence_changed',
  server: 's',
  username,
  online,
})
const realFetch = globalThis.fetch

describe('presence helpers', () => {
  test('overlay applies only notes newer than the snapshot', () => {
    const log: PresenceLog = new Map()
    notePresence(log, 'bob', true, 3)
    notePresence(log, 'carol', true, 1)
    const rows = [member('bob'), member('carol'), member('dave')]
    const out = overlayPresence(rows, log, 2)
    expect(out.map(m => m.online)).toEqual([true, false, false])
    expect(overlayPresence(rows, log, 5)).toBe(rows)
    expect(overlayPresence(rows, undefined, 0)).toBe(rows)
  })

  test('the log keeps the latest note per user and stays bounded', () => {
    const log: PresenceLog = new Map()
    for (let i = 0; i <= PRESENCE_LOG_MAX; i++) notePresence(log, `u${i}`, true, i)
    expect(log.size).toBe(PRESENCE_LOG_MAX)
    expect(log.has('u0')).toBe(false)
    notePresence(log, 'u1', false, 9999)
    expect(log.get('u1')).toEqual({ online: false, seq: 9999 })
  })

  test('a snapshot decides listed names, and others only up to its last name', () => {
    const full = presenceSnap(['bob'], 1, 4)
    expect([snapOnline(full, 'bob'), snapOnline(full, 'zed')]).toEqual([true, false])
    const part = presenceSnap(['bob', 'dave'], 9, 4)
    expect([snapOnline(part, 'carol'), snapOnline(part, 'erin')]).toEqual([false, undefined])
    expect(snapOnline(undefined, 'bob')).toBeUndefined()
  })

  test('names sort by code point, the same order as the server (ws.rs presence_order_matches_the_client)', () => {
    const names = ['\u{1F600}', 'z', '\u{FF21}', 'a', '\u00E9', 'ab', '\u{1F600}a']
    expect([...names].sort(byCodePoint)).toEqual([
      'a',
      'ab',
      'z',
      '\u00E9',
      '\u{FF21}',
      '\u{1F600}',
      '\u{1F600}a',
    ])
    expect('\u{1F600}' < '\u{FF21}').toBe(true)
    const part = presenceSnap(['a', '\u{1F600}'], 9, 4)
    expect(snapOnline(part, '\u{FF21}')).toBe(false)
    expect(snapOnline(part, '\u{1F600}a')).toBeUndefined()
  })

  test('fresh presence prefers whichever of the snapshot and the log is newer', () => {
    const log: PresenceLog = new Map()
    notePresence(log, 'bob', true, 2)
    notePresence(log, 'carol', false, 6)
    const snap = presenceSnap(['carol'], 1, 5)
    const rows = [member('bob'), member('carol'), member('dave', { online: true })]
    expect(freshPresence(rows, log, snap, 1).map(m => m.online)).toEqual([false, false, false])
    expect(freshPresence(rows, log, snap, 5).map(m => m.online)).toEqual([false, false, true])
    expect(freshPresence(rows, undefined, snap, 9)).toBe(rows)
  })

  test('a delta only counts a real change', () => {
    expect(presenceDelta(true, true)).toBe(0)
    expect(presenceDelta(false, false)).toBe(0)
    expect(presenceDelta(false, true)).toBe(1)
    expect(presenceDelta(true, false)).toBe(-1)
    expect(presenceDelta(undefined, true)).toBe(1)
  })

  test('totals follow the rows when the whole list is loaded', () => {
    const rows = [member('a', { online: true }), member('b', { online: true }), member('c')]
    expect(onlineTotals(1, 3, rows, true)).toEqual({ online: 2, offline: 1 })
    expect(onlineTotals(5, 3, rows, true)).toEqual({ online: 2, offline: 1 })
  })

  test('totals never contradict the loaded rows of a partial list', () => {
    const rows = [member('a', { online: true }), member('b', { online: true }), member('c')]
    expect(onlineTotals(1, 100, rows, false)).toEqual({ online: 2, offline: 98 })
    expect(onlineTotals(10, 100, rows, false)).toEqual({ online: 10, offline: 90 })
    expect(onlineTotals(10, 10, rows, false)).toEqual({ online: 9, offline: 1 })
    expect(onlineTotals(4, 10, undefined, false)).toEqual({ online: 4, offline: 6 })
  })
})

describe('presence events in the store', () => {
  let replies: Member[][] = []
  beforeEach(() => {
    replies = []
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(replies.shift() ?? []), { status: 200 })) as typeof fetch
    useStore.setState({ servers: {}, members: {}, memberInfo: {}, interacted: {} })
  })
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  test('a repeated online event for a counted user leaves the count alone', async () => {
    useStore.setState({
      servers: { s: serverDetail('s', { online_count: 1, member_count: 2 }) },
      members: { s: paged([member('bob', { online: true }), member('carol')]) },
    })
    dispatch(presence('bob', true))
    await frame()
    expect(st().servers.s.online_count).toBe(1)
    dispatch(presence('bob', false))
    dispatch(presence('bob', false))
    await frame()
    expect(st().servers.s.online_count).toBe(0)
    expect(st().members.s.list[0].online).toBe(false)
  })

  test('an event that arrives before the member list loads still marks the row', async () => {
    useStore.setState({ servers: { s: serverDetail('s', { online_count: 1, member_count: 2 }) } })
    let release = () => {}
    const gate = new Promise<void>(r => (release = r))
    globalThis.fetch = (async () => {
      await gate
      return new Response(JSON.stringify([member('bob'), member('carol', { online: true })]))
    }) as typeof fetch
    const loading = st().loadMembers('s', true)
    dispatch(presence('bob', true))
    await frame()
    release()
    await loading
    const rows = st().members.s.list
    expect(rows.find(m => m.username === 'bob')?.online).toBe(true)
    expect(rows.find(m => m.username === 'carol')?.online).toBe(true)
  })

  test('an event older than the member list does not override it', async () => {
    useStore.setState({ servers: { s: serverDetail('s', { online_count: 0, member_count: 1 }) } })
    dispatch(presence('bob', true))
    await frame()
    replies = [[member('bob', { online: false })]]
    await st().loadMembers('s', true)
    expect(st().members.s.list[0].online).toBe(false)
  })

  test('a viewing snapshot corrects rows, the count and later deltas', async () => {
    useStore.setState({
      servers: { s: serverDetail('s', { online_count: 1, member_count: 3 }) },
      members: { s: paged([member('bob', { online: true }), member('carol'), member('dave')]) },
    })
    dispatch({ type: 'presence_snapshot', server: 's', online: ['carol'], online_count: 1 })
    expect(st().members.s.list.map(m => m.online)).toEqual([false, true, false])
    expect(st().servers.s.online_count).toBe(1)
    dispatch(presence('carol', true))
    dispatch(presence('dave', true))
    await frame()
    expect(st().servers.s.online_count).toBe(2)
    expect(st().members.s.list.map(m => m.online)).toEqual([false, true, true])
  })

  test('a member page that was in flight during the snapshot is corrected by it', async () => {
    useStore.setState({ servers: { s: serverDetail('s', { online_count: 1, member_count: 2 }) } })
    let release = () => {}
    const gate = new Promise<void>(r => (release = r))
    globalThis.fetch = (async () => {
      await gate
      return new Response(JSON.stringify([member('bob', { online: true }), member('carol')]))
    }) as typeof fetch
    const loading = st().loadMembers('s', true)
    dispatch({ type: 'presence_snapshot', server: 's', online: ['carol'], online_count: 1 })
    release()
    await loading
    expect(st().members.s.list.map(m => [m.username, m.online])).toEqual([
      ['bob', false],
      ['carol', true],
    ])
  })

  test('a partial snapshot only decides names up to its last entry', async () => {
    useStore.setState({
      servers: { s: serverDetail('s', { online_count: 0, member_count: 200 }) },
      members: { s: paged([member('alice', { online: true }), member('zoe', { online: true })]) },
    })
    dispatch({
      type: 'presence_snapshot',
      server: 's',
      online: ['bob', 'carol'],
      online_count: 120,
    })
    expect(st().members.s.list.map(m => m.online)).toEqual([false, true])
    expect(st().servers.s.online_count).toBe(120)
  })

  test('with more than 50 online the server count is the authority', async () => {
    useStore.setState({
      servers: { s: serverDetail('s', { online_count: 0, member_count: 200 }) },
      members: { s: paged([member('zoe', { online: true })]) },
    })
    const names = Array.from({ length: 50 }, (_, i) => `u${String(i).padStart(2, '0')}`)
    dispatch({ type: 'presence_snapshot', server: 's', online: names, online_count: 80 })
    const counted = (username: string, online: boolean, online_count: number): WsEvent => ({
      type: 'presence_changed',
      server: 's',
      username,
      online,
      online_count,
    })
    dispatch(counted('zoe', true, 80))
    dispatch(counted('zoe', true, 80))
    await frame()
    expect(st().servers.s.online_count).toBe(80)
    dispatch(counted('zz', false, 79))
    dispatch(counted('zz', false, 79))
    dispatch(counted('yy', true, 80))
    await frame()
    expect(st().servers.s.online_count).toBe(80)
    dispatch(counted('zoe', false, 79))
    await frame()
    expect(st().servers.s.online_count).toBe(79)
    expect(st().members.s.list[0].online).toBe(false)
  })
})
