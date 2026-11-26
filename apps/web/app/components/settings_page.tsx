'use client'

import {
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react'
import { ArrowLeft, ChevronDown, ChevronRight, Search, X, type LucideIcon } from 'lucide-react'
import {
  currentEntry,
  focusesSearch,
  keptSections,
  navKey,
  openSection,
  pageEscape,
  rowAnchor,
  shownSection,
  tabWrap,
} from '../lib/settings_page'
import { searchRows, type SearchHit, type SearchRow } from '../lib/settings_search'
import type { EscapeLayer } from '../lib/escape_layers'
import { useMotionPlays } from '../lib/motion/use_motion'
import { Dialog } from './ui'

export interface PageSection {
  id: string
  label: string
  icon: LucideIcon
  // The heading the section sits under in the nav.
  group?: string
  // What search finds in this section.
  rows?: SearchRow[]
  // Lists the rows under the section in the nav of wide screens while it shows.
  outline?: boolean
  render: () => ReactNode
}

const barBtn =
  'flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface'

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])'

const shows = (el: Element | null): el is HTMLElement =>
  el instanceof HTMLElement && el.offsetParent !== null

// The dialog that holds `el`.
const modalOf = (el: HTMLElement | null) => el?.closest<HTMLElement>('[aria-modal="true"]') ?? null

// Whether `modal` is the top one of the open modals.
const onTop = (modal: HTMLElement) => {
  const modals = document.querySelectorAll('[aria-modal="true"]')
  return modals[modals.length - 1] === modal
}

const WIDE = '(min-width: 768px)'
const watchWide = (changed: () => void) => {
  const mq = window.matchMedia(WIDE)
  mq.addEventListener('change', changed)
  return () => mq.removeEventListener('change', changed)
}
const wideNow = () => window.matchMedia(WIDE).matches
// Markup made before the screen is known marks the section a wide screen shows.
const wideBefore = () => true

// The controls of `root` that Tab reaches, in order.
const focusables = (root: HTMLElement) =>
  [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    el => shows(el) || el === document.activeElement
  )

// A row of a section: search results and deep links scroll to it and flash it.
export function PageRow({
  id,
  children,
  className = '',
}: {
  id: string
  children: ReactNode
  className?: string
}) {
  const moves = useMotionPlays()
  return (
    <div
      id={rowAnchor(id)}
      data-setting-row
      className={`scroll-mt-4 rounded-xl data-[flash]:bg-secondary-container ${moves ? 'transition-colors duration-500' : ''} ${className}`}
    >
      {children}
    </div>
  )
}

// A titled group of rows in a section.
export function PageGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section aria-label={label} className="pb-5">
      <h2 className="pb-2 text-xs font-medium tracking-wide text-on-surface-variant uppercase">
        {label}
      </h2>
      <div className="space-y-1">{children}</div>
    </section>
  )
}

function SearchField({
  query,
  setQuery,
  onEnter,
  fieldRef,
  className = '',
}: {
  query: string
  setQuery: (q: string) => void
  onEnter: () => void
  fieldRef: React.Ref<HTMLInputElement>
  className?: string
}) {
  return (
    <div
      className={`flex items-center gap-2 rounded-xl border border-outline px-3 focus-within:border-primary ${className}`}
    >
      <Search size={16} className="shrink-0 text-on-surface-variant" />
      <input
        ref={fieldRef}
        type="search"
        value={query}
        onChange={e => setQuery(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter') onEnter()
        }}
        placeholder="Search settings"
        aria-label="Search settings"
        className="h-11 min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-on-surface-variant md:h-9 md:text-sm [&::-webkit-search-cancel-button]:hidden"
      />
      {query !== '' && (
        <button
          type="button"
          data-icon-only
          title="Clear search"
          aria-label="Clear search"
          onClick={() => setQuery('')}
          className="-mr-2.5 flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-on-surface-variant hover:bg-surface-container-high md:-mr-1.5 md:h-7 md:w-7"
        >
          <X size={16} />
        </button>
      )}
    </div>
  )
}

function Results({ hits, onPick }: { hits: SearchHit[]; onPick: (hit: SearchHit) => void }) {
  return (
    <div role="region" aria-label="Search results" className="flex flex-col gap-1 pb-4">
      <p role="status" className="px-3 text-xs text-on-surface-variant">
        {hits.length === 0
          ? 'No results'
          : hits.length === 1
            ? '1 result'
            : `${hits.length} results`}
      </p>
      {hits.map(hit => (
        <button
          key={`${hit.row.section}/${hit.row.id}`}
          type="button"
          onClick={() => onPick(hit)}
          className="flex min-h-11 w-full min-w-0 flex-col justify-center rounded-xl px-3 py-1.5 text-left hover:bg-surface-container-high"
        >
          <span className="max-w-full text-sm break-words">{hit.row.label}</span>
          <span className="max-w-full text-xs break-words text-on-surface-variant">
            {hit.trail.slice(0, -1).join(' › ')}
          </span>
        </button>
      ))}
    </div>
  )
}

