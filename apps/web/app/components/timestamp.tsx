'use client'

import { useEffect, useSyncExternalStore } from 'react'
import { Clock } from 'lucide-react'
import { sharing } from '../lib/platform'
import { useStore } from '../lib/store'
import { daySnapshot, snapshot, subscribe, subscribeDay, track } from '../lib/stamp_clock'
import { formatStamp, fullTime, messageTime, type StampStyle } from '../lib/timestamps'
import { longPress } from './context_menu'

function useLiveNow(target: number | null) {
  useEffect(() => (target === null ? undefined : track(target)), [target])
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}

export function Stamp({ ms, style, token }: { ms: number; style: StampStyle; token: string }) {
  const clock = useLiveNow(style === 'R' ? ms : null)
  const full = fullTime(ms)
  const text = formatStamp(ms, style, style === 'R' ? clock : Date.now())
  return (
    <time
      {...longPress((x, y) =>
        useStore.getState().openContextMenu(
          x,
          y,
          [
            {
              label: 'Copy Timestamp',
              icon: Clock,
              action: () => void sharing().copyText(token),
            },
          ],
          { header: <span className="text-sm text-on-surface">{full}</span> }
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

// A message's own time, with the full date and time on hover.
export function MessageTime({ ts, className }: { ts: number; className?: string }) {
  const ms = ts * 1000
  useSyncExternalStore(subscribeDay, daySnapshot, daySnapshot)
  return (
    <time dateTime={new Date(ms).toISOString()} title={fullTime(ms)} className={className}>
      {messageTime(ms, Date.now())}
    </time>
  )
}
