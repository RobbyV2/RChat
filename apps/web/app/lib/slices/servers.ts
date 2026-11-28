import { ownWork, persistently } from '../own_loads'
import { acceptHostedPolicy } from '../client/hosted_policy'
import type { AccountSession } from '../client/session'
// Servers and their members: server details, the member lists and lookups, channel layout
// sends, roles, bans, the admin lists, and leaving or losing a server.

import { ApiError } from '../api'
import type { PendingUpload } from '../attachments'
import { hostedBan, purgeNote } from '../durations'
import { siteSettings } from '../features'
import {
  type LayoutOrder,
  applyLayout,
  layoutOrder,
  moveCategory as moveCategoryIn,
  moveChannel as moveChannelIn,
  moveSeparator as moveSeparatorIn,
  orderLayout,
} from '../categories'
import type { FriendsDeps } from '../friends_store'

import { deniedAccess, runJoinStep } from '../join_flow'
import {
  type Pager,
  type ReadMark,
  appendUnique,
  createPager,
  insertSorted,
  keyed,
  lostServers,
  renameKey,
} from '../lists'
import { type Layout, forgetServer, keepCollapsed, renameServer, setCollapsed } from '../nav_layout'
import { type NotifyPrefs, renameServerRule, resetScope } from '../notify'
import { forgetProfile, forgetProfiles, profileKey } from '../profile'
import { lockUntil } from '../profile_reset'
import { shownParts, showsMore, withLook } from '../server_profile'
import { memberState, myPerms, previewServer } from '../selectors'
import { keepMyPerms, withChannel } from '../channel_perms'
import { EVERYONE_SUBJECT } from '../rules'
import type { Page } from '../lists'
import { HOSTED, baseBits, widened } from '../perms'
import { loadPermissionRules } from '../perms_load'
import { subjectNames, syncConfirmText } from '../categories'
import type { Paged, RChatState } from '../store_types'
import { groupFor, groupKey, mapGroups, regroup, serverGroups } from '../member_groups'
import { type RolePlaces, placeRoles, withRole, withRoleEvents } from '../role_looks'
import { localUntil, type TimeoutWire } from '../timeouts'
import { cleanTopic } from '../topic'
import {
  type ChannelPerm,
  type Member,
  type Message,
  Perm,
  type Role,
  type ServerBan,
  type ServerDetail,
  type ServerProfile,
  type ServerSummary,
  type UserRef,
  type WsEvent,
  hasPerm,
} from '../types'
import { type Nav, type View, threadKey, viewKey } from '../view'
import { type Lru, dropWhere, mapWhere } from '../window'
import {
  BANNED,
  Banned,
  LIST_MAX,
  PAGE,
  emptyPage,
  errorText,
  serverKey,
  settled,
  type GetState,
  type Handlers,
  type SetState,
} from './ctx'
import type { presenceSlice } from './presence'
import { withoutVoiceRooms } from './rtc'
import type { Secret } from '../secret'

export interface ServersDeps {
  acct: AccountSession
  act: (fn: () => Promise<void>) => Promise<void>
  noteMemberTimeouts: (
    server: string,
    members: { username: string; timeout?: TimeoutWire }[]
  ) => void
  noteTimeout: (server: string, username: string, timeout: TimeoutWire | undefined) => void
  applyMic: () => void
  askP2p: (msgs: Message[]) => void
  atHome: () => boolean
  bumpDmGen: () => void
  clearView: (nav?: Nav) => void
  dmPager: Pager
  dropEditIn: (scopes: Set<string>) => void
  dropGrant: (server: string) => void
  dropLinkCards: (id?: number) => void
  endVoiceMedia: () => void
  epochs: Record<string, number>
  expireSession: () => void
  fail: (e: unknown) => void
  forgetPending: (keep: (key: string, upload: PendingUpload) => boolean) => void
  forgetReads: (keep: (scope: string, mark: ReadMark) => boolean) => void
  forgetServerRules: (name: string) => void
  forgetViews: (keys: string[]) => void
  guestLocked: (name: string) => void
  liveKey: (key: string) => boolean
  loadPage: FriendsDeps['loadPage']
  loadUnreads: () => Promise<void>
  lockedOut: (e: unknown) => boolean
  mapLists: (
    messages: Record<string, Message[]>,
    fn: (list: Message[], key: string) => Message[]
  ) => Record<string, Message[]>
  mapTails: (fn: (list: Message[]) => Message[]) => void
  persistGrants: (grants: Record<string, Secret>) => void
  persistGuestNames: (names: Record<string, string>) => void
  persistGuestServers: (list: string[]) => void
  presenceHub: Pick<
    ReturnType<typeof presenceSlice>,
    'dropped' | 'forgetServer' | 'fresh' | 'missing' | 'seq'
  >
  reauthorLinkCards: (u: UserRef) => void
  refetchMe: () => Promise<void>
  rememberGuestName: (name: string, display: string) => void
  saveLayout: (next: Layout) => void
  saveNotify: (next: NotifyPrefs) => void
  syncUrl: (view: View | null, nav: Nav) => void
  systemNotice: (lead: string, name: string) => void
  tails: Map<string, Message[]>
  views: Lru<string>
}

// A renamed or updated server: its detail, cached lists, marks, voice, view and admin row follow
// the new name and fields.
export const applyServerChange = (
  s: RChatState,
  ev: Extract<WsEvent, { type: 'server_renamed' | 'server_updated' }>
): Partial<RChatState> => {
  const { server } = ev
  const old_name = ev.type === 'server_renamed' ? ev.old_name : server.name
  const servers = { ...s.servers }
  const detail = servers[old_name]
  if (detail) {
    delete servers[old_name]
    servers[server.name] = {
      ...detail,
      name: server.name,
      display_name: server.display_name,
      has_password: server.has_password,
      banner_color: server.banner_color ?? null,
      name_color: server.name_color ?? null,
      public_read: server.public_read ?? null,
      guest_voice: server.guest_voice === true,
      guest_chat: server.guest_chat === true,
      members_visible: server.members_visible ?? detail.members_visible,
      hide_members: server.hide_members ?? detail.hide_members,
      join_mode: server.join_mode ?? detail.join_mode,
      listed: server.listed ?? detail.listed,
      profiles_mode: server.profiles_mode ?? detail.profiles_mode,
      description: Object.hasOwn(server, 'description')
        ? (server.description ?? null)
        : detail.description,
      icon_kind: server.icon_kind ?? detail.icon_kind,
      seal: server.seal ?? detail.seal,
    }
  }
  const members = renameKey(s.members, old_name, server.name)
  const interacted = renameKey(s.interacted, old_name, server.name)
  const memberInfo = renameKey(s.memberInfo, old_name, server.name)
  const reads = Object.fromEntries(
    Object.entries(s.reads).map(([scope, mark]) => [
      scope,
      mark.server === old_name ? { ...mark, server: server.name } : mark,
    ])
  )
  const pings = Object.fromEntries(
    Object.entries(s.pings).map(([scope, p]) => [
      scope,
      p.server === old_name ? { ...p, server: server.name } : p,
    ])
  )
  const groupPings = Object.fromEntries(
    Object.entries(s.groupPings).map(([scope, g]) => [
      scope,
      g.server === old_name ? { ...g, server: server.name } : g,
    ])
  )
  const renamed = old_name !== server.name
  const voiceServers = renamed
    ? Object.fromEntries(
        Object.entries(s.voiceServers).map(([id, name]) => [
          id,
          name === old_name ? server.name : name,
        ])
      )
    : s.voiceServers
  return {
    servers,
    channelLabelEpochs: renamed
      ? renameKey(s.channelLabelEpochs, old_name, server.name)
      : s.channelLabelEpochs,
    members,
    memberInfo,
    interacted,
    reads,
    pings,
    groupPings,
    voice:
      s.voice?.server === old_name && old_name !== server.name
        ? { ...s.voice, server: server.name }
        : s.voice,
    voiceServers,
    me: s.me
      ? {
          ...s.me,
          servers: s.me.servers.map(x =>
            x.name === old_name
              ? {
                  ...x,
                  name: server.name,
                  display_name: server.display_name,
                  banner_color: server.banner_color ?? null,
                  name_color: server.name_color ?? null,
                  profiles_mode: server.profiles_mode ?? x.profiles_mode,
                  icon_kind: server.icon_kind ?? x.icon_kind,
                }
              : x
          ),
        }
      : s.me,
    view:
      s.view?.kind === 'channel' && s.view.server === old_name && old_name !== server.name
        ? { ...s.view, server: server.name }
        : s.view,
    adminServers: {
      ...s.adminServers,
      list: s.adminServers.list.map(x => (x.name === old_name ? server : x)),
    },
  }
}

