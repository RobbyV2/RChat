import { plainLine } from './replies'
import type { ForwardRef, Message, UserRef } from './types'

// The forward clipboard: one copied message per account, kept until it is sent or dismissed.
export interface ForwardClip {
  id: number
  author: UserRef | null
  snippet: string
  has_media: boolean
  created_at: number
  // The whole text, for forwards into P2P conversations (which copy it).
  body?: string
  // Copied from a P2P conversation: `id` is local, there is no instance message to point at.
  p2p?: boolean
}

export const BODY_MAX = 4000

export const forwardKey = (username: string) => `rchat_forward:${username}`

export const canForward = (m: Message) => (m.kind === 'user' || m.kind === 'poll') && m.id > 0

// The original author and time travel with forwards of forwards (the server does the same).
export const clipOf = (m: Message): ForwardClip => ({
  id: m.id,
  author: m.forward ? m.forward.author : m.author,
  snippet: plainLine(m.content),
  has_media: (m.media !== null && !m.media.removed) || !!m.forward?.dropped,
  created_at: m.forward?.created_at ?? m.created_at,
  body: [...m.content].slice(0, BODY_MAX).join(''),
})

const isUser = (u: unknown): u is UserRef => {
  if (typeof u !== 'object' || u === null) return false
  const { username, display_name, avatar_kind, avatar_color } = u as Record<string, unknown>
  return (
    typeof username === 'string' &&
    typeof display_name === 'string' &&
    (avatar_kind === 'identicon' || avatar_kind === 'color') &&
    (avatar_color === null || avatar_color === undefined || typeof avatar_color === 'string')
  )
}

export function parseForward(raw: string | null): ForwardClip | null {
  let data: unknown
  try {
    data = raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
  if (typeof data !== 'object' || data === null) return null
  const { v, clip } = data as Record<string, unknown>
  if (v !== 1 || typeof clip !== 'object' || clip === null) return null
  const { id, author, snippet, has_media, created_at, body, p2p } = clip as Record<string, unknown>
  if (
    typeof id !== 'number' ||
    !Number.isSafeInteger(id) ||
    id <= 0 ||
    (author !== null && !isUser(author)) ||
    typeof snippet !== 'string' ||
    typeof has_media !== 'boolean' ||
    typeof created_at !== 'number' ||
    (body !== undefined && typeof body !== 'string') ||
    (p2p !== undefined && p2p !== true)
  )
    return null
  return {
    ...(typeof body === 'string' ? { body: [...body].slice(0, BODY_MAX).join('') } : {}),
    ...(p2p === true ? { p2p: true } : {}),
    id,
    author:
      author === null
        ? null
        : {
            username: author.username,
            display_name: author.display_name,
            avatar_kind: author.avatar_kind,
            avatar_color: author.avatar_color ?? null,
          },
    snippet: [...snippet].slice(0, 200).join(''),
    has_media,
    created_at,
  }
}

export const forwardValue = (clip: ForwardClip | null) =>
  clip ? JSON.stringify({ v: 1, clip }) : null

// Whether a forward of clip `id` is already queued, sending or failed in this scope's outbox
// (one at a time; a failed one is retried or deleted from its row).
export const forwardPending = (outbox: readonly { msg: Message }[] | undefined, id: number) =>
  !!outbox?.some(o => o.msg.forward?.source_id === id)

// Where a forward came from: "Direct message", "#channel · Server" or "Server". Servers that
// predate the structured fields only send `origin`.
export function forwardOrigin(
  fwd: Pick<ForwardRef, 'origin' | 'origin_dm' | 'origin_channel' | 'origin_server'>
): { label: string; isServer: boolean } | null {
  const { origin_dm, origin_channel, origin_server } = fwd
  if (origin_dm) return { label: 'Direct message', isServer: false }
  if (origin_server)
    return {
      label: origin_channel ? `#${origin_channel} · ${origin_server}` : origin_server,
      isServer: true,
    }
  if (!fwd.origin) return null
  return { label: fwd.origin, isServer: fwd.origin !== 'Direct message' }
}
