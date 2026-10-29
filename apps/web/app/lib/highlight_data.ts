import { createLowlight } from 'lowlight'
import bash from 'highlight.js/lib/languages/bash'
import c from 'highlight.js/lib/languages/c'
import cpp from 'highlight.js/lib/languages/cpp'
import csharp from 'highlight.js/lib/languages/csharp'
import css from 'highlight.js/lib/languages/css'
import diff from 'highlight.js/lib/languages/diff'
import dockerfile from 'highlight.js/lib/languages/dockerfile'
import go from 'highlight.js/lib/languages/go'
import ini from 'highlight.js/lib/languages/ini'
import java from 'highlight.js/lib/languages/java'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import kotlin from 'highlight.js/lib/languages/kotlin'
import lua from 'highlight.js/lib/languages/lua'
import makefile from 'highlight.js/lib/languages/makefile'
import markdown from 'highlight.js/lib/languages/markdown'
import php from 'highlight.js/lib/languages/php'
import plaintext from 'highlight.js/lib/languages/plaintext'
import powershell from 'highlight.js/lib/languages/powershell'
import python from 'highlight.js/lib/languages/python'
import ruby from 'highlight.js/lib/languages/ruby'
import rust from 'highlight.js/lib/languages/rust'
import scss from 'highlight.js/lib/languages/scss'
import shell from 'highlight.js/lib/languages/shell'
import sql from 'highlight.js/lib/languages/sql'
import swift from 'highlight.js/lib/languages/swift'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'
import yaml from 'highlight.js/lib/languages/yaml'
import { autoDetects, LANGS, pickGuess, type Lang } from './code'
import type { CodeNode } from './highlight'

// Loaded with a dynamic import (see highlight.ts) so the grammars stay out of the main chunk.

const grammars: Record<Lang, typeof rust> = {
  bash,
  c,
  cpp,
  csharp,
  css,
  diff,
  dockerfile,
  go,
  ini,
  java,
  javascript,
  json,
  kotlin,
  lua,
  makefile,
  markdown,
  php,
  plaintext,
  powershell,
  python,
  ruby,
  rust,
  scss,
  shell,
  sql,
  swift,
  typescript,
  xml,
  yaml,
}

const low = createLowlight(grammars)

const GUESSABLE = (Object.keys(LANGS) as Lang[]).filter(l => l !== 'plaintext' && l !== 'scss')

const tree = (lang: Lang, code: string) => low.highlight(lang, code) as unknown as CodeNode

// Tokens for `code` in `lang`; with no language, a guess when the fence is long enough and one
// language is clearly ahead, otherwise null (shown plain).
export const highlightCode = (code: string, lang: Lang | null) => {
  if (lang === 'plaintext') return null
  if (lang !== null) return { lang, nodes: tree(lang, code) }
  if (!autoDetects(code)) return null
  const scores = GUESSABLE.map(
    l => [l, low.highlight(l, code).data?.relevance ?? 0] as [Lang, number]
  )
  const guess = pickGuess(scores)
  return guess === null ? null : { lang: guess, nodes: tree(guess, code) }
}
