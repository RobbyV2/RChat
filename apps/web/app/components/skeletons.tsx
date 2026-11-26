'use client'

import { useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import { useMotionPlays } from '../lib/motion/use_motion'
import {
  channelShapes,
  dmShapes,
  memberShapes,
  messageShapes,
  railShapes,
  rowShapes,
} from '../lib/skeletons'

const strong = 'bg-on-surface/10'
const soft = 'bg-on-surface/7'

function Blob({ className, style }: { className: string; style?: CSSProperties }) {
  return <span data-blob aria-hidden className={`block ${className}`} style={style} />
}

const pct = (n: number): CSSProperties => ({ width: `${n}%` })

// A placeholder's frame: a busy status with its label. A sheen sweeps the blobs while animations
// play; otherwise they stand still.
function Frame({
  kind,
  label,
  className = '',
  children,
}: {
  kind: string
  label: string
  className?: string
  children: ReactNode
}) {
  const moves = useMotionPlays()
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label={label}
      data-skeleton={kind}
      data-shimmer={moves ? '' : undefined}
      className={`pointer-events-none select-none ${className}`}
    >
      {children}
    </div>
  )
}

// Keeps its children hidden for their first `ms`, so a load that ends sooner shows nothing.
export function Held({ ms = 250, children }: { ms?: number; children: ReactNode }) {
  const [shown, setShown] = useState(false)
  useEffect(() => {
    const t = setTimeout(() => setShown(true), ms)
    return () => clearTimeout(t)
  }, [ms])
  return (
    <div hidden={!shown} className="contents">
      {children}
    </div>
  )
}

// Message groups in place of a list that is loading: `pane` fills a chat from the bottom with
// 36 px avatars, `panel` (a thread) and `search` start at the top with 30 px ones, and search
// hits have no cards.
export function MessageListSkeleton({
  seed,
  variant = 'pane',
  label = 'Loading messages',
  className = '',
}: {
  seed: string
  variant?: 'pane' | 'panel' | 'search'
  label?: string
  className?: string
}) {
  const avatar = variant === 'pane' ? 'size-9' : 'size-7.5'
  return (
    <Frame
      kind="messages"
      label={label}
      className={`flex flex-col gap-4 overflow-hidden py-3 ${variant === 'pane' ? 'justify-end' : 'justify-start'} ${className}`}
    >
      {messageShapes(seed, variant !== 'search').map((m, i) => (
        <div key={i} className="flex shrink-0 gap-3 px-4">
          <Blob className={`${avatar} shrink-0 rounded-full ${strong}`} />
          <div className="flex min-w-0 flex-1 flex-col gap-2 pt-0.5">
            <div className="flex h-4 min-w-0 items-center gap-2">
              <Blob
                className={`h-3 max-w-[50%] rounded-full ${strong}`}
                style={{ width: m.name }}
              />
              <Blob className={`h-2.5 shrink-0 rounded-full ${soft}`} style={{ width: m.time }} />
            </div>
            {m.lines.map((w, j) => (
              <Blob key={j} className={`h-3 rounded-full ${strong}`} style={pct(w)} />
            ))}
            {m.media && (
              <Blob
                className={`mt-0.5 max-w-full rounded-xl ${soft}`}
                style={{ width: m.media.w, height: m.media.h }}
              />
            )}
          </div>
        </div>
      ))}
    </Frame>
  )
}

// Member sections in place of a member list that is loading.
export function MemberListSkeleton({ seed, className = '' }: { seed: string; className?: string }) {
  return (
    <Frame kind="members" label="Loading members" className={`flex flex-col ${className}`}>
      {memberShapes(seed).map((rows, i) => (
        <div key={i} className="flex flex-col">
          <div className="flex h-8 items-end px-2 pb-1.5">
            <Blob className={`h-2.5 w-20 rounded-full ${soft}`} />
          </div>
          {rows.map((m, j) => (
            <div key={j} className="flex h-10 items-center gap-2 px-2">
              <Blob className={`size-8 shrink-0 rounded-full ${strong}`} />
              <span className="flex min-w-0 flex-1">
                <Blob className={`h-3 rounded-full ${strong}`} style={pct(m.name)} />
              </span>
              {m.pill !== null && (
                <Blob className={`h-4 shrink-0 rounded-full ${soft}`} style={{ width: m.pill }} />
              )}
            </div>
          ))}
        </div>
      ))}
    </Frame>
  )
}

