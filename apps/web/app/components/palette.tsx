'use client'
import { client } from '../lib/client/client'
import { AccountProvider, useAccount } from '../lib/client/react'

import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
} from 'react'
import { ArrowLeft, Command, CornerDownLeft, Search } from 'lucide-react'
import { fuzzyParts } from '../lib/fuzzy'
import { useHome } from '../lib/home_store'
import { loadSignInChoices } from '../lib/sso_actions'
import { registerAppActions } from '../lib/actions'
import { revealMasked } from '../lib/actions/masked'
import { actionsVersion, subscribeActions } from '../lib/actions/registry'
import { useApiDoc } from '../lib/api_console'
import {
  hasMasked,
  isMac,
  paletteKey,
  paletteShortcut,
  parseQuery,
  prefixesFor,
  registerPalette,
  usePalette,
  type PaletteItem,
} from '../lib/palette'
import { accountPaletteSections, createPaletteChanges } from '../lib/client/palette_accounts'
import { flatItems, noApi, type ResultCtx } from '../lib/palette_results'
import {
  closePalette,
  closePalettePoll,
  openPalette,
  setPaletteText,
  setPaletteView,
  takeEscape,
  togglePalette,
  usePaletteUi,
} from '../lib/palette_store'
import type { AccountSession } from '../lib/client/session'
import { useIndexStatus } from '../lib/palette_sync'
import { shortcutLabel, switchAccountKey } from '../lib/shortcuts'
import { useMask, useStore } from '../lib/store'
import { ApiConsoleFor } from './api_console'
import { useMedia } from './context_menu'
import { CreatePollDialog } from './poll_dialog'
import { Button, Chip, IconButton } from './controls'
import { Row, Surface } from './layout'
import { Masked, MaskedText, Sheet } from './ui'

const SHEET = '(max-width: 767px)'

// Usage is not counted for one-off rows (messages, saved requests).
const counted = (id: string) => !id.startsWith('message_') && !id.startsWith('apihistory_')

export function PaletteHost() {
  const acct = useAccount()
  const actor = usePaletteUi(s => s.actor) ?? acct
  const open = usePaletteUi(s => s.open)
  const poll = usePaletteUi(s => s.poll)

  useEffect(() => {
    registerAppActions()
    registerPalette(account => openPalette('', account))
    return () => {
      registerPalette(null)
    }
  }, [])

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      const switching = switchAccountKey(e)
      if ((!switching && !paletteKey(e)) || e.isComposing || e.repeat) return
      if (
        client.live().some(account => {
          const state = account.store.getState()
          return (
            state.confirm ||
            account.viewing.useViewing.getState().prompt ||
            state.activeDialog?.kind === 'app_preview'
          )
        })
      )
        return
      e.preventDefault()
      e.stopPropagation()
      if (switching) {
        closePalette()
        const state = acct.store.getState()
        if (state.activeDialog?.kind === 'account_switcher') state.closeDialog()
        else state.openDialog({ kind: 'account_switcher' })
      } else togglePalette(acct)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [acct])

  return (
    <>
      {open && (
        <AccountProvider key={actor.renderKey} session={actor}>
          <Palette />
        </AccountProvider>
      )}
      {poll && (
        <AccountProvider key={`poll-${poll.key}`} session={poll.actor}>
          <CreatePollDialog target={poll.target} onClose={() => closePalettePoll(poll)} />
        </AccountProvider>
      )}
    </>
  )
}

// Opens the palette from a header (the only way on touch screens).
// `rail`: the button at the foot of the server rail; otherwise the one in a narrow header.
export function PaletteButton({ rail = false }: { rail?: boolean }) {
  const acct = useAccount()
  const open = usePalette(s => s.open)
  if (!open) return null
  const label = `Command palette (${paletteShortcut(isMac())})`
  return (
    <IconButton
      icon={Command}
      label="Command palette"
      tooltip={label}
      size={rail ? 'lg' : 'md'}
      data-palette-button
      onClick={() => open(acct)}
      place={rail ? undefined : 'md:hidden'}
    />
  )
}

