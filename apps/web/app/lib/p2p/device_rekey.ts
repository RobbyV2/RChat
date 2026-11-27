import type { EventRecord, P2pStore, PartRecord } from './db'
import { PING_LOG, isSealedPing, logValue, parseLog } from './inbox'
import type { Local } from './limits'
import { PING_STORE } from './ping_log'
import { isSealed, searchForm, storedSealed } from './sealed_db'
import { PART_STORE } from './sealed_files'
import { accountRows, indexEvent, unindex } from './search'

// Replacing this device's key: a new key seals from now on, and what the old one sealed is
// sealed again a step at a time: the events, the search rows (made again under the new key's
// search key), the file blocks and the inbox rows. Then the old key is dropped. The marker in
// `meta` lets it go on after a restart.
export const REKEY_META = 'device_rekey'

// Rows read in one step.
const STEP = 200

type Phase = 'renew' | 'events' | 'search' | 'parts' | 'inbox' | 'done'

const PHASES: readonly Phase[] = ['renew', 'events', 'search', 'parts', 'inbox', 'done']

interface Marker {
  // The key being replaced.
  from: number
  phase: Phase
  // The key of the last row the phase finished.
  at: IDBValidKey | null
}

const markerOf = (v: unknown): Marker | null => {
  if (typeof v !== 'object' || v === null) return null
  const o = v as Record<string, unknown>
  if (!Number.isSafeInteger(o.from) || !PHASES.includes(o.phase as Phase)) return null
  return { from: o.from as number, phase: o.phase as Phase, at: (o.at as IDBValidKey) ?? null }
}

// Whether a replacement runs on this device.
export const replacing = async (store: P2pStore) => markerOf(await store.meta(REKEY_META)) !== null

// Makes a new device key and seals what the old one sealed again. False when this device sealed
// nothing, or a replacement already runs.
export async function replaceDeviceKey(store: P2pStore, lim: Local['search']) {
  if (await replacing(store)) return false
  const from = await store.sealing.inUse()
  if (from === null) return false
  // The marker comes first: a stop before the new key is made makes it on the next start.
  const marker: Marker = { from, phase: 'renew', at: null }
  await store.db.put('meta', marker, REKEY_META)
  void resumeRekey(store, lim).catch(() => {})
  return true
}

const running = new WeakSet<P2pStore>()

// Goes on with a replacement a restart stopped, to its end; a step that fails is tried again at
// the next start.
export async function resumeRekey(store: P2pStore, lim: Local['search']) {
  if (running.has(store)) return
  running.add(store)
  try {
    for (;;) {
      if (store.closed) return
      const m = markerOf(await store.meta(REKEY_META))
      if (!m) return
      if (m.phase === 'done') {
        await store.sealing.forget(m.from)
        await store.db.delete('meta', REKEY_META)
        return
      }
      const next = await rekeyStep(store, m, lim)
      if (store.closed) return
      await store.db.put('meta', next, REKEY_META)
    }
  } finally {
    running.delete(store)
  }
}

const after = (at: IDBValidKey | null) =>
  at === null ? undefined : IDBKeyRange.lowerBound(at, true)

const nextPhase = (m: Marker): Marker => ({
  from: m.from,
  phase: PHASES[PHASES.indexOf(m.phase) + 1] ?? 'done',
  at: null,
})

// One step of a replacement from marker `m`; answers the next marker.
export async function rekeyStep(store: P2pStore, m: Marker, lim: Local['search']): Promise<Marker> {
  const db = store.db
  const sealing = store.sealing
  const raw = sealing.stored
  if (m.phase === 'renew') {
    if ((await sealing.inUse()) === m.from) await sealing.renew()
    return nextPhase(m)
  }
  if (m.phase === 'events') {
    const rows = (await raw.getAll('events', after(m.at), STEP)) as EventRecord[]
    const old = rows
      .filter(r => isSealed(r) && sealing.keyOf(r.wire as unknown as Uint8Array) === m.from)
      .map(r => r.id)
    if (old.length > 0) {
      // Read again and written in one transaction: the handle seals what it writes again.
      const tx = db.transaction('events', 'readwrite')
      for (const id of old) {
        const rec = await tx.store.get(id)
        if (rec && storedSealed(rec)) await tx.store.put(rec)
      }
      await tx.done
    }
    const last = rows.at(-1)
    return last && rows.length === STEP ? { ...m, at: last.id } : nextPhase(m)
  }
  if (m.phase === 'search') {
    const tx = db.transaction(['events', 'search', 'rooms', 'meta'], 'readwrite')
    const st = tx.objectStore('search')
    const events = tx.objectStore('events')
    const form = searchForm(db, lim.exact)
    const delta = new Map<string, number>()
    let c = await events.openCursor(after(m.at))
    let n = 0
    let at = m.at
    while (c && n < STEP) {
      const rec = c.value
      let bytes = 0
      if (rec.type === 'msg') bytes -= await unindex(st, events, rec, lim, form)
      bytes += await indexEvent(st, events, rec, lim, form)
      if (bytes) delta.set(rec.room, (delta.get(rec.room) ?? 0) + bytes)
      at = rec.id
      n += 1
      c = await c.continue()
    }
    await accountRows(tx.objectStore('rooms'), tx.objectStore('meta'), delta)
    await tx.done
    return c ? { ...m, at } : nextPhase(m)
  }
  if (m.phase === 'parts') {
    const rows = (await raw.getAll(PART_STORE, after(m.at), STEP)) as PartRecord[]
    for (const p of rows) {
      if (p.sealed !== true) continue
      const bytes = new Uint8Array(await p.data.arrayBuffer())
      if (sealing.keyOf(bytes) !== m.from) continue
      const record = await sealing.rebox(PART_STORE, `${p.h}/${p.block}`, '', bytes)
      if (!record) continue
      const tx = raw.transaction(PART_STORE, 'readwrite')
      const now = (await tx.store.get([p.h, p.block])) as PartRecord | undefined
      if (now?.sealed === true) await tx.store.put({ ...now, data: new Blob([record as BlobPart]) })
      await tx.done
    }
    const last = rows.at(-1)
    return last && rows.length === STEP ? { ...m, at: [last.h, last.block] } : nextPhase(m)
  }
  if (m.phase === 'inbox') {
    for (let tries = 0; tries < 10; tries += 1) {
      const was = await raw.get('meta', PING_LOG)
      const list = parseLog(was)
      const next = []
      for (const p of list) {
        if (!isSealedPing(p) || sealing.keyOf(p.box) !== m.from) {
          next.push(p)
          continue
        }
        const box = await sealing.rebox(PING_STORE, p.id, p.room, p.box)
        next.push(box ? { ...p, box } : p)
      }
      const tx = raw.transaction('meta', 'readwrite')
      const now = await tx.store.get(PING_LOG)
      const same = JSON.stringify(logValue(parseLog(now))) === JSON.stringify(logValue(list))
      if (same) await tx.store.put(logValue(next), PING_LOG)
      await tx.done
      if (same) return nextPhase(m)
    }
    // The log kept changing: the phase runs again.
    return m
  }
  return m
}
