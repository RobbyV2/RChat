import { defaultEndpoints, endpointsFrom, InstanceConnection, readKnown } from '../instances'
import type { AccountSession } from './session'

export function savedConnection(origin: string) {
  const defaults = defaultEndpoints()
  const info = readKnown()[origin] ?? null
  const isDefault = origin === defaults.origin
  return new InstanceConnection(isDefault ? defaults : endpointsFrom(origin, info), info, isDefault)
}
export function createSavedSession(origin: string, username?: string | null): AccountSession {
  const conn = savedConnection(origin)
  // Keep the client and wire modules cold-importable without loading the store.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { AccountSession } = require('./session') as typeof import('./session')
  return new AccountSession(conn, undefined, undefined, username)
}
