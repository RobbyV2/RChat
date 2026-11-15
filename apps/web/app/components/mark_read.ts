import { registerAppActions } from '../lib/actions'
import { ctxFor } from '../lib/actions/ctx'
import { itemFor } from '../lib/actions/menu'
import { useStore, type ContextMenuItem } from '../lib/store'

// The home menus' "Mark all as read" row (`mark_all_read`), for a signed-in account.
export const markAllReadItem = (): ContextMenuItem => {
  registerAppActions()
  return itemFor('mark_all_read', ctxFor(useStore.getState(), { kind: 'home' }, 'menu'))!
}
