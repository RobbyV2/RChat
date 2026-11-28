// The looks of the shared controls: buttons, icon buttons, list rows, section headings, badges and
// pills, each built from a fixed set of choices. The components in `components/controls.tsx` take
// these choices as props. A call site places a control in its parent with `Place` classes only
// (position, `auto` margins, flex and grid item sizing, display and reveal), never with spacing, color or
// type, so every control of a kind looks the same. On a coarse pointer every control is at least
// 44 px high (and an icon button 44 px wide); with a mouse it keeps its size.

export type ButtonVariant =
  'filled' | 'tonal' | 'text' | 'danger' | 'filled-danger' | 'accept' | 'inverse' | 'inherit'
export type ButtonSize = 'sm' | 'md'
export type IconButtonTone =
  | 'plain'
  | 'inherit'
  | 'primary'
  | 'danger'
  | 'error'
  | 'tonal'
  | 'raised'
  | 'banner'
  | 'filled'
  | 'filled-danger'
  | 'overlay'
export type IconButtonSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl'
export type IconButtonShape = 'round' | 'square'
export type RowTone = 'plain' | 'muted' | 'primary' | 'danger'
export type RowVariant = 'plain' | 'card' | 'menu' | 'menu-touch'
export type LinkTone = 'primary' | 'error' | 'muted' | 'strong' | 'inherit'
export type ChipVariant = 'pill' | 'reaction'
export type TileTone =
  | 'idle'
  | 'active'
  | 'add'
  | 'preview'
  | 'folder'
  | 'folder-open'
  | 'p2p'
  | 'p2p-active'
  | 'p2p-server'
  | 'p2p-server-active'
  | 'p2p-folder'
  | 'p2p-folder-open'
export type SideRowTone = 'plain' | 'strong' | 'primary' | 'heading' | 'section'
export type CallTone = 'idle' | 'on' | 'off' | 'danger' | 'accept' | 'quiet'
export type CallSize = 'sm' | 'md' | 'lg' | 'bar' | 'wide'
export type CardTone = 'plain' | 'low' | 'base' | 'outlined' | 'p2p'
export type CardPad = 'none' | 'sm' | 'md' | 'lg'
export type MediaShape = 'card' | 'round' | 'inherit'
export type WindowButtonKind = 'bar' | 'bar-close' | 'dot'
export type AppButtonStyle = 'plain' | 'primary' | 'danger'
export type TriTone = 'allow' | 'deny' | 'neutral'
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

// The focus ring without its color, for a control that sets the ring's color itself.
const FOCUS_BARE = 'outline-offset-2 focus-visible:outline-2'
const FOCUS = `${FOCUS_BARE} focus-visible:outline-primary`
const HOVER = 'hover-idle:bg-on-surface/8'
// The state layer on a colored surface (a banner): a tint of the text color it inherits.
const HOVER_OWN = 'hover-idle:bg-current/10'
// What a control that is on shows, whichever ARIA attribute says so.
const ON =
  'pressed:bg-secondary-container pressed:text-on-secondary-container current:bg-secondary-container current:text-on-secondary-container selected:bg-secondary-container selected:text-on-secondary-container'
// The chosen one of a few icon buttons that are radio items.
const CHECKED = 'checked:bg-secondary-container checked:text-on-secondary-container'
// A control that stays focusable while it cannot be used (`aria-disabled`) is dimmed like a
// disabled one.
const OFF = 'disabled:opacity-40 soft-off:cursor-not-allowed soft-off:opacity-40'

const BUTTON_TONE: Record<ButtonVariant, string> = {
  filled: 'bg-primary text-on-primary hover-idle:opacity-90',
  tonal: 'bg-secondary-container text-on-secondary-container hover-idle:opacity-90',
  text: `text-primary ${HOVER}`,
  danger: `text-error ${HOVER}`,
  'filled-danger': 'bg-error text-on-error hover-idle:opacity-90',
  accept: 'bg-status-green text-surface hover-idle:brightness-110',
  inverse: 'bg-inverse-surface text-inverse-on-surface hover-idle:opacity-90',
  inherit: HOVER_OWN,
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
  tonal:
    'bg-surface-container-high text-on-surface-variant hover-idle:bg-surface-container-highest hover-idle:text-on-surface',
  raised:
    'bg-surface-container-highest text-on-surface shadow-elevation-2 hover-idle:bg-surface-bright',
  // On a server's banner: a chip of the color the header sets in `--gear-chip`.
  banner:
    'bg-gear-chip text-on-surface shadow-elevation-1 hover-idle:bg-surface-container-highest focus-visible:outline-hdr-gear',
  filled: 'bg-primary text-on-primary hover-idle:opacity-90',
  'filled-danger': 'bg-error text-on-error hover-idle:opacity-90',
  overlay: 'bg-scrim/70 text-on-scrim hover-idle:bg-scrim/85',
}

