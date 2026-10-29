'use client'

import { useEffect, useState } from 'react'
import { home } from '../lib/instances'
import { confirmGate, openDeepLink, type LinkEnv } from '../lib/deep_links'
import { useStore } from '../lib/store'
import { inShell, mobileOs } from '../lib/platform'
import { listen, shell } from '../lib/platform/desktop'
import { Dialog, filledBtn, textBtn } from './ui'

interface Ask {
  host: string
  answer: (yes: boolean) => void
}

const env = (confirmSwitch: LinkEnv['confirmSwitch']): LinkEnv => {
  const { me, guest, switchInstance, setError } = useStore.getState()
  const stored = (key: string) => localStorage.getItem(home.scoped(key)) !== null
  return {
    homeOrigin: home.origin,
    appLinks: mobileOs() !== null,
    signedIn: stored('rchat_token') || stored('rchat_guest'),
    live: (me !== null || guest) && !window.location.pathname.startsWith('/login'),
    push: path => {
      window.history.pushState(null, '', path)
      window.dispatchEvent(new PopStateEvent('popstate'))
    },
    load: path => window.location.assign(path),
    confirmSwitch,
    switchTo: switchInstance,
    openOutside: url => void shell.openExternal(url).catch(() => {}),
    fail: setError,
  }
}

// Hands `rchat://` links and update news from the desktop shell to the app. A link that would
// change the instance waits for a click here.
export default function DesktopBridge() {
  const [ask, setAsk] = useState<Ask | null>(null)
  useEffect(() => {
    if (!inShell()) return
    let live = true
    let pending: Ask | null = null
    const confirmSwitch = confirmGate((host, resolve) => {
      if (!live) return resolve(false)
      pending = {
        host,
        answer: yes => {
          pending = null
          setAsk(null)
          resolve(yes)
        },
      }
      setAsk(pending)
    })
    const drain = async () => {
      const links = await shell.takeLinks().catch(() => [])
      for (const link of links) if (live) await openDeepLink(link, env(confirmSwitch))
    }
    const offLink = listen('deep-link', () => void drain())
    const offUpdate = listen('update', () =>
      useStore.getState().showToast('An update is ready. Install it in Settings.')
    )
    void offLink.then(() => drain())
    return () => {
      live = false
      pending?.answer(false)
      void offLink.then(
        f => f(),
        () => {}
      )
      void offUpdate.then(
        f => f(),
        () => {}
      )
    }
  }, [])
  if (!ask) return null
  return (
    <Dialog title="Switch instance?" onClose={() => ask.answer(false)} layer="confirm" compact>
      <p className="text-sm text-on-surface-variant">
        Open <span className="streamer font-medium break-all text-on-surface">{ask.host}</span>?
        This changes your instance.
      </p>
      <div className="mt-6 flex justify-end gap-2">
        <button type="button" autoFocus onClick={() => ask.answer(false)} className={textBtn}>
          Cancel
        </button>
        <button type="button" onClick={() => ask.answer(true)} className={filledBtn}>
          Open
        </button>
      </div>
    </Dialog>
  )
}
