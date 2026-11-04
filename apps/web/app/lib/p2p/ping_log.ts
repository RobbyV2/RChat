import type { EventRecord, P2pStore } from './db'
import { editOf } from './dm'
import type { EditContent, MsgContent } from './content'
import {
  addPings,
  byThreadCounter,
  logValue,
  markSeen,
  parseLog,
  pingUnread,
  PING_LOG,
  readSeqs,
  type P2pPingKind,
  type PingRec,
  type PingText,
} from './inbox'
import { LOCAL } from './limits'

export const PING_BATCH_MS = LOCAL.inbox.pingBatchMs

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

// The noted pings and the read positions, as stored.
export const readPings = async (s: P2pStore) => {
  const [raw, rooms] = await Promise.all([s.meta<unknown>(PING_LOG), s.rooms()])
  return { list: parseLog(raw), readSeq: readSeqs(rooms) }
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
  dms: { unping: (room: string, n: number) => Promise<void> }
  servers: {
    unping: (room: string, ch: string, n: number, thread?: string | null) => Promise<void>
  }
  now?: () => number
  // The stored list changed.
  onWrite?: () => void
}

// The pings of the tab that runs P2P: arrivals are written in batches, and every write is a
// read-modify-write of the list in one transaction, one after the other.
export class PingLog {
  private batch: PingRec[] = []
  private timer: ReturnType<typeof setTimeout> | null = null
  private writes: Promise<unknown> = Promise.resolve()

  constructor(private deps: PingLogDeps) {}

  note(
    room: string,
    ch: string | null,
    kind: P2pPingKind,
    rec: EventRecord,
    thread: string | null = null
  ) {
    this.batch.push(pingOf(room, ch, kind, rec, thread))
    if (!this.timer) this.timer = setTimeout(() => void this.flush(), PING_BATCH_MS)
  }

  // Writes the pings noted so far; `true` once they are stored.
  flush(): Promise<boolean> {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    const add = this.batch
    this.batch = []
    const now = this.deps.now ?? Date.now
    return add.length ? this.write(list => addPings(list, add, now())) : Promise.resolve(true)
  }

  stop() {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.batch = []
  }

  // `true` once written (or nothing to write), `false` when the database refused.
  private write(fn: (list: PingRec[], readSeq: Map<string, number>) => PingRec[], rooms = false) {
    const s = this.deps.store
    const done = this.writes.then(async () => {
      try {
        if (s.closed) return false
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

  // Notes pings as seen without touching the counters (they were taken off already).
  async seen(ids: readonly string[]) {
    if (!ids.length) return
    void this.flush()
    const want = new Set(ids)
    await this.write(list => markSeen(list, want), true)
  }

  // The unread thread pings of a channel, with their roots.
  async threadPings(room: string, ch: string) {
    const { list, readSeq } = await this.read()
    return list.flatMap(p =>
      p.room === room && p.ch === ch && p.thread && pingUnread(p, readSeq)
        ? [{ id: p.id, thread: p.thread }]
        : []
    )
  }

  // The unread pings of a thread, to mark when it is read.
  async ofThread(room: string, ch: string, root: string) {
    const { list, readSeq } = await this.read()
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
    let cut: PingRec[] = []
    const ok = await this.write((list, readSeq) => {
      cut = list.filter(p => want.has(p.id) && pingUnread(p, readSeq))
      return cut.length ? markSeen(list, new Set(cut.map(p => p.id))) : list
    }, true)
    if (!ok) return 0
    for (const [key, n] of byThreadCounter(cut)) {
      const i = key.indexOf('/')
      const [ch, thread] = key.slice(i + 1).split('#')
      await (
        i < 0
          ? this.deps.dms.unping(key, n)
          : this.deps.servers.unping(key.slice(0, i), ch, n, thread ?? null)
      ).catch(() => {})
    }
    return cut.length
  }
}
