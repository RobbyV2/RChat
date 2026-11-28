'use client'

import { fromLive } from '../lib/load'
import { time } from '../lib/platform/time'
import { Loaded, useLoad } from './loaded'
import { useStoreApi } from '../lib/client/react'
import { isUnsupported } from '../lib/place/feature'
import { pins as pinsFeature, type Pinned, type Pins, type PinsState } from '../lib/place/pins'
import { useFeature, useLive } from '../lib/place/react'
import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  type MouseEvent,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { ChartColumn, FileText, Pin, X, type LucideIcon } from 'lucide-react'
import { PreviewSpoiler, RevealChannelPreview } from './preview_reveal'
import { useMediaSrc } from '../lib/media_src'
import { PINS_TITLE } from '../lib/pins'
import { channelCan, useMask, useStore } from '../lib/store'
import { useForwardAccess } from '../lib/forward_access'
import type { Message, MessageMedia } from '../lib/types'
import { longPress, useMedia } from './context_menu'
import { SHEET_QUERY } from './emoji_picker'
import { IMAGE_EXT, MarkdownMessage } from './markdown_message'
import { profileTrigger } from './profile_card'
import { Button, IconButton } from './controls'
import { CloseButton, Masked, Sheet, useOwn } from './ui'
import { ShownAvatar, ShownName } from './shown_user'
import { MessageTime } from './timestamp'
import { useMyTimeoutEnds } from './timeout_dialog'
import { Row, Stack, Surface, Inset } from './layout'

// Pinning and unpinning: either DM participant, or a member with Pin messages in the channel.
export function useCanPin() {
  const server = useStore(s => (s.view?.kind === 'channel' ? s.view.server : null))
  const timedOut = useMyTimeoutEnds(server) !== null
  const can = useStore(s => {
    const v = s.view
    if (!v || !s.me || s.guest) return false
    if (v.kind === 'dm') return true
    const held = channelCan(s, v.server, v.channelId)
    return s.me.servers.some(x => x.name === v.server) && held.pin && held.send
  })
  return can && !timedOut
}

function PinsToggle({ pins, narrowHidden }: { pins: Pins; narrowHidden: boolean }) {
  const open = useLive(pins.state).open
  return (
    <IconButton
      icon={Pin}
      label={PINS_TITLE}
      size="lg"
      tone={open ? 'primary' : 'inherit'}
      data-pins-button
      aria-haspopup="dialog"
      aria-expanded={open}
      onClick={() => (open ? pins.close() : pins.open())}
      place={narrowHidden ? '@max-sm:hidden' : undefined}
    />
  )
}

// The header button of the place around it.
export function PinsButton({ narrowHidden = false }: { narrowHidden?: boolean }) {
  const here = useFeature(pinsFeature)
  return isUnsupported(here) ? null : <PinsToggle pins={here} narrowHidden={narrowHidden} />
}

const pinLinkCls =
  'cursor-pointer rounded-sm font-medium text-on-surface outline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-primary'

