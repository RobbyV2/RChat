import { time } from '../platform/time'
import { partRange } from './blobs'
import { blankRoom, cacheKey, countOf, moveCounts, TOTAL, TOTAL_BYTES } from './dag'
import type { P2pDatabase, RoomRecord, ServerCache } from './db'
import { isSealedPing, logValue, parseLog, PING_LOG } from './inbox'
import { isSealed, sealingOf } from './sealed_db'

// How many of the members it knew a server is asked of again.
const ASK = 32

// A device that lost its device key can't open what it sealed. The rooms and DMs that hold sealed
// events are emptied here (events, their links, outbox and index rows, counters), and their
// records start over, so the device takes them from its peers again. The device's own chains in
// servers stay, so what it signs later goes on from them. A server is asked of the members the
// device last knew. The inbox keeps no row it sealed, and files stored sealed go. Returns the
// rooms it emptied.
export async function dropSealed(db: P2pDatabase, now = time().now()): Promise<string[]> {
  const sealing = sealingOf(db)
  if (!sealing) return []
  const raw = sealing.stored as unknown as P2pDatabase
  const tx = raw.transaction(
    ['rooms', 'events', 'children', 'outbox', 'meta', 'search', 'dropped'],
    'readwrite'
  )
  const events = tx.objectStore('events')
  const meta = tx.objectStore('meta')
  const rooms = new Set<string>()
  for (let c = await events.openCursor(); c; c = await c.continue())
    if (isSealed(c.value)) rooms.add(c.value.room)
  const gone = new Set<string>()
  for (const room of rooms) {
    let n = 0
    let acl = 0
    let c = await events
      .index('room_seq')
      .openCursor(IDBKeyRange.bound([room, -Infinity], [room, Infinity]))
    while (c) {
      const k = countOf(c.value)
      n += k.n
      acl += k.acl
      gone.add(c.value.id)
      await c.delete()
      c = await c.continue()
    }
    for (const key of await tx.objectStore('outbox').index('room').getAllKeys(room))
      await tx.objectStore('outbox').delete(key)
    for (const key of await tx.objectStore('dropped').index('room').getAllKeys(room))
      await tx.objectStore('dropped').delete(key)
    await tx.objectStore('search').delete(IDBKeyRange.bound([room, '', ''], [room, '￿', '￿']))
    const cache = (await meta.get(cacheKey(room))) as ServerCache | undefined
    for (const lo of [`held\n${room}\n`, `share\n${room}\n`])
      await meta.delete(IDBKeyRange.bound(lo, `${lo}\uffff`))
    await meta.delete(cacheKey(room))
    const rec = await tx.objectStore('rooms').get(room)
    if (!rec) continue
    const fresh = blankRoom(rec.id, rec.peer, rec.created)
    if (rec.kind === 'dm') {
      const num = async (k: string) => ((await meta.get(k)) as number | undefined) ?? 0
      await meta.put(Math.max(0, (await num(TOTAL)) - rec.count), TOTAL)
      await meta.put(Math.max(0, (await num(TOTAL_BYTES)) - (rec.bytes ?? 0)), TOTAL_BYTES)
      await tx.objectStore('rooms').put(fresh)
      continue
    }
    await moveCounts(meta, rec, { n: -n, acl: -acl, bytes: -(rec.bytes ?? 0) })
    const from = Object.entries(cache?.sum?.members ?? {})
      .filter(([, m]) => m.m === 'join')
      .map(([ik]) => ik)
      .slice(0, ASK)
    const kept: RoomRecord = {
      ...fresh,
      kind: 'server',
      joining: { at: now, via: 'resync', from },
      ...(rec.name !== undefined ? { name: rec.name } : {}),
      ...(rec.since !== undefined ? { since: rec.since } : {}),
      ...(rec.prev !== undefined ? { prev: rec.prev } : {}),
      ...(rec.next !== undefined ? { next: rec.next } : {}),
    }
    await tx.objectStore('rooms').put(kept)
  }
  const children = tx.objectStore('children')
  for (let c = await children.openCursor(); c; c = await c.continue())
    if (gone.has(c.value.parent) || gone.has(c.value.child)) await c.delete()
  const pings = parseLog(await meta.get(PING_LOG))
  const plain = pings.filter(p => !isSealedPing(p))
  if (plain.length < pings.length) await meta.put(logValue(plain), PING_LOG)
  await tx.done
  await dropSealedFiles(raw)
  await sealing.reset()
  return [...rooms]
}

// The files whose blocks were stored sealed go whole (record, blocks and hashes); a file is
// downloaded again when it is opened.
async function dropSealedFiles(raw: P2pDatabase) {
  const tx = raw.transaction(['blobs', 'blob_parts', 'blob_hashes'], 'readwrite')
  const parts = tx.objectStore('blob_parts')
  const files = new Set<string>()
  for (let c = await parts.openCursor(); c; c = await c.continue())
    if (c.value.sealed === true) files.add(c.value.h)
  for (const h of files) {
    await parts.delete(partRange(h))
    await tx.objectStore('blob_hashes').delete(partRange(h))
    await tx.objectStore('blobs').delete(h)
  }
  await tx.done
}
