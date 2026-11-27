import { createApi, isJson, resolveApiBase, type Api } from './api'
import { instanceDocument } from './api/public'
import { apiRoot, prefixOf, versionedUrl } from './api_version'
import { getBasePath } from './basePath'
import { hostOf, normalizeHost, privateHost } from './qualified'

export { privateHost }
import { WsClient, wsUrlFrom } from './ws'
import { shellInfo } from './platform/desktop'
import type { InstanceInfo } from './types'

import { DEFAULT_INSTANCE_NAME } from './instance_label'
import { limitsOf } from './instance_limits'

export { DEFAULT_INSTANCE_NAME }

const CLIENT_API_MAJOR = 1

export interface PeerTarget {
  host: string
  port: number
  path: string
  secure: boolean
}

export interface Endpoints {
  url: () => string
  probe: () => string
  origin: string
  api: string
  peer: (info?: InstanceInfo | null) => PeerTarget
}

export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>

const HOME_KEY = 'rchat_home'
const KNOWN_KEY = 'rchat_instances'
const KNOWN_MAX = 20
const LOOPBACK = /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?(?:[/?#]|$)/i

export function normalizeOrigin(raw: string): string | null {
  let text = raw.trim()
  if (!text) return null
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text))
    text = `${LOOPBACK.test(text) ? 'http' : 'https'}://${text}`
  try {
    const url = new URL(text)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    if (url.username || url.password || !url.hostname) return null
    return url.origin
  } catch {
    return null
  }
}

const trimSlash = (s: string) => s.replace(/\/+$/, '')

const hostnameOf = (origin: string) => {
  try {
    return new URL(origin).hostname
  } catch {
    return null
  }
}

export function remoteAllowed(origin: string, homeOrigin: string): boolean {
  let url: URL
  try {
    url = new URL(origin)
  } catch {
    return false
  }
  if (url.username || url.password) return false
  const homeHost = hostnameOf(homeOrigin)
  const dev = homeHost !== null && privateHost(homeHost)
  if (url.protocol === 'https:') return dev || !privateHost(url.hostname)
  return url.protocol === 'http:' && dev && privateHost(url.hostname)
}

export function sameSite(
  origin: string,
  info: Pick<InstanceInfo, 'api_url' | 'ws_url'> & {
    peerjs_url?: string
  }
): boolean {
  try {
    const site = new URL(origin)
    const api = new URL(info.api_url)
    const ws = new URL(info.ws_url)
    const wsProtocol = site.protocol === 'https:' ? 'wss:' : 'ws:'
    const peer = info.peerjs_url ? new URL(info.peerjs_url) : null
    return (
      api.origin === site.origin &&
      ws.protocol === wsProtocol &&
      ws.host === site.host &&
      (peer === null || peer.hostname === site.hostname)
    )
  } catch {
    return false
  }
}

const webPort = (secure: boolean, port?: string) => Number(port || (secure ? 443 : 80))

// PeerJS for an instance: the address it advertises, else /peerjs on its own origin.
export function peerFrom(raw: string | undefined, origin: string): PeerTarget {
  try {
    const url = new URL(raw ?? '')
    const secure = url.protocol === 'https:'
    return {
      host: url.hostname,
      port: webPort(secure, url.port),
      path: trimSlash(url.pathname) || '/',
      secure,
    }
  } catch {
    const url = new URL(origin)
    const secure = url.protocol === 'https:'
    return { host: url.hostname, port: webPort(secure, url.port), path: '/peerjs', secure }
  }
}

const urlOf = (raw: string | undefined) => {
  try {
    return raw ? new URL(raw) : null
  } catch {
    return null
  }
}