// "alice pinned a message to this channel. See all pinned messages." for the messages of any
// place: `name` as the place shows people, `target` null when the message is gone.
export function PinLine({
  row,
  inner,
  divider,
  press,
  name,
  place,
  ts,
  target,
}: {
  row: Record<string, string | number>
  inner?: Record<string, string>
  divider: ReactNode
  press: ReturnType<typeof longPress>
  name: ReactNode
  place: 'conversation' | 'channel'
  ts: number
  target: string | null
}) {
  const here = useFeature(pinsFeature)
  const pins = isUnsupported(here) ? null : here
  return (
    <div {...row}>
      {divider}
      <Inset
        {...inner}
        {...press}
        row
        pad="lg"
        inset="line"
        gap="md"
        align="start"
        look="hover:bg-surface-container-low"
      >
        <span className="flex h-lh w-9 shrink-0 items-center justify-center text-on-surface-variant">
          <Pin size={16} />
        </span>
        <p className="min-w-0 flex-1 text-sm text-on-surface-variant">
          {name} pinned{' '}
          {target !== null && pins ? (
            <button type="button" onClick={() => pins.show(target)} className={pinLinkCls}>
              a message
            </button>
          ) : (
            'a message'
          )}{' '}
          to this {place}. See all{' '}
          <button type="button" onClick={() => pins?.open()} className={pinLinkCls}>
            pinned messages
          </button>
          . <MessageTime ts={ts} className="text-xs opacity-70" />
        </p>
      </Inset>
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
  const store = useStoreApi()
  const target = m.pin_message_id ?? null
  return (
    <PinLine
      row={{ 'data-row': '', 'data-mid': m.id }}
      divider={divider}
      press={longPress((x, y) => onMenu(m, x, y))}
      name={
        <ShownName
          user={m.author}
          server={server}
          link
          {...profileTrigger(store, m.author, server)}
          look="font-medium text-on-surface"
        />
      }
      place={m.dm_id !== null ? 'conversation' : 'channel'}
      ts={m.created_at}
      target={target === null ? null : String(target)}
    />
  )
}

function PinMedia({ m, server }: { m: Message; server: string | null }) {
  const media = m.media
  if (!media) return null
  if (media.removed)
    return <p className="text-xs text-on-surface-variant italic">Attachment removed</p>
  const preview = (
    <PinMediaContent media={media} server={server} by={m.webhook ? null : m.author.username} />
  )
  return media.spoiler ? (
    <PreviewSpoiler key={media.id} file>
      {preview}
    </PreviewSpoiler>
  ) : (
    preview
  )
}

function PinMediaContent({
  media,
  server,
  by,
}: {
  media: MessageMedia
  server: string | null
  by: string | null
}) {
  const previews = useStore(s => s.settings.asset_previews)
  const image = media.kind === 'server' && previews && IMAGE_EXT.test(media.filename)
  const filename = useMask(useOwn(by), true)
  const src = useMediaSrc(media.id, server ?? undefined, image)
  if (image && src)
    return (
      <img
        src={src}
        alt={filename(media.filename)}
        loading="lazy"
        className="max-h-28 max-w-full rounded-lg"
      />
    )
  return (
    <Surface
      as="span"
      row
      pad="sm"
      inset="chip"
      gap="xs"
      tone="highest"
      radius="md"
      fit
      text="xs"
      ink="muted"
    >
      <FileText size={12} className="shrink-0 text-primary" />
      <span className="truncate">
        <Masked text={media.filename} file by={by} />
      </span>
    </Surface>
  )
}

function PinEntry({
  pinned,
  server,
  canUnpin,
  onJump,
  onUnpin,
  profiles,
}: {
  pinned: Pinned
  server: string | null
  canUnpin: boolean
  onJump: (key: string) => void
  onUnpin: (key: string) => void
  profiles: boolean
}) {
  const store = useStoreApi()
  const { key, message: m } = pinned
  const { access, target } = useForwardAccess(m, { server: server ?? undefined })
  const text = { ...m, media: null, embeds: [] }
  const onClick = (e: MouseEvent) => {
    const hit = e.target instanceof Element ? e.target.closest('a, button, [role="button"]') : null
    if (hit && hit !== e.currentTarget) return
    onJump(key)
  }
  return (
    <Surface
      onClick={onClick}
      as="li"
      pad="md"
      inset="bar"
      gap="2xs"
      tone="base"
      radius="lg"
      border
      look="cursor-pointer hover:bg-surface-container-highest"
      place="group/pin relative"
    >
      <Row gap="sm" look="pointer-coarse:min-h-11" place="min-w-0">
        <ShownAvatar user={m.author} server={server} size={24} />
        <ShownName
          user={m.author}
          server={server}
          link={profiles}
          {...(profiles ? profileTrigger(store, m.author, server) : {})}
          place="min-w-0"
          look="truncate text-sm font-medium text-on-surface"
        />
        <MessageTime ts={m.created_at} className="shrink-0 text-xs text-on-surface-variant" />
        <span aria-hidden className="w-20 shrink-0 pointer-coarse:w-30" />
      </Row>
      {m.forward && <p className="text-xs text-on-surface-variant italic">Forwarded</p>}
      {(m.kind === 'poll' || m.poll?.snapshot) && (
        <Row as="p" gap="2xs" text="xs" ink="primary" look="font-medium">
          <ChartColumn size={12} />
          Poll
        </Row>
      )}
      {access === 'open' ? (
        <>
          <div className="max-h-36 overflow-hidden">
            <MarkdownMessage message={text} />
          </div>
          <PinMedia m={m} server={server} />
        </>
      ) : (
        <Row as="p" gap="2xs" wrap text="sm" ink="muted" place="min-w-0">
          <span className="italic">Forwarded message</span>
          {target && <RevealChannelPreview target={target} />}
        </Row>
      )}
      <Row gap="2xs" place="absolute top-2 right-2">
        <Button
          variant="tonal"
          onClick={() => onJump(key)}
          place="opacity-0 group-focus-within/pin:opacity-100 group-hover/pin:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100"
        >
          Jump
        </Button>
        {canUnpin && (
          <IconButton
            icon={X}
            label="Unpin Message"
            tone="danger"
            size="sm"
            onClick={() => onUnpin(key)}
          />
        )}
      </Row>
    </Surface>
  )
}

function PinsList({ pins, canUnpin }: { pins: Pins; canUnpin: boolean }) {
  const state = useLive(pins.state)
  if (!state.open) return null
  return <PinsPanel pins={pins} state={state} canUnpin={canUnpin} />
}

// The pinned messages of the conversation on screen in the place around it, while they are
// open. `canUnpin`: whether you may change the pins there now.
export function PinsWindow({ canUnpin }: { canUnpin: boolean }) {
  const here = useFeature(pinsFeature)
  return isUnsupported(here) ? null : <PinsList pins={here} canUnpin={canUnpin} />
}

// A list that drops down from a conversation's header button (`button`, a selector of it), as a
// popover, or a sheet on phones: its title row (with a close button, on a sheet too with
// `sheetClose`), then `children`.
export function HeaderPopover({
  icon: Icon,
  title,
  button,
  sheetClose = false,
  onClose,
  children,
}: {
  icon: LucideIcon
  title: string
  button: string
  sheetClose?: boolean
  onClose: () => void
  children: ReactNode
}) {
  const store = useStoreApi()
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
      const s = store.getState()
      if (s.confirm || s.contextMenu || s.profile) return
      const modal = document.querySelector('[aria-modal="true"]')
      if (modal && !rootRef.current?.contains(modal)) return
      e.preventDefault()
      closeRef.current()
    }
    const onDown = (e: PointerEvent) => {
      const t = e.target
      if (!(t instanceof Element)) return
      const s = store.getState()
      if (s.confirm || s.contextMenu || s.profile) return
      if (rootRef.current?.contains(t) || t.closest(`${button}, [aria-modal="true"]`)) return
      closeRef.current()
    }
    window.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onDown, true)
    return () => {
      window.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onDown, true)
    }
  }, [store, button])

  useLayoutEffect(() => {
    if (!sheet) return
    const active = document.activeElement
    if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) active.blur()
  }, [sheet])

  const body = (
    <>
      <Inset row pad="lg" inset="bar" gap="sm" place="shrink-0">
        <Icon size={18} className="text-on-surface-variant" />
        <h2 id={titleId} className="flex-1 text-base font-medium text-on-surface">
          {title}
        </h2>
        {(!sheet || sheetClose) && <CloseButton onClick={onClose} />}
      </Inset>
      {children}
    </>
  )

  if (sheet)
    return createPortal(
      <Sheet
        layer="page"
        height="list"
        overlay={{ 'data-popover': '' }}
        onClose={onClose}
        ref={rootRef}
        aria-labelledby={titleId}
      >
        {body}
      </Sheet>,
      document.body
    )

  return (
    <div
      ref={rootRef}
      role="dialog"
      aria-labelledby={titleId}
      data-popover
      className="absolute top-14 right-2 z-popover flex max-h-popover w-104 max-w-popover flex-col overflow-hidden rounded-2xl bg-surface-container-high shadow-elevation-3"
    >
      {body}
    </div>
  )
}

