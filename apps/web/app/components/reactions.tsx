'use client'

import { Name } from './name'
import { handleName, personCalled, personName } from '../lib/names'
import { nameWithUsername } from '../lib/display_name'
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { SmilePlus } from 'lucide-react'
import { useMask, useStore } from '../lib/store'
import type { Message, Reaction, UserRef } from '../lib/types'
import {
  FULL_TITLE,
  canAddEmoji,
  reactionsFull,
  emojiCode,
  peopleText,
  reacted,
  reactionLabel,
  reactorNames,
  reactorsParts,
} from '../lib/reactions'
import { EmojiPicker, useEmojiNow, useTopEmojis } from './emoji_picker'
import { COARSE_QUERY, longPress, useMedia } from './context_menu'
import { ShownAvatar, useShown, useViewServer } from './shown_user'
import { CloseButton, Sheet, useOwnCheck } from './ui'
import { centerEmoji } from '../lib/emoji_center'
import { useChat } from '../lib/place/use_chat'
import { Surface, Row, Inset } from './layout'
import { time } from '../lib/platform/time'
import { Chip, IconButton } from './controls'
import { plays, playsOn } from '../lib/motion/play'

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
// The glyph moves by the emoji font's own offset (`centerEmoji`), so it sits in the pill's middle.
const emojiCls = 'relative top-emoji-shift font-emoji text-base leading-none'

function useReactors(messageId: number, emoji: string, count: number, enabled: boolean) {
  const { loadReactors: load } = useChat()
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
  const data = useEmojiNow()
  const users = useReactors(messageId, r.emoji, r.count, !streamer)
  const own = useOwnCheck()
  const mask = useMask()
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const code = data ? emojiCode(data, r.emoji) : null
  const names = users ? reactorNames(users, own, mask) : null

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
    <Surface
      ref={plays('tooltip', ref)}
      id={id}
      role="tooltip"
      data-reaction-tooltip
      aria-label={reactionLabel(r.emoji, code, names, r.count, streamer)}
      row
      pad="md"
      inset="bar"
      gap="md"
      tone="plain"
      radius="md"
      elevation={2}
      at={pos ?? { top: -9999, left: -9999 }}
      look="max-w-64 bg-inverse-surface text-inverse-on-surface"
      place="pointer-events-none fixed z-top"
    >
      <span aria-hidden className="shrink-0 font-emoji text-3xl leading-none">
        {r.emoji}
      </span>
      <span aria-hidden className="text-sm leading-snug">
        {code && <span className="font-semibold">:{code}: </span>}
        reacted by{' '}
        {streamer || names === null
          ? peopleText(r.count)
          : reactorsParts(users ?? [], r.count).map((p, i) =>
              typeof p === 'string' ? (
                p
              ) : (
                <Name key={i} of={personCalled(nameWithUsername(p.who), p.who.username)} />
              )
            )}
      </span>
    </Surface>,
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
  const { toggleReaction: toggle } = useChat()
  const coarse = useMedia(COARSE_QUERY)
  const ref = useRef<HTMLButtonElement>(null)
  const [tip, setTip] = useState(false)
  const tipId = useId()
  const active = r.me ? canRemove : canReact && canAddEmoji(m, r.emoji)
  return (
    <>
      <Chip
        ref={plays('reaction.add', ref)}
        data-reaction={r.emoji}
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
        variant="reaction"
        plain
        on={r.me}
        label={reactionAria(r)}
      >
        <span aria-hidden className={emojiCls}>
          {r.emoji}
        </span>
        <span ref={playsOn('reaction.count', r.count)} aria-hidden className="inline-block">
          {r.count}
        </span>
      </Chip>
      {tip && ref.current && (
        <ReactionTooltip anchor={ref.current} id={tipId} messageId={m.id} r={r} />
      )}
    </>
  )
}

