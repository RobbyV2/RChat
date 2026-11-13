import { describe, expect, test } from 'bun:test'
import type { LogStep } from '../command_log/policy'
import { type ActionRun, recorder, WRITE_MS } from '../command_log/recorder'
import { HIDDEN } from '../command_log/redact'
import { DEFAULT_PREFS } from '../command_log/retention'
import type { LogEntry, LogPrefs } from '../command_log/types'
import { memoryRecords } from '../platform/memory_records'
import type { RecordTable } from '../platform/records'

const DAY = 86_400_000
const actor = { account: 'alice@a.example' }

const rig = (over: Partial<LogPrefs> = {}, table?: RecordTable<LogEntry>) => {
  const t = table ?? memoryRecords().open<LogEntry>('log')
  const state = { now: 1000 * DAY, n: 0, prefs: { ...DEFAULT_PREFS, ...over } }
  const timers: { run: () => void; ms: number }[] = []
  const log = recorder({
    table: t,
    prefs: () => state.prefs,
    now: () => state.now,
    id: () => `id${(state.n += 1)}`,
    later: (run, ms) => void timers.push({ run, ms }),
  })
  const all = async () => {
    await log.flush()
    return t.list({ limit: 10_000 })
  }
  return { log, table: t, state, timers, all }
}

const steps: LogStep[] = [
  { name: 'member', kind: 'user', label: 'carol' },
  { name: 'duration', kind: 'duration', label: '1 hour' },
  { name: 'reason', kind: 'text' },
  { name: 'ok', kind: 'confirm' },
]

const timeout = (over: Partial<ActionRun> = {}): ActionRun => ({
  actor,
  via: 'palette',
  action: { id: 'core.timeout', title: 'Time out', steps },
  args: { member: 'u:carol', duration: '3600', reason: 'spamming links', ok: '1' },
  target: { kind: 'member', label: 'carol', ref: { server: 'pixel' } },
  result: { kind: 'ok', text: 'Timed out' },
  ms: 41,
  ...over,
})

describe('one entry per run', () => {
  test('a run with a result', async () => {
    const { log, all } = rig()
    expect(log.action(timeout())).toBe('id1')
    expect(await all()).toEqual([
      {
        v: 1,
        id: 'id1',
        at: 1000 * DAY,
        actor,
        via: 'palette',
        action: 'core.timeout',
        title: 'Time out',
        target: { kind: 'member', label: 'carol', ref: { server: 'pixel' } },
        args: [
          { name: 'member', value: 'carol' },
          { name: 'duration', value: '1 hour' },
          { name: 'reason', value: HIDDEN },
        ],
        outcome: 'ok',
        text: 'Timed out',
        ms: 41,
      },
    ])
  })

  test('outcomes: nothing returned, info, an error, a cancel at a step', async () => {
    const { log, all } = rig()
    log.action(timeout({ result: undefined, args: {} }))
    log.action(timeout({ result: { kind: 'info', text: 'Nothing to do' } }))
    log.action(timeout({ result: { kind: 'error', text: "You can't moderate this member." } }))
    log.action(timeout({ cancelled: true, result: undefined, args: { member: 'u:carol' } }))
    const got = (await all()).reverse()
    expect(got.map(e => e.outcome)).toEqual(['ok', 'info', 'error', 'cancelled'])
    expect(got.map(e => e.text)).toEqual([
      undefined,
      'Nothing to do',
      "You can't moderate this member.",
      undefined,
    ])
    expect(got[0].args).toBeUndefined()
    expect(got[3].args).toEqual([{ name: 'member', value: 'carol' }])
  })

  test('the detail is what the log keeps, and a name follows the text', async () => {
    const { log, all } = rig()
    log.action(timeout({ result: { kind: 'ok', text: 'Timed out', name: 'carol' } }))
    log.action(
      timeout({ result: { kind: 'ok', text: 'Done', name: 'x', detail: 'Timed out for 1 hour' } })
    )
    expect((await all()).map(e => e.text)).toEqual(['Timed out for 1 hour', 'Timed out carol'])
  })

  test('entries of one moment keep their order through ids', async () => {
    const { log, all } = rig()
    log.action(timeout())
    log.action(timeout())
    expect((await all()).map(e => e.id)).toEqual(['id2', 'id1'])
  })

  test('the default ids are 16 random bytes in base64url', async () => {
    const table = memoryRecords().open<LogEntry>('log')
    const log = recorder({ table, prefs: () => DEFAULT_PREFS })
    const a = log.action(timeout())
    const b = log.action(timeout())
    expect(/^[A-Za-z0-9_-]{22}$/.test(a ?? '')).toBe(true)
    expect(b).not.toBe(a)
    await log.flush()
    expect(await table.count()).toBe(2)
  })
})

