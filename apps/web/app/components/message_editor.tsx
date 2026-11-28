'use client'
import { Button, LinkButton } from './controls'
import { altError } from '../lib/alt_text'
import { AltField } from './alt_text'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Pencil } from 'lucide-react'
import { charCount, counterFrom } from '../lib/rules'
import { sendKey } from '../lib/keys'
import type { ToolbarAction } from './message_toolbar'
import { useMedia } from './context_menu'
import { useTextAssist } from './text_assist'
import { FormatToolbar, useFormatting } from './format_toolbar'
import { fullTimeOf } from '../lib/timestamps'
import { Row, Stack, Surface } from './layout'
import type { EditBinding } from '../lib/place/row_acts'
import { unnamed } from '../lib/names'

export const editAction = (onClick: () => void): ToolbarAction => ({
  key: 'edit',
  label: unnamed('Edit'),
  icon: Pencil,
  onClick,
})

export function EditedMark({ at }: { at: number }) {
  const when = fullTimeOf(at)
  return (
    <span
      data-edited
      title={when}
      aria-label={`Edited ${when}`}
      className="cursor-default align-baseline text-2xs text-on-surface-variant select-none"
    >
      (edited)
    </span>
  )
}

const POPUP_ROOM = 340

export function MessageEditor({ binding }: { binding: EditBinding }) {
  const { max, text, listKey, alt } = binding
  const focusAsk = binding.focus
  const setEditText = binding.setText
  const saveEdit = binding.save
  const cancelEdit = binding.cancel
  const fine = useMedia('(pointer: fine)')
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const [below, setBelow] = useState(false)
  useLayoutEffect(() => {
    const el = inputRef.current
    const scroller = el?.closest('.overflow-y-auto')
    if (!el || !scroller) return
    const room = el.getBoundingClientRect().top - scroller.getBoundingClientRect().top
    setBelow(room < POPUP_ROOM)
  }, [text])
  const assist = useTextAssist({
    listKey,
    text,
    getText: binding.getText,
    setText: setEditText,
    inputRef,
    paused: false,
    maxHeight: 320,
    below,
  })
  const { trackCaret } = assist
  const formatting = useFormatting({
    inputRef,
    getText: binding.getText,
    setText: setEditText,
  })

  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.focus({ preventScroll: true })
    const end = el.value.length
    el.setSelectionRange(end, end)
    el.scrollTop = el.scrollHeight
    el.scrollIntoView({ block: 'nearest' })
    trackCaret(el)
  }, [focusAsk])

  const count = charCount(text)
  const tooLong = count > max
  const blocked = tooLong || (alt !== undefined && altError(alt.text) !== null)
  const save = () => saveEdit(fine)
  const cancel = () => cancelEdit(fine)

  return (
    <div
      data-editor
      className="msg-part"
      onContextMenu={e => e.stopPropagation()}
      onTouchStart={e => e.stopPropagation()}
    >
      <Stack gap="xs">
        <Surface
          pad="md"
          inset="bar"
          gap="sm"
          row
          tone="high"
          radius="lg"
          align="end"
          place="relative"
        >
          {assist.popups}
          <FormatToolbar open={formatting.selected} onFormat={formatting.apply} below={below} />
          <textarea
            ref={inputRef}
            rows={1}
            aria-label="Edit message"
            {...assist.textarea}
            onKeyDown={e => {
              if (assist.popupKey(e)) return
              if (formatting.onKeyDown(e)) return
              if (e.key === 'Escape' && !e.nativeEvent.isComposing) {
                e.preventDefault()
                cancel()
                return
              }
              if (sendKey(e)) {
                e.preventDefault()
                save()
              }
            }}
            className="max-h-80 min-w-0 flex-1 resize-none bg-transparent text-base leading-relaxed outline-none md:text-sm"
          />
          {count > counterFrom(max) && (
            <span
              title={`Messages can be up to ${max} characters`}
              className={`shrink-0 self-center text-xs tabular-nums ${tooLong ? 'font-medium text-error' : 'text-on-surface-variant'}`}
            >
              {max - count}
            </span>
          )}
        </Surface>
        {alt && (
          <div data-alt-field className="w-full max-w-md">
            <AltField value={alt.text} onChange={alt.set} />
          </div>
        )}
        <div className="text-xs text-on-surface-variant pointer-coarse:hidden">
          escape to <LinkButton onClick={cancel}>cancel</LinkButton> • enter to{' '}
          <LinkButton onClick={save} disabled={blocked}>
            save
          </LinkButton>
        </div>
        <Row gap="sm" justify="end" place="pointer-fine:hidden">
          <Button size="md" onClick={cancel}>
            Cancel
          </Button>
          <Button variant="filled" size="md" onClick={save} disabled={blocked}>
            Save
          </Button>
        </Row>
      </Stack>
    </div>
  )
}
