'use client'
import { useRef, useState, type Ref } from 'react'
import { errorText } from '../lib/store'
import { Button, LinkButton } from './controls'
import { Row, Surface } from './layout'
import { fieldCls } from './ui'

export function TextComposer({
  send,
  label = 'Message',
  inputRef,
  initialText = '',
  onTextChange,
  reply,
  cancelReply,
}: {
  send: (content: string) => Promise<void>
  label?: string
  inputRef?: Ref<HTMLTextAreaElement>
  initialText?: string
  onTextChange?: (value: string) => void
  reply?: string
  cancelReply?: () => void
}) {
  const [text, setText] = useState(initialText)
  const change = (value: string) => {
    setText(value)
    onTextChange?.(value)
  }
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const pending = useRef(false)
  const submit = async () => {
    if (pending.current || !text.trim()) return
    pending.current = true
    setBusy(true)
    setError('')
    try {
      await send(text)
      change('')
    } catch (e) {
      setError(errorText(e))
    } finally {
      pending.current = false
      setBusy(false)
    }
  }
  return (
    <Surface
      as="form"
      tone="plain"
      radius="none"
      pad="sm"
      gap="2xs"
      place="shrink-0"
      onSubmit={e => {
        e.preventDefault()
        void submit()
      }}
    >
      {reply && (
        <Row gap="sm" justify="between" text="xs">
          <span className="truncate">
            Reply to <span className="streamer">{reply}</span>
          </span>
          <LinkButton onClick={cancelReply}>Cancel reply</LinkButton>
        </Row>
      )}
      <Row gap="sm" align="end">
        <textarea
          ref={inputRef}
          aria-label={label}
          placeholder={label}
          rows={1}
          value={text}
          disabled={busy}
          onChange={e => change(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              void submit()
            }
          }}
          className={`${fieldCls} resize-none bg-surface-container-high text-on-surface`}
        />
        <Button type="submit" variant="filled" size="md" disabled={busy || !text.trim()}>
          Send
        </Button>
      </Row>
      {error && (
        <p role="alert" className="text-sm text-error">
          {error}
        </p>
      )}
    </Surface>
  )
}
