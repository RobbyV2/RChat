'use client'

import { composerTextLook } from '../lib/controls'
import {
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type ReactNode,
  type Ref,
  type RefObject,
} from 'react'
import { Smile } from 'lucide-react'
import { spliceText } from '../lib/autocomplete'
import { background } from '../lib/api_errors'
import { loadEmojiData } from '../lib/emoji'
import { composing, sendKey } from '../lib/keys'
import type { ComposerDraft } from '../lib/scheduled'
import type { Compose } from '../lib/place/composer'
import { useLive } from '../lib/place/react'
import { charCount, counterFrom } from '../lib/rules'
import { clock } from '../lib/slowmode'
import { useMedia } from './context_menu'
import { IconButton } from './controls'
import { SendButton, useSendLater } from './scheduled'
import { EmojiPicker, SHEET_QUERY } from './emoji_picker'
import { FormatToolbar, useFormatting } from './format_toolbar'
import { useTextAssist } from './text_assist'
import { Surface } from './layout'
import { ComposerEmbeds, EmbedButton } from './embed_builder'
import { EmbedsPreview } from './markdown_message'
import { EMBEDS_MAX } from '../lib/rich_embeds'
import { embedAsks } from '../lib/place/embed_ask'
import { time } from '../lib/platform/time'
import { type Label } from '../lib/names'

// Whether `text` can be sent as far as its size goes.
export const fits = (compose: Compose, text: string, max: number) =>
  charCount(text) <= max && !compose.oversize(text)

// The field a message is written in, whichever place it goes to: the text with its completions
// and formatting, the emoji picker, the character counter and the send button. What is sent, and
// what else can be added to it (`tools`), is the caller's.
// Gives `field` the focus each time its list's composer is asked to take it (a reply started, an
// edit left).
export function useFocusAsks(compose: Compose, field: RefObject<HTMLTextAreaElement | null>) {
  const { focus } = useLive(compose.state)
  const seen = useRef(focus)
  useEffect(() => {
    if (focus === seen.current) return
    seen.current = focus
    if (focus > 0) field.current?.focus()
  }, [focus, field])
}

export function ComposerField({
  compose,
  listKey,
  placeholder,
  slowLeft,
  blocked = false,
  bar,
  tools,
  inputRef: givenRef,
  inputProps,
  later,
  onSend,
  onPaste,
  embedsAsked = false,
}: {
  compose: Compose
  // The list whose people and messages the completions draw on.
  listKey: string | null
  placeholder: Label
  // Seconds until slow mode lets the next message through.
  slowLeft: number
  // Sending is held back for a reason the caller shows.
  blocked?: boolean
  // What sits on top of the field (the reply or forward being written).
  bar: ReactNode
  tools?: ReactNode
  inputRef?: Ref<HTMLTextAreaElement>
  inputProps?: Record<`data-${string}`, string>
  // The draft as Send later reads it when one of its rows runs.
  later: () => ComposerDraft | null
  onSend: () => void
  // Takes what was pasted; true when it took files and the text paste should not happen.
  onPaste?: (e: ClipboardEvent<HTMLTextAreaElement>) => boolean
  // Opens the embed builder when the palette asks for one (the main list's field).
  embedsAsked?: boolean
}) {
  const { key, text, max, replying } = useLive(compose.state)
  const cards = useLive(compose.embeds)
  const [builder, setBuilder] = useState<number | 'new' | null>(null)
  const asked = useLive(embedAsks)
  const seenAsk = useRef(asked)
  useEffect(() => {
    if (asked === seenAsk.current) return
    seenAsk.current = asked
    if (embedsAsked && cards.can && cards.held.length < EMBEDS_MAX) setBuilder('new')
  }, [asked, embedsAsked, cards])
  const sheet = useMedia(SHEET_QUERY)
  const [focused, setFocused] = useState(false)
  const [pickerFor, setPickerFor] = useState<string | null>(null)
  const ownRef = useRef<HTMLTextAreaElement>(null)
  const emojiRef = useRef<HTMLButtonElement>(null)
  const sel = useRef({ start: 0, end: 0 })
  const sendLater = useSendLater(later)
  const pickerOpen = pickerFor !== null && pickerFor === key
  const setInput = (el: HTMLTextAreaElement | null) => {
    ownRef.current = el
    if (typeof givenRef === 'function') givenRef(el)
    else if (givenRef) givenRef.current = el
  }

  useFocusAsks(compose, ownRef)
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
    time().frame(() => {
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
      {cards.can && (
        <ComposerEmbeds
          list={cards.held}
          onChange={compose.setEmbeds}
          builder={builder}
          setBuilder={setBuilder}
          preview={list => <EmbedsPreview embeds={list} />}
        />
      )}
      <Surface
        pad="md"
        inset="bar"
        gap="sm"
        row
        tone="high"
        radius="none"
        align="end"
        look={`${bar ? 'rounded-b-3xl' : 'rounded-3xl'}`}
        place="relative"
      >
        {assist.popups}
        <FormatToolbar open={formatting.selected} onFormat={formatting.apply} />
        {tools}
        <textarea
          ref={setInput}
          rows={1}
          {...inputProps}
          {...assist.textarea}
          onFocus={() => {
            setFocused(true)
            sendLater.focused()
          }}
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
            if (sendLater.key(e)) return
            if (sendKey(e)) {
              e.preventDefault()
              onSend()
            }
          }}
          onPaste={e => {
            if (onPaste?.(e)) e.preventDefault()
          }}
          placeholder={placeholder}
          className={composerTextLook}
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
        {cards.can && (
          <EmbedButton
            disabled={cards.held.length >= EMBEDS_MAX}
            onClick={() => setBuilder('new')}
          />
        )}
        <IconButton
          ref={emojiRef}
          icon={Smile}
          label="Emoji"
          tight
          aria-haspopup="dialog"
          aria-expanded={pickerOpen}
          onPointerEnter={() => void loadEmojiData().catch(background('loading emoji failed'))}
          onClick={openPicker}
        />
        <SendButton
          buttonRef={sendLater.button}
          title={
            tooLong
              ? 'Message is too long'
              : slowLeft > 0
                ? `Slow mode: ${clock(slowLeft)}`
                : 'Send'
          }
          disabled={tooLong || slowLeft > 0 || blocked}
          onSend={onSend}
          draft={sendLater.draft}
        />
      </Surface>
    </>
  )
}
