import type { RChatState } from './store_types'
import type { ApiClient } from './api'
import { ApiError } from './api'
import { device } from './platform'
import { hasBit } from './perms'
import { ChannelPermBit, type ServerDetail, type SiteSettings, type Message } from './types'

const sessions = new Map<string, string>()

const acquiring = new Map<string, Promise<Message>>()

export function guestCanPost(
  settings: SiteSettings,
  detail: ServerDetail | undefined,
  channel: number | null
) {
  const room = detail?.channels.find(c => c.id === channel)
  return (
    settings.guests_enabled &&
    settings.guest_chat_enabled === true &&
    detail?.guest_chat === true &&
    room?.kind === 'text' &&
    (room.my_perms === undefined
      ? !room.restrict_send && !room.restrict_view && !detail.read_only?.includes(room.id)
      : hasBit(room.my_perms, ChannelPermBit.SendMessages))
  )
}

type GuestSwitches = Pick<
  SiteSettings,
  'guests_enabled' | 'guest_chat_enabled' | 'guest_voice_enabled'
>

// What the guest home promises, from the site's guest switches.
export function guestHomeLine(s: GuestSwitches) {
  const chat = s.guests_enabled && s.guest_chat_enabled === true
  const voice = s.guests_enabled && s.guest_voice_enabled === true
  const can =
    chat && voice
      ? 'send messages or join voice in servers that allow it.'
      : chat
        ? 'send messages in servers that allow it.'
        : voice
          ? 'read servers and join voice in servers that allow it.'
          : 'read servers but not post.'
  return "You're browsing as a guest. You can " + can
}

// What an account adds for a guest.
export const accountBenefits = (s: GuestSwitches) =>
  (s.guests_enabled && s.guest_chat_enabled === true ? 'send direct messages' : 'send messages') +
  ', add friends and get notified when someone mentions you.'

export function guestPostingStatus(s: RChatState, server: string | null, channel: number | null) {
  if (
    !s.guest ||
    server === null ||
    channel === null ||
    !guestCanPost(s.settings, s.servers[server], channel)
  )
    return 'off'
  return s.guestPosting[channel] ?? 'checking'
}

const sessionKey = (client: ApiClient, server: string, widget?: string) =>
  widget
    ? widget + ':guest_session:' + server
    : 'rchat_guest_session:' + client.origin() + ':' + server

export function guestSessionHeaders(
  client: ApiClient,
  server: string,
  widget?: string
): Record<string, string> {
  const key = sessionKey(client, server, widget)
  const secret = sessions.get(key) ?? device().read(key)
  return secret ? { 'X-Guest-Session': secret } : {}
}

export async function postGuest(
  client: ApiClient,
  server: string,
  path: string,
  body: { content: string; reply_to?: number; thread_root_id?: number },
  headers: Record<string, string> = {},
  widget?: string
) {
  const key = sessionKey(client, server, widget)
  const current = () => sessions.get(key) ?? device().read(key)
  const send = async (secret?: string | null) => {
    const result = await client.req<{ message: Message; session: string }>(
      'POST',
      path,
      body,
      secret ? { ...headers, 'X-Guest-Session': secret } : headers
    )
    sessions.set(key, result.session)
    device().write(key, result.session)
    return result.message
  }
  // Only the first send acquires an identity. Once acquired, channels and threads can post
  // concurrently. A failed acquisition leaves the next caller free to make its own attempt.
  const acquire = async (expired?: string): Promise<Message> => {
    const pending = acquiring.get(key)
    if (pending) {
      await pending.catch(() => {})
      const secret = current()
      return secret && secret !== expired ? send(secret) : acquire(expired)
    }
    const first = () => {
      const stored = device().read(key)
      const secret = stored && stored !== expired ? stored : current()
      return send(secret === expired ? undefined : secret)
    }
    // Web Locks also coordinate the first send between same-origin tabs sharing storage.
    let entered = false
    const locked = async () => {
      try {
        if (typeof navigator !== 'undefined' && navigator.locks)
          return await navigator.locks.request(key, () => {
            entered = true
            return first()
          })
      } catch (e) {
        if (entered || !(e instanceof DOMException) || e.name !== 'SecurityError') throw e
      }
      return first()
    }
    const work = locked().finally(() => acquiring.delete(key))
    acquiring.set(key, work)
    return work
  }
  const session = current()
  if (!session) return acquire()
  try {
    return await send(session)
  } catch (e) {
    if (e instanceof ApiError && e.status === 401 && e.message === 'Guest session expired')
      return acquire(session)
    throw e
  }
}
