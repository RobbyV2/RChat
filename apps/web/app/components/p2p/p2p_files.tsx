'use client'
import { Name } from '../name'
import { instanceName } from '../../lib/names'
import { altText, describableFile } from '../../lib/alt_text'
import { AltField } from '../alt_text'
import { withP2pIdentity } from '../../lib/client/p2p_react'

import { useP2pApp, useP2p } from '../../lib/client/p2p_react'

import { useAccount } from '../../lib/client/react'

import { useEffect, useState } from 'react'
import { Download, Eye, EyeOff, FileText, Loader2, Waypoints, X } from 'lucide-react'
import { useMask, useStore } from '../../lib/store'
import { peerChat } from '../../lib/actions/p2p_chat'
import { fmtSize } from '../../lib/bytes'
import { downloadName, kindOf } from '../../lib/sniff'
import { type FileView, type PendingFile } from '../../lib/p2p/app'
import type { Attachment } from '../../lib/p2p/content'
import { AUTO_PAUSED_TEXT } from '../../lib/p2p/dm'
import { SpoilerCover } from '../markdown_message'
import { FileCard } from '../file_card'
import { cardMenu, fileKind, pct } from '../../lib/file_card'
import { ViewableImage } from '../media_lightbox'
import { VideoAttachment } from '../video_attachment'
import { Masked } from '../ui'
import { useInstanceLabel } from '../instance_badge'
import { Row, Stack, Surface, Inset } from '../layout'

// P2P attachments in messages and in the composer. What a file is shown as comes from its
// stored bytes only (sniff.ts): images, video and audio play inline, everything else (SVG and
// HTML included) is offered as a download under a safe name.

const iconBtn =
  'shrink-0 rounded-full p-1 text-on-surface-variant hover:bg-surface-container-high hover:text-primary disabled:opacity-40'

const fmtDur = (ms: number) => {
  const s = Math.round(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export const statusText = (v: FileView | undefined) => {
  if (!v) return null
  switch (v.state) {
    case 'downloading':
      return `Downloading ${pct(v)}%`
    case 'removed':
      return 'Removed'
    case 'failed':
      return v.error ?? "Couldn't download"
    case 'done':
      return null
    default:
      if (v.paused) return AUTO_PAUSED_TEXT[v.paused]
      return v.holders > 0
        ? `Available from ${v.holders} online ${v.holders === 1 ? 'member' : 'members'}`
        : 'Unavailable right now: nobody who has this file is online'
  }
}

function useThumb(thumb: string | undefined) {
  const identity = useP2pApp()!
  const { p2pFiles } = identity

  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    void p2pFiles.thumb(thumb).then(u => live && setUrl(u))
    return () => {
      live = false
    }
  }, [thumb])
  return url
}

function useFileUrl(h: string, ready: boolean) {
  const identity = useP2pApp()!
  const { p2pFiles } = identity

  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!ready) return setUrl(null)
    let live = true
    void p2pFiles.url(h).then(u => live && setUrl(u))
    return () => {
      live = false
      p2pFiles.unuse(h)
    }
  }, [h, ready])
  return url
}

function Tile({
  att,
  canFetch,
  own,
  message,
  index,
}: {
  att: Attachment
  canFetch: boolean
  own: boolean
  message?: string
  index: number
}) {
  const identity = useP2pApp()!
  const { p2pFiles } = identity

  const acct = useAccount()

  const v = useP2p(s => s.files[att.h])
  const textOnly = useStore(s => !s.settings.asset_uploads && !s.settings.p2p_attachments)
  const done = v?.state === 'done'
  const url = useFileUrl(att.h, done && !!v.type && kindOf(v.type) !== null)
  const { label } = useInstanceLabel()
  const thumb = useThumb(done ? undefined : att.thumb)
  const placeholder = useThumb(done ? att.thumb : undefined)
  useEffect(() => {
    if (!textOnly) p2pFiles.watch(att)
  }, [att, textOnly])

  if (textOnly)
    return (
      <p className="msg-part text-xs text-on-surface-variant italic">
        Attachment hidden: <Name of={instanceName(label)} /> is text only
      </p>
    )
  return (
    <TileView
      att={att}
      canFetch={canFetch}
      own={own}
      message={message}
      index={index}
      v={v}
      placeholder={placeholder}
      url={url}
      thumb={thumb}
      save={() => void p2pFiles.save(att)}
      get={() => peerChat.forIdentity(identity).startDownload(att, acct)}
      cancel={() => void p2pFiles.cancel(att.h)}
      live={src => p2pFiles.liveUrl(att.h) === src}
    />
  )
}