// PeerJS for the web app on the instance's own site: the build's NEXT_PUBLIC_PEERJS_HOST and
// _PORT when set, else the address the instance advertises (PUBLIC_PEERJS_URL, PEERJS_PORT, or
// /peerjs on its origin), else /peerjs on the page's own origin. An instance that names itself
// differently from the page (`site`, its public_url) means the page's host; another host is one
// the operator named, where every client of the instance registers. The page's https always
// means wss.
export function homePeer(
  page: { hostname: string; protocol: string; port?: string },
  advertised: string | undefined,
  baked: { host?: string; port?: string } = {
    host: process.env.NEXT_PUBLIC_PEERJS_HOST,
    port: process.env.NEXT_PUBLIC_PEERJS_PORT,
  },
  site?: string
): PeerTarget {
  const pageSecure = page.protocol === 'https:'
  if (baked.host || baked.port)
    return {
      host: baked.host || page.hostname,
      port: Number(baked.port || '9001'),
      path: '/peerjs',
      secure: pageSecure,
    }
  const url = urlOf(advertised)
  if (url && /^https?:$/.test(url.protocol)) {
    const secure = pageSecure || url.protocol === 'https:'
    const path = trimSlash(url.pathname) || '/'
    const own = urlOf(site)
    if (url.hostname !== page.hostname && own && url.hostname === own.hostname)
      return {
        host: page.hostname,
        port: url.host === own.host ? webPort(pageSecure, page.port) : webPort(secure, url.port),
        path,
        secure: pageSecure,
      }
    return { host: url.hostname, port: webPort(secure, url.port), path, secure }
  }
  return {
    host: page.hostname,
    port: webPort(pageSecure, page.port),
    path: '/peerjs',
    secure: pageSecure,
  }
}

// The instance's unversioned API root, gateway and health URLs; a connection pins them to the
// version its document allows.
export function endpointsFrom(origin: string, info: InstanceInfo | null): Endpoints {
  const api = apiRoot(info?.api_url || `${origin}/api`)
  const ws = info?.ws_url || wsUrlFrom(origin)
  return {
    origin,
    api,
    url: () => ws,
    probe: () => `${api}/health`,
    peer: () => peerFrom(info?.peerjs_url, origin),
  }
}

export const clientOnly = () => process.env.NEXT_PUBLIC_CLIENT_ONLY === 'true'

const bakedApi = process.env.NEXT_PUBLIC_API_URL?.replace(/\/+$/, '') || undefined
const bakedWs = process.env.NEXT_PUBLIC_WS_URL?.replace(/\/+$/, '') || undefined

type Page = { href: string; protocol: string; host: string; hostname: string; port?: string }

// The page's own instance. Unless the build names another address (`baked`), every address is
// on the page's origin. The page is asked for each time an address is built. Without a page
// (the server render) the API is the local server.
export function homeEndpoints(
  page: () => Page | undefined,
  baked: { api?: string; ws?: string; peer?: { host?: string; port?: string } } = {},
  basePath: () => string = () => '',
  server: { host?: string; port?: string } = {}
): Endpoints {
  const now = page()
  const api = resolveApiBase(baked.api, now !== undefined, server.host, server.port)
  return {
    origin: new URL(api, now?.href).origin,
    api,
    url: () => wsUrlFrom(baked.api, page(), basePath(), baked.ws),
    probe: () => (baked.api ? `${baked.api}/api/health` : `${basePath()}/api/health`),
    peer: info => homePeer(page() as Page, info?.peerjs_url, baked.peer, info?.public_url),
  }
}

export const pageEndpoints = (): Endpoints =>
  homeEndpoints(
    () => (typeof window !== 'undefined' ? window.location : undefined),
    clientOnly() ? {} : { api: bakedApi, ws: bakedWs },
    getBasePath,
    { host: process.env.HOST, port: process.env.SERVER_PORT }
  )

// Wire the home store before a user chooses a server, but never probe a client-only host.
export const defaultEndpoints = (): Endpoints | null => (clientOnly() ? null : pageEndpoints())

export const ownInstance = (answered = true) => (answered ? defaultEndpoints() : null)

export const isClientHost = (origin: string) =>
  clientOnly() && typeof window !== 'undefined' && origin === window.location.origin

