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
import { maskOutsideCode, maskRuns } from '../lib/profanity'
import { useMask, useStore } from '../lib/store'
import { useChatSource } from './chat_source'
import { REVEAL_EVENT } from '../lib/masked_reveal'
import { ThemeToggle } from './status_clock'

export const fieldCls =
  'min-w-0 flex-1 rounded-xl border border-outline bg-transparent px-3 py-2 text-base outline-none placeholder:text-on-surface-variant focus:border-primary md:text-sm'
export const filledBtn =
  'rounded-full bg-primary px-4 py-2 text-sm font-medium text-on-primary hover:opacity-90 disabled:opacity-40'
export const filledDangerBtn =
  'rounded-full bg-error px-4 py-2 text-sm font-medium text-on-error hover:opacity-90'
export const textBtn =
  'rounded-full px-3 py-1.5 text-sm font-medium text-primary hover:bg-surface-container-highest'
export const dangerBtn =
  'rounded-full px-3 py-1.5 text-sm font-medium text-error hover:bg-surface-container-highest disabled:opacity-40'
export const iconBtn =
  'rounded-full p-2 text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface'
export const sectionCls =
  'pb-2 pt-5 text-xs font-medium uppercase tracking-wide text-on-surface-variant first:pt-0'

// One choice of a few, as chips.
export function Chips<T extends string | number>({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: T
  options: readonly { value: T; label: string }[]
  onChange: (v: T) => void
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-1.5">
      {options.map(o => (
        <button
          key={String(o.value)}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={`rounded-full border px-3 py-1.5 text-sm ${
            value === o.value
              ? 'border-transparent bg-secondary-container text-on-secondary-container'
              : 'border-outline text-on-surface-variant hover:bg-surface-container-highest'
          }`}
        >
          {o.label}
        </button>
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

type EscapeLayer = 'stage' | 'panel' | 'dialog' | 'confirm'

// Each handler sees the store as it was at keydown. So a handler that runs after another closed
// its layer still knows that the layer was covered.
const pressed = new WeakMap<Event, ReturnType<typeof useStore.getState>>()

const covered = (layer: EscapeLayer, e: Event) => {
  const s = pressed.get(e) ?? useStore.getState()
  pressed.set(e, s)
  if (s.contextMenu) return true
  if (layer === 'confirm') return false
  if (s.confirm) return true
  if (layer === 'dialog') return false
  if (
    s.activeDialog !== null ||
    s.profile !== null ||
    s.invite !== null ||
    document.querySelector('[aria-modal="true"]') !== null
  )
    return true
  return layer === 'stage' && s.panel !== null
}

export function useEscape(onEscape: (e: KeyboardEvent) => void, layer: EscapeLayer = 'dialog') {
  const ref = useRef(onEscape)
  useEffect(() => {
    ref.current = onEscape
  })
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.isComposing && !covered(layer, e)) ref.current(e)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [layer])
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

export function Sentinel({ onVisible }: { onVisible: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const observer = new IntersectionObserver(entries => {
      if (entries.some(e => e.isIntersecting)) onVisible()
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [onVisible])
  return <div ref={ref} className="h-px" />
}

export function CloseButton({
  onClick,
  compact = false,
}: {
  onClick: () => void
  compact?: boolean
}) {
  return (
    <button
      type="button"
      title="Close"
      aria-label="Close"
      onClick={onClick}
      className={`rounded-full ${compact ? 'p-1' : 'p-1.5'} text-on-surface-variant hover:bg-surface-container-highest`}
    >
      <X size={18} />
    </button>
  )
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
  onClose,
}: {
  icon: LucideIcon
  title: string
  closeTitle: string
  onClose: () => void
}) {
  return (
    <header className="flex h-14 shrink-0 items-center gap-2 border-b border-outline-variant px-4">
      <Icon size={18} className="shrink-0 text-on-surface-variant" />
      <span className="min-w-0 truncate font-medium">{title}</span>
      <button
        title={closeTitle}
        onClick={onClose}
        className="ml-auto shrink-0 rounded-full p-1.5 text-on-surface-variant hover:bg-surface-container-high"
      >
        <X size={18} />
      </button>
    </header>
  )
}

// `full` fills the screen on mobile. `compact` is the small card of the add server dialog.
export function Dialog({
  title,
  onClose,
  children,
  full = false,
  compact = false,
  layer = 'dialog',
}: {
  title: string
  onClose: () => void
  children: ReactNode
  full?: boolean
  compact?: boolean
  layer?: EscapeLayer
}) {
  const titleId = useId()
  const backdrop = useBackdrop(onClose)
  useEscape(onClose, layer)
  return (
    <div
      className={`fixed inset-x-0 top-app ${layer === 'confirm' || compact ? 'z-50' : 'z-40'} flex h-app items-center justify-center bg-scrim/60 ${full ? 'px-safe sm:px-safe-4 sm:py-4' : 'px-safe-4 py-4'}`}
      {...backdrop}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={`w-full overflow-y-auto bg-surface-container-high p-6 shadow-elevation-3 ${
          full
            ? 'h-full max-h-none pb-[max(1.5rem,env(safe-area-inset-bottom))] sm:h-auto sm:max-h-[min(85vh,100%)] sm:max-w-lg sm:rounded-2xl sm:pb-6'
            : compact
              ? 'max-h-full max-w-sm rounded-3xl'
              : 'max-h-[min(85vh,100%)] max-w-lg rounded-2xl'
        }`}
      >
        <div
          className={`flex items-center justify-between ${
            full
              ? 'sticky -top-6 z-10 -mx-6 -mt-6 mb-4 bg-surface-container-high px-6 py-4'
              : 'mb-4'
          }`}
        >
          <h2 id={titleId} className="text-lg font-medium text-on-surface">
            {title}
          </h2>
          <CloseButton onClick={onClose} compact={compact} />
        </div>
        {children}
      </div>
    </div>
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
    <div className="invite-backdrop fixed inset-x-0 top-app z-40 flex h-app flex-col overflow-y-auto px-safe-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
      <header className="flex shrink-0 items-center justify-between pt-3 pb-2">
        <img src="/rchat_logo.png" alt="RChat" className="h-9 w-auto" />
        <div className="flex items-center gap-1">
          <ThemeToggle />
          {authed && (
            <button
              title={closeTitle}
              aria-label={closeTitle}
              onClick={onClose}
              className={iconBtn}
            >
              <X size={20} />
            </button>
          )}
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

export function MaskedWords({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState<Set<string>>(() => new Set())
  const reveal = useCallback(
    (word: string) => setOpen(o => (o.has(word) ? o : new Set(o).add(word))),
    []
  )
  const value = useMemo(() => ({ open, reveal }), [open, reveal])
  return <RevealedWords.Provider value={value}>{children}</RevealedWords.Provider>
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
  word,
  children,
}: {
  hidden: string
  word?: string
  children: ReactNode
}) {
  const shared = useContext(RevealedWords)
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
export const useOwn = (by?: string | null) => {
  const src = useChatSource()
  const me = useStore(s => s.me?.username ?? null)
  return !!by && (src ? src.self === by : me === by)
}

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
// text that may hold markdown code, which stays as written. Your own text (`own`, or `by` you) is
// never masked.
export function Masked({
  text,
  code = false,
  by,
  own = false,
}: {
  text: string
  code?: boolean
  by?: string | null
  own?: boolean
}) {
  const mine = useOwn(by)
  const mask = useMask(own || mine)
  const shown = code ? maskOutsideCode(text, mask) : mask(text)
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

// Placeholder rows while a section loads.
export function SkeletonRows({ rows = 3, label }: { rows?: number; label: string }) {
  return (
    <div role="status" aria-label={label} data-skeleton className="flex flex-col gap-1">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-3 px-2 py-2">
          <span className="size-8 shrink-0 rounded-full bg-surface-container-highest/70 motion-safe:animate-pulse" />
          <span className="flex min-w-0 flex-1 flex-col gap-1.5">
            <span className="h-3 w-2/5 rounded-full bg-surface-container-highest/70 motion-safe:animate-pulse" />
            <span className="h-2.5 w-3/5 rounded-full bg-surface-container-highest/50 motion-safe:animate-pulse" />
          </span>
        </div>
      ))}
    </div>
  )
}
