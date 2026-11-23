import { defaultEndpoints, endpointsFrom, InstanceConnection, readKnown } from '../instances'
import { hostOf } from '../qualified'
import { parseAccountPath, parsePath, type RouteOwner } from '../view'
import { client } from './client'
import type { AccountSession } from './session'

function usernameOf(account: AccountSession) {
  const { me, guest } = account.store.getState()
  return me?.username ?? (guest ? null : account.credentialTarget)
}

export function routeOwnerFor(account: AccountSession): RouteOwner | null {
  const username = usernameOf(account)
  if (username === undefined) return null
  if (username !== null && account.conn.isDefault) {
    const entry = client.book.getState().instances.find(i => i.origin === account.conn.origin)
    const primary = entry?.accounts.find(a => a.primary)
    if (!entry?.accounts.length || primary?.username === username) return null
  }
  return { username, host: account.conn.host }
}

export function accountHistoryState(account: AccountSession, previous: unknown) {
  const username = usernameOf(account)
  if (username === undefined) return previous
  const fields = previous !== null && typeof previous === 'object' ? previous : {}
  return {
    ...fields,
    acct: (username ?? '~guest') + '@' + account.conn.host,
    rchatOrigin: account.conn.origin,
  }
}

function createPageSession(origin: string, username?: string | null) {
  const defaults = defaultEndpoints()
  const info = readKnown()[origin] ?? null
  const isDefault = origin === defaults.origin
  const conn = new InstanceConnection(
    isDefault ? defaults : endpointsFrom(origin, info),
    info,
    isDefault
  )
  // Loading the client registry alone does not initialize the chat store.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { AccountSession } = require('./session') as typeof import('./session')
  return new AccountSession(conn, undefined, undefined, username)
}

// A prefix can represent multiple origins with the same authority. Only this
// entry's recorded origin can disambiguate those for Back and Forward.
function resolvePageAccount(pathname: string, historyState: unknown): AccountSession | null {
  const route = parseAccountPath(pathname)
  if (!route) return null
  const shown = client.shown()
  const book = client.book.getState()
  const defaults = defaultEndpoints()
  const own = defaults.origin
  const primary = book.instances.find(i => i.origin === own)?.accounts.find(a => a.primary)
  const history = historyState as { acct?: unknown; rchatOrigin?: unknown } | null
  const { owner } = route
  let origin: string
  let username: string | null
  if (owner) {
    const origins = new Set(
      book.instances
        .filter(
          i =>
            hostOf(i.origin) === owner.host &&
            (owner.username === null
              ? i.guest
              : i.accounts.some(a => a.username === owner.username))
        )
        .map(i => i.origin)
    )
    for (const session of client.live()) {
      // An expired session may already be absent from the book while its login
      // form is returning to this very account's link.
      if (
        session.conn.host === owner.host &&
        session.credentialTarget === owner.username &&
        usernameOf(session) === owner.username
      )
        origins.add(session.conn.origin)
    }
    const id = (owner.username ?? '~guest') + '@' + owner.host
    if (typeof history?.rchatOrigin === 'string' && history.acct === id) {
      if (!origins.has(history.rchatOrigin)) return null
      origin = history.rchatOrigin
    } else {
      if (origins.size !== 1) return null
      origin = Array.from(origins)[0]
    }
    username = owner.username
  } else {
    if (!primary) {
      // Older profiles can first open offline, before /me has identified an
      // account. The saved home connection already targets that instance.
      if (history?.acct && history.rchatOrigin) return null
      const home = client.live().find(a => a.isHome) ?? shown
      const share =
        /^\/(?:i|invite|config)\//.test(route.path) || parsePath(route.path)?.kind === 'message'
      if (share && home.conn.origin !== own) {
        return (
          client
            .live()
            .find(session => session.conn.origin === own && usernameOf(session) === undefined) ??
          createPageSession(own)
        )
      }
      return home
    }
    if (
      history?.rchatOrigin &&
      (history.rchatOrigin !== own || history.acct !== primary.username + '@' + hostOf(own))
    )
      return null
    origin = own
    username = primary.username
  }
  const live = client.live().find(a => a.conn.origin === origin && usernameOf(a) === username)
  let next = live
  if (!next) {
    const home = client.live().find(a => a.isHome)
    if (
      home &&
      home.conn.origin === origin &&
      usernameOf(home) === undefined &&
      home.store.getState().token === null &&
      (origin !== own || primary?.username === username)
    ) {
      next = home
      next.credentialTarget = username
    } else {
      next = createPageSession(origin, username)
    }
  } else {
    next.credentialTarget = username
  }
  return next
}

export function selectPageAccount(pathname: string, historyState: unknown): AccountSession | null {
  const account = resolvePageAccount(pathname, historyState)
  if (account) client.show(account, 'none')
  else client.blockPage()
  return account
}
