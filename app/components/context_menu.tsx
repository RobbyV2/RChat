'use client'

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type {
  CSSProperties,
  MouseEvent as ReactMouseEvent,
  TouchEvent as ReactTouchEvent,
} from 'react'
import { useStore } from '../lib/store'

let pressTimer: number | null = null
let pressStart = { x: 0, y: 0 }
let suppress = false

const cancelPress = () => {
  if (pressTimer !== null) {
    window.clearTimeout(pressTimer)
    pressTimer = null
  }
}

export interface LongPressProps {
  onTouchStart: (e: ReactTouchEvent<HTMLElement>) => void
  onTouchMove: (e: ReactTouchEvent<HTMLElement>) => void
  onTouchEnd: () => void
  onTouchCancel: () => void
  onContextMenu: (e: ReactMouseEvent<HTMLElement>) => void
  onClickCapture: (e: ReactMouseEvent<HTMLElement>) => void
  style: CSSProperties
}

export function longPress(open: (x: number, y: number) => void): LongPressProps {
  return {
    onTouchStart: e => {
      cancelPress()
      if (e.touches.length !== 1) return
      const t = e.touches[0]
      suppress = false
      pressStart = { x: t.clientX, y: t.clientY }
      pressTimer = window.setTimeout(() => {
        pressTimer = null
        suppress = true
        open(pressStart.x, pressStart.y)
      }, 500)
    },
    onTouchMove: e => {
      const t = e.touches[0]
      if (Math.hypot(t.clientX - pressStart.x, t.clientY - pressStart.y) > 10) cancelPress()
    },
    onTouchEnd: () => {
      cancelPress()
      window.setTimeout(() => {
        suppress = false
      }, 500)
    },
    onTouchCancel: cancelPress,
    onContextMenu: e => {
      e.preventDefault()
      if (!suppress) open(e.clientX, e.clientY)
    },
    onClickCapture: e => {
      if (!suppress) return
      e.preventDefault()
      e.stopPropagation()
    },
    style: { WebkitTouchCallout: 'none', WebkitUserSelect: 'none', userSelect: 'none' },
  }
}

export function ContextMenu() {
  const menu = useStore(s => s.contextMenu)
  const close = useStore(s => s.closeContextMenu)
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x: 0, y: 0 })

  useLayoutEffect(() => {
    if (!menu) return
    const el = ref.current
    if (!el) return
    setPos({
      x: Math.max(4, Math.min(menu.x, window.innerWidth - el.offsetWidth - 8)),
      y: Math.max(4, Math.min(menu.y, window.innerHeight - el.offsetHeight - 8)),
    })
  }, [menu])

  useEffect(() => {
    if (!menu) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('blur', close)
    window.addEventListener('resize', close)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('blur', close)
      window.removeEventListener('resize', close)
    }
  }, [menu, close])

  if (!menu) return null
  return (
    <div
      className="fixed inset-0 z-50"
      onTouchStart={() => {
        suppress = false
      }}
      onMouseDown={() => {
        if (!suppress) close()
      }}
      onContextMenu={e => {
        e.preventDefault()
        if (!suppress) close()
      }}
    >
      <div
        ref={ref}
        style={{ left: pos.x, top: pos.y }}
        className="absolute min-w-44 rounded-xl bg-surface-container-high py-2 shadow-elevation-2"
        onMouseDown={e => e.stopPropagation()}
      >
        {menu.items.map((item, i) => (
          <button
            key={i}
            onClick={() => {
              if (suppress) return
              close()
              item.action()
            }}
            className={`block w-full px-4 py-2 text-left text-sm hover:bg-surface-container-highest ${
              item.danger ? 'text-error' : 'text-on-surface'
            }`}
          >
            {item.label}
          </button>
        ))}
      </div>
    </div>
  )
}
