// Pure reads of the store state, used in component selectors and by the store itself.

import { anyDmUnread, unreadServers } from './lists'
import { dmSections, folderChildren, folderTitle, railNames, type Folder } from './nav_layout'
import {
  mutedOf,
  pingShown,
  resolve as resolveNotify,
  unreadShown,
  type NotifyPrefs,
  type NotifyScope,
} from './notify'
import { dmPings, scopePings, serverPings, shownPings, totalPings, type Pings } from './pings'
import { canChangeRole, memberPerms, rolePerms } from './rules'
import type { ConfigSource } from './config_transfer'
import type { RChatState } from './store_types'
import { ALL_PERMS } from './types'
import type { Member, Message, Role, UserRef } from './types'

const nameIndex = new WeakMap<readonly UserRef[], Map<string, UserRef>>()

export const byUsername = <T extends UserRef>(list: readonly T[]): Map<string, T> => {
  let index = nameIndex.get(list)
  if (!index) {
    index = new Map(list.map(m => [m.username, m]))
    nameIndex.set(list, index)
  }
  return index as Map<string, T>
}

export const memberState = (
  s: Pick<RChatState, 'members' | 'memberInfo'>,
  server: string,
  username: string
): Member | null | undefined => {
  const list = s.members[server]?.list
  const listed = list ? byUsername(list).get(username) : undefined
  if (listed) return listed
  const known = s.memberInfo[server]
  return known && Object.hasOwn(known, username) ? known[username] : undefined
}

export const memberOf = (s: RChatState, server: string, username: string): Member | undefined =>
  memberState(s, server, username) ?? undefined

export const serverAdminPerms = (s: RChatState, server: string): number => {
  const { me } = s
  if (!me) return 0
  const row = memberOf(s, server, me.username)
  if (row) return memberPerms(row, s.servers[server]?.roles ?? [])
  return (me.servers.find(x => x.name === server)?.is_admin ?? false) ? ALL_PERMS : 0
}

export const myRolePerms = (s: RChatState, server: string): number =>
  rolePerms(s.me ? memberOf(s, server, s.me.username) : undefined, s.servers[server]?.roles ?? [])

export const myPerms = (s: RChatState, server: string): number =>
  s.me?.is_site_admin ? ALL_PERMS : serverAdminPerms(s, server)

export const roleColor = (roles: Role[] | undefined, roleIds: number[]): string | undefined =>
  roles?.find(r => roleIds.includes(r.id))?.color

const isUnread = (s: RChatState, scope: string): boolean => {
  const r = s.reads[scope]
  return !!r && r.latest > r.lastRead
}

export const serverNames = (s: RChatState) =>
  s.me ? s.me.servers.map(x => x.name) : s.guestServers

export const configSourceOf = (s: RChatState): ConfigSource => ({
  theme: s.theme,
  streamer: s.streamer,
  appearOffline: s.me ? s.me.appear_offline : null,
  layout: s.me || s.guest ? s.layout : null,
  notify: s.me || s.guest ? s.notifyPrefs : null,
  emoji: s.me ? s.emoji : null,
  calls: s.me ? s.callRoute : null,
})

export const railOrder = (s: RChatState) => railNames(serverNames(s), s.layout.servers)

export interface RailServer {
  name: string
  display_name: string
  creator: string | null
}

type RailSource = Pick<RChatState, 'me' | 'guestServers' | 'guestNames' | 'servers'>

// The server a signed-in user previews: open without membership (only public servers; the
// server enforces it). It has a temporary rail icon and a join bar. It is forgotten when the view
// moves away.
export const previewServer = (s: RChatState): string | null => {
  const v = s.view
  if (!s.me || s.guest || v?.kind !== 'channel') return null
  return s.me.servers.some(x => x.name === v.server) ? null : v.server
}

export const railServers = (s: RailSource): RailServer[] =>
  s.me
    ? s.me.servers.map(({ name, display_name, creator }) => ({ name, display_name, creator }))
    : s.guestServers.map(name => ({
        name,
        display_name: s.servers[name]?.display_name ?? s.guestNames[name] ?? name,
        creator: s.servers[name]?.creator ?? null,
      }))

export const folderLabel = (s: RailSource, folder: Folder, name = folder.name) =>
  folderTitle(
    name,
    folderChildren(folder, new Map(railServers(s).map(x => [x.name, x.display_name])))
  )

export const dmView = (s: RChatState) => dmSections(s.dms, s.layout)

// Mutes are pruned by a timer when they end, so `notifyPrefs` changes whenever the answer does.
export const scopeMuted = (s: RChatState, scope: NotifyScope) =>
  mutedOf(s.notifyPrefs, scope, Date.now())

export const scopeRule = (s: RChatState, scope: NotifyScope) =>
  resolveNotify(s.notifyPrefs, scope, Date.now())

// Unread dots: a muted channel, DM or server shows none.
export const scopeUnread = (s: RChatState, scope: string): boolean =>
  isUnread(s, scope) &&
  unreadShown(s.notifyPrefs, scope, s.reads[scope]?.server ?? null, Date.now())

