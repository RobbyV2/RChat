'use client'

import {
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type RefObject,
} from 'react'
import { MoreHorizontal, SmilePlus, type LucideIcon } from 'lucide-react'
import { useChat } from '../lib/place/use_chat'
import type { Message } from '../lib/types'
import { FULL_TITLE, canAddEmoji, reacted, reactionsFull } from '../lib/reactions'
import { keptWhenTight, toolbarFit } from '../lib/toolbar_fit'
import { EmojiPicker, useTopEmojis } from './emoji_picker'
import { time } from '../lib/platform/time'
import { messageToolbarLook } from '../lib/controls'
import { IconButton } from './controls'
import { look } from '../lib/motion/play'
import { type Label, notAName } from '../lib/names'

// It straddles the row's top edge, so a pointer moving up from the row reaches it before leaving.
const messageToolbarCls = messageToolbarLook

// Buttons a narrow row leaves to the More menu (see `toolbarFit`).
const quickCls = 'group-data-[fit=compact]/bar:hidden group-data-[fit=tight]/bar:hidden'
const spareCls = 'group-data-[fit=tight]/bar:hidden'

const GAP = 4

const scrollParent = (el: HTMLElement | null) => {
  for (let p = el?.parentElement; p; p = p.parentElement) {
    const { overflowY } = getComputedStyle(p)
    if (overflowY === 'auto' || overflowY === 'scroll') return p
  }
  return null
}

// Keeps the row toolbar inside the scroll area, and as wide as fits beside the row's name line.
// It overlaps the previous row and moves down if the top would be clipped.
function useClampedToolbar(ref: RefObject<HTMLDivElement | null>, shown: boolean) {
  useEffect(() => {
    const bar = ref.current
    const row = bar?.parentElement
    if (!bar || !row) return
    let scroller: HTMLElement | null = null
    const place = () => {
      scroller ??= scrollParent(row)
      const top = scroller ? scroller.getBoundingClientRect().top : 0
      const box = row.getBoundingClientRect()
      bar.dataset.fit = toolbarFit(box.width)
      const room = box.top - top
      const shift = Math.min(GAP - bar.offsetTop - room, row.offsetHeight)
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
  }, [ref, shown])
}

export interface ToolbarAction {
  key: string
  label: Label
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
  const { toggleReaction: toggle } = useChat()
  const addRef = useRef<HTMLButtonElement>(null)
  const keyboard = useRef(false)
  const [open, setOpen] = useState(false)
  const barRef = useRef<HTMLDivElement>(null)
  const shown = react || actions.length > 0 || !!onMore
  useClampedToolbar(barRef, shown)
  if (!shown) return null
  const full = reactionsFull(m)
  return (
    <div
      ref={barRef}
      role="toolbar"
      aria-label="Message actions"
      data-toolbar
      data-open={open ? '' : undefined}
      {...look('toolbar.hover')}
      className={messageToolbarCls}
    >
      {react && (
        <>
          {top.map(e => {
            const blocked = !canAddEmoji(m, e)
            return (
              <span key={e} className={`contents ${quickCls}`}>
                <IconButton
                  aria-disabled={blocked || undefined}
                  onClick={() => {
                    if (!blocked) toggle(m, e)
                  }}
                  glyph={e}
                  label={notAName(`React with ${e}`)}
                  tooltip={blocked ? FULL_TITLE : `React with ${e}`}
                  shape="square"
                  pressed={reacted(m, e)}
                />
              </span>
            )
          })}
          <span aria-hidden className={`h-5 w-px bg-outline-variant ${quickCls}`} />
          <IconButton
            icon={SmilePlus}
            label="Add reaction"
            tooltip={full ? FULL_TITLE : 'Add reaction'}
            ref={addRef}
            aria-disabled={full || undefined}
            aria-expanded={open}
            onClick={e => {
              if (full && !open) return
              keyboard.current = e.detail === 0
              setOpen(o => !o)
            }}
            shape="square"
            aria-haspopup="dialog"
          />
        </>
      )}
      {actions.map(a => (
        <span key={a.key} className={keptWhenTight(a.key) ? 'contents' : `contents ${spareCls}`}>
          <IconButton
            icon={a.icon}
            label={a.label}
            key={a.key}
            onClick={a.onClick}
            shape="square"
            tone={a.danger ? 'danger' : 'plain'}
          />
        </span>
      ))}
      {onMore && (
        <IconButton
          icon={MoreHorizontal}
          label="More"
          aria-haspopup="menu"
          onClick={e => {
            const r = e.currentTarget.getBoundingClientRect()
            onMore(r.left, r.bottom + 4)
          }}
          shape="square"
        />
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
            if (keyboard.current) time().frame(() => addRef.current?.focus())
          }}
        />
      )}
    </div>
  )
}
