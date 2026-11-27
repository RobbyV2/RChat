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
  type ReactNode,
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
import { useChatSource } from './chat_source'
import { REVEAL_EVENT } from '../lib/masked_reveal'
import { ThemeToggle } from './status_clock'
import { Chip, IconButton } from './controls'
import { buttonLook, iconButtonLook, sectionHeadingLook } from '../lib/controls'

export const fieldCls =
  'min-w-0 flex-1 rounded-xl border border-outline bg-transparent px-3 py-2 text-base outline-none placeholder:text-on-surface-variant focus:border-primary md:text-sm pointer-coarse:min-h-11'
export const filledBtn = buttonLook('filled', 'md')
export const filledDangerBtn = buttonLook('filled-danger', 'md')
export const textBtn = buttonLook('text', 'sm')
export const dangerBtn = buttonLook('danger', 'sm')
export const iconBtn = `inline-flex ${iconButtonLook('plain', 'lg')}`
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

// Returns `[copied, flash]`. `copied` is true for 1.5 s after `flash()`, for a "Copied" check mark.
export function useCopied() {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const id = window.setTimeout(() => setCopied(false), 1500)
    return () => window.clearTimeout(id)
  }, [copied])
  return [copied, () => setCopied(true)] as const
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

// The drag handle at the top of a bottom sheet.
export function SheetGrip() {
  return (
    <div aria-hidden className="mx-auto mb-2 h-1 w-8 shrink-0 rounded-full bg-outline-variant" />
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
    <div className="invite-backdrop fixed inset-x-0 top-app z-page flex h-app flex-col overflow-y-auto px-safe-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
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
  const src = useChatSource()
  const me = useStore(s => s.me?.username ?? null)
  return (by?: string | null) => !!by && (src ? src.self === by : me === by)
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
