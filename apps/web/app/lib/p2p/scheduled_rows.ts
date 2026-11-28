// The `scheduled` store as the schedule reads and writes it. A row of a room or DM that stores
// its events sealed keeps its body, reply and files in a device record (`box`); the rest of the row
// stays plain so the due index works. Rows are parsed here once, on their way out of the store.

import type { P2pDatabase, ScheduledRecord, SealedScheduled, StoredScheduled } from './db'
import { parseDraftKey, readScheduled } from './scheduled'
import { sealingOf } from './sealed_db'

// The store name bound into the device records of scheduled rows.
export const SCHEDULED_STORE = 'scheduled'

const isBoxed = (x: unknown): x is SealedScheduled =>
  typeof x === 'object' && x !== null && ArrayBuffer.isView((x as SealedScheduled).box)

const roomOf = (key: string) => parseDraftKey(key)?.room ?? null

export class ScheduledRows {
  constructor(private readonly db: P2pDatabase) {}

  private get sealing() {
    return sealingOf(this.db)
  }

  // A stored row as the schedule uses it; null for one that can't be trusted or opened, which
  // is never sent.
  private async opened(x: unknown): Promise<ScheduledRecord | null> {
    if (!isBoxed(x)) return readScheduled(x)
    const { box, ...rest } = x
    const room = typeof rest.key === 'string' ? roomOf(rest.key) : null
    if (room === null || typeof rest.id !== 'string') return null
    const inner = await this.sealing?.unbox(SCHEDULED_STORE, rest.id, room, box)
    if (typeof inner !== 'object' || inner === null) return null
    const { body, reply, att } = inner as { body?: unknown; reply?: unknown; att?: unknown }
    return readScheduled({
      ...rest,
      body,
      ...(reply !== undefined ? { reply } : {}),
      ...(att !== undefined ? { att } : {}),
    })
  }

  // The row as it is stored now: boxed while its room stores its events sealed.
  private async stored(r: ScheduledRecord): Promise<StoredScheduled> {
    const room = roomOf(r.key)
    const { body, reply, att, ...rest } = r
    const box =
      room === null
        ? null
        : await this.sealing?.box(SCHEDULED_STORE, r.id, room, {
            body,
            ...(reply !== undefined ? { reply } : {}),
            ...(att !== undefined ? { att } : {}),
          })
    return box ? { ...rest, box } : r
  }

  private async openAll(rows: unknown[]) {
    const out: ScheduledRecord[] = []
    for (const raw of rows) {
      const r = await this.opened(raw)
      if (r) out.push(r)
    }
    return out
  }

  async all() {
    return this.openAll(await this.db.getAll('scheduled'))
  }

  // The rows whose next try is at or before `now`.
  async due(now: number) {
    return this.openAll(
      await this.db.getAllFromIndex('scheduled', 'next', IDBKeyRange.upperBound(now))
    )
  }

  async get(id: string) {
    return this.opened(await this.db.get('scheduled', id))
  }

  async put(r: ScheduledRecord) {
    await this.db.put('scheduled', await this.stored(r))
  }

  delete(id: string) {
    return this.db.delete('scheduled', id)
  }

  // Writes again the rows stored plain in a room or DM that stores its events sealed now: ones
  // scheduled before its switch.
  async reseal() {
    const sealing = this.sealing
    if (!sealing) return
    for (const raw of await this.db.getAll('scheduled')) {
      if (isBoxed(raw)) continue
      const r = readScheduled(raw)
      const room = r ? roomOf(r.key) : null
      if (!r || room === null || !sealing.on(room)) continue
      const next = await this.stored(r)
      const tx = this.db.transaction('scheduled', 'readwrite')
      const now = await tx.store.get(r.id)
      if (now && !isBoxed(now) && same(readScheduled(now), r)) await tx.store.put(next)
      await tx.done
    }
  }
}

const same = (a: ScheduledRecord | null, b: ScheduledRecord) =>
  a !== null && JSON.stringify(a) === JSON.stringify(b)

// Whether a stored row keeps its text in a device record.
export const isSealedScheduled = isBoxed
