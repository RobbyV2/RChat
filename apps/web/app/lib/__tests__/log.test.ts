import { afterEach, describe, expect, test } from 'bun:test'
import { cause, label, LogField, logError, logWarn } from '../log'
import { Secret } from '../secret'

const real = { error: console.error, warn: console.warn }
afterEach(() => {
  console.error = real.error
  console.warn = real.warn
})

const capture = () => {
  const lines: { level: string; args: unknown[] }[] = []
  console.error = (...args: unknown[]) => void lines.push({ level: 'error', args })
  console.warn = (...args: unknown[]) => void lines.push({ level: 'warn', args })
  return lines
}

describe('log fields', () => {
  test('a label keeps identifier characters and a bounded length', () => {
    expect(label('server.rename').shown).toBe('server.rename')
    expect(label('Ann Lee <ann@example.com>').shown).toBe('Ann_Lee__ann_example.com_')
    expect(String(label('x'.repeat(200)).shown).length).toBe(64)
    expect(label({ name: 'Ann' }).shown).toBe('object')
  })

  test('an error keeps its stack', () => {
    const e = new Error('boom')
    expect(cause(e).shown).toBe(e)
  })

  test('a thrown object is named by its type, never printed', () => {
    expect(cause({ username: 'ann', token: 'tok' }).shown).toBe('[object Object]')
    expect(cause(['ann']).shown).toBe('[object Array]')
    expect(cause(undefined).shown).toBeUndefined()
    expect(cause(404).shown).toBe(404)
  })

  test('a thrown text is cut short', () => {
    expect(String(cause('y'.repeat(999)).shown).length).toBe(200)
  })

  test('a secret is never shown', () => {
    expect(cause(Secret.of('tok-1')).shown).toBe('[secret]')
  })

  test('a field cannot be built outside label and cause', () => {
    const Raw = LogField as unknown as new (key: symbol, shown: unknown) => LogField
    expect(() => new Raw(Symbol('log field'), 'ann')).toThrow()
  })
})

describe('log lines', () => {
  test('an error line carries its text and the shown fields', () => {
    const lines = capture()
    const e = new Error('boom')
    logError('action', label('server.rename'), cause(e), 3, true)
    expect(lines).toEqual([{ level: 'error', args: ['action', 'server.rename', e, 3, true] }])
  })

  test('a warning goes to the warning level', () => {
    const lines = capture()
    logWarn('localStorage write failed', cause('full'))
    expect(lines).toEqual([{ level: 'warn', args: ['localStorage write failed', 'full'] }])
  })
})

// Type checks only: a line's text is written in the code, and a field is never free text.
export const refusedByTypes = (dynamic: string) => {
  // @ts-expect-error a text built at run time is not a log line
  logError(dynamic)
  // @ts-expect-error a plain string is not a field
  logError('action', dynamic)
  // @ts-expect-error an object is not a field
  logWarn('action', { name: dynamic })
}
