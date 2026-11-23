import { dbName } from '../p2p/db'
import {
  defaultEndpoints,
  readLocal,
  remoteAllowed,
  writeLocal,
  type InstanceConnection,
} from '../instances'
import { hostOf } from '../qualified'

// Reconstruct origins which can produce the historical authority. WHATWG URL
// canonicalizes IP spellings, case, credentials-free ports and IDNs. The old
// host normalizer additionally erased a DNS trailing dot and the scheme.
function uniqueRemote(
  conn: InstanceConnection,
  defaultFlag: boolean,
  pinnedDefault: string | null
) {
  const url = new URL(conn.origin)
  const candidates = new Set<string>()
  let home: string
  try {
    home = defaultEndpoints().origin
  } catch {
    return false
  }
  if (defaultFlag) {
    const defaultHost = hostOf(pinnedDefault ?? (conn.isDefault ? conn.origin : home))
    if (!defaultHost || defaultHost === conn.host) return false
  }
  if (hostOf(home) === conn.host) candidates.add(home)
  for (const scheme of ['https:', 'http:']) {
    for (const hostname of [
      url.hostname.replace(/\.$/, ''),
      url.hostname.replace(/\.$/, '') + '.',
    ]) {
      try {
        const origin = new URL(`${scheme}//${hostname}${url.port ? ':' + url.port : ''}`).origin
        // A development client can reach every permitted remote, including private HTTP.
        if (hostOf(origin) === conn.host && remoteAllowed(origin, 'https://localhost'))
          candidates.add(origin)
      } catch {
        // A dot after an IPv6 literal is not a valid host.
      }
    }
  }
  return candidates.size === 1 && candidates.has(url.origin)
}

// A missing slot or ambiguous legacy flag gets a new origin-qualified namespace.
// Persist that choice on first lookup. A manifest has its own binding (null slot),
// so changes to individual enable flags never move the list of saved identities.
type Namespace = 'origin' | 'default' | 'host'
function namespace(
  conn: InstanceConnection,
  username: string,
  slot: string | null,
  legacyKey: string
): Namespace {
  const origin = new URL(conn.origin).origin
  const binding = 'rchat_peer_binding:' + JSON.stringify([origin, username, slot])
  const historical = 'rchat_peer_owner:' + JSON.stringify([conn.host, username, slot])
  const defaultBinding = 'rchat_peer_default_owner:' + JSON.stringify([username, slot])
  const pinned = readLocal(binding)
  if (pinned === 'origin') return 'origin'
  const owner = readLocal(historical)
  if (pinned === 'host' && owner === origin) return pinned
  if (pinned === 'default' && owner === origin && readLocal(defaultBinding) === origin)
    return pinned
  const enabled = (key: string) => {
    const raw = readLocal(key)
    if (raw === null) return false
    try {
      const value = JSON.parse(raw)
      return slot === null ? Array.isArray(value) : value?.v === 1 && value.on === true
    } catch {
      return false
    }
  }
  const own = enabled(legacyKey)
  const remote = enabled(legacyKey + '@' + conn.host)
  const mode =
    readLocal(legacyKey + '@' + origin) !== null
      ? 'origin'
      : conn.isDefault && own && !remote
        ? 'default'
        : remote && uniqueRemote(conn, own, readLocal(defaultBinding))
          ? 'host'
          : 'origin'
  const reserve = (key: string) => {
    const existing = readLocal(key)
    if (existing !== null) return existing === origin
    return writeLocal(key, origin) && readLocal(key) === origin
  }
  if (
    mode !== 'origin' &&
    reserve(historical) &&
    (mode !== 'default' || reserve(defaultBinding)) &&
    writeLocal(binding, mode) &&
    readLocal(binding) === mode
  )
    return mode
  writeLocal(binding, 'origin')
  return 'origin'
}

export function peerStorage(conn: InstanceConnection, username: string | null, local = 'main') {
  const origin = new URL(conn.origin).origin
  const slot = local === 'main' ? '' : `~${local}`
  const mode = username
    ? namespace(conn, username, local, `rchat_p2p:${username}${slot}`)
    : 'origin'
  const host = mode === 'origin' ? origin : conn.host
  const suffix = mode === 'default' ? '' : '@' + host
  return {
    host,
    db: username ? dbName(host, username) + slot : null,
    scoped: (key: string) => key + slot + suffix,
  }
}

function manifestKey(conn: InstanceConnection, username: string) {
  const key = `rchat_p2p_identities:${username}`
  const mode = namespace(conn, username, null, key)
  return mode === 'default'
    ? key
    : key + '@' + (mode === 'host' ? conn.host : new URL(conn.origin).origin)
}

export class KeyScope {
  constructor(
    private readonly conn: InstanceConnection,
    private readonly username: () => string | null
  ) {}

  db(local: string = 'main') {
    return peerStorage(this.conn, this.username(), local).db
  }

  local(base: string) {
    const name = this.username()
    if (base === 'rchat_p2p_identities' && name) return manifestKey(this.conn, name)
    return this.conn.scoped(name ? `${base}:${name}` : base)
  }
}
