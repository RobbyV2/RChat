'use client'

import { BellOff } from 'lucide-react'
import { scopeMuted, useStore } from '../lib/store'
import { muteEnd, mutedText, parentScope, untilText, type NotifyScope } from '../lib/notify'
import { time } from '../lib/platform/time'

// The muted marker on rows and tiles; the tooltip says until when.
export function MutedIcon({
  scope,
  size = 14,
  className = '',
}: {
  scope: NotifyScope
  size?: number
  className?: string
}) {
  const muted = useStore(s => scopeMuted(s, scope))
  const title = useStore(s => {
    const now = time().now()
    const own = muteEnd(s.notifyPrefs, scope, now)
    if (own !== null) return mutedText(own, now)
    const parent = parentScope(scope)
    if (!parent) return 'Muted'
    const server = muteEnd(s.notifyPrefs, parent, now)
    return server !== null ? `Server muted ${untilText(server, now)}` : 'Muted'
  })
  if (!muted) return null
  return (
    <span title={title} aria-label={title} role="img" className={`flex shrink-0 ${className}`}>
      <BellOff size={size} aria-hidden />
    </span>
  )
}
