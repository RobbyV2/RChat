import type {
  AdminOverview,
  AuthResponse,
  AvatarKind,
  Channel,
  ChannelKind,
  ChannelPerm,
  DmSummary,
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
  Unread,
  UserRef,
} from './types'
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

const API = resolveApiBase(
  process.env.NEXT_PUBLIC_API_URL,
  typeof window !== 'undefined',
  process.env.HOST,
  process.env.SERVER_PORT
)

let authToken: string | null = null
let guestGrants: Record<string, string> = {}

export function setToken(token: string | null) {
  authToken = token
}

export function setGrants(grants: Record<string, string>) {
  guestGrants = grants
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

async function handleResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }))
    throw new ApiError(error.error || response.statusText, response.status, error)
  }
  return response.json()
}

async function req<T>(
  method: string,
  path: string,
  body?: unknown,
  extra: Record<string, string> = {}
): Promise<T> {
  const headers: Record<string, string> = { ...extra }
  if (authToken) {
    headers.Authorization = `Bearer ${authToken}`
  } else {
    const grants = Object.values(guestGrants)
    if (grants.length) headers['X-Guest-Grant'] = grants.join(',')
  }
  const init: RequestInit = { method, headers }
  if (body instanceof FormData) {
    init.body = body
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json'
    init.body = JSON.stringify(body)
  }
  let response: Response
  try {
    response = await fetch(`${API}${path}`, init)
  } catch {
    throw new ApiError("Can't reach the server", 0)
  }
  return handleResponse<T>(response)
}

export const apiOrigin = () => new URL(API, window.location.href).origin

const seg = encodeURIComponent

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

export const register = (body: RegisterRequest) => req<AuthResponse>('POST', '/auth/register', body)
export const login = (body: LoginRequest) => req<AuthResponse>('POST', '/auth/login', body)
export const words = (username: string) =>
  req<{ words: string[] }>('GET', `/auth/words/${seg(username)}`)
export const me = () => req<Me>('GET', '/me')
export const myServers = (offset: number, limit: number) =>
  req<ServerSummary[]>('GET', `/me/servers?offset=${offset}&limit=${limit}`)
export const myServersByName = (names: string[]) =>
  req<ServerSummary[]>('GET', `/me/servers?${names.map(n => `names=${seg(n)}`).join('&')}`)
export interface MeUpdated extends UserRef {
  banner_color: string | null
  appear_offline: boolean
}

export const patchMe = (
  avatar_kind: AvatarKind,
  avatar_color?: string,
  banner_color?: string | null
) => req<MeUpdated>('PATCH', '/me', { avatar_kind, avatar_color, banner_color })
export const setAppearOffline = (appear_offline: boolean) =>
  req<MeUpdated>('PATCH', '/me', { appear_offline })
export const changePassword = (current: Secret, next: Secret) =>
  req<{ ok: boolean }>('POST', '/me/password', { current, new: next })
export const userProfile = (username: string, server?: string | null) =>
  req<Profile>('GET', `/users/${seg(username)}/profile${server ? `?server=${seg(server)}` : ''}`)

export const createServer = (name: string, password?: string) =>
  req<ServerDetail>('POST', '/servers', { name, password })
export const getServer = (name: string) => req<ServerDetail>('GET', `/servers/${seg(name)}`)
export const serverExists = (name: string) =>
  req<{ has_password: boolean }>('GET', `/servers/${seg(name)}/exists`)
export const getInvite = (name: string, password?: string | null) =>
  req<Invite>(
    'GET',
    `/invites/${seg(name)}`,
    undefined,
    password ? { 'X-Invite-Password': seg(password) } : {}
  )
export const searchServers = (q: string) => req<ServerMatch[]>('GET', `/server_search?q=${seg(q)}`)
export const guestAccess = (name: string, password: string) =>
  req<{ grant: string }>('POST', `/servers/${seg(name)}/guest_access`, { password })
