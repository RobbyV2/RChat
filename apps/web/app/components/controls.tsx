'use client'

import type { ButtonHTMLAttributes, CSSProperties, HTMLAttributes, ReactNode, Ref } from 'react'
import { Check, ChevronRight, Eye, LoaderCircle, type LucideIcon } from 'lucide-react'
import {
  BUTTON_ICON,
  CALL_ICON,
  GLYPH_TEXT,
  ICON_SIZE,
  appButtonStyleLook,
  badgeLook,
  buttonLook,
  callButtonLook,
  cardButtonLook,
  chipLook,
  coverLook,
  emojiCellLook,
  hotspotLook,
  iconBoxLook,
  iconButtonLook,
  linkLook,
  mediaButtonLook,
  pillLook,
  placed,
  pollChoiceLook,
  railToggleLook,
  rowLook,
  sectionHeadingLook,
  sideRowButtonLook,
  swatchLook,
  switchRowLook,
  switchThumbLook,
  switchTrackLook,
  tabLook,
  tickBoxLook,
  tickLook,
  tileLook,
  triLook,
  windowButtonLook,
  type AppButtonStyle,
  type BadgeTone,
  type ButtonSize,
  type ButtonVariant,
  type CallSize,
  type CallTone,
  type CardPad,
  type CardTone,
  type ChipVariant,
  type IconButtonShape,
  type IconButtonSize,
  type IconButtonTone,
  type LinkTone,
  type MediaShape,
  type Place,
  type RowTone,
  type RowVariant,
  type SideRowTone,
  type TileTone,
  type TriTone,
  type WindowButtonKind,
} from '../lib/controls'
import { FUNCTIONAL } from '../lib/motion/functional'
import { look, plays } from '../lib/motion/play'

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
        <LoaderCircle size={16} aria-hidden className={FUNCTIONAL.spinSafe} />
      </span>
    </span>
  )
}

