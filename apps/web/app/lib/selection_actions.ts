// What can be done with the current message selection. The selection bar, the right-click
// selection menu and the command palette all read this one list, so they offer the same actions
// in the same order. `selectionActions(useStore.getState())` is empty while nothing is selected.

import {
  CheckCheck,
  Copy,
  Download,
  FileJson,
  Forward,
  Link,
  Pin,
  PinOff,
  SquareDashed,
  Trash2,
  User,
  UserCheck,
  X,
  type LucideIcon,
} from 'lucide-react'
import { canForward } from './forward'
import { canPin, isPinned } from './pins'
import { isEmpty, ruleAuthor } from './selection'
import { PIN_MAX, canDeleteIn, canPinIn, moderates, pickedMessages } from './selection_store'
import type { ContextMenuItem, RChatState } from './store_types'
import type { UserRef } from './types'

export interface SelectionAction {
  id: string
  label: string
  icon: LucideIcon
  danger?: boolean
  // Shown on the selection bar itself; the others live in its "More" menu.
  primary?: boolean
  run: () => void
}

export const selectionActions = (s: RChatState, author?: UserRef | null): SelectionAction[] => {
  const sel = s.selection
  if (!sel || !s.me) return []
  const scope = sel.scope
  const picked = pickedMessages(s)
  const empty = isEmpty(sel, s.messages[scope] ?? [])
  const out: SelectionAction[] = []
  const add = (a: SelectionAction) => out.push(a)
  if (!sel.all)
    add({
      id: 'select_all',
      label: 'Select all',
      icon: CheckCheck,
      primary: true,
      run: s.selectAllMessages,
    })
  if (!empty)
    add({ id: 'clear', label: 'Clear', icon: SquareDashed, primary: true, run: s.clearSelection })
  if (
    !s.guest &&
    (sel.all || ruleAuthor(sel) !== null || picked.some(m => canDeleteIn(s, scope, m)))
  )
    add({
      id: 'delete',
      label: 'Delete',
      icon: Trash2,
      danger: true,
      primary: true,
      run: s.askDeleteSelection,
    })
  if (picked.length) {
    add({
      id: 'copy_text',
      label: 'Copy text',
      icon: Copy,
      primary: true,
      run: s.copySelectionText,
    })
    add({ id: 'copy_links', label: 'Copy links', icon: Link, run: s.copySelectionLinks })
  }
  const pinnable = picked.filter(canPin)
  if (!sel.all && pinnable.length && pinnable.length <= PIN_MAX && canPinIn(s, scope)) {
    const pin = pinnable.some(m => !isPinned(m))
    add({
      id: pin ? 'pin' : 'unpin',
      label: pin ? 'Pin' : 'Unpin',
      icon: pin ? Pin : PinOff,
      run: () => void s.pinSelection(pin),
    })
  }
  if (!sel.all && !s.guest && picked.length === 1 && canForward(picked[0]))
    add({ id: 'forward', label: 'Forward', icon: Forward, run: s.forwardSelection })
  if (!empty) {
    add({
      id: 'export_text',
      label: 'Export as text',
      icon: Download,
      run: () => void s.exportSelection('text'),
    })
    add({
      id: 'export_json',
      label: 'Export as JSON',
      icon: FileJson,
      run: () => void s.exportSelection('json'),
    })
  }
  if (author && moderates(s, scope) && !sel.all)
    add({
      id: 'select_author',
      label: 'Select all from this author',
      icon: User,
      run: () => s.selectAuthorMessages(author.username),
    })
  if (!sel.all) {
    const me = s.me.username
    add({
      id: 'select_mine',
      label: 'Select mine',
      icon: UserCheck,
      run: () => s.selectAuthorMessages(me),
    })
  }
  add({ id: 'exit', label: 'Exit selection', icon: X, run: s.exitSelection })
  return out
}

export const selectionMenuItems = (actions: SelectionAction[]): ContextMenuItem[] =>
  actions.map(a => ({ label: a.label, icon: a.icon, danger: a.danger, action: a.run }))
