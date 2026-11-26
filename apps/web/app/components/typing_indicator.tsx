'use client'

import { memo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useMotionPlays } from '../lib/motion/use_motion'
import { shownTypers } from '../lib/server_profile'
import { useMask, useStore } from '../lib/store'
import { rowTypers } from '../lib/typing_rows'
import { typingParts, typingTitle } from '../lib/typing'
import { useLooksFor } from './shown_user'
import { Masked } from './ui'
import { PingBadge } from './ping_badge'

const NONE: string[] = []

const DELAYS = ['0ms', '150ms', '300ms']

// Three dots that bounce while animations play and stand still otherwise.
function Dots({ still }: { still: string }) {
  const moves = useMotionPlays()
  return (
    <span className="flex shrink-0 items-center gap-0.5" aria-hidden>
      {DELAYS.map(d => (
        <span
          key={d}
          style={moves ? { animationDelay: d } : undefined}
          className={`size-1 rounded-full bg-current ${moves ? 'animate-typing-dot' : still}`}
        />
      ))}
    </span>
  )
}

// The dots of a channel or DM row while someone types there; their names are its label.
export const TypingEllipsis = memo(function TypingEllipsis({
  names,
}: {
  names: readonly string[]
}) {
  const streamer = useStore(s => s.streamer)
  const mask = useMask()
  const title = typingTitle(
    names.map(n => mask(n)),
    streamer
  )
  return (
    <span
      role="img"
      aria-label={title}
      title={title}
      data-typing-dots
      className="flex shrink-0 items-center"
    >
      <Dots still="opacity-80" />
    </span>
  )
})

// The right end of a channel row: typing dots in place of the unread dot (and before a ping
// count), else the ping count or the unread dot.
export function ChannelEnd({
  typers,
  pings,
  unread,
}: {
  typers: readonly string[]
  pings: number
  unread: boolean
}) {
  if (typers.length)
    return (
      <span className="ml-auto flex shrink-0 items-center gap-1.5">
        <TypingEllipsis names={typers} />
        <PingBadge count={pings} />
      </span>
    )
  if (pings > 0) return <PingBadge count={pings} className="ml-auto" />
  return unread ? (
    <span title="Unread" aria-hidden className="ml-auto h-2 w-2 shrink-0 rounded-full bg-error" />
  ) : null
}

// Who is typing in any of `scopes` of a hosted `server` (null for DMs), under the names the
// server shows (looking up the ones not loaded yet); nothing while typing indicators are off.
export function useHostedTypers(scopes: readonly string[], server: string | null) {
  const names = useStore(useShallow(s => rowTypers(s, scopes, server).names))
  const ask = useStore(useShallow(s => rowTypers(s, scopes, server).ask))
  useLooksFor(server, ask)
  return names
}

// One thin line over the bottom edge of the message list, so it never moves the list.
// `names` replaces the store's typers (a P2P conversation tracks its own). In a channel of
// `server` each typer shows under the name the server shows; one whose member row isn't loaded
// shows under the account name and is looked up once.
export function TypingIndicator({
  scope,
  bg,
  names,
  server = null,
}: {
  scope: string | null
  bg: string
  names?: string[]
  server?: string | null
}) {
  const on = useStore(s => s.typingOn)
  const typers = useStore(
    useShallow(s =>
      names || !scope || !s.typingOn
        ? NONE
        : shownTypers(s, server, s.typing[scope], s.blocked).names
    )
  )
  const ask = useStore(
    useShallow(s =>
      names || !scope || !s.typingOn ? NONE : shownTypers(s, server, s.typing[scope], s.blocked).ask
    )
  )
  useLooksFor(server, ask)
  const parts = on ? typingParts(names ?? typers) : []
  if (!parts.length) return null
  return (
    <div
      data-typing
      className={`pointer-events-none absolute inset-x-0 bottom-full flex h-4 items-center gap-1.5 px-4 text-xs leading-4 text-on-surface-variant ${bg}`}
    >
      <Dots still="opacity-70" />
      <span aria-live="polite" className="min-w-0 truncate">
        {parts.map((p, i) =>
          p.name ? (
            <span key={i} className="streamer font-semibold text-on-surface">
              <Masked text={p.text} />
            </span>
          ) : (
            <span key={i}>{p.text}</span>
          )
        )}
      </span>
    </div>
  )
}
