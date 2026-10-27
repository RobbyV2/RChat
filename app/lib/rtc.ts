import { home } from './instances'
import { SpeakingDetector } from './vad'
import { mediaError } from './rules'
import { linkQuality, type LinkQuality } from './voice_layout'
import {
  CandidateQueue,
  CONNECT_TIMEOUT_MS,
  descriptionAction,
  mayOffer,
  newSid,
  RECOVER_GRACE_MS,
  RESTART_DEBOUNCE_MS,
  sameScope,
  Serial,
  sidAction,
  SLOT_KIND,
  slotLayout,
  SLOTS,
  type RemoteSid,
  type SignalScope,
  type Slot,
} from './negotiation'
import type { RtcPayload, VoiceMsg } from './types'

export type RtcTarget =
  { channelId: number; dmId?: undefined } | { dmId: number; channelId?: undefined }

// Thrown by join() when a later join or leave started while it waited for the
// microphone; the caller has nothing left to do.
export class JoinAborted extends Error {
  constructor() {
    super('Voice join superseded')
  }
}

type Timer = ReturnType<typeof setTimeout>

interface Peer {
  pc: RTCPeerConnection
  target: RtcTarget
  polite: boolean
  remoteSid: RemoteSid
  makingOffer: boolean
  ignoreOffer: boolean
  negotiated: boolean
  offeredAt: number
  steps: Serial
  candidates: CandidateQueue<RTCIceCandidateInit>
  // The transceivers we send each slot on.
  slots: Partial<Record<Slot, RTCRtpTransceiver>>
  send: (payload: RtcPayload) => void
  watchdog: Timer | null
  grace: Timer | null
  stream: MediaStream | null
  heard: MediaStreamTrack | null
  muted: boolean
  camOn: boolean
  speaking: boolean
}

interface Detector {
  onSpeak: (id: string, speaking: boolean) => void
  watch(id: string, stream: MediaStream): void
  unwatch(id: string): void
  clear(): void
}

export interface RtcOptions {
  send?: (msg: VoiceMsg) => unknown
  detector?: Detector
  connectTimeoutMs?: number
  graceMs?: number
  restartDebounceMs?: number
}

type Status = Pick<RtcPayload, 'muted' | 'cam'>

export class RtcManager {
  private peers = new Map<string, Peer>()
  private me: string | null = null
  private target: RtcTarget | null = null
  private sid = ''
  private gen = 0
  private retired = new Map<string, Set<string>>()
  private early = new Map<string, Status>()
  local: MediaStream | null = null
  videoTrack: MediaStreamTrack | null = null
  sharing = false
  muted = false
  localSpeaking = false
  private detector: Detector
  private sendVoice: (msg: VoiceMsg) => unknown
  private connectTimeoutMs: number
  private graceMs: number
  private restartDebounceMs: number
  onChange: () => void = () => {}

  constructor(opts: RtcOptions = {}) {
    this.sendVoice = opts.send ?? (msg => home.ws.sendVoice(msg))
    this.detector = opts.detector ?? new SpeakingDetector()
    this.connectTimeoutMs = opts.connectTimeoutMs ?? CONNECT_TIMEOUT_MS
    this.graceMs = opts.graceMs ?? RECOVER_GRACE_MS
    this.restartDebounceMs = opts.restartDebounceMs ?? RESTART_DEBOUNCE_MS
    this.detector.onSpeak = (id, speaking) => {
      if (id === this.me) this.localSpeaking = speaking
      else {
        const peer = this.peers.get(id)
        if (peer) peer.speaking = speaking
      }
      this.onChange()
    }
  }

  active(): boolean {
    return this.target !== null
  }

  isSpeaking(user: string): boolean {
    return user === this.me ? this.localSpeaking : (this.peers.get(user)?.speaking ?? false)
  }

