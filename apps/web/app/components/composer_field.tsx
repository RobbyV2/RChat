'use client'

import { useEffect, useRef, useState, type ClipboardEvent, type ReactNode, type Ref } from 'react'
import { SendHorizontal, Smile } from 'lucide-react'
import { spliceText } from '../lib/autocomplete'
import { loadEmojiData } from '../lib/emoji'
import { composing, sendKey } from '../lib/keys'
import type { Compose } from '../lib/place/composer'
import { useLive } from '../lib/place/react'
import { charCount, counterFrom } from '../lib/rules'
import { clock } from '../lib/slowmode'
import { useMedia } from './context_menu'
import { IconButton } from './controls'
import { EmojiPicker, SHEET_QUERY } from './emoji_picker'
import { FormatToolbar, useFormatting } from './format_toolbar'
import { useTextAssist } from './text_assist'

// Whether `text` can be sent as far as its size goes.
export const fits = (compose: Compose, text: string, max: number) =>
  charCount(text) <= max && !compose.oversize(text)

// The field a message is written in, whichever place it goes to: the text with its completions
// and formatting, the emoji picker, the character counter and the send button. What is sent, and
// what else can be added to it (`tools`), is the caller's.
export function ComposerField({
  compose,
  listKey,
  placeholder,
  slowLeft,
  blocked = false,
  mayEditLast = true,
  bar,
  tools,
  inputRef: givenRef,
  inputProps,
  onSend,
  onPaste,
}: {
  compose: Compose
  // The list whose people and messages the completions draw on.
  listKey: string | null
  placeholder: string
  // Seconds until slow mode lets the next message through.
  slowLeft: number
  // Sending is held back for a reason the caller shows.
  blocked?: boolean
  mayEditLast?: boolean
  // What sits on top of the field (the reply or forward being written).
  bar: ReactNode
  tools?: ReactNode
  inputRef?: Ref<HTMLTextAreaElement>
  inputProps?: Record<`data-${string}`, string>
  onSend: () => void
  // Takes what was pasted; true when it took files and the text paste should not happen.
  onPaste?: (e: ClipboardEvent<HTMLTextAreaElement>) => boolean
}) {
  const { key, text, max, replying } = useLive(compose.state)
  const sheet = useMedia(SHEET_QUERY)
  const [focused, setFocused] = useState(false)
  const [pickerFor, setPickerFor] = useState<string | null>(null)
  const ownRef = useRef<HTMLTextAreaElement>(null)
  const emojiRef = useRef<HTMLButtonElement>(null)
  const sel = useRef({ start: 0, end: 0 })
  const pickerOpen = pickerFor !== null && pickerFor === key
  const setInput = (el: HTMLTextAreaElement | null) => {
    ownRef.current = el
    if (typeof givenRef === 'function') givenRef(el)
    else if (givenRef) givenRef.current = el
  }

  const typingNow = focused && text.trim() !== ''
  useEffect(() => {
    if (key !== null) compose.typing(key, typingNow)
  }, [compose, key, typingNow, text])
  useEffect(() => {
    if (key === null) return
    return () => compose.typing(key, false)
  }, [compose, key])

  const assist = useTextAssist({
    listKey,
    text,
    getText: compose.getText,
    setText: compose.setText,
    inputRef: ownRef,
    paused: pickerOpen,
    maxHeight: 160,
  })
  const { trackCaret } = assist
  const formatting = useFormatting({
    inputRef: ownRef,
    getText: compose.getText,
    setText: compose.setText,
  })

  const openPicker = () => {
    const el = ownRef.current
    if (el) sel.current = { start: el.selectionStart, end: el.selectionEnd }
    setPickerFor(pickerOpen ? null : key)
  }
  const insertEmoji = (picked: string) => {
    const cur = compose.getText()
    const start = Math.min(sel.current.start, cur.length)
    const end = Math.min(Math.max(sel.current.end, start), cur.length)
    const at = start + picked.length
    sel.current = { start: at, end: at }
    compose.setText(spliceText(cur, start, end, picked))
  }
  const closePicker = () => {
    setPickerFor(null)
    if (sheet) return
    requestAnimationFrame(() => {
      const el = ownRef.current
      const active = document.activeElement
      if (!el || (active && active !== document.body)) return
      el.focus({ preventScroll: true })
      el.setSelectionRange(sel.current.start, sel.current.end)
      trackCaret(el)
    })
  }

  const count = charCount(text)
  const tooLong = !fits(compose, text, max)
  const limit = `Messages can be up to ${max} characters`
  return (
    <>
      {pickerOpen && (
        <EmojiPicker anchor={emojiRef.current} onPick={insertEmoji} onClose={closePicker} />
      )}
      {bar}
      <div
        className={`relative flex items-end gap-2 bg-surface-container-high px-3 py-2 ${bar ? 'rounded-b-3xl' : 'rounded-3xl'}`}
      >
        {assist.popups}
        <FormatToolbar open={formatting.selected} onFormat={formatting.apply} />
        {tools}
        <textarea
          ref={setInput}
          rows={1}
          {...inputProps}
          {...assist.textarea}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            assist.textarea.onBlur()
            setFocused(false)
          }}
          onKeyDown={e => {
            if (assist.popupKey(e)) return
            if (formatting.onKeyDown(e)) return
            if (
              e.key === 'ArrowUp' &&
              !text &&
              !e.shiftKey &&
              !e.altKey &&
              !e.metaKey &&
              !e.ctrlKey &&
              !composing(e) &&
              mayEditLast &&
              compose.editLast()
            ) {
              e.preventDefault()
              return
            }
            if (e.key === 'Escape' && !e.nativeEvent.isComposing && replying) {
              e.preventDefault()
              compose.cancelReply()
              return
            }
            if (sendKey(e)) {
              e.preventDefault()
              onSend()
            }
          }}
          onPaste={e => {
            if (onPaste?.(e)) e.preventDefault()
          }}
          placeholder={placeholder}
          className="max-h-40 min-w-0 flex-1 resize-none bg-transparent py-1.5 text-base outline-none placeholder:whitespace-nowrap placeholder:text-on-surface-variant md:text-sm"
        />
        {(count > counterFrom(max) || tooLong) && (
          <span
            data-too-long={tooLong ? '' : undefined}
            title={
              count > max || !tooLong
                ? limit
                : 'This message takes too much space. Use fewer special characters.'
            }
            className={`shrink-0 self-center text-xs tabular-nums ${tooLong ? 'font-medium text-error' : 'text-on-surface-variant'}`}
          >
            {count > max || !tooLong ? max - count : 'Too long'}
          </span>
        )}
        <IconButton
          ref={emojiRef}
          icon={Smile}
          label="Emoji"
          place="pointer-coarse:-mx-1.5"
          aria-haspopup="dialog"
          aria-expanded={pickerOpen}
          onPointerEnter={() => void loadEmojiData().catch(() => {})}
          onClick={openPicker}
        />
        <IconButton
          icon={SendHorizontal}
          label="Send"
          place="pointer-coarse:-mx-1.5"
          tooltip={
            tooLong
              ? 'Message is too long'
              : slowLeft > 0
                ? `Slow mode: ${clock(slowLeft)}`
                : 'Send'
          }
          tone="filled"
          onClick={onSend}
          disabled={tooLong || slowLeft > 0 || blocked}
        />
      </div>
    </>
  )
}
