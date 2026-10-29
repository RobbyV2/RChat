// Languages for code blocks and text file previews. The grammars themselves are loaded on demand
// (see highlight.ts); this module only knows names, so it stays out of the lazy chunk.

export const LANGS = {
  bash: 'Bash',
  c: 'C',
  cpp: 'C++',
  csharp: 'C#',
  css: 'CSS',
  diff: 'Diff',
  dockerfile: 'Dockerfile',
  go: 'Go',
  ini: 'TOML / INI',
  java: 'Java',
  javascript: 'JavaScript',
  json: 'JSON',
  kotlin: 'Kotlin',
  lua: 'Lua',
  makefile: 'Makefile',
  markdown: 'Markdown',
  php: 'PHP',
  plaintext: 'Text',
  powershell: 'PowerShell',
  python: 'Python',
  ruby: 'Ruby',
  rust: 'Rust',
  scss: 'SCSS',
  shell: 'Shell session',
  sql: 'SQL',
  swift: 'Swift',
  typescript: 'TypeScript',
  xml: 'HTML / XML',
  yaml: 'YAML',
} as const

export type Lang = keyof typeof LANGS

const isLang = (s: string): s is Lang => Object.hasOwn(LANGS, s)

const ALIASES: Record<string, Lang> = {
  sh: 'bash',
  zsh: 'bash',
  'c++': 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  h: 'c',
  'c#': 'csharp',
  cs: 'csharp',
  patch: 'diff',
  docker: 'dockerfile',
  golang: 'go',
  toml: 'ini',
  cfg: 'ini',
  conf: 'ini',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  node: 'javascript',
  jsonc: 'json',
  json5: 'json',
  kt: 'kotlin',
  kts: 'kotlin',
  make: 'makefile',
  mk: 'makefile',
  md: 'markdown',
  text: 'plaintext',
  txt: 'plaintext',
  plain: 'plaintext',
  ps: 'powershell',
  ps1: 'powershell',
  pwsh: 'powershell',
  py: 'python',
  py3: 'python',
  python3: 'python',
  rb: 'ruby',
  rs: 'rust',
  console: 'shell',
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  html: 'xml',
  htm: 'xml',
  svg: 'xml',
  vue: 'xml',
  svelte: 'xml',
  yml: 'yaml',
}

// The language a fence tag names (```rs, ```Python, ```c++), or null when unknown.
export const fenceLang = (tag: string): Lang | null => {
  const t = tag.trim().toLowerCase()
  if (isLang(t)) return t
  return Object.hasOwn(ALIASES, t) ? ALIASES[t] : null
}

// The tag after ``` as react-markdown hands it over: the `language-x` class on the code element.
export const fenceTag = (className: unknown) => {
  const names = Array.isArray(className) ? className : [className]
  for (const n of names)
    if (typeof n === 'string' && n.startsWith('language-')) return n.slice('language-'.length)
  return null
}

// Text file extensions shown as a preview, with their language. SVG is left out: it is offered
// as an image or a download.
const EXT: Record<string, Lang> = {
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  fish: 'bash',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  hh: 'cpp',
  hxx: 'cpp',
  cs: 'csharp',
  css: 'css',
  diff: 'diff',
  patch: 'diff',
  go: 'go',
  ini: 'ini',
  toml: 'ini',
  cfg: 'ini',
  conf: 'ini',
  properties: 'ini',
  java: 'java',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascript',
  json: 'json',
  jsonc: 'json',
  json5: 'json',
  kt: 'kotlin',
  kts: 'kotlin',
  lua: 'lua',
  mk: 'makefile',
  md: 'markdown',
  markdown: 'markdown',
  php: 'php',
  txt: 'plaintext',
  log: 'plaintext',
  csv: 'plaintext',
  tsv: 'plaintext',
  ps1: 'powershell',
  psm1: 'powershell',
  py: 'python',
  pyi: 'python',
  pyw: 'python',
  rb: 'ruby',
  rs: 'rust',
  scss: 'scss',
  sql: 'sql',
  swift: 'swift',
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'typescript',
  html: 'xml',
  htm: 'xml',
  xml: 'xml',
  vue: 'xml',
  svelte: 'xml',
  yaml: 'yaml',
  yml: 'yaml',
}

const NAMES: Record<string, Lang> = {
  dockerfile: 'dockerfile',
  containerfile: 'dockerfile',
  makefile: 'makefile',
  gnumakefile: 'makefile',
  justfile: 'makefile',
  readme: 'plaintext',
  license: 'plaintext',
}

// The language for a file name when it is on the text allowlist, otherwise null. The bytes still
// have to pass `decodeText` before anything is shown.
export const fileLang = (filename: string): Lang | null => {
  const base = filename.split(/[\\/]/).pop()?.toLowerCase() ?? ''
  if (Object.hasOwn(NAMES, base)) return NAMES[base]
  const ext = /\.([a-z0-9+]+)$/.exec(base)?.[1] ?? ''
  return Object.hasOwn(EXT, ext) ? EXT[ext] : null
}

export const PREVIEW_TEXT_MAX = 1024 * 1024
export const NUL_WINDOW = 64 * 1024
// Highlighting past this is slow to build and render; the rest is shown as plain text.
export const HIGHLIGHT_MAX = 256 * 1024
// Auto-detection only runs on fences longer than this many lines and below this size.
export const AUTO_MIN_LINES = 3
export const AUTO_MAX = 10 * 1024
export const AUTO_MIN_RELEVANCE = 8
export const AUTO_MARGIN = 3

// Where a cut UTF-8 stream may be decoded up to: before a trailing sequence that is incomplete.
const completeEnd = (b: Uint8Array) => {
  let i = b.length - 1
  let back = 0
  while (i >= 0 && back < 3 && (b[i] & 0xc0) === 0x80) {
    i -= 1
    back += 1
  }
  if (i < 0) return b.length
  const lead = b[i]
  const need = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1
  return b.length - i < need ? i : b.length
}

// The bytes as text when they look like a text file: no NUL in the first 64 KB and valid UTF-8.
// `cut` says the bytes are the start of a longer file, so a split last character is dropped.
export const decodeText = (bytes: Uint8Array, cut: boolean): string | null => {
  const head = bytes.subarray(0, NUL_WINDOW)
  if (head.includes(0)) return null
  const body = cut ? bytes.subarray(0, completeEnd(bytes)) : bytes
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(body)
  } catch {
    return null
  }
}

// Whether a fence without a tag is long enough to guess its language.
export const autoDetects = (code: string) =>
  code.length <= AUTO_MAX && code.split('\n', AUTO_MIN_LINES + 1).length > AUTO_MIN_LINES

// The best guess from per-language relevance scores, only when it is clearly ahead.
export const pickGuess = (scores: [Lang, number][]): Lang | null => {
  const sorted = [...scores].sort((a, b) => b[1] - a[1])
  const [best, second] = sorted
  if (!best || best[1] < AUTO_MIN_RELEVANCE) return null
  return !second || best[1] - second[1] >= AUTO_MARGIN ? best[0] : null
}

// Splits text for highlighting: the part to highlight, ending at a line break, and the rest.
export const highlightSplit = (text: string, max = HIGHLIGHT_MAX): [string, string] => {
  if (text.length <= max) return [text, '']
  const nl = text.lastIndexOf('\n', max)
  const at = nl > 0 ? nl + 1 : max
  return [text.slice(0, at), text.slice(at)]
}

export const lineCount = (text: string) => {
  let n = 1
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) n += 1
  return text.endsWith('\n') ? n - 1 : n
}
