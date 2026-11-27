'use client'

import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode, Ref } from 'react'
import { ChevronRight, Eye, LoaderCircle, type LucideIcon } from 'lucide-react'
import {
  BUTTON_ICON,
  ICON_SIZE,
  badgeLook,
  buttonLook,
  chipLook,
  coverLook,
  iconBoxLook,
  iconButtonLook,
  linkLook,
  pillLook,
  placed,
  rowLook,
  sectionHeadingLook,
  tabLook,
  type BadgeTone,
  type ButtonSize,
  type ButtonVariant,
  type IconButtonShape,
  type IconButtonSize,
  type IconButtonTone,
  type Place,
  type RowTone,
  type RowVariant,
} from '../lib/controls'

type NativeButton = Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'className' | 'style' | 'title' | 'aria-label' | 'aria-pressed' | 'children'
>

type Placed<S extends string> = {
  // Where the control sits in its parent: layout classes only (see `Place`).
  place?: Place<S>
}

function Busy({ busy, children }: { busy: boolean; children: ReactNode }) {
  if (!busy) return children
  return (
    <span className="grid">
      <span className="col-start-1 row-start-1 flex items-center gap-1.5 opacity-0">
        {children}
      </span>
      <span className="col-start-1 row-start-1 flex items-center justify-center">
        <LoaderCircle size={16} aria-hidden className="motion-safe:animate-spin" />
      </span>
    </span>
  )
}

// A labelled button. `busy` disables it and shows a spinner in place of its label while the
// label keeps the width. `title` is for a longer description than the label.
export function Button<const S extends string = never>({
  variant = 'text',
  size = 'sm',
  icon: Icon,
  busy = false,
  disabled,
  type = 'button',
  title,
  place,
  ref,
  children,
  ...rest
}: NativeButton &
  Placed<S> & {
    variant?: ButtonVariant
    size?: ButtonSize
    icon?: LucideIcon
    busy?: boolean
    title?: string
    ref?: Ref<HTMLButtonElement>
    children: ReactNode
  }) {
  return (
    <button
      type={type}
      {...rest}
      ref={ref}
      title={title}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      className={placed(
        'inline-flex',
        `items-center justify-center gap-1.5 ${buttonLook(variant, size)}`,
        place
      )}
    >
      <Busy busy={busy}>
        {Icon && <Icon size={BUTTON_ICON[size]} aria-hidden className="shrink-0" />}
        {children}
      </Busy>
    </button>
  )
}

// A button that shows only an icon. `label` is its name for screen readers and its tooltip, so
// every icon button has both; `tooltip` replaces the tooltip when the name holds what a tooltip
// must not show (a name streamer mode hides) or should not repeat. `pressed` makes it a toggle; `children` (a badge, a dot) sits over
// the icon.
export function IconButton<const S extends string = never>({
  icon: Icon,
  label,
  tooltip,
  tone = 'plain',
  size = 'md',
  shape = 'round',
  pressed,
  type = 'button',
  place,
  ref,
  children,
  ...rest
}: NativeButton &
  Placed<S> & {
    icon: LucideIcon
    label: string
    tooltip?: string
    tone?: IconButtonTone
    size?: IconButtonSize
    shape?: IconButtonShape
    pressed?: boolean
    ref?: Ref<HTMLButtonElement>
    children?: ReactNode
  }) {
  const over = children !== undefined && children !== null && children !== false
  return (
    <button
      type={type}
      {...rest}
      ref={ref}
      title={tooltip ?? label}
      aria-label={label}
      aria-pressed={pressed}
      className={placed('inline-flex', iconButtonLook(tone, size, shape), place)}
    >
      {over ? (
        <span className={iconBoxLook(size)}>
          <Icon size={ICON_SIZE[size]} aria-hidden />
          {children}
        </span>
      ) : (
        <Icon size={ICON_SIZE[size]} aria-hidden />
      )}
    </button>
  )
}

