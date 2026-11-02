'use client'

import { useEffect, useState } from 'react'
import {
  Download,
  Eye,
  EyeOff,
  FileText,
  Film,
  ImageIcon,
  Loader2,
  Music,
  Play,
  Waypoints,
  X,
} from 'lucide-react'
import { maskOf, useMask, useStore, type ContextMenuItem } from '../../lib/store'
import { fmtSize } from '../../lib/bytes'
import { downloadName, kindOf } from '../../lib/sniff'
import { BIG_FILE, p2pFiles, useP2p, type FileView, type PendingFile } from '../../lib/p2p/app'
import type { Attachment } from '../../lib/p2p/event'
import { AUTO_PAUSED_TEXT } from '../../lib/p2p/dm'
import { SpoilerCover } from '../markdown_message'

// P2P attachments in messages and in the composer. What a file is shown as comes from its
// stored bytes only (sniff.ts): images, video and audio play inline, everything else (SVG and
// HTML included) is offered as a download under a safe name.

const iconBtn =
  'shrink-0 rounded-full p-1 text-on-surface-variant hover:bg-surface-container-high hover:text-primary disabled:opacity-40'

const claimKind = (a: Attachment) =>
  a.mime.startsWith('image/')
    ? 'image'
    : a.mime.startsWith('video/')
      ? 'video'
      : a.mime.startsWith('audio/')
        ? 'audio'
        : null

const pct = (v: FileView | undefined) =>
  v && v.total > 0 ? Math.min(100, Math.floor((v.got / v.total) * 100)) : 0

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

const startDownload = (att: Attachment) => {
  const run = () => void p2pFiles.download(att)
  if (att.size <= BIG_FILE) return run()
  useStore.getState().askConfirm({
    title: 'Download a large file',
    body: `This file is ${fmtSize(att.size)}. It is stored on this device and shared with others in this conversation.`,
    confirm: 'Download',
    action: run,
  })
}

// The message menu's way to the per-file buttons: save what is here, download what isn't.
export const attachmentMenu = (list: Attachment[], canFetch: boolean): ContextMenuItem | null => {
  const mask = maskOf(useStore.getState())
  const items: ContextMenuItem[] = list.map(att => {
    const v = useP2p.getState().files[att.h]
    const name = mask(downloadName(att.name))
    if (v?.state === 'done')
      return {
        label: name,
        subtitle: 'Save',
        icon: Download,
        action: () => void p2pFiles.save(att),
      }
    const busy = v?.state === 'downloading'
    return {
      label: name,
      subtitle: busy ? 'Cancel download' : 'Download',
      icon: busy ? X : Download,
      disabled: !busy && (!canFetch || !v || v.holders === 0),
      action: () => (busy ? void p2pFiles.cancel(att.h) : startDownload(att)),
    }
  })
  if (items.length === 0) return null
  if (items.length === 1)
    return { ...items[0], label: `${items[0].subtitle} attachment`, subtitle: items[0].label }
  return { label: 'Attachments', icon: Download, submenu: items }
}

function useThumb(thumb: string | undefined) {
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
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!ready) return setUrl(null)
    let live = true
    void p2pFiles.url(h).then(u => live && setUrl(u))
    return () => {
      live = false
    }
  }, [h, ready])
  return url
}

