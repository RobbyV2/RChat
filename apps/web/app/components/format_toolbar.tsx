'use client'

import { IconButton } from './controls'
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import {
  Bold,
  Code,
  EyeOff,
  Italic,
  Link,
  Strikethrough,
  TextQuote,
  type LucideIcon,
} from 'lucide-react'
import { applyFormat, FORMATS, formatKey, keysLabel, type Format } from '../lib/format'
import { time } from '../lib/platform/time'
import { Surface } from './layout'
import { notAName } from '../lib/names'

const ICONS: Record<Format, LucideIcon> = {
  bold: Bold,
  italic: Italic,
  strike: Strikethrough,
  code: Code,
  spoiler: EyeOff,
  quote: TextQuote,
  link: Link,
}

// Formatting for a message textarea (composer, edit box, P2P composer): a toolbar while text is
// selected and the format keys. Spread `onKeyDown` first in the textarea's key handler.
export function useFormatting({
  inputRef,
  getText,
  setText,
}: {
  inputRef: RefObject<HTMLTextAreaElement | null>
  getText: () => string
  setText: (text: string) => void
}) {
  const [selected, setSelected] = useState(false)
  // A format is being applied: the new text collapses the selection until it is restored.
  const applying = useRef(false)

  useEffect(() => {
    const check = () => {
      const el = inputRef.current
      if (applying.current) return
      setSelected(
        el !== null && document.activeElement === el && el.selectionStart !== el.selectionEnd
      )
    }
    document.addEventListener('selectionchange', check)
    return () => document.removeEventListener('selectionchange', check)
  }, [inputRef])

  // Text set from code (sending clears the box) moves the caret without a selectionchange.
  useLayoutEffect(() => {
    const el = inputRef.current
    if (applying.current) return
    if (selected && (el === null || el.selectionStart === el.selectionEnd)) setSelected(false)
  })

  const apply = (format: Format) => {
    const el = inputRef.current
    if (!el) return
    const out = applyFormat(getText(), el.selectionStart, el.selectionEnd, format)
    applying.current = true
    setText(out.text)
    time().frame(() => {
      applying.current = false
      const now = inputRef.current
      if (!now) return setSelected(false)
      now.focus({ preventScroll: true })
      now.setSelectionRange(out.start, out.end)
      setSelected(out.start !== out.end)
    })
  }

  // Handles a format key; `true` when it did.
  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return false
    const format = formatKey(e)
    if (!format) return false
    e.preventDefault()
    apply(format)
    return true
  }

  return { selected, apply, onKeyDown }
}

export function FormatToolbar({
  open,
  onFormat,
  below = false,
}: {
  open: boolean
  onFormat: (format: Format) => void
  below?: boolean
}) {
  if (!open) return null
  return (
    <Surface
      role="toolbar"
      aria-label="Formatting"
      data-format-toolbar
      pad="2xs"
      gap="3xs"
      row
      tone="highest"
      radius="lg"
      elevation={2}
      place={
        below
          ? 'absolute left-2 z-float top-full translate-y-1'
          : 'absolute left-2 z-float bottom-full -translate-y-1'
      }
    >
      {FORMATS.map(({ format, label, keys }) => {
        const Icon = ICONS[format]
        return (
          <IconButton
            key={format}
            icon={Icon}
            label={notAName(label)}
            tooltip={notAName(keys ? `${label} (${keysLabel(keys)})` : label)}
            shape="square"
            data-format={format}
            onMouseDown={e => e.preventDefault()}
            onClick={() => onFormat(format)}
          />
        )
      })}
    </Surface>
  )
}
