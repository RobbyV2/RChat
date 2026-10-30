'use client'

import { useEffect, useState, type RefObject } from 'react'
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

  useEffect(() => {
    const check = () => {
      const el = inputRef.current
      setSelected(
        el !== null && document.activeElement === el && el.selectionStart !== el.selectionEnd
      )
    }
    document.addEventListener('selectionchange', check)
    return () => document.removeEventListener('selectionchange', check)
  }, [inputRef])

  const apply = (format: Format) => {
    const el = inputRef.current
    if (!el) return
    const out = applyFormat(getText(), el.selectionStart, el.selectionEnd, format)
    setText(out.text)
    requestAnimationFrame(() => {
      const now = inputRef.current
      if (!now) return
      now.focus({ preventScroll: true })
      now.setSelectionRange(out.start, out.end)
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
    <div
      role="toolbar"
      aria-label="Formatting"
      data-format-toolbar
      className={`absolute left-2 z-20 flex items-center gap-0.5 rounded-xl bg-surface-container-highest p-1 shadow-elevation-2 ${
        below ? 'top-full mt-1' : 'bottom-full mb-1'
      }`}
    >
      {FORMATS.map(({ format, label, keys }) => {
        const Icon = ICONS[format]
        return (
          <button
            key={format}
            type="button"
            title={keys ? `${label} (${keysLabel(keys)})` : label}
            aria-label={label}
            data-format={format}
            onMouseDown={e => e.preventDefault()}
            onClick={() => onFormat(format)}
            className="rounded-lg p-2 text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface md:p-1.5"
          >
            <Icon size={16} />
          </button>
        )
      })}
    </div>
  )
}
