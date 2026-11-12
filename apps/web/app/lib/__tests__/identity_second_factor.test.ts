import { describe, expect, test } from 'bun:test'
import {
  START,
  heading,
  links,
  lockedLine,
  next,
  rememberLine,
  requestBody,
  switchMode,
  wrongCodeLine,
  type Step,
} from '../identity/second_factor'

const factor = (methods: string[], pending = 'rcs_1') => ({ pending, methods, expires_at: 900 })
const asked = {
  error: 'Enter the code from your authenticator app',
  reason: { kind: 'invalid' as const, field: 'code' },
  second_factor: factor(['totp', 'recovery_code', 'phrase']),
}
const codeStep = next(START, 401, asked) as Extract<Step, { step: 'code' }>

describe('the answers of the sign-in form', () => {
  test('a session ends the flow', () => {
    expect(next(START, 200, { error: '' })).toEqual({ step: 'done' })
  })
  test('a wrong password stays on the password step with one line for every cause', () => {
    expect(next(START, 401, { error: 'Invalid credentials' })).toEqual({
      step: 'password',
      error: "That username and password don't match.",
    })
    expect(next(START, 401, { error: 'Wrong username or backup phrase' })).toEqual({
      step: 'password',
      error: 'Wrong username or backup phrase',
    })
    expect(
      next(START, 429, {
        error: 'Wait 3 seconds between attempts',
        reason: { kind: 'rate', retry_after: 3 },
      })
    ).toEqual({ step: 'password', error: 'Wait 3 seconds between attempts' })
  })
  test('a right password on an account with codes opens the code step, without an error', () => {
    expect(codeStep).toEqual({
      step: 'code',
      pending: 'rcs_1',
      methods: ['totp', 'recovery_code', 'phrase'],
      mode: 'totp',
      expiresAt: 900,
      error: null,
      locked: null,
    })
    expect(heading('totp')).toBe('Enter the code from your authenticator app')
    expect(heading('recovery_code')).toBe('Enter a recovery code')
    expect(heading('phrase')).toBe('Use your backup phrase')
  })
  test('a wrong code at the form replaces the pending handle and says so', () => {
    const wrong = next(codeStep, 401, {
      error: 'Wrong code',
      reason: { kind: 'invalid', field: 'code' },
      second_factor: factor(['totp', 'recovery_code'], 'rcs_2'),
    })
    expect(wrong).toMatchObject({
      step: 'code',
      pending: 'rcs_2',
      mode: 'totp',
      error: "That code didn't work.",
    })
  })
})

