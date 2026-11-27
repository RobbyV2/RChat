import { time } from '../platform/time'
// One call of a hook point: before handlers, then the winning replace or the original wrapped by
// around handlers, then after handlers. Each kind runs by priority, then install order. A
// handler that throws, returns an invalid value, cancels where it may not, or misses its
// deadline is skipped and gets a strike.

export type Kind = 'before' | 'replace' | 'around' | 'after'
export const CANCEL = Symbol('cancel')
export class Late extends Error {
  constructor() {
    super('next called after the deadline')
  }
}

export interface Handler<T> {
  plugin: string
  installed: number
  priority: number
  kind: Kind
  fn: (input: T, next?: (input: T) => T) => T | typeof CANCEL
}

export interface Outcome<T> {
  output: T | typeof CANCEL
  strikes: string[]
  conflicts: [winner: string, loser: string][]
}

const order = <T extends { priority: number; installed: number }>(a: T, b: T) =>
  b.priority - a.priority || a.installed - b.installed

// Runs `f` at most once; later calls return the first result or rethrow its error.
const once = <A, R>(f: (a: A) => R) => {
  let done = false
  let value: R
  let error: unknown
  let failed = false
  return (a: A): R => {
    if (!done) {
      done = true
      try {
        value = f(a)
      } catch (e) {
        failed = true
        error = e
      }
    }
    if (failed) throw error
    return value
  }
}

export const runChain = <T>(
  handlers: readonly Handler<T>[],
  input: T,
  original: (input: T) => T,
  valid: (v: unknown) => v is T,
  cancellable = false
): Outcome<T> => {
  const strikes: string[] = []
  const conflicts: [string, string][] = []
  const guard = (
    h: Handler<T>,
    f: () => T | typeof CANCEL,
    fallback: () => T,
    mayCancel = cancellable
  ): T | typeof CANCEL => {
    try {
      const v = f()
      if (v === CANCEL && mayCancel) return v
      if (v !== CANCEL && valid(v)) return v
    } catch {
      // a strike, below
    }
    strikes.push(h.plugin)
    return fallback()
  }
  const of = (k: Kind) => handlers.filter(h => h.kind === k).sort(order)

  let x: T = input
  for (const h of of('before')) {
    const v = guard(
      h,
      () => h.fn(x),
      () => x
    )
    if (v === CANCEL) return { output: CANCEL, strikes, conflicts }
    x = v
  }

  const replaces = of('replace')
  const winner = replaces[0]
  for (const loser of replaces.slice(1)) conflicts.push([winner.plugin, loser.plugin])
  const core = (i: T): T =>
    winner
      ? (guard(
          winner,
          () => winner.fn(i),
          () => original(i),
          false
        ) as T)
      : original(i)

  const wrap = of('around').reduceRight<(i: T) => T>(
    (next, h) => (i: T) => {
      // A failed handler that already called `next` reuses that result.
      const inner = once(next)
      return guard(
        h,
        () => h.fn(i, inner),
        () => inner(i),
        false
      ) as T
    },
    core
  )

  let out: T = wrap(x)
  for (const h of of('after'))
    out = guard(
      h,
      () => h.fn(out),
      () => out,
      false
    ) as T
  return { output: out, strikes, conflicts }
}

export interface AsyncHandler<T> {
  plugin: string
  installed: number
  priority: number
  kind: Kind
  fn: (input: T, next?: (input: T) => Promise<T>) => Promise<T | typeof CANCEL>
}

export interface AsyncOutcome<T> extends Outcome<T> {
  // Plugins whose `next` was refused after their deadline.
  late: string[]
}

const TIMEOUT = Symbol('timeout')

const within = <V>(p: Promise<V>, ms: number): Promise<V | typeof TIMEOUT> =>
  new Promise((resolve, reject) => {
    const t = time().after(ms, () => resolve(TIMEOUT))
    p.then(
      v => {
        t()
        resolve(v)
      },
      e => {
        t()
        reject(e)
      }
    )
  })

// The same order with each handler under the point's deadline. On a miss the host goes on
// without the handler, and a late around handler's `next` is refused, so the original never
// runs twice.
export const runChainAsync = async <T>(
  handlers: readonly AsyncHandler<T>[],
  input: T,
  original: (input: T) => Promise<T>,
  valid: (v: unknown) => v is T,
  deadlineMs: number,
  cancellable = false
): Promise<AsyncOutcome<T>> => {
  const strikes: string[] = []
  const late: string[] = []
  const conflicts: [string, string][] = []
  const of = (k: Kind) => handlers.filter(h => h.kind === k).sort(order)

  // The handler's valid value, CANCEL where allowed, or null on any failure.
  const attempt = async (
    h: AsyncHandler<T>,
    run: () => Promise<T | typeof CANCEL>,
    mayCancel: boolean
  ): Promise<T | typeof CANCEL | null> => {
    try {
      const v = await within(Promise.resolve().then(run), deadlineMs)
      if (v === TIMEOUT) {
        strikes.push(h.plugin)
        return null
      }
      if (v === CANCEL) {
        if (mayCancel) return v
      } else if (valid(v)) return v
    } catch {
      // a strike, below
    }
    strikes.push(h.plugin)
    return null
  }

  let x: T = input
  for (const h of of('before')) {
    const v = await attempt(h, () => h.fn(x), cancellable)
    if (v === CANCEL) return { output: CANCEL, strikes, conflicts, late }
    if (v !== null) x = v
  }

  const replaces = of('replace')
  const winner = replaces[0]
  for (const loser of replaces.slice(1)) conflicts.push([winner.plugin, loser.plugin])
  const core = async (i: T): Promise<T> => {
    if (!winner) return original(i)
    const v = await attempt(winner, () => winner.fn(i), false)
    return v === null || v === CANCEL ? original(i) : v
  }

  const wrap = of('around').reduceRight<(i: T) => Promise<T>>(
    (next, h) => async (i: T) => {
      let closed = false
      let inner: Promise<T> | null = null
      const tracked = (j: T): Promise<T> => {
        if (inner) return inner
        if (closed) {
          late.push(h.plugin)
          return Promise.reject(new Late())
        }
        inner = next(j)
        return inner
      }
      const v = await attempt(h, () => h.fn(i, tracked), false)
      closed = true
      if (v !== null && v !== CANCEL) return v
      return inner ?? next(i)
    },
    core
  )

  let out: T = await wrap(x)
  for (const h of of('after')) {
    const v = await attempt(h, () => h.fn(out), false)
    if (v !== null && v !== CANCEL) out = v
  }
  return { output: out, strikes, conflicts, late }
}
