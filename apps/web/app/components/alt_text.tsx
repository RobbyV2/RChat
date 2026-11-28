'use client'

import { IconButton } from './controls'
import { useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { charCount } from '../lib/rules'
import { ALT_MAX, altAnnouncement, altError, cleanAlt } from '../lib/alt_text'
import { Masked, smallFieldCls } from './ui'
import { Stack, Surface, Inset } from './layout'

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
      <Inset
        type="button"
        title="Image description"
        aria-label="ALT, image description"
        aria-expanded={open}
        onClick={e => {
          e.preventDefault()
          e.stopPropagation()
          setOpen(o => !o)
        }}
        as="button"
        pad="xs"
        inset="chip"
        look="rounded bg-scrim/80 text-3xs font-bold tracking-wider text-white uppercase hover:bg-scrim"
        place="absolute right-2 bottom-2"
      >
        Alt
      </Inset>
      {open && (
        <Surface
          role="note"
          data-alt-text
          data-popover
          as="span"
          pad="md"
          tone="highest"
          radius="lg"
          elevation={2}
          text="xs"
          look="max-h-60 w-max max-w-float min-w-40 break-words whitespace-pre-line"
          place={
            up
              ? 'absolute z-float right-2 bottom-9 overflow-y-auto'
              : 'absolute z-float top-full left-0 translate-y-1 overflow-y-auto'
          }
        >
          <Masked text={alt} own={own} />
          <IconButton
            icon={X}
            label="Close"
            size="xs"
            type="button"
            onClick={e => {
              e.preventDefault()
              e.stopPropagation()
              setOpen(false)
            }}
            place="absolute top-1.5 right-1.5"
          />
        </Surface>
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
        className={`${smallFieldCls} min-w-0`}
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
