// Presence and typing: the queued presence changes and their flush, the snapshots and logs that
// newer member pages are checked against, and who is typing where.

import { home } from '../instances'
import {
  freshPresence,
  knownPresence,
  missingOnline,
  notePresence,
  presenceDelta,
  presenceSnap,
  snapOnline,
  type PresenceLog,
  type PresenceSnap,
} from '../presence'
import type { RChatState } from '../store_types'
import type { Member, WsEvent } from '../types'
import {
  IDLE,
  TYPING_TTL_MS,
  nextExpiry as nextTypingExpiry,
  nextTyping,
  pruneTypers,
  stopTyping,
  withTyper,
  type TypingMsg,
  type TypingOut,
} from '../typing'
import { mapWhere } from '../window'
import { pageVisible, type GetState, type Handlers, type SetState } from './ctx'

export type PresenceChange = {
  server: string
  username: string
  online: boolean
  online_count?: number
  seq: number
}

export const rowOnline = (s: RChatState, server: string, username: string) =>
  s.members[server]?.list.find(m => m.username === username)?.online ??
  s.memberInfo[server]?.[username]?.online

// The state after a batch of presence changes. `known` gives what each change's user was before
// it, so the online count moves only by real changes.
export const applyPresence = (
  s: RChatState,
  batch: PresenceChange[],
  known: (c: PresenceChange) => boolean | undefined
): Partial<RChatState> => {
  const byServer = new Map<string, Map<string, boolean>>()
  const delta = new Map<string, number>()
  const counts = new Map<string, number>()
  for (const c of batch) {
    if (typeof c.online_count === 'number') counts.set(c.server, c.online_count)
    const users = byServer.get(c.server) ?? new Map<string, boolean>()
    users.set(c.username, c.online)
    byServer.set(c.server, users)
    delta.set(c.server, (delta.get(c.server) ?? 0) + presenceDelta(known(c), c.online))
  }
  let servers = s.servers
  let members = s.members
  let memberInfo = s.memberInfo
  for (const [server, users] of byServer) {
    const detail = servers[server]
    if (detail) {
      const online_count =
        counts.get(server) ?? Math.max(0, detail.online_count + (delta.get(server) ?? 0))
      if (online_count !== detail.online_count)
        servers = { ...servers, [server]: { ...detail, online_count } }
    }
    const cache = members[server]
    if (cache) {
      const hit = (m: Member) => users.has(m.username) && users.get(m.username) !== m.online
      const list = mapWhere(cache.list, hit, m => ({
        ...m,
        online: users.get(m.username) ?? m.online,
      }))
      if (list !== cache.list) members = { ...members, [server]: { ...cache, list } }
    }
    const loaded = memberInfo[server]
    if (loaded) {
      let next: Record<string, Member | null> | null = null
      for (const [username, online] of users) {
        const cur = loaded[username]
        if (!cur || cur.online === online) continue
        next ??= { ...loaded }
        next[username] = { ...cur, online }
      }
      if (next) memberInfo = { ...memberInfo, [server]: next }
    }
  }
  return { servers, members, memberInfo }
}

