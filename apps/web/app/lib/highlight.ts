import { useEffect, useMemo, useState } from 'react'
import type { Lang } from './code'

// Syntax trees from lowlight (hast): spans with `hljs-*` classes around plain text. They are
// turned into React elements, never into an HTML string.
export interface CodeNode {
  type: string
  value?: string
  tagName?: string
  properties?: { className?: unknown }
  children?: CodeNode[]
}

export interface Highlighted {
  lang: Lang
  nodes: CodeNode
}

type Data = typeof import('./highlight_data')

let loaded: Data | null = null
let loading: Promise<Data> | null = null

export function loadHighlighter(): Promise<Data> {
  loading ??= import('./highlight_data').then(
    m => (loaded = m),
    e => {
      loading = null
      throw e
    }
  )
  return loading
}

const CACHE_MAX = 32
const cache = new Map<string, Highlighted | null>()

const highlighted = (data: Data, code: string, lang: Lang | null) => {
  const key = `${lang ?? ''}\0${code}`
  if (cache.has(key)) {
    const hit = cache.get(key) ?? null
    cache.delete(key)
    cache.set(key, hit)
    return hit
  }
  const out = data.highlightCode(code, lang)
  cache.set(key, out)
  for (const k of cache.keys()) {
    if (cache.size <= CACHE_MAX) break
    cache.delete(k)
  }
  return out
}

// Tokens for `code`, or null while the grammars load, when nothing matched, or when `enabled` is
// false. The grammars are fetched the first time any code is shown.
export const useHighlight = (code: string, lang: Lang | null, enabled = true) => {
  const [data, setData] = useState<Data | null>(loaded)
  useEffect(() => {
    if (!enabled || data) return
    let live = true
    loadHighlighter().then(
      m => live && setData(m),
      (e: unknown) => console.error('highlighter', e)
    )
    return () => {
      live = false
    }
  }, [enabled, data])
  return useMemo(
    () => (enabled && data ? highlighted(data, code, lang) : null),
    [enabled, data, code, lang]
  )
}
