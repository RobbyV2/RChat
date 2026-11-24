import type { AccountSession } from './session'
import type { SwitcherRow } from './switcher_rows'
import type { P2pApp } from '../p2p/app/runtime'
import { railBlocks } from './rail_blocks'

export interface HomeActor {
  key: string
  row: SwitcherRow
  instance: string
  account: AccountSession
  peer: P2pApp | null
}

export function homeActors(
  groups: Parameters<typeof railBlocks>[0],
  onlyOrigin: string | undefined,
  sessionFor: (row: SwitcherRow) => AccountSession | undefined
) {
  return railBlocks(groups, onlyOrigin).blocks.flatMap(group =>
    group.accounts.flatMap(row => {
      const account = sessionFor(row)
      if (!account) return []
      const actor = (r: SwitcherRow, peer: P2pApp | null): HomeActor => ({
        key: JSON.stringify([r.origin, r.username, r.local]),
        row: r,
        instance: group.name,
        account,
        peer,
      })
      const peers =
        account.store.getState().settings.p2p && row.username
          ? group.peers
              .filter(p => p.username === row.username)
              .flatMap(p => {
                const app = account.identities.get(p.local!)
                return app ? [actor(p, app)] : []
              })
          : []
      return [actor(row, null), ...peers]
    })
  )
}
