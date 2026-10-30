import { useEffect } from 'react'
import { create } from 'zustand'
import { home, writeLocal } from './instances'
import {
  EMPTY_HOME,
  dismissTip,
  dropRecent,
  homeKey,
  homeValue,
  parseHome,
  pushRecent,
  unreadChannels,
  unreadRows,
  type HomePrefs,
  type UnreadRow,
} from './home'
import { dmPings } from './pings'
import {
  badgePings,
  dmsUnread,
  previewServer,
  railOrder,
  scopeUnread,
  serverPingCount,
  serverUnread,
  useStore,
  type RChatState,
} from './store'

interface HomeState {
  owner: string | null
  prefs: HomePrefs
}

export const useHome = create<HomeState>(() => ({ owner: null, prefs: EMPTY_HOME }))

const read = (owner: string): HomePrefs => {
  try {
    return parseHome(localStorage.getItem(home.scoped(homeKey(owner))))
  } catch {
    return EMPTY_HOME
  }
}

const save = (prefs: HomePrefs) => {
  const { owner, prefs: before } = useHome.getState()
  if (!owner || prefs === before) return
  useHome.setState({ prefs })
  writeLocal(home.scoped(homeKey(owner)), homeValue(prefs))
}

export const loadHome = (owner: string | null) =>
  useHome.setState({ owner, prefs: owner ? read(owner) : EMPTY_HOME })

export const reloadHome = () => loadHome(useHome.getState().owner)

export const forgetRecent = (key: string) => save(dropRecent(useHome.getState().prefs, key))

export const hideTip = (id: string) => save(dismissTip(useHome.getState().prefs, id))

// Records the open channel or DM as the latest visit. Previewed servers are not recorded.
export const noteVisit = (s: RChatState, now = Date.now()) => {
  const view = s.view
  if (!view || !s.me || useHome.getState().owner !== s.me.username) return
  if (previewServer(s) !== null) return
  const names =
    view.kind === 'channel'
      ? {
          channel:
            s.servers[view.server]?.channels.find(c => c.id === view.channelId)?.name ?? null,
          serverName:
            s.me.servers.find(x => x.name === view.server)?.display_name ??
            s.servers[view.server]?.display_name ??
            null,
        }
      : { channel: null, serverName: null }
  save(pushRecent(useHome.getState().prefs, view, names, now))
}

// Keeps Home's state on the signed-in account and records every view it opens.
export function useHomeSync() {
  useEffect(() => {
    const sync = (s: RChatState, prev: RChatState | null) => {
      const owner = s.me?.username ?? null
      if (owner !== useHome.getState().owner) loadHome(owner)
      if (s.view && (s.view !== prev?.view || s.me?.username !== prev?.me?.username)) noteVisit(s)
    }
    sync(useStore.getState(), null)
    return useStore.subscribe(sync)
  }, [])
}

export interface UnreadSummary {
  servers: UnreadRow[]
  dms: { pings: number; unread: boolean }
}

let summaryMemo: {
  key: unknown[]
  value: string
} | null = null

// Home's unread summary as a string, so a selector can compare it cheaply; `parseSummary` reads it.
export const unreadSummaryKey = (s: RChatState): string => {
  const key = [s.reads, s.pings, s.groupPings, s.notifyPrefs, s.me?.servers, s.servers, s.layout]
  if (summaryMemo && summaryMemo.key.every((k, i) => k === key[i])) return summaryMemo.value
  const counts = unreadChannels(s.reads, scope => scopeUnread(s, scope))
  const names = new Map((s.me?.servers ?? []).map(x => [x.name, x]))
  const order = railOrder(s).filter(n => names.has(n))
  const rows = unreadRows(
    order.map(name => ({
      name,
      pings: serverPingCount(s, name),
      channels: serverUnread(s, name) ? Math.max(1, counts[name] ?? 0) : 0,
    }))
  )
  const summary: UnreadSummary = {
    servers: rows,
    dms: { pings: dmPings(badgePings(s)), unread: dmsUnread(s) },
  }
  const value = JSON.stringify(summary)
  summaryMemo = { key, value }
  return value
}

export const parseSummary = (value: string): UnreadSummary => JSON.parse(value) as UnreadSummary
