import { afterEach, describe, expect, test } from 'bun:test'
import type Peer from 'peerjs'
import { endpointsFrom, InstanceConnection } from '../instances'
import { RelayBook } from '../relays'
import { TransportError } from '../p2p/node'
import { PeerTransport } from '../p2p/transport'

// A PeerJS server that takes the WebSocket but never says OPEN (a proxy that doesn't pass the
// upgrade on, a blocked or stalled socket) must not leave P2P on "Connecting" for good.

class SilentPeer {
  destroyed = false
  options: Record<string, unknown> = {}
  _handleMessage() {}
  on() {
    return this
  }
  off() {
    return this
  }
  destroy() {
    this.destroyed = true
  }
}

const g = globalThis as { window?: unknown }
const real = g.window
afterEach(() => {
  g.window = real
})

describe('PeerJS transport', () => {
  test('each listener uses its owner’s signaling endpoint, ICE and subscriptions', async () => {
    const peers: OpenPeer[] = []
    class OpenPeer extends SilentPeer {
      constructor(
        _id: string,
        public options: Record<string, unknown>
      ) {
        super()
        peers.push(this)
      }
      on(event?: string, fn?: () => void) {
        if (event === 'open') queueMicrotask(() => fn?.())
        return this
      }
    }
    const owner = (host: string) => {
      const watchers = new Set<() => void>()
      const relays = new RelayBook(() => ({
        instance: [{ urls: `stun:${host}` }],
        helpers: true,
        relayOnly: false,
        instanceTurn: false,
        forced: null,
      }))
      return {
        conn: new InstanceConnection(endpointsFrom(`https://${host}`, null)),
        relays,
        ice: {
          onChange(fn: () => void) {
            watchers.add(fn)
            return () => void watchers.delete(fn)
          },
        },
        watchers,
      }
    }
    const a = owner('one.example')
    const b = owner('two.example')
    const listen = (account: typeof a) =>
      new PeerTransport({}, OpenPeer as unknown as typeof Peer, 1000, account).listen(
        'rcp-test',
        () => {},
        () => {}
      )
    const left = await listen(a)
    const right = await listen(b)
    try {
      expect(peers.map(p => p.options.host)).toEqual(['one.example', 'two.example'])
      expect(peers.map(p => p.options.config)).toEqual([
        a.relays.autoConfig(),
        b.relays.autoConfig(),
      ])
      expect(a.relays.autoConfig()).not.toEqual(b.relays.autoConfig())
      left.close()
      expect(a.watchers.size).toBe(0)
      expect(b.watchers.size).toBe(1)
      expect(peers[1].destroyed).toBe(false)
    } finally {
      left.close()
      right.close()
    }
    expect(b.watchers.size).toBe(0)
  })

  test('listening gives up when the signaling server never opens', async () => {
    g.window = { location: { hostname: 'chat.example', protocol: 'https:' } }
    const made: SilentPeer[] = []
    class Made extends SilentPeer {
      constructor() {
        super()
        made.push(this)
      }
    }
    const t = new PeerTransport({}, Made as unknown as typeof Peer, 50)
    const err = await t
      .listen(
        'rcp-x',
        () => {},
        () => {}
      )
      .catch((e: unknown) => e)
    expect(err instanceof TransportError).toBe(true)
    expect((err as TransportError).kind).toBe('timeout')
    expect(made.length).toBe(1)
    expect(made[0].destroyed).toBe(true)
  })

  // PeerJS says so when there is no RTCPeerConnection (Firefox with media.peerconnection.enabled
  // off, Tor Browser): no server can help that.
  test('a browser without WebRTC is told apart from an unreachable server', async () => {
    g.window = { location: { hostname: 'chat.example', protocol: 'https:' } }
    class NoWebRtc {
      destroyed = false
      options: Record<string, unknown> = {}
      _handleMessage() {}
      on(event: string, fn: (e: unknown) => void) {
        if (event === 'error')
          setTimeout(() => fn({ type: 'browser-incompatible', message: 'no WebRTC' }), 0)
        return this
      }
      destroy() {
        this.destroyed = true
      }
    }
    const t = new PeerTransport({}, NoWebRtc as unknown as typeof Peer, 5000)
    const err = await t
      .listen(
        'rcp-x',
        () => {},
        () => {}
      )
      .catch((e: unknown) => e)
    expect(err instanceof TransportError).toBe(true)
    expect((err as TransportError).kind).toBe('unsupported')
  })
})
