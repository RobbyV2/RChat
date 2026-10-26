import type { Channel } from './types'

export const NAME_MAX = 100
export const MESSAGE_MAX = 4000
export const SLOWMODE_MAX = 21600

export const charCount = (text: string) => Array.from(text).length

export const canDeleteChannel = (channels: Channel[], channel: Channel) =>
  channels.length > 1 &&
  (channel.kind !== 'text' || channels.filter(c => c.kind === 'text').length > 1)

export const serverInitial = (name: string) => {
  const trimmed = name.trim()
  const first =
    typeof Intl !== 'undefined' && 'Segmenter' in Intl
      ? new Intl.Segmenter().segment(trimmed)[Symbol.iterator]().next().value?.segment
      : Array.from(trimmed)[0]
  return first ? first.toUpperCase() : '?'
}

export const sameOriginImage = (src: string | undefined, base: string, origins: string[]) => {
  if (!src) return false
  try {
    const url = new URL(src, base)
    return (url.protocol === 'http:' || url.protocol === 'https:') && origins.includes(url.origin)
  } catch {
    return false
  }
}
