import { plainLine } from './replies'
import { LIMITS, isEventId, type Fwd, type FwdSrc } from './p2p/content'
import { readableNow } from './public_reading'
import type { RChatState } from './store_types'
import type { Message, SiteSettings, UserRef } from './types'
import { defineSetting } from './settings'

// The forward clipboard: one copied message per account, kept until it is sent or dismissed.
export type ForwardSource =
  | { kind: 'direct'; identity?: string }
  | { kind: 'channel'; id: number; server?: string }
  | { kind: 'p2p'; room: string; ch: string; identity?: string }

export interface ForwardClip {
  source?: ForwardSource
  quoted?: ForwardSource
  id: number
  author: UserRef | null
  snippet: string
  has_media: boolean
  has_poll?: true
  created_at: number
  // The whole text, for forwards into P2P conversations (which copy it).
  body?: string
  // Copied from a P2P conversation: `id` is local, there is no instance message to point at.
  p2p?: boolean
  // The P2P message's event id, which members who have it can find, and when its original was
  // sent (ms, as its author's device signed it).
  ev?: string
  sent_ts?: number
}

export const BODY_MAX = 4000

export const forwardKey = (username: string) => `rchat_forward:${username}`

export const canForward = (m: Message) => (m.kind === 'user' || m.kind === 'poll') && m.id > 0

