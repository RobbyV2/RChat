'use client'

import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { SmilePlus } from 'lucide-react'
import { useStore } from '../lib/store'
import type { Message, Reaction, UserRef } from '../lib/types'
import {
  FULL_TITLE,
  canAddEmoji,
  reactionsFull,
  emojiCode,
  peopleText,
  reacted,
  reactionLabel,
  reactorsText,
} from '../lib/reactions'
import { EmojiPicker, useEmojiData, useTopEmojis } from './emoji_picker'
import { COARSE_QUERY, longPress, useMedia } from './context_menu'
import { UserAvatar } from './user_avatar'
import { CloseButton, SheetGrip } from './ui'

const EMPTY: Reaction[] = []

const stop = (e: { stopPropagation: () => void }) => e.stopPropagation()

const shield = {
  onClick: stop,
  onMouseDown: stop,
  onPointerDown: stop,
  onTouchStart: stop,
  onTouchMove: stop,
  onTouchEnd: stop,
  onContextMenu: stop,
  onKeyDown: stop,
}

const chipCls =
  'flex h-7 items-center gap-1.5 rounded-lg border px-2 text-sm font-medium tabular-nums outline-offset-2 select-none focus-visible:outline-2 focus-visible:outline-primary'
const blockedCls = 'cursor-not-allowed opacity-40'
const chipMineCls = 'border-primary bg-primary/15 text-primary hover:bg-primary/25'
const chipOtherCls =
  'border-transparent bg-surface-container-high text-on-surface-variant hover:border-outline-variant hover:text-on-surface'

function useReactors(messageId: number, emoji: string, count: number, enabled: boolean) {
  const load = useStore(s => s.loadReactors)
  const key = `${messageId}:${emoji}:${count}`
  const [got, setGot] = useState<{ key: string; list: UserRef[] } | null>(null)
  useEffect(() => {
    if (!enabled) return
    let live = true
    load(messageId, emoji).then(
      list => {
        if (live) setGot({ key, list })
      },
      () => {}
    )
    return () => {
      live = false
    }
  }, [enabled, messageId, emoji, key, load])
  return got?.key === key ? got.list : null
}

const reactionAria = (r: Reaction) =>
  `${r.emoji}, ${r.count} ${r.count === 1 ? 'reaction' : 'reactions'}${r.me ? ', including you' : ''}`

function ReactionTooltip({
  anchor,
  id,
  messageId,
  r,
}: {
  anchor: HTMLElement
  id: string
  messageId: number
  r: Reaction
}) {
  const streamer = useStore(s => s.streamer)
  const { data } = useEmojiData(true)
  const users = useReactors(messageId, r.emoji, r.count, !streamer)
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const code = data ? emojiCode(data, r.emoji) : null
  const names = users?.map(u => u.display_name) ?? null

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const a = anchor.getBoundingClientRect()
    const w = el.offsetWidth
    const h = el.offsetHeight
    const above = a.top - h - 8
    setPos({
      top: above >= 8 ? above : a.bottom + 8,
      left: Math.max(8, Math.min(a.left + a.width / 2 - w / 2, window.innerWidth - w - 8)),
    })
  }, [anchor, names?.length, code])

  return createPortal(
    <div
      ref={ref}
      id={id}
      role="tooltip"
      data-reaction-tooltip
      aria-label={reactionLabel(r.emoji, code, names, r.count, streamer)}
      style={pos ?? { top: -9999, left: -9999 }}
      className="pointer-events-none fixed z-50 flex max-w-64 items-center gap-3 rounded-lg bg-inverse-surface px-3 py-2 text-inverse-on-surface shadow-elevation-2"
    >
      <span aria-hidden className="shrink-0 font-emoji text-[32px] leading-none">
        {r.emoji}
      </span>
      <span aria-hidden className="text-sm leading-snug">
        {code && <span className="font-semibold">:{code}: </span>}
        reacted by{' '}
        {streamer || names === null ? (
          peopleText(r.count)
        ) : (
          <span className="streamer">{reactorsText(names, r.count)}</span>
        )}
      </span>
    </div>,
    document.body
  )
}

