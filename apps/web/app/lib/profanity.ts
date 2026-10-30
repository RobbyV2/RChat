// The personal profanity filter: masks what you see, instance and P2P content alike, and never
// changes what is stored, sent or searched. The site filter (server side, blocks before posting)
// is separate and never applies to P2P content. The setting is per account in this browser
// (`rchat_profanity:{username|guest}`), off by default. The matcher is the server's own
// (`crates/profanity`, compiled into `crates/wasm`), loaded only once the setting is on.
import { getBasePath } from './basePath'

export const profanityKey = (username: string | null) => `rchat_profanity:${username ?? 'guest'}`

export const parseProfanity = (raw: string | null): boolean => {
  try {
    const data = raw ? (JSON.parse(raw) as unknown) : null
    if (typeof data !== 'object' || data === null) return false
    const { v, on } = data as { v?: unknown; on?: unknown }
    return v === 1 && typeof on === 'boolean' ? on : false
  } catch {
    return false
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

// Turns masking on or off. Resolves true once masking works, false when off or the matcher
// couldn't load (a later call tries again).
export const setMasking = (on: boolean, load: () => Promise<Matcher> = wasmMatcher) => {
  active = on
  if (!on) return Promise.resolve(false)
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
  data?: { hProperties?: Record<string, unknown> }
}

// Pills and timestamps render from their own data; their names are masked where they render.
const KEEP = ['data-stamp', 'data-mention', 'data-group', 'data-edited']

// Blocks whose text reads as one line, so a word split by formatting (`f**u**ck`) is still found.
const LINES = ['paragraph', 'heading', 'tableCell']

const kept = (node: MdNode) => {
  const props = node.data?.hProperties
  return !!props && KEEP.some(k => k in props)
}

// Masks the text nodes of one block together, then writes each part back in place (the mask
// keeps the number of code points). Code, pills and breaks split the text.
const maskLine = (block: MdNode, mask: Matcher) => {
  const parts: (MdNode | null)[] = []
  const collect = (node: MdNode) => {
    for (const child of node.children ?? []) {
      if (child.type === 'text') parts.push(child)
      else if (child.type === 'image') {
        if (child.alt) child.alt = mask(child.alt)
        parts.push(null)
      } else if (kept(child) || !child.children) parts.push(null)
      else collect(child)
    }
  }
  collect(block)
  const texts = parts.filter((p): p is MdNode => p !== null && !!p.value)
  if (texts.length === 0) return
  const points = parts.map(p => Array.from(p === null ? ' ' : (p.value ?? '')))
  const line = points.flat()
  const masked = Array.from(mask(line.join('')))
  if (masked.length !== line.length) {
    for (const node of texts) node.value = mask(node.value ?? '')
    return
  }
  let at = 0
  parts.forEach((part, i) => {
    const end = at + points[i].length
    if (part !== null && part.value) part.value = masked.slice(at, end).join('')
    at = end
  })
}

// Masks the visible text of a markdown tree: text and image alt text. Code (`code`,
// `inlineCode`) and link targets are other fields, so they stay as written.
export const maskTree = (node: MdNode, mask: Matcher) => {
  if (LINES.includes(node.type)) return maskLine(node, mask)
  if (node.type === 'text' && node.value) node.value = mask(node.value)
  if (node.type === 'image' && node.alt) node.alt = mask(node.alt)
  if (kept(node)) return
  for (const child of node.children ?? []) maskTree(child, mask)
}

export const remarkMask = (mask: Matcher) => () => (tree: unknown) => maskTree(tree as MdNode, mask)
