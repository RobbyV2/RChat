import { home } from './instances'
import { SpeakingDetector } from './vad'
import { mediaError } from './rules'
import { linkQuality, type LinkQuality } from './voice_layout'
import {
  captureScreen,
  nextShareId,
  SCREEN_BITRATE,
  SCREEN_FPS,
  syncStream,
  tuneScreen,
  type ScreenCapture,
} from './screen'
import {
  CandidateQueue,
  CONNECT_TIMEOUT_MS,
  descriptionAction,
  mayOffer,
  mergeStatus,
  newSid,
  RECOVER_GRACE_MS,
  RESTART_DEBOUNCE_MS,
  sameScope,
  Serial,
  sidAction,
  SLOT_KIND,
  slotLayout,
  SLOTS,
  statusOf,
  videoPlan,
  type MediaStatus,
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
  screen: MediaStream | null
  heard: MediaStreamTrack | null
  muted: boolean
  camOn: boolean
  screenOn: boolean
  shareId: string | null
  speaking: boolean
}

export interface PeerView {
  stream: MediaStream | null
  screen: MediaStream | null
  muted: boolean
  camOn: boolean
  screenOn: boolean
  shareId: string | null
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

export class RtcManager {
  private peers = new Map<string, Peer>()
  private me: string | null = null
  private target: RtcTarget | null = null
  private sid = ''
  private gen = 0
  private retired = new Map<string, Set<string>>()
  private early = new Map<string, MediaStatus>()
  local: MediaStream | null = null
  videoTrack: MediaStreamTrack | null = null
  screen: ScreenCapture | null = null
  screenStream: MediaStream | null = null
  shareId: string | null = null
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

  get sharing(): boolean {
    return this.screen !== null
  }

  // The share's system audio was left out; see shareAudio.
  get audioNote(): boolean {
    return this.screen?.audioNote ?? false
  }

