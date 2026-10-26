'use client'

import { useCallback, useEffect, useLayoutEffect, useRef, type RefObject } from 'react'
import { LoaderCircle } from 'lucide-react'

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

export function OlderLoading() {
  return (
    <div className="pointer-events-none absolute inset-x-0 top-2 z-10 flex justify-center">
      <span
        role="status"
        className="flex items-center gap-1.5 rounded-full bg-surface-container-high px-3 py-1 text-xs text-on-surface-variant shadow-elevation-1"
      >
        <LoaderCircle size={14} className="animate-spin" />
        Loading older messages
      </span>
    </div>
  )
}
