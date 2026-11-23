'use client'

import { useEffect } from 'react'
import { client } from '../lib/client/client'
import type { AccountSession } from '../lib/client/session'
import { inShell, mobileOs } from '../lib/platform'
import { onBack, pressEscape } from '../lib/platform/mobile'

const LAYERS = '[role="dialog"], [role="menu"], [role="listbox"], [data-popover], [data-drawer]'

const openLayers = (account: AccountSession) => {
  const s = account.store.getState()
  const flags = [s.contextMenu, s.confirm, s.activeDialog, s.profile, s.invite, s.panel]
  const marks = flags.map(f => (f === null || f === undefined ? '0' : '1')).join('')
  const count = document.querySelectorAll(LAYERS).length
  return marks.includes('1') || count > 0 ? `${marks}:${count}` : ''
}

const frames = () =>
  new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))

export function handleAndroidBack(canGoBack: boolean, active: () => boolean, exit: () => void) {
  const shown = client.shown()
  const owner = client.overlayOwner() ?? shown
  const shownMark = shown.lifetime.sessionMark()
  const ownerMark = owner.lifetime.sessionMark()
  const current = () =>
    active() &&
    client.shown() === shown &&
    shown.lifetime.sessionMark() === shownMark &&
    client.live().includes(owner) &&
    owner.lifetime.sessionMark() === ownerMark
  return onBack({
    open: () => openLayers(owner),
    escape: () => pressEscape(window),
    settle: frames,
    canGoBack,
    back: () => {
      if (current()) window.history.back()
    },
    exit: () => {
      if (current()) exit()
    },
  })
}

// Android's back button, inside the mobile app only: closes what is open, then walks back.
export default function MobileBridge() {
  useEffect(() => {
    if (!inShell() || mobileOs() !== 'android') return
    let live = true
    const app = import('@tauri-apps/api/app')
    const off = app.then(({ onBackButtonPress, exit }) =>
      onBackButtonPress(({ canGoBack }) => {
        if (!live) return
        void handleAndroidBack(
          canGoBack,
          () => live,
          () => void exit(0).catch(() => {})
        )
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
