'use client'

import { useEffect, useId, useLayoutEffect, useRef, type MouseEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { ChartColumn, EyeOff, FileText, Pin, X } from 'lucide-react'
import { useMediaSrc } from '../lib/media_src'
import { PINS_TITLE, noPinsText, pinPlace } from '../lib/pins'
import { myPerms, useStore, viewKey } from '../lib/store'
import { Perm, hasPerm, type Message } from '../lib/types'
import { longPress, useMedia } from './context_menu'
import { SHEET_QUERY } from './emoji_picker'
import { IMAGE_EXT, MarkdownMessage } from './markdown_message'
import { profileTrigger } from './profile_card'
import { UserAvatar } from './user_avatar'
import { CloseButton, Masked, SheetGrip } from './ui'
import { NameWithUsername } from './display_name'
import { nameTriggerCls } from './message_pane'
import { MessageTime } from './timestamp'
import { useMyTimeoutEnds } from './timeout_dialog'

// Pinning and unpinning: either DM participant, or a member with Manage messages.
export function useCanPin() {
  const server = useStore(s => (s.view?.kind === 'channel' ? s.view.server : null))
  const timedOut = useMyTimeoutEnds(server) !== null
  const can = useStore(s => {
    const v = s.view
    if (!v || !s.me || s.guest) return false
    if (v.kind === 'dm') return true
    return (
      s.me.servers.some(x => x.name === v.server) &&
      hasPerm(myPerms(s, v.server), Perm.DeleteMessages)
    )
  })
  return can && !timedOut
}

export const confirmUnpin = (unpin: () => void) =>
  useStore.getState().askConfirm({
    title: 'Unpin Message',
    body: 'Remove this message from the pinned messages?',
    confirm: 'Unpin',
    action: unpin,
  })

// The header button. `toggle` binds it to another pin list (a P2P conversation).
export function PinsButton({
  toggle,
  className = '',
}: {
  toggle?: { open: boolean; onClick: () => void }
  className?: string
}) {
  const storeOpen = useStore(
    s => s.pins !== null && s.view !== null && s.pins.key === viewKey(s.view)
  )
  const openPins = useStore(s => s.openPins)
  const closePins = useStore(s => s.closePins)
  const open = toggle ? toggle.open : storeOpen
  return (
    <button
      data-pins-button
      title={PINS_TITLE}
      aria-label={PINS_TITLE}
      aria-haspopup="dialog"
      aria-expanded={open}
      onClick={() => (toggle ? toggle.onClick() : open ? closePins() : openPins())}
      className={`rounded-full p-1.5 hover:bg-surface-container-high ${
        open ? 'bg-surface-container-high text-primary' : ''
      } ${className}`}
    >
      <Pin size={20} />
    </button>
  )
}

const pinLinkCls =
  'cursor-pointer rounded-sm font-medium text-on-surface outline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-primary'

// "alice pinned a message to this channel. See all pinned messages." for instance and P2P
// messages: `name` as the source shows people, `onMessage` null when the message is gone.
export function PinLine({
  row,
  inner,
  divider,
  press,
  name,
  place,
  ts,
  onMessage,
  onPins,
}: {
  row: Record<string, string | number>
  inner?: Record<string, string>
  divider: ReactNode
  press: ReturnType<typeof longPress>
  name: ReactNode
  place: 'conversation' | 'channel'
  ts: number
  onMessage: (() => void) | null
  onPins: () => void
}) {
  return (
    <div {...row}>
      {divider}
      <div
        {...inner}
        {...press}
        className="flex items-start gap-3 px-4 py-1 hover:bg-surface-container-low"
      >
        <span className="flex w-9 shrink-0 justify-center pt-0.5 text-on-surface-variant">
          <Pin size={16} />
        </span>
        <p className="min-w-0 flex-1 text-sm text-on-surface-variant">
          {name} pinned{' '}
          {onMessage ? (
            <button type="button" onClick={onMessage} className={pinLinkCls}>
              a message
            </button>
          ) : (
            'a message'
          )}{' '}
          to this {place}. See all{' '}
          <button type="button" onClick={onPins} className={pinLinkCls}>
            pinned messages
          </button>
          .<MessageTime ts={ts} className="ml-2 text-xs opacity-70" />
        </p>
      </div>
    </div>
  )
}

export function PinNotice({
  m,
  server,
  divider,
  onMenu,
}: {
  m: Message
  server: string | null
  divider: ReactNode
  onMenu: (m: Message, x: number, y: number) => void
}) {
  const openPins = useStore(s => s.openPins)
  const openPinned = useStore(s => s.openPinned)
  const scope = useStore(s => (s.view ? viewKey(s.view) : null))
  const target = m.pin_message_id ?? null
  return (
    <PinLine
      row={{ 'data-row': '', 'data-mid': m.id }}
      divider={divider}
      press={longPress((x, y) => onMenu(m, x, y))}
      name={
        <span
          {...profileTrigger(m.author, server)}
          className={`streamer font-medium text-on-surface ${nameTriggerCls}`}
        >
          <NameWithUsername user={m.author} />
        </span>
      }
      place={m.dm_id !== null ? 'conversation' : 'channel'}
      ts={m.created_at}
      onMessage={
        target !== null ? () => (scope ? void openPinned(scope, target) : undefined) : null
      }
      onPins={openPins}
    />
  )
}

function PinMedia({ m }: { m: Message }) {
  const previews = useStore(s => s.settings.asset_previews)
  const server = useStore(s => (s.view?.kind === 'channel' ? s.view.server : undefined))
  const media = m.media
  const image = media?.kind === 'server' && previews && IMAGE_EXT.test(media.filename)
  const src = useMediaSrc(media?.id ?? '', server, image && !media?.removed && !media?.spoiler)
  if (!media) return null
  if (media.removed)
    return <p className="mt-1 text-xs text-on-surface-variant italic">Attachment removed</p>
  if (media.spoiler)
    return (
      <span className="mt-1 flex w-fit items-center gap-1.5 rounded-lg bg-surface-container-highest px-2 py-1 text-xs text-on-surface-variant">
        <EyeOff size={12} />
        Spoiler
      </span>
    )
  if (image && src)
    return (
      <img
        src={src}
        alt={media.filename}
        loading="lazy"
        className="mt-1.5 max-h-28 max-w-full rounded-lg"
      />
    )
  return (
    <span className="mt-1 flex w-fit max-w-full items-center gap-1.5 rounded-lg bg-surface-container-highest px-2 py-1 text-xs text-on-surface-variant">
      <FileText size={12} className="shrink-0 text-primary" />
      <span className="truncate">
        <Masked text={media.filename} />
      </span>
    </span>
  )
}

function PinEntry({
  m,
  canUnpin,
  onJump,
  onUnpin,
  profiles,
}: {
  m: Message
  canUnpin: boolean
  onJump: (id: number) => void
  onUnpin: (id: number) => void
  profiles: boolean
}) {
  const server = useStore(s => (s.view?.kind === 'channel' ? s.view.server : null))
  const text = { ...m, media: null, embeds: [] }
  const onClick = (e: MouseEvent) => {
    const hit = e.target instanceof Element ? e.target.closest('a, button, [role="button"]') : null
    if (hit && hit !== e.currentTarget) return
    onJump(m.id)
  }
  return (
    <li
      onClick={onClick}
      className="group/pin relative cursor-pointer rounded-xl border border-outline-variant bg-surface-container px-3 py-2.5 hover:bg-surface-container-highest"
    >
      <div className="flex min-w-0 items-center gap-2 pr-20">
        <UserAvatar
          username={m.author.username}
          avatarKind={m.author.avatar_kind}
          avatarColor={m.author.avatar_color}
          size={24}
        />
        <span
          {...(profiles ? profileTrigger(m.author, server) : {})}
          className={`streamer min-w-0 truncate text-sm font-medium text-on-surface ${profiles ? nameTriggerCls : ''}`}
        >
          <NameWithUsername user={m.author} />
        </span>
        <MessageTime ts={m.created_at} className="shrink-0 text-xs text-on-surface-variant" />
      </div>
      {m.forward && <p className="mt-1 text-xs text-on-surface-variant italic">Forwarded</p>}
      {(m.kind === 'poll' || m.poll?.snapshot) && (
        <p className="mt-1 flex items-center gap-1 text-xs font-medium text-primary">
          <ChartColumn size={12} />
          Poll
        </p>
      )}
      <div className="mt-1 max-h-36 overflow-hidden">
        <MarkdownMessage message={text} />
      </div>
      <PinMedia m={m} />
      <div className="absolute top-2 right-2 flex items-center gap-1">
        <button
          type="button"
          onClick={() => onJump(m.id)}
          className="rounded-full bg-surface-container-highest px-2.5 py-1 text-xs font-medium text-on-surface opacity-0 group-focus-within/pin:opacity-100 group-hover/pin:opacity-100 hover:text-primary focus-visible:opacity-100 pointer-coarse:opacity-100"
        >
          Jump
        </button>
        {canUnpin && (
          <button
            type="button"
            title="Unpin Message"
            aria-label="Unpin Message"
            onClick={() => onUnpin(m.id)}
            className="rounded-full p-1 text-on-surface-variant hover:bg-surface-container-highest hover:text-error pointer-coarse:p-2"
          >
            <X size={16} />
          </button>
        )}
      </div>
    </li>
  )
}

export function PinsWindow() {
  const pins = useStore(s => s.pins)
  const scope = useStore(s => (s.view ? viewKey(s.view) : null))
  const closePins = useStore(s => s.closePins)
  const openPins = useStore(s => s.openPins)
  const jumpTo = useStore(s => s.jumpTo)
  const canUnpin = useCanPin()
  if (pins === null || pins.key !== scope || !scope) return null
  return (
    <PinsPanel
      list={pins.list}
      failed={pins.failed}
      place={pinPlace(scope)}
      empty={noPinsText(scope)}
      canUnpin={canUnpin}
      profiles
      onClose={closePins}
      onRetry={openPins}
      onJump={id => {
        closePins()
        void jumpTo(scope, id)
      }}
      onUnpin={id => confirmUnpin(() => void useStore.getState().unpinMessage(id))}
    />
  )
}

// The pinned messages of one conversation, as a popover (a sheet on phones).
export function PinsPanel({
  list,
  failed,
  place,
  empty,
  canUnpin,
  profiles,
  onClose,
  onRetry,
  onJump,
  onUnpin,
}: {
  list: Message[] | null
  failed: boolean
  place: string
  empty: string
  canUnpin: boolean
  profiles: boolean
  onClose: () => void
  onRetry: () => void
  onJump: (id: number) => void
  onUnpin: (id: number) => void
}) {
  const sheet = useMedia(SHEET_QUERY)
  const rootRef = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const closeRef = useRef(onClose)
  useEffect(() => {
    closeRef.current = onClose
  })

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.isComposing || e.defaultPrevented) return
      const s = useStore.getState()
      if (s.confirm || s.contextMenu || s.profile) return
      const modal = document.querySelector('[aria-modal="true"]')
      if (modal && !rootRef.current?.contains(modal)) return
      e.preventDefault()
      closeRef.current()
    }
    const onDown = (e: PointerEvent) => {
      const t = e.target
      if (!(t instanceof Element)) return
      const s = useStore.getState()
      if (s.confirm || s.contextMenu || s.profile) return
      if (rootRef.current?.contains(t) || t.closest('[data-pins-button], [aria-modal="true"]'))
        return
      closeRef.current()
    }
    window.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onDown, true)
    return () => {
      window.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onDown, true)
    }
  }, [])

  useLayoutEffect(() => {
    if (!sheet) return
    const active = document.activeElement
    if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) active.blur()
  }, [sheet])

  const body = (
    <>
      <div className="flex shrink-0 items-center gap-2 px-4 pb-2">
        <Pin size={18} className="text-on-surface-variant" />
        <h2 id={titleId} className="flex-1 text-base font-medium text-on-surface">
          {PINS_TITLE}
        </h2>
        {!sheet && <CloseButton onClick={onClose} />}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain border-t border-outline-variant px-3 pt-3 pb-3">
        {list === null && !failed && (
          <p className="px-1 py-6 text-center text-sm text-on-surface-variant">
            Loading pinned messages
          </p>
        )}
        {list === null && failed && (
          <div className="flex flex-col items-center gap-2 py-6 text-sm text-on-surface-variant">
            <span>Couldn&apos;t load pinned messages.</span>
            <button
              type="button"
              onClick={onRetry}
              className="rounded-full px-3 py-1.5 font-medium text-primary hover:bg-surface-container-highest"
            >
              Retry
            </button>
          </div>
        )}
        {list !== null && list.length === 0 && (
          <div className="flex flex-col items-center gap-3 px-4 py-8 text-center">
            <span className="flex h-14 w-14 items-center justify-center rounded-full bg-surface-container-highest text-on-surface-variant">
              <Pin size={26} />
            </span>
            <p className="text-sm text-on-surface-variant">{empty}</p>
          </div>
        )}
        {list !== null && list.length > 0 && (
          <ul className="flex flex-col gap-2" aria-label={`Pinned messages in this ${place}`}>
            {list.map(m => (
              <PinEntry
                key={m.id}
                m={m}
                canUnpin={canUnpin}
                onJump={onJump}
                onUnpin={onUnpin}
                profiles={profiles}
              />
            ))}
          </ul>
        )}
      </div>
    </>
  )

  if (sheet)
    return createPortal(
      <div
        data-popover
        onClick={e => {
          if (e.target === e.currentTarget) onClose()
        }}
        className="fixed inset-x-0 top-app z-40 flex h-app flex-col justify-end bg-scrim/40"
      >
        <div
          ref={rootRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          className="flex max-h-[80%] min-h-64 animate-sheet-up flex-col overflow-hidden rounded-t-3xl bg-surface-container-high px-safe pt-3 pb-[max(0.5rem,env(safe-area-inset-bottom))] shadow-elevation-3"
        >
          <SheetGrip />
          {body}
        </div>
      </div>,
      document.body
    )

  return (
    <div
      ref={rootRef}
      role="dialog"
      aria-labelledby={titleId}
      data-popover
      className="absolute top-14 right-2 z-30 flex max-h-[min(36rem,calc(100%-4.5rem))] w-[26rem] max-w-[calc(100%-1rem)] flex-col overflow-hidden rounded-2xl bg-surface-container-high pt-3 shadow-elevation-3"
    >
      {body}
    </div>
  )
}
