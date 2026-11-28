'use client'

import { useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { charCount } from '../lib/rules'
import { ALT_MAX, altAnnouncement, altError, cleanAlt } from '../lib/alt_text'
import { Masked } from './ui'
import { Stack } from './layout'

// The ALT pill in the bottom-right corner of an image that has a description; pressing it shows
// the description over the image, below the pill or, with `up`, above it where there is no room
// below (the image viewer).
export function AltBadge({
  alt,
  own = false,
  up = false,
}: {
  alt: string | null | undefined
  own?: boolean
  up?: boolean
}) {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (!open) return
    const away = (e: PointerEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false)
    }
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('pointerdown', away)
    window.addEventListener('keydown', key)
    return () => {
      window.removeEventListener('pointerdown', away)
      window.removeEventListener('keydown', key)
    }
  }, [open])
  if (!alt) return null
  return (
    <span ref={box} data-alt-badge className="contents">
      <button
        type="button"
        title="Image description"
        aria-label="ALT, image description"
        aria-expanded={open}
        onClick={e => {
          e.preventDefault()
          e.stopPropagation()
          setOpen(o => !o)
        }}
        className="absolute right-2 bottom-2 rounded bg-scrim/80 px-1.5 py-0.5 text-3xs font-bold tracking-wider text-white uppercase hover:bg-scrim"
      >
        Alt
      </button>
      {open && (
        <span
          role="note"
          data-alt-text
          data-popover
          className={`absolute z-20 ${up ? 'right-2 bottom-9' : 'top-full left-0 mt-1'} max-h-60 w-max max-w-[min(20rem,calc(100vw-5rem))] min-w-40 overflow-y-auto rounded-xl bg-surface-container-highest p-3 pr-8 text-xs break-words whitespace-pre-line text-on-surface shadow-elevation-2`}
        >
          <Masked text={alt} own={own} />
          <button
            type="button"
            title="Close"
            aria-label="Close"
            onClick={e => {
              e.preventDefault()
              e.stopPropagation()
              setOpen(false)
            }}
            className="absolute top-1.5 right-1.5 rounded-full p-1 text-on-surface-variant hover:bg-surface-container-high"
          >
            <X size={12} />
          </button>
        </span>
      )}
    </span>
  )
}

// "Describe this image": the description field next to an image being attached or edited.
export function AltField({
  value,
  onChange,
  compact = false,
}: {
  value: string
  onChange: (value: string) => void
  compact?: boolean
}) {
  const count = charCount(cleanAlt(value))
  const tooLong = altError(value)
  return (
    <Stack as="span" gap="3xs" place={compact ? undefined : 'w-full'}>
      <input
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder="Describe this image"
        aria-label="Describe this image"
        aria-invalid={tooLong !== null}
        className="min-w-0 rounded-lg border border-outline-variant bg-transparent px-2 py-1 text-base outline-none placeholder:text-on-surface-variant focus:border-primary md:text-xs"
      />
      {(tooLong || count > ALT_MAX - 50) && (
        <span
          role="status"
          className={`text-2xs ${tooLong ? 'text-error' : 'text-on-surface-variant'}`}
        >
          {tooLong ?? altAnnouncement(count)}
        </span>
      )}
    </Stack>
  )
}
