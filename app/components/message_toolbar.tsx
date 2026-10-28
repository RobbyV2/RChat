'use client'

import {
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type RefObject,
} from 'react'
import { MoreHorizontal, SmilePlus, type LucideIcon } from 'lucide-react'
import { useStore } from '../lib/store'
import type { Message } from '../lib/types'
import { FULL_TITLE, canAddEmoji, reacted, reactionsFull } from '../lib/reactions'
import { EmojiPicker, useTopEmojis } from './emoji_picker'

export const messageToolbarCls =
  'pointer-events-none absolute -top-3 right-3 z-10 flex items-center gap-0.5 rounded-lg border border-outline-variant bg-surface-container p-0.5 opacity-0 shadow-sm group-hover:pointer-events-auto group-hover:opacity-100 data-open:pointer-events-auto data-open:opacity-100 pointer-fine:group-focus-within:pointer-events-auto pointer-fine:group-focus-within:opacity-100'

const GAP = 4
const OVERLAP = 12

const scrollParent = (el: HTMLElement | null) => {
  for (let p = el?.parentElement; p; p = p.parentElement) {
    const { overflowY } = getComputedStyle(p)
    if (overflowY === 'auto' || overflowY === 'scroll') return p
  }
  return null
}

// Keeps the row toolbar inside the scroll area. It overlaps the previous row by 12 px and moves
// down if the top would be clipped.
function useClampedToolbar(ref: RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    const bar = ref.current
    const row = bar?.parentElement
    if (!bar || !row) return
    let scroller: HTMLElement | null = null
    const place = () => {
      scroller ??= scrollParent(row)
      const top = scroller ? scroller.getBoundingClientRect().top : 0
      const room = row.getBoundingClientRect().top - top
      const shift = Math.min(GAP + OVERLAP - room, row.offsetHeight)
      bar.style.transform = shift > 0 ? `translateY(${Math.ceil(shift)}px)` : ''
    }
    const enter = () => {
      place()
      scroller?.addEventListener('scroll', place, { passive: true })
    }
    const leave = () => {
      if (row.contains(document.activeElement) || bar.hasAttribute('data-open')) return
      scroller?.removeEventListener('scroll', place)
    }
    row.addEventListener('pointerenter', enter)
    row.addEventListener('focusin', enter)
    row.addEventListener('pointerleave', leave)
    row.addEventListener('focusout', leave)
    return () => {
      row.removeEventListener('pointerenter', enter)
      row.removeEventListener('focusin', enter)
      row.removeEventListener('pointerleave', leave)
      row.removeEventListener('focusout', leave)
      scroller?.removeEventListener('scroll', place)
    }
  }, [ref])
}
export const messageToolCls =
  'flex h-8 w-8 items-center justify-center rounded-md text-on-surface-variant hover:bg-surface-container-highest focus-visible:outline-2 focus-visible:outline-primary'

export interface ToolbarAction {
  key: string
  label: string
  icon: LucideIcon
  onClick: (e: ReactMouseEvent<HTMLButtonElement>) => void
  danger?: boolean
}

export function MessageToolbar({
  m,
  react,
  actions,
  onMore,
}: {
  m: Message
  react: boolean
  actions: ToolbarAction[]
  onMore?: (x: number, y: number) => void
}) {
  const top = useTopEmojis(3)
  const toggle = useStore(s => s.toggleReaction)
  const addRef = useRef<HTMLButtonElement>(null)
  const keyboard = useRef(false)
  const [open, setOpen] = useState(false)
  const barRef = useRef<HTMLDivElement>(null)
  useClampedToolbar(barRef)
  if (!react && !actions.length && !onMore) return null
  const full = reactionsFull(m)
  return (
    <div
      ref={barRef}
      role="toolbar"
      aria-label="Message actions"
      data-toolbar
      data-open={open ? '' : undefined}
      className={messageToolbarCls}
    >
      {react && (
        <>
          {top.map(e => {
            const blocked = !canAddEmoji(m, e)
            return (
              <button
                key={e}
                type="button"
                title={blocked ? FULL_TITLE : `React with ${e}`}
                aria-label={`React with ${e}`}
                aria-pressed={reacted(m, e)}
                aria-disabled={blocked || undefined}
                onClick={() => {
                  if (!blocked) toggle(m, e)
                }}
                className={`${messageToolCls} font-emoji text-[18px] leading-none ${blocked ? 'cursor-not-allowed [&>span]:opacity-40' : 'hover:[&>span]:scale-115'}`}
              >
                <span className="transition-transform">{e}</span>
              </button>
            )
          })}
          <span aria-hidden className="mx-0.5 h-5 w-px bg-outline-variant" />
          <button
            ref={addRef}
            type="button"
            title={full ? FULL_TITLE : 'Add reaction'}
            aria-label="Add reaction"
            aria-disabled={full || undefined}
            aria-expanded={open}
            onClick={e => {
              if (full && !open) return
              keyboard.current = e.detail === 0
              setOpen(o => !o)
            }}
            className={`${messageToolCls} ${full ? 'cursor-not-allowed [&>svg]:opacity-40' : 'hover:text-primary'} ${open ? 'bg-surface-container-highest text-primary' : ''}`}
          >
            <SmilePlus size={18} />
          </button>
        </>
      )}
      {actions.map(a => (
        <button
          key={a.key}
          type="button"
          title={a.label}
          aria-label={a.label}
          onClick={a.onClick}
          className={`${messageToolCls} ${a.danger ? 'hover:text-error' : 'hover:text-primary'}`}
        >
          <a.icon size={18} />
        </button>
      ))}
      {onMore && (
        <button
          type="button"
          title="More"
          aria-label="More"
          aria-haspopup="menu"
          onClick={e => {
            const r = e.currentTarget.getBoundingClientRect()
            onMore(r.left, r.bottom + 4)
          }}
          className={`${messageToolCls} hover:text-on-surface`}
        >
          <MoreHorizontal size={18} />
        </button>
      )}
      {open && (
        <EmojiPicker
          anchor={addRef.current}
          side="bottom"
          align="end"
          label="Add reaction"
          onPick={e => toggle(m, e, false)}
          onClose={() => {
            setOpen(false)
            if (keyboard.current) requestAnimationFrame(() => addRef.current?.focus())
          }}
        />
      )}
    </div>
  )
}