const ICON_BOX: Record<IconButtonSize, string> = {
  xs: 'size-5',
  sm: 'size-7',
  md: 'size-8',
  lg: 'size-9',
  xl: 'size-11',
}

export const ICON_SIZE: Record<IconButtonSize, number> = { xs: 12, sm: 16, md: 18, lg: 20, xl: 24 }

// The type step of an emoji shown in place of the icon.
export const GLYPH_TEXT: Record<IconButtonSize, string> = {
  xs: 'font-emoji text-xs leading-none',
  sm: 'font-emoji text-sm leading-none',
  md: 'font-emoji text-base leading-none',
  lg: 'font-emoji text-xl leading-none',
  xl: 'font-emoji text-2xl leading-none',
}

// The box an icon button has with a mouse: what sits over the icon (a badge) is placed in it, so
// it stays by the icon when the button grows on a coarse pointer.
export const iconBoxLook = (size: IconButtonSize) =>
  `${ICON_BOX[size]} relative flex items-center justify-center`

// An icon only button: a 20 (inside a chip), 28, 32, 36 or 44 px circle (or rounded square) with its
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
  `${ICON_BOX[size]} shrink-0 items-center justify-center ${shape === 'round' ? 'rounded-full' : 'rounded-lg'} ${ICON_TONE[tone]} ${tone === 'banner' ? FOCUS_BARE : FOCUS} expanded:bg-on-surface/8 ${ON} ${CHECKED} ${OFF} pointer-coarse:size-11${size === 'xs' ? ' pointer-coarse:-m-3' : ''}${tight ? ' pointer-coarse:-mx-1.5' : ''}`

const ROW_TONE: Record<RowTone, string> = {
  plain: 'text-on-surface',
  muted: 'text-on-surface-variant hover-idle:text-on-surface',
  primary: 'text-primary',
  danger: 'text-error',
}

const ROW_VARIANT: Record<RowVariant, string> = {
  plain: `gap-3 rounded-lg px-3 py-2 text-sm ${HOVER} pointer-coarse:min-h-11`,
  card: 'min-h-11 gap-3 rounded-xl bg-surface-container px-3 py-2 text-sm hover-idle:bg-surface-container-highest',
  menu: `gap-3 px-4 py-2 text-sm ${HOVER} focus-visible:bg-on-surface/8 expanded:bg-on-surface/8`,
  'menu-touch': 'min-h-13 gap-3 px-6 py-3 text-base active:bg-on-surface/8',
}

// A row of a list or menu: leading icon, label, trailing slot. A `card` row sits on its own
// surface and is 44 px high with any pointer; a `menu` row is an item of a menu (`menu-touch`: of
// a menu shown as a sheet). `aria-current`, `aria-selected` or `aria-pressed` marks the open one.
export const rowLook = (tone: RowTone, variant: RowVariant = 'plain') =>
  `w-full min-w-0 items-center text-left ${ROW_TONE[tone]} ${ROW_VARIANT[variant]} ${FOCUS} ${ON} ${OFF}`

// A banner under the header (a notice, an error, a toast).
export const bannerLook =
  'pointer-events-auto max-w-full self-center rounded-xl px-4 py-2 text-center text-sm shadow-elevation-2 sm:w-max sm:max-w-screen-inset'

// A row of the channel sidebar (a channel, a voice channel, a link): inset from the sidebar's sides.
const sideRowLook =
  'mx-2 flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm pointer-coarse:min-h-11'

// The text field of a composer: it grows with its lines up to a height, inside the composer's
// own frame.
export const composerTextLook =
  'max-h-40 min-w-0 flex-1 resize-none bg-transparent py-(--space-xs) text-base outline-none placeholder:whitespace-nowrap placeholder:text-on-surface-variant md:text-sm'

// A button inside a line of text (with an icon before its words, if any): it reads as a link and
// keeps the line's height; on a coarse pointer it is 44 px to tap, grown into its margins.
const LINK_TONE: Record<LinkTone, string> = {
  primary: 'font-medium text-primary',
  error: 'font-medium text-error',
  muted: 'text-on-surface-variant hover-idle:text-on-surface',
  strong: 'font-semibold text-on-surface',
  inherit: 'font-medium',
}

