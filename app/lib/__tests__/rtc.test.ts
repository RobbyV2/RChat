import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { JoinAborted, RtcManager } from '../rtc'
import type { RtcPayload, VoiceMsg } from '../types'

let ids = 0

class FakeTrack {
  id = `t${++ids}`
  enabled = true
  contentHint = ''
  stopped = false
  onended: (() => void) | null = null
  constructor(public kind: 'audio' | 'video') {}
  stop() {
    this.stopped = true
  }
  // A captured video reads as a tab, whose audio is always shared.
  getSettings() {
    return this.kind === 'video' ? { displaySurface: 'browser' } : {}
  }
}

class FakeStream {
  id = `s${++ids}`
  private tracks: FakeTrack[]
  constructor(tracks: FakeTrack[] = []) {
    this.tracks = [...tracks]
  }
  getTracks() {
    return [...this.tracks]
  }
  getAudioTracks() {
    return this.tracks.filter(t => t.kind === 'audio')
  }
  getVideoTracks() {
    return this.tracks.filter(t => t.kind === 'video')
  }
  addTrack(t: FakeTrack) {
    if (!this.tracks.includes(t)) this.tracks.push(t)
  }
  removeTrack(t: FakeTrack) {
    this.tracks = this.tracks.filter(x => x !== t)
  }
}

class FakeSender {
  streamId: string | null = null
  constructor(public track: FakeTrack | null) {}
  async replaceTrack(track: FakeTrack | null) {
    this.track = track
  }
  setStreams(...streams: FakeStream[]) {
    this.streamId = streams[0]?.id ?? null
  }
}

class FakeTransceiver {
  mid: string | null = null
  // has been negotiated with a sending direction (addTrack won't reuse it)
  sentOnce = false
  fired = false
  sender: FakeSender
  receiver: { track: FakeTrack }
  constructor(
    public kind: 'audio' | 'video',
    track: FakeTrack | null,
    public direction: RTCRtpTransceiverDirection,
    public byTrack: boolean
  ) {
    this.sender = new FakeSender(track)
    this.receiver = { track: new FakeTrack(kind) }
  }
}

interface Sdp {
  ufrag: string
  m: { mid: string; kind: 'audio' | 'video'; msid: string | null; send: boolean }[]
}

const sends = (d: RTCRtpTransceiverDirection) => d === 'sendrecv' || d === 'sendonly'

// Models what the negotiation code relies on: the signaling state machine
// (with implicit rollback of a pending offer, which is counted), transceiver
// association, negotiationneeded after changes while stable, a candidate
// after every setLocalDescription, and "connected" once both descriptions
// are set and a candidate for the current remote ICE credentials arrived.
// Track events carry the sender's stream (msid) like a browser's, and addTrack
// reuses a transceiver that never sent, so legacy clients can be modelled.
class FakePC {
  static all: FakePC[] = []
  signalingState: RTCSignalingState = 'stable'
  connectionState: RTCPeerConnectionState = 'new'
  localDescription: { type: RTCSdpType; sdp: string } | null = null
  remoteDescription: { type: RTCSdpType; sdp: string } | null = null
  onnegotiationneeded: (() => void) | null = null
  onicecandidate:
    ((e: { candidate: { toJSON: () => RTCIceCandidateInit } | null }) => void) | null = null
  ontrack: ((e: unknown) => void) | null = null
  onconnectionstatechange: (() => void) | null = null
  transceivers: FakeTransceiver[] = []
  rollbacks = 0
  offers = 0
  ufrag = `u${++ids}`
  private mids = 0
  private pendingMids: FakeTransceiver[] = []
  private heard = false

  constructor() {
    FakePC.all.push(this)
  }

  addTransceiver(
    trackOrKind: FakeTrack | 'audio' | 'video',
    init: { direction?: RTCRtpTransceiverDirection; streams?: FakeStream[] } = {}
  ) {
    const track = typeof trackOrKind === 'string' ? null : trackOrKind
    const kind = typeof trackOrKind === 'string' ? trackOrKind : trackOrKind.kind
    const t = new FakeTransceiver(kind, track, init.direction ?? 'sendrecv', false)
    t.sender.setStreams(...(init.streams ?? []))
    this.transceivers.push(t)
    this.needed()
    return t
  }

