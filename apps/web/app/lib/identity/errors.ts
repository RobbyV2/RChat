export type Kind =
  | 'invalid'
  | 'rate'
  | 'conflict'
  | 'sign_in'
  | 'unavailable'
  | 'off_site'
  | 'off_account'
  | 'off_server'
  | 'limit'
  | 'capacity'

export type Reason = {
  kind: Kind
  control?: string
  value?: number
  retry_after?: number
  field?: string
}

export type Body = {
  error: string
  reason?: Reason
  second_factor?: { pending: string; methods: string[]; expires_at: number }
  setup?: string[]
}

export const SIGN_IN: Record<string, { status: number; body: Body }> = {
  wrong_password: { status: 401, body: { error: 'Invalid credentials' } },
  code_needed: {
    status: 401,
    body: {
      error: 'Enter the code from your authenticator app',
      reason: { kind: 'invalid', field: 'code' },
      second_factor: { pending: '<handle>', methods: ['totp', 'recovery_code'], expires_at: 0 },
    },
  },
  wrong_code: {
    status: 401,
    body: { error: 'Wrong code', reason: { kind: 'invalid', field: 'code' } },
  },
  just_used: {
    status: 401,
    body: {
      error: 'That code was just used. Wait for the next one.',
      reason: { kind: 'invalid', field: 'code' },
    },
  },
  same_kind: {
    status: 400,
    body: {
      error: 'Use your authenticator app or your password with this',
      reason: { kind: 'invalid', field: 'code' },
    },
  },
  codes_locked: {
    status: 423,
    body: {
      error: 'Too many wrong codes. Try again later',
      reason: { kind: 'rate', retry_after: 3600 },
    },
  },
  pending_gone: {
    status: 400,
    body: { error: 'Sign-in expired. Try again', reason: { kind: 'invalid', field: 'pending' } },
  },
  wrong_phrase: { status: 401, body: { error: 'Wrong username or backup phrase' } },
  password_paced: {
    status: 429,
    body: { error: 'Wait 3 seconds between attempts', reason: { kind: 'rate', retry_after: 3 } },
  },
}

export type Show =
  | { at: 'field'; field: string; text: string }
  | { at: 'form'; text: string }
  | { at: 'notice'; text: string; retryIn?: number }
  | { at: 'off'; control: string; text: string }
  | { at: 'signed_out' }
  | { at: 'step'; step: 'second_factor' | 'setup' }

export const show = (b: Body): Show => {
  if (b.second_factor) return { at: 'step', step: 'second_factor' }
  if (b.setup) return { at: 'step', step: 'setup' }
  const r = b.reason
  if (!r) return { at: 'form', text: b.error }
  switch (r.kind) {
    case 'invalid':
      return r.field
        ? { at: 'field', field: r.field, text: b.error }
        : { at: 'form', text: b.error }
    case 'rate':
    case 'capacity':
    case 'unavailable':
      return { at: 'notice', text: b.error, retryIn: r.retry_after }
    case 'conflict':
    case 'limit':
      return { at: 'form', text: b.error }
    case 'off_site':
    case 'off_account':
    case 'off_server':
      return { at: 'off', control: r.control ?? '', text: b.error }
    case 'sign_in':
      return { at: 'signed_out' }
  }
}

export const PROTOCOL: Record<string, { text: string; kind: Kind }> = {
  invalid_request: {
    text: 'This application sent a request this site can not use.',
    kind: 'invalid',
  },
  invalid_client: { text: 'This application is not known here.', kind: 'invalid' },
  invalid_grant: { text: 'That sign-in ended. Start again from the application.', kind: 'sign_in' },
  unauthorized_client: { text: 'This application can not sign in that way.', kind: 'invalid' },
  unsupported_grant_type: { text: 'This application can not sign in that way.', kind: 'invalid' },
  unsupported_response_type: {
    text: 'This application can not sign in that way.',
    kind: 'invalid',
  },
  invalid_scope: {
    text: 'This application asked for something it is not allowed to.',
    kind: 'invalid',
  },
  access_denied: { text: 'Sign-in was not allowed.', kind: 'off_account' },
  temporarily_unavailable: {
    text: 'Sign-in is busy right now. Try again in a minute.',
    kind: 'capacity',
  },
  server_error: {
    text: 'Something went wrong on this site. Try again later.',
    kind: 'unavailable',
  },
  slow_down: { text: 'Waiting for approval.', kind: 'rate' },
  authorization_pending: { text: 'Waiting for approval.', kind: 'rate' },
  expired_token: { text: 'That code expired. Start again on the device.', kind: 'sign_in' },
  invalid_token: { text: 'That sign-in ended.', kind: 'sign_in' },
  insufficient_scope: { text: 'This application is not allowed to do that.', kind: 'off_account' },
  login_required: { text: 'Sign in to continue.', kind: 'sign_in' },
  consent_required: { text: 'Allow the application to continue.', kind: 'off_account' },
  account_selection_required: { text: 'Pick an account to continue.', kind: 'invalid' },
  interaction_required: { text: 'Continue on this site.', kind: 'invalid' },
  request_not_supported: {
    text: 'This application sent a request this site can not use.',
    kind: 'invalid',
  },
}

const own = (table: object, key: string) => Object.prototype.hasOwnProperty.call(table, key)

export const protocolLine = (code: string) =>
  own(PROTOCOL, code) ? PROTOCOL[code] : PROTOCOL.invalid_request

const fixed = (text: string) => () => text

// Keyed by `kind:control`, or `kind:field` for a malformed value.
export const REFUSALS: Record<string, (value: number) => string> = {
  'off_account:protection_totp': fixed('Two-factor is required here.'),
  'off_server:mod_totp': fixed('Your moderator tools here are off until you set up two-factor.'),
  'off_server:role.requires_totp': fixed(
    'Your moderator tools here are off until you set up two-factor.'
  ),
  'off_site:two_factor': fixed('Authenticator codes are turned off on this site.'),
  'off_site:application_registration': fixed('Registering applications is off here.'),
  'off_account:application_registration': fixed("Your account can't register applications here."),
  'limit:APPLICATIONS_PER_ACCOUNT': value =>
    `You own ${value} applications, the most here. Delete one to make another.`,
  'conflict:application_proposal': fixed('Someone changed this setting first. Propose it again.'),
  'off_site:oauth_provider': fixed('Sign-in for other services is turned off on this site.'),
  'off_site:application_admin_scope': fixed(
    "This site doesn't let applications use administration."
  ),
  'off_site:application_encrypted_access': fixed(
    "This site doesn't let applications read encrypted chats."
  ),
  'conflict:proxy_hosts': fixed('Another application uses this host.'),
  'invalid:hosts': fixed("This host isn't in FORWARD_AUTH_HOSTS."),
  'capacity:logout_deliveries': fixed('Sign-out notices are delayed.'),
  'conflict:application_seat': fixed('You already vote as an owner.'),
  'invalid:accounts': fixed('No account with that name.'),
  'unavailable:ACCOUNT_SECRETS_KEY': fixed('This site is missing a key. Ask the site admin.'),
  'limit:E2EE_DEVICES_PER_ACCOUNT': value =>
    `You have ${value} of ${value} encryption devices. Remove one first.`,
}

export const refusalLine = (b: Body): string => {
  const r = b.reason
  if (!r) return b.error
  const key = `${r.kind}:${r.control ?? r.field ?? ''}`
  return own(REFUSALS, key) ? REFUSALS[key](r.value ?? 0) : b.error
}
