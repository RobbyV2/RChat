// The Branding section of the site administration page: the controls that name the instance
// and the app it serves, with their limits and the name of each in the server config.

import { BRAND_ROWS } from './admin/rows.gen'
import type { BrandLink, InstanceSuggestion, InstanceSuggestions } from './types'
import { anything, obj, opt, parseJson, str, type Schema } from './schema'

const textMax = (key: string) => {
  const row = BRAND_ROWS.find(r => r.key === key)
  return row?.kind === 'text' ? row.max : 0
}

export const BRAND_NAME_MAX = textMax('instance_name')
export const BRAND_SHORT_NAME_MAX = textMax('app_short_name')
export const BRAND_ABOUT_MAX = textMax('brand_about')
export const BRAND_LOGIN_NOTE_MAX = textMax('login_note')
export const BRAND_LINKS_MAX = 4
export const BRAND_LABEL_MAX = 32
export const BRAND_SUGGESTIONS_MAX = 20

interface Base {
  // The control's name in the server's list of controls.
  key: string
  env: string
  label: string
  line: string
  keywords?: string[]
}

export type BrandRow =
  | (Base & { kind: 'text'; min: number; max: number; lines: boolean; placeholder?: string })
  | (Base & { kind: 'links' })
  | (Base & { kind: 'suggestions' })

export { BRAND_ROWS }

export const brandRow = (key: string) => BRAND_ROWS.find(r => r.key === key)

const count = (text: string) => [...text].length

// Whether the text holds a control character other than a line break where breaks are allowed.
const hasControl = (text: string, lines: boolean) =>
  [...text].some(c => {
    const code = c.codePointAt(0) ?? 0
    const control = code < 32 || (code >= 127 && code < 160)
    return control && !(lines && c === '\n')
  })

// What is wrong with a text for `row`, or null. The server trims it and checks the same.
export const textError = (row: Extract<BrandRow, { kind: 'text' }>, raw: string): string | null => {
  const text = raw.replace(/\r\n/g, '\n').trim()
  const n = count(text)
  if (n < row.min) return 'Enter a name.'
  if (n > row.max) return `Use at most ${row.max} characters.`
  if (hasControl(text, row.lines)) return row.lines ? 'Use plain text.' : 'Use one line of text.'
  return null
}

const httpsUrl = (raw: string, schemes: string[]): URL | null => {
  try {
    const url = new URL(raw.trim())
    const plain = url.username === '' && url.password === '' && url.hostname !== ''
    return schemes.includes(url.protocol) && plain ? url : null
  } catch {
    return null
  }
}

// What is wrong with the links, or null.
export const linksError = (links: BrandLink[]): string | null => {
  if (links.length > BRAND_LINKS_MAX) return `Use at most ${BRAND_LINKS_MAX} links.`
  for (const link of links) {
    const label = link.label.trim()
    if (label === '') return 'Give each link a label.'
    if (count(label) > BRAND_LABEL_MAX)
      return `Use at most ${BRAND_LABEL_MAX} characters in a label.`
    if (hasControl(label, false)) return 'Use one line of text in a label.'
    if (!httpsUrl(link.url, ['https:']))
      return 'Each link needs an address that starts with https://.'
  }
  return null
}

// What is wrong with the suggested instances, or null.
export const suggestionsError = (list: InstanceSuggestion[]): string | null => {
  if (list.length > BRAND_SUGGESTIONS_MAX) return `Use at most ${BRAND_SUGGESTIONS_MAX} instances.`
  for (const s of list) {
    if (count(s.label.trim()) > BRAND_LABEL_MAX)
      return `Use at most ${BRAND_LABEL_MAX} characters in a label.`
    if (hasControl(s.label.trim(), false)) return 'Use one line of text in a label.'
    if (!httpsUrl(s.url, ['http:', 'https:']))
      return 'Each instance needs an address that starts with https:// or http://.'
  }
  return null
}

const LINK = obj({ label: str(), url: str() })
const SUGGESTION = obj({ url: str(), label: opt(anything) })
const SUGGESTIONS = obj({ mode: opt(anything), list: opt(anything) })

// The entries of `list` that fit `shape`; the others are left out.
const fitting = <T>(list: unknown, shape: Schema<T>): T[] =>
  Array.isArray(list)
    ? list.flatMap(item => {
        const parsed = shape.parse(item)
        return parsed.ok ? [parsed.value] : []
      })
    : []

// The links a stored or config value holds; an unreadable value holds none.
export const linksOf = (shown: string | null | undefined): BrandLink[] => {
  const parsed = parseJson(shown ?? '[]', anything)
  return parsed.ok ? fitting(parsed.value, LINK) : []
}

// The suggested instances a stored or config value holds; an unreadable value holds none.
export const suggestionsOf = (shown: string | null | undefined): InstanceSuggestions => {
  const parsed = parseJson(shown ?? '', SUGGESTIONS)
  if (!parsed.ok) return { mode: 'add', list: [] }
  return {
    mode: parsed.value.mode === 'replace' ? 'replace' : 'add',
    list: fitting(parsed.value.list, SUGGESTION).map((s): InstanceSuggestion => ({
      url: s.url,
      label: typeof s.label === 'string' ? s.label : '',
    })),
  }
}
