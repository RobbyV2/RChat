import { describe, expect, test } from 'bun:test'
import {
  DAY_CHOICES,
  DEFAULT_PREFS,
  forget,
  MAX_MAX,
  MAX_MIN,
  moveIdentity,
  parsePrefs,
  prefsKey,
  prune,
  PRUNE_EVERY,
  pruneOpts,
  signedOut,
  tableName,
} from '../command_log/retention'
import type { LogEntry, LogPrefs } from '../command_log/types'
import { memoryRecords } from '../platform/memory_records'

const DAY = 86_400_000

const entry = (id: string, at: number, identity?: string): LogEntry => ({
  v: 1,
  id,
  at,
  actor: { account: 'alice@a.example', ...(identity ? { identity } : {}) },
  via: 'palette',
  action: 'core.x',
  title: id,
  outcome: 'ok',
})

const prefs = (over: Partial<LogPrefs> = {}): LogPrefs => ({ ...DEFAULT_PREFS, ...over })

describe('prefs', () => {
  test('the defaults', () => {
    expect(DEFAULT_PREFS).toEqual({
      v: 1,
      on: true,
      days: 30,
      max: 1000,
      keep_after_sign_out: false,
    })
    expect(DAY_CHOICES).toEqual([7, 30, 90, 365])
    expect([MAX_MIN, MAX_MAX]).toEqual([100, 5000])
    expect(PRUNE_EVERY).toBe(50)
  })

  test('what was stored comes back', () => {
    const stored = prefs({ on: false, days: 90, max: 250, keep_after_sign_out: true })
    expect(parsePrefs(JSON.stringify(stored))).toEqual(stored)
  })

  test('bad JSON, another version or another shape gives the defaults', () => {
    for (const raw of [null, '', '{', 'null', '[]', '7', '"x"', '{"v":2,"on":false}', '{}'])
      expect(parsePrefs(raw)).toEqual(DEFAULT_PREFS)
  })

  test('each bad field falls back by itself', () => {
    expect(parsePrefs('{"v":1,"on":"no","days":31,"max":"9","keep_after_sign_out":1}')).toEqual(
      DEFAULT_PREFS
    )
    expect(parsePrefs('{"v":1,"on":false,"days":7,"max":1e9}')).toEqual(
      prefs({ on: false, days: 7, max: 5000 })
    )
    expect(parsePrefs('{"v":1,"max":3}').max).toBe(100)
    expect(parsePrefs('{"v":1,"max":250.7}').max).toBe(250)
    expect(parsePrefs('{"v":1,"max":null}').max).toBe(1000)
    expect(parsePrefs('{"v":1,"extra":true}')).toEqual(DEFAULT_PREFS)
  })

  test('names are per account', () => {
    expect(tableName('alice@chat.a.com')).toBe('rchat_cmdlog:alice@chat.a.com')
    expect(prefsKey('alice@chat.a.com')).toBe('rchat_cmdlog_prefs:alice@chat.a.com')
  })
})

describe('pruning', () => {
  test('by days and count', async () => {
    const now = 100 * DAY
    expect(pruneOpts(prefs(), now)).toEqual({ olderThan: 70 * DAY, keep: 1000 })
    expect(pruneOpts(prefs({ days: 7, max: 100 }), now)).toEqual({ olderThan: 93 * DAY, keep: 100 })
    const table = memoryRecords().open<LogEntry>('t')
    await table.put([
      entry('old', 69 * DAY),
      entry('edge', 70 * DAY),
      entry('new', 99 * DAY),
      entry('newer', 100 * DAY),
    ])
    expect(await prune(table, prefs(), now)).toBe(1)
    expect((await table.list()).map(e => e.id)).toEqual(['newer', 'new', 'edge'])
    expect(await prune(table, prefs({ max: 100 }), now)).toBe(0)
    await table.put(Array.from({ length: 150 }, (_, i) => entry(`e${i}`, 80 * DAY + i)))
    expect(await prune(table, prefs({ max: 100 }), now)).toBe(53)
    expect(await table.count()).toBe(100)
    expect((await table.list({ limit: 2 })).map(e => e.id)).toEqual(['newer', 'new'])
  })

  test('with logging paused, old entries age out', async () => {
    const table = memoryRecords().open<LogEntry>('t')
    await table.put([entry('old', 0), entry('new', 50 * DAY)])
    expect(await prune(table, prefs({ on: false }), 50 * DAY)).toBe(1)
  })
})

describe('lifecycle', () => {
  test('signing out drops the table unless it is kept', async () => {
    const store = memoryRecords()
    const name = tableName('alice@a.example')
    await store.open<LogEntry>(name).put([entry('a', 1)])
    await signedOut(store, 'alice@a.example', prefs({ keep_after_sign_out: true }))
    expect(await store.open<LogEntry>(name).count()).toBe(1)
    await signedOut(store, 'alice@a.example', prefs())
    expect(await store.open<LogEntry>(name).count()).toBe(0)
  })

  test('removing an account always drops it, and only its own', async () => {
    const store = memoryRecords()
    await store.open<LogEntry>(tableName('alice@a.example')).put([entry('a', 1)])
    await store.open<LogEntry>(tableName('bob@a.example')).put([entry('b', 1)])
    await forget(store, 'alice@a.example')
    expect(await store.open<LogEntry>(tableName('alice@a.example')).count()).toBe(0)
    expect(await store.open<LogEntry>(tableName('bob@a.example')).count()).toBe(1)
  })

  test('moving a P2P identity moves its entries, and no others', async () => {
    const store = memoryRecords()
    const from = store.open<LogEntry>(tableName('alice@a.example'))
    const to = store.open<LogEntry>(tableName('bob@b.example'))
    await from.put([
      entry('own', 1),
      entry('other', 2, 'p2'),
      ...Array.from({ length: 120 }, (_, i) => entry(`m${i}`, 10 + i, 'p1')),
    ])
    await to.put([entry('there', 5)])
    expect(await moveIdentity(from, to, 'p1', 'bob@b.example')).toBe(120)
    expect((await from.list()).map(e => e.id)).toEqual(['other', 'own'])
    expect(await to.count()).toBe(121)
    const moved = await to.list({ limit: 1 })
    expect(moved[0]).toEqual({
      ...entry('m119', 129, 'p1'),
      actor: { account: 'bob@b.example', identity: 'p1' },
    })
    expect(await moveIdentity(from, to, 'p1', 'bob@b.example')).toBe(0)
  })
})
