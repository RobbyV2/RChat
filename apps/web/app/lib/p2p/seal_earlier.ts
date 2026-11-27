import { sealStoredFile } from './blobs'
import type { EventRecord, P2pStore } from './db'
import type { Local } from './limits'
import { isSealed, searchForm, storedSealed } from './sealed_db'
import { accountRows, indexEvent, unindex } from './search'

// What a device does once the switch of a room or DM it stores is on with `earlier`: it seals
// what it stored of that room plain before, a step at a time: its events, then its search rows
// (each message's made again in the form it is stored in), then the blocks of the files its
// events carry. The marker in `meta` lets it go on after a restart; it stops while the switch is
// off, and what it sealed stays sealed.
export const EARLIER_META = 'seal_earlier\n'

// Events read in one step.
const STEP = 200

type Phase = 'events' | 'search' | 'files' | 'done'

interface Marker {
  phase: Phase
  // The `seq` of the last event the phase finished.
  at: number
}

const PHASES: readonly Phase[] = ['events', 'search', 'files', 'done']

export const markerOf = (v: unknown): Marker => {
  const o = (typeof v === 'object' && v !== null ? v : {}) as Record<string, unknown>
  return {
    phase: PHASES.includes(o.phase as Phase) ? (o.phase as Phase) : 'events',
    at: Number.isSafeInteger(o.at) ? (o.at as number) : -1,
  }
}

const running = new Set<string>()

// Runs the job of `room` to its end, or until its switch is off or the store closes.
export async function sealEarlier(store: P2pStore, room: string, lim: Local['search']) {
  const key = `${store.name}\n${room}`
  if (running.has(key)) return
  running.add(key)
  try {
    while (!store.closed && store.sealing.on(room)) {
      const m = markerOf(await store.meta(EARLIER_META + room))
      if (m.phase === 'done') return
      const next = await earlierStep(store, room, m, lim)
      if (store.closed || !store.sealing.on(room)) return
      await store.db.put('meta', next, EARLIER_META + room)
    }
  } finally {
    running.delete(key)
  }
}

// Forgets the job of `room` when its switch is off: a later one starts from the beginning.
export const forgetEarlier = (store: P2pStore, room: string) =>
  store.db.delete('meta', EARLIER_META + room).catch(() => {})

// Follows the switch of `room` as admitted here: starts or goes on with the job while it is on
// with `earlier`, forgets it while it is off.
export function followEarlier(
  store: P2pStore,
  room: string,
  { on, earlier }: { on: boolean; earlier: boolean },
  lim: Local['search']
) {
  if (!on) return void forgetEarlier(store, room)
  if (earlier) void sealEarlier(store, room, lim).catch(() => {})
}

const after = (room: string, at: number) =>
  IDBKeyRange.bound([room, at], [room, Number.MAX_SAFE_INTEGER], true, false)

// One step of the job of `room` from marker `m`; answers the next marker.
export async function earlierStep(
  store: P2pStore,
  room: string,
  m: Marker,
  lim: Local['search']
): Promise<Marker> {
  const db = store.db
  const raw = store.sealing.stored
  if (m.phase === 'events') {
    // Read as stored, so sealed ones are not opened; a plain one is written again through the
    // handle, which seals it.
    const rows = (await raw.getAllFromIndex(
      'events',
      'room_seq',
      after(room, m.at),
      STEP
    )) as EventRecord[]
    const plain = rows.filter(rec => !isSealed(rec)).map(rec => rec.id)
    if (plain.length > 0) {
      // Read again and written in one transaction, so a purge or a redaction in between stays.
      const tx = db.transaction('events', 'readwrite')
      for (const id of plain) {
        const rec = await tx.store.get(id)
        if (rec && !storedSealed(rec)) await tx.store.put(rec)
      }
      await tx.done
    }
    const last = rows.at(-1)
    return last && rows.length === STEP
      ? { phase: 'events', at: last.seq }
      : { phase: 'search', at: -1 }
  }
  if (m.phase === 'search') {
    const tx = db.transaction(['events', 'search', 'rooms', 'meta'], 'readwrite')
    const st = tx.objectStore('search')
    const events = tx.objectStore('events')
    let bytes = 0
    const form = searchForm(db, lim.exact)
    let c = await events.index('room_seq').openCursor(after(room, m.at))
    let n = 0
    let at = m.at
    while (c && n < STEP) {
      if (c.value.type === 'msg') bytes -= await unindex(st, events, c.value, lim, form)
      bytes += await indexEvent(st, events, c.value, lim, form)
      at = c.value.seq
      n += 1
      c = await c.continue()
    }
    await accountRows(tx.objectStore('rooms'), tx.objectStore('meta'), new Map([[room, bytes]]))
    await tx.done
    return c ? { phase: 'search', at } : { phase: 'files', at: -1 }
  }
  if (m.phase === 'files') {
    const rows = (await raw.getAllFromIndex(
      'events',
      'room_seq',
      after(room, m.at),
      STEP
    )) as (EventRecord & { atts?: string[] })[]
    for (const rec of rows) for (const h of rec.atts ?? []) await sealStoredFile(store, h)
    const last = rows.at(-1)
    return last && rows.length === STEP
      ? { phase: 'files', at: last.seq }
      : { phase: 'done', at: -1 }
  }
  return m
}

// Goes on with the jobs a restart stopped.
export async function resumeEarlier(store: P2pStore, lim: Local['search']) {
  const keys = (await store.db.getAllKeys(
    'meta',
    IDBKeyRange.bound(EARLIER_META, `${EARLIER_META}\uffff`)
  )) as string[]
  for (const key of keys)
    void sealEarlier(store, key.slice(EARLIER_META.length), lim).catch(() => {})
}
