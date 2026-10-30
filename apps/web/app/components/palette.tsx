'use client'

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { ArrowLeft, Command, CornerDownLeft, Search } from 'lucide-react'
import { fuzzyParts } from '../lib/fuzzy'
import { useHome } from '../lib/home_store'
import { loadApiDoc, loadApiHistory, useApiDoc } from '../lib/api_console'
import {
  isMac,
  paletteKey,
  paletteShortcut,
  parseQuery,
  prefixesFor,
  registerPalette,
  usePalette,
  type PaletteItem,
} from '../lib/palette'
import { registerCoreCommands } from '../lib/palette_commands'
import { buildSections, flatItems, noApi, type ResultCtx } from '../lib/palette_results'
import {
  closePalette,
  closePalettePoll,
  noteUsed,
  openPalette,
  setPaletteText,
  setPaletteView,
  takeEscape,
  togglePalette,
  usePaletteUi,
} from '../lib/palette_store'
import { docVisible, paletteIndex, startIndexSync, useIndexStatus } from '../lib/palette_sync'
import { shortcutLabel } from '../lib/shortcuts'
import { useMask, useStore } from '../lib/store'
import { ApiConsoleFor } from './api_console'
import { useMedia } from './context_menu'
import { CreatePollDialog } from './poll_dialog'
import { SheetGrip, iconBtn, textBtn } from './ui'

const SHEET = '(max-width: 767px)'

// Usage is not counted for one-off rows (messages, saved requests).
const counted = (id: string) => !id.startsWith('message_') && !id.startsWith('apihistory_')

export function PaletteHost() {
  const open = usePaletteUi(s => s.open)
  const poll = usePaletteUi(s => s.poll)
  const owner = useStore(s => s.me?.username ?? (s.guest ? 'guest' : null))

  useEffect(() => {
    registerCoreCommands()
    registerPalette(() => openPalette())
    const stop = startIndexSync()
    return () => {
      registerPalette(null)
      stop()
    }
  }, [])

  const lastOwner = useRef(owner)
  useEffect(() => {
    loadApiHistory(owner)
    // What the previous account had open (API form values, a response) is not shown to the next.
    if (lastOwner.current !== owner) closePalette()
    lastOwner.current = owner
  }, [owner])

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (!paletteKey(e) || e.isComposing || e.repeat) return
      if (useStore.getState().confirm) return
      e.preventDefault()
      e.stopPropagation()
      togglePalette()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  return (
    <>
      {open && <Palette />}
      {poll && <CreatePollDialog target={poll} onClose={closePalettePoll} />}
    </>
  )
}

// Opens the palette from a header (the only way on touch screens).
export function PaletteButton({
  className = 'rounded-full p-1.5 hover:bg-surface-container-high md:hidden',
}: {
  className?: string
}) {
  const open = usePalette(s => s.open)
  if (!open) return null
  const label = `Command palette (${paletteShortcut(isMac())})`
  return (
    <button
      type="button"
      title={label}
      aria-label="Command palette"
      data-palette-button
      onClick={open}
      className={className}
    >
      <Command size={20} />
    </button>
  )
}

function Title({ item, hits }: { item: PaletteItem; hits: number[] }) {
  const mask = useMask()
  const text = item.name ? mask(item.title) : item.title
  const parts = hits.length && text === item.title ? fuzzyParts(text, hits) : [{ text, hit: false }]
  return (
    <span
      className={`truncate text-sm ${item.danger ? 'text-error' : 'text-on-surface'} ${item.name ? 'streamer' : ''}`}
    >
      {parts.map((p, i) =>
        p.hit ? (
          <mark key={i} className="bg-transparent font-semibold text-primary">
            {p.text}
          </mark>
        ) : (
          <span key={i}>{p.text}</span>
        )
      )}
    </span>
  )
}

