export type View =
  { kind: 'channel'; server: string; channelId: number } | { kind: 'dm'; dmId: number }

export type Nav = 'push' | 'replace' | 'none'

export interface MessageTarget {
  kind: 'message'
  place: View
  thread: number | null
  id: number
}

export type PathTarget = View | { kind: 'server'; server: string } | MessageTarget

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
      const server = decodeURIComponent(raw)
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
      const server = decodeURIComponent(raw)
      return id === undefined
        ? { kind: 'server', server }
        : { kind: 'channel', server, channelId: Number(id) }
    } catch {
      return null
    }
  }
  const dm = pathname.match(/^\/dm\/(\d+)\/?$/)
  return dm ? { kind: 'dm', dmId: Number(dm[1]) } : null
}

export const viewKey = (view: View) =>
  view.kind === 'channel' ? `c${view.channelId}` : `d${view.dmId}`

export const threadKey = (rootId: number) => `t${rootId}`