export const awaitingInstance = (conn: InstanceConnection) =>
  clientOnly() && conn.isHome && conn.isDefault

const isUrl = (v: unknown, protocols: string[]) => {
  if (typeof v !== 'string') return false
  try {
    return protocols.includes(new URL(v).protocol)
  } catch {
    return false
  }
}

export function fromOrigin(origin: string, info: Pick<InstanceInfo, 'host' | 'public_url'>) {
  try {
    return (
      new URL(info.public_url).origin === new URL(origin).origin &&
      normalizeHost(info.host) === hostOf(origin)
    )
  } catch {
    return false
  }
}

export function validInfo(x: unknown, origin?: string): x is InstanceInfo {
  if (typeof x !== 'object' || x === null) return false
  const o = x as Record<string, unknown>
  return (
    o.software === 'rchat' &&
    typeof o.id === 'string' &&
    o.id.length > 0 &&
    typeof o.name === 'string' &&
    typeof o.host === 'string' &&
    isUrl(o.public_url, ['http:', 'https:']) &&
    (origin === undefined || fromOrigin(origin, o as Pick<InstanceInfo, 'host' | 'public_url'>)) &&
    typeof o.api_version === 'string' &&
    isUrl(o.api_url, ['http:', 'https:']) &&
    isUrl(o.ws_url, ['ws:', 'wss:']) &&
    typeof o.features === 'object' &&
    o.features !== null
  )
}

export const apiMajor = (version: string) => Number.parseInt(version.split('.')[0] ?? '', 10)

export const compatible = (info: InstanceInfo) => apiMajor(info.api_version) === CLIENT_API_MAJOR

export class InstanceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InstanceError'
  }
}

export async function fetchInstance(
  origin: string,
  fetcher?: Fetcher,
  timeoutMs = 8000
): Promise<InstanceInfo> {
  if (isClientHost(origin))
    throw new InstanceError('Enter the address of an RChat instance. This address serves the app.')
  const host = hostOf(origin) ?? origin
  for (const path of ['document', 'wellKnown'] as const) {
    let res: Response
    try {
      res = await instanceDocument(origin, path, timeoutMs).send(fetcher)
    } catch {
      throw new InstanceError(`Can't reach ${host}`)
    }
    if (!res.ok || !isJson(res)) continue
    const body: unknown = await res.json().catch(() => null)
    if (!validInfo(body)) continue
    if (!fromOrigin(origin, body)) throw new InstanceError(`${host} claims to be another site`)
    if (!sameSite(origin, body))
      throw new InstanceError(`${host} advertises endpoints on another site`)
    return body
  }
  throw new InstanceError(`No RChat instance at ${host}`)
}

export async function resolveInstance(
  input: string,
  fetcher?: Fetcher
): Promise<{ origin: string; info: InstanceInfo }> {
  const origin = normalizeOrigin(input)
  if (!origin) throw new InstanceError('Enter an instance address, like chat.example.com')
  const info = await fetchInstance(origin, fetcher)
  const host = hostOf(origin) ?? origin
  if (!compatible(info))
    throw new InstanceError(
      apiMajor(info.api_version) > CLIENT_API_MAJOR
        ? `${host} needs a newer RChat client (API ${info.api_version})`
        : `${host} runs an older RChat API (${info.api_version}) this client can't use`
    )
  return { origin, info }
}

export class InstanceConnection {
  readonly api: Api
  readonly ws: WsClient
  private doc: InstanceInfo | null = null

  constructor(
    private ends: Endpoints,
    info: InstanceInfo | null = null,
    public isDefault = false,
    readonly isHome = false
  ) {
    this.api = createApi(ends.api, isHome ? 'same-origin' : 'omit')
    this.info = info
    this.ws = new WsClient(this.pinned)
  }

  // The instance's document, which also picks the API version this connection calls.
  get info() {
    return this.doc
  }