// A labelled button. `busy` disables it and shows a spinner in place of its label while the
// label keeps the width. `title` is for a longer description than the label, and `label` names it
// when its words are not always shown. `align="start"` starts a wide one's label at its edge;
// `raised` lifts one that floats over the page.
export function Button<const S extends string = never>({
  variant = 'text',
  size = 'sm',
  icon: Icon,
  busy = false,
  align = 'center',
  raised = false,
  disabled,
  type = 'button',
  title,
  label,
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
    align?: 'center' | 'start'
    raised?: boolean
    title?: string
    label?: string
    ref?: Ref<HTMLButtonElement>
    children: ReactNode
  }) {
  return (
    <button
      type={type}
      {...rest}
      ref={ref}
      title={title}
      aria-label={label}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      className={placed(
        'inline-flex',
        `items-center ${align === 'start' ? 'justify-start text-left' : 'justify-center'} gap-1.5 ${buttonLook(variant, size)}${raised ? ' shadow-elevation-2' : ''}`,
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
// the icon. `glyph` shows an emoji (or any small mark) in place of the icon. `grip` makes it a
// handle to drag by.
export function IconButton<const S extends string = never>({
  icon: Icon,
  glyph,
  label,
  tooltip,
  tone = 'plain',
  size = 'md',
  shape = 'round',
  tight = false,
  grip = false,
  pressed,
  type = 'button',
  place,
  ref,
  children,
  ...rest
}: NativeButton &
  Placed<S> &
  ({ icon: LucideIcon; glyph?: undefined } | { icon?: undefined; glyph: ReactNode }) & {
    label: string
    tooltip?: string
    tone?: IconButtonTone
    size?: IconButtonSize
    shape?: IconButtonShape
    tight?: boolean
    grip?: boolean
    pressed?: boolean
    ref?: Ref<HTMLButtonElement>
    children?: ReactNode
  }) {
  const over = children !== undefined && children !== null && children !== false
  const mark = Icon ? (
    <Icon size={ICON_SIZE[size]} aria-hidden />
  ) : (
    <span aria-hidden className={GLYPH_TEXT[size]}>
      {glyph}
    </span>
  )
  return (
    <button
      type={type}
      {...rest}
      ref={ref}
      title={tooltip ?? label}
      aria-label={label}
      aria-pressed={pressed}
      className={placed(
        'inline-flex',
        `${iconButtonLook(tone, size, shape, tight)}${grip ? ' cursor-grab touch-none' : ''}`,
        place
      )}
    >
      {over ? (
        <span className={iconBoxLook(size)}>
          {mark}
          {children}
        </span>
      ) : (
        mark
      )}
    </button>
  )
}

// A row of a menu or a list: leading icon (or `leading`, an avatar), label (and a line under it),
// trailing slot, and a chevron when it opens a page (`narrow`: only while the screen is narrow).
// `current` marks the open one (`page`: the page shown beside the list). `wrap` lets a long label
// wrap instead of cutting it short. `name`
// is what a screen reader calls it when its label alone does not say.
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
  pressed,
  wrap = false,
  type = 'button',
  title,
  name,
  place,
  ref,
  ...rest
}: Omit<NativeButton, 'name'> &
  Placed<S> & {
    icon?: LucideIcon
    leading?: ReactNode
    label: ReactNode
    pressed?: boolean
    name?: string
    description?: ReactNode
    trailing?: ReactNode
    chevron?: boolean | 'narrow'
    tone?: RowTone
    variant?: RowVariant
    current?: boolean | 'page'
    wrap?: boolean
    title?: string
    ref?: Ref<HTMLButtonElement>
  }) {
  return (
    <button
      type={type}
      {...rest}
      ref={ref}
      title={title}
      aria-label={name}
      aria-current={current || undefined}
      aria-pressed={pressed}
      className={placed('flex', rowLook(tone, variant), place)}
    >
      {Icon && <Icon size={18} aria-hidden className="shrink-0 opacity-80" />}
      {leading}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className={wrap ? 'break-words' : 'truncate'}>{label}</span>
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
// line's height and type. `underlined` shows the line under it always, not only under the mouse.
export function LinkButton<const S extends string = never>({
  tone = 'primary',
  underlined = false,
  type = 'button',
  title,
  label,
  place,
  ref,
  children,
  ...rest
}: NativeButton &
  Placed<S> & {
    tone?: LinkTone
    underlined?: boolean
    title?: string
    label?: string
    ref?: Ref<HTMLButtonElement>
    children: ReactNode
  }) {
  return (
    <button
      type={type}
      {...rest}
      ref={ref}
      title={title}
      aria-label={label}
      className={placed('inline-flex', linkLook(tone, underlined), place)}
    >
      {children}
    </button>
  )
}

// One of a few choices as a chip. A toggle says whether it is on; in a radio group (`radio`) it
// says whether it is the chosen one; `as` makes it a switch or a tab of a tab list. `plain`
// children are laid out as given (an emoji and a count) and not cut short.
export function Chip<const S extends string = never>({
  on,
  radio = false,
  as = radio ? 'radio' : 'toggle',
  variant = 'pill',
  icon: Icon,
  plain = false,
  title,
  label,
  type = 'button',
  place,
  ref,
  children,
  ...rest
}: NativeButton &
  Placed<S> & {
    on: boolean
    radio?: boolean
    as?: 'toggle' | 'radio' | 'switch' | 'tab'
    variant?: ChipVariant
    icon?: LucideIcon
    plain?: boolean
    title?: string
    label?: string
    ref?: Ref<HTMLButtonElement>
    children: ReactNode
  }) {
  return (
    <button
      type={type}
      {...rest}
      ref={ref}
      title={title}
      aria-label={label}
      role={as === 'toggle' ? undefined : as}
      aria-checked={as === 'radio' || as === 'switch' ? on : undefined}
      aria-selected={as === 'tab' ? on : undefined}
      aria-pressed={as === 'toggle' ? on : undefined}
      className={placed('inline-flex', chipLook(on, variant), place)}
    >
      {Icon && <Icon size={14} aria-hidden className="shrink-0" />}
      {plain ? children : <span className="truncate">{children}</span>}
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
      {...look('nav.indicator')}
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
    <span {...rest} ref={plays('badge')} className={placed('inline-flex', badgeLook(tone), place)}>
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

type Labelled = {
  // Its name for screen readers and its tooltip; `tooltip` replaces the tooltip (see IconButton).
  label: string
  tooltip?: string
}

// A tile of the rail: a server, a folder, Home, an action. What it holds (a glyph, an avatar, an
// icon, its badges) are its children. `tint` carries the colors of a folder's own color.
export function Tile<const S extends string = never>({
  tone = 'idle',
  tint,
  label,
  tooltip,
  pressed,
  type = 'button',
  place,
  ref,
  children,
  ...rest
}: NativeButton &
  Placed<S> &
  Labelled & {
    tone?: TileTone
    tint?: CSSProperties
    pressed?: boolean
    ref?: Ref<HTMLButtonElement>
    children: ReactNode
  }) {
  return (
    <button
      type={type}
      {...rest}
      ref={ref}
      title={tooltip ?? label}
      aria-label={label}
      aria-pressed={pressed}
      style={tint}
      {...look('hover', 'nav.indicator')}
      className={placed('flex', tileLook(tone), place)}
    >
      {children}
    </button>
  )
}

// The small toggle over a group of rail tiles that folds the group: a chip with a letter, or an
// avatar (`chip={false}`).
export function RailToggle({
  open,
  chip = true,
  tooltip,
  type = 'button',
  children,
  ...rest
}: NativeButton & { open: boolean; chip?: boolean; tooltip: string; children: ReactNode }) {
  return (
    <button
      type={type}
      {...rest}
      title={tooltip}
      aria-expanded={open}
      className={`flex ${railToggleLook(chip)}`}
    >
      {children}
    </button>
  )
}

// A row of the channel sidebar: a channel, a conversation, a section. `current` marks the open
// one (`pressed` for a row that toggles a panel), `dim` fades a muted one, and a `heading` folds
// the rows under it (`open`; `caps` sets it in spaced capitals).
export function SideRow<const S extends string = never>({
  tone = 'plain',
  current = false,
  pressed,
  open,
  dim = false,
  caps = false,
  title,
  label,
  type = 'button',
  place,
  ref,
  children,
  ...rest
}: NativeButton &
  Placed<S> & {
    tone?: SideRowTone
    current?: boolean
    pressed?: boolean
    open?: boolean
    dim?: boolean
    caps?: boolean
    title?: string
    label?: string
    ref?: Ref<HTMLButtonElement>
    children: ReactNode
  }) {
  return (
    <button
      type={type}
      {...rest}
      ref={ref}
      title={title}
      aria-label={label}
      aria-current={current ? 'page' : undefined}
      aria-pressed={pressed}
      aria-expanded={open}
      {...look('nav.indicator')}
      className={placed(
        'flex',
        `${sideRowButtonLook(tone, dim && !current && !pressed)}${caps ? ' tracking-wider uppercase' : ''}`,
        place
      )}
    >
      {children}
    </button>
  )
}

// A round control of a call. `pressed` makes it a toggle.
export function CallButton<const S extends string = never>({
  icon: Icon,
  tone = 'idle',
  size = 'lg',
  label,
  tooltip,
  pressed,
  type = 'button',
  place,
  ...rest
}: NativeButton &
  Placed<S> &
  Labelled & { icon: LucideIcon; tone?: CallTone; size?: CallSize; pressed?: boolean }) {
  return (
    <button
      type={type}
      {...rest}
      title={tooltip ?? label}
      aria-label={label}
      aria-pressed={pressed}
      className={placed('flex', callButtonLook(tone, size), place)}
    >
      <Icon size={CALL_ICON[size]} aria-hidden />
    </button>
  )
}

// A card one can press. `column` stacks what it holds, centered; `pressed` and `current` show it
// chosen; `open` says it unfolds what follows it.
export function CardButton<const S extends string = never>({
  tone = 'plain',
  pad = 'md',
  column = false,
  pressed,
  current,
  open,
  title,
  label,
  type = 'button',
  place,
  ref,
  children,
  ...rest
}: NativeButton &
  Placed<S> & {
    tone?: CardTone
    pad?: CardPad
    column?: boolean
    pressed?: boolean
    current?: boolean
    open?: boolean
    title?: string
    label?: string
    ref?: Ref<HTMLButtonElement>
    children: ReactNode
  }) {
  return (
    <button
      type={type}
      {...rest}
      ref={ref}
      title={title}
      aria-label={label}
      aria-pressed={pressed}
      aria-current={current ? 'true' : undefined}
      aria-expanded={open}
      {...look('hover')}
      className={placed('flex', cardButtonLook(tone, pad, column), place)}
    >
      {children}
    </button>
  )
}

// A picture one can press: an image that opens, a covered image, an avatar. The picture is its
// child; `zoom` shows the pointer of something that opens larger.
export function MediaButton<const S extends string = never>({
  shape = 'card',
  zoom = false,
  title,
  label,
  type = 'button',
  place,
  ref,
  children,
  ...rest
}: NativeButton &
  Placed<S> & {
    shape?: MediaShape
    zoom?: boolean
    title?: string
    label?: string
    ref?: Ref<HTMLButtonElement>
    children: ReactNode
  }) {
  return (
    <button
      type={type}
      {...rest}
      ref={ref}
      title={title}
      aria-label={label}
      className={placed('block', mediaButtonLook(shape, zoom), place)}
    >
      {children}
    </button>
  )
}

// A button with nothing to show that covers its positioned parent, so pressing the parent
// anywhere presses it. `labelledBy` names it by another element when it has no label of its own.
export function Hotspot({
  label,
  labelledBy,
  tooltip,
  tint = false,
  pressed,
  type = 'button',
  ...rest
}: NativeButton &
  ({ label: string; labelledBy?: undefined } | { label?: undefined; labelledBy: string }) & {
    tooltip?: string
    tint?: boolean
    pressed?: boolean
  }) {
  return (
    <button
      type={type}
      {...rest}
      title={tooltip ?? label}
      aria-label={label}
      aria-labelledby={labelledBy}
      aria-pressed={pressed}
      className={hotspotLook(tint)}
    />
  )
}

// A color to pick: a circle of that color with a check when it is the chosen one. `ink` is the
// check's color on it.
export function Swatch({
  color,
  ink,
  on,
  label,
  tooltip,
  type = 'button',
  ...rest
}: NativeButton & Labelled & { color: string; ink: string; on: boolean }) {
  return (
    <button
      type={type}
      {...rest}
      title={tooltip ?? label}
      aria-label={label}
      aria-pressed={on}
      style={{ background: color, color: ink }}
      className={`flex ${swatchLook}`}
    >
      {on && <Check size={16} aria-hidden />}
    </button>
  )
}

// A switch as a row: its label (and a hint under it) with the switch at the end. `hintId` is the
// id the hint gets, for a caller that describes something else by it too.
export function SwitchRow({
  checked,
  label,
  hint,
  hintId,
  title,
  type = 'button',
  ...rest
}: NativeButton & {
  checked: boolean
  label: string
  hint?: string
  hintId?: string
  title?: string
}) {
  return (
    <button
      type={type}
      {...rest}
      role="switch"
      aria-checked={checked}
      aria-label={label}
      aria-describedby={hint && hintId ? hintId : undefined}
      title={title ?? label}
      className={`group/switch flex ${switchRowLook}`}
    >
      <span className="flex min-w-0 flex-col">
        <span>{label}</span>
        {hint && (
          <span id={hintId} className="text-xs text-on-surface-variant">
            {hint}
          </span>
        )}
      </span>
      <span aria-hidden {...look('toggle')} className={`flex ${switchTrackLook}`}>
        <span className={`flex ${switchThumbLook}`}>
          <Check size={12} strokeWidth={4} />
        </span>
      </span>
    </button>
  )
}

// The box that selects a row: ticked or not.
export function Tick({
  checked,
  label,
  type = 'button',
  ...rest
}: NativeButton & { checked: boolean; label: string }) {
  return (
    <button
      type={type}
      {...rest}
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      title={label}
      className={`flex ${tickLook}`}
    >
      <span className={`flex ${tickBoxLook}`}>
        {checked && <Check size={14} strokeWidth={3} aria-hidden />}
      </span>
    </button>
  )
}

// A button of the window's title bar; its glyph is its child.
export function WindowButton({
  kind,
  label,
  type = 'button',
  children,
  ...rest
}: NativeButton & { kind: WindowButtonKind; label: string; children: ReactNode }) {
  return (
    <button
      type={type}
      {...rest}
      title={label}
      aria-label={label}
      className={`flex ${windowButtonLook(kind)}`}
    >
      {children}
    </button>
  )
}

// An emoji of the picker's grid (an option of its list box). `touch` is the larger one of the
// sheet.
export function EmojiCell({
  label,
  touch = false,
  type = 'button',
  children,
  ...rest
}: NativeButton & { label: string; touch?: boolean; children: ReactNode }) {
  return (
    <button
      type={type}
      {...rest}
      role="option"
      tabIndex={-1}
      aria-selected={false}
      aria-label={label}
      className={`flex ${emojiCellLook(touch)}`}
    >
      <span className={touch ? undefined : 'transition-transform duration-100 hover:scale-110'}>
        {children}
      </span>
    </button>
  )
}

// A button an app puts under its message. `wide` is the closed face of its select menu.
export function AppButton({
  style = 'plain',
  wide = false,
  pressed,
  title,
  type = 'button',
  ref,
  children,
  ...rest
}: NativeButton & {
  style?: AppButtonStyle
  wide?: boolean
  pressed?: boolean
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
      aria-pressed={pressed}
      className={`flex ${appButtonStyleLook(style, wide)}`}
    >
      {children}
    </button>
  )
}

// One of the three states of a permission, in a frame with the other two.
export function TriButton({
  icon: Icon,
  tone,
  on,
  label,
  tooltip,
  type = 'button',
  ...rest
}: NativeButton & Labelled & { icon: LucideIcon; tone: TriTone; on: boolean }) {
  return (
    <button
      type={type}
      {...rest}
      title={tooltip ?? label}
      aria-label={label}
      aria-pressed={on}
      className={`flex ${triLook(tone)}`}
    >
      <Icon size={14} aria-hidden />
    </button>
  )
}

// An option of a poll one can vote for; what it shows (its bar, text and count) are its children.
export function PollChoice({
  chosen,
  type = 'button',
  children,
  ...rest
}: NativeButton & { chosen: boolean; children: ReactNode }) {
  return (
    <button type={type} {...rest} aria-pressed={chosen} className={pollChoiceLook}>
      {children}
    </button>
  )
}
