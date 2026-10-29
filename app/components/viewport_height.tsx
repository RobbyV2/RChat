'use client'

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { ArrowDown, LoaderCircle, X } from 'lucide-react'
import { useStore, type Focus } from '../lib/store'
import {
  EDITABLE,
  FOLLOWING,
  nearBottom,
  pillStep,
  placed,
  scrolled,
  upKey,
  userScrolling,
  type Follow,
  type Pill,
  type PillEvent,
} from '../lib/follow'

const KEYBOARD_MIN = 120

export default function ViewportHeight() {
  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return
    const root = document.documentElement
    let last = 0
    const sync = () => {
      const h = Math.round(vv.height * vv.scale)
      root.toggleAttribute('data-keyboard', window.innerHeight - h > KEYBOARD_MIN)
      if (h === last) return
      const grew = last > 0 && h > last
      const shrank = last > 0 && h < last
      last = h
      root.style.setProperty('--app-height', `${h}px`)
      if (grew && root.scrollHeight <= window.innerHeight + 1) window.scrollTo(0, 0)
      const active = document.activeElement
      if (shrank && active instanceof HTMLElement && active.matches(EDITABLE))
        active.scrollIntoView({ block: 'nearest' })
    }
    sync()
    vv.addEventListener('resize', sync)
    return () => vv.removeEventListener('resize', sync)
  }, [])
  return null
}

export const ROW = '[data-row]'

const offsetIn = (el: HTMLElement, id: number) => {
  const node = el.querySelector(`[data-row][data-mid="${id}"]`)
  return node ? node.getBoundingClientRect().top - el.getBoundingClientRect().top : null
}

const firstVisible = (el: HTMLElement) => {
  const box = el.getBoundingClientRect()
  const rows = el.querySelectorAll<HTMLElement>(ROW)
  let lo = 0
  let hi = rows.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (rows[mid].getBoundingClientRect().bottom > box.top) hi = mid
    else lo = mid + 1
  }
  const node = rows[lo]
  if (!node) return null
  return { id: Number(node.dataset.mid), top: node.getBoundingClientRect().top - box.top }
}

