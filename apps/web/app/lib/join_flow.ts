import { ApiError } from './api'
import { parseInvite, type InviteTarget } from './invite'

export const PASSWORD_REQUIRED = 'Password required'
export const ACCESS_DENIED = 'Server not found or wrong password'

export const JOIN_NOTE =
  'Private servers (or nonexistent servers) will ask for a password, if the server exists and the password is correct, you will join the server.'

export const needsPassword = (e: unknown) =>
  e instanceof ApiError && e.status === 401 && e.message === PASSWORD_REQUIRED

export const deniedAccess = (e: unknown) =>
  e instanceof ApiError && e.status === 404 && e.message === ACCESS_DENIED

export type JoinStep = 'name' | 'password'

export type JoinResult = { done: true } | { done: false; step: JoinStep; error: string | null }

export async function runJoinStep(
  step: JoinStep,
  password: string,
  join: (password?: string) => Promise<unknown>,
  describe: (e: unknown) => string
): Promise<JoinResult> {
  const pw = step === 'password' ? password.trim() : ''
  if (step === 'password' && !pw) return { done: false, step, error: 'Enter the server password' }
  try {
    await join(pw || undefined)
    return { done: true }
  } catch (e) {
    if (needsPassword(e))
      return {
        done: false,
        step: 'password',
        error: step === 'password' ? 'Enter the server password' : null,
      }
    return { done: false, step, error: describe(e) }
  }
}

export const CODE_GONE = "This invite link doesn't work. It may have expired."

// What the join field holds: a pasted invite link of this instance, or (null) a server name.
export const joinInput = (text: string, origin: string): InviteTarget | null => {
  const trimmed = text.trim()
  return trimmed.includes('/') ? parseInvite(trimmed, origin) : null
}

// Joins with an invite code: finds the server the code is for, then joins it with the code as
// its password. Answers the error to show, or null once joined.
export async function joinByCode(
  code: string,
  lookup: (code: string) => Promise<string>,
  join: (server: string, password?: string) => Promise<unknown>,
  describe: (e: unknown) => string
): Promise<string | null> {
  let server: string
  try {
    server = await lookup(code)
  } catch (e) {
    return e instanceof ApiError && e.status === 404 ? CODE_GONE : describe(e)
  }
  try {
    await join(server, code)
    return null
  } catch (e) {
    return deniedAccess(e) || needsPassword(e) ? CODE_GONE : describe(e)
  }
}
