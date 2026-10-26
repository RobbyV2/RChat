export interface MentionPart {
  text: string
  mention: boolean
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const mentionRe = (username: string) =>
  new RegExp(`(?<![\\p{L}\\p{N}\\p{M}_])@${escapeRe(username)}(?![\\p{L}\\p{N}\\p{M}_])`, 'giu')

export const mentionsUser = (content: string, username: string): boolean =>
  username !== '' && mentionRe(username).test(content)

export const splitMentions = (text: string, username: string): MentionPart[] => {
  if (!username) return [{ text, mention: false }]
  const parts: MentionPart[] = []
  let last = 0
  for (const m of text.matchAll(mentionRe(username))) {
    const at = m.index ?? 0
    if (at > last) parts.push({ text: text.slice(last, at), mention: false })
    parts.push({ text: m[0], mention: true })
    last = at + m[0].length
  }
  if (last < text.length || parts.length === 0)
    parts.push({ text: text.slice(last), mention: false })
  return parts
}
