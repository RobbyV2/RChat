import { shareOrigin } from './instances'
import { visibleLinks } from './invite'
import type { Message, MessageLocation } from './types'
import { messagePath, parsePath, type MessageTarget } from './view'

// `{origin}/s/{server}/{channel}/{id}/`, `{origin}/s/{server}/{channel}/t/{root}/{id}/` for
// thread replies and `{origin}/dm/{dm}/{id}/`. Null when the message's place isn't known.
export const messageLinkUrl = (
  m: Pick<Message, 'id' | 'channel_id' | 'dm_id' | 'thread_root_id'>,
  server: string | null,
  origin = shareOrigin()
) => {
  const { id, channel_id, dm_id, thread_root_id } = m
  if (dm_id !== null)
    return `${origin}${messagePath({ place: { kind: 'dm', dmId: dm_id }, thread: null, id })}`
  if (channel_id === null || server === null) return null
  const place = { kind: 'channel' as const, server, channelId: channel_id }
  return `${origin}${messagePath({ place, thread: thread_root_id, id })}`
}

export const parseMessageLink = (href: string, origins: string[]): MessageTarget | null => {
  let url: URL
  try {
    url = new URL(href)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (url.username || url.password || !origins.includes(url.origin)) return null
  const target = parsePath(url.pathname)
  return target?.kind === 'message' ? target : null
}

export const findMessageLinks = (text: string, origins: string[], max = 3): MessageTarget[] => {
  const out: MessageTarget[] = []
  for (const url of visibleLinks(text)) {
    const target = parseMessageLink(url, origins)
    if (!target || out.some(o => o.id === target.id)) continue
    out.push(target)
    if (out.length === max) break
  }
  return out
}

export type CardLabel = 'pin' | 'call' | 'forward'

// What a link card shows instead of a text snippet: pin notices and call logs have no text, and a
// forward without text or attachment says so. `forwarded` marks a forward that still shows its text.
export const cardLabel = (
  card: Pick<MessageLocation, 'kind' | 'forwarded' | 'content' | 'has_media'>
): { label: CardLabel; text: string } | { label: null; forwarded: boolean } => {
  if (card.kind === 'pin') return { label: 'pin', text: 'Pinned a message' }
  if (card.kind === 'call') return { label: 'call', text: 'Call' }
  if (card.forwarded && !card.content && !card.has_media)
    return { label: 'forward', text: 'Forwarded message' }
  return { label: null, forwarded: card.forwarded }
}
