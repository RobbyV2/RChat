import { publicSettings } from '../api/public'
import { ownInstance, readLocal, writeLocal } from '../instances'
import { shellInfo } from '../platform/desktop'
import type { Book } from './book'
import { time } from '../platform/time'

// Only the instance serving this web app can set its connection policy.
const own = () => (shellInfo() ? null : ownInstance())
const key = (origin: string) => 'rchat_hosted_lock@' + origin
export function createHostedPolicy() {
  const listeners = new Set<() => void>()
  let current: { origin: string; allowed: boolean } | undefined
  let revision = 0
  let pending: Promise<void> | undefined

  function canAddInstance() {
    const site = own()
    if (!site) return true
    return current?.origin === site.origin ? current.allowed : readLocal(key(site.origin)) !== '1'
  }

  function allowsAccountOrigin(origin: string) {
    return canAddInstance() || origin === own()?.origin
  }

  function hostedLockMessage() {
    return `This site's app only connects to ${new URL(own()!.origin).host}. Use the RChat app or another web app for other instances.`
  }

  function visibleBook(book: Book): Book {
    if (canAddInstance()) return book
    return { ...book, instances: book.instances.filter(i => allowsAccountOrigin(i.origin)) }
  }

  function watchHostedPolicy(listener: () => void) {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }

  const hostedPolicyRevision = () => revision

  function acceptHostedPolicy(origin: string, value: unknown, expected?: number) {
    if (expected !== undefined && revision !== expected) return
    if (own()?.origin !== origin) return
    const allowed = value !== false
    const previous = current?.origin === origin ? current.allowed : undefined
    revision++
    current = { origin, allowed }
    writeLocal(key(origin), allowed ? null : '1')
    if (allowed !== previous) for (const listener of listeners) listener()
  }

  // A remote deep link can be the first page, before any account on this site has a socket.
  function refreshHostedPolicy() {
    const site = own()
    if (!site) return Promise.resolve()
    if (pending) return pending
    const at = revision
    pending = (async () => {
      try {
        const response = await publicSettings(site.api, 5000).send()
        if (!response.ok) return
        const settings = await response.json()
        if (settings && typeof settings === 'object' && at === revision)
          acceptHostedPolicy(site.origin, settings.client_other_instances)
      } catch {
        /* Keep the last known policy offline. */
      }
    })().finally(() => {
      pending = undefined
    })
    return pending
  }

  function watchPagePolicy(select: () => void) {
    let active = true
    let ready = false
    const off = watchHostedPolicy(() => {
      if (ready) select()
    })
    void refreshHostedPolicy().then(() => {
      if (active) {
        ready = true
        select()
      }
    })
    const refresh = () => {
      void refreshHostedPolicy()
    }
    const pop = () => {
      if (ready) select()
    }
    window.addEventListener('popstate', pop)
    const storage = (event: StorageEvent) => {
      const site = own()
      if (site && (event.key === key(site.origin) || event.key === null)) refresh()
    }
    window.addEventListener('storage', storage)
    window.addEventListener('focus', refresh)
    const timer = own() ? time().every(30000, refresh) : undefined
    return () => {
      active = false
      off()
      timer?.()
      window.removeEventListener('popstate', pop)
      window.removeEventListener('focus', refresh)
      window.removeEventListener('storage', storage)
    }
  }

  return {
    canAddInstance,
    allowsAccountOrigin,
    hostedLockMessage,
    visibleBook,
    watchHostedPolicy,
    hostedPolicyRevision,
    acceptHostedPolicy,
    refreshHostedPolicy,
    watchPagePolicy,
  }
}

export const {
  canAddInstance,
  allowsAccountOrigin,
  hostedLockMessage,
  visibleBook,
  watchHostedPolicy,
  hostedPolicyRevision,
  acceptHostedPolicy,
  refreshHostedPolicy,
  watchPagePolicy,
} = createHostedPolicy()
