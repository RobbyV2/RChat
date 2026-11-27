'use client'
import { useRef, useState, type Ref } from 'react'
import { errorText } from '../lib/store'
import { Button, LinkButton } from './controls'

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
    <form
      className="min-w-0 shrink-0 space-y-1 p-2"
      onSubmit={e => {
        e.preventDefault()
        void submit()
      }}
    >
      {reply && (
        <div className="flex items-center justify-between gap-2 text-xs">
          <span className="truncate">
            Reply to <span className="streamer">{reply}</span>
          </span>
          <LinkButton onClick={cancelReply}>Cancel reply</LinkButton>
        </div>
      )}
      <div className="flex items-end gap-2">
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
          className="min-w-0 flex-1 resize-none rounded-xl bg-surface-container-high px-3 py-2 text-on-surface"
        />
        <Button type="submit" variant="filled" size="md" disabled={busy || !text.trim()}>
          Send
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-sm text-error">
          {error}
        </p>
      )}
    </form>
  )
}