// A P2P attachment as its state `v` shows it, with `url` the stored file once it plays inline
// and `thumb` its checked preview. An image opens in the viewer with the others of its
// `message`'s group, `index` being its place among the message's attachments.
export function TileView({
  att,
  canFetch,
  own,
  message,
  index = 0,
  v,
  placeholder = null,
  url,
  thumb,
  save,
  get,
  cancel,
  live = () => true,
}: {
  att: Attachment
  canFetch: boolean
  own: boolean
  message?: string
  index?: number
  v: FileView | undefined
  // The checked preview of a stored image, shown in the viewer while the image loads.
  placeholder?: string | null
  url: string | null
  thumb: string | null
  save: () => void
  get: () => void
  cancel: () => void
  // Whether `src` is the stored file's live URL now.
  live?: (src: string) => boolean
}) {
  // Shown cleaned like the saved name: no direction overrides or control characters.
  const clean = downloadName(att.name)
  const name = useMask(own)(clean)
  const [revealed, setRevealed] = useState(false)
  const done = v?.state === 'done'
  const kind = done && v.type ? kindOf(v.type) : null
  const hidden = !!att.spoiler && !revealed
  const status = statusText(v)
  const busy = v?.state === 'downloading'
  const canGet = canFetch && !done && !busy && v?.state !== 'removed' && !!v && v.holders > 0

  const caption = (
    <Row as="span" gap="sm" look="msg-part" place="max-w-full">
      <span className="max-w-60 truncate text-xs text-on-surface-variant">
        <Masked text={clean} own={own} />
      </span>
      <span className="shrink-0 text-xs text-on-surface-variant tabular-nums">
        {fmtSize(att.size)}
      </span>
      <button title={`Save ${name}`} aria-label="Save" onClick={save} className={iconBtn}>
        <Download size={14} />
      </button>
    </Row>
  )

  const card = {
    name: clean,
    own,
    fileMask: false,
    kind: fileKind(clean, att.mime),
    size: att.size,
    detail: att.dur !== undefined ? ` · ${fmtDur(att.dur)}` : undefined,
    dashed: true,
    primary: done
      ? { label: 'Save' as const, onClick: save }
      : { label: 'Download' as const, onClick: get, disabled: !canGet },
    menu: { download: done ? save : canGet ? get : null, link: null },
  }

  if (hidden) {
    if (kind === 'image' && url)
      return (
        <button
          data-file-spoiler
          title="Click to reveal"
          onClick={() => setRevealed(true)}
          className="msg-part relative block w-fit overflow-hidden rounded-xl"
        >
          <img src={url} alt="Spoiler" className="max-h-80 max-w-full blur-2xl" />
          <span className="absolute inset-0 flex items-center justify-center">
            <Inset
              as="span"
              pad="md"
              inset="chip"
              look="rounded-full bg-scrim/70 text-xs font-medium tracking-wide text-white uppercase"
            >
              Spoiler
            </Inset>
          </span>
        </button>
      )
    return (
      <div data-file-spoiler>
        <SpoilerCover title="Click to reveal" onReveal={() => setRevealed(true)} />
      </div>
    )
  }

  if (done && url && kind === 'image')
    return (
      <ViewableImage
        message={message}
        index={index}
        item={{
          src: url,
          name: clean,
          own,
          fileMask: false,
          size: att.size,
          w: att.w,
          h: att.h_px,
          placeholder,
          alt: altText(att.alt),
        }}
        menu={cardMenu(clean, { ...card, progress: null })}
        width={att.w}
        height={att.h_px}
        className="h-auto max-h-80 w-auto max-w-full rounded-xl"
        data={{ 'data-p2p-file': att.h }}
      >
        {caption}
      </ViewableImage>
    )

  const stored = (
    <p className="msg-part-loose text-xs text-on-surface-variant">
      {v?.tooBig
        ? 'Stored on this device. Too large to show here: save it to view.'
        : 'Stored on this device'}
    </p>
  )

  if (done && url && kind === 'video')
    return (
      <VideoAttachment
        src={url}
        name={clean}
        own={own}
        fileMask={false}
        primary={card.primary}
        menu={card.menu}
        w={att.w}
        h={att.h_px}
        remember={{ key: `p2p:${att.h}`, live }}
        data={{ 'data-p2p-file': att.h }}
        fallback={
          <FileCard
            {...card}
            data={{ 'data-p2p-file': att.h, 'data-state': 'done' }}
            progress={null}
          >
            {stored}
          </FileCard>
        }
      />
    )

  if (done && url && kind === 'audio')
    return (
      <FileCard {...card} data={{ 'data-p2p-file': att.h }} progress={null}>
        <audio src={url} controls className="msg-part-loose w-full" />
      </FileCard>
    )

  return (
    <FileCard
      {...card}
      data={{ 'data-p2p-file': att.h, 'data-state': v?.state ?? 'none' }}
      progress={busy && v ? { got: v.got, total: v.total } : null}
      onCancel={cancel}
      preview={
        thumb && (
          <img
            src={thumb}
            alt=""
            aria-hidden
            className="max-h-40 max-w-60 rounded-lg object-contain"
          />
        )
      }
    >
      {status && !busy && (
        <p
          data-file-status
          className={`msg-part-loose text-xs ${v?.state === 'failed' ? 'text-error' : 'text-on-surface-variant'}`}
        >
          {status}
        </p>
      )}
      {done && (kind === null || v.tooBig) && stored}
    </FileCard>
  )
}

