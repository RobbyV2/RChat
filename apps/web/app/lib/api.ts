import type { Announcement, AnnouncementFeed } from './announcements'
import type { Widget, WidgetConfig } from './widgets'
import { reasonOf } from './reasons'
import { apiRoot, versionedBase, type ApiPrefix } from './api_version'
import { localUntil, type TimeoutWire } from './timeouts'
import { DEFAULT_DM_QUERY, queryParams, type DmQuery } from './dm_list'
import { ALL_PERMS, ROLE_BITS } from './types'
import { resetBody, type LockSecs, type ResetField } from './profile_reset'
import type {
  AccountFilter,
  AccountServer,
  AdminAccount,
  AdminConfig,
  AdminOverview,
  BrandAsset,
  CreatedAccount,
  IssuedPassword,
  InstanceAuditEntry,
  AuditEntry,
  AuthResponse,
  BlockedUser,
  BulkJob,
  ScheduledMessage,
  ScheduledPage,
  Friend,
  FriendRequest,
  FriendSummary,
  InboxFilter,
  InboxPage,
  InboxSource,
  InboxUntil,
  AvatarKind,
  Category,
  CategoryStyle,
  Channel,
  ChannelKind,
  ChannelLayout,
  ChannelPerm,
  ChannelPermInput,
  DmSummary,
  IceServers,
  InstanceInfo,
  LinkedProvider,
  ReAuthBody,
  SealJob,
  Separator,
  SeparatorStyle,
  ExchangeRequest,
  ExchangeResponse,
  Invite,
  InviteLinkInfo,
  Me,
  Member,
  MemberHit,
  Message,
  MessageLocation,
  Poll,
  PollKind,
  PollVoter,
  ThreadItem,
  ShowResults,
  PasswordMembers,
  CreatedPassword,
  NewPassword,
  ServerPasswords,
  SystemMessages,
  Profile,
  ProfilesMode,
  Role,
  SearchResult,
  BanResult,
  ServerBan,
  ServerDetail,
  ServerMatch,
  ServerProfile,
  ServerProfilePatch,
  ServerSummary,
  ServerSummaryLite,
  ServerUpdated,
  SiteSettings,
  SiteSettingsPatch,
  GifPage,
  RichEmbed,
  StoredSeal,
  Unread,
  UserRef,
} from './types'
import type { UploadExpiry, UploadExpiryState } from './upload_expiry'
import type { ServerIconKind } from './server_about'
import type { LayoutOrder } from './categories'
import type { AvatarCrop } from './avatar_images'
import type { Page } from './lists'
import type { UnreadCount } from './unread_banner'
import { retrySeconds } from './rate_limit'
import { TO_REQUEST, type Secret as Sealed } from './secret'
import type { Privacy, Relation, RequestStatus } from './friends'
import type { Secret } from './password'
import type {
  Delivery,
  OutgoingList,
  OutgoingSecret,
  OutgoingWebhook,
  Webhook,
  WebhookSecret,
} from './webhooks'
import { time } from './platform/time'
import { readJson, writeJson } from './api/masks'

// The API root (`.../api`); clients call it through `versionedBase` (see `api_version.ts`).
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
    public data?: unknown,
    // Seconds the server asked to wait, on a 429 or 503 that says so.
    public retryAfter: number | null = null
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

const WAITS = new Set([429, 503])

async function failed(response: Response): Promise<never> {
  const error = await bodyOf<{ error?: string } | null>(response).catch(() => ({
    error: response.statusText,
  }))
  const message = error?.error || response.statusText || `HTTP ${response.status}`
  const wait = WAITS.has(response.status)
    ? retrySeconds(response.headers.get('Retry-After'), String(message))
    : null
  throw new ApiError(message, response.status, error, wait)
}

// How the client waits between attempts. Tests pass their own.
export interface Pace {
  wait: (ms: number, signal?: AbortSignal) => Promise<void>
}

const realPace: Pace = {
  wait: (ms, signal) =>
    new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason)
      const stop = () => {
        timer()
        reject(signal?.reason)
      }
      const timer = time().after(ms, () => {
        signal?.removeEventListener('abort', stop)
        resolve()
      })
      signal?.addEventListener('abort', stop, { once: true })
    }),
}

// Waits before a request that changes nothing is sent again after the network failed.
export const RETRY_AFTER_MS: readonly number[] = [250, 1000]
// The longest wait a 429 or 503 answer may ask for that the client sits out itself.
export const RETRY_WAIT_MAX_S = 5

export interface SendOptions {
  headers?: Record<string, string>
  keepalive?: boolean
  timeoutMs?: number
  signal?: AbortSignal
  // Whose credentials go along: the session's (the token, or every guest grant), a file's (the
  // token, or the guest grant for one server, and no cookie beside a token), or nobody's.
  as?: 'session' | 'nobody' | { file: string | undefined }
  // Below the versioned base, or the unversioned root every version serves.
  under?: 'base' | 'root'
  cookies?: RequestCredentials
  redirect?: RequestRedirect
  cache?: RequestCache
  referrerPolicy?: ReferrerPolicy
  // False for a request that must answer or fail at once.
  retry?: boolean
}

export const isJson = (res: Response) =>
  /^application\/(?:[\w.+-]*\+)?json\b/i.test(res.headers.get('content-type') ?? '')

const bodyOf = async <T>(response: Response) => readJson(await response.text()) as T

async function handleResponse<T>(response: Response): Promise<T> {
  if (!response.ok) return failed(response)
  return bodyOf<T>(response)
}

const NEXT_CURSOR = 'X-Next-Cursor'

// Requests the app makes on its own, so they don't keep an idle session alive.
export const BACKGROUND: Readonly<Record<string, string>> = Object.freeze({ 'X-Background': '1' })

// The channel a member list shows in, as a query part to append.
const inChannel = (channel: number | null) => (channel === null ? '' : `&channel_id=${channel}`)

export const withCursor = (path: string, cursor: string | null) =>
  cursor ? `${path}${path.includes('?') ? '&' : '?'}cursor=${seg(cursor)}` : path

const seg = encodeURIComponent

const threadsQuery = (q: string) => (q.trim() ? `?q=${seg(q.trim())}` : '')
// Why a moderator does something, for the server's audit log (percent-encoded).
export const reasonHeader = (reason?: string): Record<string, string> => {
  const text = reasonOf(reason)
  return text ? { 'X-Audit-Reason': encodeURIComponent(text) } : {}
}

