'use client'
import { IconButton } from './controls'
import { useAccount } from '../lib/client/react'
import type { AccountSession } from '../lib/client/session'

import {
  createContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
  type MouseEvent,
  type ReactNode,
} from 'react'
import { Check, Ellipsis, ListChecks, SquareCheckBig, X } from 'lucide-react'
import { openActionMenu } from '../lib/actions/menu'
import { actionsVersion, subscribeActions } from '../lib/actions/registry'
import { useStore } from '../lib/store'
import { isSelected, selectionLabel, selectable } from '../lib/selection'
import { selectionActions, type SelectionAction } from '../lib/selection_actions'
import { canDeleteIn } from '../lib/selection_store'
import { allKey, selectKey } from '../lib/shortcuts'
import type { Message, UserRef } from '../lib/types'
import { useMedia } from './context_menu'
import { Row, Surface, Inset } from './layout'

// Clicks on these never pick a row.
const INTERACTIVE =
  'a, button, input, textarea, select, summary, label, video, audio, [role="button"], [role="link"], [contenteditable="true"], [data-no-select]'

// Message text: outside selection mode a click or Shift+click there stays a text selection.
const TEXT = 'p, li, pre, code, blockquote, h1, h2, h3, h4, h5, h6, td, th'

const onText = (t: EventTarget | null) => t instanceof Element && t.closest(TEXT) !== null

const textPicked = (row: Element) => {
  const sel = typeof window === 'undefined' ? null : window.getSelection()
  if (!sel || sel.isCollapsed || !sel.toString().trim()) return false
  return sel.anchorNode !== null && row.contains(sel.anchorNode)
}

const editable = (t: EventTarget | null) =>
  t instanceof HTMLElement &&
  (t.isContentEditable ||
    t.tagName === 'INPUT' ||
    t.tagName === 'TEXTAREA' ||
    t.tagName === 'SELECT')

// True inside a row in selection mode: right-click and long-press there open the row's menu.
export const RowSelecting = createContext(false)

// 0: not in selection mode for `scope`; 1: in it, row not picked; 2: picked.
const useRowState = (scope: string | null, m: Message) =>
  useStore(s =>
    scope === null || s.selection?.scope !== scope ? 0 : isSelected(s.selection, m) ? 2 : 1
  )

// The selection actions for the current selection, recomputed when it or its rows change.
export function useSelectionActions(author?: UserRef | null): SelectionAction[] {
  const acct = useAccount()

  const selection = useStore(s => s.selection)
  const list = useStore(s => (s.selection ? s.messages[s.selection.scope] : undefined))
  const me = useStore(s => s.me)
  const servers = useStore(s => s.servers)
  const actions = useSyncExternalStore(subscribeActions, actionsVersion, actionsVersion)
  return useMemo(
    () => selectionActions(acct.store.getState(), author, acct),
    [acct, selection, list, me, servers, author, actions]
  )
}

// Opens the selection menu instead of the message menu for a picked row; false otherwise.
export const openSelectionMenu = (
  scope: string | null,
  m: Message,
  x: number,
  y: number,
  acct: AccountSession
) => {
  const s = acct.store.getState()
  if (!scope || s.selection?.scope !== scope || !isSelected(s.selection, m)) return false
  openActionMenu(x, y, { kind: 'selection', list: scope, author: m.author }, undefined, acct)
  return true
}

