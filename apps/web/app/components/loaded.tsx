'use client'

import { useMemo, type ReactNode } from 'react'
import {
  claimLoadReader,
  fromRequest,
  overdueIn,
  type Load,
  type RequestOptions,
} from '../lib/load'
import type { Live } from '../lib/place/live'
import { useLive } from '../lib/place/react'
import { time } from '../lib/platform/time'
import { ConnectionNotice, ErrorNotice, Notice, useElapsed } from './notices'
import { Held, RowsSkeleton } from './skeletons'

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

function Loading({
  overdueAt,
  retry,
  skeleton,
  what,
}: {
  overdueAt: number
  retry: (() => void) | null
  skeleton: ReactNode
  what: string
}) {
  const now = useElapsed(overdueAt)
  if (overdueIn(overdueAt, now) > 0)
    return skeleton === null ? null : (
      <Held>{skeleton ?? <RowsSkeleton rows={3} label={`Loading ${what}`} />}</Held>
    )
  return <Notice line={`Still loading ${what}.`} icon="none" retry={retry} />
}

// Draws what a load holds: `children` with the value once it is here, and every other state
// itself. While loading it shows `skeleton` (rows by default, nothing for null), and past the deadline a line with
// a way to ask again. `empty` is the line for nothing to show; `what` names the thing in the
// lines ("pins", "the member list").
export function Loaded<T>({
  load,
  skeleton,
  empty = 'Nothing here yet.',
  what = 'this',
  children,
}: {
  load: Load<T>
  skeleton?: ReactNode
  empty?: ReactNode
  what?: string
  children: (value: T) => ReactNode
}) {
  const view = read(load)
  switch (view.status) {
    case 'ready':
      return <>{children(view.value)}</>
    case 'loading':
      return (
        <Loading overdueAt={view.overdueAt} retry={load.retry} skeleton={skeleton} what={what} />
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
