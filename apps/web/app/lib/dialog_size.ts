// The box of a dialog: its size, how it fits a phone, and the classes of its backdrop, panel and
// header. No imports.

// A box of CSS lengths (a number is pixels), applied from the `md` breakpoint up. The width and
// height never pass the room the backdrop leaves.
export interface DialogBox {
  width?: string | number
  maxWidth?: string | number
  height?: string | number
  maxHeight?: string | number
}

// `sm`, `md`, `lg` and `xl` are cards of growing width. `settings` and `full` are large boxes
// on wide screens, as is a `DialogBox`; all three fill the screen on phones.
export type DialogSize = 'sm' | 'md' | 'lg' | 'xl' | 'settings' | 'full' | DialogBox

// `bare` leaves the header, padding and scrolling to the content, for split panes.
export type DialogChrome = 'default' | 'bare'

export interface DialogFit {
  size?: DialogSize
  // Fills the screen on phones and is a card from `sm` up.
  full?: boolean
  // The small card of a short choice; it sits above other dialogs.
  compact?: boolean
  chrome?: DialogChrome
  // Sits above other dialogs and full pages.
  raised?: boolean
  // Blurs what is behind the backdrop.
  blur?: boolean
}

export interface DialogLayout {
  backdrop: string
  // A layer under the backdrop that blurs the app behind it. It sits beside the backdrop, not
  // around it, so dialogs inside this one still place themselves against the screen.
  blur?: string
  panel: string
  header: string
  // The column the children of a large box with the default chrome sit in.
  body?: string
  style?: Record<string, string>
}

type Card = 'sm' | 'md' | 'lg' | 'xl'

// Each card's box on every screen, and from `sm` up for a dialog that fills phones.
const CARDS: Record<Card, [string, string]> = {
  sm: ['max-h-full max-w-sm rounded-3xl', 'sm:max-h-full sm:max-w-sm sm:rounded-3xl'],
  md: [
    'max-h-[min(85vh,100%)] max-w-lg rounded-2xl',
    'sm:max-h-[min(85vh,100%)] sm:max-w-lg sm:rounded-2xl',
  ],
  lg: [
    'max-h-[min(85vh,100%)] max-w-2xl rounded-2xl',
    'sm:max-h-[min(85vh,100%)] sm:max-w-2xl sm:rounded-2xl',
  ],
  xl: [
    'max-h-[min(85vh,100%)] max-w-4xl rounded-2xl',
    'sm:max-h-[min(85vh,100%)] sm:max-w-4xl sm:rounded-2xl',
  ],
}

const LARGE = {
  settings: 'md:h-[min(88dvh,820px)] md:max-h-full md:w-[min(94vw,1120px)] md:max-w-full',
  full: 'md:h-[min(92dvh,960px)] md:max-h-full md:w-[min(96vw,1400px)] md:max-w-full',
  box: 'md:h-(--dialog-h) md:max-h-(--dialog-max-h) md:w-(--dialog-w) md:max-w-(--dialog-max-w)',
}

const isCard = (size: DialogSize): size is Card =>
  size === 'sm' || size === 'md' || size === 'lg' || size === 'xl'

// Whether a size is a large box: it fills phones, and its backdrop blurs while motion plays.
export const largeDialog = (size: DialogSize | undefined) => size !== undefined && !isCard(size)

const length = (value: string | number) => (typeof value === 'number' ? `${value}px` : value)

// The CSS variables of a custom box.
export const boxVars = ({ width, maxWidth, height, maxHeight }: DialogBox) => ({
  '--dialog-w': length(width ?? '100%'),
  '--dialog-max-w': `min(${length(maxWidth ?? '100%')}, 100%)`,
  '--dialog-h': length(height ?? 'auto'),
  '--dialog-max-h': `min(${length(maxHeight ?? '100%')}, 100%)`,
})

// Whether the backdrop blurs: large boxes do unless asked not to, others only when asked, and
// none while motion is still.
export const dialogBlurs = (
  size: DialogSize | undefined,
  asked: boolean | undefined,
  motionPlays: boolean
) => motionPlays && (asked ?? largeDialog(size))

const STICKY = 'sticky -top-6 z-raised -mx-6 -mt-6 mb-4 bg-surface-container-high px-6 py-4'
const FILL_PAD = 'pb-[max(1.5rem,env(safe-area-inset-bottom))]'

export const dialogLayout = ({
  size,
  full = false,
  compact = false,
  chrome = 'default',
  raised = false,
  blur = false,
}: DialogFit): DialogLayout => {
  const asked = size ?? (compact ? 'sm' : 'md')
  const bare = chrome === 'bare'
  const z = raised || compact ? 'z-top' : 'z-page'
  const base = `fixed inset-x-0 top-app ${z} flex h-app items-center justify-center bg-scrim/60`
  const veil = (at: string) =>
    blur ? { blur: `pointer-events-none fixed inset-x-0 top-app ${z} h-app ${at}` } : {}
  const skin = bare
    ? 'flex w-full flex-col overflow-hidden bg-surface text-on-surface shadow-elevation-3 outline-none'
    : 'w-full overflow-y-auto bg-surface-container-high p-6 shadow-elevation-3 outline-none'
  if (isCard(asked) && !full)
    return {
      backdrop: `${base} safe-x-4 py-4`,
      ...veil('backdrop-blur-[6px]'),
      panel: `${skin} ${CARDS[asked][0]}`,
      header: 'flex items-center justify-between mb-4',
    }
  if (isCard(asked))
    return {
      backdrop: `${base} safe-x sm:safe-x-4 sm:py-4`,
      ...veil('sm:backdrop-blur-[6px]'),
      panel: `${skin} h-full max-h-none ${bare ? 'sm:h-auto' : `${FILL_PAD} sm:h-auto sm:pb-6`} ${CARDS[asked][1]}`,
      header: `flex items-center justify-between ${STICKY}`,
    }
  const box = typeof asked === 'object' ? asked : null
  return {
    backdrop: `${base} ${bare ? '' : 'safe-x '}md:safe-x-4 md:py-4`,
    ...veil('md:backdrop-blur-[6px]'),
    panel: `${skin} h-full max-h-none ${bare ? 'safe-x md:px-0' : `${FILL_PAD} md:pb-6`} md:rounded-2xl md:border md:border-outline-variant/60 ${
      box ? LARGE.box : LARGE[asked as 'settings' | 'full']
    }`,
    header: `flex items-center justify-between ${STICKY} border-b border-outline-variant`,
    ...(bare ? {} : { body: 'mx-auto w-full max-w-3xl' }),
    ...(box ? { style: boxVars(box) } : {}),
  }
}
