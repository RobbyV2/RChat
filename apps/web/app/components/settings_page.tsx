'use client'

import { Covered } from './covered'
import {
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react'
import { ArrowLeft, ChevronDown, ChevronUp, Search, X, type LucideIcon } from 'lucide-react'
import {
  currentEntry,
  focusesSearch,
  keptSections,
  navKey,
  navRuns,
  openSection,
  pageEscape,
  rowAnchor,
  shownSection,
  tabWrap,
} from '../lib/settings_page'
import { searchRows, type SearchHit, type SearchRow } from '../lib/settings_search'
import type { EscapeLayer } from '../lib/escape_layers'
import { playsOn } from '../lib/motion/play'
import { useSlotPlays } from '../lib/motion/use_motion'
import { IconButton, ListRow } from './controls'
import { Row, Stack, Surface, Inset } from './layout'
import { Dialog } from './ui'
import { time } from '../lib/platform/time'

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
  const moves = useSlotPlays('route')
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
    <section aria-label={label}>
      <Stack gap="sm">
        <h2 className="text-xs font-medium tracking-wide text-on-surface-variant uppercase">
          {label}
        </h2>
        <Stack gap="2xs">{children}</Stack>
      </Stack>
    </section>
  )
}

function SearchField({
  query,
  setQuery,
  onEnter,
  fieldRef,
}: {
  query: string
  setQuery: (q: string) => void
  onEnter: () => void
  fieldRef: React.Ref<HTMLInputElement>
}) {
  return (
    <Surface
      pad="md"
      inset="sides"
      gap="sm"
      row
      tone="plain"
      radius="lg"
      look="focus-within:border-primary border border-outline"
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
        <IconButton
          icon={X}
          label="Clear search"
          size="sm"
          data-icon-only
          onClick={() => setQuery('')}
        />
      )}
    </Surface>
  )
}