export function useChatScroll(opts: {
  list: RefObject<HTMLElement | null>
  content: RefObject<HTMLElement | null>
  scope: string | null
  count: number
  lastId: number | undefined
  stale: boolean
  focus: boolean
  detached: boolean
  outCount: number
  onBottom: () => void
}) {
  const { list, content, scope, count, lastId, stale, focus, detached, outCount } = opts
  const setAtBottom = useStore(s => s.setAtBottom)
  const [pill, setPill] = useState<Pill>({ scope, ready: null, left: null })
  const step = useCallback((e: PillEvent) => setPill(p => pillStep(p, e)), [])
  if (pill.scope !== scope) setPill(p => pillStep(p, { kind: 'scope', scope }))
  const follow = useRef<Follow>(FOLLOWING)
  const anchor = useRef<{ id: number; top: number } | null>(null)
  const input = useRef({ touching: false, at: -Infinity })
  const sent = useRef<{ scope: string | null; n: number }>({ scope: null, n: 0 })
  const live = useRef({ ...opts, positioned: false })
  const positioned = scope !== null && pill.ready === scope

  useLayoutEffect(() => {
    live.current = { ...opts, positioned }
  })

  useLayoutEffect(() => {
    follow.current = FOLLOWING
    anchor.current = null
    if (scope) setAtBottom(scope, true)
  }, [scope, setAtBottom])

  const apply = useCallback(
    (next: Follow) => {
      const prev = follow.current
      follow.current = next
      const key = live.current.scope
      if (next.following === prev.following || !key) return
      setAtBottom(key, next.following)
      step({
        kind: 'follow',
        scope: key,
        following: next.following,
        lastId: live.current.lastId ?? 0,
      })
    },
    [setAtBottom, step]
  )

  const settle = useCallback(() => {
    const el = list.current
    if (!el || !live.current.scope) return
    apply(placed(el, live.current.detached))
    anchor.current = firstVisible(el)
    if (nearBottom(el)) live.current.onBottom()
  }, [list, apply])

  const toBottom = useCallback(() => {
    const el = list.current
    if (!el) return
    el.scrollTop = el.scrollHeight
    settle()
    step({ kind: 'bottom' })
  }, [list, settle, step])

  useLayoutEffect(() => {
    const el = list.current
    if (!el || !scope || positioned || !count || stale) return
    if (!focus) {
      const divider = el.querySelector<HTMLElement>('[data-divider]')
      el.scrollTop = divider
        ? Math.max(
            0,
            divider.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop - 48
          )
        : el.scrollHeight
      settle()
    }
    step({ kind: 'ready', scope })
  }, [list, scope, positioned, count, stale, focus, settle, step])

  useLayoutEffect(() => {
    const grew = sent.current.scope === scope && outCount > sent.current.n
    sent.current = { scope, n: outCount }
    const el = list.current
    if (!el || !positioned || focus || detached) return
    if (grew && !follow.current.following) apply({ following: true, top: el.scrollTop })
    if (follow.current.following) el.scrollTop = el.scrollHeight
  }, [list, positioned, scope, count, lastId, outCount, focus, detached, apply])

  useEffect(() => {
    const el = list.current
    const inner = content.current
    if (!el || !inner) return
    const ro = new ResizeObserver(() => {
      const cur = live.current
      if (!cur.positioned) return
      if (follow.current.following && !cur.detached) {
        el.scrollTop = el.scrollHeight
        return
      }
      const a = anchor.current
      const top = a ? offsetIn(el, a.id) : null
      if (a && top !== null && Math.abs(top - a.top) >= 1) el.scrollTop += top - a.top
    })
    ro.observe(el)
    ro.observe(inner)
    const mark = () => {
      input.current.at = performance.now()
    }
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < 0) mark()
    }
    const onKey = (e: KeyboardEvent) => {
      if (upKey(e.key, e.shiftKey)) mark()
    }
    const onTouch = (e: TouchEvent) => {
      input.current.touching = e.type !== 'touchend' && e.type !== 'touchcancel'
      mark()
    }
    const onPointer = (e: PointerEvent) => {
      if (e.target === el) mark()
    }
    el.addEventListener('wheel', onWheel, { passive: true })
    el.addEventListener('keydown', onKey)
    el.addEventListener('pointerdown', onPointer)
    for (const t of ['touchstart', 'touchmove', 'touchend', 'touchcancel'] as const)
      el.addEventListener(t, onTouch, { passive: true })
    return () => {
      ro.disconnect()
      el.removeEventListener('wheel', onWheel)
      el.removeEventListener('keydown', onKey)
      el.removeEventListener('pointerdown', onPointer)
      for (const t of ['touchstart', 'touchmove', 'touchend', 'touchcancel'] as const)
        el.removeEventListener(t, onTouch)
    }
  }, [list, content, scope])

  const onScroll = useCallback(() => {
    const el = list.current
    const cur = live.current
    if (!el || !cur.scope || !cur.positioned) return
    const { touching, at } = input.current
    apply(
      scrolled(follow.current, el, userScrolling(touching, at, performance.now()), cur.detached)
    )
    anchor.current = firstVisible(el)
    if (nearBottom(el)) cur.onBottom()
  }, [list, apply])

  return {
    positioned,
    leftAt: pill.scope === scope ? pill.left : null,
    settle,
    toBottom,
    onScroll,
  }
}

export function useScrollAnchor(
  ref: RefObject<HTMLElement | null>,
  firstId: number | undefined,
  busy = false
) {
  const anchor = useRef<{ id: number; top: number } | null>(null)
  useLayoutEffect(() => {
    const el = ref.current
    const a = anchor.current
    if (!el || !a) return
    const top = offsetIn(el, a.id)
    if (top === null) return
    anchor.current = null
    el.scrollTop += top - a.top
  }, [ref, firstId])
  useLayoutEffect(() => {
    if (!busy) anchor.current = null
  }, [busy])
  return useCallback(() => {
    const el = ref.current
    if (el) anchor.current = firstVisible(el)
  }, [ref])
}