  set info(info: InstanceInfo | null) {
    this.doc = info
    this.api.prefix = prefixOf(info)
  }

  private pinned = {
    open: () => this.api.socket(versionedUrl(this.ends.url(), this.api.prefix)),
    reachable: () => this.api.reachable(this.health()),
    timings: () => limitsOf(this.info),
  }

  health() {
    return versionedUrl(this.ends.probe(), this.api.prefix)
  }

  get origin() {
    return this.ends.origin
  }

  get apiBase() {
    return this.api.base
  }

  get host() {
    return hostOf(this.origin) ?? this.origin
  }

  get name() {
    return this.info?.name || DEFAULT_INSTANCE_NAME
  }

  peer() {
    return this.ends.peer(this.info)
  }

  scoped(key: string) {
    return this.isDefault ? key : `${key}@${this.host}`
  }

  retarget(ends: Endpoints, info: InstanceInfo | null, isDefault: boolean) {
    this.ends = ends
    this.info = info
    this.isDefault = isDefault
    this.api.setBase(ends.api)
    this.api.setToken(null)
    this.api.setGrants({})
    this.ws.retarget(this.pinned)
  }
}

const storage = (): StorageLike | null => {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

const local = (): Storage | null => (typeof localStorage === 'undefined' ? null : localStorage)
const session = (): StorageLike | null => window.sessionStorage

// A value in the storage `store` gives; storage that throws (blocked, full or failing) reads as
// nothing saved.
const read = (store: () => StorageLike | null, key: string) => {
  try {
    return store()?.getItem(key) ?? null
  } catch {
    return null
  }
}

// Writes or removes a value in the storage `store` gives. False when getting the storage or
// writing to it throws; `warn` says so in the console.
function write(store: () => StorageLike | null, key: string, value: string | null, warn = true) {
  try {
    const to = store()
    if (value === null) to?.removeItem(key)
    else to?.setItem(key, value)
    return true
  } catch (e) {
    if (warn) console.warn('localStorage write failed', key, e)
    return false
  }
}

export function canReadSharedStorage() {
  try {
    const store = local()
    if (!store) return false
    store.getItem('rchat_book')
    return true
  } catch {
    return false
  }
}

export const readLocal = (key: string) => read(local, key)

export const localKeys = (prefix: string): string[] => {
  try {
    const storage = local()
    const keys: string[] = []
    if (storage)
      for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i)
        if (key?.startsWith(prefix)) keys.push(key)
      }
    return keys
  } catch {
    return []
  }
}

export const writeLocal = (key: string, value: string | null) => write(local, key, value)

// This tab's sessionStorage, through the same guard.
export const sessionStore: StorageLike = {
  getItem: key => read(session, key),
  setItem: (key, value) => void write(session, key, value, false),
  removeItem: key => void write(session, key, null, false),
}

export function readKnown(store: StorageLike | null = storage()): Record<string, InstanceInfo> {
  try {
    const raw = JSON.parse(read(() => store, KNOWN_KEY) ?? '{}') as Record<string, unknown>
    return Object.fromEntries(
      Object.entries(raw).filter(
        (e): e is [string, InstanceInfo] => validInfo(e[1], e[0]) && sameSite(e[0], e[1])
      )
    )
  } catch {
    return {}
  }
}

export function rememberInstance(
  origin: string,
  info: InstanceInfo,
  store: StorageLike | null = storage()
) {
  const known = readKnown(store)
  delete known[origin]
  const entries = [[origin, info] as const, ...Object.entries(known)].slice(0, KNOWN_MAX)
  write(() => store, KNOWN_KEY, JSON.stringify(Object.fromEntries(entries)))
}

export function savedHome(defaultOrigin: string, store: StorageLike | null = storage()) {
  const saved = read(() => store, HOME_KEY)
  const origin = saved ? normalizeOrigin(saved) : null
  return origin ?? defaultOrigin
}

