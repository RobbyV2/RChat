// Plugin CSS and Quick CSS, made safe to add to the page: a tokenizer after CSS Syntax Level 3,
// a rule allowlist, no addresses, every selector under the app container, and text only on the
// plugin's own surfaces. The output is written from the parsed tokens, never copied from the
// input.

// The cap on what a plugin wrote. What comes out is longer (each selector gains the app
// container, each page-wide name the id: about 22 times for a list of one-letter names and a
// 40-character id), so stored output is read back under the larger one.
export const CSS_MAX_BYTES = 256 * 1024
export const CSS_MAX_STORED_BYTES = 32 * CSS_MAX_BYTES

// Variables the app sets for itself, by the start of their names: its own, the theme's, the
// motion tokens and the ones its utility classes write (`--tw-content` is what their
// pseudo-elements show).
// Plugin CSS may read them and never set them: a custom property passes into every descendant,
// closed roots included.
export const APP_VARIABLES = [
  '--rc-',
  '--tw-',
  '--md-',
  '--color-',
  '--font-',
  '--shadow-',
  '--animate-',
  '--rail-',
  '--safe-',
  '--titlebar-',
  '--app-',
  '--folder-',
  '--notice-',
  '--motion-',
  '--space-',
  '--text-',
  '--radius-',
  '--z-',
  '--emoji-',
  '--gear-',
  '--hdr-',
] as const

// Font families of the app's own and Tailwind's stacks, and generic names, in lower case. A
// plugin can't define one of them (its families start with its id and an underscore, which
// none of these holds).
export const APP_FONTS = [
  'sans-serif',
  'system-ui',
  'ui-sans-serif',
  'ui-serif',
  'ui-monospace',
  'ui-rounded',
  'sfmono-regular',
]

// The `data-rc` names plugin CSS may rely on.
export const SELECTORS = [
  'rail',
  'server-tile',
  'channel-list',
  'channel-row',
  'header',
  'message-list',
  'message',
  'message-author',
  'message-body',
  'message-toolbar',
  'composer',
  'member-list',
  'member-row',
  'panel',
  'home',
  'settings',
  'palette',
  'voice-grid',
  'voice-tile',
  'call-bar',
  'button',
] as const

// Attributes the app mirrors onto its container. A selector may lead with them.
export const A11Y_ATTRS = [
  'data-theme',
  'data-style',
  'data-density',
  'data-contrast',
  'data-borders',
  'data-links',
  'data-focus',
  'data-transparency',
  'data-vision',
  'data-targets',
  'data-font',
  'data-grouping',
  'data-times',
  'data-gifs',
] as const

type Mark =
  | 'whitespace'
  | 'bad-string'
  | 'bad-url'
  | 'cdo'
  | 'cdc'
  | ':'
  | ';'
  | ','
  | '['
  | ']'
  | '('
  | ')'
  | '{'
  | '}'

export type Token =
  | { type: 'ident' | 'function' | 'at' | 'string' | 'url' | 'delim'; value: string }
  | { type: 'hash'; value: string; id: boolean }
  | { type: 'number' | 'percentage'; value: string }
  | { type: 'dimension'; value: string; unit: string }
  | { type: Mark }

const MARKS = ':;,[](){}'

