// An account that asks to be deleted: the wait, what the app says, and the order of the steps.

import { removeIdentity } from './client/book'
import { client } from './client/client'
import { identityRecords } from './client/identity_enrollment'
import type { AccountSession } from './client/session'
import type { P2pApp } from './p2p/app/runtime'
import type { ReAuthBody } from './types'

export const DELETION_DAYS = 14

const DAY = 86_400

// Whole days until `deleteAt`, at least one while it is ahead. Both in unix seconds.
export const deletionDaysLeft = (deleteAt: number, now: number) =>
  Math.max(0, Math.ceil((deleteAt - now) / DAY))

// The line of the notice at the top of the app while a deletion waits.
export const deletionNotice = (deleteAt: number, now: number) => {
  const days = deletionDaysLeft(deleteAt, now)
  if (days === 0) return 'This account is being deleted.'
  return `This account is deleted in ${days} ${days === 1 ? 'day' : 'days'}.`
}

export const DELETION_TEXT = `Your account, your messages and your direct messages are deleted after ${DELETION_DAYS} days. Confirming signs you out everywhere. Sign in again before then to keep the account.`

export const DELETION_P2P_LABEL = 'Also remove my P2P identities from this device'

export const DELETION_P2P_KEPT =
  'Your P2P identities stay on this device and keep working without the account.'

// Shown in the dialog when an identity can't come online in this tab: nothing was sent.
export const DELETION_P2P_OFFLINE =
  "Your P2P identities couldn't connect here, so nothing was deleted. Try again in a moment."

export interface Retiring {
  // Leaves the P2P servers and removes the identities from this device. One that can't leave
  // every server stays.
  retire(): Promise<void>
  // Lets the identities run as before.
  release(): void
}

export interface DeletionSteps {
  // Gets the P2P identities ready to sign their leaves here. Throws when one can't.
  prepare(): Promise<Retiring>
  // Asks the instance. It refuses a wrong confirmation, and then nothing else happens.
  request(reauth: ReAuthBody): Promise<{ delete_at: number }>
  // Ends the session here.
  signOut(): void
}

// The identities get ready first, so one that can't run here stops everything before the
// instance is asked. Nothing is signed or deleted before the instance accepts, so a refusal
// leaves them alone; they leave before the session ends here.
export async function runDeletion(steps: DeletionSteps, reauth: ReAuthBody, removeP2p: boolean) {
  const going = removeP2p ? await steps.prepare() : null
  try {
    const { delete_at } = await steps.request(reauth)
    await going?.retire().catch(() => {})
    steps.signOut()
    return delete_at
  } finally {
    going?.release()
  }
}

// Whether this device holds P2P identities of the signed-in account.
export const holdsIdentities = (account: AccountSession) => {
  const username = account.store.getState().me?.username
  if (!username) return false
  return (
    account.identities.list().some(app => app.p2p.hasData(username)) ||
    account.identities.offlineData().length > 0
  )
}

// Gets every P2P identity of the signed-in account on this device ready to leave its servers:
// each runs in this tab until `release`. Throws when one does not come online here.
export async function readyIdentities(account: AccountSession): Promise<Retiring> {
  const username = account.store.getState().me?.username
  const apps = username ? account.identities.list().filter(app => app.p2p.hasData(username)) : []
  const holds = apps.map(app => account.identities.hold(app.localId))
  const release = () => holds.forEach(free => free())
  const ready = await Promise.all(apps.map(app => app.p2p.runHere(username!).catch(() => false)))
  if (!ready.every(Boolean)) {
    release()
    throw new Error(DELETION_P2P_OFFLINE)
  }
  return { release, retire: () => retireIdentities(account, apps) }
}

// Removes the P2P identities of the signed-in account from this device: each leaves its
// servers, then its data, its device key and its saved entry go.
async function retireIdentities(account: AccountSession, apps: P2pApp[]) {
  const { origin } = account.conn
  const username = account.store.getState().me?.username
  if (!username) return
  const record = (local: string) =>
    identityRecords(client.book.getState(), origin, username)?.find(i => i.local === local)
  const forget = async (local: string, saved: ReturnType<typeof record>) => {
    if (!saved) return
    await client.updateBook(book =>
      identityRecords(book, origin, username)?.some(
        i => i.local === local && i.added === saved.added && i.ik === saved.ik
      )
        ? removeIdentity(book, origin, username, local)
        : book
    )
  }
  for (const app of apps) {
    if (!app.p2p.hasData(username)) continue
    const local = app.localId
    const saved = record(local)
    if (!(await app.p2p.retire(username).catch(() => false))) continue
    if (local !== 'main') account.identities.unregister(local)
    await forget(local, saved).catch(() => {})
  }
  for (const slot of account.identities.offlineData()) {
    const saved = record(slot.id)
    if (await slot.remove().catch(() => false)) await forget(slot.id, saved).catch(() => {})
  }
}
