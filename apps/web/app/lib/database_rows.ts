import type { DatabasePool, DatabaseStatus } from './types'

const pool = (p: DatabasePool) => `${p.in_use} in use, ${p.idle} idle, ${p.max} maximum`

export const databaseRows = (db: DatabaseStatus): [string, string][] => {
  const rows: [string, string][] = [
    ['Engine', `${db.kind === 'sqlite' ? 'SQLite' : 'PostgreSQL'} ${db.version}`],
    ['Schema', String(db.schema_version)],
    ['Primary pool', pool(db.pool)],
  ]
  if (db.reader) rows.push(['Reader pool', pool(db.reader)])
  if (db.connections)
    rows.push(['Connections', `${db.connections.used} of ${db.connections.allowed}`])
  if (db.light_commits) rows.push(['Bookkeeping commits', db.light_commits])
  if (db.statement_timeout_secs !== null)
    rows.push([
      'Statement timeout',
      db.statement_timeout_secs ? `${db.statement_timeout_secs}s` : 'Off',
    ])
  db.replicas.forEach((r, i) =>
    rows.push([
      `Replica ${i + 1}`,
      `${r.host} · ${r.healthy ? 'Ready' : 'Unavailable'}${r.lag_ms === null ? '' : ` · ${r.lag_ms} ms lag`}`,
    ])
  )
  for (const index of db.online_indexes)
    rows.push([
      index.name,
      `${index.state}${index.percent === null ? '' : ` ${index.percent}%`} · ${index.size_mib} MiB`,
    ])
  return rows
}