describe('what is never stored', () => {
  test('an egg is not logged at all', async () => {
    const { log, all, timers } = rig()
    expect(log.action(timeout({ action: { id: 'fun.egg', title: 'Egg', egg: true } }))).toBeNull()
    expect(
      log.action(timeout({ action: { id: 'fun.egg', title: 'Egg', egg: true, secret: true } }))
    ).toBeNull()
    expect(timers.length).toBe(0)
    expect(await all()).toEqual([])
  })

  test('a secret action logs its title and outcome only', async () => {
    const { log, all } = rig()
    log.action(
      timeout({
        action: { id: 'core.phrase.show', title: 'Show backup phrase', secret: true, steps },
        result: { kind: 'ok', text: 'abandon ability able', detail: 'u:carol', undo: () => {} },
      })
    )
    expect(await all()).toEqual([
      {
        v: 1,
        id: 'id1',
        at: 1000 * DAY,
        actor,
        via: 'palette',
        action: 'core.phrase.show',
        title: 'Show backup phrase',
        outcome: 'ok',
      },
    ])
  })

  test('with logging off nothing is written', async () => {
    const { log, all, state, timers } = rig({ on: false })
    expect(log.action(timeout())).toBeNull()
    expect(log.api({ actor, method: 'GET', path: '/api/v1/me', status: 200 })).toBeNull()
    expect(log.notice({ actor, title: 'Reply', text: 'hi' })).toBeNull()
    expect(timers.length).toBe(0)
    state.prefs = { ...state.prefs, on: true }
    expect(log.action(timeout())).toBe('id1')
    expect((await all()).length).toBe(1)
  })

  test('a local reply that echoes a hidden argument is stored without it', async () => {
    const { log, all } = rig()
    log.action(timeout({ result: { kind: 'ok', text: 'Timed out carol for spamming links' } }))
    expect((await all())[0].text).toBe(`Timed out carol for ${HIDDEN}`)
  })

  test('an argument no step declares is hidden from the reply too', async () => {
    const { log, all } = rig()
    log.action(
      timeout({
        args: { member: 'u:carol', extra: 'hunter2-hunter' },
        result: { kind: 'ok', text: 'Got hunter2-hunter' },
      })
    )
    const [e] = await all()
    expect(e.text).toBe(`Got ${HIDDEN}`)
    expect(e.args).toEqual([{ name: 'member', value: 'carol' }])
  })

  test('server spans hide exactly the hidden arguments, whatever was done to the value', async () => {
    const { log, all } = rig()
    const command: LogStep[] = [
      { name: 'code', kind: 'text', log: 'keep' },
      { name: 'who', kind: 'user', label: 'bob' },
    ]
    const text = 'Linked @⁠X7Q-993 for bob. Done.'
    log.action({
      actor,
      via: 'server',
      action: {
        id: 'srv.alice@a.example.pixel.link',
        title: 'link',
        steps: command,
        serverCommand: true,
      },
      args: { code: '@X7Q-993-ALPHA', who: 'u:bob' },
      result: { kind: 'ok', text, onlyYou: true },
      spans: [
        { start: 7, end: 16, arg: 'args.code' },
        { start: 21, end: 24, arg: 'args.who' },
      ],
    })
    const [e] = await all()
    expect(text.slice(21, 24)).toBe('bob')
    expect(e.text).toBe(`Linked ${HIDDEN} for bob. Done.`)
    expect(e.args).toEqual([
      { name: 'code', value: HIDDEN },
      { name: 'who', value: 'bob' },
    ])
  })

  test('server spans mark the text, so a detail loses the exact values instead', async () => {
    const { log, all } = rig()
    const command: LogStep[] = [{ name: 'code', kind: 'text' }]
    const run = (result: ActionRun['result']): ActionRun => ({
      actor,
      via: 'server',
      action: { id: 'srv.a.pixel.link', title: 'link', steps: command, serverCommand: true },
      args: { code: 'X7Q-993' },
      result,
      spans: [{ start: 7, end: 14, arg: 'args.code' }],
    })
    log.action(
      run({ kind: 'ok', text: 'Linked X7Q-993 now', detail: 'Your code X7Q-993 is linked' })
    )
    log.action(run({ kind: 'ok', text: 'Linked X7Q-993 now', name: 'bob' }))
    expect((await all()).map(e => e.text)).toEqual([
      `Linked ${HIDDEN} now bob`,
      `Your code ${HIDDEN} is linked`,
    ])
  })

  test('a span for an argument the client does not know is hidden', async () => {
    const { log, all } = rig()
    log.action(
      timeout({
        result: { kind: 'ok', text: 'Saved abc' },
        spans: [{ start: 6, end: 9, arg: 'args.mystery' }],
      })
    )
    expect((await all())[0].text).toBe(`Saved ${HIDDEN}`)
  })

  test('every string is scrubbed at write', async () => {
    const { log, all } = rig()
    log.action(
      timeout({
        action: {
          id: 'core.webhook.test',
          title: 'Test https://a.example/api/v1/webhooks/3/tok',
          steps: [{ name: 'note', kind: 'text', log: 'keep' }],
        },
        args: { note: 'Bearer abc123' },
        target: { kind: 'channel', label: 'https://u:p@a.example/x' },
        result: { kind: 'ok', text: 'Sent to /hook?token=abc' },
      })
    )
    const [e] = await all()
    expect(e.title).toBe(`Test https://a.example/api/v1/webhooks/3/${HIDDEN}`)
    expect(e.args).toEqual([{ name: 'note', value: `Bearer ${HIDDEN}` }])
    expect(e.target?.label).toBe(`https://${HIDDEN}@a.example/x`)
    expect(e.text).toBe(`Sent to /hook?token=${HIDDEN}`)
  })
})

