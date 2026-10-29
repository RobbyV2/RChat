import type { NoticeOptions, Notifier, Permission } from '../platform'

export interface FakeNotifier extends Notifier {
  shown: NoticeOptions[]
  closed: string[]
  badge: number
  grant: (p: Permission) => void
}

export const fakeNotifier = (start: Permission = 'default'): FakeNotifier => {
  let perm = start
  const listeners = new Set<(p: Permission) => void>()
  const fake: FakeNotifier = {
    shown: [],
    closed: [],
    badge: 0,
    grant: p => {
      perm = p
      for (const cb of listeners) cb(p)
    },
    supported: () => perm !== 'unsupported',
    permission: () => perm,
    requestPermission: async () => {
      if (perm === 'default') fake.grant('granted')
      return perm
    },
    show: opts => {
      if (perm !== 'granted') return null
      fake.shown.push(opts)
      return { close: () => void fake.closed.push(opts.tag) }
    },
    onPermissionChange: cb => {
      listeners.add(cb)
      return () => void listeners.delete(cb)
    },
    setBadge: n => {
      fake.badge = n
    },
  }
  return fake
}
