import type { EventRecord, P2pStore } from './db'
import { editOf } from './dm'
import type { EditContent, MsgContent } from './content'
import {
  addPings,
  byThreadCounter,
  isSealedPing,
  logValue,
  markSeen,
  parseLog,
  pingUnread,
  PING_LOG,
  readSeqs,
  whatOf,
  type P2pPingKind,
  type PingRec,
  type PingRow,
  type InboxLimits,
  type PingText,
} from './inbox'
import { LOCAL } from './limits'
import { time } from '../platform/time'
import type { Cancel } from '../clock'
import type { Sealing } from './sealed_db'

// The ping a counted arrival leaves in the log.
export const pingOf = (
  room: string,
  ch: string | null,
  kind: P2pPingKind,
  rec: EventRecord,
  thread: string | null = null
): PingRec => {
  const c = rec.wire.c as { key?: unknown } | null
  return {
    id: rec.id,
    room,
    ch,
    kind,
    actor: rec.sender,
    at: rec.receivedAt,
    seq: rec.seq,
    emoji: kind === 'reaction' && typeof c?.key === 'string' ? c.key : null,
    target: kind === 'reaction' ? (rec.target ?? null) : null,
    seen: false,
    thread,
  }
}

// The store of the device records of ping rows (sealed_db.ts).
export const PING_STORE = 'inbox'

// The rows of `add` as they are stored: a ping of a room or DM that stores its events sealed
// keeps its kind and emoji in a box.
export const sealPings = async (
  sealing: Sealing | undefined,
  add: PingRec[]
): Promise<PingRow[]> => {
  if (!sealing) return add
  const out: PingRow[] = []
  for (const p of add) {
    const { kind, emoji, ...base } = p
    const box = await sealing.box(PING_STORE, p.id, p.room, { kind, emoji })
    out.push(box ? { ...base, box } : p)
  }
  return out
}

// The stored rows as the inbox reads them; a sealed row that doesn't open is left out.
export const openPings = async (sealing: Sealing | undefined, rows: PingRow[]) => {
  const out: PingRec[] = []
  for (const p of rows) {
    if (!isSealedPing(p)) {
      out.push(p)
      continue
    }
    const { box, ...base } = p
    const what = sealing ? whatOf(await sealing.unbox(PING_STORE, p.id, p.room, box)) : null
    if (what) out.push({ ...base, ...what })
  }
  return out
}

// The stored ping rows and the read positions, as stored; sealed rows stay boxed.
const storedPings = async (s: P2pStore) => {
  const [raw, rooms] = await Promise.all([s.meta<unknown>(PING_LOG), s.rooms()])
  return { list: parseLog(raw), readSeq: readSeqs(rooms) }
}

// The noted pings and the read positions, as stored.
export const readPings = async (s: P2pStore) => {
  const { list, readSeq } = await storedPings(s)
  return { list: await openPings(s.sealing, list), readSeq }
}

// The message a ping shows (for a reaction, the message reacted to), while it is there.
const shownMessage = async (s: P2pStore, p: PingRec) => {
  const id = p.kind === 'reaction' ? p.target : p.id
  const rec = id ? await s.event(id) : undefined
  if (!rec || rec.room !== p.room || rec.type !== 'msg' || rec.redacted) return null
  const c = rec.wire.c as MsgContent | null
  return c && !rec.purged ? { rec, c } : null
}

export const pingAlive = async (s: P2pStore, p: PingRec) => {
  try {
    return (await shownMessage(s, p)) !== null
  } catch {
    return false
  }
}

// What a ping shows: its message as last edited; null once that message is gone or hidden.
export const pingText = async (s: P2pStore, p: PingRec): Promise<PingText | null> => {
  try {
    const shown = await shownMessage(s, p)
    if (!shown) return null
    const { rec, c } = shown
    const id = rec.id
    const rel = c.fwd ? [] : await s.db.getAllFromIndex('events', 'room_target', [p.room, id])
    const edit = c.fwd ? null : editOf(rec, rel)
    const att = c.fwd?.att ?? c.att ?? []
    return {
      content: edit ? (edit.wire.c as EditContent).body : (c.fwd?.body ?? c.body),
      media: att[0]?.name ?? null,
      mediaSpoiler: att[0]?.spoiler === true,
    }
  } catch {
    return null
  }
}

export interface PingLogDeps {
  store: P2pStore
  dms: { unping: (room: string, n: number, thread?: string | null) => Promise<void> }
  servers: {
    unping: (room: string, ch: string, n: number, thread?: string | null) => Promise<void>
  }
  now?: () => number
  // The stored list changed.
  onWrite?: () => void
  limits?: Partial<InboxLimits>
}

