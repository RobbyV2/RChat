import { create } from 'zustand'
import {
  ApiError,
  type LoginRequest,
  type PageOpts,
  type RegisterRequest,
  type SendOpts,
} from './api'
import {
  api,
  fitsHome,
  home,
  noteHomeInfo,
  resolveInstance,
  selectHome,
  writeLocal,
} from './instances'
import { rtc } from './rtc'
import { newP2pId, p2p } from './p2p'
import { mentionsUser } from './mentions'
import { catchUpDelay, due } from './backoff'
import { createReadQueue, mergeReads } from './reads'
import {
  WINDOW_MAX,
  createLru,
  dropWhere,
  findById,
  indexOfId,
  mapWhere,
  mergeSorted,
  patchById,
  trimWindow,
} from './window'
import {
  anyDmUnread,
  appendUnique,
  bumpFront,
  createPager,
  keyed,
  lostServers,
  mergeHead,
  insertSorted,
  refreshTail,
  samePrefix,
  unreadServers,
  windowEdges,
  type Key,
  type OlderState,
  type Page,
  type ReadMark,
} from './lists'
import { SEARCH_PAGE, SEARCH_TRIES, addSearchPage, searchParams, type SearchArgs } from './search'
import {
  addToFolder as addIn,
  bootDms,
  dmSections,
  emptyLayout,
  folderChildren,
  folderTitle,
  forgetServer,
  knownDms,
  layoutKey,
  layoutServers,
  mergeServers as mergeIn,
  moveFolder as moveFolderIn,
  moveIntoFolder as moveIntoIn,
  moveServer as moveServerIn,
  newFolderId,
  parseLayout,
  pinDm as pinIn,
  placeDm as placeIn,
  pruneLayout,
  railNames,
  renameFolder as renameFolderIn,
  renameServer,
  toggleFolder as toggleIn,
  ungroupFolder as ungroupIn,
  unpinDm as unpinIn,
  type DmZone,
  type Folder,
  type Layout,
} from './nav_layout'
import { memberPerms } from './rules'
import {
  dropStashedInvite,
  entryState,
  inviteEntry,
  invitePath,
  parseInvite,
  staleInvites,
  takeStashedInvite,
  type InviteEntry,
  type OpenInvite,
} from './invite'
import { clearProfiles } from './profile'
import { retrySeconds, tooManyText } from './rate_limit'
import {
  freshPresence,
  knownPresence,
  notePresence,
  presenceDelta,
  presenceSnap,
  snapOnline,
  type PresenceLog,
  type PresenceSnap,
} from './presence'
import type { PassKind, Secret } from './password'
import { ALL_PERMS } from './types'
import type {
  AdminOverview,
  AuthResponse,
  AvatarKind,
  CallKind,
  ChannelKind,
  ChannelPerm,
  ConfirmChoice,
  DmSummary,
  Embed,
  Me,
  Member,
  Message,
  P2pAvailability,
  Role,
  SearchResult,
  ServerBan,
  ServerDetail,
  ServerSummary,
  ServerSummaryLite,
  SiteSettings,
  InstanceInfo,
  Theme,
  UserRef,
  WsEvent,
  WsStatus,
} from './types'

export type View =
  { kind: 'channel'; server: string; channelId: number } | { kind: 'dm'; dmId: number }

export type Nav = 'push' | 'replace' | 'none'

export type PathTarget = View | { kind: 'server'; server: string }

export const viewPath = (view: View | null) => {
  if (view === null) return '/'
  return view.kind === 'channel'
    ? `/s/${encodeURIComponent(view.server)}/${view.channelId}/`
    : `/dm/${view.dmId}/`
}

export const parsePath = (pathname: string): PathTarget | null => {
  const channel = pathname.match(/^\/s\/([^/]+)(?:\/(\d+))?\/?$/)
  if (channel) {
    const [, raw, id] = channel
    try {
      const server = decodeURIComponent(raw)
      return id === undefined
        ? { kind: 'server', server }
        : { kind: 'channel', server, channelId: Number(id) }
    } catch {
      return null
    }
  }
  const dm = pathname.match(/^\/dm\/(\d+)\/?$/)
  return dm ? { kind: 'dm', dmId: Number(dm[1]) } : null
}

export interface ContextMenuItem {
  label: string
  danger?: boolean
  action: () => void
}

export interface ContextMenuState {
  x: number
  y: number
  items: ContextMenuItem[]
}

export interface ConfirmRequest {
  title: string
  body: string
  confirm: string
  action: (choice: string) => void
  choices?: ConfirmChoice[]
}

export type ActiveDialog =
  | { kind: 'add_server'; join?: string }
  | { kind: 'server_settings'; server: string }
  | { kind: 'admin_panel' }
  | { kind: 'ban_confirm'; username: string }
  | { kind: 'delete_user_confirm'; username: string }
  | { kind: 'settings' }
  | { kind: 'rename_folder'; id: string }

export type Panel = { kind: 'thread'; root: Message } | { kind: 'search' }

export interface Focus {
  id: number | null
  flash: boolean
}

export interface ProfileTarget {
  user: UserRef
  server: string | null
  x: number
  y: number
  instance?: string | null
}

export type UploadMode = 'server' | 'p2p'

export interface PendingUpload {
  file: File
  spoiler: boolean
  mode: UploadMode
  scope: string
}

export type OutgoingStatus = 'queued' | 'sending' | 'failed'

export interface Outgoing {
  tempId: number
  key: string
  status: OutgoingStatus
  msg: Message
  pending: PendingUpload | null
  p2pExpiresIn: number | null
  send: (opts: SendOpts) => Promise<Message>
}

export interface Notice {
  id: number
  lead?: string
  name: string
  title: string
  body: string
  go: () => void
}

export interface SearchState {
  results: SearchResult[]
  hasMore: boolean
  loading: boolean
  cursor?: string | null
}

export interface VoiceSession {
  server: string
  channelId: number
}

export interface CallSession {
  dmId: number
  dmUsers: string[]
  state: 'ringing' | 'active'
  from: string
  kind: CallKind
}

const emptySearch = (): SearchState => ({ results: [], hasMore: false, loading: false })

export const MAX_UPLOAD = 25 * 1024 * 1024
export const PAGE = 50
export const LIST_MAX = 100

const BANNED = 'You are banned from this server'

class Banned extends Error {}

export interface Paged<T> {
  list: T[]
  hasMore: boolean
  loading: boolean
  q: string
  cursor?: string | null
}

const emptyPage = <T>(): Paged<T> => ({ list: [], hasMore: true, loading: false, q: '' })

const LS = {
  get token() {
    return home.scoped('rchat_token')
  },
  get guest() {
    return home.scoped('rchat_guest')
  },
  get guestServers() {
    return home.scoped('rchat_guest_servers')
  },
  get guestGrants() {
    return home.scoped('rchat_guest_grants')
  },
  get guestNames() {
    return home.scoped('rchat_guest_names')
  },
  theme: 'rchat_theme',
  streamer: 'rchat_streamer',
  get lastDm() {
    return home.scoped('rchat_last_dm')
  },
}

export const THEME_COLORS: Record<Theme, string> = { dark: '#141218', light: '#fef7ff' }

export const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))

export const viewKey = (view: View) =>
  view.kind === 'channel' ? `c${view.channelId}` : `d${view.dmId}`

export const threadKey = (rootId: number) => `t${rootId}`

