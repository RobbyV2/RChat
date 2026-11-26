// What the new messages banner says: how many arrived since the first unread one, and when.
// Pure.

export interface UnreadSummary {
  // How many from others since the first unread message; null while unknown.
  count: number | null
  // More than `count` (the count stopped at a cap).
  more: boolean
  // When the first unread message was sent, in ms; null while unknown.
  since: number | null
}

// Counts above this show as "99+".
export const UNREAD_SHOWN_MAX = 99

// "11/25/26, 2:39 PM".
export const formatSince = (ms: number, locale?: string) =>
  new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'short' }).format(ms)

// "15 new messages since 11/25/26, 2:39 PM", "1 new message since …", "99+ new messages …",
// or "New messages" while the count is unknown.
export const unreadBannerText = (u: UnreadSummary, locale?: string) => {
  const count =
    u.count === null
      ? 'New messages'
      : u.more || u.count > UNREAD_SHOWN_MAX
        ? `${UNREAD_SHOWN_MAX}+ new messages`
        : `${u.count} new ${u.count === 1 ? 'message' : 'messages'}`
  return u.since === null ? count : `${count} since ${formatSince(u.since, locale)}`
}

export interface UnreadRow {
  id: number
  author: string
  created_at: number
}

// The server's count of a hosted scope (`GET /api/v1/unreads/{scope}`).
export interface UnreadCount {
  count: number
  more: boolean
  since: number | null
  latest: number | null
}

// A hosted list's banner: from the loaded rows when they run from the first unread one
// (`first`) to the newest message (`tail`), else from the server's count of what follows `after`
// plus the rows from others that came after the last one it counted.
export const hostedUnread = (
  rows: readonly UnreadRow[],
  first: number,
  tail: boolean,
  me: string | undefined,
  after: number,
  counted: UnreadCount | null
): UnreadSummary => {
  const others = (r: UnreadRow) => r.author !== me
  if (first >= 0 && tail) {
    const unread = rows.slice(first).filter(others)
    return { count: unread.length, more: false, since: rows[first].created_at * 1000 }
  }
  if (!counted) return { count: null, more: false, since: null }
  const edge = counted.latest ?? after
  const later = rows.filter(r => r.id > edge && others(r)).length
  return {
    count: counted.count + later,
    more: counted.more,
    since: counted.since === null ? null : counted.since * 1000,
  }
}

export interface P2pUnreadRow {
  sender: string
  seq: number
  ts: number
  system?: unknown
  call?: unknown
}

// Only messages count, as the stored counter does.
const counts = (r: P2pUnreadRow, me: string | null) => r.sender !== me && !r.system && !r.call

// A P2P list's banner. From the loaded rows when they run from the first unread one (`first`) to
// the newest (`tail`); else from the count when it opened (`atOpen`, with the arrival number it
// had then) plus what arrived since, and the first unread message (loaded, or `found` in storage,
// `ts` in ms).
export const p2pUnread = (
  rows: readonly P2pUnreadRow[],
  first: number,
  tail: boolean,
  me: string | null,
  atOpen: { count: number; seq: number },
  found: { ts: number } | null
): UnreadSummary => {
  if (first >= 0 && tail)
    return {
      count: rows.slice(first).filter(r => counts(r, me)).length,
      more: false,
      since: rows[first].ts,
    }
  const later = rows.filter(r => r.seq > atOpen.seq && counts(r, me)).length
  return {
    count: atOpen.count + later,
    more: false,
    since: first >= 0 ? rows[first].ts : (found?.ts ?? null),
  }
}

// Where a P2P list's unread part starts: after the read marker and after your own last message
// (as on hosted lists). `ambiguous` when the first loaded row is unread while older rows are not
// loaded: the first unread one may be older.
export const p2pUnreadStart = (
  rows: readonly Pick<P2pUnreadRow, 'sender' | 'seq'>[],
  readSeq: number,
  me: string | null,
  more: boolean
): { first: number; ambiguous: boolean; sent: boolean } => {
  if (!readSeq) return { first: -1, ambiguous: false, sent: false }
  let own = 0
  for (const r of rows) if (r.sender === me && r.seq > own) own = r.seq
  const at = Math.max(readSeq, own)
  const first = rows.findIndex(r => r.sender !== me && r.seq > at)
  return { first, ambiguous: first === 0 && more && own <= readSeq, sent: own > readSeq }
}
