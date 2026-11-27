import { client } from './client'
import { addIdentity, editIdentity, removeIdentity, type Book, type BookIdentity } from './book'
import type { AccountSession } from './session'
import { parseOn, p2pKey } from '../p2p/app/store'
import { accountStorage, peerStorage } from './keys'
import { readLocal } from '../instances'
import { CHANGED } from '../p2p/transfer'
import { cleanName } from '../p2p/keys'
import { sameSecret } from '../secret'
import { time } from '../platform/time'

export function identityRecords(book: Book, origin: string, username: string) {
  return book.instances.find(i => i.origin === origin)?.accounts.find(a => a.username === username)
    ?.identities
}

function sessionOwner(account: AccountSession, username: string) {
  const mark = account.lifetime.sessionMark()
  const origin = account.conn.origin
  const key = accountStorage(account.conn).token(username)
  const credential = readLocal(key)
  const token = account.store.getState().token
  return () => {
    const state = account.store.getState()
    return (
      account.lifetime.sessionMark() === mark &&
      account.conn.origin === origin &&
      state.me?.username === username &&
      !state.guest &&
      sameSecret(state.token, token) &&
      readLocal(key) === credential
    )
  }
}

export function identityOwner(account: AccountSession) {
  const state = account.store.getState()
  const username = state.me?.username
  if (!username || state.guest || !state.settings.p2p)
    throw Error('Sign in with P2P enabled to add an identity')
  const origin = account.conn.origin
  const sameSession = sessionOwner(account, username)
  const current = () => sameSession() && account.store.getState().settings.p2p
  return { origin, username, current }
}

export async function reserveIdentity(account: AccountSession, name: string) {
  const owner = identityOwner(account)
  const main = account.identities.get()
  if (!main || !cleanName(name)) throw Error('Enter an identity name')
  const other = crypto.randomUUID()
  const added = time().now()
  let local = ''
  const manifest = account.keys.local('rchat_p2p_identities')
  let flag = ''
  let before: string | null = null
  const result = await client.updateStoredBook(book => {
    if (!owner.current()) return book
    const records = identityRecords(book, owner.origin, owner.username)
    if (!records || records.length >= 8) return book
    local =
      main.p2p.hasData(owner.username) || records.some(i => i.local === 'main') ? other : 'main'
    flag = peerStorage(account.conn, owner.username, local).scoped(p2pKey(owner.username))
    before = readLocal(flag)
    return addIdentity(book, owner.origin, owner.username, {
      local,
      enrollment: other,
      added,
      name: cleanName(name),
      ik: null,
      background: true,
    })
  })
  const record = identityRecords(result, owner.origin, owner.username)?.find(
    i => i.local === local && i.enrollment === other
  )
  if (!record)
    throw Error('Could not save this identity. Each account can hold up to eight identities.')
  let releaseEmpty = () => account.identities.releaseSlot(local, manifest, true)
  const cancel = async () => {
    // Manifest pruning must run only on the serialized edit, never an optimistic replay.
    await client.updateStoredBook(book => {
      const now = identityRecords(book, owner.origin, owner.username)?.find(i => i.local === local)
      if (
        now?.enrollment !== other ||
        now.added !== record.added ||
        now.name !== record.name ||
        now.ik !== null ||
        now.pendingImport ||
        readLocal(flag) !== before ||
        parseOn(before)
      )
        return book
      if (local !== 'main' && !releaseEmpty()) return book
      return removeIdentity(book, owner.origin, owner.username, local)
    })
  }
  try {
    if (!owner.current()) throw Error('The selected account changed')
    if (local !== 'main') {
      let saved = false
      await client.updateStoredBook(book => {
        const slot = identityRecords(book, owner.origin, owner.username)?.find(
          i => i.local === local
        )
        if (slot?.enrollment === other && owner.current())
          saved = account.identities.saveSlot(manifest, local)
        return book
      })
      if (!saved || !owner.current()) throw Error('Could not attach this identity')
    }
    const app = local === 'main' ? main : account.identities.add(local)
    releaseEmpty = account.identities.emptySlotCleanup(local, manifest, app)
    const current = () =>
      owner.current() &&
      account.identities.get(local) === app &&
      identityRecords(client.readStoredBook(), owner.origin, owner.username)?.some(
        i => i.local === local && i.enrollment === other
      ) === true
    return { app, current, cancel }
  } catch (error) {
    await cancel()
    throw error
  }
}

