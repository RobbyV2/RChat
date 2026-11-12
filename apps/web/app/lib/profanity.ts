// The personal profanity filter: masks what you see, instance and P2P content alike, and never
// changes what is stored, sent or searched. The site filter (server side, blocks before posting)
// is separate and never applies to P2P content. The setting is per account in this browser
// (`rchat_profanity:{username|guest}`), on unless the account turned it off. The matcher is the
// server's own (`crates/profanity`, compiled into `crates/wasm`), loaded only once it is on.
import { getBasePath } from './basePath'
import { unavailable } from './capabilities'
import { capabilities } from './platform'

export const profanityKey = (username: string | null) => `rchat_profanity:${username ?? 'guest'}`

export const PROFANITY_DEFAULT = true

export const parseProfanity = (raw: string | null): boolean => {
  try {
    const data = raw ? (JSON.parse(raw) as unknown) : null
    if (typeof data !== 'object' || data === null) return PROFANITY_DEFAULT
    const { v, on } = data as { v?: unknown; on?: unknown }
    return v === 1 && typeof on === 'boolean' ? on : PROFANITY_DEFAULT
  } catch {
    return PROFANITY_DEFAULT
  }
}

export const profanityValue = (on: boolean) => JSON.stringify({ v: 1, on })

export type Matcher = (text: string) => string

export const CACHE_MAX = 2000

export const lru = <V>(max: number) => {
  const map = new Map<string, V>()
  return {
    get: (key: string) => {
      const hit = map.get(key)
      if (hit !== undefined) {
        map.delete(key)
        map.set(key, hit)
      }
      return hit
    },
    set: (key: string, value: V) => {
      map.delete(key)
      map.set(key, value)
      if (map.size > max) map.delete(map.keys().next().value as string)
    },
    size: () => map.size,
    clear: () => map.clear(),
  }
}

let matcher: Matcher | null = null
let active = false
let loading: Promise<boolean> | null = null
const cache = lru<string>(CACHE_MAX)

const stars = (text: string) => text.split('*').length - 1

// Masks profanity in text you are about to show, when the filter is on and loaded.
export const maskProfanity = (text: string): string => {
  if (!active || matcher === null || text.trim() === '') return text
  const hit = cache.get(text)
  if (hit !== undefined) return hit
  const out = matcher(text)
  // The wasm reads lone surrogates as U+FFFD; text it didn't mask comes back as it was.
  const kept = stars(out) > stars(text) ? out : text
  cache.set(text, kept)
  return kept
}

export const showText = (text: string) => text

// Code fences (closed or cut off) and inline code, as markdown reads them in plain previews.
const CODE = /(```[\s\S]*?(?:```|$)|`[^`\n]+`)/

// Masks plain text that may hold markdown code (snippets, notifications), leaving code as it is.
export const maskOutsideCode = (text: string, mask: Matcher) =>
  text.includes('`')
    ? text
        .split(CODE)
        .map((part, i) => (i % 2 ? part : mask(part)))
        .join('')
    : mask(text)

interface WasmModule {
  default: (init: { module_or_path: string }) => Promise<unknown>
  mask_profanity: Matcher
}

export const wasmMatcher = async (): Promise<Matcher> => {
  const base = `${getBasePath()}/wasm/rust_next_wasm`
  const mod = (await import(
    /* webpackIgnore: true */ /* turbopackIgnore: true */ `${base}.js`
  )) as WasmModule
  await mod.default({ module_or_path: `${base}_bg.wasm` })
  return mod.mask_profanity
}

// Turns masking on or off. Resolves true once masking works, false when off, when the page
// can't run WebAssembly (nothing is loaded then) or when the matcher couldn't load (a later call
// tries again).
export const setMasking = (on: boolean, load: () => Promise<Matcher> = wasmMatcher) => {
  active = on && capabilities().wasm
  if (!active) return Promise.resolve(false)
  if (matcher !== null) return Promise.resolve(true)
  loading ??= load().then(
    m => {
      matcher = m
      return true
    },
    () => {
      loading = null
      return false
    }
  )
  return loading.then(ok => ok && active)
}

const NO_WASM = unavailable("The filter needs WebAssembly, which this browser can't run here.")
const NOT_LOADED =
  'The filter could not be loaded. Check your connection, then turn it on again or reload.'

// What the filter's switch shows: on only while words can be masked, and why not otherwise.
// `wasm`: the page can run WebAssembly; `failed`: the matcher did not load.
export const filterSwitch = (wasm: boolean, on: boolean, failed: boolean) =>
  !wasm
    ? { on: false, usable: false, note: NO_WASM }
    : on && failed
      ? { on: false, usable: true, note: NOT_LOADED }
      : { on, usable: true, note: null }

export const resetMasking = () => {
  matcher = null
  active = false
  loading = null
  cache.clear()
}

export const cachedMasks = () => cache.size()

interface MdNode {
  type: string
  value?: string
  alt?: string | null
  children?: MdNode[]
  data?: { hName?: string; hProperties?: Record<string, unknown>; hChildren?: MdNode[] }
}

// Pills and timestamps render from their own data; their names are masked where they render.
const KEEP = ['data-stamp', 'data-mention', 'data-group', 'data-edited']

// Blocks whose text reads as one line, so a word split by formatting (`f**u**ck`) is still found.
const LINES = ['paragraph', 'heading', 'tableCell']

const SPACE = /\s/u