describe('API console requests', () => {
  test('method, path, query keys without values, status and time', async () => {
    const { log, all } = rig()
    log.api({
      actor,
      method: 'get',
      path: '/api/v1/servers/pixel/messages?limit=50&before=991&token=abc#frag',
      status: 200,
      ms: 12,
    })
    log.api({ actor, method: 'DELETE', path: '/api/v1/webhooks/3/tok-secret', status: 404 })
    log.api({ actor, method: 'POST', path: '/api/v1/x?', status: 0 })
    const got = (await all()).reverse()
    expect(got[0]).toEqual({
      v: 1,
      id: 'id1',
      at: 1000 * DAY,
      actor,
      via: 'api',
      action: 'api',
      title: 'GET /api/v1/servers/pixel/messages?limit&before&token',
      outcome: 'ok',
      text: '200',
      ms: 12,
    })
    expect(got[1].title).toBe(`DELETE /api/v1/webhooks/3/${HIDDEN}`)
    expect([got[1].outcome, got[1].text]).toEqual(['error', '404'])
    expect([got[2].title, got[2].outcome, got[2].text]).toEqual(['POST /api/v1/x', 'error', '0'])
  })

  test('a query value never gets in, even without a key', async () => {
    const { log, all } = rig()
    log.api({ actor, method: 'GET', path: '/x?hunter2&a=b=c&=v', status: 200 })
    expect((await all())[0].title).toBe('GET /x?a')
  })
})

describe('notices', () => {
  test('a notice is an info entry, with every marked span hidden', async () => {
    const { log, all } = rig()
    log.notice({
      actor: { account: 'alice@a.example', identity: 'p1' },
      title: 'Reply from Pixel Club',
      text: 'Thanks sent to bob with code 1234',
      spans: [{ start: 29, end: 33, arg: 'args.code' }],
      target: { kind: 'channel', label: 'general', ref: { server: 'pixel', channel: 4 } },
    })
    expect(await all()).toEqual([
      {
        v: 1,
        id: 'id1',
        at: 1000 * DAY,
        actor: { account: 'alice@a.example', identity: 'p1' },
        via: 'notice',
        action: 'notice',
        title: 'Reply from Pixel Club',
        target: { kind: 'channel', label: 'general', ref: { server: 'pixel', channel: 4 } },
        outcome: 'info',
        text: `Thanks sent to bob with code ${HIDDEN}`,
      },
    ])
  })
})

