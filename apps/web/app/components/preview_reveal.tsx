'use client'

import { useEffect, useId, useRef, useState, type HTMLAttributes, type ReactNode } from 'react'
import { requestViewing, type ViewingTarget } from '../lib/viewing'
import { Masked } from './ui'

// The row opens its destination. Buttons in its preview have their own focus and click targets.
export function PreviewRow({
  children,
  className = '',
  contentClassName = '',
  onOpen,
  title,
  tabIndex,
  ...props
}: HTMLAttributes<HTMLDivElement> & { onOpen: () => void; contentClassName?: string }) {
  const label = useId()
  return (
    <div
      {...props}
      className={'relative cursor-pointer ' + className}
      onClick={e => {
        e.stopPropagation()
        if (!e.defaultPrevented) onOpen()
      }}
    >
      <button
        type="button"
        title={title}
        tabIndex={tabIndex}
        aria-labelledby={label}
        className="absolute inset-0 cursor-pointer rounded-[inherit] focus-visible:outline-2 focus-visible:outline-primary"
      />
      <div
        id={label}
        className={'preview-row-content relative pointer-events-none ' + contentClassName}
      >
        {children}
      </div>
    </div>
  )
}

export function PreviewSpoiler({
  children,
  file = false,
}: {
  children: ReactNode
  file?: boolean
}) {
  const [open, setOpen] = useState(false)
  const focus = useRef(false)
  const shown = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (open && focus.current) shown.current?.focus({ preventScroll: true })
  }, [open])
  if (open)
    return (
      <span ref={shown} tabIndex={-1}>
        {children}
      </span>
    )
  const label = file ? 'Reveal spoiler attachment' : 'Reveal spoiler'
  return (
    <button
      type="button"
      data-reply-spoiler
      aria-label={label}
      title={label}
      onClick={e => {
        e.preventDefault()
        e.stopPropagation()
        focus.current = e.currentTarget === document.activeElement
        setOpen(true)
      }}
      className="inline-flex cursor-pointer items-center rounded bg-spoiler px-1.5 align-baseline text-xs font-medium text-white hover:underline focus-visible:outline-2 focus-visible:outline-primary"
    >
      Spoiler
    </button>
  )
}

export function PreviewFilename({
  name,
  spoiler,
  own = false,
}: {
  name: string
  spoiler?: boolean
  own?: boolean
}) {
  const filename = <Masked text={name} file own={own} />
  return spoiler ? (
    <PreviewSpoiler key={name} file>
      {filename}
    </PreviewSpoiler>
  ) : (
    filename
  )
}

export function RevealChannelPreview({ target }: { target: ViewingTarget }) {
  return (
    <button
      type="button"
      className="min-h-8 shrink-0 cursor-pointer rounded-sm px-1 text-sm whitespace-nowrap text-primary underline focus-visible:outline-2 focus-visible:outline-primary"
      onClick={e => {
        e.stopPropagation()
        void requestViewing(target)
      }}
    >
      Reveal preview
    </button>
  )
}
