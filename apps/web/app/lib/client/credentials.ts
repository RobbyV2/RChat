import { clientOnly, localKeys, readLocal, writeLocal, type InstanceConnection } from '../instances'
import { accountUsername } from '../qualified'
import { accountStorage, peerStorage, SSO_LOGOUT_KEY } from './keys'
import { addInstance, addAccount, addIdentity, type Book, type BookAccount } from './book'
import type { Me } from '../types'

export function storedCredential(conn: InstanceConnection, book: Book, target?: string | null) {
  const keys = accountStorage(conn)
  if (target === null) return null
  if (target !== undefined) {
    const token = readLocal(keys.token(target))
    return token ? { token, username: target, key: keys.token(target) } : null
  }
  const alias = readLocal(keys.key('rchat_token'))
  const accounts = book.instances.find(i => i.origin === conn.origin)?.accounts ?? []
  if (alias)
    return {
      token: alias,
      key: keys.key('rchat_token'),
      username: accounts.find(a => readLocal(keys.token(a.username)) === alias)?.username,
    }
  for (const account of accounts) {
    const token = readLocal(keys.token(account.username))
    if (token) return { token, username: account.username, key: keys.token(account.username) }
  }
  // A selected remote can have a qualified token before /me has populated
  // the book. Only consider keys in the namespace bound to this connection.
  if (clientOnly() && conn.isHome && !conn.isDefault && !accounts.length) {
    const prefix = 'rchat_token:'
    const suffix = keys.token('').slice(prefix.length)
    for (const key of localKeys(prefix)) {
      if (!suffix || !key.endsWith(suffix)) continue
      const username = accountUsername(key.slice(prefix.length, key.length - suffix.length))
      if (!username || key !== keys.token(username)) continue
      const token = readLocal(key)
      if (token) return { token, username, key }
    }
  }
  return null
}

export function confirmCredential(
  conn: InstanceConnection,
  me: Me,
  token: string,
  restoring: boolean,
  endSession = false
) {
  const keys = accountStorage(conn)
  const alias = keys.key('rchat_token')
  const old = readLocal(alias)
  const qualified = keys.token(me.username)
  const previous = readLocal(qualified)
  if (restoring && previous && previous !== token && old !== token) return
  if (!restoring || previous !== token)
    writeLocal(
      keys.key(SSO_LOGOUT_KEY + ':' + me.username),
      endSession ? JSON.stringify({ v: 1, on: true }) : null
    )
  writeLocal(qualified, token)
  if (old === token || (!restoring && (!old || previous === old))) writeLocal(alias, token)
  const dm = keys.lastDm(me.username)
  if (readLocal(dm) === null && old === token) {
    const found =
      readLocal(keys.key('rchat_last_dm') + ':' + me.username) ??
      readLocal(keys.key('rchat_last_dm'))
    if (found !== null) writeLocal(dm, found)
  }
}
export function rememberLastDm(
  conn: InstanceConnection,
  username: string,
  token: string | null,
  id: number
) {
  const keys = accountStorage(conn)
  const value = String(id)
  writeLocal(keys.lastDm(username), value)
  // An older remote client reads its username after the authority. The earliest
  // host-only pointer belongs to whichever account still owns the legacy token.
  const historical = keys.key('rchat_last_dm')
  writeLocal(historical + ':' + username, value)
  if (token && readLocal(keys.key('rchat_token')) === token && readLocal(historical) !== null)
    writeLocal(historical, value)
}
export function forgetCredential(
  conn: InstanceConnection,
  username: string | undefined,
  token: string | null
) {
  const keys = accountStorage(conn)
  if (!token) return false
  if (username && readLocal(keys.token(username)) === token) {
    writeLocal(keys.key(SSO_LOGOUT_KEY + ':' + username), null)
    writeLocal(keys.token(username), null)
  }
  const alias = keys.key('rchat_token')
  if (readLocal(alias) !== token) return false
  writeLocal(alias, null)
  writeLocal(keys.key('rchat_last_dm'), null)
  return true
}
export function instanceDescriptor(conn: InstanceConnection) {
  return { origin: conn.origin, id: conn.info?.id || conn.origin, name: conn.name }
}

// Capture the verified owner before a browser lock can yield to another session.
export function accountUpdate(conn: InstanceConnection, me: Me) {
  const instance = instanceDescriptor(conn)
  const own = conn.isDefault ? instance.origin : null
  const added = Date.now()
  const flag = peerStorage(conn, me.username).scoped('rchat_p2p:' + me.username)
  let main = false
  try {
    const value = JSON.parse(readLocal(flag) ?? 'null')
    main = value?.v === 1 && value.on === true
  } catch {
    /* Ignore a malformed historical flag. */
  }
  return (current: Book) => {
    let book = addInstance(current, instance)
    const old = book.instances
      .find(i => i.origin === instance.origin)
      ?.accounts.find(a => a.username === me.username)
    const account: BookAccount = {
      connect: true,
      added,
      identities: [],
      ...old,
      username: me.username,
      display: me.display_name ?? null,
      avatar: me.avatar_kind ? { kind: me.avatar_kind, color: me.avatar_color } : null,
    }
    book = addAccount(book, instance.origin, account, own)
    return main
      ? addIdentity(book, instance.origin, me.username, {
          local: 'main',
          ik: null,
          name: 'Main',
          added: account.added,
          background: true,
        })
      : book
  }
}