function Title({ item, hits }: { item: PaletteItem; hits: number[] }) {
  const mask = useMask(item.own)
  const masked = item.name === true && mask(item.title) !== item.title
  const parts = hits.length && !masked ? fuzzyParts(item.title, hits) : null
  return (
    <span
      className={`truncate text-sm ${item.danger ? 'text-error' : 'text-on-surface'} ${item.name ? 'streamer' : ''}`}
    >
      {item.originalTitle ? (
        <MaskedText key={item.originalTitle} text={item.originalTitle} shown={item.title} />
      ) : parts ? (
        parts.map((p, i) =>
          p.hit ? (
            <mark key={i} className="bg-transparent font-semibold text-primary">
              {p.text}
            </mark>
          ) : (
            <span key={i}>{p.text}</span>
          )
        )
      ) : masked ? (
        <Masked text={item.title} />
      ) : (
        item.title
      )}
    </span>
  )
}

function ResultRow({
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
            {item.originalSubtitle ? (
              <MaskedText
                key={item.originalSubtitle}
                text={item.originalSubtitle}
                shown={item.subtitle}
              />
            ) : item.subtitleName ? (
              <Masked text={item.subtitle} own={item.own} />
            ) : (
              item.subtitle
            )}
          </span>
        )}
      </span>
      {item.hint && (
        <kbd className="shrink-0 rounded-md border border-outline-variant px-1.5 py-0.5 font-mono text-2xs text-on-surface-variant">
          {/^Mod|^Shift|^Escape/.test(item.hint) ? shortcutLabel(item.hint) : item.hint}
        </kbd>
      )}
      {item.arg && <span className="shrink-0 text-xs text-on-surface-variant">…</span>}
    </div>
  )
}

function ArgView({ item, onBack }: { item: PaletteItem; onBack: () => void }) {
  const acct = useAccount()
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
    if (item.available?.() === false) return onBack()
    if (counted(item.id)) acct.palettePrefs.noteUsed(item.id)
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
      <Surface pad="md" inset="bar" tone="plain" radius="none" border="bottom" place="shrink-0">
        <Row gap="sm">
          <IconButton icon={ArrowLeft} label="Back" size="lg" onClick={onBack} />
          <span className="min-w-0 truncate text-sm font-medium">{item.title}</span>
        </Row>
      </Surface>
      <Surface pad="lg" inset="bar" gap="md" tone="plain" radius="none">
        <Row gap="sm">
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
          {!choices && <IconButton icon={CornerDownLeft} label="Run" size="lg" onClick={submit} />}
        </Row>
        {error && (
          <p role="alert" className="text-xs text-error">
            {error}
          </p>
        )}
      </Surface>
      {choices && (
        <Surface
          id={listId}
          role="listbox"
          pad="sm"
          tone="plain"
          radius="none"
          place="min-h-0 flex-1 overflow-y-auto"
        >
          {shown.map((c, i) => (
            <Surface
              key={c.value}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              onClick={() => finish(c.value)}
              onMouseMove={() => setActive(i)}
              pad="md"
              inset="sides"
              row
              tone="plain"
              radius="lg"
              text="sm"
              look={`min-h-11 cursor-pointer ${i === active ? 'bg-secondary-container text-on-secondary-container' : ''}`}
            >
              {c.label}
            </Surface>
          ))}
        </Surface>
      )}
    </div>
  )
}