export const listMembers = (name: string, offset: number) =>
  req<Member[]>('GET', `/servers/${seg(name)}/members?offset=${offset}&limit=50`)
export const membersByName = (name: string, usernames: string[]) =>
  req<Member[]>(
    'GET',
    `/servers/${seg(name)}/members?${usernames.map(u => `usernames=${seg(u)}`).join('&')}`
  )
export const listInteracted = (name: string, offset: number) =>
  req<UserRef[]>('GET', `/servers/${seg(name)}/interacted?offset=${offset}&limit=50`)
export const joinServer = (name: string, password?: string) =>
  req<ServerDetail>('POST', `/servers/${seg(name)}/join`, { password })
export const leaveServer = (name: string) => req<unknown>('POST', `/servers/${seg(name)}/leave`)
export const updateServer = (
  name: string,
  patch: { name?: string; password?: string; members?: PasswordMembers }
) => req<ServerUpdated>('PATCH', `/servers/${seg(name)}`, patch)
export const deleteServer = (name: string) => req<unknown>('DELETE', `/servers/${seg(name)}`)
export const createChannel = (server: string, name: string, kind: ChannelKind = 'text') =>
  req<Channel>('POST', `/servers/${seg(server)}/channels`, { name, kind })
export const updateChannel = (id: number, patch: { name?: string; slowmode_seconds?: number }) =>
  req<Channel>('PATCH', `/channels/${id}`, patch)
export const deleteChannel = (id: number) => req<unknown>('DELETE', `/channels/${id}`)
export const kickMember = (server: string, username: string) =>
  req<unknown>('POST', `/servers/${seg(server)}/kick`, { username })
export const banMember = (server: string, username: string) =>
  req<unknown>('POST', `/servers/${seg(server)}/bans`, { username })
export const unbanMember = (server: string, username: string) =>
  req<unknown>('DELETE', `/servers/${seg(server)}/bans/${seg(username)}`)
export const listBans = (server: string, offset: number) =>
  req<ServerBan[]>('GET', `/servers/${seg(server)}/bans?offset=${offset}&limit=50`)
export const grantAdmin = (server: string, username: string) =>
  req<unknown>('POST', `/servers/${seg(server)}/admins`, { username })
export const revokeAdmin = (server: string, username: string) =>
  req<unknown>('DELETE', `/servers/${seg(server)}/admins/${seg(username)}`)
export const transferAdmin = (server: string, username: string) =>
  req<unknown>('POST', `/servers/${seg(server)}/transfer_admin`, { username })
export const setAdminPerms = (server: string, username: string, perms: number) =>
  req<unknown>('PATCH', `/servers/${seg(server)}/admins/${seg(username)}/perms`, { perms })
export const createRole = (server: string, body: { name: string; color: string; perms: number }) =>
  req<Role>('POST', `/servers/${seg(server)}/roles`, body)
export const updateRole = (
  server: string,
  id: number,
  patch: { name?: string; color?: string; perms?: number }
) => req<Role>('PATCH', `/servers/${seg(server)}/roles/${id}`, patch)
export const deleteRole = (server: string, id: number) =>
  req<unknown>('DELETE', `/servers/${seg(server)}/roles/${id}`)
export const assignRole = (server: string, id: number, username: string) =>
  req<unknown>('POST', `/servers/${seg(server)}/roles/${id}/assign`, { username })
export const unassignRole = (server: string, id: number, username: string) =>
  req<unknown>('DELETE', `/servers/${seg(server)}/roles/${id}/assign/${seg(username)}`)
export const channelPerms = (id: number) => req<ChannelPerm[]>('GET', `/channels/${id}/perms`)
export const setChannelPerm = (id: number, perm: ChannelPerm) =>
  req<unknown>('PUT', `/channels/${id}/perms`, perm)
export const clearChannelPerm = (id: number, subject: string) =>
  req<unknown>('DELETE', `/channels/${id}/perms/${seg(subject)}`)

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

export const channelMessages = (id: number, page: PageOpts = {}) =>
  req<Message[]>('GET', `/channels/${id}/messages${pageQuery(page)}`)
