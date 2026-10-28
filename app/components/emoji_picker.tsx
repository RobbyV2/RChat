'use client'

import {
  memo,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type TouchEvent as ReactTouchEvent,
} from 'react'
import { createPortal } from 'react-dom'
import {
  Car,
  Clock,
  Flag,
  Gamepad2,
  Heart,
  Leaf,
  Lightbulb,
  Pizza,
  Search,
  SearchX,
  Smile,
  X,
} from 'lucide-react'
import { useStore } from '../lib/store'
import {
  CATEGORIES,
  DEFAULT_TOP,
  boostFor,
  emojiData,
  frequent,
  gridMove,
  loadEmojiData,
  searchEmoji,
  sectionHeight,
  sections,
  shortcodeOf,
  topEmojis,
  withTone,
  type CategoryId,
  type Emoji,
  type GridKey,
  type GridPos,
} from '../lib/emoji'
import { placePopover, type Align, type Side } from '../lib/autocomplete'
import { useMedia } from './context_menu'

export const SHEET_QUERY = '(pointer: coarse), (max-width: 639px)'

const ICONS: Record<CategoryId, typeof Smile> = {
  recent: Clock,
  people: Smile,
  nature: Leaf,
  food: Pizza,
  activities: Gamepad2,
  travel: Car,
  objects: Lightbulb,
  symbols: Heart,
  flags: Flag,
}

const TONE_NAMES = [
  'Default',
  'Light skin tone',
  'Medium-light skin tone',
  'Medium skin tone',
  'Medium-dark skin tone',
  'Dark skin tone',
]

const HAND = '✋'
const toneHand = (tone: number) => (tone === 0 ? HAND : HAND + String.fromCodePoint(0x1f3fa + tone))

const ARROWS: Record<string, GridKey> = {
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ArrowUp: 'up',
  ArrowDown: 'down',
}

const CELL = 40
const SHEET_CELL = 46
const FREQUENT_ROWS = 2
const HEADER = 30
const DRAG_CLOSE = 96

export function useEmojiData(enabled = true) {
  const [data, setData] = useState<Emoji[] | null>(emojiData)
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (!enabled || data) return
    let live = true
    loadEmojiData().then(
      d => live && setData(d),
      () => live && setFailed(true)
    )
    return () => {
      live = false
    }
  }, [enabled, data, attempt])
  const retry = () => {
    setFailed(false)
    setAttempt(a => a + 1)
  }
  return { data, failed, retry }
}

export function useTopEmojis(n: number) {
  const prefs = useStore(s => s.emoji)
  return useMemo(() => topEmojis(n, prefs), [n, prefs])
}

export interface PickOptions {
  keepOpen: boolean
}

export interface EmojiPickerProps {
  anchor: HTMLElement | null
  onPick: (emoji: string, opts: PickOptions) => void
  onClose: () => void
  side?: Side
  align?: Align
  label?: string
}

