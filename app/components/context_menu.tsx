'use client'

import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { MouseEvent as ReactMouseEvent, TouchEvent as ReactTouchEvent } from 'react'
import { useStore } from '../lib/store'
import {
  HOLD_MS,
  PRESSED_DELAY_MS,
  idlePress,
  pressStep,
  swallowsClick,
  type PressInput,
} from '../lib/long_press'

let press = idlePress
let owner: HTMLElement | null = null
let opener: ((x: number, y: number) => void) | null = null
let claimed: Event | null = null
let holdTimer: number | null = null
let pressedTimer: number | null = null
let guarded = false

const onScroll = () => void drive({ kind: 'cancel', now: Date.now() })

const clearPress = () => {
  if (holdTimer !== null) window.clearTimeout(holdTimer)
  if (pressedTimer !== null) window.clearTimeout(pressedTimer)
  holdTimer = null
  pressedTimer = null
  owner?.removeAttribute('data-pressed')
  document.removeEventListener('scroll', onScroll, true)
}

const armPress = () => {
  holdTimer = window.setTimeout(() => {
    holdTimer = null
    drive({ kind: 'timer' })
  }, HOLD_MS)
  pressedTimer = window.setTimeout(() => {
    pressedTimer = null
    owner?.setAttribute('data-pressed', '')
  }, PRESSED_DELAY_MS)
  document.addEventListener('scroll', onScroll, { capture: true, passive: true })
}

const drive = (input: PressInput, open = opener) => {
  const [next, out] = pressStep(press, input)
  press = next
  if (out.clear) clearPress()
  if (out.arm) armPress()
  if (out.open && open) {
    if (press.phase === 'held') navigator.vibrate?.(10)
    open(out.open.x, out.open.y)
  }
  return out
}

const guardClicks = () => {
  if (guarded) return
  guarded = true
  window.addEventListener(
    'click',
    e => {
      if (!swallowsClick(press, Date.now())) return
      e.preventDefault()
      e.stopPropagation()
    },
    true
  )
  window.addEventListener(
    'touchstart',
    e => void drive({ kind: 'touch', touches: e.touches.length }),
    { capture: true, passive: true }
  )
}

const claim = (e: { nativeEvent: Event }) => {
  if (claimed === e.nativeEvent) return false
  claimed = e.nativeEvent
  return true
}

export interface LongPressProps {
  'data-long-press': ''
  onTouchStart: (e: ReactTouchEvent<HTMLElement>) => void
  onTouchMove: (e: ReactTouchEvent<HTMLElement>) => void
  onTouchEnd: (e: ReactTouchEvent<HTMLElement>) => void
  onTouchCancel: (e: ReactTouchEvent<HTMLElement>) => void
  onContextMenu: (e: ReactMouseEvent<HTMLElement>) => void
}

export function longPress(open: (x: number, y: number) => void): LongPressProps {
  return {
    'data-long-press': '',
    onTouchStart: e => {
      if (!claim(e)) return
      guardClicks()
      const t = e.touches[0]
      if (e.touches.length === 1) {
        clearPress()
        owner = e.currentTarget
        opener = open
      }
      drive({ kind: 'start', x: t.clientX, y: t.clientY, touches: e.touches.length })
    },
    onTouchMove: e => {
      if (!claim(e)) return
      const t = e.touches[0]
      if (t) drive({ kind: 'move', x: t.clientX, y: t.clientY })
    },
    onTouchEnd: e => {
      if (!claim(e)) return
      if (drive({ kind: 'end', now: Date.now() }).swallow && e.cancelable) e.preventDefault()
    },
    onTouchCancel: e => {
      if (!claim(e)) return
      drive({ kind: 'cancel', now: Date.now() })
    },
    onContextMenu: e => {
      if (!claim(e)) return
      e.preventDefault()
      drive({ kind: 'native', x: e.clientX, y: e.clientY, now: Date.now() }, open)
    },
  }
}

const coarseQuery = '(pointer: coarse)'

const subscribeCoarse = (cb: () => void) => {
  const mq = window.matchMedia(coarseQuery)
  mq.addEventListener('change', cb)
  return () => mq.removeEventListener('change', cb)
}

const useCoarse = () =>
  useSyncExternalStore(
    subscribeCoarse,
    () => window.matchMedia(coarseQuery).matches,
    () => false
  )

export function ContextMenu() {
  const menu = useStore(s => s.contextMenu)
  const close = useStore(s => s.closeContextMenu)
  const coarse = useCoarse()
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x: 0, y: 0 })

  useLayoutEffect(() => {
    if (!menu) return
    if (coarse) {
      const active = document.activeElement
      if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) active.blur()
      return
    }
    const el = ref.current
    if (!el) return
    setPos({
      x: Math.max(4, Math.min(menu.x, window.innerWidth - el.offsetWidth - 8)),
      y: Math.max(4, Math.min(menu.y, window.innerHeight - el.offsetHeight - 8)),
    })
  }, [menu, coarse])

  useEffect(() => {
    if (!menu) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('blur', close)
    if (!coarse) window.addEventListener('resize', close)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('blur', close)
      window.removeEventListener('resize', close)
    }
  }, [menu, close, coarse])

  if (!menu) return null

  const item = (it: (typeof menu.items)[number], i: number, cls: string) => (
    <button
      key={i}
      role="menuitem"
      onClick={() => {
        close()
        it.action()
      }}
      className={`${cls} ${it.danger ? 'text-error' : 'text-on-surface'}`}
    >
      {it.label}
    </button>
  )

  if (coarse) {
    return (
      <div
        className="fixed inset-0 z-50 flex flex-col justify-end bg-scrim/40"
        onClick={close}
        onContextMenu={e => {
          e.preventDefault()
          if (press.phase !== 'held') close()
        }}
      >
        <div
          role="menu"
          onClick={e => e.stopPropagation()}
          onContextMenu={e => {
            e.preventDefault()
            e.stopPropagation()
          }}
          className="animate-sheet-up max-h-[70dvh] overflow-y-auto overscroll-contain rounded-t-3xl bg-surface-container-high pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] shadow-elevation-3 select-none"
        >
          <div aria-hidden className="mx-auto mb-2 h-1 w-8 rounded-full bg-outline-variant" />
          {menu.items.map((it, i) =>
            item(
              it,
              i,
              'flex min-h-13 w-full items-center px-6 text-left text-base active:bg-surface-container-highest'
            )
          )}
        </div>
      </div>
    )
  }

  return (
    <div
      className="fixed inset-0 z-50"
      onMouseDown={close}
      onContextMenu={e => {
        e.preventDefault()
        close()
      }}
    >
      <div
        ref={ref}
        role="menu"
        style={{ left: pos.x, top: pos.y }}
        className="absolute min-w-44 rounded-xl bg-surface-container-high py-2 shadow-elevation-2"
        onMouseDown={e => e.stopPropagation()}
      >
        {menu.items.map((it, i) =>
          item(it, i, 'block w-full px-4 py-2 text-left text-sm hover:bg-surface-container-highest')
        )}
      </div>
    </div>
  )
}
