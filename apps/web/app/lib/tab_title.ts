// The browser tab's (and the desktop window's) title: the place on screen, a leading dot while
// something is unread or waits, and the count of unseen notifications. Pure.
import { badgeText } from './pings'
import type { TabMark } from './platform/notifications'
import type { DmSummary, Me, ServerDetail } from './types'

export type TabPlace =
  | { kind: 'channel'; channel: string; server: string; voice: boolean; own: boolean }
  | { kind: 'dm'; name: string; own: boolean }
  | { kind: 'server'; server: string; own: boolean }
  | { kind: 'app' }

// The app itself: Home, and a place that is not known yet.
export const APP_PLACE: TabPlace = { kind: 'app' }

export const tabMark = (pings: number, unread: boolean): TabMark =>
  pings > 0 ? 'pings' : unread ? 'unread' : 'none'

// A hosted server as its tab names it: with the channel `channelId` when the server has it.
export const serverPlace = (
  s: {
    servers: Record<string, Pick<ServerDetail, 'display_name' | 'creator' | 'channels'> | undefined>
    me: Pick<Me, 'username' | 'servers'> | null
  },
  name: string,
  channelId: number | null
): TabPlace => {
  const detail = s.servers[name]
  const summary = s.me?.servers.find(x => x.name === name)
  const server = detail?.display_name ?? summary?.display_name ?? name
  const own = !!s.me && (summary?.creator ?? detail?.creator) === s.me.username
  const channel = detail?.channels.find(c => c.id === channelId)
  return channel
    ? { kind: 'channel', server, channel: channel.name, voice: channel.kind === 'voice', own }
    : { kind: 'server', server, own }
}

// A hosted DM; the app while the account does not list it.
export const dmPlace = (s: { dms: readonly DmSummary[] }, dmId: number): TabPlace => {
  const dm = s.dms.find(d => d.id === dmId)
  return dm ? { kind: 'dm', name: dm.other.display_name, own: dm.is_self } : APP_PLACE
}

// A P2P room, with its channel `ch` when the room has it; the app while the room loads.
export const roomPlace = (
  s: {
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
    me: string | null
  },
  room: string,
  ch: string | null
): TabPlace => {
  const v = s.servers[room]
  if (!v) return APP_PLACE
  const own = !!s.me && (v.owner === s.me || v.owners.includes(s.me))
  const channel = v.channels.find(c => c.id === ch)
  return channel
    ? {
        kind: 'channel',
        server: v.name,
        channel: channel.name,
        voice: channel.kind === 'voice',
        own,
      }
    : { kind: 'server', server: v.name, own }
}

// A P2P conversation with the contact called `name`; the app without one.
export const conversationPlace = (name: string | null): TabPlace =>
  name === null ? APP_PLACE : { kind: 'dm', name, own: false }

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
