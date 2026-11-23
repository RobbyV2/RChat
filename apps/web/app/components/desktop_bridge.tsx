'use client'

import { useEffect, useState } from 'react'
import { accountHistoryState, routeOwnerFor } from '../lib/client/account_paths'
import { accountPath } from '../lib/view'
import { client } from '../lib/client/client'
import type { AccountSession } from '../lib/client/session'
import { confirmGate, openDeepLink, type LinkEnv } from '../lib/deep_links'
import { keptSession } from '../lib/start'
import { inShell, mobileOs } from '../lib/platform'
import { listen, shell } from '../lib/platform/desktop'
import { Dialog, filledBtn, textBtn } from './ui'

interface Ask {
  host: string
  answer: (yes: boolean) => void
}

const env = (
  owner: AccountSession,
  confirmSwitch: LinkEnv['confirmSwitch'],
  active: () => boolean
): LinkEnv => {
  const { me, guest, switchInstance, setError } = owner.store.getState()
  const mark = owner.lifetime.sessionMark()
  const current = () => active() && client.shown() === owner && client.live().includes(owner)
  return {
    homeOrigin: owner.conn.origin,
    canSwitch: () => current() && owner.lifetime.sessionMark() === mark,
    canLoad: origin => current() && owner.conn.origin === origin,
    appLinks: mobileOs() !== null,
    signedIn: me !== null || guest || keptSession(owner.conn, owner.credentialTarget),
    live: (me !== null || guest) && !window.location.pathname.startsWith('/login'),
    push: path => {
      window.history.pushState(
        accountHistoryState(owner, null),
        '',
        accountPath(path, routeOwnerFor(owner))
      )
      window.dispatchEvent(new PopStateEvent('popstate'))
    },
    load: path => window.location.assign(accountPath(path, routeOwnerFor(owner))),
    confirmSwitch,
    switchTo: switchInstance,
    openOutside: url => void shell.openExternal(url).catch(() => {}),
    fail: message => {
      if (current() && owner.lifetime.sessionMark() === mark) setError(message)
    },
  }
}

export function listenForLinks(
  confirmSwitch: LinkEnv['confirmSwitch'],
  active: () => boolean,
  register = listen,
  takeLinks = shell.takeLinks
) {
  const deliver = async (owner: AccountSession, mark: object, links: string[]) => {
    for (const link of links) {
      if (!active() || client.shown() !== owner || owner.lifetime.sessionMark() !== mark) return
      await openDeepLink(link, env(owner, confirmSwitch, active))
    }
  }
  const owner = client.shown()
  const mark = owner.lifetime.sessionMark()
  const startup = Promise.withResolvers<void>()
  let next = startup.promise
  let registered = false
  const reservations = new Set<Promise<string[]>>()
  const listener = register('deep-link', batch => {
    if (!active() || (!registered && typeof batch !== 'number')) return
    const target = client.shown()
    const at = target.lifetime.sessionMark()
    // Take this event's links immediately, then open them in arrival order.
    const links = takeLinks(typeof batch === 'number' ? batch : undefined).catch(() => [])
    if (!registered) {
      reservations.add(links)
      void links.then(() => reservations.delete(links))
    }
    next = next.then(async () => deliver(target, at, await links)).catch(() => {})
  })
  void listener.then(
    async () => {
      registered = true
      try {
        await Promise.all(reservations)
        if (active()) await deliver(owner, mark, await takeLinks().catch(() => []))
      } finally {
        startup.resolve()
      }
    },
    () => startup.resolve()
  )
  return listener
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
    const offLink = listenForLinks(confirmSwitch, () => live)
    const offUpdate = listen('update', () =>
      client.shown().store.getState().showToast('An update is ready. Install it in Settings.')
    )
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
        Open <span className="font-medium break-all text-on-surface">{ask.host}</span>? This changes
        your instance.
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
