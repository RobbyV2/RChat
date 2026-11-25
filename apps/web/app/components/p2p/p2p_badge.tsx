'use client'
import { useP2pApp } from '../../lib/client/p2p_react'

import { withP2pIdentity } from '../../lib/client/p2p_react'

import { useP2p } from '../../lib/client/p2p_react'

import { useAccount } from '../../lib/client/react'

import { useMemo } from 'react'
import { minidenticon } from 'minidenticons'
import { identiconInk } from '../../lib/identicon'
import { validColor } from '../../lib/profile'
import { roomLookOf } from '../../lib/server_profile'
import type { AvatarKind } from '../../lib/types'
import {
  BadgeAlert,
  BadgeCheck,
  BadgeX,
  Shield,
  ShieldAlert,
  ShieldCheck,
  Waypoints,
} from 'lucide-react'
import type { Shield as ShieldKind } from '../../lib/p2p/contacts'
import type { Presence } from '../../lib/p2p/node'
import { badgeState, type BadgeSlot, type BadgeState } from '../../lib/p2p/badge'

import { openActionMenu } from '../../lib/actions/menu'
import { useStore } from '../../lib/store'
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

export function ContactShield({
  kind,
  size = 16,
  id,
}: {
  kind: ShieldKind
  size?: number
  id?: string
}) {
  const { Icon, cls, text } = SHIELD[kind]
  return (
    <span
      id={id}
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

// A member's avatar as a server shows it: the avatar they set there, over their key's picture.
export function MemberAvatar({
  members,
  ik,
  size,
}: {
  members:
    readonly { ik: string; name: string; av?: { kind: AvatarKind; bg?: string } }[] | undefined
  ik: string
  size?: number
}) {
  const look = roomLookOf(members?.find(m => m.ik === ik))
  return (
    <KeyAvatar ik={ik} size={size} kind={look?.avatar_kind ?? undefined} bg={look?.avatar_color} />
  )
}

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

// Identicons come from the identity key, so a look-alike name never gets the same picture. A
// member's own background sits behind it; a color avatar is a disc of that color with the key
// identicon as a mark in its corner, so the key-derived picture always shows.
export function KeyAvatar({
  ik,
  size = 36,
  kind = 'identicon',
  bg,
}: {
  ik: string
  size?: number
  kind?: AvatarKind
  bg?: string | null
}) {
  const shade = validColor(bg) ? bg.toLowerCase() : null
  const disc = kind === 'color' && shade !== null
  const src = useMemo(() => {
    const svg =
      shade && !disc
        ? minidenticon(ik, 95, 45).replace(/fill="[^"]*"/, `fill="${identiconInk(ik, shade)}"`)
        : minidenticon(ik, 95, 45)
    return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`
  }, [ik, shade, disc])
  if (disc) {
    const mark = Math.max(12, Math.round(size * 0.45))
    return (
      <span
        className="relative inline-block shrink-0 rounded-full"
        style={{ width: size, height: size, backgroundColor: shade }}
      >
        <img
          src={src}
          alt=""
          width={mark}
          height={mark}
          draggable={false}
          className="absolute -right-0.5 -bottom-0.5 rounded-full bg-surface-container-highest ring-2 ring-surface-container-low"
        />
      </span>
    )
  }
  return (
    <img
      src={src}
      alt=""
      width={size}
      height={size}
      draggable={false}
      className="shrink-0 rounded-full bg-surface-container-highest"
      style={shade ? { backgroundColor: shade } : undefined}
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
function AccountChipBody({ ik, size = 'full' }: { ik: string; size?: 'full' | 'short' | 'icon' }) {
  const identity = useP2pApp()!

  const acct = useAccount()

  const slot = useP2p(s => s.badges[ik])
  const streamer = useStore(s => s.streamer)
  const state = badgeState(slot, Date.now())
  if (!slot || !state) return null
  const { Icon, cls, text, short } = CHIP[state]
  const line = badgeLine(state, slot, streamer)
  const sub = slot.ok?.sub
  const open = (x: number, y: number) =>
    openActionMenu(
      x,
      y,
      { kind: 'p2p_badge', ik, sub: sub ?? null, stale: state === 'unchecked' },
      { header: <BadgeSheet state={state} slot={slot} /> },
      acct,
      identity
    )
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

export const AccountChip = withP2pIdentity(AccountChipBody)
