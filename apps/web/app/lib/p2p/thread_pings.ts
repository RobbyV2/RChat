import type { EventRecord } from './db'

// Thread pings of P2P server channels and conversations: which still count when the place is
// read, and what comes off the thread counters.

export interface ThreadPing {
  id: string
  thread: string
}

export interface LiveCheck {
  // The events of the room among `ids`.
  events: (ids: string[]) => Promise<EventRecord[]>
  // The thread a message replies in, or null.
  rootOf: (m: EventRecord) => Promise<string | null>
  // Which of `ids` show (all of them where nothing is hidden).
  shows: (ids: string[]) => Promise<Set<string>>
}

// The pings that still count: each is about a message (a reaction's target) that is there, not
// deleted, still in the thread it pinged in, with that thread's root there; and all of them show.
export async function liveThreadPings(pings: readonly ThreadPing[], check: LiveCheck) {
  const recs = new Map<string, EventRecord>()
  for (const r of await check.events([...new Set(pings.flatMap(p => [p.id, p.thread]))]))
    recs.set(r.id, r)
  const targets = new Map<string, EventRecord>()
  for (const r of await check.events(
    [...recs.values()].flatMap(r => (r.type === 'react' && r.target ? [r.target] : []))
  ))
    targets.set(r.id, r)
  // The message each ping is about (a reaction's target), in the thread it pinged in.
  const about = new Map<string, EventRecord>()
  for (const p of pings) {
    const r = recs.get(p.id)
    const m = r?.type === 'react' && r.target ? targets.get(r.target) : r
    if (!r || !m || m.type !== 'msg' || r.purged || r.redacted || m.purged || m.redacted) continue
    if ((await check.rootOf(m)) === p.thread && recs.get(p.thread)) about.set(p.id, m)
  }
  const ids = [
    ...new Set([...about].flatMap(([id, m]) => [id, m.id, m.thread as string]).filter(x => x)),
  ]
  const ok = await check.shows(ids)
  return new Set(
    [...about]
      .filter(([id, m]) => ok.has(id) && ok.has(m.id) && ok.has(m.thread as string))
      .map(([id]) => id)
  )
}

// What a read takes off the thread counters (`counts`, per root): what `live` doesn't account
// for among `pings`, the unread thread pings of the place.
export const deadCounts = (
  counts: Readonly<Record<string, number>>,
  pings: readonly ThreadPing[],
  live: ReadonlySet<string>
) => {
  const drop: Record<string, number> = {}
  for (const [root, n] of Object.entries(counts)) {
    const alive = pings.filter(p => p.thread === root && live.has(p.id)).length
    if (n > alive) drop[root] = n - alive
  }
  return drop
}