function Results({ hits, onPick }: { hits: SearchHit[]; onPick: (hit: SearchHit) => void }) {
  return (
    <Stack role="region" aria-label="Search results" gap="2xs">
      <Surface pad="md" inset="bar" tone="plain">
        <p role="status" className="text-xs text-on-surface-variant">
          {hits.length === 0
            ? 'No results'
            : hits.length === 1
              ? '1 result'
              : `${hits.length} results`}
        </p>
      </Surface>
      {hits.map(hit => (
        <ListRow
          key={`${hit.row.section}/${hit.row.id}`}
          wrap
          onClick={() => onPick(hit)}
          label={hit.row.label}
          description={hit.trail.slice(0, -1).join(' › ')}
        />
      ))}
    </Stack>
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
  const moves = useSlotPlays('route')
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
    const id = time().after(1600, () => el.removeAttribute('data-flash'))
    return () => {
      id()
      el.removeAttribute('data-flash')
    }
  }, [row, shown, jumps])

  const searchButton = search && (
    <IconButton
      icon={Search}
      label="Search settings"
      size="lg"
      data-icon-only
      pressed={searching}
      onClick={() => {
        if (searching) setQuery('')
        setSearching(!searching)
      }}
    />
  )
  const closeButton = (
    <IconButton icon={X} label={closeTitle} size="lg" data-icon-only onClick={onClose} />
  )
  const results = query.trim() !== '' && <Results hits={hits} onPick={pick} />
  const named = heading !== undefined && !!headingName

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
          <Surface
            pad="sm"
            inset="bar"
            tone="plain"
            radius="none"
            border="bottom"
            place="shrink-0 md:hidden"
          >
            <Row gap="2xs">
              {closeButton}
              <span className="min-w-0 flex-1 truncate font-medium">{title}</span>
              {actor}
              {searchButton}
            </Row>
          </Surface>
          {(header === undefined || search) && (
            <Surface pad="lg" gap="2xs" tone="plain" place="hidden shrink-0 md:flex">
              {header === undefined && (
                <Surface pad="md" inset="bar" tone="plain">
                  <p className="text-xs font-medium tracking-wide text-on-surface-variant uppercase">
                    {title}
                  </p>
                </Surface>
              )}
              {search && (
                <SearchField
                  query={query}
                  setQuery={setQuery}
                  onEnter={enter}
                  fieldRef={wideField}
                />
              )}
            </Surface>
          )}
          {search && searching && (
            <Surface pad="md" tone="plain" place="shrink-0 md:hidden">
              <SearchField query={query} setQuery={setQuery} onEnter={enter} fieldRef={listField} />
            </Surface>
          )}
          {header !== undefined && (
            <Inset pad="lg" inset="bar" place={results ? 'shrink-0 hidden md:flex' : 'shrink-0'}>
              {header}
            </Inset>
          )}
          <div className="min-h-0 flex-1 overflow-y-auto">
            <Inset pad="lg" inset="bar" safe>
              {results && <div className="md:hidden">{results}</div>}
              <Stack gap="md" place={results ? 'hidden md:flex' : undefined}>
                {summary && <div className="md:hidden">{summary}</div>}
                <Stack
                  as="nav"
                  gap="lg"
                  aria-label={title}
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
                  {navRuns(sections).map(run => (
                    <Stack key={run.entries[0].id} gap="2xs">
                      {run.heading !== undefined && (
                        <Surface pad="md" inset="bar" tone="plain">
                          <p className="text-xs font-medium tracking-wide text-on-surface-variant uppercase">
                            {run.heading}
                          </p>
                        </Surface>
                      )}
                      {run.entries.map(({ id, label, icon: Icon, rows, outline }) => {
                        const parts = outline && shown === id ? (rows ?? []) : []
                        const open = parts.length > 1 && folded !== id
                        const entry = (
                          <ListRow
                            data-settings-section={id}
                            tone="muted"
                            icon={Icon}
                            label={label}
                            chevron="narrow"
                            current={currentEntry(id, { shown, active, wide }) && 'page'}
                            onClick={() => onSection(id)}
                            place="flex-1"
                          />
                        )
                        const fold = open
                          ? `Hide the parts of ${label}`
                          : `Show the parts of ${label}`
                        return (
                          <Fragment key={id}>
                            {parts.length > 1 ? (
                              <Row gap="2xs">
                                {entry}
                                <IconButton
                                  icon={open ? ChevronUp : ChevronDown}
                                  label={fold}
                                  data-icon-only
                                  aria-expanded={open}
                                  onClick={() => setFolded(open ? id : null)}
                                  place="hidden md:inline-flex"
                                />
                              </Row>
                            ) : (
                              entry
                            )}
                            {open && (
                              <Inset pad="lg" inset="sides" place="hidden md:flex">
                                <div className="border-l border-outline-variant">
                                  <Surface pad="2xs" gap="3xs" tone="plain">
                                    {parts.map(part => (
                                      <ListRow
                                        key={part.id}
                                        data-settings-part={part.id}
                                        tone="muted"
                                        label={part.label}
                                        onClick={() => jump(id, part.id)}
                                      />
                                    ))}
                                  </Surface>
                                </div>
                              </Inset>
                            )}
                          </Fragment>
                        )
                      })}
                    </Stack>
                  ))}
                </Stack>
              </Stack>
            </Inset>
          </div>
        </div>
        <div
          className={`${active === null ? 'hidden' : 'flex'} min-h-0 min-w-0 flex-1 flex-col md:flex`}
        >
          <Surface
            pad="sm"
            inset="bar"
            tone="plain"
            radius="none"
            border="bottom"
            place="shrink-0 md:hidden"
          >
            <Row gap="2xs">
              {(onBack || !single) && (
                <IconButton
                  ref={back}
                  icon={ArrowLeft}
                  label="Back"
                  size="lg"
                  data-icon-only
                  onClick={onBack ?? (() => onSection(null))}
                />
              )}
              <Covered what="title" on={named} look="min-w-0 flex-1 truncate font-medium">
                {heading ?? section?.label}
              </Covered>
              {actor}
              {searchButton}
              {closeButton}
            </Row>
          </Surface>
          {search && searching && (
            <Surface pad="md" tone="plain" place="shrink-0 md:hidden">
              <SearchField
                query={query}
                setQuery={setQuery}
                onEnter={enter}
                fieldRef={sectionField}
              />
            </Surface>
          )}
          <Inset
            row
            pad="xl"
            inset="sides"
            gap="md"
            border="bottom"
            look="h-16"
            place="hidden shrink-0 md:flex"
          >
            <Covered
              as="h1"
              what="title"
              on={named}
              look="min-w-0 flex-1 truncate text-xl font-medium"
            >
              {heading ?? section?.label}
            </Covered>
            {actor}
            {closeButton}
          </Inset>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <Inset pad="lg" safe>
              <Stack gap="lg" place="mx-auto max-w-3xl">
                {results}
                <div ref={playsOn('route', shown ?? '')}>
                  {lead}
                  {sections
                    .filter(s => kept.includes(s.id))
                    .map(s => (
                      <Stack key={s.id} data-section-body={s.id} hidden={s.id !== shown} gap="xl">
                        {s.render()}
                      </Stack>
                    ))}
                </div>
              </Stack>
            </Inset>
          </div>
        </div>
      </div>
    </Dialog>
  )
}
