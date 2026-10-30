'use client'

import { useStore } from '../lib/store'
import { typerNames, typingParts } from '../lib/typing'
import { Masked } from './ui'

const DELAYS = ['0ms', '150ms', '300ms']

// One thin line over the bottom edge of the message list, so it never moves the list.
export function TypingIndicator({ scope, bg }: { scope: string | null; bg: string }) {
  const on = useStore(s => s.typingOn)
  const here = useStore(s => (scope ? s.typing[scope] : undefined))
  const parts = on ? typingParts(typerNames(here)) : []
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