function useResults(text: string) {
  const acct = useAccount()
  const viewing = acct.viewing.useViewing(s => s.revision)
  const s = useStore()
  const usage = usePaletteUi(x => x.prefs.used)
  const mask = useMask()
  const ops = useApiDoc(x => x.ops)
  const history = useApiDoc(x => x.history.items)
  const recents = useHome(x => x.prefs.recents)
  const indexTick = useIndexStatus(x => x.docs + x.bytes)
  const actions = useSyncExternalStore(subscribeActions, actionsVersion, actionsVersion)
  const changes = useMemo(() => createPaletteChanges(acct), [acct])
  const owners = useSyncExternalStore(changes.subscribe, changes.getSnapshot, changes.getSnapshot)
  return useMemo(() => {
    const ctx: ResultCtx = {
      usage,
      now: acct.time.now(),
      index: acct.indexer.paletteIndex(),
      visible: d => acct.indexer.docVisible(s, d),
      ops,
      history,
      recents,
      mask,
    }
    void viewing
    void indexTick
    void actions
    void owners
    return accountPaletteSections(acct, text, ctx)
  }, [acct, s, text, usage, mask, ops, history, recents, indexTick, actions, viewing, owners])
}

function ListView() {
  const acct = useAccount()

  const text = usePaletteUi(s => s.text)
  const indexMode = useIndexStatus(s => s.mode)
  const apiLoading = useApiDoc(s => s.loading)
  const apiError = useApiDoc(s => s.error)
  const sections = useResults(text)
  const items = useMemo(() => flatItems(sections), [sections])
  const mask = useMask()
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listId = useId()
  const { mode, q } = parseQuery(text)
  const noConsole = useStore(noApi)
  const prefixes = prefixesFor(noConsole)
  const apiMode = mode === 'api' && !noConsole

  useEffect(() => {
    if (apiMode) void acct.apiDoc.loadApiDoc()
  }, [acct, apiMode])

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

  const ownerOf = (item: PaletteItem) =>
    sections.find(s => s.items.some(row => row.item === item))?.owner?.account ?? acct

  const pick = (item: PaletteItem | undefined) => {
    if (!item || item.available?.() === false) return
    if (item.arg) {
      setPaletteView({ kind: 'arg', item })
      return
    }
    if (counted(item.id)) ownerOf(item).palettePrefs.noteUsed(item.id)
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
    } else if (e.key === 'Enter' && e.altKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      const item = items[current]
      if (item && item.available?.() !== false)
        revealMasked(document.getElementById(`${listId}-${current}`), ownerOf(item))
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
      <div className="shrink-0 border-b border-outline-variant px-4">
        <Row gap="md">
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
        </Row>
      </div>
      <Surface
        role="toolbar"
        aria-label="Narrow the search"
        pad="md"
        inset="bar"
        tone="plain"
        radius="none"
        border="bottom"
        place="shrink-0 overflow-x-auto"
      >
        <Row gap="xs">
          {prefixes.map(p => {
            const on = mode === p.mode
            return (
              <Chip
                key={p.prefix}
                on={on}
                title={`${p.label} (${p.prefix})`}
                onClick={() => setMode(on ? '' : p.prefix)}
                place="shrink-0"
              >
                <span className="font-mono font-semibold">{p.prefix}</span> {p.label}
              </Chip>
            )
          })}
        </Row>
      </Surface>
      <Surface
        id={listId}
        role="listbox"
        aria-label="Results"
        pad="sm"
        tone="plain"
        radius="none"
        place="min-h-0 flex-1 overflow-y-auto overscroll-contain"
      >
        {sections.map((sec, ix) => (
          <div
            key={JSON.stringify([
              sec.owner?.account.renderKey,
              sec.owner?.local,
              sec.group,
              sec.label,
            ])}
            role="group"
            aria-label={sec.owner ? mask(sec.owner.label) + ' · ' + sec.label : sec.label}
            data-palette-owner={sec.owner?.account.renderKey}
            data-palette-identity={sec.owner?.local}
          >
            <Surface pad="md" inset="bar" gap="sm" tone="plain" radius="none">
              {sec.owner &&
                (sections[ix - 1]?.owner?.account !== sec.owner.account ||
                  sections[ix - 1]?.owner?.local !== sec.owner.local) && (
                  <h3 className="streamer text-sm font-semibold">
                    <Masked text={sec.owner.label} />
                  </h3>
                )}
              <p className="text-2xs font-medium tracking-wide text-on-surface-variant uppercase">
                {sec.label}
              </p>
            </Surface>
            {sec.items.map(({ item, hits }) => {
              const i = n++
              return (
                <ResultRow
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
          <Surface pad="lg" tone="plain" radius="none">
            <p className="text-sm text-on-surface-variant">Loading the API…</p>
          </Surface>
        )}
        {apiMode && apiError && (
          <Surface pad="lg" tone="plain" radius="none">
            <Row gap="sm">
              <span className="text-sm text-on-surface-variant">{apiError}</span>
              <Button onClick={() => void acct.apiDoc.loadApiDoc(true)}>Try again</Button>
            </Row>
          </Surface>
        )}
        {!items.length && !(apiMode && (apiLoading || apiError)) && (
          <Surface pad="xl" tone="plain" radius="none">
            <p className="text-center text-sm text-on-surface-variant">
              {q ? 'Nothing matches.' : 'Nothing here yet.'}
            </p>
          </Surface>
        )}
        {mode === 'all' && q.length > 1 && indexMode === 'off' && (
          <Surface pad="md" inset="bar" tone="plain" radius="none">
            <p className="text-xs text-on-surface-variant">
              Turn on the index under Settings, Command palette, to search messages here.
            </p>
          </Surface>
        )}
      </Surface>
      <Surface
        pad="lg"
        inset="bar"
        tone="plain"
        radius="none"
        border="top"
        place="hidden shrink-0 md:flex"
      >
        <p className="text-2xs text-on-surface-variant">
          <Row as="span" gap="lg">
            <span>↑↓ Move</span>
            <span>Enter Run</span>
            <span>Esc Close</span>
            {hasMasked(items[current], mask) && <span>Alt+Enter Show masked text</span>}
            <span className="ml-auto">? Help</span>
          </Row>
        </p>
      </Surface>
    </div>
  )
}

const listsFor = new WeakMap<object, string>()

// Friend, request and block lists load lazily; the palette's commands for them need them once.
const loadLists = (acct: AccountSession) => {
  const s = acct.store.getState()
  const mark = acct.lifetime.sessionMark()
  if (!s.me || s.guest || listsFor.get(mark) === s.me.username) return
  listsFor.set(mark, s.me.username)
  if (!s.friends.list.length && !s.friends.loading) void s.loadFriends('', true)
  if (!s.incomingRequests.list.length && !s.incomingRequests.loading)
    void s.loadFriendRequests(true, true)
  if (!s.blockList.list.length && !s.blockList.loading) void s.loadBlockList('', true)
}

function Palette() {
  const acct = useAccount()
  const stored = usePaletteUi(s => s.view)
  acct.viewing.useViewing(s => s.revision)
  useSyncExternalStore(subscribeActions, actionsVersion, actionsVersion)
  const revoked = stored.kind === 'arg' && stored.item.available?.() === false
  useEffect(() => {
    if (revoked) setPaletteView({ kind: 'list' })
  }, [revoked])
  const noConsole = useStore(noApi)
  // Guests never get the API console, whatever asked for it.
  const view =
    revoked || (stored.kind === 'api' && noConsole) ? ({ kind: 'list' } as const) : stored
  useEffect(() => loadLists(acct), [acct])
  useEffect(() => loadSignInChoices(acct), [acct])
  const sheet = useMedia(SHEET)
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

  const body =
    view.kind === 'api' ? (
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
    )
  return (
    <Sheet
      sheet={sheet}
      float={{
        at: `top-[max(4rem,12vh)] left-1/2 w-[min(42rem,calc(100%-2rem))] -translate-x-1/2 ${
          view.kind === 'api' ? 'h-[min(44rem,80vh)]' : 'max-h-[min(40rem,80vh)]'
        }`,
        backdrop: 'dim',
      }}
      layer="palette"
      height="tall"
      surface="low"
      aria-label="Command palette"
      onClose={closePalette}
      ref={box}
      data-palette=""
    >
      {body}
    </Sheet>
  )
}