// A large dialog of settings over the app: sections on the left and one section's content on
// wide screens; on narrow ones the screen fills with the list of sections, then a section as its
// own screen.
export function SettingsPage({
  title,
  sections,
  active: asked,
  onSection,
  onClose,
  onBack,
  heading,
  headingName = false,
  row = null,
  summary,
  header,
  actor,
  lead,
  closeTitle = 'Close',
  layer = 'page',
  top = false,
  search = true,
}: {
  title: string
  sections: PageSection[]
  // The open section; null shows the list on narrow screens and the first section on wide ones.
  active: string | null
  onSection: (id: string | null, row?: string) => void
  onClose: () => void
  // Where the back arrow of a narrow section screen goes; the list of sections when left out.
  onBack?: () => void
  // The name of what the section shows, when it is one item of it.
  heading?: string
  // Whether `heading` is a username or a server name.
  headingName?: boolean
  // The row to scroll to and flash.
  row?: string | null
  // Shown above the list of sections on narrow screens.
  summary?: ReactNode
  // Shown above the list of sections on every screen, in place of the title on wide ones.
  header?: ReactNode
  // Who the page acts as, beside the section's name.
  actor?: ReactNode
  // Shown above every section's content.
  lead?: ReactNode
  closeTitle?: string
  layer?: EscapeLayer
  top?: boolean
  search?: boolean
}) {
  const root = useRef<HTMLDivElement>(null)
  const back = useRef<HTMLButtonElement>(null)
  const wideField = useRef<HTMLInputElement>(null)
  const listField = useRef<HTMLInputElement>(null)
  const sectionField = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [folded, setFolded] = useState<string | null>(null)
  // Counts jumps to a row, so asking for the row already shown scrolls to it and flashes again.
  const [jumps, setJumps] = useState(0)
  // Where focus was as the page opened, before a field inside it took focus.
  const [opener] = useState(() => (typeof document === 'undefined' ? null : document.activeElement))
  const moves = useMotionPlays()
  const smooth = useRef(moves)
  useEffect(() => {
    smooth.current = moves
  })
  const active = openSection(sections, asked)
  const shown = shownSection(sections, active)
  const section = sections.find(s => s.id === shown) ?? null
  const wide = useSyncExternalStore(watchWide, wideNow, wideBefore)
  const [visited, setVisited] = useState<readonly string[]>([])
  const kept = keptSections(visited, shown)
  if (kept !== visited) setVisited(kept)
  // The last section open, for focus to go back to its entry in the list.
  const left = useRef<string | null>(null)
  useEffect(() => {
    if (active !== null) left.current = active
  })
  const single = sections.length === 1
  const hits = useMemo(() => searchRows(sections, query), [sections, query])

  const jump = (to: string, row: string) => {
    setJumps(n => n + 1)
    onSection(to, row)
  }
  const pick = (hit: SearchHit) => {
    setQuery('')
    setSearching(false)
    jump(hit.row.section, hit.row.id)
  }
  const enter = () => {
    if (hits[0]) pick(hits[0])
  }
  const screen = active === null ? 'list' : 'section'

  const escape = () => {
    if (pageEscape(query) === 'clear') setQuery('')
    else onClose()
  }

  // Focus goes back to where it was when the page closes, unless another dialog took its place.
  useEffect(
    () => () => {
      if (!(opener instanceof HTMLElement) || !opener.isConnected) return
      const modals = document.querySelectorAll('[aria-modal="true"]')
      const over = modals[modals.length - 1]
      if (over && !over.contains(opener)) return
      opener.focus()
    },
    [opener]
  )

  // Focus moves into the page when it opens, and to the new screen when the one it was on hides:
  // the entry of the section just left or the current one in the nav, else the back arrow.
  useEffect(() => {
    const el = root.current
    const modal = modalOf(el)
    if (!el || !modal) return
    const at = document.activeElement
    if (at !== modal && modal.contains(at) && shows(at)) return
    const entry = (id: string | null) =>
      id === null ? null : el.querySelector(`nav [data-settings-section="${CSS.escape(id)}"]`)
    const start = [
      entry(left.current),
      el.querySelector('nav [aria-current="page"]'),
      el.querySelector('nav [data-settings-section]'),
      back.current,
    ].find(shows)
    ;(start ?? modal).focus({ preventScroll: true })
  }, [screen, heading])

  // Tab stays inside the page while it is the top one.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const modal = modalOf(root.current)
      if (e.key !== 'Tab' || e.defaultPrevented || !modal) return
      const at = document.activeElement
      const inside = at !== null && modal.contains(at)
      if (!inside && at !== null && at !== document.body) return
      if (!onTop(modal)) return
      const all = focusables(modal)
      const to = tabWrap(inside ? all.indexOf(at as HTMLElement) : -1, all.length, e.shiftKey)
      if (to === null) return
      e.preventDefault()
      all[to].focus()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    if (!search) return
    const onKey = (e: KeyboardEvent) => {
      const on = e.target instanceof HTMLElement ? e.target : document.body
      if (!focusesSearch(e, { tag: on.tagName, editable: on.isContentEditable })) return
      const modal = modalOf(root.current)
      if (!modal || !onTop(modal)) return
      e.preventDefault()
      const wide = wideField.current
      if (wide && wide.offsetParent !== null) return wide.focus()
      setSearching(true)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [search])

  useEffect(() => {
    if (!searching) return
    for (const field of [listField.current, sectionField.current])
      if (field && field.offsetParent !== null) field.focus()
  }, [searching, active])

  useEffect(() => {
    if (!row) return
    const el = document.getElementById(rowAnchor(row))
    if (!el) return
    el.scrollIntoView({ block: 'center', behavior: smooth.current ? 'smooth' : 'auto' })
    el.setAttribute('data-flash', '')
    const id = window.setTimeout(() => el.removeAttribute('data-flash'), 1600)
    return () => {
      window.clearTimeout(id)
      el.removeAttribute('data-flash')
    }
  }, [row, shown, jumps])

  const searchButton = search && (
    <button
      type="button"
      data-icon-only
      title="Search settings"
      aria-label="Search settings"
      aria-pressed={searching}
      onClick={() => {
        if (searching) setQuery('')
        setSearching(!searching)
      }}
      className={barBtn}
    >
      <Search size={20} />
    </button>
  )
  const closeButton = (className: string) => (
    <button
      type="button"
      data-icon-only
      title={closeTitle}
      aria-label={closeTitle}
      onClick={onClose}
      className={className}
    >
      <X size={20} />
    </button>
  )
  const results = query.trim() !== '' && <Results hits={hits} onPick={pick} />
  const named = heading !== undefined && headingName ? 'streamer' : ''

  return (
    <Dialog
      title={title}
      onClose={onClose}
      onEscape={escape}
      size="settings"
      chrome="bare"
      layer={layer}
      top={top}
    >
      <div
        ref={root}
        data-settings-page
        data-screen={screen}
        className="flex min-h-0 flex-1 flex-col md:flex-row"
      >
        <div
          className={`${active === null ? 'flex' : 'hidden'} min-h-0 flex-1 flex-col md:flex md:w-64 md:flex-none md:border-r md:border-outline-variant md:bg-surface-container-low`}
        >
          <div className="flex h-14 shrink-0 items-center gap-1 border-b border-outline-variant px-2 md:hidden">
            {closeButton(barBtn)}
            <span className="min-w-0 flex-1 truncate px-1 font-medium">{title}</span>
            {actor}
            {searchButton}
          </div>
          {header === undefined && (
            <p className="hidden px-7 pt-6 pb-3 text-xs font-medium tracking-wide text-on-surface-variant uppercase md:block">
              {title}
            </p>
          )}
          {search && (
            <>
              <SearchField
                query={query}
                setQuery={setQuery}
                onEnter={enter}
                fieldRef={wideField}
                className={`mx-4 mb-3 hidden md:flex ${header === undefined ? '' : 'mt-4'}`}
              />
              {searching && (
                <SearchField
                  query={query}
                  setQuery={setQuery}
                  onEnter={enter}
                  fieldRef={listField}
                  className="mx-3 mt-3 md:hidden"
                />
              )}
            </>
          )}
          {header !== undefined && (
            <div
              className={`shrink-0 px-3 pt-3 md:px-4 md:pb-3 ${search ? 'md:pt-0' : 'md:pt-4'} ${results ? 'hidden md:block' : ''}`}
            >
              {header}
            </div>
          )}
          <div className="min-h-0 flex-1 overflow-y-auto px-3 pt-3 pb-[max(1rem,env(safe-area-inset-bottom))] md:px-4 md:pt-0">
            {results && <div className="md:hidden">{results}</div>}
            <div className={results ? 'hidden md:block' : ''}>
              {summary && <div className="pb-3 md:hidden">{summary}</div>}
              <nav
                aria-label={title}
                className="flex flex-col gap-1"
                onKeyDown={e => {
                  const buttons = [...e.currentTarget.querySelectorAll('button')].filter(shows)
                  const to = navKey(
                    e.key,
                    buttons.indexOf(document.activeElement as HTMLButtonElement),
                    buttons.length
                  )
                  if (to === null) return
                  e.preventDefault()
                  buttons[to]?.focus()
                }}
              >
                {sections.map(({ id, label, icon: Icon, group, rows, outline }, i) => {
                  const parts = outline && shown === id ? (rows ?? []) : []
                  const open = parts.length > 1 && folded !== id
                  const entry = (
                    <button
                      type="button"
                      data-settings-section={id}
                      aria-current={currentEntry(id, { shown, active, wide }) ? 'page' : undefined}
                      onClick={() => onSection(id)}
                      className={`flex min-h-11 w-full min-w-0 flex-1 items-center gap-3 rounded-xl px-3 py-2 text-left text-sm md:min-h-0 ${
                        active === id
                          ? 'bg-secondary-container text-on-secondary-container'
                          : shown === id
                            ? 'text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface md:bg-secondary-container md:text-on-secondary-container'
                            : 'text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface'
                      }`}
                    >
                      <Icon size={18} className="shrink-0" />
                      <span className="min-w-0 flex-1 truncate">{label}</span>
                      <ChevronRight size={18} className="shrink-0 md:hidden" />
                    </button>
                  )
                  const fold = open ? `Hide the parts of ${label}` : `Show the parts of ${label}`
                  return (
                    <Fragment key={id}>
                      {group !== undefined && group !== sections[i - 1]?.group && (
                        <p className="px-3 pt-4 pb-1 text-xs font-medium tracking-wide text-on-surface-variant uppercase first:pt-1">
                          {group}
                        </p>
                      )}
                      {parts.length > 1 ? (
                        <div className="flex min-w-0 items-center gap-1">
                          {entry}
                          <button
                            type="button"
                            data-icon-only
                            title={fold}
                            aria-label={fold}
                            aria-expanded={open}
                            onClick={() => setFolded(open ? id : null)}
                            className="hidden size-8 shrink-0 items-center justify-center rounded-full text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface md:flex"
                          >
                            <ChevronDown size={16} className={open ? 'rotate-180' : ''} />
                          </button>
                        </div>
                      ) : (
                        entry
                      )}
                      {open && (
                        <div className="ml-5 hidden min-w-0 flex-col gap-0.5 border-l border-outline-variant py-1 pl-2 md:flex">
                          {parts.map(part => (
                            <button
                              key={part.id}
                              type="button"
                              data-settings-part={part.id}
                              onClick={() => jump(id, part.id)}
                              className="min-w-0 truncate rounded-lg px-3 py-1.5 text-left text-sm text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface"
                            >
                              {part.label}
                            </button>
                          ))}
                        </div>
                      )}
                    </Fragment>
                  )
                })}
              </nav>
            </div>
          </div>
        </div>
        <div
          className={`${active === null ? 'hidden' : 'flex'} min-h-0 min-w-0 flex-1 flex-col md:flex`}
        >
          <div className="flex h-14 shrink-0 items-center gap-1 border-b border-outline-variant px-2 md:hidden">
            {(onBack || !single) && (
              <button
                ref={back}
                type="button"
                data-icon-only
                title="Back"
                aria-label="Back"
                onClick={onBack ?? (() => onSection(null))}
                className={barBtn}
              >
                <ArrowLeft size={20} />
              </button>
            )}
            <span className={`min-w-0 flex-1 truncate px-1 font-medium ${named}`}>
              {heading ?? section?.label}
            </span>
            {actor}
            {searchButton}
            {closeButton(barBtn)}
          </div>
          {search && searching && (
            <SearchField
              query={query}
              setQuery={setQuery}
              onEnter={enter}
              fieldRef={sectionField}
              className="mx-3 mt-3 md:hidden"
            />
          )}
          <div className="hidden h-16 shrink-0 items-center gap-3 border-b border-outline-variant pr-3 pl-6 md:flex lg:pl-10">
            <h1 className={`min-w-0 flex-1 truncate text-xl font-medium ${named}`}>
              {heading ?? section?.label}
            </h1>
            {actor}
            {closeButton(
              'flex size-10 shrink-0 items-center justify-center rounded-full text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface'
            )}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 pt-4 pb-[max(1.5rem,env(safe-area-inset-bottom))] md:px-6 md:pt-6 md:pb-10 lg:px-10">
            <div className="mx-auto max-w-3xl">
              {results}
              {lead}
              {sections
                .filter(s => kept.includes(s.id))
                .map(s => (
                  <div key={s.id} data-section-body={s.id} hidden={s.id !== shown}>
                    {s.render()}
                  </div>
                ))}
            </div>
          </div>
        </div>
      </div>
    </Dialog>
  )
}
