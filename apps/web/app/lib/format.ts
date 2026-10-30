// Markdown formatting for the composer and the edit box: the selection toolbar and its keys.
// Applying a format to text that already has it removes it.

export type Format = 'bold' | 'italic' | 'strike' | 'code' | 'spoiler' | 'quote' | 'link'

export interface FormatEdit {
  text: string
  start: number
  end: number
}

export interface FormatItem {
  format: Format
  label: string
  // Keys as shown, "Mod" being Ctrl (Cmd on Apple devices); `null` when only the toolbar has it.
  keys: string | null
}

// Ctrl/Cmd+Shift+P (asked for spoilers) opens a private window in Firefox and pages can't take
// it, and Mod+Shift+S selects messages, so spoilers are Mod+Shift+H ("hide").
export const FORMATS: FormatItem[] = [
  { format: 'bold', label: 'Bold', keys: 'Mod+B' },
  { format: 'italic', label: 'Italic', keys: 'Mod+I' },
  { format: 'strike', label: 'Strikethrough', keys: 'Mod+Shift+X' },
  { format: 'code', label: 'Code', keys: 'Mod+E' },
  { format: 'spoiler', label: 'Spoiler', keys: 'Mod+Shift+H' },
  { format: 'quote', label: 'Quote', keys: null },
  { format: 'link', label: 'Link', keys: null },
]

export const isApple = () =>
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform ?? '')

export const keysLabel = (keys: string, apple = isApple()) =>
  keys.replaceAll('Mod', apple ? 'Cmd' : 'Ctrl')

type KeyLike = Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'> &
  Partial<Pick<KeyboardEvent, 'code'>>

// The format a key press asks for, if any. Mod is Cmd alone on Apple devices (Ctrl+B and Ctrl+E
// move the caret there) and Ctrl alone elsewhere; on non-Latin layouts the physical key counts.
export const formatKey = (e: KeyLike, apple = isApple()): Format | null => {
  const mod = apple ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey
  if (!mod || e.altKey) return null
  const latin = /^[a-z]$/i.test(e.key)
  const letter = latin ? e.key : (/^Key([A-Z])$/.exec(e.code ?? '')?.[1] ?? e.key)
  const pressed = `Mod+${e.shiftKey ? 'Shift+' : ''}${letter.toUpperCase()}`
  return FORMATS.find(f => f.keys === pressed)?.format ?? null
}

const MARKS: Record<'bold' | 'italic' | 'strike' | 'code' | 'spoiler', string> = {
  bold: '**',
  italic: '*',
  strike: '~~',
  code: '`',
  spoiler: '||',
}

const leading = (s: string, c: string) => s.length - s.replace(new RegExp(`^\\${c}+`), '').length
const trailing = (s: string, c: string) => s.length - s.replace(new RegExp(`\\${c}+$`), '').length

// How many marker characters to strip on each side when `left` and `right` touch the text, or 0
// when the format isn't there. Stars carry both bold and italic (`***x***`).
const wrapped = (format: keyof typeof MARKS, left: number, right: number) => {
  const n = Math.min(left, right)
  if (format === 'bold') return n >= 2 ? 2 : 0
  if (format === 'italic') return n % 2 === 1 ? 1 : 0
  return n >= MARKS[format].length ? MARKS[format].length : 0
}

const edit = (text: string, start: number, end: number, insert: string, sel: [number, number]) => ({
  text: text.slice(0, start) + insert + text.slice(end),
  start: start + sel[0],
  end: start + sel[1],
})

