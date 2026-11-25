'use client'

import { useEffect, useState } from 'react'
import { knownLinkOrigin, routeInstanceLink } from '../lib/client/instance_links'
import { client } from '../lib/client/client'
import type { AccountSession } from '../lib/client/session'
import { readIntent, deliverReturn } from '../lib/sso'
import { deepLinkTarget, confirmGate, openDeepLink, type LinkEnv } from '../lib/deep_links'
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
  const { setError } = owner.store.getState()
  const mark = owner.lifetime.sessionMark()
  const nav = owner.store.navigationMark()
  const shown = client.shownVersion()
  const current = () =>
    active() &&
    shown === client.shownVersion() &&
    client.shown() === owner &&
    client.live().includes(owner)
  return {
    homeOrigin: owner.conn.origin,
    appLinks: mobileOs() !== null,
    current: () =>
      current() && owner.lifetime.sessionMark() === mark && owner.store.navigationMark() === nav,
    known: knownLinkOrigin,
    route: (origin, path) => routeInstanceLink(owner, { origin, path }),
    confirmSwitch,
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
      const intent = readIntent()
      const target = deepLinkTarget(link, intent?.origin ?? owner.conn.origin)
      if (target && /^\/sso\/?(?:\?|$)/.test(target.path)) {
        // The custom scheme carries only host and port. The saved intent supplies
        // the exact http(s) origin, including non-default loopback configurations.
        if (intent && new URL(link).host.toLowerCase() === new URL(intent.origin).host) {
          const search = new URL(target.path, intent.origin).search
          if (!deliverReturn(search, intent.origin) && intent.purpose === 'login')
            window.location.assign('/sso/' + search)
        }
        continue
      }
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
    <Dialog title="Open instance link?" onClose={() => ask.answer(false)} layer="confirm" compact>
      <p className="text-sm text-on-surface-variant">
        Open <span className="font-medium break-all text-on-surface">{ask.host}</span>?
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
