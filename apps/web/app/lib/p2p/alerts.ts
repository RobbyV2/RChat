import type { AlertInput } from '../notices'
import { levelOf, messageAlert, pingToast, type NotifyPrefs, type Resolved } from '../notify'
import type { UserRef } from '../types'
import type { PingKind } from './dag'
import type { Arrival } from './dm'
import type { MsgContent } from './event'

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

// Pings that badge (the P2P tile, the tab title): every conversation except those set to
// "Nothing".
export const badgePings = (
  rooms: Record<string, { id: string; pings: number }>,
  prefs: NotifyPrefs
) =>
  Object.values(rooms).reduce(
    (n, r) => n + (levelOf(prefs, { kind: 'p2p', room: r.id }) === 'nothing' ? 0 : r.pings),
    0
  )
