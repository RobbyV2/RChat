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