// `own`: files you sent, whose names are never masked for you. `message`: the message they are
// attached to, whose group their images open with in the viewer.
export function AttachmentList({
  att,
  canFetch,
  own = false,
  message,
}: {
  att: Attachment[]
  canFetch: boolean
  own?: boolean
  message?: string
}) {
  if (!att.length) return null
  return (
    <Stack gap="2xs">
      {att.map((a, i) => (
        <Tile key={a.h} att={a} canFetch={canFetch} own={own} message={message} index={i} />
      ))}
    </Stack>
  )
}

function PendingChip({ room, p }: { room: string; p: PendingFile }) {
  const identity = useP2pApp()!
  const { p2pFiles } = identity

  const ready = p.hashed !== null && p.preview !== null
  const thumb = useThumb(p.preview?.thumb)
  return (
    <Surface
      data-pending-file
      pad="sm"
      tone="base"
      radius="lg"
      justify="between"
      look="h-24 w-40 border-tertiary/60 border-dashed border"
      place="relative shrink-0"
    >
      <Surface
        title="Remove file"
        aria-label="Remove file"
        onClick={() => p2pFiles.remove(room, p.id)}
        as="button"
        pad="2xs"
        tone="error"
        radius="full"
        elevation={1}
        place="absolute -top-2 -right-2"
      >
        <X size={12} />
      </Surface>
      <Row gap="2xs" justify="between">
        {thumb ? (
          <img src={thumb} alt="" aria-hidden className="h-10 w-14 rounded object-cover" />
        ) : (
          <FileText size={20} className="text-tertiary" />
        )}
        <Inset
          title={p.spoiler ? 'Unmark spoiler' : 'Mark as spoiler'}
          aria-label={p.spoiler ? 'Unmark spoiler' : 'Mark as spoiler'}
          onClick={() => p2pFiles.toggleSpoiler(room, p.id)}
          as="button"
          pad="2xs"
          look={`rounded-full ${p.spoiler ? 'bg-primary-container text-on-primary-container' : 'text-on-surface-variant hover:bg-surface-container-high'}`}
        >
          {p.spoiler ? <EyeOff size={14} /> : <Eye size={14} />}
        </Inset>
      </Row>
      <span className="truncate text-xs">
        {p.spoiler ? 'Spoiler · ' : ''}
        {downloadName(p.file.name)}
      </span>
      <Row as="span" gap="2xs">
        {!p.error && !ready && (
          <Loader2 size={10} className="text-on-surface-variant motion-safe:animate-spin" />
        )}
        <span
          className={`text-2xs tabular-nums ${p.error ? 'text-error' : 'text-on-surface-variant'}`}
        >
          {p.error
            ? p.error
            : ready
              ? fmtSize(p.file.size)
              : `Preparing ${Math.floor(p.progress * 100)}%`}
        </span>
      </Row>
    </Surface>
  )
}

function PendingFilesBody({ room }: { room: string }) {
  const { p2pFiles } = useP2pApp()!
  const list = useP2p(s => s.attaching[room])
  if (!list?.length) return null
  return (
    <Surface
      pad="sm"
      tone="plain"
      radius="none"
      align="start"
      place="w-full overflow-x-auto"
      aria-label="Files to send"
    >
      <Row gap="md" align="stretch">
        {list.map(p => (
          <div key={p.id} className="w-40 shrink-0">
            <Stack gap="2xs">
              <PendingChip room={room} p={p} />
              {describableFile(p.file.name, p.file.type) && (
                <AltField
                  compact
                  value={p.alt ?? ''}
                  onChange={v => p2pFiles.setAlt(room, p.id, v)}
                />
              )}
            </Stack>
          </div>
        ))}
        <Inset
          title="Sent peer-to-peer: stored on your devices and shared with the people in this conversation"
          as="span"
          row
          pad="xs"
          inset="chip"
          gap="2xs"
          look="rounded bg-tertiary-container text-2xs font-medium text-on-tertiary-container"
          place="shrink-0 self-end"
        >
          <Waypoints size={10} />
          P2P
        </Inset>
      </Row>
    </Surface>
  )
}

export const PendingFiles = withP2pIdentity(PendingFilesBody)
