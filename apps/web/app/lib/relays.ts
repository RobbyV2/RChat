import { ice, probeRelay } from './ice'
import { device } from './platform'

// The user's own STUN and TURN relays, on top of what the instance offers, for P2P files and
// P2P calls. They live on this device only (credentials included) and are never sent to the
// server or to peers; peers only learn the host of a TURN relay we connect through, so they
// can ask their user first. Each side uses its own relays: when both use different ones, the
// connection runs relay to relay. Relay only is the real IP protection, since a dishonest peer
// can always skip relays.

export interface Relay {
  url: string
  username?: string
  credential?: string
}

// 'auto' (instance relays plus ours, ICE picks a working path) or the URL of one of our TURN
// relays (that relay only, no fallback).
export type RelayChoice = string

export const AUTO: RelayChoice = 'auto'

export interface RelayPrefs {
  relays: Relay[]
  // Relay hosts of others the user always allows.
  allowed: string[]
  // Ask before connecting through a relay host that isn't known.
  ask: boolean
  choice: RelayChoice
}

export const RELAYS_MAX = 8
export const ALLOWED_MAX = 100
// Same as the server's cap on declared hosts.
export const DECLARED_MAX = 4
const URL_MAX = 300
const SECRET_MAX = 512
const HOST_MAX = 253
export const HOST_SHOWN = 48

export const defaultRelays = (): RelayPrefs => ({
  relays: [],
  allowed: [],
  ask: true,
  choice: AUTO,
})

const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/
const QUAD = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/

// A lowercase ASCII host: DNS labels, a dotted IPv4 address or a bracketed IPv6 address. A name
// ending in an all-digit label must be a dotted quad. The same rule as the server's relay_host.
export const cleanHost = (raw: unknown): string | null => {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > HOST_MAX) return null
  const host = raw.toLowerCase()
  if (host.startsWith('[')) {
    if (!/^\[[0-9a-f:.]+\]$/.test(host)) return null
    try {
      return new URL(`http://${host}/`).hostname
    } catch {
      return null
    }
  }
  const labels = host.split('.')
  if (!labels.every(l => LABEL.test(l))) return null
  if (/^\d+$/.test(labels[labels.length - 1]) && !QUAD.test(host)) return null
  return host
}