// Where a scheduled message goes: one of `channel_id`, `dm_id` and `thread_root_id`. `at` in
// seconds.
export interface ScheduleReq {
  channel_id?: number
  dm_id?: number
  thread_root_id?: number
  reply_to?: number
  mention_reply?: boolean
  content: string
  media_id?: string
  media_spoiler?: boolean
  media_alt?: string
  poll?: PollReq
  at: number
}

export interface ScheduledPatch {
  resume?: boolean
  content?: string
  at?: number
  remove_reply?: boolean
}

export interface ScheduledQuery {
  scope?: string
  status?: 'waiting' | 'failed'
  after?: string | null
  limit?: number
}

export const scheduledParams = (q: ScheduledQuery) => {
  const p = new URLSearchParams()
  if (q.scope) p.set('scope', q.scope)
  if (q.status) p.set('status', q.status)
  if (q.after) p.set('after', q.after)
  if (q.limit) p.set('limit', String(q.limit))
  const text = p.toString()
  return text ? `?${text}` : ''
}

export interface InboxQuery {
  unread?: boolean
  kind?: InboxFilter
  server?: string
  dms?: boolean
  limit?: number
}

export const inboxParams = (q: InboxQuery) => {
  const p = new URLSearchParams()
  if (q.unread) p.set('unread', 'true')
  if (q.kind) p.set('kind', q.kind)
  if (q.server) p.set('server', q.server)
  if (q.dms) p.set('dms', 'true')
  p.set('limit', String(q.limit ?? 30))
  return p.toString()
}

export class ApiClient {
  private token: Sealed | null = null
  private grants: Record<string, Sealed> = {}
  private root = ''
  // Set from the instance's discovery document (see `api_version.ts`).
  prefix: ApiPrefix = 'unversioned'

  constructor(
    base: string,
    private readonly cookieMode: RequestCredentials = 'same-origin',
    private readonly pace: Pace = realPace
  ) {
    this.setBase(base)
  }

  get base() {
    return versionedBase(this.root, this.prefix)
  }

  setBase(base: string) {
    this.root = apiRoot(base)
  }

  async ssoExchange(body: ExchangeRequest): Promise<ExchangeResponse> {
    const confirmation = body.confirm_as !== undefined
    const path = confirmation ? '/auth/oidc/exchange/confirmation' : '/auth/oidc/exchange'
    const response = await this.send('POST', path, body, {
      under: 'root',
      as: 'nobody',
      cookies: 'omit',
      redirect: 'error',
      cache: 'no-store',
    })
    if (
      confirmation &&
      (response.status === 404 || response.status === 405 || (response.ok && !isJson(response)))
    )
      throw new ApiError(
        'Confirmation sign-in is unavailable. Go back to sign in with a normal login method.',
        response.status
      )
    return handleResponse<ExchangeResponse>(response)
  }

  // The instance's discovery document, on the unversioned path every version serves. Only a JSON
  // answer counts; a redirect (into the web app on older instances) is not followed. The boot
  // waits for it, so it gives up after 3 s.
  async discovery(timeoutMs = 3000, cache?: RequestCache): Promise<InstanceInfo> {
    const res = await this.send('GET', '/instance', undefined, {
      under: 'root',
      as: 'nobody',
      headers: { Accept: 'application/json' },
      redirect: 'manual',
      timeoutMs,
      cache,
      retry: false,
    })
    if (!isJson(res)) throw new ApiError('No instance document', res.status)
    return handleResponse<InstanceInfo>(res)
  }

  // The one place a socket to this instance is opened. Credentials go in its first message,
  // never in the address.
  socket(url: string): WebSocket {
    return new WebSocket(url)
  }

  // Whether the instance answers at its health address. Carries no credentials.
  async reachable(url: string): Promise<boolean> {
    return (await fetch(url, { credentials: 'omit' })).ok
  }

  setToken(token: Sealed | null) {
    this.token = token
  }

  setGrants(grants: Record<string, Sealed>) {
    this.grants = grants
  }

  origin(href = typeof window === 'undefined' ? 'http://localhost/' : window.location.href) {
    return new URL(this.base, href).origin
  }

  private credentials(as: SendOptions['as'] = 'session'): Record<string, string> {
    if (as === 'nobody') return {}
    if (this.token) return { Authorization: `Bearer ${this.token.reveal(TO_REQUEST)}` }
    if (as === 'session') {
      const grants = Object.values(this.grants).map(g => g.reveal(TO_REQUEST))
      return grants.length ? { 'X-Guest-Grant': grants.join(',') } : {}
    }
    const grant = as.file === undefined ? undefined : this.grants[as.file]
    return grant ? { 'X-Guest-Grant': grant.reveal(TO_REQUEST) } : {}
  }

  // Every request to this instance leaves here. A GET is sent again after a network failure, and
  // once after a 429 or 503 that asks for a short wait.
  async send(
    method: string,
    path: string,
    body?: unknown,
    opts: SendOptions = {}
  ): Promise<Response> {
    const { as = 'session', under = 'base', keepalive = false, timeoutMs = 0 } = opts
    const headers: Record<string, string> = { ...opts.headers }
    if (headers.Authorization === undefined) Object.assign(headers, this.credentials(as))
    const init: RequestInit = keepalive ? { method, headers, keepalive } : { method, headers }
    const file = typeof as === 'object'
    init.credentials = opts.cookies ?? (file && this.token ? 'omit' : this.cookieMode)
    if (opts.redirect) init.redirect = opts.redirect
    if (opts.cache) init.cache = opts.cache
    if (opts.referrerPolicy) init.referrerPolicy = opts.referrerPolicy
    const stops = [opts.signal, timeoutMs ? time().deadline(timeoutMs) : undefined].filter(
      s => s !== undefined
    )
    const stop = stops.length > 1 ? AbortSignal.any(stops) : stops[0]
    if (stop) init.signal = stop
    if (body instanceof FormData) {
      init.body = body
    } else if (body instanceof Blob) {
      headers['Content-Type'] = body.type || 'application/octet-stream'
      init.body = body
    } else if (body !== undefined) {
      headers['Content-Type'] = 'application/json'
      init.body = writeJson(body)
    }
    const url = `${under === 'root' ? this.root : this.base}${path}`
    // A request that refuses redirects fails like the network does when it meets one.
    const again =
      method === 'GET' &&
      body === undefined &&
      !keepalive &&
      opts.retry !== false &&
      opts.redirect !== 'error'
    const unreachable = () => new ApiError("Can't reach the server", 0)
    let waited = false
    for (let attempt = 0; ; attempt += 1) {
      let response: Response
      try {
        response = await fetch(url, init)
      } catch {
        if (!again || stop?.aborted || attempt >= RETRY_AFTER_MS.length) throw unreachable()
        await this.pace.wait(RETRY_AFTER_MS[attempt], stop).catch(() => {
          throw unreachable()
        })
        continue
      }
      if (!again || waited || !WAITS.has(response.status)) return response
      const wait = retrySeconds(response.headers.get('Retry-After'))
      if (wait === null || wait > RETRY_WAIT_MAX_S) return response
      waited = true
      await response.body?.cancel().catch(() => {})
      await this.pace.wait(wait * 1000, stop).catch(() => {
        throw unreachable()
      })
    }
  }

