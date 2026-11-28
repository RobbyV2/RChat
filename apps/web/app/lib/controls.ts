// The looks of the shared controls: buttons, icon buttons, list rows, section headings, badges and
// pills, each built from a fixed set of choices. The components in `components/controls.tsx` take
// these choices as props. A call site places a control in its parent with `Place` classes only
// (position, `auto` margins, flex and grid item sizing, display and reveal), never with spacing, color or
// type, so every control of a kind looks the same. On a coarse pointer every control is at least
// 44 px high (and an icon button 44 px wide); with a mouse it keeps its size.

export type ButtonVariant = 'filled' | 'tonal' | 'text' | 'danger' | 'filled-danger'
export type ButtonSize = 'sm' | 'md'
export type IconButtonTone =
  'plain' | 'inherit' | 'primary' | 'danger' | 'error' | 'filled' | 'filled-danger' | 'overlay'
export type IconButtonSize = 'xs' | 'sm' | 'md' | 'lg'
export type IconButtonShape = 'round' | 'square'
export type RowTone = 'plain' | 'muted' | 'primary' | 'danger'
export type RowVariant = 'plain' | 'card'
export type BadgeTone = 'danger' | 'primary' | 'tertiary' | 'neutral' | 'outline' | 'error'

type Sign = '' | '-'
type Edge = 'top' | 'right' | 'bottom' | 'left' | 'inset' | 'inset-x' | 'inset-y' | 'start' | 'end'
type Margin = 'm' | 'mx' | 'my' | 'mt' | 'mr' | 'mb' | 'ml' | 'ms' | 'me'
type Length = `${number}` | `${number}/${number}` | 'px' | 'full' | 'auto' | 'app' | `[${string}]`
type Layer =
  | 'raised'
  | 'float'
  | 'popover'
  | 'page'
  | 'lightbox'
  | 'top'
  | 'palette'
  | 'banner'
  | 'drag'
  | 'chrome'
type Display = 'hidden' | 'flex' | 'inline-flex' | 'grid' | 'block'
type Size = 'w' | 'h' | 'size' | 'min-w' | 'min-h' | 'max-w' | 'max-h'
type Container = 'xs' | 'sm' | 'md' | 'lg' | 'xl' | '2xl' | '3xl' | '4xl' | '5xl' | '6xl' | 'prose'
type SharedUtility =
  | 'absolute'
  | 'relative'
  | 'fixed'
  | 'sticky'
  | `${Sign}${Edge}-${Length}`
  | `${Sign}translate-${'x' | 'y'}-${Length}`
  | `z-${Layer}`
  | `${Margin}-auto`
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
  | 'h-full'
  | 'h-app'
  | 'min-h-app'
  | 'min-w-0'
  | 'min-h-0'
  | 'max-w-full'
  | 'max-h-full'
  | `max-w-${Container}`
  | `overflow-${'' | 'x-' | 'y-'}${'auto' | 'hidden' | 'visible' | 'clip'}`
  | `overscroll-${'' | 'x-' | 'y-'}contain`
  | 'opacity-0'
  | 'opacity-100'
  | 'pointer-events-none'
  | 'pointer-events-auto'
  | 'group'
  | `group/${string}`
  | 'peer'
// A layout box may also have a fixed size (a rail, a media frame); a control's size is its look.
type LayoutUtility = SharedUtility | `${Size}-${number}` | `${Size}-${number}/${number}`
type PlaceUtility = SharedUtility
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
type Word<W extends string, U extends string> = W extends `${infer V}:${infer Rest}`
  ? V extends Variant
    ? `${V}:${Word<Rest, U>}`
    : never
  : W extends U
    ? W
    : never

type Tokens<S extends string, U extends string> = S extends `${infer Head} ${infer Rest}`
  ? `${Word<Head, U>} ${Tokens<Rest, U>}`
  : Word<S, U>

