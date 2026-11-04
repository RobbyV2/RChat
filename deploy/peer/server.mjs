import { BlockList, isIP } from 'node:net'
import process from 'node:process'
import { PeerServer } from 'peer'
import { WebSocketServer } from 'ws'

// The PeerJS signaling server (the stock `peer` package), with a cap on open connections per
// client address next to its global cap. IPv6 addresses count per /64.

export const setting = (env, name, fallback) => {
  const raw = env[name]
  if (raw === undefined || raw === '') return fallback
  const n = Number(raw)
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`${name} must be a whole number`)
  return n
}

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

export const start = (env = process.env) => {
  const port = setting(env, 'PEERJS_PORT', 9001)
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
            verifyClient: (info, done) =>
              held.room(keyOf(info.req)) ? done(true) : done(false, 429, 'Too many connections'),
          })
          // Counted once open, so an upgrade that fails halfway never holds a slot.
          wss.on('connection', (socket, req) => {
            const key = keyOf(req)
            if (!held.take(key)) return socket.close(1008, 'Too many connections')
            socket.once('close', () => held.give(key))
          })
          return wss
        },
      },
      server => resolve({ server, held })
    )
  })
}

if (import.meta.main) {
  const { server } = await start()
  const addr = server.address()
  process.stdout.write(`PeerJS server on port ${typeof addr === 'object' ? addr?.port : addr}\n`)
}
