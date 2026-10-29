'use client'

import { useEffect, useState } from 'react'
import { ChevronDown, Phone, Video } from 'lucide-react'
import { relayOnly } from '../lib/ice'
import {
  P2P_IP_HINT,
  ROUTE_LABEL,
  p2pCallable,
  recentlyFailed,
  routeFor,
  type CallRoute,
} from '../lib/call_choice'
import { fmtDuration } from '../lib/voice_layout'
import { useStore, type ContextMenuItem } from '../lib/store'
import type { DmSummary } from '../lib/types'

export const useP2pCallable = (dm: DmSummary) =>
  useStore(s =>
    p2pCallable({
      guest: s.guest,
      signedIn: s.me !== null,
      p2pOn: s.settings.p2p_attachments,
      selfDm: dm.is_self,
      failed: recentlyFailed(s.p2pCallFailed[dm.id]),
    })
  )

export function DirectBadge({ label = 'Direct' }: { label?: string }) {
  return (
    <span
      title="Direct (P2P) call"
      className="shrink-0 rounded bg-tertiary-container px-1 py-0.5 text-[10px] leading-none font-bold whitespace-nowrap text-on-tertiary-container"
    >
      {label}
    </span>
  )
}

export function CallDuration({ from }: { from: number }) {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000))
  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000)
    return () => clearInterval(id)
  }, [])
  return <>{fmtDuration(Math.max(0, now - from))}</>
}

// "Video call" or "Call", and how it connects.
export function CallType({
  video,
  p2p,
  incoming = false,
}: {
  video: boolean
  p2p: boolean
  incoming?: boolean
}) {
  const Icon = video ? Video : Phone
  const label = video ? 'Video call' : 'Call'
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-sm text-on-surface-variant">
      <span className="flex items-center gap-1.5 whitespace-nowrap">
        <Icon size={14} aria-hidden className="shrink-0" />
        {incoming ? `Incoming ${label.toLowerCase()}` : label}
      </span>
      {p2p ? (
        <DirectBadge label={ROUTE_LABEL.p2p} />
      ) : (
        <span className="shrink-0 rounded bg-surface-container-highest px-1 py-0.5 text-[10px] leading-none font-bold whitespace-nowrap text-on-surface-variant">
          {ROUTE_LABEL.server}
        </span>
      )}
    </span>
  )
}

function SplitCall({ dm, video }: { dm: DmSummary; video: boolean }) {
  const chosen = useStore(s => s.callRoute)
  const busy = useStore(s => s.call !== null)
  const hidesIp = useStore(s => relayOnly(s.instance?.ice, s.iceHelpers, s.iceRelay))
  const startCall = useStore(s => s.startCall)
  const startP2pCall = useStore(s => s.startP2pCall)
  const setCallRoute = useStore(s => s.setCallRoute)
  const openContextMenu = useStore(s => s.openContextMenu)
  const p2pOk = useP2pCallable(dm)
  const [shown, setShown] = useState<object | null>(null)
  const open = useStore(s => shown !== null && s.contextMenu === shown)
  const route = routeFor(chosen, p2pOk)
  const kind = video ? 'Video call' : 'Call'
  const Icon = video ? Video : Phone
  const start = (r: CallRoute) => {
    if (r === 'p2p') void startP2pCall(dm.id, video)
    else void startCall(dm.id, video)
  }
  const pick = (r: CallRoute) => {
    setCallRoute(r)
    start(r)
  }
  const title = route === 'p2p' ? `${kind}, direct (P2P)` : kind
  const menu = (x: number, y: number) => {
    const items: ContextMenuItem[] = [
      {
        label: ROUTE_LABEL.server,
        radio: true,
        checked: route === 'server',
        action: () => pick('server'),
      },
      ...(p2pOk
        ? [
            {
              label: ROUTE_LABEL.p2p,
              subtitle: hidesIp ? undefined : P2P_IP_HINT,
              wrap: true,
              radio: true,
              checked: route === 'p2p',
              action: () => pick('p2p'),
            },
          ]
        : []),
    ]
    openContextMenu(x, y, items, {
      header: (
        <span className="px-2 text-xs font-medium text-on-surface-variant">
          {video ? 'Start a video call' : 'Start a call'}
        </span>
      ),
    })
    setShown(useStore.getState().contextMenu)
  }
  return (
    <div
      data-call-split={video ? 'video' : 'voice'}
      className={`flex items-center rounded-full ${busy ? 'opacity-40' : ''}`}
    >
      <button
        title={title}
        aria-label={title}
        disabled={busy}
        onClick={() => start(route)}
        className="relative rounded-l-full py-1.5 pr-1 pl-1.5 outline-offset-2 hover:bg-surface-container-high focus-visible:outline-2 focus-visible:outline-primary disabled:hover:bg-transparent"
      >
        <Icon size={20} />
        {route === 'p2p' && (
          <span
            aria-hidden
            className="absolute -bottom-0.5 left-3 rounded bg-tertiary-container px-0.5 text-[8px] leading-tight font-bold text-on-tertiary-container"
          >
            P2P
          </span>
        )}
      </button>
      <button
        title={`${kind} options`}
        aria-label={`${kind} options`}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={busy}
        onClick={e => {
          const r = e.currentTarget.getBoundingClientRect()
          menu(r.left - 24, r.bottom + 4)
        }}
        className="flex h-8 items-center rounded-r-full pr-1 pl-0.5 text-on-surface-variant [@media(pointer:coarse)]:h-10 [@media(pointer:coarse)]:min-w-10 [@media(pointer:coarse)]:justify-center outline-offset-2 hover:bg-surface-container-high hover:text-on-surface focus-visible:outline-2 focus-visible:outline-primary disabled:hover:bg-transparent"
      >
        <ChevronDown size={14} />
      </button>
    </div>
  )
}

// Call and Video, each with a chevron to pick how it connects.
export function CallButtons({ dm }: { dm: DmSummary }) {
  return (
    <div className="flex items-center gap-1">
      <SplitCall dm={dm} video={false} />
      <SplitCall dm={dm} video />
    </div>
  )
}
