'use client'

import { useEffect, useMemo, type ReactNode } from 'react'
import {
  claimLoadReader,
  fromPages,
  fromRequest,
  overdueIn,
  type Load,
  type LoadSource,
  type Page,
  type Pages,
  type PagesOptions,
  type PagesSource,
  type RequestOptions,
} from '../lib/load'
import type { Key } from '../lib/lists'
import { useAccount } from '../lib/client/react'
import type { AccountSession } from '../lib/client/session'
import type { Live } from '../lib/place/live'
import { useLive } from '../lib/place/react'
import { time } from '../lib/platform/time'
import { Button } from './controls'
import { ConnectionNotice, ErrorNotice, Notice, useElapsed } from './notices'
import { Held, RowsSkeleton } from './skeletons'
import { Sentinel } from './ui'

const read = claimLoadReader()

// A load as it is now.
export const useLoad = <T,>(live: Live<Load<T>>): Load<T> => useLive(live)

// What one request fetches, asked for while this component is on screen and again when `deps`
// change.
export function useRequest<T>(
  run: (signal: AbortSignal) => Promise<T>,
  deps: readonly unknown[],
  options?: RequestOptions<T>
): Load<T> {
  const source = useMemo(() => fromRequest(time(), run, options), deps)
  return useLive(source)
}

// The same with its source, for a screen that asks again (`refresh`) or changes what it holds
// (`change`) after the person acts.
export function useSource<T>(
  run: (signal: AbortSignal) => Promise<T>,
  deps: readonly unknown[],
  options?: RequestOptions<T>
): [Load<T>, LoadSource<T>] {
  const source = useMemo(() => fromRequest(time(), run, options), deps)
  return [useLive(source), source]
}

const never = new Promise<never>(() => {})
const NO_EVENTS: readonly string[] = []

// `run` against the account's instance. An answer that arrives after the account's session
// changed never shows.
function useInSession<A extends unknown[], T>(
  run: (api: AccountSession['api'], ...args: A) => Promise<T>
): [(...args: A) => Promise<T>, AccountSession, unknown] {
  const account = useAccount()
  const mark = account.lifetime.sessionMark()
  const current = <V,>(value: V) => (mark === account.lifetime.sessionMark() ? value : never)
  return [
    (...args) =>
      run(account.api, ...args).then(current, (error: unknown) =>
        Promise.resolve(current(null)).then(() => Promise.reject(error))
      ),
    account,
    mark,
  ]
}

// What one request to the account's instance fetches, asked again when the account, its session
// or `deps` change.
export function useAccountRequest<T>(
  run: (api: AccountSession['api'], signal: AbortSignal) => Promise<T>,
  deps: readonly unknown[],
  options?: RequestOptions<T>
): Load<T> {
  const [guarded, account, mark] = useInSession(run)
  return useRequest(guarded, [account, mark, ...deps], options)
}

export function useAccountSource<T>(
  run: (api: AccountSession['api'], signal: AbortSignal) => Promise<T>,
  deps: readonly unknown[],
  options?: RequestOptions<T>
): [Load<T>, LoadSource<T>] {
  const [guarded, account, mark] = useInSession(run)
  return useSource(guarded, [account, mark, ...deps], options)
}

// Asks `source` again on each of the window's `events`, and with `front` when the window comes
// back to the front.
export function useRefreshOn(
  source: { refresh(): void },
  { front = false, events = NO_EVENTS }: { front?: boolean; events?: readonly string[] }
) {
  useEffect(() => {
    const again = () => source.refresh()
    const shown = () => {
      if (document.visibilityState === 'visible') source.refresh()
    }
    for (const event of events) window.addEventListener(event, again)
    if (front) {
      window.addEventListener('focus', shown)
      document.addEventListener('visibilitychange', shown)
    }
    return () => {
      for (const event of events) window.removeEventListener(event, again)
      window.removeEventListener('focus', shown)
      document.removeEventListener('visibilitychange', shown)
    }
  }, [source, front, events])
}

// A list fetched a page at a time.
export function usePages<T>(
  run: (cursor: string | null, signal: AbortSignal) => Promise<Page<T>>,
  keyOf: (item: T) => Key,
  deps: readonly unknown[],
  options?: PagesOptions
): [Load<Pages<T>>, PagesSource<T>] {
  const source = useMemo(() => fromPages(time(), run, keyOf, options), deps)
  return [useLive(source), source]
}

function Loading({
  overdueAt,
  retry,
  skeleton,
  hold,
  what,
}: {
  overdueAt: number
  retry: (() => void) | null
  skeleton: ReactNode
  hold: boolean
  what: string
}) {
  const now = useElapsed(overdueAt)
  if (overdueIn(overdueAt, now) > 0) {
    if (skeleton === null) return null
    const drawn = skeleton ?? <RowsSkeleton rows={3} label={`Loading ${what}`} />
    return hold ? <Held>{drawn}</Held> : <>{drawn}</>
  }
  return <Notice line={`Still loading ${what}.`} icon="none" retry={retry} />
}

