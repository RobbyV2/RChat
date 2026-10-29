'use client'

import { useEffect } from 'react'
import { useStore } from '../lib/store'
import { inShell, mobileOs } from '../lib/platform'
import { onBack, pressEscape } from '../lib/platform/mobile'

const LAYERS = '[role="dialog"], [role="menu"], [role="listbox"], [data-popover], [data-drawer]'

const openLayers = () => {
  const s = useStore.getState()
  const flags = [s.contextMenu, s.confirm, s.activeDialog, s.profile, s.invite, s.panel]
  const marks = flags.map(f => (f === null || f === undefined ? '0' : '1')).join('')
  const count = document.querySelectorAll(LAYERS).length
  return marks.includes('1') || count > 0 ? `${marks}:${count}` : ''
}

const frames = () =>
  new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))

// Android's back button, inside the mobile app only: closes what is open, then walks back.
export default function MobileBridge() {
  useEffect(() => {
    if (!inShell() || mobileOs() !== 'android') return
    let live = true
    const app = import('@tauri-apps/api/app')
    const off = app.then(({ onBackButtonPress, exit }) =>
      onBackButtonPress(({ canGoBack }) => {
        if (!live) return
        void onBack({
          open: openLayers,
          escape: () => pressEscape(window),
          settle: frames,
          canGoBack,
          back: () => window.history.back(),
          exit: () => void exit(0).catch(() => {}),
        })
      })
    )
    return () => {
      live = false
      void off.then(
        listener => listener.unregister(),
        () => {}
      )
    }
  }, [])
  return null
}