export const sendChannelMessage = (id: number, content: string, opts: SendOpts = {}) =>
  req<Message>('POST', `/channels/${id}/messages`, { content, ...opts })
export const listDms = (offset: number, limit: number) =>
  req<DmSummary[]>('GET', `/dms?offset=${offset}&limit=${limit}`)
export const dmsById = (ids: number[]) => req<DmSummary[]>('GET', `/dms?ids=${ids.join(',')}`)
export const openDm = (username: string) => req<DmSummary>('POST', '/dms', { username })
export const dmMessages = (id: number, page: PageOpts = {}) =>
  req<Message[]>('GET', `/dms/${id}/messages${pageQuery(page)}`)
export const sendDmMessage = (id: number, content: string, opts: SendOpts = {}) =>
  req<Message>('POST', `/dms/${id}/messages`, { content, ...opts })
export const deleteMessage = (id: number) => req<unknown>('DELETE', `/messages/${id}`)
export const deleteMedia = (id: number) => req<unknown>('DELETE', `/messages/${id}/media`)
export const deleteEmbed = (id: number, ord: number, banner: boolean) =>
  req<unknown>('DELETE', `/messages/${id}/embeds/${ord}${banner ? '?banner=1' : ''}`)
export const threadMessages = (id: number, page: PageOpts = {}) =>
  req<Message[]>('GET', `/messages/${id}/thread${pageQuery(page)}`)
export const sendThreadMessage = (id: number, content: string, opts: SendOpts = {}) =>
  req<Message>('POST', `/messages/${id}/thread`, { content, ...opts })

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
  offset?: number
  servers?: string[]
}

export const search = (params: SearchParams) => {
  const qs = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (Array.isArray(v)) for (const item of v) qs.append(k, String(item))
    else if (v !== undefined) qs.set(k, String(v))
  }
  return req<SearchResult[]>('GET', `/search?${qs.toString()}`)
}

export const getUnreads = () => req<{ items: Unread[] }>('GET', '/unreads')
export const postRead = (scope: string, last_read: number) =>
  req<void>('POST', '/read', { scope, last_read })

export const uploadMedia = (file: File) => {
  const form = new FormData()
  form.append('file', file, file.name)
  return req<{ id: string }>('POST', '/media', form)
}
export const mediaUrl = (id: string, server?: string) => {
  const grant = authToken || !server ? undefined : guestGrants[server]
  const suffix = grant ? `?grant=${seg(grant)}` : ''
  return `${API}/media/${seg(id)}${suffix}`
}

export const getSettings = () => req<SiteSettings>('GET', '/settings')
export const patchSettings = (body: Partial<SiteSettings>) =>
  req<SiteSettings>('PATCH', '/admin/settings', body)

export const adminOverview = () => req<AdminOverview>('GET', '/admin/overview')
export const adminUsers = (offset: number, q: string) =>
  req<UserRef[]>('GET', `/admin/users?offset=${offset}&limit=50&q=${seg(q)}`)
export const adminServers = (offset: number, q: string) =>
  req<ServerSummaryLite[]>('GET', `/admin/servers?offset=${offset}&limit=50&q=${seg(q)}`)
export const adminDeleteServer = (name: string) =>
  req<unknown>('DELETE', `/admin/servers/${seg(name)}`)
export const adminDeleteUser = (username: string) =>
  req<unknown>('DELETE', `/admin/users/${seg(username)}`)
export const adminUserServers = (username: string) =>
  req<ServerSummaryLite[]>('GET', `/admin/users/${seg(username)}/servers`)
export const adminDeleteMessage = (id: number) => req<unknown>('DELETE', `/admin/messages/${id}`)
export const banUser = (username: string) => req<unknown>('POST', '/admin/ban', { username })

export function pageQuery(page: PageOpts) {
  const parts = Object.entries(page)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${v}`)
  return parts.length ? `?${parts.join('&')}` : ''
}
