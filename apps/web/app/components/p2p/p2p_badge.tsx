'use client'

import { useMemo } from 'react'
import { minidenticon } from 'minidenticons'
import { Shield, ShieldAlert, ShieldCheck, Waypoints } from 'lucide-react'
import type { Shield as ShieldKind } from '../../lib/p2p/contacts'
import type { Presence } from '../../lib/p2p/node'

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
