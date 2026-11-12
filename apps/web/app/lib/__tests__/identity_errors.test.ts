import { describe, expect, test } from 'bun:test'
import { PROTOCOL, REFUSALS, SIGN_IN, protocolLine, refusalLine, show } from '../identity/errors'

describe('sign-in refusals', () => {
  test('every body is plain ASCII; only the uniform credential refusals have no reason', () => {
    for (const [k, { body }] of Object.entries(SIGN_IN)) {
      expect(/^[\x20-\x7e]+$/.test(body.error)).toBe(true)
      expect(body.reason === undefined).toBe(k === 'wrong_password' || k === 'wrong_phrase')
    }
    for (const p of Object.values(PROTOCOL)) expect(/^[\x20-\x7e]+$/.test(p.text)).toBe(true)
  })
  test('a wrong password names no field and no reason', () => {
    expect(SIGN_IN.wrong_password.body).toEqual({ error: 'Invalid credentials' })
    expect(show(SIGN_IN.wrong_password.body)).toEqual({ at: 'form', text: 'Invalid credentials' })
  })
  test('steps and fields', () => {
    expect(show(SIGN_IN.code_needed.body)).toEqual({ at: 'step', step: 'second_factor' })
    expect(show(SIGN_IN.wrong_code.body)).toEqual({
      at: 'field',
      field: 'code',
      text: 'Wrong code',
    })
    expect(show(SIGN_IN.codes_locked.body)).toEqual({
      at: 'notice',
      text: 'Too many wrong codes. Try again later',
      retryIn: 3600,
    })
    expect(
      show({
        error: 'Finish setting up your account first',
        reason: { kind: 'off_account' },
        setup: ['totp'],
      })
    ).toEqual({ at: 'step', step: 'setup' })
    expect(
      show({
        error: 'Applications are turned off on this site',
        reason: { kind: 'off_site', control: 'oauth_provider' },
      })
    ).toEqual({
      at: 'off',
      control: 'oauth_provider',
      text: 'Applications are turned off on this site',
    })
    expect(show({ error: 'Not found' })).toEqual({ at: 'form', text: 'Not found' })
    expect(
      show({
        error: 'Your moderator tools here are off until you set up two-factor',
        reason: { kind: 'off_server', control: 'mod_totp' },
      })
    ).toMatchObject({ at: 'off', control: 'mod_totp' })
    expect(show(SIGN_IN.just_used.body)).toEqual({
      at: 'field',
      field: 'code',
      text: 'That code was just used. Wait for the next one.',
    })
  })
  test('every kind has a place on the screen', () => {
    expect(show({ error: 'Bad', reason: { kind: 'invalid' } })).toEqual({ at: 'form', text: 'Bad' })
    expect(show({ error: 'Slow', reason: { kind: 'rate', retry_after: 3 } })).toEqual({
      at: 'notice',
      text: 'Slow',
      retryIn: 3,
    })
    expect(show({ error: 'Full', reason: { kind: 'capacity' } })).toEqual({
      at: 'notice',
      text: 'Full',
      retryIn: undefined,
    })
    expect(show({ error: 'Down', reason: { kind: 'unavailable' } }).at).toBe('notice')
    expect(show({ error: 'Taken', reason: { kind: 'conflict' } })).toEqual({
      at: 'form',
      text: 'Taken',
    })
    expect(show({ error: 'Most', reason: { kind: 'limit', value: 10 } }).at).toBe('form')
    expect(show({ error: 'Off', reason: { kind: 'off_account' } })).toEqual({
      at: 'off',
      control: '',
      text: 'Off',
    })
    expect(show({ error: 'Ended', reason: { kind: 'sign_in' } })).toEqual({ at: 'signed_out' })
  })
})

