'use client'

import { useEffect, useState, useSyncExternalStore } from 'react'
import { Download } from 'lucide-react'

interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>
}

let deferred: InstallPromptEvent | null = null
const listeners = new Set<() => void>()
const setDeferred = (e: InstallPromptEvent | null) => {
  deferred = e
  listeners.forEach(l => l())
}
const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}

const isStandalone = () =>
  window.matchMedia('(display-mode: standalone)').matches ||
  (navigator as { standalone?: boolean }).standalone === true

export function InstallButton({ compact = false }: { compact?: boolean }) {
  const prompt = useSyncExternalStore(
    subscribe,
    () => deferred,
    () => null
  )
  if (!prompt) return null
  return (
    <button
      type="button"
      title="Install app"
      onClick={() => {
        void prompt.prompt()
        setDeferred(null)
      }}
      className={
        compact
          ? 'flex h-10 w-10 items-center justify-center rounded-full text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface'
          : 'flex items-center justify-center gap-1.5 whitespace-nowrap rounded-full px-3 py-2 text-sm text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface'
      }
    >
      <Download size={compact ? 18 : 16} />
      {!compact && 'Install app'}
    </button>
  )
}

export function IosInstallHint() {
  const [show, setShow] = useState(false)
  useEffect(() => {
    setShow(/iphone|ipad|ipod/i.test(navigator.userAgent) && !isStandalone())
  }, [])
  if (!show) return null
  return (
    <p className="text-center text-xs text-on-surface-variant">
      Install RChat: tap Share, then Add to Home Screen.
    </p>
  )
}

export default function PwaRegister() {
  useEffect(() => {
    const onPrompt = (e: Event) => {
      e.preventDefault()
      if (!isStandalone()) setDeferred(e as InstallPromptEvent)
    }
    window.addEventListener('beforeinstallprompt', onPrompt)
    if (process.env.NODE_ENV === 'production' && 'serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => undefined)
    }
    return () => window.removeEventListener('beforeinstallprompt', onPrompt)
  }, [])
  return null
}
