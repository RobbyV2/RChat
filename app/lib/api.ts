import type {
  AdminOverview,
  AuthResponse,
  AvatarKind,
  Channel,
  ChannelKind,
  ChannelPerm,
  DmSummary,
  InstanceInfo,
  Invite,
  Me,
  Member,
  Message,
  PasswordMembers,
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
import type { Page } from './lists'
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

export const NEXT_CURSOR = 'X-Next-Cursor'

export const withCursor = (path: string, cursor: string | null) =>
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

  mediaUrl(id: string, server?: string) {
    const grant = this.token || !server ? undefined : this.grants[server]
    const suffix = grant ? `?grant=${seg(grant)}` : ''
    return `${this.base}/media/${seg(id)}${suffix}`
  }
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

export interface MemberFilter {
  q?: string
  admins?: boolean
}

export interface P2pAttachment {
  filename: string
  size: number
  mime: string
  p2p_id: string
  expires_in_seconds?: number
}

export interface SendOpts {
  media_id?: string
  media_spoiler?: boolean
  p2p?: P2pAttachment
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
  register: (body: RegisterRequest) => c.req<AuthResponse>('POST', '/auth/register', body),
  login: (body: LoginRequest) => c.req<AuthResponse>('POST', '/auth/login', body),
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
  me: () => c.req<Me>('GET', '/me'),
  myServers: (cursor: string | null, limit: number) =>
    c.page<ServerSummary>(withCursor(`/me/servers?limit=${limit}`, cursor)),
  myServersByName: (names: string[]) =>
    c.req<ServerSummary[]>('GET', `/me/servers?${names.map(n => `names=${seg(n)}`).join('&')}`),
  patchMe: (avatar_kind: AvatarKind, avatar_color?: string, banner_color?: string | null) =>
    c.req<MeUpdated>('PATCH', '/me', { avatar_kind, avatar_color, banner_color }),
  setBio: (bio: string | null) => c.req<MeUpdated>('PATCH', '/me', { bio }),
  setAppearOffline: (appear_offline: boolean) =>
    c.req<MeUpdated>('PATCH', '/me', { appear_offline }),
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
  serverExists: (name: string) =>
    c.req<{ has_password: boolean }>('GET', `/servers/${seg(name)}/exists`),
  getInvite: (name: string, password?: string | null) =>
    c.req<Invite>(
      'GET',
      `/invites/${seg(name)}`,
      undefined,
      password ? { 'X-Invite-Password': seg(password) } : {}
    ),
  searchServers: (q: string) => c.req<ServerMatch[]>('GET', `/server_search?q=${seg(q)}`),
  guestAccess: (name: string, password: string) =>
    c.req<{ grant: string }>('POST', `/servers/${seg(name)}/guest_access`, { password }),
  listMembers: (name: string, cursor: string | null, filter: MemberFilter = {}) =>
    c.page<Member>(
      withCursor(
        `/servers/${seg(name)}/members?limit=50${filter.q ? `&q=${seg(filter.q)}` : ''}${filter.admins ? '&admins=1' : ''}`,
        cursor
      )
    ),
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
    patch: { name?: string; password?: string; members?: PasswordMembers; keep_guests?: boolean }
  ) => c.req<ServerUpdated>('PATCH', `/servers/${seg(name)}`, patch),
  deleteServer: (name: string) => c.req<unknown>('DELETE', `/servers/${seg(name)}`),
  createChannel: (server: string, name: string, kind: ChannelKind = 'text') =>
    c.req<Channel>('POST', `/servers/${seg(server)}/channels`, { name, kind }),
  updateChannel: (id: number, patch: { name?: string; slowmode_seconds?: number }) =>
    c.req<Channel>('PATCH', `/channels/${id}`, patch),
  deleteChannel: (id: number) => c.req<unknown>('DELETE', `/channels/${id}`),
  kickMember: (server: string, username: string) =>
    c.req<unknown>('POST', `/servers/${seg(server)}/kick`, { username }),
  banMember: (server: string, username: string) =>
    c.req<unknown>('POST', `/servers/${seg(server)}/bans`, { username }),
  unbanMember: (server: string, username: string) =>
    c.req<unknown>('DELETE', `/servers/${seg(server)}/bans/${seg(username)}`),
  listBans: (server: string, cursor: string | null) =>
    c.page<ServerBan>(withCursor(`/servers/${seg(server)}/bans?limit=50`, cursor)),
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
    patch: { name?: string; color?: string; perms?: number }
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
  dmMessages: (id: number, page: PageOpts = {}) =>
    c.req<Message[]>('GET', `/dms/${id}/messages${pageQuery(page)}`),
  sendDmMessage: (id: number, content: string, opts: SendOpts = {}) =>
    c.req<Message>('POST', `/dms/${id}/messages`, { content, ...opts }),
  deleteMessage: (id: number) => c.req<unknown>('DELETE', `/messages/${id}`),
  deleteMedia: (id: number) => c.req<unknown>('DELETE', `/messages/${id}/media`),
  deleteEmbed: (id: number, ord: number, banner: boolean) =>
    c.req<unknown>('DELETE', `/messages/${id}/embeds/${ord}${banner ? '?banner=1' : ''}`),
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
  postRead: (scope: string, last_read: number, keepalive = false) =>
    c.req<void>('POST', '/read', { scope, last_read }, {}, keepalive),
  uploadMedia: (file: File) => {
    const form = new FormData()
    form.append('file', file, file.name)
    return c.req<{ id: string }>('POST', '/media', form)
  },
  mediaUrl: (id: string, server?: string) => c.mediaUrl(id, server),
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

export function pageQuery(page: PageOpts) {
  const parts = Object.entries(page)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${v}`)
  return parts.length ? `?${parts.join('&')}` : ''
}
