'use client'

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { Refusal } from '../lib/api_errors'
import {
  claimLoadReader,
  fromRequest,
  overdueIn,
  retryIn,
  type Load,
  type RequestOptions,
  type Waiting,
} from '../lib/load'
import type { Live } from '../lib/place/live'
import { useLive } from '../lib/place/react'
import { time } from '../lib/platform/time'
import { Button } from './controls'
import { Stack } from './layout'
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

// Milliseconds on the app's clock, read again when `at` passes (and each second until then when
// `ticking`).
function useElapsed(at: number | null, ticking = false) {
  const [now, setNow] = useState(() => time().elapsed())
  useEffect(() => {
    if (at === null) return
    const clock = time()
    const left = at - clock.elapsed()
    if (left <= 0) {
      setNow(clock.elapsed())
      return
    }
    const step = ticking ? Math.min(1000, left) : left
    return clock.after(step, () => setNow(clock.elapsed()))
  }, [at, ticking, now])
  return now
}

const WAITING: Record<Waiting, string> = {
  offline: 'You are offline. This loads when you are back online.',
  reconnecting: 'Reconnecting. This loads once you are connected.',
  no_peer: 'Nobody who has this is online right now.',
}

// A line in place of what did not load, with a way to ask again.
function LoadLine({
  line,
  alert = false,
  retry,
  wait = 0,
}: {
  line: string
  alert?: boolean
  retry: (() => void) | null
  wait?: number
}) {
  return (
    <Stack gap="sm" align="start" role={alert ? 'alert' : 'status'} data-load-line>
      <p className="text-sm text-on-surface-variant">{line}</p>
      {retry && (
        <Button variant="text" disabled={wait > 0} onClick={retry}>
          {wait > 0 ? `Try again in ${wait} s` : 'Try again'}
        </Button>
      )}
    </Stack>
  )
}

function Failed({
  refusal,
  retryAt,
  retry,
  what,
}: {
  refusal: Refusal
  retryAt: number | null
  retry: (() => void) | null
  what: string
}) {
  const now = useElapsed(retryAt, true)
  return (
    <LoadLine
      alert
      line={`Could not load ${what}. ${refusal.message}`}
      retry={retry}
      wait={retryIn(retryAt, now)}
    />
  )
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
    return <Held>{skeleton ?? <RowsSkeleton rows={3} label={`Loading ${what}`} />}</Held>
  return <LoadLine line={`Still loading ${what}.`} retry={retry} />
}

// Draws what a load holds: `children` with the value once it is here, and every other state
// itself. While loading it shows `skeleton` (rows by default), and past the deadline a line with
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
      return <Failed refusal={view.refusal} retryAt={view.retryAt} retry={load.retry} what={what} />
    case 'waiting':
      return <LoadLine line={WAITING[view.why]} retry={load.retry} />
  }
}
