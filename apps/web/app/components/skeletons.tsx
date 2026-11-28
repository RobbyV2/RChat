'use client'

import { useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import { useMotionPlays } from '../lib/motion/use_motion'
import { Row, Stack, Surface, Inset } from './layout'
import {
  channelShapes,
  dmShapes,
  memberShapes,
  messageShapes,
  railShapes,
  rowShapes,
} from '../lib/skeletons'
import { time } from '../lib/platform/time'

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
    const t = time().after(ms, () => setShown(true))
    return () => t()
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
      className={`flex flex-col overflow-hidden ${variant === 'pane' ? 'justify-end' : 'justify-start'} ${className}`}
    >
      <Surface tone="plain" radius="none" pad="lg" inset="bar" gap="lg">
        {messageShapes(seed, variant !== 'search').map((m, i) => (
          <Row key={i} gap="md" align="stretch" place="shrink-0">
            <Blob className={`${avatar} shrink-0 rounded-full ${strong}`} />
            <Surface tone="plain" radius="none" pad="3xs" gap="sm" place="flex-1">
              <div className="flex h-4 min-w-0 items-center">
                <Row gap="sm" place="flex-1">
                  <Blob
                    className={`h-3 max-w-1/2 rounded-full ${strong}`}
                    style={{ width: m.name }}
                  />
                  <Blob
                    className={`h-2.5 shrink-0 rounded-full ${soft}`}
                    style={{ width: m.time }}
                  />
                </Row>
              </div>
              {m.lines.map((w, j) => (
                <Blob key={j} className={`h-3 rounded-full ${strong}`} style={pct(w)} />
              ))}
              {m.media && (
                <Blob
                  className={`max-w-full rounded-xl ${soft}`}
                  style={{ width: m.media.w, height: m.media.h }}
                />
              )}
            </Surface>
          </Row>
        ))}
      </Surface>
    </Frame>
  )
}

// Member sections in place of a member list that is loading.
export function MemberListSkeleton({ seed, className = '' }: { seed: string; className?: string }) {
  return (
    <Frame kind="members" label="Loading members" className={`flex flex-col ${className}`}>
      {memberShapes(seed).map((rows, i) => (
        <div key={i} className="flex flex-col">
          <Inset row pad="sm" inset="sides" look="h-8">
            <Blob className={`h-2.5 w-20 rounded-full ${soft}`} />
          </Inset>
          {rows.map((m, j) => (
            <Surface
              key={j}
              pad="sm"
              inset="sides"
              gap="sm"
              row
              tone="plain"
              radius="none"
              look="h-10"
            >
              <Blob className={`size-8 shrink-0 rounded-full ${strong}`} />
              <span className="flex min-w-0 flex-1">
                <Blob className={`h-3 rounded-full ${strong}`} style={pct(m.name)} />
              </span>
              {m.pill !== null && (
                <Blob className={`h-4 shrink-0 rounded-full ${soft}`} style={{ width: m.pill }} />
              )}
            </Surface>
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
        <Surface
          pad="lg"
          inset="sides"
          row
          tone="plain"
          radius="none"
          border="bottom"
          look="h-14"
          place="shrink-0"
        >
          <Blob className={`h-3.5 w-28 rounded-full ${strong}`} />
        </Surface>
      )}
      <Stack gap="md" place="min-h-0 overflow-hidden">
        {channelShapes(seed).map((g, i) => (
          <Stack key={i} gap="none">
            {g.header && (
              <Surface pad="lg" inset="sides" row tone="plain" radius="none" look="h-6">
                <Blob className={`h-2.5 w-24 rounded-full ${soft}`} />
              </Surface>
            )}
            {g.rows.map((w, j) => (
              <Inset key={j} row pad="lg" inset="sides" gap="sm" look="h-8">
                <Blob className={`size-4 shrink-0 rounded ${soft}`} />
                <span className="flex min-w-0 flex-1">
                  <Blob className={`h-3 rounded-full ${strong}`} style={pct(w)} />
                </span>
              </Inset>
            ))}
          </Stack>
        ))}
      </Stack>
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
        <Surface
          key={i}
          pad="sm"
          inset="sides"
          gap="md"
          row
          tone="plain"
          radius="none"
          look="h-12"
          place="shrink-0"
        >
          <Blob className={`size-8 shrink-0 rounded-full ${strong}`} />
          <Stack as="span" gap="xs" place="flex-1">
            <Blob className={`h-3 rounded-full ${strong}`} style={pct(d.name)} />
            {d.preview !== null && (
              <Blob className={`h-2.5 rounded-full ${soft}`} style={pct(d.preview)} />
            )}
          </Stack>
        </Surface>
      ))}
    </Frame>
  )
}

// Server tiles in place of a rail list that is loading (`few`: 2 or 3).
export function ServerRailSkeleton({ seed, few = false }: { seed: string; few?: boolean }) {
  return (
    <Frame kind="servers" label="Loading servers" className="flex shrink-0 flex-col items-center">
      <Stack gap="sm" align="center">
        {railShapes(seed, few).map((t, i) => (
          <Blob
            key={i}
            className={`size-12 shrink-0 ${t.round ? 'rounded-full' : 'rounded-2xl'} ${strong}`}
          />
        ))}
      </Stack>
    </Frame>
  )
}

// Rows of an avatar, a title and a line, for the sections of Home, Friends and the inbox.
export function RowsSkeleton({ rows, label }: { rows: number; label: string }) {
  return (
    <Frame kind="rows" label={label}>
      <Stack gap="2xs">
        {rowShapes(label, rows).map((r, i) => (
          <Surface key={i} tone="plain" radius="none" pad="sm">
            <Row gap="md">
              <Blob className={`size-8 shrink-0 rounded-full ${strong}`} />
              <Stack as="span" gap="xs" place="flex-1">
                <Blob className={`h-3 rounded-full ${strong}`} style={pct(r.title)} />
                <Blob className={`h-2.5 rounded-full ${soft}`} style={pct(r.line)} />
              </Stack>
            </Row>
          </Surface>
        ))}
      </Stack>
    </Frame>
  )
}
