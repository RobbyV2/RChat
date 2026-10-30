import { localUntil, type TimeoutWire } from './timeouts'
import type {
  AdminOverview,
  AuditEntry,
  AuthResponse,
  BlockedUser,
  Friend,
  FriendRequest,
  FriendSummary,
  AvatarKind,
  Category,
  Channel,
  ChannelKind,
  ChannelLayout,
  ChannelPerm,
  DmSummary,
  IceServers,
  InstanceInfo,
  Invite,
  Me,
  Member,
  Message,
  MessageLocation,
  Poll,
  PollKind,
  PollVoter,
  ShowResults,
  PasswordMembers,
  CreatedPassword,
  NewPassword,
  ServerPasswords,
  SystemMessages,
  Profile,
  Role,
  SearchResult,
  ServerBan,
  ServerDetail,
  ServerMatch,
  ServerSummary,
  ServerSummaryLite,
  ServerUpdated,
  SiteSettings,
  SiteSettingsPatch,
  Unread,
  UserRef,
} from './types'
import type { LayoutOrder } from './categories'
import type { Page } from './lists'
import type { Privacy, Relation, RequestStatus } from './friends'
import type { Secret } from './password'

export function resolveApiBase(
  url: string | undefined,
  hasWindow: boolean,
  host?: string,
  port?: string
): string {
  if (url) return `${url.replace(/\/+$/, '')}/api`
  if (hasWindow) return '/api'
  return `http://${host || '127.0.0.1'}:${port || '3000'}/api`
}

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public data?: unknown
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

async function failed(response: Response): Promise<never> {
  const error = await response.json().catch(() => ({ error: response.statusText }))
  throw new ApiError(error.error || response.statusText, response.status, error)
}

async function handleResponse<T>(response: Response): Promise<T> {
  if (!response.ok) return failed(response)
  return response.json()
}

const NEXT_CURSOR = 'X-Next-Cursor'

const withCursor = (path: string, cursor: string | null) =>
  cursor ? `${path}${path.includes('?') ? '&' : '?'}cursor=${seg(cursor)}` : path

const seg = encodeURIComponent

export class ApiClient {
  private token: string | null = null
  private grants: Record<string, string> = {}

  base = ''

  constructor(base: string) {
    this.setBase(base)
  }

  setBase(base: string) {
    this.base = base.replace(/\/+$/, '')
  }

  setToken(token: string | null) {
    this.token = token
  }

  setGrants(grants: Record<string, string>) {
    this.grants = grants
  }

  origin(href = typeof window === 'undefined' ? 'http://localhost/' : window.location.href) {
    return new URL(this.base, href).origin
  }

  async send(
    method: string,
    path: string,
    body?: unknown,
    extra: Record<string, string> = {},
    keepalive = false,
    timeoutMs = 0
  ): Promise<Response> {
    const headers: Record<string, string> = { ...extra }
    if (headers.Authorization === undefined && this.token) {
      headers.Authorization = `Bearer ${this.token}`
    } else if (headers.Authorization === undefined) {
      const grants = Object.values(this.grants)
      if (grants.length) headers['X-Guest-Grant'] = grants.join(',')
    }
    const init: RequestInit = keepalive ? { method, headers, keepalive } : { method, headers }
    if (timeoutMs) init.signal = AbortSignal.timeout(timeoutMs)
    if (body instanceof FormData) {
      init.body = body
    } else if (body !== undefined) {
      headers['Content-Type'] = 'application/json'
      init.body = JSON.stringify(body)
    }
    try {
      return await fetch(`${this.base}${path}`, init)
    } catch {
      throw new ApiError("Can't reach the server", 0)
    }
  }

  async req<T>(
    method: string,
    path: string,
    body?: unknown,
    extra: Record<string, string> = {},
    keepalive = false,
    timeoutMs = 0
  ): Promise<T> {
    return handleResponse<T>(await this.send(method, path, body, extra, keepalive, timeoutMs))
  }