// Space separated placement classes, checked word by word: `place="ml-auto shrink-0"`. A word that
// sets a look (spacing inside, color, type, size) does not type check, nor does a computed string.
export type Place<S extends string> = S & Tokens<S, PlaceUtility>

// Placement of a layout box in its parent: as `Place`, but the only margin is `auto` (pushing it to
// one side); the space around it comes from its parent's gap.
export type LayoutPlace<S extends string> = S & Tokens<S, LayoutUtility>

type SpacingUtility =
  `${Sign}${'p' | 'px' | 'py' | 'pt' | 'pb' | 'pl' | 'pr' | 'ps' | 'pe' | Margin | 'gap' | 'gap-x' | 'gap-y' | 'space-x' | 'space-y'}-${string}`
// What a layout box decides itself: how its children line up.
type FlowUtility =
  | `items-${string}`
  | `justify-${'start' | 'center' | 'end' | 'between' | 'around' | 'evenly'}`
  | `flex-${'col' | 'row' | 'wrap' | 'nowrap'}`
  | `flex-${'col' | 'row'}-reverse`

// One word of a look: any class but spacing, an arbitrary value or one the box sets itself.
type LookWord<W extends string> = string extends W
  ? never
  : W extends `${infer V}:${infer Rest}`
    ? `${V}:${LookWord<Rest>}`
    : W extends SpacingUtility | FlowUtility | `${string}[${string}` | `${string}(--${string}`
      ? never
      : W

type LookTokens<S extends string> = string extends S
  ? never
  : S extends `${infer Head} ${infer Rest}`
    ? `${LookWord<Head>} ${LookTokens<Rest>}`
    : LookWord<S>

// The classes a screen may give a layout box besides its placement: color, type, border, size on
// the size scale, state. A padding, margin or gap, an arbitrary value (`w-[13rem]`) or a computed
// string does not type check: the space in and around a box comes only from its props.
export type Look<S extends string> = S & LookTokens<S>

const words = (s: string) => s.split(/\s+/).filter(Boolean)

const DISPLAY: readonly string[] = [
  'hidden',
  'flex',
  'inline-flex',
  'inline-block',
  'grid',
  'block',
]
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

// A text field, a select or a text area: outlined, 44 px high on a coarse pointer.
export const fieldLook =
  'min-w-0 flex-1 rounded-xl border border-outline bg-transparent px-3 py-2 text-base outline-none placeholder:text-on-surface-variant focus:border-primary md:text-sm pointer-coarse:min-h-11'

// A labelled button: pill shape, medium label, 32 px (`sm`) or 36 px (`md`) high.
export const buttonLook = (variant: ButtonVariant, size: ButtonSize) =>
  `rounded-full ${BUTTON_SIZE[size]} text-sm font-medium ${BUTTON_TONE[variant]} ${FOCUS} disabled:opacity-40 pointer-coarse:min-h-11 pointer-coarse:min-w-11`

export const BUTTON_ICON: Record<ButtonSize, number> = { sm: 16, md: 18 }

const ICON_TONE: Record<IconButtonTone, string> = {
  plain: `text-on-surface-variant ${HOVER} hover-idle:text-on-surface`,
  inherit: HOVER,
  primary: `text-primary ${HOVER}`,
  danger: `text-on-surface-variant ${HOVER} hover-idle:text-error`,
  error: `text-error ${HOVER}`,
  filled: 'bg-primary text-on-primary hover-idle:opacity-90',
  'filled-danger': 'bg-error text-on-error hover-idle:opacity-90',
  overlay: 'bg-scrim/70 text-on-scrim hover-idle:bg-scrim/85',
}

const ICON_BOX: Record<IconButtonSize, string> = {
  xs: 'size-5',
  sm: 'size-7',
  md: 'size-8',
  lg: 'size-9',
}

export const ICON_SIZE: Record<IconButtonSize, number> = { xs: 12, sm: 16, md: 18, lg: 20 }

