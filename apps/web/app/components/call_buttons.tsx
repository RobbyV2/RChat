'use client'

import { useEffect, useState, type ReactNode } from 'react'
import { ChevronDown, Phone, Video } from 'lucide-react'
import { useAccount } from '../lib/client/react'
import { openActionMenu } from '../lib/actions/menu'
import { p2pCallOk } from '../lib/actions/voice'
import { ROUTE_LABEL, routeFor, type CallRoute } from '../lib/call_choice'
import { fmtDuration } from '../lib/voice_layout'
import { useStore } from '../lib/store'
import type { DmSummary } from '../lib/types'
import { Row, Inset } from './layout'
import { time } from '../lib/platform/time'

export function DirectBadge({ label = 'Direct' }: { label?: string }) {
  return (
    <Inset
      title="Direct (P2P) call"
      as="span"
      pad="2xs"
      inset="bar"
      look="rounded bg-tertiary-container text-3xs leading-none font-bold whitespace-nowrap text-on-tertiary-container"
      place="shrink-0"
    >
      {label}
    </Inset>
  )
}

export function CallDuration({ from }: { from: number }) {
  const [now, setNow] = useState(() => Math.floor(time().now() / 1000))
  useEffect(() => {
    const id = time().every(1000, () => setNow(Math.floor(time().now() / 1000)))
    return () => id()
  }, [])
  return <>{fmtDuration(Math.max(0, now - from))}</>
}

// "Video call" or "Call", and how it connects.
export function CallType({
  video,
  p2p,
  incoming = false,
  chip,
}: {
  video: boolean
  p2p: boolean
  incoming?: boolean
  // Shown instead of the route chip.
  chip?: ReactNode
}) {
  const Icon = video ? Video : Phone
  const label = video ? 'Video call' : 'Call'
  return (
    <Row as="span" gap="sm" wrap lineGap="3xs" text="sm" ink="muted" place="min-w-0">
      <Row as="span" gap="xs">
        <Icon size={14} aria-hidden className="shrink-0" />
        <span className="whitespace-nowrap">
          {incoming ? `Incoming ${label.toLowerCase()}` : label}
        </span>
      </Row>
      {chip ??
        (p2p ? (
          <DirectBadge label={ROUTE_LABEL.p2p} />
        ) : (
          <Inset
            as="span"
            pad="2xs"
            inset="bar"
            look="rounded bg-surface-container-highest text-3xs leading-none font-bold whitespace-nowrap text-on-surface-variant"
            place="shrink-0"
          >
            {ROUTE_LABEL.server}
          </Inset>
        ))}
    </Row>
  )
}

function SplitCall({ dm, video }: { dm: DmSummary; video: boolean }) {
  const chosen = useStore(s => s.callRoute)
  const busy = useStore(s => !s.canStartCall(dm.id))
  const startCall = useStore(s => s.startCall)
  const startP2pCall = useStore(s => s.startP2pCall)
  const p2pOk = useStore(s => p2pCallOk(s, dm))
  const account = useAccount()
  const [shown, setShown] = useState<object | null>(null)
  const open = useStore(s => shown !== null && s.contextMenu === shown)
  const route = routeFor(chosen, p2pOk)
  const kind = video ? 'Video call' : 'Call'
  const Icon = video ? Video : Phone
  const start = (r: CallRoute) => {
    if (r === 'p2p') void startP2pCall(dm.id, video)
    else void startCall(dm.id, video)
  }
  const title = route === 'p2p' ? `${kind}, direct (P2P)` : kind
  const menu = (x: number, y: number) => {
    openActionMenu(
      x,
      y,
      { kind: 'call', dm, video },
      {
        header: (
          <span className="text-xs font-medium text-on-surface-variant">
            {video ? 'Start a video call' : 'Start a call'}
          </span>
        ),
      },
      account
    )
    setShown(account.store.getState().contextMenu)
  }
  return (
    <div
      data-call-split={video ? 'video' : 'voice'}
      className={`flex items-center rounded-full ${busy ? 'opacity-40' : ''}`}
    >
      <Inset
        title={title}
        aria-label={title}
        disabled={busy}
        onClick={() => start(route)}
        as="button"
        pad="xs"
        look="relative rounded-l-full outline-offset-2 hover:bg-surface-container-high focus-visible:outline-2 focus-visible:outline-primary disabled:hover:bg-transparent"
      >
        <Icon size={20} />
        {route === 'p2p' && (
          <Inset
            aria-hidden
            as="span"
            pad="3xs"
            inset="sides"
            look="rounded bg-tertiary-container text-3xs leading-tight font-bold text-on-tertiary-container"
            place="absolute -bottom-0.5 left-3"
          >
            P2P
          </Inset>
        )}
      </Inset>
      <Inset
        title={`${kind} options`}
        aria-label={`${kind} options`}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={busy}
        onClick={e => {
          const r = e.currentTarget.getBoundingClientRect()
          menu(r.left - 24, r.bottom + 4)
        }}
        as="button"
        row
        pad="3xs"
        inset="sides"
        justify="center"
        look="h-8 rounded-r-full text-on-surface-variant pointer-coarse:h-10 pointer-coarse:min-w-10 outline-offset-2 hover:bg-surface-container-high hover:text-on-surface focus-visible:outline-2 focus-visible:outline-primary disabled:hover:bg-transparent"
      >
        <ChevronDown size={14} />
      </Inset>
    </div>
  )
}

// Call and Video, each with a chevron to pick how it connects.
export function CallButtons({ dm }: { dm: DmSummary }) {
  return (
    <Row gap="2xs">
      <SplitCall dm={dm} video={false} />
      <SplitCall dm={dm} video />
    </Row>
  )
}
