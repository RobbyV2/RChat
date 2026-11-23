import type { InboxQuery } from './api'
import { client } from './client/client'
import type { AccountSession } from './client/session'

import { DM_PLACE, entryOf, type InboxAdapter, type InboxEntry, type InboxView } from './inbox'
import { groupKindsShown, pingShown, type NotifyPrefs } from './notify'
import { Ended } from './slices/ctx'
import type { GroupKind, InboxItem, InboxUntil } from './types'

export const INSTANCE_INBOX = 'instance'

const queryOf = (view: InboxView): InboxQuery => ({
  unread: view.unread,
  kind: view.kind ?? undefined,
  server: view.place && view.place !== DM_PLACE ? view.place : undefined,
  dms: view.place === DM_PLACE,
})

const viewKey = (view: InboxView) => `${view.unread}\n${view.kind ?? ''}\n${view.place ?? ''}`

export const untilFor = (base: InboxUntil | undefined, shown: InboxEntry[]): InboxUntil => {
  const out = { ...(base ?? { pings: 0, groups: 0, friends: 0 }) }
  for (const e of shown) {
    const item = e.raw as InboxItem
    if (item.source === 'ping') out.pings = Math.max(out.pings, item.id)
    else if (item.source === 'group') out.groups = Math.max(out.groups, item.id)
    else out.friends = Math.max(out.friends, item.id)
  }
  return out
}

// Whether an item would badge under the notification settings: not in a scope set to "Nothing",
// and for a group mention, a kind the server does not suppress. The Unread tab lists only those,
// so it agrees with the bell; All lists everything.
export const itemNotifies = (prefs: NotifyPrefs, item: InboxItem) => {
  if (item.scope === null) return true
  if (!pingShown(prefs, item.scope, item.server)) return false
  if (item.source !== 'group') return true
  const kinds = item.group_kinds?.length ? item.group_kinds : [item.kind as GroupKind]
  return groupKindsShown(prefs, item.server, kinds).length > 0
}

// Pages read at most per load while the Unread filter leaves them empty.
const EMPTY_PAGES_MAX = 5