function Tile({ att, canFetch }: { att: Attachment; canFetch: boolean }) {
  // Shown cleaned like the saved name: no direction overrides or control characters.
  const name = useMask()(downloadName(att.name))
  const v = useP2p(s => s.files[att.h])
  const textOnly = useStore(s => !s.settings.asset_uploads && !s.settings.p2p_attachments)
  const [revealed, setRevealed] = useState(false)
  const done = v?.state === 'done'
  const kind = done && v.type ? kindOf(v.type) : null
  const url = useFileUrl(att.h, done && kind !== null)
  const thumb = useThumb(done ? undefined : att.thumb)
  useEffect(() => {
    if (!textOnly) p2pFiles.watch(att)
  }, [att, textOnly])

  if (textOnly)
    return (
      <p className="mt-1 text-xs text-on-surface-variant italic">
        Attachment hidden: this instance is text only
      </p>
    )
  const hidden = !!att.spoiler && !revealed
  const status = statusText(v)
  const busy = v?.state === 'downloading'
  const canGet = canFetch && !done && !busy && v?.state !== 'removed'

  const actions = (
    <>
      {busy && (
        <button
          title="Cancel download"
          aria-label="Cancel download"
          onClick={() => void p2pFiles.cancel(att.h)}
          className={iconBtn}
        >
          <X size={14} />
        </button>
      )}
      {canGet && (
        <button
          title={`Download ${fmtSize(att.size)}`}
          aria-label="Download"
          disabled={!v || v.holders === 0}
          onClick={() => startDownload(att)}
          className={iconBtn}
        >
          {kind === null && claimKind(att) === 'video' ? (
            <Play size={14} />
          ) : (
            <Download size={14} />
          )}
        </button>
      )}
      {done && (
        <button
          title={`Save ${name}`}
          aria-label="Save"
          onClick={() => void p2pFiles.save(att)}
          className={iconBtn}
        >
          <Download size={14} />
        </button>
      )}
    </>
  )

  const caption = (
    <span className="mt-1 flex max-w-full items-center gap-2">
      <span className="max-w-60 truncate text-xs text-on-surface-variant">{name}</span>
      <span className="shrink-0 text-xs text-on-surface-variant tabular-nums">
        {fmtSize(att.size)}
      </span>
      {actions}
    </span>
  )

  const progress = busy && (
    <div
      role="progressbar"
      aria-label={`Downloading ${name}`}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct(v)}
      className="mt-2 h-1 w-full min-w-40 overflow-hidden rounded-full bg-surface-container-highest"
    >
      <div className="h-full rounded-full bg-primary" style={{ width: `${pct(v)}%` }} />
    </div>
  )

  if (hidden) {
    if (kind === 'image' && url)
      return (
        <button
          data-file-spoiler
          title="Click to reveal"
          onClick={() => setRevealed(true)}
          className="relative mt-1 block w-fit cursor-pointer overflow-hidden rounded-xl"
        >
          <img src={url} alt="Spoiler" className="max-h-80 max-w-full blur-2xl" />
          <span className="absolute inset-0 flex items-center justify-center">
            <span className="rounded-full bg-scrim/70 px-3 py-1 text-xs font-medium tracking-wide text-white uppercase">
              Spoiler
            </span>
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
      <div data-p2p-file={att.h} className="mt-1 w-fit max-w-full">
        <img
          src={url}
          alt={name}
          width={att.w}
          height={att.h_px}
          className="h-auto max-h-80 w-auto max-w-full rounded-xl"
        />
        {caption}
      </div>
    )
  if (done && url && kind === 'video')
    return (
      <div data-p2p-file={att.h} className="mt-1 w-fit max-w-full">
        <video src={url} controls className="max-h-80 max-w-full rounded-xl" />
        {caption}
      </div>
    )
  if (done && url && kind === 'audio')
    return (
      <div data-p2p-file={att.h} className="mt-1 w-fit max-w-full">
        <audio src={url} controls className="max-w-full" />
        {caption}
      </div>
    )

  const Icon =
    claimKind(att) === 'image'
      ? ImageIcon
      : claimKind(att) === 'video'
        ? Film
        : claimKind(att) === 'audio'
          ? Music
          : FileText
  return (
    <div
      data-p2p-file={att.h}
      data-state={v?.state ?? 'none'}
      className="mt-1 w-fit max-w-full rounded-xl border border-dashed border-tertiary/60 bg-surface-container px-3 py-2"
    >
      {thumb && (
        <img
          src={thumb}
          alt=""
          aria-hidden
          className="mb-2 max-h-40 max-w-60 rounded-lg object-contain"
        />
      )}
      <div className="flex items-center gap-2">
        <Icon size={18} className="shrink-0 text-tertiary" />
        <span className="max-w-60 truncate text-sm">{name}</span>
        <span className="shrink-0 text-xs text-on-surface-variant tabular-nums">
          {fmtSize(att.size)}
          {att.dur !== undefined && ` · ${fmtDur(att.dur)}`}
        </span>
        {actions}
      </div>
      {progress}
      {status && (
        <p
          data-file-status
          className={`mt-1 text-xs ${v?.state === 'failed' ? 'text-error' : 'text-on-surface-variant'}`}
        >
          {status}
        </p>
      )}
      {done && (kind === null || v.tooBig) && (
        <p className="mt-1 text-xs text-on-surface-variant">
          {v.tooBig
            ? 'Stored on this device. Too large to show here: save it to view.'
            : 'Stored on this device'}
        </p>
      )}
    </div>
  )
}

