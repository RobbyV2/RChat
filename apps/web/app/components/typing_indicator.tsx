'use client'

import { useShallow } from 'zustand/react/shallow'
import { shownTypers } from '../lib/server_profile'
import { useStore } from '../lib/store'
import { typingParts } from '../lib/typing'
import { useLooksFor } from './shown_user'
import { Masked } from './ui'

const NONE: string[] = []

const DELAYS = ['0ms', '150ms', '300ms']

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
      <span className="flex shrink-0 items-center gap-0.5" aria-hidden>
        {DELAYS.map(d => (
          <span
            key={d}
            style={{ animationDelay: d }}
            className="size-1 animate-typing-dot rounded-full bg-current opacity-70 motion-reduce:animate-none"
          />
        ))}
      </span>
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
