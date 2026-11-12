import type { RChatState } from './store_types'
import type { UserRef } from './types'

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
