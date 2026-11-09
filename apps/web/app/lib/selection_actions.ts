// What can be done with the current message selection. The selection bar, the right-click
// selection menu and the command palette all read the registry's `selection_*` actions, so they
// offer the same actions in the same order. `selectionActions(useStore.getState())` is empty while
// nothing is selected.

import type { LucideIcon } from 'lucide-react'
import { ctxFor } from './actions/ctx'
import { labelOf, targetActions } from './actions/registry'
import { confirmThenRun, dangerOf, iconOf } from './actions/steps'
import type { RChatState } from './store_types'
import type { UserRef } from './types'

export interface SelectionAction {
  id: string
  label: string
  icon?: LucideIcon
  danger?: boolean
  // Shown on the selection bar itself; the others live in its "More" menu.
  primary?: boolean
  run: () => void
}

export const PRIMARY: ReadonlySet<string> = new Set(['select_all', 'clear', 'delete', 'copy_text'])

const PREFIX = 'selection_'

export const selectionActions = (s: RChatState, author?: UserRef | null): SelectionAction[] => {
  if (!s.selection) return []
  const ctx = ctxFor(s, { kind: 'selection', list: s.selection.scope, author }, 'bar')
  return targetActions(ctx).map(a => {
    const id = a.id.startsWith(PREFIX) ? a.id.slice(PREFIX.length) : a.id
    return {
      id,
      label: labelOf(a, ctx),
      icon: iconOf(a, ctx),
      danger: dangerOf(a, ctx),
      primary: PRIMARY.has(id) || undefined,
      run: () => void confirmThenRun(a, ctx, {}),
    }
  })
}