// A list of the account's instance, fetched a page at a time.
export function useAccountPages<T>(
  run: (api: AccountSession['api'], cursor: string | null, signal: AbortSignal) => Promise<Page<T>>,
  keyOf: (item: T) => Key,
  deps: readonly unknown[],
  options?: PagesOptions
): [Load<Pages<T>>, PagesSource<T>] {
  const [guarded, account, mark] = useInSession(run)
  return usePages(guarded, keyOf, [account, mark, ...deps], options)
}

// The way to the next page of a list: a button, or with `auto` a marker that asks once it
// scrolls into view. A page that was refused says so here, with a way to ask again.
export function More<T>({
  pages,
  auto = false,
  label = 'Show more',
}: {
  pages: Pages<T>
  auto?: boolean
  label?: string
}) {
  if (pages.refusal)
    return <ErrorNotice refusal={pages.refusal} lead="Could not load more." retry={pages.more} />
  if (pages.loadingMore)
    return (
      <Button disabled place="self-start">
        Loading
      </Button>
    )
  if (!pages.more) return null
  return auto ? (
    <Sentinel key={pages.items.length} onVisible={pages.more} />
  ) : (
    <Button onClick={pages.more} place="self-start">
      {label}
    </Button>
  )
}

// Draws what a load holds: `children` with the value once it is here, and every other state
// itself. While loading it shows `skeleton` (rows by default, nothing for null), and past the
// deadline a line with a way to ask again. The skeleton appears after a moment, or at once with
// `hold` false, for a thing whose room on screen is already taken. `empty` is the line for
// nothing to show; `what` names the thing in the lines ("pins", "the member list").
export function Loaded<T>({
  load,
  skeleton,
  hold = true,
  empty = 'Nothing here yet.',
  what = 'this',
  children,
}: {
  load: Load<T>
  skeleton?: ReactNode
  hold?: boolean
  empty?: ReactNode
  what?: string
  children: (value: T) => ReactNode
}) {
  const view = read(load)
  switch (view.status) {
    case 'ready':
      return (
        <>
          {view.stale && (
            <ErrorNotice
              refusal={view.stale}
              lead={`Could not refresh ${what}.`}
              retry={load.retry}
            />
          )}
          {children(view.value)}
        </>
      )
    case 'loading':
      return (
        <Loading
          overdueAt={view.overdueAt}
          retry={load.retry}
          skeleton={skeleton}
          hold={hold}
          what={what}
        />
      )
    case 'empty':
      return typeof empty === 'string' ? (
        <p data-load-empty className="text-sm text-on-surface-variant">
          {empty}
        </p>
      ) : (
        <>{empty}</>
      )
    case 'failed':
      return (
        <ErrorNotice
          refusal={view.refusal}
          lead={`Could not load ${what}.`}
          retry={load.retry}
          retryAt={view.retryAt}
        />
      )
    case 'waiting':
      return <ConnectionNotice why={view.why} retry={load.retry} />
  }
}

function Overdue({
  overdueAt,
  retry,
  what,
}: {
  overdueAt: number
  retry: (() => void) | null
  what: string
}) {
  const now = useElapsed(overdueAt)
  if (overdueIn(overdueAt, now) > 0) return null
  return <Notice line={`Still loading ${what}.`} icon="none" retry={retry} />
}

// For a screen that already knows something of the value (a kept copy, a row of a list): draws
// `children` at once with `known`, then with the value. `notice` is the line for every other
// state of the load (refused, waiting, overdue), which the screen places where the person looks;
// it draws nothing while there is nothing to say.
export function Refreshed<T>({
  load,
  known,
  what = 'this',
  children,
}: {
  load: Load<T>
  known: T
  what?: string
  children: (value: T, notice: ReactNode) => ReactNode
}) {
  const view = read(load)
  switch (view.status) {
    case 'ready':
      return (
        <>
          {children(
            view.value,
            view.stale && (
              <ErrorNotice
                refusal={view.stale}
                lead={`Could not refresh ${what}.`}
                retry={load.retry}
              />
            )
          )}
        </>
      )
    case 'loading':
      return (
        <>
          {children(known, <Overdue overdueAt={view.overdueAt} retry={load.retry} what={what} />)}
        </>
      )
    case 'empty':
      return <>{children(known, null)}</>
    case 'failed':
      return (
        <>
          {children(
            known,
            <ErrorNotice
              refusal={view.refusal}
              lead={`Could not load ${what}.`}
              retry={load.retry}
              retryAt={view.retryAt}
            />
          )}
        </>
      )
    case 'waiting':
      return <>{children(known, <ConnectionNotice why={view.why} retry={load.retry} />)}</>
  }
}