  async req<T>(
    method: string,
    path: string,
    body?: unknown,
    extra: Record<string, string> = {},
    keepalive = false,
    timeoutMs = 0,
    signal?: AbortSignal
  ): Promise<T> {
    return handleResponse<T>(
      await this.send(method, path, body, { headers: extra, keepalive, timeoutMs, signal })
    )
  }

  async page<T>(path: string, signal?: AbortSignal): Promise<Page<T>> {
    const response = await this.send('GET', path, undefined, { signal })
    if (!response.ok) return failed(response)
    const items = await bodyOf<T[]>(response)
    return { items, next: response.headers.get(NEXT_CURSOR) || null }
  }

  mediaUrl(id: string) {
    return `${this.base}/media/${seg(id)}`
  }

  avatarUrl(id: string, size: number) {
    return `${this.base}/avatars/${seg(id)}/${size}`
  }

  avatarAnimatedUrl(id: string, size: number) {
    return `${this.base}/avatars/${seg(id)}/${size}/animated`
  }

  hasToken(candidate: Sealed | null) {
    return this.token !== null && this.token.same(candidate)
  }

  signedIn() {
    return this.token !== null
  }

  // Guests can't load media by URL: their grant goes in a header, never in a link that could be
  // copied or kept in history. See `media_src.ts`.
  guestMedia(server?: string) {
    return !this.token && server !== undefined && this.grants[server] !== undefined
  }

  // A link preview's image, always from this instance (see `previewPath`).
  previewUrl(path: string) {
    return `${this.base}${path}`
  }

  // The path of an address below this API's root (any version), or null for anywhere else: the
  // token and grants go nowhere but here.
  private below(url: string) {
    const page = typeof window === 'undefined' ? 'http://localhost/' : window.location.href
    try {
      const at = new URL(url, page)
      const root = new URL(`${this.root}/`, page)
      if (at.origin !== root.origin || !at.pathname.startsWith(root.pathname)) return null
      return {
        path: at.pathname.slice(root.pathname.length),
        search: at.search,
        plain: !at.search && !at.hash,
      }
    } catch {
      return null
    }
  }

  // The id in the address of one of this instance's media files, or null for anything else.
  mediaId(url: string) {
    const at = this.below(url)
    const m = at?.plain ? /^(?:v1\/)?media\/([^/]+)$/.exec(at.path) : null
    try {
      return m ? decodeURIComponent(m[1]) : null
    } catch {
      return null
    }
  }

  async mediaBlob(id: string, server?: string, signal?: AbortSignal) {
    return this.authedBlob(this.mediaUrl(id), server, signal)
  }

  // A file of this instance, fetched with the account's token or the guest's grant for `server`
  // in a header. An address outside the API is refused and a redirect is never followed, so
  // neither is ever sent anywhere else.
  async authedBlob(url: string, server?: string, signal?: AbortSignal) {
    const at = this.below(url)
    if (!at) throw new ApiError('Could not load the file', 0)
    const res = await this.file(`/${at.path}${at.search}`, server, signal, 'root')
    if (!res.ok) throw new ApiError('Could not load the file', res.status)
    return res.blob()
  }

  private async file(
    path: string,
    server: string | undefined,
    signal: AbortSignal | undefined,
    under: 'base' | 'root'
  ) {
    try {
      return await this.send('GET', path, undefined, {
        under,
        as: { file: server },
        signal,
        redirect: 'error',
        referrerPolicy: 'no-referrer',
      })
    } catch {
      throw new ApiError('Could not load the file', 0)
    }
  }