  async join(me: string, target: RtcTarget, muted = false) {
    this.leave()
    const gen = this.gen
    const local = await navigator.mediaDevices.getUserMedia({ audio: true }).catch((e: unknown) => {
      throw mediaError(e, 'microphone', target.channelId !== undefined ? 'join voice' : 'call')
    })
    if (gen !== this.gen) {
      for (const track of local.getTracks()) track.stop()
      throw new JoinAborted()
    }
    for (const track of local.getAudioTracks()) track.enabled = !muted
    this.muted = muted
    this.me = me
    this.sid = newSid()
    this.target = target
    this.local = local
    this.detector.watch(me, local)
    this.onChange()
  }

  leave() {
    this.gen += 1
    this.detector.clear()
    for (const peer of this.peers.values()) this.close(peer)
    this.peers.clear()
    this.retired.clear()
    this.early.clear()
    for (const track of this.local?.getTracks() ?? []) track.stop()
    this.local = null
    this.videoTrack = null
    this.me = null
    this.target = null
    this.muted = false
    this.sharing = false
    this.localSpeaking = false
    this.onChange()
  }

  sync(users: string[]) {
    if (!this.target) return
    const wanted = new Set(users.filter(u => u !== this.me))
    for (const [user, peer] of this.peers) {
      if (!wanted.has(user)) this.retire(user, peer)
    }
    for (const user of wanted) {
      if (!this.peers.has(user)) this.connect(user, this.target)
    }
    this.onChange()
  }

  peer(user: string): { stream: MediaStream | null; muted: boolean; camOn: boolean } | undefined {
    const p = this.peers.get(user)
    return p ? { stream: p.stream, muted: p.muted, camOn: p.camOn } : undefined
  }

  remoteStreams(): [string, MediaStream][] {
    return [...this.peers].flatMap(([user, p]): [string, MediaStream][] =>
      p.stream ? [[user, p.stream]] : []
    )
  }

  quality(): LinkQuality {
    return linkQuality([...this.peers.values()].map(p => p.pc.connectionState))
  }

  setMuted(muted: boolean) {
    this.muted = muted
    const track = this.local?.getAudioTracks()[0]
    if (track) track.enabled = !muted
    for (const peer of this.peers.values()) peer.send({ muted })
    this.onChange()
  }

  async camera(on: boolean) {
    if (!on) return this.setVideo(null, false)
    const media = await navigator.mediaDevices.getUserMedia({ video: true }).catch((e: unknown) => {
      throw mediaError(e, 'camera', 'turn on video')
    })
    await this.setVideo(media.getVideoTracks()[0] ?? null, false)
  }

  async share(on: boolean) {
    if (!on) return this.setVideo(null, false)
    const media = await navigator.mediaDevices.getDisplayMedia({ video: true })
    await this.setVideo(media.getVideoTracks()[0] ?? null, true)
  }

  // Camera and screen share both go out on the camera slot for now, which
  // every client, old ones included, shows. Toggling only swaps the track.
  private async setVideo(track: MediaStreamTrack | null, sharing: boolean) {
    const old = this.videoTrack
    if (old) {
      old.stop()
      this.local?.removeTrack(old)
    }
    this.videoTrack = track
    this.sharing = track !== null && sharing
    if (track) {
      this.local?.addTrack(track)
      track.onended = () => {
        if (this.videoTrack === track) void this.setVideo(null, false)
      }
    }
    for (const peer of this.peers.values()) await this.placeVideo(peer)
    for (const peer of this.peers.values()) peer.send({ cam: track !== null })
    this.onChange()
  }

  private async placeVideo(peer: Peer) {
    const track = this.videoTrack
    const slot = peer.slots.cam
    if (slot) {
      if (slot.sender.track !== track) await slot.sender.replaceTrack(track)
      return
    }
    // A legacy peer negotiated without a camera slot: add one, which
    // renegotiates once.
    if (!track || !this.local || !peer.negotiated) return
    const sender = peer.pc.addTrack(track, this.local)
    peer.slots.cam = peer.pc.getTransceivers().find(t => t.sender === sender)
  }

