'use client'

import {
  createContext,
  Fragment,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type HTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type Ref,
  type RefObject,
  type SyntheticEvent,
} from 'react'
import { X, type LucideIcon } from 'lucide-react'
import { client } from '../lib/client/client'
import { useAccount } from '../lib/client/react'
import type { AccountSession } from '../lib/client/session'
import type { RChatState } from '../lib/store_types'
import { layerCovered, type EscapeLayer } from '../lib/escape_layers'
import { dialogBlurs, dialogLayout, type DialogChrome, type DialogSize } from '../lib/dialog_size'
import { useMotionPlays } from '../lib/motion/use_motion'
import { maskOutsideCode, maskRuns } from '../lib/profanity'
import { useMask, useStore } from '../lib/store'
import { useChat } from '../lib/place/use_chat'
import { useLive } from '../lib/place/react'
import { REVEAL_EVENT } from '../lib/masked_reveal'
import { ThemeToggle } from './status_clock'
import { Chip, IconButton } from './controls'
import { fieldLook, sectionHeadingLook } from '../lib/controls'

export const fieldCls = fieldLook
// A small field or select beside others on a toolbar line (a search filter).
export const smallFieldCls =
  'rounded-lg border border-outline bg-transparent px-2 py-1 text-base outline-none placeholder:text-on-surface-variant focus:border-primary md:text-xs'
// The square a color is picked from.
export const colorSwatchCls =
  'h-9 w-9 shrink-0 cursor-pointer rounded-lg border border-outline bg-transparent p-0.5 disabled:cursor-not-allowed disabled:opacity-60'
// The field a name is edited in where it stands (a channel in the sidebar).
export const renameFieldCls =
  'rounded-lg border border-primary bg-transparent px-2 py-1.5 text-base outline-none md:text-sm'
// A text field inside a box that draws the field (a search box, a composer): no border or sides of
// its own.
export const bareFieldCls =
  'min-w-0 flex-1 bg-transparent py-1.5 text-base outline-none placeholder:text-on-surface-variant md:text-sm'
// A value set off inside a line of text (a time, a code): it breaks across lines with the text.
export const inlineChipCls =
  'rounded box-decoration-clone bg-surface-container-high px-1 py-0.5 text-on-surface'
export const sectionCls = sectionHeadingLook

// One choice of a few, as chips.
export function Chips<T extends string | number>({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string
  value: T
  options: readonly { value: T; label: string }[]
  onChange: (v: T) => void
  disabled?: boolean
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-1.5">
      {options.map(o => (
        <Chip
          key={String(o.value)}
          radio
          on={value === o.value}
          disabled={disabled}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </Chip>
      ))}
    </div>
  )
}

export function FieldError({ message, id }: { message: string | null; id?: string }) {
  if (!message) return null
  return (
    <p id={id} role="alert" className="pt-1.5 text-xs text-error">
      {message}
    </p>
  )
}

// Each handler sees the store as it was at keydown. So a handler that runs after another closed
// its layer still knows that the layer was covered.
const pressed = new WeakMap<Event, { owner: AccountSession; state: RChatState }>()

const covered = (layer: EscapeLayer, e: Event, account: AccountSession) => {
  let snapshot = pressed.get(e)
  if (!snapshot) {
    const owner = client.overlayOwner() ?? account
    snapshot = { owner, state: owner.store.getState() }
    pressed.set(e, snapshot)
  }
  return (
    snapshot.owner !== account ||
    layerCovered(
      layer,
      snapshot.state,
      () => document.querySelector('[aria-modal="true"]') !== null
    )
  )
}

export function useEscape(onEscape: (e: KeyboardEvent) => void, layer: EscapeLayer = 'dialog') {
  const account = useAccount()
  const ref = useRef(onEscape)
  useEffect(() => {
    ref.current = onEscape
  })
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.isComposing && !covered(layer, e, account)) ref.current(e)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [layer, account])
}

export function useBackdrop(onClose: () => void) {
  const pressed = useRef(false)
  return {
    onMouseDown: (e: React.MouseEvent) => {
      pressed.current = e.target === e.currentTarget
    },
    onClick: (e: React.MouseEvent) => {
      const hit = pressed.current && e.target === e.currentTarget
      pressed.current = false
      if (hit) onClose()
    },
  }
}

