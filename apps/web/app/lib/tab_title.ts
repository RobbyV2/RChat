// The browser tab's (and the desktop window's) title: the place on screen, a leading dot while
// something is unread or waits, and the count of unseen notifications. Pure.
import { badgeText } from './pings'
import type { TabMark } from './platform/notifications'
import type { DmSummary, Me, ServerDetail } from './types'
import type { View } from './view'

export type TabPlace =
  | { kind: 'channel'; channel: string; server: string; voice: boolean; own: boolean }
  | { kind: 'dm'; name: string; own: boolean }
  | { kind: 'server'; server: string; own: boolean }
  | { kind: 'app' }

const APP: TabPlace = { kind: 'app' }

export const tabMark = (pings: number, unread: boolean): TabMark =>
  pings > 0 ? 'pings' : unread ? 'unread' : 'none'

// The instance place open in an account, or the app on Home and while nothing is open.
export const hostedPlace = (s: {
  view: View | null
  home: boolean
  dms: readonly DmSummary[]
  servers: Record<string, Pick<ServerDetail, 'display_name' | 'creator' | 'channels'> | undefined>
  me: Pick<Me, 'username' | 'servers'> | null
}): TabPlace => {
  const v = s.view
  if (!v || s.home) return APP
  if (v.kind === 'dm') {
    const dm = s.dms.find(d => d.id === v.dmId)
    return dm ? { kind: 'dm', name: dm.other.display_name, own: dm.is_self } : APP
  }
  const detail = s.servers[v.server]
  const summary = s.me?.servers.find(x => x.name === v.server)
  const server = detail?.display_name ?? summary?.display_name ?? v.server
  const own = !!s.me && (summary?.creator ?? detail?.creator) === s.me.username
  const channel = detail?.channels.find(c => c.id === v.channelId)
  return channel
    ? { kind: 'channel', server, channel: channel.name, voice: channel.kind === 'voice', own }
    : { kind: 'server', server, own }
}

export interface P2pPlaceSource {
  home: boolean
  server: { room: string; ch: string | null } | null
  servers: Record<
    string,
    | {
        name: string
        owner: string | null
        owners: readonly string[]
        channels: readonly { id: string; name: string; kind: string }[]
      }
    | undefined
  >
  chat: { peer: string; ch?: string } | null
  me: string | null
}

// The P2P place open in an identity: a server channel, the server while it loads, a conversation,
// the P2P home (the app); null while P2P isn't on screen.
export const p2pPlace = (
  s: P2pPlaceSource,
  contactName: (ik: string) => string | null
): TabPlace | null => {
  if (s.server) {
    const v = s.servers[s.server.room]
    if (!v) return APP
    const own = !!s.me && (v.owner === s.me || v.owners.includes(s.me))
    const ch = v.channels.find(c => c.id === s.server?.ch)
    return ch
      ? { kind: 'channel', server: v.name, channel: ch.name, voice: ch.kind === 'voice', own }
      : { kind: 'server', server: v.name, own }
  }
  if (!s.home) return null
  const name = s.chat && !s.chat.ch ? contactName(s.chat.peer) : null
  return name === null ? APP : { kind: 'dm', name, own: false }
}

// "#general · Club", "Lounge · Club" (voice), "@Alice", "Club", or the app's name. Streamer mode
// names no server, channel or person.
export const placeText = (place: TabPlace, app: string, streamer: boolean) => {
  switch (place.kind) {
    case 'channel':
      return streamer ? 'Server' : `${place.voice ? '' : '#'}${place.channel} · ${place.server}`
    case 'dm':
      return streamer ? 'Direct message' : `@${place.name}`
    case 'server':
      return streamer ? 'Server' : place.server
    case 'app':
      return app
  }
}

// "(3) • #general · Club", "• @Alice", "Club".
export const tabTitle = (
  place: TabPlace,
  app: string,
  streamer: boolean,
  pings: number,
  unread: boolean
) => {
  const text = placeText(place, app, streamer)
  const count = pings > 0 ? `(${badgeText(pings)}) ` : ''
  return `${count}${tabMark(pings, unread) === 'none' ? '' : '• '}${text}`
}