  private trackFor(slot: Slot): MediaStreamTrack | null {
    if (slot === 'mic') return this.local?.getAudioTracks()[0] ?? null
    if (slot === 'cam') return this.videoTrack
    return null
  }

  private signal(to: string, payload: RtcPayload, target: RtcTarget) {
    if (target !== this.target) return
    this.sendVoice({
      type: 'rtc_signal',
      to,
      channel_id: target.channelId ?? null,
      dm_id: target.dmId ?? null,
      payload,
    })
  }

  // A peer is current while it is the one registered for its user in the
  // session it was created for; closed or replaced peers must stay silent.
  private current(user: string, peer: Peer): boolean {
    return this.peers.get(user) === peer && peer.target === this.target
  }

  private failed(user: string, peer: Peer, what: string) {
    return (e: unknown) => {
      if (this.current(user, peer)) console.error(what, e)
    }
  }

  private close(peer: Peer) {
    if (peer.watchdog) clearTimeout(peer.watchdog)
    if (peer.grace) clearTimeout(peer.grace)
    peer.watchdog = null
    peer.grace = null
    peer.pc.close()
  }

  // Closes a peer and remembers its remote session, so signals still in
  // flight from it are dropped instead of reviving a connection.
  private retire(user: string, peer: Peer) {
    if (typeof peer.remoteSid === 'string') {
      const old = this.retired.get(user) ?? new Set<string>()
      old.add(peer.remoteSid)
      this.retired.set(user, old)
    }
    this.detector.unwatch(user)
    this.close(peer)
    if (this.peers.get(user) === peer) this.peers.delete(user)
  }

  private connect(user: string, target: RtcTarget): Peer {
    const pc = new RTCPeerConnection({ iceServers: [] })
    const peer: Peer = {
      pc,
      target,
      polite: (this.me ?? '') < user,
      remoteSid: undefined,
      makingOffer: false,
      ignoreOffer: false,
      negotiated: false,
      offeredAt: 0,
      steps: new Serial(),
      candidates: new CandidateQueue(),
      slots: {},
      send: () => {},
      watchdog: null,
      grace: null,
      stream: null,
      heard: null,
      muted: false,
      camOn: false,
      speaking: false,
    }
    peer.send = payload => {
      if (!this.current(user, peer)) return
      const rsid = typeof peer.remoteSid === 'string' ? { rsid: peer.remoteSid } : {}
      this.signal(user, { ...payload, sid: this.sid, ...rsid }, target)
    }
    // The impolite side makes the first offer with every slot in it, so
    // turning the camera or a screen share on and off later never
    // renegotiates. The polite side takes the slots over from that offer.
    if (!peer.polite) {
      const local = this.local
      for (const slot of SLOTS) {
        const streams = local && slot !== 'screenAudio' ? [local] : []
        peer.slots[slot] = pc.addTransceiver(this.trackFor(slot) ?? SLOT_KIND[slot], {
          direction: 'sendrecv',
          streams,
        })
      }
    }
    pc.onicecandidate = e => {
      if (e.candidate) peer.send({ candidate: e.candidate.toJSON() })
    }
    // Offers run on the peer's serial queue, so a remote description is
    // never applied while our own setLocalDescription(offer) is in flight.
    pc.onnegotiationneeded = () => {
      void peer.steps
        .run(async () => {
          if (!this.current(user, peer) || pc.signalingState !== 'stable') return
          if (!mayOffer(peer.polite, peer.negotiated)) return
          await this.offer(peer)
        })
        .catch(this.failed(user, peer, 'rtc offer'))
    }
    pc.onconnectionstatechange = () => {
      this.watch(user, peer)
      this.onChange()
    }
    pc.ontrack = () => {
      this.hear(user, peer)
      this.onChange()
    }
    this.peers.set(user, peer)
    this.arm(user, peer)
    const early = this.early.get(user)
    if (early) {
      this.early.delete(user)
      this.status(peer, early)
    }
    if (this.muted || this.videoTrack)
      peer.send({ muted: this.muted, cam: this.videoTrack !== null })
    return peer
  }

