import { CheckCheck } from 'lucide-react'
import { registerAppActions } from '../lib/actions'
import { ctxFor } from '../lib/actions/ctx'
import { itemFor } from '../lib/actions/menu'
import { useStore, type ContextMenuItem } from '../lib/store'

// "Mark as read" for a context menu, dimmed when `targets` (what it would mark now) is empty.
export const markReadItem = (targets: readonly string[], mark: () => void): ContextMenuItem => ({
  label: 'Mark as read',
  icon: CheckCheck,
  disabled: !targets.length,
  action: mark,
})

// The home menus' "Mark all as read" row (`mark_all_read`), for a signed-in account.
export const markAllReadItem = (): ContextMenuItem => {
  registerAppActions()
  return itemFor('mark_all_read', ctxFor(useStore.getState(), { kind: 'home' }, 'menu'))!
}
