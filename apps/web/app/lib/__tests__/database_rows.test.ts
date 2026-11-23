import { expect, test } from 'bun:test'
import { databaseRows } from '../database_rows'
import type { DatabaseStatus } from '../types'

const db: DatabaseStatus = {
  kind: 'sqlite',
  version: '3.50',
  schema_version: 40,
  pool: { in_use: 1, idle: 2, max: 8 },
  reader: null,
  connections: null,
  light_commits: null,
  statement_timeout_secs: null,
  replicas: [],
  online_indexes: [],
}

test('shows only the database resources present on this copy', () => {
  expect(databaseRows(db)).toEqual([
    ['Engine', 'SQLite 3.50'],
    ['Schema', '40'],
    ['Primary pool', '1 in use, 2 idle, 8 maximum'],
  ])
  const rows = databaseRows({
    ...db,
    kind: 'postgres',
    statement_timeout_secs: 0,
    replicas: [{ host: 'reader:5432/chat', healthy: false, lag_ms: 3100 }],
    online_indexes: [{ name: 'messages_index', state: 'building', percent: 42, size_mib: 18 }],
  })
  expect(Object.fromEntries(rows)['Statement timeout']).toBe('Off')
  expect(Object.fromEntries(rows)['Replica 1']).toBe('reader:5432/chat · Unavailable · 3100 ms lag')
  expect(Object.fromEntries(rows).messages_index).toBe('building 42% · 18 MiB')
})