  addTrack(track: FakeTrack, stream?: FakeStream) {
    const reuse = this.transceivers.find(
      t => t.kind === track.kind && t.mid !== null && !t.sender.track && !t.sentOnce
    )
    const t = reuse ?? new FakeTransceiver(track.kind, track, 'sendrecv', true)
    if (reuse) {
      reuse.sender.track = track
      reuse.direction = reuse.direction === 'inactive' ? 'sendonly' : 'sendrecv'
      this.dirty = true
    } else this.transceivers.push(t)
    t.sender.setStreams(...(stream ? [stream] : []))
    this.needed()
    return t.sender
  }

  private dirty = false
  private remoteStreams = new Map<string, FakeStream>()

  getTransceivers() {
    return [...this.transceivers]
  }

  private needed() {
    setTimeout(() => {
      const unassociated = this.transceivers.some(t => t.mid === null)
      if (this.signalingState === 'stable' && (unassociated || this.dirty))
        this.onnegotiationneeded?.()
    }, 0)
  }

  private sdp(): string {
    const m = this.transceivers.map(t => {
      if (t.mid === null) {
        while (this.transceivers.some(x => x.mid === String(this.mids))) this.mids++
        t.mid = String(this.mids++)
        this.pendingMids.push(t)
      }
      return this.mline(t, t.mid)
    })
    return JSON.stringify({ ufrag: this.ufrag, m } satisfies Sdp)
  }

  async createOffer(opts: { iceRestart?: boolean } = {}) {
    if (opts.iceRestart) this.ufrag = `u${++ids}`
    return { type: 'offer' as const, sdp: this.peekSdp() }
  }

  private peekSdp() {
    const m = this.transceivers.map((t, i) => this.mline(t, t.mid ?? `n${i}`))
    return JSON.stringify({ ufrag: this.ufrag, m } satisfies Sdp)
  }

  private mline(t: FakeTransceiver, mid: string) {
    return { mid, kind: t.kind, msid: t.sender.streamId, send: sends(t.direction) }
  }

  private undoOffer() {
    for (const t of this.pendingMids) t.mid = null
    this.pendingMids = []
    this.rollbacks += 1
    this.signalingState = 'stable'
    this.localDescription = null
  }

  async setLocalDescription(desc?: { type: RTCSdpType; sdp?: string }) {
    await tick()
    if (this.signalingState === 'closed') throw new Error('closed')
    if (desc?.type === 'rollback') return this.undoOffer()
    const answering = this.signalingState === 'have-remote-offer'
    if (answering) {
      const offered = JSON.parse(this.remoteDescription?.sdp ?? '{"m":[]}') as Sdp
      const m = offered.m.flatMap(({ mid }) => {
        const t = this.transceivers.find(x => x.mid === mid)
        return t ? [this.mline(t, mid)] : []
      })
      this.localDescription = { type: 'answer', sdp: JSON.stringify({ ufrag: this.ufrag, m }) }
      this.signalingState = 'stable'
    } else {
      this.pendingMids = []
      this.localDescription = { type: 'offer', sdp: this.sdp() }
      this.signalingState = 'have-local-offer'
      this.offers += 1
    }
    const ufrag = this.ufrag
    setTimeout(() => {
      if (this.signalingState !== 'closed')
        this.onicecandidate?.({
          candidate: {
            toJSON: () => ({ candidate: 'host', sdpMid: '0', usernameFragment: ufrag }),
          },
        })
    }, 0)
    if (answering) this.settled()
  }

  async setRemoteDescription(desc: { type: RTCSdpType; sdp: string }) {
    await tick()
    if (this.signalingState === 'closed') throw new Error('closed')
    const sdp = JSON.parse(desc.sdp) as Sdp
    if (desc.type === 'offer') {
      if (this.signalingState === 'have-local-offer') this.undoOffer()
      if (this.signalingState !== 'stable') throw new Error(`offer in ${this.signalingState}`)
      for (const { mid, kind } of sdp.m) {
        if (this.transceivers.some(t => t.mid === mid)) continue
        const reuse = this.transceivers.find(t => t.mid === null && t.byTrack && t.kind === kind)
        if (reuse) reuse.mid = mid
        else {
          const t = new FakeTransceiver(kind, null, 'recvonly', false)
          t.mid = mid
          this.transceivers.push(t)
        }
      }
      this.signalingState = 'have-remote-offer'
      this.tracks(sdp)
    } else {
      if (this.signalingState !== 'have-local-offer') throw new Error('answer without offer')
      this.pendingMids = []
      this.signalingState = 'stable'
      this.tracks(sdp)
    }
    if (this.remoteDescription && JSON.parse(this.remoteDescription.sdp).ufrag !== sdp.ufrag)
      this.heard = false
    this.remoteDescription = desc
    if (desc.type === 'answer') this.settled()
  }

