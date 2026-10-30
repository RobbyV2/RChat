'use client'

import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Hash, Volume2 } from 'lucide-react'
import { useStore } from '../lib/store'
import { charCount } from '../lib/rules'
import {
  TOPIC_MAX,
  cleanTopic,
  topicAnnouncement,
  topicError,
  topicLine,
  topicParts,
} from '../lib/topic'
import type { Channel } from '../lib/types'
import { useMedia } from './context_menu'
import { SHEET_QUERY } from './emoji_picker'
import { MessageLink } from './markdown_message'
import { CloseButton, fieldCls, FieldError, filledBtn, Masked, SheetGrip, textBtn } from './ui'

const topicFieldCls = fieldCls.replace(' border-outline', '').replace(' focus:border-primary', '')

export function TopicText({ topic }: { topic: string }) {
  return (
    <p className="text-sm break-words whitespace-pre-wrap text-on-surface">
      {topicParts(topic).map((part, i) =>
        part.href === undefined ? (
          <span key={i}>
            <Masked text={part.text} />
          </span>
        ) : (
          <MessageLink key={i} href={part.href}>
            <Masked text={part.text} />
          </MessageLink>
        )
      )}
    </p>
  )
}

// The channel topic as one line (header) or two lines (voice view); a click shows all of it.
export function ChannelTopic({
  channel,
  variant = 'header',
}: {
  channel: Channel
  variant?: 'header' | 'voice'
}) {
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const topic = channel.topic ?? ''
  const line = topicLine(topic)
  if (!line) return null
  return (
    <>
      <button
        ref={trigger}
        type="button"
        data-topic
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className={`min-w-0 rounded-md text-left text-on-surface-variant outline-offset-2 hover:text-on-surface focus-visible:outline-2 focus-visible:outline-primary ${
          variant === 'header'
            ? 'w-full truncate text-xs md:w-auto md:max-w-full md:text-sm'
            : 'line-clamp-2 text-sm'
        }`}
      >
        <Masked text={line} />
      </button>
      {open && (
        <TopicWindow
          channel={channel}
          topic={topic}
          anchor={trigger}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  )
}

function TopicWindow({
  channel,
  topic,
  anchor,
  onClose,
}: {
  channel: Channel
  topic: string
  anchor: React.RefObject<HTMLButtonElement | null>
  onClose: () => void
}) {
  const sheet = useMedia(SHEET_QUERY)
  const rootRef = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const [at, setAt] = useState<{ top: number; left: number } | null>(null)
  const closeRef = useRef(onClose)
  useEffect(() => {
    closeRef.current = onClose
  })

  useLayoutEffect(() => {
    if (sheet) return
    const place = () => {
      const rect = anchor.current?.getBoundingClientRect()
      if (!rect) return
      const width = Math.min(448, window.innerWidth - 16)
      setAt({
        top: rect.bottom + 8,
        left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
      })
    }
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [sheet, anchor])

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
      if (rootRef.current?.contains(t) || anchor.current?.contains(t)) return
      if (t.closest('[aria-modal="true"]') && !rootRef.current?.contains(t)) return
      closeRef.current()
    }
    window.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onDown, true)
    return () => {
      window.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onDown, true)
    }
  }, [anchor])

  useEffect(() => {
    const id = channel.id
    const unsub = useStore.subscribe(s => {
      if (s.view?.kind !== 'channel' || s.view.channelId !== id) closeRef.current()
    })
    return unsub
  }, [channel.id])

  const Icon = channel.kind === 'voice' ? Volume2 : Hash
  const body = (
    <>
      <div className="flex shrink-0 items-center gap-2 px-4 pb-2">
        <Icon size={18} className="shrink-0 text-on-surface-variant" />
        <h2 id={titleId} className="min-w-0 flex-1 truncate text-base font-medium text-on-surface">
          <Masked text={channel.name} />
        </h2>
        {!sheet && <CloseButton onClick={onClose} />}
      </div>
      <div
        onClickCapture={e => {
          if (e.target instanceof Element && e.target.closest('a')) onClose()
        }}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain border-t border-outline-variant px-4 pt-3 pb-3"
      >
        <TopicText topic={topic} />
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
          className="flex max-h-[70%] animate-sheet-up flex-col overflow-hidden rounded-t-3xl bg-surface-container-high px-safe pt-3 pb-[max(0.5rem,env(safe-area-inset-bottom))] shadow-elevation-3"
        >
          <SheetGrip />
          {body}
        </div>
      </div>,
      document.body
    )

  return createPortal(
    <div
      ref={rootRef}
      role="dialog"
      aria-labelledby={titleId}
      data-popover
      style={at ? { top: at.top, left: at.left } : { visibility: 'hidden' }}
      className="fixed z-30 flex max-h-[min(28rem,calc(100dvh-6rem))] w-[28rem] max-w-[calc(100vw-1rem)] flex-col overflow-hidden rounded-2xl bg-surface-container-high pt-3 shadow-elevation-3"
    >
      {body}
    </div>,
    document.body
  )
}

export function TopicEditor({
  server,
  channel,
  refresh,
}: {
  server: string
  channel: Channel
  refresh?: () => void
}) {
  const saved = channel.topic ?? ''
  const setChannelTopic = useStore(s => s.setChannelTopic)
  const [text, setText] = useState(saved)
  const [seen, setSeen] = useState(saved)
  if (seen !== saved) {
    setSeen(saved)
    if (text === seen) setText(saved)
  }
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  const [busy, setBusy] = useState(false)
  const id = useId()

  const count = charCount(cleanTopic(text))
  const over = count > TOPIC_MAX
  const changed = cleanTopic(text) !== saved

  const save = async () => {
    const invalid = topicError(text)
    if (invalid) {
      setError(invalid)
      return
    }
    setBusy(true)
    const err = await setChannelTopic(server, channel.id, text)
    setBusy(false)
    setError(err)
    if (err) return
    setDone(true)
    setText(cleanTopic(text))
    refresh?.()
  }

  return (
    <div className="flex flex-col gap-2 pt-2">
      <label htmlFor={id} className="text-xs text-on-surface-variant">
        Topic
      </label>
      <textarea
        id={id}
        rows={3}
        value={text}
        onChange={e => {
          setText(e.target.value)
          setError(null)
          setDone(false)
        }}
        placeholder="What is this channel about?"
        aria-invalid={over || error !== null}
        aria-describedby={error ? `${id}-count ${id}-error` : `${id}-count`}
        className={`${topicFieldCls} resize-y ${
          over || error !== null ? 'border-error' : 'border-outline focus:border-primary'
        }`}
      />
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <FieldError id={`${id}-error`} message={error} />
          {done && !error && <p className="pt-1.5 text-xs text-on-surface-variant">Saved</p>}
        </div>
        <span aria-live="polite" className="sr-only">
          {topicAnnouncement(count, done && !error)}
        </span>
        <span
          id={`${id}-count`}
          className={`shrink-0 pt-1.5 text-xs tabular-nums ${over ? 'text-error' : 'text-on-surface-variant'}`}
        >
          {count}/{TOPIC_MAX}
        </span>
      </div>
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={() => {
            setText(saved)
            setError(null)
            setDone(false)
          }}
          disabled={text === saved}
          className={`${textBtn} disabled:opacity-40`}
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => void save()}
          disabled={busy || over || !changed}
          className={filledBtn}
        >
          Save
        </button>
      </div>
    </div>
  )
}
