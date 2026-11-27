// The looks of the shared controls: buttons, icon buttons, list rows, section headings, badges and
// pills, each built from a fixed set of choices. The components in `components/controls.tsx` take
// these choices as props. A call site places a control in its parent with `Place` classes only
// (position, margins, flex and grid item sizing, display and reveal), never with spacing, color or
// type, so every control of a kind looks the same. On a coarse pointer every control is at least
// 44 px high (and an icon button 44 px wide); with a mouse it keeps its size.

export type ButtonVariant = 'filled' | 'tonal' | 'text' | 'danger' | 'filled-danger'
export type ButtonSize = 'sm' | 'md'
export type IconButtonTone =
  'plain' | 'inherit' | 'primary' | 'danger' | 'filled' | 'filled-danger' | 'overlay'
export type IconButtonSize = 'sm' | 'md' | 'lg'
export type IconButtonShape = 'round' | 'square'
export type RowTone = 'plain' | 'muted' | 'danger'
export type RowVariant = 'plain' | 'card'
export type BadgeTone = 'danger' | 'primary' | 'tertiary' | 'neutral' | 'outline'

type Sign = '' | '-'
type Edge = 'top' | 'right' | 'bottom' | 'left' | 'inset' | 'inset-x' | 'inset-y' | 'start' | 'end'
type Margin = 'm' | 'mx' | 'my' | 'mt' | 'mr' | 'mb' | 'ml' | 'ms' | 'me'
type Length = `${number}` | `${number}/${number}` | 'px' | 'full' | 'auto' | 'app' | `[${string}]`
type Layer = 'raised' | 'float' | 'popover' | 'page' | 'top' | 'banner' | 'drag' | 'chrome'
type Display = 'hidden' | 'flex' | 'inline-flex'
type PlaceUtility =
  | 'absolute'
  | 'relative'
  | 'fixed'
  | 'sticky'
  | `${Sign}${Edge}-${Length}`
  | `${Sign}translate-${'x' | 'y'}-${Length}`
  | `z-${Layer}`
  | `${Sign}${Margin}-${Length}`
  | Display
  | 'invisible'
  | 'visible'
  | 'shrink-0'
  | 'grow'
  | 'flex-1'
  | 'flex-none'
  | 'flex-auto'
  | `self-${string}`
  | `justify-self-${string}`
  | `place-self-${string}`
  | `order-${string}`
  | `col-${string}`
  | `row-${string}`
  | 'w-full'
  | 'w-fit'
  | 'min-w-0'
  | 'max-w-full'
  | 'opacity-0'
  | 'opacity-100'
  | 'pointer-events-none'
  | 'pointer-events-auto'
  | 'group'
  | `group/${string}`
  | 'peer'
type Breakpoint = 'sm' | 'md' | 'lg' | 'xl' | '2xl'
type Variant =
  | Breakpoint
  | `max-${Breakpoint}`
  | `@${Breakpoint | `max-${Breakpoint}`}`
  | 'pointer-coarse'
  | 'pointer-fine'
  | 'hover'
  | 'focus-visible'
  | 'focus-within'
  | 'disabled'
  | 'keyboard'
  | `group-${'hover' | 'focus-within' | 'focus-visible' | `has-${string}`}${'' | `/${string}`}`
  | `peer-${string}`
  | `data-${string}`

// One word: variants (`md:`, `group-hover/x:`) in front of a placement utility.
type Word<W extends string> = W extends `${infer V}:${infer Rest}`
  ? V extends Variant
    ? `${V}:${Word<Rest>}`
    : never
  : W extends PlaceUtility
    ? W
    : never

type Tokens<S extends string> = S extends `${infer Head} ${infer Rest}`
  ? `${Word<Head>} ${Tokens<Rest>}`
  : Word<S>

// Space separated placement classes, checked word by word: `place="ml-auto shrink-0"`. A word that
// sets a look (spacing inside, color, type, size) does not type check, nor does a computed string.
export type Place<S extends string> = S & Tokens<S>

const words = (s: string) => s.split(/\s+/).filter(Boolean)

const DISPLAY: readonly string[] = ['hidden', 'flex', 'inline-flex', 'inline-block']
const POSITION: readonly string[] = ['absolute', 'relative', 'fixed', 'sticky']

// The control's own display and position (`base`), its look and its placement as one class list.
// A placement that sets the display (`hidden md:inline-flex`) or the position (`absolute`) takes
// the place of the control's own.
export const placed = (base: string, look: string, place?: string) => {
  const own = words(place ?? '')
  const kept = words(base).filter(
    w =>
      !own.some(
        p =>
          (DISPLAY.includes(w) && DISPLAY.includes(p)) ||
          (POSITION.includes(w) && POSITION.includes(p))
      )
  )
  return [...kept, look, ...own].join(' ')
}

const FOCUS = 'outline-offset-2 focus-visible:outline-2 focus-visible:outline-primary'
const HOVER = 'hover-idle:bg-on-surface/8'

const BUTTON_TONE: Record<ButtonVariant, string> = {
  filled: 'bg-primary text-on-primary hover-idle:opacity-90',
  tonal: 'bg-secondary-container text-on-secondary-container hover-idle:opacity-90',
  text: `text-primary ${HOVER}`,
  danger: `text-error ${HOVER}`,
  'filled-danger': 'bg-error text-on-error hover-idle:opacity-90',
}

