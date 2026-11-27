import { clientOnly, localKeys, readLocal, writeLocal, type InstanceConnection } from '../instances'
import { accountUsername } from '../qualified'
import { accountStorage, peerStorage, SSO_LOGOUT_KEY } from './keys'
import { addInstance, addAccount, addIdentity, type Book, type BookAccount } from './book'
import type { Me } from '../types'
import { sameSecret, Secret, TO_STORE } from '../secret'

// A saved session token, read from and written to this device's storage.
export const readToken = (key: string): Secret | null => Secret.from(readLocal(key))
export const writeToken = (key: string, token: Secret | null) =>
  writeLocal(key, token ? token.reveal(TO_STORE) : null)

export function storedCredential(conn: InstanceConnection, book: Book, target?: string | null) {
  const keys = accountStorage(conn)
  if (target === null) return null
  if (target !== undefined) {
    const token = readToken(keys.token(target))
    return token ? { token, username: target, key: keys.token(target) } : null
  }
  const alias = readToken(keys.key('rchat_token'))
  const accounts = book.instances.find(i => i.origin === conn.origin)?.accounts ?? []
  if (alias)
    return {
      token: alias,
      key: keys.key('rchat_token'),
      username: accounts.find(a => alias.same(readToken(keys.token(a.username))))?.username,
    }
  for (const account of accounts) {
    const token = readToken(keys.token(account.username))
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
      const token = readToken(key)
      if (token) return { token, username, key }
    }
  }
  return null
}

export function confirmCredential(
  conn: InstanceConnection,
  me: Me,
  token: Secret,
  restoring: boolean,
  endSession = false
) {
  const keys = accountStorage(conn)
  const alias = keys.key('rchat_token')
  const old = readToken(alias)
  const qualified = keys.token(me.username)
  const previous = readToken(qualified)
  if (restoring && previous && !token.same(previous) && !token.same(old)) return
  if (!restoring || !token.same(previous))
    writeLocal(
      keys.key(SSO_LOGOUT_KEY + ':' + me.username),
      endSession ? JSON.stringify({ v: 1, on: true }) : null
    )
  writeToken(qualified, token)
  if (token.same(old) || (!restoring && (!old || sameSecret(previous, old))))
    writeToken(alias, token)
  const dm = keys.lastDm(me.username)
  if (readLocal(dm) === null && token.same(old)) {
    const found =
      readLocal(keys.key('rchat_last_dm') + ':' + me.username) ??
      readLocal(keys.key('rchat_last_dm'))
    if (found !== null) writeLocal(dm, found)
  }
}
export function rememberLastDm(
  conn: InstanceConnection,
  username: string,
  token: Secret | null,
  id: number
) {
  const keys = accountStorage(conn)
  const value = String(id)
  writeLocal(keys.lastDm(username), value)
  // An older remote client reads its username after the authority. The earliest
  // host-only pointer belongs to whichever account still owns the legacy token.
  const historical = keys.key('rchat_last_dm')
  writeLocal(historical + ':' + username, value)
  if (token?.same(readToken(keys.key('rchat_token'))) && readLocal(historical) !== null)
    writeLocal(historical, value)
}
export function forgetCredential(
  conn: InstanceConnection,
  username: string | undefined,
  token: Secret | null
) {
  const keys = accountStorage(conn)
  if (!token) return false
  if (username && token.same(readToken(keys.token(username)))) {
    writeLocal(keys.key(SSO_LOGOUT_KEY + ':' + username), null)
    writeLocal(keys.token(username), null)
  }
  const alias = keys.key('rchat_token')
  if (!token.same(readToken(alias))) return false
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