  private tracks(sdp: Sdp) {
    for (const { mid, msid, send } of sdp.m) {
      const t = this.transceivers.find(x => x.mid === mid)
      if (!t || !send || t.fired) continue
      t.fired = true
      let streams: FakeStream[] = []
      if (msid) {
        const stream = this.remoteStreams.get(msid) ?? new FakeStream()
        this.remoteStreams.set(msid, stream)
        stream.addTrack(t.receiver.track)
        streams = [stream]
      }
      this.ontrack?.({ track: t.receiver.track, streams, transceiver: t })
    }
  }

  private settled() {
    this.dirty = false
    for (const t of this.transceivers) if (sends(t.direction)) t.sentOnce = true
    this.check()
    this.needed()
  }

  async addIceCandidate(c: RTCIceCandidateInit) {
    await tick()
    if (!this.remoteDescription) throw new Error('no remote description')
    const remote = JSON.parse(this.remoteDescription.sdp) as Sdp
    if (c.usernameFragment !== remote.ufrag) throw new Error('unknown ufrag')
    this.heard = true
    this.check()
  }

  private check() {
    if (this.signalingState === 'stable' && this.remoteDescription && this.heard)
      this.setState('connected')
  }

  setState(state: RTCPeerConnectionState) {
    if (this.connectionState === state || this.connectionState === 'closed') return
    this.connectionState = state
    this.onconnectionstatechange?.()
  }

  close() {
    this.signalingState = 'closed'
    this.connectionState = 'closed'
  }
}

const tick = () => new Promise(r => setTimeout(r, 0))
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

interface Wire {
  from: string
  to: string
  channel_id: number | null
  dm_id: number | null
  payload: RtcPayload
}

let wire: Wire[] = []
let sent: Wire[] = []
let errors: unknown[][] = []
let tamper: (w: Wire) => Wire | null = w => w
const managers = new Map<string, RtcManager>()
const quiet = { onSpeak: () => {}, watch: () => {}, unwatch: () => {}, clear: () => {} }

const g = globalThis as Record<string, unknown>
const saved = {
  RTCPeerConnection: g.RTCPeerConnection,
  MediaStream: g.MediaStream,
  navigator: g.navigator,
}
const realError = console.error

function manager(name: string, opts: { connectTimeoutMs?: number; graceMs?: number } = {}) {
  const m = new RtcManager({
    detector: { ...quiet },
    connectTimeoutMs: opts.connectTimeoutMs ?? 60_000,
    graceMs: opts.graceMs ?? 60_000,
    restartDebounceMs: 10,
    send: (msg: VoiceMsg) => {
      if (msg.type !== 'rtc_signal') return true
      const w = {
        from: name,
        to: msg.to,
        channel_id: msg.channel_id,
        dm_id: msg.dm_id,
        payload: msg.payload,
      }
      sent.push(w)
      wire.push(w)
      return true
    },
  })
  managers.set(name, m)
  return m
}

async function pump() {
  while (wire.length) {
    const next = tamper(wire.shift() as Wire)
    if (!next) continue
    const to = managers.get(next.to)
    await to?.onSignal(next.from, next.payload, { channelId: next.channel_id, dmId: next.dm_id })
  }
}

async function settle(ms = 30) {
  const end = Date.now() + ms
  do {
    await pump()
    await sleep(1)
  } while (wire.length || Date.now() < end)
}

const pcOf = (m: RtcManager, user: string) =>
  (m as unknown as { peers: Map<string, { pc: FakePC }> }).peers.get(user)?.pc
const offersFrom = (name: string) =>
  sent.filter(w => w.from === name && w.payload.description?.type === 'offer')
const rollbacks = () => FakePC.all.reduce((n, pc) => n + pc.rollbacks, 0)

beforeEach(() => {
  ids = 0
  wire = []
  sent = []
  errors = []
  tamper = w => w
  managers.clear()
  FakePC.all = []
  g.RTCPeerConnection = FakePC
  g.MediaStream = FakeStream
  g.navigator = {
    mediaDevices: {
      getUserMedia: async (c: { audio?: boolean; video?: boolean }) =>
        new FakeStream([new FakeTrack(c.video ? 'video' : 'audio')]),
      getDisplayMedia: async () => new FakeStream([new FakeTrack('video')]),
    },
  }
  console.error = (...args: unknown[]) => {
    errors.push(args)
  }
})

