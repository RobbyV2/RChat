import { refusalOf, type Refusal } from './api_errors'
import type { Cancel, Time } from './clock'
import { appendUnique, type Key } from './lists'
import type { Live } from './place/live'

// What a screen knows about something it loads: still loading, here, here and empty, refused, or
// waiting on a connection. Only the sources below make a `Load`, and only the `Loaded` component
// reads the value of one, so a screen that shows loaded data also shows every other state.

const minted: unique symbol = Symbol('load')
type Minted = typeof minted

// Why a load is waiting: this device is offline, its connection is coming back, or nobody who
// holds the data is online (a P2P room or DM).
export type Waiting = 'offline' | 'reconnecting' | 'no_peer'

// How long a load may take before its screen says so.
export const LOAD_DEADLINE_MS = 10_000

type State<T> =
  | { status: 'loading'; overdueAt: number }
  | { status: 'ready'; value: T; stale: Refusal | null }
  | { status: 'empty' }
  | { status: 'failed'; refusal: Refusal; retryAt: number | null }
  | { status: 'waiting'; why: Waiting }

export type LoadStatus = State<unknown>['status']

const states = new WeakMap<object, State<unknown>>()

export class Load<T> {
  constructor(
    by: Minted,
    state: State<T>,
    // Asks again; null where nothing can be asked (a value a store holds).
    readonly retry: (() => void) | null
  ) {
    if (by !== minted) throw new TypeError('loads come from the load sources')
    states.set(this, state)
  }

  get status(): LoadStatus {
    return read(this).status
  }

  // The same load with its value mapped; the other states pass through.
  map<U>(to: (value: T) => U): Load<U> {
    const s = read(this)
    return s.status === 'ready'
      ? new Load<U>(minted, { status: 'ready', value: to(s.value), stale: s.stale }, this.retry)
      : new Load<U>(minted, s, this.retry)
  }
}

// What a `Load` holds, for the component that draws it.
export type LoadView<T> = State<T>

export type LoadReader = <T>(load: Load<T>) => LoadView<T>

const read: LoadReader = <T>(load: Load<T>) => states.get(load) as State<T>

let claimed = false

// The reader of loads, handed out once: to the component that draws them. A second caller in a
// built app is an error.
export const claimLoadReader = (): LoadReader => {
  if (claimed && process.env.NODE_ENV === 'production')
    throw new Error('loads are read by one component')
  claimed = true
  return read
}

// What a source may say a load is.
export interface LoadMaker<T> {
  loading(): Load<T>
  ready(value: T): Load<T>
  empty(): Load<T>
  failed(error: unknown): Load<T>
  waiting(why: Waiting): Load<T>
}

export interface LoadSource<T> extends Live<Load<T>> {
  retry(): void
  // Asks again and keeps what is on screen meanwhile. A refusal then sits beside the kept value.
  refresh(): void
  // Replaces a value that is here with what the person just made of it.
  change(to: (value: T) => T): void
}

export interface RequestOptions<T> {
  // Whether what came back counts as nothing to show.
  empty?: (value: T) => boolean
  deadlineMs?: number
  // How long to wait before asking, for what a person is still typing.
  delayMs?: number
  // Asks again this often while watched, keeping the value on screen.
  everyMs?: number
}