interface Group {
  id: CategoryId | 'search'
  label: string
  items: Emoji[]
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

const stop = (e: { stopPropagation: () => void }) => e.stopPropagation()

export function EmojiPicker({
  anchor,
  onPick,
  onClose,
  side = 'top',
  align = 'end',
  label = 'Emoji picker',
}: EmojiPickerProps) {
  const sheet = useMedia(SHEET_QUERY)
  const rootRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const [dragY, setDragY] = useState<number | null>(null)
  const dragFrom = useRef(0)
  const closeRef = useRef(onClose)
  const pickRef = useRef(onPick)
  useEffect(() => {
    closeRef.current = onClose
    pickRef.current = onPick
  })

  useLayoutEffect(() => {
    if (sheet) {
      const active = document.activeElement
      if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) active.blur()
      return
    }
    const place = () => {
      const el = rootRef.current
      if (!el) return
      const vw = window.innerWidth
      const vh = window.innerHeight
      const r = anchor?.getBoundingClientRect() ?? {
        top: vh / 2,
        bottom: vh / 2,
        left: vw / 2 + el.offsetWidth / 2,
        right: vw / 2 + el.offsetWidth / 2,
      }
      const next = placePopover(
        r,
        { width: el.offsetWidth, height: el.offsetHeight },
        { width: vw, height: vh },
        side,
        align
      )
      setPos(cur => (cur && cur.top === next.top && cur.left === next.left ? cur : next))
    }
    const onScroll = (e: Event) => {
      if (!(e.target instanceof Node && rootRef.current?.contains(e.target))) place()
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [sheet, anchor, side, align])

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const t = e.target
      if (!(t instanceof Node)) return
      if (rootRef.current?.contains(t) || anchor?.contains(t)) return
      if (!sheet) closeRef.current()
    }
    document.addEventListener('pointerdown', onDown, true)
    return () => document.removeEventListener('pointerdown', onDown, true)
  }, [anchor, sheet])

  const [relay] = useState(() => ({
    pick: (e: string, o: PickOptions) => pickRef.current(e, o),
    close: () => closeRef.current(),
  }))

  const body = <PickerBody sheet={sheet} label={label} onPick={relay.pick} onClose={relay.close} />

  const guard = {
    onMouseDown: stop,
    onPointerDown: stop,
    onTouchStart: stop,
    onTouchMove: stop,
    onTouchEnd: stop,
    onContextMenu: (e: ReactMouseEvent) => {
      e.stopPropagation()
      if (sheet) e.preventDefault()
    },
    onKeyDown: stop,
  }

  if (sheet) {
    const handle = {
      onTouchStart: (e: ReactTouchEvent) => {
        dragFrom.current = e.touches[0].clientY
        setDragY(0)
      },
      onTouchMove: (e: ReactTouchEvent) => {
        if (dragY !== null) setDragY(Math.max(0, e.touches[0].clientY - dragFrom.current))
      },
      onTouchEnd: () => {
        if ((dragY ?? 0) > DRAG_CLOSE) onClose()
        setDragY(null)
      },
      onTouchCancel: () => setDragY(null),
    }
    return createPortal(
      <div
        {...guard}
        data-popover
        onClick={e => {
          e.stopPropagation()
          if (e.target === e.currentTarget) onClose()
        }}
        className="fixed inset-x-0 top-0 z-50 flex h-app flex-col justify-end bg-scrim/40"
      >
        <div
          ref={rootRef}
          role="dialog"
          aria-label={label}
          style={
            dragY
              ? { transform: `translateY(${dragY}px)`, transition: 'none' }
              : { transition: 'transform 160ms ease-out' }
          }
          className="flex h-[60%] min-h-80 animate-sheet-up flex-col overflow-hidden rounded-t-3xl bg-surface-container-high px-safe pb-[max(0.5rem,env(safe-area-inset-bottom))] shadow-elevation-3"
        >
          <div {...handle} className="flex shrink-0 touch-none justify-center pt-3 pb-2">
            <div aria-hidden className="h-1 w-8 rounded-full bg-outline-variant" />
          </div>
          {body}
        </div>
      </div>,
      document.body
    )
  }

  return createPortal(
    <div
      {...guard}
      onClick={stop}
      ref={rootRef}
      role="dialog"
      aria-label={label}
      data-popover
      style={pos ?? undefined}
      className={`fixed z-50 flex h-[27.5rem] max-h-[calc(100dvh-1rem)] w-[27.5rem] max-w-[calc(100vw-1rem)] flex-col overflow-hidden rounded-2xl bg-surface-container-high shadow-elevation-3 ${
        pos ? '' : 'pointer-events-none opacity-0'
      }`}
    >
      {body}
    </div>,
    document.body
  )
}

