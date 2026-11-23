// What can be done with this account's P2P limits (Settings > Peer-to-peer > Advanced), from the
// command palette and the menu of the rail's P2P tile.

import { HardDrive, RotateCcw } from 'lucide-react'

import { LIMITS_LATER, readUserLimits, writeUserLimits } from '../p2p/user_limits'
import { signedIn } from './global'
import type { Action, ActionCtx } from './types'
export const LIMITS_RESET_TEXT = `P2P limits reset. ${LIMITS_LATER}`
import { identityActions } from './identity'
export const peerLimits = identityActions(identity => {
  const { useP2p } = identity

  const p2pAccount = ({ s }: ActionCtx) => {
    const { account, enabled } = useP2p.getState()
    return account && enabled && signedIn(s) ? account : null
  }

  const keywords = ['p2p', 'peer-to-peer', 'storage', 'limits', 'background', 'advanced']

  const p2pLimitActions: Action[] = [
    {
      id: 'p2p_limits',
      title: 'P2P storage settings',
      scope: 'p2p',
      targets: ['p2p_home'],
      group: 'settings',
      icon: HardDrive,
      keywords,
      available: ctx => p2pAccount(ctx) !== null,
      run: ({ acct }) =>
        acct.store.getState().openDialog({ kind: 'settings', section: 'p2p', focus: 'p2p_limits' }),
    },
    {
      id: 'p2p_limits_reset',
      title: 'Reset P2P limits',
      scope: 'p2p',
      targets: ['p2p_home'],
      group: 'settings',
      icon: RotateCcw,
      keywords,
      available: ctx => {
        const account = p2pAccount(ctx)
        return (
          account !== null &&
          Object.keys(readUserLimits(account, ctx.acct.conn, identity.localId)).length > 1
        )
      },
      run: ctx => {
        const account = p2pAccount(ctx)
        if (!account) return
        writeUserLimits(account, { v: 1 }, ctx.acct.conn, identity.localId)
        ctx.acct.store.getState().showToast(LIMITS_RESET_TEXT)
      },
    },
  ]

  return { actions: p2pLimitActions }
})
export const { actions: p2pLimitActions } = peerLimits.defaults