export function confirmIdentityRemoval(
  source: AccountSession,
  account: AccountSession,
  local: string,
  done?: (ok: boolean) => void
) {
  const { origin } = account.conn
  const username = account.store.getState().me?.username
  if (!username) return
  const sameSession = sessionOwner(account, username)
  const flag = peerStorage(account.conn, username, local).scoped(p2pKey(username))
  const app = account.identities.get(local)
  const expectedKey = app?.useP2p.getState().ik
  const offline = app ? undefined : account.identities.offlineData().find(s => s.id === local)
  const record = identityRecords(client.book.getState(), origin, username)?.find(
    i => i.local === local
  )
  const current = () =>
    sameSession() &&
    account.identities.get(local) === app &&
    identityRecords(client.book.getState(), origin, username)?.find(i => i.local === local)
      ?.added === record?.added
  source.store.getState().askConfirm({
    title: 'Remove P2P data from this browser?',
    body: 'Your P2P identity and contacts are deleted from this browser. Without a backup they are gone for good.',
    confirm: 'Remove',
    action: async () => {
      if (
        !current() ||
        app?.useP2p.getState().ik !== expectedKey ||
        identityRecords(client.book.getState(), origin, username)?.find(i => i.local === local)
          ?.ik !== record?.ik
      )
        return
      const ok = await (app ? app.p2p.removeData(username) : offline?.remove())
      done?.(!!ok)
      if (!ok) {
        if (current()) source.store.getState().setError("Couldn't remove P2P data")
        return
      }
      if (parseOn(readLocal(flag))) return
      if (current() && app && local !== 'main') account.identities.unregister(local)
      if (record)
        await client.updateBook(book =>
          identityRecords(book, origin, username)?.some(
            i => i.local === local && i.added === record.added && i.ik === record.ik
          )
            ? removeIdentity(book, origin, username, local)
            : book
        )
    },
  })
}

export function creationChoices<T extends 'account' | 'identity' | 'none'>(
  supported: readonly T[],
  accountPhraseOwner: string | null,
  target: string | null
) {
  return supported.filter(
    choice => choice !== 'account' || accountPhraseOwner === null || accountPhraseOwner === target
  )
}

// Keep both keys in the shared book until the destination transaction settles.
export async function claimImportedKey(
  account: AccountSession,
  local: string,
  ik: string,
  destination: { expected: string | null; readDestination(): Promise<string | null> }
) {
  const owner = identityOwner(account)
  const find = (book: Book) =>
    identityRecords(book, owner.origin, owner.username)?.find(i => i.local === local)
  const snapshot = find(client.readStoredBook())
  if (!snapshot) throw Error('This identity is no longer saved on this device')
  const id = crypto.randomUUID()
  const same = (book: Book) => {
    const record = find(book)
    return record && record.added === snapshot.added && record.enrollment === snapshot.enrollment
      ? record
      : undefined
  }
  const owns = (book: Book) => same(book)?.pendingImport?.id === id
  const edit = (book: Book, apply: (record: BookIdentity) => BookIdentity) =>
    editIdentity(book, owner.origin, owner.username, local, apply)
  const finish = async (key: string | null) => {
    const result = await client.updateStoredBook(book =>
      owns(book)
        ? edit(book, record => {
            const next = { ...record, ik: key }
            delete next.pendingImport
            return next
          })
        : book
    )
    if (owns(result)) throw Error('Could not save the identity import result')
  }

  // A renderer may have exited on either side of the IDB commit. Fence its writer
  // before reading self: this read queues behind any transaction it already started.
  if (snapshot.pendingImport) {
    const fenced = await client.updateStoredBook(book => {
      const pending = same(book)?.pendingImport
      return owner.current() && pending && pending.id === snapshot.pendingImport!.id
        ? edit(book, record => ({ ...record, pendingImport: { ...pending, id } }))
        : book
    })
    if (!owns(fenced)) throw Error(CHANGED)
    await finish(await destination.readDestination())
  }
  if ((await destination.readDestination()) !== destination.expected) throw Error(CHANGED)
  const result = await client.updateStoredBook(book => {
    const record = same(book)
    if (
      !owner.current() ||
      !record ||
      record.pendingImport ||
      (record.ik !== null && record.ik !== destination.expected)
    )
      return book
    const conflict = book.instances.some(i =>
      i.accounts.some(a =>
        a.identities.some(
          peer =>
            peer !== record &&
            [peer.ik, peer.pendingImport?.ik].some(
              key => key != null && (key === ik || key === destination.expected)
            )
        )
      )
    )
    return conflict
      ? book
      : edit(book, peer => ({
          ...peer,
          ik: destination.expected,
          pendingImport: { id, ik },
        }))
  })
  if (!owns(result))
    throw Error('Could not attach this key. It may already belong to another saved identity.')
  return {
    check() {
      if (!owner.current() || !owns(client.readStoredBook())) throw Error(CHANGED)
    },
    rollback: async () => finish(await destination.readDestination()),
    commit: () => finish(ik),
  }
}