const isDigit = (c: string) => c >= '0' && c <= '9'
const isHex = (c: string) => isDigit(c) || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')
const isNameStart = (c: string) =>
  (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_' || c >= '\u0080'
const isName = (c: string) => isNameStart(c) || isDigit(c) || c === '-'
const isSpace = (c: string) => c === ' ' || c === '\n' || c === '\t'
const isNonPrintable = (c: string) =>
  c !== '' &&
  (c <= '\u0008' || c === '\u000b' || (c >= '\u000e' && c <= '\u001f') || c === '\u007f')

export const tokenize = (css: string): Token[] => {
  const s = css
    .replace(/\r\n?|\f/g, '\n')
    .split('\u0000')
    .join('\ufffd')
  const out: Token[] = []
  let i = 0
  const at = (n: number) => s.charAt(i + n)
  const validEscape = (n: number) => at(n) === '\\' && at(n + 1) !== '\n'
  const startsIdent = (n: number) => {
    const c = at(n)
    if (c === '-') return isNameStart(at(n + 1)) || at(n + 1) === '-' || validEscape(n + 1)
    return isNameStart(c) || validEscape(n)
  }
  const startsNumber = (n: number) => {
    const c = at(n)
    if (c === '+' || c === '-')
      return isDigit(at(n + 1)) || (at(n + 1) === '.' && isDigit(at(n + 2)))
    return c === '.' ? isDigit(at(n + 1)) : isDigit(c)
  }
  // The code point after a backslash, which is already consumed.
  const escape = (): string => {
    if (i >= s.length) return '\ufffd'
    if (!isHex(at(0))) {
      const c = String.fromCodePoint(s.codePointAt(i) as number)
      i += c.length
      return c
    }
    let hex = ''
    while (hex.length < 6 && isHex(at(0))) hex += s[i++]
    if (isSpace(at(0))) i++
    const code = parseInt(hex, 16)
    return code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)
      ? '\ufffd'
      : String.fromCodePoint(code)
  }
  const name = (): string => {
    let v = ''
    for (;;)
      if (isName(at(0)) && at(0) !== '') v += s[i++]
      else if (validEscape(0)) {
        i++
        v += escape()
      } else return v
  }
  const number = (): string => {
    const from = i
    if (at(0) === '+' || at(0) === '-') i++
    while (isDigit(at(0))) i++
    if (at(0) === '.' && isDigit(at(1))) {
      i++
      while (isDigit(at(0))) i++
    }
    const sign = at(1) === '+' || at(1) === '-' ? 1 : 0
    if ((at(0) === 'e' || at(0) === 'E') && isDigit(at(1 + sign))) {
      i += 1 + sign
      while (isDigit(at(0))) i++
    }
    return s.slice(from, i)
  }
  const numeric = () => {
    const value = number()
    if (startsIdent(0)) out.push({ type: 'dimension', value, unit: name() })
    else if (at(0) === '%') {
      i++
      out.push({ type: 'percentage', value })
    } else out.push({ type: 'number', value })
  }
  const string = (quote: string) => {
    let value = ''
    for (;;) {
      const c = at(0)
      if (c === '' || c === quote) {
        i++
        return out.push({ type: 'string', value })
      }
      if (c === '\n') return out.push({ type: 'bad-string' })
      i++
      if (c !== '\\') value += c
      else if (at(0) === '\n') i++
      else if (at(0) !== '') value += escape()
    }
  }
  const url = () => {
    let value = ''
    while (isSpace(at(0))) i++
    for (;;) {
      const c = at(0)
      if (c === '' || c === ')') {
        i++
        return out.push({ type: 'url', value })
      }
      if (isSpace(c)) {
        while (isSpace(at(0))) i++
        if (at(0) === '' || at(0) === ')') continue
        break
      }
      if (c === '"' || c === "'" || c === '(' || isNonPrintable(c)) break
      if (c === '\\' && !validEscape(0)) break
      i++
      value += c === '\\' ? escape() : c
    }
    while (at(0) !== '' && at(0) !== ')') i += validEscape(0) ? 2 : 1
    i++
    out.push({ type: 'bad-url' })
  }
  const identLike = () => {
    const value = name()
    if (at(0) !== '(') return out.push({ type: 'ident', value })
    i++
    if (value.toLowerCase() !== 'url') return out.push({ type: 'function', value })
    while (isSpace(at(0)) && isSpace(at(1))) i++
    const quote = isSpace(at(0)) ? at(1) : at(0)
    if (quote === '"' || quote === "'") return out.push({ type: 'function', value })
    url()
  }

  while (i < s.length) {
    const c = at(0)
    if (c === '/' && at(1) === '*') {
      const end = s.indexOf('*/', i + 2)
      i = end < 0 ? s.length : end + 2
    } else if (isSpace(c)) {
      while (isSpace(at(0))) i++
      out.push({ type: 'whitespace' })
    } else if (c === '"' || c === "'") {
      i++
      string(c)
    } else if (c === '#' && (isName(at(1)) || validEscape(1)) && at(1) !== '') {
      i++
      const id = startsIdent(0)
      out.push({ type: 'hash', value: name(), id })
    } else if (startsNumber(0)) numeric()
    else if (c === '-' && at(1) === '-' && at(2) === '>') {
      i += 3
      out.push({ type: 'cdc' })
    } else if (c === '<' && s.startsWith('!--', i + 1)) {
      i += 4
      out.push({ type: 'cdo' })
    } else if (c === '@' && startsIdent(1)) {
      i++
      out.push({ type: 'at', value: name() })
    } else if (startsIdent(0)) identLike()
    else {
      i++
      if (MARKS.includes(c)) out.push({ type: c as Mark })
      else out.push({ type: 'delim', value: c })
    }
  }
  return out
}

const hexEscape = (c: string) => `\\${(c.codePointAt(0) as number).toString(16)} `

