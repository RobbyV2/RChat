import type { P2pDatabase, PartRecord } from './db'
import { sealingOf } from './sealed_db'

// File blocks stored sealed. A file that a room or DM storing its events sealed refers to (any
// file while the site requires sealing everywhere) has each block stored as a device record, AAD
// `deviceAad('blob_parts', '<h>/<block>', '')`. A file is stored once whichever rooms refer to
// it, so one sealed room is enough. Blocks stored sealed stay sealed; opening such a file puts
// its plain bytes together in memory.
export const PART_STORE = 'blob_parts'

const partKey = (h: string, block: number) => `${h}/${block}`

// Whether file `h` is stored sealed on `db` now: some sealed room or DM refers to it, or
// `room`, the one it is stored for, is sealed.
export async function sealsFile(db: P2pDatabase, h: string, room?: string): Promise<boolean> {
  const sealing = sealingOf(db)
  if (!sealing) return false
  if (room !== undefined && sealing.on(room)) return true
  if (sealing.everything) return sealing.on(room ?? '')
  const rooms = sealing.sealedRooms().filter(r => sealing.on(r))
  const raw = sealing.stored as unknown as P2pDatabase
  for (const r of rooms) {
    const index = raw.transaction('events').store.index('file')
    const range = IDBKeyRange.bound(`${r}\n`, `${r}\n\uffff`)
    for (let c = await index.openKeyCursor(range); c; c = await c.continue())
      if ((c.key as string).endsWith(`\n${h}`)) return true
  }
  return false
}

// The record block `block` of file `h` is stored as: sealed when `sealed`.
export async function storedPart(
  db: object,
  h: string,
  block: number,
  bytes: Uint8Array,
  sealed: boolean
): Promise<PartRecord> {
  const record = sealed
    ? await sealingOf(db)?.sealBytes(PART_STORE, partKey(h, block), '', bytes)
    : null
  return record
    ? { h, block, data: new Blob([record as BlobPart]), sealed: true }
    : { h, block, data: new Blob([bytes as BlobPart]) }
}

// The bytes a stored part holds; null for a sealed one that doesn't open.
export async function partBytes(db: object, p: PartRecord): Promise<Uint8Array | null> {
  const bytes = new Uint8Array(await p.data.arrayBuffer())
  if (p.sealed !== true) return bytes
  const sealing = sealingOf(db)
  return sealing ? sealing.openBytes(PART_STORE, partKey(p.h, p.block), '', bytes) : null
}

// A stored part's data as the app reads it: the stored Blob, or the opened bytes of a sealed one.
export async function partData(db: object, p: PartRecord): Promise<Blob | null> {
  if (p.sealed !== true) return p.data
  const bytes = await partBytes(db, p)
  return bytes && new Blob([bytes as BlobPart])
}