// A message row that can be picked: file-manager clicks outside the mode (a click sets the
// anchor, Shift+click selects the range, Ctrl/Cmd+click toggles), and a checkbox inside it.
export function Selectable({
  m,
  scope,
  children,
}: {
  m: Message
  scope: string | null
  children: ReactNode
}) {
  const acct = useAccount()
  const state = useRowState(scope, m)
  const allowed = useStore(
    s => scope !== null && s.me !== null && !s.guest && selectable(m, canDeleteIn(s, scope, m))
  )
  const wide = useMedia('(min-width: 768px)')
  if (!scope || !allowed) return children

  const pick = (e: MouseEvent, viaBox: boolean) => {
    const s = acct.store.getState()
    if (e.shiftKey) s.selectRangeTo(scope, m)
    else if (wide || viaBox) s.toggleSelect(scope, m)
    else s.tapSelect(scope, m)
  }

  const onClickCapture = (e: MouseEvent<HTMLDivElement>) => {
    const t = e.target
    if (!(t instanceof Element) || t.closest(INTERACTIVE) || textPicked(e.currentTarget)) return
    const s = acct.store.getState()
    if (state) {
      e.preventDefault()
      e.stopPropagation()
      pick(e, false)
      return
    }
    if (e.shiftKey && !onText(t) && s.selectAnchor?.scope === scope && s.selectAnchor.id !== m.id) {
      e.preventDefault()
      window.getSelection()?.removeAllRanges()
      s.startSelection(scope)
      s.selectRangeTo(scope, m)
    } else if (e.ctrlKey || e.metaKey) {
      e.preventDefault()
      s.toggleSelect(scope, m)
    } else if (!e.shiftKey && !onText(t)) s.setSelectAnchor(scope, m.id)
  }

  const onMouseDown = (e: MouseEvent) => {
    if (!e.shiftKey) return
    if (state || (!onText(e.target) && acct.store.getState().selectAnchor?.scope === scope))
      e.preventDefault()
  }

  return (
    <div
      data-selectable=""
      data-selected={state === 2 ? '' : undefined}
      onClickCapture={onClickCapture}
      onMouseDown={onMouseDown}
      className={
        state
          ? `relative flex items-stretch ${state === 2 ? 'bg-primary/10' : ''} cursor-pointer select-none`
          : undefined
      }
    >
      {state > 0 && (
        <Inset
          type="button"
          role="checkbox"
          aria-checked={state === 2}
          title={state === 2 ? 'Unselect message' : 'Select message'}
          aria-label={state === 2 ? 'Unselect message' : 'Select message'}
          onClick={e => {
            e.stopPropagation()
            pick(e, true)
          }}
          as="button"
          row
          pad="md"
          align="start"
          look="outline-none"
          place="shrink-0"
        >
          <span
            className={`flex h-5 w-5 items-center justify-center rounded-md border-2 ${
              state === 2
                ? 'border-primary bg-primary text-on-primary'
                : 'border-outline bg-surface hover:border-primary'
            } focus-visible:outline-2`}
          >
            {state === 2 && <Check size={14} strokeWidth={3} />}
          </span>
        </Inset>
      )}
      <div className={state ? 'min-w-0 flex-1' : undefined}>
        <RowSelecting.Provider value={state > 0}>{children}</RowSelecting.Provider>
      </div>
    </div>
  )
}

// Header toggle for selection mode in a scope. Hidden on narrow screens until on: long-press
// "Select message" enters the mode there, and the header needs the room.
export function SelectButton({
  scope,
  narrowHidden = false,
}: {
  scope: string | null
  narrowHidden?: boolean
}) {
  const acct = useAccount()
  const on = useStore(s => scope !== null && s.selection?.scope === scope)
  const signedIn = useStore(s => s.me !== null && !s.guest)
  if (!scope || !signedIn) return null
  const label = on ? 'Stop selecting' : 'Select messages'
  return (
    <IconButton
      icon={SquareCheckBig}
      label={label}
      size="lg"
      tone="inherit"
      pressed={on}
      onClick={() => {
        const s = acct.store.getState()
        if (on) s.exitSelection()
        else s.startSelection(scope)
      }}
      place={
        on
          ? undefined
          : narrowHidden
            ? 'hidden md:inline-flex @max-sm:hidden'
            : 'hidden md:inline-flex'
      }
    />
  )
}

// Ctrl/Cmd+Shift+S toggles selection mode in `scope`, or in `thread` when focus is in the thread
// panel; Ctrl/Cmd+A selects everything while selecting. A selection outside `scopes` (the view
// and the open thread) ends.
export function useSelectionKeys(
  scope: string | null,
  scopes: (string | null)[],
  thread: string | null = null
) {
  const acct = useAccount()
  const key = scopes.join(',')
  useEffect(() => {
    const s = acct.store.getState()
    if (s.selection && !key.split(',').includes(s.selection.scope)) s.exitSelection()
  }, [acct, key])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = acct.store.getState()
      if (!s.me || s.guest || e.isComposing) return
      if (selectKey(e)) {
        e.preventDefault()
        const inThread =
          thread !== null && document.activeElement?.closest('[data-thread-panel]') != null
        const target = inThread ? thread : scope
        if (s.selection) s.exitSelection()
        else if (target) s.startSelection(target)
        return
      }
      if (allKey(e) && s.selection && !editable(e.target)) {
        e.preventDefault()
        s.selectAllMessages()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [acct, scope, thread])
}

const barLook = 'font-medium hover:bg-surface-container-highest disabled:opacity-50'