function ReactionChip({
  m,
  r,
  canReact,
  canRemove,
  onList,
}: {
  m: Message
  r: Reaction
  canReact: boolean
  canRemove: boolean
  onList: (emoji: string) => void
}) {
  const toggle = useStore(s => s.toggleReaction)
  const coarse = useMedia(COARSE_QUERY)
  const ref = useRef<HTMLButtonElement>(null)
  const [tip, setTip] = useState(false)
  const tipId = useId()
  const active = r.me ? canRemove : canReact && canAddEmoji(m, r.emoji)
  return (
    <>
      <button
        ref={ref}
        type="button"
        data-reaction={r.emoji}
        aria-pressed={r.me}
        aria-label={reactionAria(r)}
        aria-describedby={tip ? tipId : undefined}
        {...longPress(() => {
          setTip(false)
          onList(r.emoji)
        })}
        onClick={() => {
          if (active) toggle(m, r.emoji)
        }}
        onPointerEnter={e => {
          if (e.pointerType === 'mouse') setTip(true)
        }}
        onPointerLeave={() => setTip(false)}
        onFocus={() => {
          if (!coarse) setTip(true)
        }}
        onBlur={() => setTip(false)}
        className={`${chipCls} ${r.me ? chipMineCls : chipOtherCls} ${active ? '' : 'cursor-default'}`}
      >
        <span aria-hidden className="font-emoji text-base leading-none">
          {r.emoji}
        </span>
        <span aria-hidden>{r.count}</span>
      </button>
      {tip && ref.current && (
        <ReactionTooltip anchor={ref.current} id={tipId} messageId={m.id} r={r} />
      )}
    </>
  )
}

function AddReactionChip({ m }: { m: Message }) {
  const toggle = useStore(s => s.toggleReaction)
  const ref = useRef<HTMLButtonElement>(null)
  const keyboard = useRef(false)
  const [open, setOpen] = useState(false)
  const full = reactionsFull(m)
  return (
    <>
      <button
        ref={ref}
        type="button"
        title={full ? FULL_TITLE : 'Add reaction'}
        aria-label="Add reaction"
        aria-disabled={full || undefined}
        aria-expanded={open}
        data-open={open ? '' : undefined}
        onClick={e => {
          if (full) return
          keyboard.current = e.detail === 0
          setOpen(o => !o)
        }}
        className={`flex h-7 w-7 items-center justify-center rounded-full bg-surface-container-high text-on-surface-variant opacity-0 outline-offset-2 group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-primary pointer-coarse:opacity-100 data-open:opacity-100 ${full ? 'cursor-not-allowed [&>svg]:opacity-40' : 'hover:text-on-surface'}`}
      >
        <SmilePlus size={16} />
      </button>
      {open && (
        <EmojiPicker
          anchor={ref.current}
          side="top"
          align="start"
          label="Add reaction"
          onPick={e => toggle(m, e, false)}
          onClose={() => {
            setOpen(false)
            if (keyboard.current) requestAnimationFrame(() => ref.current?.focus())
          }}
        />
      )}
    </>
  )
}

export function ReactionBar({
  m,
  canReact,
  canRemove,
}: {
  m: Message
  canReact: boolean
  canRemove: boolean
}) {
  const list = m.reactions ?? EMPTY
  const [sheet, setSheet] = useState<string | null>(null)
  if (!list.length) return null
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1" data-reactions>
      {list.map(r => (
        <ReactionChip
          key={r.emoji}
          m={m}
          r={r}
          canReact={canReact}
          canRemove={canRemove}
          onList={setSheet}
        />
      ))}
      {canReact && <AddReactionChip m={m} />}
      {sheet !== null && <ReactorsSheet m={m} start={sheet} onClose={() => setSheet(null)} />}
    </div>
  )
}

