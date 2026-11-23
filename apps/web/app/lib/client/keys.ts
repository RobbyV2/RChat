import { dbName } from '../p2p/db'
import type { InstanceConnection } from '../instances'

export class KeyScope {
  constructor(
    private readonly conn: InstanceConnection,
    private readonly username: () => string | null
  ) {}

  db(local: string = 'main') {
    const name = this.username()
    if (!name) return null
    const db = dbName(this.conn.host, name)
    return local === 'main' ? db : `${db}~${local}`
  }

  local(base: string) {
    const name = this.username()
    return this.conn.scoped(name ? `${base}:${name}` : base)
  }
}
