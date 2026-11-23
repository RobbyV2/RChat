import type { AccountSession } from '../client/session'
import type { LeaderDeps } from './leader'
import type { Transport } from './node'
import type { TransportLimits } from './transport'

export interface IdentityOptions {
  transport?: (limits: TransportLimits, account: AccountSession) => Transport
  leaderDeps?: () => LeaderDeps
}
export interface IdentityScope {
  owner: AccountSession
  localId: string
  readonly disposed?: boolean
  dbHost(username: string): string
  current(username?: string): boolean
  resetSignal(): AbortSignal
  options: IdentityOptions
  scoped(key: string): string
  reset(): void
  onReset(fn: () => void): void
  onDispose(fn: () => void): void
}
export function resetHandlers() {
  const handlers: Array<() => void> = []
  let lifetime = new AbortController()
  return {
    resetSignal: () => lifetime.signal,
    onReset(fn: () => void) {
      handlers.push(fn)
    },
    reset() {
      lifetime.abort()
      lifetime = new AbortController()
      for (const fn of handlers) fn()
    },
  }
}
