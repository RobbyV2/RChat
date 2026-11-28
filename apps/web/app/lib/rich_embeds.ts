import { isRecord } from './bytes'
import { embedColor } from './webhooks'
import type { EmbedField, Message, RichEmbed } from './types'

// Rich embeds (cards) members attach to messages, on hosted servers and in P2P rooms and DMs
// alike: the limits and checks the server applies (`rich_embeds.rs`, in the same order and
// words, held together by `assets/rich_embed_cases.json`), the reading of cards off P2P events,
// and the builder's draft.

export const EMBEDS_MAX = 5
export const TITLE_MAX = 256
export const DESCRIPTION_MAX = 4096
export const AUTHOR_MAX = 256
export const FIELDS_MAX = 25
export const FIELD_NAME_MAX = 256
export const FIELD_VALUE_MAX = 1024
export const FOOTER_MAX = 2048
export const URL_MAX = 2048
export const TEXT_MAX = 6000
export const TIMESTAMP_MAX = 253_402_300_799
export const COLOR_MAX = 0xffffff

const chars = (s: string) => Array.from(s).length

const blank = (s: string) => /^\p{White_Space}*$/u.test(s)

export const isWebUrl = (raw: string) => {
  if (chars(raw) > URL_MAX) return false
  try {
    const u = new URL(raw)
    return (u.protocol === 'http:' || u.protocol === 'https:') && u.hostname !== ''
  } catch {
    return false
  }
}

const tooLong = (what: string, max: number) => `${what} must be at most ${max} characters`

// The first problem of one embed, with the characters it counts toward `TEXT_MAX`.
const embedCheck = (e: RichEmbed): { problem: string | null; count: number } => {
  const texts: [string, number, string][] = []
  const { title, description, url, color, fields = [], footer, author, timestamp } = e
  const fail = (problem: string) => ({ problem, count: 0 })
  if (typeof title === 'string') texts.push([title, TITLE_MAX, 'Embed title'])
  if (typeof description === 'string')
    texts.push([description, DESCRIPTION_MAX, 'Embed description'])
  if (author) {
    if (blank(author.name)) return fail('Embed author is empty')
    texts.push([author.name, AUTHOR_MAX, 'Embed author'])
  }
  if (fields.length > FIELDS_MAX) return fail(`At most ${FIELDS_MAX} embed fields`)
  for (const f of fields) {
    if (blank(f.name) || blank(f.value)) return fail('Embed fields need a name and a value')
    texts.push([f.name, FIELD_NAME_MAX, 'Embed field name'])
    texts.push([f.value, FIELD_VALUE_MAX, 'Embed field value'])
  }
  if (footer) {
    if (blank(footer.text)) return fail('Embed footer is empty')
    texts.push([footer.text, FOOTER_MAX, 'Embed footer'])
  }
  if (typeof url === 'string' && !isWebUrl(url))
    return fail('Embed url must be an http or https link')
  if (typeof author?.url === 'string' && !isWebUrl(author.url))
    return fail('Embed author url must be an http or https link')
  if (typeof color === 'number' && !(Number.isInteger(color) && color >= 0 && color <= COLOR_MAX))
    return fail('Embed color must be between 0 and 16777215')
  if (
    typeof timestamp === 'number' &&
    !(Number.isInteger(timestamp) && timestamp >= 0 && timestamp <= TIMESTAMP_MAX)
  )
    return fail('Embed timestamp is out of range')
  const shown =
    (typeof title === 'string' && !blank(title)) ||
    (typeof description === 'string' && !blank(description)) ||
    !!author ||
    fields.length > 0 ||
    !!footer
  if (!shown) return fail('Embed is empty')
  let count = 0
  for (const [text, max, what] of texts) {
    const n = chars(text)
    if (n > max) return fail(tooLong(what, max))
    count += n
  }
  return { problem: null, count }
}

// The first problem of a message's embeds, as the server words it; null when they can be sent.
export const embedsProblem = (list: readonly RichEmbed[], max = EMBEDS_MAX): string | null => {
  if (list.length > max) return `At most ${max} embeds`
  let total = 0
  for (const e of list) {
    const { problem, count } = embedCheck(e)
    if (problem) return problem
    total += count
  }
  return total > TEXT_MAX ? `Embeds must have at most ${TEXT_MAX} characters in total` : null
}

export const embedProblem = (e: RichEmbed) => embedCheck(e).problem

