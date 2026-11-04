'use client'

import { useMemo } from 'react'
import { minidenticon } from 'minidenticons'
import {
  BadgeAlert,
  BadgeCheck,
  BadgeX,
  Copy,
  RefreshCw,
  Shield,
  ShieldAlert,
  ShieldCheck,
  Waypoints,
} from 'lucide-react'
import type { Shield as ShieldKind } from '../../lib/p2p/contacts'
import type { Presence } from '../../lib/p2p/node'
import { badgeState, type BadgeSlot, type BadgeState } from '../../lib/p2p/badge'
import { p2pBadge, useP2p } from '../../lib/p2p/app'
import { sharing } from '../../lib/platform'
import { useStore } from '../../lib/store'
import type { ContextMenuItem } from '../../lib/store_types'
import { longPress } from '../context_menu'

// The one mark everything P2P carries: Waypoints, "P2P", a dashed outline in the tertiary color.
export function P2pBadge({ label = 'P2P', title }: { label?: string; title?: string }) {
  return (
    <span
      title={title ?? 'Peer-to-peer: stored on your devices, not on the instance'}
      className="inline-flex shrink-0 items-center gap-1 rounded-full border border-dashed border-tertiary px-1.5 py-px text-[11px] leading-4 font-medium text-tertiary"
    >
      <Waypoints size={12} aria-hidden />
      {label}
    </span>
  )
}

const SHIELD = {
  verified: { Icon: ShieldCheck, cls: 'text-status-green', text: 'Verified' },
  warning: { Icon: ShieldAlert, cls: 'text-error', text: 'Identity warning' },
  unverified: { Icon: Shield, cls: 'text-on-surface-variant', text: 'Not verified' },
} as const

export const shieldText = (kind: ShieldKind) => SHIELD[kind].text

export function ContactShield({ kind, size = 16 }: { kind: ShieldKind; size?: number }) {
  const { Icon, cls, text } = SHIELD[kind]
  return (
    <span
      title={text}
      aria-label={text}
      role="img"
      data-shield={kind}
      className={`shrink-0 ${cls}`}
    >
      <Icon size={size} />
    </span>
  )
}

const DOT = {
  online: { cls: 'bg-status-green', text: 'Online' },
  dialing: { cls: 'bg-outline animate-pulse', text: 'Connecting' },
  offline: { cls: 'bg-outline', text: 'Offline' },
} as const

export const presenceText = (p: Presence) => DOT[p].text

export function PresenceDot({ presence }: { presence: Presence }) {
  const { cls, text } = DOT[presence]
  return (
    <span
      title={text}
      aria-label={text}
      role="img"
      data-presence={presence}
      className={`absolute -right-0.5 -bottom-0.5 h-3 w-3 rounded-full border-2 border-surface-container-low ${cls}`}
    />
  )
}

// Identicons come from the identity key, so a look-alike name never gets the same picture.
export function KeyAvatar({ ik, size = 36 }: { ik: string; size?: number }) {
  const src = useMemo(
    () => `data:image/svg+xml;utf8,${encodeURIComponent(minidenticon(ik, 95, 45))}`,
    [ik]
  )
  return (
    <img
      src={src}
      alt=""
      width={size}
      height={size}
      draggable={false}
      className="shrink-0 rounded-full bg-surface-container-highest"
    />
  )
}

export const badgeDate = (ms: number) =>
  new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })

const CHIP: Record<
  BadgeState,
  { Icon: typeof BadgeCheck; cls: string; text: string; short: string }
> = {
  confirmed: {
    Icon: BadgeCheck,
    cls: 'bg-secondary-container text-on-secondary-container',
    text: 'Confirmed as',
    short: '',
  },
  expired: {
    Icon: BadgeX,
    cls: 'border border-outline-variant text-on-surface-variant',
    text: 'Confirmation expired',
    short: 'Expired',
  },
  unchecked: {
    Icon: BadgeAlert,
    cls: 'border border-dashed border-outline text-on-surface-variant',
    text: "Couldn't check",
    short: "Couldn't check",
  },
}

