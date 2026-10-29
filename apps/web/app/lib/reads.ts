import { backoffDelay } from './backoff'
import type { ReadMark } from './lists'
import { clearPings, pingCount, type Pings } from './pings'
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

const READ_DELAY = 2_000
const READ_MAX_WAIT = 5_000
const READ_RETRY_CAP = 60_000

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

// Most scopes one POST /api/read/batch takes.
export const READ_BATCH_MAX = 200

export const chunked = <T>(list: readonly T[], size = READ_BATCH_MAX): T[][] => {
  const out: T[][] = []
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size))
  return out
}

// The keys "Mark as read" sends for the channel and DM scopes `pick` accepts: unread scopes,
// scopes with pings, and the threads (`t<root id>`) with pings in them. Mutes do not matter.
export const markTargets = (
  reads: Record<string, ReadMark>,
  pings: Pings,
  pick: (scope: string, server: string | null) => boolean
): string[] => {
  const out = new Set<string>()
  for (const [scope, r] of Object.entries(reads))
    if (r.latest > r.lastRead && scope[0] !== 't' && pick(scope, r.server ?? null)) out.add(scope)
  for (const [key, p] of Object.entries(pings))
    if (pingCount(p) > 0 && pick(p.scope, p.server)) out.add(key)
  return [...out]
}

// Adds the thread keys with pings under the given channel scopes.
export const withThreads = (keys: readonly string[], pings: Pings): string[] => {
  const out = new Set(keys)
  for (const [key, p] of Object.entries(pings)) if (out.has(p.scope)) out.add(key)
  return [...out]
}

// Local state once `keys` are read: positions move to the newest known message and every ping
// under the keys is gone.
export const markedRead = (
  reads: Record<string, ReadMark>,
  pings: Pings,
  keys: readonly string[]
): { reads: Record<string, ReadMark>; pings: Pings } => {
  let nextReads = reads
  let nextPings = pings
  for (const key of keys) {
    nextPings = clearPings(nextPings, key)
    const r = nextReads[key]
    if (key[0] !== 't' && r && r.latest > r.lastRead) {
      if (nextReads === reads) nextReads = { ...reads }
      nextReads[key] = { ...r, lastRead: r.latest }
    }
  }
  return { reads: nextReads, pings: nextPings }
}