const escapeName = (value: string, ident: boolean): string => {
  const chars = Array.from(value)
  if (ident && value === '-') return '\\-'
  return chars
    .map((c, n) => {
      if (c <= '\u001f' || c === '\u007f' || c === '<') return hexEscape(c)
      if (ident && isDigit(c) && (n === 0 || (n === 1 && chars[0] === '-'))) return hexEscape(c)
      return isName(c) ? c : `\\${c}`
    })
    .join('')
}

const escapeString = (value: string) =>
  `"${Array.from(value)
    .map(c =>
      c === '"' || c === '\\'
        ? `\\${c}`
        : c <= '\u001f' || c === '\u007f' || c === '<'
          ? hexEscape(c)
          : c
    )
    .join('')}"`

// A unit that would read back as an exponent gets its first letter escaped.
const escapeUnit = (unit: string) =>
  /^[eE]([+-]?\d)/.test(unit)
    ? hexEscape(unit[0]) + escapeName(unit.slice(1), false)
    : escapeName(unit, true)

const write = (t: Token): string => {
  switch (t.type) {
    case 'ident':
      return escapeName(t.value, true)
    case 'function':
      return `${escapeName(t.value, true)}(`
    case 'at':
      return `@${escapeName(t.value, true)}`
    case 'hash':
      return `#${escapeName(t.value, t.id)}`
    case 'string':
      return escapeString(t.value)
    case 'url':
      return `url(${escapeString(t.value)})`
    case 'delim':
      return t.value === '\\' ? '' : t.value
    case 'number':
      return t.value
    case 'percentage':
      return `${t.value}%`
    case 'dimension':
      return t.value + escapeUnit(t.unit)
    case 'whitespace':
      return ' '
    case 'cdo':
      return '<!--'
    case 'cdc':
      return '-->'
    case 'bad-string':
    case 'bad-url':
      return ''
    default:
      return t.type
  }
}

type Any = Token | { type: 'block' } | undefined
const delim = (t: Any, ...values: string[]) =>
  t !== undefined && t.type === 'delim' && values.includes(t.value)
const numberLike = (t: Any) =>
  t !== undefined && (t.type === 'number' || t.type === 'percentage' || t.type === 'dimension')
const identLike = (t: Token) => t.type === 'ident' || t.type === 'function' || t.type === 'url'

// Would two tokens written side by side read back as something else?
const merges = (a: Token, b: Token): boolean => {
  const word = identLike(b) || delim(b, '-') || numberLike(b) || b.type === 'cdc'
  if (a.type === 'ident') return word || b.type === '('
  if (a.type === 'at' || a.type === 'hash' || a.type === 'dimension') return word
  if (delim(a, '#', '-')) return word
  if (a.type === 'number') return identLike(b) || numberLike(b) || delim(b, '%') || b.type === 'cdc'
  if (delim(a, '@')) return identLike(b) || delim(b, '-') || b.type === 'cdc'
  if (delim(a, '.', '+')) return numberLike(b)
  if (delim(a, '/')) return delim(b, '*')
  return delim(a, '<') && delim(b, '!')
}

// Tokens as text that reads back as the same tokens.
export const serialize = (tokens: readonly Token[]): string => {
  let out = ''
  let last: Token | null = null
  for (const t of tokens) {
    const text = write(t)
    if (text === '') continue
    if (last && merges(last, t)) out += '/**/'
    out += text
    last = t
  }
  return out
}

interface Block {
  type: 'block'
  open: '(' | '[' | '{'
  name?: string
  items: Part[]
}
type Part = Token | Block

const CLOSE = { '(': ')', '[': ']', '{': '}' } as const
const MAX_DEPTH = 64

class TooDeep extends Error {}

const nest = (tokens: Token[]): Part[] => {
  const root: Part[] = []
  const stack: Block[] = []
  let cur = root
  for (const t of tokens) {
    const top = stack[stack.length - 1]
    if (t.type === '(' || t.type === '[' || t.type === '{' || t.type === 'function') {
      const block: Block =
        t.type === 'function'
          ? { type: 'block', open: '(', name: t.value, items: [] }
          : { type: 'block', open: t.type, items: [] }
      cur.push(block)
      stack.push(block)
      if (stack.length > MAX_DEPTH) throw new TooDeep()
      cur = block.items
    } else if (top && t.type === CLOSE[top.open]) {
      stack.pop()
      cur = stack.length ? stack[stack.length - 1].items : root
    } else cur.push(t)
  }
  return root
}

const flat = (parts: readonly Part[]): Token[] =>
  parts.flatMap((p): Token[] =>
    p.type !== 'block'
      ? [p]
      : [
          p.name === undefined ? { type: p.open } : { type: 'function', value: p.name },
          ...flat(p.items),
          { type: CLOSE[p.open] },
        ]
  )