// The original author and time travel with forwards of forwards (the server does the same).
export const clipOf = (m: Message, server?: string): ForwardClip => ({
  source:
    m.channel_id == null
      ? { kind: 'direct' }
      : { kind: 'channel', id: m.channel_id, ...(server ? { server } : {}) },
  id: m.id,
  author: m.forward ? m.forward.author : m.author,
  snippet: plainLine(m.content),
  ...(m.poll || m.kind === 'poll' ? { has_poll: true as const } : {}),
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

const isSource = (value: unknown): value is ForwardSource => {
  if (!value || typeof value !== 'object' || !('kind' in value)) return false
  if (
    'identity' in value &&
    (typeof value.identity !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(value.identity))
  )
    return false
  if (value.kind === 'direct') return true
  if (value.kind === 'channel')
    return (
      'id' in value &&
      typeof value.id === 'number' &&
      Number.isSafeInteger(value.id) &&
      value.id > 0 &&
      (!('server' in value) || typeof value.server === 'string')
    )
  return (
    value.kind === 'p2p' &&
    'room' in value &&
    typeof value.room === 'string' &&
    'ch' in value &&
    typeof value.ch === 'string'
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
  const { id, author, snippet, has_media, created_at, body, p2p, source, quoted, ev, sent_ts } =
    clip as Record<string, unknown>
  if (
    !isSource(source) ||
    (quoted !== undefined && !isSource(quoted)) ||
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
    source,
    ...(quoted ? { quoted } : {}),
    ...(typeof body === 'string' ? { body: [...body].slice(0, BODY_MAX).join('') } : {}),
    ...(p2p === true ? { p2p: true } : {}),
    ...(isEventId(ev) ? { ev } : {}),
    ...(typeof sent_ts === 'number' && Number.isSafeInteger(sent_ts) && sent_ts >= 0
      ? { sent_ts }
      : {}),
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
    ...((clip as Record<string, unknown>).has_poll === true ? { has_poll: true as const } : {}),
    created_at,
  }
}

export const forwardValue = (clip: ForwardClip | null) =>
  clip ? JSON.stringify({ v: 1, clip }) : null

export const forwardSetting = defineSetting<ForwardClip | null, [string]>({
  scope: 'account',
  key: forwardKey,
  decode: parseForward,
  encode: forwardValue,
})

// Whether a forward of clip `id` is already queued, sending or failed in this scope's outbox
// (one at a time; a failed one is retried or deleted from its row).
export const forwardPending = (outbox: readonly { msg: Message }[] | undefined, id: number) =>
  !!outbox?.some(o => o.msg.forward?.source_id === id)

// Where a forward goes: an instance channel or thread (its server) or DM (null), or a P2P
// conversation or server channel.
export type ForwardDestination =
  { kind: 'instance'; server: string | null } | { kind: 'p2p'; room: string; ch: string | null }

type Site = Pick<SiteSettings, 'server_joining' | 'public_reading' | 'guests_enabled'>

// The server of an instance draft: a channel's, a thread's (its root's channel), none for a DM.
export const instanceServer = (
  s: Pick<RChatState, 'servers' | 'panel' | 'view'>,
  key: string
): string | null => {
  const id = key.startsWith('c')
    ? Number(key.slice(1))
    : s.panel?.kind === 'thread' && key === `t${s.panel.root.id}`
      ? s.panel.root.channel_id
      : null
  if (key.startsWith('d')) return null
  const found =
    id == null
      ? undefined
      : Object.values(s.servers).find(d => d.channels.some(c => c.id === id))?.name
  return found ?? (s.view?.kind === 'channel' ? s.view.server : null)
}

// A P2P draft key: a conversation's room, or a server channel or thread in it.
export const p2pDestination = (key: string): ForwardDestination => {
  const [room, ch] = key.split('#')[0].split('/')
  return { kind: 'p2p', room, ch: ch || null }
}

const serverOf = (s: Pick<RChatState, 'servers'>, source: ForwardSource & { kind: 'channel' }) =>
  Object.values(s.servers).find(d => d.channels.some(c => c.id === source.id))?.name ??
  source.server

// Whether "Show where it's from" starts on, or null when there is no choice: a direct message
// always says it is one, and a P2P message copied to the instance carries nothing.
export const forwardSourceDefault = (
  clip: Pick<ForwardClip, 'source'>,
  destination: ForwardDestination,
  s: Pick<RChatState, 'servers'>,
  site: Site
): boolean | null => {
  const source = clip.source
  if (!source || source.kind === 'direct') return null
  if (source.kind === 'p2p')
    return destination.kind === 'p2p'
      ? destination.room === source.room && destination.ch !== null
      : null
  const server = serverOf(s, source)
  if (destination.kind === 'instance' && server && server === destination.server) return true
  const d = server ? s.servers[server] : undefined
  return d ? readableNow(d.public_read ?? null, d.has_password, site) : false
}

// Where a clip is from as its sender sees it. `restricted`: not everyone in the server sees the
// channel, so its name stays inside.
export interface SourceNames {
  server: string
  channel: string | null
  restricted: boolean
}

// An instance channel as the server says a forward that shows its source would name it.
export const hostedSourceNames = (
  shown: { server: string; channel?: string } | null
): SourceNames | null =>
  shown
    ? { server: shown.server, channel: shown.channel ?? null, restricted: !shown.channel }
    : null

interface P2pServerSource {
  name: string
  channels: readonly { id: string; name: string; everyoneSees: boolean }[]
}

export const p2pSourceNames = (v: P2pServerSource | undefined, ch: string): SourceNames | null => {
  if (!v) return null
  const c = v.channels.find(x => x.id === ch)
  return { server: v.name, channel: c?.name ?? null, restricted: !c?.everyoneSees }
}

// What the copy says of where it's from: a direct message always says so, a room or server only
// when its sender shows it, its channel only when everyone there sees it.
export const shownSource = (names: SourceNames | null, show: boolean) =>
  show && names ? { server: names.server, channel: names.restricted ? null : names.channel } : null

const clipped = (name: string) => [...name].slice(0, LIMITS.name).join('')

export const fwdSource = (
  source: ForwardSource | undefined,
  names: SourceNames | null,
  show: boolean
): FwdSrc | undefined => {
  if (!source) return undefined
  if (source.kind === 'direct') return { dm: true }
  const shown = shownSource(names, show)
  if (!shown?.server.trim()) return undefined
  const cn = shown.channel?.trim() ? clipped(shown.channel) : null
  return { rn: clipped(shown.server), ...(cn ? { cn } : {}) }
}

// A P2P copy of a clip: its author's name, time and text, the original's event id and where
// it's from as `src` says.
export const p2pForward = (clip: ForwardClip, src: FwdSrc | undefined): Fwd => ({
  name: clip.author?.display_name ?? 'Deleted user',
  ts: clip.sent_ts ?? clip.created_at * 1000,
  body: clip.body ?? clip.snippet,
  ...(clip.ev ? { ev: clip.ev } : {}),
  ...(src ? { src } : {}),
})
