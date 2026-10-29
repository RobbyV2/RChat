'use client'

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import type {
  ReactNode,
  DragEvent as ReactDragEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  TouchEvent as ReactTouchEvent,
} from 'react'
import { Check, ChevronLeft, ChevronRight } from 'lucide-react'
import { useStore, type ContextMenuItem, type ContextMenuState } from '../lib/store'
import {
  HOLD_MS,
  PRESSED_DELAY_MS,
  idlePress,
  pressStep,
  swallowsClick,
  type PressInput,
} from '../lib/long_press'
import { dnd, type DragSpec } from './drag'

let press = idlePress
let owner: HTMLElement | null = null
let opener: ((x: number, y: number) => void) | null = null
let dragSpec: DragSpec | null = null
let pointerId: number | null = null
let touchId: number | null = null
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

const abortDrag = () => void drive({ kind: 'escape' })

const drive = (input: PressInput, open = opener) => {
  const prev = press
  const [next, out] = pressStep(press, input)
  press = next
  if (out.clear) clearPress()
  if (out.arm) armPress()
  if (prev.phase === 'lifted' && next.phase !== 'lifted') dnd.unlift()
  if (out.lift && owner) {
    navigator.vibrate?.(10)
    dnd.lift(owner)
  }
  if (out.drag === 'start' && input.kind === 'move' && owner && dragSpec) {
    if (next.mouse && pointerId !== null) owner.setPointerCapture?.(pointerId)
    dnd.start(dragSpec, owner, prev.x, prev.y, abortDrag)
    dnd.move(input.x, input.y)
  }
  if (out.drag === 'drop' || out.drag === 'cancel') dnd.finish(out.drag === 'drop')
  if (out.open && open) {
    if (press.phase === 'held') navigator.vibrate?.(10)
    open(out.open.x, out.open.y)
  }
  return out
}

const onMouseMove = (e: PointerEvent) => {
  if (e.pointerId !== pointerId) return
  if (press.phase === 'dragging') dnd.move(e.clientX, e.clientY)
  else drive({ kind: 'move', x: e.clientX, y: e.clientY })
}

const onMouseUp = (e: PointerEvent) => {
  if (e.pointerId !== pointerId) return
  unwatchMouse()
  drive({ kind: e.type === 'pointerup' ? 'end' : 'cancel', now: Date.now() })
}

const watchMouse = () => {
  window.addEventListener('pointermove', onMouseMove)
  window.addEventListener('pointerup', onMouseUp)
  window.addEventListener('pointercancel', onMouseUp)
}

const unwatchMouse = () => {
  window.removeEventListener('pointermove', onMouseMove)
  window.removeEventListener('pointerup', onMouseUp)
  window.removeEventListener('pointercancel', onMouseUp)
  pointerId = null
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
  window.addEventListener(
    'pointerdown',
    e => {
      if (e.pointerType === 'touch') return
      unwatchMouse()
      drive({ kind: 'touch', touches: 1 })
    },
    { capture: true, passive: true }
  )
  window.addEventListener(
    'keydown',
    () => {
      if (pointerId === null) drive({ kind: 'key' })
    },
    { capture: true, passive: true }
  )
  window.addEventListener('blur', () => {
    unwatchMouse()
    drive({ kind: 'cancel', now: Date.now() })
  })
}

const primary = (list: ReactTouchEvent['touches']) =>
  Array.from(list).find(t => touchId === null || t.identifier === touchId)

const claim = (e: { nativeEvent: Event }) => {
  if (claimed === e.nativeEvent) return false
  claimed = e.nativeEvent
  return true
}

export interface LongPressProps {
  'data-long-press': ''
  'data-drag-key'?: string
  onTouchStart: (e: ReactTouchEvent<HTMLElement>) => void
  onTouchMove: (e: ReactTouchEvent<HTMLElement>) => void
  onTouchEnd: (e: ReactTouchEvent<HTMLElement>) => void
  onTouchCancel: (e: ReactTouchEvent<HTMLElement>) => void
  onContextMenu: (e: ReactMouseEvent<HTMLElement>) => void
  onPointerDown?: (e: ReactPointerEvent<HTMLElement>) => void
  onDragStart?: (e: ReactDragEvent<HTMLElement>) => void
}

