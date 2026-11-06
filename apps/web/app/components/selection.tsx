'use client'

import { useEffect, useMemo, type MouseEvent, type ReactNode } from 'react'
import { Check, Ellipsis, ListChecks, SquareCheckBig, X } from 'lucide-react'
import { useStore } from '../lib/store'
import { isSelected, selectionLabel, selectable } from '../lib/selection'
import {
  selectionActions,
  selectionMenuItems,
  type SelectionAction,
} from '../lib/selection_actions'
import { canDeleteIn } from '../lib/selection_store'
import { allKey, selectKey } from '../lib/shortcuts'
import type { Message, UserRef } from '../lib/types'
import { useMedia } from './context_menu'

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

// 0: not in selection mode for `scope`; 1: in it, row not picked; 2: picked.
const useRowState = (scope: string | null, m: Message) =>
  useStore(s =>
    scope === null || s.selection?.scope !== scope ? 0 : isSelected(s.selection, m) ? 2 : 1
  )

// The selection actions for the current selection, recomputed when it or its rows change.
export function useSelectionActions(author?: UserRef | null): SelectionAction[] {
  const selection = useStore(s => s.selection)
  const list = useStore(s => (s.selection ? s.messages[s.selection.scope] : undefined))
  const me = useStore(s => s.me)
  const servers = useStore(s => s.servers)
  return useMemo(
    () => selectionActions(useStore.getState(), author),
    [selection, list, me, servers, author]
  )
}

// Opens the selection menu instead of the message menu for a picked row; false otherwise.
export const openSelectionMenu = (scope: string | null, m: Message, x: number, y: number) => {
  const s = useStore.getState()
  if (!scope || s.selection?.scope !== scope || !isSelected(s.selection, m)) return false
  const items = selectionMenuItems(selectionActions(s, m.author))
  s.openContextMenu(x, y, items)
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
  const state = useRowState(scope, m)
  const allowed = useStore(
    s => scope !== null && s.me !== null && !s.guest && selectable(m, canDeleteIn(s, scope, m))
  )
  const wide = useMedia('(min-width: 768px)')
  if (!scope || !allowed) return children

  const pick = (e: MouseEvent, viaBox: boolean) => {
    const s = useStore.getState()
    if (e.shiftKey) s.selectRangeTo(scope, m)
    else if (wide || viaBox) s.toggleSelect(scope, m)
    else s.tapSelect(scope, m)
  }

  const onClickCapture = (e: MouseEvent<HTMLDivElement>) => {
    const t = e.target
    if (!(t instanceof Element) || t.closest(INTERACTIVE) || textPicked(e.currentTarget)) return
    const s = useStore.getState()
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
    if (state || (!onText(e.target) && useStore.getState().selectAnchor?.scope === scope))
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
        <button
          type="button"
          role="checkbox"
          aria-checked={state === 2}
          title={state === 2 ? 'Unselect message' : 'Select message'}
          aria-label={state === 2 ? 'Unselect message' : 'Select message'}
          onClick={e => {
            e.stopPropagation()
            pick(e, true)
          }}
          className="flex shrink-0 items-start pt-2.5 pl-3 outline-none"
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
        </button>
      )}
      <div className={state ? 'min-w-0 flex-1' : undefined}>{children}</div>
    </div>
  )
}

// Header toggle for selection mode in a scope. Hidden on narrow screens until on: long-press
// "Select message" enters the mode there, and the header needs the room.
export function SelectButton({
  scope,
  className = '',
}: {
  scope: string | null
  className?: string
}) {
  const on = useStore(s => scope !== null && s.selection?.scope === scope)
  const signedIn = useStore(s => s.me !== null && !s.guest)
  if (!scope || !signedIn) return null
  const label = on ? 'Stop selecting' : 'Select messages'
  return (
    <button
      title={label}
      aria-label={label}
      aria-pressed={on}
      onClick={() => {
        const s = useStore.getState()
        if (on) s.exitSelection()
        else s.startSelection(scope)
      }}
      className={`rounded-full p-1.5 ${on ? 'bg-secondary-container text-on-secondary-container' : `hidden hover:bg-surface-container-high md:inline-flex ${className}`}`}
    >
      <SquareCheckBig size={20} />
    </button>
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
  const key = scopes.join(',')
  useEffect(() => {
    const s = useStore.getState()
    if (s.selection && !key.split(',').includes(s.selection.scope)) s.exitSelection()
  }, [key])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = useStore.getState()
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
  }, [scope, thread])
}