// The pinned messages of one conversation, as a popover (a sheet on phones).
function PinsPanel({ pins, state, canUnpin }: { pins: Pins; state: PinsState; canUnpin: boolean }) {
  const { place } = state
  const load = useLoad(
    useMemo(
      () =>
        fromLive<PinsState, Pinned[]>(
          time(),
          pins.state,
          (s, make) => {
            if (s.list === null)
              return s.failed ? make.failed('Try again in a moment.') : make.loading()
            return s.list.length ? make.ready(s.list) : make.empty()
          },
          pins.open
        ),
      [pins]
    )
  )
  return (
    <HeaderPopover icon={Pin} title={PINS_TITLE} button="[data-pins-button]" onClose={pins.close}>
      <Surface
        tone="plain"
        radius="none"
        border="top"
        pad="md"
        place="min-h-0 flex-1 overflow-y-auto overscroll-contain"
      >
        <Loaded
          load={load}
          what="pinned messages"
          empty={
            <Surface tone="plain" radius="none" pad="2xl" gap="md" align="center">
              <span className="flex h-14 w-14 items-center justify-center rounded-full bg-surface-container-highest text-on-surface-variant">
                <Pin size={26} />
              </span>
              <p className="text-center text-sm text-on-surface-variant">{`This ${place} doesn't have any pinned messages yet.`}</p>
            </Surface>
          }
        >
          {list => (
            <Stack as="ul" gap="sm" aria-label={`Pinned messages in this ${place}`}>
              {list.map(pinned => (
                <PinEntry
                  key={pinned.key}
                  pinned={pinned}
                  server={state.server}
                  canUnpin={canUnpin}
                  onJump={pins.jump}
                  onUnpin={pins.unpin}
                  profiles={state.profiles}
                />
              ))}
            </Stack>
          )}
        </Loaded>
      </Surface>
    </HeaderPopover>
  )
}