const text = (parts: readonly Part[]) => serialize(flat(parts))
const space = (p: Part | undefined) => p !== undefined && p.type === 'whitespace'
const trim = (parts: readonly Part[]): Part[] => {
  let from = 0
  let to = parts.length
  while (from < to && space(parts[from])) from++
  while (to > from && space(parts[to - 1])) to--
  return parts.slice(from, to)
}
const split = (parts: readonly Part[], by: ',' | ';'): Part[][] => {
  const out: Part[][] = [[]]
  for (const p of parts)
    if (p.type === by) out.push([])
    else out[out.length - 1].push(p)
  return out
}
const braces = (p: Part) => p.type === 'block' && p.open === '{'
const lower = (p: Part | undefined) =>
  p !== undefined && p.type === 'ident' ? p.value.toLowerCase() : null

// Written into markup, text with these two characters could end a style element. Names and
// strings write `<` as an escape, so only a `<` on its own can meet a `/`.
const closes = (written: string) => written.includes('</')

// Would an attribute selector on `id` match the protected root?
const reachesProtected = (items: readonly Part[]): boolean => {
  const parts = items.filter(i => !space(i))
  // The name may follow a namespace: `ns|id`, `*|id`, `|id`.
  const bar = parts.findIndex(i => delim(i, '|'))
  const at = bar >= 0 && bar <= 1 && parts[bar + 1]?.type === 'ident' ? bar + 1 : 0
  const name = parts[at]
  const rest = parts.slice(at + 1)
  const eq = rest.findIndex(i => delim(i, '='))
  const value = rest[eq + 1]
  if (lower(name) !== 'id' || eq < 0 || value === undefined) return false
  if (value.type !== 'string' && value.type !== 'ident') return false
  const v = value.value.toLowerCase()
  const before = rest[eq - 1]
  const op = before !== undefined && before.type === 'delim' ? before.value : '='
  if (op === '^') return v !== '' && PROTECTED.startsWith(v)
  if (op === '$') return v !== '' && PROTECTED.endsWith(v)
  if (op === '*') return v !== '' && PROTECTED.includes(v)
  return v === PROTECTED || (op === '|' && PROTECTED.startsWith(`${v}-`))
}

export interface CssOpts {
  // The plugin whose surfaces count as its own; null for Quick CSS, which has none.
  plugin?: string | null
  // The url the host serves one of the plugin's assets at, or null when it has none.
  asset?: (path: string) => string | null
  // The size cap in bytes: CSS_MAX_BYTES unless given. Stored output takes CSS_MAX_STORED_BYTES.
  maxBytes?: number
}

export interface CssResult {
  css: string
  // What was left out, for the plugin's log.
  dropped: string[]
}

const ASSET = /^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)*$/
const DATA = /^data:(image|font)\/[a-z0-9.+-]+[;,]/i
const IMAGE_FUNCTIONS = [
  'image-set',
  '-webkit-image-set',
  'image',
  'cross-fade',
  '-webkit-cross-fade',
]
const TEXT_PROPERTIES = [
  'content',
  'quotes',
  'list-style',
  'list-style-type',
  'hyphenate-character',
  '-webkit-hyphenate-character',
  'text-emphasis',
  'text-emphasis-style',
  '-webkit-text-emphasis',
  '-webkit-text-emphasis-style',
  'text-overflow',
  'string-set',
]
const PAGE_TYPES = ['html', 'body']
const PAGE_PSEUDOS = ['root', 'host', 'host-context', 'scope', 'backdrop', 'part', 'slotted']
// Functions that paint another element or run a worklet.
const PAINT_FUNCTIONS = ['element', '-moz-element', 'paint']
const MARKERS = ['none', 'disc', 'circle', 'square', 'disclosure-open', 'disclosure-closed']
const COUNTERS = ['counter-reset', 'counter-set', 'counter-increment']
const ANIMATIONS = ['animation', 'animation-name', '-webkit-animation', '-webkit-animation-name']
// Properties that name something other rules look up across the page: anchors, position
// fallbacks, view transitions and timelines.
const NAMED = [
  'anchor-name',
  'anchor-scope',
  'position-anchor',
  'position-try',
  'position-try-fallbacks',
  'view-transition-name',
  'scroll-timeline',
  'scroll-timeline-name',
  'view-timeline',
  'view-timeline-name',
  'timeline-scope',
  'animation-timeline',
]
const ANCHOR_FUNCTIONS = ['anchor', 'anchor-size']
const VIEW_WORDS = ['none', 'auto', 'match-element', 'initial', 'unset', 'revert', 'revert-layer']
const ANIMATION_WORD =
  /^(none|infinite|normal|reverse|alternate(-reverse)?|forwards|backwards|both|running|paused|linear|ease(-in)?(-out)?|step-(start|end)|initial|inherit|unset|revert(-layer)?)$/