describe('undo', () => {
  test('a result with an undo is marked, and the mark follows what happens to it', async () => {
    const { log, all } = rig()
    const a = log.action(timeout({ result: { kind: 'ok', text: 'Done', undo: async () => {} } }))
    const b = log.action(timeout({ result: { kind: 'ok', text: 'Done', undo: async () => {} } }))
    const c = log.action(timeout())
    log.undo(a ?? '', 'used')
    expect((await all()).map(e => e.undo)).toEqual([undefined, 'available', 'used'])
    log.undo(b ?? '', 'expired')
    log.undo(c ?? '', 'used')
    log.undo('nope', 'used')
    expect((await all()).map(e => e.undo)).toEqual([undefined, 'expired', 'used'])
    log.undo(a ?? '', 'expired')
    expect((await all()).map(e => e.undo)).toEqual([undefined, 'expired', 'used'])
  })

  test('an entry deleted from the log is not brought back by its undo', async () => {
    const { log, all, table } = rig()
    const a = log.action(timeout({ result: { kind: 'ok', text: 'Done', undo: async () => {} } }))
    await log.flush()
    await table.delete([a ?? ''])
    log.forget([a ?? ''])
    log.undo(a ?? '', 'used')
    expect(await all()).toEqual([])
  })
})

describe('writes', () => {
  test('are batched: one write per 250 ms, however many entries', async () => {
    const puts: number[] = []
    const inner = memoryRecords().open<LogEntry>('log')
    const table: RecordTable<LogEntry> = {
      ...inner,
      put: async records => {
        puts.push(records.length)
        await inner.put(records)
      },
    }
    const { log, timers } = rig({}, table)
    expect(WRITE_MS).toBe(250)
    for (let i = 0; i < 7; i += 1) log.action(timeout())
    expect(timers.map(t => t.ms)).toEqual([250])
    expect(puts).toEqual([])
    timers[0].run()
    await log.flush()
    expect(puts).toEqual([7])
    log.action(timeout())
    expect(timers.length).toBe(2)
    timers[1].run()
    await log.flush()
    expect(puts).toEqual([7, 1])
    await log.flush()
    expect(puts).toEqual([7, 1])
  })

  test('a failed write never throws into the command, and the next write lands', async () => {
    const inner = memoryRecords().open<LogEntry>('log')
    let fail = true
    const table: RecordTable<LogEntry> = {
      ...inner,
      put: async records => {
        if (fail) throw new Error('QuotaExceededError')
        await inner.put(records)
      },
      prune: async () => {
        throw new Error('nope')
      },
    }
    const { log } = rig({}, table)
    log.action(timeout())
    await log.flush()
    fail = false
    log.action(timeout())
    await log.flush()
    await log.start()
    expect(await inner.count()).toBe(1)
  })

  test('pruning at start and every 50 writes', async () => {
    const inner = memoryRecords().open<LogEntry>('log')
    const prunes: { olderThan?: number; keep?: number }[] = []
    const table: RecordTable<LogEntry> = {
      ...inner,
      prune: async opts => {
        prunes.push(opts)
        return inner.prune(opts)
      },
    }
    const { log, state } = rig({ days: 7, max: 100 }, table)
    await inner.put([
      {
        v: 1,
        id: 'old',
        at: 992 * DAY,
        actor,
        via: 'key',
        action: 'core.x',
        title: 'Old',
        outcome: 'ok',
      },
    ])
    await log.start()
    expect(prunes).toEqual([{ olderThan: 993 * DAY, keep: 100 }])
    expect(await inner.count()).toBe(0)
    for (let i = 0; i < 49; i += 1) {
      state.now += 1
      log.action(timeout())
    }
    await log.flush()
    expect(prunes.length).toBe(1)
    log.action(timeout())
    await log.flush()
    expect(prunes.length).toBe(2)
    for (let i = 0; i < 120; i += 1) {
      state.now += 1
      log.action(timeout())
    }
    await log.flush()
    expect(prunes.length).toBe(3)
    expect(await inner.count()).toBe(100)
    for (let i = 0; i < 30; i += 1) log.action(timeout())
    await log.flush()
    expect(prunes.length).toBe(4)
  })
})
