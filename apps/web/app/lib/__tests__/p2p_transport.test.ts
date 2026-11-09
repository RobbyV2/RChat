import { afterEach, describe, expect, test } from 'bun:test'
import type Peer from 'peerjs'
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
  test('listening gives up when the signaling server never opens', async () => {
    g.window = { location: { hostname: 'chat.example', protocol: 'https:' } }
    const made: SilentPeer[] = []
    class Made extends SilentPeer {
      constructor() {
        super()
        made.push(this)
      }
    }
    const t = new PeerTransport(Made as unknown as typeof Peer, 50)
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
    const t = new PeerTransport(NoWebRtc as unknown as typeof Peer, 5000)
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
