'use client'
import { Button, LinkButton } from './controls'
import { useStoreApi } from '../lib/client/react'
import { useEffect, useId, useRef, useState } from 'react'
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
import { MessageLink } from './markdown_message'
import { Anchored, CloseButton, fieldCls, FieldError, Masked, useOwnServer } from './ui'
import { Row, Surface, Stack, Inset } from './layout'

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
      <LinkButton
        ref={trigger}
        data-topic
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        tone="muted"
        place={variant === 'header' ? 'w-full md:w-fit' : undefined}
      >
        <span
          className={
            variant === 'header' ? 'min-w-0 truncate text-xs md:text-sm' : 'line-clamp-2 text-sm'
          }
        >
          <Masked text={line} />
        </span>
      </LinkButton>
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
  const store = useStoreApi()
  const ownServer = useOwnServer(useStore(s => (s.view?.kind === 'channel' ? s.view.server : null)))
  const titleId = useId()
  const closeRef = useRef(onClose)
  useEffect(() => {
    closeRef.current = onClose
  })

  useEffect(() => {
    const id = channel.id
    const unsub = store.subscribe(s => {
      if (s.view?.kind !== 'channel' || s.view.channelId !== id) closeRef.current()
    })
    return unsub
  }, [store, channel.id])

  const Icon = channel.kind === 'voice' ? Volume2 : Hash
  return (
    <Anchored anchor={{ el: anchor }} size="text" labelledBy={titleId} onClose={onClose}>
      {sheet => (
        <>
          <Inset row pad="lg" inset="bar" gap="sm" place="shrink-0">
            <Icon size={18} className="shrink-0 text-on-surface-variant" />
            <h2
              id={titleId}
              className="min-w-0 flex-1 truncate text-base font-medium text-on-surface"
            >
              <Masked text={channel.name} own={ownServer} />
            </h2>
            {!sheet && <CloseButton onClick={onClose} />}
          </Inset>
          <Surface
            tone="plain"
            radius="none"
            border="top"
            inset="bar"
            pad="lg"
            place="min-h-0 flex-1 overflow-y-auto overscroll-contain"
            onClickCapture={e => {
              if (e.target instanceof Element && e.target.closest('a')) onClose()
            }}
          >
            <TopicText topic={topic} />
          </Surface>
        </>
      )}
    </Anchored>
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
    <Stack gap="sm">
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
      <Row gap="md" align="start" justify="between">
        <div className="min-w-0">
          <FieldError id={`${id}-error`} message={error} />
          {done && !error && <p className="text-xs text-on-surface-variant">Saved</p>}
        </div>
        <span aria-live="polite" className="sr-only">
          {topicAnnouncement(count, done && !error)}
        </span>
        <span
          id={`${id}-count`}
          className={`shrink-0 text-xs tabular-nums ${over ? 'text-error' : 'text-on-surface-variant'}`}
        >
          {count}/{TOPIC_MAX}
        </span>
      </Row>
      <Row gap="sm" justify="end">
        <Button
          size="md"
          onClick={() => {
            setText(saved)
            setError(null)
            setDone(false)
          }}
          disabled={text === saved}
        >
          Cancel
        </Button>
        <Button
          variant="filled"
          size="md"
          onClick={() => void save()}
          disabled={busy || over || !changed}
        >
          Save
        </Button>
      </Row>
    </Stack>
  )
}
