import { replaceSpoilers } from './spoilers'
import type { Message, ReplyRef } from './types'

export interface Replying {
  message: Message
  mention: boolean
}

export const replyMentionKey = (username: string) => `rchat_reply_mention:${username}`

export function parseReplyMention(raw: string | null): boolean {
  let data: unknown
  try {
    data = raw ? JSON.parse(raw) : null
  } catch {
    return true
  }
  if (typeof data !== 'object' || data === null) return true
  const { v, mention } = data as Record<string, unknown>
  return v === 1 && typeof mention === 'boolean' ? mention : true
}

export const replyMentionValue = (mention: boolean) => JSON.stringify({ v: 1, mention })

const SNIPPET_MAX = 200
const FENCE = /^(```|~~~)/
const PREFIX = /^(?:-# |>\s*|#{1,6} )/
// eslint-disable-next-line no-control-regex
const HIDDEN = /[\u0000-\u0008\u000E-\u001F\u007F-\u009F\u200E\u200F\u202A-\u202E\u2066-\u2069]/g

const OPEN = '\uE000'
const CLOSE = '\uE001'
const PLAIN = /\\([!-/:-@[-`{-~])|~~|[*`]|[|\\]|\uE000|\uE001/g

const spoilerMarked = (text: string) => replaceSpoilers(text, inner => `${OPEN}${inner}${CLOSE}`)

// Close to the server's `reply_snippet`, for replies still being sent: the first line with
// text, without block markers, emphasis or code marks. Spoilers are wrapped in `||` (closed also
// when cut off); a literal pipe or backslash gets a backslash, so `||` only marks spoilers.
export function plainLine(content: string): string {
  const marked = spoilerMarked(content)
  let at = 0
  for (const raw of marked.split('\n')) {
    const from = at
    at += raw.length + 1
    let line = raw.trim()
    if (!line || FENCE.test(line)) continue
    while (PREFIX.test(line)) line = line.replace(PREFIX, '').trimStart()
    const text = line
      .replace(/\[([^\]\n]*)\]\([^)\n]*\)/g, '$1')
      .replace(/<(https?:\/\/[^>\s]+)>/g, '$1')
      .replace(/(^|[^\p{L}\p{N}_])_+|_+(?![\p{L}\p{N}])/gu, (_, pre?: string) => pre ?? '')
      .replace(PLAIN, (m: string, esc?: string) =>
        esc !== undefined
          ? esc === '|' || esc === '\\'
            ? m
            : esc
          : m === '|' || m === '\\'
            ? `\\${m}`
            : m === OPEN || m === CLOSE
              ? m
              : ''
      )
      .replace(/\s+/g, ' ')
      .replace(HIDDEN, '')
      .trim()
    if (!text.replace(/[\uE000\uE001]/g, '').trim()) continue
    const before = marked.slice(0, from)
    const inside = before.split(OPEN).length > before.split(CLOSE).length
    return closeSnippet(`${inside ? OPEN : ''}${text}`)
  }
  return ''
}

// Cuts to `SNIPPET_MAX` shown characters and turns the spoiler marks into balanced `||`.
const closeSnippet = (text: string) => {
  let out = ''
  let shown = 0
  let opened: number | null = null
  const chars = [...text]
  for (let i = 0; i < chars.length; i += 1) {
    const c = chars[i]
    if (c === OPEN) {
      if (opened === null) {
        opened = out.length
        out += '||'
      }
      continue
    }
    if (c === CLOSE) {
      if (opened !== null) {
        out = out.trimEnd()
        out = out.length === opened + 2 ? out.slice(0, opened) : `${out}||`
        opened = null
      }
      continue
    }
    if (shown === SNIPPET_MAX) break
    out += c === '\\' ? `${c}${chars[++i] ?? ''}` : c
    shown += 1
  }
  out = out.trimEnd()
  if (opened !== null) out = out.length === opened + 2 ? out.slice(0, opened) : `${out}||`
  return out.trimEnd()
}

export const quoteOf = ({ message: m, mention }: Replying, me: string): ReplyRef =>
  quoteFrom(m, mention && m.author.username !== me)

export const canQuote = (m: Message) => m.kind === 'user' || m.kind === 'poll'

const deletedQuote = (id: number, mention: boolean): ReplyRef => ({
  id,
  author: null,
  content: '',
  has_media: false,
  deleted: true,
  mention,
})

// The quote of `ref` built from a loaded copy of the original. Loaded lists only hold what the
// viewer may read, so this shows nothing REST would hide.
const quoteFrom = (original: Message, mention: boolean): ReplyRef => ({
  id: original.id,
  author: original.author,
  content: plainLine(original.content),
  has_media: original.media !== null,
  deleted: false,
  mention,
  ...(original.forward ? { forwarded: true } : {}),
})

// Fills a partial quote (WebSocket events carry only the id): from `known`, a quote already
// resolved for this reply, else from the original if it is loaded and in the same place.
// `null` means it has to be read from the server.
export function fillQuote(
  m: Message,
  known: ReplyRef | undefined,
  original: Message | undefined
): Message | null {
  const ref = m.reply_to
  if (!ref?.partial) return m
  if (known && !known.partial && known.id === ref.id)
    return { ...m, reply_to: { ...known, mention: ref.mention } }
  if (
    original &&
    original.id === ref.id &&
    original.channel_id === m.channel_id &&
    original.dm_id === m.dm_id
  )
    return { ...m, reply_to: quoteFrom(original, ref.mention) }
  return null
}

// The quote a list read returned for reply `id`, or the placeholder if the reply was not in it.
export const fetchedQuote = (list: Message[], id: number, ref: ReplyRef): ReplyRef => {
  const got = list.find(x => x.id === id)?.reply_to
  return got && !got.partial && got.id === ref.id ? got : deletedQuote(ref.id, ref.mention)
}

// The reply pinged `me`: a reply with mention on to a message `me` wrote, by someone else.
export const repliesToMe = (m: Message, me: string | undefined) =>
  me !== undefined &&
  m.author.username !== me &&
  m.reply_to?.mention === true &&
  m.reply_to.deleted === false &&
  m.reply_to.partial !== true &&
  m.reply_to.author?.username === me

export const sendReply = (r: Replying | null | undefined) =>
  r ? { reply_to: r.message.id, mention_reply: r.mention } : {}

export function quoteDeleted(list: Message[], id: number): Message[] {
  if (!list.some(m => m.reply_to?.id === id && !m.reply_to.deleted)) return list
  return list.map(m =>
    m.reply_to?.id === id && !m.reply_to.deleted
      ? { ...m, reply_to: deletedQuote(id, m.reply_to.mention) }
      : m
  )
}

// Shown quotes of a message that was just edited take its new text. Placeholders and partial
// quotes stay as they are: the viewer may not be allowed to see the original.
export const editedQuote = (ref: ReplyRef, edited: Message): ReplyRef =>
  ref.id === edited.id && !ref.deleted && !ref.partial
    ? { ...ref, content: plainLine(edited.content), has_media: edited.media !== null }
    : ref

export function quoteEdited(list: Message[], edited: Message): Message[] {
  if (!list.some(m => m.reply_to && editedQuote(m.reply_to, edited) !== m.reply_to)) return list
  return list.map(m => {
    const ref = m.reply_to && editedQuote(m.reply_to, edited)
    return ref && ref !== m.reply_to ? { ...m, reply_to: ref } : m
  })
}

export interface SnippetPart {
  text: string
  spoiler: boolean
}

// Reads a snippet (`plainLine`, the server's `reply_snippet`): `||` toggles a spoiler, `\\|` and
// `\\\\` are a literal pipe and backslash. An unclosed spoiler runs to the end.
export function snippetParts(text: string): SnippetPart[] {
  const out: SnippetPart[] = []
  let cur = ''
  let spoiler = false
  const flush = () => {
    if (cur) out.push({ text: cur, spoiler })
    cur = ''
  }
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i]
    const next = text[i + 1]
    if (c === '\\' && (next === '|' || next === '\\')) {
      cur += next
      i += 1
    } else if (c === '|' && next === '|') {
      flush()
      spoiler = !spoiler
      i += 1
    } else {
      cur += c
    }
  }
  flush()
  return out
}
