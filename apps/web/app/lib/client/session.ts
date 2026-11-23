import type { StoreApi } from 'zustand/vanilla'
import type { InstanceConnection } from '../instances'
import type { RChatState } from '../store_types'
import { KeyScope } from './keys'

export type AccountId = string

export class AccountSession {
  readonly keys: KeyScope

  constructor(
    readonly conn: InstanceConnection,
    readonly store: StoreApi<RChatState>
  ) {
    this.keys = new KeyScope(conn, () => this.username)
  }

  private get username() {
    return this.store.getState().me?.username ?? null
  }

  get id(): AccountId {
    return `${this.username ?? '~guest'}@${this.conn.host}`
  }

  get api() {
    return this.conn.api
  }
}
