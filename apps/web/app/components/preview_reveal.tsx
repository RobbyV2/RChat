'use client'

import { useAccount } from '../lib/client/react'
import { useEffect, useId, useRef, useState, type HTMLAttributes, type ReactNode } from 'react'
import type { ViewingTarget } from '../lib/viewing'
import { Masked } from './ui'
import { Inset } from './layout'
import { Hotspot, LinkButton } from './controls'

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
      <Hotspot tabIndex={tabIndex} labelledBy={label} tooltip={title} />
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
    <LinkButton
      data-reply-spoiler
      title={label}
      onClick={e => {
        e.preventDefault()
        e.stopPropagation()
        focus.current = e.currentTarget === document.activeElement
        setOpen(true)
      }}
      tone="inherit"
      label={label}
    >
      <Inset
        as="span"
        pad="xs"
        inset="sides"
        look="rounded bg-spoiler text-xs font-medium text-white"
      >
        Spoiler
      </Inset>
    </LinkButton>
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
  const { requestViewing } = useAccount().viewing
  return (
    <LinkButton
      onClick={e => {
        e.stopPropagation()
        void requestViewing(target)
      }}
      place="shrink-0"
      underlined
    >
      <span className="text-sm whitespace-nowrap">Reveal preview</span>
    </LinkButton>
  )
}
