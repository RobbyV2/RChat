import { charCount, cleanBio } from './rules'

export const TOPIC_MAX = 1024

const TOPIC_WARN = 50

export const cleanTopic = cleanBio

export const topicError = (text: string) =>
  charCount(cleanTopic(text)) > TOPIC_MAX ? `Topic must be at most ${TOPIC_MAX} characters` : null

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

export const topicAnnouncement = (count: number, saved: boolean) => {
  if (saved) return 'Topic saved'
  const left = TOPIC_MAX - count
  if (left < 0) return `${plural(-left, 'character')} over the limit`
  if (left <= TOPIC_WARN) return `${plural(left, 'character')} left`
  return ''
}

// One line for the channel header: every run of whitespace, newlines included, becomes a space.
export const topicLine = (topic: string) => topic.replace(/\s+/g, ' ').trim()

export type TopicPart = { text: string; href?: undefined } | { text: string; href: string }

const URL_RE = /https?:\/\/[^\s<>"'`]+/gi
const TRAIL = /[)\]}>.,;:!?*_~|'"]+$/

const safeHref = (raw: string) => {
  try {
    const url = new URL(raw)
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname ? raw : null
  } catch {
    return null
  }
}

// Plain text with http(s) links found, the way a message autolinks them. No markdown.
export const topicParts = (topic: string): TopicPart[] => {
  const parts: TopicPart[] = []
  let at = 0
  const push = (text: string) => {
    if (!text) return
    const last = parts[parts.length - 1]
    if (last && last.href === undefined) last.text += text
    else parts.push({ text })
  }
  for (const match of topic.matchAll(URL_RE)) {
    const start = match.index
    const url = match[0].replace(TRAIL, '')
    const href = safeHref(url)
    push(topic.slice(at, start))
    if (href) parts.push({ text: url, href })
    else push(url)
    at = start + url.length
  }
  push(topic.slice(at))
  return parts
}