// What the user typed as a host: internationalized names become punycode, nothing else is
// rewritten (no shorthand or hex IPv4 forms).
const typedHost = (raw: string): string | null => {
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7f]*$/.test(raw)) return cleanHost(raw)
  if (/[\s/?#@:%\\[\]]/.test(raw)) return null
  try {
    return cleanHost(new URL(`http://${raw}/`).hostname)
  } catch {
    return null
  }
}

export type Scheme = 'stun' | 'turn' | 'turns'

export type ParsedUrl =
  { ok: true; url: string; scheme: Scheme; host: string } | { ok: false; error: string }

const URL_SHAPE =
  /^(stun|turn|turns):(\[[^\]\s]*\]|[^\s:/?#@[\]]+)(?::(\d{1,5}))?(?:\?transport=([a-z]+))?$/i

export const URL_HINT = 'Use stun:, turn: or turns: with a host and optional port'

// stun:host[:port], turn:host[:port][?transport=udp|tcp] or turns:host[:port][?transport=tcp].
// Returns the URL in a normal form (lowercase scheme and host).
export const parseRelayUrl = (input: string): ParsedUrl => {
  const text = input.trim()
  if (!text) return { ok: false, error: 'Enter a relay address' }
  if (text.length > URL_MAX) return { ok: false, error: 'That address is too long' }
  const m = URL_SHAPE.exec(text)
  if (!m) return { ok: false, error: URL_HINT }
  const scheme = m[1].toLowerCase() as Scheme
  const host = typedHost(m[2])
  if (!host) return { ok: false, error: 'That host is not valid' }
  const port = m[3] === undefined ? null : Number(m[3])
  if (port !== null && (port < 1 || port > 65535 || m[3].startsWith('0')))
    return { ok: false, error: 'The port must be 1 to 65535' }
  const transport = m[4]?.toLowerCase() ?? null
  if (transport !== null && transport !== 'udp' && transport !== 'tcp')
    return { ok: false, error: 'Transport must be udp or tcp' }
  if (scheme === 'stun' && transport !== null)
    return { ok: false, error: 'STUN addresses take no transport' }
  if (scheme === 'turns' && transport === 'udp')
    return { ok: false, error: 'TURNS works over TCP only' }
  const url = `${scheme}:${host}${port === null ? '' : `:${port}`}${
    transport === null ? '' : `?transport=${transport}`
  }`
  return { ok: true, url, scheme, host }
}

export const hostOf = (url: string): string | null => {
  const p = parseRelayUrl(url)
  return p.ok ? p.host : null
}

export const isTurn = (url: string) => /^turns?:/i.test(url)

// A host as shown to the user: already plain ASCII, cut in the middle when long.
export const displayHost = (host: string) => {
  const safe = host.replace(/[^a-z0-9.:[\]-]/gi, '')
  return safe.length > HOST_SHOWN ? `${safe.slice(0, 22)}...${safe.slice(-22)}` : safe
}

const relayOf = (x: unknown): Relay | null => {
  if (typeof x !== 'object' || x === null) return null
  const { url, username, credential } = x as Record<string, unknown>
  if (typeof url !== 'string') return null
  const p = parseRelayUrl(url)
  if (!p.ok) return null
  const r: Relay = { url: p.url }
  if (typeof username === 'string' && username && username.length <= SECRET_MAX)
    r.username = username
  if (typeof credential === 'string' && credential && credential.length <= SECRET_MAX)
    r.credential = credential
  return r
}

const cleanList = <T>(xs: unknown, clean: (x: unknown) => T | null, key: (t: T) => string) => {
  const out: T[] = []
  const seen = new Set<string>()
  for (const x of Array.isArray(xs) ? xs : []) {
    const t = clean(x)
    if (t === null || seen.has(key(t))) continue
    seen.add(key(t))
    out.push(t)
  }
  return out
}

// Stored per account: { v: 1, relays, allowed, ask, choice }. Anything unreadable falls back to
// the defaults, field by field.
export const parseRelayPrefs = (raw: string | null): RelayPrefs => {
  let v: unknown
  try {
    v = raw ? (JSON.parse(raw) as unknown) : null
  } catch {
    return defaultRelays()
  }
  if (typeof v !== 'object' || v === null || (v as { v?: unknown }).v !== 1) return defaultRelays()
  const { relays, allowed, ask, choice } = v as Record<string, unknown>
  const list = cleanList(relays, relayOf, r => r.url).slice(0, RELAYS_MAX)
  return {
    relays: list,
    allowed: cleanList(allowed, cleanHost, h => h).slice(0, ALLOWED_MAX),
    ask: ask !== false,
    choice: validChoice(choice, list) ? choice : AUTO,
  }
}

export const relayPrefsValue = (p: RelayPrefs) =>
  JSON.stringify({ v: 1, relays: p.relays, allowed: p.allowed, ask: p.ask, choice: p.choice })

export const relaysKey = (username: string) => `rchat_relays:${username}`

export const validChoice = (choice: unknown, relays: Relay[]): choice is RelayChoice =>
  choice === AUTO || relays.some(r => r.url === choice && isTurn(r.url))

export const ownTurn = (p: RelayPrefs) => p.relays.some(r => isTurn(r.url))

// Manual choices: our TURN relays (a STUN server can't carry traffic).
export const manualRelays = (p: RelayPrefs) => p.relays.filter(r => isTurn(r.url))

export const iceServerOf = (r: Relay): RTCIceServer => {
  const s: RTCIceServer = { urls: r.url }
  if (r.username !== undefined) s.username = r.username
  if (r.credential !== undefined) s.credential = r.credential
  return s
}

const urlsOf = (s: RTCIceServer) => (Array.isArray(s.urls) ? s.urls : [s.urls])

export const hostsOf = (servers: RTCIceServer[], turnOnly = false): string[] => [
  ...new Set(
    servers
      .flatMap(urlsOf)
      .filter(u => !turnOnly || isTurn(u))
      .map(hostOf)
      .filter((h): h is string => h !== null)
  ),
]

export interface IceInputs {
  // The instance's servers, whether or not helpers are on.
  instance: RTCIceServer[]
  helpers: boolean
  // The user turned relay only on.
  relayOnly: boolean
  instanceTurn: boolean
  // A test override of the transport policy.
  forced: RTCIceTransportPolicy | null
}

export type Resolved =
  | {
      ok: true
      config: RTCConfiguration
      // Our TURN hosts the other side may see traffic from, to declare.
      declared: string[]
      // The relay host of a manual choice.
      manual: string | null
    }
  | { ok: false; error: string }

export const GONE = 'That relay is no longer in your list'

// The ICE config for one P2P action. Auto: the instance's servers and ours (when helpers are
// on), relay only when the user asked for it and some TURN relay exists. Manual: that relay
// alone with relayed candidates only, so a broken relay fails instead of silently going direct.
export const resolveIce = (choice: RelayChoice, p: RelayPrefs, x: IceInputs): Resolved => {
  const instanceHosts = new Set(hostsOf(x.instance))
  if (choice !== AUTO) {
    const relay = manualRelays(p).find(r => r.url === choice)
    const host = relay ? hostOf(relay.url) : null
    if (!relay || host === null) return { ok: false, error: GONE }
    return {
      ok: true,
      config: { iceServers: [iceServerOf(relay)], iceTransportPolicy: 'relay' },
      declared: instanceHosts.has(host) ? [] : [host],
      manual: host,
    }
  }
  if (!x.helpers) {
    const config: RTCConfiguration = { iceServers: [] }
    if (x.forced) config.iceTransportPolicy = x.forced
    return { ok: true, config, declared: [], manual: null }
  }
  // Only TURN relays the other side is told about (or the instance's own hosts) are used, so a
  // peer is never connected through a relay of ours it could not be asked about.
  const declared = hostsOf(manualRelays(p).map(iceServerOf), true)
    .filter(h => !instanceHosts.has(h))
    .slice(0, DECLARED_MAX)
  const usable = new Set([...declared, ...instanceHosts])
  const own = p.relays
    .filter(r => !isTurn(r.url) || usable.has(hostOf(r.url) ?? ''))
    .map(iceServerOf)
  const ownTurn = own.some(s => urlsOf(s).some(isTurn))
  const config: RTCConfiguration = {
    iceServers: [
      ...x.instance.map(s => ({ ...s, urls: Array.isArray(s.urls) ? [...s.urls] : s.urls })),
      ...own,
    ],
  }
  const policy = x.forced ?? (x.relayOnly && (x.instanceTurn || ownTurn) ? 'relay' : null)
  if (policy) config.iceTransportPolicy = policy
  return { ok: true, config, declared, manual: null }
}

// With relayed candidates only, another side's relay never sees the user's IP address, so its
// declared relays need no prompt.
export const hidesIp = (r: Resolved) => r.ok && r.config.iceTransportPolicy === 'relay'

// A declared host list as it arrives (absent means none), or null when anything in it is not a
// plain host or there are too many: such a list is refused, never partly used.
export const declaredHosts = (declared: unknown): string[] | null => {
  if (declared === undefined || declared === null) return []
  if (!Array.isArray(declared) || declared.length > DECLARED_MAX) return null
  const hosts = declared.map(cleanHost)
  return hosts.every((h): h is string => h !== null) ? [...new Set(hosts)] : null
}

// What the consent check returns for a list that can't be read.
export const UNREADABLE = ''

// Declared hosts we don't know yet: not the instance's, not ours and not allowed. A list that
// can't be read counts as one unknown relay (UNREADABLE).
export const unknownHosts = (declared: unknown, known: ReadonlySet<string>): string[] => {
  const hosts = declaredHosts(declared)
  return hosts === null ? [UNREADABLE] : hosts.filter(h => !known.has(h))
}

export const knownHosts = (instance: RTCIceServer[], p: RelayPrefs): Set<string> =>
  new Set([...hostsOf(instance), ...hostsOf(p.relays.map(iceServerOf)), ...p.allowed])

export type Decision = 'once' | 'always' | 'deny'

export const allowHost = (p: RelayPrefs, host: string): RelayPrefs =>
  p.allowed.includes(host) || p.allowed.length >= ALLOWED_MAX
    ? p
    : { ...p, allowed: [...p.allowed, host] }

// The whole host, so two hosts never look the same.
export const promptText = (host: string) =>
  `Connect through ${host.replace(/[^a-z0-9.:[\]-]/gi, '')}? That relay can see your IP address unless you use relay only.`

export const DENIED_DOWNLOAD = 'Download canceled: relay not allowed'
export const DENIED_CALL = 'Call canceled: relay not allowed'

export const failedText = (host: string) => `Could not connect through ${displayHost(host)}`

// For the config export: relay URLs and the allow-list, never credentials.
export interface RelaysSection {
  servers: string[]
  allowed: string[]
  ask: boolean
}

export const exportRelays = (p: RelayPrefs): RelaysSection => ({
  servers: p.relays.map(r => r.url),
  allowed: [...p.allowed],
  ask: p.ask,
})

export const cleanRelaysSection = (x: unknown): RelaysSection | undefined => {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return undefined
  const { servers, allowed, ask } = x as Record<string, unknown>
  return {
    servers: cleanList(
      servers,
      u => {
        const p = typeof u === 'string' ? parseRelayUrl(u) : null
        return p?.ok ? p.url : null
      },
      u => u
    ).slice(0, RELAYS_MAX),
    allowed: cleanList(allowed, cleanHost, h => h).slice(0, ALLOWED_MAX),
    ask: ask !== false,
  }
}

// Imported relays are added without credentials (they never travel); existing ones keep theirs.
// An import can turn asking on, never off.
export const mergeRelays = (p: RelayPrefs, s: RelaysSection): RelayPrefs => {
  const have = new Set(p.relays.map(r => r.url))
  const added = s.servers.filter(u => !have.has(u)).map(url => ({ url }))
  return {
    ...p,
    relays: [...p.relays, ...added].slice(0, RELAYS_MAX),
    allowed: [...new Set([...p.allowed, ...s.allowed])].slice(0, ALLOWED_MAX),
    ask: p.ask || s.ask,
  }
}

const hostList = (hosts: string[]) => hosts.map(displayHost).join(', ')

export const relaysText = (s: RelaysSection) => {
  const n = s.servers.length
  const a = s.allowed.length
  const relays = s.servers.map(u => hostOf(u) ?? u)
  return `${n} ${n === 1 ? 'relay' : 'relays'}${n ? ` (${hostList(relays)})` : ''}, ${a} allowed ${
    a === 1 ? 'host' : 'hosts'
  }${a ? ` (${hostList(s.allowed)})` : ''}`
}

// The current account's relays, the consent prompt and the per-action ICE config.
export class RelayBook {
  prefs: RelayPrefs = defaultRelays()
  private key: string | null = null
  private unwatch: (() => void) | null = null
  private listeners = new Set<() => void>()
  private queue: Promise<unknown> = Promise.resolve()
  // Shows the prompt for one host; without a UI every unknown relay is refused.
  prompt: (host: string) => Promise<Decision> = () => Promise.resolve('deny')
  probe: (server: RTCIceServer) => Promise<boolean> = s => probeRelay(s)

  constructor(
    private inputs: () => IceInputs = () => ({
      instance: ice.instanceServers(),
      helpers: ice.helpersOn(),
      relayOnly: ice.relayWanted(),
      instanceTurn: ice.instanceTurn(),
      forced: ice.policy,
    })
  ) {}

  // `key` is the scoped storage key of the account, or null signed out.
  load(key: string | null) {
    this.unwatch?.()
    this.unwatch = null
    this.key = key
    this.prefs = key === null ? defaultRelays() : parseRelayPrefs(device().read(key))
    // Another tab's edit (a removed relay, an always-allowed host) applies here too.
    if (key !== null)
      this.unwatch =
        device().watch?.(key, () => {
          if (this.key !== key) return
          this.prefs = parseRelayPrefs(device().read(key))
          this.changed()
        }) ?? null
    this.changed()
  }

  save(next: RelayPrefs) {
    const choice = validChoice(next.choice, next.relays) ? next.choice : AUTO
    this.prefs = { ...next, choice }
    if (this.key !== null) device().write(this.key, relayPrefsValue(this.prefs))
    this.changed()
  }

  onChange(fn: () => void) {
    this.listeners.add(fn)
    return () => void this.listeners.delete(fn)
  }

  private changed() {
    ice.setOwnTurn(this.prefs.relays.some(r => isTurn(r.url)))
    for (const fn of this.listeners) fn()
  }

  resolve(choice: RelayChoice = this.prefs.choice): Resolved {
    return resolveIce(choice, this.prefs, this.inputs())
  }

  // The config for a P2P action that has no choice of its own: a connection arriving without a
  // file or call we know, or the broker's default.
  autoConfig(): RTCConfiguration {
    const r = this.resolve(AUTO)
    return r.ok ? r.config : { iceServers: [], iceTransportPolicy: 'relay' }
  }

  // Throws when a manual choice is gone or its relay hands out no relayed candidates.
  async check(choice: RelayChoice): Promise<Resolved & { ok: true }> {
    const r = this.resolve(choice)
    if (!r.ok) throw new Error(r.error)
    if (r.manual !== null) {
      const server = r.config.iceServers?.[0]
      if (!server || !(await this.probe(server))) throw new Error(failedText(r.manual))
    }
    return r
  }

  known(): Set<string> {
    return knownHosts(this.inputs().instance, this.prefs)
  }

  // Asks about each declared host that isn't known, one prompt at a time. Returns the host the
  // user denied, or null when everything may be used.
  consent(declared: unknown): Promise<string | null> {
    const run = async (): Promise<string | null> => {
      if (!this.prefs.ask) return null
      for (const host of unknownHosts(declared, this.known())) {
        if (host === UNREADABLE) return host
        if (this.known().has(host)) continue
        const d = await this.prompt(host)
        if (d === 'deny') return host
        if (d === 'always') this.save(allowHost(this.prefs, host))
      }
      return null
    }
    const next = this.queue.then(run, run)
    this.queue = next.catch(() => null)
    return next
  }
}

export const relayBook = new RelayBook()
