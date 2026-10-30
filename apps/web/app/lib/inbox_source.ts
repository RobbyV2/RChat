import type { InboxQuery } from './api'
import { api } from './instances'
import { DM_PLACE, entryOf, type InboxAdapter, type InboxEntry, type InboxView } from './inbox'
import { groupKindsShown, pingShown, type NotifyPrefs } from './notify'
import { useStore } from './store'
import type { GroupKind, InboxItem, InboxUntil } from './types'

export const INSTANCE_INBOX = 'instance'

const queryOf = (view: InboxView): InboxQuery => ({
  unread: view.unread,
  kind: view.kind ?? undefined,
  server: view.place && view.place !== DM_PLACE ? view.place : undefined,
  dms: view.place === DM_PLACE,
})

const viewKey = (view: InboxView) => `${view.unread}\n${view.kind ?? ''}\n${view.place ?? ''}`

// The newest ids of the first page of each view: "Mark all as read" goes up to them (or to
// newer entries shown since), never past what the user saw.
const shownUntil = new Map<string, InboxUntil>()

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

// The instance's notifications: pings, group mentions and friend pings.
export const instanceInbox: InboxAdapter = {
  id: INSTANCE_INBOX,
  load: async (view, cursor) => {
    let at = cursor
    for (let i = 0; ; i++) {
      const page = await api.inbox(queryOf(view), at)
      if (page.until) shownUntil.set(viewKey(view), page.until)
      const prefs = useStore.getState().notifyPrefs
      const items = view.unread ? page.items.filter(it => itemNotifies(prefs, it)) : page.items
      if (items.length || page.next === null || i + 1 >= EMPTY_PAGES_MAX)
        return { entries: items.map(it => entryOf(INSTANCE_INBOX, it)), next: page.next }
      at = page.next
    }
  },
  markRead: async entry => {
    const item = entry.raw as InboxItem
    await api.inboxRead(item.source, item.id)
  },
  markAll: async (view, shown) => {
    const until = untilFor(shownUntil.get(viewKey(view)), shown)
    await api.inboxReadAll(until, queryOf(view))
  },
  open: entry => {
    const item = entry.raw as InboxItem
    const s = useStore.getState()
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

export const inboxAdapters = () => adapters

export const addInboxAdapter = (adapter: InboxAdapter) => {
  adapters = [...adapters.filter(a => a.id !== adapter.id), adapter]
}

export const removeInboxAdapter = (id: string) => {
  adapters = adapters.filter(a => a.id !== id)
}