export const presenceSlice = (set: SetState, get: GetState) => {
  const presence: PresenceChange[] = []
  const presenceLogs = new Map<string, PresenceLog>()
  const presenceSnaps = new Map<string, PresenceSnap>()
  const presenceDrops = new Map<string, number>()
  let presenceSeq = 0
  let presenceFrame = false

  const knownOnline = (server: string, username: string) => {
    const noted = knownPresence(presenceLogs.get(server), presenceSnaps.get(server), username)
    if (noted !== undefined) return noted
    return rowOnline(get(), server, username)
  }

  const flushPresence = () => {
    presenceFrame = false
    const batch = presence.splice(0)
    if (!batch.length) return
    const was = new Map<PresenceChange, boolean | undefined>()
    for (const c of batch) {
      was.set(c, knownOnline(c.server, c.username))
      const log = presenceLogs.get(c.server) ?? new Map()
      const lost = notePresence(log, c.username, c.online, c.seq)
      if (lost) presenceDrops.set(c.server, lost.seq)
      presenceLogs.set(c.server, log)
    }
    set(s => applyPresence(s, batch, c => was.get(c)))
  }

  const applySnapshot = (ev: Extract<WsEvent, { type: 'presence_snapshot' }>) => {
    flushPresence()
    presenceSeq += 1
    const snap = presenceSnap(ev.online, ev.online_count, presenceSeq)
    presenceSnaps.set(ev.server, snap)
    const fix = <T extends { username: string; online: boolean }>(m: T) => {
      const online = snapOnline(snap, m.username)
      return online === undefined || online === m.online ? m : { ...m, online }
    }
    set(s => {
      const out: Partial<RChatState> = {}
      const detail = s.servers[ev.server]
      if (detail && detail.online_count !== ev.online_count)
        out.servers = { ...s.servers, [ev.server]: { ...detail, online_count: ev.online_count } }
      const cache = s.members[ev.server]
      if (cache) {
        const list = mapWhere(cache.list, m => fix(m) !== m, fix)
        if (list !== cache.list) out.members = { ...s.members, [ev.server]: { ...cache, list } }
      }
      const known = s.memberInfo[ev.server]
      if (known) {
        let next: Record<string, Member | null> | null = null
        for (const [username, m] of Object.entries(known)) {
          if (!m || fix(m) === m) continue
          next ??= { ...known }
          next[username] = fix(m)
        }
        if (next) out.memberInfo = { ...s.memberInfo, [ev.server]: next }
      }
      return out
    })
  }

  const queuePresence = (ev: Extract<WsEvent, { type: 'presence_changed' }>) => {
    presenceSeq += 1
    const { server, username, online, online_count } = ev
    presence.push({ server, username, online, online_count, seq: presenceSeq })
    if (presenceFrame) return
    presenceFrame = true
    if (typeof requestAnimationFrame === 'function' && pageVisible())
      requestAnimationFrame(flushPresence)
    else setTimeout(flushPresence, 16)
  }

  // Member rows fetched since `since`, with the presence noted while they were in flight.
  const fresh = <T extends { username: string; online: boolean }>(
    server: string,
    rows: T[],
    since: number
  ) => freshPresence(rows, presenceLogs.get(server), presenceSnaps.get(server), since)

  // Up to `limit` names known online in `server` that no loaded or looked-up row covers.
  const missing = (server: string, limit: number) => {
    const s = get()
    return missingOnline(
      s.members[server]?.list ?? [],
      s.memberInfo[server],
      presenceLogs.get(server),
      presenceSnaps.get(server),
      limit
    )
  }

  // The seq of the newest change in `server` that its log no longer holds.
  const dropped = (server: string) => presenceDrops.get(server) ?? 0

  const forgetServer = (name: string) => {
    presenceLogs.delete(name)
    presenceSnaps.delete(name)
    presenceDrops.delete(name)
  }

  const forget = () => {
    presence.length = 0
    presenceLogs.clear()
    presenceSnaps.clear()
    presenceDrops.clear()
  }

  let outgoing: TypingOut = IDLE
  let typingTimer: ReturnType<typeof setTimeout> | null = null

  const sendTyping = (msgs: TypingMsg[]) => {
    for (const msg of msgs) home.ws.sendTyping(msg)
  }

  const armTyping = () => {
    if (typingTimer !== null) clearTimeout(typingTimer)
    typingTimer = null
    const next = nextTypingExpiry(get().typing)
    if (next === null) return
    typingTimer = setTimeout(
      () => {
        typingTimer = null
        set(s => ({ typing: pruneTypers(s.typing, Date.now()) }))
        armTyping()
      },
      Math.max(next - Date.now() + 50, 50)
    )
  }

  const forgetTyping = (sendStop: boolean) => {
    if (sendStop) sendTyping(stopTyping(outgoing))
    outgoing = IDLE
    if (typingTimer !== null) clearTimeout(typingTimer)
    typingTimer = null
    set({ typing: {} })
  }

  const noteTyper = (scope: string, username: string, name: string, on: boolean) => {
    const { typing } = get()
    const next = withTyper(
      typing,
      scope,
      username,
      on ? { name, until: Date.now() + TYPING_TTL_MS } : null
    )
    if (next === typing) return
    set({ typing: next })
    armTyping()
  }

  const noteTyping = (scope: string, active: boolean) => {
    const { typingOn, me, guest } = get()
    if (!typingOn || !me || guest) return
    const { next, send } = nextTyping(outgoing, scope, active, Date.now())
    outgoing = next
    sendTyping(send)
  }

  const handlers = {
    presence_changed: ev => {
      queuePresence(ev)
    },
    presence_snapshot: ev => {
      applySnapshot(ev)
    },
    presence_mode: ev => {
      set(s =>
        s.me?.username === ev.username ? { me: { ...s.me, appear_offline: ev.appear_offline } } : {}
      )
    },
    typing: ev => {
      const { typingOn, me, blocked } = get()
      if (!typingOn || ev.username === me?.username || blocked[ev.username]) return
      noteTyper(ev.scope, ev.username, ev.display_name, ev.until > 0)
    },
  } satisfies Handlers

  return {
    handlers,
    knownOnline,
    seq: () => presenceSeq,
    fresh,
    missing,
    dropped,
    forgetServer,
    forget,
    forgetTyping,
    noteTyper,
    noteTyping,
  }
}