// The box an icon button has with a mouse: what sits over the icon (a badge) is placed in it, so
// it stays by the icon when the button grows on a coarse pointer.
export const iconBoxLook = (size: IconButtonSize) =>
  `${ICON_BOX[size]} relative flex items-center justify-center`

// An icon only button: a 20 (inside a chip), 28, 32 or 36 px circle (or rounded square) with its
// icon in the middle. On a coarse pointer it grows to 44 px; the one inside a chip grows into the
// chip's margin, so the chip keeps its size. `aria-pressed` shows it on, `aria-expanded` on
// a button with a popup shows the popup open (the `pressed:` and `expanded:` variants of
// globals.css). A `tight` one in a crowded row (the composer) grows into the gaps beside it on a
// coarse pointer, so the row keeps its width.
export const iconButtonLook = (
  tone: IconButtonTone,
  size: IconButtonSize,
  shape: IconButtonShape = 'round',
  tight = false
) =>
  `${ICON_BOX[size]} shrink-0 items-center justify-center ${shape === 'round' ? 'rounded-full' : 'rounded-lg'} ${ICON_TONE[tone]} ${FOCUS} expanded:bg-on-surface/8 pressed:bg-secondary-container pressed:text-on-secondary-container disabled:opacity-40 pointer-coarse:size-11${size === 'xs' ? ' pointer-coarse:-m-3' : ''}${tight ? ' pointer-coarse:-mx-1.5' : ''}`

const ROW_TONE: Record<RowTone, string> = {
  plain: 'text-on-surface',
  muted: 'text-on-surface-variant hover-idle:text-on-surface',
  primary: 'text-primary',
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

// A banner under the header (a notice, an error, a toast).
export const bannerLook =
  'pointer-events-auto max-w-full self-center rounded-xl px-4 py-2 text-center text-sm shadow-elevation-2 sm:w-max sm:max-w-screen-inset'

// A row of the channel sidebar (a channel, a voice channel, a link): inset from the sidebar's sides.
export const sideRowLook =
  'mx-2 flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm pointer-coarse:min-h-11'

// The text field of a composer: it grows with its lines up to a height, inside the composer's
// own frame.
export const composerTextLook =
  'max-h-40 min-w-0 flex-1 resize-none bg-transparent py-(--space-xs) text-base outline-none placeholder:whitespace-nowrap placeholder:text-on-surface-variant md:text-sm'

// A button inside a line of text (with an icon before its words, if any): it reads as a link and
// keeps the line's height; on a coarse pointer it is 44 px to tap, grown into its margins.
export const linkLook = `inline-flex items-center gap-1 rounded-sm font-medium text-primary underline-offset-2 hover-idle:underline ${FOCUS} disabled:opacity-40 pointer-coarse:-my-3.5 pointer-coarse:min-w-11 pointer-coarse:justify-center pointer-coarse:py-3.5`

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
  error: 'bg-error-container text-on-error-container',
}

// A count on a small round badge.
export const badgeLook = (tone: BadgeTone) =>
  `h-4.5 min-w-4.5 shrink-0 items-center justify-center rounded-full px-1 text-2xs leading-none font-bold tabular-nums ${BADGE_TONE[tone]}`

// A short label on a pill.
export const pillLook = (tone: BadgeTone) =>
  `min-w-0 shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-2xs leading-4 font-medium ${BADGE_TONE[tone]}`

// Looks of single controls that only one screen uses. Their padding is fixed here, like every
// control's, so the screen that places them sets none.

// A field of the API console: its border color says whether its value is valid.
export const consoleFieldLook =
  'w-full min-w-0 rounded-lg border bg-transparent px-3 py-1.5 text-base outline-none placeholder:text-on-surface-variant/70 focus:border-primary md:text-sm'

// A button an app puts under its message: a pill with the color of its style.
export const appButtonLook =
  'flex min-h-11 max-w-full cursor-pointer items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-medium disabled:cursor-default disabled:opacity-40'

