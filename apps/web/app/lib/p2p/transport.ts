import Peer, { type DataConnection } from 'peerjs'
import { randomHex } from '../bytes'
import { home } from '../instances'
import { ice } from '../ice'
import { hidesIp, relayBook, unknownHosts } from '../relays'
import { TransportError, type Listener, type Transport } from './node'
import type { Pipe } from './session'

// The PeerJS side of P2P messaging: our own Peer on the instance's PeerServer (never the one P2P
// files use), configured only from the shared ICE seam. Every connection is a reliable binary
// data channel labeled `rcp1`; what crosses it is already encrypted by the session.

export const LABEL = 'rcp1'
const DIAL_MS = 15_000
// Offers held while the user decides about a relay host they don't know.
const HELD_MAX = 4

type Hooked = Peer & { _handleMessage?: (msg: unknown) => void }

type Offer = {
  type?: unknown
  payload?: { label?: unknown; metadata?: unknown }
}

const relaysOf = (meta: unknown): unknown =>
  typeof meta === 'object' && meta !== null ? (meta as { relays?: unknown }).relays : undefined

const pipeOf = (conn: DataConnection): Pipe => {
  const dataFns: ((d: Uint8Array) => void)[] = []
  const closeFns: (() => void)[] = []
  let closed = false
  const shut = () => {
    if (closed) return
    closed = true
    for (const fn of closeFns) fn()
  }
  conn.on('data', data => {
    if (closed) return
    if (data instanceof ArrayBuffer) dataFns.forEach(f => f(new Uint8Array(data)))
    else if (ArrayBuffer.isView(data))
      dataFns.forEach(f => f(new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice()))
  })
  conn.on('close', shut)
  conn.on('error', shut)
  return {
    remote: conn.peer,
    send: data => {
      if (closed) throw new Error('closed')
      void conn.send(data)
    },
    onData: fn => void dataFns.push(fn),
    onClose: fn => void closeFns.push(fn),
    close: () => {
      conn.close()
      shut()
    },
  }
}

export class PeerTransport implements Transport {
  private peer: Peer | null = null
  private held = 0
  private unwatch: (() => void)[] = []

  listen(id: string, onPipe: (pipe: Pipe) => void, onLost: () => void): Promise<Listener> {
    this.close()
    return new Promise((resolve, reject) => {
      // A fresh token each time, so an old registration never blocks the new one.
      const peer = new Peer(id, {
        ...home.peer(),
        token: randomHex(8),
        config: relayBook.autoConfig(),
      })
      this.peer = peer
      const refresh = () => {
        if (!peer.destroyed) peer.options.config = relayBook.autoConfig()
      }
      this.unwatch = [ice.onChange(refresh), relayBook.onChange(refresh)]
      this.hookOffers(peer)
      let opened = false
      peer.on('open', () => {
        opened = true
        resolve({ close: () => this.close(peer) })
      })
      peer.on('connection', conn => {
        if (conn.label !== LABEL || conn.serialization !== 'raw') return conn.close()
        conn.on('open', () => onPipe(pipeOf(conn)))
      })
      peer.on('disconnected', () => {
        if (peer.destroyed || this.peer !== peer) return
        // The signaling socket dropped; sessions already up keep running.
        try {
          peer.reconnect()
        } catch {
          this.close(peer)
          onLost()
        }
      })
      peer.on('error', err => {
        const type = (err as { type?: string }).type
        if (type === 'peer-unavailable') return
        if (!opened) {
          this.close(peer)
          reject(new TransportError(type === 'unavailable-id' ? 'unavailable-id' : 'network'))
        } else if (
          type === 'unavailable-id' ||
          type === 'server-error' ||
          type === 'network' ||
          type === 'socket-error' ||
          type === 'socket-closed'
        ) {
          // The node registers again after a while.
          this.close(peer)
          onLost()
        }
      })
    })
  }

  // A contact's connection through relay hosts we don't know waits for the user's answer
  // (relays.ts), as P2P files do; refused offers are dropped and the dial times out.
  private hookOffers(peer: Peer) {
    const p = peer as Hooked
    const handle = p._handleMessage
    if (typeof handle !== 'function') return
    p._handleMessage = (msg: unknown) => {
      const m = msg as Offer | null
      if (m?.type !== 'OFFER' || m.payload?.label !== LABEL) return handle.call(peer, msg)
      const declared = relaysOf(m.payload?.metadata)
      const ask =
        relayBook.prefs.ask &&
        !hidesIp(relayBook.resolve()) &&
        unknownHosts(declared, relayBook.known()).length > 0
      if (!ask) return handle.call(peer, msg)
      if (this.held >= HELD_MAX) return
      this.held += 1
      void relayBook
        .consent(declared)
        .then(denied => {
          if (denied === null && !peer.destroyed) handle.call(peer, msg)
        })
        .finally(() => {
          this.held -= 1
        })
    }
  }

  dial(_from: string, to: string): Promise<Pipe> {
    const peer = this.peer
    if (!peer || peer.destroyed) return Promise.reject(new TransportError('network'))
    const plan = relayBook.resolve()
    const conn = peer.connect(to, {
      label: LABEL,
      reliable: true,
      serialization: 'raw',
      metadata: { relays: plan.ok ? plan.declared : [] },
    })
    return new Promise((resolve, reject) => {
      let done = false
      const finish = (err: TransportError | null) => {
        if (done) return
        done = true
        clearTimeout(timer)
        peer.off('error', onError)
        if (err) {
          conn.close()
          reject(err)
        } else resolve(pipeOf(conn))
      }
      const onError = (err: { type?: string; message?: string }) => {
        if (err.type === 'peer-unavailable' && String(err.message).endsWith(to))
          finish(new TransportError('peer-unavailable'))
      }
      const timer = setTimeout(() => finish(new TransportError('timeout')), DIAL_MS)
      peer.on('error', onError)
      conn.on('open', () => finish(null))
      conn.on('close', () => finish(new TransportError('peer-unavailable')))
      conn.on('error', () => finish(new TransportError('network')))
    })
  }

  close(which: Peer | null = this.peer) {
    if (!which) return
    if (which === this.peer) {
      this.peer = null
      for (const u of this.unwatch) u()
      this.unwatch = []
    }
    if (!which.destroyed) which.destroy()
  }
}