function Row({
  id,
  item,
  hits,
  active,
  onPick,
  onHover,
}: {
  id: string
  item: PaletteItem
  hits: number[]
  active: boolean
  onPick: () => void
  onHover: () => void
}) {
  const Icon = item.icon ?? Command
  const mask = useMask()
  return (
    <div
      id={id}
      role="option"
      aria-selected={active}
      data-palette-item={item.id}
      onClick={onPick}
      onMouseMove={onHover}
      className={`flex min-h-11 cursor-pointer items-center gap-3 rounded-xl px-3 py-1.5 ${
        active ? 'bg-secondary-container text-on-secondary-container' : ''
      }`}
    >
      <Icon
        size={16}
        className={`shrink-0 ${item.danger ? 'text-error' : 'text-on-surface-variant'}`}
      />
      <span className="flex min-w-0 flex-1 flex-col">
        <Title item={item} hits={hits} />
        {item.subtitle && (
          <span
            className={`truncate text-xs text-on-surface-variant ${item.subtitleName ? 'streamer' : ''}`}
          >
            {item.subtitleName ? mask(item.subtitle) : item.subtitle}
          </span>
        )}
      </span>
      {item.hint && (
        <kbd className="shrink-0 rounded-md border border-outline-variant px-1.5 py-0.5 font-mono text-[11px] text-on-surface-variant">
          {/^Mod|^Shift|^Escape/.test(item.hint) ? shortcutLabel(item.hint) : item.hint}
        </kbd>
      )}
      {item.arg && <span className="shrink-0 text-xs text-on-surface-variant">…</span>}
    </div>
  )
}

