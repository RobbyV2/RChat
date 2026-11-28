import { instanceLabel } from '../instance_label'
import { readLocal } from '../instances'
import { parseOn, p2pKey } from '../p2p/app/store'
import { allowsAccountOrigin } from './hosted_policy'
import { client } from './client'
import { peerStorage } from './keys'
import { railBlocks } from './rail_blocks'
import { createSavedSession, savedConnection } from './saved_session'
import { shareLabels, type ShareOwner } from './share_target'
import { accountLabel, instanceName, labelWith, notAName, p2pName } from '../names'
import { switcherSession } from './switch_actor'
import { liveSwitcherRows } from './switcher_rows'

// The accounts and P2P identities a share can go out as, by instance. Labels follow each
// account's streamer mode and this device's: an instance is then "Instance 2", a row "Account 1".
export function shareChoices(groups: ReturnType<typeof liveSwitcherRows>['groups']) {
  const blocks = railBlocks(groups.filter(group => allowsAccountOrigin(group.origin))).blocks
  const origins = [...new Set(blocks.map(group => group.origin))]
  const rows = blocks.flatMap(group =>
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
          say: shareLabels(state ?? { streamer: false, profanityReady: false, me: null }),
          group: instanceLabel(group, group.host, groups),
          display: row.display,
        },
      ]
    })
  )
  return rows.map(row => {
    const mates = rows.filter(r => r.origin === row.origin)
    const n = mates.indexOf(row) + 1
    const hidden = mates.find(r => r.say.hiding)?.say ?? row.say
    const { say, display, ...kept } = row
    return {
      ...kept,
      group: hidden.line(notAName('Instance ' + (origins.indexOf(row.origin) + 1)), () =>
        hidden(instanceName(row.group))
      ),
      label: row.local
        ? say.line(
            notAName('P2P identity ' + n),
            () =>
              labelWith`${say(p2pName(display, true))} · P2P as ${say(accountLabel(row.username))}`
          )
        : say.line(notAName('Account ' + n), () => say(accountLabel(row.username))),
    }
  })
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