export function createHomeConnection() {
  // The unconnected home store needs addresses to construct its API and socket,
  // even on a shell that has no server of its own. Startup waits for Add an instance.
  const defaults = pageEndpoints()
  const origin = savedHome(defaults.origin)
  const info = readKnown()[origin] ?? null
  return origin === defaults.origin
    ? new InstanceConnection(defaults, info, true, true)
    : new InstanceConnection(endpointsFrom(origin, info), info, false, true)
}

// The selected page instance survives reloads of the desktop client.
export function rememberHome(connection: InstanceConnection, info: InstanceInfo) {
  const store = storage()
  write(() => store, HOME_KEY, connection.isDefault ? null : connection.origin)
  rememberInstance(connection.origin, info, store)
}

export const MEDIA_COOKIE_CHANGE = 'rchat-media-cookie-change'

export function ownsMediaCookie(connection: InstanceConnection): boolean {
  if (!connection.isHome || !connection.isDefault || typeof document === 'undefined') return false
  try {
    // The media endpoint reads the first cookie with this name.
    const pair = document.cookie
      .split(';')
      .map(part => part.trim())
      .find(part => part.startsWith('rchat_token='))
    return !!pair && connection.api.hasToken(pair.slice('rchat_token='.length))
  } catch {
    return false
  }
}

// Same-origin private media loads with the home connection's cookie.
export function setMediaCookie(connection: InstanceConnection, token: string | null) {
  if (!connection.isHome || !connection.isDefault) return
  const attrs = `path=/; SameSite=Strict${window.location.protocol === 'https:' ? '; Secure' : ''}`
  try {
    document.cookie = token
      ? `rchat_token=${token}; ${attrs}; max-age=31536000`
      : `rchat_token=; ${attrs}; max-age=0`
  } catch {
    // Header-authenticated media remains available when the browser blocks cookies.
  }
  window.dispatchEvent?.(new Event(MEDIA_COOKIE_CHANGE))
}

export const fitsHome = (info: InstanceInfo, conn: InstanceConnection) =>
  conn.isDefault || (fromOrigin(conn.origin, info) && sameSite(conn.origin, info))

// A lookup of the home instance's discovery document: `settled` waits for `done`, at most `ms`.
export const lookup = () => {
  let finish = () => {}
  const looked = new Promise<void>(resolve => {
    finish = resolve
  })
  return {
    done: () => finish(),
    settled: (ms: number) =>
      Promise.race([looked, new Promise<void>(resolve => setTimeout(resolve, ms))]),
  }
}

export function noteHomeInfo(info: InstanceInfo, connection: InstanceConnection) {
  connection.info = info
  rememberInstance(connection.origin, info)
}

export const knownInstances = () =>
  Object.entries(readKnown()).map(([origin, info]) => ({ origin, info }))

// The site links for other people point at: this page on the web, the home instance in the
// desktop and mobile apps (whose own pages live on an app-only origin nobody else can open).
export function shareOrigin(
  page: Pick<Location, 'protocol' | 'origin'> | null = typeof window === 'undefined'
    ? null
    : window.location,
  app = shellInfo() !== null,
  connection: InstanceConnection
): string {
  if (
    connection.isHome &&
    page &&
    !app &&
    (page.protocol === 'http:' || page.protocol === 'https:')
  )
    return page.origin
  return normalizeOrigin(connection.info?.public_url ?? '') ?? connection.origin
}

// The current page's address on the share origin, so app-only origins parse like web ones.
export const pageHref = (origin: string, pathname = window.location.pathname) =>
  `${origin}${pathname}${window.location.search}${window.location.hash}`

export function localOrigins(
  connection: InstanceConnection,
  homePublic: string | null = connection.info?.public_url ?? null
) {
  const page = typeof window === 'undefined' ? null : window.location.origin
  const all = [
    connection.isHome ? page : null,
    connection.origin,
    homePublic ? normalizeOrigin(homePublic) : null,
  ]
  return all.filter((o, at): o is string => o !== null && all.indexOf(o) === at)
}