export function AttachmentList({ att, canFetch }: { att: Attachment[]; canFetch: boolean }) {
  if (!att.length) return null
  return (
    <div className="flex flex-col gap-1">
      {att.map(a => (
        <Tile key={a.h} att={a} canFetch={canFetch} />
      ))}
    </div>
  )
}

function PendingChip({ room, p }: { room: string; p: PendingFile }) {
  const ready = p.hashed !== null && p.preview !== null
  const thumb = useThumb(p.preview?.thumb)
  const mask = useMask()
  return (
    <div
      data-pending-file
      className="relative flex h-24 w-40 shrink-0 flex-col justify-between rounded-xl border border-dashed border-tertiary/60 bg-surface-container p-2"
    >
      <button
        title="Remove file"
        aria-label="Remove file"
        onClick={() => p2pFiles.remove(room, p.id)}
        className="absolute -top-2 -right-2 rounded-full bg-error-container p-1 text-on-error-container shadow-elevation-1"
      >
        <X size={12} />
      </button>
      <div className="flex items-center justify-between gap-1">
        {thumb ? (
          <img src={thumb} alt="" aria-hidden className="h-10 w-14 rounded object-cover" />
        ) : (
          <FileText size={20} className="text-tertiary" />
        )}
        <button
          title={p.spoiler ? 'Unmark spoiler' : 'Mark as spoiler'}
          aria-label={p.spoiler ? 'Unmark spoiler' : 'Mark as spoiler'}
          onClick={() => p2pFiles.toggleSpoiler(room, p.id)}
          className={`rounded-full p-1 ${
            p.spoiler
              ? 'bg-primary-container text-on-primary-container'
              : 'text-on-surface-variant hover:bg-surface-container-high'
          }`}
        >
          {p.spoiler ? <EyeOff size={14} /> : <Eye size={14} />}
        </button>
      </div>
      <span className="truncate text-xs">
        {p.spoiler ? 'Spoiler · ' : ''}
        {mask(downloadName(p.file.name))}
      </span>
      <span
        className={`flex items-center gap-1 text-[11px] tabular-nums ${p.error ? 'text-error' : 'text-on-surface-variant'}`}
      >
        {p.error ? (
          p.error
        ) : ready ? (
          fmtSize(p.file.size)
        ) : (
          <>
            <Loader2 size={10} className="motion-safe:animate-spin" />
            Preparing {Math.floor(p.progress * 100)}%
          </>
        )}
      </span>
    </div>
  )
}

export function PendingFiles({ room }: { room: string }) {
  const list = useP2p(s => s.attaching[room])
  if (!list?.length) return null
  return (
    <div className="mb-2 flex gap-3 overflow-x-auto px-1 pt-2 pb-1" aria-label="Files to send">
      {list.map(p => (
        <PendingChip key={p.id} room={room} p={p} />
      ))}
      <span
        title="Sent peer-to-peer: stored on your devices and shared with the people in this conversation"
        className="flex shrink-0 items-center gap-1 self-end rounded bg-tertiary-container px-1.5 py-0.5 text-[11px] font-medium text-on-tertiary-container"
      >
        <Waypoints size={10} />
        P2P
      </span>
    </div>
  )
}
