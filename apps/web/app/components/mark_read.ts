import { CheckCheck } from 'lucide-react'
import { allMarkTargets, useStore, type ContextMenuItem } from '../lib/store'
import { p2pMarkAll } from '../lib/p2p/app'

// "Mark as read" for a context menu, dimmed when `targets` (what it would mark now) is empty.
export const markReadItem = (targets: readonly string[], mark: () => void): ContextMenuItem => ({
  label: 'Mark as read',
  icon: CheckCheck,
  disabled: !targets.length,
  action: mark,
})

// "Mark all as read" for a context menu: instance conversations and P2P ones, like Home's.
export const markAllReadItem = (): ContextMenuItem => {
  const s = useStore.getState()
  return {
    label: 'Mark all as read',
    icon: CheckCheck,
    disabled: !allMarkTargets(s).length && !p2pMarkAll().pending,
    action: () => useStore.getState().askMarkAllRead(p2pMarkAll()),
  }
}