export function OlderLoading({ newer = false }: { newer?: boolean }) {
  return (
    <div
      className={`pointer-events-none absolute inset-x-0 z-10 flex justify-center ${newer ? 'bottom-2' : 'top-2'}`}
    >
      <span
        role="status"
        className="flex items-center gap-1.5 rounded-full bg-surface-container-high px-3 py-1 text-xs text-on-surface-variant shadow-elevation-1"
      >
        <LoaderCircle size={14} className="animate-spin" />
        {newer ? 'Loading newer messages' : 'Loading older messages'}
      </span>
    </div>
  )
}

const EDGE_MARGIN = 200

export function EdgeSentinel({
  root,
  edge,
  onVisible,
}: {
  root: RefObject<HTMLElement | null>
  edge: 'top' | 'bottom'
  onVisible: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const latest = useRef(onVisible)
  useEffect(() => {
    latest.current = onVisible
  })
  useEffect(() => {
    const el = ref.current
    const scroller = root.current
    if (!el || !scroller) return
    const margin = edge === 'top' ? `${EDGE_MARGIN}px 0px 0px 0px` : `0px 0px ${EDGE_MARGIN}px 0px`
    const observer = new IntersectionObserver(
      entries => {
        if (entries.some(e => e.isIntersecting)) latest.current()
      },
      { root: scroller, rootMargin: margin }
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [root, edge])
  return <div ref={ref} aria-hidden className="h-px" />
}

const scrollToMessage = (list: HTMLElement, id: number | null) => {
  if (id === null) {
    list.scrollTop = list.scrollHeight
    return true
  }
  const rows = [...list.querySelectorAll<HTMLElement>(ROW)]
  const node = rows.find(r => Number(r.dataset.mid) >= id) ?? rows[rows.length - 1]
  if (!node) return false
  const box = list.getBoundingClientRect()
  const at = node.getBoundingClientRect()
  list.scrollTop += at.top - box.top - Math.max(0, (list.clientHeight - at.height) / 2)
  return true
}

export function useFocusMessage(
  list: RefObject<HTMLElement | null>,
  key: string | null,
  focus: Focus | undefined,
  deps: unknown,
  settle: () => void
) {
  const clearFocus = useStore(s => s.clearFocus)
  const [flash, setFlash] = useState<number | null>(null)
  const after = useRef(settle)
  useEffect(() => {
    after.current = settle
  })
  useLayoutEffect(() => {
    const el = list.current
    if (!el || !key || !focus) return
    if (!scrollToMessage(el, focus.id)) return
    clearFocus(key)
    after.current()
    if (focus.flash && focus.id !== null) setFlash(focus.id)
  }, [list, key, focus, deps, clearFocus])
  useEffect(() => {
    if (flash === null) return
    const t = setTimeout(() => setFlash(null), 2200)
    return () => clearTimeout(t)
  }, [flash])
  return flash
}

export function UnreadBar({ onJump, onDismiss }: { onJump: () => void; onDismiss: () => void }) {
  return (
    <div className="absolute inset-x-0 top-0 z-10 flex items-center gap-2 bg-primary-container px-4 py-1.5 text-xs text-on-primary-container shadow-elevation-1">
      <button onClick={onJump} className="min-w-0 flex-1 truncate text-left font-medium">
        New messages above · Jump to first unread
      </button>
      <button
        title="Mark as read"
        onClick={onDismiss}
        className="shrink-0 rounded-full p-1 hover:bg-on-primary-container/10"
      >
        <X size={14} />
      </button>
    </div>
  )
}

export function PresentBar({ onJump, count = 0 }: { onJump: () => void; count?: number }) {
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-3 z-10 flex justify-center">
      <button
        onClick={onJump}
        className="pointer-events-auto flex items-center gap-1.5 rounded-full bg-primary px-3 py-1.5 text-xs font-medium text-on-primary shadow-elevation-2 hover:opacity-90"
      >
        <ArrowDown size={14} />
        {count > 0 ? `${count} new ${count === 1 ? 'message' : 'messages'}` : 'Jump to present'}
      </button>
    </div>
  )
}