export function longPress(open: (x: number, y: number) => void, drag?: DragSpec): LongPressProps {
  const props: LongPressProps = {
    'data-long-press': '',
    onTouchStart: e => {
      if (!claim(e)) return
      guardClicks()
      const t = e.touches[0]
      if (e.touches.length === 1) {
        clearPress()
        owner = e.currentTarget
        opener = open
        dragSpec = drag ?? null
        touchId = t.identifier
      }
      drive({
        kind: 'start',
        x: t.clientX,
        y: t.clientY,
        touches: e.touches.length,
        drag: drag !== undefined,
      })
    },
    onTouchMove: e => {
      if (!claim(e)) return
      const t = primary(e.touches)
      if (!t) return
      if (press.phase === 'dragging') dnd.move(t.clientX, t.clientY)
      else drive({ kind: 'move', x: t.clientX, y: t.clientY })
    },
    onTouchEnd: e => {
      if (!claim(e) || !primary(e.changedTouches)) return
      if (drive({ kind: 'end', now: Date.now() }).swallow && e.cancelable) e.preventDefault()
    },
    onTouchCancel: e => {
      if (!claim(e) || !primary(e.changedTouches)) return
      drive({ kind: 'cancel', now: Date.now() })
    },
    onContextMenu: e => {
      if (!claim(e)) return
      e.preventDefault()
      drive({ kind: 'native', x: e.clientX, y: e.clientY, now: Date.now() }, open)
    },
  }
  if (!drag) return props
  return {
    ...props,
    'data-drag-key': drag.key,
    onPointerDown: e => {
      if (e.pointerType === 'touch' || e.button !== 0 || !claim(e)) return
      guardClicks()
      clearPress()
      owner = e.currentTarget
      opener = open
      dragSpec = drag
      pointerId = e.pointerId
      drive({ kind: 'mouse', x: e.clientX, y: e.clientY })
      watchMouse()
    },
    onDragStart: e => e.preventDefault(),
  }
}

export const COARSE_QUERY = '(pointer: coarse)'

export function useMedia(query: string) {
  const subscribe = useCallback(
    (cb: () => void) => {
      const mq = window.matchMedia(query)
      mq.addEventListener('change', cb)
      return () => mq.removeEventListener('change', cb)
    },
    [query]
  )
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false
  )
}

const useCoarse = () => useMedia(COARSE_QUERY)

type MenuItem = ContextMenuItem

// Submenus: on desktop, a flyout beside the parent row. On touch, the sheet shows only the
// deepest submenu with a Back row.
interface Level {
  items: MenuItem[]
  label: string
  from: number
  place: Place
}

type Place = { x: number; y: number } | { beside: DOMRect }

const menuIds = new WeakMap<object, number>()
let menuSeq = 0
const menuId = (menu: object) => {
  let id = menuIds.get(menu)
  if (id === undefined) {
    menuSeq += 1
    id = menuSeq
    menuIds.set(menu, id)
  }
  return id
}

const ITEM = '[data-menu-item]'

const itemsOf = (root: HTMLElement | null, level: number) =>
  Array.from(root?.querySelectorAll<HTMLElement>(`[data-menu-level="${level}"] ${ITEM}`) ?? [])

const roleOf = (it: MenuItem) =>
  it.checked === undefined ? 'menuitem' : it.radio ? 'menuitemradio' : 'menuitemcheckbox'

function Indicator({ it, size }: { it: MenuItem; size: number }) {
  if (it.submenu) return <ChevronRight size={size} aria-hidden className="shrink-0 opacity-80" />
  if (it.checked !== undefined && it.radio)
    return (
      <span
        aria-hidden
        className={`flex shrink-0 items-center justify-center rounded-full border-2 ${
          it.checked ? 'border-primary' : 'border-on-surface-variant'
        }`}
        style={{ width: size, height: size }}
      >
        {it.checked && <span className="size-2 rounded-full bg-primary" />}
      </span>
    )
  if (it.checked !== undefined)
    return (
      <span
        aria-hidden
        className={`flex shrink-0 items-center justify-center rounded-sm border-2 ${
          it.checked ? 'border-primary bg-primary text-on-primary' : 'border-on-surface-variant'
        }`}
        style={{ width: size, height: size }}
      >
        {it.checked && <Check size={size - 6} strokeWidth={3} />}
      </span>
    )
  return it.icon ? <it.icon size={size} aria-hidden className="shrink-0 opacity-80" /> : null
}

