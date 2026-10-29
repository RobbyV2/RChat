import { api, home } from './instances'
import type { IceServers, InstanceIce } from './types'

// The only source of ICE servers. Without it, PeerJS uses its own public STUN and TURN servers,
// so every Peer and RTCPeerConnection gets its config from iceConfig(). The instance supplies the
// servers: STUN from the discovery `ice` list, and TURN credentials from /api/p2p/ice for
// signed-in users, refreshed at 80% of their lifetime.

export interface IceSource {
  info: () => InstanceIce | null | undefined
  fetch: () => Promise<IceServers>
  now: () => number
}

export interface Timers {
  set: (fn: () => void, ms: number) => unknown
  clear: (handle: unknown) => void
}

const realTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

const REFRESH_SHARE = 0.8
export const RETRY_MS = 60_000
const SCHEMES = /^(stun|stuns|turn|turns):[^\s]+$/

const urlsOf = (urls: unknown): string[] =>
  (Array.isArray(urls) ? urls : [urls]).filter(
    (u): u is string => typeof u === 'string' && SCHEMES.test(u)
  )

export const cleanServers = (list: unknown): RTCIceServer[] =>
  (Array.isArray(list) ? list : []).flatMap(entry => {
    if (typeof entry !== 'object' || entry === null) return []
    const { urls, username, credential } = entry as Record<string, unknown>
    const clean = urlsOf(urls)
    if (clean.length === 0) return []
    const server: RTCIceServer = { urls: clean }
    if (typeof username === 'string') server.username = username
    if (typeof credential === 'string') server.credential = credential
    return [server]
  })

const stunOf = (info: InstanceIce | null | undefined): RTCIceServer[] => {
  const urls = urlsOf(info?.stun ?? []).filter(u => u.startsWith('stun'))
  return urls.length ? [{ urls }] : []
}

const copy = (s: RTCIceServer): RTCIceServer => ({
  ...s,
  urls: Array.isArray(s.urls) ? [...s.urls] : s.urls,
})

export class IceCache {
  private list: RTCIceServer[] = []
  private expires = 0
  private signedIn = false
  private helpers = true
  private relay = false
  private timer: unknown = null
  private gen = 0
  private listeners = new Set<() => void>()
  policy: RTCIceTransportPolicy | null = null

  constructor(
    private src: IceSource,
    private timers: Timers = realTimers
  ) {}

  servers(): RTCIceServer[] {
    return this.helpers ? this.list.map(copy) : []
  }

  config(): RTCConfiguration {
    const config: RTCConfiguration = { iceServers: this.servers() }
    const policy = this.policy ?? (this.relayActive() ? 'relay' : null)
    if (policy) config.iceTransportPolicy = policy
    return config
  }

  helpersOn() {
    return this.helpers
  }

  setHelpers(on: boolean) {
    if (this.helpers === on) return
    this.helpers = on
    this.emit()
  }

  setRelay(on: boolean) {
    if (this.relay === on) return
    this.relay = on
    this.emit()
  }

  // Relay only is in force: the user asked for it, helpers are on and the instance has a TURN
  // relay. Then connections use relayed candidates only, even before the credentials arrive,
  // so they fail rather than show the user's IP address.
  relayActive() {
    return relayOnly(this.src.info(), this.helpers, this.relay)
  }

  setSignedIn(on: boolean) {
    this.signedIn = on
    return this.refresh()
  }

  onChange(fn: () => void) {
    this.listeners.add(fn)
    return () => void this.listeners.delete(fn)
  }

  private emit() {
    for (const fn of this.listeners) fn()
  }

  private cancel() {
    if (this.timer !== null) this.timers.clear(this.timer)
    this.timer = null
  }

  private schedule(ms: number) {
    this.cancel()
    this.timer = this.timers.set(
      () => {
        this.timer = null
        void this.refresh()
      },
      Math.max(1_000, Math.min(ms, 2 ** 31 - 1))
    )
  }

  async refresh(): Promise<RTCConfiguration> {
    const gen = ++this.gen
    this.cancel()
    const info = this.src.info()
    let next = stunOf(info)
    if (info?.turn && this.signedIn) {
      try {
        const res = await this.src.fetch()
        if (gen !== this.gen) return this.config()
        next = cleanServers(res.ice_servers)
        this.expires = res.expires_at * 1000
        const ttl = this.expires - this.src.now()
        this.schedule(ttl > 0 ? ttl * REFRESH_SHARE : RETRY_MS)
      } catch {
        if (gen !== this.gen) return this.config()
        if (this.expires > this.src.now()) next = this.list
        this.schedule(RETRY_MS)
      }
    } else this.expires = 0
    this.list = next
    this.emit()
    return this.config()
  }

  stop() {
    this.gen++
    this.cancel()
    this.signedIn = false
  }
}

export const relayOnly = (info: InstanceIce | null | undefined, helpers: boolean, relay: boolean) =>
  relay && helpers && info?.turn === true

// Stored per account: { v: 1, on, relay }. Anything unreadable means helpers on, relay only off.
export const iceKey = (username: string | null) => `rchat_ice:${username ?? 'guest'}`

export interface IcePrefs {
  on: boolean
  relay: boolean
}

export const parseIce = (raw: string | null): IcePrefs => {
  try {
    const v = raw ? (JSON.parse(raw) as unknown) : null
    if (typeof v !== 'object' || v === null || (v as { v?: unknown }).v !== 1)
      return { on: true, relay: false }
    const { on, relay } = v as { on?: unknown; relay?: unknown }
    return { on: on !== false, relay: relay === true }
  } catch {
    return { on: true, relay: false }
  }
}

export const parseHelpers = (raw: string | null): boolean => parseIce(raw).on

export const iceValue = ({ on, relay }: IcePrefs) => JSON.stringify({ v: 1, on, relay })

export const helpersValue = (on: boolean) => iceValue({ on, relay: false })

// Test hook: `?ice=relay` forces relayed candidates for this tab, to check the relay path.
const forcedPolicy = (): RTCIceTransportPolicy | null => {
  if (typeof window === 'undefined') return null
  try {
    const flag = new URLSearchParams(window.location.search).get('ice')
    if (flag === 'relay' || flag === 'all') sessionStorage.setItem('rchat_ice_policy', flag)
    return sessionStorage.getItem('rchat_ice_policy') === 'relay' ? 'relay' : null
  } catch {
    return null
  }
}

export const ice = new IceCache({
  info: () => home.info?.ice,
  fetch: () => api.p2pIce(),
  now: () => Date.now(),
})
ice.policy = forcedPolicy()

export const iceServers = (): RTCIceServer[] => ice.servers()

export const iceConfig = (): RTCConfiguration => ice.config()

// What the instance offers, for the settings line.
export const iceOffer = (info: InstanceIce | null | undefined): string[] => {
  if (!info) return []
  const out: string[] = []
  const publicStun = info.stun.length - (info.relay ? 1 : 0)
  if (publicStun > 0)
    out.push(`Public STUN (${publicStun} ${publicStun === 1 ? 'server' : 'servers'})`)
  if (info.relay) out.push('Instance relay')
  else if (info.turn) out.push('Relay servers')
  return out
}