export function Sentinel({
  onVisible,
  onHidden,
}: {
  onVisible: () => void
  onHidden?: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const observer = new IntersectionObserver(entries => {
      if (entries.some(e => e.isIntersecting)) onVisible()
      if (!entries[entries.length - 1]?.isIntersecting) onHidden?.()
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [onVisible, onHidden])
  return <div ref={ref} className="h-px" />
}

export function CloseButton({
  onClick,
  compact = false,
}: {
  onClick: () => void
  compact?: boolean
}) {
  return <IconButton icon={X} label="Close" size={compact ? 'sm' : 'md'} onClick={onClick} />
}

export type OverlayLayer = 'page' | 'top' | 'palette'
export type Backdrop = 'dim' | 'clear' | 'none'
export type SheetHeight = 'fit' | 'list' | 'half' | 'tall'
export type SheetSurface = 'low' | 'base' | 'high'

const OVERLAY_Z: Record<OverlayLayer, string> = {
  page: 'z-page',
  top: 'z-top',
  palette: 'z-palette',
}

const SHEET_HEIGHT: Record<SheetHeight, string> = {
  fit: 'max-h-[85%]',
  list: 'min-h-64 max-h-[85%]',
  half: 'h-[60%] min-h-80',
  tall: 'h-[85%]',
}

const SURFACE: Record<SheetSurface, string> = {
  low: 'bg-surface-container-low',
  base: 'bg-surface-container',
  high: 'bg-surface-container-high',
}

type DivAttrs = Omit<HTMLAttributes<HTMLDivElement>, 'className' | 'role'> & {
  [data: `data-${string}`]: string | number | undefined
}

// A layer over the app's area (under the title bar and status bar, above the on-screen keyboard) on
// `layer`. A `dim` backdrop lays a scrim over it and a `clear` one only takes presses; a click on
// the backdrop calls `onClose`. Only what the layer holds and its backdrop take presses.
export function Overlay({
  layer = 'top',
  backdrop = 'dim',
  onClose,
  ref,
  children,
  ...rest
}: DivAttrs & {
  layer?: OverlayLayer
  backdrop?: Backdrop
  onClose: () => void
  ref?: Ref<HTMLDivElement>
  children: ReactNode
}) {
  return (
    <div
      {...rest}
      ref={ref}
      className={`pointer-events-none fixed inset-x-0 top-app h-app *:pointer-events-auto ${OVERLAY_Z[layer]}`}
    >
      {backdrop !== 'none' && (
        <div
          data-backdrop
          aria-hidden
          onClick={onClose}
          className={`absolute inset-0${backdrop === 'dim' ? ' bg-scrim/40' : ''}`}
        />
      )}
      {children}
    </div>
  )
}

// A panel on an `Overlay`. As a `sheet` (on a phone) it rises from the bottom of the app over a dim
// backdrop, under a grip (`gripProps` makes it a drag handle): `fit` is as high as what it holds
// (85% at most), `list` too but at least 16rem (a list that loads), `half` 60% and `tall` 85% of
// the app. Otherwise it floats where `float.at` places it in
// the app's area, over `float.backdrop`. A `scroll` panel scrolls itself; one that is not
// `selectable` keeps a long press from selecting its text. It is a modal dialog (or a `menu`); a
// dialog floating with no backdrop is not modal. What it holds keeps its state when it turns from
// a sheet to a floating panel. `overlay` takes the handlers of the layer under it.
export function Sheet({
  sheet = true,
  float,
  layer,
  height = 'fit',
  surface = 'high',
  grip = true,
  scroll = false,
  selectable = true,
  role = 'dialog',
  onClose,
  overlay,
  gripProps,
  ref,
  children,
  ...rest
}: DivAttrs & {
  sheet?: boolean
  float?: { at: string; backdrop: Backdrop }
  layer?: OverlayLayer
  height?: SheetHeight
  surface?: SheetSurface
  grip?: boolean
  scroll?: boolean
  selectable?: boolean
  role?: 'dialog' | 'menu'
  onClose: () => void
  overlay?: DivAttrs
  gripProps?: DivAttrs
  ref?: Ref<HTMLDivElement>
  children: ReactNode
}) {
  const backdrop = sheet ? 'dim' : (float?.backdrop ?? 'dim')
  const look = sheet
    ? `absolute inset-x-0 bottom-0 ${SHEET_HEIGHT[height]} animate-sheet-up rounded-t-3xl safe-x pb-[max(var(--space-md),env(safe-area-inset-bottom))]`
    : `absolute ${float?.at ?? 'inset-0 m-auto h-fit max-h-[85%] w-[min(28rem,calc(100%-2rem))]'} rounded-2xl border border-outline-variant`
  return (
    <Overlay {...overlay} layer={layer} backdrop={backdrop} onClose={onClose}>
      <div
        {...rest}
        ref={ref}
        role={role}
        data-sheet={sheet ? '' : undefined}
        aria-modal={role === 'dialog' && backdrop !== 'none' ? 'true' : undefined}
        className={`${look} flex flex-col ${SURFACE[surface]} shadow-elevation-3 outline-none ${
          scroll ? 'overflow-y-auto overscroll-contain' : 'overflow-hidden'
        }${selectable ? '' : ' select-none'}`}
      >
        {sheet && grip && (
          <div
            {...gripProps}
            className={`flex shrink-0 justify-center pt-3 pb-2${gripProps ? ' touch-none' : ''}`}
          >
            <div aria-hidden className="h-1 w-8 rounded-full bg-outline-variant" />
          </div>
        )}
        {children}
      </div>
    </Overlay>
  )
}

// The header of a side panel (thread, search).
export function PanelHeader({
  icon: Icon,
  title,
  closeTitle,
  actor,
  onClose,
}: {
  icon: LucideIcon
  title: string
  closeTitle: string
  actor?: ReactNode
  onClose: () => void
}) {
  return (
    <header className="flex h-14 shrink-0 items-center gap-2 border-b border-outline-variant px-4">
      <Icon size={18} className="shrink-0 text-on-surface-variant" />
      <span className="min-w-0 truncate font-medium">{title}</span>
      {actor}
      <IconButton icon={X} label={closeTitle} onClick={onClose} place="ml-auto" />
    </header>
  )
}

// `size` picks the box (see `DialogSize`); `full` fills the screen on phones and `compact` is the
// small card of the add server dialog. `bare` chrome leaves the header, padding and scrolling to
// the children. `top` sits above other dialogs and full pages. The backdrop of a large box blurs
// while motion plays, unless `blurBackdrop` says otherwise.
export function Dialog({
  title,
  onClose,
  children,
  full = false,
  compact = false,
  size,
  chrome = 'default',
  blurBackdrop,
  top = false,
  actor,
  layer = 'dialog',
  onEscape,
}: {
  title: string
  onClose: () => void
  children: ReactNode
  full?: boolean
  compact?: boolean
  size?: DialogSize
  chrome?: DialogChrome
  blurBackdrop?: boolean
  top?: boolean
  actor?: ReactNode
  layer?: EscapeLayer
  // What Esc does, when it does more than close.
  onEscape?: () => void
}) {
  const titleId = useId()
  const backdrop = useBackdrop(onClose)
  const moves = useMotionPlays()
  const panelRef = useRef<HTMLDivElement>(null)
  // Focus moves into the dialog as it opens, unless something in it took focus already. A bare
  // dialog's content places focus itself.
  useEffect(() => {
    const panel = panelRef.current
    if (chrome === 'default' && panel && !panel.contains(document.activeElement))
      panel.focus({ preventScroll: true })
  }, [chrome])
  useEscape(onEscape ?? onClose, layer)
  const fit = dialogLayout({
    size,
    full,
    compact,
    chrome,
    raised: top || layer === 'confirm',
    blur: dialogBlurs(size, blurBackdrop, moves),
  })
  const panel =
    chrome === 'bare' ? (
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className={fit.panel}
        style={fit.style}
      >
        {children}
      </div>
    ) : (
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={fit.panel}
        style={fit.style}
      >
        <div className={fit.header}>
          <h2 id={titleId} className="text-lg font-medium text-on-surface">
            {title}
          </h2>
          {actor}
          <CloseButton onClick={onClose} compact={compact} />
        </div>
        {fit.body ? <div className={fit.body}>{children}</div> : children}
      </div>
    )
  return (
    <>
      {fit.blur && <div aria-hidden className={fit.blur} />}
      <div className={fit.backdrop} {...backdrop}>
        {panel}
      </div>
    </>
  )
}

// A question in the browser's top layer, above every other layer (dialogs, calls, full pages), that
// must be answered before anything else goes on. It opens when mounted, focuses `initialFocus`, and
// gives focus back when unmounted. Esc (and, with `backdrop`, a click beside it) calls `onCancel`.
// `onOpen` adds behaviour to the open element and returns what undoes it. An `onTop` dialog opens
// after everything else mounted with it, so it sits above another top dialog opened at once (a
// consent prompt over the app it guards). A `wide` one lays its children out as a column.
export function TopDialog({
  labelledBy,
  describedBy,
  wide = false,
  backdrop = false,
  onTop = false,
  initialFocus,
  onCancel,
  onKeyDown,
  onOpen,
  children,
}: {
  labelledBy: string
  describedBy?: string
  wide?: boolean
  backdrop?: boolean
  onTop?: boolean
  initialFocus?: RefObject<HTMLElement | null>
  onCancel: () => void
  onKeyDown?: (e: ReactKeyboardEvent<HTMLDialogElement>) => void
  onOpen?: (el: HTMLDialogElement) => (() => void) | void
  children: ReactNode
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const beside = useBackdrop(onCancel)
  const opened = useRef(onOpen)
  const first = useRef(initialFocus)
  const useOpen = useRef(onTop ? useEffect : useLayoutEffect).current
  useOpen(() => {
    const el = ref.current!
    const opener = document.activeElement
    el.showModal()
    first.current?.current?.focus()
    const undo = opened.current?.(el)
    return () => {
      undo?.()
      el.close()
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus({ preventScroll: true })
    }
  }, [])
  return (
    <dialog
      ref={ref}
      aria-modal="true"
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      onCancel={e => {
        e.preventDefault()
        onCancel()
      }}
      onKeyDown={e => {
        e.stopPropagation()
        onKeyDown?.(e)
      }}
      className={`fixed inset-0 m-auto max-h-dvh-85 max-w-full flex-col overflow-hidden rounded-3xl bg-surface-container-high text-on-surface shadow-elevation-3 open:flex backdrop:bg-scrim/60 ${
        wide ? 'w-[min(32rem,calc(100%-2rem))]' : 'w-[min(24rem,calc(100%-2rem))]'
      }`}
      {...(backdrop ? beside : {})}
    >
      <div className={`min-h-0 flex-1 overflow-y-auto p-6${wide ? ' flex flex-col' : ''}`}>
        {children}
      </div>
    </dialog>
  )
}

// A full screen page over the app (invite, config link) with the logo and theme toggle on top.
// The close button shows only when signed in or a guest.
export function LinkPage({
  closeTitle,
  onClose,
  children,
}: {
  closeTitle: string
  onClose: () => void
  children: ReactNode
}) {
  const authed = useStore(s => s.me !== null || s.guest)
  return (
    <div className="invite-backdrop fixed inset-x-0 top-app z-page flex h-app flex-col overflow-y-auto safe-x-4 pb-[max(var(--space-lg),env(safe-area-inset-bottom))]">
      <header className="flex shrink-0 items-center justify-between pt-3 pb-2">
        <img src="/rchat_logo.png" alt="RChat" className="h-9 w-auto" />
        <div className="flex items-center gap-1">
          <ThemeToggle />
          {authed && <IconButton icon={X} label={closeTitle} size="lg" onClick={onClose} />}
        </div>
      </header>
      <main className="my-auto flex w-full justify-center py-6">{children}</main>
    </div>
  )
}

// Masked words whose reveal is shared, so the pieces of a word split by formatting open together.
const RevealedWords = createContext<{ open: Set<string>; reveal: (word: string) => void } | null>(
  null
)

export function MaskedWords({
  children,
  open: shown,
}: {
  children: ReactNode
  open?: readonly string[]
}) {
  const [open, setOpen] = useState<Set<string>>(() => new Set(shown))
  const reveal = useCallback(
    (word: string) => setOpen(o => (o.has(word) ? o : new Set(o).add(word))),
    []
  )
  const value = useMemo(() => ({ open, reveal }), [open, reveal])
  return <RevealedWords.Provider value={value}>{children}</RevealedWords.Provider>
}

// A reveal scope for what's inside, unless one is around it already.
export function RevealScope({ children }: { children: ReactNode }) {
  const outer = useContext(RevealedWords)
  return outer ? children : <MaskedWords>{children}</MaskedWords>
}

// Whether the masked words under `word` were revealed in the scope around.
export const useRevealed = (word: string) => !!useContext(RevealedWords)?.open.has(word)

const MaskGroup = createContext<string | undefined>(undefined)

// The masked words inside open together under `word`, in the scope around them or their own.
export function MaskedTogether({ word, children }: { word: string; children: ReactNode }) {
  return (
    <RevealScope>
      <MaskGroup.Provider value={word}>{children}</MaskGroup.Provider>
    </RevealScope>
  )
}

// Elements that are controls: a masked word inside one may not be a control itself.
const CONTROL =
  'a[href],button,label,select,textarea,summary,[role=button],[role=link],[role=option],[role=menuitem],[role=menuitemcheckbox],[role=menuitemradio],[role=tab],[role=checkbox],[role=radio],[role=switch]'

// Where masked words render: `plain` text (each word a button), inside a `control` (plain
// spans), or not said (spans until the page shows they are outside any control).
const MaskMode = createContext<'plain' | 'control' | null>(null)

export function MaskControl({ children }: { children: ReactNode }) {
  return <MaskMode.Provider value="control">{children}</MaskMode.Provider>
}

export function MaskPlain({ children }: { children: ReactNode }) {
  const outer = useContext(MaskMode)
  return (
    <MaskMode.Provider value={outer === 'control' ? 'control' : 'plain'}>
      {children}
    </MaskMode.Provider>
  )
}

const useIsoLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect

// A word the personal filter masked, shown until the page reloads. In plain text it is a button
// (click, tap, Enter or Space). Inside a control it is a span that a click or tap reveals; the
// row's context menu and the palette reveal it from the keyboard (`REVEAL_EVENT`).
export function MaskedWord({
  hidden,
  word: own,
  children,
}: {
  hidden: string
  word?: string
  children: ReactNode
}) {
  const shared = useContext(RevealedWords)
  const group = useContext(MaskGroup)
  const word = own ?? group
  const mode = useContext(MaskMode)
  const [mine, setMine] = useState(false)
  const [control, setControl] = useState(mode !== 'plain')
  const node = useRef<HTMLElement | null>(null)
  const shownRef = useRef<HTMLSpanElement>(null)
  const focused = useRef(false)
  const open = mine || (word !== undefined && !!shared && shared.open.has(word))
  const show = useCallback(() => {
    if (word !== undefined && shared) shared.reveal(word)
    else setMine(true)
  }, [word, shared])
  useIsoLayoutEffect(() => {
    if (open || mode === 'control') return
    setControl(!!node.current?.parentElement?.closest(CONTROL))
  }, [open, mode])
  useEffect(() => {
    const el = node.current
    if (open || !el) return
    el.addEventListener(REVEAL_EVENT, show)
    return () => el.removeEventListener(REVEAL_EVENT, show)
  }, [open, show, control])
  useEffect(() => {
    if (open && focused.current) shownRef.current?.focus()
  }, [open])
  if (open)
    return (
      <span ref={shownRef} tabIndex={-1} className="outline-none">
        {hidden}
      </span>
    )
  const reveal = (e: SyntheticEvent) => {
    e.preventDefault()
    e.stopPropagation()
    focused.current = document.activeElement === e.currentTarget
    show()
  }
  const keep = (el: HTMLElement | null) => {
    node.current = el
  }
  if (control)
    return (
      <span
        ref={keep}
        data-masked-word=""
        onClick={reveal}
        className="cursor-pointer rounded-sm underline decoration-dotted underline-offset-2 hover:bg-on-surface/10"
      >
        <span aria-hidden="true">{children}</span>
        <span className="sr-only">masked</span>
      </span>
    )
  return (
    <button
      ref={keep}
      type="button"
      data-masked-word=""
      aria-label="Masked word"
      title="Show masked word"
      onClick={reveal}
      className="inline cursor-pointer rounded-sm underline decoration-dotted underline-offset-2 hover:bg-on-surface/10 focus-visible:outline-2 focus-visible:outline-primary"
    >
      {children}
    </button>
  )
}

// Whether text written or owned by `by` is your own: your username, or your P2P identity inside
// a P2P conversation.
export const useOwnCheck = () => {
  const self = useLive(useChat().self)
  return (by?: string | null) => !!by && self === by
}

export const useOwn = (by?: string | null) => useOwnCheck()(by)

// Whether you created instance server `name`: its server, channel, category and role names are
// your own text.
export const useOwnServer = (name: string | null | undefined) =>
  useStore(s => {
    const me = s.me
    if (!me || !name) return false
    const creator = me.servers.find(x => x.name === name)?.creator ?? s.servers[name]?.creator
    return creator === me.username
  })

// Text as the personal profanity filter shows it, each masked word revealable. `code`: plain
// text that may hold markdown code, which stays as written. `file`: the name of a file. Your own
// text (`own`, or `by` you) is never masked.
export function Masked({
  text,
  code = false,
  file = false,
  by,
  own = false,
}: {
  text: string
  code?: boolean
  file?: boolean
  by?: string | null
  own?: boolean
}) {
  const mine = useOwn(by)
  const mask = useMask(own || mine, file)
  const shown = code ? maskOutsideCode(text, mask) : mask(text)
  return <MaskedText text={text} shown={shown} />
}

export function MaskedText({ text, shown }: { text: string; shown: string }) {
  if (shown === text) return <>{text}</>
  return (
    <>
      {maskRuns(text, shown).map((r, i) =>
        r.hidden === undefined ? (
          <Fragment key={i}>{r.text}</Fragment>
        ) : (
          <MaskedWord key={i} hidden={r.hidden}>
            {r.text}
          </MaskedWord>
        )
      )}
    </>
  )
}
