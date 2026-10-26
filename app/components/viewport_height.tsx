'use client'

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { ArrowDown, LoaderCircle, X } from 'lucide-react'
import { useStore, type Focus } from '../lib/store'

const editable = 'input, textarea, select, [contenteditable]'
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
      if (shrank && active instanceof HTMLElement && active.matches(editable))
        active.scrollIntoView({ block: 'nearest' })
    }
    sync()
    vv.addEventListener('resize', sync)
    return () => vv.removeEventListener('resize', sync)
  }, [])
  return null
}

export function usePinnedBottom(
  ref: RefObject<HTMLElement | null>,
  pinned: RefObject<boolean>,
  key: unknown
) {
  useEffect(() => {
    const el = ref.current
    if (!el) return
    let height = el.clientHeight
    const ro = new ResizeObserver(() => {
      if (el.clientHeight === height) return
      height = el.clientHeight
      if (pinned.current) el.scrollTop = el.scrollHeight
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref, pinned, key])
}

const offsetIn = (el: HTMLElement, id: number) => {
  const node = el.querySelector(`[data-mid="${id}"]`)
  return node ? node.getBoundingClientRect().top - el.getBoundingClientRect().top : null
}

export function usePrependAnchor(ref: RefObject<HTMLElement | null>, firstId: number | undefined) {
  const anchor = useRef<{ id: number; top: number } | null>(null)
  useLayoutEffect(() => {
    const el = ref.current
    const a = anchor.current
    if (!el || !a || a.id === firstId) return
    anchor.current = null
    const top = offsetIn(el, a.id)
    if (top !== null) el.scrollTop += top - a.top
  }, [ref, firstId])
  return useCallback(() => {
    const el = ref.current
    if (!el || firstId === undefined) return
    const top = offsetIn(el, firstId)
    anchor.current = top === null ? null : { id: firstId, top }
  }, [ref, firstId])
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

export const EDGE_MARGIN = 200

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

export const scrollToMessage = (list: HTMLElement, id: number | null) => {
  if (id === null) {
    list.scrollTop = list.scrollHeight
    return true
  }
  const rows = [...list.querySelectorAll<HTMLElement>('[data-mid]')]
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

export function PresentBar({ onJump }: { onJump: () => void }) {
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-3 z-10 flex justify-center">
      <button
        onClick={onJump}
        className="pointer-events-auto flex items-center gap-1.5 rounded-full bg-primary px-3 py-1.5 text-xs font-medium text-on-primary shadow-elevation-2 hover:opacity-90"
      >
        <ArrowDown size={14} />
        Jump to present
      </button>
    </div>
  )
}
