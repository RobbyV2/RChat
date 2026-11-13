// Records kept on this device (the command log, reminders the device holds), behind one
// interface so native shells can keep them elsewhere. The web one, in IndexedDB, is in
// `web_records.ts`; `memory_records.ts` holds them for the life of the page.

// A record has an id, unique in its table, and a time in ms that orders the table.
export interface Stored {
  id: string
  at: number
}

export interface RecordTable<T extends Stored> {
  // Adds the records in one write. A record whose id is already there replaces it.
  put: (records: T[]) => Promise<void>
  // The newest records first; with `before`, only those older than that record (pass the last
  // one of the previous page). Records of the same time are ordered by id.
  list: (opts?: { before?: Stored; limit?: number }) => Promise<T[]>
  delete: (ids: string[]) => Promise<void>
  // Removes the records older than `olderThan` and all but the newest `keep`; resolves to how
  // many went.
  prune: (opts: { olderThan?: number; keep?: number }) => Promise<number>
  clear: () => Promise<void>
  count: () => Promise<number>
  // Whether the records outlive the page. False when the platform has no storage for them.
  durable: () => Promise<boolean>
}

export interface RecordStore {
  // Names come already scoped to the instance and account.
  open: <T extends Stored>(name: string) => RecordTable<T>
  // Drops the table and everything in it.
  remove: (name: string) => Promise<void>
}

export const PAGE = 50

// Whether `a` comes after `b` in a table: older, or of the same time with a smaller id.
export const olderThan = (a: Stored, b: Stored) => a.at < b.at || (a.at === b.at && a.id < b.id)
