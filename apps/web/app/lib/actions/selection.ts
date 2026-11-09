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
} from 'lucide-react'
import { canForward } from '../forward'
import { canPin, isPinned } from '../pins'
import { isEmpty, ruleAuthor, type Selection } from '../selection'
import { PRIMARY } from '../selection_actions'
import { PIN_MAX, canDeleteIn, canPinIn, moderates, pickedMessages } from '../selection_store'
import type { RChatState } from '../store_types'
import type { Message } from '../types'
import type { Action, ActionCtx } from './types'

interface Picked {
  sel: Selection
  scope: string
  picked: Message[]
  empty: boolean
}

const seen = new WeakMap<RChatState, Picked | null>()

// The selection the target is on, or in the palette the current one; null when signed out.
const selected = ({ s, target }: ActionCtx): Picked | null => {
  const sel = s.selection
  if (!sel || !s.me || (target.kind === 'selection' && target.list !== sel.scope)) return null
  let hit = seen.get(s)
  if (hit === undefined) {
    const scope = sel.scope
    hit = { sel, scope, picked: pickedMessages(s), empty: isEmpty(sel, s.messages[scope] ?? []) }
    seen.set(s, hit)
  }
  return hit
}

// The bar's More menu leaves out what the bar shows.
const offBar = (id: string, { target }: ActionCtx) =>
  !(target.kind === 'selection' && target.more && (PRIMARY.has(id) || id === 'exit'))

const pinnable = (ctx: ActionCtx, p: Picked) => {
  const list = p.picked.filter(canPin)
  return !p.sel.all && list.length > 0 && list.length <= PIN_MAX && canPinIn(ctx.s, p.scope)
    ? list
    : null
}

const author = ({ target }: ActionCtx) =>
  target.kind === 'selection' ? (target.author ?? null) : null

const on = (
  id: string,
  title: string,
  icon: Action['icon'],
  when: (p: Picked, ctx: ActionCtx) => boolean,
  run: (ctx: ActionCtx) => void,
  danger?: boolean
): Action => ({
  id: `selection_${id}`,
  title,
  icon,
  danger,
  scope: 'message',
  targets: ['selection'],
  group: 'selection',
  keywords: ['selected', 'messages'],
  available: ctx => {
    const p = selected(ctx)
    return p !== null && offBar(id, ctx) && when(p, ctx)
  },
  run,
})

// The selection bar's actions, in its order (`selection_<id>`).
export const selectionActions: Action[] = [
  on(
    'select_all',
    'Select all',
    CheckCheck,
    p => !p.sel.all,
    ({ s }) => s.selectAllMessages()
  ),
  on(
    'clear',
    'Clear',
    SquareDashed,
    p => !p.empty,
    ({ s }) => s.clearSelection()
  ),
  on(
    'delete',
    'Delete',
    Trash2,
    (p, { s }) =>
      !s.guest &&
      (p.sel.all || ruleAuthor(p.sel) !== null || p.picked.some(m => canDeleteIn(s, p.scope, m))),
    ({ s }) => s.askDeleteSelection(),
    true
  ),
  on(
    'copy_text',
    'Copy text',
    Copy,
    p => p.picked.length > 0,
    ({ s }) => s.copySelectionText()
  ),
  on(
    'copy_links',
    'Copy links',
    Link,
    p => p.picked.length > 0,
    ({ s }) => s.copySelectionLinks()
  ),
  on(
    'pin',
    'Pin',
    Pin,
    (p, ctx) => !!pinnable(ctx, p)?.some(m => !isPinned(m)),
    ({ s }) => void s.pinSelection(true)
  ),
  on(
    'unpin',
    'Unpin',
    PinOff,
    (p, ctx) => !!pinnable(ctx, p)?.every(isPinned),
    ({ s }) => void s.pinSelection(false)
  ),
  on(
    'forward',
    'Forward',
    Forward,
    (p, { s }) => !p.sel.all && !s.guest && p.picked.length === 1 && canForward(p.picked[0]),
    ({ s }) => s.forwardSelection()
  ),
  on(
    'export_text',
    'Export as text',
    Download,
    p => !p.empty,
    ({ s }) => void s.exportSelection('text')
  ),
  on(
    'export_json',
    'Export as JSON',
    FileJson,
    p => !p.empty,
    ({ s }) => void s.exportSelection('json')
  ),
  on(
    'select_author',
    'Select all from this author',
    User,
    (p, ctx) => author(ctx) !== null && moderates(ctx.s, p.scope) && !p.sel.all,
    ctx => {
      const who = author(ctx)
      if (who) ctx.s.selectAuthorMessages(who.username)
    }
  ),
  on(
    'select_mine',
    'Select mine',
    UserCheck,
    p => !p.sel.all,
    ({ s }) => {
      if (s.me) s.selectAuthorMessages(s.me.username)
    }
  ),
  on(
    'exit',
    'Exit selection',
    X,
    () => true,
    ({ s }) => s.exitSelection()
  ),
]
