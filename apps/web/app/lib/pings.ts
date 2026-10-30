import type { Ping, PingSummary, Unread } from './types'
import { pingToast, type Resolved } from './notify'

// Unseen pings under one key: the channel or DM scope for pings outside threads, `t<root id>` for
// pings on thread replies. `scope` is where the badge rolls up (the channel for a thread).
// `bulk` pings are known only by count (from /api/unreads or ping_count), all with ids up to
// `bulkUntil`; `ids` are pings that arrived live.
export interface PingCount {
  scope: string
  server: string | null
  bulk: number
  bulkUntil: number
  ids: number[]
}

export type Pings = Record<string, PingCount>

export const NO_PINGS: Pings = {}

export const pingKey = (ping: Ping) =>
  ping.thread_root_id !== null ? `t${ping.thread_root_id}` : ping.scope

export const pingCount = (p: PingCount | undefined) => (p ? p.bulk + p.ids.length : 0)

export const pingUntil = (p: PingCount | undefined) =>
  p ? p.ids.reduce((n, id) => Math.max(n, id), p.bulkUntil) : 0

const without = (pings: Pings, key: string): Pings => {
  if (!(key in pings)) return pings
  const out = { ...pings }
  delete out[key]
  return out
}

const put = (pings: Pings, key: string, p: PingCount): Pings =>
  pingCount(p) > 0 ? { ...pings, [key]: p } : without(pings, key)

export const addPing = (pings: Pings, ping: Ping): Pings => {
  const key = pingKey(ping)
  const cur = pings[key]
  if (cur && (ping.id <= cur.bulkUntil || cur.ids.includes(ping.id))) return pings
  return put(pings, key, {
    scope: ping.scope,
    server: ping.server,
    bulk: cur?.bulk ?? 0,
    bulkUntil: cur?.bulkUntil ?? 0,
    ids: [...(cur?.ids ?? []), ping.id],
  })
}

// Drops the pings under `key` with ids up to `until` (all of them by default). Counted pings
// newer than `until` stay.
export const clearPings = (pings: Pings, key: string, until = Infinity): Pings => {
  const cur = pings[key]
  if (!cur) return pings
  const bulkGone = cur.bulk > 0 && cur.bulkUntil <= until
  const ids = cur.ids.filter(id => id > until)
  if (!bulkGone && ids.length === cur.ids.length) return pings
  return put(pings, key, {
    ...cur,
    bulk: bulkGone ? 0 : cur.bulk,
    bulkUntil: bulkGone ? 0 : cur.bulkUntil,
    ids,
  })
}

// The keys and counts a scope summary (an /api/unreads item or a ping_count event) describes.
const summaryPings = (
  scope: string,
  server: string | null,
  sum: PingSummary
): [string, PingCount][] => {
  const threads = sum.thread_pings ?? []
  const top = (sum.pings ?? 0) - threads.reduce((n, t) => n + t.pings, 0)
  const out: [string, PingCount][] = []
  if (top > 0)
    out.push([scope, { scope, server, bulk: top, bulkUntil: sum.pings_until ?? 0, ids: [] }])
  for (const t of threads)
    if (t.pings > 0)
      out.push([
        `t${t.root_id}`,
        { scope, server, bulk: t.pings, bulkUntil: t.pings_until, ids: [] },
      ])
  return out
}

// Replaces everything under `scope` (its own key and its threads) with the summary.
export const setScopePings = (
  pings: Pings,
  scope: string,
  server: string | null,
  sum: PingSummary
): Pings => {
  const out: Pings = {}
  for (const [key, p] of Object.entries(pings)) if (p.scope !== scope) out[key] = p
  for (const [key, p] of summaryPings(scope, server, sum)) out[key] = p
  return out
}

export const forgetPings = (
  pings: Pings,
  drop: (scope: string, p: PingCount) => boolean
): Pings => {
  const kept = Object.entries(pings).filter(([, p]) => !drop(p.scope, p))
  return kept.length === Object.keys(pings).length ? pings : Object.fromEntries(kept)
}

// Server counts from GET /api/unreads win, except for keys that changed locally while the
// request was in flight (a live ping or a read since `before`) and scopes it does not list.
export const mergePings = (before: Pings, current: Pings, items: Unread[]): Pings => {
  const out: Pings = {}
  for (const i of items)
    for (const [key, p] of summaryPings(i.scope, i.server, i))
      if (current[key] === before[key]) out[key] = p
  for (const [key, p] of Object.entries(current))
    if (p !== before[key] || !messageScope(p.scope)) out[key] = p
  return out
}

// Channel and DM scopes; others (`friends`) are not in /api/unreads.
const messageScope = (scope: string) => scope[0] === 'c' || scope[0] === 'd'

const sum = (pings: Pings, pick: (p: PingCount) => boolean) => {
  let n = 0
  for (const p of Object.values(pings)) if (pick(p)) n += pingCount(p)
  return n
}

// A channel or DM row's count, its threads included.
export const scopePings = (pings: Pings, scope: string) => sum(pings, p => p.scope === scope)

export const serverPings = (pings: Pings, server: string) => sum(pings, p => p.server === server)

export const dmPings = (pings: Pings) => sum(pings, p => p.scope[0] === 'd')

export const totalPings = (pings: Pings) => sum(pings, () => true)

// The pings that count toward badges.
export const shownPings = (
  pings: Pings,
  shown: (scope: string, server: string | null) => boolean
) => {
  const kept = Object.entries(pings).filter(([, p]) => shown(p.scope, p.server))
  return kept.length === Object.keys(pings).length ? pings : Object.fromEntries(kept)
}

export const badgeText = (n: number) => (n > 99 ? '99+' : String(n))

export const pingTitle = (base: string, n: number) => (n > 0 ? `(${badgeText(n)}) ${base}` : base)

export interface Watching {
  view: string | null
  thread: number | null
  following: (key: string) => boolean
  visible: boolean
}

export interface PingAlert {
  toast: boolean
  badge: boolean
}

// What an incoming ping does. Seen in place (its message is on screen and the view follows the
// bottom) means no toast and no badge: the scope is marked seen instead. Otherwise it is counted
// (badges hide it under "Nothing", see `pingShown`) and toasts unless the scope is muted or set
// to "Nothing".
export const pingAlert = (
  ping: Pick<Ping, 'scope' | 'thread_root_id'>,
  w: Watching,
  rule?: Resolved
): PingAlert => {
  const seen =
    w.visible &&
    (ping.thread_root_id !== null
      ? w.thread === ping.thread_root_id && w.following(`t${ping.thread_root_id}`)
      : w.view === ping.scope && w.following(ping.scope))
  return { toast: !seen && (rule === undefined || pingToast(rule)), badge: !seen }
}

const ACTION: Record<Ping['kind'], string> = {
  mention: 'mentioned you',
  reply: 'replied to you',
  reaction: 'reacted to your message',
  friend_request: 'sent you a friend request',
  friend_accept: 'accepted your friend request',
}

export const pingAction = (ping: Ping, channel: string | null) => {
  const what =
    ping.kind === 'reaction' && ping.emoji
      ? `reacted ${ping.emoji} to your message`
      : ACTION[ping.kind]
  return channel ? `${what} in #${channel}` : what
}
