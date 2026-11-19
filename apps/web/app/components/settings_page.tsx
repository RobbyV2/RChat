'use client'

import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { ArrowLeft, ChevronRight, Search, X, type LucideIcon } from 'lucide-react'
import {
  focusesSearch,
  navKey,
  pageEscape,
  rowAnchor,
  shownSection,
  tabWrap,
} from '../lib/settings_page'
import { searchRows, type SearchHit, type SearchRow } from '../lib/settings_search'
import { useEscape } from './ui'

export interface PageSection {
  id: string
  label: string
  icon: LucideIcon
  // What search finds in this section.
  rows?: SearchRow[]
  render: () => ReactNode
}

const barBtn =
  'flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface'

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])'

const shows = (el: Element | null): el is HTMLElement =>
  el instanceof HTMLElement && el.offsetParent !== null

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
  return (
    <div
      id={rowAnchor(id)}
      data-setting-row
      className={`scroll-mt-4 rounded-xl transition-colors duration-500 data-[flash]:bg-secondary-container ${className}`}
    >
      {children}
    </div>
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
          className="-mr-1.5 shrink-0 rounded-full p-1.5 text-on-surface-variant hover:bg-surface-container-high"
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

// A full page of settings over the app: sections on the left and one section's content on wide
// screens; on narrow ones the list of sections, then a section as its own screen.
export function SettingsPage({
  title,
  sections,
  active,
  onSection,
  onClose,
  onBack,
  heading,
  row = null,
  summary,
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
  // The row to scroll to and flash.
  row?: string | null
  // Shown above the list of sections on narrow screens.
  summary?: ReactNode
  search?: boolean
}) {
  const titleId = useId()
  const root = useRef<HTMLDivElement>(null)
  const back = useRef<HTMLButtonElement>(null)
  const wideField = useRef<HTMLInputElement>(null)
  const listField = useRef<HTMLInputElement>(null)
  const sectionField = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const shown = shownSection(sections, active)
  const section = sections.find(s => s.id === shown) ?? null
  const hits = useMemo(() => searchRows(sections, query), [sections, query])

  const pick = (hit: SearchHit) => {
    setQuery('')
    setSearching(false)
    onSection(hit.row.section, hit.row.id)
  }
  const enter = () => {
    if (hits[0]) pick(hits[0])
  }
  const screen = active === null ? 'list' : 'section'

  useEscape(() => {
    if (pageEscape(query) === 'clear') setQuery('')
    else onClose()
  }, 'page')

  // Focus goes back to where it was when the page closes.
  useEffect(() => {
    const opener = document.activeElement
    return () => {
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus()
    }
  }, [])

  // Focus moves into the page when it opens, and to the new screen when the one it was on hides:
  // the open section in the nav, else the back arrow.
  useEffect(() => {
    const el = root.current
    if (!el) return
    const at = document.activeElement
    if (at !== el && el.contains(at) && shows(at)) return
    const current = el.querySelector('nav [aria-current="page"]')
    const start = shows(current) ? current : shows(back.current) ? back.current : el
    start.focus({ preventScroll: true })
  }, [screen, heading])

  // Tab stays inside the page while it is the top one.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = root.current
      if (e.key !== 'Tab' || e.defaultPrevented || !el) return
      const at = document.activeElement
      const inside = at !== null && el.contains(at)
      if (!inside && at !== null && at !== document.body) return
      const modals = document.querySelectorAll('[aria-modal="true"]')
      if (modals[modals.length - 1] !== el) return
      const all = focusables(el)
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
      const modals = document.querySelectorAll('[aria-modal="true"]')
      if (modals[modals.length - 1] !== root.current) return
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
    el.scrollIntoView({ block: 'center' })
    el.setAttribute('data-flash', '')
    const id = window.setTimeout(() => el.removeAttribute('data-flash'), 1600)
    return () => {
      window.clearTimeout(id)
      el.removeAttribute('data-flash')
    }
  }, [row, shown])

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
  const results = query.trim() !== '' && <Results hits={hits} onPick={pick} />

  return (
    <div
      ref={root}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      tabIndex={-1}
      data-settings-page
      data-screen={screen}
      className="fixed inset-x-0 top-app z-40 flex h-app flex-col bg-surface px-safe text-on-surface outline-none md:flex-row"
    >
      <div
        className={`${active === null ? 'flex' : 'hidden'} min-h-0 flex-1 flex-col md:flex md:w-64 md:flex-none md:border-r md:border-outline-variant md:bg-surface-container-low`}
      >
        <div className="flex h-14 shrink-0 items-center gap-1 border-b border-outline-variant px-2 md:hidden">
          <button
            type="button"
            data-icon-only
            title="Close"
            aria-label="Close"
            onClick={onClose}
            className={barBtn}
          >
            <X size={20} />
          </button>
          <span className="min-w-0 flex-1 truncate px-1 font-medium">{title}</span>
          {searchButton}
        </div>
        <p
          id={titleId}
          className="hidden px-7 pt-6 pb-3 text-xs font-medium tracking-wide text-on-surface-variant uppercase md:block"
        >
          {title}
        </p>
        {search && (
          <>
            <SearchField
              query={query}
              setQuery={setQuery}
              onEnter={enter}
              fieldRef={wideField}
              className="mx-4 mb-3 hidden md:flex"
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
        <div className="min-h-0 flex-1 overflow-y-auto px-3 pt-3 pb-[max(1rem,env(safe-area-inset-bottom))] md:px-4 md:pt-0">
          {results && <div className="md:hidden">{results}</div>}
          <div className={results ? 'hidden md:block' : ''}>
            {summary && <div className="pb-3 md:hidden">{summary}</div>}
            <nav
              aria-label={title}
              className="flex flex-col gap-1"
              onKeyDown={e => {
                const buttons = [...e.currentTarget.querySelectorAll('button')]
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
              {sections.map(({ id, label, icon: Icon }) => (
                <button
                  key={id}
                  type="button"
                  aria-current={shown === id ? 'page' : undefined}
                  onClick={() => onSection(id)}
                  className={`flex min-h-11 w-full min-w-0 items-center gap-3 rounded-xl px-3 py-2 text-left text-sm md:min-h-0 ${
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
              ))}
            </nav>
          </div>
        </div>
      </div>
      <div
        className={`${active === null ? 'hidden' : 'flex'} min-h-0 min-w-0 flex-1 flex-col md:flex`}
      >
        <div className="flex h-14 shrink-0 items-center gap-1 border-b border-outline-variant px-2 md:hidden">
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
          <span className="min-w-0 flex-1 truncate px-1 font-medium">
            {heading ?? section?.label}
          </span>
          {searchButton}
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
        <div className="hidden shrink-0 items-center gap-3 px-10 pt-6 pb-2 md:flex">
          <h1 className="min-w-0 flex-1 truncate text-xl font-medium">
            {heading ?? section?.label}
          </h1>
          <button
            type="button"
            data-icon-only
            title="Close"
            aria-label="Close"
            onClick={onClose}
            className="shrink-0 rounded-full border border-outline-variant p-2 text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface"
          >
            <X size={18} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pt-4 pb-[max(1.5rem,env(safe-area-inset-bottom))] md:px-10 md:pt-2 md:pb-10">
          <div className="max-w-2xl">
            {results}
            {section?.render()}
          </div>
        </div>
      </div>
    </div>
  )
}
