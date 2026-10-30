import type { AvatarKind, Message, RichEmbed, UserRef } from './types'

// Author keys of incoming webhooks start with `@`, which usernames cannot contain.
const PREFIX = '@webhook:'

export const isWebhookAuthor = (username: string | null | undefined) =>
  typeof username === 'string' && username.startsWith(PREFIX)

export const webhookIdOf = (username: string): number | null => {
  if (!isWebhookAuthor(username)) return null
  const id = Number(username.slice(PREFIX.length))
  return Number.isSafeInteger(id) && id > 0 ? id : null
}

export const isWebhookMessage = (m: Pick<Message, 'author' | 'webhook'>) =>
  !!m.webhook || isWebhookAuthor(m.author.username)

export interface Webhook {
  id: number
  channel_id: number
  name: string
  avatar_kind: AvatarKind
  avatar_color: string | null
  creator: UserRef | null
  mentions: boolean
  created_at: number
  last_used_at: number | null
}

export interface WebhookSecret extends Webhook {
  token: string
  path: string
}

export interface OutgoingWebhook {
  id: number
  name: string
  url: string
  events: string[]
  creator: UserRef | null
  enabled: boolean
  disabled_at: number | null
  disabled_reason: 'failures' | 'owner' | null
  failures: number
  created_at: number
}

export interface OutgoingSecret extends OutgoingWebhook {
  secret: string
}

export interface OutgoingList {
  available: boolean
  webhooks: OutgoingWebhook[]
}

export interface Delivery {
  id: number
  event: string
  status: 'pending' | 'delivered' | 'failed'
  attempts: number
  last_code: number | null
  last_ms: number | null
  last_error: string | null
  created_at: number
  next_at: number | null
  finished_at: number | null
}

export const OUTGOING_EVENTS: { key: string; label: string }[] = [
  { key: 'message.created', label: 'Message sent' },
  { key: 'message.updated', label: 'Message edited' },
  { key: 'message.deleted', label: 'Message deleted' },
  { key: 'member.joined', label: 'Member joined' },
  { key: 'member.left', label: 'Member left' },
  { key: 'reaction.added', label: 'Reaction added' },
  { key: 'reaction.removed', label: 'Reaction removed' },
  { key: 'poll.ended', label: 'Poll ended' },
]

export const eventLabel = (key: string) =>
  OUTGOING_EVENTS.find(e => e.key === key)?.label ?? (key === 'ping' ? 'Test' : key)

export const WEBHOOK_NAME_MAX = 80
export const CHANNEL_WEBHOOKS_MAX = 15
export const SERVER_WEBHOOKS_MAX = 100
export const OUTGOING_MAX = 10

// The full URL to post to, from the path the server returns once.
export const webhookUrl = (origin: string, path: string) => `${origin.replace(/\/+$/, '')}${path}`

// A local check of a webhook name, before the server applies its own (it also refuses names
// of people in the server).
export function nameProblem(name: string): string | null {
  const t = name.trim()
  if (!t) return 'Name is required'
  if ([...t].length > WEBHOOK_NAME_MAX) return `Name must be at most ${WEBHOOK_NAME_MAX} characters`
  if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(t)) return 'Name has invalid characters'
  if (t.normalize('NFKC').replace(/\s+/g, ' ').toLowerCase() === 'instance staff')
    return 'Pick another name'
  return null
}

// Changes to someone else's webhook that set what it receives or can do make you its owner.
export const takesOver = (owner: UserRef | null, me: string | null | undefined) =>
  !owner || !me || owner.username.toLowerCase() !== me.toLowerCase()

export const OWNER_NOTE = 'You will become the owner of this webhook.'

// Whether an outgoing edit changes what it receives: its URL or its events.
export function outgoingReach(
  before: Pick<OutgoingWebhook, 'url' | 'events'>,
  after: { url: string; events: string[] }
): boolean {
  const same = (a: string[], b: string[]) =>
    a.length === b.length && [...a].sort().join(' ') === [...b].sort().join(' ')
  return after.url.trim() !== before.url || !same(before.events, after.events)
}

// A local check of an outgoing URL; the server also checks the address it resolves to.
export function urlProblem(raw: string): string | null {
  const t = raw.trim()
  if (!t) return 'URL is required'
  let url: URL
  try {
    url = new URL(t)
  } catch {
    return 'Enter a full URL, like https://example.com/hook'
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return 'URL must use https'
  if (url.username || url.password) return 'URL must not contain credentials'
  if (url.hash) return 'URL must not contain a fragment'
  return null
}

export const embedColor = (c: number | null | undefined) =>
  typeof c === 'number' && Number.isInteger(c) && c >= 0 && c <= 0xffffff
    ? `#${c.toString(16).padStart(6, '0')}`
    : null

// Only http(s) links are ever rendered as links.
export const safeLink = (url: string | null | undefined): string | null => {
  if (!url) return null
  try {
    const u = new URL(url)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null
  } catch {
    return null
  }
}

export const hasEmbeds = (
  m: Pick<Message, 'webhook'>
): m is { webhook: { id: number; embeds: RichEmbed[] } } =>
  !!m.webhook && m.webhook.embeds.length > 0

// Inline fields sit side by side, up to three per row; others take a full row.
export function fieldRows<T extends { inline?: boolean }>(fields: T[]): T[][] {
  const rows: T[][] = []
  for (const f of fields) {
    const last = rows[rows.length - 1]
    if (f.inline && last && last.length < 3 && last.every(x => x.inline)) last.push(f)
    else rows.push([f])
  }
  return rows
}

export const deliveryText = (d: Delivery): string => {
  const code = d.last_code !== null ? `HTTP ${d.last_code}` : null
  const time = d.last_ms !== null ? `${d.last_ms} ms` : null
  const parts = [code, time].filter((x): x is string => x !== null)
  if (d.status === 'delivered') return parts.join(', ') || 'Delivered'
  if (d.status === 'pending')
    return d.attempts === 0
      ? 'Waiting'
      : `Retrying (${d.attempts} tries)${d.last_error ? `: ${d.last_error}` : ''}`
  return `Failed after ${d.attempts} ${d.attempts === 1 ? 'try' : 'tries'}${d.last_error ? `: ${d.last_error}` : ''}`
}
