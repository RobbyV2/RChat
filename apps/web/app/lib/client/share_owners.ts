import { instanceLabel } from '../instance_label'
import { readLocal } from '../instances'
import { parseOn, p2pKey } from '../p2p/app/store'
import { allowsAccountOrigin } from './hosted_policy'
import { client } from './client'
import { peerStorage } from './keys'
import { railBlocks } from './rail_blocks'
import { createSavedSession, savedConnection } from './saved_session'
import type { ShareOwner } from './share_target'
import { switcherSession } from './switch_actor'
import { liveSwitcherRows } from './switcher_rows'

export function shareChoices(groups: ReturnType<typeof liveSwitcherRows>['groups']) {
  return railBlocks(groups.filter(group => allowsAccountOrigin(group.origin))).blocks.flatMap(
    group =>
      group.rows.flatMap(row => {
        if (!row.username || row.status === 'Signed out') return []
        const account = switcherSession(row)
        const state = account?.store.getState()
        if (state?.guest || state?.authExpired || state?.signedOut) return []
        const identity = row.local ? account?.identities.get(row.local) : null
        if (row.local) {
          if (state?.me && !state.settings.p2p) return []
          if (!identity?.useP2p.getState().enabled) {
            const conn = account?.conn ?? savedConnection(row.origin)
            if (
              !parseOn(
                readLocal(peerStorage(conn, row.username, row.local).scoped(p2pKey(row.username)))
              )
            )
              return []
          }
        }
        const ready: ShareOwner | null =
          account &&
          state?.me?.username === row.username &&
          (!row.local || identity?.useP2p.getState().enabled)
            ? { account, identity: identity ?? null }
            : null
        return [
          {
            key: JSON.stringify([row.origin, row.username, row.local]),
            origin: row.origin,
            username: row.username,
            local: row.local,
            ready,
            streamer: !!state?.streamer,
            group: instanceLabel(group, group.host, groups),
            label: row.local ? row.display + ' · P2P as ' + row.username : row.username,
          },
        ]
      })
  )
}

// Materialize a saved owner only after the operator has chosen it.
export async function prepareShareOwner(key: string, current: () => boolean) {
  const choice = () => shareChoices(liveSwitcherRows().groups).find(row => row.key === key)
  const row = choice()
  if (!current() || !row) return null
  if (row.ready) return row.ready
  const account = switcherSession(row) ?? createSavedSession(row.origin, row.username)
  const epoch = account.lifetime.sessionMark()
  const intent = client.actorSelectionMark()
  const valid = () =>
    current() &&
    allowsAccountOrigin(row.origin) &&
    intent === client.actorSelectionMark() &&
    account.lifetime.sessionMark() === epoch &&
    switcherSession(row) === account &&
    !!choice()
  if (!account.store.getState().me) await account.store.getState().bootstrap(false)
  if (!valid() || account.store.getState().me?.username !== row.username) return null
  if (!row.local) return { account, identity: null }
  if (!account.identities.get(row.local)) await account.store.getState().loadSettings()
  if (!valid()) return null
  const identity = account.identities.get(row.local)
  if (!identity || !account.store.getState().settings.p2p) return null
  if (!identity.useP2p.getState().enabled) {
    // Admission gives the foreground's selected identity priority, including paused slots.
    account.identities.show(identity)
    if (!client.show(account)) return null
    client.accounts.reconcile()
  }
  return { account, identity }
}
