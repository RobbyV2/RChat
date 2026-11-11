// The text a message cue may read: the message view's markdown tree, parsed once
// from the original text exactly as the view parses it (remark-parse and remark-gfm over
// `markSpoilers(text)`), keeping only prose. Never: code blocks, inline code, quotes, raw HTML,
// images, link targets, mentions and channel links, custom emoji codes. Hidden text is dropped by
// its position in the source: a character counts only if its offset, mapped back through the
// spoiler markers, lies outside every span `spoilerSpans` hides. So text hidden by the previews
// (and by the view once its 0.4.0 fix hides the same spans) never cues, and nothing is rewritten
// before the parse (blanking spoilers first could unclose an HTML comment).
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import { unified } from 'unified'
import { markSpoilers, spoilerSpans, typedMarks } from '../spoilers'

interface MdNode {
  type: string
  value?: string
  url?: string
  children?: MdNode[]
  position?: { start: { offset?: number }; end: { offset?: number } }
}

const SKIP = new Set([
  'code',
  'inlineCode',
  'blockquote',
  'html',
  'image',
  'imageReference',
  'definition',
  'footnoteDefinition',
  'footnoteReference',
])
const BLOCKS = new Set(['paragraph', 'heading', 'listItem', 'tableCell'])
const URLISH = /^(?:[a-z][a-z0-9+.-]*:\/\/|www\.|mailto:)/i
// `@name` and `#channel` after any non-word character, as `lib/mentions.ts` reads them.
const MENTION = /(^|[^\p{L}\p{N}_])[@#][\p{L}\p{N}_.-]+/gu
const SHORTCODE = /<a?:\w+:\d+>|:[\w+-]+:/g
const BARE_URL = /\b[a-z][a-z0-9+.-]*:\/\/\S+|\bwww\.\S+/gi

const parser = unified().use(remarkParse).use(remarkGfm)

// Where `markSpoilers` put its 3-character markers (each replaced a 2-character `||`), in the
// marked text, so marked offsets map back to the original.
interface Source {
  marked: string
  markers: number[]
  hidden: [number, number][]
}

const sourceOf = (markdown: string): Source => {
  const spans = spoilerSpans(typedMarks(markdown))
  const markers: number[] = []
  let shift = 0
  for (const { start, end } of spans) {
    markers.push(start + shift)
    shift += 1
    markers.push(end - 2 + shift)
    shift += 1
  }
  return { marked: markSpoilers(markdown), markers, hidden: spans.map(s => [s.start, s.end]) }
}

// The original offset of a marked offset, or -1 inside a marker.
const toSource = (src: Source, m: number) => {
  let before = 0
  for (const at of src.markers) {
    if (m >= at + 3) before++
    else if (m >= at) return -1
    else break
  }
  return m - before
}

const shown = (src: Source, m: number) => {
  const o = toSource(src, m)
  return o >= 0 && !src.hidden.some(([a, b]) => o >= a && o < b)
}

// A text node's visible characters. When the node's value is its source slice (no escapes or
// entities), character by character; otherwise all or nothing: shown only if no character of
// its source is hidden.
const visible = (src: Source, n: MdNode): string => {
  const value = n.value ?? ''
  const s = n.position?.start.offset
  const e = n.position?.end.offset
  if (s === undefined || e === undefined) return ''
  if (src.marked.slice(s, e) === value) {
    let out = ''
    for (let i = 0; i < value.length; i++) out += shown(src, s + i) ? value[i] : ' '
    return out
  }
  for (let m = s; m < e; m++) if (!shown(src, m)) return ''
  return value
}

// One string per block (paragraph, heading, list item, table cell), so a phrase never runs
// across two blocks.
export function cueSegments(markdown: string): string[] {
  const src = sourceOf(markdown)
  const tree = parser.parse(src.marked) as MdNode
  const out: string[] = []
  let cur: string[] = []
  const flush = () => {
    const t = cur.join('').replace(MENTION, '$1 ').replace(SHORTCODE, ' ').replace(BARE_URL, ' ')
    if (t.trim()) out.push(t)
    cur = []
  }
  const textIn = (n: MdNode): string =>
    n.type === 'text' ? visible(src, n) : (n.children ?? []).map(textIn).join('')
  const walk = (n: MdNode) => {
    if (SKIP.has(n.type)) return
    if (n.type === 'link' || n.type === 'linkReference') {
      const t = textIn(n)
      if (!URLISH.test(t.trim())) cur.push(t)
      return
    }
    if (n.type === 'text') {
      cur.push(visible(src, n))
      return
    }
    if (n.type === 'break') cur.push(' ')
    const block = BLOCKS.has(n.type)
    if (block) flush()
    for (const c of n.children ?? []) walk(c)
    if (block) flush()
  }
  walk(tree)
  flush()
  return out
}
