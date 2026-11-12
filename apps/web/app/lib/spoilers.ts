// `||spoilers||` in message markdown. One reader for everything: the message view, every
// preview (replies, forwards, link cards, search, toasts) and, ported to Rust with the same
// fixture (`__tests__/fixtures/spoilers.json`), the server's link preview fetcher
// (`apps/server/src/spoilers.rs`). Rules:
// - `||` opens and the next `||` closes; an empty pair (`||||`) and an unclosed `||` are text.
// - Code is never a spoiler marker: fenced and indented code blocks and inline code. Inline code
//   may sit inside a spoiler.
// - `\|` is a literal pipe (markdown escapes), so `\||` is text.
// - A spoiler may span lines, never a blank line or a code block.

export interface SpoilerSpan {
  // Index of the opening `||`.
  start: number
  // Index just after the closing `||`, or the text's end for a spoiler cut off by an excerpt.
  end: number
  closed: boolean
}

export interface SpoilerPart {
  text: string
  spoiler: boolean
}

const FENCE = /^(?: {0,3}>)* {0,3}(`{3,}|~{3,})(.*)$/
const LIST_ITEM = /^ {0,3}(?:[-+*]|\d{1,9}[.)])(?:\s|$)/
const BREAK = /^[\s>]*$/
const PUNCT = /[!-/:-@[-`{-~]/

interface Run {
  start: number
  end: number
}

// Stretches of text between blank lines and code blocks, as [start, end) indices.
const textRuns = (text: string): Run[] => {
  const runs: Run[] = []
  let fence: string | null = null
  let indented = false
  let list = false
  let blank = true
  let run: Run | null = null
  let at = 0
  const stop = () => {
    if (run) runs.push(run)
    run = null
  }
  for (const line of text.split('\n')) {
    const from = at
    at += line.length + 1
    const open = line.match(FENCE)
    if (fence !== null) {
      const [, marks = '', rest = ''] = open ?? []
      if (marks[0] === fence[0] && marks.length >= fence.length && !rest.trim()) {
        fence = null
        blank = true
      }
      continue
    }
    if (open && !(open[1][0] === '`' && open[2].includes('`'))) {
      stop()
      fence = open[1]
      indented = false
      continue
    }
    if (BREAK.test(line)) {
      stop()
      blank = true
      continue
    }
    const deep = /^(?: {4}|\t)/.test(line)
    const code: boolean = deep && !list && (blank || indented)
    if (!deep) list = LIST_ITEM.test(line) || (list && !blank)
    indented = code
    blank = false
    if (code) {
      stop()
      continue
    }
    if (run) run.end = from + line.length
    else run = { start: from, end: from + line.length }
  }
  stop()
  return runs
}

const ticks = (text: string, at: number, end: number) => {
  let n = 0
  while (at + n < end && text[at + n] === '`') n += 1
  return n
}

// The `||` markers of one run, outside inline code and escapes.
const markers = (text: string, { start, end }: Run): number[] => {
  const out: number[] = []
  let i = start
  while (i < end) {
    const c = text[i]
    if (c === '\\' && i + 1 < end && PUNCT.test(text[i + 1])) {
      i += 2
    } else if (c === '`') {
      const n = ticks(text, i, end)
      let j = i + n
      let close = -1
      while (j < end) {
        if (text[j] !== '`') {
          j += 1
          continue
        }
        const m = ticks(text, j, end)
        if (m === n) {
          close = j
          break
        }
        j += m
      }
      i = close === -1 ? i + n : close + n
    } else if (c === '|' && text[i + 1] === '|' && i + 1 < end) {
      out.push(i)
      i += 2
    } else {
      i += 1
    }
  }
  return out
}

// Spoilers of `text`. `cut`: the text is an excerpt, so an unclosed `||` at the end hides the
// rest (the spoiler went on past the cut).
export const spoilerSpans = (text: string, cut = false): SpoilerSpan[] => {
  if (!text.includes('||')) return []
  const spans: SpoilerSpan[] = []
  const runs = textRuns(text)
  runs.forEach((run, r) => {
    const marks = markers(text, run)
    let open: number | null = null
    for (const at of marks) {
      if (open === null) open = at
      else if (at === open + 2) open = at
      else {
        spans.push({ start: open, end: at + 2, closed: true })
        open = null
      }
    }
    if (open !== null && cut && r === runs.length - 1)
      spans.push({ start: open, end: text.length, closed: false })
  })
  return spans
}

// `text` split into spoiler and plain parts, markers removed.
export const spoilerParts = (text: string, cut = false): SpoilerPart[] => {
  const out: SpoilerPart[] = []
  let at = 0
  const push = (part: string, spoiler: boolean) => {
    if (part) out.push({ text: part, spoiler })
  }
  for (const { start, end, closed } of spoilerSpans(text, cut)) {
    push(text.slice(at, start), false)
    push(text.slice(start + 2, closed ? end - 2 : end), true)
    at = end
  }
  push(text.slice(at), false)
  return out
}

// Whether [from, to) touches a spoiler, markers included.
export const overlapsSpoiler = (spans: SpoilerSpan[], from: number, to: number) =>
  spans.some(s => from < s.end && to > s.start)

// Spoilers replaced by `hide(inner)`, everything else as it was.
export const replaceSpoilers = (text: string, hide: (inner: string) => string, cut = false) =>
  spoilerParts(text, cut)
    .map(p => (p.spoiler ? hide(p.text) : p.text))
    .join('')

// For the markdown renderer: the paired markers become `<` OPEN `|` and `<` CLOSE `|`. The pipes
// and `<` are punctuation like `||`, so emphasis reads the same; `<` ends a bare link
// (`||https://x||` must not take the marker into the link) and starts no tag before a
// private-use character. `hideSpoilers` (`spoiler_tree.ts`) reads them in the parsed tree.
export const OPEN = '<\uE000|'
export const CLOSE = '<\uE001|'

// Marker characters typed in the text become U+FFFD (the same length), so they mark nothing.
export const typedMarks = (text: string) => text.replace(/[\uE000\uE001]/g, '\uFFFD')

export const markSpoilers = (raw: string) => {
  const text = typedMarks(raw)
  const spans = spoilerSpans(text)
  if (!spans.length) return text
  let out = ''
  let at = 0
  for (const { start, end } of spans) {
    out += `${text.slice(at, start)}${OPEN}${text.slice(start + 2, end - 2)}${CLOSE}`
    at = end
  }
  return out + text.slice(at)
}

// Settings > Chat > Show spoilers, per account in this browser
// (`rchat_spoilers:{username|guest}`). Reveals are per message view and never stored.
export type ShowSpoilers = 'click' | 'always'

export const spoilersKey = (username: string | null) => `rchat_spoilers:${username ?? 'guest'}`

export const isShowSpoilers = (x: unknown): x is ShowSpoilers => x === 'click' || x === 'always'

export const parseSpoilers = (raw: string | null): ShowSpoilers => {
  try {
    const data = raw ? (JSON.parse(raw) as unknown) : null
    if (typeof data !== 'object' || data === null) return 'click'
    const { v, show } = data as { v?: unknown; show?: unknown }
    return v === 1 && isShowSpoilers(show) ? show : 'click'
  } catch {
    return 'click'
  }
}

export const spoilersValue = (show: ShowSpoilers) => JSON.stringify({ v: 1, show })
