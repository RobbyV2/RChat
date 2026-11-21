// The account tools of the site administration page: the create form, the lines about a
// temporary password, and the text an admin hands to the person.

import type { AccountFilter, AccountServer, AdminAccount, PasswordChangeMode } from './types'

export const USERNAME_MAX = 100
export const DISPLAY_NAME_MAX = 32
// The most servers one new account joins besides the default ones.
export const ACCOUNT_SERVERS_MAX = 20

export const ACCOUNT_FILTERS: { value: AccountFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'temporary', label: 'Temporary password' },
  { value: 'expired', label: 'Expired' },
]

export interface AccountForm {
  username: string
  displayName: string
  servers: AccountServer[]
}

export const emptyAccountForm = (): AccountForm => ({ username: '', displayName: '', servers: [] })

const count = (text: string) => [...text].length

// What is wrong with the form, as { field, message }, or null. The server checks the rest
// (taken and banned names, the name filter).
export const accountFormError = (
  form: AccountForm
): { field: 'username' | 'displayName' | 'servers'; message: string } | null => {
  const name = form.username.trim()
  if (name === '') return { field: 'username', message: 'Enter a username.' }
  if (count(name) > USERNAME_MAX)
    return { field: 'username', message: `Use at most ${USERNAME_MAX} characters.` }
  if (name.includes('@')) return { field: 'username', message: "Usernames can't contain @." }
  if (count(form.displayName.trim()) > DISPLAY_NAME_MAX)
    return { field: 'displayName', message: `Use at most ${DISPLAY_NAME_MAX} characters.` }
  if (form.servers.length > ACCOUNT_SERVERS_MAX)
    return { field: 'servers', message: `Add at most ${ACCOUNT_SERVERS_MAX} servers.` }
  return null
}

// The request the form sends.
export const accountRequest = (form: AccountForm) => {
  const display = form.displayName.trim()
  return {
    username: form.username.trim(),
    ...(display === '' ? {} : { display_name: display }),
    servers: form.servers,
  }
}

// The form's servers with `server` added (once, at the end) or its roles replaced.
export const withServer = (servers: AccountServer[], server: string, roles: number[] = []) =>
  servers.some(s => s.server === server)
    ? servers.map(s => (s.server === server ? { server, roles } : s))
    : [...servers, { server, roles }]

export const withoutServer = (servers: AccountServer[], server: string) =>
  servers.filter(s => s.server !== server)

// `roles` with `id` switched on or off.
export const toggledRole = (roles: number[], id: number) =>
  roles.includes(id) ? roles.filter(r => r !== id) : [...roles, id]

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`

// How long from `now` (unix seconds) until `at`, in the largest unit that fits: "3 days",
// "5 hours", "20 minutes", "under a minute".
export const span = (at: number, now: number) => {
  const left = Math.max(0, at - now)
  if (left >= 86400) return plural(Math.round(left / 86400), 'day')
  if (left >= 3600) return plural(Math.round(left / 3600), 'hour')
  if (left >= 60) return plural(Math.round(left / 60), 'minute')
  return 'under a minute'
}

// When a temporary password stops signing in.
export const expiryLine = (expiresAt: number | null, now: number) => {
  if (expiresAt === null) return 'It does not expire.'
  return expiresAt <= now ? 'It has expired.' : `It stops working in ${span(expiresAt, now)}.`
}

// What the new person is asked to do with it.
export const changeLine = (mode: PasswordChangeMode | undefined) =>
  mode === 'encouraged'
    ? 'They are asked to choose their own password after signing in.'
    : 'They must choose their own password at first sign-in.'

// How an account signs in, for its page.
export const signInLine = (account: AdminAccount, now: number) => {
  const t = account.temporary
  if (t === null) return account.sign_in === 'words' ? '7 words' : 'Password'
  if (t.expired || (t.expires_at !== null && t.expires_at <= now))
    return 'Temporary password, expired'
  return t.expires_at === null
    ? 'Temporary password, no expiry'
    : `Temporary password, stops working in ${span(t.expires_at, now)}`
}

// The plain text an admin hands to the person: where to sign in and with what.
export const signInDetails = (address: string, username: string, password: string) =>
  [`Address: ${address}`, `Username: ${username}`, `Temporary password: ${password}`].join('\n')
