import type { AlertInput } from '../notices'
import {
  levelOf,
  messageAlert,
  mutedOf,
  pingToast,
  type NotifyPrefs,
  type Resolved,
} from '../notify'
import type { UserRef } from '../types'
import { visibleContacts, type Contact } from './contacts'
import type { PingKind } from './dag'
import type { Arrival } from './dm'
import type { MsgContent } from './event'
import type { ServerView } from './server'

// How a new event in a P2P conversation notifies, by the conversation's Task 9 rule: pings
// (mentions, replies to you, reactions to your messages) toast unless muted or "Nothing"; other
// messages only under "All messages" and unmuted.

const PING_ACTION: Record<PingKind, string> = {
  mention: 'mentioned you',
  reply: 'replied to you',
  reaction: 'reacted to your message',
}

export const p2pAlert = (
  a: Arrival,
  rule: Resolved,
  actor: UserRef,
  go: () => void
): AlertInput | null => {
  const c = a.rec.wire.c
  const base = {
    key: `p2p:${a.room}`,
    actor,
    server: null,
    channel: null,
    dm: true,
    name: actor.display_name,
    go,
  }
  if (a.ping) {
    if (!pingToast(rule)) return null
    const key = a.ping === 'reaction' && c && 'key' in c ? c.key : null
    const body = a.ping === 'reaction' ? '' : ((c as MsgContent | null)?.body ?? '')
    return {
      ...base,
      action: key ? `reacted ${key} to your message` : PING_ACTION[a.ping],
      body,
      message: a.ping !== 'reaction',
      generic: 'New notification',
    }
  }
  if (!a.unread || !messageAlert(rule, false)) return null
  const m = c as MsgContent | null
  return {
    ...base,
    action: '',
    body: m?.body || m?.fwd?.body || '',
    message: true,
    generic: 'New message',
  }
}

// The contacts the conversation list has a row for (mutual, not blocked or ignored): only their
// conversations count, since nothing else can be opened and read.
export const listedPeers = (contacts: Contact[]): ReadonlySet<string> =>
  new Set(
    visibleContacts(contacts)
      .filter(c => c.state === 'mutual')
      .map(c => c.ik)
  )

type Counted = { id: string; peer: string; unread: number; pings: number }

const listedRooms = <R extends { peer: string }>(
  rooms: Record<string, R>,
  listed: ReadonlySet<string>
) => Object.values(rooms).filter(r => listed.has(r.peer))

// Pings that badge (the P2P tile, the tab title): every listed conversation except those set to
// "Nothing".
export const badgePings = (
  rooms: Record<string, Omit<Counted, 'unread'>>,
  prefs: NotifyPrefs,
  listed: ReadonlySet<string>
) =>
  listedRooms(rooms, listed).reduce(
    (n, r) => n + (levelOf(prefs, { kind: 'p2p', room: r.id }) === 'nothing' ? 0 : r.pings),
    0
  )

// Pings in a server's channels that badge: channels set to "Nothing" don't, nor channels that
// don't show (deleted, or we may no longer view them: they couldn't be cleared).
export const serverPings = (
  v: { id: string; chans: Record<string, { pings: number }>; channels: readonly { id: string }[] },
  prefs: NotifyPrefs
) =>
  Object.entries(v.chans).reduce(
    (n, [ch, c]) =>
      n +
      (!v.channels.some(x => x.id === ch) ||
      levelOf(prefs, { kind: 'p2pc', room: v.id, ch }) === 'nothing'
        ? 0
        : c.pings),
    0
  )

export interface P2pUnreadRow {
  v: ServerView
  pings: number
  // Unread channels that show it (not muted).
  channels: number
}

// What Home's Unread card lists of P2P: joined servers with pings or unread channels (pinging
// ones first, then by name), and whether conversations have pings or unread messages.
export const p2pUnread = (
  st: {
    servers: Record<string, ServerView>
    rooms: Record<string, Counted>
    contacts: Contact[]
  },
  prefs: NotifyPrefs,
  now: number
) => {
  const listed = listedPeers(st.contacts)
  const servers: P2pUnreadRow[] = Object.values(st.servers)
    .filter(v => v.me === 'join')
    .map(v => ({
      v,
      pings: serverPings(v, prefs),
      channels: mutedOf(prefs, { kind: 'p2ps', room: v.id }, now)
        ? 0
        : v.channels.filter(
            c =>
              (v.chans[c.id]?.unread ?? 0) > 0 &&
              !mutedOf(prefs, { kind: 'p2pc', room: v.id, ch: c.id }, now)
          ).length,
    }))
    .filter(r => r.pings > 0 || r.channels > 0)
    .sort((a, b) => b.pings - a.pings || a.v.name.localeCompare(b.v.name))
  return {
    servers,
    dms: {
      pings: badgePings(st.rooms, prefs, listed),
      unread: listedRooms(st.rooms, listed).some(
        r => r.unread > 0 && !mutedOf(prefs, { kind: 'p2p', room: r.id }, now)
      ),
    },
  }
}
