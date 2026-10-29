import { pingTitle } from '../pings'
import type { Invoke } from './desktop'
import { permissionOf, type Notifier, type Permission } from './notifications'

// System notifications from the desktop shell. The permission comes from the notification
// plugin (macOS asks the user; other systems report granted). Clicking a notice focuses the app on
// most systems but does not call `onClick`.
export const desktopNotifier = (call: Invoke): Notifier => {
  let baseTitle: string | null = null
  let state: Permission = 'default'
  const listeners = new Set<(p: Permission) => void>()
  const settle = (raw: unknown) => {
    const next = permissionOf(raw)
    if (next !== state) {
      state = next
      for (const cb of listeners) cb(next)
    }
    return state
  }
  const refresh = () => call<string>('notify_permission').then(settle, () => state)
  void refresh()
  return {
    supported: () => true,
    permission: () => state,
    requestPermission: () => call<string>('notify_request').then(settle, () => state),
    show: ({ title, body }) => {
      if (state === 'denied') return null
      void call('notify', { title, body }).catch(() => {})
      return { close: () => {} }
    },
    onPermissionChange: cb => {
      listeners.add(cb)
      void refresh()
      return () => void listeners.delete(cb)
    },
    setBadge: count => {
      const n = Math.max(0, Math.floor(count))
      if (typeof document !== 'undefined') {
        baseTitle ??= document.title.replace(/^\(\d+\+?\) /, '')
        document.title = pingTitle(baseTitle, n)
      }
      void call('set_badge', { count: n }).catch(() => {})
    },
  }
}
