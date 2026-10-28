import { pingTitle } from '../pings'
import { permissionOf, type Notifier, type Permission } from './notifications'

const api = () => (typeof Notification === 'undefined' ? null : Notification)

const current = (): Permission => {
  const N = api()
  return N ? permissionOf(N.permission) : 'unsupported'
}

// Older Safari only takes a callback.
const ask = (N: typeof Notification) =>
  new Promise<NotificationPermission>(resolve => {
    const out = N.requestPermission(resolve)
    if (out) void out.then(resolve, () => resolve(N.permission))
  })

let baseTitle: string | null = null

// The Notification API without a service worker. Browsers that only allow notifications from a
// service worker (some mobile ones) throw on `new Notification`; those get no notice.
export const webNotifier: Notifier = {
  supported: () => api() !== null,
  permission: current,
  requestPermission: async () => {
    const N = api()
    if (!N) return 'unsupported'
    try {
      return permissionOf(await ask(N))
    } catch {
      return current()
    }
  },
  show: ({ title, body, tag, icon, renotify, onClick }) => {
    const N = api()
    if (!N || N.permission !== 'granted') return null
    try {
      const n = new N(title, { body, tag, icon, renotify } as NotificationOptions)
      n.onclick = () => {
        window.focus()
        n.close()
        onClick()
      }
      return { close: () => n.close() }
    } catch {
      return null
    }
  },
  onPermissionChange: cb => {
    let last = current()
    const check = () => {
      const now = current()
      if (now === last) return
      last = now
      cb(now)
    }
    let status: PermissionStatus | null = null
    let gone = false
    void navigator.permissions
      ?.query({ name: 'notifications' })
      .then(s => {
        if (gone) return
        status = s
        s.addEventListener('change', check)
      })
      .catch(() => {})
    window.addEventListener('focus', check)
    document.addEventListener('visibilitychange', check)
    return () => {
      gone = true
      status?.removeEventListener('change', check)
      window.removeEventListener('focus', check)
      document.removeEventListener('visibilitychange', check)
    }
  },
  setBadge: count => {
    baseTitle ??= document.title.replace(/^\(\d+\+?\) /, '')
    document.title = pingTitle(baseTitle, count)
    const nav = navigator as Navigator & {
      setAppBadge?: (n?: number) => Promise<void>
      clearAppBadge?: () => Promise<void>
    }
    const done = count > 0 ? nav.setAppBadge?.(count) : nav.clearAppBadge?.()
    void done?.catch(() => {})
  },
}