describe('protocol errors on our own pages', () => {
  test('every standard code has a line and a kind', () => {
    for (const code of [
      'invalid_request',
      'invalid_client',
      'invalid_grant',
      'unauthorized_client',
      'unsupported_grant_type',
      'unsupported_response_type',
      'invalid_scope',
      'access_denied',
      'temporarily_unavailable',
      'server_error',
      'slow_down',
      'authorization_pending',
      'expired_token',
      'invalid_token',
      'insufficient_scope',
      'login_required',
      'consent_required',
      'account_selection_required',
      'interaction_required',
      'request_not_supported',
    ])
      expect(PROTOCOL[code].text.length).toBeGreaterThan(10)
    expect(Object.keys(PROTOCOL)).toHaveLength(20)
    expect(protocolLine('invalid_grant')).toEqual({
      text: 'That sign-in ended. Start again from the application.',
      kind: 'sign_in',
    })
    expect(protocolLine('made_up')).toEqual(PROTOCOL.invalid_request)
    expect(protocolLine('constructor')).toEqual(PROTOCOL.invalid_request)
  })
})

describe('what the person sees for each refusal', () => {
  const line = (kind: string, control?: string, value?: number) =>
    refusalLine({ error: 'x', reason: { kind: kind as never, control, value } })
  test('site, account, server and limit refusals say which it is and what to do', () => {
    expect(line('off_account', 'protection_totp')).toBe('Two-factor is required here.')
    expect(line('off_server', 'mod_totp')).toBe(
      'Your moderator tools here are off until you set up two-factor.'
    )
    expect(line('off_server', 'role.requires_totp')).toBe(line('off_server', 'mod_totp'))
    expect(line('off_site', 'two_factor')).toBe('Authenticator codes are turned off on this site.')
    expect(line('off_site', 'application_registration')).toBe(
      'Registering applications is off here.'
    )
    expect(line('off_account', 'application_registration')).toBe(
      "Your account can't register applications here."
    )
    expect(line('limit', 'APPLICATIONS_PER_ACCOUNT', 10)).toBe(
      'You own 10 applications, the most here. Delete one to make another.'
    )
    expect(line('off_site', 'oauth_provider')).toBe(
      'Sign-in for other services is turned off on this site.'
    )
    expect(line('off_site', 'application_admin_scope')).toBe(
      "This site doesn't let applications use administration."
    )
    expect(line('off_site', 'application_encrypted_access')).toBe(
      "This site doesn't let applications read encrypted chats."
    )
    expect(line('conflict', 'proxy_hosts')).toBe('Another application uses this host.')
    expect(line('conflict', 'application_seat')).toBe('You already vote as an owner.')
    expect(line('unavailable', 'ACCOUNT_SECRETS_KEY')).toBe(
      'This site is missing a key. Ask the site admin.'
    )
    expect(line('limit', 'E2EE_DEVICES_PER_ACCOUNT', 20)).toBe(
      'You have 20 of 20 encryption devices. Remove one first.'
    )
  })
  test('a field decides between two refusals of one kind', () => {
    const field = (name: string) =>
      refusalLine({ error: 'x', reason: { kind: 'invalid', field: name } })
    expect(field('hosts')).toBe("This host isn't in FORWARD_AUTH_HOSTS.")
    expect(field('accounts')).toBe('No account with that name.')
  })
  test("an unknown refusal shows the server's own text", () => {
    expect(
      refusalLine({
        error: 'Names are 2 to 32 characters',
        reason: { kind: 'invalid', field: 'name' },
      })
    ).toBe('Names are 2 to 32 characters')
    expect(refusalLine({ error: 'Not found' })).toBe('Not found')
    expect(line('off_site', 'constructor')).toBe('x')
  })
  test('no line uses an em dash or names the software', () => {
    const lines = [
      ...Object.values(REFUSALS).map(make => make(7)),
      ...Object.values(PROTOCOL).map(p => p.text),
      ...Object.values(SIGN_IN).map(s => s.body.error),
    ]
    expect(lines.length).toBeGreaterThan(40)
    for (const text of lines) {
      expect(/\u2014|\u2013|RChat/.test(text)).toBe(false)
      expect(/^[\x20-\x7e]+$/.test(text)).toBe(true)
    }
  })
})
