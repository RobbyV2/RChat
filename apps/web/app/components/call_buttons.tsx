'use client'

import { IconButton } from './controls'
import { useEffect, useState, type ReactNode } from 'react'
import { ChevronDown, Phone, Video } from 'lucide-react'
import { useAccount } from '../lib/client/react'
import { openActionMenu } from '../lib/actions/menu'
import { p2pCallOk } from '../lib/actions/voice'
import { ROUTE_LABEL, routeFor } from '../lib/call_choice'
import { fmtDuration } from '../lib/voice_layout'
import { useStore } from '../lib/store'
import type { DmSummary } from '../lib/types'
import { Row, Inset } from './layout'
import { longPress } from './context_menu'
import { time } from '../lib/platform/time'
import { type Said } from '../lib/names'

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

// One call button with a chevron beside it that offers how it connects (`onMenu`, with the place
// to show it). A right-click or a long press on the button offers the same; a touch screen shows
// no chevron.
export function CallSplit<const L extends string>({
  video,
  title,
  p2p,
  off,
  open,
  onStart,
  onMenu,
}: {
  video: boolean
  title: Said<L>
  p2p: boolean
  off: boolean
  open: boolean
  onStart: () => void
  onMenu: (x: number, y: number) => void
}) {
  const kind = video ? 'Video call' : 'Call'
  return (
    <div
      data-call-split={video ? 'video' : 'voice'}
      className={`flex items-center rounded-full ${off ? 'opacity-40' : ''}`}
    >
      <IconButton
        icon={video ? Video : Phone}
        label={title}
        tone="inherit"
        size="lg"
        disabled={off}
        onClick={onStart}
        {...longPress(onMenu)}
      >
        {p2p && (
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
      </IconButton>
      <IconButton
        icon={ChevronDown}
        label={`${kind} options`}
        size="sm"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={off}
        onClick={e => {
          const r = e.currentTarget.getBoundingClientRect()
          onMenu(r.left - 24, r.bottom + 4)
        }}
        place="pointer-coarse:hidden"
      />
    </div>
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
    <CallSplit
      video={video}
      title={route === 'p2p' ? (video ? 'Video call, direct (P2P)' : 'Call, direct (P2P)') : kind}
      p2p={route === 'p2p'}
      off={busy}
      open={open}
      onStart={() => {
        if (route === 'p2p') void startP2pCall(dm.id, video)
        else void startCall(dm.id, video)
      }}
      onMenu={menu}
    />
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