  private async offer(peer: Peer, iceRestart = false) {
    const { pc } = peer
    peer.makingOffer = true
    try {
      if (iceRestart) await pc.setLocalDescription(await pc.createOffer({ iceRestart }))
      else await pc.setLocalDescription()
      peer.offeredAt = Date.now()
      const desc = pc.localDescription
      if (desc?.type === 'offer') peer.send({ description: desc })
    } finally {
      peer.makingOffer = false
    }
  }

  // Starts (or restarts) the timer that recovers a peer that doesn't connect.
  private arm(user: string, peer: Peer) {
    if (peer.watchdog) clearTimeout(peer.watchdog)
    peer.watchdog = setTimeout(() => {
      peer.watchdog = null
      this.recover(user, peer)
    }, this.connectTimeoutMs)
  }

  private watch(user: string, peer: Peer) {
    const state = peer.pc.connectionState
    if (state === 'connected' || state === 'closed') {
      if (peer.watchdog) clearTimeout(peer.watchdog)
      if (peer.grace) clearTimeout(peer.grace)
      peer.watchdog = null
      peer.grace = null
    } else if ((state === 'failed' || state === 'disconnected') && !peer.grace) {
      peer.grace = setTimeout(() => {
        peer.grace = null
        this.recover(user, peer)
      }, this.graceMs)
    }
  }

  // The impolite side re-offers with an ICE restart. The polite side asks it
  // to, so it never makes a fresh offer that could collide with one; only a
  // legacy peer, which doesn't know the request, gets a restart from the
  // polite side, and only on a connection that was already negotiated.
  private recover(user: string, peer: Peer) {
    if (!this.current(user, peer) || peer.pc.connectionState === 'connected') return
    if (!peer.polite || (peer.remoteSid === null && peer.negotiated)) this.restart(user, peer)
    else peer.send({ restart: true })
    this.arm(user, peer)
  }

  private restart(user: string, peer: Peer) {
    peer.offeredAt = Date.now()
    this.arm(user, peer)
    void peer.steps
      .run(async () => {
        const state = peer.pc.signalingState
        if (!this.current(user, peer)) return
        if (state !== 'stable' && state !== 'have-local-offer') return
        await this.offer(peer, true)
      })
      .catch(this.failed(user, peer, 'rtc restart'))
  }

  // Maps the remote side's slots onto the stream we show and play: its mic
  // and its camera.
  private hear(user: string, peer: Peer) {
    const all = peer.pc.getTransceivers()
    const at = slotLayout(
      all.map(t => t.receiver.track.kind),
      peer.remoteSid === null
    )
    const pick = (slot: Slot) => {
      const i = at[slot]
      return i === undefined ? null : (all[i]?.receiver.track ?? null)
    }
    const mic = pick('mic')
    const wanted = [mic, pick('cam')].filter((t): t is MediaStreamTrack => t !== null)
    if (!peer.stream) peer.stream = new MediaStream(wanted)
    else {
      const stream = peer.stream
      for (const t of stream.getTracks()) if (!wanted.includes(t)) stream.removeTrack(t)
      for (const t of wanted) if (!stream.getTracks().includes(t)) stream.addTrack(t)
    }
    if (mic && mic !== peer.heard) {
      peer.heard = mic
      this.detector.watch(user, new MediaStream([mic]))
    }
  }

