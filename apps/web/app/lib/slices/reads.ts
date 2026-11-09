// Reads and pings: the read marks and their queue, ping badges, group pings and the unread list.

import { api } from '../instances'
import {
  addGroupPing,
  forgetGroupPings,
  groupAction,
  groupKindsFor,
  mergeGroupPings,
  onlineForHere,
  seenGroupMessages,
} from '../group_pings'
import { FRIENDS_SCOPE } from '../friends'
import type { friendsSlice } from '../friends_store'
import type { ReadMark } from '../lists'
import { mentionsUser } from '../mentions'
import { nameWithUsername } from '../display_name'
import type { AlertInput } from '../notices'
import { groupKindsShown, scopeOfKey } from '../notify'
import {
  addPing,
  clearPings,
  forgetPings,
  mergePings,
  pingAction,
  pingAlert,
  pingKey,
  pingUntil,
  setScopePings,
} from '../pings'
import { chunked, createReadQueue, markedRead, mergeReads, withThreads } from '../reads'
import { repliesToMe } from '../replies'
import {
  allMarkTargets,
  dmsMarkTargets,
  memberOf,
  previewServer,
  scopeRule,
  serversMarkTargets,
} from '../selectors'
import type { RChatState } from '../store_types'
import type { Message, Unread, WsEvent } from '../types'
import { viewKey } from '../view'
import { pageVisible, type GetState, type Handlers, type SetState } from './ctx'

export interface ReadsDeps {
  alertUser: (alert: AlertInput) => void
  detached: (key: string) => boolean
  friendsHub: Pick<ReturnType<typeof friendsSlice>, 'onPing'>
}

// A read mark from another tab or device: it never moves the mark back, and clears the pings it
// covers (a thread key only clears its pings).
export const applyReadUpdated = (
  s: RChatState,
  ev: Extract<WsEvent, { type: 'read_updated' }>
): Partial<RChatState> => {
  const until = ev.pings_until ?? 0
  if (ev.scope[0] === 't') return { pings: clearPings(s.pings, ev.scope, until) }
  const prev = s.reads[ev.scope] ?? { lastRead: 0, latest: ev.last_read }
  const lastRead = Math.max(prev.lastRead, ev.last_read)
  return {
    reads: {
      ...s.reads,
      [ev.scope]: { ...prev, lastRead, latest: Math.max(prev.latest, ev.last_read) },
    },
    pings: clearPings(s.pings, ev.scope, until),
  }
}

// The scope's ping count, replaced by the server's.
export const applyPingCount = (
  s: RChatState,
  ev: Extract<WsEvent, { type: 'ping_count' }>
): Partial<RChatState> => {
  const known = Object.values(s.pings).find(p => p.scope === ev.scope)
  return {
    pings: setScopePings(s.pings, ev.scope, known?.server ?? s.reads[ev.scope]?.server ?? null, ev),
  }
}

