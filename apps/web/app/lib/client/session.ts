import { createViewing } from '../viewing'
import { createChatStore } from '../store'
import { sessionLifetime } from '../slices/ctx'
import { lookup, shareOrigin, type InstanceConnection } from '../instances'
import { client } from './client'
import { KeyScope } from './keys'

export type AccountId = string

export class AccountSession {
  readonly renderKey = client.nextSessionKey()
  readonly keys: KeyScope
  readonly lifetime = sessionLifetime()
  readonly store: ReturnType<typeof createChatStore>
  constructor(
    readonly conn: InstanceConnection,
    readonly viewing = createViewing(conn),
    readonly discovery = lookup()
  ) {
    this.keys = new KeyScope(conn, () => this.username)
    this.store = createChatStore(this)
    client.attach(this)
  }

  private get username() {
    return this.store.getState().me?.username ?? null
  }

  get id(): AccountId {
    return `${this.username ?? '~guest'}@${this.conn.host}`
  }

  get shareOrigin() {
    return shareOrigin(undefined, undefined, this.conn)
  }

  get api() {
    return this.conn.api
  }
}
