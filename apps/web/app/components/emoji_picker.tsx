'use client'
import { useStoreApi } from '../lib/client/react'
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
  emojiSource,
  emojiWatch,
  frequent,
  gridMove,
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
import { IconButton, EmojiCell } from './controls'
import { Sheet, Popover } from './ui'
import { Stack, Surface, Inset, Grid } from './layout'
import { time } from '../lib/platform/time'
import { useLive } from '../lib/place/react'
import { Loaded, useLoad } from './loaded'

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

// The emoji data once it is here, for code that reads it outside what it draws (a key handler,
// a tooltip); null until then. While `wanted` it asks for the data.
export function useEmojiNow(wanted = true): Emoji[] | null {
  useLive(emojiWatch(wanted))
  return emojiData()
}

export function useTopEmojis(n: number) {
  const prefs = useStore(s => s.emoji)
  return useMemo(() => topEmojis(n, prefs), [n, prefs])
}

interface PickOptions {
  keepOpen: boolean
}

interface EmojiPickerProps {
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
      <Sheet
        height="half"
        overlay={{ ...guard, onClick: stop, 'data-popover': '' }}
        gripProps={handle}
        onClose={onClose}
        ref={rootRef}
        aria-label={label}
        style={
          dragY
            ? { transform: `translateY(${dragY}px)`, transition: 'none' }
            : { transition: 'transform 160ms ease-out' }
        }
      >
        {body}
      </Sheet>,
      document.body
    )
  }

  return createPortal(
    <Popover
      {...guard}
      onClick={stop}
      at={pos}
      size="picker"
      layer="top"
      ref={rootRef}
      aria-label={label}
    >
      {body}
    </Popover>,
    document.body
  )
}

interface BodyProps {
  sheet: boolean
  label: string
  onPick: (emoji: string, opts: PickOptions) => void
  onClose: () => void
}

