import { ApiError } from './api'

// Why a request was refused, as the app reasons about it. `denied` is an answer with no reason:
// the caller cannot open the thing, or it is not there. `offline` is a request that never got an
// answer.
export type RefusalKind =
  | 'invalid'
  | 'rate'
  | 'conflict'
  | 'sign_in'
  | 'unavailable'
  | 'off_site'
  | 'off_account'
  | 'off_server'
  | 'off_app'
  | 'app'
  | 'limit'
  | 'capacity'
  | 'perm'
  | 'locked'
  | 'denied'
  | 'offline'
  | 'unknown'

export interface Refusal {
  kind: RefusalKind
  // The server's own line, in plain text.
  message: string
  // The switch, limit or permission the refusal is about.
  control: string | null
  // The fields of the request the refusal is about.
  fields: readonly string[]
  // Seconds to wait before asking again.
  retryAfter: number | null
  status: number | null
}

const KINDS: ReadonlySet<string> = new Set<RefusalKind>([
  'invalid',
  'rate',
  'conflict',
  'sign_in',
  'unavailable',
  'off_site',
  'off_account',
  'off_server',
  'off_app',
  'app',
  'limit',
  'capacity',
  'perm',
  'locked',
])

const text = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)

const seconds = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.ceil(v) : null

const byStatus = (status: number): RefusalKind => {
  if (status === 401) return 'sign_in'
  if (status === 403 || status === 404) return 'denied'
  if (status === 409) return 'conflict'
  if (status === 429) return 'rate'
  if (status === 400 || status === 422) return 'invalid'
  if (status >= 500) return 'unavailable'
  return 'unknown'
}

const plain = (kind: RefusalKind, message: string): Refusal => ({
  kind,
  message,
  control: null,
  fields: [],
  retryAfter: null,
  status: null,
})

// Any failure of a request as a refusal. This is the one place that reads the shape errors come
// in: the API client's error and the body the server sent with it, a request that was cut off
// or timed out, and anything else thrown on the way.
export const refusalOf = (error: unknown): Refusal => {
  if (error instanceof ApiError) {
    const body = (error.data ?? {}) as { reason?: unknown }
    const reason = (body.reason && typeof body.reason === 'object' ? body.reason : {}) as Record<
      string,
      unknown
    >
    const said = text(reason.kind)
    const field = text(reason.field)
    const fields = Array.isArray(reason.fields)
      ? reason.fields.filter((f): f is string => typeof f === 'string')
      : []
    return {
      kind: said !== null && KINDS.has(said) ? (said as RefusalKind) : byStatus(error.status),
      message: error.message,
      control: text(reason.control),
      fields: field !== null && !fields.includes(field) ? [field, ...fields] : fields,
      retryAfter: seconds(reason.retry_after) ?? seconds(error.retryAfter),
      status: error.status,
    }
  }
  if (error instanceof Error) {
    if (error.name === 'TimeoutError') return plain('unavailable', 'The request took too long')
    if (error.name === 'AbortError') return plain('unknown', 'The request was stopped')
    if (error instanceof TypeError) return plain('offline', 'No answer from the server')
    return plain('unknown', error.message || 'Something went wrong')
  }
  return plain('unknown', typeof error === 'string' && error ? error : 'Something went wrong')
}

// Whether asking again can help without the person changing anything.
export const canRetry = (r: Refusal): boolean =>
  r.kind === 'rate' ||
  r.kind === 'capacity' ||
  r.kind === 'unavailable' ||
  r.kind === 'offline' ||
  r.kind === 'unknown'

// Where a refusal is shown: under the field it is about, as a notice with a way to ask again, on
// the control that is turned off, as the connection state, as a prompt to log in again, or
// inside the app that refused (in its own words).
export type RefusalPlace = 'field' | 'notice' | 'control' | 'connection' | 'sign_in' | 'app'

export interface RefusalView {
  where: RefusalPlace
  // What the person reads. Never a code.
  line: string
  // Whether asking again can help, and the seconds to wait first.
  retry: boolean
  wait: number | null
  fields: readonly string[]
}

// A wait as people say it: seconds under a minute, then whole minutes.
export const waitText = (seconds: number): string => {
  if (seconds < 60) return seconds === 1 ? '1 second' : `${seconds} seconds`
  const minutes = Math.round(seconds / 60)
  return minutes === 1 ? 'about a minute' : `about ${minutes} minutes`
}

// What a control's key is called in a line: its words, the first one capitalized.
export const controlLabel = (control: string | null): string | null => {
  const words = (control ?? '').replace(/[._-]+/g, ' ').trim()
  return words ? words[0].toUpperCase() + words.slice(1) : null
}

const again = (wait: number | null) =>
  wait === null ? 'Try again in a moment.' : `Try again in ${waitText(wait)}.`

const OFF: Record<'off_site' | 'off_account' | 'off_server' | 'off_app', string> = {
  off_site: 'on this site',
  off_account: 'for your account',
  off_server: 'in this server',
  off_app: 'for this app',
}

// What to show for a refusal, and where.
export const refusalView = (r: Refusal): RefusalView => {
  const base = { retry: canRetry(r), wait: r.retryAfter, fields: r.fields }
  const thing = controlLabel(r.control)
  switch (r.kind) {
    case 'invalid':
      return { ...base, where: r.fields.length ? 'field' : 'notice', line: r.message }
    case 'rate':
      return {
        ...base,
        where: 'notice',
        line: `You are doing that too fast. ${again(r.retryAfter)}`,
      }
    case 'capacity':
      return {
        ...base,
        where: 'notice',
        line: `This site is at capacity${thing ? ` for ${thing.toLowerCase()}` : ''} right now. ${again(r.retryAfter)}`,
      }
    case 'unavailable':
      return {
        ...base,
        where: 'notice',
        line: `The server cannot do that right now. ${again(r.retryAfter)}`,
      }
    case 'off_site':
    case 'off_account':
    case 'off_server':
    case 'off_app':
      return {
        ...base,
        where: 'control',
        line: `${thing ?? 'This'} is turned off ${OFF[r.kind]}.`,
      }
    case 'perm':
      return { ...base, where: 'control', line: 'You do not have permission to do that here.' }
    case 'locked':
    case 'limit':
    case 'conflict':
      return { ...base, where: 'notice', line: r.message }
    case 'sign_in':
      return { ...base, where: 'sign_in', line: 'Your session ended. Log in again to continue.' }
    case 'app':
      return { ...base, where: 'app', line: r.message }
    case 'denied':
      return { ...base, where: 'notice', line: 'This is not here, or you cannot open it.' }
    case 'offline':
      return {
        ...base,
        where: 'connection',
        line: 'No answer from the server. Check your connection and try again.',
      }
    case 'unknown':
      return { ...base, where: 'notice', line: r.message }
  }
}

// The line under `field`, when the refusal is about it.
export const fieldLine = (r: Refusal | null, field: string): string | null =>
  r !== null && r.fields.includes(field) ? r.message : null