const barBtn =
  'flex shrink-0 items-center gap-1.5 rounded-full py-1.5 text-sm font-medium hover:bg-surface-container-highest disabled:opacity-50'

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
    useStore.getState().openContextMenu(r.left, r.bottom, selectionMenuItems(more))
  }
  const exit = (
    <button
      title="Stop selecting"
      aria-label="Stop selecting"
      onClick={() => useStore.getState().exitSelection()}
      className="shrink-0 rounded-full p-1.5 hover:bg-surface-container-highest"
    >
      <X size={18} />
    </button>
  )
  const status = (
    <span className="min-w-0 flex-1 truncate text-sm font-medium" aria-live="polite">
      {busy ?? label}
    </span>
  )
  const buttons = primary.map(a => (
    <button
      key={a.id}
      title={a.label}
      aria-label={a.label}
      disabled={busy !== null}
      onClick={a.run}
      className={`${barBtn} ${compact ? 'px-2' : 'px-3'} ${a.danger ? 'text-error' : ''}`}
    >
      <a.icon size={16} />
      <span className={sheet || compact ? 'sr-only' : 'hidden lg:inline'}>{a.label}</span>
    </button>
  ))
  const moreBtn = more.length > 0 && (
    <button
      title="More actions"
      aria-label="More actions"
      disabled={busy !== null}
      onClick={openMore}
      className={`${barBtn} ${compact ? 'px-2' : 'px-3'}`}
    >
      <Ellipsis size={16} />
    </button>
  )
  if (sheet)
    return (
      <div
        role="toolbar"
        aria-label="Selected messages"
        className="shrink-0 rounded-t-2xl border-t border-outline-variant bg-surface-container-high px-3 pt-2 pb-[max(0.75rem,env(safe-area-inset-bottom))] shadow-elevation-2"
      >
        <div className="flex items-center gap-2">
          {exit}
          {status}
          <button
            aria-pressed={selection.ranging}
            title="Select range: tap the first and the last message"
            onClick={() => useStore.getState().toggleSelectRange()}
            className={`${barBtn} px-3 ${selection.ranging ? 'bg-secondary-container text-on-secondary-container' : ''}`}
          >
            <ListChecks size={16} />
            Select range
          </button>
        </div>
        {selection.ranging && (
          <p className="px-2 pt-1 text-xs text-on-surface-variant">
            {selection.anchor === null ? 'Tap the first message' : 'Tap the last message'}
          </p>
        )}
        <div className="mt-1 flex items-center justify-around gap-1">
          {buttons}
          {moreBtn}
        </div>
      </div>
    )
  return (
    <div
      role="toolbar"
      aria-label="Selected messages"
      className={`z-10 flex shrink-0 items-center border-b border-outline-variant bg-surface-container-high py-1.5 ${compact ? 'gap-0.5 px-1.5' : 'gap-1 px-3'}`}
    >
      {exit}
      {status}
      {buttons}
      {moreBtn}
    </div>
  )
}

// Progress of the viewer's background delete in `scope`, with Cancel.
export function BulkJobBar({ scope }: { scope: string | null }) {
  const job = useStore(s => (scope ? s.bulkJobs[scope] : undefined))
  if (!scope || !job || job.status !== 'running') return null
  const done = job.deleted.toLocaleString('en-US')
  const of = job.estimate.toLocaleString('en-US')
  return (
    <div
      role="status"
      className="z-10 flex shrink-0 items-center gap-3 border-b border-outline-variant bg-secondary-container px-4 py-1.5 text-sm text-on-secondary-container"
    >
      <span className="min-w-0 flex-1 truncate">
        Deleting messages: {done} of about {of}
      </span>
      <button
        onClick={() => void useStore.getState().cancelBulkJob(scope)}
        className="shrink-0 rounded-full px-3 py-1 font-medium hover:bg-on-secondary-container/10"
      >
        Cancel
      </button>
    </div>
  )
}