// The bar shown while selecting in `scope`: sticky above the list on wide screens, a bottom
// sheet (in place of the composer) on narrow ones.
export function SelectionBar({
  scope,
  sheet,
  compact = false,
}: {
  scope: string | null
  sheet: boolean
  // Icons only (the thread panel).
  compact?: boolean
}) {
  const acct = useAccount()

  const selection = useStore(s => (scope && s.selection?.scope === scope ? s.selection : null))
  const list = useStore(s => (scope ? s.messages[scope] : undefined))
  const busy = useStore(s => s.selectionBusy)
  const anchorAuthor = useStore(s => {
    const sel = s.selection
    if (!sel || sel.anchor === null) return null
    return (s.messages[sel.scope] ?? []).find(m => m.id === sel.anchor)?.author ?? null
  })
  const actions = useSelectionActions(anchorAuthor)
  const me = useStore(s => s.me?.username)
  if (!selection || !scope) return null
  const label = selectionLabel(selection, list ?? [], me)
  const primary = actions.filter(a => a.primary)
  const more = actions.filter(a => !a.primary && a.id !== 'exit')
  const openMore = (e: MouseEvent) => {
    const r = e.currentTarget.getBoundingClientRect()
    openActionMenu(
      r.left,
      r.bottom,
      {
        kind: 'selection',
        list: scope,
        author: anchorAuthor,
        more: true,
      },
      undefined,
      acct
    )
  }
  const exit = (
    <IconButton
      icon={X}
      label="Stop selecting"
      tone="inherit"
      onClick={() => acct.store.getState().exitSelection()}
    />
  )
  const status = (
    <span className="min-w-0 flex-1 truncate text-sm font-medium" aria-live="polite">
      {busy ?? label}
    </span>
  )
  const buttons = primary.map(a => (
    <Surface
      key={a.id}
      title={a.label}
      aria-label={a.label}
      disabled={busy !== null}
      onClick={a.run}
      as="button"
      row
      pad={compact ? 'sm' : 'md'}
      inset="chip"
      gap="xs"
      tone="plain"
      radius="full"
      text="sm"
      look={`${barLook} ${a.danger ? 'text-error' : ''}`}
      place="shrink-0"
    >
      {a.icon && <a.icon size={16} />}
      <span className={sheet || compact ? 'sr-only' : 'hidden lg:inline'}>{a.label}</span>
    </Surface>
  ))
  const moreBtn = more.length > 0 && (
    <Surface
      title="More actions"
      aria-label="More actions"
      disabled={busy !== null}
      onClick={openMore}
      as="button"
      row
      pad={compact ? 'sm' : 'md'}
      inset="chip"
      gap="xs"
      tone="plain"
      radius="full"
      text="sm"
      look={barLook}
      place="shrink-0"
    >
      <Ellipsis size={16} />
    </Surface>
  )
  if (sheet)
    return (
      <Surface
        role="toolbar"
        aria-label="Selected messages"
        pad="md"
        gap="2xs"
        tone="high"
        radius="none"
        border="top"
        safe
        elevation={2}
        look="rounded-t-2xl"
        place="shrink-0"
      >
        <Row gap="sm">
          {exit}
          {status}
          <Surface
            aria-pressed={selection.ranging}
            title="Select range: tap the first and the last message"
            onClick={() => acct.store.getState().toggleSelectRange()}
            as="button"
            row
            pad="md"
            inset="chip"
            gap="xs"
            tone="plain"
            radius="full"
            text="sm"
            look={`${barLook} ${selection.ranging ? 'bg-secondary-container text-on-secondary-container' : ''}`}
            place="shrink-0"
          >
            <ListChecks size={16} />
            Select range
          </Surface>
        </Row>
        {selection.ranging && (
          <p className="text-xs text-on-surface-variant">
            {selection.anchor === null ? 'Tap the first message' : 'Tap the last message'}
          </p>
        )}
        <Row gap="2xs" justify="around">
          {buttons}
          {moreBtn}
        </Row>
      </Surface>
    )
  return (
    <Surface
      role="toolbar"
      aria-label="Selected messages"
      row
      pad={compact ? 'xs' : 'md'}
      inset="chip"
      gap={compact ? '3xs' : '2xs'}
      tone="high"
      radius="none"
      border="bottom"
      place="z-raised shrink-0"
    >
      {exit}
      {status}
      {buttons}
      {moreBtn}
    </Surface>
  )
}

// Progress of the viewer's background delete in `scope`, with Cancel.
export function BulkJobBar({ scope }: { scope: string | null }) {
  const acct = useAccount()
  const job = useStore(s => (scope ? s.bulkJobs[scope] : undefined))
  if (!scope || !job || job.status !== 'running') return null
  const done = job.deleted.toLocaleString('en-US')
  const of = job.estimate.toLocaleString('en-US')
  return (
    <Surface
      role="status"
      row
      pad="lg"
      inset="chip"
      gap="md"
      tone="secondary"
      radius="none"
      border="bottom"
      text="sm"
      place="z-raised shrink-0"
    >
      <span className="min-w-0 flex-1 truncate">
        Deleting messages: {done} of about {of}
      </span>
      <Inset
        onClick={() => void acct.store.getState().cancelBulkJob(scope)}
        as="button"
        pad="md"
        inset="chip"
        look="rounded-full font-medium hover:bg-on-secondary-container/10"
        place="shrink-0"
      >
        Cancel
      </Inset>
    </Surface>
  )
}