afterEach(() => {
  for (const m of managers.values()) m.leave()
  g.RTCPeerConnection = saved.RTCPeerConnection
  g.MediaStream = saved.MediaStream
  g.navigator = saved.navigator
  console.error = realError
})

// alice < bob, so alice is the polite side.
async function room(opts: { alice?: number; bob?: number } = {}) {
  const alice = manager('alice', { connectTimeoutMs: opts.alice, graceMs: opts.alice })
  const bob = manager('bob', { connectTimeoutMs: opts.bob, graceMs: opts.bob })
  await alice.join('alice', { channelId: 5 })
  await bob.join('bob', { channelId: 5 })
  return { alice, bob }
}

const connected = (m: RtcManager, user: string) => pcOf(m, user)?.connectionState === 'connected'

describe('first negotiation', () => {
  test('two peers meeting at once: one offer, from the impolite side, and no rollback', async () => {
    const { alice, bob } = await room()
    alice.sync(['alice', 'bob'])
    bob.sync(['alice', 'bob'])
    await settle()
    expect(rollbacks()).toBe(0)
    expect(offersFrom('bob')).toHaveLength(1)
    expect(offersFrom('alice')).toHaveLength(0)
    expect(connected(alice, 'bob') && connected(bob, 'alice')).toBe(true)
    expect(errors).toEqual([])
  })

  test('the first offer carries every slot, so camera toggles never renegotiate', async () => {
    const { alice, bob } = await room()
    alice.sync(['alice', 'bob'])
    bob.sync(['alice', 'bob'])
    await settle()
    const sdp = JSON.parse(offersFrom('bob')[0].payload.description?.sdp ?? '{}') as Sdp
    expect(sdp.m.map(m => m.kind)).toEqual(['audio', 'audio', 'video', 'video'])
    await Promise.all([alice.camera(true), bob.camera(true)])
    await settle()
    await Promise.all([alice.camera(false), bob.camera(false)])
    await Promise.all([alice.camera(true), bob.share(true)])
    await settle()
    expect(offersFrom('bob')).toHaveLength(1)
    expect(offersFrom('alice')).toHaveLength(0)
    expect(rollbacks()).toBe(0)
    expect(alice.peer('bob')?.camOn).toBe(false)
    expect(alice.peer('bob')?.screenOn).toBe(true)
    expect(bob.peer('alice')?.camOn).toBe(true)
    const shown = (alice.peer('bob')?.stream as unknown as FakeStream).getTracks()
    expect(shown.map(t => t.kind)).toEqual(['audio', 'video'])
    expect(pcOf(bob, 'alice')?.transceivers[2].sender.track).toBe(null)
    expect(
      pcOf(bob, 'alice')?.transceivers[3].sender.track === (bob.screen?.video as unknown)
    ).toBe(true)
    expect(pcOf(alice, 'bob')?.transceivers[2].sender.track === alice.videoTrack).toBe(true)
  })

  test('candidates that arrive before the offer are held, then added', async () => {
    const { alice, bob } = await room()
    bob.sync(['alice', 'bob'])
    await sleep(5)
    // swap bob's offer and candidate on the wire
    const offer = wire.findIndex(w => w.payload.description)
    const cand = wire.findIndex(w => w.payload.candidate)
    expect(offer >= 0 && cand > offer).toBe(true)
    ;[wire[offer], wire[cand]] = [wire[cand], wire[offer]]
    alice.sync(['alice', 'bob'])
    await settle()
    expect(connected(alice, 'bob') && connected(bob, 'alice')).toBe(true)
    expect(errors).toEqual([])
  })

  test('a signal for another channel is ignored', async () => {
    const { alice } = await room()
    await alice.onSignal('bob', { candidate: { candidate: 'x' } }, { channelId: 6 })
    await alice.onSignal('bob', { description: { type: 'offer', sdp: '{}' } }, { dmId: 5 })
    expect(FakePC.all).toHaveLength(0)
  })

  test('a status update creates no peer and is applied once the peer exists', async () => {
    const { alice } = await room()
    await alice.onSignal('bob', { muted: true, sid: 'b1' }, { channelId: 5 })
    expect(FakePC.all).toHaveLength(0)
    alice.sync(['alice', 'bob'])
    expect(alice.peer('bob')?.muted).toBe(true)
  })
})