// A value that one request fetches. The request starts when the load is first watched and is
// stopped when nobody watches it; a value that arrived is kept. `retry` asks again, after the
// wait a refusal asked for when it gave one.
export function fromRequest<T>(
  time: Time,
  run: (signal: AbortSignal) => Promise<T>,
  { empty, deadlineMs = LOAD_DEADLINE_MS, delayMs = 0, everyMs }: RequestOptions<T> = {}
): LoadSource<T> {
  const listeners = new Set<() => void>()
  let abort: AbortController | null = null
  let wake: Cancel | null = null
  let poll: Cancel | null = null
  let turn = 0
  let running = false
  let held: { value: T } | null = null
  const loading = (): State<T> => ({
    status: 'loading',
    overdueAt: time.elapsed() + delayMs + deadlineMs,
  })
  const set = (state: State<T>) => {
    current = new Load<T>(minted, state, retry)
    for (const l of [...listeners]) l()
  }
  const arrived = (value: T) => {
    held = { value }
    set(empty?.(value) ? { status: 'empty' } : { status: 'ready', value, stale: null })
  }
  const halt = () => {
    turn++
    running = false
    abort?.abort()
    abort = null
    wake?.()
    wake = null
  }
  const ask = (keep: boolean) => {
    const id = turn
    const mine = (abort = new AbortController())
    run(mine.signal).then(
      value => {
        if (id !== turn) return
        running = false
        arrived(value)
      },
      (error: unknown) => {
        if (id !== turn) return
        running = false
        const refusal = refusalOf(error)
        if (keep && held && !empty?.(held.value))
          return set({ status: 'ready', value: held.value, stale: refusal })
        set({
          status: 'failed',
          refusal,
          retryAt: refusal.retryAfter === null ? null : time.elapsed() + refusal.retryAfter * 1000,
        })
      }
    )
  }
  const start = (quiet = false) => {
    halt()
    const id = turn
    running = true
    if (quiet) current = new Load<T>(minted, loading(), retry)
    else set(loading())
    if (delayMs <= 0) return ask(false)
    wake = time.after(delayMs, () => {
      wake = null
      if (id === turn) ask(false)
    })
  }
  function retry() {
    const s = read(current)
    const wait = s.status === 'failed' && s.retryAt !== null ? s.retryAt - time.elapsed() : 0
    if (wait <= 0) return start()
    wake?.()
    wake = time.after(wait, () => start())
  }
  const refresh = () => {
    const settled = current.status === 'ready' || current.status === 'empty'
    if (listeners.size === 0) {
      if (settled) current = new Load<T>(minted, loading(), retry)
      return
    }
    if (!settled || !held) return start()
    halt()
    running = true
    ask(true)
  }
  let current = new Load<T>(minted, loading(), retry)
  return {
    get: () => current,
    subscribe: changed => {
      listeners.add(changed)
      const settled = current.status === 'ready' || current.status === 'empty'
      if (listeners.size === 1) {
        if (!running && !settled) start(true)
        if (everyMs !== undefined) poll = time.every(everyMs, refresh)
      }
      return () => {
        listeners.delete(changed)
        if (listeners.size > 0) return
        halt()
        poll?.()
        poll = null
      }
    },
    retry,
    refresh,
    change: to => {
      const settled = current.status === 'ready' || current.status === 'empty'
      if (settled && held) arrived(to(held.value))
    },
  }
}

export interface Page<T> {
  items: T[]
  next: string | null
}

// A list that arrives a page at a time.
export interface Pages<T> {
  items: T[]
  // Asks for the next page. Null when there is none, or while one is on its way.
  more: (() => void) | null
  loadingMore: boolean
  // Why the next page did not come; `more` asks for it again.
  refusal: Refusal | null
}

export interface PagesOptions {
  deadlineMs?: number
  delayMs?: number
  // False where a list with no rows still draws (a form that adds the first one).
  showEmpty?: boolean
}

export interface PagesSource<T> extends Live<Load<Pages<T>>> {
  retry(): void
  refresh(): void
  // Replaces the rows that are here with what the person just made of them.
  change(to: (items: T[]) => T[]): void
}

// A list one request per page fetches. The first page is the load; later pages join the value,
// and a page that is refused leaves the rows in place with the refusal beside them.
export function fromPages<T>(
  time: Time,
  run: (cursor: string | null, signal: AbortSignal) => Promise<Page<T>>,
  keyOf: (item: T) => Key,
  { showEmpty = true, ...options }: PagesOptions = {}
): PagesSource<T> {
  let stop: AbortController | null = null
  const view = (
    items: T[],
    next: string | null,
    loadingMore: boolean,
    refusal: Refusal | null
  ): Pages<T> => ({
    items,
    more: next === null || loadingMore ? null : () => more(next),
    loadingMore,
    refusal,
  })
  const first = fromRequest<Pages<T>>(
    time,
    signal => {
      stop?.abort()
      stop = null
      return run(null, signal).then(page => view(page.items, page.next, false, null))
    },
    {
      ...options,
      empty: pages =>
        showEmpty && pages.items.length === 0 && pages.more === null && !pages.loadingMore,
    }
  )
  const more = (cursor: string) => {
    const mine = (stop = new AbortController())
    first.change(v => view(v.items, cursor, true, null))
    run(cursor, mine.signal).then(
      page => {
        if (mine.signal.aborted) return
        first.change(v => view(appendUnique(v.items, page.items, keyOf), page.next, false, null))
      },
      (error: unknown) => {
        if (mine.signal.aborted) return
        first.change(v => view(v.items, cursor, false, refusalOf(error)))
      }
    )
  }
  return {
    get: first.get,
    subscribe: first.subscribe,
    retry: first.retry,
    refresh: first.refresh,
    change: to => first.change(v => ({ ...v, items: to(v.items) })),
  }
}