const readJson = <T>(key: string, fallback: T): T => {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

const byId = (a: Message, b: Message) => a.id - b.id
const dmKey = (d: DmSummary) => d.id
const isSelfDm = (d: DmSummary) => d.is_self
const serverKey = (x: ServerSummary) => x.name

const merge = mergeSorted<Message>

const OPT_BASE = 1e15
let optSeq = 0
const draining = new Set<string>()

const pendingEmbeds = new Map<number, Embed[]>()
const PENDING_EMBEDS_MAX = 256
const RESYNC_JITTER = 10_000
const CATCH_UP_VIEW_MAX = 5_000
const POLL_EVERY = 60_000
const VIEW_CACHE = 8
const DETACH_AT = WINDOW_MAX * 2
const rememberEmbeds = (id: number, embeds: Embed[]) => {
  pendingEmbeds.delete(id)
  pendingEmbeds.set(id, embeds)
  if (pendingEmbeds.size > PENDING_EMBEDS_MAX)
    pendingEmbeds.delete(pendingEmbeds.keys().next().value as number)
}
const applyEmbeds = (list: Message[]) =>
  pendingEmbeds.size === 0
    ? list
    : list.map(m => {
        const e = pendingEmbeds.get(m.id)
        return e && e !== m.embeds ? { ...m, embeds: e } : m
      })

const pageVisible = () => typeof document === 'undefined' || document.visibilityState === 'visible'

interface RChatState {
  token: string | null
  me: Me | null
  guest: boolean
  guestServers: string[]
  guestGrants: Record<string, string>
  guestNames: Record<string, string>
  servers: Record<string, ServerDetail>
  members: Record<string, Paged<Member>>
  memberInfo: Record<string, Record<string, Member | null>>
  memberInfoTrim: Record<string, number>
  adminChanges: Record<string, number>
  interacted: Record<string, Paged<UserRef>>
  bans: Record<string, Paged<ServerBan>>
  adminUsers: Paged<UserRef>
  adminServers: Paged<ServerSummaryLite>
  dms: DmSummary[]
  dmsMore: boolean
  serversMore: boolean
  layout: Layout
  voice: VoiceSession | null
  call: CallSession | null
  voiceUsers: Record<number, string[]>
  p2pAvailability: Record<string, P2pAvailability>
  rtcTick: number
  view: View | null
  invite: OpenInvite | null
  messages: Record<string, Message[]>
  older: Record<string, OlderState>
  newer: Record<string, OlderState>
  stale: Record<string, boolean>
  focus: Record<string, Focus>
  outbox: Record<string, Outgoing[]>
  reads: Record<string, ReadMark>
  unreadAnchor: Record<string, number>
  atBottom: boolean
  authExpired: boolean
  bootError: string | null
  wsStatus: WsStatus
  theme: Theme
  streamer: boolean
  contextMenu: ContextMenuState | null
  profile: ProfileTarget | null
  activeDialog: ActiveDialog | null
  confirm: ConfirmRequest | null
  confirmSeq: number
  panel: Panel | null
  pending: Record<string, PendingUpload>
  notices: Notice[]
  drafts: Record<string, string>
  search: SearchState
  error: string | null
  adminOverview: AdminOverview | null
  settings: SiteSettings
  instance: InstanceInfo | null
  instanceHost: string
  loadInstance: () => Promise<boolean>
  switchInstance: (address: string) => Promise<string | null>
  bootstrap: () => Promise<void>
  loadSettings: () => Promise<void>
  setTheme: (theme: Theme) => void
  setStreamer: (streamer: boolean) => void
  patchMe: (
    avatar_kind: AvatarKind,
    avatar_color?: string,
    banner_color?: string | null
  ) => Promise<void>
  setAppearOffline: (appearOffline: boolean) => Promise<void>
  changePassword: (current: Secret, next: Secret, kind: PassKind) => Promise<string | null>
  refreshAccount: () => Promise<void>
  syncFromUrl: (nav: 'replace' | 'none') => Promise<void>
  register: (body: RegisterRequest) => Promise<void>
  login: (body: LoginRequest) => Promise<void>
  logout: () => void
  enterGuest: () => Promise<void>
  guestJoinServer: (name: string, password?: string, nav?: Nav) => Promise<void>
  openServer: (name: string, channelId?: number, nav?: Nav, at?: number) => Promise<void>
  openChannel: (server: string, channelId: number, nav?: Nav, at?: number) => Promise<void>
  openDm: (dmId: number, nav?: Nav, at?: number) => Promise<void>
  openLastDm: () => void
  openInvite: (server: string, password?: string | null) => void
  closeInvite: () => void
  syncInvite: () => boolean
  consumeInviteJoin: () => void
  startDm: (username: string) => Promise<void>
  messageUser: (username: string, content: string) => Promise<void>
  loadMoreDms: () => Promise<void>
  loadMoreServers: () => Promise<void>
  ensureDms: (ids: number[]) => Promise<void>
  ensureServers: (names: string[]) => Promise<void>
  moveServer: (name: string, index: number) => void
  moveFolder: (id: string, index: number) => void
  moveIntoFolder: (name: string, id: string, index: number) => void
  addToFolder: (name: string, id: string) => void
  mergeServers: (name: string, target: string) => void
  toggleFolder: (id: string) => void
  renameFolder: (id: string, name: string) => void
  ungroupFolder: (id: string) => void
  placeDm: (id: number, zone: DmZone, index: number) => void
  pinDm: (id: number) => void
  unpinDm: (id: number) => void
  reloadLayout: () => void
  setDraft: (key: string, text: string) => void
  sendMessage: (content: string, p2pExpiresIn?: number | null) => void
  markRead: (scope: string, messageId: number) => void
  setAtBottom: (v: boolean) => void
  retryOutgoing: (key: string, tempId: number) => void
  cancelOutgoing: (key: string, tempId: number) => void
  loadOlder: () => Promise<void>
  loadNewer: () => Promise<void>
  jumpTo: (key: string, id: number, flash?: boolean) => Promise<void>
  jumpToUnread: () => Promise<void>
  jumpToPresent: (key: string) => Promise<void>
  dismissUnread: (key: string) => void
  clearFocus: (key: string) => void
  openResult: (result: SearchResult) => Promise<void>
  uploadFile: (key: string, file: File | null) => void
  toggleSpoiler: (key: string) => void
  toggleUploadMode: (key: string) => void
  openThread: (root: Message, at?: number) => Promise<void>
  openSearch: () => void
  closePanel: () => void
  loadOlderThread: () => Promise<void>
  loadNewerThread: () => Promise<void>
  sendThreadMessage: (content: string, p2pExpiresIn?: number | null) => void
  searchRun: (args: SearchArgs, reset: boolean) => Promise<void>
  dismissNotice: (id: number) => void
  deleteMessage: (id: number) => Promise<void>
  deleteMedia: (messageId: number) => Promise<void>
  deleteEmbed: (messageId: number, ord: number, banner: boolean) => Promise<void>
  createServer: (name: string, password?: string) => Promise<void>
  joinServer: (name: string, password?: string, nav?: Nav) => Promise<void>
  leaveServer: (name: string) => Promise<void>
  renameServer: (name: string, newName: string) => Promise<void>
  deleteServer: (name: string) => Promise<void>
  createChannel: (server: string, name: string, kind?: ChannelKind) => Promise<void>
  renameChannel: (id: number, name: string) => Promise<void>
  setSlowmode: (id: number, seconds: number) => Promise<void>
  deleteChannel: (id: number) => Promise<void>
  kickMember: (server: string, username: string) => Promise<void>
  banMember: (server: string, username: string) => Promise<void>
  unbanMember: (server: string, username: string) => Promise<void>
  loadBans: (server: string, reset?: boolean) => Promise<void>
  grantAdmin: (server: string, username: string) => Promise<void>
  revokeAdmin: (server: string, username: string) => Promise<void>
  transferAdmin: (server: string, username: string) => Promise<void>
  setAdminPerms: (server: string, username: string, perms: number) => Promise<void>
  createRole: (
    server: string,
    body: { name: string; color: string; perms: number }
  ) => Promise<void>
  updateRole: (
    server: string,
    id: number,
    patch: { name?: string; color?: string; perms?: number }
  ) => Promise<void>
  deleteRole: (server: string, id: number) => Promise<void>
  assignRole: (server: string, id: number, username: string) => Promise<void>
  unassignRole: (server: string, id: number, username: string) => Promise<void>
  setChannelPerm: (id: number, perm: ChannelPerm) => Promise<void>
  clearChannelPerm: (id: number, subject: string) => Promise<void>
  adminDeleteUser: (username: string) => Promise<void>
  adminDeleteMessage: (id: number) => Promise<void>
  loadMembers: (server: string, reset?: boolean) => Promise<void>
  loadInteracted: (server: string, reset?: boolean) => Promise<void>
  ensureMembers: (server: string, usernames: string[]) => Promise<void>
  rememberMember: (server: string, username: string, member: Member | null) => void
  notePresence: (server: string, username: string, online: boolean) => void
  refreshMember: (server: string, username: string) => Promise<void>
  joinVoice: (server: string, channelId: number) => Promise<void>
  leaveVoice: () => void
  toggleMute: () => void
  toggleCamera: () => Promise<void>
  toggleShare: () => Promise<void>
  startCall: (dmId: number, video: boolean) => Promise<void>
  startP2pCall: (dmId: number, video: boolean) => Promise<void>
  acceptCall: () => Promise<void>
  declineCall: () => void
  hangupCall: () => void
  loadAdminOverview: () => Promise<void>
  loadAdminUsers: (q: string, reset?: boolean) => Promise<void>
  loadAdminServers: (q: string, reset?: boolean) => Promise<void>
  adminDeleteServer: (name: string) => Promise<void>
  banUser: (username: string) => Promise<void>
  updateSettings: (patch: Partial<SiteSettings>) => Promise<void>
  setViewing: (server: string | null) => void
  applyWsEvent: (ev: WsEvent) => void
  openContextMenu: (x: number, y: number, items: ContextMenuItem[]) => void
  closeContextMenu: () => void
  openProfile: (user: UserRef, server: string | null, x: number, y: number) => void
  closeProfile: () => void
  openDialog: (dialog: ActiveDialog) => void
  closeDialog: () => void
  askConfirm: (req: ConfirmRequest) => void
  closeConfirm: () => void
  setError: (message: string | null) => void
}

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

export const myPerms = (s: RChatState, server: string): number =>
  s.me?.is_site_admin ? ALL_PERMS : serverAdminPerms(s, server)

export const roleColor = (roles: Role[] | undefined, roleIds: number[]): string | undefined =>
  roles?.find(r => roleIds.includes(r.id))?.color

export const isUnread = (s: RChatState, scope: string): boolean => {
  const r = s.reads[scope]
  return !!r && r.latest > r.lastRead
}

export const serverNames = (s: RChatState) =>
  s.me ? s.me.servers.map(x => x.name) : s.guestServers

export const railOrder = (s: RChatState) => railNames(serverNames(s), s.layout.servers)

export interface RailServer {
  name: string
  display_name: string
  creator: string | null
}

type RailSource = Pick<RChatState, 'me' | 'guestServers' | 'guestNames' | 'servers'>

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

let unreadMemo: { reads: RChatState['reads']; servers: Set<string> } | null = null

export const serverUnread = (s: RChatState, name: string): boolean => {
  const detail = s.servers[name]
  if (detail) return detail.channels.some(c => c.kind === 'text' && isUnread(s, `c${c.id}`))
  if (unreadMemo?.reads !== s.reads)
    unreadMemo = { reads: s.reads, servers: unreadServers(s.reads) }
  return unreadMemo.servers.has(name)
}

let dmUnreadMemo: { reads: RChatState['reads']; unread: boolean } | null = null

export const dmsUnread = (s: RChatState): boolean => {
  if (dmUnreadMemo?.reads !== s.reads)
    dmUnreadMemo = { reads: s.reads, unread: anyDmUnread(s.reads) }
  return dmUnreadMemo.unread
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

export const roleMenuItems = (server: string, username: string): ContextMenuItem[] => {
  const s = useStore.getState()
  const roles = s.servers[server]?.roles ?? []
  const roleIds = memberOf(s, server, username)?.role_ids ?? []
  return roles.map(r => {
    const assigned = roleIds.includes(r.id)
    return {
      label: `${assigned ? 'Remove' : 'Assign'} ${r.name}`,
      danger: assigned,
      action: () =>
        void (assigned
          ? s.unassignRole(server, r.id, username)
          : s.assignRole(server, r.id, username)),
    }
  })
}

export const banMenuItem = (server: string, username: string): ContextMenuItem => ({
  label: 'Ban from server',
  danger: true,
  action: () => {
    const s = useStore.getState()
    s.askConfirm({
      title: 'Ban from Server',
      body: "Ban this user? They are removed from the server and can't join again until unbanned.",
      confirm: 'Ban',
      action: () => void s.banMember(server, username),
    })
  },
})

export const confirmKick = (server: string, username: string, after?: () => void) =>
  useStore.getState().askConfirm({
    title: 'Kick Member',
    body: 'Kick this member? They are removed from the server but can join again.',
    confirm: 'Kick',
    action: () => void useStore.getState().kickMember(server, username).then(after),
  })

export const confirmTransfer = (server: string, username: string) =>
  useStore.getState().askConfirm({
    title: 'Transfer Admin',
    body: 'Make this member the server admin? You lose your own admin rights and cannot take them back yourself.',
    confirm: 'Transfer',
    action: () => void useStore.getState().transferAdmin(server, username),
  })

export const revokeAdminFor = (server: string, username: string, after?: () => void) => {
  const s = useStore.getState()
  const revoke = () => void useStore.getState().revokeAdmin(server, username).then(after)
  if (s.me?.username !== username) {
    revoke()
    return
  }
  s.askConfirm({
    title: 'Revoke Admin',
    body: 'Remove your own admin rights? Another admin has to give them back.',
    confirm: 'Revoke',
    action: revoke,
  })
}

export const confirmDeleteMessage = (id: number, now = false) => {
  const s = useStore.getState()
  if (now) {
    void s.deleteMessage(id)
    return
  }
  s.askConfirm({
    title: 'Delete Message',
    body: 'Delete this message for everyone? Hold Shift while clicking the trash icon to skip this.',
    confirm: 'Delete',
    action: () => void useStore.getState().deleteMessage(id),
  })
}

export const useStore = create<RChatState>()((set, get) => {
  const epochs: Record<string, number> = {}

  const fail = (e: unknown) => {
    if (e instanceof Banned) return
    const message = errorText(e)
    set({ error: message })
    setTimeout(() => {
      if (get().error === message) set({ error: null })
    }, 5000)
  }

  const act = async (fn: () => Promise<void>) => {
    try {
      await fn()
    } catch (e) {
      fail(e)
    }
  }

  const authRequest = async (path: string, body: LoginRequest | RegisterRequest) => {
    const res = await api.send('POST', path, body)
    if (res.ok) return (await res.json()) as AuthResponse
    const text = await res.text().catch(() => '')
    if (res.status === 429)
      throw new ApiError(tooManyText(retrySeconds(res.headers.get('Retry-After'), text)), 429)
    let message: string
    try {
      message = (JSON.parse(text) as { error?: string }).error || res.statusText
    } catch {
      message = res.statusText
    }
    throw new ApiError(message || `HTTP ${res.status}`, res.status)
  }

  const expireSession = () => {
    if (get().authExpired) return
    set({ authExpired: true })
    get().logout()
  }

  const dmPager = createPager<DmSummary>({
    read: () => get().dms,
    write: (dms, dmsMore) => set({ dms, dmsMore }),
    fetchPage: api.listDms,
    keyOf: dmKey,
    page: PAGE,
  })

  const serverPager = createPager<ServerSummary>({
    read: () => get().me?.servers ?? [],
    write: (servers, serversMore) =>
      set(s => (s.me ? { me: { ...s.me, servers }, serversMore } : {})),
    fetchPage: api.myServers,
    keyOf: serverKey,
    page: PAGE,
  })

  let dmGen = 0
  let serverGen = 0
  const droppedAt = new Map<string, number>()

  const settled = async <T>(gen: () => number, fetch: () => Promise<T>): Promise<T> => {
    for (;;) {
      const at = gen()
      const out = await fetch()
      if (gen() === at) return out
    }
  }

  const historyGen = new Map<string, number>()
  let historySeq = 0
  const newHistory = (key: string) => historyGen.set(key, ++historySeq)

  const readLayout = (username: string | null) => {
    try {
      return parseLayout(localStorage.getItem(home.scoped(layoutKey(username))))
    } catch {
      return emptyLayout
    }
  }

  const saveLayout = (next: Layout) => {
    if (next === get().layout) return
    set({ layout: next })
    const { me, guest } = get()
    if (me || guest) writeLocal(home.scoped(layoutKey(me?.username ?? null)), JSON.stringify(next))
  }

  const syncLayout = async (username: string) => {
    const { servers } = get().layout
    const asked = bootDms(get().layout, PAGE)
    try {
      await get().ensureServers(layoutServers(servers))
      await get().ensureDms(asked)
    } catch {
      return
    }
    if (!sameUser(username)) return
    const s = get()
    const dmIds = knownDms(
      s.layout,
      s.dms.map(d => d.id),
      asked
    )
    saveLayout(pruneLayout(s.layout, serverNames(s), dmIds))
  }

  const loadGuestLayout = () => {
    set({ layout: readLayout(null) })
    saveLayout(pruneLayout(get().layout, get().guestServers, null))
  }

  const applyMe = (fresh: Me, keep: boolean) => {
    const cur = get()
    const same = keep && cur.me?.username === fresh.username
    const steady = {
      servers: same && !!cur.me && samePrefix(cur.me.servers, fresh.servers, serverKey),
      dms: same && samePrefix(cur.dms, fresh.dms, dmKey),
    }
    const resume = {
      servers: serverPager.reset(fresh.servers_cursor, steady.servers) && same,
      dms: dmPager.reset(fresh.dms_cursor, steady.dms) && same,
    }
    set({
      me: {
        ...fresh,
        servers:
          same && cur.me
            ? mergeHead(cur.me.servers, fresh.servers, fresh.servers_more, serverKey)
            : fresh.servers,
      },
      dms: same ? mergeHead(cur.dms, fresh.dms, fresh.dms_more, dmKey) : fresh.dms,
      serversMore: fresh.servers_more,
      dmsMore: fresh.dms_more,
      ...(same ? {} : { layout: readLayout(fresh.username) }),
    })
    if (resume.servers) void get().loadMoreServers()
    if (resume.dms) void get().loadMoreDms()
    if (!same) void syncLayout(fresh.username)
  }

  const refetchMe = () =>
    api
      .me()
      .then(me => applyMe(me, true))
      .catch(e => {
        if (e instanceof ApiError && e.status === 401) expireSession()
        else fail(e)
      })

  let meRetry: ReturnType<typeof setTimeout> | null = null
  let recovering = false

  const recoverMe = async () => {
    if (meRetry) clearTimeout(meRetry)
    meRetry = null
    if (recovering || get().me || !get().token) return
    recovering = true
    try {
      const me = await api.me()
      if (!get().token) return
      applyMe(me, false)
      set({ bootError: null })
      p2p.announce()
      void loadUnreads()
      await resolveUrl('replace')
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        expireSession()
        return
      }
      set({ bootError: errorText(e) })
      meRetry = setTimeout(() => void recoverMe(), 5000)
    } finally {
      recovering = false
    }
  }

  const refreshView = async () => {
    const { view } = get()
    if (!view) return
    try {
      const key = viewKey(view)
      if (detached(key)) {
        if (view.kind === 'channel') {
          const detail = await api.getServer(view.server)
          set(s => ({ servers: { ...s.servers, [view.server]: detail } }))
        }
        return
      }
      if (loadingHead(key)) return
      const gen = historyGen.get(key)
      const msgs = await fetchPage(key, {})
      if (historyGen.get(key) !== gen || loadingHead(key)) return
      const { view: now } = get()
      if (!now || viewKey(now) !== key) return
      if (!views.has(key)) {
        firstPage(key, msgs)
        askP2p(msgs)
        return
      }
      const prev = get().messages[key] ?? []
      const next = refreshTail(prev, msgs, PAGE, get().older[key]?.more ?? true)
      const bounded = trimWindow(next.list, 'newest')
      const replaced = bounded.list[0]?.id !== prev[0]?.id
      if (replaced) newHistory(key)
      set(s => ({
        messages: { ...s.messages, [key]: applyEmbeds(bounded.list) },
        older: {
          ...s.older,
          [key]: {
            more: next.more || bounded.trimmed,
            loading: !replaced && (s.older[key]?.loading ?? false),
          },
        },
      }))
      askP2p(msgs)
      if (view.kind === 'channel') {
        const detail = await api.getServer(view.server)
        set(s => ({ servers: { ...s.servers, [view.server]: detail } }))
      }
    } catch (e) {
      if (view.kind === 'channel' && lockedOut(e)) guestLocked(view.server)
      else console.error('degraded poll', e)
    }
  }

  const lockedOut = (e: unknown) =>
    get().guest && get().settings.guests_enabled && e instanceof ApiError && e.status === 401

  const guestLocked = (name: string) => {
    if (!get().guestServers.includes(name)) return
    const { servers, guestNames } = get()
    notify(
      servers[name]?.display_name ?? guestNames[name] ?? name,
      '',
      '',
      () => {},
      'You were removed from'
    )
    dropServer(name)
  }

  const refetchServer = (server: string) => {
    if (!get().servers[server]) return
    void api
      .getServer(server)
      .then(detail => {
        set(s => ({ servers: { ...s.servers, [server]: detail } }))
        const { view } = get()
        if (
          view?.kind === 'channel' &&
          view.server === server &&
          !detail.channels.some(c => c.id === view.channelId)
        ) {
          const next = detail.channels[0]
          if (next) void get().openChannel(server, next.id, 'replace')
          else {
            set({ view: null })
            syncUrl(null, 'replace')
          }
        }
      })
      .catch(fail)
  }

  const askP2p = (msgs: Message[]) => {
    const known = get().p2pAvailability
    const hosters = [
      ...new Set(
        msgs.flatMap(m =>
          m.media?.kind === 'p2p' &&
          m.media.hoster !== null &&
          !Object.hasOwn(known, m.media.hoster)
            ? [m.media.hoster]
            : []
        )
      ),
    ]
    if (hosters.length) home.ws.sendVoice({ type: 'p2p_who', hosters })
  }

  let pendingDial: string | null = null

  const endRtc = () => {
    rtc.leave()
    p2p.endMedia()
    pendingDial = null
    set(s => (s.voice || s.call ? { voice: null, call: null } : {}))
  }

  const endCallMedia = (kind: CallKind) => {
    pendingDial = null
    if (kind === 'p2p') p2p.endMedia()
    else rtc.leave()
  }

  let unreadsReady: Promise<void> = Promise.resolve()

  let unreadsMore = false

  const loadUnreads = () => {
    const before = get().reads
    unreadsReady = api
      .getUnreads()
      .then(({ items, more }) => {
        unreadsMore = more
        set(s => ({ reads: mergeReads(before, s.reads, items, readQueue.pending) }))
      })
      .catch(() => {})
    return unreadsReady
  }

  const pruneServers = async () => {
    const me = get().me
    if (!me) return
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
      for (const x of found) joined.add(x.name)
    }
    const dropped = (name: string) => (droppedAt.get(name) ?? 0) > since
    const lost = lostServers(names, joined, dropped)
    const exists = await Promise.all(
      lost.map(name =>
        api.serverExists(name).then(
          () => true,
          (e: unknown) => !(e instanceof ApiError && e.status === 404)
        )
      )
    )
    if (!sameUser(me.username)) return
    lost.forEach((name, i) => {
      if (dropped(name)) return
      if (exists[i]) removedFrom(name, false, titles.get(name))
      else dropServer(name)
    })
  }

  const catchUp = () => {
    void refreshView()
    if (get().me) void loadUnreads()
    void pruneServers()
      .catch(() => {})
      .then(() => {
        const { view, members } = get()
        if (view?.kind === 'channel' && members[view.server])
          void get().loadMembers(view.server, true)
      })
  }

  let resyncTimer: ReturnType<typeof setTimeout> | null = null

  const resync = () => {
    if (resyncTimer) return
    resyncTimer = setTimeout(
      () => {
        resyncTimer = null
        set({ p2pAvailability: {}, voiceUsers: {} })
        home.ws.resubscribe()
        if (get().me) void refetchMe()
        else if (get().token) void recoverMe()
        const { view } = get()
        if (view) askP2p(get().messages[viewKey(view)] ?? [])
        catchUp()
      },
      250 + Math.random() * RESYNC_JITTER
    )
  }

  let downSince: number | null = null
  let viewTimer: ReturnType<typeof setTimeout> | null = null
  let catchUpTimer: ReturnType<typeof setTimeout> | null = null
  let polledMe: number | null = null
  let polledSettings: number | null = null

  const stopCatchUp = () => {
    if (viewTimer) clearTimeout(viewTimer)
    if (catchUpTimer) clearTimeout(catchUpTimer)
    viewTimer = null
    catchUpTimer = null
  }

  const scheduleCatchUp = (outage: number) => {
    stopCatchUp()
    viewTimer = setTimeout(
      () => {
        viewTimer = null
        void refreshView()
      },
      catchUpDelay(outage, Math.random, CATCH_UP_VIEW_MAX)
    )
    catchUpTimer = setTimeout(() => {
      catchUpTimer = null
      if (get().me) void refetchMe()
      else if (get().token) void recoverMe()
      if (get().me) void loadUnreads()
      void pruneServers()
        .catch(() => {})
        .then(() => {
          const { view, members } = get()
          if (view?.kind === 'channel' && members[view.server])
            void get().loadMembers(view.server, true)
        })
    }, catchUpDelay(outage))
  }

  let listening = false
  const listenPage = () => {
    if (listening || typeof document === 'undefined' || typeof window === 'undefined') return
    listening = true
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') {
        readQueue.flush()
        return
      }
      const { view, atBottom, messages } = get()
      if (!view || !atBottom || detached(viewKey(view))) return
      const list = messages[viewKey(view)] ?? []
      const last = list[list.length - 1]
      if (last) get().markRead(viewKey(view), last.id)
    })
    window.addEventListener('pagehide', () => readQueue.flush())
  }

  const startWs = () => {
    let connected = false
    downSince = null
    stopCatchUp()
    listenPage()
    home.ws.onEvent = ev => get().applyWsEvent(ev)
    home.ws.onStatus = wsStatus => {
      set({ wsStatus })
      if (wsStatus !== 'green') {
        if (downSince === null) downSince = Date.now()
        if (get().voice || get().call) endRtc()
        return
      }
      const outage = downSince === null ? 0 : Date.now() - downSince
      downSince = null
      set({ p2pAvailability: {}, voiceUsers: {} })
      if (get().me) p2p.announce()
      else if (get().token) void recoverMe()
      const { view } = get()
      if (view) askP2p(get().messages[viewKey(view)] ?? [])
      if (connected) scheduleCatchUp(outage)
      connected = true
    }
    home.ws.onPoll = () => {
      void refreshView()
      const now = Date.now()
      if (due(polledMe, now, POLL_EVERY)) {
        polledMe = now
        if (get().me) void refetchMe()
        else if (get().token) void recoverMe()
      }
      if (due(polledSettings, now, POLL_EVERY)) {
        polledSettings = now
        void get().loadSettings()
      }
    }
    home.ws.start(get().token)
    p2p.ensurePurge()
    if (get().me) void loadUnreads()
    if (get().guest) home.ws.subscribe(get().guestServers)
  }

  const persistGuestServers = (list: string[]) => {
    writeLocal(LS.guestServers, JSON.stringify(list))
    set({ guestServers: list })
  }

  const persistGuestNames = (names: Record<string, string>) => {
    writeLocal(LS.guestNames, JSON.stringify(names))
    set({ guestNames: names })
  }

  const rememberGuestName = (name: string, display: string) => {
    if (get().guestNames[name] !== display)
      persistGuestNames({ ...get().guestNames, [name]: display })
  }

  const persistGrants = (grants: Record<string, string>) => {
    writeLocal(LS.guestGrants, JSON.stringify(grants))
    api.setGrants(grants)
    home.ws.setGrants(grants)
    set({ guestGrants: grants })
  }

  const dropGrant = (server: string) => {
    if (!(server in get().guestGrants)) return
    const grants = { ...get().guestGrants }
    delete grants[server]
    persistGrants(grants)
  }

  const bannedHere = new Set<string>()
  const banCheck = (e: unknown, server: string | null | undefined) => {
    if (!server || !(e instanceof ApiError && e.status === 403 && e.message === BANNED)) return e
    bannedFrom(server)
    return new Banned(BANNED)
  }

  const fetchServer = async (name: string) => {
    try {
      const detail = await api.getServer(name)
      bannedHere.delete(name)
      if (get().guest) rememberGuestName(detail.name, detail.display_name)
      return detail
    } catch (e) {
      if (get().guest && e instanceof ApiError && e.status === 401) dropGrant(name)
      throw banCheck(e, name)
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
    await get().ensureServers([name])
    if (get().me && !get().me?.servers.some(x => x.name === name)) await refetchMe()
  }

  const forgetReads = (keep: (scope: string, mark: ReadMark) => boolean) =>
    set(s => {
      const entries = Object.entries(s.reads)
      const kept = entries.filter(([scope, mark]) => keep(scope, mark))
      return kept.length === entries.length ? {} : { reads: Object.fromEntries(kept) }
    })

  const forgetPending = (keep: (key: string, upload: PendingUpload) => boolean) =>
    set(s => {
      const entries = Object.entries(s.pending)
      const kept = entries.filter(([key, upload]) => keep(key, upload))
      return kept.length === entries.length ? {} : { pending: Object.fromEntries(kept) }
    })

  const setTokenCookie = (value: string | null) => {
    const token = home.isDefault ? value : null
    const attrs = `path=/; SameSite=Strict${window.location.protocol === 'https:' ? '; Secure' : ''}`
    document.cookie = token
      ? `rchat_token=${token}; ${attrs}; max-age=31536000`
      : `rchat_token=; ${attrs}; max-age=0`
  }

  const leaveInvite = () => {
    if (get().invite) set({ invite: null })
  }

  const rememberInvite = (entry: InviteEntry) =>
    queueMicrotask(() => {
      if (parseInvite(window.location.href, window.location.origin)?.server !== entry.server) return
      window.history.replaceState(entryState(entry), '', invitePath(entry.server))
    })

  const readInvite = () => {
    const target = parseInvite(window.location.href, window.location.origin)
    const handoff = takeStashedInvite(target?.server ?? null)
    if (!target) {
      leaveInvite()
      return false
    }
    const { server } = target
    const entry = inviteEntry(window.history.state, server)
    const password = target.password ?? entry?.password ?? handoff?.password ?? null
    if (target.password !== null || password !== (entry?.password ?? null))
      rememberInvite({ server, password, pushed: entry?.pushed ?? false })
    const { me, guest } = get()
    set({ invite: { server, password, join: handoff !== null && (me !== null || guest) } })
    return true
  }

  const syncUrl = (view: View | null, nav: Nav) => {
    leaveInvite()
    if (nav === 'none') return
    const path = viewPath(view)
    if (window.location.pathname === path) return
    if (nav === 'push') window.history.pushState(null, '', path)
    else window.history.replaceState(null, '', path)
  }

  const resolveUrl = async (nav: 'replace' | 'none') => {
    if (readInvite() || (!get().me && !get().guest)) return
    const target = parsePath(window.location.pathname)
    const fallback = async () => {
      await unreadsReady
      return leaveForSafety()
    }
    const cur = get().view
    if (target && target.kind !== 'server' && cur && viewPath(target) === viewPath(cur)) return
    if (!target) return fallback()
    if (target.kind === 'dm') {
      if (get().guest) return fallback()
      const known = () => get().dms.some(d => d.id === target.dmId)
      if (!known())
        await get()
          .ensureDms([target.dmId])
          .catch(() => {})
      if (!known()) return fallback()
      await unreadsReady
      return get().openDm(target.dmId, nav)
    }
    let detail: ServerDetail
    try {
      detail = (await Promise.all([fetchServer(target.server), ensureMembership(target.server)]))[0]
    } catch (e) {
      if (e instanceof Banned) {
        const now = get().view
        if (now) syncUrl(now, 'replace')
        return
      }
      await fallback()
      const locked =
        e instanceof ApiError &&
        (e.status === 403 || (e.status === 401 && get().settings.guests_enabled))
      const missing = e instanceof ApiError && e.status === 404
      if (locked) {
        fail(new Error('That server is password protected. Enter its password to join.'))
        get().openDialog({ kind: 'add_server', join: target.server })
      } else fail(missing ? new Error('That server does not exist') : e)
      return
    }
    const { guest, guestServers } = get()
    if (guest && !guestServers.includes(target.server)) {
      persistGuestServers([...guestServers, target.server])
      home.ws.subscribe([target.server])
    }
    set(s => ({ servers: { ...s.servers, [target.server]: detail } }))
    const wanted = target.kind === 'channel' ? target.channelId : null
    const channel = detail.channels.find(c => c.id === wanted) ?? detail.channels[0]
    if (!channel) return fallback()
    if (cur?.kind === 'channel' && cur.server === target.server && cur.channelId === channel.id)
      return syncUrl(cur, 'replace')
    await unreadsReady
    return get().openChannel(target.server, channel.id, channel.id === wanted ? nav : 'replace')
  }

  const enter = (res: AuthResponse) => {
    writeLocal(LS.token, res.token)
    setTokenCookie(res.token)
    writeLocal(LS.guest, null)
    api.setToken(res.token)
    applyMe(res.user, false)
    set({
      token: res.token,
      guest: false,
      authExpired: false,
      bootError: null,
    })
    startWs()
  }

  const dropServer = (name: string) => {
    if (get().voice?.server === name) get().leaveVoice()
    serverGen += 1
    droppedAt.set(name, serverGen)
    const reload = serverPager.removed()
    const scopes = new Set((get().servers[name]?.channels ?? []).map(c => `c${c.id}`))
    for (const scope of scopes) tails.delete(scope)
    forgetViews(views.keys().filter(k => scopes.has(k) && !liveKey(k)))
    forgetPending((_, upload) => !scopes.has(upload.scope))
    forgetReads((_, mark) => mark.server !== name)
    forgetMemberInfo(name)
    presenceLogs.delete(name)
    presenceSnaps.delete(name)
    saveLayout(forgetServer(get().layout, name))
    set(s => {
      const servers = { ...s.servers }
      delete servers[name]
      const members = { ...s.members }
      delete members[name]
      const interacted = { ...s.interacted }
      delete interacted[name]
      return {
        servers,
        members,
        interacted,
        me: s.me ? { ...s.me, servers: s.me.servers.filter(x => x.name !== name) } : s.me,
      }
    })
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
    if (!view || stuck) void leaveForSafety()
  }

  const removedFrom = (server: string, banned: boolean, title?: string) => {
    if (banned) bannedHere.add(server)
    const { servers, me } = get()
    const name =
      servers[server]?.display_name ??
      me?.servers.find(x => x.name === server)?.display_name ??
      title ??
      server
    notify(name, '', '', () => {}, banned ? 'You were banned from' : 'You were removed from')
    dropServer(server)
  }

  const messageKey = (channel_id: number | null, dm_id: number | null) => {
    if (channel_id !== null) return `c${channel_id}`
    if (dm_id !== null) return `d${dm_id}`
    return null
  }

  const TAIL_MAX = 200
  const tails = new Map<string, Message[]>()
  const holdTail = (key: string, m: Message) =>
    tails.set(key, merge(tails.get(key) ?? [], [m]).slice(-TAIL_MAX))
  const takeTail = (key: string, after: number) => {
    const held = tails.get(key) ?? []
    tails.delete(key)
    return held.filter(m => m.id > after)
  }
  const heads = new Map<string, number>()
  const loadingHead = (key: string) => (heads.get(key) ?? 0) > 0
  const holding = (key: string) => detached(key) || loadingHead(key)
  const headLoad = async <T>(key: string, run: () => Promise<T>): Promise<T> => {
    heads.set(key, (heads.get(key) ?? 0) + 1)
    if (get().messages[key]?.length) set(s => ({ stale: { ...s.stale, [key]: true } }))
    try {
      return await run()
    } catch (e) {
      if (heads.get(key) === 1) {
        const caught = detached(key) ? [] : takeTail(key, 0)
        set(s => ({
          messages:
            caught.length && s.messages[key]
              ? { ...s.messages, [key]: applyEmbeds(merge(s.messages[key], caught)) }
              : s.messages,
          stale: keyed(s.stale, key, null),
        }))
      }
      throw e
    } finally {
      const left = (heads.get(key) ?? 1) - 1
      if (left > 0) heads.set(key, left)
      else heads.delete(key)
    }
  }
  const mapTails = (fn: (list: Message[]) => Message[]) => {
    for (const [key, list] of tails) {
      const next = fn(list)
      if (next !== list) tails.set(key, next)
    }
  }

  const mapLists = (
    messages: Record<string, Message[]>,
    fn: (list: Message[], key: string) => Message[]
  ) => {
    let out: Record<string, Message[]> | null = null
    for (const [key, list] of Object.entries(messages)) {
      const next = fn(list, key)
      if (next === list) continue
      out ??= { ...messages }
      out[key] = next
    }
    return out ?? messages
  }

  const patchMessage = (id: number, fn: (m: Message) => Message) => {
    const patch = (list: Message[]) => patchById(list, id, fn)
    mapTails(patch)
    set(s => {
      const messages = mapLists(s.messages, patch)
      return messages === s.messages ? {} : { messages }
    })
  }

  const liveKey = (key: string) => {
    const { view, panel } = get()
    return (
      (view !== null && viewKey(view) === key) ||
      (panel?.kind === 'thread' && threadKey(panel.root.id) === key)
    )
  }

  const views = createLru<string>(VIEW_CACHE, liveKey)

  const forgetViews = (keys: string[]) => {
    if (!keys.length) return
    for (const key of keys) {
      tails.delete(key)
      heads.delete(key)
      historyGen.delete(key)
      sticky.delete(key)
      views.delete(key)
    }
    const without = <T>(map: Record<string, T>) => {
      if (!keys.some(k => k in map)) return map
      const next = { ...map }
      for (const k of keys) delete next[k]
      return next
    }
    set(s => ({
      messages: without(s.messages),
      older: without(s.older),
      newer: without(s.newer),
      stale: without(s.stale),
      focus: without(s.focus),
      unreadAnchor: without(s.unreadAnchor),
    }))
  }

  const touchView = (key: string) => forgetViews(views.touch(key))

  const appendLive = (key: string, msgs: Message[], create = false): Partial<RChatState> | null => {
    const s = get()
    const cur = s.messages[key]
    if (!cur && !(create && liveKey(key))) return {}
    const merged = merge(cur ?? [], applyEmbeds(msgs))
    const bottom = s.view !== null && viewKey(s.view) === key && s.atBottom
    if (!bottom && merged.length > DETACH_AT) return null
    const bounded =
      bottom && !s.older[key]?.loading
        ? trimWindow(merged, 'newest')
        : { list: merged, trimmed: false }
    if (bounded.trimmed) newHistory(key)
    const anchor = s.unreadAnchor[key]
    const cut = bounded.trimmed && anchor !== undefined && anchor < (bounded.list[0]?.id ?? 0)
    if (cut) sticky.delete(key)
    return {
      messages: { ...s.messages, [key]: bounded.list },
      ...(bounded.trimmed ? { older: { ...s.older, [key]: { more: true, loading: false } } } : {}),
      ...(cut
        ? { unreadAnchor: { ...s.unreadAnchor, [key]: bounded.list[bounded.list.length - 1].id } }
        : {}),
    }
  }

  const holdLive = (key: string, msgs: Message[]): Partial<RChatState> => {
    for (const m of msgs) holdTail(key, m)
    return { newer: { ...get().newer, [key]: { more: true, loading: false } } }
  }

  const withoutEmbed = (embeds: Embed[], ord: number, banner: boolean) =>
    banner
      ? embeds.map(e => (e.ord === ord ? { ...e, banner_removed: true } : e))
      : embeds.filter(e => e.ord !== ord)

  const patchServer = (name: string, fn: (detail: ServerDetail) => ServerDetail) => {
    set(s => {
      const detail = s.servers[name]
      return detail ? { servers: { ...s.servers, [name]: fn(detail) } } : {}
    })
  }

  const patchMembers = (server: string, fn: (list: Member[]) => Member[]) => {
    set(s => {
      const cache = s.members[server]
      if (!cache) return {}
      const list = fn(cache.list)
      return list === cache.list ? {} : { members: { ...s.members, [server]: { ...cache, list } } }
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

  const presence: { ev: Extract<WsEvent, { type: 'presence_changed' }>; seq: number }[] = []
  const presenceLogs = new Map<string, PresenceLog>()
  const presenceSnaps = new Map<string, PresenceSnap>()
  let presenceSeq = 0
  let presenceFrame = false

  const knownOnline = (server: string, username: string) => {
    const noted = knownPresence(presenceLogs.get(server), presenceSnaps.get(server), username)
    if (noted !== undefined) return noted
    const s = get()
    return (
      s.members[server]?.list.find(m => m.username === username)?.online ??
      s.memberInfo[server]?.[username]?.online
    )
  }

  const flushPresence = () => {
    presenceFrame = false
    const batch = presence.splice(0)
    if (!batch.length) return
    const byServer = new Map<string, Map<string, boolean>>()
    const delta = new Map<string, number>()
    const counts = new Map<string, number>()
    for (const { ev, seq } of batch) {
      if (typeof ev.online_count === 'number') counts.set(ev.server, ev.online_count)
      const users = byServer.get(ev.server) ?? new Map<string, boolean>()
      users.set(ev.username, ev.online)
      byServer.set(ev.server, users)
      const known = knownOnline(ev.server, ev.username)
      delta.set(ev.server, (delta.get(ev.server) ?? 0) + presenceDelta(known, ev.online))
      const log = presenceLogs.get(ev.server) ?? new Map()
      notePresence(log, ev.username, ev.online, seq)
      presenceLogs.set(ev.server, log)
    }
    set(s => {
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
        const known = memberInfo[server]
        if (known) {
          let next: Record<string, Member | null> | null = null
          for (const [username, online] of users) {
            const cur = known[username]
            if (!cur || cur.online === online) continue
            next ??= { ...known }
            next[username] = { ...cur, online }
          }
          if (next) memberInfo = { ...memberInfo, [server]: next }
        }
      }
      return { servers, members, memberInfo }
    })
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
    presence.push({ ev, seq: presenceSeq })
    if (presenceFrame) return
    presenceFrame = true
    if (typeof requestAnimationFrame === 'function' && pageVisible())
      requestAnimationFrame(flushPresence)
    else setTimeout(flushPresence, 16)
  }

  const leaveServerView = (next: string | null) => {
    const cur = get().view
    const prev = cur?.kind === 'channel' ? cur.server : null
    if (prev === null || prev === next) return
    const { activeDialog } = get()
    if (activeDialog?.kind === 'server_settings' && activeDialog.server === prev) return
    for (const id of [`m:${prev}`, `i:${prev}`]) epochs[id] = (epochs[id] ?? 0) + 1
    set(s => {
      if (!s.members[prev] && !s.interacted[prev]) return {}
      const members = { ...s.members }
      delete members[prev]
      const interacted = { ...s.interacted }
      delete interacted[prev]
      return { members, interacted }
    })
  }

  const matches = (q: string, ...names: string[]) => {
    const needle = q.toLowerCase()
    return !needle || names.some(n => n.toLowerCase().includes(needle))
  }

  const pageKeys = new WeakMap<unknown[], Set<Key>>()

  const loadPage = async <T>(
    id: string,
    read: () => Paged<T>,
    write: (page: Paged<T>) => void,
    fetchPage: (cursor: string | null) => Promise<Page<T>>,
    keyOf: (item: T) => string,
    q: string,
    reset: boolean
  ) => {
    const cur = read()
    const fresh = reset || q !== cur.q
    if (!fresh && (cur.loading || !cur.hasMore)) return
    if (fresh) epochs[id] = (epochs[id] ?? 0) + 1
    const epoch = epochs[id] ?? 0
    const base: Paged<T> = fresh
      ? { list: [], hasMore: true, loading: true, q, cursor: null }
      : { ...cur, loading: true }
    write(base)
    let page: Page<T>
    try {
      page = await fetchPage(base.cursor ?? null)
    } catch (e) {
      if ((epochs[id] ?? 0) === epoch) write({ ...base, loading: false })
      throw e
    }
    if ((epochs[id] ?? 0) !== epoch) return
    const seen = pageKeys.get(base.list) ?? new Set<Key>(base.list.map(keyOf))
    const added = page.items.filter(item => {
      const key = keyOf(item)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    const list = added.length ? [...base.list, ...added] : base.list
    pageKeys.set(list, seen)
    write({ ...base, list, hasMore: page.next !== null, cursor: page.next, loading: false })
  }

  const writeMembers = (server: string) => (page: Paged<Member>) =>
    set(s => ({ members: { ...s.members, [server]: page } }))

  const memberGen: Record<string, number> = {}
  const memberPending = new Set<string>()
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
    for (let i = 0; i < names.length; i += LIST_MAX) {
      const batch = names.slice(i, i + LIST_MAX)
      const gen = memberGen[server] ?? 0
      for (const n of batch) memberPending.add(pendingKey(server, n))
      let found: Member[]
      const since = presenceSeq
      try {
        found = freshPresence(
          await api.membersByName(server, batch).catch(e => {
            throw banCheck(e, server)
          }),
          presenceLogs.get(server),
          presenceSnaps.get(server),
          since
        )
      } finally {
        for (const n of batch) memberPending.delete(pendingKey(server, n))
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
      void fetchMemberInfo(
        server,
        kept.map(([n]) => n)
      ).catch(() => {})
  }

  const forgetMemberInfo = (server: string) => {
    memberGen[server] = (memberGen[server] ?? 0) + 1
    set(s => {
      if (!s.memberInfo[server]) return {}
      const memberInfo = { ...s.memberInfo }
      delete memberInfo[server]
      return { memberInfo }
    })
  }

  const queueMessage = (
    view: View,
    me: Me,
    content: string,
    pending: PendingUpload | null,
    p2pExpiresIn: number | null
  ) => {
    home.ws.ensureConnected()
    const tempId = OPT_BASE + ++optSeq
    enqueue({
      tempId,
      key: viewKey(view),
      status: 'queued',
      pending,
      p2pExpiresIn,
      msg: {
        id: tempId,
        channel_id: view.kind === 'channel' ? view.channelId : null,
        dm_id: view.kind === 'dm' ? view.dmId : null,
        thread_root_id: null,
        author: me,
        content,
        created_at: Math.floor(Date.now() / 1000),
        reply_count: 0,
        media: null,
        embeds: [],
        kind: 'user',
        call: null,
      },
      send: opts =>
        view.kind === 'channel'
          ? api.sendChannelMessage(view.channelId, content, opts)
          : api.sendDmMessage(view.dmId, content, opts),
    })
  }

  const sameUser = (username: string) => get().me?.username === username

  const readQueue = createReadQueue({
    send: (scope, id) => (get().token ? api.postRead(scope, id, true) : Promise.resolve()),
  })

  const moveDmUp = (id: number) =>
    set(s => {
      const dm = s.dms.find(d => d.id === id)
      return dm ? { dms: bumpFront(s.dms, dm, dmKey, isSelfDm) } : {}
    })

  const bumpDm = (id: number) => {
    if (get().dms.some(d => d.id === id)) moveDmUp(id)
    else
      void get()
        .ensureDms([id])
        .then(() => moveDmUp(id))
        .catch(() => {})
  }

  const setOlder = (key: string, state: OlderState) =>
    set(s => ({ older: { ...s.older, [key]: state } }))

  const fetchPage = async (key: string, page: PageOpts): Promise<Message[]> => {
    const id = Number(key.slice(1))
    try {
      switch (key[0]) {
        case 'c':
          return await api.channelMessages(id, page)
        case 'd':
          return await api.dmMessages(id, page)
        default:
          return await api.threadMessages(id, page)
      }
    } catch (e) {
      const { servers, view } = get()
      const server =
        key[0] === 'c'
          ? Object.values(servers).find(d => d.channels.some(c => c.id === id))?.name
          : key[0] === 'd'
            ? null
            : view?.kind === 'channel'
              ? view.server
              : null
      throw banCheck(e, server)
    }
  }

  const detached = (key: string) => get().newer[key]?.more === true

  const loadOlderFor = async (key: string) => {
    const cur = get().older[key]
    if (cur?.loading || cur?.more === false) return
    const first = (get().messages[key] ?? [])[0]
    if (!first) return
    if (!historyGen.has(key)) newHistory(key)
    const gen = historyGen.get(key)
    const current = () => historyGen.get(key) === gen
    setOlder(key, { more: true, loading: true })
    let older: Message[]
    try {
      older = await fetchPage(key, { before: first.id })
    } catch (e) {
      if (!current()) return
      setOlder(key, { more: true, loading: false })
      throw e
    }
    if (!current()) return
    const bounded = trimWindow(merge(get().messages[key] ?? [], applyEmbeds(older)), 'oldest')
    if (bounded.trimmed) {
      newHistory(key)
      tails.delete(key)
    }
    set(s => ({
      messages: { ...s.messages, [key]: bounded.list },
      older: { ...s.older, [key]: { more: older.length === PAGE, loading: false } },
      ...(bounded.trimmed ? { newer: { ...s.newer, [key]: { more: true, loading: false } } } : {}),
    }))
    askP2p(older)
  }

  const loadNewerFor = async (key: string) => {
    const cur = get().newer[key]
    if (!cur?.more || cur.loading) return
    const list = get().messages[key] ?? []
    const last = list[list.length - 1]
    if (!last) return
    if (!historyGen.has(key)) newHistory(key)
    const gen = historyGen.get(key)
    const current = () => historyGen.get(key) === gen
    set(s => ({ newer: { ...s.newer, [key]: { more: true, loading: true } } }))
    let newer: Message[]
    try {
      newer = await fetchPage(key, { after: last.id })
    } catch (e) {
      if (!current()) return
      set(s => ({ newer: { ...s.newer, [key]: { more: true, loading: false } } }))
      throw e
    }
    if (!current()) return
    const more = newer.length === PAGE
    const caught = more ? [] : takeTail(key, Math.max(last.id, ...newer.map(m => m.id)))
    const bounded = trimWindow(
      merge(get().messages[key] ?? [], applyEmbeds([...newer, ...caught])),
      'newest'
    )
    if (bounded.trimmed) newHistory(key)
    set(s => ({
      messages: { ...s.messages, [key]: bounded.list },
      newer: keyed(s.newer, key, more ? { more: true, loading: false } : null),
      ...(bounded.trimmed ? { older: { ...s.older, [key]: { more: true, loading: false } } } : {}),
    }))
    askP2p(newer)
  }

  const firstPage = (key: string, msgs: Message[], focus?: Focus) => {
    newHistory(key)
    touchView(key)
    const sorted = [...msgs].sort(byId)
    const caught = takeTail(key, (sorted[0]?.id ?? 1) - 1)
    set(s => ({
      messages: { ...s.messages, [key]: applyEmbeds(merge(caught, sorted)) },
      older: { ...s.older, [key]: { more: msgs.length === PAGE, loading: false } },
      newer: keyed(s.newer, key, null),
      stale: keyed(s.stale, key, null),
      ...(focus ? { focus: { ...s.focus, [key]: focus } } : {}),
    }))
  }

  const windowPage = (
    key: string,
    msgs: Message[],
    at: number,
    focus: (sorted: Message[]) => Focus | null
  ) => {
    newHistory(key)
    touchView(key)
    const sorted = [...msgs].sort(byId)
    const edges = windowEdges(
      sorted.map(m => m.id),
      at,
      PAGE
    )
    const caught = edges.newer ? [] : takeTail(key, (sorted[0]?.id ?? 1) - 1)
    if (edges.newer) {
      const last = sorted.at(-1)?.id ?? 0
      const held = (tails.get(key) ?? []).filter(m => m.id > last)
      if (held.length) tails.set(key, held)
      else tails.delete(key)
    }
    set(s => ({
      messages: { ...s.messages, [key]: applyEmbeds(merge(caught, sorted)) },
      older: { ...s.older, [key]: { more: edges.older, loading: false } },
      newer: keyed(s.newer, key, edges.newer ? { more: true, loading: false } : null),
      stale: keyed(s.stale, key, null),
      focus: keyed(s.focus, key, focus(sorted)),
    }))
  }

  const loadAround = async (
    key: string,
    at: number,
    focus: (sorted: Message[]) => Focus | null = () => ({ id: at, flash: true })
  ) => {
    const msgs = await headLoad(key, () => fetchPage(key, { around: at, limit: PAGE }))
    windowPage(key, msgs, at, focus)
    askP2p(msgs)
  }

  const sticky = new Set<string>()
  const placeAnchor = (key: string) =>
    set(s => {
      const mark = s.reads[key]
      const anchor = mark?.lastRead ?? 0
      if (mark && anchor > 0 && mark.latest > anchor) sticky.add(key)
      else sticky.delete(key)
      return { unreadAnchor: { ...s.unreadAnchor, [key]: anchor } }
    })

  let noticeId = 0
  const notify = (name: string, title: string, body: string, go: () => void, lead?: string) => {
    noticeId += 1
    const id = noticeId
    set(s => ({ notices: [...s.notices, { id, lead, name, title, body, go }].slice(-3) }))
    setTimeout(() => set(s => ({ notices: s.notices.filter(n => n.id !== id) })), 5000)
  }

  let endedVoice: number | null = null
  rtc.onChange = () => set(s => ({ rtcTick: s.rtcTick + 1 }))
  p2p.onChange = () => set(s => ({ rtcTick: s.rtcTick + 1 }))
  p2p.onError = message => fail(new Error(message))

  const uploadOk = (file: File) => {
    if (!get().settings.asset_uploads) {
      fail(new Error('File uploads are disabled'))
      return false
    }
    if (file.size > MAX_UPLOAD) {
      fail(new Error('File exceeds 25MB limit'))
      return false
    }
    return true
  }

  const buildSendOpts = async (
    pending: PendingUpload | null,
    p2pExpiresIn: number | null | undefined
  ): Promise<{ opts: SendOpts; p2pId: string | null }> => {
    if (!pending) return { opts: {}, p2pId: null }
    const { file, spoiler, mode } = pending
    if (mode === 'p2p') {
      const id = newP2pId()
      const expiresAt = p2pExpiresIn == null ? null : Math.floor(Date.now() / 1000) + p2pExpiresIn
      await p2p.storeFile(id, file, expiresAt)
      return {
        opts: {
          media_spoiler: spoiler,
          p2p: {
            filename: file.name,
            size: file.size,
            mime: file.type || 'application/octet-stream',
            p2p_id: id,
            expires_in_seconds: p2pExpiresIn ?? undefined,
          },
        },
        p2pId: id,
      }
    }
    const uploaded = await api.uploadMedia(file)
    return { opts: { media_id: uploaded.id, media_spoiler: spoiler }, p2pId: null }
  }

  const patchOutgoing = (key: string, tempId: number, status: OutgoingStatus) =>
    set(s => {
      const list = s.outbox[key]
      if (!list) return {}
      return {
        outbox: {
          ...s.outbox,
          [key]: list.map(o => (o.tempId === tempId ? { ...o, status } : o)),
        },
      }
    })

  const dropOutgoing = (map: Record<string, Outgoing[]>, key: string, tempId: number) => {
    const next = (map[key] ?? []).filter(o => o.tempId !== tempId)
    const outbox = { ...map }
    if (next.length) outbox[key] = next
    else delete outbox[key]
    return outbox
  }

  const drain = async (key: string) => {
    if (draining.has(key)) return
    draining.add(key)
    try {
      for (;;) {
        const head = (get().outbox[key] ?? [])[0]
        if (!head || head.status === 'failed') break
        patchOutgoing(key, head.tempId, 'sending')
        let real: Message
        try {
          const { opts, p2pId } = await buildSendOpts(head.pending, head.p2pExpiresIn)
          try {
            real = await head.send(opts)
          } catch (e) {
            if (p2pId !== null) p2p.removeFile(p2pId)
            throw e
          }
        } catch (e) {
          patchOutgoing(key, head.tempId, 'failed')
          fail(e)
          break
        }
        if (holding(key)) holdTail(key, real)
        const next = holding(key) ? {} : (appendLive(key, [real], true) ?? holdLive(key, [real]))
        set(s => ({ outbox: dropOutgoing(s.outbox, key, head.tempId), ...next }))
        if (key[0] !== 't') get().markRead(key, real.id)
      }
    } finally {
      draining.delete(key)
    }
  }

  const enqueue = (o: Outgoing) => {
    set(s => ({ outbox: { ...s.outbox, [o.key]: [...(s.outbox[o.key] ?? []), o] } }))
    void drain(o.key)
  }

  return {
    token: null,
    me: null,
    guest: false,
    guestServers: ['rchat'],
    guestGrants: {},
    guestNames: {},
    servers: {},
    members: {},
    memberInfo: {},
    memberInfoTrim: {},
    adminChanges: {},
    interacted: {},
    bans: {},
    adminUsers: emptyPage<UserRef>(),
    adminServers: emptyPage<ServerSummaryLite>(),
    dms: [],
    dmsMore: false,
    serversMore: false,
    layout: emptyLayout,
    voice: null,
    call: null,
    voiceUsers: {},
    p2pAvailability: {},
    rtcTick: 0,
    view: null,
    invite: null,
    messages: {},
    older: {},
    newer: {},
    stale: {},
    focus: {},
    outbox: {},
    reads: {},
    unreadAnchor: {},
    atBottom: true,
    authExpired: false,
    bootError: null,
    wsStatus: 'red',
    theme: 'dark',
    streamer: false,
    contextMenu: null,
    profile: null,
    activeDialog: null,
    confirm: null,
    confirmSeq: 0,
    panel: null,
    pending: {},
    notices: [],
    drafts: {},
    search: emptySearch(),
    error: null,
    adminOverview: null,
    settings: {
      profanity_filter: true,
      asset_previews: true,
      asset_uploads: true,
      guests_enabled: true,
    },

    instance: null,
    instanceHost: '',

    loadInstance: async () => {
      set({ instance: home.info, instanceHost: home.host })
      try {
        const info = await api.instance()
        if (!fitsHome(info)) throw new Error('instance endpoints moved to another site')
        noteHomeInfo(info)
        set({ instance: info, instanceHost: home.host })
        return true
      } catch {
        set({ instanceHost: home.host })
        return false
      }
    },

    switchInstance: async address => {
      if (get().token || get().guest) return 'Log out before switching instances'
      try {
        const { origin, info } = await resolveInstance(address)
        if (origin !== home.origin || home.info?.id !== info.id) {
          home.ws.stop()
          selectHome(origin, info)
        } else noteHomeInfo(info)
        set({ instance: info, instanceHost: home.host, error: null })
        await get().loadSettings()
        return null
      } catch (e) {
        return errorText(e)
      }
    },

    loadSettings: async () => {
      try {
        set({ settings: await api.getSettings() })
      } catch (e) {
        fail(e)
      }
    },

    setTheme: theme => {
      writeLocal(LS.theme, theme)
      document.documentElement.dataset.theme = theme
      document
        .querySelector('meta[name="theme-color"]')
        ?.setAttribute('content', THEME_COLORS[theme])
      set({ theme })
    },

    setStreamer: streamer => {
      writeLocal(LS.streamer, streamer ? '1' : '0')
      document.body.classList.toggle('streamer-mode', streamer)
      set({ streamer })
    },

    patchMe: (avatar_kind, avatar_color, banner_color) =>
      act(async () => {
        const user = await api.patchMe(avatar_kind, avatar_color, banner_color)
        set(s => (s.me ? { me: { ...s.me, ...user } } : {}))
      }),

    setAppearOffline: appearOffline =>
      act(async () => {
        await api.setAppearOffline(appearOffline)
        set(s => (s.me ? { me: { ...s.me, appear_offline: appearOffline } } : {}))
      }),

    refreshAccount: async () => {
      if (!get().token || !get().me) return
      const fresh = await api.me().catch(() => null)
      if (fresh)
        set(s =>
          s.me?.username === fresh.username
            ? {
                me: { ...s.me, password_kind: fresh.password_kind },
              }
            : {}
        )
    },

    changePassword: async (current, next, kind) => {
      try {
        await api.changePassword(current, next)
        set(s => (s.me ? { me: { ...s.me, password_kind: kind } } : {}))
        return null
      } catch (e) {
        if (e instanceof ApiError && e.status === 401 && e.message === 'Unauthorized')
          expireSession()
        return errorText(e)
      }
    },

    bootstrap: async () => {
      if (get().me || get().guest) {
        await resolveUrl('replace')
        return
      }
      void get().loadSettings()
      void get().loadInstance()
      const token = localStorage.getItem(LS.token)
      const guest = localStorage.getItem(LS.guest) === '1'
      const stored = readJson<unknown>(LS.guestServers, null)
      const guestServers = Array.isArray(stored)
        ? stored.filter((n): n is string => typeof n === 'string')
        : ['rchat']
      if (!guestServers.includes('rchat')) guestServers.unshift('rchat')
      if (token) {
        api.setToken(token)
        let me: Me
        try {
          me = await api.me()
        } catch (e) {
          if (e instanceof ApiError && e.status === 401) {
            fail(e)
            expireSession()
            return
          }
          setTokenCookie(token)
          set({ token, guest: false, bootError: errorText(e) })
          startWs()
          meRetry = setTimeout(() => void recoverMe(), 5000)
          return
        }
        setTokenCookie(token)
        applyMe(me, false)
        set({ token, guest: false, bootError: null })
        startWs()
        await resolveUrl('replace')
      } else if (guest) {
        persistGrants(readJson<Record<string, string>>(LS.guestGrants, {}))
        set({
          guest: true,
          guestServers,
          guestNames: readJson<Record<string, string>>(LS.guestNames, {}),
        })
        loadGuestLayout()
        startWs()
        await resolveUrl('replace')
      }
    },

    syncFromUrl: nav => resolveUrl(nav),

    register: body => act(async () => enter(await authRequest('/auth/register', body))),
    login: body => act(async () => enter(await authRequest('/auth/login', body))),

    logout: () => {
      const token = get().authExpired ? null : get().token
      if (meRetry) clearTimeout(meRetry)
      meRetry = null
      const flushed = readQueue.flush()
      readQueue.clear()
      if (token)
        void Promise.race([flushed, new Promise(r => setTimeout(r, 3000))])
          .then(() => api.logout(token))
          .catch(() => {})
      unreadsMore = false
      stopCatchUp()
      home.ws.stop()
      rtc.leave()
      p2p.endMedia()
      pendingDial = null
      writeLocal(LS.token, null)
      setTokenCookie(null)
      writeLocal(LS.guest, null)
      api.setToken(null)
      api.setGrants({})
      home.ws.setGrants({})
      dmPager.reset(null)
      serverPager.reset(null)
      historyGen.clear()
      tails.clear()
      sticky.clear()
      views.clear()
      presence.length = 0
      presenceLogs.clear()
      presenceSnaps.clear()
      bannedHere.clear()
      clearProfiles()
      dropStashedInvite()
      set({
        token: null,
        me: null,
        guest: false,
        guestGrants: {},
        guestNames: {},
        voice: null,
        call: null,
        voiceUsers: {},
        servers: {},
        members: {},
        memberInfo: {},
        memberInfoTrim: {},
        adminChanges: {},
        interacted: {},
        bans: {},
        adminUsers: emptyPage<UserRef>(),
        adminServers: emptyPage<ServerSummaryLite>(),
        dms: [],
        dmsMore: false,
        serversMore: false,
        layout: emptyLayout,
        view: null,
        invite: null,
        messages: {},
        older: {},
        newer: {},
        stale: {},
        focus: {},
        outbox: {},
        reads: {},
        unreadAnchor: {},
        atBottom: true,
        p2pAvailability: {},
        wsStatus: 'red',
        contextMenu: null,
        profile: null,
        activeDialog: null,
        confirm: null,
        panel: null,
        pending: {},
        notices: [],
        drafts: {},
        bootError: null,
        search: emptySearch(),
        adminOverview: null,
      })
    },

    enterGuest: () =>
      act(async () => {
        writeLocal(LS.guest, '1')
        writeLocal(LS.guestServers, JSON.stringify(['rchat']))
        persistGrants({})
        persistGuestNames({})
        set({ guest: true, guestServers: ['rchat'] })
        loadGuestLayout()
        startWs()
      }),

    guestJoinServer: async (name, password, nav) => {
      const id = name.trim().toLowerCase()
      if (password) {
        const { grant } = await api.guestAccess(id, password)
        persistGrants({ ...get().guestGrants, [id]: grant })
      }
      await fetchServer(id)
      const list = get().guestServers
      persistGuestServers(list.includes(id) ? list : [...list, id])
      home.ws.subscribe([id])
      await get().openServer(id, undefined, nav)
    },

    openServer: (name, channelId, nav = 'push', at) =>
      act(async () => {
        const [detail] = await Promise.all([fetchServer(name), ensureMembership(name)])
        set(s => ({ servers: { ...s.servers, [name]: detail } }))
        const target = detail.channels.find(c => c.id === channelId) ?? detail.channels[0]
        if (!target) throw new Error(`No channels you can view in ${detail.display_name}`)
        await get().openChannel(name, target.id, nav, target.id === channelId ? at : undefined)
      }),

    openChannel: (server, channelId, nav = 'push', at) =>
      act(async () => {
        const view: View = { kind: 'channel', server, channelId }
        const key = viewKey(view)
        const before = get().view
        const entering = before?.kind !== 'channel' || before.server !== server
        readQueue.flush()
        leaveServerView(server)
        if (entering) refreshMemberInfo(server)
        set(s => ({ view, atBottom: true, focus: keyed(s.focus, key, null) }))
        placeAnchor(key)
        syncUrl(view, nav)
        get().setViewing(server)
        const kind = get().servers[server]?.channels.find(c => c.id === channelId)?.kind
        if (kind === 'voice') return
        if (at !== undefined) {
          await loadAround(key, at)
          return
        }
        const msgs = await headLoad(key, () => fetchPage(key, {}))
        firstPage(key, msgs)
        askP2p(msgs)
      }),

    openDm: (dmId, nav = 'push', at) =>
      act(async () => {
        const view: View = { kind: 'dm', dmId }
        const key = viewKey(view)
        readQueue.flush()
        leaveServerView(null)
        set(s => ({ view, atBottom: true, focus: keyed(s.focus, key, null) }))
        placeAnchor(key)
        syncUrl(view, nav)
        get().setViewing(null)
        const username = get().me?.username
        if (username) writeLocal(`${LS.lastDm}:${username}`, String(dmId))
        if (username && !get().dms.some(d => d.id === dmId))
          void get()
            .ensureDms([dmId])
            .catch(() => {})
        if (at !== undefined) {
          await loadAround(key, at)
          return
        }
        const msgs = await headLoad(key, () => fetchPage(key, {}))
        firstPage(key, msgs)
        askP2p(msgs)
      }),

    openInvite: (server, password = null) => {
      const invite: OpenInvite = { server, password, join: false }
      set({ invite, contextMenu: null, profile: null, activeDialog: null })
      const path = invitePath(server)
      if (window.location.pathname !== path)
        window.history.pushState(entryState({ server, password, pushed: true }), '', path)
    },

    closeInvite: () => {
      const { view, invite } = get()
      const pushed = invite !== null && inviteEntry(window.history.state, invite.server)?.pushed
      leaveInvite()
      if (pushed) window.history.back()
      else if (view) syncUrl(view, 'push')
      else void leaveForSafety('push')
    },

    syncInvite: readInvite,

    consumeInviteJoin: () =>
      set(s => (s.invite?.join ? { invite: { ...s.invite, join: false } } : {})),

    openLastDm: () => {
      const { me } = get()
      if (!me) return
      const stored = Number(localStorage.getItem(`${LS.lastDm}:${me.username}`))
      const known = () => get().dms.some(d => d.id === stored)
      const go = () => {
        const { dms } = get()
        const target = known() ? stored : (dms.find(d => d.is_self) ?? dms[0])?.id
        if (target !== undefined && sameUser(me.username)) void get().openDm(target)
      }
      if (known() || !(stored > 0)) go()
      else
        void get()
          .ensureDms([stored])
          .catch(() => {})
          .then(go)
    },

    setDraft: (key, text) => set(s => ({ drafts: keyed(s.drafts, key, text || null) })),

    startDm: username =>
      act(async () => {
        const dm = await api.openDm(username)
        set(s => ({ dms: bumpFront(s.dms, dm, dmKey, isSelfDm) }))
        await get().openDm(dm.id)
      }),

    messageUser: (username, content) =>
      act(async () => {
        const { me } = get()
        if (!me) throw new Error('Create an account to send messages')
        const dm = await api.openDm(username)
        if (!sameUser(me.username)) return
        set(s => ({ dms: bumpFront(s.dms, dm, dmKey, isSelfDm) }))
        await get().openDm(dm.id)
        const author = get().me
        if (content.trim() && author?.username === me.username)
          queueMessage({ kind: 'dm', dmId: dm.id }, author, content, null, null)
      }),

    loadMoreDms: () =>
      act(async () => {
        if (get().me && get().dmsMore) await dmPager.load()
      }),

    loadMoreServers: () =>
      act(async () => {
        if (get().me && get().serversMore) await serverPager.load()
      }),

    ensureDms: async ids => {
      const me = get().me
      if (!me) return
      const have = new Set(get().dms.map(d => d.id))
      const missing = [...new Set(ids)].filter(id => Number.isSafeInteger(id) && !have.has(id))
      for (let i = 0; i < missing.length; i += LIST_MAX) {
        const batch = missing.slice(i, i + LIST_MAX)
        const found = await settled(
          () => dmGen,
          () => api.dmsById(batch)
        )
        if (!sameUser(me.username)) return
        set(s => ({ dms: appendUnique(s.dms, found, dmKey) }))
      }
    },

    ensureServers: async names => {
      const me = get().me
      if (!me) return
      const have = new Set(me.servers.map(x => x.name))
      const missing = [...new Set(names.map(n => n.toLowerCase()))].filter(n => n && !have.has(n))
      for (let i = 0; i < missing.length; i += LIST_MAX) {
        const batch = missing.slice(i, i + LIST_MAX)
        const found = await settled(
          () => serverGen,
          () => api.myServersByName(batch)
        )
        if (!sameUser(me.username)) return
        set(s =>
          s.me ? { me: { ...s.me, servers: appendUnique(s.me.servers, found, serverKey) } } : {}
        )
      }
    },

    moveServer: (name, index) => {
      const s = get()
      saveLayout(moveServerIn(s.layout, serverNames(s), name, index))
    },

    moveFolder: (id, index) => {
      const s = get()
      saveLayout(moveFolderIn(s.layout, serverNames(s), id, index))
    },

    moveIntoFolder: (name, id, index) => {
      const s = get()
      saveLayout(moveIntoIn(s.layout, serverNames(s), name, id, index))
    },

    addToFolder: (name, id) => {
      const s = get()
      saveLayout(addIn(s.layout, serverNames(s), name, id))
    },

    mergeServers: (name, target) => {
      const s = get()
      const id = newFolderId(s.layout.servers)
      saveLayout(mergeIn(s.layout, serverNames(s), name, target, id))
    },

    toggleFolder: id => saveLayout(toggleIn(get().layout, id)),
    renameFolder: (id, name) => saveLayout(renameFolderIn(get().layout, id, name)),
    ungroupFolder: id => saveLayout(ungroupIn(get().layout, id)),

    placeDm: (id, zone, index) => {
      const s = get()
      const { pinned, recent } = dmView(s)
      const shown = { pinned: pinned.map(d => d.id), recent: recent.map(d => d.id) }
      const maxId = s.dms.reduce((m, d) => Math.max(m, d.id), 0)
      saveLayout(placeIn(s.layout, shown, id, zone, index, maxId))
    },

    pinDm: id => saveLayout(pinIn(get().layout, id)),
    unpinDm: id => saveLayout(unpinIn(get().layout, id)),

    reloadLayout: () => {
      const { me, guest } = get()
      if (me || guest) set({ layout: readLayout(me?.username ?? null) })
    },

    sendMessage: (content, p2pExpiresIn) => {
      const { view, me } = get()
      if (!view || !me) return
      const key = viewKey(view)
      const pending = get().pending[key] ?? null
      if (!content.trim() && !pending) return
      set(s => ({ pending: keyed(s.pending, key, null) }))
      if (detached(key)) void get().jumpToPresent(key)
      queueMessage(view, me, content, pending, p2pExpiresIn ?? null)
    },

    markRead: (scope, messageId) => {
      const cur = get().reads[scope]
      if (cur && messageId <= cur.lastRead) return
      set(s => {
        const prev = s.reads[scope] ?? { lastRead: 0, latest: messageId }
        const lastRead = Math.max(prev.lastRead, messageId)
        return {
          reads: {
            ...s.reads,
            [scope]: { ...prev, lastRead, latest: Math.max(prev.latest, messageId) },
          },
          unreadAnchor: sticky.has(scope)
            ? s.unreadAnchor
            : { ...s.unreadAnchor, [scope]: lastRead },
        }
      })
      if (get().token) readQueue.mark(scope, messageId)
    },

    setAtBottom: v => set({ atBottom: v }),

    retryOutgoing: (key, tempId) => {
      patchOutgoing(key, tempId, 'queued')
      void drain(key)
    },

    cancelOutgoing: (key, tempId) => {
      set(s => ({ outbox: dropOutgoing(s.outbox, key, tempId) }))
      void drain(key)
    },

    loadOlder: () =>
      act(async () => {
        const { view } = get()
        if (view) await loadOlderFor(viewKey(view))
      }),

    loadNewer: () =>
      act(async () => {
        const { view } = get()
        if (view) await loadNewerFor(viewKey(view))
      }),

    jumpTo: (key, id, flash = true) =>
      act(async () => {
        if ((get().messages[key] ?? []).some(m => m.id === id)) {
          set(s => ({ focus: { ...s.focus, [key]: { id, flash } } }))
          return
        }
        await loadAround(key, id, () => ({ id, flash }))
      }),

    jumpToUnread: () =>
      act(async () => {
        const { view } = get()
        if (!view) return
        const key = viewKey(view)
        const anchor = get().unreadAnchor[key] ?? 0
        if (anchor <= 0) return
        await loadAround(key, anchor, sorted => ({
          id: sorted.find(m => m.id > anchor)?.id ?? anchor,
          flash: false,
        }))
      }),

    jumpToPresent: key =>
      act(async () => {
        const msgs = await headLoad(key, () => fetchPage(key, {}))
        firstPage(key, msgs, { id: null, flash: false })
        askP2p(msgs)
      }),

    dismissUnread: key => {
      sticky.delete(key)
      set(s => ({
        unreadAnchor: {
          ...s.unreadAnchor,
          [key]: Math.max(s.reads[key]?.latest ?? 0, s.unreadAnchor[key] ?? 0),
        },
      }))
    },

    clearFocus: key => set(s => (s.focus[key] ? { focus: keyed(s.focus, key, null) } : {})),

    openResult: result =>
      act(async () => {
        const { message, server } = result
        const { channel_id, thread_root_id, id } = message
        if (channel_id === null) return
        const s = get()
        const here = s.view?.kind === 'channel' && s.view.channelId === channel_id
        const at = thread_root_id ?? id
        if (here) {
          set({ panel: null })
          await get().jumpTo(viewKey({ kind: 'channel', server, channelId: channel_id }), at)
        } else {
          set({ panel: null })
          await get().openServer(server, channel_id, 'push', at)
        }
        if (thread_root_id === null) return
        const root = (get().messages[`c${channel_id}`] ?? []).find(m => m.id === thread_root_id)
        if (root) await get().openThread(root, id)
      }),

    uploadFile: (key, file) => {
      if (file && !uploadOk(file)) return
      const { panel } = get()
      const root = panel?.kind === 'thread' && threadKey(panel.root.id) === key ? panel.root : null
      const scope = root && root.channel_id !== null ? `c${root.channel_id}` : key
      const pending: PendingUpload | null = file
        ? { file, spoiler: false, mode: 'server', scope }
        : null
      set(s => ({ pending: keyed(s.pending, key, pending) }))
    },

    toggleSpoiler: key =>
      set(s => {
        const cur = s.pending[key]
        return cur ? { pending: { ...s.pending, [key]: { ...cur, spoiler: !cur.spoiler } } } : {}
      }),

    toggleUploadMode: key =>
      set(s => {
        const cur = s.pending[key]
        if (!cur) return {}
        const mode: UploadMode = cur.mode === 'server' ? 'p2p' : 'server'
        return { pending: { ...s.pending, [key]: { ...cur, mode } } }
      }),

    openThread: (root, at) =>
      act(async () => {
        const key = threadKey(root.id)
        set(s => ({ panel: { kind: 'thread', root }, focus: keyed(s.focus, key, null) }))
        if (at !== undefined) {
          await loadAround(key, at)
          return
        }
        const msgs = await headLoad(key, () => fetchPage(key, {}))
        firstPage(key, msgs)
        askP2p(msgs)
      }),

    openSearch: () => set({ panel: { kind: 'search' }, search: emptySearch() }),

    closePanel: () => set({ panel: null }),

    loadOlderThread: () =>
      act(async () => {
        const { panel } = get()
        if (panel?.kind === 'thread') await loadOlderFor(threadKey(panel.root.id))
      }),

    loadNewerThread: () =>
      act(async () => {
        const { panel } = get()
        if (panel?.kind === 'thread') await loadNewerFor(threadKey(panel.root.id))
      }),

    sendThreadMessage: (content, p2pExpiresIn) => {
      const { panel, me } = get()
      if (panel?.kind !== 'thread' || !me) return
      const rootId = panel.root.id
      const key = threadKey(rootId)
      const pending = get().pending[key] ?? null
      if (!content.trim() && !pending) return
      const tempId = OPT_BASE + ++optSeq
      set(s => ({ pending: keyed(s.pending, key, null) }))
      if (detached(key)) void get().jumpToPresent(key)
      enqueue({
        tempId,
        key,
        status: 'queued',
        pending,
        p2pExpiresIn: p2pExpiresIn ?? null,
        msg: {
          id: tempId,
          channel_id: null,
          dm_id: null,
          thread_root_id: rootId,
          author: me,
          content,
          created_at: Math.floor(Date.now() / 1000),
          reply_count: 0,
          media: null,
          embeds: [],
          kind: 'user',
          call: null,
        },
        send: opts => api.sendThreadMessage(rootId, content, opts),
      })
    },

    searchRun: (args, reset) =>
      act(async () => {
        const cur = get().search
        if (!reset && (cur.loading || !cur.hasMore)) return
        if (reset) epochs.search = (epochs.search ?? 0) + 1
        const epoch = epochs.search ?? 0
        let results = reset ? [] : cur.results
        let cursor = reset ? null : (cur.cursor ?? null)
        set({ search: { results, hasMore: true, loading: true, cursor } })
        const { guest, guestServers } = get()
        const start = results.length
        for (let tries = 0; ; tries += 1) {
          let page: Page<SearchResult>
          try {
            page = await api.search(searchParams(args, cursor, guest ? guestServers : null))
          } catch (e) {
            if ((epochs.search ?? 0) === epoch)
              set({ search: { results, hasMore: true, loading: false, cursor } })
            throw e
          }
          if ((epochs.search ?? 0) !== epoch) return
          const next = addSearchPage(results, page.items, page.next)
          results = next.results
          cursor = page.next
          const done =
            !next.hasMore || results.length - start >= SEARCH_PAGE || tries + 1 >= SEARCH_TRIES
          set({ search: { ...next, loading: !done, cursor } })
          if (done) return
        }
      }),

    dismissNotice: id => set(s => ({ notices: s.notices.filter(n => n.id !== id) })),

    deleteMessage: id =>
      act(async () => {
        await api.deleteMessage(id)
        const drop = (list: Message[]) => {
          const i = indexOfId(list, id)
          return i === -1 ? list : [...list.slice(0, i), ...list.slice(i + 1)]
        }
        mapTails(drop)
        set(s => ({ messages: mapLists(s.messages, drop) }))
      }),

    deleteMedia: messageId =>
      act(async () => {
        await api.deleteMedia(messageId)
        const { me, messages } = get()
        for (const list of Object.values(messages)) {
          const m = findById(list, messageId)
          if (
            m?.media?.kind === 'p2p' &&
            m.media.hoster !== null &&
            m.media.hoster === me?.username
          ) {
            p2p.removeFile(m.media.id)
            break
          }
        }
        patchMessage(messageId, m =>
          m.media ? { ...m, media: { ...m.media, removed: true, removed_by_author: true } } : m
        )
      }),

    deleteEmbed: (messageId, ord, banner) =>
      act(async () => {
        await api.deleteEmbed(messageId, ord, banner)
        patchMessage(messageId, m => ({ ...m, embeds: withoutEmbed(m.embeds, ord, banner) }))
      }),

    createServer: async (name, password) => {
      const { name: id } = await api.createServer(name, password)
      await addServer(id).catch(fail)
      await get().openServer(id)
    },

    joinServer: async (name, password, nav = 'push') => {
      const { name: id } = await api.joinServer(name.trim().toLowerCase(), password)
      await addServer(id).catch(fail)
      const { view } = get()
      const here = view?.kind === 'channel' && view.server === id ? view.channelId : undefined
      await get().openServer(id, here, here === undefined ? nav : 'replace')
    },

    leaveServer: name =>
      act(async () => {
        if (get().guest) {
          persistGuestServers(get().guestServers.filter(n => n !== name))
        } else {
          await api.leaveServer(name)
        }
        dropServer(name)
      }),

    renameServer: async (name, newName) => void (await api.updateServer(name, { name: newName })),
    deleteServer: name => act(async () => void (await api.deleteServer(name))),
    createChannel: (server, name, kind = 'text') =>
      act(async () => void (await api.createChannel(server, name, kind))),
    renameChannel: (id, name) => act(async () => void (await api.updateChannel(id, { name }))),
    setSlowmode: (id, seconds) =>
      act(async () => void (await api.updateChannel(id, { slowmode_seconds: seconds }))),
    deleteChannel: id => act(async () => void (await api.deleteChannel(id))),
    kickMember: (server, username) =>
      act(async () => void (await api.kickMember(server, username))),
    banMember: (server, username) =>
      act(async () => {
        await api.banMember(server, username)
        if (get().bans[server]) await get().loadBans(server, true)
      }),
    unbanMember: (server, username) =>
      act(async () => {
        await api.unbanMember(server, username)
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
    assignRole: (server, id, username) =>
      act(async () => void (await api.assignRole(server, id, username))),
    unassignRole: (server, id, username) =>
      act(async () => void (await api.unassignRole(server, id, username))),
    setChannelPerm: (id, perm) => act(async () => void (await api.setChannelPerm(id, perm))),
    clearChannelPerm: (id, subject) =>
      act(async () => void (await api.clearChannelPerm(id, subject))),
    adminDeleteUser: username => act(async () => void (await api.adminDeleteUser(username))),
    adminDeleteMessage: id => act(async () => void (await api.adminDeleteMessage(id))),

    loadMembers: (server, reset = false) =>
      act(() =>
        loadPage(
          `m:${server}`,
          () => get().members[server] ?? emptyPage<Member>(),
          writeMembers(server),
          async cursor => {
            const since = presenceSeq
            const page = await api.listMembers(server, cursor).catch(e => {
              throw banCheck(e, server)
            })
            return {
              ...page,
              items: freshPresence(
                page.items,
                presenceLogs.get(server),
                presenceSnaps.get(server),
                since
              ),
            }
          },
          m => m.username,
          '',
          reset
        )
      ),

    loadInteracted: (server, reset = false) =>
      act(() =>
        loadPage(
          `i:${server}`,
          () => get().interacted[server] ?? emptyPage<UserRef>(),
          page => set(s => ({ interacted: { ...s.interacted, [server]: page } })),
          cursor =>
            api.listInteracted(server, cursor).catch(e => {
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
      if (missing.length) await fetchMemberInfo(server, missing).catch(() => {})
    },

    rememberMember: (server, username, member) => writeMemberInfo(server, [[username, member]]),

    notePresence: (server, username, online) =>
      set(s => {
        const out: Partial<RChatState> = {}
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
        found = (await api.membersByName(server, [username]))[0]
      } catch {
        return
      }
      writeMemberInfo(server, [[username, found ?? null]])
      if (found) {
        const fresh = found
        patchMembers(server, list => list.map(m => (m.username === username ? fresh : m)))
      }
    },

    joinVoice: (server, channelId) =>
      act(async () => {
        const { me, guest, voice } = get()
        if (guest || !me) throw new Error('Create an account to join voice')
        home.ws.ensureConnected()
        await get().openChannel(server, channelId)
        if (voice?.channelId === channelId) return
        p2p.endMedia()
        await rtc.join(me.username, { channelId })
        if (!home.ws.sendVoice({ type: 'voice_join', channel_id: channelId })) {
          rtc.leave()
          throw new Error('Not connected')
        }
        set({ voice: { server, channelId }, call: null })
      }),

    leaveVoice: () => {
      home.ws.sendVoice({ type: 'voice_leave' })
      rtc.leave()
      set({ voice: null })
    },

    toggleMute: () => {
      const { call, voice } = get()
      if (!voice && call?.kind === 'p2p') p2p.setMuted(!p2p.muted)
      else rtc.setMuted(!rtc.muted)
    },
    toggleCamera: () =>
      act(async () => {
        const { call, voice } = get()
        if (!voice && call?.kind === 'p2p') await p2p.toggleCamera()
        else await rtc.camera(!(rtc.videoTrack !== null && !rtc.sharing))
      }),
    toggleShare: () =>
      act(async () => {
        const { call, voice } = get()
        if (!voice && call?.kind === 'p2p') await p2p.toggleShare()
        else await rtc.share(!rtc.sharing)
      }),

    startCall: (dmId, video) =>
      act(async () => {
        const { me, guest, call } = get()
        if (guest || !me) throw new Error('Create an account to start calls')
        if (call) throw new Error('Already in a call')
        try {
          await rtc.join(me.username, { dmId })
          if (video) await rtc.camera(true)
        } catch (e) {
          rtc.leave()
          throw e
        }
        if (!home.ws.sendVoice({ type: 'call_start', dm_id: dmId })) {
          rtc.leave()
          throw new Error('Not connected')
        }
        set({ voice: null })
      }),

    startP2pCall: (dmId, video) =>
      act(async () => {
        const { me, guest, call } = get()
        if (guest || !me) throw new Error('Create an account to start calls')
        if (call) throw new Error('Already in a call')
        try {
          await p2p.startMedia()
          if (video) await p2p.toggleCamera()
        } catch (e) {
          p2p.endMedia()
          throw e
        }
        if (!home.ws.sendVoice({ type: 'call_start', dm_id: dmId, p2p: true })) {
          p2p.endMedia()
          throw new Error('Not connected')
        }
        set({ voice: null })
      }),

    acceptCall: () =>
      act(async () => {
        const { me, call } = get()
        if (!me || !call || call.state !== 'ringing') return
        if (call.kind === 'p2p') await p2p.startMedia()
        else await rtc.join(me.username, { dmId: call.dmId })
        if (!home.ws.sendVoice({ type: 'call_accept', dm_id: call.dmId })) {
          endCallMedia(call.kind)
          throw new Error('Not connected')
        }
        set({ voice: null })
      }),

    declineCall: () => {
      const { call } = get()
      if (call) {
        home.ws.sendVoice({ type: 'call_decline', dm_id: call.dmId })
        endCallMedia(call.kind)
      }
      set({ call: null })
    },

    hangupCall: () => {
      const { call } = get()
      if (call) {
        home.ws.sendVoice({ type: 'call_leave', dm_id: call.dmId })
        endCallMedia(call.kind)
      }
      set({ call: null })
    },

    loadAdminOverview: () =>
      act(async () => {
        set({ adminOverview: await api.adminOverview() })
      }),

    loadAdminUsers: (q, reset = false) =>
      act(() =>
        loadPage(
          'admin_users',
          () => get().adminUsers,
          adminUsers => set({ adminUsers }),
          cursor => api.adminUsers(cursor, q),
          u => u.username,
          q,
          reset
        )
      ),

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
        set({ settings: await api.patchSettings(patch) })
      }),

    setViewing: server => {
      if (get().token) home.ws.setViewing(server)
    },

    applyWsEvent: ev => {
      switch (ev.type) {
        case 'message': {
          const m = ev.message
          const rootId = m.thread_root_id
          if (rootId !== null) {
            const tkey = threadKey(rootId)
            const ckey = m.channel_id !== null ? `c${m.channel_id}` : null
            const bump = (list: Message[]) =>
              patchById(list, rootId, r => ({ ...r, reply_count: r.reply_count + 1 }))
            const held = ckey ? tails.get(ckey) : undefined
            if (ckey && held) tails.set(ckey, bump(held))
            const live = liveKey(tkey)
            if (live && holding(tkey)) holdTail(tkey, m)
            const thread =
              live && !holding(tkey) ? (appendLive(tkey, [m]) ?? holdLive(tkey, [m])) : {}
            set(s => {
              const messages = { ...s.messages, ...thread.messages }
              if (ckey && messages[ckey]) messages[ckey] = bump(messages[ckey])
              return {
                ...thread,
                messages,
                panel:
                  s.panel?.kind === 'thread' && s.panel.root.id === rootId
                    ? {
                        ...s.panel,
                        root: { ...s.panel.root, reply_count: s.panel.root.reply_count + 1 },
                      }
                    : s.panel,
              }
            })
          } else {
            const key = messageKey(ev.channel_id, ev.dm_id)
            if (key && liveKey(key)) {
              if (holding(key)) holdTail(key, m)
              else set(appendLive(key, [m]) ?? holdLive(key, [m]))
            }
          }
          askP2p([m])
          if (ev.dm_id !== null && get().me) bumpDm(ev.dm_id)
          if (m.kind === 'call') return
          if (rootId === null) {
            const scope = messageKey(m.channel_id, m.dm_id)
            if (scope) {
              const meNow = get().me
              const mine = meNow?.username === m.author.username
              const viewNow = get().view
              const viewingScope = viewNow ? viewKey(viewNow) : null
              set(s => {
                const prev = s.reads[scope] ?? { lastRead: unreadsMore ? 0 : m.id - 1, latest: 0 }
                return {
                  reads: {
                    ...s.reads,
                    [scope]: {
                      ...prev,
                      latest: Math.max(prev.latest, m.id),
                      server: ev.server ?? prev.server,
                    },
                  },
                }
              })
              if (mine || (scope === viewingScope && get().atBottom && pageVisible()))
                get().markRead(scope, m.id)
            }
          }
          const { me, view, panel } = get()
          if (!me || m.author.username === me.username) return
          const { server, channel_id, dm_id } = ev
          if (dm_id !== null) {
            if (view?.kind === 'dm' && view.dmId === dm_id) return
            notify(
              m.author.display_name,
              '',
              m.content || m.media?.filename || 'Attachment',
              () => {
                void get().openDm(dm_id)
              }
            )
          } else if (channel_id !== null && server !== null) {
            if (!mentionsUser(m.content, me.username)) return
            const viewingIt =
              rootId !== null
                ? panel?.kind === 'thread' && panel.root.id === rootId
                : view?.kind === 'channel' && view.channelId === channel_id
            if (viewingIt) return
            notify(m.author.display_name, 'mentioned you', m.content, () => {
              void get().openServer(server, channel_id)
            })
          }
          return
        }
        case 'message_updated': {
          patchMessage(ev.message.id, () => ev.message)
          return
        }
        case 'message_deleted': {
          if (ev.server !== null) staleInvites(ev.server)
          const rootOf = ev.thread_root_id
          const drop = (list: Message[]) => {
            const i = indexOfId(list, ev.id)
            const cut = i === -1 ? list : [...list.slice(0, i), ...list.slice(i + 1)]
            return rootOf === null
              ? cut
              : patchById(cut, rootOf, m => ({
                  ...m,
                  reply_count: Math.max(0, m.reply_count - 1),
                }))
          }
          tails.delete(threadKey(ev.id))
          views.delete(threadKey(ev.id))
          mapTails(drop)
          forgetPending(key => key !== threadKey(ev.id))
          set(s => {
            const kept = { ...s.messages }
            delete kept[threadKey(ev.id)]
            const messages = mapLists(kept, drop)
            const panel =
              s.panel?.kind === 'thread' && s.panel.root.id === ev.id
                ? null
                : s.panel?.kind === 'thread' && s.panel.root.id === rootOf
                  ? {
                      ...s.panel,
                      root: {
                        ...s.panel.root,
                        reply_count: Math.max(0, s.panel.root.reply_count - 1),
                      },
                    }
                  : s.panel
            return { messages, panel }
          })
          return
        }
        case 'media_removed': {
          patchMessage(ev.message_id, m =>
            m.media
              ? {
                  ...m,
                  media: { ...m.media, removed: true, removed_by_author: ev.removed_by_author },
                }
              : m
          )
          return
        }
        case 'embeds_resolved': {
          rememberEmbeds(ev.message_id, ev.embeds)
          patchMessage(ev.message_id, m => ({ ...m, embeds: ev.embeds }))
          return
        }
        case 'embeds_removed': {
          const cur = pendingEmbeds.get(ev.message_id)
          if (cur) rememberEmbeds(ev.message_id, withoutEmbed(cur, ev.ord, ev.banner))
          patchMessage(ev.message_id, m => ({
            ...m,
            embeds: withoutEmbed(m.embeds, ev.ord, ev.banner),
          }))
          return
        }
        case 'channel_created': {
          patchServer(ev.server, d =>
            d.channels.some(c => c.id === ev.channel.id)
              ? d
              : { ...d, channels: [...d.channels, ev.channel] }
          )
          return
        }
        case 'channel_renamed': {
          patchServer(ev.server, d => ({
            ...d,
            channels: d.channels.map(c => (c.id === ev.channel.id ? ev.channel : c)),
          }))
          return
        }
        case 'channel_deleted': {
          patchServer(ev.server, d => ({
            ...d,
            channels: d.channels.filter(c => c.id !== ev.channel_id),
          }))
          if (get().voice?.channelId === ev.channel_id) {
            rtc.leave()
            set({ voice: null })
          }
          set(s => {
            const voiceUsers = { ...s.voiceUsers }
            delete voiceUsers[ev.channel_id]
            return { voiceUsers }
          })
          forgetReads(scope => scope !== `c${ev.channel_id}`)
          forgetPending((_, upload) => upload.scope !== `c${ev.channel_id}`)
          tails.delete(`c${ev.channel_id}`)
          if (!liveKey(`c${ev.channel_id}`)) forgetViews([`c${ev.channel_id}`])
          const { view, servers } = get()
          if (view?.kind === 'channel' && view.channelId === ev.channel_id) {
            const next = servers[ev.server]?.channels[0]
            if (next) void get().openChannel(ev.server, next.id, 'replace')
            else {
              set({ view: null })
              syncUrl(null, 'replace')
            }
          }
          return
        }
        case 'server_created': {
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
          return
        }
        case 'server_renamed': {
          const { old_name, server } = ev
          staleInvites(old_name)
          set(s => {
            const servers = { ...s.servers }
            const detail = servers[old_name]
            if (detail) {
              delete servers[old_name]
              servers[server.name] = {
                ...detail,
                name: server.name,
                display_name: server.display_name,
                has_password: server.has_password,
              }
            }
            const members = { ...s.members }
            const cache = members[old_name]
            if (cache) {
              delete members[old_name]
              members[server.name] = cache
            }
            const interacted = { ...s.interacted }
            const icache = interacted[old_name]
            if (icache) {
              delete interacted[old_name]
              interacted[server.name] = icache
            }
            const memberInfo = { ...s.memberInfo }
            const known = memberInfo[old_name]
            if (known) {
              delete memberInfo[old_name]
              memberInfo[server.name] = known
            }
            const reads = Object.fromEntries(
              Object.entries(s.reads).map(([scope, mark]) => [
                scope,
                mark.server === old_name ? { ...mark, server: server.name } : mark,
              ])
            )
            return {
              servers,
              members,
              memberInfo,
              interacted,
              reads,
              voice: s.voice?.server === old_name ? { ...s.voice, server: server.name } : s.voice,
              me: s.me
                ? {
                    ...s.me,
                    servers: s.me.servers.map(x =>
                      x.name === old_name
                        ? { ...x, name: server.name, display_name: server.display_name }
                        : x
                    ),
                  }
                : s.me,
              view:
                s.view?.kind === 'channel' && s.view.server === old_name
                  ? { ...s.view, server: server.name }
                  : s.view,
              adminServers: {
                ...s.adminServers,
                list: s.adminServers.list.map(x => (x.name === old_name ? server : x)),
              },
            }
          })
          saveLayout(renameServer(get().layout, old_name, server.name))
          serverGen += 1
          if (old_name !== server.name) droppedAt.set(old_name, serverGen)
          memberGen[old_name] = (memberGen[old_name] ?? 0) + 1
          memberGen[server.name] = (memberGen[server.name] ?? 0) + 1
          if (serverPager.removed()) void get().loadMoreServers()
          if (get().guest && get().guestServers.includes(old_name)) {
            persistGuestServers(get().guestServers.map(n => (n === old_name ? server.name : n)))
            const names = { ...get().guestNames, [server.name]: server.display_name }
            if (old_name !== server.name) delete names[old_name]
            persistGuestNames(names)
            const grants = get().guestGrants
            if (old_name !== server.name && grants[old_name]) {
              const next = { ...grants, [server.name]: grants[old_name] }
              delete next[old_name]
              persistGrants(next)
            }
            home.ws.unsubscribe(old_name)
            home.ws.subscribe([server.name])
            if (server.has_password)
              void api.getServer(server.name).catch((e: unknown) => {
                if (lockedOut(e)) guestLocked(server.name)
              })
          }
          const renamedView = get().view
          if (renamedView?.kind === 'channel' && renamedView.server === server.name)
            syncUrl(renamedView, 'replace')
          return
        }
        case 'server_deleted': {
          staleInvites(ev.name)
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
          return
        }
        case 'member_joined': {
          staleInvites(ev.server)
          const self = get().me?.username === ev.member.username
          if (!self) patchServer(ev.server, d => ({ ...d, member_count: d.member_count + 1 }))
          patchMembers(ev.server, list => [
            ...list.filter(m => m.username !== ev.member.username),
            ev.member,
          ])
          if (get().memberInfo[ev.server])
            writeMemberInfo(ev.server, [[ev.member.username, ev.member]])
          if (self) void addServer(ev.server).catch(() => {})
          return
        }
        case 'member_left':
        case 'member_kicked': {
          staleInvites(ev.server)
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
          patchMembers(ev.server, list => list.filter(m => m.username !== ev.username))
          if (Object.hasOwn(get().memberInfo[ev.server] ?? {}, ev.username))
            writeMemberInfo(ev.server, [[ev.username, null]])
          return
        }
        case 'admin_changed': {
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
          if (get().me?.username === ev.username) refetchServer(ev.server)
          return
        }
        case 'roles_changed': {
          if (!get().servers[ev.server]) return
          refetchServer(ev.server)
          void get().loadMembers(ev.server, true)
          refreshMemberInfo(ev.server)
          return
        }
        case 'channel_perms_changed': {
          refetchServer(ev.server)
          return
        }
        case 'user_updated': {
          const u = ev.user
          const byAuthor = (m: Message) => m.author.username === u.username
          const reauthor = (list: Message[]) => mapWhere(list, byAuthor, m => ({ ...m, author: u }))
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
            messages: mapLists(s.messages, reauthor),
            adminUsers: {
              ...s.adminUsers,
              list: s.adminUsers.list.map(x => (x.username === u.username ? u : x)),
            },
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
              s.profile?.user.username === u.username ? { ...s.profile, user: u } : s.profile,
          }))
          mapMemberInfo((username, m) => (username === u.username ? { ...m, ...u } : m))
          return
        }
        case 'presence_changed': {
          queuePresence(ev)
          return
        }
        case 'presence_snapshot': {
          applySnapshot(ev)
          return
        }
        case 'server_banned': {
          staleInvites(ev.server)
          const { me, servers, view } = get()
          const here = view?.kind === 'channel' && view.server === ev.server
          if (me?.username === ev.username && (here || servers[ev.server])) bannedFrom(ev.server)
          return
        }
        case 'presence_mode': {
          set(s =>
            s.me?.username === ev.username
              ? { me: { ...s.me, appear_offline: ev.appear_offline } }
              : {}
          )
          return
        }
        case 'read_updated': {
          if (get().me?.username !== ev.username) return
          readQueue.seen(ev.scope, ev.last_read)
          set(s => {
            const prev = s.reads[ev.scope] ?? { lastRead: 0, latest: ev.last_read }
            const lastRead = Math.max(prev.lastRead, ev.last_read)
            return {
              reads: {
                ...s.reads,
                [ev.scope]: { ...prev, lastRead, latest: Math.max(prev.latest, ev.last_read) },
              },
              unreadAnchor: sticky.has(ev.scope)
                ? s.unreadAnchor
                : {
                    ...s.unreadAnchor,
                    [ev.scope]: Math.max(s.unreadAnchor[ev.scope] ?? 0, lastRead),
                  },
            }
          })
          return
        }
        case 'voice_state': {
          set(s => {
            const voiceUsers = { ...s.voiceUsers }
            if (ev.users.length) voiceUsers[ev.channel_id] = ev.users
            else delete voiceUsers[ev.channel_id]
            return { voiceUsers }
          })
          const { me, voice } = get()
          if (me && voice?.channelId === ev.channel_id) {
            if (ev.users.includes(me.username)) rtc.sync(ev.users)
            else {
              endedVoice = ev.channel_id
              rtc.leave()
              set({ voice: null })
            }
          }
          return
        }
        case 'call_state': {
          const { me } = get()
          if (!me) return
          if (ev.state === 'ended') {
            if (get().call?.dmId === ev.dm_id) {
              endCallMedia(ev.kind)
              set({ call: null })
            }
            return
          }
          if (!get().dms.some(d => d.id === ev.dm_id))
            void get()
              .ensureDms([ev.dm_id])
              .catch(() => {})
          set({
            call: {
              dmId: ev.dm_id,
              dmUsers: ev.dm_users,
              state: ev.state,
              from: ev.from,
              kind: ev.kind,
            },
          })
          if (ev.state !== 'active') return
          if (ev.kind === 'rtc') {
            rtc.sync(ev.dm_users)
            return
          }
          if (ev.from !== me.username) return
          const other = ev.dm_users.find(u => u !== me.username)
          if (!other) return
          const avail = get().p2pAvailability[other]
          if (avail?.online && avail.peer_id !== null) p2p.dial(avail.peer_id)
          else {
            pendingDial = other
            home.ws.sendVoice({ type: 'p2p_who', hosters: [other] })
          }
          return
        }
        case 'p2p_availability': {
          const { hoster, peer_id, ids, online } = ev
          set(s => ({
            p2pAvailability: { ...s.p2pAvailability, [hoster]: { peer_id, ids, online } },
          }))
          if (pendingDial === hoster && online && peer_id !== null) {
            pendingDial = null
            p2p.dial(peer_id)
          }
          return
        }
        case 'rtc_signal': {
          if (get().me?.username === ev.to)
            rtc.onSignal(ev.from, ev.payload).catch((e: unknown) => console.error('rtc signal', e))
          return
        }
        case 'voice_ended': {
          const { me, voice } = get()
          const mine = me !== null && (ev.dm_users?.includes(me.username) ?? false)
          if (mine && ev.channel_id !== null && voice?.channelId === ev.channel_id) {
            rtc.leave()
            set({ voice: null })
          }
          const endedChannel = ev.channel_id !== null && ev.channel_id === endedVoice
          if (endedChannel) endedVoice = null
          if (endedChannel || mine) fail(new Error(ev.reason))
          return
        }
        case 'error': {
          fail(new Error(ev.message))
          const { me, voice, call, voiceUsers } = get()
          const confirmed =
            call !== null ||
            (voice !== null &&
              me !== null &&
              (voiceUsers[voice.channelId] ?? []).includes(me.username))
          if (confirmed) return
          if (rtc.active() || voice) {
            rtc.leave()
            set({ voice: null })
          }
          if (p2p.mediaActive()) p2p.endMedia()
          return
        }
        case 'dm_created': {
          const { me } = get()
          if (me && ev.dm_users.includes(me.username)) bumpDm(ev.dm_id)
          return
        }
        case 'banned': {
          staleInvites(null)
          if (get().me?.username === ev.username) {
            expireSession()
            return
          }
          const gone = get()
            .dms.filter(d => d.other.username === ev.username)
            .map(d => `d${d.id}`)
          dmGen += 1
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
            interacted: mapPages(s.interacted, list =>
              dropWhere(list, u => u.username === ev.username)
            ),
            dms: s.dms.filter(d => d.other.username !== ev.username),
            adminOverview: s.adminOverview
              ? { ...s.adminOverview, user_count: Math.max(0, s.adminOverview.user_count - 1) }
              : s.adminOverview,
            adminUsers: {
              ...s.adminUsers,
              list: s.adminUsers.list.filter(u => u.username !== ev.username),
            },
          }))
          mapMemberInfo((username, m) => (username === ev.username ? null : m))
          set(s => (s.profile?.user.username === ev.username ? { profile: null } : {}))
          if (reload) void get().loadMoreDms()
          const { view, dms } = get()
          if (view?.kind === 'dm' && !dms.some(d => d.id === view.dmId)) {
            const self = dms.find(d => d.is_self)
            if (self) void get().openDm(self.id, 'replace')
            else {
              set({ view: null })
              syncUrl(null, 'replace')
            }
          }
          return
        }
        case 'user_registered': {
          set(s => ({
            adminOverview: s.adminOverview
              ? { ...s.adminOverview, user_count: s.adminOverview.user_count + 1 }
              : s.adminOverview,
            adminUsers:
              (s.adminUsers.list.length > 0 || !s.adminUsers.hasMore) &&
              matches(s.adminUsers.q, ev.user.username, ev.user.display_name)
                ? {
                    ...s.adminUsers,
                    list: insertSorted(
                      s.adminUsers.list,
                      ev.user,
                      (a, b) => a.username.localeCompare(b.username),
                      u => u.username,
                      s.adminUsers.hasMore
                    ),
                  }
                : s.adminUsers,
          }))
          return
        }
        case 'settings_changed': {
          set({ settings: ev.settings })
          return
        }
        case 'resync': {
          resync()
          return
        }
      }
    },

    openContextMenu: (x, y, items) => set({ contextMenu: { x, y, items } }),
    closeContextMenu: () => set({ contextMenu: null }),
    openProfile: (user, server, x, y) => set({ profile: { user, server, x, y } }),
    closeProfile: () => set(s => (s.profile ? { profile: null } : {})),
    openDialog: dialog => set({ activeDialog: dialog }),
    closeDialog: () => set({ activeDialog: null }),
    askConfirm: req =>
      set(s => ({ confirm: req, confirmSeq: s.confirmSeq + 1, contextMenu: null })),
    closeConfirm: () => set(s => (s.confirm ? { confirm: null } : {})),
    setError: message => set({ error: message }),
  }
})