// What the badge says in full: the hover tooltip, the screen reader label and the long-press
// sheet. Streamer mode leaves the account out.
export const badgeLine = (state: BadgeState, slot: BadgeSlot, streamer: boolean) => {
  const ok = slot.ok
  const sub = streamer || !ok ? '' : ` as ${ok.sub}`
  switch (state) {
    case 'confirmed':
      return `Confirmed${sub || ' account'}. Checked ${badgeDate((ok as NonNullable<typeof ok>).checked)}.`
    case 'expired':
      return `Confirmation expired${ok ? ` on ${badgeDate(ok.exp * 1000)}` : ''}. It was confirmed${sub}.`
    case 'unchecked':
      return ok
        ? `Couldn't check a newer confirmation. Last checked ${badgeDate(ok.checked)}.`
        : "Couldn't check this account confirmation with the instance. Trying again later."
  }
}

function BadgeSheet({ state, slot }: { state: BadgeState; slot: BadgeSlot }) {
  const { Icon } = CHIP[state]
  const ok = slot.ok
  return (
    <div className="flex max-w-72 flex-col gap-1 text-sm">
      <p className="flex items-center gap-1.5 font-medium">
        <Icon size={16} className="shrink-0" aria-hidden />
        {state === 'confirmed' && ok ? (
          <span className="min-w-0 truncate">
            Confirmed as <span className="streamer">{ok.sub}</span>
          </span>
        ) : (
          CHIP[state].text
        )}
      </p>
      {ok && (
        <p className="text-xs text-on-surface-variant">
          {state === 'expired' ? (
            <>
              Was <span className="streamer">{ok.sub}</span> until {badgeDate(ok.exp * 1000)}.
            </>
          ) : (
            <>Checked {badgeDate(ok.checked)}.</>
          )}
        </p>
      )}
      <p className="text-xs text-on-surface-variant">
        {state === 'unchecked'
          ? "The instance couldn't be asked about it. Trying again later."
          : 'The instance says this P2P identity belongs to that account.'}
      </p>
    </div>
  )
}

// Whether an account chip shows for this contact.
export const useHasChip = (ik: string) => useP2p(s => badgeState(s.badges[ik], Date.now()) !== null)

// "Confirmed as alice@host" next to the shield, or "Confirmation expired" / "Couldn't check".
// `short` leaves out "Confirmed as" (and says "Expired"), `icon` keeps only the icon (a phone's
// DM header). Hover
// shows the check date; long-press (or right-click) opens it with the account.
export function AccountChip({
  ik,
  size = 'full',
}: {
  ik: string
  size?: 'full' | 'short' | 'icon'
}) {
  const slot = useP2p(s => s.badges[ik])
  const streamer = useStore(s => s.streamer)
  const openMenu = useStore(s => s.openContextMenu)
  const state = badgeState(slot, Date.now())
  if (!slot || !state) return null
  const { Icon, cls, text, short } = CHIP[state]
  const line = badgeLine(state, slot, streamer)
  const sub = slot.ok?.sub
  const items: ContextMenuItem[] =
    state === 'unchecked'
      ? [{ label: 'Check again', icon: RefreshCw, action: () => p2pBadge.recheck(ik) }]
      : sub
        ? [{ label: 'Copy account', icon: Copy, action: () => void sharing().copyText(sub) }]
        : []
  const open = (x: number, y: number) =>
    openMenu(x, y, items, { header: <BadgeSheet state={state} slot={slot} /> })
  return (
    <span
      data-account-badge={state}
      title={line}
      aria-label={line}
      aria-haspopup="menu"
      role="button"
      tabIndex={0}
      onKeyDown={e => {
        if (e.key !== 'Enter' && e.key !== ' ') return
        e.preventDefault()
        e.stopPropagation()
        const r = e.currentTarget.getBoundingClientRect()
        open(r.left, r.bottom)
      }}
      {...longPress(open)}
      className={`inline-flex min-w-0 items-center gap-1 rounded-full py-px text-[11px] leading-4 font-medium ${
        size === 'icon' ? 'shrink-0 p-px' : 'shrink px-1.5'
      } ${cls}`}
    >
      <Icon size={12} className="shrink-0" aria-hidden />
      {size === 'icon' ? null : state === 'confirmed' && sub ? (
        <span className="min-w-0 truncate">
          {size === 'full' && 'Confirmed as '}
          <span className="streamer">{sub}</span>
        </span>
      ) : (
        <span className="truncate">{size === 'short' ? short : text}</span>
      )}
    </span>
  )
}
