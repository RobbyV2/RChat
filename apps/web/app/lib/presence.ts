export type PresenceNote = { online: boolean; seq: number }
export type PresenceLog = Map<string, PresenceNote>

type Row = { username: string; online: boolean }

export const PRESENCE_LOG_MAX = 2000

export const notePresence = (log: PresenceLog, username: string, online: boolean, seq: number) => {
  log.delete(username)
  log.set(username, { online, seq })
  if (log.size > PRESENCE_LOG_MAX) {
    const oldest = log.keys().next().value
    if (oldest !== undefined) log.delete(oldest)
  }
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