function LoadingGrid({ sheet }: { sheet: boolean }) {
  const cols = sheet ? 8 : 9
  return (
    <Inset pad="md">
      <Grid
        aria-busy
        aria-label="Loading emoji"
        cols={1}
        gap="2xs"
        at={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
      >
        {Array.from({ length: cols * 6 }, (_, i) => (
          <div
            key={i}
            className="aspect-square animate-pulse rounded-lg bg-surface-container-highest/60"
          />
        ))}
      </Grid>
    </Inset>
  )
}

const PickerBody = memo(function PickerBody(props: BodyProps) {
  const { sheet, onClose } = props
  const load = useLoad(emojiSource())
  const here = load.status === 'ready'
  useEffect(() => {
    if (here) return
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape' || e.isComposing) return
      e.preventDefault()
      e.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [here, onClose])
  return (
    <Loaded
      load={load}
      what="emoji"
      hold={false}
      skeleton={<LoadingGrid sheet={sheet} />}
      empty="No emoji to show."
    >
      {data => <PickerGrid {...props} data={data} />}
    </Loaded>
  )
})

function PickerGrid({ sheet, label, onPick, onClose, data }: BodyProps & { data: Emoji[] }) {
  const store = useStoreApi()
  const uid = useId()
  const tone = useStore(s => s.emoji.tone)
  const noteEmoji = useStore(s => s.noteEmoji)
  const setSkinTone = useStore(s => s.setSkinTone)
  const [opened] = useState(() => ({ prefs: store.getState().emoji, now: time().now() }))
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
    <Surface
      aria-label="Emoji categories"
      as="nav"
      row={sheet}
      pad={sheet ? 'md' : '2xs'}
      inset={sheet ? 'bar' : 'even'}
      gap="3xs"
      tone={sheet ? 'plain' : 'base'}
      radius="none"
      justify={sheet ? 'between' : 'start'}
      align={sheet ? 'stretch' : 'center'}
      look={sheet ? '' : 'w-12 scrollbar-none'}
      place={sheet ? 'shrink-0' : 'shrink-0 overflow-y-auto'}
    >
      {CATEGORIES.filter(c => groups.some(g => g.id === c.id)).map(c => {
        const Icon = ICONS[c.id]
        const on = current === c.id
        return (
          <IconButton
            icon={Icon}
            label={c.label}
            key={c.id}
            aria-current={on ? 'true' : undefined}
            onClick={() => jump(c.id)}
            place={sheet ? 'flex-1' : undefined}
          />
        )
      })}
    </Surface>
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
          style={{
            contentVisibility: 'auto',
            containIntrinsicHeight: `${sectionHeight(g.items.length, cols, cell, HEADER)}px`,
          }}
        >
          <Inset
            aria-hidden
            row
            pad="sm"
            inset="sides"
            look="h-7.5 bg-surface-container-high/95 text-xs font-medium tracking-wide text-on-surface-variant uppercase backdrop-blur-sm"
            place="sticky top-0 z-raised"
          >
            {g.label}
          </Inset>
          <div className="grid" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
            {g.items.map((e, i) => (
              <EmojiCell
                key={e.emoji}
                id={`${uid}-${s}-${i}`}
                data-cell=""
                data-s={s}
                data-i={i}
                label={e.name}
                touch={sheet}
              >
                {withTone(e, tone)}
              </EmojiCell>
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

  const hasGrid = groups.some(g => g.items.length > 0)
  let content: ReactNode
  if (!hasGrid) {
    content = (
      <Surface tone="plain" radius="none" pad="xl" place="h-full">
        <Stack gap="sm" align="center" justify="center" place="flex-1">
          <SearchX size={36} className="text-on-surface-variant" />
          <p className="text-center text-sm font-medium text-on-surface">No emoji found</p>
          <p className="text-center text-xs text-on-surface-variant">Try a different word.</p>
        </Stack>
      </Surface>
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
      <Inset row pad="md" inset={sheet ? 'bar' : 'even'} gap="sm" place="shrink-0">
        <Surface
          pad="md"
          inset="sides"
          gap="sm"
          row
          tone="highest"
          radius="full"
          look="h-10 focus-within:ring-2 focus-within:ring-primary"
          place="min-w-0 flex-1"
        >
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
            <IconButton
              icon={X}
              label="Clear search"
              size="sm"
              onClick={() => {
                setQuery('')
                setActive(null)
                if (!sheet) searchRef.current?.focus()
              }}
            />
          )}
        </Surface>
        <div className="relative shrink-0">
          <IconButton
            aria-haspopup="menu"
            aria-expanded={toneOpen}
            onClick={() => setToneOpen(o => !o)}
            glyph={toneHand(tone)}
            label="Skin tone"
            size="lg"
          >
            {toneHand(tone)}
          </IconButton>
          {toneOpen && (
            <Surface
              role="menu"
              aria-label="Skin tone"
              pad="2xs"
              gap="3xs"
              tone="highest"
              radius="hero"
              elevation={2}
              place="absolute top-full right-0 z-float translate-y-1"
            >
              {TONE_NAMES.map((name, t) => (
                <IconButton
                  key={t}
                  role="menuitemradio"
                  aria-checked={t === tone}
                  onClick={() => {
                    setSkinTone(t)
                    setToneOpen(false)
                    if (!sheet) searchRef.current?.focus()
                  }}
                  glyph={toneHand(t)}
                  label={name}
                  size="lg"
                />
              ))}
            </Surface>
          )}
        </div>
      </Inset>
      {sheet && rail}
      <div className="flex min-h-0 flex-1">
        {!sheet && rail}
        <div
          ref={scrollRef}
          onScroll={onScroll}
          className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain"
        >
          <Inset pad="sm" inset="sides">
            {content}
          </Inset>
        </div>
      </div>
      {!sheet && (
        <Surface
          row
          pad="lg"
          inset="sides"
          gap="md"
          tone="base"
          radius="none"
          look="h-14 border-t border-outline-variant/60"
          place="shrink-0"
        >
          {preview && (
            <>
              <span aria-hidden className="font-emoji text-3xl leading-none">
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
        </Surface>
      )}
    </>
  )
}
