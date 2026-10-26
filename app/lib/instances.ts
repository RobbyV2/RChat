import { createApi, resolveApiBase, type Api } from './api'
import { getBasePath } from './basePath'
import { hostOf, normalizeHost, privateHost } from './qualified'

export { privateHost }
import { WsClient, wsUrlFrom, type WsEndpoints } from './ws'
import type { InstanceInfo } from './types'

export const CLIENT_API_MAJOR = 1
export const DEFAULT_INSTANCE_NAME = 'RChat'

export interface PeerTarget {
  host: string
  port: number
  path: string
  secure: boolean
}

export interface Endpoints extends WsEndpoints {
  origin: string
  api: string
  peer: () => PeerTarget
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

export function peerFrom(raw: string | undefined, origin: string): PeerTarget {
  try {
    const url = new URL(raw ?? '')
    const secure = url.protocol === 'https:'
    return {
      host: url.hostname,
      port: Number(url.port || (secure ? 443 : 80)),
      path: trimSlash(url.pathname) || '/',
      secure,
    }
  } catch {
    const url = new URL(origin)
    return { host: url.hostname, port: 9001, path: '/peerjs', secure: url.protocol === 'https:' }
  }
}

export function endpointsFrom(origin: string, info: InstanceInfo | null): Endpoints {
  const api = trimSlash(info?.api_url || `${origin}/api`)
  const ws = info?.ws_url || wsUrlFrom(origin)
  return {
    origin,
    api,
    url: () => ws,
    probe: () => `${api}/health`,
    peer: () => peerFrom(info?.peerjs_url, origin),
  }
}

const bakedApi = process.env.NEXT_PUBLIC_API_URL?.replace(/\/+$/, '') || undefined
const bakedWs = process.env.NEXT_PUBLIC_WS_URL?.replace(/\/+$/, '') || undefined

export function defaultEndpoints(): Endpoints {
  const hasWindow = typeof window !== 'undefined'
  const api = resolveApiBase(bakedApi, hasWindow, process.env.HOST, process.env.SERVER_PORT)
  const origin = new URL(api, hasWindow ? window.location.href : undefined).origin
  return {
    origin,
    api,
    url: () => wsUrlFrom(bakedApi, window.location, getBasePath(), bakedWs),
    probe: () => (bakedApi ? `${bakedApi}/api/health` : `${getBasePath()}/api/health`),
    peer: () => ({
      host: process.env.NEXT_PUBLIC_PEERJS_HOST || window.location.hostname,
      port: Number(process.env.NEXT_PUBLIC_PEERJS_PORT || '9001'),
      path: '/peerjs',
      secure: window.location.protocol === 'https:',
    }),
  }
}

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
  fetcher: Fetcher = (input, init) => fetch(input, init),
  timeoutMs = 8000
): Promise<InstanceInfo> {
  const host = hostOf(origin) ?? origin
  for (const path of ['/api/instance', '/.well-known/rchat']) {
    let res: Response
    try {
      res = await fetcher(`${origin}${path}`, {
        signal: AbortSignal.timeout(timeoutMs),
        credentials: 'omit',
        headers: { Accept: 'application/json' },
      })
    } catch {
      throw new InstanceError(`Can't reach ${host}`)
    }
    if (!res.ok) continue
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

  constructor(
    private ends: Endpoints,
    public info: InstanceInfo | null = null,
    public isDefault = false
  ) {
    this.api = createApi(ends.api)
    this.ws = new WsClient(ends)
  }

  get origin() {
    return this.ends.origin
  }

  get apiBase() {
    return this.ends.api
  }

  get host() {
    return hostOf(this.origin) ?? this.origin
  }

  get name() {
    return this.info?.name || DEFAULT_INSTANCE_NAME
  }

  peer() {
    return this.ends.peer()
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
    this.ws.retarget(ends)
  }
}

export class InstanceRegistry {
  private others = new Map<string, InstanceConnection>()

  constructor(
    readonly home: InstanceConnection,
    private defaults: () => Endpoints
  ) {}

  list() {
    return [this.home, ...this.others.values()]
  }

  get(origin: string) {
    const key = normalizeOrigin(origin)
    if (!key) return null
    return key === this.home.origin ? this.home : (this.others.get(key) ?? null)
  }

  byHost(host: string) {
    const want = normalizeHost(host)
    return this.list().find(c => c.host === want) ?? null
  }

  isHome(originOrHost: string) {
    const origin = normalizeOrigin(originOrHost)
    return origin === this.home.origin || normalizeHost(originOrHost) === this.home.host
  }

  add(origin: string, info: InstanceInfo | null = null) {
    const key = normalizeOrigin(origin)
    if (!key) throw new InstanceError('Not an instance address')
    const found = this.get(key)
    if (found) {
      if (info) found.info = info
      return found
    }
    const conn = new InstanceConnection(endpointsFrom(key, info), info)
    this.others.set(key, conn)
    return conn
  }

  remove(origin: string) {
    const key = normalizeOrigin(origin)
    const conn = key ? this.others.get(key) : undefined
    if (!key || !conn) return false
    conn.ws.stop()
    this.others.delete(key)
    return true
  }

  setHome(origin: string, info: InstanceInfo | null) {
    const key = normalizeOrigin(origin)
    if (!key) throw new InstanceError('Not an instance address')
    const defaults = this.defaults()
    const isDefault = key === defaults.origin
    this.home.ws.stop()
    this.home.retarget(isDefault ? defaults : endpointsFrom(key, info), info, isDefault)
    this.others.delete(key)
    return this.home
  }
}

const storage = (): StorageLike | null => {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

function write(store: StorageLike | null, key: string, value: string | null) {
  try {
    if (value === null) store?.removeItem(key)
    else store?.setItem(key, value)
  } catch (e) {
    console.warn('localStorage write failed', key, e)
  }
}

export function readKnown(store: StorageLike | null = storage()): Record<string, InstanceInfo> {
  try {
    const raw = JSON.parse(store?.getItem(KNOWN_KEY) ?? '{}') as Record<string, unknown>
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
  write(store, KNOWN_KEY, JSON.stringify(Object.fromEntries(entries)))
}

export function savedHome(defaultOrigin: string, store: StorageLike | null = storage()) {
  const saved = store?.getItem(HOME_KEY)
  const origin = saved ? normalizeOrigin(saved) : null
  return origin ?? defaultOrigin
}

function initialHome() {
  const defaults = defaultEndpoints()
  const origin = savedHome(defaults.origin)
  const info = readKnown()[origin] ?? null
  return origin === defaults.origin
    ? new InstanceConnection(defaults, info, true)
    : new InstanceConnection(endpointsFrom(origin, info), info, false)
}

export const registry = new InstanceRegistry(initialHome(), defaultEndpoints)

export const home = registry.home

export const api = home.api

export function selectHome(origin: string, info: InstanceInfo) {
  const conn = registry.setHome(origin, info)
  const store = storage()
  write(store, HOME_KEY, conn.isDefault ? null : conn.origin)
  rememberInstance(conn.origin, info, store)
  return conn
}

export const fitsHome = (info: InstanceInfo, conn: InstanceConnection = home) =>
  conn.isDefault || (fromOrigin(conn.origin, info) && sameSite(conn.origin, info))

export function noteHomeInfo(info: InstanceInfo) {
  home.info = info
  rememberInstance(home.origin, info)
}

export const knownInstances = () =>
  Object.entries(readKnown()).map(([origin, info]) => ({ origin, info }))

export function localOrigins(homePublic: string | null = home.info?.public_url ?? null) {
  const page = typeof window === 'undefined' ? null : window.location.origin
  const all = [page, home.origin, homePublic ? normalizeOrigin(homePublic) : null]
  return all.filter((o, at): o is string => o !== null && all.indexOf(o) === at)
}
