import type { Message } from './types'

export interface Sed {
  find: string
  replace: string
  global: boolean
}

// Splits on `/`, where `\/` is a literal slash; any other backslash stays as it is.
function slashParts(text: string): string[] {
  const parts: string[] = []
  let cur = ''
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i]
    if (c === '\\' && text[i + 1] === '/') {
      cur += '/'
      i += 1
    } else if (c === '/') {
      parts.push(cur)
      cur = ''
    } else cur += c
  }
  parts.push(cur)
  return parts
}

// Discord's `s/old/new` (also `s/old/new/` and `s/old/new/g`) on one line. `null` when the text
// is not one, so it is sent as a normal message.
export function parseSed(text: string): Sed | null {
  const line = text.trim()
  if (!line.startsWith('s/') || line.includes('\n')) return null
  const parts = slashParts(line.slice(2))
  if (parts.length < 2 || parts.length > 3) return null
  const [find, replace, flags = ''] = parts
  if (!find || (flags !== '' && flags !== 'g')) return null
  return { find, replace, global: flags === 'g' }
}

// The text with the first (or with `g` every) literal occurrence replaced; `null` without one.
export function applySed(content: string, { find, replace, global }: Sed): string | null {
  const at = content.indexOf(find)
  if (at === -1) return null
  if (global) return content.split(find).join(replace)
  return content.slice(0, at) + replace + content.slice(at + find.length)
}

export const canEdit = (m: Message, me: string | undefined) =>
  me !== undefined && m.kind === 'user' && m.author.username === me

// The newest message `me` can edit in a loaded list, then in `fallback` (a thread's root).
export function lastEditable(
  list: Message[],
  me: string | undefined,
  fallback?: Message | null
): Message | null {
  for (let i = list.length - 1; i >= 0; i -= 1) if (canEdit(list[i], me)) return list[i]
  return fallback && canEdit(fallback, me) ? fallback : null
}
