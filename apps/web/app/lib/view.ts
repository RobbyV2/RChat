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
  'users',
  'servers',
  'audit',
  'config',
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

export const adminPath = (section: AdminSection | null, item: string | null = null) => {
  if (section === null) return '/admin/'
  return item !== null && ADMIN_ITEMS.includes(section)
    ? `/admin/${section}/${encodeURIComponent(item)}/`
    : `/admin/${section}/`
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

export const messagePath = ({ place, thread, id }: Omit<MessageTarget, 'kind'>) =>
  `${viewPath(place)}${thread === null ? '' : `t/${thread}/`}${id}/`

export const viewPath = (view: View | null) => {
  if (view === null) return '/'
  return view.kind === 'channel'
    ? `/s/${encodeURIComponent(view.server)}/${view.channelId}/`
    : `/dm/${view.dmId}/`
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

export const parsePath = (pathname: string): PathTarget | null => {
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
