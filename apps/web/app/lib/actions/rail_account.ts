import { client } from '../client/client'
import { canAddInstance } from '../client/adding'
import { ownInstance } from '../instances'
import { setConnected } from '../client/book'
import { switchActor, switcherSession } from '../client/switch_actor'
import { liveSwitcherRows, signOutSwitcherAccount } from '../client/switcher_rows'
import type { Action, ActionCtx } from './types'

function rowFor({ target }: ActionCtx) {
  if (
    target.kind !== 'rail_account' ||
    (!canAddInstance() && target.origin !== ownInstance()?.origin)
  )
    return
  return liveSwitcherRows()
    .groups.find(g => g.origin === target.origin)
    ?.rows.find(
      r => r.local === null && r.username === target.username && r.status !== 'Signed out'
    )
}
function readOwner(ctx: ActionCtx) {
  const { target, acct } = ctx
  if (target.kind !== 'rail_account' || !target.username || switcherSession(target) !== acct) return
  const state = acct.store.getState()
  if (state.me?.username === target.username && state.token && state.readsReady) return state
}

const base = {
  scope: 'app',
  targets: ['rail_account'],
  available: (ctx: ActionCtx) => !!rowFor(ctx),
} as const
export const railAccountActions: Action[] = [
  {
    ...base,
    id: 'rail_show_account',
    title: 'Show this account',
    run: ctx => {
      const row = rowFor(ctx)
      if (row) void switchActor(row, client.shown())
    },
  },
  {
    ...base,
    id: 'rail_mark_account_read',
    title: 'Mark all read',
    disabled: ctx => !readOwner(ctx),
    subtitle: ctx =>
      ctx.target.kind === 'rail_account' && ctx.target.username && !readOwner(ctx)
        ? 'Show this account to load its unread messages'
        : undefined,
    run: ctx => readOwner(ctx)?.markAllRead(),
  },
  {
    ...base,
    id: 'rail_keep_connected',
    title: 'Keep connected',
    available: ctx => !!rowFor(ctx)?.username,
    checked: ctx => !!rowFor(ctx)?.background,
    run: ctx => {
      const row = rowFor(ctx)
      if (row?.username)
        void client.updateBook(book =>
          setConnected(book, row.origin, row.username!, !row.background)
        )
    },
  },
  {
    ...base,
    id: 'rail_sign_out',
    title: 'Sign out',
    danger: true,
    run: ctx => {
      const row = rowFor(ctx)
      if (row)
        ctx.acct.store.getState().askConfirm({
          title: 'Sign out of this account?',
          body: 'Other accounts on this device stay signed in.',
          confirm: 'Sign out',
          action: () => signOutSwitcherAccount(row.origin, row.username),
        })
    },
  },
]
