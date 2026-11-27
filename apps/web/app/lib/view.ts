import { accountUsername, isHost, normalizeHost } from './qualified'

export interface RouteOwner {
  username: string | null
  host: string
}

const routeHost = (value: string) =>
  value.trim() === value && !value.endsWith(':') && isHost(value) ? normalizeHost(value) : null

// Only the first path segment names the account. Keep the query and fragment opaque.
export function parseAccountPath(href: string): { owner: RouteOwner | null; path: string } | null {
  const pathname = href.split(/[?#]/, 1)[0]
  if (!pathname.startsWith('/') || pathname.startsWith('//') || /[\\\p{Cc}]/u.test(pathname))
    return null
  if (!pathname.startsWith('/@')) return { owner: null, path: href }
  const end = pathname.indexOf('/', 2)
  const prefix = pathname.slice(2, end < 0 ? undefined : end)
  const at = prefix.indexOf('@')
  const host = routeHost(prefix.slice(at + 1))
  if (!host) return null
  let username: string | null = null
  if (at !== -1) {
    try {
      username = accountUsername(decodeURIComponent(prefix.slice(0, at)))
    } catch {
      return null
    }
    if (!username) return null
  }
  const path = end < 0 ? '/' + href.slice(pathname.length) : href.slice(end)
  if (path.startsWith('//') || path.startsWith('/@')) return null
  return { owner: { username, host }, path }
}

// An omitted owner denotes the primary account. Requalifying a local link replaces its prefix.
export function accountPath(href: string, owner?: RouteOwner | null): string {
  const route = parseAccountPath(href)
  if (!route) throw new Error('Invalid local account path')
  if (!owner) return route.path
  const host = routeHost(owner.host)
  const username = owner.username === null ? null : accountUsername(owner.username)
  if (!host || (owner.username !== null && username === null))
    throw new Error('Invalid route owner')
  return '/@' + (username === null ? '' : encodeURIComponent(username) + '@') + host + route.path
}

export type View =
  { kind: 'channel'; server: string; channelId: number } | { kind: 'dm'; dmId: number }

export type Nav = 'push' | 'replace' | 'none'

export interface MessageTarget {
  kind: 'message'
  place: View
  thread: number | null
  id: number
}

// The sections of the site administration page, in the order its nav lists them.
export const ADMIN_SECTIONS = [
  'overview',
  'features',
  'branding',
  'users',
  'servers',
  'audit',
  'config',
  'encryption',
  'danger',
] as const

export type AdminSection = (typeof ADMIN_SECTIONS)[number]

// A place in the site administration page: its list of sections (`section` null), a section, or
// one account or server (`item`).
export interface AdminTarget {
  kind: 'admin'
  section: AdminSection | null
  item: string | null
}

const ADMIN_ITEMS: readonly AdminSection[] = ['users', 'servers']

export const adminPath = (
  section: AdminSection | null,
  item: string | null = null,
  owner?: RouteOwner | null
) => {
  if (section === null) return accountPath('/admin/', owner)
  return accountPath(
    item !== null && ADMIN_ITEMS.includes(section)
      ? `/admin/${section}/${encodeURIComponent(item)}/`
      : `/admin/${section}/`,
    owner
  )
}

const parseAdmin = (pathname: string): AdminTarget | null => {
  const found = pathname.match(/^\/admin(?:\/([^/]+)(?:\/([^/]+))?)?\/?$/)
  if (!found) return null
  const [, raw, item] = found
  if (raw === undefined) return { kind: 'admin', section: null, item: null }
  const section = ADMIN_SECTIONS.find(s => s === raw)
  if (!section) return null
  if (item === undefined) return { kind: 'admin', section, item: null }
  if (!ADMIN_ITEMS.includes(section)) return null
  try {
    return { kind: 'admin', section, item: decodeURIComponent(item) }
  } catch {
    return null
  }
}

export type PathTarget = View | { kind: 'server'; server: string } | MessageTarget | AdminTarget

export const serverPath = (server: string, owner?: RouteOwner | null) =>
  accountPath(`/s/${encodeURIComponent(server)}/`, owner)

export const messagePath = (
  { place, thread, id }: Omit<MessageTarget, 'kind'>,
  owner?: RouteOwner | null
) => `${viewPath(place, owner)}${thread === null ? '' : `t/${thread}/`}${id}/`

export const viewPath = (view: View | null, owner?: RouteOwner | null) => {
  if (view === null) return accountPath('/', owner)
  return view.kind === 'channel'
    ? `${serverPath(view.server, owner)}${view.channelId}/`
    : accountPath(`/dm/${view.dmId}/`, owner)
}

const parseMessage = (pathname: string): MessageTarget | null => {
  const channel = pathname.match(/^\/s\/([^/]+)\/(\d+)\/(?:t\/(\d+)\/)?(\d+)\/?$/)
  if (channel) {
    const [, raw, channelId, thread, id] = channel
    try {
      const server = decodeURIComponent(raw).toLowerCase()
      return {
        kind: 'message',
        place: { kind: 'channel', server, channelId: Number(channelId) },
        thread: thread === undefined ? null : Number(thread),
        id: Number(id),
      }
    } catch {
      return null
    }
  }
  const dm = pathname.match(/^\/dm\/(\d+)\/(\d+)\/?$/)
  return dm
    ? {
        kind: 'message',
        place: { kind: 'dm', dmId: Number(dm[1]) },
        thread: null,
        id: Number(dm[2]),
      }
    : null
}

export const parsePath = (href: string): PathTarget | null => {
  const route = parseAccountPath(href)
  if (!route) return null
  const pathname = route.path.split(/[?#]/, 1)[0]
  const message = parseMessage(pathname)
  if (message) return message
  const channel = pathname.match(/^\/s\/([^/]+)(?:\/(\d+))?\/?$/)
  if (channel) {
    const [, raw, id] = channel
    try {
      const server = decodeURIComponent(raw).toLowerCase()
      return id === undefined
        ? { kind: 'server', server }
        : { kind: 'channel', server, channelId: Number(id) }
    } catch {
      return null
    }
  }
  const dm = pathname.match(/^\/dm\/(\d+)\/?$/)
  return dm ? { kind: 'dm', dmId: Number(dm[1]) } : parseAdmin(pathname)
}

export const viewKey = (view: View) =>
  view.kind === 'channel' ? `c${view.channelId}` : `d${view.dmId}`

export const threadKey = (rootId: number) => `t${rootId}`
