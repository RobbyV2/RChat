import { BlockList, isIP } from 'node:net'
import process from 'node:process'
import { clearTimeout, setTimeout } from 'node:timers'
import { PeerServer } from 'peer'
import { WebSocketServer } from 'ws'

// The separate PeerJS signaling server (the stock `peer` package), with a cap on open connections
// per client address next to its global cap. IPv6 addresses count per /64. The Rust server
// serves the same protocol at /peerjs itself unless PEERJS_BUILTIN is off. With
// PEERJS_SETTINGS_URL (the instance's /api/v1/settings) it follows the instance's P2P switches.

export const setting = (env, name, fallback) => {
  const raw = env[name]
  if (raw === undefined || raw === '') return fallback
  const n = Number(raw)
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`${name} must be a whole number`)
  return n
}

const filled = raw => String(raw ?? '').trim() !== ''
const off = raw =>
  ['off', 'false', 'no', '0'].includes(
    String(raw ?? '')
      .trim()
      .toLowerCase()
  )

// Whether the settings ask for this server: the built-in signaling is off, or the instance or
// its web build names a PeerJS port or address of its own. `--wanted` exits 0 when they do.
export const wanted = env =>
  off(env.PEERJS_BUILTIN) ||
  [
    env.PEERJS_PORT,
    env.PUBLIC_PEERJS_URL,
    env.NEXT_PUBLIC_PEERJS_HOST,
    env.NEXT_PUBLIC_PEERJS_PORT,
  ].some(filled)

export const proxyList = text => {
  const list = new BlockList()
  for (const part of (text ?? '').split(',')) {
    const item = part.trim()
    if (!item) continue
    const [addr, bits] = item.split('/')
    const family = isIP(addr)
    if (family === 0) throw new Error(`TRUSTED_PROXIES: ${item} is not an address`)
    const type = family === 4 ? 'ipv4' : 'ipv6'
    if (bits === undefined) list.addAddress(addr, type)
    else list.addSubnet(addr, Number(bits), type)
  }
  return list
}

const unmapped = addr => addr.replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i, '$1')

// The bucket of an address: an IPv4 address, or the /64 of an IPv6 one.
export const bucketOf = raw => {
  const addr = unmapped(raw)
  if (isIP(addr) !== 6) return addr
  const [head, tail = ''] = addr.toLowerCase().split('::')
  const left = head ? head.split(':') : []
  const right = tail ? tail.split(':') : []
  const groups = addr.includes('::')
    ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right]
    : left
  return `${groups
    .slice(0, 4)
    .map(g => g.replace(/^0+(?=.)/, ''))
    .join(':')}::/64`
}

// The client's address: the peer's own, or the last X-Forwarded-For entry when the peer is a
// trusted proxy (or all peers are).
export const clientOf = (req, trusted, trustAll) => {
  const peer = unmapped(req.socket.remoteAddress ?? '')
  const type = isIP(peer) === 6 ? 'ipv6' : 'ipv4'
  if (!trustAll && !(isIP(peer) && trusted.check(peer, type))) return peer
  const forwarded = String(req.headers['x-forwarded-for'] ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .pop()
  return forwarded && isIP(unmapped(forwarded)) ? unmapped(forwarded) : peer
}

export const perAddress = max => {
  const open = new Map()
  const room = key => max === 0 || (open.get(key) ?? 0) < max
  return {
    room,
    take(key) {
      if (!room(key)) return false
      open.set(key, (open.get(key) ?? 0) + 1)
      return true
    },
    give(key) {
      const n = (open.get(key) ?? 0) - 1
      if (n > 0) open.set(key, n)
      else open.delete(key)
    },
    size: () => open.size,
  }
}

const OFF = 'P2P is turned off on this instance'

// Whether the instance's settings leave signaling on: P2P or P2P attachments.
export const serves = settings => settings?.p2p !== false || settings?.p2p_attachments !== false

// Puts `serving` in front of every plain request to `server`: while it says no, each one gets
// the 404 the instance's own /peerjs gives.
export const gate = (server, serving) => {
  const handlers = server.listeners('request')
  server.removeAllListeners('request')
  server.on('request', (req, res) => {
    if (serving()) {
      for (const handle of handlers) handle.call(server, req, res)
      return
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end(OFF)
  })
}

// Asks `url` for the instance's settings every `every` ms and tells `apply` whether signaling
// serves. An answer that can't be read keeps the last one.
export const follow = (url, every, apply) => {
  let stopped = false
  let timer = null
  const ask = async () => {
    try {
      const res = await globalThis.fetch(url, { signal: globalThis.AbortSignal.timeout(10_000) })
      if (res.ok && !stopped) apply(serves(await res.json()))
    } catch {
      // Keeps the last answer.
    }
    if (!stopped) timer = setTimeout(ask, every)
  }
  void ask()
  return () => {
    stopped = true
    clearTimeout(timer)
  }
}

export const start = (env = process.env, { every = 30_000 } = {}) => {
  const port = setting(env, 'PEERJS_PORT', 9001)
  const settingsUrl = filled(env.PEERJS_SETTINGS_URL)
    ? String(env.PEERJS_SETTINGS_URL).trim()
    : null
  let on = true
  let sockets = null
  const apply = serving => {
    on = serving
    if (!on) for (const socket of sockets?.clients ?? []) socket.close(1008, OFF)
  }
  const trusted = proxyList(env.TRUSTED_PROXIES)
  const trustAll = env.TRUST_PROXY === 'true'
  const held = perAddress(setting(env, 'PEERJS_PEERS_PER_IP', 50))
  const keyOf = req => bucketOf(clientOf(req, trusted, trustAll))
  return new Promise(resolve => {
    PeerServer(
      {
        port,
        path: '/peerjs',
        concurrent_limit: setting(env, 'PEERJS_CONCURRENT_LIMIT', 5000),
        createWebSocketServer: options => {
          const wss = new WebSocketServer({
            ...options,
            verifyClient: (info, done) => {
              if (!on) return done(false, 404, OFF)
              return held.room(keyOf(info.req))
                ? done(true)
                : done(false, 429, 'Too many connections')
            },
          })
          sockets = wss
          // Counted once open, so an upgrade that fails halfway never holds a slot.
          wss.on('connection', (socket, req) => {
            if (!on) return socket.close(1008, OFF)
            const key = keyOf(req)
            if (!held.take(key)) return socket.close(1008, 'Too many connections')
            socket.once('close', () => held.give(key))
          })
          return wss
        },
      },
      server => {
        gate(server, () => on)
        const stop = settingsUrl ? follow(settingsUrl, every, apply) : () => {}
        server.once('close', stop)
        resolve({ server, held, stop, following: settingsUrl !== null })
      }
    )
  })
}

if (import.meta.main) {
  if (process.argv.includes('--wanted')) process.exit(wanted(process.env) ? 0 : 1)
  const { server } = await start()
  const addr = server.address()
  process.stdout.write(`PeerJS server on port ${typeof addr === 'object' ? addr?.port : addr}\n`)
}