  // The first `max` bytes of a file, for a text preview; the rest is never downloaded. `cut` is
  // true when the file goes on past them; `total` is its full size when the server says.
  async mediaStart(id: string, server: string | undefined, max: number, signal?: AbortSignal) {
    const res = await this.file(`/media/${seg(id)}`, server, signal, 'base')
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

const cropQuery = (crop: AvatarCrop | null) =>
  crop ? `?x=${crop.x}&y=${crop.y}&size=${crop.size}` : ''

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

export interface RolePatch {
  name?: string
  color?: string
  perms?: bigint
  mentionable?: boolean
  // null removes it
  icon?: string | null
  hoist?: boolean
  color_names?: boolean
}

export interface MemberFilter {
  q?: string
  admins?: boolean
}

// One group of the member list: the members of a role shown separately, or `rest` for those in
// no group.
export type MemberGroup = number | 'rest'

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
  media_alt?: string
  p2p?: P2pAttachment
  reply_to?: number
  mention_reply?: boolean
  forward_of?: number
  show_source?: boolean
  poll?: PollReq
  embeds?: RichEmbed[]
}

export interface PollOptionReq {
  text: string
  emoji?: string | null
}

export interface BulkDeleteReq {
  // `c{channel}`, `t{thread root}` or `d{dm}`.
  scope: string
  ids?: number[]
  all?: boolean
  except?: number[]
  before?: number
  after?: number
  // With `all`: only this author's messages.
  author?: string
  dry_run?: boolean
}

export interface BulkDeleteResp {
  total: number
  deletable: number
  others: number
  missing: number
  deleted: number
  ids: number[]
  job: BulkJob | null
  // For `all`: the newest message id counted; send `before: upto + 1` to delete just those.
  upto?: number | null
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
  logout: (token: Sealed) =>
    c.req<{ ok: boolean; end_session_url?: string | null }>(
      'POST',
      '/auth/logout',
      undefined,
      { Authorization: `Bearer ${token.reveal(TO_REQUEST)}` },
      true,
      3000
    ),
  words: (username: string) => c.req<{ words: string[] }>('GET', `/auth/words/${seg(username)}`),
  me: (background = false) =>
    c.req<Me>('GET', '/me', undefined, background ? BACKGROUND : {}).then(localMe),
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
  putAvatar: (file: Blob, crop: AvatarCrop | null) =>
    c.req<MeUpdated>('PUT', `/me/avatar${cropQuery(crop)}`, file),
  deleteAvatar: () => c.req<MeUpdated>('DELETE', '/me/avatar'),
  putServerIcon: (server: string, file: Blob, crop: AvatarCrop | null) =>
    c.req<ServerSummaryLite>('PUT', `/servers/${seg(server)}/icon${cropQuery(crop)}`, file),
  deleteServerIcon: (server: string) =>
    c.req<ServerSummaryLite>('DELETE', `/servers/${seg(server)}/icon`),
  putProfileAvatar: (server: string, file: Blob, crop: AvatarCrop | null) =>
    c.req<ServerProfile>('PUT', `/servers/${seg(server)}/profile/avatar${cropQuery(crop)}`, file),
  deleteProfileAvatar: (server: string) =>
    c.req<ServerProfile>('DELETE', `/servers/${seg(server)}/profile/avatar`),
  setBio: (bio: string | null) => c.req<MeUpdated>('PATCH', '/me', { bio }),
  setDisplayName: (display_name: string) => c.req<MeUpdated>('PATCH', '/me', { display_name }),
  setAppearOffline: (appear_offline: boolean) =>
    c.req<MeUpdated>('PATCH', '/me', { appear_offline }),
  createConfigShare: (blob: string, expires_in: number) =>
    c.req<ConfigShare>('POST', '/config_shares', { blob, expires_in }),
  configShares: () => c.req<ConfigShare[]>('GET', '/config_shares'),
  configShare: (id: string) => c.req<SharedConfig>('GET', `/config_shares/${seg(id)}`),
  deleteConfigShare: (id: string) => c.req<{ ok: boolean }>('DELETE', `/config_shares/${seg(id)}`),
  ssoLinks: () => c.req<LinkedProvider[]>('GET', '/me/sso'),
  ssoUnlink: (provider: string) => c.req<{ ok: boolean }>('DELETE', '/me/sso/' + seg(provider)),
  ssoTicket: (body: { provider: string; purpose: 'reauth' | 'link'; reauth?: ReAuthBody }) =>
    c.req<{ ticket: string }>('POST', '/me/sso/ticket', body),
  recoveryStatus: () => c.req<{ set: boolean }>('GET', '/me/recovery'),
  recoveryChallenge: (username: string) =>
    c.req<{ username: string; nonce: string }>('POST', '/auth/recovery/challenge', { username }),
  setRecovery: (key: string, reauth: ReAuthBody) =>
    c.req<{ set: boolean }>('PUT', '/me/recovery', { key, reauth }),
  deleteAccount: (reauth: ReAuthBody) =>
    c.req<{ delete_at: number }>('POST', '/me/delete', { reauth }),
  keepAccount: () => c.req<{ ok: boolean }>('DELETE', '/me/delete'),
  changePassword: (current: Secret | undefined, next: Secret, reauth?: ReAuthBody) =>
    c.req<{ ok: boolean }>('POST', '/me/password', { current, new: next, reauth }),
  userProfile: (username: string, server?: string | null) =>
    c.req<Profile>(
      'GET',
      `/users/${seg(username)}/profile${server ? `?server=${seg(server)}` : ''}`
    ),
  serverProfile: (server: string) => c.req<ServerProfile>('GET', `/servers/${seg(server)}/profile`),
  setServerProfile: (server: string, patch: ServerProfilePatch) =>
    c.req<ServerProfile>('PATCH', `/servers/${seg(server)}/profile`, patch),
  resetServerProfile: (server: string) =>
    c.req<ServerProfile>('DELETE', `/servers/${seg(server)}/profile`),
  resetMemberProfile: (
    server: string,
    username: string,
    fields: readonly ResetField[],
    secs: LockSecs,
    reason: string
  ) =>
    c.req<unknown>(
      'POST',
      `/servers/${seg(server)}/members/${seg(username)}/profile/reset`,
      resetBody(fields, secs, reason)
    ),
  unlockMemberProfile: (server: string, username: string) =>
    c.req<unknown>('DELETE', `/servers/${seg(server)}/members/${seg(username)}/profile/lock`),
  createServer: (name: string, password?: string) =>
    c.req<ServerDetail>('POST', '/servers', { name, password }),
  getServer: (name: string) => c.req<ServerDetail>('GET', `/servers/${seg(name)}`),
  serverAvailable: (name: string, signal?: AbortSignal) =>
    c.req<{ available: boolean }>(
      'GET',
      `/servers/${seg(name)}/available`,
      undefined,
      {},
      false,
      0,
      signal
    ),
  getInvite: (
    name: string,
    password?: string | null,
    preview?: 'metadata' | { revision: string }
  ) =>
    c.req<Invite>(
      'GET',
      `/invites/${seg(name)}${preview === 'metadata' ? '/metadata' : preview ? '?preview_revision=' + seg(preview.revision) : ''}`,
      undefined,
      password ? { 'X-Invite-Password': seg(password) } : {}
    ),
  inviteByCode: (code: string) => c.req<Invite>('GET', `/invite_codes/${seg(code)}`),
  standingInvite: (name: string) =>
    c.req<InviteLinkInfo | null>('GET', `/servers/${seg(name)}/invite`),
  renewInvite: (name: string) => c.req<InviteLinkInfo>('POST', `/servers/${seg(name)}/invite`),
  revokeInvite: (name: string) => c.req<unknown>('DELETE', `/servers/${seg(name)}/invite`),
  searchServers: (q: string, signal?: AbortSignal) =>
    c.req<ServerMatch[]>('GET', `/server_search?q=${seg(q)}`, undefined, {}, false, 0, signal),
  guestAccess: (name: string, password?: string) =>
    c.req<{ grant: string | null }>('POST', `/servers/${seg(name)}/guest_access`, { password }),
  listMembers: (
    name: string,
    cursor: string | null,
    filter: MemberFilter = {},
    channel: number | null = null
  ) =>
    c.page<Member>(
      withCursor(
        `/servers/${seg(name)}/members?limit=50${filter.q ? `&q=${seg(filter.q)}` : ''}${filter.admins ? '&admins=1' : ''}${inChannel(channel)}`,
        cursor
      )
    ),
  searchMembers: (name: string, query: string, cursor: string | null, signal?: AbortSignal) =>
    c.page<MemberHit>(
      withCursor(`/servers/${seg(name)}/members/search${query ? `?${query}` : ''}`, cursor),
      signal
    ),
  listGroup: (
    name: string,
    group: MemberGroup,
    cursor: string | null,
    limit = 50,
    channel: number | null = null
  ) =>
    c.page<Member>(
      withCursor(
        `/servers/${seg(name)}/members?limit=${limit}${group === 'rest' ? '&unhoisted=1' : `&role=${group}&top_hoisted=1`}${inChannel(channel)}`,
        cursor
      )
    ),
  suggestMembers: (name: string, q: string, channel: number | null = null) =>
    c.req<Member[]>(
      'GET',
      `/servers/${seg(name)}/members?suggest=1&q=${seg(q)}${inChannel(channel)}`
    ),
  membersByName: (name: string, usernames: string[], channel: number | null = null) =>
    c.req<Member[]>(
      'GET',
      `/servers/${seg(name)}/members?${usernames.map(u => `usernames=${seg(u)}`).join('&')}${inChannel(channel)}`
    ),
  listInteracted: (name: string, cursor: string | null, channel: number | null = null) =>
    c.page<UserRef>(
      withCursor(`/servers/${seg(name)}/interacted?limit=50${inChannel(channel)}`, cursor)
    ),
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
      public_read?: boolean | null
      guest_voice_opt_in?: boolean
      guest_chat_opt_in?: boolean
      members_visible?: boolean
      hide_members?: boolean
      profiles_mode?: ProfilesMode
      description?: string | null
      icon_kind?: ServerIconKind
      seal?: boolean
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
  uploadExpiry: (name: string) =>
    c.req<UploadExpiryState>('GET', `/servers/${seg(name)}/upload_expiry`),
  setUploadExpiry: (name: string, choice: UploadExpiry) =>
    c.req<UploadExpiryState>('PUT', `/servers/${seg(name)}/upload_expiry`, choice),
  createChannel: (
    server: string,
    name: string,
    kind: ChannelKind = 'text',
    category: number | null = null,
    textOnly = false
  ) =>
    c.req<Channel>('POST', `/servers/${seg(server)}/channels`, {
      name,
      kind,
      category_id: category,
      ...(textOnly ? { text_only: true } : {}),
    }),
  createCategory: (server: string, name: string) =>
    c.req<Category>('POST', `/servers/${seg(server)}/categories`, { name }),
  renameCategory: (id: number, name: string, style?: CategoryStyle) =>
    c.req<Category>('PATCH', `/categories/${id}`, { name, ...(style ? { style } : {}) }),
  deleteCategory: (id: number) => c.req<unknown>('DELETE', `/categories/${id}`),
  createSeparator: (
    server: string,
    label: string,
    style: SeparatorStyle,
    category: number | null
  ) =>
    c.req<Separator>('POST', `/servers/${seg(server)}/separators`, {
      label,
      style,
      category_id: category,
    }),
  editSeparator: (id: number, patch: { label?: string; style?: SeparatorStyle }) =>
    c.req<Separator>('PATCH', `/separators/${id}`, patch),
  deleteSeparator: (id: number) => c.req<unknown>('DELETE', `/separators/${id}`),
  reorderLayout: (server: string, order: LayoutOrder & { version: number }) =>
    c.req<ChannelLayout>('PUT', `/servers/${seg(server)}/layout`, order),
  updateChannel: (
    id: number,
    patch: {
      name?: string
      sensitive?: boolean
      text_only?: boolean
      slowmode_seconds?: number
      restrict_view?: boolean
      restrict_send?: boolean
      topic?: string | null
    }
  ) => c.req<Channel>('PATCH', `/channels/${id}`, patch),
  deleteChannel: (id: number) => c.req<unknown>('DELETE', `/channels/${id}`),
  kickMember: (server: string, username: string, reason?: string) =>
    c.req<unknown>('POST', `/servers/${seg(server)}/kick`, { username }, reasonHeader(reason)),
  banMember: (
    server: string,
    username: string,
    options: { duration_secs?: number; reason?: string; purge_hours?: number } = {}
  ) => c.req<BanResult>('POST', `/servers/${seg(server)}/bans`, { username, ...options }),
  timeoutMember: (server: string, username: string, seconds: number, reason: string | null) =>
    c.req<TimeoutWire>('PUT', `/servers/${seg(server)}/timeouts/${seg(username)}`, {
      seconds,
      reason,
    }),
  removeTimeout: (server: string, username: string) =>
    c.req<unknown>('DELETE', `/servers/${seg(server)}/timeouts/${seg(username)}`),
  disconnectGuest: (server: string, name: string) =>
    c.req<unknown>('POST', `/servers/${seg(server)}/voice/${seg(name)}/disconnect`),
  muteGuest: (server: string, name: string, muted: boolean) =>
    c.req<unknown>(muted ? 'PUT' : 'DELETE', `/servers/${seg(server)}/voice/${seg(name)}/mute`),
  unbanMember: (server: string, username: string) =>
    c.req<unknown>('DELETE', `/servers/${seg(server)}/bans/${seg(username)}`),
  listBans: (server: string, cursor: string | null) =>
    c.page<ServerBan>(withCursor(`/servers/${seg(server)}/bans?limit=50`, cursor)),
  listWebhooks: (server: string) => c.req<Webhook[]>('GET', `/servers/${seg(server)}/webhooks`),
  createWebhook: (
    server: string,
    body: { channel_id: number; name: string; avatar_kind: AvatarKind; avatar_color: string | null }
  ) => c.req<WebhookSecret>('POST', `/servers/${seg(server)}/webhooks`, body),
  updateWebhook: (
    server: string,
    id: number,
    patch: {
      channel_id?: number
      name?: string
      avatar_kind?: AvatarKind
      avatar_color?: string | null
    }
  ) => c.req<Webhook>('PATCH', `/servers/${seg(server)}/webhooks/${id}`, patch),
  resetWebhookToken: (server: string, id: number) =>
    c.req<WebhookSecret>('POST', `/servers/${seg(server)}/webhooks/${id}/token`),
  deleteWebhook: (server: string, id: number) =>
    c.req<unknown>('DELETE', `/servers/${seg(server)}/webhooks/${id}`),
  listOutgoing: (server: string) =>
    c.req<OutgoingList>('GET', `/servers/${seg(server)}/outgoing_webhooks`),
  createOutgoing: (server: string, body: { name: string; url: string; events: string[] }) =>
    c.req<OutgoingSecret>('POST', `/servers/${seg(server)}/outgoing_webhooks`, body),
  updateOutgoing: (
    server: string,
    id: number,
    patch: { name?: string; url?: string; events?: string[]; enabled?: boolean }
  ) => c.req<OutgoingWebhook>('PATCH', `/servers/${seg(server)}/outgoing_webhooks/${id}`, patch),
  resetOutgoingSecret: (server: string, id: number, url?: string) =>
    c.req<OutgoingSecret>(
      'POST',
      `/servers/${seg(server)}/outgoing_webhooks/${id}/secret`,
      url === undefined ? undefined : { url }
    ),
  deleteOutgoing: (server: string, id: number) =>
    c.req<unknown>('DELETE', `/servers/${seg(server)}/outgoing_webhooks/${id}`),
  testOutgoing: (server: string, id: number) =>
    c.req<unknown>('POST', `/servers/${seg(server)}/outgoing_webhooks/${id}/test`),
  listDeliveries: (server: string, id: number) =>
    c.req<Delivery[]>('GET', `/servers/${seg(server)}/outgoing_webhooks/${id}/deliveries`),
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
  setAdminPerms: (server: string, username: string, perms: bigint) =>
    c.req<unknown>('PATCH', `/servers/${seg(server)}/admins/${seg(username)}/perms`, {
      perms,
      mask: ALL_PERMS,
    }),
  createRole: (server: string, body: { name: string; color: string; perms: bigint }) =>
    c.req<Role>('POST', `/servers/${seg(server)}/roles`, body),
  updateRole: (server: string, id: number, patch: RolePatch) =>
    c.req<Role>('PATCH', `/servers/${seg(server)}/roles/${id}`, { ...patch, mask: ROLE_BITS }),
  deleteRole: (server: string, id: number) =>
    c.req<unknown>('DELETE', `/servers/${seg(server)}/roles/${id}`),
  assignRole: (server: string, id: number, username: string) =>
    c.req<unknown>('POST', `/servers/${seg(server)}/roles/${id}/assign`, { username }),
  unassignRole: (server: string, id: number, username: string) =>
    c.req<unknown>('DELETE', `/servers/${seg(server)}/roles/${id}/assign/${seg(username)}`),
  widgets: (server: string, cursor: string | null, signal?: AbortSignal) =>
    c.page<Widget>(withCursor(`/servers/${seg(server)}/widgets`, cursor), signal),
  saveWidget: (server: string, id: string | null, body: WidgetConfig) =>
    c.req<Widget>(
      id === null ? 'POST' : 'PUT',
      `/servers/${seg(server)}/widgets${id === null ? '' : `/${id}`}`,
      body
    ),
  channelPerms: (id: number, cursor: string | null = null) =>
    c.page<ChannelPerm>(withCursor(`/channels/${id}/perms`, cursor)),
  setChannelPerm: (id: number, perm: ChannelPermInput) =>
    c.req<unknown>('PUT', `/channels/${id}/perms`, perm),
  setEveryonePerms: (server: string, perms: bigint, mask?: bigint) =>
    c.req<{ everyone_perms: bigint }>('PATCH', `/servers/${seg(server)}/everyone`, {
      perms,
      mask,
    }),
  // `order` lists every role id, the highest first; `version` is the detail's `roles_version`.
  setRoleOrder: (server: string, order: number[], version: number) =>
    c.req<{ order: number[]; version: number }>('PUT', `/servers/${seg(server)}/roles/order`, {
      order,
      version,
    }),
  // `order` lists every role id, the one shown highest first.
  setRoleDisplay: (server: string, order: number[], version: number) =>
    c.req<{ order: number[]; version: number }>(
      'PUT',
      `/servers/${seg(server)}/roles/display_order`,
      { order, version }
    ),
  followRoleOrder: (server: string, version: number) =>
    c.req<{ order: number[]; version: number }>(
      'DELETE',
      `/servers/${seg(server)}/roles/display_order`,
      { version }
    ),
  confirmRoleOrder: (server: string, version: number) =>
    c.req<{ confirmed: boolean }>('POST', `/servers/${seg(server)}/roles/order/confirm`, {
      version,
    }),
  clearChannelPerm: (id: number, subject: string) =>
    c.req<unknown>('DELETE', `/channels/${id}/perms/${seg(subject)}`),
  categoryPerms: (id: number, cursor: string | null = null) =>
    c.page<ChannelPerm>(withCursor(`/categories/${id}/perms`, cursor)),
  setCategoryPerm: (id: number, rule: { subject: string; allow: bigint; deny: bigint }) =>
    c.req<unknown>('PUT', `/categories/${id}/perms`, rule),
  clearCategoryPerm: (id: number, subject: string) =>
    c.req<unknown>('DELETE', `/categories/${id}/perms/${seg(subject)}`),
  // `confirm`: even when the category's rules let someone in who could not see or send there.
  syncChannelPerms: (id: number, confirm: boolean) =>
    c.req<unknown>('POST', `/channels/${id}/perms/sync`, { confirm }),
  channelMessages: (id: number, page: PageOpts = {}) =>
    c.req<Message[]>('GET', `/channels/${id}/messages${pageQuery(page)}`),
  sendChannelMessage: (id: number, content: string, opts: SendOpts = {}) =>
    c.req<Message>('POST', `/channels/${id}/messages`, { content, ...opts }),
  listDms: (cursor: string | null, limit: number, query: DmQuery = DEFAULT_DM_QUERY) =>
    c.page<DmSummary>(withCursor(`/dms?limit=${limit}${queryParams(query)}`, cursor)),
  dmsById: (ids: number[]) => c.req<DmSummary[]>('GET', `/dms?ids=${ids.join(',')}`),
  openDm: (username: string) => c.req<DmSummary>('POST', '/dms', { username }),
  closeDm: (id: number) => c.req<unknown>('POST', `/dms/${id}/close`),
  setDmSeal: (id: number, on: boolean) => c.req<unknown>('PUT', `/dms/${id}/seal`, { on }),
  startSealJob: (place: string, direction: SealJob['direction'], reauth: ReAuthBody) =>
    c.req<SealJob>('POST', '/seal_jobs', { place, direction, reauth }),
  sealJob: (id: number) => c.req<SealJob>('GET', `/seal_jobs/${id}`),
  sealJobs: (place: string) =>
    c.req<SealJob[]>('GET', `/seal_jobs?place=${encodeURIComponent(place)}`),
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
  inbox: (query: InboxQuery, cursor: string | null) =>
    c.req<InboxPage>('GET', withCursor(`/inbox?${inboxParams(query)}`, cursor)),
  inboxRead: (source: InboxSource, id: number) =>
    c.req<unknown>('POST', '/inbox/read', { source, id }),
  inboxReadAll: (until: InboxUntil, query: InboxQuery) =>
    c.req<unknown>('POST', '/inbox/read_all', {
      until,
      kind: query.kind,
      server: query.server,
      dms: query.dms || undefined,
    }),
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
  bulkDelete: (req: BulkDeleteReq) => c.req<BulkDeleteResp>('POST', '/messages/bulk_delete', req),
  bulkJobs: () => c.req<BulkJob[]>('GET', '/messages/bulk_delete/jobs'),
  cancelBulkJob: (id: number) => c.req<BulkJob>('DELETE', `/messages/bulk_delete/jobs/${id}`),
  listScheduled: (q: ScheduledQuery = {}) =>
    c.req<ScheduledPage>('GET', `/me/scheduled${scheduledParams(q)}`),
  createScheduled: (req: ScheduleReq) => c.req<ScheduledMessage>('POST', '/me/scheduled', req),
  patchScheduled: (id: number, patch: ScheduledPatch) =>
    c.req<ScheduledMessage>('PATCH', `/me/scheduled/${id}`, patch),
  sendScheduled: (id: number) => c.req<Message>('POST', `/me/scheduled/${id}/send`),
  deleteScheduled: (id: number) => c.req<unknown>('DELETE', `/me/scheduled/${id}`),
  // `alt`: a new description of the message's image (null removes it); left out keeps it.
  editMessage: (id: number, content: string, alt?: string | null, embeds?: RichEmbed[]) =>
    c.req<Message>('PATCH', `/messages/${id}`, {
      content,
      ...(alt === undefined ? {} : { media_alt: alt }),
      ...(embeds === undefined ? {} : { embeds }),
    }),
  deleteMedia: (id: number) => c.req<unknown>('DELETE', `/messages/${id}/media`),
  messageLocation: (id: number) => c.req<MessageLocation>('GET', `/messages/${id}/location`),
  messagePlace: (id: number) =>
    c.req<
      Pick<MessageLocation, 'server' | 'channel_id' | 'dm_id' | 'thread_root_id'> & {
        // What a forward of it that shows its source would name; absent from older servers.
        shown?: { server: string; channel?: string } | null
      }
    >('GET', `/messages/${id}/location?preview=false`),
  messageLocations: (ids: number[], expected?: Record<number, string>) =>
    c.req<MessageLocation[]>('POST', '/messages/locations', { ids, expected }),
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
  channelThreads: (id: number, q: string, cursor: string | null) =>
    c.page<ThreadItem>(withCursor(`/channels/${id}/threads${threadsQuery(q)}`, cursor)),
  dmThreads: (id: number, q: string, cursor: string | null) =>
    c.page<ThreadItem>(withCursor(`/dms/${id}/threads${threadsQuery(q)}`, cursor)),
  threadMessages: (id: number, page: PageOpts = {}) =>
    c.req<Message[]>('GET', `/messages/${id}/thread${pageQuery(page)}`),
  sendThreadMessage: (id: number, content: string, opts: SendOpts = {}) =>
    c.req<Message>('POST', `/messages/${id}/thread`, { content, ...opts }),
  search: (params: SearchParams, signal?: AbortSignal) => {
    const qs = new URLSearchParams()
    for (const [k, v] of Object.entries(params)) {
      if (Array.isArray(v)) for (const item of v) qs.append(k, String(item))
      else if (v !== undefined) qs.set(k, String(v))
    }
    return c.page<SearchResult>(`/search?${qs.toString()}`, signal)
  },
  getUnreads: () => c.req<{ items: Unread[]; more: boolean }>('GET', '/unreads'),
  getUnreadCount: (scope: string, after: number) =>
    c.req<UnreadCount>('GET', `/unreads/${encodeURIComponent(scope)}?after=${after}`),
  postRead: (scope: string, last_read: number, keepalive = false, pings_until?: number) =>
    c.req<void>(
      'POST',
      '/read',
      pings_until === undefined ? { scope, last_read } : { scope, last_read, pings_until },
      BACKGROUND,
      keepalive
    ),
  postReadBatch: (scopes: string[]) =>
    c.req<{ ok: boolean }>('POST', '/read/batch', { scopes }, BACKGROUND),
  uploadMedia: (file: File, place: string | null = null) => {
    const form = new FormData()
    form.append('file', file, file.name)
    const query = place ? `?place=${encodeURIComponent(place)}` : ''
    return c.req<{ id: string }>('POST', `/media${query}`, form)
  },
  getSettings: (background = false) =>
    c.req<SiteSettings>('GET', '/settings', undefined, background ? BACKGROUND : {}),
  patchSettings: (body: SiteSettingsPatch) => c.req<SiteSettings>('PATCH', '/admin/settings', body),
  brand: () => c.req<unknown>('GET', '/brand'),
  adminPutBrandAsset: (kind: BrandAsset, image: Blob) =>
    c.req<unknown>('PUT', `/admin/brand/${seg(kind)}`, image),
  adminDeleteBrandAsset: (kind: BrandAsset) =>
    c.req<unknown>('DELETE', `/admin/brand/${seg(kind)}`),
  announcements: () =>
    c.req<AnnouncementFeed>('GET', '/announcements', undefined, BACKGROUND, false, 10000),
  dismissAnnouncement: (id: string) => c.req('PUT', `/announcements/${seg(id)}/dismiss`),
  adminAnnouncements: () =>
    c.req<Announcement[]>('GET', '/admin/announcements', undefined, BACKGROUND, false, 10000),
  scheduleAnnouncement: (body: Omit<Announcement, 'id'>) =>
    c.req<Announcement>('POST', '/admin/announcements', body),
  removeAnnouncement: (id: string) => c.req('DELETE', `/admin/announcements/${seg(id)}`),
  adminOverview: () => c.req<AdminOverview>('GET', '/admin/overview'),
  adminConfig: () => c.req<AdminConfig>('GET', '/admin/config'),
  pauseGuestPosting: (messageId: number) =>
    c.req<unknown>('POST', `/messages/${messageId}/pause-guest`),
  adminEncryption: () => c.req<unknown>('GET', '/admin/encryption'),
  adminRequireEncryption: (on: boolean) =>
    c.req<{ on: boolean; pinned: boolean }>('PUT', '/admin/encryption/required', { on }),
  adminConfirmCopies: (confirmed: boolean) =>
    c.req<unknown>('PUT', '/admin/encryption/copies', { confirmed }),
  adminKeysSaved: (reauth: ReAuthBody) =>
    c.req<{ backed_up_at: number }>('PUT', '/admin/encryption/backed_up', { reauth }),
  adminRotateKeys: (reauth: ReAuthBody, purposes?: string[]) =>
    c.req<unknown>('POST', '/admin/encryption/rotate', { reauth, purposes }),
  adminRequireServerEncryption: (name: string, on: boolean) =>
    c.req<StoredSeal>('PUT', `/admin/servers/${seg(name)}/seal_forced`, { on }),
  adminUsers: (cursor: string | null, q: string, filter: AccountFilter = 'all') =>
    c.page<UserRef>(
      withCursor(
        `/admin/users?limit=50&q=${seg(q)}${filter === 'all' ? '' : `&filter=${filter}`}`,
        cursor
      )
    ),
  adminAccount: (username: string) => c.req<AdminAccount>('GET', `/admin/users/${seg(username)}`),
  adminCreateUser: (body: { username: string; display_name?: string; servers: AccountServer[] }) =>
    c.req<CreatedAccount>('POST', '/admin/users', body),
  adminResetPassword: (username: string) =>
    c.req<IssuedPassword>('POST', `/admin/users/${seg(username)}/temp_password`),
  adminSignOut: (username: string) =>
    c.req<unknown>('POST', `/admin/users/${seg(username)}/sign_out`),
  adminAddToServer: (username: string, body: AccountServer) =>
    c.req<unknown>('POST', `/admin/users/${seg(username)}/servers`, body),
  searchGifs: (q: string, next: string | null = null) =>
    c.req<GifPage>('GET', `/gifs/search?q=${seg(q)}${next ? `&next=${seg(next)}` : ''}`),
  trendingGifs: (next: string | null = null) =>
    c.req<GifPage>('GET', `/gifs/trending${next ? `?next=${seg(next)}` : ''}`),
  adminServers: (cursor: string | null, q: string) =>
    c.page<ServerSummaryLite>(withCursor(`/admin/servers?limit=50&q=${seg(q)}`, cursor)),
  adminDeleteServer: (name: string) => c.req<unknown>('DELETE', `/admin/servers/${seg(name)}`),
  adminCreateServer: (body: { name: string; owner: string; password?: string }) =>
    c.req<ServerDetail>('POST', '/admin/servers', body),
  adminDeleteUser: (username: string) => c.req<unknown>('DELETE', `/admin/users/${seg(username)}`),
  adminRemovePhrase: (username: string) =>
    c.req<{ removed: boolean }>('DELETE', `/admin/users/${seg(username)}/recovery`),
  adminAudit: (cursor: string | null) =>
    c.page<InstanceAuditEntry>(withCursor('/admin/audit', cursor)),
  adminUserServers: (username: string, cursor: string | null = null) =>
    c.page<ServerSummaryLite>(withCursor(`/admin/users/${seg(username)}/servers`, cursor)),
  adminDeleteMessage: (id: number) => c.req<unknown>('DELETE', `/admin/messages/${id}`),
  staffView: (channel: number, reauth: ReAuthBody, reason: Record<string, string> | null) =>
    c.req<{ until: number; remaining: number }>(
      'POST',
      `/admin/channels/${channel}/staff_view`,
      { reauth },
      reason ?? {}
    ),
  banUser: (username: string) => c.req<unknown>('POST', '/admin/ban', { username }),
  instance: (cache?: RequestCache) => c.discovery(undefined, cache),
  identityAssertion: (aud: string, nonce?: string) =>
    c.req<Assertion>('POST', '/identity/assertion', { aud, nonce }),
  p2pIce: () => c.req<IceServers>('GET', '/p2p/ice'),
  p2pBinding: (ik: string, ts: number, proof: string) =>
    c.req<P2pBinding>('POST', '/identity/p2p_binding', { ik, ts, proof }),
})

export type Api = ApiClient & ReturnType<typeof endpoints>

export const createApi = (base: string, cookieMode?: RequestCredentials, pace?: Pace): Api => {
  const client = new ApiClient(base, cookieMode, pace)
  return Object.assign(client, endpoints(client))
}

export interface Assertion {
  token: string
  iss: string
  sub: string
  expires_at: number
}

// Your own timeouts end on this device's clock, counted from the seconds left the server sent.
export const localSummary = (s: ServerSummary, now = time().now()): ServerSummary =>
  s.timed_out_remaining == null
    ? s
    : { ...s, timed_out_until: localUntil(s.timed_out_remaining, now) }

const localMe = (me: Me): Me => ({ ...me, servers: me.servers.map(s => localSummary(s)) })

const localAuth = (res: AuthResponse): AuthResponse => ({ ...res, user: localMe(res.user) })

export interface P2pBinding {
  token: string
  iss: string
  sub: string
  ik: string
  expires_at: number
}

function pageQuery(page: PageOpts) {
  const parts = Object.entries(page)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${v}`)
  return parts.length ? `?${parts.join('&')}` : ''
}
