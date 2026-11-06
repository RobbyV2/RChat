export type PresenceNote = { online: boolean; seq: number }
export type PresenceLog = Map<string, PresenceNote>

type Row = { username: string; online: boolean }

export const PRESENCE_LOG_MAX = 2000

export const notePresence = (
  log: PresenceLog,
  username: string,
  online: boolean,
  seq: number
): PresenceNote | undefined => {
  log.delete(username)
  log.set(username, { online, seq })
  if (log.size <= PRESENCE_LOG_MAX) return undefined
  const oldest = log.entries().next().value
  if (!oldest) return undefined
  log.delete(oldest[0])
  return oldest[1]
}

export const overlayPresence = <T extends Row>(
  rows: T[],
  log: PresenceLog | undefined,
  since: number
): T[] => {
  if (!log?.size) return rows
  let out: T[] | null = null
  rows.forEach((row, i) => {
    const note = log.get(row.username)
    if (!note || note.seq <= since || note.online === row.online) return
    out ??= [...rows]
    out[i] = { ...row, online: note.online }
  })
  return out ?? rows
}

export type PresenceSnap = {
  online: Set<string>
  last: string | null
  complete: boolean
  seq: number
}

export const presenceSnap = (online: string[], count: number, seq: number): PresenceSnap => ({
  online: new Set(online),
  last: online.at(-1) ?? null,
  complete: count <= online.length,
  seq,
})

export const byCodePoint = (a: string, b: string) => {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n;) {
    const x = a.codePointAt(i) ?? 0
    const y = b.codePointAt(i) ?? 0
    if (x !== y) return x < y ? -1 : 1
    i += x > 0xffff ? 2 : 1
  }
  return Math.sign(a.length - b.length)
}

export const snapOnline = (snap: PresenceSnap | undefined, username: string) => {
  if (!snap) return undefined
  if (snap.online.has(username)) return true
  if (snap.complete || (snap.last !== null && byCodePoint(username, snap.last) < 0)) return false
  return undefined
}

export const knownPresence = (
  log: PresenceLog | undefined,
  snap: PresenceSnap | undefined,
  username: string,
  since = 0
) => {
  const note = log?.get(username)
  const fresh = note && note.seq > since ? note : undefined
  if (fresh && (!snap || fresh.seq > snap.seq)) return fresh.online
  const snapped = snap && snap.seq > since ? snapOnline(snap, username) : undefined
  return snapped ?? fresh?.online
}

export const missingOnline = (
  loaded: Row[],
  info: Record<string, Row | null> | undefined,
  log: PresenceLog | undefined,
  snap: PresenceSnap | undefined,
  limit: number
): string[] => {
  const covered = new Set(loaded.map(r => r.username))
  const names = new Set([...(log?.keys() ?? []), ...(snap?.online ?? [])])
  return [...names]
    .filter(
      n =>
        !covered.has(n) && !(info && Object.hasOwn(info, n)) && knownPresence(log, snap, n) === true
    )
    .sort(byCodePoint)
    .slice(0, limit)
}

export const onlineRows = <T extends Row & { display_name: string }>(
  loaded: T[],
  info: Record<string, T | null> | undefined
): T[] => {
  const listed = new Set(loaded.map(r => r.username))
  const extra = Object.values(info ?? {}).filter(
    (m): m is T => m !== null && m.online && !listed.has(m.username)
  )
  return [...loaded.filter(m => m.online), ...extra].sort((a, b) =>
    a.display_name.localeCompare(b.display_name)
  )
}

export const onlineMore = (
  total: number,
  rows: number,
  cache: { loading: boolean } | undefined,
  info: Record<string, unknown> | undefined
): string | null =>
  cache && !cache.loading && total > rows ? `omore${rows}:${Object.keys(info ?? {}).length}` : null

export const listComplete = (
  cache: { hasMore: boolean; loading: boolean } | undefined,
  rows: number,
  members: number
) => !!cache && !cache.hasMore && !cache.loading && rows >= members

// The member list's online section: its rows, counts and the key of its "more" sentinel.
export const onlineSection = <T extends Row & { display_name: string }>(
  count: number,
  members: number,
  cache: { list: T[]; hasMore: boolean; loading: boolean } | undefined,
  info: Record<string, T | null> | undefined
) => {
  const loaded = cache?.list ?? []
  const online = onlineRows(loaded, info)
  const offline = loaded.filter(m => !m.online)
  const rows = [...online, ...offline]
  const totals = onlineTotals(count, members, rows, listComplete(cache, rows.length, members))
  return { online, offline, totals, more: onlineMore(totals.online, online.length, cache, info) }
}

export const freshPresence = <T extends Row>(
  rows: T[],
  log: PresenceLog | undefined,
  snap: PresenceSnap | undefined,
  since: number
): T[] => {
  if (!log?.size && !(snap && snap.seq > since)) return rows
  let out: T[] | null = null
  rows.forEach((row, i) => {
    const online = knownPresence(log, snap, row.username, since)
    if (online === undefined || online === row.online) return
    out ??= [...rows]
    out[i] = { ...row, online }
  })
  return out ?? rows
}

export const presenceDelta = (known: boolean | undefined, online: boolean) =>
  known === online ? 0 : online ? 1 : -1

export const onlineTotals = (
  count: number,
  members: number,
  rows: Row[] | undefined,
  complete: boolean
): { online: number; offline: number } => {
  const on = rows?.filter(r => r.online).length ?? 0
  const off = (rows?.length ?? 0) - on
  if (rows && complete) return { online: on, offline: off }
  const online = Math.min(Math.max(count, on), Math.max(on, members - off))
  return { online, offline: Math.max(off, members - online) }
}
