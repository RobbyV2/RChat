'use client'

import { Mic, MicOff, PhoneOff } from 'lucide-react'
import { guestLabel, guestVoiceActions, type GuestVoiceAction } from '../lib/guest_voice'
import { myPerms } from '../lib/selectors'
import { useStore, type ContextMenuItem } from '../lib/store'

export const GUEST_MENU = 'guest-voice'

const itemFor = (server: string, name: string, action: GuestVoiceAction): ContextMenuItem => {
  const s = useStore.getState()
  switch (action) {
    case 'mute':
      return {
        label: 'Mute for everyone',
        subtitle: 'Stays muted for up to 24 hours',
        wrap: true,
        icon: MicOff,
        action: () => void s.muteGuest(server, name, true),
      }
    case 'unmute':
      return {
        label: 'Unmute for everyone',
        icon: Mic,
        action: () => void s.muteGuest(server, name, false),
      }
    case 'disconnect':
      return {
        label: 'Disconnect',
        subtitle: "Can't rejoin voice here for 10 minutes",
        wrap: true,
        danger: true,
        icon: PhoneOff,
        action: () => void s.disconnectGuest(server, name),
      }
  }
}

// Opens the staff menu of the guest `name` in the voice of `server` at a point, or null when you
// can't act on it (not a guest, or you lack the permissions).
export function useGuestMenu(server: string | null, name: string) {
  const perms = useStore(s => (server === null ? 0 : myPerms(s, server)))
  const hushed = useStore(s => Object.values(s.voiceHushed).some(l => l.includes(name)))
  const actions = server === null ? [] : guestVoiceActions(name, perms, hushed)
  if (server === null || actions.length === 0) return null
  return (x: number, y: number) =>
    useStore.getState().openContextMenu(
      x,
      y,
      actions.map(a => itemFor(server, name, a)),
      {
        owner: `${GUEST_MENU}:${name}`,
        header: <span className="text-sm font-medium text-on-surface">{guestLabel(name)}</span>,
      }
    )
}

export const useGuestMenuOpen = (name: string) =>
  useStore(s => s.contextMenu?.owner === `${GUEST_MENU}:${name}`)