  async page<T>(path: string): Promise<Page<T>> {
    const response = await this.send('GET', path)
    if (!response.ok) return failed(response)
    const items = (await response.json()) as T[]
    return { items, next: response.headers.get(NEXT_CURSOR) || null }
  }

  mediaUrl(id: string) {
    return `${this.base}/media/${seg(id)}`
  }

  // Guests can't load media by URL: their grant goes in a header, never in a link that could be
  // copied or kept in history. See `media_src.ts`.
  guestMedia(server?: string) {
    return !this.token && server !== undefined && this.grants[server] !== undefined
  }

  async mediaBlob(id: string, server: string, signal?: AbortSignal) {
    const grant = this.grants[server]
    const headers: Record<string, string> = grant ? { 'X-Guest-Grant': grant } : {}
    const res = await fetch(this.mediaUrl(id), { headers, signal })
    if (!res.ok) throw new ApiError('Could not load the file', res.status)
    return res.blob()
  }

  // The first `max` bytes of a file, for a text preview; the rest is never downloaded. `cut` is
  // true when the file goes on past them; `total` is its full size when the server says.
  async mediaStart(id: string, server: string | undefined, max: number, signal?: AbortSignal) {
    const headers: Record<string, string> = {}
    const grant = server !== undefined ? this.grants[server] : undefined
    if (this.token) headers.Authorization = `Bearer ${this.token}`
    else if (grant) headers['X-Guest-Grant'] = grant
    const res = await fetch(this.mediaUrl(id), { headers, signal })
    if (!res.ok || !res.body) throw new ApiError('Could not load the file', res.status)
    const length = Number(res.headers.get('content-length'))
    const total = Number.isSafeInteger(length) && length > 0 ? length : null
    return { ...(await readStart(res.body, max)), total }
  }
}

export const readStart = async (body: ReadableStream<Uint8Array>, max: number) => {
  const reader = body.getReader()
  const out = new Uint8Array(max)
  let got = 0
  let cut = false
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      const room = max - got
      out.set(value.subarray(0, room), got)
      got += Math.min(room, value.length)
      if (value.length > room) {
        cut = true
        break
      }
    }
  } finally {
    if (cut) await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
  return { bytes: out.subarray(0, got), cut }
}

export interface RegisterRequest {
  username: string
  password?: string
  words?: string[]
  avatar_kind: AvatarKind
  avatar_color?: string
}

export interface LoginRequest {
  username: string
  password?: string
  words?: string[]
}

export interface MeUpdated extends UserRef {
  banner_color: string | null
  bio: string | null
  appear_offline: boolean
}

export interface ConfigShare {
  id: string
  created_at: number
  expires_at: number
}

export interface SharedConfig {
  blob: string
  expires_at: number
}

export interface MemberFilter {
  q?: string
  admins?: boolean
}

export interface P2pAttachment {
  filename: string
  size: number
  mime: string
  sha256?: string
  p2p_id: string
  expires_in_seconds?: number
}

export interface SendOpts {
  media_id?: string
  media_spoiler?: boolean
  p2p?: P2pAttachment
  reply_to?: number
  mention_reply?: boolean
  forward_of?: number
  poll?: PollReq
}

export interface PollOptionReq {
  text: string
  emoji?: string | null
}

export interface PollReq {
  question: string
  kind: PollKind
  options?: PollOptionReq[]
  anonymous?: boolean
  show_results?: ShowResults
  allow_change?: boolean
  allow_add?: boolean
  min_choices?: number
  max_choices?: number
  scale?: number
  duration_seconds?: number | null
}

export interface PageOpts {
  before?: number
  after?: number
  around?: number
  limit?: number
}

export interface SearchParams {
  q?: string
  server?: string
  channel_id?: number
  from?: string
  has?: 'file'
  before?: number
  after?: number
  before_ts?: number
  after_ts?: number
  cursor?: string
  servers?: string[]
}

