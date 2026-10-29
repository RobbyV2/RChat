'use client'

import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { X, type LucideIcon } from 'lucide-react'
import { useStore } from '../lib/store'
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
      <Icon size={18} className="text-on-surface-variant" />
      <span className="font-medium">{title}</span>
      <button
        title={closeTitle}
        onClick={onClose}
        className="ml-auto rounded-full p-1.5 text-on-surface-variant hover:bg-surface-container-high"
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
      className={`fixed inset-x-0 top-0 ${layer === 'confirm' || compact ? 'z-50' : 'z-40'} flex h-app items-center justify-center bg-scrim/60 ${full ? 'px-safe sm:px-safe-4 sm:py-4' : 'px-safe-4 py-4'}`}
      {...backdrop}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={`w-full overflow-y-auto bg-surface-container-high p-6 shadow-elevation-3 ${
          full
            ? 'h-full max-h-none sm:h-auto sm:max-h-[min(85vh,100%)] sm:max-w-lg sm:rounded-2xl'
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
    <div className="invite-backdrop fixed inset-x-0 top-0 z-40 flex h-app flex-col overflow-y-auto px-safe-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
      <header className="flex shrink-0 items-center justify-between pt-[max(0.75rem,env(safe-area-inset-top))] pb-2">
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