const toggleWrap = (
  text: string,
  start: number,
  end: number,
  format: keyof typeof MARKS
): FormatEdit => {
  const sel = text.slice(start, end)
  if (format === 'code' && sel.includes('\n')) return toggleFence(text, start, end)
  const mark = MARKS[format]
  const c = mark[0]
  const star = c === '*'
  const count = (s: string, from: 'start' | 'end') =>
    star || mark.length === 1
      ? from === 'start'
        ? leading(s, c)
        : trailing(s, c)
      : (from === 'start' ? s.startsWith(mark) : s.endsWith(mark))
        ? mark.length
        : 0
  const inside = wrapped(format, count(sel, 'start'), count(sel, 'end'))
  if (inside && sel.length > inside * 2) {
    const inner = sel.slice(inside, sel.length - inside)
    return edit(text, start, end, inner, [0, inner.length])
  }
  if (format === 'italic' && sel.length > 2 && sel[0] === '_' && sel.endsWith('_')) {
    const inner = sel.slice(1, -1)
    return edit(text, start, end, inner, [0, inner.length])
  }
  const before = text.slice(0, start)
  const after = text.slice(end)
  const outside = wrapped(format, count(before, 'end'), count(after, 'start'))
  if (outside) return edit(text, start - outside, end + outside, sel, [0, sel.length])
  return edit(text, start, end, `${mark}${sel}${mark}`, [mark.length, mark.length + sel.length])
}

const toggleFence = (text: string, start: number, end: number): FormatEdit => {
  const sel = text.slice(start, end)
  const fenced = /^```[^\n`]*\n([\s\S]*)\n```$/.exec(sel)
  if (fenced) return edit(text, start, end, fenced[1], [0, fenced[1].length])
  const open = /```[^\n`]*\n$/.exec(text.slice(0, start))
  if (open && text.slice(end).startsWith('\n```'))
    return edit(text, start - open[0].length, end + 4, sel, [0, sel.length])
  const lead = start > 0 && text[start - 1] !== '\n' ? '\n' : ''
  const tail = end < text.length && text[end] !== '\n' ? '\n' : ''
  const block = `${lead}\`\`\`\n${sel}\n\`\`\`${tail}`
  const at = lead.length + 4
  return edit(text, start, end, block, [at, at + sel.length])
}

const toggleQuote = (text: string, start: number, end: number): FormatEdit => {
  const from = text.lastIndexOf('\n', start - 1) + 1
  const stop = end > start && text[end - 1] === '\n' ? end - 1 : end
  const next = text.indexOf('\n', stop)
  const to = next === -1 ? text.length : next
  const lines = text.slice(from, to).split('\n')
  const quoted = lines.filter(l => l.trim()).every(l => /^ {0,3}>/.test(l))
  const block = lines
    .map(l => (quoted ? l.replace(/^( {0,3})> ?/, '$1') : l.trim() ? `> ${l}` : l))
    .join('\n')
  return edit(text, from, to, block, [0, block.length])
}

const LINK = /^\[([^\]\n]*)\]\(([^)\n]*)\)$/

const toggleLink = (text: string, start: number, end: number): FormatEdit => {
  const sel = text.slice(start, end)
  const link = LINK.exec(sel)
  if (link) return edit(text, start, end, link[1], [0, link[1].length])
  const target = /^\]\([^)\n]*\)/.exec(text.slice(end))
  if (text[start - 1] === '[' && target)
    return edit(text, start - 1, end + target[0].length, sel, [0, sel.length])
  if (/^https?:\/\/\S+$/.test(sel)) return edit(text, start, end, `[](${sel})`, [1, 1])
  const at = sel.length + 3
  return edit(text, start, end, `[${sel}](https://)`, [at, at + 8])
}

// Applies `format` to the selection [start, end) of `text`, or removes it when it is already
// there. Spaces at the selection's ends stay outside the marks (markdown needs that).
export const applyFormat = (
  text: string,
  start: number,
  end: number,
  format: Format
): FormatEdit => {
  let a = Math.max(0, Math.min(start, end, text.length))
  let b = Math.min(Math.max(start, end), text.length)
  if (format === 'quote') return toggleQuote(text, a, b)
  while (a < b && /\s/.test(text[a])) a += 1
  while (b > a && /\s/.test(text[b - 1])) b -= 1
  if (format === 'link') return toggleLink(text, a, b)
  return toggleWrap(text, a, b, format)
}
