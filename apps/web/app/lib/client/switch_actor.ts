import { client } from './client'
import type { AccountSession } from './session'
import { liveSwitcherRows, type SwitcherRow } from './switcher_rows'
import { createSavedSession } from './saved_session'

export function switcherSession(row: Pick<SwitcherRow, 'origin' | 'username'>) {
  return client.live().find(account => {
    const s = account.store.getState()
    return (
      account.conn.origin === row.origin &&
      (s.me?.username ?? (s.guest ? null : account.credentialTarget)) === row.username
    )
  })
}

export async function switchActor(
  row: SwitcherRow,
  from: AccountSession,
  selected?: (owner: AccountSession) => void
) {
  const parent = liveSwitcherRows()
    .groups.find(g => g.origin === row.origin)
    ?.rows.find(r => r.username === row.username && r.local === null)
  if (!parent) return
  if (parent.status === 'Signed out') {
    client.cancelActorSelection()
    from.store
      .getState()
      .openDialog({ kind: 'add_instance', origin: row.origin, username: row.username ?? undefined })
    return
  }
  const owner = switcherSession(row) ?? createSavedSession(row.origin, row.username)
  from.store.getState().closeDialog()
  if (!client.show(owner)) return
  const intent = client.actorSelectionMark()
  const mark = owner.lifetime.sessionMark()
  if (!owner.store.getState().me && !owner.store.getState().guest)
    await owner.store.getState().bootstrap()
  if (
    intent !== client.actorSelectionMark() ||
    owner.lifetime.sessionMark() !== mark ||
    !client.canWritePage(owner) ||
    switcherSession(row) !== owner
  )
    return
  if (row.local === null) owner.identities.viewed()?.p2p.closeHome()
  else {
    const identity = owner.identities.get(row.local)
    if (!identity) return
    owner.identities.show(identity)
    // Admission restores the parked app's account before openHome persists its view.
    client.accounts.reconcile()
    identity.p2p.openHome()
  }
  selected?.(owner)
}
