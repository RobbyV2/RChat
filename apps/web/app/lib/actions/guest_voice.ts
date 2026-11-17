// Staff's menu of a guest in a server's voice: on the guest's tile and sidebar row.

import { Mic, MicOff, PhoneOff } from 'lucide-react'
import { guestVoiceActions, isGuestName, type GuestVoiceAction } from '../guest_voice'
import { myPerms } from '../selectors'
import { useStore } from '../store'
import type { Action, ActionCtx } from './types'

const get = () => useStore.getState()

const guestOf = ({ target }: ActionCtx) => (target.kind === 'voice_guest' ? target : null)

// Whether you may do `action` to the guest now.
const may = (action: GuestVoiceAction) => (ctx: ActionCtx) => {
  const at = guestOf(ctx)
  if (!at || !isGuestName(at.name)) return false
  const hushed = Object.values(ctx.s.voiceHushed).some(l => l.includes(at.name))
  return guestVoiceActions(at.name, myPerms(ctx.s, at.server), hushed).includes(action)
}

const mute = (muted: boolean) => (ctx: ActionCtx) => {
  const at = guestOf(ctx)
  if (at) void get().muteGuest(at.server, at.name, muted)
}

const onGuest = { scope: 'voice', targets: ['voice_guest'] } as const

export const guestVoiceMenuActions: Action[] = [
  {
    id: 'voice_guest_mute',
    title: 'Mute for everyone',
    subtitle: () => 'Stays muted for up to 24 hours',
    wrap: true,
    icon: MicOff,
    ...onGuest,
    order: 100,
    available: may('mute'),
    run: mute(true),
  },
  {
    id: 'voice_guest_unmute',
    title: 'Unmute for everyone',
    icon: Mic,
    ...onGuest,
    order: 100,
    available: may('unmute'),
    run: mute(false),
  },
  {
    id: 'voice_guest_disconnect',
    title: 'Disconnect',
    subtitle: () => "Can't rejoin voice here for 10 minutes",
    wrap: true,
    danger: true,
    icon: PhoneOff,
    ...onGuest,
    order: 110,
    available: may('disconnect'),
    run: ctx => {
      const at = guestOf(ctx)
      if (at) void get().disconnectGuest(at.server, at.name)
    },
  },
]