export const linkLook = (tone: LinkTone = 'primary', underlined = false) =>
  `max-w-full min-w-0 items-center gap-1 rounded-sm text-left ${LINK_TONE[tone]} underline-offset-2 ${underlined ? 'underline' : 'hover-idle:underline'} ${FOCUS} disabled:opacity-40 pointer-coarse:-my-3.5 pointer-coarse:min-w-11 pointer-coarse:py-3.5`

// One choice of a few, as a chip: the chosen one is filled.
export const chipLook = (on: boolean, variant: ChipVariant = 'pill') =>
  variant === 'reaction'
    ? `h-7 max-w-full min-w-0 items-center justify-center gap-1.5 rounded-lg border px-2 text-sm font-medium tabular-nums select-none ${FOCUS} ${OFF} pointer-coarse:h-11 pointer-coarse:min-w-11 ${
        on
          ? 'border-primary bg-primary/15 text-primary'
          : 'border-transparent bg-surface-container-high text-on-surface-variant hover-idle:border-outline-variant hover-idle:text-on-surface'
      }`
    : `max-w-full min-w-0 items-center justify-center gap-1.5 rounded-full border px-3 py-1.5 text-sm ${FOCUS} disabled:opacity-50 pointer-coarse:min-h-11 pointer-coarse:min-w-11 ${
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

// The pill under a forwarded message that says where it came from.
export const sourcePillLook =
  'mt-2 flex w-fit max-w-full min-w-0 items-center gap-1.5 rounded-lg border border-outline-variant/70 bg-surface-container-high px-2 py-1 text-xs text-on-surface-variant'

// A place named in that pill.
export const sourcePlaceLook =
  'flex min-w-0 items-center gap-1 rounded-sm font-semibold text-on-surface'

// A covered or removed embed, in place of its card.
export const embedNoteLook =
  'mt-1 flex w-fit max-w-md items-center gap-2 rounded-lg border-l-4 border-outline bg-surface-container py-2 pr-3 pl-3 text-sm'

// The quick actions floating over the top edge of a message row.
export const messageToolbarLook =
  'group/bar pointer-events-none absolute -top-5 right-3 z-raised flex items-center gap-0.5 rounded-lg border border-outline-variant bg-surface-container p-0.5 opacity-0 shadow-elevation-1 group-hover:pointer-events-auto group-hover:opacity-100 data-open:pointer-events-auto data-open:opacity-100 pointer-fine:group-focus-within:pointer-events-auto pointer-fine:group-focus-within:opacity-100'

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

// Shared controls with a look of their own.

const TILE_TONE: Record<TileTone, string> = {
  idle: 'bg-surface-container-high text-on-surface hover-idle:bg-primary-container hover-idle:text-on-primary-container',
  active: 'bg-primary text-on-primary',
  add: 'bg-primary-container text-on-primary-container shadow-elevation-1 hover-idle:bg-primary hover-idle:text-on-primary',
  preview: 'border-2 border-dashed border-primary bg-surface-container-high text-on-surface',
  folder: 'folder-tile',
  'folder-open': 'folder-icon',
  p2p: 'bg-surface-container-high text-tertiary hover-idle:bg-tertiary-container hover-idle:text-on-tertiary-container',
  'p2p-active': 'bg-tertiary text-on-tertiary',
  'p2p-server':
    'border-2 border-dashed border-tertiary bg-surface-container-high text-on-surface hover-idle:bg-primary-container hover-idle:text-on-primary-container',
  'p2p-server-active': 'border-2 border-dashed border-on-primary bg-primary text-on-primary',
  'p2p-folder': 'folder-tile border-2 border-dashed border-tertiary',
  'p2p-folder-open': 'folder-icon-p2p',
}

// A tile of the rail: a 48 px rounded square holding a glyph, an avatar or an icon, with its
// badges on its corners.
export const tileLook = (tone: TileTone) =>
  `relative size-12 shrink-0 items-center justify-center rounded-2xl text-lg font-semibold transition-colors ${TILE_TONE[tone]} ${FOCUS}`

// A small toggle of the rail that folds a group of tiles: a chip (`chip`) or whatever it holds
// (an avatar).
export const railToggleLook = (chip: boolean) =>
  `relative shrink-0 items-center justify-center ${chip ? 'h-5 w-10 rounded bg-surface-container-high text-xs pointer-coarse:h-11 pointer-coarse:w-11' : 'rounded-full'} ${FOCUS}`

const SIDE_TONE: Record<SideRowTone, string> = {
  plain: 'text-on-surface-variant',
  strong: 'font-semibold text-on-surface',
  primary: 'font-medium text-primary',
  heading: 'text-xs text-on-surface-variant hover-idle:text-on-surface',
  section: 'text-sm',
}

// A row of the channel sidebar one can press: the open one is filled, a `dim` one (muted) fades.
// A `heading` (of a category) or a `section` (of the conversations) folds the rows under it.
export const sideRowButtonLook = (tone: SideRowTone, dim = false) =>
  tone === 'heading' || tone === 'section'
    ? `min-w-0 flex-1 items-center gap-1 rounded-md px-2 py-1.5 text-left font-medium ${SIDE_TONE[tone]} -outline-offset-2 focus-visible:outline-2 focus-visible:outline-primary pointer-coarse:min-h-11`
    : `${sideRowLook} shrink-0 text-left ${SIDE_TONE[tone]} -outline-offset-2 transition-colors hover-idle:bg-surface-container hover-idle:text-on-surface focus-visible:outline-2 focus-visible:outline-primary ${ON} ${dim ? 'opacity-60' : ''}`

const CALL_TONE: Record<CallTone, string> = {
  idle: 'bg-surface-container-highest text-on-surface hover-idle:bg-surface-bright',
  on: 'bg-on-surface text-surface hover-idle:bg-on-surface/85',
  off: 'bg-mute text-on-mute hover-idle:bg-mute-hover',
  danger: 'bg-danger text-on-danger hover-idle:brightness-110',
  accept: 'bg-status-green text-surface hover-idle:brightness-110',
  quiet: 'text-on-surface-variant hover-idle:bg-error/15 hover-idle:text-error',
}

const CALL_SIZE: Record<CallSize, string> = {
  sm: 'size-8 pointer-coarse:size-11',
  md: 'size-9 pointer-coarse:size-11',
  lg: 'size-11 sm:size-12',
  bar: 'h-8 flex-1 pointer-coarse:h-11',
  wide: 'h-11 w-16 sm:h-12 sm:w-18',
}

export const CALL_ICON: Record<CallSize, number> = { sm: 18, md: 16, lg: 20, bar: 16, wide: 20 }

// A round control of a call: mute, camera, share, leave, accept, decline.
export const callButtonLook = (tone: CallTone, size: CallSize) =>
  `shrink-0 items-center justify-center rounded-full transition-colors ${CALL_SIZE[size]} ${CALL_TONE[tone]} ${FOCUS} disabled:cursor-not-allowed disabled:opacity-60`

const CARD_TONE: Record<CardTone, string> = {
  plain: HOVER,
  low: 'bg-surface-container-low hover-idle:bg-surface-container-high',
  base: 'bg-surface-container hover-idle:bg-surface-container-highest',
  outlined: `border border-outline-variant ${HOVER} pressed:border-primary`,
  p2p: 'border-2 border-dashed border-tertiary/70 bg-surface-container-low hover-idle:bg-tertiary-container hover-idle:text-on-tertiary-container',
}

const CARD_PAD: Record<CardPad, string> = {
  none: 'gap-3',
  sm: 'gap-2 p-2',
  md: 'gap-3 p-3',
  lg: 'gap-3 px-4 py-3',
}

// A card one can press: what it holds side by side (or one under the other, centered, when
// `column`), on a surface of its tone. `aria-pressed` and `aria-current` show it chosen.
export const cardButtonLook = (tone: CardTone, pad: CardPad, column: boolean) =>
  `min-w-0 rounded-xl text-sm text-on-surface ${column ? 'flex-col items-center text-center' : 'items-center text-left'} ${CARD_PAD[pad]} ${CARD_TONE[tone]} ${FOCUS} ${ON} disabled:opacity-40 pointer-coarse:min-h-11`

const MEDIA_SHAPE: Record<MediaShape, string> = {
  card: 'overflow-hidden rounded-xl',
  round: 'rounded-full',
  inherit: 'rounded-inherit',
}

// A picture one can press (an image that opens, a covered image, an avatar): the picture is the
// button, which adds only its focus ring.
export const mediaButtonLook = (shape: MediaShape, zoom: boolean) =>
  `relative w-fit max-w-full ${MEDIA_SHAPE[shape]} ${zoom ? 'cursor-zoom-in' : 'cursor-pointer'} ${FOCUS}`

// A button with nothing to show that covers its positioned parent: pressing the parent anywhere
// presses it. A `tint` one shades the parent under the mouse.
export const hotspotLook = (tint: boolean) =>
  `absolute inset-0 cursor-pointer rounded-inherit -outline-offset-2 focus-visible:outline-2 focus-visible:outline-primary ${tint ? 'transition-colors hover-idle:bg-on-surface/5' : ''}`

// A color one can pick: a 32 px circle of that color, ringed when it is the chosen one.
export const swatchLook =
  'size-8 items-center justify-center rounded-full border border-outline-variant outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-surface-container-high pressed:ring-2 pressed:ring-primary pressed:ring-offset-2 pressed:ring-offset-surface-container-high pointer-coarse:size-11'

// A switch with its label (and a hint under it) as one row to press.
export const switchRowLook = `w-full min-w-0 items-center justify-between gap-3 rounded-lg px-3 py-2 text-left text-sm ${HOVER} ${FOCUS} disabled:opacity-50 pointer-coarse:min-h-11`
export const switchTrackLook =
  'h-6 w-10 shrink-0 items-center rounded-full border border-outline bg-surface-container-highest p-0.5 transition-colors group-checked/switch:justify-end group-checked/switch:border-transparent group-checked/switch:bg-primary'
export const switchThumbLook =
  'size-4.5 items-center justify-center rounded-full bg-outline text-primary group-checked/switch:bg-on-primary'

// The box one ticks to select a row: it fills the row's leading edge, so the whole edge ticks it.
export const tickLook = 'group/tick shrink-0 items-start p-3 outline-none'
export const tickBoxLook =
  'size-5 items-center justify-center rounded-md border-2 border-outline bg-surface group-hover/tick:border-primary group-focus-visible/tick:outline-2 group-focus-visible/tick:outline-primary group-checked/tick:border-primary group-checked/tick:bg-primary group-checked/tick:text-on-primary'

const WINDOW_KIND: Record<WindowButtonKind, string> = {
  bar: 'h-full w-11.5 text-on-surface hover:bg-on-surface/10 active:bg-on-surface/20',
  'bar-close':
    'h-full w-11.5 text-on-surface hover:bg-window-close hover:text-on-window-close active:bg-window-close/80 active:text-on-window-close',
  dot: 'size-6 rounded-full bg-on-surface/10 text-on-surface hover:bg-on-surface/20 active:bg-on-surface/30',
}

// A button of the window's title bar (minimize, maximize, close).
export const windowButtonLook = (kind: WindowButtonKind) =>
  `items-center justify-center -outline-offset-2 focus-visible:outline-2 focus-visible:outline-primary ${WINDOW_KIND[kind]}`

// An emoji of the picker's grid: it fills its cell; the one the keys are on is ringed.
export const emojiCellLook = (touch: boolean) =>
  `aspect-square scroll-mt-9 scroll-mb-1 items-center justify-center rounded-xl font-emoji leading-none select-none ${touch ? 'text-3xl active:bg-surface-container-highest' : 'text-2xl'} selected:bg-secondary-container selected:ring-2 selected:ring-primary selected:ring-inset hover-idle:bg-surface-container-highest`

const APP_STYLE: Record<AppButtonStyle, string> = {
  plain: 'border border-outline text-on-surface hover-idle:bg-surface-container-highest',
  primary: 'bg-primary text-on-primary hover-idle:opacity-90',
  danger: 'bg-error text-on-error hover-idle:opacity-90',
}

// A button an app puts under its message, in the color of its style; `wide` is the closed face of
// a select menu.
export const appButtonStyleLook = (style: AppButtonStyle, wide: boolean) =>
  `min-h-11 max-w-full cursor-pointer items-center gap-1.5 px-3 py-1.5 text-sm font-medium ${wide ? 'w-full justify-between rounded-xl' : 'rounded-full'} ${APP_STYLE[style]} ${FOCUS} pressed:border pressed:border-transparent pressed:bg-secondary-container pressed:text-on-secondary-container disabled:cursor-default disabled:opacity-40`

const TRI_TONE: Record<TriTone, string> = {
  allow: 'pressed:bg-primary pressed:text-on-primary',
  deny: 'pressed:bg-error pressed:text-on-error',
  neutral: 'pressed:bg-surface-container-highest pressed:text-on-surface',
}

// One of the three states of a permission (allow, inherit, deny), side by side in one frame.
export const triLook = (tone: TriTone) =>
  `h-8 w-9 items-center justify-center text-on-surface-variant hover-idle:bg-on-surface/8 ${TRI_TONE[tone]} -outline-offset-2 focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-40 pointer-coarse:size-11`

// An option of a poll one can vote for: `pollOptionLook`, its border darker under the mouse and
// primary when it is the vote.
export const pollChoiceLook = `${pollOptionLook} border-outline-variant hover-idle:border-outline pressed:border-primary ${FOCUS}`
