import Peer, { type DataConnection } from 'peerjs'
import { randomHex } from '../bytes'
import { home } from '../instances'
import { ice } from '../ice'
import { declaredHosts, hidesIp, relayBook, unknownHosts, type RelayBook } from '../relays'
import { TransportError, type Listener, type OfferGuard, type Transport } from './node'
import type { Pipe } from './session'

// The PeerJS side of P2P messaging: our own Peer on the instance's PeerServer (never the one P2P
// files use), configured only from the shared ICE seam. Every connection is a reliable binary
// data channel labeled `rcp1`, plus `rcp1b` for attachments (opened on demand, so file transfers
// never hold up chat); what crosses them is already encrypted.

export const LABEL = 'rcp1'
export const BULK_LABEL = 'rcp1b'
// A bulk sender waits once this much is queued in the data channel.
const LOW_MARK = 256 * 1024
const DIAL_MS = 15_000
// Offers held while the user decides about a relay host they don't know, in all and per peer,
// and the proofs of such offers checked a minute.
export const HELD_MAX = 4
export const HELD_PER_PEER = 1
export const CHECKS_PER_MIN = 30

type Hooked = Peer & { _handleMessage?: (msg: unknown) => void }

type Offer = {
  type?: unknown
  src?: unknown
  payload?: { label?: unknown; metadata?: unknown }
}

const field = (meta: unknown, key: string): unknown =>
  typeof meta === 'object' && meta !== null ? (meta as Record<string, unknown>)[key] : undefined

// Without the hook every offer would be answered at once: then connections use relays only
// while the user wants to be asked, so no relay of theirs sees this side's address.
export const answerConfig = (hooked: boolean, book: RelayBook = relayBook): RTCConfiguration => {
  const config = book.autoConfig()
  return hooked || !book.prefs.ask ? config : { ...config, iceTransportPolicy: 'relay' }
}

// An offer through relay hosts we don't know is answered only once the user allowed them, and
// asked about only for a signed device of someone we'd talk to (node.ts OfferGuard); anything
// else is dropped and the other side's dial times out.
export class OfferGate {
  private held = new Map<string, number>()
  private heldAll = 0
  private checks: number[] = []

  constructor(
    private book: RelayBook,
    private guard: () => OfferGuard | null,
    private now: () => number = () => Date.now()
  ) {}

  offer(src: string, meta: unknown, answer: () => void) {
    const declared = field(meta, 'relays')
    const ask =
      this.book.prefs.ask &&
      !hidesIp(this.book.resolve()) &&
      unknownHosts(declared, this.book.known()).length > 0
    if (!ask) return answer()
    const hosts = declaredHosts(declared)
    const guard = this.guard()
    if (hosts === null || !guard || !this.mayCheck()) return
    const who = guard.sender(src, field(meta, 'ask'), hosts)
    if (who === null || this.heldAll >= HELD_MAX || (this.held.get(who) ?? 0) >= HELD_PER_PEER)
      return
    this.hold(who, 1)
    const done = () => this.hold(who, -1)
    void this.book.consent(hosts, who).then(denied => {
      done()
      if (denied === null) answer()
    }, done)
  }

  private hold(who: string, n: number) {
    this.heldAll += n
    const left = (this.held.get(who) ?? 0) + n
    if (left > 0) this.held.set(who, left)
    else this.held.delete(who)
  }

  private mayCheck() {
    const now = this.now()
    this.checks = this.checks.filter(t => now - t < 60_000)
    if (this.checks.length >= CHECKS_PER_MIN) return false
    this.checks.push(now)
    return true
  }
}

const channelOf = (conn: DataConnection) =>
  (conn as { dataChannel?: RTCDataChannel }).dataChannel ?? null

// PeerJS keeps its own queue in front of the channel.
const queuedIn = (conn: DataConnection) =>
  (channelOf(conn)?.bufferedAmount ?? 0) +
  ((conn as { bufferSize?: number }).bufferSize ?? 0) * 16384

const drainOf = (conn: DataConnection) => () =>
  new Promise<void>(resolve => {
    const ch = channelOf(conn)
    if (!ch || queuedIn(conn) <= LOW_MARK || ch.readyState !== 'open') return resolve()
    ch.bufferedAmountLowThreshold = LOW_MARK
    const done = () => {
      clearInterval(poll)
      ch.removeEventListener('bufferedamountlow', check)
      ch.removeEventListener('close', done)
      resolve()
    }
    const check = () => {
      if (queuedIn(conn) <= LOW_MARK || ch.readyState !== 'open') done()
    }
    // PeerJS's own queue drains on a timer, so the event alone isn't enough.
    const poll = setInterval(check, 50)
    ch.addEventListener('bufferedamountlow', check)
    ch.addEventListener('close', done)
  })

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
    ...(conn.label === BULK_LABEL ? { kind: 'bulk' as const } : {}),
    drain: drainOf(conn),
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
  private unwatch: (() => void)[] = []
  private offers: OfferGuard | null = null
  private gate = new OfferGate(relayBook, () => this.offers)

  guard(g: OfferGuard) {
    this.offers = g
  }

  listen(id: string, onPipe: (pipe: Pipe) => void, onLost: () => void): Promise<Listener> {
    this.close()
    return new Promise((resolve, reject) => {
      // A fresh token each time, so an old registration never blocks the new one.
      const peer = new Peer(id, {
        ...home.peer(),
        token: randomHex(8),
        config: answerConfig(false),
      })
      this.peer = peer
      const hooked = this.hookOffers(peer)
      if (!hooked) console.error('P2P offers cannot be checked: connecting through relays only')
      const refresh = () => {
        if (!peer.destroyed) peer.options.config = answerConfig(hooked)
      }
      refresh()
      this.unwatch = [ice.onChange(refresh), relayBook.onChange(refresh)]
      let opened = false
      peer.on('open', () => {
        opened = true
        resolve({ close: () => this.close(peer) })
      })
      peer.on('connection', conn => {
        if ((conn.label !== LABEL && conn.label !== BULK_LABEL) || conn.serialization !== 'raw')
          return conn.close()
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

  // A connection through relay hosts we don't know waits for the user's answer (OfferGate),
  // as P2P files do. False when PeerJS has no method to hook.
  private hookOffers(peer: Peer) {
    const p = peer as Hooked
    const handle = p._handleMessage
    if (typeof handle !== 'function') return false
    p._handleMessage = (msg: unknown) => {
      const m = msg as Offer | null
      const label = m?.payload?.label
      if (m?.type !== 'OFFER' || (label !== LABEL && label !== BULK_LABEL))
        return handle.call(peer, msg)
      this.gate.offer(String(m.src), m.payload?.metadata, () => {
        if (!peer.destroyed) handle.call(peer, msg)
      })
    }
    return true
  }

  dial(from: string, to: string, kind?: 'bulk'): Promise<Pipe> {
    const peer = this.peer
    if (!peer || peer.destroyed) return Promise.reject(new TransportError('network'))
    const plan = relayBook.resolve()
    const relays = plan.ok ? plan.declared : []
    const ask = relays.length ? this.offers?.vouch(from, to, relays) : null
    const conn = peer.connect(to, {
      label: kind === 'bulk' ? BULK_LABEL : LABEL,
      reliable: true,
      serialization: 'raw',
      metadata: { relays, ...(ask ? { ask } : {}) },
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
