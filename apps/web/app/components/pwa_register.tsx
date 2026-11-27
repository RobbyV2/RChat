'use client'

import { Button, IconButton } from './controls'
import { useEffect, useState, useSyncExternalStore } from 'react'
import { Download } from 'lucide-react'
import { shellInfo } from '../lib/platform'
import { trackUpdates } from '../lib/pwa_update'

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

const trackUpdate = (reg: ServiceWorkerRegistration) =>
  trackUpdates(
    reg,
    () => navigator.serviceWorker.controller !== null,
    () => window.location.reload()
  )

export function InstallButton({ compact = false }: { compact?: boolean }) {
  const prompt = useSyncExternalStore(
    subscribe,
    () => deferred,
    () => null
  )
  if (!prompt) return null
  const install = () => {
    void prompt.prompt()
    setDeferred(null)
  }
  return compact ? (
    <IconButton icon={Download} label="Install app" size="lg" onClick={install} />
  ) : (
    <Button icon={Download} size="md" onClick={install}>
      Install app
    </Button>
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
    if (shellInfo()) return
    const onPrompt = (e: Event) => {
      e.preventDefault()
      if (!isStandalone()) setDeferred(e as InstallPromptEvent)
    }
    window.addEventListener('beforeinstallprompt', onPrompt)
    if (process.env.NODE_ENV === 'production' && 'serviceWorker' in navigator) {
      navigator.serviceWorker
        .register('/sw.js')
        .then(reg => {
          trackUpdate(reg)
          void reg.update()
        })
        .catch(() => undefined)
    }
    return () => window.removeEventListener('beforeinstallprompt', onPrompt)
  }, [])
  return null
}
