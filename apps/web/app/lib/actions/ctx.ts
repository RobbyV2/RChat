import { memberState, messageServer } from '../selectors'
import { OPT_BASE } from '../slices/messages'
import { useStore } from '../store'
import type { RChatState } from '../store_types'
import type { Channel, DmSummary } from '../types'
import { threadKey, viewKey } from '../view'
import { bindActionHost } from './registry'
import type { ActionCtx, Target, Via } from './types'

// The open thread's list, else the open channel's or DM's.
export const currentList = (s: RChatState): string | null =>
  s.panel?.kind === 'thread' ? threadKey(s.panel.root.id) : s.view ? viewKey(s.view) : null

interface Place {
  server: string | null
  channel: Channel | null
  dm: DmSummary | null
}

const channelIn = (s: RChatState, server: string | null, id: number | null) =>
  server === null || id === null
    ? null
    : (s.servers[server]?.channels.find(c => c.id === id) ?? null)

const dmById = (s: RChatState, id: number | null) =>
  id === null ? null : (s.dms.find(d => d.id === id) ?? null)

const openPlace = (s: RChatState): Place => {
  const v = s.view
  if (v?.kind === 'channel')
    return { server: v.server, channel: channelIn(s, v.server, v.channelId), dm: null }
  return { server: null, channel: null, dm: v?.kind === 'dm' ? dmById(s, v.dmId) : null }
}

const placeOf = (s: RChatState, t: Target): Place => {
  switch (t.kind) {
    case 'message': {
      const server = messageServer(s, t.message)
      return {
        server,
        channel: channelIn(s, server, t.message.channel_id),
        dm: dmById(s, t.message.dm_id),
      }
    }
    case 'channel':
      return { server: t.server, channel: t.channel, dm: null }
    case 'dm':
      return { server: null, channel: null, dm: t.dm }
    case 'member':
    case 'server':
    case 'category': {
      const open = openPlace(s)
      const same = open.server !== null && open.server === t.server
      return { server: t.server, channel: same ? open.channel : null, dm: null }
    }
    case 'none':
    case 'selection':
    case 'folder':
    case 'home':
      return openPlace(s)
  }
}

const memberOf = (s: RChatState, t: Target) =>
  t.kind === 'member'
    ? t.user
    : t.kind === 'message'
      ? t.message.webhook
        ? null
        : t.message.author
      : (s.profile?.user ?? null)

export const ctxFor = (s: RChatState, target: Target, via: Via): ActionCtx => ({
  s,
  via,
  target,
  ...placeOf(s, target),
  list: target.kind === 'message' || target.kind === 'selection' ? target.list : currentList(s),
  message: target.kind === 'message' ? target.message : null,
  member: memberOf(s, target),
})

export const paletteCtx = (s: RChatState) => ctxFor(s, { kind: 'none' }, 'palette')

// New messages reach a list only while it is open, attached and caught up.
const liveList = (s: RChatState, key: string) =>
  s.wsStatus === 'green' &&
  !s.newer[key]?.more &&
  !s.stale[key] &&
  ((s.view !== null && viewKey(s.view) === key) ||
    (s.panel?.kind === 'thread' && threadKey(s.panel.root.id) === key))

// A message is gone when its loaded list lacks it inside its window, or above it while the list
// is live. A server that isn't loaded keeps the target's channel and categories.
const freshTarget = (s: RChatState, t: Target): Target | null => {
  switch (t.kind) {
    case 'message': {
      const id = t.message.id
      const list = Object.hasOwn(s.messages, t.list) ? s.messages[t.list] : null
      const root = s.panel?.kind === 'thread' && s.panel.root.id === id ? s.panel.root : null
      const fresh = list?.find(m => m.id === id) ?? root
      if (fresh) return { ...t, message: fresh }
      if (!list) return t.list === threadKey(id) ? null : t
      const last = list.at(-1)?.id ?? 0
      const inside = list.length > 0 && list[0].id < id && id < last
      const above = id > last && id < OPT_BASE && liveList(s, t.list)
      return inside || above ? null : t
    }
    case 'member':
      return t.server !== null && memberState(s, t.server, t.user.username) === null ? null : t
    case 'channel': {
      if (!s.servers[t.server]) return t
      const channel = channelIn(s, t.server, t.channel.id)
      return channel && { ...t, channel }
    }
    case 'category': {
      const all = s.servers[t.server]?.categories
      const category = all?.find(c => c.id === t.category.id)
      return !all ? t : category ? { ...t, category } : null
    }
    case 'dm': {
      const dm = dmById(s, t.dm.id)
      return dm && { ...t, dm }
    }
    case 'none':
    case 'selection':
    case 'server':
    case 'folder':
    case 'home':
      return t
  }
}

// The same context on the store's current state, or null when its target is gone.
export const refreshCtx = (ctx: ActionCtx): ActionCtx | null => {
  const s = useStore.getState()
  const t = freshTarget(s, ctx.target)
  return t && ctxFor(s, t, ctx.via)
}

bindActionHost({
  refresh: refreshCtx,
  gone: () => useStore.getState().showToast("That's no longer available"),
})
