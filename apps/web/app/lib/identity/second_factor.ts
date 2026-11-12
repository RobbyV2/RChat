import { refusalLine, type Body } from './errors'
import { cleanCode, cleanRecovery } from './totp_display'

export type Method = 'totp' | 'recovery_code' | 'phrase'
export const METHODS: readonly Method[] = ['totp', 'recovery_code', 'phrase']

export type Step =
  | { step: 'password'; error: string | null }
  | {
      step: 'code'
      pending: string
      methods: Method[]
      mode: Method | null
      expiresAt: number
      error: string | null
      locked: string | null
    }
  | { step: 'done' }

export type Answer = Body & { tries_left?: number }

export const START: Step = { step: 'password', error: null }

const CREDENTIALS = "That username and password don't match."
const EXPIRED = 'That took too long. Sign in again.'

export const wrongCodeLine = (triesLeft: number | undefined) =>
  triesLeft && triesLeft > 0
    ? `That code didn't work. ${triesLeft} ${triesLeft === 1 ? 'try' : 'tries'} left.`
    : "That code didn't work."

const wait = (secs: number | undefined) => {
  if (secs === undefined || secs <= 0) return 'later'
  const minutes = Math.ceil(secs / 60)
  if (minutes <= 1) return 'in a minute'
  if (minutes <= 90) return `in ${minutes} minutes`
  return `in ${Math.ceil(minutes / 60)} hours`
}

export const lockedLine = (retryAfter: number | undefined, phrase: boolean) =>
  `Too many wrong codes. Try again ${wait(retryAfter)}${phrase ? ', or use your backup phrase' : ''}.`

const sentence = (text: string) => (/[.!?]$/.test(text) ? text : `${text}.`)

const codeError = (b: Answer) => {
  if (b.error === 'Enter the code from your authenticator app') return null
  if (b.error === 'Wrong code') return wrongCodeLine(b.tries_left)
  const line = refusalLine(b)
  return line === b.error ? sentence(line) : line
}

export const next = (state: Step, status: number, b: Answer): Step => {
  if (status >= 200 && status < 300) return { step: 'done' }
  const locked = status === 423
  const here = state.step === 'code' ? state : null
  if (b.second_factor || here) {
    if (b.reason?.field === 'pending') return { step: 'password', error: EXPIRED }
    const listed = b.second_factor?.methods ?? here?.methods ?? []
    const methods = METHODS.filter(m => listed.includes(m))
    const open = locked ? methods.filter(m => m === 'phrase') : methods
    const mode = here?.mode && open.includes(here.mode) ? here.mode : (open[0] ?? null)
    return {
      step: 'code',
      pending: b.second_factor?.pending ?? here?.pending ?? '',
      methods,
      mode,
      expiresAt: b.second_factor?.expires_at ?? here?.expiresAt ?? 0,
      error: locked ? null : codeError(b),
      locked: locked ? lockedLine(b.reason?.retry_after, methods.includes('phrase')) : null,
    }
  }
  return {
    step: 'password',
    error: !b.reason && b.error === 'Invalid credentials' ? CREDENTIALS : refusalLine(b),
  }
}

export const heading = (mode: Method) =>
  mode === 'totp'
    ? 'Enter the code from your authenticator app'
    : mode === 'recovery_code'
      ? 'Enter a recovery code'
      : 'Use your backup phrase'

const LINK: Record<Method, string> = {
  totp: 'Use your authenticator app',
  recovery_code: 'Use a recovery code',
  phrase: 'Use your backup phrase instead',
}

export const links = (state: Step) =>
  state.step === 'code' && !state.locked
    ? state.methods.filter(m => m !== state.mode).map(mode => ({ mode, label: LINK[mode] }))
    : []

export const switchMode = (state: Step, mode: Method): Step =>
  state.step === 'code' && state.methods.includes(mode) ? { ...state, mode, error: null } : state

export const rememberLine = (days: number) =>
  days > 0 ? `Remember this device for ${days} ${days === 1 ? 'day' : 'days'}` : null

export const requestBody = (
  state: Step,
  username: string,
  input: string,
  extra: { remember?: boolean; label?: string }
) => {
  if (state.step !== 'code' || state.locked) return null
  const base = { username, pending: state.pending, ...extra }
  if (state.mode === 'totp') {
    const code = cleanCode(input)
    return code ? { ...base, code } : null
  }
  if (state.mode === 'recovery_code') {
    const code = cleanRecovery(input)
    return code ? { ...base, recovery_code: code } : null
  }
  return null
}
