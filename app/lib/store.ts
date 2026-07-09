import { create } from 'zustand'
import * as api from './api'
import { wsClient } from './ws'
import { rtc } from './rtc'
import { newP2pId, p2p } from './p2p'
import { ALL_PERMS } from './types'
import type {
  AdminOverview,
  AuthResponse,
  AvatarKind,
  CallKind,
  ChannelKind,
  ChannelPerm,
  DmSummary,
  Embed,
  Me,
  Member,
  Message,
  P2pAvailability,
  Role,
  SearchResult,
  ServerDetail,
  ServerSummaryLite,
  SiteSettings,
  Theme,
  UserRef,
  WsEvent,
  WsStatus,
} from './types'

export type View =
  { kind: 'channel'; server: string; channelId: number } | { kind: 'dm'; dmId: number }

export type Nav = 'push' | 'replace' | 'none'

export const viewPath = (view: View | null) => {
  if (view === null) return '/'
  return view.kind === 'channel'
    ? `/s/${encodeURIComponent(view.server)}/${view.channelId}/`
    : `/dm/${view.dmId}/`
}

export const parsePath = (pathname: string): View | null => {
  const channel = pathname.match(/^\/s\/([^/]+)\/(\d+)\/?$/)
  if (channel) {
    const [, raw, id] = channel
    try {
      return { kind: 'channel', server: decodeURIComponent(raw), channelId: Number(id) }
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

export type ActiveDialog =
  | { kind: 'add_server' }
  | { kind: 'server_settings'; server: string }
  | { kind: 'admin_panel' }
  | { kind: 'ban_confirm'; username: string }
  | { kind: 'delete_user_confirm'; username: string }
  | { kind: 'settings' }

export type Panel = { kind: 'thread'; root: Message } | { kind: 'search' }

export type UploadMode = 'server' | 'p2p'

export interface PendingUpload {
  file: File
  spoiler: boolean
  mode: UploadMode
}

export type OutgoingStatus = 'queued' | 'sending' | 'failed'

export interface Outgoing {
  tempId: number
  key: string
  status: OutgoingStatus
  msg: Message
  pending: PendingUpload | null
  p2pExpiresIn: number | null
  send: (opts: api.SendOpts) => Promise<Message>
}

export interface Notice {
  id: number
  title: string
  body: string
  go: () => void
}

export interface SearchArgs {
  q: string
  from: string
  channelId: number | null
  hasFile: boolean
  beforeTs: number | null
  afterTs: number | null
}

export interface SearchState {
  results: SearchResult[]
  hasMore: boolean
  loading: boolean
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

export const filterSearchPage = (
  raw: SearchResult[],
  seenIds: Set<number>,
  beforeTs: number | null,
  afterTs: number | null
): { filtered: SearchResult[]; hasMore: boolean } => {
  const filtered = raw.filter(
    r =>
      !seenIds.has(r.message.id) &&
      (beforeTs === null || r.message.created_at < beforeTs) &&
      (afterTs === null || r.message.created_at > afterTs)
  )
  const past = afterTs !== null && raw.some(r => r.message.created_at <= afterTs)
  return { filtered, hasMore: raw.length === 25 && !past }
}

export const MAX_UPLOAD = 25 * 1024 * 1024
export const PAGE = 50

export interface Paged<T> {
  list: T[]
  hasMore: boolean
  loading: boolean
  q: string
}

const emptyPage = <T>(): Paged<T> => ({ list: [], hasMore: true, loading: false, q: '' })

const LS = {
  token: 'rchat_token',
  guest: 'rchat_guest',
  guestServers: 'rchat_guest_servers',
  guestGrants: 'rchat_guest_grants',
  theme: 'rchat_theme',
  streamer: 'rchat_streamer',
}

export const viewKey = (view: View) =>
  view.kind === 'channel' ? `c${view.channelId}` : `d${view.dmId}`

const byId = (a: Message, b: Message) => a.id - b.id

const merge = (list: Message[], incoming: Message[]) => {
  const map = new Map(list.map(m => [m.id, m]))
  for (const m of incoming) map.set(m.id, m)
  return [...map.values()].sort(byId)
}

const OPT_BASE = 1e15
let optSeq = 0
const draining = new Set<string>()

interface RChatState {
  token: string | null
  me: Me | null
  guest: boolean
  guestServers: string[]
  guestGrants: Record<string, string>
  servers: Record<string, ServerDetail>
  members: Record<string, Paged<Member>>
  interacted: Record<string, Paged<UserRef>>
  adminUsers: Paged<UserRef>
  adminServers: Paged<ServerSummaryLite>
  dms: DmSummary[]
  voice: VoiceSession | null
  call: CallSession | null
  voiceUsers: Record<number, string[]>
  p2pAvailability: Record<string, P2pAvailability>
  rtcTick: number
  view: View | null
  messages: Record<string, Message[]>
  outbox: Record<string, Outgoing[]>
  reads: Record<string, { lastRead: number; latest: number }>
  unreadAnchor: Record<string, number>
  atBottom: boolean
  authExpired: boolean
  wsStatus: WsStatus
  theme: Theme
  streamer: boolean
  contextMenu: ContextMenuState | null
  activeDialog: ActiveDialog | null
  panel: Panel | null
  pending: PendingUpload | null
  threadPending: PendingUpload | null
  notices: Notice[]
  search: SearchState
  error: string | null
  adminOverview: AdminOverview | null
  settings: SiteSettings
  bootstrap: () => Promise<void>
  loadSettings: () => Promise<void>
  setTheme: (theme: Theme) => void
  setStreamer: (streamer: boolean) => void
  patchMe: (avatar_kind: AvatarKind, avatar_color?: string) => Promise<void>
  syncFromUrl: (nav: 'replace' | 'none') => Promise<void>
  register: (body: api.RegisterRequest) => Promise<void>
  login: (body: api.LoginRequest) => Promise<void>
  logout: () => void
  enterGuest: () => Promise<void>
  guestJoinServer: (name: string, password?: string) => Promise<void>
  openServer: (name: string, channelId?: number, nav?: Nav) => Promise<void>
  openChannel: (server: string, channelId: number, nav?: Nav) => Promise<void>
  openDm: (dmId: number, nav?: Nav) => Promise<void>
  startDm: (username: string) => Promise<void>
  sendMessage: (content: string, p2pExpiresIn?: number | null) => void
  markRead: (scope: string, messageId: number) => void
  setAtBottom: (v: boolean) => void
  retryOutgoing: (key: string, tempId: number) => void
  cancelOutgoing: (key: string, tempId: number) => void
  loadOlder: () => Promise<void>
  uploadFile: (file: File | null, thread?: boolean) => void
  toggleSpoiler: (thread?: boolean) => void
  toggleUploadMode: (thread?: boolean) => void
  openThread: (root: Message) => Promise<void>
  openSearch: () => void
  closePanel: () => void
  loadOlderThread: () => Promise<void>
  sendThreadMessage: (content: string, p2pExpiresIn?: number | null) => void
  searchRun: (args: SearchArgs, reset: boolean) => Promise<void>
  dismissNotice: (id: number) => void
  deleteMessage: (id: number) => Promise<void>
  deleteMedia: (messageId: number) => Promise<void>
  deleteEmbed: (messageId: number, ord: number, banner: boolean) => Promise<void>
  createServer: (name: string, password?: string) => Promise<void>
  joinServer: (name: string, password?: string) => Promise<void>
  leaveServer: (name: string) => Promise<void>
  renameServer: (name: string, newName: string) => Promise<void>
  setServerPassword: (name: string, password: string) => Promise<void>
  deleteServer: (name: string) => Promise<void>
  createChannel: (server: string, name: string, kind?: ChannelKind) => Promise<void>
  renameChannel: (id: number, name: string) => Promise<void>
  setSlowmode: (id: number, seconds: number) => Promise<void>
  deleteChannel: (id: number) => Promise<void>
  kickMember: (server: string, username: string) => Promise<void>
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
  openDialog: (dialog: ActiveDialog) => void
  closeDialog: () => void
  setError: (message: string | null) => void
}

export const serverAdminPerms = (s: RChatState, server: string): number => {
  const { me } = s
  if (!me) return 0
  const row = s.members[server]?.list.find(m => m.username === me.username)
  if (row) {
    if (row.is_admin) return row.perms === 0 ? ALL_PERMS : row.perms & ALL_PERMS
    const roles = s.servers[server]?.roles ?? []
    return (
      roles.filter(r => row.role_ids.includes(r.id)).reduce((acc, r) => acc | r.perms, 0) &
      ALL_PERMS
    )
  }
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

export const serverUnread = (s: RChatState, name: string): boolean =>
  (s.servers[name]?.channels ?? []).some(c => c.kind === 'text' && isUnread(s, `c${c.id}`))

export const dmsUnread = (s: RChatState): boolean => s.dms.some(d => isUnread(s, `d${d.id}`))

export const userRefFor = (s: RChatState, username: string): UserRef => {
  if (s.me?.username === username) return s.me
  const dm = s.dms.find(d => d.other.username === username)
  if (dm) return dm.other
  for (const cache of Object.values(s.members)) {
    const m = cache.list.find(x => x.username === username)
    if (m) return m
  }
  for (const cache of Object.values(s.interacted)) {
    const u = cache.list.find(x => x.username === username)
    if (u) return u
  }
  return { username, display_name: username, avatar_kind: 'identicon', avatar_color: null }
}

export const roleMenuItems = (server: string, username: string): ContextMenuItem[] => {
  const s = useStore.getState()
  const roles = s.servers[server]?.roles ?? []
  const roleIds = s.members[server]?.list.find(m => m.username === username)?.role_ids ?? []
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

export const useStore = create<RChatState>()((set, get) => {
  const fail = (e: unknown) => {
    const message = e instanceof Error ? e.message : String(e)
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

  const expireSession = () => {
    if (get().authExpired) return
    get().logout()
    set({ authExpired: true })
  }

  const refetchMe = () =>
    api
      .me()
      .then(me => set({ me, dms: me.dms }))
      .catch(e => {
        if (e instanceof api.ApiError && e.status === 401) expireSession()
        else fail(e)
      })

  const refreshView = async () => {
    const { view } = get()
    if (!view) return
    try {
      const msgs =
        view.kind === 'channel'
          ? await api.channelMessages(view.channelId)
          : await api.dmMessages(view.dmId)
      set(s => ({ messages: { ...s.messages, [viewKey(view)]: [...msgs].sort(byId) } }))
      askP2p(msgs)
      if (view.kind === 'channel') {
        const detail = await api.getServer(view.server)
        set(s => ({ servers: { ...s.servers, [view.server]: detail } }))
      }
    } catch (e) {
      console.error('degraded poll', e)
    }
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
    if (hosters.length) wsClient.sendVoice({ type: 'p2p_who', hosters })
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

  const loadUnreads = () =>
    api
      .getUnreads()
      .then(({ items }) =>
        set({
          reads: Object.fromEntries(
            items.map(i => [i.scope, { lastRead: i.last_read, latest: i.latest }])
          ),
        })
      )
      .catch(() => {})

  const startWs = () => {
    wsClient.onEvent = ev => get().applyWsEvent(ev)
    wsClient.onStatus = wsStatus => {
      set({ wsStatus })
      if (wsStatus !== 'green' && (get().voice || get().call)) endRtc()
      if (wsStatus === 'green') {
        set({ p2pAvailability: {}, voiceUsers: {} })
        if (get().me) {
          p2p.announce()
          void refetchMe()
        }
        const { view } = get()
        if (view) askP2p(get().messages[viewKey(view)] ?? [])
      }
    }
    wsClient.onPoll = () => {
      void refreshView()
      if (get().me) void refetchMe()
      void get().loadSettings()
    }
    wsClient.start(get().token)
    p2p.ensurePurge()
    if (get().me) void loadUnreads()
    if (get().guest) wsClient.subscribe(get().guestServers)
  }

  const persistGuestServers = (list: string[]) => {
    localStorage.setItem(LS.guestServers, JSON.stringify(list))
    set({ guestServers: list })
  }

  const persistGrants = (grants: Record<string, string>) => {
    localStorage.setItem(LS.guestGrants, JSON.stringify(grants))
    api.setGrants(grants)
    wsClient.setGrants(grants)
    set({ guestGrants: grants })
  }

  const dropGrant = (server: string) => {
    if (!(server in get().guestGrants)) return
    const grants = { ...get().guestGrants }
    delete grants[server]
    persistGrants(grants)
  }

  const fetchServer = async (name: string) => {
    try {
      return await api.getServer(name)
    } catch (e) {
      if (get().guest && e instanceof api.ApiError && e.status === 401) dropGrant(name)
      throw e
    }
  }

  const setTokenCookie = (token: string | null) => {
    const attrs = `path=/; SameSite=Strict${window.location.protocol === 'https:' ? '; Secure' : ''}`
    document.cookie = token
      ? `rchat_token=${token}; ${attrs}; max-age=31536000`
      : `rchat_token=; ${attrs}; max-age=0`
  }

  const syncUrl = (view: View | null, nav: Nav) => {
    if (nav === 'none') return
    const path = viewPath(view)
    if (window.location.pathname === path) return
    if (nav === 'push') window.history.pushState(null, '', path)
    else window.history.replaceState(null, '', path)
  }

  const resolveUrl = async (nav: 'replace' | 'none') => {
    const target = parsePath(window.location.pathname)
    const fallback = () => get().openServer('rchat', undefined, 'replace')
    const cur = get().view
    if (target && cur && viewPath(target) === viewPath(cur)) return
    if (!target) return fallback()
    if (target.kind === 'dm') {
      if (get().guest || !get().dms.some(d => d.id === target.dmId)) return fallback()
      return get().openDm(target.dmId, nav)
    }
    let detail: ServerDetail
    try {
      detail = await fetchServer(target.server)
    } catch {
      return fallback()
    }
    const { guest, guestServers } = get()
    if (guest && !guestServers.includes(target.server)) {
      persistGuestServers([...guestServers, target.server])
      wsClient.subscribe([target.server])
    }
    set(s => ({ servers: { ...s.servers, [target.server]: detail } }))
    const channel = detail.channels.find(c => c.id === target.channelId) ?? detail.channels[0]
    if (!channel) return fallback()
    return get().openChannel(
      target.server,
      channel.id,
      channel.id === target.channelId ? nav : 'replace'
    )
  }

  const enter = (res: AuthResponse) => {
    localStorage.setItem(LS.token, res.token)
    setTokenCookie(res.token)
    localStorage.removeItem(LS.guest)
    api.setToken(res.token)
    set({ token: res.token, me: res.user, dms: res.user.dms, guest: false, authExpired: false })
    startWs()
  }

  const dropServer = (name: string) => {
    if (get().voice?.server === name) get().leaveVoice()
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
    if (get().guest) {
      persistGuestServers(get().guestServers.filter(n => n !== name))
      dropGrant(name)
      wsClient.unsubscribe(name)
    }
    const { view } = get()
    if (view?.kind === 'channel' && view.server === name)
      void get().openServer('rchat', undefined, 'replace')
  }

  const messageKey = (channel_id: number | null, dm_id: number | null) => {
    if (channel_id !== null) return `c${channel_id}`
    if (dm_id !== null) return `d${dm_id}`
    return null
  }

  const patchMessage = (id: number, fn: (m: Message) => Message) => {
    set(s => ({
      messages: Object.fromEntries(
        Object.entries(s.messages).map(([k, list]) => [k, list.map(m => (m.id === id ? fn(m) : m))])
      ),
    }))
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
      return cache
        ? { members: { ...s.members, [server]: { ...cache, list: fn(cache.list) } } }
        : {}
    })
  }

  const matches = (q: string, ...names: string[]) => {
    const needle = q.toLowerCase()
    return !needle || names.some(n => n.toLowerCase().includes(needle))
  }

  const epochs: Record<string, number> = {}

  const loadPage = async <T>(
    id: string,
    read: () => Paged<T>,
    write: (page: Paged<T>) => void,
    fetchPage: (offset: number) => Promise<T[]>,
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
      ? { list: [], hasMore: true, loading: true, q }
      : { ...cur, loading: true }
    write(base)
    let page: T[]
    try {
      page = await fetchPage(base.list.length)
    } catch (e) {
      if ((epochs[id] ?? 0) === epoch) write({ ...base, loading: false })
      throw e
    }
    if ((epochs[id] ?? 0) !== epoch) return
    const seen = new Set(base.list.map(keyOf))
    write({
      ...base,
      list: [...base.list, ...page.filter(item => !seen.has(keyOf(item)))],
      hasMore: page.length === PAGE,
      loading: false,
    })
  }

  const writeMembers = (server: string) => (page: Paged<Member>) =>
    set(s => ({ members: { ...s.members, [server]: page } }))

  let noticeId = 0
  const notify = (title: string, body: string, go: () => void) => {
    noticeId += 1
    const id = noticeId
    set(s => ({ notices: [...s.notices, { id, title, body, go }].slice(-3) }))
    setTimeout(() => set(s => ({ notices: s.notices.filter(n => n.id !== id) })), 5000)
  }

  let searchOffset = 0
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
  ): Promise<{ opts: api.SendOpts; p2pId: string | null }> => {
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
        set(s => ({
          outbox: dropOutgoing(s.outbox, key, head.tempId),
          messages: { ...s.messages, [key]: merge(s.messages[key] ?? [], [real]) },
        }))
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
    servers: {},
    members: {},
    interacted: {},
    adminUsers: emptyPage<UserRef>(),
    adminServers: emptyPage<ServerSummaryLite>(),
    dms: [],
    voice: null,
    call: null,
    voiceUsers: {},
    p2pAvailability: {},
    rtcTick: 0,
    view: null,
    messages: {},
    outbox: {},
    reads: {},
    unreadAnchor: {},
    atBottom: true,
    authExpired: false,
    wsStatus: 'red',
    theme: 'dark',
    streamer: false,
    contextMenu: null,
    activeDialog: null,
    panel: null,
    pending: null,
    threadPending: null,
    notices: [],
    search: emptySearch(),
    error: null,
    adminOverview: null,
    settings: {
      profanity_filter: true,
      asset_previews: true,
      asset_uploads: true,
      guests_enabled: true,
    },

    loadSettings: async () => {
      try {
        set({ settings: await api.getSettings() })
      } catch (e) {
        fail(e)
      }
    },

    setTheme: theme => {
      localStorage.setItem(LS.theme, theme)
      document.documentElement.dataset.theme = theme
      set({ theme })
    },

    setStreamer: streamer => {
      localStorage.setItem(LS.streamer, streamer ? '1' : '0')
      document.body.classList.toggle('streamer-mode', streamer)
      set({ streamer })
    },

    patchMe: (avatar_kind, avatar_color) =>
      act(async () => {
        const user = await api.patchMe(avatar_kind, avatar_color)
        set(s => (s.me ? { me: { ...s.me, ...user } } : {}))
      }),

    bootstrap: async () => {
      if (get().me || get().guest) {
        await resolveUrl('replace')
        return
      }
      void get().loadSettings()
      const token = localStorage.getItem(LS.token)
      const guest = localStorage.getItem(LS.guest) === '1'
      const stored = localStorage.getItem(LS.guestServers)
      const guestServers: string[] = stored ? JSON.parse(stored) : ['rchat']
      if (!guestServers.includes('rchat')) guestServers.unshift('rchat')
      if (token) {
        api.setToken(token)
        try {
          const me = await api.me()
          setTokenCookie(token)
          set({ token, me, dms: me.dms, guest: false })
          startWs()
          await resolveUrl('replace')
        } catch (e) {
          fail(e)
          expireSession()
        }
      } else if (guest) {
        const storedGrants = localStorage.getItem(LS.guestGrants)
        persistGrants(storedGrants ? (JSON.parse(storedGrants) as Record<string, string>) : {})
        set({ guest: true, guestServers })
        startWs()
        await resolveUrl('replace')
      }
    },

    syncFromUrl: nav => resolveUrl(nav),

    register: body => act(async () => enter(await api.register(body))),
    login: body => act(async () => enter(await api.login(body))),

    logout: () => {
      wsClient.stop()
      rtc.leave()
      p2p.endMedia()
      pendingDial = null
      localStorage.removeItem(LS.token)
      setTokenCookie(null)
      localStorage.removeItem(LS.guest)
      api.setToken(null)
      api.setGrants({})
      wsClient.setGrants({})
      set({
        token: null,
        me: null,
        guest: false,
        guestGrants: {},
        voice: null,
        call: null,
        voiceUsers: {},
        servers: {},
        members: {},
        interacted: {},
        adminUsers: emptyPage<UserRef>(),
        adminServers: emptyPage<ServerSummaryLite>(),
        dms: [],
        view: null,
        messages: {},
        outbox: {},
        reads: {},
        unreadAnchor: {},
        atBottom: true,
        p2pAvailability: {},
        wsStatus: 'red',
        contextMenu: null,
        activeDialog: null,
        panel: null,
        pending: null,
        threadPending: null,
        notices: [],
        search: emptySearch(),
        adminOverview: null,
      })
    },

    enterGuest: () =>
      act(async () => {
        localStorage.setItem(LS.guest, '1')
        localStorage.setItem(LS.guestServers, JSON.stringify(['rchat']))
        persistGrants({})
        set({ guest: true, guestServers: ['rchat'] })
        startWs()
      }),

    guestJoinServer: (name, password) =>
      act(async () => {
        const id = name.trim().toLowerCase()
        if (password) {
          const { grant } = await api.guestAccess(id, password)
          persistGrants({ ...get().guestGrants, [id]: grant })
        }
        await fetchServer(id)
        const list = get().guestServers
        persistGuestServers(list.includes(id) ? list : [...list, id])
        wsClient.subscribe([id])
        await get().openServer(id)
      }),

    openServer: (name, channelId, nav = 'push') =>
      act(async () => {
        const detail = await fetchServer(name)
        set(s => ({ servers: { ...s.servers, [name]: detail } }))
        const target = detail.channels.find(c => c.id === channelId) ?? detail.channels[0]
        if (!target) throw new Error(`No channels you can view in ${detail.display_name}`)
        await get().openChannel(name, target.id, nav)
      }),

    openChannel: (server, channelId, nav = 'push') =>
      act(async () => {
        const view: View = { kind: 'channel', server, channelId }
        set(s => ({
          view,
          atBottom: true,
          unreadAnchor: {
            ...s.unreadAnchor,
            [`c${channelId}`]: s.reads[`c${channelId}`]?.lastRead ?? 0,
          },
        }))
        syncUrl(view, nav)
        get().setViewing(server)
        const kind = get().servers[server]?.channels.find(c => c.id === channelId)?.kind
        if (kind === 'voice') return
        const msgs = await api.channelMessages(channelId)
        set(s => ({ messages: { ...s.messages, [`c${channelId}`]: [...msgs].sort(byId) } }))
        askP2p(msgs)
      }),

    openDm: (dmId, nav = 'push') =>
      act(async () => {
        const view: View = { kind: 'dm', dmId }
        set(s => ({
          view,
          atBottom: true,
          unreadAnchor: { ...s.unreadAnchor, [`d${dmId}`]: s.reads[`d${dmId}`]?.lastRead ?? 0 },
        }))
        syncUrl(view, nav)
        get().setViewing(null)
        const msgs = await api.dmMessages(dmId)
        set(s => ({ messages: { ...s.messages, [`d${dmId}`]: [...msgs].sort(byId) } }))
        askP2p(msgs)
      }),

    startDm: username =>
      act(async () => {
        const dm = await api.openDm(username)
        set(s => ({ dms: s.dms.some(d => d.id === dm.id) ? s.dms : [...s.dms, dm] }))
        await get().openDm(dm.id)
      }),

    sendMessage: (content, p2pExpiresIn) => {
      const { view, pending, me } = get()
      if (!view || !me) return
      if (!content.trim() && !pending) return
      wsClient.ensureConnected()
      const key = viewKey(view)
      const tempId = OPT_BASE + ++optSeq
      set({ pending: null })
      enqueue({
        tempId,
        key,
        status: 'queued',
        pending,
        p2pExpiresIn: p2pExpiresIn ?? null,
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
        },
        send: opts =>
          view.kind === 'channel'
            ? api.sendChannelMessage(view.channelId, content, opts)
            : api.sendDmMessage(view.dmId, content, opts),
      })
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
            [scope]: { lastRead, latest: Math.max(prev.latest, messageId) },
          },
          unreadAnchor: { ...s.unreadAnchor, [scope]: lastRead },
        }
      })
      void api.postRead(scope, messageId).catch(() => {})
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
        const { view, messages } = get()
        if (!view) return
        const key = viewKey(view)
        const first = (messages[key] ?? [])[0]
        if (!first) return
        const older =
          view.kind === 'channel'
            ? await api.channelMessages(view.channelId, first.id)
            : await api.dmMessages(view.dmId, first.id)
        set(s => ({ messages: { ...s.messages, [key]: merge(s.messages[key] ?? [], older) } }))
        askP2p(older)
      }),

    uploadFile: (file, thread = false) => {
      if (file && !uploadOk(file)) return
      const pending: PendingUpload | null = file ? { file, spoiler: false, mode: 'server' } : null
      set(thread ? { threadPending: pending } : { pending })
    },

    toggleSpoiler: (thread = false) =>
      set(s =>
        thread
          ? {
              threadPending: s.threadPending
                ? { ...s.threadPending, spoiler: !s.threadPending.spoiler }
                : null,
            }
          : { pending: s.pending ? { ...s.pending, spoiler: !s.pending.spoiler } : null }
      ),

    toggleUploadMode: (thread = false) => {
      const flip = (p: PendingUpload | null): PendingUpload | null =>
        p ? { ...p, mode: p.mode === 'server' ? 'p2p' : 'server' } : null
      set(s => (thread ? { threadPending: flip(s.threadPending) } : { pending: flip(s.pending) }))
    },

    openThread: root =>
      act(async () => {
        set({ panel: { kind: 'thread', root }, threadPending: null })
        const msgs = await api.threadMessages(root.id)
        set(s => ({ messages: { ...s.messages, [`t${root.id}`]: [...msgs].sort(byId) } }))
        askP2p(msgs)
      }),

    openSearch: () => set({ panel: { kind: 'search' }, search: emptySearch() }),

    closePanel: () => set({ panel: null, threadPending: null }),

    loadOlderThread: () =>
      act(async () => {
        const { panel, messages } = get()
        if (panel?.kind !== 'thread') return
        const key = `t${panel.root.id}`
        const first = (messages[key] ?? [])[0]
        if (!first) return
        const older = await api.threadMessages(panel.root.id, first.id)
        set(s => ({ messages: { ...s.messages, [key]: merge(s.messages[key] ?? [], older) } }))
        askP2p(older)
      }),

    sendThreadMessage: (content, p2pExpiresIn) => {
      const { panel, threadPending, me } = get()
      if (panel?.kind !== 'thread' || !me) return
      if (!content.trim() && !threadPending) return
      const rootId = panel.root.id
      const key = `t${rootId}`
      const tempId = OPT_BASE + ++optSeq
      set({ threadPending: null })
      enqueue({
        tempId,
        key,
        status: 'queued',
        pending: threadPending,
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
        },
        send: opts => api.sendThreadMessage(rootId, content, opts),
      })
    },

    searchRun: (args, reset) =>
      act(async () => {
        const { q, from, channelId, hasFile, beforeTs, afterTs } = args
        const cur = get().search
        if (!reset && (cur.loading || !cur.hasMore)) return
        if (reset) {
          epochs.search = (epochs.search ?? 0) + 1
          searchOffset = 0
        }
        const epoch = epochs.search ?? 0
        const base: SearchState = {
          results: reset ? [] : cur.results,
          hasMore: true,
          loading: true,
        }
        set({ search: base })
        const { guest, guestServers } = get()
        let results = base.results
        let hasMore = true
        for (;;) {
          let raw: SearchResult[]
          try {
            raw = await api.search({
              q: q || undefined,
              from: from || undefined,
              channel_id: channelId ?? undefined,
              has: hasFile ? 'file' : undefined,
              offset: searchOffset,
              servers: guest ? guestServers.join(',') : undefined,
            })
          } catch (e) {
            if ((epochs.search ?? 0) === epoch)
              set({ search: { results, hasMore, loading: false } })
            throw e
          }
          if ((epochs.search ?? 0) !== epoch) return
          searchOffset += raw.length
          const seen = new Set(results.map(r => r.message.id))
          const page = filterSearchPage(raw, seen, beforeTs, afterTs)
          results = [...results, ...page.filtered]
          hasMore = page.hasMore
          if (page.filtered.length > 0 || !hasMore) break
        }
        set({ search: { results, hasMore, loading: false } })
      }),

    dismissNotice: id => set(s => ({ notices: s.notices.filter(n => n.id !== id) })),

    deleteMessage: id =>
      act(async () => {
        await api.deleteMessage(id)
        set(s => ({
          messages: Object.fromEntries(
            Object.entries(s.messages).map(([k, list]) => [k, list.filter(m => m.id !== id)])
          ),
        }))
      }),

    deleteMedia: messageId =>
      act(async () => {
        await api.deleteMedia(messageId)
        const { me, messages } = get()
        for (const list of Object.values(messages)) {
          const m = list.find(x => x.id === messageId)
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

    createServer: (name, password) =>
      act(async () => {
        await api.createServer(name, password)
        await refetchMe()
        await get().openServer(name.trim().toLowerCase())
      }),

    joinServer: (name, password) =>
      act(async () => {
        const id = name.trim().toLowerCase()
        await api.joinServer(id, password)
        await refetchMe()
        await get().openServer(id)
      }),

    leaveServer: name =>
      act(async () => {
        if (get().guest) {
          persistGuestServers(get().guestServers.filter(n => n !== name))
        } else {
          await api.leaveServer(name)
        }
        dropServer(name)
      }),

    renameServer: (name, newName) =>
      act(async () => void (await api.updateServer(name, { name: newName }))),
    setServerPassword: (name, password) =>
      act(async () => void (await api.updateServer(name, { password }))),
    deleteServer: name => act(async () => void (await api.deleteServer(name))),
    createChannel: (server, name, kind = 'text') =>
      act(async () => void (await api.createChannel(server, name, kind))),
    renameChannel: (id, name) => act(async () => void (await api.updateChannel(id, { name }))),
    setSlowmode: (id, seconds) =>
      act(async () => void (await api.updateChannel(id, { slowmode_seconds: seconds }))),
    deleteChannel: id => act(async () => void (await api.deleteChannel(id))),
    kickMember: (server, username) =>
      act(async () => void (await api.kickMember(server, username))),
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
          offset => api.listMembers(server, offset),
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
          offset => api.listInteracted(server, offset),
          u => u.username,
          '',
          reset
        )
      ),

    joinVoice: (server, channelId) =>
      act(async () => {
        const { me, guest, voice } = get()
        if (guest || !me) throw new Error('Create an account to join voice')
        wsClient.ensureConnected()
        await get().openChannel(server, channelId)
        if (voice?.channelId === channelId) return
        p2p.endMedia()
        await rtc.join(me.username, { channelId })
        if (!wsClient.sendVoice({ type: 'voice_join', channel_id: channelId })) {
          rtc.leave()
          throw new Error('Not connected')
        }
        set({ voice: { server, channelId }, call: null })
      }),

    leaveVoice: () => {
      wsClient.sendVoice({ type: 'voice_leave' })
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
        if (!wsClient.sendVoice({ type: 'call_start', dm_id: dmId })) {
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
        if (!wsClient.sendVoice({ type: 'call_start', dm_id: dmId, p2p: true })) {
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
        if (!wsClient.sendVoice({ type: 'call_accept', dm_id: call.dmId })) {
          endCallMedia(call.kind)
          throw new Error('Not connected')
        }
        set({ voice: null })
      }),

    declineCall: () => {
      const { call } = get()
      if (call) {
        wsClient.sendVoice({ type: 'call_decline', dm_id: call.dmId })
        endCallMedia(call.kind)
      }
      set({ call: null })
    },

    hangupCall: () => {
      const { call } = get()
      if (call) {
        wsClient.sendVoice({ type: 'call_leave', dm_id: call.dmId })
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
          offset => api.adminUsers(offset, q),
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
          offset => api.adminServers(offset, q),
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
      if (get().token) wsClient.setViewing(server)
    },

    applyWsEvent: ev => {
      switch (ev.type) {
        case 'message': {
          const m = ev.message
          const rootId = m.thread_root_id
          if (rootId !== null) {
            set(s => {
              const messages = { ...s.messages }
              const tkey = `t${rootId}`
              if (messages[tkey]) messages[tkey] = merge(messages[tkey], [m])
              const ckey = m.channel_id !== null ? `c${m.channel_id}` : null
              if (ckey && messages[ckey]) {
                messages[ckey] = messages[ckey].map(r =>
                  r.id === rootId ? { ...r, reply_count: r.reply_count + 1 } : r
                )
              }
              return {
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
            if (key) {
              set(s =>
                s.messages[key]
                  ? { messages: { ...s.messages, [key]: merge(s.messages[key], [m]) } }
                  : {}
              )
            }
          }
          askP2p([m])
          if (rootId === null) {
            const scope = messageKey(m.channel_id, m.dm_id)
            if (scope) {
              const meNow = get().me
              const mine = meNow?.username === m.author.username
              const viewNow = get().view
              const viewingScope = viewNow ? viewKey(viewNow) : null
              set(s => {
                const prev = s.reads[scope] ?? { lastRead: 0, latest: 0 }
                return {
                  reads: {
                    ...s.reads,
                    [scope]: { lastRead: prev.lastRead, latest: Math.max(prev.latest, m.id) },
                  },
                }
              })
              if (mine || (scope === viewingScope && get().atBottom)) get().markRead(scope, m.id)
            }
          }
          const { me, view, panel } = get()
          if (!me || m.author.username === me.username) return
          const { server, channel_id, dm_id } = ev
          if (dm_id !== null) {
            if (view?.kind === 'dm' && view.dmId === dm_id) return
            notify(m.author.display_name, m.content || m.media?.filename || 'Attachment', () => {
              void get().openDm(dm_id)
            })
          } else if (channel_id !== null && server !== null) {
            if (!m.content.toLowerCase().includes(`@${me.username}`)) return
            const viewingIt =
              rootId !== null
                ? panel?.kind === 'thread' && panel.root.id === rootId
                : view?.kind === 'channel' && view.channelId === channel_id
            if (viewingIt) return
            notify(`${m.author.display_name} mentioned you`, m.content, () => {
              void get().openServer(server, channel_id)
            })
          }
          return
        }
        case 'message_deleted': {
          set(s => {
            const rootOf = ev.thread_root_id
            const messages = Object.fromEntries(
              Object.entries(s.messages)
                .filter(([k]) => k !== `t${ev.id}`)
                .map(([k, list]) => [
                  k,
                  list
                    .filter(m => m.id !== ev.id)
                    .map(m =>
                      m.id === rootOf ? { ...m, reply_count: Math.max(0, m.reply_count - 1) } : m
                    ),
                ])
            )
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
          patchMessage(ev.message_id, m => ({ ...m, embeds: ev.embeds }))
          return
        }
        case 'embeds_removed': {
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
            adminServers: matches(s.adminServers.q, ev.server.name, ev.server.display_name)
              ? {
                  ...s.adminServers,
                  list: [
                    ...s.adminServers.list.filter(x => x.name !== ev.server.name),
                    ev.server,
                  ].sort((a, b) => a.name.localeCompare(b.name)),
                }
              : s.adminServers,
          }))
          return
        }
        case 'server_renamed': {
          const { old_name, server } = ev
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
            return {
              servers,
              members,
              interacted,
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
          if (get().guest && get().guestServers.includes(old_name)) {
            persistGuestServers(get().guestServers.map(n => (n === old_name ? server.name : n)))
            const grants = get().guestGrants
            if (grants[old_name]) {
              const next = { ...grants, [server.name]: grants[old_name] }
              delete next[old_name]
              persistGrants(next)
            }
            wsClient.unsubscribe(old_name)
            wsClient.subscribe([server.name])
          }
          const renamedView = get().view
          if (renamedView?.kind === 'channel' && renamedView.server === server.name)
            syncUrl(renamedView, 'replace')
          return
        }
        case 'server_deleted': {
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
          const self = get().me?.username === ev.member.username
          if (!self) patchServer(ev.server, d => ({ ...d, member_count: d.member_count + 1 }))
          patchMembers(ev.server, list => [
            ...list.filter(m => m.username !== ev.member.username),
            ev.member,
          ])
          if (self) void refetchMe()
          return
        }
        case 'member_left':
        case 'member_kicked': {
          if (get().me?.username === ev.username) {
            dropServer(ev.server)
            return
          }
          patchServer(ev.server, d => ({
            ...d,
            member_count: Math.max(0, d.member_count - 1),
          }))
          patchMembers(ev.server, list => list.filter(m => m.username !== ev.username))
          return
        }
        case 'admin_changed': {
          patchMembers(ev.server, list =>
            list.map(m =>
              m.username === ev.username ? { ...m, is_admin: ev.is_admin, perms: ev.perms } : m
            )
          )
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
          return
        }
        case 'channel_perms_changed': {
          refetchServer(ev.server)
          return
        }
        case 'user_updated': {
          const u = ev.user
          set(s => ({
            me: s.me && s.me.username === u.username ? { ...s.me, ...u } : s.me,
            dms: s.dms.map(d => (d.other.username === u.username ? { ...d, other: u } : d)),
            members: Object.fromEntries(
              Object.entries(s.members).map(([k, cache]) => [
                k,
                {
                  ...cache,
                  list: cache.list.map(m => (m.username === u.username ? { ...m, ...u } : m)),
                },
              ])
            ),
            messages: Object.fromEntries(
              Object.entries(s.messages).map(([k, list]) => [
                k,
                list.map(m => (m.author.username === u.username ? { ...m, author: u } : m)),
              ])
            ),
            adminUsers: {
              ...s.adminUsers,
              list: s.adminUsers.list.map(x => (x.username === u.username ? u : x)),
            },
            interacted: Object.fromEntries(
              Object.entries(s.interacted).map(([k, cache]) => [
                k,
                { ...cache, list: cache.list.map(x => (x.username === u.username ? u : x)) },
              ])
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
          }))
          return
        }
        case 'presence_changed': {
          patchServer(ev.server, d => ({
            ...d,
            online_count: Math.max(0, d.online_count + (ev.online ? 1 : -1)),
          }))
          patchMembers(ev.server, list =>
            list.map(m => (m.username === ev.username ? { ...m, online: ev.online } : m))
          )
          return
        }
        case 'read_updated': {
          if (get().me?.username !== ev.username) return
          set(s => {
            const prev = s.reads[ev.scope] ?? { lastRead: 0, latest: ev.last_read }
            const lastRead = Math.max(prev.lastRead, ev.last_read)
            return {
              reads: {
                ...s.reads,
                [ev.scope]: { lastRead, latest: Math.max(prev.latest, ev.last_read) },
              },
              unreadAnchor: {
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
            wsClient.sendVoice({ type: 'p2p_who', hosters: [other] })
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
          if (me && ev.dm_users.includes(me.username)) {
            void api
              .listDms()
              .then(dms => set({ dms }))
              .catch(fail)
          }
          return
        }
        case 'banned': {
          if (get().me?.username === ev.username) {
            expireSession()
            return
          }
          set(s => ({
            messages: Object.fromEntries(
              Object.entries(s.messages).map(([k, list]) => [
                k,
                list.filter(m => m.author.username !== ev.username),
              ])
            ),
            members: Object.fromEntries(
              Object.entries(s.members).map(([k, cache]) => [
                k,
                { ...cache, list: cache.list.filter(m => m.username !== ev.username) },
              ])
            ),
            interacted: Object.fromEntries(
              Object.entries(s.interacted).map(([k, cache]) => [
                k,
                { ...cache, list: cache.list.filter(u => u.username !== ev.username) },
              ])
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
            adminUsers: matches(s.adminUsers.q, ev.user.username, ev.user.display_name)
              ? {
                  ...s.adminUsers,
                  list: [
                    ...s.adminUsers.list.filter(u => u.username !== ev.user.username),
                    ev.user,
                  ].sort((a, b) => a.username.localeCompare(b.username)),
                }
              : s.adminUsers,
          }))
          return
        }
        case 'settings_changed': {
          set({ settings: ev.settings })
          return
        }
      }
    },

    openContextMenu: (x, y, items) => set({ contextMenu: { x, y, items } }),
    closeContextMenu: () => set({ contextMenu: null }),
    openDialog: dialog => set({ activeDialog: dialog }),
    closeDialog: () => set({ activeDialog: null }),
    setError: message => set({ error: message }),
  }
})