function Row({
  it,
  level,
  index,
  open,
  coarse,
  onEnter,
  onPick,
}: {
  it: MenuItem
  level: number
  index: number
  open: boolean
  coarse: boolean
  onEnter?: (el: HTMLElement) => void
  onPick: (el: HTMLElement, keyboard: boolean) => void
}) {
  const size = coarse ? 20 : 16
  return (
    <button
      role={roleOf(it)}
      aria-checked={it.checked}
      aria-haspopup={it.submenu ? 'menu' : undefined}
      aria-expanded={it.submenu ? open : undefined}
      data-menu-item=""
      data-menu-index={index}
      onMouseEnter={onEnter ? e => onEnter(e.currentTarget) : undefined}
      onClick={e => onPick(e.currentTarget, e.detail === 0)}
      className={`flex w-full items-center gap-3 text-left outline-none focus-visible:bg-surface-container-highest ${
        coarse
          ? 'min-h-13 px-6 py-1.5 text-base active:bg-surface-container-highest'
          : `px-4 py-2 text-sm hover:bg-surface-container-highest ${open ? 'bg-surface-container-highest' : ''}`
      } ${it.danger ? 'text-error' : 'text-on-surface'}`}
      data-level={level}
    >
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate">{it.label}</span>
        {it.subtitle && (
          <span
            className={`text-on-surface-variant ${
              it.wrap ? `text-pretty ${coarse ? '' : 'max-w-64'}` : 'truncate'
            } ${coarse ? 'text-sm' : 'text-xs'}`}
          >
            {it.subtitle}
          </span>
        )}
      </span>
      <Indicator it={it} size={size} />
    </button>
  )
}

function Panel({
  place,
  level,
  header,
  children,
}: {
  place: Place
  level: number
  header?: ReactNode
  children: ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)

  // Placed before paint (and before the menu moves focus into it), clamped to the window.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const w = el.offsetWidth
    const h = el.offsetHeight
    const maxX = window.innerWidth - w - 8
    const maxY = window.innerHeight - h - 8
    if ('beside' in place) {
      const r = place.beside
      const right = r.right + 2
      el.style.left = `${right <= maxX ? right : Math.max(4, r.left - w - 2)}px`
      el.style.top = `${Math.max(4, Math.min(r.top - 8, maxY))}px`
    } else {
      el.style.left = `${Math.max(4, Math.min(place.x, maxX))}px`
      el.style.top = `${Math.max(4, Math.min(place.y, maxY))}px`
    }
  }, [place])

  return (
    <div
      ref={ref}
      role="menu"
      data-menu-level={level}
      className="absolute max-h-[calc(100dvh-1rem)] min-w-44 overflow-y-auto rounded-xl bg-surface-container-high py-2 shadow-elevation-2"
      onMouseDown={e => e.stopPropagation()}
    >
      {header && <div className="mb-1 border-b border-outline-variant px-2 pb-2">{header}</div>}
      {children}
    </div>
  )
}

