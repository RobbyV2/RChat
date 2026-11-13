import { olderThan, PAGE, type RecordStore, type RecordTable, type Stored } from './records'

const table = <T extends Stored>(rows: Map<string, Stored>): RecordTable<T> => {
  const sorted = () => [...rows.values()].sort((a, b) => (olderThan(a, b) ? 1 : -1))
  return {
    put: async records => {
      for (const r of records) rows.set(r.id, structuredClone(r))
    },
    list: async ({ before, limit = PAGE } = {}) =>
      sorted()
        .filter(r => !before || olderThan(r, before))
        .slice(0, limit)
        .map(r => structuredClone(r) as T),
    delete: async ids => {
      for (const id of ids) rows.delete(id)
    },
    prune: async ({ olderThan: cut, keep }) => {
      const gone = sorted().filter(
        (r, i) => (cut !== undefined && r.at < cut) || (keep !== undefined && i >= keep)
      )
      for (const r of gone) rows.delete(r.id)
      return gone.length
    },
    clear: async () => rows.clear(),
    count: async () => rows.size,
    durable: async () => false,
  }
}

// Records held in memory: for tests, and for browsers whose storage is closed.
export const memoryRecords = (): RecordStore => {
  const tables = new Map<string, Map<string, Stored>>()
  return {
    open: name => {
      const rows = tables.get(name) ?? new Map<string, Stored>()
      tables.set(name, rows)
      return table(rows)
    },
    remove: async name => void tables.delete(name),
  }
}