const kept = (node: MdNode) => {
  const props = node.data?.hProperties
  return !!props && KEEP.some(k => k in props)
}

// The masked words of `text` (code points) as `shown` shows it: [first, last] of each stretch
// of changed code points with no space between them.
export const maskSpans = (text: string[], shown: string[]): [number, number][] => {
  const spans: [number, number][] = []
  let i = 0
  while (i < text.length) {
    if (text[i] === shown[i]) {
      i += 1
      continue
    }
    let last = i
    for (let j = i + 1; j < text.length && !SPACE.test(text[j]); j += 1)
      if (text[j] !== shown[j]) last = j
    spans.push([i, last])
    i = last + 1
  }
  return spans
}

// A piece of shown text. A masked piece keeps what it hides, and `word`, the masked word it
// belongs to (pieces of a word split by formatting share it).
export interface MaskRun {
  text: string
  hidden?: string
  word?: number
}

const slice = (
  text: string[],
  shown: string[],
  spans: [number, number][],
  from: number,
  to: number
) => {
  const runs: MaskRun[] = []
  let at = from
  spans.forEach(([first, last], word) => {
    const start = Math.max(first, from)
    const end = Math.min(last + 1, to)
    if (start >= end) return
    if (start > at) runs.push({ text: shown.slice(at, start).join('') })
    runs.push({
      text: shown.slice(start, end).join(''),
      hidden: text.slice(start, end).join(''),
      word,
    })
    at = end
  })
  if (at < to) runs.push({ text: shown.slice(at, to).join('') })
  return runs
}

// `text` as its masked form `shown` shows it: plain runs and masked words. A mask that changed
// the length hides the whole text as one word.
export const maskRuns = (text: string, shown: string): MaskRun[] => {
  if (shown === text) return text ? [{ text }] : []
  const a = Array.from(text)
  const b = Array.from(shown)
  if (a.length !== b.length) return [{ text: shown, hidden: text, word: 0 }]
  return slice(a, b, maskSpans(a, b), 0, a.length)
}

// Markdown nodes for runs: masked words become `span[data-masked]` holding the hidden text,
// `data-mask-word` naming the word within the message.
const runNodes = (runs: MaskRun[], line: number): MdNode[] =>
  runs.map(r =>
    r.hidden === undefined
      ? { type: 'text', value: r.text }
      : {
          type: 'maskedWord',
          data: {
            hName: 'span',
            hProperties: { dataMasked: r.hidden, dataMaskWord: `${line}.${r.word}` },
            hChildren: [{ type: 'text', value: r.text }],
          },
        }
  )

const replace = (parent: MdNode, node: MdNode, by: MdNode[]) => {
  const kids = parent.children ?? []
  kids.splice(kids.indexOf(node), 1, ...by)
}

// Masks the text nodes of one block together, then splits each into plain and masked runs in
// place (the mask keeps the number of code points). Code, pills and breaks split the text.
const maskLine = (block: MdNode, mask: Matcher, next: () => number) => {
  const parts: ({ node: MdNode; parent: MdNode } | null)[] = []
  const collect = (node: MdNode) => {
    for (const child of node.children ?? []) {
      if (child.type === 'text') parts.push({ node: child, parent: node })
      else if (child.type === 'image') {
        if (child.alt) child.alt = mask(child.alt)
        parts.push(null)
      } else if (kept(child) || !child.children) parts.push(null)
      else collect(child)
    }
  }
  collect(block)
  const texts = parts.filter(p => p !== null && !!p.node.value)
  if (texts.length === 0) return
  const points = parts.map(p => Array.from(p === null ? ' ' : (p.node.value ?? '')))
  const line = points.flat()
  const masked = Array.from(mask(line.join('')))
  if (masked.length !== line.length) {
    for (const part of texts) {
      if (!part) continue
      const value = part.node.value ?? ''
      const runs = maskRuns(value, mask(value))
      if (runs.some(r => r.hidden !== undefined))
        replace(part.parent, part.node, runNodes(runs, next()))
    }
    return
  }
  const spans = maskSpans(line, masked)
  if (spans.length === 0) return
  const id = next()
  let at = 0
  parts.forEach((part, i) => {
    const end = at + points[i].length
    if (part !== null && part.node.value) {
      const runs = slice(line, masked, spans, at, end)
      if (runs.some(r => r.hidden !== undefined))
        replace(part.parent, part.node, runNodes(runs, id))
    }
    at = end
  })
}

const walk = (node: MdNode, mask: Matcher, next: () => number) => {
  if (LINES.includes(node.type)) return maskLine(node, mask, next)
  if (node.type === 'image' && node.alt) node.alt = mask(node.alt)
  if (kept(node)) return
  for (const child of [...(node.children ?? [])]) {
    if (child.type !== 'text' || !child.value) walk(child, mask, next)
    else {
      const runs = maskRuns(child.value, mask(child.value))
      if (runs.some(r => r.hidden !== undefined)) replace(node, child, runNodes(runs, next()))
    }
  }
}

// Masks the visible text of a markdown tree: text and image alt text. Code (`code`,
// `inlineCode`) and link targets are other fields, so they stay as written. Masked words become
// `span[data-masked]` nodes the renderer turns into reveal buttons.
export const maskTree = (node: MdNode, mask: Matcher) => {
  let line = 0
  walk(node, mask, () => line++)
}

export const remarkMask = (mask: Matcher) => () => (tree: unknown) => maskTree(tree as MdNode, mask)