// An action on a note only the viewer sees.
export const noteActionLook =
  'cursor-pointer rounded-full px-3 py-1.5 text-sm font-medium text-primary hover:bg-surface-container-highest'

// A small round icon button beside a file or a code block.
export const miniIconLook =
  'shrink-0 rounded-full p-1 text-on-surface-variant hover:bg-surface-container-high hover:text-primary'

// The same, dimmed while it cannot be used.
export const miniIconOffLook =
  'shrink-0 rounded-full p-1 text-on-surface-variant hover:bg-surface-container-high hover:text-primary disabled:opacity-40'

// The pill under a forwarded message that says where it came from.
export const sourcePillLook =
  'mt-2 flex w-fit max-w-full min-w-0 items-center gap-1.5 rounded-lg border border-outline-variant/70 bg-surface-container-high px-2 py-1 text-xs text-on-surface-variant'

// A place named in that pill.
export const sourcePlaceLook =
  'streamer flex min-w-0 items-center gap-1 rounded-sm font-semibold text-on-surface'

// A quick action on Home: a wide card button.
export const homeActionLook =
  'flex min-w-0 items-center gap-3 rounded-2xl bg-surface-container-low px-4 py-3 text-left text-sm font-medium text-on-surface hover:bg-surface-container-high focus-visible:outline-2 focus-visible:outline-primary'

// The same for a peer-to-peer action: dashed.
export const homeP2pActionLook =
  'flex min-w-0 items-center gap-3 rounded-2xl border-2 border-dashed border-tertiary/70 bg-surface-container-low px-4 py-3 text-left text-sm font-medium text-on-surface hover:bg-tertiary-container hover:text-on-tertiary-container focus-visible:outline-2 focus-visible:outline-primary'

// A covered or removed embed, in place of its card.
export const embedNoteLook =
  'mt-1 flex w-fit max-w-md items-center gap-2 rounded-lg border-l-4 border-outline bg-surface-container py-2 pr-3 pl-3 text-sm'

// The quick actions floating over the top edge of a message row.
export const messageToolbarLook =
  'group/bar pointer-events-none absolute -top-5 right-3 z-raised flex items-center gap-0.5 rounded-lg border border-outline-variant bg-surface-container p-0.5 opacity-0 shadow-elevation-1 group-hover:pointer-events-auto group-hover:opacity-100 data-open:pointer-events-auto data-open:opacity-100 pointer-fine:group-focus-within:pointer-events-auto pointer-fine:group-focus-within:opacity-100'

// A reaction under a message: its emoji and count.
export const reactionChipLook =
  'flex h-7 items-center gap-1.5 rounded-lg border px-2 text-sm font-medium tabular-nums outline-offset-2 select-none focus-visible:outline-2 focus-visible:outline-primary'

// A field of the sign-in form: its border color says whether its value is valid.
export const signInFieldLook = 'rounded-lg border bg-transparent px-3 py-2 outline-none'

// Someone in a voice channel, under its row in the sidebar.
export const sideSeatLook =
  'mr-2 ml-7 flex items-center gap-2 rounded-md px-2 py-1 text-sm text-on-surface-variant -outline-offset-2'

// The mark of a member muted by a moderator, on their tile.
export const muteBadgeLook = 'rounded-full bg-mute p-0.5 text-on-mute'

// An option of a poll: a full-width row with its bar behind the text.
export const pollOptionLook =
  'relative flex min-h-10 w-full items-center gap-2 overflow-hidden rounded-xl border px-3 py-2 text-left text-sm'

// The box that stands in for a hidden secret of any size (a QR code).
export const coverBoxLook =
  'flex items-center justify-center border border-dashed border-outline-variant p-4 text-center text-sm text-on-surface-variant'

// What a preview row holds, on one line.
export const inlineRowLook = 'flex min-w-0 items-center gap-1.5'