interface Watched<S> {
  getState: () => S
  subscribe: (changed: () => void) => () => void
  getInitialState?: () => S
}

// A value a store holds (an account's store, or a P2P identity's): `select` says which state it
// is in. `retry` asks the store to load it again, where it can.
export function fromStore<S, T>(
  time: Time,
  store: Watched<S>,
  select: (state: S, make: LoadMaker<T>) => Load<T>,
  retry: (() => void) | null = null,
  deadlineMs = LOAD_DEADLINE_MS
): Live<Load<T>> {
  let since: number | null = null
  const make = (from: 'now' | 'first'): LoadMaker<T> => ({
    loading: () => {
      if (from === 'now' && since === null) since = time.elapsed()
      const at = from === 'now' ? (since as number) : time.elapsed()
      return new Load<T>(minted, { status: 'loading', overdueAt: at + deadlineMs }, retry)
    },
    ready: value => new Load<T>(minted, { status: 'ready', value, stale: null }, retry),
    empty: () => new Load<T>(minted, { status: 'empty' }, retry),
    failed: error =>
      new Load<T>(minted, { status: 'failed', refusal: refusalOf(error), retryAt: null }, retry),
    waiting: why => new Load<T>(minted, { status: 'waiting', why }, retry),
  })
  const same = (a: Load<T>, b: Load<T>) => {
    const x = read(a)
    const y = read(b)
    if (x.status !== y.status) return false
    if (x.status === 'ready' && y.status === 'ready') return Object.is(x.value, y.value)
    if (x.status === 'loading' && y.status === 'loading') return x.overdueAt === y.overdueAt
    if (x.status === 'failed' && y.status === 'failed')
      return x.refusal.kind === y.refusal.kind && x.refusal.message === y.refusal.message
    if (x.status === 'waiting' && y.status === 'waiting') return x.why === y.why
    return true
  }
  const kept = (pick: () => Load<T>) => {
    let held: Load<T> | null = null
    return () => {
      const next = pick()
      if (held === null || !same(held, next)) held = next
      return held
    }
  }
  const now = make('now')
  return {
    get: kept(() => {
      const load = select(store.getState(), now)
      if (load.status !== 'loading') since = null
      return load
    }),
    subscribe: changed => store.subscribe(changed),
    ...(store.getInitialState
      ? { initial: kept(() => select(store.getInitialState!(), make('first'))) }
      : {}),
  }
}

// The same over a live value (what a place feature hands out).
export const fromLive = <S, T>(
  time: Time,
  live: Live<S>,
  select: (state: S, make: LoadMaker<T>) => Load<T>,
  retry: (() => void) | null = null
): Live<Load<T>> =>
  fromStore(
    time,
    {
      getState: live.get,
      subscribe: live.subscribe,
      ...(live.initial ? { getInitialState: live.initial } : {}),
    },
    select,
    retry
  )

// Whether a loading load passed its deadline at `elapsed`, and how long until it does.
export const overdueIn = (overdueAt: number, elapsed: number): number =>
  Math.max(0, overdueAt - elapsed)

// Seconds left before a refused load may be asked again.
export const retryIn = (retryAt: number | null, elapsed: number): number =>
  retryAt === null ? 0 : Math.max(0, Math.ceil((retryAt - elapsed) / 1000))
