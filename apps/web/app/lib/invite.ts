import type { StorageLike } from './instances'
import { replaceSpoilers, spoilerParts } from './spoilers'
import type { Invite, InviteLinkInfo, InviteStatus, JoinMode } from './types'

// An invite by name (`server`, with `password` when the link has one), or by an invite code
// (`code`, with `server` empty until the code is looked up).
export interface InviteTarget {
  server: string
  password: string | null
  code?: string
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

const hex = (c: string) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`

const strictEncode = (s: string) => encodeURIComponent(s).replace(/[!'()*~]/g, hex)

const queryEncode = (s: string) => encodeURIComponent(s).replace(/[^%A-Za-z0-9]/g, hex)

// What an invite card does by itself after a sign-in that started on it. An account that may
// only read the server is not asked for a password it may not have.
export const autoStep = (status: InviteStatus, guest: boolean): 'open' | 'stop' | 'join' => {
  if (status === 'member') return 'open'
  if (status === 'banned' || (status === 'readable' && !guest)) return 'stop'
  return 'join'
}

export const invitePath = (server: string) => `/invite/${strictEncode(server)}/`

// Invite codes use lowercase letters and digits that can't be mistaken for each other.
const CODE = /^[2-9a-hjkmnp-z]{6,32}$/

export const isCode = (raw: string) => CODE.test(raw)

export const codePath = (code: string) => `/i/${code}/`

export const codeUrl = (code: string, origin: string) => `${origin}${codePath(code)}`

export const targetPath = (target: InviteTarget) =>
  target.code ? codePath(target.code) : invitePath(target.server)

export const sameInvite = (a: InviteTarget, b: InviteTarget) =>
  a.server === b.server && (a.code ?? null) === (b.code ?? null)

// Whether people get into a server through its invite link rather than its name.
export const sharedByCode = (mode: JoinMode | undefined) => mode === 'invite' || mode === 'closed'

// The link that invites someone to `server`: its name link, or for a server people join with an
// invite, its invite link (`link`, null when it has none).
export const shareLink = (
  server: string,
  mode: JoinMode | undefined,
  link: InviteLinkInfo | null | undefined,
  origin: string
) => {
  if (!sharedByCode(mode)) return inviteUrl(server, null, origin)
  return link ? codeUrl(link.code, origin) : null
}

export const inviteUrl = (server: string, password: string | null | undefined, origin: string) => {
  const pw = password?.trim()
  const base = origin
  return `${base}${invitePath(server)}${pw ? `#password=${queryEncode(pw)}` : ''}`
}

// Keep routing fragments and query parameters when moving an invite password into history state.
export function publicInvitePath(url: URL) {
  if (url.searchParams.has('password')) url.searchParams.delete('password')
  const fragment = new URLSearchParams(url.hash.slice(1))
  if (fragment.has('password')) {
    fragment.delete('password')
    url.hash = fragment.toString()
  }
  return url.pathname + url.search + url.hash
}

const linkPassword = (url: URL) => {
  const fragment = new URLSearchParams(url.hash.replace(/^#/, '')).get('password')?.trim()
  return fragment || url.searchParams.get('password')?.trim() || null
}

export interface RemoteInvite extends InviteLink {
  origin: string
}

export const parseInviteAt = (href: string, base: string): RemoteInvite | null => {
  if (!SCHEME.test(href) && !href.startsWith('/')) return null
  let url: URL
  try {
    url = new URL(href, base)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (url.username || url.password) return null
  const coded = url.pathname.match(/^\/i\/([^/]+)\/?$/)?.[1].toLowerCase()
  if (coded !== undefined)
    return isCode(coded)
      ? { origin: url.origin, server: '', password: null, code: coded, url: url.href }
      : null
  const match = url.pathname.match(/^\/invite\/([^/]+)\/?$/)
  if (!match) return null
  let server: string
  try {
    server = decodeURIComponent(match[1]).trim().toLowerCase()
  } catch {
    return null
  }
  if (!server) return null
  return { origin: url.origin, server, password: linkPassword(url), url: url.href }
}

export const parseInvite = (href: string, origin: string): InviteTarget | null => {
  const found = parseInviteAt(href, origin)
  if (!found || found.origin !== origin) return null
  const { server, password, code } = found
  return code ? { server, password, code } : { server, password }
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
  withoutCodeBlocks(replaceSpoilers(text, () => ' ')).replace(
    CODE_SPAN,
    (_, lead: string) => `${lead} `
  )

export const visibleLinks = (text: string) =>
  [...visibleText(text).matchAll(URL_RE)].map(match => match[0].replace(TRAIL, ''))

export const findInvites = (text: string, origin: string, max = 3): InviteLink[] => {
  const out: InviteLink[] = []
  for (const url of visibleLinks(text)) {
    const target = parseInvite(url, origin)
    if (!target || out.some(o => sameInvite(o, target))) continue
    out.push({ ...target, url })
    if (out.length === max) break
  }
  return out
}

export const findRemoteInvites = (
  text: string,
  local: string[],
  allowed: (origin: string) => boolean,
  max = 3
): RemoteInvite[] => {
  const out: RemoteInvite[] = []
  for (const url of visibleLinks(text)) {
    const found = parseInviteAt(url, 'http://invalid')
    if (!found || found.code || local.includes(found.origin) || !allowed(found.origin)) continue
    if (out.some(o => o.origin === found.origin && o.server === found.server)) continue
    out.push({ ...found, url })
    if (out.length === max) break
  }
  return out
}

export const remoteKey = ({ origin, server }: { origin: string; server: string }) =>
  `${origin}\n${server}`

export const remoteInviteUrl = ({ origin, server, password }: RemoteInvite) =>
  inviteUrl(server, password, origin)

export const safeNext = (raw: string | null | undefined) => {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return null
  const control = Array.from(raw).some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
  return control ? null : raw
}

export const spoilerBlocks = (inner: string) =>
  inner.trim() ? '\u2588'.repeat(Math.min(8, Math.max(3, inner.trim().length))) : ''

const plainPreview = (text: string) =>
  text
    .replace(/^\s{0,3}(#{1,6}|>)\s+/gm, '')
    .replace(/(\*\*|__|~~|`)/g, '')
    .replace(/\s+/g, ' ')