describe('closed peers', () => {
  test('a closed peer sends nothing, and its timers are cleared', async () => {
    const { alice, bob } = await room({ alice: 20, bob: 20 })
    alice.sync(['alice', 'bob'])
    bob.sync(['alice', 'bob'])
    tamper = () => null
    await settle(5)
    const old = pcOf(bob, 'alice') as FakePC
    bob.sync(['bob'])
    const before = sent.length
    old.onicecandidate?.({ candidate: { toJSON: () => ({ candidate: 'late' }) } })
    old.onnegotiationneeded?.()
    await sleep(80)
    expect(sent.slice(before).some(w => w.from === 'bob')).toBe(false)
  })

  test('leaving stops every recovery timer', async () => {
    const { alice, bob } = await room({ alice: 20, bob: 20 })
    tamper = () => null
    alice.sync(['alice', 'bob'])
    bob.sync(['alice', 'bob'])
    await settle(5)
    alice.leave()
    bob.leave()
    const before = sent.length
    await sleep(80)
    expect(sent.length).toBe(before)
  })
})

describe('recovery', () => {
  test('a lost first offer is re-sent with an ICE restart', async () => {
    const { alice, bob } = await room({ alice: 40, bob: 40 })
    let dropped = 0
    tamper = w => (w.from === 'bob' && w.payload.description && dropped++ === 0 ? null : w)
    alice.sync(['alice', 'bob'])
    bob.sync(['alice', 'bob'])
    await settle(20)
    expect(connected(alice, 'bob')).toBe(false)
    await settle(150)
    expect(dropped >= 1).toBe(true)
    expect(connected(alice, 'bob') && connected(bob, 'alice')).toBe(true)
    expect(offersFrom('alice')).toHaveLength(0)
    expect(rollbacks()).toBe(0)
  })

  test('the polite side asks for a restart instead of offering', async () => {
    const { alice, bob } = await room({ alice: 30 })
    let dropped = 0
    tamper = w => (w.from === 'bob' && w.payload.description && dropped++ === 0 ? null : w)
    alice.sync(['alice', 'bob'])
    bob.sync(['alice', 'bob'])
    await settle(150)
    expect(sent.some(w => w.from === 'alice' && w.payload.restart === true)).toBe(true)
    expect(offersFrom('alice')).toHaveLength(0)
    expect(offersFrom('bob')).toHaveLength(2)
    expect(connected(alice, 'bob') && connected(bob, 'alice')).toBe(true)
  })

  test('a failed connection restarts ICE after the grace period', async () => {
    const { alice, bob } = await room({ alice: 30, bob: 30 })
    alice.sync(['alice', 'bob'])
    bob.sync(['alice', 'bob'])
    await settle()
    expect(connected(alice, 'bob')).toBe(true)
    const pa = pcOf(alice, 'bob') as FakePC
    const pb = pcOf(bob, 'alice') as FakePC
    pa.setState('failed')
    pb.setState('failed')
    await settle(10)
    expect(offersFrom('bob')).toHaveLength(1)
    await settle(150)
    expect(offersFrom('bob').length >= 2).toBe(true)
    expect(offersFrom('alice')).toHaveLength(0)
    expect(pa.connectionState).toBe('connected')
    expect(pb.connectionState).toBe('connected')
    expect(pcOf(alice, 'bob') === pa).toBe(true)
  })

  test('a brief disconnect that heals by itself does not restart', async () => {
    const { alice, bob } = await room({ alice: 40, bob: 40 })
    alice.sync(['alice', 'bob'])
    bob.sync(['alice', 'bob'])
    await settle()
    const pb = pcOf(bob, 'alice') as FakePC
    pb.setState('disconnected')
    await sleep(10)
    pb.setState('connected')
    await settle(100)
    expect(offersFrom('bob')).toHaveLength(1)
  })
})