function AddReactionChip({ m }: { m: Message }) {
  const { toggleReaction: toggle } = useChat()
  const ref = useRef<HTMLButtonElement>(null)
  const keyboard = useRef(false)
  const [open, setOpen] = useState(false)
  const full = reactionsFull(m)
  return (
    <>
      <IconButton
        icon={SmilePlus}
        label="Add reaction"
        tooltip={full ? FULL_TITLE : 'Add reaction'}
        ref={ref}
        aria-disabled={full || undefined}
        aria-expanded={open}
        data-open={open ? '' : undefined}
        onClick={e => {
          if (full) return
          keyboard.current = e.detail === 0
          setOpen(o => !o)
        }}
        tone="tonal"
        size="sm"
        place="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100 data-open:opacity-100"
      />
      {open && (
        <EmojiPicker
          anchor={ref.current}
          side="top"
          align="start"
          label="Add reaction"
          onPick={e => toggle(m, e, false)}
          onClose={() => {
            setOpen(false)
            if (keyboard.current) time().frame(() => ref.current?.focus())
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
  useEffect(centerEmoji, [])
  if (!list.length) return null
  return (
    <Row data-reactions gap="2xs" wrap look="msg-part">
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
    </Row>
  )
}

// A reactor under the name the open server shows.
function ReactorName({ user, server }: { user: UserRef; server: string | null }) {
  const shown = useShown(user, server)
  return <Name of={personName(shown)} look="block truncate text-sm font-medium text-on-surface" />
}

function ReactorsSheet({ m, start, onClose }: { m: Message; start: string; onClose: () => void }) {
  const server = useViewServer()
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
    <Sheet
      sheet={coarse}
      float={{ place: 'center-wide' }}
      selectable={!coarse}
      overlay={shield}
      onClose={onClose}
      aria-labelledby={titleId}
      data-popover=""
    >
      <Inset row pad="lg" inset="bar" justify="between" place="shrink-0">
        <h2 id={titleId} className="text-base font-medium text-on-surface">
          Reactions
        </h2>
        {!coarse && <CloseButton onClick={onClose} />}
      </Inset>
      <Inset
        role="tablist"
        aria-label="Reactions"
        row
        pad="lg"
        inset="bar"
        gap="xs"
        align="stretch"
        place="shrink-0 overflow-x-auto"
      >
        {list.map(r => (
          <Chip
            key={r.emoji}
            onClick={() => setPicked(r.emoji)}
            as="tab"
            variant="reaction"
            plain
            on={r.emoji === current.emoji}
            label={reactionAria(r)}
            place="shrink-0"
          >
            <span aria-hidden className={emojiCls}>
              {r.emoji}
            </span>
            <span aria-hidden>{r.count}</span>
          </Chip>
        ))}
      </Inset>
      <Inset
        role="tabpanel"
        aria-label={`${current.emoji} reacted by ${peopleText(current.count)}`}
        as="ul"
        pad="sm"
        border="top"
        look="min-h-24"
        place="overflow-y-auto overscroll-contain"
      >
        {users === null && (
          <Inset as="li" pad="sm" text="sm" ink="muted">
            Loading reactions
          </Inset>
        )}
        {users?.map(u => (
          <Surface as="li" key={u.username} pad="sm" gap="md" row tone="plain" radius="lg">
            <ShownAvatar user={u} server={server} size={32} />
            <span className="min-w-0 flex-1">
              <ReactorName user={u} server={server} />
              <Name
                of={handleName(u.username)}
                look="block truncate text-xs text-on-surface-variant"
              />
            </span>
          </Surface>
        ))}
        {more > 0 && (
          <Inset as="li" pad="sm" text="xs" ink="muted">
            And {more} more
          </Inset>
        )}
      </Inset>
    </Sheet>,
    document.body
  )
}

export function QuickReactions({ m, anchor }: { m: Message; anchor: HTMLElement | null }) {
  const top = useTopEmojis(3)
  const coarse = useMedia(COARSE_QUERY)
  const { toggleReaction: toggle, openReactPicker: openPicker } = useChat()
  const close = useStore(s => s.closeContextMenu)
  const full = reactionsFull(m)
  return (
    <Row gap="2xs" justify={coarse ? 'around' : 'start'}>
      {top.map(e => {
        const on = reacted(m, e)
        const blocked = !on && !canAddEmoji(m, e)
        return (
          <IconButton
            key={e}
            aria-disabled={blocked || undefined}
            onClick={() => {
              if (blocked) return
              close()
              toggle(m, e)
            }}
            glyph={e}
            label={`React with ${e}`}
            tooltip={blocked ? FULL_TITLE : `React with ${e}`}
            tone="tonal"
            size="xl"
            pressed={on}
          />
        )
      })}
      <IconButton
        icon={SmilePlus}
        label="Add reaction"
        tooltip={full ? FULL_TITLE : 'Add reaction'}
        aria-disabled={full || undefined}
        onClick={() => {
          if (full) return
          close()
          openPicker(m, anchor?.isConnected ? anchor : null)
        }}
        tone="tonal"
        size="xl"
      />
    </Row>
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
