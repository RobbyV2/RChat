import { describe, expect, test } from 'bun:test'
import {
  hiddenNames,
  hiddenValues,
  loggedArgs,
  type LogStep,
  stepPolicy,
} from '../command_log/policy'
import { HIDDEN } from '../command_log/redact'

const steps: LogStep[] = [
  { name: 'member', kind: 'choice', label: 'carol' },
  { name: 'reason', kind: 'text' },
  { name: 'ok', kind: 'confirm' },
  { name: 'note', kind: 'text', log: 'keep' },
]
const args = { member: 'u:carol', reason: 'spam', ok: '1', note: 'first warning' }

describe('policies', () => {
  test('text fails safe, choices keep their label, confirms are omitted', () => {
    expect(stepPolicy('text')).toBe('hide')
    expect(stepPolicy('text', 'keep')).toBe('keep')
    expect(stepPolicy('choice')).toBe('keep')
    expect(stepPolicy('confirm')).toBe('omit')
    expect(stepPolicy('choice', 'hide')).toBe('hide')
    expect(stepPolicy('confirm', 'keep')).toBe('keep')
  })

  test('user, duration and date steps keep', () => {
    expect(stepPolicy('user')).toBe('keep')
    expect(stepPolicy('duration')).toBe('keep')
    expect(stepPolicy('date')).toBe('keep')
  })

  test('logged args follow the policies; a secret action keeps none', () => {
    expect(loggedArgs(steps, args, false)).toEqual([
      { name: 'member', value: 'carol' },
      { name: 'reason', value: HIDDEN },
      { name: 'note', value: 'first warning' },
    ])
    expect(loggedArgs(steps, args, true)).toEqual([])
  })

  test('a step that was never answered is not logged', () => {
    expect(loggedArgs(steps, { member: 'u:carol' }, false)).toEqual([
      { name: 'member', value: 'carol' },
    ])
    expect(loggedArgs([{ name: 'toString', kind: 'text', log: 'keep' }], {}, false)).toEqual([])
  })

  test('a kept choice without a label keeps its value', () => {
    expect(loggedArgs([{ name: 'for', kind: 'duration' }], { for: '1h' }, false)).toEqual([
      { name: 'for', value: '1h' },
    ])
  })

  test('server-command text is always hidden, whatever the server declares', () => {
    const command: LogStep[] = [
      { name: 'code', kind: 'text', log: 'keep' },
      { name: 'who', kind: 'user', label: 'bob' },
    ]
    expect(loggedArgs(command, { code: 'sk-123456', who: 'u:bob' }, false, true)).toEqual([
      { name: 'code', value: HIDDEN },
      { name: 'who', value: 'bob' },
    ])
    expect(hiddenNames(command, { code: 'sk-123456', who: 'u:bob' }, false, true)).toEqual(['code'])
    expect(hiddenNames(command, { code: 'sk-123456', who: 'u:bob' }, false)).toEqual([])
  })

  test('the values a reply must not echo: hidden and omitted ones of 4 or more characters', () => {
    expect(hiddenNames(steps, args, false)).toEqual(['reason', 'ok'])
    expect(hiddenValues(steps, args, false)).toEqual(['spam'])
    expect(hiddenValues(steps, { ...args, reason: 'no' }, false)).toEqual([])
    expect(hiddenValues(steps, { reason: '😀😀😀' }, false)).toEqual([])
    expect(hiddenValues(steps, { reason: '😀😀😀😀' }, false)).toEqual(['😀😀😀😀'])
  })

  test('a secret action hides every argument', () => {
    expect(hiddenNames(steps, args, true)).toEqual(['member', 'reason', 'ok', 'note'])
    expect(hiddenValues(steps, args, true)).toEqual(['u:carol', 'spam', 'first warning'])
  })
})
