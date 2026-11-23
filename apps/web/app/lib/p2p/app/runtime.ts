import { peerStorage } from '../../client/keys'
import type { AccountSession } from '../../client/session'
import { resetHandlers, type IdentityOptions, type IdentityScope } from '../identity_scope'
import type { P2pParts } from './scope'
import { bindP2pHost } from './host'
import { createStorePart, legacyStore, legacyScope } from './store'
import { createViewingPart, legacyViewing } from './viewing'
import { createRailPart, legacyRail } from './rail'
import { createDmsPart, legacyDms } from './dms'
import { createAttachmentsPart, legacyAttachments } from './attachments'
import { createBadgePart, legacyBadge } from './badge'
import { createCallsPart, legacyCalls } from './calls'
import { createInboxPart, legacyInbox } from './inbox'
import { createServersPart, legacyServers } from './servers'
import { createMovePart, legacyMove } from './move'
import { createAccountPart, legacyAccount } from './account'

function makeParts(scope: IdentityScope): P2pParts {
  // Cross-part callbacks read these fields after construction. Only the server
  // subscriptions read the state and viewing parts during construction.
  const parts = {} as P2pParts
  parts.store = createStorePart(scope)
  parts.viewing = createViewingPart(scope)
  parts.rail = createRailPart(parts, scope)
  parts.dms = createDmsPart(parts, scope)
  parts.attachments = createAttachmentsPart(parts, scope)
  parts.badge = createBadgePart(parts, scope)
  parts.calls = createCallsPart(parts, scope)
  parts.inbox = createInboxPart(parts)
  parts.servers = createServersPart(parts, scope)
  parts.move = createMovePart(parts, scope)
  parts.account = createAccountPart(parts, scope)
  return parts
}

function application(parts: P2pParts, scope: IdentityScope, cleanup: () => void) {
  const app = {
    ...parts.store,
    ...parts.viewing,
    ...parts.rail,
    ...parts.dms,
    ...parts.attachments,
    ...parts.badge,
    ...parts.calls,
    ...parts.inbox,
    ...parts.servers,
    ...parts.move,
    ...parts.account,
    get owner() {
      return scope.owner ?? parts.store.p2pHost.account
    },
    localId: scope.localId,
    inIdentity<T extends unknown[], R>(fn: (...args: T) => R) {
      const account = scope.owner ?? parts.store.p2pHost.account
      const mark = account?.lifetime.sessionMark()
      return (...args: T) => {
        if (!scope.disposed && account?.lifetime.sessionMark() === mark) return fn(...args)
      }
    },
    dispose() {
      void parts.account.p2pAccount(null)
      cleanup()
    },
  }
  // The node and protocol handles change on leadership transfer and restart.
  for (const part of [parts.store, parts.dms])
    for (const [key, desc] of Object.entries(Object.getOwnPropertyDescriptors(part)))
      if (desc.get) Object.defineProperty(app, key, desc)
  return app
}

export type P2pApp = ReturnType<typeof application>
export function createP2pApp(
  owner: AccountSession,
  localId: string,
  options: IdentityOptions = {}
) {
  let disposed = false
  const cleanups = new Set<() => void>()
  const { origin } = owner.conn
  const username = owner.store.getState().me?.username
  const storage = peerStorage(owner.conn, username ?? null, localId)
  const session = owner.lifetime.sessionMark()
  const scope: IdentityScope = {
    ...resetHandlers(),
    owner,
    localId,
    options,
    get disposed() {
      return disposed
    },
    dbHost: () => storage.host,
    current: user =>
      !disposed &&
      owner.conn.origin === origin &&
      owner.lifetime.sessionMark() === session &&
      owner.store.getState().me?.username === username &&
      (user === undefined || user === username),
    scoped: storage.scoped,
    onDispose: fn => {
      cleanups.add(fn)
    },
  }
  const app = application(makeParts(scope), scope, () => {
    disposed = true
    for (const fn of cleanups) fn()
    cleanups.clear()
  })
  bindP2pHost(app, owner, () => scope.current() && app.useP2p.getState().account === username)
  return app
}

export const legacyP2pApp = application(
  {
    store: legacyStore,
    viewing: legacyViewing,
    rail: legacyRail,
    dms: legacyDms,
    attachments: legacyAttachments,
    badge: legacyBadge,
    calls: legacyCalls,
    inbox: legacyInbox,
    servers: legacyServers,
    move: legacyMove,
    account: legacyAccount,
  },
  legacyScope,
  () => {}
)
