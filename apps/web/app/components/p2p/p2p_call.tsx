'use client'

import { useState } from 'react'
import { ChevronDown, Phone, PhoneOff, Video } from 'lucide-react'
import { relayOnly } from '../../lib/ice'
import { displayHost, hostOf, manualRelays, ownTurn } from '../../lib/relays'
import { P2P_IP_HINT, ROUTE_LABEL } from '../../lib/call_choice'
import { useStore, type ContextMenuItem } from '../../lib/store'
import { CALL_ELSEWHERE, p2pCall, useP2p } from '../../lib/p2p/app'
import type { P2pMessage } from '../../lib/p2p/dm'
import type { CallLog } from '../../lib/types'
import { CallLogLine } from '../message_pane'
import { P2pBadge } from './p2p_badge'

const seconds = (ms: number) => Math.floor(ms / 1000)

// A call row of a P2P conversation as the shared call log row reads it: the caller is the
// sender, and only its outcome and length are known.
export const callLogOf = (p: P2pMessage): CallLog | null => {
  const c = p.call
  if (!c) return null
  const end = seconds(p.ts)
  const ended = c.outcome === 'ended'
  return {
    from: p.sender,
    answered_at: ended ? end - (c.dur ?? 0) : null,
    ended_at: end,
    outcome: c.outcome === 'ended' ? 'completed' : c.outcome,
    p2p: true,
    video: c.video,
  }
}

export function P2pCallRow({ p, me }: { p: P2pMessage; me: string | null }) {
  const call = callLogOf(p)
  if (!call) return null
  return (
    <div data-row data-event={p.id} data-p2p-call={p.call?.outcome}>
      <CallLogLine call={call} me={me} time={seconds(p.ts)} badge={<P2pBadge />} />
    </div>
  )
}

// Call and Video for a P2P contact. A call with a contact is always direct; the chevron offers
// a relay of the user's own for this call only, as in instance DMs.
function SplitCall({ peer, video, why }: { peer: string; video: boolean; why: string | null }) {
  const hidesIp = useStore(s =>
    relayOnly(s.instance?.ice, s.iceHelpers, s.iceRelay, ownTurn(s.relayPrefs))
  )
  const relays = useStore(s => s.relayPrefs)
  const openContextMenu = useStore(s => s.openContextMenu)
  const [shown, setShown] = useState<object | null>(null)
  const open = useStore(s => shown !== null && s.contextMenu === shown)
  const kind = video ? 'Video call' : 'Call'
  const Icon = video ? Video : Phone
  const off = why !== null
  const title = why ?? `${kind}, direct (P2P)`
  const menu = (x: number, y: number) => {
    const items: ContextMenuItem[] = [
      {
        label: ROUTE_LABEL.p2p,
        subtitle: hidesIp ? undefined : P2P_IP_HINT,
        wrap: true,
        radio: true,
        checked: true,
        action: () => void p2pCall.start(peer, video),
      },
      ...manualRelays(relays).map(r => ({
        label: `Direct through ${displayHost(hostOf(r.url) ?? r.url)}`,
        wrap: true,
        action: () => void p2pCall.start(peer, video, r.url),
      })),
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
      className={`flex items-center rounded-full ${off ? 'opacity-40' : ''}`}
    >
      <button
        title={title}
        aria-label={title}
        disabled={off}
        onClick={() => void p2pCall.start(peer, video)}
        className="relative rounded-l-full py-1.5 pr-1 pl-1.5 outline-offset-2 [@media(pointer:coarse)]:h-10 [@media(pointer:coarse)]:min-w-10 hover:bg-surface-container-high focus-visible:outline-2 focus-visible:outline-primary disabled:hover:bg-transparent"
      >
        <Icon size={20} />
        <span
          aria-hidden
          className="absolute -bottom-0.5 left-3 rounded bg-tertiary-container px-0.5 text-[8px] leading-tight font-bold text-on-tertiary-container"
        >
          P2P
        </span>
      </button>
      <button
        title={`${kind} options`}
        aria-label={`${kind} options`}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={off}
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

// The header's call buttons, or why there are none right now.
export function P2pCallButtons({
  peer,
  name,
  online,
  canCall,
}: {
  peer: string
  name: string
  online: boolean
  canCall: boolean
}) {
  const elsewhere = useP2p(s => s.reader || s.elsewhere)
  const there = useP2p(s => s.callElsewhere)
  const own = useP2p(s => s.call !== null)
  const instance = useStore(s => s.call !== null)
  if (elsewhere && there)
    return (
      <span
        data-call-elsewhere
        className="rounded-full bg-surface-container-high px-2.5 py-1 text-xs text-on-surface-variant"
      >
        {CALL_ELSEWHERE}
      </span>
    )
  const why = elsewhere
    ? 'P2P is open in another tab'
    : !canCall
      ? 'Calls need a mutual contact'
      : own || instance
        ? 'Already in a call'
        : !online
          ? `${name} is offline`
          : null
  return (
    <div className="flex items-center gap-1">
      <SplitCall peer={peer} video={false} why={why} />
      <SplitCall peer={peer} video why={why} />
    </div>
  )
}

// An incoming call in the open conversation: always here, also when its ringing is quiet.
export function IncomingCallBar({ room, name }: { room: string; name: string }) {
  const c = useP2p(s => (s.call?.room === room ? s.call : null))
  const accepting = useP2p(s => s.callAccepting)
  if (!c || c.dir !== 'in' || c.state !== 'ringing') return null
  return (
    <div
      role="status"
      data-p2p-incoming
      className="flex shrink-0 flex-wrap items-center gap-3 border-b border-outline-variant bg-surface-container px-4 py-2 text-sm"
    >
      <span className="flex min-w-0 flex-1 items-center gap-2">
        {c.video ? (
          <Video size={16} className="shrink-0 text-status-green" aria-hidden />
        ) : (
          <Phone size={16} className="shrink-0 text-status-green" aria-hidden />
        )}
        <span className="min-w-0 truncate">
          <span className="streamer font-medium">{name}</span>{' '}
          {c.video ? 'is video calling you' : 'is calling you'}
        </span>
      </span>
      <span className="flex items-center gap-1.5">
        <button
          title="Accept"
          aria-label="Accept"
          disabled={accepting}
          onClick={() => void p2pCall.accept()}
          className="flex items-center gap-1 rounded-full bg-status-green px-2.5 py-1 text-xs [@media(pointer:coarse)]:px-3.5 [@media(pointer:coarse)]:py-2 font-medium text-surface outline-offset-2 hover:brightness-110 focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-60"
        >
          <Phone size={12} />
          Accept
        </button>
        <button
          title="Decline"
          aria-label="Decline"
          onClick={() => p2pCall.decline()}
          className="flex items-center gap-1 rounded-full bg-danger px-2.5 py-1 text-xs [@media(pointer:coarse)]:px-3.5 [@media(pointer:coarse)]:py-2 font-medium text-on-danger outline-offset-2 hover:brightness-110 focus-visible:outline-2 focus-visible:outline-primary"
        >
          <PhoneOff size={12} />
          Decline
        </button>
      </span>
    </div>
  )
}