// The pings of the tab that runs P2P: arrivals are written in batches, and every write is a
// read-modify-write of the list in one transaction, one after the other.
export class PingLog {
  private batch: PingRec[] = []
  private timer: Cancel | null = null
  private writes: Promise<unknown> = Promise.resolve()

  readonly limits: InboxLimits

  constructor(private deps: PingLogDeps) {
    this.limits = { ...LOCAL.inbox, ...deps.limits }
  }

  note(
    room: string,
    ch: string | null,
    kind: P2pPingKind,
    rec: EventRecord,
    thread: string | null = null
  ) {
    this.batch.push(pingOf(room, ch, kind, rec, thread))
    if (!this.timer) this.timer = time().after(this.limits.pingBatchMs, () => void this.flush())
  }

  // Writes the pings noted so far; `true` once they are stored.
  flush(): Promise<boolean> {
    this.timer?.()
    this.timer = null
    const add = this.batch
    this.batch = []
    const now = this.deps.now ?? (() => time().now())
    let rows: PingRow[] = []
    const seal = async () => {
      rows = await sealPings(this.deps.store.sealing, add)
    }
    return add.length
      ? this.write(list => addPings(list, rows, now(), this.limits), false, seal)
      : Promise.resolve(true)
  }

  stop() {
    this.timer?.()
    this.timer = null
    this.batch = []
  }

  // `true` once written (or nothing to write), `false` when the database refused. `before` runs
  // first, outside the write's transaction.
  private write(
    fn: (list: PingRow[], readSeq: Map<string, number>) => PingRow[],
    rooms = false,
    before: () => Promise<void> = async () => {}
  ) {
    const s = this.deps.store
    const done = this.writes.then(async () => {
      try {
        if (s.closed) return false
        await before()
        const readSeq = rooms ? readSeqs(await s.rooms()) : new Map<string, number>()
        const tx = s.db.transaction('meta', 'readwrite')
        const list = parseLog(await tx.store.get(PING_LOG))
        const next = fn(list, readSeq)
        if (next !== list) await tx.store.put(logValue(next), PING_LOG)
        await tx.done
        if (next !== list) this.deps.onWrite?.()
        return true
      } catch {
        return false
      }
    })
    this.writes = done
    return done
  }

  async read() {
    void this.flush()
    await this.writes
    return readPings(this.deps.store)
  }

  // The rows as stored, for what needs only their plain fields.
  private async rows() {
    void this.flush()
    await this.writes
    return storedPings(this.deps.store)
  }

  // Notes pings as seen without touching the counters (they were taken off already).
  async seen(ids: readonly string[]) {
    if (!ids.length) return
    void this.flush()
    const want = new Set(ids)
    await this.write(list => markSeen(list, want), true)
  }

  // The unread thread pings of a channel or conversation (`ch` null), with their roots.
  async threadPings(room: string, ch: string | null) {
    const { list, readSeq } = await this.rows()
    return list.flatMap(p =>
      p.room === room && p.ch === ch && p.thread && pingUnread(p, readSeq)
        ? [{ id: p.id, thread: p.thread }]
        : []
    )
  }

  // The unread pings of a thread, to mark when it is read.
  async ofThread(room: string, ch: string | null, root: string) {
    const { list, readSeq } = await this.rows()
    return list
      .filter(p => p.room === room && p.ch === ch && p.thread === root && pingUnread(p, readSeq))
      .map(p => p.id)
  }

  // Marks pings read: each unread one is noted as seen, and once that is stored, taken off its
  // counter. Returns how many were marked.
  async mark(ids: readonly string[]) {
    if (!ids.length) return 0
    void this.flush()
    const want = new Set(ids)
    let cut: PingRow[] = []
    const ok = await this.write((list, readSeq) => {
      cut = list.filter(p => want.has(p.id) && pingUnread(p, readSeq))
      return cut.length ? markSeen(list, new Set(cut.map(p => p.id))) : list
    }, true)
    if (!ok) return 0
    for (const [key, n] of byThreadCounter(cut)) {
      const [place, thread] = key.split('#')
      const i = place.indexOf('/')
      await (
        i < 0
          ? this.deps.dms.unping(place, n, thread ?? null)
          : this.deps.servers.unping(place.slice(0, i), place.slice(i + 1), n, thread ?? null)
      ).catch(() => {})
    }
    return cut.length
  }
}