const optString = (x: unknown) => x === undefined || x === null || typeof x === 'string'

const fieldOf = (x: unknown): EmbedField | null =>
  isRecord(x) &&
  typeof x.name === 'string' &&
  typeof x.value === 'string' &&
  (x.inline === undefined || typeof x.inline === 'boolean')
    ? { name: x.name, value: x.value, ...(x.inline === true ? { inline: true } : {}) }
    : null

// One embed as an event carries it, by its known fields (others are left out); null when one of
// them is malformed or it breaks a limit.
const embedOf = (x: unknown): RichEmbed | null => {
  if (!isRecord(x)) return null
  const { title, description, url, color, fields, footer, author, timestamp } = x
  if (![title, description, url].every(optString)) return null
  if (color !== undefined && color !== null && typeof color !== 'number') return null
  if (timestamp !== undefined && timestamp !== null && typeof timestamp !== 'number') return null
  if (fields !== undefined && !Array.isArray(fields)) return null
  const read = (fields ?? []).map(fieldOf)
  if (read.some(f => f === null)) return null
  if (
    footer !== undefined &&
    footer !== null &&
    !(isRecord(footer) && typeof footer.text === 'string')
  )
    return null
  if (
    author !== undefined &&
    author !== null &&
    !(isRecord(author) && typeof author.name === 'string' && optString(author.url))
  )
    return null
  const e: RichEmbed = {
    ...(typeof title === 'string' ? { title } : {}),
    ...(typeof description === 'string' ? { description } : {}),
    ...(typeof url === 'string' ? { url } : {}),
    ...(typeof color === 'number' ? { color } : {}),
    ...(read.length ? { fields: read as EmbedField[] } : {}),
    ...(isRecord(footer) ? { footer: { text: footer.text as string } } : {}),
    ...(isRecord(author)
      ? {
          author: {
            name: author.name as string,
            ...(typeof author.url === 'string' ? { url: author.url } : {}),
          },
        }
      : {}),
    ...(typeof timestamp === 'number' ? { timestamp } : {}),
  }
  return embedProblem(e) === null ? e : null
}

// The embeds of a P2P message (`emb`), read only when shown: malformed ones are left out, and
// the rest only as far as the count and the total length allow.
export const readEmbeds = (x: unknown, max = EMBEDS_MAX): RichEmbed[] => {
  if (!Array.isArray(x)) return []
  const out: RichEmbed[] = []
  let total = 0
  for (const item of x) {
    if (out.length === max) break
    const e = embedOf(item)
    if (!e) continue
    const count = embedCheck(e).count
    if (total + count > TEXT_MAX) break
    total += count
    out.push(e)
  }
  return out
}

// An embed as it is sent: only the parts that are set, without blank optional text.
export const wireEmbed = (e: RichEmbed): RichEmbed => {
  const s = (x: string | null | undefined) => (typeof x === 'string' && x !== '' ? x : undefined)
  const title = s(e.title)
  const description = s(e.description)
  const url = s(e.url)
  const authorUrl = s(e.author?.url)
  return {
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
    ...(url ? { url } : {}),
    ...(typeof e.color === 'number' ? { color: e.color } : {}),
    ...(e.author
      ? { author: { name: e.author.name, ...(authorUrl ? { url: authorUrl } : {}) } }
      : {}),
    ...(e.fields?.length
      ? {
          fields: e.fields.map(f => ({
            name: f.name,
            value: f.value,
            ...(f.inline ? { inline: true } : {}),
          })),
        }
      : {}),
    ...(e.footer ? { footer: { text: e.footer.text } } : {}),
    ...(typeof e.timestamp === 'number' ? { timestamp: e.timestamp } : {}),
  }
}

const FALLBACK_MAX = 200

// The text a P2P message with embeds and no text of its own carries, so a version that shows no
// cards shows something: the first embed's title, author, description, first field or footer.
export const embedFallback = (list: readonly RichEmbed[]): string => {
  const e = list[0]
  if (!e) return ''
  const first = [e.title, e.author?.name, e.description, e.fields?.[0]?.name, e.footer?.text]
    .map(t => (typeof t === 'string' ? t.trim() : ''))
    .find(t => t !== '')
  return Array.from(first ?? '')
    .slice(0, FALLBACK_MAX)
    .join('')
}