function ArgView({ item, onBack }: { item: PaletteItem; onBack: () => void }) {
  const arg = item.arg!
  const [text, setText] = useState('')
  const [active, setActive] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listId = useId()
  const choices = arg.choices ?? null
  const shown = choices
    ? choices.filter(c => !text || c.label.toLowerCase().includes(text.trim().toLowerCase()))
    : []

  useEffect(() => inputRef.current?.focus(), [])

  const finish = (value: string) => {
    if (counted(item.id)) noteUsed(item.id)
    closePalette()
    void item.run(value)
  }

  const submit = () => {
    if (choices) {
      const c = shown[active]
      if (c) finish(c.value)
      return
    }
    const problem = arg.check?.(text) ?? null
    if (problem) {
      setError(problem)
      return
    }
    finish(text.trim())
  }

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault()
      submit()
    } else if (choices && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault()
      const n = shown.length
      if (n) setActive(a => (a + (e.key === 'ArrowDown' ? 1 : n - 1)) % n)
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-outline-variant px-3 py-2">
        <button type="button" title="Back" aria-label="Back" onClick={onBack} className={iconBtn}>
          <ArrowLeft size={18} />
        </button>
        <span className="min-w-0 truncate text-sm font-medium">{item.title}</span>
      </div>
      <div className="flex items-center gap-2 px-4 py-3">
        <input
          ref={inputRef}
          value={text}
          onChange={e => {
            setText(e.target.value)
            setError(null)
            setActive(0)
          }}
          onKeyDown={onKey}
          placeholder={arg.placeholder}
          aria-label={arg.placeholder}
          aria-invalid={error !== null}
          role={choices ? 'combobox' : undefined}
          aria-expanded={choices ? true : undefined}
          aria-controls={choices ? listId : undefined}
          aria-activedescendant={choices && shown.length ? `${listId}-${active}` : undefined}
          autoComplete="off"
          spellCheck={false}
          className="min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-on-surface-variant md:text-sm"
        />
        {!choices && (
          <button type="button" title="Run" aria-label="Run" onClick={submit} className={iconBtn}>
            <CornerDownLeft size={16} />
          </button>
        )}
      </div>
      {error && (
        <p role="alert" className="px-4 pb-2 text-xs text-error">
          {error}
        </p>
      )}
      {choices && (
        <div id={listId} role="listbox" className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          {shown.map((c, i) => (
            <div
              key={c.value}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              onClick={() => finish(c.value)}
              onMouseMove={() => setActive(i)}
              className={`flex min-h-11 cursor-pointer items-center rounded-xl px-3 text-sm ${
                i === active ? 'bg-secondary-container text-on-secondary-container' : ''
              }`}
            >
              {c.label}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function useResults(text: string) {
  const s = useStore()
  const usage = usePaletteUi(x => x.prefs.used)
  const mask = useMask()
  const ops = useApiDoc(x => x.ops)
  const history = useApiDoc(x => x.history.items)
  const recents = useHome(x => x.prefs.recents)
  const indexTick = useIndexStatus(x => x.docs + x.bytes)
  return useMemo(() => {
    const ctx: ResultCtx = {
      usage,
      now: Date.now(),
      index: paletteIndex(),
      visible: d => docVisible(s, d),
      ops,
      history,
      recents,
      mask,
    }
    void indexTick
    return buildSections(s, text, ctx)
  }, [s, text, usage, mask, ops, history, recents, indexTick])
}

function ListView() {
  const text = usePaletteUi(s => s.text)
  const indexMode = useIndexStatus(s => s.mode)
  const apiLoading = useApiDoc(s => s.loading)
  const apiError = useApiDoc(s => s.error)
  const sections = useResults(text)
  const items = useMemo(() => flatItems(sections), [sections])
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listId = useId()
  const { mode, q } = parseQuery(text)
  const noConsole = useStore(noApi)
  const prefixes = prefixesFor(noConsole)
  const apiMode = mode === 'api' && !noConsole

  useEffect(() => {
    if (apiMode) void loadApiDoc()
  }, [apiMode])

  const [seenText, setSeenText] = useState(text)
  if (seenText !== text) {
    setSeenText(text)
    setActive(0)
  }
  const current = Math.min(active, Math.max(0, items.length - 1))

  useEffect(() => inputRef.current?.focus(), [])

  useEffect(() => {
    document.getElementById(`${listId}-${current}`)?.scrollIntoView({ block: 'nearest' })
  }, [current, listId])

  const pick = (item: PaletteItem | undefined) => {
    if (!item) return
    if (item.arg) {
      setPaletteView({ kind: 'arg', item })
      return
    }
    if (counted(item.id)) noteUsed(item.id)
    if (!item.keepOpen) closePalette()
    void item.run()
  }

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    const n = items.length
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (n) setActive((current + (e.key === 'ArrowDown' ? 1 : n - 1)) % n)
    } else if (e.key === 'PageDown' || e.key === 'PageUp') {
      e.preventDefault()
      if (n) setActive(Math.max(0, Math.min(n - 1, current + (e.key === 'PageDown' ? 8 : -8))))
    } else if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault()
      pick(items[current])
    }
  }

  const setMode = (prefix: string) => {
    const rest = q
    setPaletteText(prefix ? `${prefix}${rest}` : rest)
    inputRef.current?.focus()
  }

  let n = 0
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-3 border-b border-outline-variant px-4">
        <Search size={18} className="shrink-0 text-on-surface-variant" />
        <input
          ref={inputRef}
          value={text}
          onChange={e => setPaletteText(e.target.value)}
          onKeyDown={onKey}
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-activedescendant={items.length ? `${listId}-${current}` : undefined}
          aria-label="Search or run a command"
          placeholder="Search, or type > for commands"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          data-palette-input
          className="h-14 min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-on-surface-variant"
        />
      </div>
      <div
        role="toolbar"
        aria-label="Narrow the search"
        className="flex shrink-0 gap-1.5 overflow-x-auto border-b border-outline-variant px-3 py-2"
      >
        {prefixes.map(p => {
          const on = mode === p.mode
          return (
            <button
              key={p.prefix}
              type="button"
              aria-pressed={on}
              title={`${p.label} (${p.prefix})`}
              onClick={() => setMode(on ? '' : p.prefix)}
              className={`flex shrink-0 items-center gap-1 rounded-full border px-2.5 py-1 text-xs ${
                on
                  ? 'border-transparent bg-secondary-container text-on-secondary-container'
                  : 'border-outline-variant text-on-surface-variant hover:bg-surface-container-high'
              }`}
            >
              <span className="font-mono font-semibold">{p.prefix}</span>
              {p.label}
            </button>
          )
        })}
      </div>
      <div
        id={listId}
        role="listbox"
        aria-label="Results"
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 py-2"
      >
        {sections.map(sec => (
          <div key={`${sec.group}:${sec.label}`} role="group" aria-label={sec.label}>
            <p className="px-3 pt-2 pb-1 text-[11px] font-medium tracking-wide text-on-surface-variant uppercase">
              {sec.label}
            </p>
            {sec.items.map(({ item, hits }) => {
              const i = n++
              return (
                <Row
                  key={`${sec.group}:${sec.label}:${item.id}`}
                  id={`${listId}-${i}`}
                  item={item}
                  hits={hits}
                  active={i === current}
                  onPick={() => pick(item)}
                  onHover={() => i !== current && setActive(i)}
                />
              )
            })}
          </div>
        ))}
        {apiMode && apiLoading && (
          <p className="px-3 py-4 text-sm text-on-surface-variant">Loading the API…</p>
        )}
        {apiMode && apiError && (
          <div className="flex items-center gap-2 px-3 py-4 text-sm text-on-surface-variant">
            <span>{apiError}</span>
            <button type="button" onClick={() => void loadApiDoc(true)} className={textBtn}>
              Try again
            </button>
          </div>
        )}
        {!items.length && !(apiMode && (apiLoading || apiError)) && (
          <p className="px-3 py-6 text-center text-sm text-on-surface-variant">
            {q ? 'Nothing matches.' : 'Nothing here yet.'}
          </p>
        )}
        {mode === 'all' && q.length > 1 && indexMode === 'off' && (
          <p className="px-3 pt-2 pb-1 text-xs text-on-surface-variant">
            Turn on the index under Settings, Command palette, to search messages here.
          </p>
        )}
      </div>
      <div className="hidden shrink-0 items-center gap-4 border-t border-outline-variant px-4 py-2 text-[11px] text-on-surface-variant md:flex">
        <span>↑↓ Move</span>
        <span>Enter Run</span>
        <span>Esc Close</span>
        <span className="ml-auto">? Help</span>
      </div>
    </div>
  )
}

let listsFor: string | null = null

// Friend, request and block lists load lazily; the palette's commands for them need them once.
const loadLists = () => {
  const s = useStore.getState()
  if (!s.me || s.guest || listsFor === s.me.username) return
  listsFor = s.me.username
  if (!s.friends.list.length && !s.friends.loading) void s.loadFriends('', true)
  if (!s.incomingRequests.list.length && !s.incomingRequests.loading)
    void s.loadFriendRequests(true, true)
  if (!s.blockList.list.length && !s.blockList.loading) void s.loadBlockList('', true)
}

function Palette() {
  const stored = usePaletteUi(s => s.view)
  const noConsole = useStore(noApi)
  // Guests never get the API console, whatever asked for it.
  const view = stored.kind === 'api' && noConsole ? ({ kind: 'list' } as const) : stored
  useEffect(loadLists, [])
  const sheet = useMedia(SHEET)
  const pressed = useRef(false)
  const box = useRef<HTMLDivElement>(null)

  // Focus goes back to where it was when the palette closes.
  useEffect(() => {
    const opener = document.activeElement
    return () => {
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus()
    }
  }, [])

  // Escape belongs to the palette while it is open, wherever focus is. Tab stays inside it.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Tab') {
        const el = box.current
        if (!el) return
        const all = [
          ...el.querySelectorAll<HTMLElement>(
            'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])'
          ),
        ].filter(x => x.offsetParent !== null || x === document.activeElement)
        if (!all.length) return
        const first = all[0]
        const last = all[all.length - 1]
        const at = document.activeElement
        const inside = at instanceof Node && el.contains(at)
        if (!inside || (e.shiftKey && at === first) || (!e.shiftKey && at === last)) {
          e.preventDefault()
          ;(e.shiftKey ? last : first).focus()
        }
        return
      }
      if (e.key !== 'Escape' || e.isComposing) return
      e.preventDefault()
      e.stopImmediatePropagation()
      if (takeEscape()) return
      if (usePaletteUi.getState().view.kind !== 'list') setPaletteView({ kind: 'list' })
      else closePalette()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  return (
    <div
      className="fixed inset-0 z-[55] bg-scrim/50"
      onMouseDown={e => {
        pressed.current = e.target === e.currentTarget
      }}
      onClick={e => {
        if (pressed.current && e.target === e.currentTarget) closePalette()
        pressed.current = false
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        data-palette
        ref={box}
        className={
          sheet
            ? 'absolute inset-x-0 bottom-0 flex h-[85dvh] flex-col rounded-t-3xl bg-surface-container-low pt-2 pb-[env(safe-area-inset-bottom)] shadow-elevation-3'
            : `absolute top-[max(4rem,12vh)] left-1/2 flex w-[min(42rem,calc(100vw-2rem))] -translate-x-1/2 flex-col overflow-hidden rounded-2xl border border-outline-variant bg-surface-container-low shadow-elevation-3 ${
                view.kind === 'api' ? 'h-[min(44rem,80vh)]' : 'max-h-[min(40rem,80vh)]'
              }`
        }
      >
        {sheet && <SheetGrip />}
        {view.kind === 'api' ? (
          <ApiConsoleFor
            key={`${view.op}`}
            opId={view.op}
            initial={view.values}
            onBack={() => setPaletteView({ kind: 'list' })}
          />
        ) : view.kind === 'arg' ? (
          <ArgView item={view.item} onBack={() => setPaletteView({ kind: 'list' })} />
        ) : (
          <ListView />
        )}
      </div>
    </div>
  )
}