const BUTTON_SIZE: Record<ButtonSize, string> = {
  sm: 'px-3 py-1.5',
  md: 'px-4 py-2',
}

// A labelled button: pill shape, medium label, 32 px (`sm`) or 36 px (`md`) high.
export const buttonLook = (variant: ButtonVariant, size: ButtonSize) =>
  `rounded-full ${BUTTON_SIZE[size]} text-sm font-medium ${BUTTON_TONE[variant]} ${FOCUS} disabled:opacity-40 pointer-coarse:min-h-11 pointer-coarse:min-w-11`

export const BUTTON_ICON: Record<ButtonSize, number> = { sm: 16, md: 18 }

const ICON_TONE: Record<IconButtonTone, string> = {
  plain: `text-on-surface-variant ${HOVER} hover-idle:text-on-surface`,
  inherit: HOVER,
  primary: `text-primary ${HOVER}`,
  danger: `text-on-surface-variant ${HOVER} hover-idle:text-error`,
  filled: 'bg-primary text-on-primary hover-idle:opacity-90',
  'filled-danger': 'bg-error text-on-error hover-idle:opacity-90',
  overlay: 'bg-scrim/70 text-on-scrim hover-idle:bg-scrim/85',
}

const ICON_BOX: Record<IconButtonSize, string> = {
  sm: 'size-7',
  md: 'size-8',
  lg: 'size-9',
}

export const ICON_SIZE: Record<IconButtonSize, number> = { sm: 16, md: 18, lg: 20 }

// An icon only button: a 28, 32 or 36 px circle (or rounded square) with its icon in the middle.
// `aria-pressed` shows it on, `aria-expanded` on a button with a popup shows the popup open (the
// `pressed:` and `expanded:` variants of globals.css).
export const iconButtonLook = (
  tone: IconButtonTone,
  size: IconButtonSize,
  shape: IconButtonShape = 'round'
) =>
  `${ICON_BOX[size]} shrink-0 items-center justify-center ${shape === 'round' ? 'rounded-full' : 'rounded-lg'} ${ICON_TONE[tone]} ${FOCUS} expanded:bg-on-surface/8 pressed:bg-secondary-container pressed:text-on-secondary-container disabled:opacity-40 pointer-coarse:size-11`

const ROW_TONE: Record<RowTone, string> = {
  plain: 'text-on-surface',
  muted: 'text-on-surface-variant hover-idle:text-on-surface',
  danger: 'text-error',
}

// A row of a list or menu: leading icon, label, trailing slot. A `card` row sits on its own
// surface and is 44 px high with any pointer. `aria-current` marks the open one.
export const rowLook = (tone: RowTone, variant: RowVariant = 'plain') =>
  `w-full min-w-0 items-center gap-3 px-3 py-2 text-left text-sm ${ROW_TONE[tone]} ${
    variant === 'card'
      ? 'min-h-11 rounded-xl bg-surface-container hover-idle:bg-surface-container-highest'
      : `rounded-lg ${HOVER}`
  } ${FOCUS} current:bg-secondary-container current:text-on-secondary-container selected:bg-secondary-container selected:text-on-secondary-container disabled:opacity-40 pointer-coarse:min-h-11`

// One choice of a few, as a chip: the chosen one is filled.
export const chipLook = (on: boolean) =>
  `max-w-full truncate rounded-full border px-3 py-1.5 text-sm ${FOCUS} disabled:opacity-50 pointer-coarse:min-h-11 pointer-coarse:min-w-11 ${
    on
      ? 'border-transparent bg-secondary-container text-on-secondary-container'
      : `border-outline text-on-surface-variant ${HOVER}`
  }`

// A tab of a tab list: the selected one is filled.
export const tabLook = `items-center justify-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-medium text-on-surface-variant ${HOVER} ${FOCUS} selected:bg-secondary-container selected:text-on-secondary-container disabled:opacity-40 pointer-coarse:min-h-11 pointer-coarse:min-w-11`

// What covers a secret until pressed: a dashed box the width of its place.
export const coverLook = `min-h-12 w-full items-center justify-center gap-2 rounded-xl border border-dashed border-outline-variant px-3 py-2 text-center text-sm text-on-surface-variant ${HOVER} hover-idle:text-on-surface ${FOCUS}`

export const sectionHeadingLook =
  'pb-2 pt-5 text-xs font-medium uppercase tracking-wide text-on-surface-variant first:pt-0'

const BADGE_TONE: Record<BadgeTone, string> = {
  danger: 'bg-danger text-on-danger',
  primary: 'bg-primary text-on-primary',
  tertiary: 'bg-tertiary-container text-on-tertiary-container',
  neutral: 'bg-surface-container-highest text-on-surface-variant',
  outline: 'border border-outline-variant text-on-surface-variant',
}

// A count on a small round badge.
export const badgeLook = (tone: BadgeTone) =>
  `h-4.5 min-w-4.5 shrink-0 items-center justify-center rounded-full px-1 text-2xs leading-none font-bold tabular-nums ${BADGE_TONE[tone]}`

// A short label on a pill.
export const pillLook = (tone: BadgeTone) =>
  `min-w-0 shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-2xs leading-4 font-medium ${BADGE_TONE[tone]}`
