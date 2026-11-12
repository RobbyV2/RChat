import { charCount } from './rules'
import type { RChatState } from './store_types'
import type { UserRef } from './types'
import { isGuestName } from './guest_voice'
import { isWebhookAuthor } from './webhooks'

export const DISPLAY_NAME_MAX = 32

// The server's length rule, checked before sending: trimmed, 1 to 32 characters.
export const displayNameError = (text: string) => {
  const name = text.trim()
  if (!name) return 'Type a display name'
  return charCount(name) > DISPLAY_NAME_MAX
    ? `Display name must be at most ${DISPLAY_NAME_MAX} characters`
    : null
}

type Named = Pick<UserRef, 'username' | 'display_name'>

// A display name that is more than the username's case shows the username next to it. Webhooks
// and guests keep their own name.
export const showsUsername = (u: Named) =>
  !isWebhookAuthor(u.username) &&
  !isGuestName(u.username) &&
  u.display_name.toLowerCase() !== u.username

// "Display (username)" as plain text: titles, notifications, the typing line.
export const nameWithUsername = (u: Named) =>
  showsUsername(u) ? `${u.display_name} (${u.username})` : u.display_name

// A name as the viewer's filter shows it. A guest's label is the app's own text and never masked.
export const maskedName = (u: Named, mask: (text: string) => string) =>
  isGuestName(u.username) ? u.display_name : mask(nameWithUsername(u))

// What a mention pill shows: the handle that resolves.
export const mentionHandle = (u: Named) => (showsUsername(u) ? u.username : u.display_name)

export const dmPlaceholder = (
  other: Named | undefined,
  streamer: boolean,
  mask: (text: string) => string = t => t
) => (streamer || !other ? 'Send a direct message' : `Message @${mask(other.username)}`)

export const canEditDisplayName = (s: RChatState) =>
  s.me !== null && !s.guest && s.settings.display_names
