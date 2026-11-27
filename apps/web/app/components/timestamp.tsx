'use client'
import { useAccount } from '../lib/client/react'

import { useEffect, useSyncExternalStore } from 'react'
import { openActionMenu } from '../lib/actions/menu'
import { daySnapshot, snapshot, subscribe, subscribeDay, track } from '../lib/stamp_clock'
import { formatStamp, fullTime, messageTime, type StampStyle } from '../lib/timestamps'
import { longPress } from './context_menu'
import { time } from '../lib/platform/time'

// The shared clock's time, ticking while `target` (milliseconds) is set: each second within a
// minute of it, else each minute.
export function useLiveNow(target: number | null) {
  useEffect(() => (target === null ? undefined : track(target)), [target])
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}

export function Stamp({ ms, style, token }: { ms: number; style: StampStyle; token: string }) {
  const acct = useAccount()

  const clock = useLiveNow(style === 'R' ? ms : null)
  const full = fullTime(ms)
  const text = formatStamp(ms, style, style === 'R' ? clock : acct.time.now())
  return (
    <time
      {...longPress((x, y) =>
        openActionMenu(
          x,
          y,
          { kind: 'timestamp', ts: ms, token },
          { header: <span className="text-sm text-on-surface">{full}</span> },
          acct
        )
      )}
      data-stamp={style}
      dateTime={new Date(ms).toISOString()}
      title={full}
      className="rounded box-decoration-clone bg-surface-container-high px-1 py-0.5 text-on-surface"
    >
      {text}
    </time>
  )
}

// Hours and minutes alone, with the full date and time on hover: a grouped message's gutter.
export function ShortTime({ ts, className }: { ts: number; className?: string }) {
  const ms = ts * 1000
  return (
    <time dateTime={new Date(ms).toISOString()} title={fullTime(ms)} className={className}>
      {formatStamp(ms, 't', ms)}
    </time>
  )
}

// A message's own time, with the full date and time on hover.
export function MessageTime({ ts, className }: { ts: number; className?: string }) {
  const ms = ts * 1000
  useSyncExternalStore(subscribeDay, daySnapshot, daySnapshot)
  return (
    <time dateTime={new Date(ms).toISOString()} title={fullTime(ms)} className={className}>
      {messageTime(ms, time().now())}
    </time>
  )
}
