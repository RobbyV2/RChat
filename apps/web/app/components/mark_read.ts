import { CheckCheck } from 'lucide-react'
import { allMarkTargets, useStore, type ContextMenuItem } from '../lib/store'

// "Mark as read" for a context menu, dimmed when `targets` (what it would mark now) is empty.
export const markReadItem = (targets: readonly string[], mark: () => void): ContextMenuItem => ({
  label: 'Mark as read',
  icon: CheckCheck,
  disabled: !targets.length,
  action: mark,
})

export const markAllReadItem = (): ContextMenuItem => {
  const s = useStore.getState()
  return {
    label: 'Mark all as read',
    icon: CheckCheck,
    disabled: !allMarkTargets(s).length,
    action: () => useStore.getState().askMarkAllRead(),
  }
}