const PickerBody = memo(function PickerBody({
  sheet,
  label,
  onPick,
  onClose,
}: {
  sheet: boolean
  label: string
  onPick: (emoji: string, opts: PickOptions) => void
  onClose: () => void
}) {
  const uid = useId()
  const { data, failed, retry } = useEmojiData()
  const tone = useStore(s => s.emoji.tone)
  const noteEmoji = useStore(s => s.noteEmoji)
  const setSkinTone = useStore(s => s.setSkinTone)
  const [opened] = useState(() => ({ prefs: useStore.getState().emoji, now: Date.now() }))
  const [query, setQuery] = useState('')
  const [hover, setHover] = useState<Emoji | null>(null)
  const [active, setActive] = useState<GridPos | null>(null)
  const [current, setCurrent] = useState<Group['id']>('recent')
  const [toneOpen, setToneOpen] = useState(false)
  const [{ cols, cell }, setLayout] = useState(() => ({
    cols: sheet ? 8 : 9,
    cell: sheet ? SHEET_CELL : CELL,
  }))
  const searchRef = useRef<HTMLInputElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const sectionRefs = useRef<(HTMLElement | null)[]>([])
  const jumpTo = useRef<CategoryId | null>(null)
  const toneRef = useRef(toneOpen)
  useEffect(() => {
    toneRef.current = toneOpen
  })

  useEffect(() => {
    if (!sheet) searchRef.current?.focus({ preventScroll: true })
  }, [sheet])

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape' || e.isComposing) return
      e.preventDefault()
      e.stopPropagation()
      if (toneRef.current) setToneOpen(false)
      else onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const min = sheet ? SHEET_CELL : CELL
    const measure = () => {
      const width = el.clientWidth - 16
      const cols = Math.max(1, Math.floor(width / min))
      const cell = width / cols
      setLayout(cur => (cur.cols === cols && cur.cell === cell ? cur : { cols, cell }))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [sheet, data])

  const groups = useMemo<Group[]>(() => {
    if (!data) return []
    const q = query.trim()
    if (q) {
      return [
        {
          id: 'search',
          label: 'Search results',
          items: searchEmoji(data, q, boostFor(opened.prefs, opened.now)),
        },
      ]
    }
    const byBase = new Map(data.map(e => [e.emoji, e]))
    const used = frequent(opened.prefs, cols * FREQUENT_ROWS, opened.now)
    const recent = (used.length ? used : DEFAULT_TOP).flatMap(b => byBase.get(b) ?? [])
    const by = sections(data)
    return CATEGORIES.map(c => ({
      id: c.id,
      label: c.label,
      items: c.id === 'recent' ? recent : (by.get(c.id) ?? []),
    })).filter(g => g.items.length > 0)
  }, [data, query, cols, opened])

  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const id = jumpTo.current
    jumpTo.current = null
    const s = id ? groups.findIndex(g => g.id === id) : -1
    el.scrollTop = s > 0 ? (sectionRefs.current[s]?.offsetTop ?? 0) : 0
    setCurrent(s >= 0 ? groups[s].id : (groups[0]?.id ?? 'recent'))
  }, [groups.length, query])

  const item = (p: GridPos | null) => (p ? (groups[p.s]?.items[p.i] ?? null) : null)
  const first = groups[0]?.items[0] ?? null
  const preview = hover ?? item(active) ?? first

  const pick = (e: Emoji, keep: boolean) => {
    const picked = withTone(e, tone)
    noteEmoji(e.emoji, picked)
    onPick(picked, { keepOpen: keep })
    if (!keep) onClose()
  }

  const cellOf = (t: EventTarget) => {
    const el = t instanceof Element ? t.closest<HTMLElement>('[data-cell]') : null
    if (!el) return null
    const p = { s: Number(el.dataset.s), i: Number(el.dataset.i) }
    const e = item(p)
    return e ? { p, e } : null
  }

  const onScroll = () => {
    const el = scrollRef.current
    if (!el || query.trim()) return
    let s = 0
    sectionRefs.current.forEach((r, i) => {
      if (r && i < groups.length && r.offsetTop <= el.scrollTop + 4) s = i
    })
    const id = groups[s]?.id
    if (id && id !== current) setCurrent(id)
  }

  const jump = (id: CategoryId) => {
    if (query.trim()) {
      jumpTo.current = id
      setQuery('')
      return
    }
    const s = groups.findIndex(g => g.id === id)
    const el = scrollRef.current
    if (s < 0 || !el) return
    el.scrollTop = sectionRefs.current[s]?.offsetTop ?? 0
    setCurrent(id)
  }

  const move = (key: GridKey) => {
    const sizes = groups.map(g => g.items.length)
    if (!sizes.some(Boolean)) return
    const next = active ? gridMove(sizes, cols, active, key) : { s: 0, i: 0 }
    setActive(next)
    setHover(null)
    document
      .getElementById(`${uid}-${next.s}-${next.i}`)
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }

  const onSearchKey = (e: KeyboardEvent<HTMLInputElement>) => {
    const dir = ARROWS[e.key]
    if (dir) {
      e.preventDefault()
      move(dir)
      return
    }
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault()
      const target = item(active) ?? first
      if (target) pick(target, e.shiftKey)
    }
  }

  const rail = groups.length > 0 && !query.trim() && (
    <nav
      aria-label="Emoji categories"
      className={
        sheet
          ? 'flex shrink-0 justify-between gap-0.5 px-3 pb-2'
          : 'flex w-12 shrink-0 flex-col items-center gap-0.5 overflow-y-auto bg-surface-container py-2 [scrollbar-width:none]'
      }
    >
      {CATEGORIES.filter(c => groups.some(g => g.id === c.id)).map(c => {
        const Icon = ICONS[c.id]
        const on = current === c.id
        return (
          <button
            key={c.id}
            type="button"
            title={c.label}
            aria-label={c.label}
            aria-current={on ? 'true' : undefined}
            onClick={() => jump(c.id)}
            className={`flex shrink-0 items-center justify-center rounded-full transition-colors ${
              sheet ? 'h-10 max-w-14 min-w-0 flex-1' : 'h-8 w-8'
            } ${
              on
                ? 'bg-secondary-container text-on-secondary-container'
                : 'text-on-surface-variant hover:bg-surface-container-highest hover:text-on-surface'
            }`}
          >
            <Icon size={18} />
          </button>
        )
      })}
    </nav>
  )

  const grid = useMemo(
    () =>
      groups.map((g, s) => (
        <section
          key={g.id}
          ref={el => {
            sectionRefs.current[s] = el
          }}
          role="group"
          aria-label={g.label}
          className="pb-1"
          style={{
            contentVisibility: 'auto',
            containIntrinsicHeight: `${sectionHeight(g.items.length, cols, cell, HEADER)}px`,
          }}
        >
          <div
            aria-hidden
            className="sticky top-0 z-10 h-[30px] bg-surface-container-high/95 px-2 pt-2 pb-1.5 text-xs font-medium tracking-wide text-on-surface-variant uppercase backdrop-blur-sm"
          >
            {g.label}
          </div>
          <div className="grid" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
            {g.items.map((e, i) => (
              <button
                key={e.emoji}
                id={`${uid}-${s}-${i}`}
                type="button"
                role="option"
                tabIndex={-1}
                aria-selected={false}
                aria-label={e.name}
                data-cell=""
                data-s={s}
                data-i={i}
                className={`flex aspect-square scroll-mt-9 scroll-mb-1 items-center justify-center rounded-xl font-emoji leading-none select-none ${
                  sheet ? 'text-[30px] active:bg-surface-container-highest' : 'text-[26px]'
                } aria-selected:bg-secondary-container aria-selected:ring-2 aria-selected:ring-primary aria-selected:ring-inset aria-[selected=false]:hover:bg-surface-container-highest`}
              >
                <span className={sheet ? '' : 'transition-transform duration-100 hover:scale-110'}>
                  {withTone(e, tone)}
                </span>
              </button>
            ))}
          </div>
        </section>
      )),
    [groups, tone, cols, cell, sheet, uid]
  )

  useLayoutEffect(() => {
    const root = scrollRef.current
    if (!root) return
    for (const el of root.querySelectorAll('[aria-selected="true"]'))
      el.setAttribute('aria-selected', 'false')
    if (active)
      document
        .getElementById(`${uid}-${active.s}-${active.i}`)
        ?.setAttribute('aria-selected', 'true')
  }, [active, grid, uid])

  const hasGrid = !failed && !!data && groups.some(g => g.items.length > 0)
  let content: ReactNode
  if (failed) {
    content = (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-sm text-on-surface-variant">
        <p>Emoji could not load.</p>
        <button
          type="button"
          onClick={retry}
          className="rounded-full px-3 py-1.5 text-sm font-medium text-primary hover:bg-surface-container-highest"
        >
          Try again
        </button>
      </div>
    )
  } else if (!data) {
    content = (
      <div
        aria-label="Loading emoji"
        className="grid gap-1 p-2"
        style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
      >
        {Array.from({ length: cols * 6 }, (_, i) => (
          <div
            key={i}
            className="aspect-square animate-pulse rounded-lg bg-surface-container-highest/60"
          />
        ))}
      </div>
    )
  } else if (!hasGrid) {
    content = (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
        <SearchX size={36} className="text-on-surface-variant" />
        <p className="text-sm font-medium text-on-surface">No emoji found</p>
        <p className="text-xs text-on-surface-variant">Try a different word.</p>
      </div>
    )
  } else {
    content = (
      <div
        role="listbox"
        id={`${uid}-grid`}
        aria-label={label}
        onMouseMove={e => {
          const hit = cellOf(e.target)
          if (hit && hit.e !== hover) setHover(hit.e)
        }}
        onMouseLeave={() => setHover(null)}
        onClick={e => {
          const hit = cellOf(e.target)
          if (!hit) return
          setActive(hit.p)
          pick(hit.e, !sheet && e.shiftKey)
        }}
      >
        {grid}
      </div>
    )
  }

  return (
    <>
      <div className={`flex shrink-0 items-center gap-2 ${sheet ? 'px-3 pb-2' : 'p-3 pb-2'}`}>
        <div className="flex h-10 min-w-0 flex-1 items-center gap-2 rounded-full bg-surface-container-highest px-3 focus-within:ring-2 focus-within:ring-primary">
          <Search size={16} className="shrink-0 text-on-surface-variant" />
          <input
            ref={searchRef}
            value={query}
            onChange={e => {
              setQuery(e.target.value)
              setActive(e.target.value.trim() ? { s: 0, i: 0 } : null)
              setHover(null)
            }}
            onKeyDown={onSearchKey}
            placeholder="Search emoji"
            aria-label="Search emoji"
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={hasGrid}
            aria-controls={hasGrid ? `${uid}-grid` : undefined}
            aria-activedescendant={active ? `${uid}-${active.s}-${active.i}` : undefined}
            enterKeyHint="search"
            autoComplete="off"
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-on-surface-variant md:text-sm"
          />
          {query && (
            <button
              type="button"
              title="Clear search"
              aria-label="Clear search"
              onClick={() => {
                setQuery('')
                setActive(null)
                if (!sheet) searchRef.current?.focus()
              }}
              className="-mr-1 shrink-0 rounded-full p-1 text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface"
            >
              <X size={14} />
            </button>
          )}
        </div>
        <div className="relative shrink-0">
          <button
            type="button"
            title="Skin tone"
            aria-label="Skin tone"
            aria-haspopup="menu"
            aria-expanded={toneOpen}
            onClick={() => setToneOpen(o => !o)}
            className={`flex h-10 w-10 items-center justify-center rounded-full font-emoji text-[22px] leading-none ${
              toneOpen ? 'bg-surface-container-highest' : 'hover:bg-surface-container-highest'
            }`}
          >
            {toneHand(tone)}
          </button>
          {toneOpen && (
            <div
              role="menu"
              aria-label="Skin tone"
              className="absolute top-full right-0 z-20 mt-1 flex flex-col gap-0.5 rounded-3xl bg-surface-container-highest p-1 shadow-elevation-2"
            >
              {TONE_NAMES.map((name, t) => (
                <button
                  key={t}
                  type="button"
                  role="menuitemradio"
                  aria-checked={t === tone}
                  title={name}
                  aria-label={name}
                  onClick={() => {
                    setSkinTone(t)
                    setToneOpen(false)
                    if (!sheet) searchRef.current?.focus()
                  }}
                  className={`flex h-9 w-9 items-center justify-center rounded-full font-emoji text-[20px] leading-none ${
                    t === tone
                      ? 'bg-secondary-container ring-2 ring-primary ring-inset'
                      : 'hover:bg-surface-container-high'
                  }`}
                >
                  {toneHand(t)}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
      {sheet && rail}
      <div className="flex min-h-0 flex-1">
        {!sheet && rail}
        <div
          ref={scrollRef}
          onScroll={onScroll}
          className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain px-2"
        >
          {content}
        </div>
      </div>
      {!sheet && (
        <div className="flex h-14 shrink-0 items-center gap-3 border-t border-outline-variant/60 bg-surface-container px-4">
          {preview && (
            <>
              <span aria-hidden className="font-emoji text-[32px] leading-none">
                {withTone(preview, tone)}
              </span>
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-on-surface">
                  {capital(preview.name)}
                </p>
                <p className="truncate text-xs text-on-surface-variant">:{shortcodeOf(preview)}:</p>
              </div>
            </>
          )}
        </div>
      )}
    </>
  )
})
