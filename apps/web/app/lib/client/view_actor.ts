import type { AccountSession } from './session'
import type { Book } from './book'
import { instanceLabel } from '../instance_label'
import type { SwitcherRow } from './switcher_rows'

export type ActorTagRow = Pick<
  SwitcherRow,
  'origin' | 'username' | 'local' | 'display' | 'avatar' | 'ik'
>

export function hasMultipleActors(book: Book) {
  let count = 0
  for (const instance of book.instances) {
    count += Number(instance.guest) + instance.accounts.length
    if (count > 1 || instance.accounts.some(account => account.identities.length > 0)) return true
  }
  return false
}

export function resolveViewActor(
  book: Book,
  origin: string,
  username: string | null,
  peer: { local: string; name: string | null; ik: string | null } | null
) {
  if (!hasMultipleActors(book)) return null
  const instance = book.instances.find(i => i.origin === origin)
  const account = instance?.accounts.find(a => a.username === username)
  if (!instance || (!account && !(username === null && instance.guest))) return null
  const identity = peer && account?.identities.find(i => i.local === peer.local)
  const display = peer ? peer.name || identity?.name || peer.local : (username ?? 'Guest')
  const name = instanceLabel(
    instance,
    new URL(origin).host,
    book.instances.map(i => ({
      name: i.name,
      host: new URL(i.origin).host,
    }))
  )
  const row: ActorTagRow = {
    origin,
    username,
    display,
    local: peer?.local ?? null,
    ik: peer?.ik ?? identity?.ik ?? null,
    avatar: account?.avatar ?? null,
  }
  return { row, name }
}

// Alerts from the main P2P identity retain their original keys. Additional identities
// namespace the same keys with identityScopeKey in the P2P host.
export function noticePeerLocal(key: string) {
  const peer = /^(?:identity\/([^/]+)\/)?p2p(?:-call)?:/.exec(key)
  return peer ? (peer[1] ?? 'main') : null
}

export function resolveNoticeActor(book: Book, owner: AccountSession, key: string) {
  const state = owner.store.getState()
  const username = state.guest ? null : (state.me?.username ?? owner.credentialTarget ?? null)
  const local = noticePeerLocal(key)
  const snapshot = local ? owner.identities.get(local)?.useP2p.getState() : undefined
  return resolveViewActor(
    book,
    owner.conn.origin,
    username,
    local ? { local, name: snapshot?.name ?? null, ik: snapshot?.ik ?? null } : null
  )
}