describe('the answers of the code step', () => {
  test('a wrong code counts down the tries', () => {
    const wrong = next(codeStep, 401, {
      error: 'Wrong code',
      reason: { kind: 'invalid', field: 'code' },
      tries_left: 4,
    })
    expect(wrong).toEqual({ ...codeStep, error: "That code didn't work. 4 tries left." })
    expect(wrongCodeLine(1)).toBe("That code didn't work. 1 try left.")
    expect(wrongCodeLine(undefined)).toBe("That code didn't work.")
    expect(wrongCodeLine(0)).toBe("That code didn't work.")
  })
  test('a just-used code and a second proof of the same kind keep the step', () => {
    const used = next(codeStep, 401, {
      error: 'That code was just used. Wait for the next one.',
      reason: { kind: 'invalid', field: 'code' },
      tries_left: 5,
    })
    expect(used).toEqual({ ...codeStep, error: 'That code was just used. Wait for the next one.' })
    const same = next(codeStep, 400, {
      error: 'Use your authenticator app or your password with this',
      reason: { kind: 'invalid', field: 'code' },
    })
    expect(same).toEqual({
      ...codeStep,
      error: 'Use your authenticator app or your password with this.',
    })
    const junk = next(codeStep, 400, {
      error: 'That is not a code',
      reason: { kind: 'invalid', field: 'code' },
    })
    expect(junk).toEqual({ ...codeStep, error: 'That is not a code.' })
  })
  test('an expired step goes back to the password', () => {
    expect(
      next(codeStep, 400, {
        error: 'Sign-in expired. Try again',
        reason: { kind: 'invalid', field: 'pending' },
      })
    ).toEqual({ step: 'password', error: 'That took too long. Sign in again.' })
  })
  test('a lock replaces the field with a notice and leaves the phrase', () => {
    const locked = next(codeStep, 423, {
      error: 'Too many wrong codes. Try again later',
      reason: { kind: 'rate', control: 'second_factor', retry_after: 42 * 60 },
      second_factor: factor(['phrase'], 'rcs_3'),
    })
    expect(locked).toEqual({
      step: 'code',
      pending: 'rcs_3',
      methods: ['phrase'],
      mode: 'phrase',
      expiresAt: 900,
      error: null,
      locked: 'Too many wrong codes. Try again in 42 minutes, or use your backup phrase.',
    })
    const noPhrase = next(codeStep, 423, {
      error: 'Too many wrong codes. Try again later',
      reason: { kind: 'rate', control: 'second_factor', retry_after: 3600 },
      second_factor: factor([], 'rcs_4'),
    })
    expect(noPhrase).toMatchObject({
      mode: null,
      locked: 'Too many wrong codes. Try again in 60 minutes.',
    })
    const atStep = next(codeStep, 423, {
      error: 'Too many wrong codes. Try again later',
      reason: { kind: 'rate', control: 'second_factor', retry_after: 30 },
    })
    expect(atStep).toMatchObject({
      pending: 'rcs_1',
      mode: 'phrase',
      locked: 'Too many wrong codes. Try again in a minute, or use your backup phrase.',
    })
    expect(lockedLine(3 * 3600, false)).toBe('Too many wrong codes. Try again in 3 hours.')
    expect(lockedLine(undefined, true)).toBe(
      'Too many wrong codes. Try again later, or use your backup phrase.'
    )
  })
  test('a missing key is never shown as a wrong code', () => {
    const missing = next(codeStep, 503, {
      error: 'This site is missing a key in ACCOUNT_SECRETS_KEY. Ask the site admin.',
      reason: { kind: 'unavailable', control: 'ACCOUNT_SECRETS_KEY' },
    })
    expect(missing).toEqual({
      ...codeStep,
      error: 'This site is missing a key. Ask the site admin.',
    })
  })
  test('a method this client does not know is never offered', () => {
    const odd = next(START, 401, { ...asked, second_factor: factor(['passkey', 'recovery_code']) })
    expect(odd).toMatchObject({ methods: ['recovery_code'], mode: 'recovery_code' })
  })
})

describe('the other ways in', () => {
  test('links follow the methods the answer listed', () => {
    expect(links(codeStep)).toEqual([
      { mode: 'recovery_code', label: 'Use a recovery code' },
      { mode: 'phrase', label: 'Use your backup phrase instead' },
    ])
    const recovery = switchMode(codeStep, 'recovery_code')
    expect(recovery).toMatchObject({ mode: 'recovery_code', error: null })
    expect(links(recovery)).toEqual([
      { mode: 'totp', label: 'Use your authenticator app' },
      { mode: 'phrase', label: 'Use your backup phrase instead' },
    ])
    expect(switchMode(codeStep, 'passkey' as never)).toEqual(codeStep)
    expect(switchMode(START, 'phrase')).toEqual(START)
    expect(links(START)).toEqual([])
    const noPhrase = next(START, 401, {
      ...asked,
      second_factor: factor(['totp', 'recovery_code']),
    })
    expect(links(noPhrase)).toEqual([{ mode: 'recovery_code', label: 'Use a recovery code' }])
  })
  test('remembering a device is offered only while the site allows it', () => {
    expect(rememberLine(30)).toBe('Remember this device for 30 days')
    expect(rememberLine(1)).toBe('Remember this device for 1 day')
    expect(rememberLine(0)).toBeNull()
  })
})

describe('what the step sends', () => {
  test('exactly one proof, cleaned; nothing for input that is not a code', () => {
    expect(
      requestBody(codeStep, 'alice', ' 123 456 ', { remember: true, label: 'Firefox on Linux' })
    ).toEqual({
      username: 'alice',
      pending: 'rcs_1',
      code: '123456',
      remember: true,
      label: 'Firefox on Linux',
    })
    expect(requestBody(codeStep, 'alice', '12345', {})).toBeNull()
    const recovery = switchMode(codeStep, 'recovery_code')
    expect(requestBody(recovery, 'alice', 'ABCDE fghjk', {})).toEqual({
      username: 'alice',
      pending: 'rcs_1',
      recovery_code: 'abcdefghjk',
    })
    expect(requestBody(recovery, 'alice', '123456', {})).toBeNull()
    expect(requestBody(switchMode(codeStep, 'phrase'), 'alice', 'x', {})).toBeNull()
    expect(requestBody(START, 'alice', '123456', {})).toBeNull()
  })
})