function ReactorsSheet({ m, start, onClose }: { m: Message; start: string; onClose: () => void }) {
  const coarse = useMedia(COARSE_QUERY)
  const list = m.reactions ?? EMPTY
  const [picked, setPicked] = useState(start)
  const current = list.find(r => r.emoji === picked) ?? list[0]
  const users = useReactors(m.id, current?.emoji ?? '', current?.count ?? 0, current !== undefined)
  const titleId = useId()
  const closeRef = useRef(onClose)
  useEffect(() => {
    closeRef.current = onClose
  })
  const gone = current === undefined
  useEffect(() => {
    if (gone) closeRef.current()
  }, [gone])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.isComposing) return
      e.preventDefault()
      e.stopPropagation()
      closeRef.current()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])
  useLayoutEffect(() => {
    if (!coarse) return
    const active = document.activeElement
    if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) active.blur()
  }, [coarse])
  if (!current) return null
  const more = users ? current.count - users.length : 0

  return createPortal(
    <div
      {...shield}
      onClick={e => {
        e.stopPropagation()
        if (e.target === e.currentTarget) onClose()
      }}
      className={`fixed inset-x-0 top-app z-50 flex h-app bg-scrim/40 ${
        coarse ? 'flex-col justify-end' : 'items-center justify-center px-safe-4 py-4'
      }`}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-popover
        className={`flex flex-col bg-surface-container-high shadow-elevation-3 ${
          coarse
            ? 'animate-sheet-up max-h-[70dvh] rounded-t-3xl px-safe pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] select-none'
            : 'max-h-[min(70vh,100%)] w-full max-w-md rounded-2xl py-4'
        }`}
      >
        {coarse && <SheetGrip />}
        <div className="flex shrink-0 items-center justify-between px-4 pb-2">
          <h2 id={titleId} className="text-base font-medium text-on-surface">
            Reactions
          </h2>
          {!coarse && <CloseButton onClick={onClose} />}
        </div>
        <div
          role="tablist"
          aria-label="Reactions"
          className="flex shrink-0 gap-1.5 overflow-x-auto px-4 pb-3"
        >
          {list.map(r => (
            <button
              key={r.emoji}
              type="button"
              role="tab"
              aria-selected={r.emoji === current.emoji}
              aria-label={reactionAria(r)}
              onClick={() => setPicked(r.emoji)}
              className={`${chipCls} h-8 shrink-0 ${
                r.emoji === current.emoji ? chipMineCls : chipOtherCls
              }`}
            >
              <span aria-hidden className="font-emoji text-base leading-none">
                {r.emoji}
              </span>
              <span aria-hidden>{r.count}</span>
            </button>
          ))}
        </div>
        <ul
          role="tabpanel"
          aria-label={`${current.emoji} reacted by ${peopleText(current.count)}`}
          className="min-h-24 overflow-y-auto overscroll-contain border-t border-outline-variant px-2 pt-2"
        >
          {users === null && (
            <li className="px-2 py-3 text-sm text-on-surface-variant">Loading reactions</li>
          )}
          {users?.map(u => (
            <li key={u.username} className="flex items-center gap-3 rounded-xl px-2 py-2">
              <UserAvatar
                username={u.username}
                avatarKind={u.avatar_kind}
                avatarColor={u.avatar_color}
                size={32}
              />
              <span className="min-w-0 flex-1">
                <span className="streamer block truncate text-sm font-medium text-on-surface">
                  {u.display_name}
                </span>
                <span className="streamer block truncate text-xs text-on-surface-variant">
                  {u.username}
                </span>
              </span>
            </li>
          ))}
          {more > 0 && (
            <li className="px-2 py-2 text-xs text-on-surface-variant">And {more} more</li>
          )}
        </ul>
      </div>
    </div>,
    document.body
  )
}

export function QuickReactions({ m, anchor }: { m: Message; anchor: HTMLElement | null }) {
  const top = useTopEmojis(3)
  const coarse = useMedia(COARSE_QUERY)
  const toggle = useStore(s => s.toggleReaction)
  const close = useStore(s => s.closeContextMenu)
  const openPicker = useStore(s => s.openReactPicker)
  const size = coarse ? 'h-12 w-12 text-[26px]' : 'h-9 w-9 text-[20px]'
  const full = reactionsFull(m)
  return (
    <div className={`flex items-center gap-1 ${coarse ? 'justify-around' : ''}`}>
      {top.map(e => {
        const on = reacted(m, e)
        const blocked = !on && !canAddEmoji(m, e)
        return (
          <button
            key={e}
            type="button"
            title={blocked ? FULL_TITLE : `React with ${e}`}
            aria-label={`React with ${e}`}
            aria-pressed={on}
            aria-disabled={blocked || undefined}
            onClick={() => {
              if (blocked) return
              close()
              toggle(m, e)
            }}
            className={`flex items-center justify-center rounded-full font-emoji leading-none ${size} ${
              on
                ? 'bg-primary/15 ring-2 ring-primary ring-inset'
                : blocked
                  ? `${blockedCls} bg-surface-container-highest`
                  : 'bg-surface-container-highest hover:bg-surface-variant active:bg-surface-variant'
            }`}
          >
            {e}
          </button>
        )
      })}
      <button
        type="button"
        title={full ? FULL_TITLE : 'Add reaction'}
        aria-label="Add reaction"
        aria-disabled={full || undefined}
        onClick={() => {
          if (full) return
          close()
          openPicker(m, anchor?.isConnected ? anchor : null)
        }}
        className={`flex items-center justify-center rounded-full bg-surface-container-highest text-on-surface-variant ${size} ${
          full
            ? blockedCls
            : 'hover:bg-surface-variant hover:text-on-surface active:bg-surface-variant'
        }`}
      >
        <SmilePlus size={coarse ? 24 : 18} />
      </button>
    </div>
  )
}

export function ReactionPickerHost() {
  const picker = useStore(s => s.reactPicker)
  const close = useStore(s => s.closeReactPicker)
  const toggle = useStore(s => s.toggleReaction)
  if (!picker) return null
  return (
    <EmojiPicker
      anchor={picker.anchor?.isConnected ? picker.anchor : null}
      side="top"
      align="end"
      label="Add reaction"
      onPick={e => toggle(picker.message, e, false)}
      onClose={close}
    />
  )
}

export const rowAt = (x: number, y: number) => {
  const hit = document.elementFromPoint(x, y)
  const row = hit instanceof Element ? hit.closest('[data-mid]') : null
  return row instanceof HTMLElement ? row : null
}