export const endpoints = (c: ApiClient) => ({
  register: (body: RegisterRequest) =>
    c.req<AuthResponse>('POST', '/auth/register', body).then(localAuth),
  login: (body: LoginRequest) => c.req<AuthResponse>('POST', '/auth/login', body).then(localAuth),
  logout: (token: string) =>
    c.req<{ ok: boolean }>(
      'POST',
      '/auth/logout',
      undefined,
      { Authorization: `Bearer ${token}` },
      true,
      3000
    ),
  words: (username: string) => c.req<{ words: string[] }>('GET', `/auth/words/${seg(username)}`),
  me: () => c.req<Me>('GET', '/me').then(localMe),
  myServers: (cursor: string | null, limit: number) =>
    c
      .page<ServerSummary>(withCursor(`/me/servers?limit=${limit}`, cursor))
      .then(p => ({ ...p, items: p.items.map(localSummary) })),
  myServersByName: (names: string[]) =>
    c
      .req<ServerSummary[]>('GET', `/me/servers?${names.map(n => `names=${seg(n)}`).join('&')}`)
      .then(list => list.map(localSummary)),
  patchMe: (avatar_kind: AvatarKind, avatar_color?: string, banner_color?: string | null) =>
    c.req<MeUpdated>('PATCH', '/me', { avatar_kind, avatar_color, banner_color }),
  setBio: (bio: string | null) => c.req<MeUpdated>('PATCH', '/me', { bio }),
  setAppearOffline: (appear_offline: boolean) =>
    c.req<MeUpdated>('PATCH', '/me', { appear_offline }),
  createConfigShare: (blob: string, expires_in: number) =>
    c.req<ConfigShare>('POST', '/config_shares', { blob, expires_in }),
  configShares: () => c.req<ConfigShare[]>('GET', '/config_shares'),
  configShare: (id: string) => c.req<SharedConfig>('GET', `/config_shares/${seg(id)}`),
  deleteConfigShare: (id: string) => c.req<{ ok: boolean }>('DELETE', `/config_shares/${seg(id)}`),
  changePassword: (current: Secret, next: Secret) =>
    c.req<{ ok: boolean }>('POST', '/me/password', { current, new: next }),
  userProfile: (username: string, server?: string | null) =>
    c.req<Profile>(
      'GET',
      `/users/${seg(username)}/profile${server ? `?server=${seg(server)}` : ''}`
    ),
  createServer: (name: string, password?: string) =>
    c.req<ServerDetail>('POST', '/servers', { name, password }),
  getServer: (name: string) => c.req<ServerDetail>('GET', `/servers/${seg(name)}`),
  serverAvailable: (name: string) =>
    c.req<{ available: boolean }>('GET', `/servers/${seg(name)}/available`),
  getInvite: (name: string, password?: string | null) =>
    c.req<Invite>(
      'GET',
      `/invites/${seg(name)}`,
      undefined,
      password ? { 'X-Invite-Password': seg(password) } : {}
    ),
  searchServers: (q: string) => c.req<ServerMatch[]>('GET', `/server_search?q=${seg(q)}`),
  guestAccess: (name: string, password?: string) =>
    c.req<{ grant: string | null }>('POST', `/servers/${seg(name)}/guest_access`, { password }),
  listMembers: (name: string, cursor: string | null, filter: MemberFilter = {}) =>
    c.page<Member>(
      withCursor(
        `/servers/${seg(name)}/members?limit=50${filter.q ? `&q=${seg(filter.q)}` : ''}${filter.admins ? '&admins=1' : ''}`,
        cursor
      )
    ),
  suggestMembers: (name: string, q: string) =>
    c.req<Member[]>('GET', `/servers/${seg(name)}/members?suggest=1&q=${seg(q)}`),
  membersByName: (name: string, usernames: string[]) =>
    c.req<Member[]>(
      'GET',
      `/servers/${seg(name)}/members?${usernames.map(u => `usernames=${seg(u)}`).join('&')}`
    ),
  listInteracted: (name: string, cursor: string | null) =>
    c.page<UserRef>(withCursor(`/servers/${seg(name)}/interacted?limit=50`, cursor)),
  joinServer: (name: string, password?: string) =>
    c.req<ServerDetail>('POST', `/servers/${seg(name)}/join`, { password }),
  leaveServer: (name: string) => c.req<unknown>('POST', `/servers/${seg(name)}/leave`),
  updateServer: (
    name: string,
    patch: {
      name?: string
      password?: string
      protected?: boolean
      members?: PasswordMembers
      keep_guests?: boolean
      banner_color?: string | null
      name_color?: string | null
    }
  ) => c.req<ServerUpdated>('PATCH', `/servers/${seg(name)}`, patch),
  deleteServer: (name: string) => c.req<unknown>('DELETE', `/servers/${seg(name)}`),
  listPasswords: (name: string) => c.req<ServerPasswords>('GET', `/servers/${seg(name)}/passwords`),
  createPassword: (name: string, body: NewPassword) =>
    c.req<CreatedPassword>('POST', `/servers/${seg(name)}/passwords`, body),
  revokePassword: (name: string, id: number) =>
    c.req<unknown>('DELETE', `/servers/${seg(name)}/passwords/${id}`),
  systemMessages: (name: string) =>
    c.req<SystemMessages>('GET', `/servers/${seg(name)}/system_messages`),
  updateSystemMessages: (name: string, patch: Partial<SystemMessages>) =>
    c.req<SystemMessages>('PATCH', `/servers/${seg(name)}/system_messages`, patch),
  createChannel: (
    server: string,
    name: string,
    kind: ChannelKind = 'text',
    category: number | null = null
  ) =>
    c.req<Channel>('POST', `/servers/${seg(server)}/channels`, {
      name,
      kind,
      category_id: category,
    }),
  createCategory: (server: string, name: string) =>
    c.req<Category>('POST', `/servers/${seg(server)}/categories`, { name }),
  renameCategory: (id: number, name: string) =>
    c.req<Category>('PATCH', `/categories/${id}`, { name }),
  deleteCategory: (id: number) => c.req<unknown>('DELETE', `/categories/${id}`),
  reorderLayout: (server: string, order: LayoutOrder & { version: number }) =>
    c.req<ChannelLayout>('PUT', `/servers/${seg(server)}/layout`, order),
  updateChannel: (
    id: number,
    patch: {
      name?: string
      slowmode_seconds?: number
      restrict_view?: boolean
      restrict_send?: boolean
      topic?: string | null
    }
  ) => c.req<Channel>('PATCH', `/channels/${id}`, patch),
  deleteChannel: (id: number) => c.req<unknown>('DELETE', `/channels/${id}`),
  kickMember: (server: string, username: string) =>
    c.req<unknown>('POST', `/servers/${seg(server)}/kick`, { username }),
  banMember: (server: string, username: string) =>
    c.req<unknown>('POST', `/servers/${seg(server)}/bans`, { username }),
  timeoutMember: (server: string, username: string, seconds: number, reason: string | null) =>
    c.req<TimeoutWire>('PUT', `/servers/${seg(server)}/timeouts/${seg(username)}`, {
      seconds,
      reason,
    }),
  removeTimeout: (server: string, username: string) =>
    c.req<unknown>('DELETE', `/servers/${seg(server)}/timeouts/${seg(username)}`),
  unbanMember: (server: string, username: string) =>
    c.req<unknown>('DELETE', `/servers/${seg(server)}/bans/${seg(username)}`),
  listBans: (server: string, cursor: string | null) =>
    c.page<ServerBan>(withCursor(`/servers/${seg(server)}/bans?limit=50`, cursor)),
  listAudit: (server: string, cursor: string | null, query: Record<string, string>) =>
    c.page<AuditEntry>(
      withCursor(`/servers/${seg(server)}/audit?${new URLSearchParams(query)}`, cursor)
    ),
  grantAdmin: (server: string, username: string) =>
    c.req<unknown>('POST', `/servers/${seg(server)}/admins`, { username }),
  revokeAdmin: (server: string, username: string) =>
    c.req<unknown>('DELETE', `/servers/${seg(server)}/admins/${seg(username)}`),
  transferAdmin: (server: string, username: string) =>
    c.req<unknown>('POST', `/servers/${seg(server)}/transfer_admin`, { username }),
  setAdminPerms: (server: string, username: string, perms: number) =>
    c.req<unknown>('PATCH', `/servers/${seg(server)}/admins/${seg(username)}/perms`, { perms }),
  createRole: (server: string, body: { name: string; color: string; perms: number }) =>
    c.req<Role>('POST', `/servers/${seg(server)}/roles`, body),
  updateRole: (
    server: string,
    id: number,
    patch: { name?: string; color?: string; perms?: number; mentionable?: boolean }
  ) => c.req<Role>('PATCH', `/servers/${seg(server)}/roles/${id}`, patch),
  deleteRole: (server: string, id: number) =>
    c.req<unknown>('DELETE', `/servers/${seg(server)}/roles/${id}`),
  assignRole: (server: string, id: number, username: string) =>
    c.req<unknown>('POST', `/servers/${seg(server)}/roles/${id}/assign`, { username }),
  unassignRole: (server: string, id: number, username: string) =>
    c.req<unknown>('DELETE', `/servers/${seg(server)}/roles/${id}/assign/${seg(username)}`),
  channelPerms: (id: number, cursor: string | null = null) =>
    c.page<ChannelPerm>(withCursor(`/channels/${id}/perms`, cursor)),
  setChannelPerm: (id: number, perm: ChannelPerm) =>
    c.req<unknown>('PUT', `/channels/${id}/perms`, perm),
  clearChannelPerm: (id: number, subject: string) =>
    c.req<unknown>('DELETE', `/channels/${id}/perms/${seg(subject)}`),
  channelMessages: (id: number, page: PageOpts = {}) =>
    c.req<Message[]>('GET', `/channels/${id}/messages${pageQuery(page)}`),
  sendChannelMessage: (id: number, content: string, opts: SendOpts = {}) =>
    c.req<Message>('POST', `/channels/${id}/messages`, { content, ...opts }),
  listDms: (cursor: string | null, limit: number) =>
    c.page<DmSummary>(withCursor(`/dms?limit=${limit}`, cursor)),
  dmsById: (ids: number[]) => c.req<DmSummary[]>('GET', `/dms?ids=${ids.join(',')}`),
  openDm: (username: string) => c.req<DmSummary>('POST', '/dms', { username }),
  closeDm: (id: number) => c.req<unknown>('POST', `/dms/${id}/close`),
  blocks: (cursor: string | null, q: string) =>
    c.page<BlockedUser>(withCursor(`/blocks?limit=50&q=${seg(q)}`, cursor)),
  blockedUsernames: () => c.req<string[]>('GET', '/blocks/usernames'),
  block: (username: string) => c.req<BlockedUser>('POST', '/blocks', { username }),
  unblock: (username: string) => c.req<unknown>('DELETE', `/blocks/${seg(username)}`),
  friends: (cursor: string | null, q: string, online = false) =>
    c.page<Friend>(
      withCursor(`/friends?limit=50&q=${seg(q)}${online ? '&online=true' : ''}`, cursor)
    ),
  friendRequests: (incoming: boolean, cursor: string | null) =>
    c.page<FriendRequest>(withCursor(`/friends/requests?limit=50&incoming=${incoming}`, cursor)),
  friendSummary: () => c.req<FriendSummary>('GET', '/friends/summary'),
  friendsSeen: (until: number) => c.req<unknown>('POST', '/friends/seen', { pings_until: until }),
  sendFriendRequest: (username: string) =>
    c.req<{ status: RequestStatus; user: UserRef }>('POST', '/friends/requests', { username }),
  cancelFriendRequest: (username: string) =>
    c.req<unknown>('DELETE', `/friends/requests/${seg(username)}`),
  acceptFriend: (username: string) =>
    c.req<Friend>('POST', `/friends/requests/${seg(username)}/accept`),
  denyFriend: (username: string) =>
    c.req<unknown>('POST', `/friends/requests/${seg(username)}/deny`),
  friendship: (username: string) =>
    c.req<{ status: Relation }>('GET', `/users/${seg(username)}/friendship`),
  removeFriend: (username: string) =>
    c.req<unknown>('DELETE', `/users/${seg(username)}/friendship`),
  privacy: () => c.req<unknown>('GET', '/me/privacy'),
  setPrivacy: (patch: Partial<Privacy>) => c.req<unknown>('PATCH', '/me/privacy', patch),
  dmMessages: (id: number, page: PageOpts = {}) =>
    c.req<Message[]>('GET', `/dms/${id}/messages${pageQuery(page)}`),
  sendDmMessage: (id: number, content: string, opts: SendOpts = {}) =>
    c.req<Message>('POST', `/dms/${id}/messages`, { content, ...opts }),
  deleteMessage: (id: number) => c.req<unknown>('DELETE', `/messages/${id}`),
  editMessage: (id: number, content: string) =>
    c.req<Message>('PATCH', `/messages/${id}`, { content }),
  deleteMedia: (id: number) => c.req<unknown>('DELETE', `/messages/${id}/media`),
  messageLocation: (id: number) => c.req<MessageLocation>('GET', `/messages/${id}/location`),
  messageLocations: (ids: number[]) =>
    c.req<MessageLocation[]>('POST', '/messages/locations', { ids }),
  pinMessage: (id: number) => c.req<unknown>('PUT', `/messages/${id}/pin`),
  unpinMessage: (id: number) => c.req<unknown>('DELETE', `/messages/${id}/pin`),
  channelPins: (id: number) => c.req<Message[]>('GET', `/channels/${id}/pins`),
  dmPins: (id: number) => c.req<Message[]>('GET', `/dms/${id}/pins`),
  deleteEmbed: (id: number, ord: number, banner: boolean) =>
    c.req<unknown>('DELETE', `/messages/${id}/embeds/${ord}${banner ? '?banner=1' : ''}`),
  addReaction: (id: number, emoji: string) =>
    c.req<unknown>('PUT', `/messages/${id}/reactions/${seg(emoji)}`),
  removeReaction: (id: number, emoji: string) =>
    c.req<unknown>('DELETE', `/messages/${id}/reactions/${seg(emoji)}`),
  reactors: (id: number, emoji: string) =>
    c.req<UserRef[]>('GET', `/messages/${id}/reactions/${seg(emoji)}?limit=100`),
  poll: (id: number) => c.req<Poll>('GET', `/polls/${id}`),
  vote: (id: number, body: { options?: number[]; value?: number }) =>
    c.req<Poll>('PUT', `/polls/${id}/vote`, body),
  retractVote: (id: number) => c.req<Poll>('DELETE', `/polls/${id}/vote`),
  addPollOption: (id: number, text: string, emoji: string | null) =>
    c.req<Poll>('POST', `/polls/${id}/options`, { text, emoji }),
  closePoll: (id: number) => c.req<Poll>('POST', `/polls/${id}/close`),
  reopenPoll: (id: number) => c.req<Poll>('POST', `/polls/${id}/reopen`),
  pollVoters: (id: number, option: number | null, cursor: string | null) =>
    c.page<PollVoter>(
      withCursor(
        `/polls/${id}/voters?limit=50${option === null ? '' : `&option=${option}`}`,
        cursor
      )
    ),
  threadMessages: (id: number, page: PageOpts = {}) =>
    c.req<Message[]>('GET', `/messages/${id}/thread${pageQuery(page)}`),
  sendThreadMessage: (id: number, content: string, opts: SendOpts = {}) =>
    c.req<Message>('POST', `/messages/${id}/thread`, { content, ...opts }),
  search: (params: SearchParams) => {
    const qs = new URLSearchParams()
    for (const [k, v] of Object.entries(params)) {
      if (Array.isArray(v)) for (const item of v) qs.append(k, String(item))
      else if (v !== undefined) qs.set(k, String(v))
    }
    return c.page<SearchResult>(`/search?${qs.toString()}`)
  },
  getUnreads: () => c.req<{ items: Unread[]; more: boolean }>('GET', '/unreads'),
  postRead: (scope: string, last_read: number, keepalive = false, pings_until?: number) =>
    c.req<void>(
      'POST',
      '/read',
      pings_until === undefined ? { scope, last_read } : { scope, last_read, pings_until },
      {},
      keepalive
    ),
  postReadBatch: (scopes: string[]) => c.req<{ ok: boolean }>('POST', '/read/batch', { scopes }),
  uploadMedia: (file: File) => {
    const form = new FormData()
    form.append('file', file, file.name)
    return c.req<{ id: string }>('POST', '/media', form)
  },
  getSettings: () => c.req<SiteSettings>('GET', '/settings'),
  patchSettings: (body: SiteSettingsPatch) => c.req<SiteSettings>('PATCH', '/admin/settings', body),
  adminOverview: () => c.req<AdminOverview>('GET', '/admin/overview'),
  adminUsers: (cursor: string | null, q: string) =>
    c.page<UserRef>(withCursor(`/admin/users?limit=50&q=${seg(q)}`, cursor)),
  adminServers: (cursor: string | null, q: string) =>
    c.page<ServerSummaryLite>(withCursor(`/admin/servers?limit=50&q=${seg(q)}`, cursor)),
  adminDeleteServer: (name: string) => c.req<unknown>('DELETE', `/admin/servers/${seg(name)}`),
  adminDeleteUser: (username: string) => c.req<unknown>('DELETE', `/admin/users/${seg(username)}`),
  adminUserServers: (username: string, cursor: string | null = null) =>
    c.page<ServerSummaryLite>(withCursor(`/admin/users/${seg(username)}/servers`, cursor)),
  adminDeleteMessage: (id: number) => c.req<unknown>('DELETE', `/admin/messages/${id}`),
  banUser: (username: string) => c.req<unknown>('POST', '/admin/ban', { username }),
  instance: () => c.req<InstanceInfo>('GET', '/instance'),
  identityAssertion: (aud: string, nonce?: string) =>
    c.req<Assertion>('POST', '/identity/assertion', { aud, nonce }),
  p2pIce: () => c.req<IceServers>('GET', '/p2p/ice'),
})

export type Api = ApiClient & ReturnType<typeof endpoints>

export const createApi = (base: string): Api => {
  const client = new ApiClient(base)
  return Object.assign(client, endpoints(client))
}

export interface Assertion {
  token: string
  iss: string
  sub: string
  expires_at: number
}

// Your own timeouts end on this device's clock, counted from the seconds left the server sent.
export const localSummary = (s: ServerSummary, now = Date.now()): ServerSummary =>
  s.timed_out_remaining === undefined
    ? s
    : { ...s, timed_out_until: localUntil(s.timed_out_remaining, now) }

const localMe = (me: Me): Me => ({ ...me, servers: me.servers.map(s => localSummary(s)) })

const localAuth = (res: AuthResponse): AuthResponse => ({ ...res, user: localMe(res.user) })

function pageQuery(page: PageOpts) {
  const parts = Object.entries(page)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${v}`)
  return parts.length ? `?${parts.join('&')}` : ''
}
