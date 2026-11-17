'use client'

import { openActionMenu, useHasMenu } from '../lib/actions/menu'
import type { Target } from '../lib/actions/types'
import { guestLabel, isGuestName } from '../lib/guest_voice'
import { useStore } from '../lib/store'

export const GUEST_MENU = 'guest-voice'

// Opens the staff menu of the guest `name` in the voice of `server` at a point, or null when you
// can't act on it (not a guest, or you lack the permissions). Accounts skip the registry.
export function useGuestMenu(server: string | null, name: string) {
  const target: Target | null =
    server === null || !isGuestName(name) ? null : { kind: 'voice_guest', server, name }
  const has = useHasMenu(target)
  if (target === null || !has) return null
  return (x: number, y: number) =>
    openActionMenu(x, y, target, {
      owner: `${GUEST_MENU}:${name}`,
      header: <span className="text-sm font-medium text-on-surface">{guestLabel(name)}</span>,
    })
}

export const useGuestMenuOpen = (name: string) =>
  useStore(s => s.contextMenu?.owner === `${GUEST_MENU}:${name}`)
