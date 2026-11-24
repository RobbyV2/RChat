import { LIMIT_ROWS, type LimitKey } from './limits'

export type ReasonKind =
  | 'off_site'
  | 'off_account'
  | 'off_server'
  | 'off_app'
  | 'limit'
  | 'capacity'
  | 'invalid'
  | 'rate'
  | 'conflict'
  | 'sign_in'
  | 'unavailable'
  | 'locked'
  | 'app'

export interface Reason {
  kind: ReasonKind
  control?: string
  field?: string
  retry_after?: number
  until?: number
  used?: string
  cap?: string
  who?: 'operator' | 'owner' | 'author'
  app?: string
  text?: string
}

export interface Refusal {
  error: string
  reason?: Reason
}

export const notFound = (): Refusal => ({ error: 'Not found' })

export const invalid = (field: string, what: string): Refusal => ({
  error: `${field} ${what}.`,
  reason: { kind: 'invalid', field },
})

export const invalidLine = (field: string, line: string): Refusal => ({
  error: line,
  reason: { kind: 'invalid', field },
})

export const conflict = (what: string): Refusal => ({ error: what, reason: { kind: 'conflict' } })

// An author's words, cut at 200 characters.
const words = (text: string) => [...text].slice(0, 200).join('')

export const appConflict = (app: string, text: string): Refusal => ({
  error: 'That already exists.',
  reason: { kind: 'conflict', app, text: words(text) },
})

export const offAccount = (control: string, text: string): Refusal => ({
  error: text,
  reason: { kind: 'off_account', control },
})

export const unavailable = (control: string, text: string, retry?: number): Refusal => ({
  error: text,
  reason: { kind: 'unavailable', control, ...(retry === undefined ? {} : { retry_after: retry }) },
})

// The author's words travel only in `reason.text`; `error` is always this line.
export const APP_ERROR = 'Refused by the app.'

export const fromApp = (app: string, text: string): Refusal => ({
  error: APP_ERROR,
  reason: { kind: 'app', app, text: words(text) },
})

export const cliLine = (r: Refusal): string =>
  r.reason?.kind === 'app' ? `${r.reason.app} says: ${r.reason.text}` : r.error

export const rate = (control: string, retry: number, text: string): Refusal => ({
  error: text,
  reason: { kind: 'rate', control, retry_after: retry },
})

// Locked by a moderator until `until` (unix seconds).
export const locked = (until: number, text: string): Refusal => ({
  error: text,
  reason: { kind: 'locked', until },
})

export const offSite = (control: string, text: string): Refusal => ({
  error: text,
  reason: { kind: 'off_site', control },
})

export const offServer = (control: string, text: string): Refusal => ({
  error: text,
  reason: { kind: 'off_server', control },
})

export const offApp = (control: string, text: string): Refusal => ({
  error: text,
  reason: { kind: 'off_app', control },
})

export const capacity = (control: string, retry: number, text: string): Refusal => ({
  error: text,
  reason: { kind: 'capacity', control, retry_after: retry },
})

export const limit = (
  key: LimitKey,
  used: string,
  cap: string,
  setBy: 'operator' | 'owner' | 'author' = 'operator'
): Refusal => {
  const r = LIMIT_ROWS.find(x => x.key === key)!
  const who =
    setBy === 'author'
      ? 'This app sets it; the server owner can ask its author.'
      : setBy === 'owner' && r.who !== 'operator'
        ? 'The server owner set it and can raise it up to the site limit.'
        : 'The site admin can raise it.'
  return {
    error: `${r.what}: ${used} of ${cap}. ${who}`,
    reason: { kind: 'limit', control: r.env.toLowerCase(), used, cap, who: setBy },
  }
}