const PROTECTED = 'rc-protected'
const SELECTOR_DELIMS = ['.', '*', '>', '+', '~', '|', '=', '^', '$']
const MAX_NOTES = 50
const MAX_NOTE = 80

export const sanitizeCss = (css: string, opts: CssOpts = {}): CssResult => {
  const dropped: string[] = []
  const note = (what: string) => {
    if (dropped.length < MAX_NOTES) dropped.push(what.slice(0, MAX_NOTE))
  }
  const plugin = opts.plugin || null

  // An address that may stay: one of the plugin's assets, or an inline image or font.
  const address = (value: string): string | null => {
    if (DATA.test(value)) return value
    if (!value.startsWith('asset:')) return null
    const path = value.slice(6)
    if (!ASSET.test(path) || path.split('/').includes('..')) return null
    return opts.asset ? opts.asset(path) : value
  }

  // A value with its addresses checked, or null when the whole declaration must go. Inside
  // the image functions (`image`) and in a custom property (`custom`) every string is an
  // address. A custom property keeps one as url(), so it never holds a string that a text
  // property could show through var().
  const clean = (parts: readonly Part[], strings: 'none' | 'image' | 'custom'): Part[] | null => {
    const out: Part[] = []
    const keep = (value: string, as: 'string' | 'url') => {
      const ok = address(value)
      if (ok === null) return note('address')
      const s: Token = { type: 'string', value: ok }
      out.push(as === 'string' ? s : { type: 'block', open: '(', name: 'url', items: [s] })
    }
    for (const p of parts) {
      if (p.type === 'block') {
        if (p.open === '{') return null
        const fn = p.name?.toLowerCase()
        if (fn === 'url' || fn === 'src') {
          const first = trim(p.items)[0]
          if (first !== undefined && first.type === 'string') keep(first.value, 'url')
          else note('address')
          continue
        }
        if (fn !== undefined && PAINT_FUNCTIONS.includes(fn)) {
          note(`function ${fn}`)
          continue
        }
        const image = fn !== undefined && IMAGE_FUNCTIONS.includes(fn)
        const inner = clean(p.items, strings === 'none' && image ? 'image' : strings)
        if (inner === null) return null
        out.push({ ...p, items: inner })
      } else if (p.type === 'url') keep(p.value, 'url')
      else if (p.type === 'string' && strings !== 'none')
        keep(p.value, strings === 'custom' ? 'url' : 'string')
      else if (p.type === 'bad-string' || p.type === 'bad-url' || delim(p, '\\')) return null
      else if (p.type === ')' || p.type === ']' || p.type === '}') return null
      else out.push(p)
    }
    return out
  }

  // Outside the plugin's own surfaces a rule may not write words: no generated content, no
  // marker that spells, no counter, and only keywords in the other properties that take text.
  // A cursor there is a built-in one, so a click lands where the pointer shows.
  const quiet = (name: string, value: readonly Part[]): boolean => {
    const all = value.filter(p => !space(p))
    const n = all.length
    const important = n > 1 && delim(all[n - 2], '!') && lower(all[n - 1]) === 'important'
    const parts = important ? all.slice(0, n - 2) : all
    const words = parts.map(lower)
    if (name === 'content') return words.length === 1 && ['none', 'normal'].includes(words[0] ?? '')
    if (name === 'list-style-type') return words.length === 1 && MARKERS.includes(words[0] ?? '')
    if (name === 'list-style')
      return parts.every(
        (p, n) =>
          (p.type === 'block' && p.name === 'url') ||
          [...MARKERS, 'inside', 'outside'].includes(words[n] ?? '')
      )
    if (COUNTERS.includes(name) || name === 'quotes' || name === 'string-set') return false
    return !(TEXT_PROPERTIES.includes(name) || name === 'cursor') || words.every(w => w !== null)
  }

  // Names the scoper makes the plugin's own start with its id and an underscore, which no id
  // holds, so no plugin can make another one's name or one of the app's (they hold none).
  const owner = plugin ?? 'quickcss'
  const prefix = `${owner}_`
  const mine = (name: string) => (name.startsWith(prefix) ? name : prefix + name)
  const dashed = (name: string) => `--${mine(name.slice(2))}`

  // A name in one of the NAMED properties is made the plugin's own. It can't come from a
  // variable, an attribute or the parent, so the value holds names and keywords only.
  const ownNames = (name: string, value: readonly Part[]): Part[] => {
    if (value.some(p => p.type === 'block' || lower(p) === 'inherit')) return []
    const bare = name === 'view-transition-name'
    const bang = value.findIndex(p => delim(p, '!'))
    return value.map((p, n) => {
      if (p.type !== 'ident' || (bang >= 0 && n > bang)) return p
      if (p.value.startsWith('--')) return { ...p, value: dashed(p.value) }
      const word = VIEW_WORDS.includes(p.value.toLowerCase())
      return bare && !word ? { ...p, value: mine(p.value) } : p
    })
  }

  // So is a name inside anchor() and anchor-size(), wherever they are.
  const anchors = (value: readonly Part[], inside = false): Part[] =>
    value.map(p => {
      if (p.type === 'block')
        return {
          ...p,
          items: anchors(p.items, ANCHOR_FUNCTIONS.includes(p.name?.toLowerCase() ?? '')),
        }
      return inside && p.type === 'ident' && p.value.startsWith('--')
        ? { ...p, value: dashed(p.value) }
        : p
    })

  // An animation that names keyframes this sheet defines follows their new name.
  const renamed = (name: string, value: readonly Part[]): Part[] =>
    value.map(p => {
      if ((p.type !== 'ident' && p.type !== 'string') || !defined.has(p.value)) return p
      const word =
        p.type === 'ident' &&
        (name.endsWith('-name') ? p.value === 'none' : ANIMATION_WORD.test(p.value))
      return word ? p : { ...p, value: mine(p.value) }
    })

  const declarations = (parts: readonly Part[], own: boolean): string[] => {
    const out: string[] = []
    const one = (chunk: Part[]) => {
      // A nested rule ends at its block; what follows it is read as declarations again.
      let after = chunk.length
      while (after > 0 && !braces(chunk[after - 1])) after--
      if (after > 0) note('nested rule')
      const body = trim(chunk.slice(after))
      if (body.length === 0) return
      const first = body[0]
      const colon = body.findIndex(p => p.type === ':')
      if (first.type !== 'ident' || colon < 1 || !body.slice(1, colon).every(space))
        return note('declaration')
      const custom = first.value.startsWith('--')
      const name = custom ? first.value : first.value.toLowerCase()
      const value = clean(body.slice(colon + 1), custom ? 'custom' : 'none')
      const cleaned = value === null ? [] : trim(value)
      const kept = ANIMATIONS.includes(name)
        ? renamed(name, cleaned)
        : NAMED.includes(name)
          ? ownNames(name, cleaned)
          : anchors(cleaned)
      const written = `${escapeName(name, true)}:${text(kept)}`
      const app = custom && APP_VARIABLES.some(start => name.startsWith(start))
      // `all: inherit` would give an element the names its parent has.
      const inherits = name === 'all' && kept.some(p => lower(p) === 'inherit')
      if (kept.length === 0 || app || inherits || !(own || quiet(name, kept)) || closes(written))
        return note(`declaration ${name}`)
      out.push(written)
    }
    for (const chunk of split(parts, ';')) one(chunk)
    return out
  }

  // 'refused' names the page, a host of another tree, the backdrop or the protected root;
  // 'invalid' is not a selector at all.
  const verdict = (
    parts: readonly Part[],
    attr: boolean,
    top: boolean
  ): 'ok' | 'refused' | 'invalid' => {
    let worst: 'ok' | 'refused' = 'ok'
    let prev: Part | undefined
    for (const p of parts) {
      if (p.type === 'block') {
        if (p.open === '{' || (p.open === '(' && p.name === undefined) || attr) return 'invalid'
        if (p.open === '(' && (prev === undefined || prev.type !== ':')) return 'invalid'
        const fn = p.name?.toLowerCase()
        if (fn !== undefined && PAGE_PSEUDOS.includes(fn)) worst = 'refused'
        if (p.open === '[' && reachesProtected(p.items)) worst = 'refused'
        const inner = verdict(p.items, p.open === '[', false)
        if (inner === 'invalid') return inner
        if (inner === 'refused') worst = inner
      } else if (p.type === 'ident') {
        const v = p.value.toLowerCase()
        if (attr ? v.includes(PROTECTED) : prev?.type === ':' ? PAGE_PSEUDOS.includes(v) : false)
          worst = 'refused'
        if (!attr && PAGE_TYPES.includes(v) && prev?.type !== ':' && !delim(prev, '.'))
          worst = 'refused'
      } else if (p.type === 'hash') {
        if (attr || !p.id) return 'invalid'
        if (p.value.toLowerCase() === PROTECTED) worst = 'refused'
      } else if (p.type === 'string') {
        if (top) return 'invalid'
        if (p.value.toLowerCase().includes(PROTECTED)) worst = 'refused'
      } else if (p.type === 'delim') {
        if (p.value === '&') worst = 'refused'
        else if (!SELECTOR_DELIMS.includes(p.value) && !(p.value === '-' && !top)) return 'invalid'
      } else if (p.type === ',' || numberLike(p)) {
        if (top) return 'invalid'
      } else if (p.type !== ':' && p.type !== 'whitespace') return 'invalid'
      if (p.type !== 'whitespace') prev = p
    }
    return worst
  }

  const appPrefix = (parts: readonly Part[]): number => {
    const [colon, where] = parts
    if (colon?.type !== ':' || where?.type !== 'block' || where.name?.toLowerCase() !== 'where')
      return 0
    const inner = trim(where.items)
    const box = inner[0]
    if (inner.length !== 1 || box.type !== 'block' || box.open !== '[') return 0
    const names = trim(box.items)
    return names.length === 1 && lower(names[0]) === 'data-rc-app' ? 2 : 0
  }

  const a11y = (p: Part) =>
    p.type === 'block' &&
    p.open === '[' &&
    (A11Y_ATTRS as readonly string[]).includes(lower(trim(p.items)[0]) ?? '')

  const ownSurface = (p: Part) => {
    if (plugin === null || p.type !== 'block' || p.open !== '[') return false
    const [name, eq, value, ...rest] = p.items.filter(i => !space(i))
    return (
      rest.length === 0 &&
      lower(name) === 'data-rc-plugin' &&
      delim(eq, '=') &&
      value !== undefined &&
      (value.type === 'string' || value.type === 'ident') &&
      value.value === plugin
    )
  }

  // The selector under the app container, and whether everything it matches is inside one of
  // the plugin's own surfaces.
  const scope = (given: readonly Part[]): { css: string; own: boolean } | 'refused' | 'invalid' => {
    const stripped = trim(given)
    const parts = trim(stripped.slice(appPrefix(stripped)))
    if (parts.length === 0) return 'invalid'
    const v = verdict(parts, false, true)
    if (v !== 'ok') return v
    // Compounds and the combinators between them: ' ' for a descendant.
    const compounds: Part[][] = [[]]
    const joins: string[] = []
    for (const p of parts) {
      const combinator = space(p)
        ? ' '
        : p.type === 'delim' && '>+~'.includes(p.value)
          ? p.value
          : null
      const cur = compounds[compounds.length - 1]
      if (combinator === null) cur.push(p)
      else if (cur.length > 0) {
        joins.push(combinator)
        compounds.push([])
      } else if (combinator !== ' ') {
        if (joins.length === 0 || joins[joins.length - 1] !== ' ') return 'invalid'
        joins[joins.length - 1] = combinator
      }
    }
    if (compounds[compounds.length - 1].length === 0) return 'invalid'
    const piped = parts.some(p => delim(p, '|'))
    const inside = (from: number) => !piped && joins.slice(from).every(j => j === ' ' || j === '>')
    const leads =
      compounds.length > 1 && compounds[0].every(a11y) && (joins[0] === ' ' || joins[0] === '>')
    const anchor = leads ? 1 : 0
    return {
      css: `:where([data-rc-app])${leads ? '' : ' '}${text(parts)}`,
      own: compounds[anchor].some(ownSurface) && inside(anchor),
    }
  }

  const style = (prelude: readonly Part[], block: Block): string | null => {
    const selectors: string[] = []
    let own = true
    for (const one of split(prelude, ',')) {
      const got = scope(one)
      if (got === 'invalid') {
        note(`selector ${text(trim(prelude))}`)
        return null
      }
      if (got === 'refused') {
        note(`selector ${text(trim(one))}`)
        continue
      }
      selectors.push(got.css)
      own = own && got.own
    }
    if (selectors.length === 0) return null
    const body = declarations(block.items, own)
    return body.length ? `${selectors.join(',')}{${body.join(';')}}` : null
  }

  // A font family is a name for the whole page, closed roots included, so one defined here
  // must start with the plugin's id and an underscore (`quickcss_` for Quick CSS), which no
  // family of the app's holds, be printable ASCII (browsers fold case by Unicode, where `\17f`
  // is an `s`) and be none of the app's. Then it can never stand in for a font the app uses.
  // This reads the declarations as they are written.
  const ownFamily = (body: readonly string[]): boolean => {
    const families = body.filter(d => d.startsWith('font-family:'))
    return (
      families.length > 0 &&
      families.every(d => {
        const value = tokenize(d.slice('font-family:'.length))
        const name = value[0]
        return (
          value.length === 1 &&
          (name.type === 'string' || name.type === 'ident') &&
          name.value.length > owner.length + 1 &&
          /^[\x20-\x7e]+$/.test(name.value) &&
          name.value.toLowerCase().startsWith(prefix) &&
          !APP_FONTS.includes(name.value.toLowerCase())
        )
      })
    )
  }

  const keyframes = (parts: readonly Part[]): string => {
    const out: string[] = []
    for (const r of rules(parts)) {
      const stops = trim(r.prelude)
      const ok = stops.every(
        p =>
          space(p) ||
          p.type === ',' ||
          p.type === 'percentage' ||
          ['from', 'to'].includes(lower(p) ?? '')
      )
      if (r.at !== undefined || !r.block || !ok || stops.length === 0) {
        note('keyframe')
        continue
      }
      const body = declarations(r.block.items, false)
      if (body.length) out.push(`${text(stops)}{${body.join(';')}}`)
    }
    return out.join('')
  }

  interface Rule {
    at?: string
    prelude: Part[]
    block: Block | null
  }

  const rules = (parts: readonly Part[]): Rule[] => {
    const out: Rule[] = []
    let cur: Rule | null = null
    for (const p of parts) {
      if (cur === null) {
        if (space(p) || p.type === 'cdo' || p.type === 'cdc') continue
        cur =
          p.type === 'at'
            ? { at: p.value.toLowerCase(), prelude: [], block: null }
            : { prelude: [p], block: null }
        if (p.type === 'block' && p.open === '{') {
          out.push({ prelude: [], block: p })
          cur = null
        }
      } else if (p.type === 'block' && p.open === '{') {
        out.push({ ...cur, block: p })
        cur = null
      } else if (p.type === ';' && cur.at !== undefined) {
        out.push(cur)
        cur = null
      } else cur.prelude.push(p)
    }
    if (cur !== null && cur.at !== undefined) out.push(cur)
    return out
  }

  const sheet = (parts: readonly Part[]): string[] => {
    const out: string[] = []
    for (const r of rules(parts)) {
      if (r.at === undefined) {
        const s = r.block ? style(r.prelude, r.block) : null
        if (s !== null) out.push(s)
        continue
      }
      const prelude = clean(r.prelude, 'none')
      const head = prelude === null ? '' : text(trim(prelude))
      const names = (prelude ?? []).every(
        p => space(p) || p.type === 'ident' || p.type === ',' || delim(p, '.')
      )
      if (prelude === null || closes(head)) note(`@${r.at}`)
      else if (['media', 'supports', 'container'].includes(r.at) && r.block) {
        const inner = sheet(r.block.items)
        if (inner.length) out.push(`@${r.at} ${head}{${inner.join('\n')}}`)
      } else if (r.at === 'layer' && names) {
        // The first name of each layer path takes the prefix.
        let first = true
        const layers = text(
          trim(prelude).map(p => {
            const lead = first && p.type === 'ident'
            first = p.type === ',' || (first && space(p))
            return lead && p.type === 'ident' ? { ...p, value: mine(p.value) } : p
          })
        )
        const inner = r.block ? sheet(r.block.items) : []
        if (!r.block && layers) out.push(`@layer ${layers};`)
        else if (inner.length) out.push(`@layer${layers ? ` ${layers}` : ''}{${inner.join('\n')}}`)
      } else if (r.at === 'keyframes' && r.block) {
        const [title, ...more] = trim(prelude)
        const frames = keyframes(r.block.items)
        if (more.length === 0 && (title?.type === 'ident' || title?.type === 'string') && frames)
          out.push(`@keyframes ${text([{ ...title, value: mine(title.value) }])}{${frames}}`)
        else note('@keyframes')
      } else if (r.at === 'font-face' && r.block && head === '') {
        const body = declarations(r.block.items, false)
        if (ownFamily(body)) out.push(`@font-face{${body.join(';')}}`)
        else note('@font-face')
      } else note(`@${r.at}`)
    }
    return out
  }

  // The keyframes this sheet defines, at any depth, as their names were written.
  const defined = new Set<string>()
  const collect = (parts: readonly Part[]) => {
    for (const r of rules(parts)) {
      const [title, ...more] = trim(r.prelude)
      if (r.at === 'keyframes' && more.length === 0 && title !== undefined) {
        if (title.type === 'ident' || title.type === 'string') defined.add(title.value)
      } else if (r.at !== undefined && r.block) collect(r.block.items)
    }
  }

  if (new TextEncoder().encode(css).length > (opts.maxBytes ?? CSS_MAX_BYTES))
    return { css: '', dropped: ['too large'] }
  try {
    const parts = nest(tokenize(css))
    collect(parts)
    return { css: sheet(parts).join('\n'), dropped }
  } catch (e) {
    if (e instanceof TooDeep) return { css: '', dropped: ['nested too deep'] }
    throw e
  }
}