// What a P2P message sends as its text: its own, or the fallback when it has only embeds.
export const sentBody = (text: string, list: readonly RichEmbed[]) =>
  text.trim() === '' && list.length ? embedFallback(list) : text

// What a P2P message shows as its text: nothing when it is the fallback of the embeds it shows.
export const shownBody = (body: string, list: readonly RichEmbed[]) =>
  list.length && body === embedFallback(list) ? '' : body

// The builder's form. `color` is `#rrggbb` or null; `stamped` shows a time, `at` when it was set
// (Unix seconds), kept when an embed is edited.
export interface EmbedDraft {
  title: string
  url: string
  author: string
  authorUrl: string
  description: string
  color: string | null
  fields: { name: string; value: string; inline: boolean }[]
  footer: string
  stamped: boolean
  at: number | null
}

export const emptyDraft = (): EmbedDraft => ({
  title: '',
  url: '',
  author: '',
  authorUrl: '',
  description: '',
  color: null,
  fields: [],
  footer: '',
  stamped: false,
  at: null,
})

export const hexColor = (hex: string | null) =>
  hex !== null && /^#[0-9a-f]{6}$/i.test(hex) ? parseInt(hex.slice(1), 16) : undefined

export const draftOf = (e: RichEmbed): EmbedDraft => ({
  title: e.title ?? '',
  url: e.url ?? '',
  author: e.author?.name ?? '',
  authorUrl: e.author?.url ?? '',
  description: e.description ?? '',
  color: embedColor(e.color),
  fields: (e.fields ?? []).map(f => ({ name: f.name, value: f.value, inline: !!f.inline })),
  footer: e.footer?.text ?? '',
  stamped: typeof e.timestamp === 'number',
  at: typeof e.timestamp === 'number' ? e.timestamp : null,
})

// The embed a draft makes, at `now` (Unix seconds) for a new time. Empty text is left out, so
// a draft with nothing in it makes an embed that `embedProblem` calls empty.
export const embedOfDraft = (d: EmbedDraft, now: number): RichEmbed => {
  const t = (s: string) => s.trim()
  return wireEmbed({
    title: t(d.title),
    url: t(d.url),
    description: d.description.trim() === '' ? '' : d.description,
    color: hexColor(d.color),
    author: t(d.author) ? { name: t(d.author), url: t(d.authorUrl) } : null,
    fields: d.fields.map(f => ({ name: t(f.name), value: f.value.trim(), inline: f.inline })),
    footer: t(d.footer) ? { text: t(d.footer) } : null,
    timestamp: d.stamped ? (d.at ?? now) : undefined,
  })
}

// A field moved by `by` places (up is negative), kept within the list.
export const movedField = <T>(list: readonly T[], at: number, by: number): T[] => {
  const to = Math.max(0, Math.min(list.length - 1, at + by))
  if (to === at || at < 0 || at >= list.length) return [...list]
  const out = [...list]
  const [f] = out.splice(at, 1)
  out.splice(to, 0, f)
  return out
}

type Carded = Pick<Message, 'rich_embeds' | 'webhook'>

// A message's rich embeds: its own, or a webhook's as an older server sends them.
export const cardsOf = (m: Carded): RichEmbed[] => m.rich_embeds ?? m.webhook?.embeds ?? []

// `m` without its rich embed at `index`.
export const withoutCard = <M extends Carded>(m: M, index: number): M => {
  const list = cardsOf(m).filter((_, i) => i !== index)
  return {
    ...m,
    rich_embeds: list,
    ...(m.webhook ? { webhook: { ...m.webhook, embeds: list } } : {}),
  }
}

// Why the last embed can't be taken off a message.
export const EMPTY_LEFT = 'This would leave the message empty'

// A short name of an embed for its chip above the composer.
export const embedLabel = (e: RichEmbed) => embedFallback([e]) || 'Embed'

// The embeds a P2P message shows: those of its latest edit when the edit carries `emb`, else its
// own. Read only when shown, like the descriptions of its files.
export const shownEmbeds = (msg: unknown, edit: unknown): RichEmbed[] =>
  isRecord(edit) && Object.hasOwn(edit, 'emb')
    ? readEmbeds(edit.emb)
    : isRecord(msg)
      ? readEmbeds(msg.emb)
      : []

// What a P2P message or edit carries for `list`: nothing without embeds.
export const embField = (list: readonly RichEmbed[]): { emb?: RichEmbed[] } =>
  list.length ? { emb: list.map(wireEmbed) } : {}
