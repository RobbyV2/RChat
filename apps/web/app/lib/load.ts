import { refusalOf, type Refusal } from './api_errors'
import type { Cancel, Time } from './clock'
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
  | { status: 'ready'; value: T }
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
      ? new Load<U>(minted, { status: 'ready', value: to(s.value) }, this.retry)
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
}

export interface RequestOptions<T> {
  // Whether what came back counts as nothing to show.
  empty?: (value: T) => boolean
  deadlineMs?: number
}

// A value that one request fetches. The request starts when the load is first watched and is
// stopped when nobody watches it; a value that arrived is kept. `retry` asks again, after the
// wait a refusal asked for when it gave one.
export function fromRequest<T>(
  time: Time,
  run: (signal: AbortSignal) => Promise<T>,
  { empty, deadlineMs = LOAD_DEADLINE_MS }: RequestOptions<T> = {}
): LoadSource<T> {
  const listeners = new Set<() => void>()
  let abort: AbortController | null = null
  let wake: Cancel | null = null
  let turn = 0
  let running = false
  const loading = (): State<T> => ({ status: 'loading', overdueAt: time.elapsed() + deadlineMs })
  const set = (state: State<T>) => {
    current = new Load<T>(minted, state, retry)
    for (const l of [...listeners]) l()
  }
  const halt = () => {
    turn++
    running = false
    abort?.abort()
    abort = null
    wake?.()
    wake = null
  }
  const start = (quiet = false) => {
    halt()
    const id = turn
    running = true
    const mine = (abort = new AbortController())
    if (quiet) current = new Load<T>(minted, loading(), retry)
    else set(loading())
    run(mine.signal).then(
      value => {
        if (id !== turn) return
        running = false
        set(empty?.(value) ? { status: 'empty' } : { status: 'ready', value })
      },
      (error: unknown) => {
        if (id !== turn) return
        running = false
        const refusal = refusalOf(error)
        set({
          status: 'failed',
          refusal,
          retryAt: refusal.retryAfter === null ? null : time.elapsed() + refusal.retryAfter * 1000,
        })
      }
    )
  }
  function retry() {
    const s = read(current)
    const wait = s.status === 'failed' && s.retryAt !== null ? s.retryAt - time.elapsed() : 0
    if (wait <= 0) return start()
    wake?.()
    wake = time.after(wait, () => start())
  }
  let current = new Load<T>(minted, loading(), retry)
  return {
    get: () => current,
    subscribe: changed => {
      listeners.add(changed)
      const settled = current.status === 'ready' || current.status === 'empty'
      if (listeners.size === 1 && !running && !settled) start(true)
      return () => {
        listeners.delete(changed)
        if (listeners.size === 0) halt()
      }
    },
    retry,
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
    ready: value => new Load<T>(minted, { status: 'ready', value }, retry),
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