function OpenMenu({ menu, coarse }: { menu: ContextMenuState; coarse: boolean }) {
  const close = useStore(s => s.closeContextMenu)
  const ref = useRef<HTMLDivElement>(null)
  const [stack, setStack] = useState<Level[]>([])
  const focusNext = useRef<{ level: number; index: number } | null>(null)
  const root = useMemo<Place>(() => ({ x: menu.x, y: menu.y }), [menu.x, menu.y])

  const levels: MenuItem[][] = [menu.items, ...stack.map(l => l.items)]

  const openSub = (level: number, index: number, el: HTMLElement | null, focus: boolean) => {
    const it = levels[level]?.[index]
    if (!it?.submenu) return
    const sub = it.submenu
    if (focus) focusNext.current = { level: level + 1, index: 0 }
    setStack(st => {
      const cur = st[level]
      if (cur && cur.from === index && cur.items === sub && !focus) return st
      return [
        ...st.slice(0, level),
        {
          items: sub,
          label: it.label,
          from: index,
          place: { beside: el?.getBoundingClientRect() ?? new DOMRect() },
        },
      ]
    })
  }

  const back = () => {
    const top = stack[stack.length - 1]
    if (!top) return
    focusNext.current = { level: stack.length - 1, index: top.from }
    setStack(stack.slice(0, -1))
  }

  useLayoutEffect(() => {
    const want = focusNext.current
    if (!want) return
    focusNext.current = null
    itemsOf(ref.current, coarse ? 0 : want.level)[want.index]?.focus()
  })

  // Re-registered every render so the handler sees the current stack.
  useEffect(() => {
    const deepest = () => {
      const active = document.activeElement
      const box = active instanceof HTMLElement ? active.closest('[data-menu-level]') : null
      return box && ref.current?.contains(box) ? Number(box.getAttribute('data-menu-level')) : null
    }
    const onKey = (e: KeyboardEvent) => {
      const key = e.key
      if (
        !['Escape', 'ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(key)
      )
        return
      e.preventDefault()
      e.stopPropagation()
      const depth = stack.length
      const at = deepest()
      if (key === 'Escape') {
        if (depth > 0) back()
        else close()
        return
      }
      const level = coarse ? 0 : (at ?? depth)
      const rows = itemsOf(ref.current, level)
      const current = rows.findIndex(r => r === document.activeElement)
      if (key === 'ArrowLeft') {
        if (level > 0 || (coarse && depth > 0)) back()
        return
      }
      if (key === 'ArrowRight') {
        if (current >= 0) openSub(coarse ? depth : level, current, rows[current] ?? null, true)
        return
      }
      if (!rows.length) return
      const n = rows.length
      const next =
        key === 'Home'
          ? 0
          : key === 'End'
            ? n - 1
            : current < 0
              ? key === 'ArrowDown'
                ? 0
                : n - 1
              : (current + (key === 'ArrowDown' ? 1 : -1) + n) % n
      rows[next]?.focus()
      if (!coarse && stack.length > level) setStack(st => st.slice(0, level))
    }
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('blur', close)
    if (!coarse) window.addEventListener('resize', close)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('blur', close)
      window.removeEventListener('resize', close)
    }
  })

  // Enter or Space moves focus into the submenu. The sheet always does this, because the parent
  // row is gone.
  const pick = (level: number, index: number, el: HTMLElement, keyboard: boolean) => {
    const it = levels[level]?.[index]
    if (!it) return
    if (it.submenu) {
      openSub(level, index, el, keyboard || coarse)
      return
    }
    close()
    it.action?.()
  }

  if (coarse) {
    const depth = stack.length
    const top = stack[depth - 1]
    const items = levels[depth]
    return (
      <div
        className="fixed inset-x-0 top-0 z-50 flex h-app flex-col justify-end bg-scrim/40"
        onClick={close}
        onContextMenu={e => {
          e.preventDefault()
          if (press.phase !== 'held') close()
        }}
      >
        <div
          ref={ref}
          role="menu"
          data-menu-level={0}
          onClick={e => e.stopPropagation()}
          onContextMenu={e => {
            e.preventDefault()
            e.stopPropagation()
          }}
          className="animate-sheet-up max-h-[70dvh] overflow-y-auto overscroll-contain rounded-t-3xl bg-surface-container-high px-safe pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] shadow-elevation-3 select-none"
        >
          <div aria-hidden className="mx-auto mb-2 h-1 w-8 rounded-full bg-outline-variant" />
          {top ? (
            <div className="flex items-center gap-1 border-b border-outline-variant px-2 pb-2">
              <button
                title="Back"
                aria-label="Back"
                onClick={back}
                className="rounded-full p-3 text-on-surface-variant active:bg-surface-container-highest"
              >
                <ChevronLeft size={20} />
              </button>
              <span className="truncate text-base font-medium text-on-surface">{top.label}</span>
            </div>
          ) : (
            menu.header && (
              <div className="border-b border-outline-variant px-4 pt-1 pb-3">{menu.header}</div>
            )
          )}
          {items.map((it, i) => (
            <Row
              key={`${depth}:${i}`}
              it={it}
              level={depth}
              index={i}
              open={false}
              coarse
              onPick={(el, keyboard) => pick(depth, i, el, keyboard)}
            />
          ))}
        </div>
      </div>
    )
  }

  return (
    <div
      ref={ref}
      className="fixed inset-0 z-50"
      onMouseDown={close}
      onContextMenu={e => {
        e.preventDefault()
        close()
      }}
    >
      {levels.map((items, level) => (
        <Panel
          key={level === 0 ? 'root' : `${level}:${stack[level - 1]?.from}`}
          level={level}
          place={level === 0 ? root : (stack[level - 1]?.place ?? root)}
          header={level === 0 ? menu.header : undefined}
        >
          {items.map((it, i) => (
            <Row
              key={i}
              it={it}
              level={level}
              index={i}
              open={stack[level]?.from === i}
              coarse={false}
              onEnter={el => {
                if (it.submenu) openSub(level, i, el, false)
                else if (stack.length > level) setStack(st => st.slice(0, level))
              }}
              onPick={(el, keyboard) => pick(level, i, el, keyboard)}
            />
          ))}
        </Panel>
      ))}
    </div>
  )
}

export function ContextMenu() {
  const menu = useStore(s => s.contextMenu)
  const coarse = useCoarse()

  useLayoutEffect(() => {
    if (!menu || !coarse) return
    const active = document.activeElement
    if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) active.blur()
  }, [menu, coarse])

  if (!menu) return null
  return <OpenMenu key={menuId(menu)} menu={menu} coarse={coarse} />
}