let unreadMemo: {
  reads: RChatState['reads']
  prefs: NotifyPrefs
  servers: Set<string>
} | null = null

export const serverUnread = (s: RChatState, name: string): boolean => {
  const now = Date.now()
  const prefs = s.notifyPrefs
  if (mutedOf(prefs, { kind: 'server', name }, now)) return false
  const detail = s.servers[name]
  if (detail)
    return detail.channels.some(
      c => c.kind === 'text' && isUnread(s, `c${c.id}`) && unreadShown(prefs, `c${c.id}`, name, now)
    )
  if (unreadMemo?.reads !== s.reads || unreadMemo.prefs !== prefs)
    unreadMemo = {
      reads: s.reads,
      prefs,
      servers: unreadServers(s.reads, (scope, r) =>
        unreadShown(prefs, scope, r.server ?? null, now)
      ),
    }
  return unreadMemo.servers.has(name)
}

let dmUnreadMemo: { reads: RChatState['reads']; prefs: NotifyPrefs; unread: boolean } | null = null

export const dmsUnread = (s: RChatState): boolean => {
  const prefs = s.notifyPrefs
  if (dmUnreadMemo?.reads !== s.reads || dmUnreadMemo.prefs !== prefs) {
    const now = Date.now()
    dmUnreadMemo = {
      reads: s.reads,
      prefs,
      unread: anyDmUnread(s.reads, scope => unreadShown(prefs, scope, null, now)),
    }
  }
  return dmUnreadMemo.unread
}

let pingMemo: { pings: Pings; prefs: NotifyPrefs; shown: Pings } | null = null

// The pings that badge: all of them except in scopes set to "Nothing".
export const badgePings = (s: RChatState): Pings => {
  if (pingMemo?.pings !== s.pings || pingMemo.prefs !== s.notifyPrefs) {
    const prefs = s.notifyPrefs
    pingMemo = {
      pings: s.pings,
      prefs,
      shown: shownPings(s.pings, (scope, server) => pingShown(prefs, scope, server)),
    }
  }
  return pingMemo.shown
}

export const scopePingCount = (s: RChatState, scope: string) => scopePings(badgePings(s), scope)

export const serverPingCount = (s: RChatState, name: string) => serverPings(badgePings(s), name)

export const dmPingCount = (s: RChatState) => dmPings(badgePings(s))

export const allPings = (s: RChatState) => totalPings(badgePings(s))

const messageServer = (s: RChatState, m: Message): string | null => {
  if (m.channel_id === null) return null
  const v = s.view
  if (v?.kind === 'channel' && s.servers[v.server]?.channels.some(c => c.id === m.channel_id))
    return v.server
  for (const [name, detail] of Object.entries(s.servers))
    if (detail.channels.some(c => c.id === m.channel_id)) return name
  return null
}

const knowsUser = (s: RChatState, m: Message, server: string | null, name: string) => {
  if (s.me?.username === name || m.author.username === name) return true
  if (m.dm_id !== null) return s.dms.some(d => d.id === m.dm_id && d.other.username === name)
  if (server === null) return false
  const list = s.members[server]?.list
  if (list && byUsername(list).has(name)) return true
  return !!s.memberInfo[server]?.[name]
}

// Usernames this message mentions that are known members (or DM participants), newline-joined
// so the selector result is a stable string.
export const knownMentions = (s: RChatState, m: Message, candidates: string[]) => {
  if (!candidates.length) return ''
  const server = messageServer(s, m)
  return candidates.filter(n => knowsUser(s, m, server, n)).join('\n')
}

export const userRefFor = (s: RChatState, username: string): UserRef => {
  if (s.me?.username === username) return s.me
  const dm = s.dms.find(d => d.other.username === username)
  if (dm) return dm.other
  for (const cache of Object.values(s.members)) {
    const m = byUsername(cache.list).get(username)
    if (m) return m
  }
  for (const known of Object.values(s.memberInfo)) {
    const m = Object.hasOwn(known, username) ? known[username] : null
    if (m) return m
  }
  for (const cache of Object.values(s.interacted)) {
    const u = byUsername(cache.list).get(username)
    if (u) return u
  }
  return { username, display_name: username, avatar_kind: 'identicon', avatar_color: null }
}

export const changeableRoles = (s: RChatState, server: string, username: string): Role[] => {
  const roles = s.servers[server]?.roles ?? []
  const perms = myPerms(s, server)
  const siteAdmin = s.me?.is_site_admin ?? false
  const target = memberPerms(memberOf(s, server, username), roles)
  const self = s.me?.username === username
  const held = memberOf(s, server, username)?.role_ids ?? []
  const limits = s.servers[server]?.role_limits
  const grants = limits?.channel_grants ?? []
  const denies = limits?.channel_denies ?? []
  return roles.filter(r =>
    canChangeRole(
      perms,
      siteAdmin,
      r.perms,
      held.includes(r.id),
      self,
      target,
      (held.includes(r.id) ? denies : grants).includes(r.id)
    )
  )
}
