import type { RChatState } from './store_types'
import { hasPerm, Perm, type UserRef } from './types'

// A guest is in voice rooms under a name the server gives its connection. It starts with `@`,
// which usernames cannot contain.
const PREFIX = '@guest:'

export const isGuestName = (name: string | null | undefined) =>
  typeof name === 'string' && name.startsWith(PREFIX)

// "Guest" and the start of the name's tag, so two guests in one room differ.
export const guestLabel = (name: string) => `Guest ${name.slice(PREFIX.length, PREFIX.length + 4)}`

export const guestRef = (name: string): UserRef => ({
  username: name,
  display_name: guestLabel(name),
  avatar_kind: 'identicon',
  avatar_color: null,
})

// Who this tab is in voice: the account, or a guest under its connection's name.
export const voiceSelf = (s: Pick<RChatState, 'me' | 'guest' | 'guestVoiceName'>) =>
  s.me?.username ?? (s.guest ? s.guestVoiceName : null)

// What a guest muted by staff, and the people who see its tile, are told.
export const STAFF_MUTED = 'Muted by staff'

export type GuestVoiceAction = 'mute' | 'unmute' | 'disconnect'

// What staff with `perms` in the server may do to someone in its voice: only guests are
// moderated here. Mute needs Timeout members, Disconnect needs Kick.
export const guestVoiceActions = (
  name: string,
  perms: number,
  hushed: boolean
): GuestVoiceAction[] => {
  if (!isGuestName(name)) return []
  const out: GuestVoiceAction[] = []
  if (hasPerm(perms, Perm.TimeoutMembers)) out.push(hushed ? 'unmute' : 'mute')
  if (hasPerm(perms, Perm.Kick)) out.push('disconnect')
  return out
}

// Who a remote audio stream is from: `bob` or `bob:screen` (the audio of their screen share).
const streamOwner = (key: string) =>
  isGuestName(key) ? key.split(':').slice(0, 2).join(':') : key.split(':')[0]

// The remote streams to play: none of a silenced peer's, mic or screen audio, whatever it sends;
// the rest muted while you are deafened.
export const audibleStreams = (
  streams: [string, MediaStream][],
  silenced: readonly string[],
  deafened: boolean
) =>
  streams
    .filter(([key]) => !silenced.includes(streamOwner(key)))
    .map(([key, stream]) => ({ key, stream, muted: deafened }))