// Categories and channels in place of a server's channel list that is loading; `header` adds
// the server name bar above them.
export function ChannelListSkeleton({
  seed,
  header = false,
  className = '',
}: {
  seed: string
  header?: boolean
  className?: string
}) {
  return (
    <Frame kind="channels" label="Loading channels" className={`flex flex-col ${className}`}>
      {header && (
        <div className="flex h-14 shrink-0 items-center border-b border-outline-variant px-4">
          <Blob className={`h-3.5 w-28 rounded-full ${strong}`} />
        </div>
      )}
      <div className="flex min-h-0 flex-col overflow-hidden pb-3">
        {channelShapes(seed).map((g, i) => (
          <div key={i} className="flex flex-col pt-3">
            {g.header && (
              <div className="flex h-6 items-center px-4">
                <Blob className={`h-2.5 w-24 rounded-full ${soft}`} />
              </div>
            )}
            {g.rows.map((w, j) => (
              <div key={j} className="mx-2 flex h-8 items-center gap-2 px-2">
                <Blob className={`size-4 shrink-0 rounded ${soft}`} />
                <span className="flex min-w-0 flex-1">
                  <Blob className={`h-3 rounded-full ${strong}`} style={pct(w)} />
                </span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </Frame>
  )
}

// Conversation rows in place of a DM or contact list that is loading.
export function DmListSkeleton({
  seed,
  rows,
  label = 'Loading conversations',
  className = '',
}: {
  seed: string
  rows?: number
  label?: string
  className?: string
}) {
  return (
    <Frame kind="dms" label={label} className={`flex flex-col ${className}`}>
      {dmShapes(seed, rows).map((d, i) => (
        <div key={i} className="flex h-12 shrink-0 items-center gap-3 px-2">
          <Blob className={`size-8 shrink-0 rounded-full ${strong}`} />
          <span className="flex min-w-0 flex-1 flex-col gap-1.5">
            <Blob className={`h-3 rounded-full ${strong}`} style={pct(d.name)} />
            {d.preview !== null && (
              <Blob className={`h-2.5 rounded-full ${soft}`} style={pct(d.preview)} />
            )}
          </span>
        </div>
      ))}
    </Frame>
  )
}

// Server tiles in place of a rail list that is loading (`few`: 2 or 3).
export function ServerRailSkeleton({ seed, few = false }: { seed: string; few?: boolean }) {
  return (
    <Frame
      kind="servers"
      label="Loading servers"
      className="flex shrink-0 flex-col items-center gap-2"
    >
      {railShapes(seed, few).map((t, i) => (
        <Blob
          key={i}
          className={`size-12 shrink-0 ${t.round ? 'rounded-full' : 'rounded-2xl'} ${strong}`}
        />
      ))}
    </Frame>
  )
}

// Rows of an avatar, a title and a line, for the sections of Home, Friends and the inbox.
export function RowsSkeleton({ rows, label }: { rows: number; label: string }) {
  return (
    <Frame kind="rows" label={label} className="flex flex-col gap-1">
      {rowShapes(label, rows).map((r, i) => (
        <div key={i} className="flex items-center gap-3 px-2 py-2">
          <Blob className={`size-8 shrink-0 rounded-full ${strong}`} />
          <span className="flex min-w-0 flex-1 flex-col gap-1.5">
            <Blob className={`h-3 rounded-full ${strong}`} style={pct(r.title)} />
            <Blob className={`h-2.5 rounded-full ${soft}`} style={pct(r.line)} />
          </span>
        </div>
      ))}
    </Frame>
  )
}
