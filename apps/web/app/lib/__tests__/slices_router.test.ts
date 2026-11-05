import { afterAll, describe, expect, test } from 'bun:test'
import { routeEvent, type Handlers } from '../slices/ctx'
import { applyPresence, rowOnline } from '../slices/presence'
import { IGNORED, eventTables, resetSessionCaches, useStore, type RChatState } from '../store'
import type { WsEvent } from '../types'
import { member, paged, serverDetail } from './fixtures'

afterAll(resetSessionCaches)

const state = (): RChatState => ({
  ...useStore.getState(),
  servers: { s: serverDetail('s', { online_count: 3 }) },
  members: { s: paged([member('bob')]) },
  memberInfo: { s: { carol: member('carol') } },
})

describe('event router', () => {
  test('every handler table owns distinct event types', () => {
    const tables = eventTables()
    const seen = new Set<string>()
    for (const table of tables)
      for (const type of Object.keys(table)) {
        expect(seen.has(type)).toBe(false)
        seen.add(type)
      }
    expect(seen.has('presence_changed')).toBe(true)
    expect(seen.has('message')).toBe(true)
  })

  test('no table handles an ignored type', () => {
    for (const type of IGNORED)
      for (const table of eventTables()) expect(Object.hasOwn(table, type)).toBe(false)
  })

  test('an unknown event type is ignored', () => {
    expect(routeEvent({ type: 'nope' } as unknown as WsEvent, eventTables())).toBe(false)
  })

  test('an event runs the one handler for its type', () => {
    const seen: WsEvent[] = []
    const tables: Handlers[] = [
      { resync: ev => void seen.push(ev) },
      { error: ev => void seen.push(ev) },
    ]
    const ev: WsEvent = { type: 'error', message: 'x' }
    expect(routeEvent(ev, tables)).toBe(true)
    expect(seen).toEqual([ev])
  })
})

describe('presence reducer', () => {
  test('applyPresence counts and flips loaded rows', () => {
    const s = state()
    const out = applyPresence(
      s,
      [
        { server: 's', username: 'bob', online: true, seq: 1 },
        { server: 's', username: 'carol', online: true, online_count: 9, seq: 2 },
      ],
      c => rowOnline(s, c.server, c.username)
    )
    expect(out.servers!.s.online_count).toBe(9)
    expect(out.members!.s.list[0].online).toBe(true)
    expect(out.memberInfo!.s.carol!.online).toBe(true)
  })

  test('applyPresence moves the count by the changes it did not know of', () => {
    const s = state()
    const out = applyPresence(
      s,
      [
        { server: 's', username: 'bob', online: true, seq: 1 },
        { server: 's', username: 'zed', online: true, seq: 2 },
        { server: 's', username: 'carol', online: false, seq: 3 },
      ],
      c => rowOnline(s, c.server, c.username)
    )
    expect(out.servers!.s.online_count).toBe(5)
    expect(out.memberInfo).toBe(s.memberInfo)
  })

  test('applyPresence takes what the log already knew', () => {
    const known = (c: { username: string }) => (c.username === 'zed' ? true : undefined)
    const s = state()
    const out = applyPresence(s, [{ server: 's', username: 'zed', online: true, seq: 1 }], known)
    expect(out.servers).toBe(s.servers)
  })
})
