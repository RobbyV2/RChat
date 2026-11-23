import { readLocal, writeLocal } from '../instances'
import type { AccountSession } from './session'

function accountKey(origin: string, username: string | null, prefix: string) {
  // A historical AccountId can be identical for different schemes on the same host.
  return prefix + JSON.stringify([new URL(origin).origin, username])
}

export function accountNoticeTag(account: AccountSession, key: string) {
  return account.conn.origin + '|' + account.id + '|' + key
}

interface Lease {
  key: string
  held: boolean
  pending: (() => void)[] | null
  owns: () => boolean
  stop: () => void
}

const heartbeat = 5000
const expiry = heartbeat * 4

export class AccountTabLock {
  private lease: Lease | null = null
  private readonly listeners = new Set<() => void>()

  constructor(
    private readonly shown: () => boolean,
    private readonly locks = (): LockManager | undefined =>
      typeof navigator === 'undefined' ? undefined : navigator.locks,
    private readonly prefix = 'rchat-acct:'
  ) {}

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  holds(origin: string, username: string | null) {
    const lease = this.lease
    return !!lease && lease.key === accountKey(origin, username, this.prefix) && lease.owns()
  }

  // A follower discards its copy of the event when the initial availability
  // check completes. A later handover never replays that notification.
  whenHolder(origin: string, username: string | null, action: () => void) {
    const lease = this.lease
    if (!lease || lease.key !== accountKey(origin, username, this.prefix)) return
    if (lease.owns()) action()
    else lease.pending?.push(action)
  }

  private publish(lease: Lease, held: boolean) {
    if (this.lease !== lease) return
    const pending = lease.pending
    lease.pending = null
    if (lease.held !== held) {
      lease.held = held
      for (const listener of this.listeners) listener()
    }
    if (held) {
      for (const action of pending ?? []) {
        if (this.lease === lease && lease.owns()) action()
      }
    }
  }

  start(origin: string, username: string | null) {
    const key = accountKey(origin, username, this.prefix)
    if (this.lease?.key === key) return
    this.stop()
    const lease: Lease = { key, held: false, pending: [], owns: () => lease.held, stop: () => {} }
    this.lease = lease
    let locks: LockManager | undefined
    try {
      locks = this.locks()
    } catch {
      // Some restricted browser contexts deny access to navigator.locks.
    }
    if (!locks) {
      this.storageLease(lease)
      return
    }
    const controller = new AbortController()
    const signal = controller.signal
    const done = new Promise<void>(resolve => {
      lease.stop = () => {
        controller.abort()
        resolve()
      }
    })
    const hold = () => {
      if (this.lease !== lease) return
      this.publish(lease, true)
      return done
    }
    const acquire = async () => {
      await locks.request(key, { ifAvailable: true }, lock => {
        if (lock) return hold()
        this.publish(lease, false)
      })
      if (this.lease === lease && !lease.held) await locks.request(key, { signal }, hold)
    }
    void acquire().catch(() => {
      if (this.lease === lease) this.storageLease(lease)
    })
  }

  // The poll owner commits synchronously only while connected delivery is idle.
  async ifIdle(origin: string, username: string, action: () => void) {
    const key = accountKey(origin, username, this.prefix)
    let locks: LockManager | undefined
    try {
      locks = this.locks()
    } catch {
      // Match start() in restricted browser contexts.
    }
    if (locks) {
      await locks.request(key, { ifAvailable: true }, lock => {
        if (lock) action()
      })
    } else {
      const record = JSON.parse(readLocal(key) ?? 'null')
      if (!record || !(record.until > Date.now())) action()
    }
  }

  private storageLease(lease: Lease) {
    const fallback = () => {
      lease.owns = this.shown
      this.publish(lease, this.shown())
    }
    if (typeof window === 'undefined') {
      fallback()
      return
    }
    const page = window
    const token = Array.from(crypto.getRandomValues(new Uint32Array(4))).join('-')
    type Record = { token: string; until: number }
    const read = (): Record | null => JSON.parse(readLocal(lease.key) ?? 'null')
    const owns = () => {
      const record = read()
      return record?.token === token && record.until > Date.now()
    }
    lease.owns = () => {
      try {
        return owns()
      } catch {
        return this.shown()
      }
    }
    const tick = () => {
      if (this.lease !== lease) return
      try {
        const now = Date.now()
        const record = read()
        if (!record || record.token === token || !(record.until > now)) {
          const value = JSON.stringify({ token, until: now + expiry })
          if (!writeLocal(lease.key, value) || readLocal(lease.key) === null) {
            lease.stop()
            fallback()
            return
          }
        }
        this.publish(lease, owns())
      } catch {
        lease.stop()
        fallback()
      }
    }
    const changed = (e: StorageEvent) => {
      if (e.key === lease.key || e.key === null) tick()
    }
    const timer = setInterval(tick, heartbeat)
    page.addEventListener?.('storage', changed)
    lease.stop = () => {
      clearInterval(timer)
      page.removeEventListener?.('storage', changed)
      try {
        if (read()?.token === token) writeLocal(lease.key, null)
      } catch {
        /* Storage is unavailable. */
      }
    }
    tick()
  }

  stop() {
    const lease = this.lease
    if (!lease) return
    this.lease = null
    lease.pending = null
    lease.stop()
    if (lease.held) for (const listener of this.listeners) listener()
  }
}