export function createInboxSources(acct: AccountSession) {
  const { api, store } = acct
  const { canView, instanceTarget } = acct.viewing
  const { live, sessionMark } = acct.lifetime
  let disposed = false
  // The newest ids of the first page of each view, per session: "Mark all as read" goes up to them
  // (or to newer entries shown since), never past what the user saw.
  let bounds = { at: sessionMark(), views: new Map<string, InboxUntil>() }
  const shownUntil = () => {
    if (bounds.at !== sessionMark()) bounds = { at: sessionMark(), views: new Map() }
    return bounds.views
  }

  // The instance's notifications: pings, group mentions and friend pings.
  const instanceInbox: InboxAdapter = {
    id: INSTANCE_INBOX,
    canPreview: entry => {
      const item = entry.raw as InboxItem
      if (!item.server || !item.scope?.startsWith('c')) return true
      const t = instanceTarget(store.getState(), item.server, Number(item.scope.slice(1)))
      return !!t && canView(t)
    },
    previewTarget: entry => {
      const item = entry.raw as InboxItem
      if (!item.server || !item.scope?.startsWith('c')) return null
      return instanceTarget(store.getState(), item.server, Number(item.scope.slice(1)))
    },
    load: async (view, cursor) => {
      if (disposed) throw new Ended()
      const mark = sessionMark()
      let at = cursor
      for (let i = 0; ; i++) {
        const page = await live(api.inbox(queryOf(view), at))
        if (disposed || sessionMark() !== mark) throw new Ended()
        if (page.until) shownUntil().set(viewKey(view), page.until)
        for (const server of new Set(page.items.map(item => item.server))) {
          if (server)
            void store
              .getState()
              .discoverChannels(server)
              .catch(() => {})
        }
        const prefs = store.getState().notifyPrefs
        const items = view.unread ? page.items.filter(it => itemNotifies(prefs, it)) : page.items
        if (items.length || page.next === null || i + 1 >= EMPTY_PAGES_MAX)
          return { entries: items.map(it => entryOf(INSTANCE_INBOX, it)), next: page.next }
        at = page.next
      }
    },
    markRead: async entry => {
      if (disposed) throw new Ended()
      const item = entry.raw as InboxItem
      await live(api.inboxRead(item.source, item.id))
    },
    markAll: async (view, shown) => {
      if (disposed) throw new Ended()
      const until = untilFor(shownUntil().get(viewKey(view)), shown)
      await live(api.inboxReadAll(until, queryOf(view)))
    },
    open: entry => {
      if (disposed) return
      const item = entry.raw as InboxItem
      const s = store.getState()
      if (item.source === 'friend') {
        s.openFriends(item.kind === 'friend_request' ? 'pending' : 'all')
        return
      }
      if (item.scope === null || item.message_id === null) return
      return s.openPing({
        id: item.id,
        kind: 'mention',
        scope: item.scope,
        server: item.server,
        message_id: item.message_id,
        thread_root_id: item.thread_root_id,
        actor: item.actor,
        emoji: item.emoji,
        excerpt: '',
        created_at: item.created_at,
      })
    },
  }

  // Sources the inbox merges. Other sources (P2P) add theirs with `addInboxAdapter`.
  let adapters: InboxAdapter[] = [instanceInbox]

  const inboxAdapters = () => adapters

  const listeners = new Set<() => void>()
  const subscribeAdapters = (listener: () => void) => {
    if (!disposed) listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }
  const updateAdapters = (next: InboxAdapter[]) => {
    adapters = next
    for (const listener of listeners) listener()
  }

  const addInboxAdapter = (adapter: InboxAdapter) => {
    if (disposed || adapters.includes(adapter)) return
    updateAdapters([...adapters.filter(a => a.id !== adapter.id), adapter])
  }

  const removeInboxAdapter = (id: string) => {
    if (adapters.some(a => a.id === id)) updateAdapters(adapters.filter(a => a.id !== id))
  }

  const adapterCounts = () => adapters.reduce((total, a) => total + (a.count?.() ?? 0), 0)
  const subscribeCounts = (listener: () => void) => {
    const subscribe = () => adapters.flatMap(a => (a.subscribe ? [a.subscribe(listener)] : []))
    let offs = subscribe()
    const offRegistry = subscribeAdapters(() => {
      offs.forEach(off => off())
      offs = subscribe()
      listener()
    })
    return () => {
      offRegistry()
      offs.forEach(off => off())
    }
  }

  return {
    instanceInbox,
    adapterOf: (id: string) => adapters.find(a => a.id === id),
    inboxAdapters,
    subscribeAdapters,
    adapterCounts,
    subscribeCounts,
    addInboxAdapter,
    removeInboxAdapter,
    dispose() {
      disposed = true
      bounds.views.clear()
      updateAdapters([])
      listeners.clear()
    },
  }
}
export const inboxAdapters = () => client.shown().inbox.inboxAdapters()
export const addInboxAdapter = (adapter: InboxAdapter) =>
  client.shown().inbox.addInboxAdapter(adapter)
export const removeInboxAdapter = (id: string) => client.shown().inbox.removeInboxAdapter(id)
export const instanceInbox: InboxAdapter = {
  id: INSTANCE_INBOX,
  load: (...args) => client.shown().inbox.instanceInbox.load(...args),
  markAll: (...args) => client.shown().inbox.instanceInbox.markAll(...args),
  markRead: (...args) => client.shown().inbox.instanceInbox.markRead(...args),
  open: (...args) => client.shown().inbox.instanceInbox.open(...args),
  canPreview: entry => client.shown().inbox.instanceInbox.canPreview!(entry),
  previewTarget: entry => client.shown().inbox.instanceInbox.previewTarget!(entry),
}