// A row of a menu or a list: leading icon (or `leading`, an avatar), label (and a line under it),
// trailing slot, and a chevron when it opens a page (`narrow`: only while the screen is narrow).
// `current` marks the open one (`page`: the page shown beside the list). `wrap` lets a long label
// wrap instead of cutting it short. A `streamer` label is a name: streamer mode blurs it.
export function ListRow<const S extends string = never>({
  icon: Icon,
  leading,
  label,
  description,
  trailing,
  chevron = false,
  tone = 'plain',
  variant = 'plain',
  current = false,
  wrap = false,
  streamer = false,
  type = 'button',
  title,
  place,
  ref,
  ...rest
}: NativeButton &
  Placed<S> & {
    icon?: LucideIcon
    leading?: ReactNode
    label: ReactNode
    description?: ReactNode
    trailing?: ReactNode
    chevron?: boolean | 'narrow'
    tone?: RowTone
    variant?: RowVariant
    current?: boolean | 'page'
    wrap?: boolean
    streamer?: boolean
    title?: string
    ref?: Ref<HTMLButtonElement>
  }) {
  return (
    <button
      type={type}
      {...rest}
      ref={ref}
      title={title}
      aria-current={current || undefined}
      className={placed('flex', rowLook(tone, variant), place)}
    >
      {Icon && <Icon size={18} aria-hidden className="shrink-0 opacity-80" />}
      {leading}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className={`${streamer ? 'streamer ' : ''}${wrap ? 'break-words' : 'truncate'}`}>
          {label}
        </span>
        {description && (
          <span className="break-words text-xs text-on-surface-variant">{description}</span>
        )}
      </span>
      {trailing}
      {chevron && (
        <ChevronRight
          size={18}
          aria-hidden
          className={`shrink-0 ${chevron === 'narrow' ? 'md:hidden' : 'text-on-surface-variant'}`}
        />
      )}
    </button>
  )
}

// A button inside a line of text ("No friends yet. Add friend"): it reads as a link and keeps the
// line's height.
export function LinkButton({
  type = 'button',
  ref,
  children,
  ...rest
}: NativeButton & { ref?: Ref<HTMLButtonElement>; children: ReactNode }) {
  return (
    <button type={type} {...rest} ref={ref} className={linkLook}>
      {children}
    </button>
  )
}

// One of a few choices as a chip. A toggle says whether it is on; in a radio group (`radio`) it
// says whether it is the chosen one.
export function Chip<const S extends string = never>({
  on,
  radio = false,
  type = 'button',
  place,
  ref,
  children,
  ...rest
}: NativeButton &
  Placed<S> & {
    on: boolean
    radio?: boolean
    ref?: Ref<HTMLButtonElement>
    children: ReactNode
  }) {
  return (
    <button
      type={type}
      {...rest}
      ref={ref}
      role={radio ? 'radio' : undefined}
      aria-checked={radio ? on : undefined}
      aria-pressed={radio ? undefined : on}
      className={placed('inline-block', chipLook(on), place)}
    >
      {children}
    </button>
  )
}

// A tab of a tab list (the list itself is the caller's `role="tablist"` element).
export function Tab<const S extends string = never>({
  selected,
  icon: Icon,
  type = 'button',
  place,
  ref,
  children,
  ...rest
}: NativeButton &
  Placed<S> & {
    selected: boolean
    icon?: LucideIcon
    ref?: Ref<HTMLButtonElement>
    children: ReactNode
  }) {
  return (
    <button
      type={type}
      {...rest}
      ref={ref}
      role="tab"
      aria-selected={selected}
      className={placed('inline-flex', tabLook, place)}
    >
      {Icon && <Icon size={16} aria-hidden className="shrink-0" />}
      {children}
    </button>
  )
}

// Covers a secret (in streamer mode) until pressed.
export function Cover<const S extends string = never>({
  type = 'button',
  place,
  ref,
  children,
  ...rest
}: NativeButton & Placed<S> & { ref?: Ref<HTMLButtonElement>; children: ReactNode }) {
  return (
    <button type={type} {...rest} ref={ref} className={placed('flex', coverLook, place)}>
      <Eye size={16} aria-hidden className="shrink-0" />
      {children}
    </button>
  )
}

// The small capital heading over a group of settings or a list section. `action` sits at its end.
export function SectionHeading({
  children,
  action,
  as: Tag = 'h3',
  id,
}: {
  children: ReactNode
  action?: ReactNode
  as?: 'h2' | 'h3' | 'h4' | 'p'
  id?: string
}) {
  if (!action)
    return (
      <Tag id={id} className={sectionHeadingLook}>
        {children}
      </Tag>
    )
  return (
    <div className={`flex items-center gap-2 ${sectionHeadingLook}`}>
      <Tag id={id} className="min-w-0 flex-1 truncate">
        {children}
      </Tag>
      {action}
    </div>
  )
}

type Span = Omit<HTMLAttributes<HTMLSpanElement>, 'className' | 'style'>

// A count, on a small round badge.
export function Badge<const S extends string = never>({
  tone = 'danger',
  place,
  children,
  ...rest
}: Span & Placed<S> & { tone?: BadgeTone; children: ReactNode }) {
  return (
    <span {...rest} className={placed('inline-flex', badgeLook(tone), place)}>
      {children}
    </span>
  )
}

// A short label (a role, a kind, a state), on a pill.
export function Pill<const S extends string = never>({
  tone = 'neutral',
  place,
  children,
  ...rest
}: Span & Placed<S> & { tone?: BadgeTone; children: ReactNode }) {
  return (
    <span {...rest} className={placed('inline-flex', pillLook(tone), place)}>
      {children}
    </span>
  )
}