  // The polite side takes over the slots of the offer it is about to answer,
  // and puts our tracks on them.
  private async adopt(peer: Peer) {
    const { pc } = peer
    const all = pc.getTransceivers()
    const fresh: RTCRtpTransceiver[] = []
    if (peer.polite) {
      const at = slotLayout(
        all.map(t => t.receiver.track.kind),
        peer.remoteSid === null
      )
      for (const slot of SLOTS) {
        const i = at[slot]
        const t = i === undefined ? undefined : all[i]
        if (!t || peer.slots[slot] || Object.values(peer.slots).includes(t)) continue
        peer.slots[slot] = t
        fresh.push(t)
      }
    }
    for (const slot of SLOTS) {
      const t = peer.slots[slot]
      if (!t) continue
      if (fresh.includes(t)) {
        t.direction = 'sendrecv'
        if (this.local && slot !== 'screenAudio') t.sender.setStreams?.(this.local)
      }
      const track = this.trackFor(slot)
      if (t.sender.track !== track) await t.sender.replaceTrack(track)
    }
    await this.placeVideo(peer)
  }

  private status(peer: Peer, { muted, cam }: Status) {
    if (muted !== undefined) peer.muted = muted
    if (cam !== undefined) peer.camOn = cam
  }

  // scope is the channel or call the sender tagged the signal with. Signals
  // for any other session (in flight across a switch) are dropped, and so
  // are signals for an earlier session of ours or from an earlier one of
  // theirs.
  async onSignal(from: string, payload: RtcPayload, scope: SignalScope) {
    const { target } = this
    if (!target || !sameScope(target, scope) || from === this.me) return
    const { description, candidate, muted, cam, restart, sid, rsid } = payload
    if (rsid !== undefined && rsid !== this.sid) return
    const retired = sid !== undefined && (this.retired.get(from)?.has(sid) ?? false)
    const negotiating = description !== undefined || candidate !== undefined
    let peer = this.peers.get(from)
    if (!peer) {
      if (retired) return
      // Only negotiation creates a peer; a status update from someone we
      // don't have a peer for yet is kept until we do.
      if (!negotiating) {
        const held = this.early.get(from) ?? {}
        if (muted !== undefined) held.muted = muted
        if (cam !== undefined) held.cam = cam
        if (muted !== undefined || cam !== undefined) this.early.set(from, held)
        return
      }
      peer = this.connect(from, target)
    }
    const action = sidAction(peer.remoteSid, sid, retired)
    if (action === 'drop') return
    if (action === 'replace') {
      this.retire(from, peer)
      peer = this.connect(from, target)
    }
    peer.remoteSid = sid ?? null
    if (muted !== undefined || cam !== undefined) {
      this.status(peer, { muted, cam })
      this.onChange()
    }
    if (restart && !peer.polite && Date.now() - peer.offeredAt > this.restartDebounceMs)
      this.restart(from, peer)
    if (!negotiating) return
    const p = peer
    await p.steps
      .run(async () => {
        if (!this.current(from, p)) return
        const { pc } = p
        if (description) {
          const action = descriptionAction(description.type, {
            polite: p.polite,
            makingOffer: p.makingOffer,
            negotiated: p.negotiated,
            signalingState: pc.signalingState,
          })
          if (description.type === 'offer') p.ignoreOffer = action === 'ignore'
          if (action !== 'apply') return
          await pc.setRemoteDescription(description)
          p.negotiated = true
          for (const held of p.candidates.drain()) await this.addCandidate(p, held)
          if (description.type === 'offer') {
            await this.adopt(p)
            await pc.setLocalDescription()
            const desc = pc.localDescription
            if (desc?.type === 'answer') p.send({ description: desc })
          }
          this.hear(from, p)
          this.onChange()
        } else if (candidate) {
          const verdict = p.candidates.accept(candidate, {
            hasRemote: pc.remoteDescription !== null,
            ignoring: p.ignoreOffer,
          })
          if (verdict === 'add') await this.addCandidate(p, candidate)
        }
      })
      .catch(this.failed(from, p, 'rtc signal'))
  }

  private async addCandidate(peer: Peer, candidate: RTCIceCandidateInit) {
    try {
      await peer.pc.addIceCandidate(candidate)
    } catch (e) {
      if (!peer.ignoreOffer && peer.pc.signalingState !== 'closed') console.error('rtc ice', e)
    }
  }
}

export const rtc = new RtcManager()