describe('sessions', () => {
  test('signals for an earlier session of ours are dropped after a quick switch back', async () => {
    const { alice, bob } = await room()
    alice.sync(['alice', 'bob'])
    bob.sync(['alice', 'bob'])
    await settle()
    bob.setMuted(true)
    const stale = sent.at(-1) as Wire
    expect(stale.payload.rsid === sent.find(w => w.from === 'alice')?.payload.sid).toBe(true)
    await alice.join('alice', { channelId: 6 })
    await alice.join('alice', { channelId: 5 })
    alice.sync(['alice', 'bob'])
    await settle(5)
    const fresh = pcOf(alice, 'bob') as FakePC
    expect(fresh.signalingState).toBe('stable')
    const { sid, rsid } = stale.payload
    const scope = { channelId: 5 }
    await alice.onSignal('bob', stale.payload, scope)
    await alice.onSignal('bob', { candidate: { candidate: 'old' }, sid, rsid }, scope)
    const answer = { type: 'answer' as const, sdp: JSON.stringify({ ufrag: 'old', m: [] }) }
    await alice.onSignal('bob', { description: answer, sid, rsid }, scope)
    expect(alice.peer('bob')?.muted).toBe(false)
    expect(fresh.remoteDescription).toBeNull()
    expect(errors).toEqual([])
  })

  test('a reload that keeps its room slot replaces the peer on the other side', async () => {
    const { alice, bob } = await room()
    alice.sync(['alice', 'bob'])
    bob.sync(['alice', 'bob'])
    await settle()
    const old = pcOf(alice, 'bob') as FakePC
    // bob reloads; alice sees no change in the room
    bob.leave()
    const reloaded = manager('bob')
    await reloaded.join('bob', { channelId: 5 })
    reloaded.sync(['alice', 'bob'])
    await settle()
    expect(old.connectionState).toBe('closed')
    expect(connected(alice, 'bob') && connected(reloaded, 'alice')).toBe(true)
    expect(rollbacks()).toBe(0)
  })

  test('the polite side reloading is picked up through its restart request', async () => {
    const { alice, bob } = await room({ alice: 30 })
    alice.sync(['alice', 'bob'])
    bob.sync(['alice', 'bob'])
    await settle()
    const old = pcOf(bob, 'alice') as FakePC
    alice.leave()
    const reloaded = manager('alice', { connectTimeoutMs: 30, graceMs: 30 })
    await reloaded.join('alice', { channelId: 5 })
    reloaded.sync(['alice', 'bob'])
    await settle(150)
    expect(old.connectionState).toBe('closed')
    expect(connected(reloaded, 'bob') && connected(bob, 'alice')).toBe(true)
    expect(offersFrom('alice')).toHaveLength(0)
  })

  test('a legacy peer without session ids still connects', async () => {
    const { alice, bob } = await room()
    tamper = w => {
      if (w.from !== 'bob') return w
      const { sid: _sid, rsid: _rsid, ...payload } = w.payload
      return { ...w, payload }
    }
    alice.sync(['alice', 'bob'])
    bob.sync(['alice', 'bob'])
    await settle()
    expect(connected(alice, 'bob') && connected(bob, 'alice')).toBe(true)
    await bob.camera(true)
    await settle()
    expect(alice.peer('bob')?.camOn).toBe(true)
    expect(offersFrom('bob')).toHaveLength(1)
  })
})

describe('joins', () => {
  test('a join superseded while waiting for the mic stops its tracks and aborts', async () => {
    const m = manager('alice')
    const first = m.join('alice', { channelId: 1 })
    const second = m.join('alice', { channelId: 2 })
    const outcome = await first.then(
      () => 'joined',
      (e: unknown) => (e instanceof JoinAborted ? 'aborted' : 'failed')
    )
    await second
    expect(outcome).toBe('aborted')
    expect(m.active()).toBe(true)
    expect((m.local as unknown as FakeStream).getTracks()[0].stopped).toBe(false)
    m.sync(['alice', 'zed'])
    await sleep(5)
    expect(sent.every(w => w.channel_id === 2)).toBe(true)
  })
})