// The member list of `server` without `username`.
export const dropMemberRow = (
  s: RChatState,
  server: string,
  username: string
): Partial<RChatState> => {
  const gone = (list: Member[]) => dropWhere(list, m => m.username === username)
  const hoisted = mapGroups(s.hoisted, server, gone)
  const cache = s.members[server]
  const out: Partial<RChatState> = hoisted === s.hoisted ? {} : { hoisted }
  if (!cache) return out
  const list = cache.list.filter(m => m.username !== username)
  return { ...out, members: { ...s.members, [server]: { ...cache, list } } }
}

export const serversSlice = (set: SetState, get: GetState, deps: ServersDeps) => {
  const { acct } = deps
  const home = acct.conn
  const api = acct.api
  const { live, sessionMark } = acct.lifetime
  const {
    act,
    noteMemberTimeouts,
    noteTimeout,
    applyMic,
    askP2p,
    atHome,
    bumpDmGen,
    clearView,
    dmPager,
    dropEditIn,
    dropGrant,
    dropLinkCards,
    endVoiceMedia,
    epochs,
    expireSession,
    fail,
    forgetPending,
    forgetReads,
    forgetServerRules,
    forgetViews,
    guestLocked,
    liveKey,
    loadPage,
    loadUnreads,
    lockedOut,
    mapLists,
    mapTails,
    persistGrants,
    persistGuestNames,
    persistGuestServers,
    presenceHub,
    reauthorLinkCards,
    refetchMe,
    rememberGuestName,
    saveLayout,
    saveNotify,
    syncUrl,
    systemNotice,
    tails,
    views,
  } = deps

  const serverPager = createPager<ServerSummary>({
    read: () => get().me?.servers ?? [],
    write: (servers, serversMore) =>
      set(s => (s.me ? { me: { ...s.me, servers }, serversMore } : {})),
    fetchPage: api.myServers,
    keyOf: serverKey,
    page: PAGE,
  })

  let serverGen = 0
  const droppedAt = new Map<string, number>()
  // Reorders go out one at a time per server, each with the version the previous one returned.
  // While one is pending, live layout events are skipped: the answer (or a reload) settles it.
  // When one fails, the orders queued behind it are dropped (they were built on the failed one)
  // and new ones are refused until the reload is in. They end with the session: an answer that
  // comes after it is ignored.
  const layoutSends = new Map<
    string,
    { pending: number; chain: Promise<void>; round: number; reloading: boolean }
  >()

  const sendLayout = (server: string, order: LayoutOrder) => {
    const detail = get().servers[server]
    if (!detail) return
    const slot = layoutSends.get(server) ?? {
      pending: 0,
      chain: Promise.resolve(),
      round: 0,
      reloading: false,
    }
    if (slot.reloading) return
    patchServer(server, d => applyLayout(d, orderLayout(d, order)))
    slot.pending += 1
    layoutSends.set(server, slot)
    const round = slot.round
    const live = () => layoutSends.get(server) === slot
    slot.chain = slot.chain.then(async () => {
      try {
        if (round !== slot.round || !live()) return
        const version = get().servers[server]?.layout_version ?? 0
        const layout = await api.reorderLayout(server, { ...order, version })
        if (live()) patchServer(server, d => applyLayout(d, layout))
      } catch (e) {
        if (!live()) return
        if (e instanceof ApiError && (e.status === 409 || e.status === 400)) {
          fail(new Error('The channel list changed. Try again'))
        } else fail(e)
        slot.round += 1
        slot.reloading = true
        await reloadServer(server)
        slot.reloading = false
      } finally {
        slot.pending -= 1
        if (slot.pending === 0 && live()) layoutSends.delete(server)
      }
    })
  }

  const refetchServer = (server: string) => void reloadServer(server)

  const voiceIds = (detail: ServerDetail | undefined) =>
    new Set((detail?.channels ?? []).filter(c => c.kind === 'voice').map(c => c.id))

  const reloadServer = (server: string): Promise<void> => {
    if (!get().servers[server]) return Promise.resolve()
    return fetchServer(server)
      .then(detail => {
        const before = voiceIds(get().servers[server])
        const { view } = get()
        const lost =
          view?.kind === 'channel' &&
          view.server === server &&
          !detail.channels.some(c => c.id === view.channelId)
        const next = detail.channels[0]
        if (lost && !next) {
          clearView()
          if (!get().servers[server]) return
        }
        putServer(server, detail)
        // A voice room we can see now gets its people, and what they say about their audio.
        if (get().servers[server] === detail && [...voiceIds(detail)].some(id => !before.has(id)))
          home.ws.resubscribe()
        if (lost && next) void get().openChannel(server, next.id, 'replace')
      })
      .catch(fail)
  }

  const pruneServers = async () => {
    const me = get().me
    if (!me) return
    const at = sessionMark()
    const since = serverGen
    const names = me.servers.map(x => x.name)
    const titles = new Map(me.servers.map(x => [x.name, x.display_name]))
    const joined = new Set<string>()
    for (let i = 0; i < names.length; i += LIST_MAX) {
      const batch = names.slice(i, i + LIST_MAX)
      const found = await settled(
        () => serverGen,
        () => api.myServersByName(batch)
      )
      if (at !== sessionMark()) return
      for (const x of found) joined.add(x.name)
    }
    const dropped = (name: string) => (droppedAt.get(name) ?? 0) > since
    const lost = lostServers(names, joined, dropped)
    const exists = await Promise.all(
      lost.map(name =>
        api.getServer(name).then(
          () => true,
          (e: unknown) => !(e instanceof ApiError && e.status === 404)
        )
      )
    )
    if (at !== sessionMark()) return
    lost.forEach((name, i) => {
      if (dropped(name)) return
      if (exists[i]) removedFrom(name, false, titles.get(name))
      else dropServer(name)
    })
  }

  const bannedHere = new Set<string>()
  const banCheck = (e: unknown, server: string | null | undefined) => {
    if (!server || !(e instanceof ApiError && e.status === 403 && e.message === BANNED)) return e
    bannedFrom(server)
    return new Banned(BANNED)
  }

  // Live channel and role updates can arrive while a server detail request is in flight.
  const reading = new Set<{
    server: string
    updates: Map<number, ServerDetail['channels'][number]>
    roles: Map<number, Role>
    places: RolePlaces | null
  }>()
  const responseEpoch = new WeakMap<ServerDetail, number>()
  const fetchServer = async (name: string) => {
    const epoch = get().channelLabelEpoch
    const read = {
      server: name,
      updates: new Map<number, ServerDetail['channels'][number]>(),
      roles: new Map<number, Role>(),
      places: null as RolePlaces | null,
    }
    reading.add(read)
    try {
      const detail = await live(api.getServer(name))
      bannedHere.delete(name)
      if (get().guest) rememberGuestName(detail.name, detail.display_name)
      const channels = read.updates.size
        ? {
            ...detail,
            channels: detail.channels.map(c => {
              const update = read.updates.get(c.id)
              return update ? keepMyPerms(c, update) : c
            }),
          }
        : detail
      const merged = withRoleEvents(channels, read.roles, read.places)
      responseEpoch.set(merged, epoch)
      return merged
    } catch (e) {
      if (get().guest && e instanceof ApiError && (e.status === 401 || deniedAccess(e)))
        dropGrant(name)
      throw banCheck(e, name)
    } finally {
      reading.delete(read)
    }
  }

  const ensureMembership = async (name: string) => {
    const { me, serversMore } = get()
    if (!me || !serversMore || me.servers.some(x => x.name === name)) return
    await get()
      .ensureServers([name])
      .catch(() => {})
  }

  const addServer = async (name: string) => {
    const at = sessionMark()
    await get().ensureServers([name])
    if (at !== sessionMark()) return
    if (get().me && !get().me?.servers.some(x => x.name === name)) await refetchMe()
  }

  const dropServer = (name: string) => {
    if (get().voice?.server === name) get().leaveVoice()
    serverGen += 1
    droppedAt.set(name, serverGen)
    dropLinkCards()
    const reload = serverPager.removed()
    const scopes = new Set((get().servers[name]?.channels ?? []).map(c => `c${c.id}`))
    dropEditIn(scopes)
    for (const scope of scopes) tails.delete(scope)
    forgetViews(views.keys().filter(k => scopes.has(k) && !liveKey(k)))
    forgetPending((_, upload) => !scopes.has(upload.scope))
    forgetReads((_, mark) => mark.server !== name)
    forgetMemberInfo(name)
    presenceHub.forgetServer(name)
    saveLayout(forgetServer(get().layout, name))
    forgetServerRules(name)
    set(s => ({
      servers: keyed(s.servers, name, null),
      members: keyed(s.members, name, null),
      hoisted: keyed<Record<string, Paged<Member>>>(s.hoisted, name, null),
      interacted: keyed(s.interacted, name, null),
      me: s.me ? { ...s.me, servers: s.me.servers.filter(x => x.name !== name) } : s.me,
      ...withoutVoiceRooms(
        s,
        id => s.voiceServers[id] === name || !!s.servers[name]?.channels.some(c => c.id === id)
      ),
    }))
    if (reload) void get().loadMoreServers()
    if (get().guest) {
      persistGuestServers(get().guestServers.filter(n => n !== name))
      dropGrant(name)
      home.ws.unsubscribe(name)
      if (name in get().guestNames) {
        const names = { ...get().guestNames }
        delete names[name]
        persistGuestNames(names)
      }
    }
    const { view } = get()
    if (view?.kind === 'channel' && view.server === name) void leaveForSafety()
  }

  const leaveForSafety = (nav: Nav = 'replace') => {
    if (bannedHere.has('rchat') && get().me) get().openLastDm()
    else return get().openServer('rchat', undefined, nav)
  }

  const bannedFrom = (server: string) => {
    if (bannedHere.has(server)) return
    const { view } = get()
    removedFrom(server, true)
    const stuck = view?.kind === 'channel' && view.server !== server && bannedHere.has(view.server)
    if ((!view && !atHome()) || stuck) void leaveForSafety()
  }

  const removedFrom = (server: string, banned: boolean, title?: string) => {
    if (banned) bannedHere.add(server)
    const { servers, me } = get()
    const name =
      servers[server]?.display_name ??
      me?.servers.find(x => x.name === server)?.display_name ??
      title ??
      server
    systemNotice(banned ? 'You were banned from' : 'You were removed from', name)
    dropServer(server)
  }

  // A loaded server detail; collapsed ids of categories it no longer has are dropped.
  const putServer = (name: string, detail: ServerDetail) => {
    const epoch = responseEpoch.get(detail) ?? get().channelLabelEpoch
    if (epoch !== get().channelLabelEpoch) return
    set(s => ({
      servers: { ...s.servers, [name]: detail },
      channelLabelEpochs: { ...s.channelLabelEpochs, [name]: epoch },
    }))
    saveLayout(
      keepCollapsed(
        get().layout,
        name,
        (detail.categories ?? []).map(c => c.id)
      )
    )
  }

  const patchServer = (name: string, fn: (detail: ServerDetail) => ServerDetail) => {
    set(s => {
      const detail = s.servers[name]
      return detail ? { servers: { ...s.servers, [name]: fn(detail) } } : {}
    })
  }

  const profileLocked = (e: unknown) =>
    e instanceof ApiError &&
    (e.data as { reason?: { kind?: unknown } } | undefined)?.reason?.kind === 'locked'

  const keepMyProfile = (server: string, mine: ServerProfile) =>
    patchServer(server, d => ({ ...d, my_profile: mine, profiles_mode: mine.mode }))

  // The loaded member list of `server` and its groups, through `fn`.
  const patchMembers = (server: string, fn: (list: Member[]) => Member[]) => {
    set(s => {
      const hoisted = mapGroups(s.hoisted, server, fn)
      const out: Partial<RChatState> = hoisted === s.hoisted ? {} : { hoisted }
      const cache = s.members[server]
      if (!cache) return out
      const list = fn(cache.list)
      return list === cache.list
        ? out
        : { ...out, members: { ...s.members, [server]: { ...cache, list } } }
    })
  }

  const mapPages = <T>(pages: Record<string, Paged<T>>, fn: (list: T[]) => T[]) => {
    let out: Record<string, Paged<T>> | null = null
    for (const [key, cache] of Object.entries(pages)) {
      const list = fn(cache.list)
      if (list === cache.list) continue
      out ??= { ...pages }
      out[key] = { ...cache, list }
    }
    return out ?? pages
  }

  // Leaving a previewed server forgets it: its detail, cached messages, reads and member info
  // go, so nothing of it is left once the rail icon disappears.
  const forgetPreview = (name: string) => {
    const scopes = new Set((get().servers[name]?.channels ?? []).map(c => `c${c.id}`))
    const { panel, view } = get()
    if (view?.kind === 'channel' && view.server === name) scopes.add(`c${view.channelId}`)
    const thread =
      panel?.kind === 'thread' && scopes.has(`c${panel.root.channel_id}`)
        ? [threadKey(panel.root.id)]
        : []
    dropEditIn(new Set([...scopes, ...thread]))
    forgetViews([...scopes, ...thread])
    forgetPending((_, upload) => !scopes.has(upload.scope))
    forgetReads(scope => !scopes.has(scope))
    forgetMemberInfo(name)
    presenceHub.forgetServer(name)
    set(s => {
      const servers = { ...s.servers }
      delete servers[name]
      return { servers }
    })
  }

  // Forgets the loaded groups of `server`'s member list; pages still loading are dropped.
  const forgetGroups = (server: string) => {
    for (const key of Object.keys(get().hoisted[server] ?? {}))
      epochs[`g:${server}:${key}`] = (epochs[`g:${server}:${key}`] ?? 0) + 1
    set(s =>
      s.hoisted[server]
        ? { hoisted: keyed<Record<string, Paged<Member>>>(s.hoisted, server, null) }
        : {}
    )
  }

  const leaveServerView = (next: string | null) => {
    const cur = get().view
    const prev = cur?.kind === 'channel' ? cur.server : null
    if (prev === null || prev === next) return
    if (previewServer(get()) === prev) forgetPreview(prev)
    const { activeDialog } = get()
    if (activeDialog?.kind === 'server_settings' && activeDialog.server === prev) return
    for (const id of [`m:${prev}`, `i:${prev}`]) epochs[id] = (epochs[id] ?? 0) + 1
    forgetGroups(prev)
    set(s => ({
      members: keyed(s.members, prev, null),
      interacted: keyed(s.interacted, prev, null),
    }))
  }

  const matches = (q: string, ...names: string[]) => {
    const needle = q.toLowerCase()
    return !needle || names.some(n => n.toLowerCase().includes(needle))
  }

  const writeMembers = (server: string) => (page: Paged<Member>) =>
    set(s => ({ members: { ...s.members, [server]: page } }))

  const memberGen: Record<string, number> = {}
  // Per session, like the lookups it counts.
  let memberPending = new Set<string>()
  const listSince = new Map<string, number>()
  const listScope = new Map<string, number>()
  const scopeOf = (server: string) => listScope.get(server) ?? null
  const pastOnline = new Set<string>()
  const pendingKey = (server: string, username: string) => `${server}\n${username}`

  const writeMemberInfo = (server: string, entries: [string, Member | null][]) =>
    set(s => ({
      memberInfo: {
        ...s.memberInfo,
        [server]: { ...(s.memberInfo[server] ?? {}), ...Object.fromEntries(entries) },
      },
    }))

  const mapMemberInfo = (fn: (username: string, m: Member) => Member | null) =>
    set(s => ({
      memberInfo: Object.fromEntries(
        Object.entries(s.memberInfo).map(([server, known]) => [
          server,
          Object.fromEntries(
            Object.entries(known).map(([username, m]) => [username, m ? fn(username, m) : m])
          ),
        ])
      ),
    }))

  const patchMemberInfo = (server: string, username: string, fn: (m: Member) => Member | null) =>
    set(s => {
      const known = s.memberInfo[server]
      if (!known || !Object.hasOwn(known, username)) return {}
      const cur = known[username]
      return cur
        ? { memberInfo: { ...s.memberInfo, [server]: { ...known, [username]: fn(cur) } } }
        : {}
    })

  const fetchMemberInfo = async (server: string, names: string[]) => {
    const pending = memberPending
    for (let i = 0; i < names.length; i += LIST_MAX) {
      const batch = names.slice(i, i + LIST_MAX)
      const gen = memberGen[server] ?? 0
      for (const n of batch) pending.add(pendingKey(server, n))
      let found: Member[]
      const since = presenceHub.seq()
      const rolesSince = roleSeq
      try {
        found = freshRoles(
          server,
          presenceHub.fresh(
            server,
            await live(api.membersByName(server, batch, scopeOf(server))).catch(e => {
              throw banCheck(e, server)
            }),
            since
          ),
          rolesSince
        )
      } finally {
        for (const n of batch) pending.delete(pendingKey(server, n))
      }
      if ((memberGen[server] ?? 0) !== gen) {
        if (get().servers[server]) void get().ensureMembers(server, batch)
        continue
      }
      const byName = new Map(found.map(m => [m.username, m]))
      writeMemberInfo(
        server,
        batch.map(n => [n, byName.get(n) ?? null])
      )
    }
  }

  const missedRows = new Map<string, Set<string>>()

  // Member rows the store asks for on its own account (names in a chat, a refresh): tried again
  // quietly, and a failure that stays is kept for the chat that shows those names.
  const loadMemberRows = (server: string, names: string[]) => {
    const at = sessionMark()
    const rows = ownWork(set, `members:${server}`)
    return persistently(acct.time, () => fetchMemberInfo(server, names), {
      live: () => at === sessionMark() && !!get().servers[server],
    }).then(
      () => {
        missedRows.delete(server)
        rows.came()
      },
      (error: unknown) => {
        if (at !== sessionMark() || !get().servers[server]) return
        const missed = missedRows.get(server) ?? new Set<string>()
        for (const n of names) missed.add(n)
        missedRows.set(server, missed)
        rows.refused(error)
      }
    )
  }

  const MEMBER_INFO_REFRESH = 300

  const refreshMemberInfo = (server: string) => {
    memberGen[server] = (memberGen[server] ?? 0) + 1
    const known = get().memberInfo[server]
    if (!known) return
    const kept = Object.entries(known)
      .filter(([, m]) => m !== null)
      .slice(-MEMBER_INFO_REFRESH)
    set(s => ({
      memberInfo: { ...s.memberInfo, [server]: Object.fromEntries(kept) },
      memberInfoTrim: { ...s.memberInfoTrim, [server]: (s.memberInfoTrim[server] ?? 0) + 1 },
    }))
    if (kept.length)
      void loadMemberRows(
        server,
        kept.map(([n]) => n)
      )
  }

  const forgetMemberInfo = (server: string) => {
    memberGen[server] = (memberGen[server] ?? 0) + 1
    missedRows.delete(server)
    ownWork(set, `members:${server}`).came()
    set(s => {
      if (!s.memberInfo[server]) return {}
      const memberInfo = { ...s.memberInfo }
      delete memberInfo[server]
      return { memberInfo }
    })
  }

  const onChannelChange = (
    ev: Extract<WsEvent, { type: 'channel_renamed' | 'channel_updated' }>
  ) => {
    for (const read of reading)
      if (read.server === ev.server) read.updates.set(ev.channel.id, ev.channel)
    patchServer(ev.server, d => ({
      ...d,
      channels: withChannel(d.channels, ev.channel),
    }))
  }

  // Member rows fetched while a server's mode or the site's switches left a part of the looks out:
  // fetched again once that part shows.
  const refreshLooks = (server: string) => {
    if (get().members[server]) void get().loadMembers(server, true)
    refreshMemberInfo(server)
  }

  const onServerChange = (ev: Extract<WsEvent, { type: 'server_renamed' | 'server_updated' }>) => {
    const { server } = ev
    const old_name = ev.type === 'server_renamed' ? ev.old_name : server.name
    acct.inviteUpdates.staleInvites(old_name)
    const shownBefore = shownParts(get(), old_name)
    set(s => applyServerChange(s, ev))
    saveLayout(renameServer(get().layout, old_name, server.name))
    saveNotify(renameServerRule(get().notifyPrefs, old_name, server.name))
    serverGen += 1
    const renamed = old_name !== server.name
    if (renamed) {
      droppedAt.set(old_name, serverGen)
      memberGen[old_name] = (memberGen[old_name] ?? 0) + 1
      memberGen[server.name] = (memberGen[server.name] ?? 0) + 1
    }
    if (showsMore(shownBefore, shownParts(get(), server.name))) refreshLooks(server.name)
    if (serverPager.removed()) void get().loadMoreServers()
    if (get().guest && get().guestServers.includes(old_name)) {
      persistGuestServers(get().guestServers.map(n => (n === old_name ? server.name : n)))
      const names = { ...get().guestNames, [server.name]: server.display_name }
      if (renamed) delete names[old_name]
      persistGuestNames(names)
      const grants = get().guestGrants
      if (renamed && grants[old_name]) {
        const next = { ...grants, [server.name]: grants[old_name] }
        delete next[old_name]
        persistGrants(next)
      }
      if (renamed) {
        home.ws.unsubscribe(old_name)
        home.ws.subscribe([server.name])
      }
      if (server.has_password)
        void api.getServer(server.name).catch((e: unknown) => {
          if (lockedOut(e)) guestLocked(server.name)
        })
    }
    const renamedView = get().view
    if (renamed && renamedView?.kind === 'channel' && renamedView.server === server.name)
      syncUrl(renamedView, 'replace')
  }

  const onMemberGone = (ev: Extract<WsEvent, { type: 'member_left' | 'member_kicked' }>) => {
    acct.inviteUpdates.staleInvites(ev.server)
    const banned = ev.type === 'member_kicked' && ev.banned
    if (get().me?.username === ev.username) {
      if (ev.type === 'member_kicked') removedFrom(ev.server, banned)
      else dropServer(ev.server)
      return
    }
    if (banned && get().bans[ev.server]) void get().loadBans(ev.server, true)
    patchServer(ev.server, d => ({
      ...d,
      member_count: Math.max(0, d.member_count - 1),
    }))
    set(s => dropMemberRow(s, ev.server, ev.username))
    if (Object.hasOwn(get().memberInfo[ev.server] ?? {}, ev.username))
      writeMemberInfo(ev.server, [[ev.username, null]])
  }

  // Role changes by server and member, newest last, so rows a request read before a change
  // arrived take the roles it carries.
  const ROLE_LOG_MAX = 500
  let roleSeq = 0
  const roleLog = new Map<string, Map<string, { seq: number; role_ids: number[] }>>()
  const noteRoles = (server: string, username: string, role_ids: number[]) => {
    const log = roleLog.get(server) ?? new Map<string, { seq: number; role_ids: number[] }>()
    roleLog.set(server, log)
    log.delete(username)
    log.set(username, { seq: (roleSeq += 1), role_ids })
    if (log.size > ROLE_LOG_MAX) log.delete(log.keys().next().value!)
  }
  const rolesAfter = (server: string, username: string, since: number) => {
    const change = roleLog.get(server)?.get(username)
    return change && change.seq > since ? change.role_ids : null
  }
  const freshRoles = (server: string, rows: Member[], since: number) =>
    rows.map(m => {
      const role_ids = rolesAfter(server, m.username, since)
      return role_ids ? { ...m, role_ids } : m
    })

  // Moves `username` to the loaded page of the group they show in now. False when that page is
  // loaded and their row is not known anywhere.
  const regroupMember = (server: string, username: string, roleIds: number[]) => {
    const s = get()
    const pages = s.hoisted[server]
    if (!pages) return true
    const groups = serverGroups(s.servers[server]?.roles)
    const row =
      Object.values(pages)
        .flatMap(p => p.list)
        .find(m => m.username === username) ??
      memberState(s, server, username) ??
      undefined
    const next = regroup(pages, groups, username, row)
    if (next !== pages) set(st => ({ hoisted: { ...st.hoisted, [server]: next } }))
    return row !== undefined || !pages[groupFor(groups, roleIds)]
  }

  const forget = () => {
    roleLog.clear()
    memberPending = new Set()
    bannedHere.clear()
    listSince.clear()
    pastOnline.clear()
    layoutSends.clear()
    reading.clear()
    discoveries.clear()
  }

  const discoveries = new Map<string, Promise<void>>()
  const actions: Pick<
    RChatState,
    | 'loadMoreServers'
    | 'discoverChannels'
    | 'ensureServers'
    | 'createServer'
    | 'joinServer'
    | 'joinPreview'
    | 'leaveServer'
    | 'renameServer'
    | 'deleteServer'
    | 'createChannel'
    | 'createCategory'
    | 'renameCategory'
    | 'deleteCategory'
    | 'createSeparator'
    | 'editSeparator'
    | 'deleteSeparator'
    | 'moveChannel'
    | 'moveSeparator'
    | 'moveCategory'
    | 'setCategoriesCollapsed'
    | 'renameChannel'
    | 'setSlowmode'
    | 'setChannelRestrict'
    | 'setChannelSensitive'
    | 'setChannelTextOnly'
    | 'setChannelTopic'
    | 'deleteChannel'
    | 'kickMember'
    | 'timeoutMember'
    | 'removeTimeout'
    | 'loadMyProfile'
    | 'saveMyProfile'
    | 'clearMyProfile'
    | 'setMyProfilePicture'
    | 'removeMyProfilePicture'
    | 'resetMemberProfile'
    | 'unlockMemberProfile'
    | 'noteProfileLock'
    | 'disconnectGuest'
    | 'muteGuest'
    | 'banMember'
    | 'unbanMember'
    | 'loadBans'
    | 'grantAdmin'
    | 'revokeAdmin'
    | 'transferAdmin'
    | 'setAdminPerms'
    | 'createRole'
    | 'updateRole'
    | 'deleteRole'
    | 'setRoleOrder'
    | 'setRoleDisplay'
    | 'setEveryonePerms'
    | 'confirmRoleOrder'
    | 'assignRole'
    | 'unassignRole'
    | 'setChannelPerm'
    | 'clearChannelPerm'
    | 'setCategoryPerm'
    | 'clearCategoryPerm'
    | 'syncChannelPerms'
    | 'adminDeleteUser'
    | 'adminRemovePhrase'
    | 'adminSignOut'
    | 'adminDeleteMessage'
    | 'loadMembers'
    | 'loadGroup'
    | 'clearGroups'
    | 'scopeMembers'
    | 'loadInteracted'
    | 'ensureMembers'
    | 'retryMemberRows'
    | 'loadMissingOnline'
    | 'rememberMember'
    | 'notePresence'
    | 'refreshMember'
    | 'loadAdminOverview'
    | 'loadAdminServers'
    | 'adminDeleteServer'
    | 'banUser'
    | 'updateSettings'
  > = {
    loadMoreServers: () =>
      act(async () => {
        if (get().me && get().serversMore) await serverPager.load()
      }),

    discoverChannels: (name, refresh = false) => {
      const s = get()
      if (!refresh && s.servers[name] && (s.channelLabelEpochs[name] ?? 0) === s.channelLabelEpoch)
        return Promise.resolve()
      const key = JSON.stringify([s.channelLabelEpoch, name])
      const pending = discoveries.get(key)
      if (pending) return pending
      const request = fetchServer(name)
        .then(detail => {
          if (discoveries.get(key) === request) putServer(name, detail)
        })
        .finally(() => {
          if (discoveries.get(key) === request) discoveries.delete(key)
        })
      discoveries.set(key, request)
      return request
    },
    ensureServers: async names => {
      const me = get().me
      if (!me) return
      const at = sessionMark()
      const have = new Set(me.servers.map(x => x.name))
      const missing = [...new Set(names.map(n => n.toLowerCase()))].filter(n => n && !have.has(n))
      for (let i = 0; i < missing.length; i += LIST_MAX) {
        const batch = missing.slice(i, i + LIST_MAX)
        const found = await settled(
          () => serverGen,
          () => api.myServersByName(batch)
        )
        if (at !== sessionMark()) return
        set(s =>
          s.me ? { me: { ...s.me, servers: appendUnique(s.me.servers, found, serverKey) } } : {}
        )
      }
    },

    createServer: async (name, password) => {
      const { name: id } = await live(api.createServer(name, password))
      await live(addServer(id).catch(fail))
      await get().openServer(id)
    },

    joinServer: async (name, password, nav = 'push') => {
      const { name: id } = await live(api.joinServer(name.trim().toLowerCase(), password))
      await live(addServer(id).catch(fail))
      const { view } = get()
      const here = view?.kind === 'channel' && view.server === id ? view.channelId : undefined
      await get().openServer(id, here, here === undefined ? nav : 'replace')
    },

    // Join from the preview tile's menu: the JoinBar's steps, with the password asked in the
    // join dialog when the server wants one.
    joinPreview: async name => {
      const at = sessionMark()
      const out = await runJoinStep('name', '', pw => get().joinServer(name, pw), errorText)
      if (out.done || at !== sessionMark()) return
      if (out.step === 'password')
        get().openDialog({ kind: 'add_server', join: name, locked: true })
      else get().setError(out.error)
    },

    leaveServer: name =>
      act(async () => {
        if (get().guest) {
          persistGuestServers(get().guestServers.filter(n => n !== name))
        } else {
          await live(api.leaveServer(name))
        }
        dropServer(name)
      }),

    renameServer: async (name, newName) =>
      void (await live(api.updateServer(name, { name: newName }))),
    deleteServer: name => act(async () => void (await api.deleteServer(name))),
    createChannel: (server, name, kind = 'text', category = null, textOnly = false) =>
      act(async () => void (await api.createChannel(server, name, kind, category, textOnly))),
    createCategory: (server, name) =>
      act(async () => void (await api.createCategory(server, name))),
    renameCategory: (id, name, style) =>
      act(async () => void (await api.renameCategory(id, name, style))),
    deleteCategory: id => act(async () => void (await api.deleteCategory(id))),
    createSeparator: (server, label, style, category) =>
      act(async () => void (await api.createSeparator(server, label, style, category))),
    editSeparator: (id, patch) => act(async () => void (await api.editSeparator(id, patch))),
    deleteSeparator: id => act(async () => void (await api.deleteSeparator(id))),
    moveChannel: (server, id, category, index) => {
      const detail = get().servers[server]
      if (detail) sendLayout(server, moveChannelIn(layoutOrder(detail), id, category, index))
    },
    moveSeparator: (server, id, category, index) => {
      const detail = get().servers[server]
      if (detail) sendLayout(server, moveSeparatorIn(layoutOrder(detail), id, category, index))
    },
    moveCategory: (server, id, index) => {
      const detail = get().servers[server]
      if (detail) sendLayout(server, moveCategoryIn(layoutOrder(detail), id, index))
    },
    setCategoriesCollapsed: (server, ids, collapsed) =>
      saveLayout(setCollapsed(get().layout, server, ids, collapsed)),
    renameChannel: (id, name) => act(async () => void (await api.updateChannel(id, { name }))),
    setSlowmode: (id, seconds) =>
      act(async () => void (await api.updateChannel(id, { slowmode_seconds: seconds }))),
    setChannelRestrict: (id, patch) => act(async () => void (await api.updateChannel(id, patch))),
    setChannelTextOnly: (server, id, text_only) =>
      act(async () => {
        const channel = await live(api.updateChannel(id, { text_only }))
        onChannelChange({ type: 'channel_updated', server, channel })
      }),
    setChannelSensitive: (server, id, sensitive) =>
      act(async () => {
        const channel = await live(api.updateChannel(id, { sensitive }))
        onChannelChange({ type: 'channel_updated', server, channel })
      }),
    setChannelTopic: async (server, id, topic) => {
      try {
        const channel = await live(api.updateChannel(id, { topic: cleanTopic(topic) || null }))
        patchServer(server, d => ({
          ...d,
          channels: withChannel(d.channels, channel),
        }))
        return null
      } catch (e) {
        return errorText(e)
      }
    },
    deleteChannel: id => act(async () => void (await api.deleteChannel(id))),
    kickMember: (server, username, reason) =>
      act(async () => void (await api.kickMember(server, username, reason))),
    timeoutMember: async (server, username, seconds, reason) => {
      try {
        const t = await live(api.timeoutMember(server, username, seconds, reason.trim() || null))
        noteTimeout(server, username, t)
        return true
      } catch (e) {
        fail(e)
        return false
      }
    },
    removeTimeout: (server, username) =>
      act(async () => {
        await live(api.removeTimeout(server, username))
        noteTimeout(server, username, undefined)
      }),
    loadMyProfile: async server => {
      try {
        const mine = await live(api.serverProfile(server))
        keepMyProfile(server, mine)
        return mine
      } catch {
        return null
      }
    },
    saveMyProfile: async (server, patch) => {
      try {
        keepMyProfile(server, await live(api.setServerProfile(server, patch)))
        return null
      } catch (e) {
        if (profileLocked(e)) void get().loadMyProfile(server)
        return errorText(e)
      }
    },
    clearMyProfile: async server => {
      try {
        keepMyProfile(server, await live(api.resetServerProfile(server)))
        return null
      } catch (e) {
        if (profileLocked(e)) void get().loadMyProfile(server)
        return errorText(e)
      }
    },
    setMyProfilePicture: async (server, file, crop) => {
      try {
        keepMyProfile(server, await live(api.putProfileAvatar(server, file, crop)))
        return null
      } catch (e) {
        if (profileLocked(e)) void get().loadMyProfile(server)
        return errorText(e)
      }
    },
    removeMyProfilePicture: async server => {
      try {
        keepMyProfile(server, await live(api.deleteProfileAvatar(server)))
        return null
      } catch (e) {
        if (profileLocked(e)) void get().loadMyProfile(server)
        return errorText(e)
      }
    },
    noteProfileLock: (server, username, until) =>
      set(s => {
        const { [username]: had, ...rest } = s.profileLocks[server] ?? {}
        if (typeof until !== 'number') {
          return had === undefined ? {} : { profileLocks: { ...s.profileLocks, [server]: rest } }
        }
        return had === until
          ? {}
          : { profileLocks: { ...s.profileLocks, [server]: { ...rest, [username]: until } } }
      }),
    resetMemberProfile: async (server, username, fields, secs, reason) => {
      try {
        await live(api.resetMemberProfile(server, username, fields, secs, reason))
        forgetProfile(profileKey(username, server), sessionMark())
        if (secs !== null)
          get().noteProfileLock(
            server,
            username,
            lockUntil(secs, Math.floor(acct.time.now() / 1000))
          )
        return null
      } catch (e) {
        return errorText(e)
      }
    },
    unlockMemberProfile: (server, username) =>
      act(async () => {
        await live(api.unlockMemberProfile(server, username))
        forgetProfile(profileKey(username, server), sessionMark())
        get().noteProfileLock(server, username, null)
      }),
    disconnectGuest: (server, name) =>
      act(async () => void (await api.disconnectGuest(server, name))),
    muteGuest: (server, name, muted) =>
      act(async () => void (await api.muteGuest(server, name, muted))),
    banMember: async (server, username, choice) => {
      const at = sessionMark()
      try {
        const done = await live(api.banMember(server, username, hostedBan(choice)))
        const note = purgeNote(done)
        if (note) get().showToast(note)
        if (get().bans[server]) await get().loadBans(server, true)
        return true
      } catch (e) {
        if (at === sessionMark()) fail(e)
        return false
      }
    },
    unbanMember: (server, username) =>
      act(async () => {
        await live(api.unbanMember(server, username))
        const id = `b:${server}`
        epochs[id] = (epochs[id] ?? 0) + 1
        set(s => {
          const cache = s.bans[server]
          if (!cache) return {}
          const list = cache.list.filter(b => b.username !== username)
          return { bans: { ...s.bans, [server]: { ...cache, list, loading: false } } }
        })
      }),
    loadBans: (server, reset = false) =>
      act(() =>
        loadPage(
          `b:${server}`,
          () => get().bans[server] ?? emptyPage<ServerBan>(),
          page => set(s => ({ bans: { ...s.bans, [server]: page } })),
          cursor => api.listBans(server, cursor),
          b => b.username,
          '',
          reset
        )
      ),
    grantAdmin: (server, username) =>
      act(async () => void (await api.grantAdmin(server, username))),
    revokeAdmin: (server, username) =>
      act(async () => void (await api.revokeAdmin(server, username))),
    transferAdmin: (server, username) =>
      act(async () => void (await api.transferAdmin(server, username))),
    setAdminPerms: (server, username, perms) =>
      act(async () => void (await api.setAdminPerms(server, username, perms))),
    createRole: (server, body) => act(async () => void (await api.createRole(server, body))),
    updateRole: (server, id, patch) =>
      act(async () => void (await api.updateRole(server, id, patch))),
    deleteRole: (server, id) => act(async () => void (await api.deleteRole(server, id))),
    setRoleOrder: (server, order, version) =>
      act(async () => void (await api.setRoleOrder(server, order, version))),
    setRoleDisplay: (server, order, version) =>
      act(async () => {
        if (order === null) await api.followRoleOrder(server, version)
        else await api.setRoleDisplay(server, order, version)
      }),
    setEveryonePerms: (server, perms, mask) =>
      act(async () => void (await api.setEveryonePerms(server, perms, mask))),
    confirmRoleOrder: (server, version) =>
      act(async () => void (await api.confirmRoleOrder(server, version))),
    assignRole: (server, id, username) =>
      act(async () => void (await api.assignRole(server, id, username))),
    unassignRole: (server, id, username) =>
      act(async () => void (await api.unassignRole(server, id, username))),
    setChannelPerm: (id, perm) => act(async () => void (await api.setChannelPerm(id, perm))),
    clearChannelPerm: (id, subject) =>
      act(async () => void (await api.clearChannelPerm(id, subject))),
    setCategoryPerm: (id, rule) => act(async () => void (await api.setCategoryPerm(id, rule))),
    clearCategoryPerm: (id, subject) =>
      act(async () => void (await api.clearCategoryPerm(id, subject))),
    syncChannelPerms: (server, id) =>
      act(async () => {
        const detail = get().servers[server]
        const channel = detail?.channels.find(c => c.id === id)
        const category = detail?.categories?.find(c => c.id === channel?.category_id)
        if (!detail || !channel || !category) return
        await live(loadPermissionRules())
        const every = async (page: (cursor: string | null) => Promise<Page<ChannelPerm>>) => {
          const out: ChannelPerm[] = []
          let cursor: string | null = null
          do {
            const next: Page<ChannelPerm> = await live(page(cursor))
            out.push(...next.items)
            cursor = next.next
          } while (cursor !== null)
          return out
        }
        const [before, after] = await Promise.all([
          every(cursor => api.channelPerms(id, cursor)),
          every(cursor => api.categoryPerms(category.id, cursor)),
        ])
        const rules = (list: ChannelPerm[]) =>
          list.map(r => ({
            subject: r.subject,
            allow: r.allow ?? 0n,
            deny: r.deny ?? 0n,
            merge: r.mode === 'merge',
          }))
        const members = [...new Set([...before, ...after].map(r => r.subject))]
          .filter(s => s.startsWith('u:'))
          .map(s => s.slice(2))
        await get().ensureMembers(server, members)
        const held = Object.fromEntries(
          members.map(name => [
            `u:${name}`,
            (memberState(get(), server, name)?.role_ids ?? []).map(r => `r:${r}`),
          ])
        )
        const subjects = widened(
          rules(before),
          rules(after),
          { subject: EVERYONE_SUBJECT, bits: detail.everyone_perms ?? baseBits() },
          Object.fromEntries(detail.roles.map(r => [`r:${r.id}`, r.perms])),
          held,
          {
            restrictView: !!channel.restrict_view,
            restrictSend: !!channel.restrict_send,
            voice: channel.kind === 'voice',
          },
          HOSTED
        )
        const confirmed = () => void act(async () => void (await api.syncChannelPerms(id, true)))
        const ask = (names: string[] | null) =>
          get().askConfirm({
            title: 'Sync Permissions',
            body: names
              ? syncConfirmText(category.name, `#${channel.name}`, names)
              : `Syncing with ${category.name} lets more people see or send in #${channel.name}.`,
            confirm: 'Sync',
            action: confirmed,
          })
        if (!subjects.length) {
          try {
            return void (await live(api.syncChannelPerms(id, false)))
          } catch (e) {
            if (!(e instanceof ApiError && e.status === 409)) throw e
            return ask(null)
          }
        }
        const nameOf = (subject: string) =>
          subject === EVERYONE_SUBJECT
            ? '@everyone'
            : subject.startsWith('r:')
              ? (detail.roles.find(r => `r:${r.id}` === subject)?.name ?? 'a role')
              : get().streamer
                ? 'a member'
                : (memberState(get(), server, subject.slice(2))?.display_name ?? subject.slice(2))
        ask(subjectNames(subjects, nameOf))
      }),
    adminDeleteUser: username => act(async () => void (await api.adminDeleteUser(username))),
    adminRemovePhrase: username =>
      act(async () => {
        const { removed } = await live(api.adminRemovePhrase(username))
        get().showToast(removed ? 'Backup phrase removed' : 'No backup phrase was set')
      }),
    adminSignOut: username =>
      act(async () => {
        await live(api.adminSignOut(username))
        get().showToast('Signed out everywhere')
      }),
    adminDeleteMessage: id => act(async () => void (await api.adminDeleteMessage(id))),

    loadMembers: (server, reset = false) =>
      act(() =>
        loadPage(
          `m:${server}`,
          () => get().members[server] ?? emptyPage<Member>(),
          writeMembers(server),
          async cursor => {
            const since = presenceHub.seq()
            const rolesSince = roleSeq
            if (cursor === null) listSince.set(server, since)
            const page = await live(api.listMembers(server, cursor, {}, scopeOf(server))).catch(
              e => {
                throw banCheck(e, server)
              }
            )
            if (page.items.at(-1)?.online === false) pastOnline.add(server)
            else pastOnline.delete(server)
            noteMemberTimeouts(server, page.items)
            return {
              ...page,
              items: freshRoles(server, presenceHub.fresh(server, page.items, since), rolesSince),
            }
          },
          m => m.username,
          '',
          reset
        )
      ),

    loadGroup: (server, group, reset = false, limit = PAGE) =>
      act(() => {
        const key = groupKey(group)
        return loadPage(
          `g:${server}:${key}`,
          () => get().hoisted[server]?.[key] ?? emptyPage<Member>(),
          page =>
            set(s => ({
              hoisted: { ...s.hoisted, [server]: { ...(s.hoisted[server] ?? {}), [key]: page } },
            })),
          async cursor => {
            const since = presenceHub.seq()
            const rolesSince = roleSeq
            const page = await live(
              api.listGroup(server, group, cursor, cursor === null ? limit : PAGE, scopeOf(server))
            ).catch(e => {
              throw banCheck(e, server)
            })
            noteMemberTimeouts(server, page.items)
            // A member whose roles changed while the page loaded may show in another group now.
            const groups = serverGroups(get().servers[server]?.roles)
            const items = presenceHub.fresh(server, page.items, since).flatMap(m => {
              const role_ids = rolesAfter(server, m.username, rolesSince)
              if (!role_ids) return [m]
              return groupFor(groups, role_ids) === key ? [{ ...m, role_ids }] : []
            })
            return { ...page, items }
          },
          m => m.username,
          '',
          reset
        )
      }),

    clearGroups: server => forgetGroups(server),

    scopeMembers: (server, channel) => {
      if (channel === null) listScope.delete(server)
      else listScope.set(server, channel)
    },

    loadInteracted: (server, reset = false) =>
      act(() =>
        loadPage(
          `i:${server}`,
          () => get().interacted[server] ?? emptyPage<UserRef>(),
          page => set(s => ({ interacted: { ...s.interacted, [server]: page } })),
          cursor =>
            live(api.listInteracted(server, cursor, scopeOf(server))).catch(e => {
              throw banCheck(e, server)
            }),
          u => u.username,
          '',
          reset
        )
      ),

    ensureMembers: async (server, usernames) => {
      const s = get()
      const known = s.memberInfo[server] ?? {}
      const listed = new Set((s.members[server]?.list ?? []).map(m => m.username))
      const missing = [...new Set(usernames)].filter(
        n =>
          n !== '' &&
          !Object.hasOwn(known, n) &&
          !listed.has(n) &&
          !memberPending.has(pendingKey(server, n))
      )
      if (missing.length) await loadMemberRows(server, missing)
    },

    retryMemberRows: server => {
      const names = [...(missedRows.get(server) ?? [])]
      missedRows.delete(server)
      ownWork(set, `members:${server}`).came()
      if (names.length) void loadMemberRows(server, names)
    },

    loadMissingOnline: async server => {
      const names = presenceHub.missing(server, PAGE)
      if (names.length) await get().ensureMembers(server, names)
      else if (
        (!get().members[server]?.hasMore || pastOnline.has(server)) &&
        presenceHub.dropped(server) > (listSince.get(server) ?? 0)
      )
        await get().loadMembers(server, true)
    },

    rememberMember: (server, username, member) => writeMemberInfo(server, [[username, member]]),

    notePresence: (server, username, online) =>
      set(s => {
        const out: Partial<RChatState> = {}
        const hoisted = mapGroups(s.hoisted, server, list =>
          mapWhere(
            list,
            m => m.username === username && m.online !== online,
            m => ({ ...m, online })
          )
        )
        if (hoisted !== s.hoisted) out.hoisted = hoisted
        const cache = s.members[server]
        if (cache) {
          const list = mapWhere(
            cache.list,
            m => m.username === username && m.online !== online,
            m => ({ ...m, online })
          )
          if (list !== cache.list) out.members = { ...s.members, [server]: { ...cache, list } }
        }
        const cur = s.memberInfo[server]?.[username]
        if (cur && cur.online !== online)
          out.memberInfo = {
            ...s.memberInfo,
            [server]: { ...s.memberInfo[server], [username]: { ...cur, online } },
          }
        return out
      }),

    refreshMember: async (server, username) => {
      let found: Member | undefined
      try {
        found = (await live(api.membersByName(server, [username], scopeOf(server))))[0]
      } catch {
        return
      }
      writeMemberInfo(server, [[username, found ?? null]])
      if (found) {
        const fresh = found
        patchMembers(server, list => list.map(m => (m.username === username ? fresh : m)))
      }
    },

    loadAdminOverview: () =>
      act(async () => {
        set({ adminOverview: await live(api.adminOverview()) })
      }),

    loadAdminServers: (q, reset = false) =>
      act(() =>
        loadPage(
          'admin_servers',
          () => get().adminServers,
          adminServers => set({ adminServers }),
          cursor => api.adminServers(cursor, q),
          sv => sv.name,
          q,
          reset
        )
      ),

    adminDeleteServer: name => act(async () => void (await api.adminDeleteServer(name))),

    banUser: username => act(async () => void (await api.banUser(username))),

    updateSettings: patch =>
      act(async () => {
        const mark = sessionMark()
        const origin = home.origin
        const settings = siteSettings(await api.patchSettings(patch))
        if (mark !== sessionMark() || origin !== home.origin) return
        set({ settings })
        acceptHostedPolicy(home.origin, settings.client_other_instances)
      }),
  }

  const handlers = {
    channel_created: ev => {
      patchServer(ev.server, d =>
        d.channels.some(c => c.id === ev.channel.id)
          ? d
          : { ...d, channels: [...d.channels, ev.channel] }
      )
    },
    channel_renamed: onChannelChange,
    channel_updated: onChannelChange,
    channel_deleted: ev => {
      dropLinkCards()
      saveNotify(
        resetScope(get().notifyPrefs, { kind: 'channel', id: ev.channel_id, server: null })
      )
      patchServer(ev.server, d => ({
        ...d,
        channels: d.channels.filter(c => c.id !== ev.channel_id),
      }))
      if (get().voice?.channelId === ev.channel_id) endVoiceMedia()
      set(s => withoutVoiceRooms(s, id => id === ev.channel_id))
      forgetReads(scope => scope !== `c${ev.channel_id}`)
      forgetPending((_, upload) => upload.scope !== `c${ev.channel_id}`)
      tails.delete(`c${ev.channel_id}`)
      dropEditIn(new Set([`c${ev.channel_id}`]))
      if (!liveKey(`c${ev.channel_id}`)) forgetViews([`c${ev.channel_id}`])
      const { view, servers } = get()
      if (view?.kind === 'channel' && view.channelId === ev.channel_id) {
        const next = servers[ev.server]?.channels[0]
        if (next) void get().openChannel(ev.server, next.id, 'replace')
        else {
          clearView()
        }
      }
    },
    server_created: ev => {
      set(s => ({
        adminOverview: s.adminOverview
          ? { ...s.adminOverview, server_count: s.adminOverview.server_count + 1 }
          : s.adminOverview,
        adminServers:
          (s.adminServers.list.length > 0 || !s.adminServers.hasMore) &&
          matches(s.adminServers.q, ev.server.name, ev.server.display_name)
            ? {
                ...s.adminServers,
                list: insertSorted(
                  s.adminServers.list,
                  ev.server,
                  (a, b) => a.name.localeCompare(b.name),
                  x => x.name,
                  s.adminServers.hasMore
                ),
              }
            : s.adminServers,
      }))
    },
    server_renamed: onServerChange,
    server_updated: onServerChange,
    server_deleted: ev => {
      acct.inviteUpdates.staleInvites(ev.name)
      dropServer(ev.name)
      set(s => ({
        adminOverview: s.adminOverview
          ? { ...s.adminOverview, server_count: Math.max(0, s.adminOverview.server_count - 1) }
          : s.adminOverview,
        adminServers: {
          ...s.adminServers,
          list: s.adminServers.list.filter(x => x.name !== ev.name),
        },
      }))
    },
    server_banned: ev => {
      acct.inviteUpdates.staleInvites(ev.server)
      const { me, servers, view } = get()
      const here = view?.kind === 'channel' && view.server === ev.server
      if (me?.username === ev.username && (here || servers[ev.server])) bannedFrom(ev.server)
    },
    member_joined: ev => {
      acct.inviteUpdates.staleInvites(ev.server)
      const self = get().me?.username === ev.member.username
      if (!self) patchServer(ev.server, d => ({ ...d, member_count: d.member_count + 1 }))
      const joined = (list: Member[]) => [
        ...list.filter(m => m.username !== ev.member.username),
        ev.member,
      ]
      set(s => {
        const cache = s.members[ev.server]
        const rest = s.hoisted[ev.server]?.rest
        return {
          ...(cache
            ? { members: { ...s.members, [ev.server]: { ...cache, list: joined(cache.list) } } }
            : {}),
          ...(rest
            ? {
                hoisted: {
                  ...s.hoisted,
                  [ev.server]: {
                    ...s.hoisted[ev.server],
                    rest: { ...rest, list: joined(rest.list) },
                  },
                },
              }
            : {}),
        }
      })
      if (get().memberInfo[ev.server]) writeMemberInfo(ev.server, [[ev.member.username, ev.member]])
      if (self) void addServer(ev.server).catch(() => {})
    },
    member_left: onMemberGone,
    member_kicked: onMemberGone,
    member_timeout: ev => {
      const wire =
        ev.until === null
          ? undefined
          : { until: ev.until, remaining: ev.remaining, reason: ev.reason }
      const mine = get().me?.username === ev.username
      if (mine) {
        set(s =>
          s.me
            ? {
                me: {
                  ...s.me,
                  servers: s.me.servers.map(x =>
                    x.name === ev.server
                      ? {
                          ...x,
                          timed_out_until: ev.until === null ? undefined : localUntil(ev.remaining),
                        }
                      : x
                  ),
                },
              }
            : {}
        )
        applyMic()
      }
      if (!mine || hasPerm(myPerms(get(), ev.server), Perm.TimeoutMembers))
        noteTimeout(ev.server, ev.username, wire)
    },
    admin_changed: ev => {
      set(s => ({
        adminChanges: { ...s.adminChanges, [ev.server]: (s.adminChanges[ev.server] ?? 0) + 1 },
      }))
      patchMembers(ev.server, list =>
        list.map(m =>
          m.username === ev.username ? { ...m, is_admin: ev.is_admin, perms: ev.perms } : m
        )
      )
      patchMemberInfo(ev.server, ev.username, m => ({
        ...m,
        is_admin: ev.is_admin,
        perms: ev.perms,
      }))
      set(s =>
        s.me?.username === ev.username
          ? {
              me: {
                ...s.me,
                servers: s.me.servers.map(x =>
                  x.name === ev.server ? { ...x, is_admin: ev.is_admin } : x
                ),
              },
            }
          : {}
      )
      if (
        get().me?.username === ev.username ||
        [Perm.ManageAdmins, Perm.ManageRoles, Perm.AssignRoles].some(perm =>
          hasPerm(myPerms(get(), ev.server), perm)
        )
      )
        refetchServer(ev.server)
    },
    upload_expiry_changed: ev => {
      if (get().servers[ev.server]) refetchServer(ev.server)
    },
    roles_changed: ev => {
      dropLinkCards()
      if (!get().servers[ev.server]) return
      refetchServer(ev.server)
      void get().loadMembers(ev.server, true)
      if (get().hoisted[ev.server]) get().clearGroups(ev.server)
      refreshMemberInfo(ev.server)
    },
    role_updated: ev => {
      for (const read of reading) if (read.server === ev.server) read.roles.set(ev.role.id, ev.role)
      patchServer(ev.server, d => ({ ...d, roles: withRole(d.roles, ev.role) }))
    },
    roles_reordered: ev => {
      for (const read of reading)
        if (read.server === ev.server && ev.version > (read.places?.version ?? -1)) read.places = ev
      const known = get().servers[ev.server]
      if (!known || (known.roles_version ?? -1) >= ev.version) return
      const placed = placeRoles(known.roles, ev.order, ev.display)
      if (!placed) return refetchServer(ev.server)
      patchServer(ev.server, d => ({ ...d, roles: placed, roles_version: ev.version }))
      if (
        [Perm.ManageRoles, Perm.AssignRoles].some(perm => hasPerm(myPerms(get(), ev.server), perm))
      )
        refetchServer(ev.server)
    },
    member_roles_changed: ev => {
      const { me, servers } = get()
      const self = me?.username === ev.username
      if (self) dropLinkCards()
      noteRoles(ev.server, ev.username, ev.role_ids)
      const roles = (m: Member) => ({ ...m, role_ids: ev.role_ids })
      patchMembers(ev.server, list => mapWhere(list, m => m.username === ev.username, roles))
      patchMemberInfo(ev.server, ev.username, roles)
      if (!regroupMember(ev.server, ev.username, ev.role_ids)) {
        const at = sessionMark()
        void get()
          .ensureMembers(ev.server, [ev.username])
          .then(() => {
            if (at === sessionMark()) regroupMember(ev.server, ev.username, ev.role_ids)
          })
      }
      const detail = servers[ev.server]
      // Your own roles decide what you hold; while the role order is unconfirmed, who holds a
      // role decides which roles managers may change.
      const manages = [Perm.ManageRoles, Perm.AssignRoles].some(perm =>
        hasPerm(myPerms(get(), ev.server), perm)
      )
      if (detail && (self || (detail.roles_order_confirmed === false && manages)))
        refetchServer(ev.server)
    },
    channel_perms_changed: ev => {
      dropLinkCards()
      refetchServer(ev.server)
    },
    channels_perms_changed: ev => {
      dropLinkCards()
      refetchServer(ev.server)
    },
    layout_changed: ev => {
      if (layoutSends.has(ev.server)) return
      const known = get().servers[ev.server]
      if (!known) return
      const listed = new Set([
        ...ev.layout.uncategorized,
        ...ev.layout.categories.flatMap(c => c.channels),
      ])
      patchServer(ev.server, d => applyLayout(d, ev.layout))
      if (known.channels.some(c => !listed.has(c.id))) refetchServer(ev.server)
    },
    member_profile: ev => {
      const theirs = (m: Member) => m.username === ev.username
      set(s => {
        const page = s.members[ev.server]
        return page
          ? {
              members: {
                ...s.members,
                [ev.server]: {
                  ...page,
                  list: mapWhere(page.list, theirs, m => withLook(m, ev.profile)),
                },
              },
            }
          : {}
      })
      patchMemberInfo(ev.server, ev.username, m => withLook(m, ev.profile))
      if (ev.bio) forgetProfile(profileKey(ev.username, ev.server), sessionMark())
      // An open card of theirs in that server reads the profile again.
      set(s =>
        s.profile?.user.username === ev.username && s.profile.server === ev.server
          ? { profile: { ...s.profile, rev: (s.profile.rev ?? 0) + 1 } }
          : {}
      )
      if (ev.username === get().me?.username && get().servers[ev.server])
        void get().loadMyProfile(ev.server)
    },
    user_updated: ev => {
      const u = ev.user
      const wrote = (m: Message) => m.author.username === u.username
      const quotes = (m: Message) => m.reply_to?.author?.username === u.username
      const reauthor = (list: Message[]) =>
        mapWhere(
          list,
          m => wrote(m) || quotes(m),
          m => ({
            ...m,
            author: wrote(m) ? u : m.author,
            ...(m.reply_to && quotes(m) ? { reply_to: { ...m.reply_to, author: u } } : {}),
          })
        )
      mapTails(reauthor)
      set(s => ({
        me: s.me && s.me.username === u.username ? { ...s.me, ...u } : s.me,
        dms: s.dms.map(d => (d.other.username === u.username ? { ...d, other: u } : d)),
        members: mapPages(s.members, list =>
          mapWhere(
            list,
            m => m.username === u.username,
            m => ({ ...m, ...u })
          )
        ),
        hoisted: mapGroups(s.hoisted, null, list =>
          mapWhere(
            list,
            m => m.username === u.username,
            m => ({ ...m, ...u })
          )
        ),
        messages: mapLists(s.messages, reauthor),
        interacted: mapPages(s.interacted, list =>
          mapWhere(
            list,
            x => x.username === u.username,
            () => u
          )
        ),
        search: {
          ...s.search,
          results: s.search.results.map(r =>
            r.message.author.username === u.username
              ? { ...r, message: { ...r.message, author: u } }
              : r
          ),
        },
        panel:
          s.panel?.kind === 'thread' && s.panel.root.author.username === u.username
            ? { ...s.panel, root: { ...s.panel.root, author: u } }
            : s.panel,
        profile:
          s.profile?.user.username === u.username
            ? { ...s.profile, user: u, rev: (s.profile.rev ?? 0) + 1 }
            : s.profile,
      }))
      mapMemberInfo((username, m) => (username === u.username ? { ...m, ...u } : m))
      reauthorLinkCards(u)
    },
    banned: ev => {
      acct.inviteUpdates.staleInvites(null)
      if (get().me?.username === ev.username) {
        expireSession()
        return
      }
      forgetProfiles(ev.username, sessionMark())
      const gone = get()
        .dms.filter(d => d.other.username === ev.username)
        .map(d => `d${d.id}`)
      bumpDmGen()
      const reload = dmPager.removed()
      forgetReads(scope => !gone.includes(scope))
      const byBanned = (m: Message) => m.author.username === ev.username
      const roots = new Set(
        Object.values(get().messages)
          .flatMap(list => list.filter(byBanned))
          .map(m => threadKey(m.id))
      )
      forgetPending((key, upload) => !gone.includes(upload.scope) && !roots.has(key))
      for (const scope of gone) tails.delete(scope)
      const unban = (list: Message[]) => dropWhere(list, byBanned)
      mapTails(unban)
      if (get().me) void loadUnreads()
      set(s => ({
        messages: mapLists(s.messages, unban),
        members: mapPages(s.members, list => dropWhere(list, m => m.username === ev.username)),
        hoisted: mapGroups(s.hoisted, null, list =>
          dropWhere(list, m => m.username === ev.username)
        ),
        interacted: mapPages(s.interacted, list =>
          dropWhere(list, u => u.username === ev.username)
        ),
        dms: s.dms.filter(d => d.other.username !== ev.username),
        adminOverview: s.adminOverview
          ? { ...s.adminOverview, user_count: Math.max(0, s.adminOverview.user_count - 1) }
          : s.adminOverview,
      }))
      mapMemberInfo((username, m) => (username === ev.username ? null : m))
      set(s => (s.profile?.user.username === ev.username ? { profile: null } : {}))
      if (reload) void get().loadMoreDms()
      const { view, dms } = get()
      if (view?.kind === 'dm' && !dms.some(d => d.id === view.dmId)) {
        const self = dms.find(d => d.is_self)
        if (self) void get().openDm(self.id, 'replace')
        else {
          clearView()
        }
      }
    },
    user_registered: () => {
      set(s => ({
        adminOverview: s.adminOverview
          ? { ...s.adminOverview, user_count: s.adminOverview.user_count + 1 }
          : s.adminOverview,
      }))
    },
    brand_changed: ev => get().setBrand(ev.brand),
    settings_changed: ev => {
      const settings = siteSettings(ev.settings)
      acceptHostedPolicy(home.origin, settings.client_other_instances)
      const p2pFlip = settings.p2p_attachments !== get().settings.p2p_attachments
      const looksBefore = get()
      set({ settings, ...(p2pFlip ? { p2pAvailability: {} } : {}) })
      for (const server of new Set([
        ...Object.keys(looksBefore.members),
        ...Object.keys(looksBefore.memberInfo),
      ]))
        if (showsMore(shownParts(looksBefore, server), shownParts(get(), server)))
          refreshLooks(server)
      const { view } = get()
      if (p2pFlip && view) askP2p(get().messages[viewKey(view)] ?? [])
    },
  } satisfies Handlers

  return {
    handlers,
    actions,
    banCheck,
    dropServer,
    ensureMembership,
    fetchServer,
    leaveForSafety,
    leaveServerView,
    pruneServers,
    putServer,
    refreshMemberInfo,
    serverPager,
    forget,
  }
}
