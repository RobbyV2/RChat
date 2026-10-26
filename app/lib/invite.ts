export interface InviteTarget {
  server: string
  password: string | null
}

export interface InviteLink extends InviteTarget {
  url: string
}

export interface OpenInvite extends InviteTarget {
  join: boolean
}

export interface InviteEntry extends InviteTarget {
  pushed: boolean
}

const STASH = 'rchat_invite'
const HANDOFF_MS = 10 * 60 * 1000
const SCHEME = /^[a-z][a-z0-9+.-]*:/i
const URL_RE = /https?:\/\/[^\s<>"'`]+/gi
const TRAIL = /[)\]}>.,;:!?*_~|'"]+$/
const FENCE = /^(?: {0,3}>)* {0,3}(`{3,}|~{3,})(.*)$/
const LIST_ITEM = /^ {0,3}(?:[-+*]|\d{1,9}[.)])(?:\s|$)/
const CODE_SPAN = /(^|[^`])(`+)(?!`)(?:(?!\n[ \t]*\n)[\s\S])*?[^`]\2(?!`)/g
const SPOILER = /\|\|(?:(?!\|\||\n[ \t]*\n)[\s\S])+\|\|/g

const hex = (c: string) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`

const strictEncode = (s: string) => encodeURIComponent(s).replace(/[!'()*~]/g, hex)

const queryEncode = (s: string) => encodeURIComponent(s).replace(/[^%A-Za-z0-9]/g, hex)

export const invitePath = (server: string) => `/invite/${strictEncode(server)}/`

export const inviteUrl = (server: string, password?: string | null, origin?: string) => {
  const pw = password?.trim()
  const base = origin ?? window.location.origin
  return `${base}${invitePath(server)}${pw ? `?password=${queryEncode(pw)}` : ''}`
}

export const parseInvite = (href: string, origin: string): InviteTarget | null => {
  if (!SCHEME.test(href) && !href.startsWith('/')) return null
  let url: URL
  try {
    url = new URL(href, origin)
  } catch {
    return null
  }
  if (url.origin !== origin) return null
  const match = url.pathname.match(/^\/invite\/([^/]+)\/?$/)
  if (!match) return null
  let server: string
  try {
    server = decodeURIComponent(match[1]).trim().toLowerCase()
  } catch {
    return null
  }
  if (!server) return null
  const password = url.searchParams.get('password')?.trim()
  return { server, password: password || null }
}

const withoutCodeBlocks = (text: string) => {
  let fence: string | null = null
  let indented = false
  let list = false
  let blank = true
  return text
    .split('\n')
    .map(line => {
      const open = line.match(FENCE)
      if (fence !== null) {
        const [, marks = '', rest = ''] = open ?? []
        if (marks[0] === fence[0] && marks.length >= fence.length && !rest.trim()) {
          fence = null
          blank = true
        }
        return ''
      }
      if (open && !(open[1][0] === '`' && open[2].includes('`'))) {
        fence = open[1]
        indented = false
        return ''
      }
      if (!line.trim()) {
        blank = true
        return line
      }
      const deep = /^(?: {4}|\t)/.test(line)
      const code = deep && !list && (blank || indented)
      if (!deep) list = LIST_ITEM.test(line) || (list && !blank)
      indented = code
      blank = false
      return code ? '' : line
    })
    .join('\n')
}

const visibleText = (text: string) =>
  withoutCodeBlocks(text)
    .replace(CODE_SPAN, (_, lead: string) => `${lead} `)
    .replace(SPOILER, ' ')

export const findInvites = (text: string, origin: string, max = 3): InviteLink[] => {
  const out: InviteLink[] = []
  for (const match of visibleText(text).matchAll(URL_RE)) {
    const url = match[0].replace(TRAIL, '')
    const target = parseInvite(url, origin)
    if (!target || out.some(o => o.server === target.server)) continue
    out.push({ ...target, url })
    if (out.length === max) break
  }
  return out
}

export const safeNext = (raw: string | null | undefined) => {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return null
  const control = Array.from(raw).some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
  return control ? null : raw
}

export const previewText = (content: string) =>
  content
    .replace(/\|\|([\s\S]+?)\|\|/g, (_, inner: string) =>
      '\u2588'.repeat(Math.min(8, Math.max(3, inner.trim().length)))
    )
    .replace(/^\s{0,3}(#{1,6}|>)\s+/gm, '')
    .replace(/(\*\*|__|~~|`)/g, '')
    .replace(/\s+/g, ' ')
    .trim()

export const inviteEntry = (state: unknown, server: string): InviteEntry | null => {
  const saved = (state as { rchatInvite?: Partial<InviteEntry> } | null)?.rchatInvite
  if (!saved || saved.server !== server) return null
  const password = typeof saved.password === 'string' ? saved.password : null
  return { server, password, pushed: saved.pushed === true }
}

export const entryState = (entry: InviteEntry) => ({ rchatInvite: entry })

const session = () => {
  try {
    return window.sessionStorage
  } catch {
    return null
  }
}

export const handoffFor = (
  raw: string | null,
  server: string,
  now: number
): InviteTarget | null => {
  if (!raw) return null
  try {
    const saved = JSON.parse(raw) as Partial<InviteTarget & { at: number }>
    const fresh = typeof saved.at === 'number' && saved.at <= now && now - saved.at < HANDOFF_MS
    if (!fresh || saved.server !== server) return null
    return { server, password: typeof saved.password === 'string' ? saved.password : null }
  } catch {
    return null
  }
}

export const stashInvite = (target: InviteTarget) =>
  session()?.setItem(STASH, JSON.stringify({ ...target, at: Date.now() }))

export const takeStashedInvite = (server: string | null) => {
  const store = session()
  const raw = store?.getItem(STASH) ?? null
  if (raw !== null) store?.removeItem(STASH)
  return server === null ? null : handoffFor(raw, server, Date.now())
}

export const dropStashedInvite = () => session()?.removeItem(STASH)