describe('screen share', () => {
  const display = (audio: boolean) => {
    const nav = g.navigator as { mediaDevices: Record<string, unknown> }
    nav.mediaDevices.getDisplayMedia = async () =>
      new FakeStream([new FakeTrack('video'), ...(audio ? [new FakeTrack('audio')] : [])])
  }

  async function pair() {
    const { alice, bob } = await room()
    alice.sync(['alice', 'bob'])
    bob.sync(['alice', 'bob'])
    await settle()
    return { alice, bob }
  }

  test('a share with the camera on goes out on its own slots, with no renegotiation', async () => {
    display(true)
    const { alice, bob } = await pair()
    await alice.camera(true)
    await alice.share(true)
    await settle()
    const pc = pcOf(alice, 'bob') as FakePC
    expect(pc.transceivers[0].sender.track === (alice.screen?.audio as unknown)).toBe(true)
    expect(pc.transceivers[2].sender.track === alice.videoTrack).toBe(true)
    expect(pc.transceivers[3].sender.track === (alice.screen?.video as unknown)).toBe(true)
    expect(alice.screen?.video.contentHint).toBe('detail')
    const seen = bob.peer('alice')
    expect(seen?.camOn).toBe(true)
    expect(seen?.screenOn).toBe(true)
    expect(typeof seen?.shareId).toBe('string')
    const screen = (seen?.screen as unknown as FakeStream).getTracks().map(t => t.kind)
    expect(screen).toEqual(['video', 'audio'])
    expect(bob.remoteStreams().map(([k]) => k)).toEqual(['alice', 'alice:screen'])
    expect(offersFrom('bob')).toHaveLength(1)
    expect(offersFrom('alice')).toHaveLength(0)
    expect(rollbacks()).toBe(0)
  })

  test('the browser ending the capture stops the share and tells the peers', async () => {
    display(false)
    const { alice, bob } = await pair()
    await bob.share(true)
    await settle()
    const first = alice.peer('bob')?.shareId
    expect(alice.peer('bob')?.screenOn).toBe(true)
    const track = bob.screen?.video as unknown as FakeTrack
    track.onended?.()
    await settle()
    expect(bob.sharing).toBe(false)
    expect(bob.screenStream).toBe(null)
    expect(alice.peer('bob')?.screenOn).toBe(false)
    expect(alice.peer('bob')?.shareId).toBe(null)
    expect(pcOf(bob, 'alice')?.transceivers[3].sender.track).toBe(null)
    await bob.share(true)
    await settle()
    expect(alice.peer('bob')?.shareId === first).toBe(false)
    expect(offersFrom('bob')).toHaveLength(1)
  })

  test('someone joining while a share is on learns about it and gets the track', async () => {
    display(false)
    const { alice, bob } = await room()
    await bob.share(true)
    alice.sync(['alice', 'bob'])
    bob.sync(['alice', 'bob'])
    await settle()
    expect(alice.peer('bob')?.screenOn).toBe(true)
    expect(
      pcOf(bob, 'alice')?.transceivers[3].sender.track === (bob.screen?.video as unknown)
    ).toBe(true)
    await alice.share(true)
    await settle()
    expect(bob.peer('alice')?.screenOn).toBe(true)
    expect(
      pcOf(alice, 'bob')?.transceivers[3].sender.track === (alice.screen?.video as unknown)
    ).toBe(true)
  })

  test('leaving stops the capture, and a share that resolves after leaving is dropped', async () => {
    display(true)
    const { alice } = await pair()
    await alice.share(true)
    const { video, audio } = alice.screen as unknown as { video: FakeTrack; audio: FakeTrack }
    alice.leave()
    expect(video.stopped && audio.stopped).toBe(true)
    expect(alice.sharing).toBe(false)
    await alice.join('alice', { channelId: 5 })
    const pending = alice.share(true)
    alice.leave()
    await pending
    expect(alice.sharing).toBe(false)
  })

  test('a closed picker is not an error', async () => {
    const nav = g.navigator as { mediaDevices: Record<string, unknown> }
    nav.mediaDevices.getDisplayMedia = async () => {
      throw Object.assign(new Error('denied'), { name: 'NotAllowedError' })
    }
    const { alice } = await pair()
    await alice.share(true)
    expect(alice.sharing).toBe(false)
  })

  test('a legacy peer sees a share on the camera slot while the camera is off', async () => {
    display(false)
    const { alice, bob } = await room()
    tamper = w => {
      if (w.from !== 'bob') return w
      const { sid: _sid, rsid: _rsid, ...payload } = w.payload
      return { ...w, payload }
    }
    alice.sync(['alice', 'bob'])
    bob.sync(['alice', 'bob'])
    await settle()
    const cam = () => pcOf(alice, 'bob')?.transceivers[2].sender.track
    const screen = () => pcOf(alice, 'bob')?.transceivers[3].sender.track
    await alice.share(true)
    await settle()
    expect(cam() === (alice.screen?.video as unknown)).toBe(true)
    expect(screen()).toBe(null)
    expect(bob.peer('alice')?.camOn).toBe(true)
    await alice.camera(true)
    await settle()
    expect(cam() === alice.videoTrack).toBe(true)
    expect(screen()).toBe(null)
    await alice.camera(false)
    await settle()
    expect(cam() === (alice.screen?.video as unknown)).toBe(true)
    expect(bob.peer('alice')?.camOn).toBe(true)
    await alice.share(false)
    await settle()
    expect(cam()).toBe(null)
    expect(bob.peer('alice')?.camOn).toBe(false)
    expect(offersFrom('alice')).toHaveLength(0)
  })

  test('a peer with session ids never gets the screen on the camera slot', async () => {
    display(false)
    const { alice, bob } = await pair()
    await alice.share(true)
    await settle()
    expect(pcOf(alice, 'bob')?.transceivers[2].sender.track).toBe(null)
    expect(bob.peer('alice')?.camOn).toBe(false)
    expect(bob.peer('alice')?.screenOn).toBe(true)
  })

  test('a share status from someone without a peer yet is held', async () => {
    const { alice } = await room()
    await alice.onSignal('bob', { screen: true, sid: 'b1' }, { channelId: 5 })
    await alice.onSignal('bob', { muted: true, sid: 'b1' }, { channelId: 5 })
    alice.sync(['alice', 'bob'])
    expect(alice.peer('bob')?.screenOn).toBe(true)
    expect(alice.peer('bob')?.muted).toBe(true)
  })

  test('a peer that turns out legacy after the share started gets it on the camera slot', async () => {
    display(true)
    // alice is polite towards bob and impolite towards aaron.
    const { alice, bob } = await room()
    const aaron = manager('aaron')
    await aaron.join('aaron', { channelId: 5 })
    await alice.share(true)
    tamper = w => {
      if (w.from !== 'bob' && w.from !== 'aaron') return w
      const { sid: _sid, rsid: _rsid, ...payload } = w.payload
      return { ...w, payload }
    }
    for (const m of [alice, bob, aaron]) m.sync(['alice', 'bob', 'aaron'])
    await settle()
    for (const [name, m] of [
      ['bob', bob],
      ['aaron', aaron],
    ] as const) {
      const slots = (pcOf(alice, name) as FakePC).transceivers
      const at = (kind: 'video', n: number) => slots.filter(t => t.kind === kind)[n]?.sender.track
      expect(connected(alice, name)).toBe(true)
      expect(at('video', 0) === (alice.screen?.video as unknown)).toBe(true)
      expect(at('video', 1) ?? null).toBe(null)
      expect(m.peer('alice')?.camOn).toBe(true)
    }
    expect(offersFrom('alice')).toHaveLength(1)
  })

  test('one peer failing to take the share does not keep it from the others', async () => {
    display(false)
    const { alice, bob } = await room()
    const carol = manager('carol')
    await carol.join('carol', { channelId: 5 })
    for (const m of [alice, bob, carol]) m.sync(['alice', 'bob', 'carol'])
    await settle()
    const broken = (pcOf(alice, 'bob') as FakePC).transceivers[3].sender
    broken.replaceTrack = async () => {
      throw new Error('closed')
    }
    await alice.share(true)
    await settle()
    expect(alice.sharing).toBe(true)
    expect(
      pcOf(alice, 'carol')?.transceivers[3].sender.track === (alice.screen?.video as unknown)
    ).toBe(true)
    expect(carol.peer('alice')?.screenOn).toBe(true)
    expect(bob.peer('alice')?.screenOn).toBe(true)
    expect(errors.some(e => e[0] === 'rtc share')).toBe(true)
  })

  test('one peer failing to take the camera does not keep it from the others', async () => {
    const { alice, bob } = await room()
    const carol = manager('carol')
    await carol.join('carol', { channelId: 5 })
    for (const m of [alice, bob, carol]) m.sync(['alice', 'bob', 'carol'])
    await settle()
    const broken = (pcOf(alice, 'bob') as FakePC).transceivers[2].sender
    broken.replaceTrack = async () => {
      throw new Error('closed')
    }
    await alice.camera(true)
    await settle()
    expect(pcOf(alice, 'carol')?.transceivers[2].sender.track === alice.videoTrack).toBe(true)
    expect(carol.peer('alice')?.camOn).toBe(true)
    expect(errors.some(e => e[0] === 'rtc camera')).toBe(true)
  })
})
