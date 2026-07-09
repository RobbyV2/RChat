import { wsClient } from './ws'
import { SpeakingDetector } from './vad'
import type { RtcPayload } from './types'

export type RtcTarget =
  { channelId: number; dmId?: undefined } | { dmId: number; channelId?: undefined }

interface Peer {
  pc: RTCPeerConnection
  polite: boolean
  makingOffer: boolean
  ignoreOffer: boolean
  stream: MediaStream | null
  videoSender: RTCRtpSender | null
  muted: boolean
  camOn: boolean
  speaking: boolean
}

class RtcManager {
  private peers = new Map<string, Peer>()
  private me: string | null = null
  private target: RtcTarget | null = null
  local: MediaStream | null = null
  videoTrack: MediaStreamTrack | null = null
  sharing = false
  muted = false
  localSpeaking = false
  private detector = new SpeakingDetector()
  onChange: () => void = () => {}

  constructor() {
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

  async join(me: string, target: RtcTarget) {
    this.leave()
    const local = await navigator.mediaDevices.getUserMedia({ audio: true })
    this.me = me
    this.target = target
    this.local = local
    this.detector.watch(me, local)
    this.onChange()
  }

  leave() {
    this.detector.clear()
    for (const { pc } of this.peers.values()) pc.close()
    this.peers.clear()
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
      if (!wanted.has(user)) {
        this.detector.unwatch(user)
        peer.pc.close()
        this.peers.delete(user)
      }
    }
    for (const user of wanted) {
      if (!this.peers.has(user)) this.connect(user)
    }
    this.onChange()
  }

  peer(user: string): { stream: MediaStream | null; muted: boolean; camOn: boolean } | undefined {
    const p = this.peers.get(user)
    return p ? { stream: p.stream, muted: p.muted, camOn: p.camOn } : undefined
  }

  setMuted(muted: boolean) {
    this.muted = muted
    const track = this.local?.getAudioTracks()[0]
    if (track) track.enabled = !muted
    for (const user of this.peers.keys()) this.signal(user, { muted })
    this.onChange()
  }

  async camera(on: boolean) {
    if (!on) return this.setVideo(null, false)
    const media = await navigator.mediaDevices.getUserMedia({ video: true })
    await this.setVideo(media.getVideoTracks()[0] ?? null, false)
  }

  async share(on: boolean) {
    if (!on) return this.setVideo(null, false)
    const media = await navigator.mediaDevices.getDisplayMedia({ video: true })
    await this.setVideo(media.getVideoTracks()[0] ?? null, true)
  }

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
    for (const peer of this.peers.values()) {
      if (peer.videoSender) await peer.videoSender.replaceTrack(track)
      else if (track && this.local) peer.videoSender = peer.pc.addTrack(track, this.local)
    }
    for (const user of this.peers.keys()) this.signal(user, { cam: track !== null })
    this.onChange()
  }

  private signal(to: string, payload: RtcPayload) {
    const { target } = this
    if (!target) return
    wsClient.sendVoice({
      type: 'rtc_signal',
      to,
      channel_id: target.channelId ?? null,
      dm_id: target.dmId ?? null,
      payload,
    })
  }

  private connect(user: string): Peer {
    const pc = new RTCPeerConnection({ iceServers: [] })
    const peer: Peer = {
      pc,
      polite: (this.me ?? '') < user,
      makingOffer: false,
      ignoreOffer: false,
      stream: null,
      videoSender: null,
      muted: false,
      camOn: false,
      speaking: false,
    }
    const local = this.local
    if (local) {
      for (const track of local.getTracks()) {
        const sender = pc.addTrack(track, local)
        if (track.kind === 'video') peer.videoSender = sender
      }
    }
    pc.onicecandidate = e => {
      if (e.candidate) this.signal(user, { candidate: e.candidate.toJSON() })
    }
    pc.onnegotiationneeded = () => {
      void (async () => {
        try {
          peer.makingOffer = true
          await pc.setLocalDescription()
          if (pc.localDescription) this.signal(user, { description: pc.localDescription })
        } catch (e) {
          console.error('rtc offer', e)
        } finally {
          peer.makingOffer = false
        }
      })()
    }
    pc.ontrack = e => {
      peer.stream = e.streams[0] ?? new MediaStream([e.track])
      if (e.track.kind === 'audio') this.detector.watch(user, new MediaStream([e.track]))
      this.onChange()
    }
    this.peers.set(user, peer)
    if (this.muted || this.videoTrack)
      this.signal(user, { muted: this.muted, cam: this.videoTrack !== null })
    return peer
  }

  async onSignal(from: string, payload: RtcPayload) {
    if (!this.target) return
    const peer = this.peers.get(from) ?? this.connect(from)
    const { description, candidate, muted, cam } = payload
    if (muted !== undefined || cam !== undefined) {
      if (muted !== undefined) peer.muted = muted
      if (cam !== undefined) peer.camOn = cam
      this.onChange()
      return
    }
    const { pc } = peer
    if (description) {
      const collision =
        description.type === 'offer' && (peer.makingOffer || pc.signalingState !== 'stable')
      peer.ignoreOffer = !peer.polite && collision
      if (peer.ignoreOffer) return
      await pc.setRemoteDescription(description)
      if (description.type === 'offer') {
        await pc.setLocalDescription()
        if (pc.localDescription) this.signal(from, { description: pc.localDescription })
      }
    } else if (candidate) {
      try {
        await pc.addIceCandidate(candidate)
      } catch (e) {
        if (!peer.ignoreOffer) console.error('rtc ice', e)
      }
    }
  }
}

export const rtc = new RtcManager()