  anyShare(): boolean {
    return this.screen !== null || [...this.peers.values()].some(p => p.screenOn)
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
    this.screen?.video.stop()
    this.screen?.audio?.stop()
    this.local = null
    this.videoTrack = null
    this.screen = null
    this.screenStream = null
    this.shareId = null
    this.me = null
    this.target = null
    this.muted = false
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

  peer(user: string): PeerView | undefined {
    const p = this.peers.get(user)
    if (!p) return undefined
    const { stream, screen, muted, camOn, screenOn, shareId } = p
    return { stream, screen, muted, camOn, screenOn, shareId }
  }

  // Everything to play: each peer's mic and, while they share, the audio of
  // their screen.
  remoteStreams(): [string, MediaStream][] {
    return [...this.peers].flatMap(([user, p]): [string, MediaStream][] => [
      ...(p.stream ? [[user, p.stream] as [string, MediaStream]] : []),
      ...(p.screen && p.screenOn ? [[`${user}:screen`, p.screen] as [string, MediaStream]] : []),
    ])
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
    if (!on) return this.setVideo(null)
    const gen = this.gen
    const media = await navigator.mediaDevices.getUserMedia({ video: true }).catch((e: unknown) => {
      throw mediaError(e, 'camera', 'turn on video')
    })
    if (gen !== this.gen || !this.target) {
      for (const t of media.getTracks()) t.stop()
      return
    }
    await this.setVideo(media.getVideoTracks()[0] ?? null)
  }

  async share(on: boolean) {
    if (!on) return this.setScreen(null)
    const gen = this.gen
    const capture = await captureScreen()
    if (!capture) return
    if (gen !== this.gen || !this.target) {
      capture.video.stop()
      capture.audio?.stop()
      return
    }
    await this.setScreen(capture)
  }

  // Camera and screen each have their own slot, negotiated up front, so
  // toggling only swaps the track and tells the peers.
  private async setVideo(track: MediaStreamTrack | null) {
    const old = this.videoTrack
    if (old) {
      old.stop()
      this.local?.removeTrack(old)
    }
    this.videoTrack = track
    if (track) {
      this.local?.addTrack(track)
      track.onended = () => {
        if (this.videoTrack === track) void this.setVideo(null)
      }
    }
    await this.each('rtc camera', peer => this.placeVideo(peer))
    for (const peer of this.peers.values()) peer.send({ cam: this.camFor(peer) !== null })
    this.onChange()
  }

  // Runs a step on every peer on its own, so one peer failing (its pc closed
  // midway, say) doesn't keep the others from getting the change.
  private async each(what: string, step: (peer: Peer) => Promise<void>) {
    await Promise.all(
      [...this.peers].map(([user, peer]) => step(peer).catch(this.failed(user, peer, what)))
    )
  }

  private async setScreen(capture: ScreenCapture | null) {
    const old = this.screen
    if (old && old !== capture) {
      old.video.stop()
      old.audio?.stop()
    }
    this.screen = capture
    this.screenStream = capture ? new MediaStream([capture.video]) : null
    this.shareId = capture ? nextShareId('r') : null
    if (capture)
      capture.video.onended = () => {
        if (this.screen === capture) void this.setScreen(null)
      }
    this.onChange()
    await this.each('rtc share', async peer => {
      await this.placeScreen(peer)
      if (peer.remoteSid === null) await this.placeVideo(peer)
    })
    for (const peer of this.peers.values())
      peer.send({ cam: this.camFor(peer) !== null, screen: capture !== null })
    this.onChange()
  }

  private async placeScreen(peer: Peer) {
    for (const slot of ['screen', 'screenAudio'] as const) {
      const t = peer.slots[slot]
      const track = this.trackFor(slot, peer)
      if (t && t.sender.track !== track) await t.sender.replaceTrack(track)
    }
    const screen = peer.slots.screen
    if (screen?.sender.track) await tuneScreen(screen.sender)
  }

  private camFor(peer: Peer): MediaStreamTrack | null {
    return this.trackFor('cam', peer)
  }

  private async placeVideo(peer: Peer) {
    const track = this.camFor(peer)
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

  // What a peer gets on each slot; see videoPlan for a legacy peer. A peer
  // whose version isn't known yet (no signal from it so far) is taken as
  // current, and moved over when its first signal says otherwise.
  private trackFor(slot: Slot, peer: Peer): MediaStreamTrack | null {
    if (slot === 'mic') return this.local?.getAudioTracks()[0] ?? null
    if (slot === 'screenAudio') return this.screen?.audio ?? null
    const plan = videoPlan(this.videoTrack, this.screen?.video ?? null, peer.remoteSid === null)
    return plan[slot]
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
      screen: null,
      heard: null,
      muted: false,
      camOn: false,
      screenOn: false,
      shareId: null,
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
        const sendEncodings =
          slot === 'screen' ? [{ maxBitrate: SCREEN_BITRATE, maxFramerate: SCREEN_FPS }] : undefined
        peer.slots[slot] = pc.addTransceiver(this.trackFor(slot, peer) ?? SLOT_KIND[slot], {
          direction: 'sendrecv',
          streams,
          ...(sendEncodings ? { sendEncodings } : {}),
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
    if (this.muted || this.videoTrack || this.screen)
      peer.send({
        muted: this.muted,
        cam: this.camFor(peer) !== null,
        screen: this.screen !== null,
      })
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

  // Maps the remote side's slots onto the streams we show and play: its mic
  // and camera, and its screen with the screen's audio.
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
    peer.stream = syncStream(peer.stream, [mic, pick('cam')])
    peer.screen = syncStream(peer.screen, [pick('screen'), pick('screenAudio')])
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
      const track = this.trackFor(slot, peer)
      if (t.sender.track !== track) await t.sender.replaceTrack(track)
    }
    if (peer.slots.screen?.sender.track) await tuneScreen(peer.slots.screen.sender)
    await this.placeVideo(peer)
  }

  private status(peer: Peer, status: MediaStatus) {
    const { muted, cam, screen } = mergeStatus(
      { muted: peer.muted, cam: peer.camOn, screen: peer.screenOn },
      status
    )
    if (screen && !peer.screenOn) peer.shareId = nextShareId('r')
    if (!screen) peer.shareId = null
    peer.muted = muted ?? false
    peer.camOn = cam ?? false
    peer.screenOn = screen ?? false
  }

  // scope is the channel or call the sender tagged the signal with. Signals
  // for any other session (in flight across a switch) are dropped, and so
  // are signals for an earlier session of ours or from an earlier one of
  // theirs.
  async onSignal(from: string, payload: RtcPayload, scope: SignalScope) {
    const { target } = this
    if (!target || !sameScope(target, scope) || from === this.me) return
    const { description, candidate, restart, sid, rsid } = payload
    const status = statusOf(payload)
    if (rsid !== undefined && rsid !== this.sid) return
    const retired = sid !== undefined && (this.retired.get(from)?.has(sid) ?? false)
    const negotiating = description !== undefined || candidate !== undefined
    let peer = this.peers.get(from)
    if (!peer) {
      if (retired) return
      // Only negotiation creates a peer; a status update from someone we
      // don't have a peer for yet is kept until we do.
      if (!negotiating) {
        if (status) this.early.set(from, mergeStatus(this.early.get(from) ?? {}, status))
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
    const known = peer.remoteSid !== undefined
    peer.remoteSid = sid ?? null
    if (!known && peer.remoteSid === null && this.screen) {
      if (!this.videoTrack) peer.send({ cam: true })
      const p = peer
      void (async () => {
        await this.placeScreen(p)
        await this.placeVideo(p)
      })().catch(this.failed(from, p, 'rtc legacy share'))
    }
    if (status) {
      this.status(peer, status)
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