export const readsSlice = (set: SetState, get: GetState, deps: ReadsDeps) => {
  const { alertUser, detached, friendsHub } = deps

  // Highest ping id cleared here per key, sent as `pings_until` so the server only marks pings
  // this client showed; a ping that arrives meanwhile keeps its badge.
  const seenPings = new Map<string, number>()
  const noteSeen = (key: string, until: number) => {
    if (until > (seenPings.get(key) ?? 0)) seenPings.set(key, until)
  }

  const readQueue = createReadQueue({
    send: (scope, id) =>
      get().token ? api.postRead(scope, id, true, seenPings.get(scope) ?? 0) : Promise.resolve(),
  })

  // Clears the badge of a scope (outside threads) or of a thread (`t<root id>`) here and,
  // through POST /api/read (which marks those pings seen and echoes read_updated), on the
  // account's other tabs and devices.
  const seePings = (key: string) => {
    const until = pingUntil(get().pings[key])
    if (until === 0) return
    noteSeen(key, until)
    set(s => ({ pings: clearPings(s.pings, key, until) }))
    const lastRead = key[0] === 't' ? 0 : (get().reads[key]?.lastRead ?? 0)
    if (get().token) void api.postRead(key, lastRead, false, until).catch(() => {})
  }

  let unreadsReady: Promise<void> = Promise.resolve()

  let unreadsMore = false
  let unreadsLoading = 0
  const lateAnchor = new Set<string>()

  const placeLate = (items: Unread[]) => {
    const view = get().view
    const key = view ? viewKey(view) : null
    const item = items.find(i => i.scope === key)
    if (key && lateAnchor.has(key) && item && item.latest > item.last_read && item.last_read > 0)
      set(s => ({ unreadAnchor: { ...s.unreadAnchor, [key]: item.last_read } }))
    lateAnchor.clear()
  }

  const loadUnreads = () => {
    const before = get().reads
    const pingsBefore = get().pings
    const groupsBefore = get().groupPings
    unreadsLoading += 1
    unreadsReady = api
      .getUnreads()
      .then(({ items, more }) => {
        unreadsMore = more
        placeLate(items)
        set(s => ({
          reads: mergeReads(before, s.reads, items, readQueue.pending),
          pings: mergePings(pingsBefore, s.pings, items),
          groupPings: mergeGroupPings(groupsBefore, s.groupPings, items),
        }))
      })
      .catch(() => {})
      .finally(() => {
        unreadsLoading -= 1
        if (!unreadsLoading) lateAnchor.clear()
        if (!get().readsReady) set({ readsReady: true })
      })
    return unreadsReady
  }

  const forgetReads = (keep: (scope: string, mark: ReadMark) => boolean) =>
    set(s => {
      const entries = Object.entries(s.reads)
      const kept = entries.filter(([scope, mark]) => keep(scope, mark))
      const pings = forgetPings(
        s.pings,
        (scope, p) => !keep(scope, { lastRead: 0, latest: 0, server: p.server ?? undefined })
      )
      const groupPings = forgetGroupPings(
        s.groupPings,
        (scope, server) => !keep(scope, { lastRead: 0, latest: 0, server: server ?? undefined })
      )
      return {
        ...(kept.length === entries.length ? {} : { reads: Object.fromEntries(kept) }),
        ...(pings === s.pings ? {} : { pings }),
        ...(groupPings === s.groupPings ? {} : { groupPings }),
      }
    })

  const placeAnchor = (key: string) =>
    set(s => {
      const mark = s.reads[key]
      if (!mark && unreadsLoading) lateAnchor.add(key)
      else lateAnchor.delete(key)
      const anchor = mark && mark.latest > mark.lastRead ? mark.lastRead : 0
      return { unreadAnchor: { ...s.unreadAnchor, [key]: anchor } }
    })

  const clearAnchor = (key: string) => {
    lateAnchor.delete(key)
    set(s => (s.unreadAnchor[key] ? { unreadAnchor: { ...s.unreadAnchor, [key]: 0 } } : {}))
  }

  let groupReload: ReturnType<typeof setTimeout> | null = null
  const reloadGroups = () => {
    if (groupReload !== null) return
    groupReload = setTimeout(() => {
      groupReload = null
      if (get().me) void loadUnreads()
    }, 2000)
  }

  // A live channel message with @everyone, @here or role mentions. When it addresses you, it is
  // counted (until the channel is read past it) and toasts like a ping, through the same
  // decision as pings plus the server's suppress settings. Returns whether it was handled, so
  // no plain message toast follows; when the suppress settings hide every kind it addresses
  // you with, the plain message path ("All messages") decides instead. Nothing is stored per
  // member on the server: each client decides from the message itself. `@here` uses the
  // server's rule: you are online while connected anywhere on the site, unless you appear
  // offline, whatever server or page is open.
  const groupAlert = (m: Message, server: string): boolean => {
    const s = get()
    const me = s.me
    if (!me || m.channel_id === null || !m.group_mentions?.length) return false
    if (s.blocked[m.author.username]) return false
    const member = me.servers.some(x => x.name === server)
    const known = memberOf(s, server, me.username)
    const kinds = groupKindsFor(m, {
      username: me.username,
      member,
      online: onlineForHere(me),
      roleIds: known?.role_ids ?? null,
    })
    if (!kinds.length) {
      if (member && !known && m.group_mentions.some(g => g.kind === 'role')) reloadGroups()
      return false
    }
    const toMe =
      mentionsUser(m.content, me.username) ||
      repliesToMe(m, me.username) ||
      (m.reply_to?.partial === true && m.reply_to.mention)
    if (toMe) return true
    const scope = `c${m.channel_id}`
    set(st => ({
      groupPings: addGroupPing(st.groupPings, scope, server, { message_id: m.id, kinds }),
    }))
    const shown = groupKindsShown(s.notifyPrefs, server, kinds)
    if (!shown.length) return false
    const target = scopeOfKey(scope, server)
    const alert = pingAlert(
      { scope, thread_root_id: null },
      {
        view: s.view ? viewKey(s.view) : null,
        thread: s.panel?.kind === 'thread' ? s.panel.root.id : null,
        following: key => s.atBottom[key] === true && !detached(key),
        visible: pageVisible(),
      },
      target ? scopeRule(s, target) : undefined
    )
    if (!alert.toast) return true
    const host = s.servers[server]
    const roles = host?.roles ?? []
    const role =
      m.group_mentions
        .filter(g => g.kind === 'role' && known?.role_ids.includes(g.role_id ?? -1))
        .map(g => roles.find(r => r.id === g.role_id)?.name)
        .find(name => name !== undefined) ?? null
    const channelId = m.channel_id
    alertUser({
      key: scope,
      actor: m.author,
      action: groupAction(shown, role),
      body: m.content,
      server: host?.display_name ?? null,
      channel: host?.channels.find(c => c.id === channelId)?.name ?? null,
      dm: false,
      message: true,
      name: nameWithUsername(m.author),
      generic: 'New notification',
      go: () => void get().openChannel(server, channelId, 'push', m.id),
    })
    return true
  }

  const forget = () => {
    readQueue.clear()
    unreadsMore = false
    unreadsReady = Promise.resolve()
    lateAnchor.clear()
    seenPings.clear()
  }

  const actions: Pick<
    RChatState,
    | 'markRead'
    | 'seeThread'
    | 'markScopesRead'
    | 'markServerRead'
    | 'markServersRead'
    | 'markDmsRead'
    | 'markAllRead'
    | 'askMarkAllRead'
  > = {
    markRead: (scope, messageId) => {
      const cur = get().reads[scope]
      if (cur && messageId <= cur.lastRead) {
        seePings(scope)
        return
      }
      const until = pingUntil(get().pings[scope])
      noteSeen(scope, until)
      set(s => {
        const prev = s.reads[scope] ?? { lastRead: 0, latest: messageId }
        const lastRead = Math.max(prev.lastRead, messageId)
        return {
          reads: {
            ...s.reads,
            [scope]: { ...prev, lastRead, latest: Math.max(prev.latest, messageId) },
          },
          pings: clearPings(s.pings, scope, until),
        }
      })
      const preview = previewServer(get())
      const previewed =
        preview !== null && !!get().servers[preview]?.channels.some(c => `c${c.id}` === scope)
      if (get().token && !previewed) readQueue.mark(scope, messageId)
    },

    seeThread: rootId => seePings(`t${rootId}`),

    markScopesRead: async scopes => {
      const s = get()
      if (!s.me) return
      const keys = withThreads(scopes, s.pings)
      if (!keys.length) return
      for (const key of keys) noteSeen(key, pingUntil(s.pings[key]))
      set(st => markedRead(st.reads, st.pings, keys))
      const reads = get().reads
      for (const key of keys) if (key[0] !== 't' && get().unreadAnchor[key]) clearAnchor(key)
      if (!get().token) return
      for (const chunk of chunked(keys)) {
        const failed = await api.postReadBatch(chunk).then(
          () => false,
          () => true
        )
        for (const key of chunk) {
          const at = reads[key]?.lastRead ?? 0
          if (key[0] === 't') {
            if (failed) void api.postRead(key, 0, false, seenPings.get(key) ?? 0).catch(() => {})
          } else if (at > 0) {
            if (failed) readQueue.mark(key, at)
            else readQueue.seen(key, at)
          }
        }
      }
    },

    markServerRead: name => get().markServersRead([name]),

    markServersRead: names => get().markScopesRead(serversMarkTargets(get(), names)),

    markDmsRead: () => get().markScopesRead(dmsMarkTargets(get())),

    // The unread list is capped, so when it was cut, marking reloads it and goes on (bounded).
    markAllRead: async () => {
      await get().markScopesRead(allMarkTargets(get()))
      for (let round = 0; unreadsMore && round < 5; round += 1) {
        await loadUnreads()
        const more = allMarkTargets(get())
        if (!more.length) return
        await get().markScopesRead(more)
      }
    },

    askMarkAllRead: extra => {
      const s = get()
      const more = extra?.pending === true
      if (!s.me || (!allMarkTargets(s).length && !more)) return
      s.askConfirm({
        title: 'Mark all as read',
        body: 'Mark every channel and DM as read?',
        confirm: 'Mark as read',
        action: () => {
          void get().markAllRead()
          if (more) extra?.mark()
        },
      })
    },
  }

  const handlers = {
    read_updated: ev => {
      if (get().me?.username !== ev.username) return
      noteSeen(ev.scope, ev.pings_until ?? 0)
      if (ev.scope[0] !== 't') readQueue.seen(ev.scope, ev.last_read)
      set(s => applyReadUpdated(s, ev))
    },
    ping: ev => {
      const me = get().me
      if (!me || me.username !== ev.username) return
      const { ping } = ev
      if (ping.scope === FRIENDS_SCOPE) {
        friendsHub.onPing(ping, (go, action, actor) =>
          alertUser({
            key: FRIENDS_SCOPE,
            actor,
            action,
            body: '',
            server: null,
            channel: null,
            dm: false,
            message: false,
            name: actor.display_name,
            generic: 'New notification',
            go,
          })
        )
        return
      }
      const s = get()
      const target = scopeOfKey(ping.scope, ping.server)
      const alert = pingAlert(
        ping,
        {
          view: s.view ? viewKey(s.view) : null,
          thread: s.panel?.kind === 'thread' ? s.panel.root.id : null,
          following: key => s.atBottom[key] === true && !detached(key),
          visible: pageVisible(),
        },
        target ? scopeRule(s, target) : undefined
      )
      if (alert.badge) set(st => ({ pings: addPing(st.pings, ping) }))
      else {
        const key = pingKey(ping)
        noteSeen(key, ping.id)
        const lastRead = key[0] === 't' ? 0 : (get().reads[key]?.lastRead ?? 0)
        if (get().token) void api.postRead(key, lastRead, false, ping.id).catch(() => {})
      }
      if (!alert.toast) return
      const host = ping.server !== null ? s.servers[ping.server] : undefined
      const channel = host?.channels.find(c => `c${c.id}` === ping.scope)?.name ?? null
      alertUser({
        key: pingKey(ping),
        actor: ping.actor,
        action: pingAction(ping, null),
        body: ping.excerpt,
        server: ping.server !== null ? (host?.display_name ?? null) : null,
        channel,
        dm: ping.scope[0] === 'd',
        message: ping.kind !== 'reaction',
        name: ping.actor.display_name,
        generic: 'New notification',
        go: () => void get().openPing(ping),
      })
    },
    group_pings_seen: ev => {
      if (get().me?.username !== ev.username) return
      set(s => {
        const groupPings = seenGroupMessages(s.groupPings, ev.scope, ev.message_ids)
        return groupPings === s.groupPings ? {} : { groupPings }
      })
    },
    ping_count: ev => {
      if (get().me?.username !== ev.username) return
      set(s => applyPingCount(s, ev))
    },
  } satisfies Handlers

  return {
    handlers,
    actions,
    loadUnreads,
    ready: () => unreadsReady,
    more: () => unreadsMore,
    forgetReads,
    readQueue,
    lateAnchor,
    placeAnchor,
    clearAnchor,
    groupAlert,
    forget,
  }
}
