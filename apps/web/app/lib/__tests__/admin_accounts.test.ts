import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  accountFormError,
  accountRequest,
  changeLine,
  emptyAccountForm,
  expiryLine,
  signInDetails,
  signInLine,
  span,
  toggledRole,
  withServer,
  withoutServer,
} from '../admin_accounts'
import type { AdminAccount } from '../types'
import { user } from './fixtures'

const form = (over = {}) => ({ ...emptyAccountForm(), username: 'dana', ...over })

test('the create form asks for a username the server could take', () => {
  expect(accountFormError(form())).toBeNull()
  expect(accountFormError(form({ username: '  ' }))).toEqual({
    field: 'username',
    message: 'Enter a username.',
  })
  expect(accountFormError(form({ username: 'a@b' }))?.message).toBe("Usernames can't contain @.")
  expect(accountFormError(form({ username: 'x'.repeat(100) }))).toBeNull()
  expect(accountFormError(form({ username: 'x'.repeat(101) }))?.message).toBe(
    'Use at most 100 characters.'
  )
  expect(accountFormError(form({ displayName: 'y'.repeat(32) }))).toBeNull()
  expect(accountFormError(form({ displayName: 'y'.repeat(33) }))).toEqual({
    field: 'displayName',
    message: 'Use at most 32 characters.',
  })
  const many = Array.from({ length: 21 }, (_, i) => ({ server: `s${i}`, roles: [] }))
  expect(accountFormError(form({ servers: many.slice(0, 20) }))).toBeNull()
  expect(accountFormError(form({ servers: many }))?.field).toBe('servers')
})

test('the request leaves out an empty display name', () => {
  expect(accountRequest(form({ username: ' Dana ', displayName: '  ' }))).toEqual({
    username: 'Dana',
    servers: [],
  })
  expect(
    accountRequest(form({ displayName: ' Dana R. ', servers: [{ server: 'club', roles: [3] }] }))
  ).toEqual({
    username: 'dana',
    display_name: 'Dana R.',
    servers: [{ server: 'club', roles: [3] }],
  })
})

test('servers are listed once, each with its roles', () => {
  const one = withServer([], 'club')
  expect(one).toEqual([{ server: 'club', roles: [] }])
  const two = withServer(one, 'lobby', [4])
  expect(withServer(two, 'club', [1, 2])).toEqual([
    { server: 'club', roles: [1, 2] },
    { server: 'lobby', roles: [4] },
  ])
  expect(withoutServer(two, 'club')).toEqual([{ server: 'lobby', roles: [4] }])
  expect(toggledRole([1, 2], 2)).toEqual([1])
  expect(toggledRole([1], 2)).toEqual([1, 2])
})

test('lines about a temporary password say when it stops working', () => {
  const now = 1_000_000
  expect(span(now + 3 * 86400, now)).toBe('3 days')
  expect(span(now + 86400, now)).toBe('1 day')
  expect(span(now + 5 * 3600, now)).toBe('5 hours')
  expect(span(now + 20 * 60, now)).toBe('20 minutes')
  expect(span(now + 30, now)).toBe('under a minute')
  expect(expiryLine(now + 72 * 3600, now)).toBe('It stops working in 3 days.')
  expect(expiryLine(null, now)).toBe('It does not expire.')
  expect(expiryLine(now - 1, now)).toBe('It has expired.')
  expect(changeLine('required')).toBe('They must choose their own password at first sign-in.')
  expect(changeLine(undefined)).toBe('They must choose their own password at first sign-in.')
  expect(changeLine('encouraged')).toBe(
    'They are asked to choose their own password after signing in.'
  )
})

const account = (over: Partial<AdminAccount> = {}): AdminAccount => ({
  user: user('dana'),
  created_at: 5,
  sign_in: 'text',
  temporary: null,
  phrase: false,
  sessions: 0,
  servers: 1,
  ...over,
})

test('an account page says how the account signs in', () => {
  const now = 1_000_000
  expect(signInLine(account(), now)).toBe('Password')
  expect(signInLine(account({ sign_in: 'words' }), now)).toBe('7 words')
  const temporary = (expires_at: number | null, expired = false) =>
    account({ temporary: { issued_at: now - 10, expires_at, expired } })
  expect(signInLine(temporary(now + 2 * 86400), now)).toBe(
    'Temporary password, stops working in 2 days'
  )
  expect(signInLine(temporary(null), now)).toBe('Temporary password, no expiry')
  expect(signInLine(temporary(now - 5, true), now)).toBe('Temporary password, expired')
  expect(signInLine(temporary(now - 5), now)).toBe('Temporary password, expired')
})

test('sign-in details are three plain lines', () => {
  expect(signInDetails('https://chat.example.com', 'dana', 'k7mq-x3ta')).toBe(
    'Address: https://chat.example.com\nUsername: dana\nTemporary password: k7mq-x3ta'
  )
})

// A temporary password lives in the open dialog only: nothing writes it to storage or to the
// app's store.
test('nothing that shows a temporary password stores it', () => {
  const source = (path: string) =>
    readFileSync(fileURLToPath(new URL(`../../${path}`, import.meta.url)), 'utf8')
  for (const path of ['components/admin/accounts.tsx', 'lib/admin_accounts.ts']) {
    const code = source(path)
    for (const store of [
      'writeLocal',
      'localStorage',
      'sessionStorage',
      'indexedDB',
      'home.scoped',
      'setState',
      'document.cookie',
    ])
      expect(code.includes(store)).toBe(false)
  }
  const types = source('lib/store_types.ts')
  expect(/temp_password|tempPassword/.test(types)).toBe(false)
})
