'use client'

import { memo } from 'react'
import { formatDateBanner, localDayKey } from '../lib/date_dividers'

// The line above the first message of a calendar day, with the full date.
export const DateDivider = memo(function DateDivider({ at }: { at: number }) {
  const ms = at * 1000
  const day = localDayKey(ms)
  const label = formatDateBanner(ms)
  return (
    <div
      role="separator"
      aria-label={label}
      data-date-divider={day}
      className="my-3 flex items-center gap-3 px-4 select-none"
    >
      <div className="h-px flex-1 bg-outline-variant/60" />
      <time dateTime={day} className="shrink-0 text-xs font-medium text-on-surface-variant">
        {label}
      </time>
      <div className="h-px flex-1 bg-outline-variant/60" />
    </div>
  )
})
