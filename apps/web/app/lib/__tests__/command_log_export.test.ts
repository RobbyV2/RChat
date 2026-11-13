import { describe, expect, test } from 'bun:test'
import { exportCsv, exportJson } from '../command_log/export'
import { HIDDEN } from '../command_log/redact'
import type { LogEntry } from '../command_log/types'

const AT = Date.UTC(2026, 10, 12, 14, 2, 11)

const entries: LogEntry[] = [
  {
    v: 1,
    id: 'e2',
    at: AT,
    actor: { account: 'alice@a.example' },
    via: 'palette',
    action: 'core.timeout',
    title: 'Time out',
    target: { kind: 'member', label: 'carol', ref: { server: 'pixel' } },
    args: [
      { name: 'member', value: 'carol' },
      { name: 'duration', value: '1 hour' },
    ],
    outcome: 'ok',
    text: 'Timed out, "for now"',
    ms: 40,
  },
  {
    v: 1,
    id: 'e1',
    at: AT - 1000,
    actor: { account: 'alice@a.example', identity: 'p1' },
    via: 'api',
    action: 'api',
    title: 'GET /api/v1/webhooks/3/tok-secret',
    outcome: 'error',
    text: 'line one\nline two',
  },
]

describe('JSON', () => {
  test('the envelope, with every entry scrubbed again', () => {
    const out = JSON.parse(exportJson('alice@a.example', entries, AT + 5)) as unknown
    expect(out).toEqual({
      format: 'rchat-command-log',
      v: 1,
      account: 'alice@a.example',
      exported_at: AT + 5,
      entries: [entries[0], { ...entries[1], title: `GET /api/v1/webhooks/3/${HIDDEN}` }],
    })
  })

  test('an empty log exports', () => {
    expect(JSON.parse(exportJson('a', [], 1)) as unknown).toEqual({
      format: 'rchat-command-log',
      v: 1,
      account: 'a',
      exported_at: 1,
      entries: [],
    })
  })
})

describe('CSV', () => {
  test('the columns, quoted where needed, scrubbed again', () => {
    expect(exportCsv(entries)).toBe(
      [
        'at,via,action,title,target,args,outcome,text',
        '2026-11-12T14:02:11.000Z,palette,core.timeout,Time out,carol,member=carol; duration=1 hour,ok,"Timed out, ""for now"""',
        `2026-11-12T14:02:10.000Z,api,api,GET /api/v1/webhooks/3/${HIDDEN},,,error,"line one\nline two"`,
        '',
      ].join('\r\n')
    )
  })

  test('an empty log is the header alone', () => {
    expect(exportCsv([])).toBe('at,via,action,title,target,args,outcome,text\r\n')
  })

  test('a cell a spreadsheet would run as a formula is made text', () => {
    const risky = (title: string): LogEntry => ({ ...entries[1], title, text: undefined })
    const cell = (title: string) =>
      exportCsv([risky(title)])
        .split('\r\n')[1]
        .split(',')[3]
    expect(cell('=1+1')).toBe("'=1+1")
    expect(cell('+1')).toBe("'+1")
    expect(cell('-1')).toBe("'-1")
    expect(cell('@sum')).toBe("'@sum")
    expect(cell('\t=1')).toBe("'\t=1")
    expect(cell('a=1')).toBe('a=1')
  })

  test('a time that is not one leaves the cell empty', () => {
    const odd = { ...entries[0], at: Number.NaN }
    expect(exportCsv([odd]).split('\r\n')[1].startsWith(',palette,')).toBe(true)
  })
})
