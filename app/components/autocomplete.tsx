'use client'

import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { keepDismissal, scrollToShow } from '../lib/autocomplete'
import { composing } from '../lib/keys'

export interface Autocomplete<T> {
  open: boolean
  items: T[]
  active: number
  setActive: (i: number) => void
  accept: (item: T) => void
  dismiss: () => void
  onKeyDown: (e: KeyboardEvent) => boolean
}

export function useAutocomplete<T>({
  scope,
  query,
  search,
  onAccept,
}: {
  scope: string | null
  query: string
  search: (query: string) => T[]
  onAccept: (item: T) => void
}): Autocomplete<T> {
  const [picked, setPicked] = useState({ key: '', active: 0 })
  const [dismissed, setDismissed] = useState<string | null>(null)
  const kept = keepDismissal(dismissed, scope)
  if (kept !== dismissed) setDismissed(kept)
  const live = scope !== null && kept !== scope
  const items = useMemo(() => (live ? search(query) : []), [live, query, search])
  const key = `${scope}\u0000${query}`
  const open = live && items.length > 0
  const active = picked.key === key ? Math.min(picked.active, items.length - 1) : 0
  const setActive = (i: number) => setPicked({ key, active: i })
  const accept = (item: T) => {
    setPicked({ key: '', active: 0 })
    onAccept(item)
  }
  const dismiss = () => setDismissed(scope)

  const onKeyDown = (e: KeyboardEvent) => {
    if (!open || composing(e)) return false
    const n = items.length
    switch (e.key) {
      case 'ArrowDown':
        setActive((active + 1) % n)
        break
      case 'ArrowUp':
        setActive((active - 1 + n) % n)
        break
      case 'Tab':
      case 'Enter':
        if (e.shiftKey) return false
        accept(items[active])
        break
      case 'Escape':
        dismiss()
        break
      default:
        return false
    }
    e.preventDefault()
    e.stopPropagation()
    return true
  }

  return { open, items, active, setActive, accept, dismiss, onKeyDown }
}

export function AutocompletePopup<T>({
  id,
  title,
  ac,
  keyOf,
  render,
  below = false,
}: {
  id: string
  title: ReactNode
  ac: Autocomplete<T>
  keyOf: (item: T) => string
  render: (item: T, active: boolean) => ReactNode
  below?: boolean
}) {
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const list = listRef.current
    if (!ac.open || !list) return
    const row = list.querySelector<HTMLElement>(`#${CSS.escape(`${id}-${ac.active}`)}`)
    if (row)
      list.scrollTop = scrollToShow(
        row.offsetTop,
        row.offsetHeight,
        list.scrollTop,
        list.clientHeight
      )
  }, [id, ac.open, ac.active])

  if (!ac.open) return null

  return (
    <div
      data-popover
      className={`absolute inset-x-0 z-30 overflow-hidden rounded-2xl ${below ? 'top-full mt-2' : 'bottom-full mb-2'} bg-surface-container-high py-2 shadow-elevation-2`}
      onMouseDown={e => e.preventDefault()}
    >
      <div className="truncate px-4 pb-1 text-xs font-medium tracking-wide text-on-surface-variant uppercase">
        {title}
      </div>
      <div
        ref={listRef}
        id={id}
        role="listbox"
        aria-label={typeof title === 'string' ? title : undefined}
        className="relative max-h-72 overflow-y-auto overscroll-contain px-2"
      >
        {ac.items.map((item, i) => (
          <div
            key={keyOf(item)}
            id={`${id}-${i}`}
            role="option"
            aria-selected={i === ac.active}
            onMouseMove={() => i !== ac.active && ac.setActive(i)}
            onClick={() => ac.accept(item)}
            className={`flex min-h-10 cursor-pointer items-center gap-3 rounded-xl px-2 py-1.5 text-sm ${
              i === ac.active
                ? 'bg-secondary-container text-on-secondary-container'
                : 'text-on-surface'
            }`}
          >
            {render(item, i === ac.active)}
          </div>
        ))}
      </div>
    </div>
  )
}
