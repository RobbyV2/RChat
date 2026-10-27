import { backoffDelay } from './backoff'
import type { ReadMark } from './lists'
import type { Unread } from './types'

type Timer = ReturnType<typeof setTimeout>

export interface ReadQueue {
  mark: (scope: string, id: number) => void
  seen: (scope: string, id: number) => void
  flush: (scope?: string) => Promise<void>
  clear: () => void
  queued: () => number
  pending: (scope: string) => number
}

export const READ_DELAY = 2_000
export const READ_MAX_WAIT = 5_000
export const READ_RETRY_CAP = 60_000

const permanent = (err: unknown) => {
  const status = (err as { status?: unknown } | null)?.status
  return typeof status === 'number' && status >= 400 && status < 500 && status !== 429
}

export const createReadQueue = (opts: {
  send: (scope: string, id: number) => Promise<unknown>
  delay?: number
  maxWait?: number
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => Timer
  clearTimer?: (t: Timer) => void
  retryDelay?: (attempt: number) => number
}): ReadQueue => {
  const delay = opts.delay ?? READ_DELAY
  const maxWait = opts.maxWait ?? READ_MAX_WAIT
  const now = opts.now ?? Date.now
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = opts.clearTimer ?? (t => clearTimeout(t))
  const retryDelay =
    opts.retryDelay ?? (attempt => backoffDelay(attempt, Math.random, 1_000, READ_RETRY_CAP))
  const sent = new Map<string, number>()
  const queue = new Map<string, { id: number; since: number; at?: number }>()
  const failures = new Map<string, number>()
  let timer: Timer | null = null
  let gen = 0

  const send = (scope: string, id: number) => {
    sent.set(scope, id)
    const mine = gen
    return opts.send(scope, id).then(
      () => {
        if (mine === gen && (queue.get(scope)?.id ?? 0) <= id) failures.delete(scope)
      },
      (err: unknown) => {
        if (mine !== gen) return
        if (sent.get(scope) === id) sent.delete(scope)
        if (permanent(err)) {
          failures.delete(scope)
          return
        }
        const cur = queue.get(scope)
        if (cur && cur.id > id) return
        const attempt = (failures.get(scope) ?? 0) + 1
        failures.set(scope, attempt)
        queue.set(scope, { id, since: cur?.since ?? now(), at: now() + retryDelay(attempt) })
        schedule()
      }
    )
  }

  const flush = (scope?: string) => {
    const scopes = scope === undefined ? [...queue.keys()] : [scope]
    const sending: Promise<void>[] = []
    for (const s of scopes) {
      const q = queue.get(s)
      if (!q) continue
      queue.delete(s)
      if (q.id > (sent.get(s) ?? 0)) sending.push(send(s, q.id))
    }
    if (timer !== null && queue.size === 0) {
      clearTimer(timer)
      timer = null
    }
    return Promise.all(sending).then(() => {})
  }

  const flushDue = () => {
    const t = now()
    for (const [s, q] of [...queue]) if (q.at === undefined || q.at <= t) flush(s)
    if (queue.size) schedule()
  }

  const schedule = () => {
    if (timer !== null) clearTimer(timer)
    timer = null
    if (!queue.size) return
    let next = Infinity
    for (const q of queue.values())
      next = Math.min(next, q.at ?? Math.min(now() + delay, q.since + maxWait))
    timer = setTimer(
      () => {
        timer = null
        flushDue()
      },
      Math.max(0, next - now())
    )
  }

  return {
    mark: (scope, id) => {
      const cur = queue.get(scope)
      if (id <= Math.max(sent.get(scope) ?? 0, cur?.id ?? 0)) return
      queue.set(scope, { id, since: cur?.since ?? now(), at: cur?.at })
      schedule()
    },
    seen: (scope, id) => {
      if (id > (sent.get(scope) ?? 0)) sent.set(scope, id)
      const cur = queue.get(scope)
      if (cur && cur.id <= id) {
        queue.delete(scope)
        failures.delete(scope)
      }
    },
    flush,
    clear: () => {
      gen += 1
      if (timer !== null) clearTimer(timer)
      timer = null
      queue.clear()
      sent.clear()
      failures.clear()
    },
    queued: () => queue.size,
    pending: scope => Math.max(queue.get(scope)?.id ?? 0, sent.get(scope) ?? 0),
  }
}

export const mergeReads = (
  before: Record<string, ReadMark>,
  current: Record<string, ReadMark>,
  items: Unread[],
  pending: (scope: string) => number
): Record<string, ReadMark> => {
  const out: Record<string, ReadMark> = {}
  for (const [scope, mark] of Object.entries(current)) if (mark !== before[scope]) out[scope] = mark
  for (const i of items) {
    const local = current[i.scope]
    const lastRead = Math.max(i.last_read, local?.lastRead ?? 0, pending(i.scope))
    out[i.scope] = {
      lastRead,
      latest: Math.max(i.latest, local?.latest ?? 0, lastRead),
      server: i.server ?? local?.server,
    }
  }
  return out
}
