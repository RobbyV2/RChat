'use client'

import { useEffect, type RefObject } from 'react'

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
