import { ApiError } from './api'

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