// Plain text for notifications and other previews where the reader cannot reveal a spoiler.
export const previewText = (content: string, cut = false) =>
  plainPreview(replaceSpoilers(content, spoilerBlocks, cut)).trim()

// Keep the contents of each spoiler separate for in-app reveal controls. A truncated
// excerpt can end inside a spoiler.
export const previewParts = (content: string, cut = false) =>
  spoilerParts(content, cut).map(p => ({ ...p, text: plainPreview(p.text) }))

export const inviteEntry = (
  state: unknown,
  server: string,
  code: string | null = null,
  owner?: string
): InviteEntry | null => {
  if ((state as { rchatInviteOwner?: unknown } | null)?.rchatInviteOwner !== owner) return null
  const saved = (state as { rchatInvite?: Partial<InviteEntry> } | null)?.rchatInvite
  if (!saved || saved.server !== server || (saved.code ?? null) !== code) return null
  const password = typeof saved.password === 'string' ? saved.password : null
  return code
    ? { server, password, code, pushed: saved.pushed === true }
    : { server, password, pushed: saved.pushed === true }
}

export const entryState = (entry: InviteEntry, owner?: string) => ({
  rchatInvite: entry,
  ...(owner === undefined ? {} : { rchatInviteOwner: owner }),
})

export const handoffFor = (
  raw: string | null,
  server: string,
  now: number,
  code: string | null = null
): InviteTarget | null => {
  if (!raw) return null
  try {
    const saved = JSON.parse(raw) as Partial<InviteTarget & { at: number }>
    const fresh = typeof saved.at === 'number' && saved.at <= now && now - saved.at < HANDOFF_MS
    if (!fresh || saved.server !== server || (saved.code ?? null) !== code) return null
    const password = typeof saved.password === 'string' ? saved.password : null
    return code ? { server, password, code } : { server, password }
  } catch {
    return null
  }
}

export const stashInvite = (target: InviteTarget, store: StorageLike) =>
  store.setItem(STASH, JSON.stringify({ ...target, at: Date.now() }))

export const takeStashedInvite = (
  server: string | null,
  code: string | null,
  store: StorageLike
) => {
  const raw = store.getItem(STASH)
  if (raw !== null) store.removeItem(STASH)
  return server === null ? null : handoffFor(raw, server, Date.now(), code)
}

export const dropStashedInvite = (store: StorageLike) => store.removeItem(STASH)

const INVITE_VERSIONS_MAX = 500
export function createInviteUpdates() {
  const inviteVersions = new Map<string, number>()
  const inviteWatchers = new Set<() => void>()
  let inviteEpoch = 0

  const inviteVersion = (server: string) => inviteEpoch + (inviteVersions.get(server) ?? 0)

  const staleInvites = (server: string | null) => {
    if (server === null || inviteVersions.size >= INVITE_VERSIONS_MAX) {
      inviteEpoch += 1 + Math.max(0, ...inviteVersions.values())
      inviteVersions.clear()
    } else inviteVersions.set(server, (inviteVersions.get(server) ?? 0) + 1)
    for (const fn of inviteWatchers) fn()
  }

  const watchInvites = (fn: () => void) => {
    inviteWatchers.add(fn)
    return () => {
      inviteWatchers.delete(fn)
    }
  }

  return { inviteVersion, staleInvites, watchInvites }
}
export const INVITE_QUIET = 2_000
export const INVITE_MAX_WAIT = 10_000
export const INVITE_GAP = 15_000

export const refreshDelay = (
  staleSince: number,
  lastBump: number,
  fetchedAt: number,
  now: number
) => {
  const due = Math.min(lastBump + INVITE_QUIET, staleSince + INVITE_MAX_WAIT)
  return Math.max(0, Math.max(due, fetchedAt + INVITE_GAP) - now)
}

export const keepsPreview = (status: number | null) =>
  status === null || status === 429 || status >= 500

export const hostParts = (text: string, host: string): { text: string; host: boolean }[] => {
  if (!host) return [{ text, host: false }]
  return text
    .split(host)
    .flatMap((part, i) =>
      i
        ? [
            { text: host, host: true },
            { text: part, host: false },
          ]
        : [{ text: part, host: false }]
    )
    .filter(p => p.text !== '')
}

// A pinned preview answer holds the room the viewer chose, or names the room's new state.
export const pinnedPreview = (
  asked: { id?: number | null; label?: boolean },
  got: Pick<Invite, 'preview_channel_id' | 'preview_sensitive' | 'preview_channel' | 'preview'>
) =>
  (got.preview_channel_id ?? null) === (asked.id ?? null) && got.preview_sensitive === asked.label
    ? { messages: got.preview, changed: null }
    : {
        messages: null,
        changed: {
          id: got.preview_channel_id ?? null,
          label: got.preview_sensitive === true,
          name: got.preview_channel,
        },
      }
