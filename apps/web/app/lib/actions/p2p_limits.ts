// What can be done with this account's P2P limits (Settings > Peer-to-peer > Advanced). The
// command palette and the P2P tile's menu read this one list.

import { HardDrive, RotateCcw } from 'lucide-react'
import { useP2p } from '../p2p/app'
import { LIMITS_LATER, readUserLimits, writeUserLimits } from '../p2p/user_limits'
import { useStore } from '../store'
import { signedIn } from './global'
import type { Action, ActionCtx } from './types'

export const LIMITS_RESET_TEXT = `P2P limits reset. ${LIMITS_LATER}`

const p2pAccount = ({ s }: ActionCtx) => {
  const { account, enabled } = useP2p.getState()
  return account && enabled && signedIn(s) ? account : null
}

const keywords = ['p2p', 'peer-to-peer', 'storage', 'limits', 'background', 'advanced']

export const p2pLimitActions: Action[] = [
  {
    id: 'p2p_limits',
    title: 'P2P storage settings',
    scope: 'p2p',
    group: 'settings',
    icon: HardDrive,
    keywords,
    available: ctx => p2pAccount(ctx) !== null,
    run: () =>
      useStore
        .getState()
        .openDialog({ kind: 'settings', section: 'settings', focus: 'p2p_limits' }),
  },
  {
    id: 'p2p_limits_reset',
    title: 'Reset P2P limits',
    scope: 'p2p',
    group: 'settings',
    icon: RotateCcw,
    keywords,
    available: ctx => {
      const account = p2pAccount(ctx)
      return account !== null && Object.keys(readUserLimits(account)).length > 1
    },
    run: ctx => {
      const account = p2pAccount(ctx)
      if (!account) return
      writeUserLimits(account, { v: 1 })
      useStore.getState().showToast(LIMITS_RESET_TEXT)
    },
  },
]
