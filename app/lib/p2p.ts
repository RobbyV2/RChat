import Peer, { type DataConnection, type MediaConnection } from 'peerjs'
import { backoffDelay } from './backoff'
import { home, writeLocal } from './instances'
import { SpeakingDetector } from './vad'
import { mediaError } from './rules'
import { slotLayout, videoPlan, type Slot } from './negotiation'
import { captureScreen, nextShareId, syncStream, tuneScreen, type ScreenCapture } from './screen'

export interface StoredFile {
  name: string
  mime: string
  size: number
  data: string
  expires_at: number | null
}

type WireMsg =
  | { type: 'get'; id: string }
  | { type: 'file'; id: string; name: string; mime: string; data: string }
  | { type: 'missing'; id: string }
  | { type: 'cam'; on: boolean; share: boolean; screen?: boolean }

const LS_ID = 'rchat_peer_id'
const LS_FILES = 'rchat_p2p_files'

const randomHex = (bytes: number) => {
  const buf = new Uint8Array(bytes)
  crypto.getRandomValues(buf)
  return [...buf].map(b => b.toString(16).padStart(2, '0')).join('')
}

export const newP2pId = () => randomHex(16)

export const fileToBase64 = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve((reader.result as string).split(',')[1] ?? '')
    reader.onerror = () => reject(new Error('Could not read file'))
    reader.readAsDataURL(file)
  })

export const base64ToBlob = (data: string, mime: string) => {
  const bin = atob(data)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i)
  return new Blob([bytes], { type: mime })
}

export const servable = (file: StoredFile | null, now: number) =>
  file && (file.expires_at === null || file.expires_at > now) ? file : null

export class P2pManager {
  private peer: Peer | null = null
  private retry: ReturnType<typeof setTimeout> | null = null
  private attempt = 0
  private media: MediaConnection | null = null
  private control: DataConnection | null = null
  private purgeTimer: ReturnType<typeof setInterval> | null = null
  private cached: Record<string, StoredFile> | null = null
  private id: string | null = null
  private placeholder: MediaStreamTrack | null = null
  private screenPlaceholder: MediaStreamTrack | null = null
  private silence: MediaStreamTrack | null = null
  private silenceCtx: AudioContext | null = null
  private cameraTrack: MediaStreamTrack | null = null
  private screen: ScreenCapture | null = null
  // Bumped whenever the call's media ends, so a camera or screen that was
  // still being picked for an earlier call is dropped instead of joining
  // the next one.
  private gen = 0
  // A 0.2.0 peer, told apart by its cam messages, which lack screen.
  private remoteLegacy = false
  local: MediaStream | null = null
  camView: MediaStream | null = null
  screenView: MediaStream | null = null
  shareId: string | null = null
  remote: MediaStream | null = null
  remoteScreen: MediaStream | null = null
  muted = false
  camOn = false
  shareOn = false
  remoteCamOn = false
  remoteScreenOn = false
  remoteShareId: string | null = null
  localSpeaking = false
  remoteSpeaking = false
  private detector = new SpeakingDetector()
  onChange: () => void = () => {}
  onError: (message: string) => void = () => {}

  constructor() {
    this.detector.onSpeak = (id, speaking) => {
      if (id === 'local') this.localSpeaking = speaking
      else this.remoteSpeaking = speaking
      this.onChange()
    }
  }

  peerId(): string {
    if (this.id) return this.id
    let stored: string | null
    try {
      stored = localStorage.getItem(LS_ID)
    } catch {
      stored = null
    }
    this.id = stored || randomHex(16)
    if (!stored) writeLocal(LS_ID, this.id)
    return this.id
  }

  files(): Record<string, StoredFile> {
    if (this.cached) return this.cached
    try {
      this.cached = JSON.parse(localStorage.getItem(LS_FILES) ?? '{}') as Record<string, StoredFile>
    } catch {
      this.cached = {}
    }
    return this.cached
  }

  private write(files: Record<string, StoredFile>) {
    if (!writeLocal(LS_FILES, JSON.stringify(files))) throw new Error('storage write failed')
    this.cached = files
  }

  private drop(files: Record<string, StoredFile>) {
    writeLocal(LS_FILES, JSON.stringify(files))
    this.cached = files
  }

  file(id: string): StoredFile | null {
    return this.files()[id] ?? null
  }

  async storeFile(id: string, file: File, expiresAt: number | null) {
    const data = await fileToBase64(file)
    const files = { ...this.files() }
    files[id] = {
      name: file.name,
      mime: file.type || 'application/octet-stream',
      size: file.size,
      data,
      expires_at: expiresAt,
    }
    try {
      this.write(files)
    } catch {
      throw new Error('Browser storage is full; P2P file could not be kept')
    }
    this.announce()
  }

  removeFile(id: string) {
    const files = { ...this.files() }
    if (!(id in files)) return
    delete files[id]
    this.drop(files)
    this.announce()
  }

  purgeExpired() {
    const files = { ...this.files() }
    const now = Math.floor(Date.now() / 1000)
    let changed = false
    for (const [id, f] of Object.entries(files)) {
      if (f.expires_at !== null && f.expires_at <= now) {
        delete files[id]
        changed = true
      }
    }
    if (changed) {
      this.drop(files)
      this.announce()
    }
  }

  ensurePurge() {
    this.purgeExpired()
    if (!this.purgeTimer) this.purgeTimer = setInterval(() => this.purgeExpired(), 60_000)
  }

  announce() {
    this.ensurePeer()
    home.ws.sendVoice({
      type: 'p2p_hosting',
      peer_id: this.peerId(),
      ids: Object.keys(this.files()),
    })
  }

  private retryLater() {
    if (this.retry) return
    this.retry = setTimeout(() => {
      this.retry = null
      this.ensurePeer(true)
    }, backoffDelay(this.attempt++))
  }

  private ensurePeer(now = false): Peer {
    const cur = this.peer
    if (cur && !cur.destroyed && !cur.disconnected) return cur
    if (cur && !now) {
      this.retryLater()
      return cur
    }
    if (this.retry) clearTimeout(this.retry)
    this.retry = null
    if (cur && !cur.destroyed) {
      cur.reconnect()
      return cur
    }
    const peer = new Peer(this.peerId(), home.peer())
    peer.on('open', () => {
      this.attempt = 0
    })
    peer.on('connection', conn =>
      conn.label === 'call' ? this.attachControl(conn) : this.serve(conn)
    )
    peer.on('call', call => this.answer(call))
    peer.on('disconnected', () => {
      if (this.peer === peer) this.retryLater()
    })
    peer.on('error', err => {
      if (err.type === 'unavailable-id') {
        writeLocal(LS_ID, randomHex(16))
        peer.destroy()
        this.peer = null
        this.announce()
      } else {
        console.error('peer', err)
      }
    })
    this.peer = peer
    return peer
  }

  private serve(conn: DataConnection) {
    let answered = false
    conn.on('data', d => {
      const msg = d as WireMsg
      if (answered || msg?.type !== 'get' || typeof msg.id !== 'string') return
      answered = true
      const f = servable(this.file(msg.id), Math.floor(Date.now() / 1000))
      void conn.send(
        f
          ? { type: 'file', id: msg.id, name: f.name, mime: f.mime, data: f.data }
          : { type: 'missing', id: msg.id }
      )
    })
  }

  download(peerId: string, id: string): Promise<Blob> {
    return new Promise((resolve, reject) => {
      const conn = this.ensurePeer(true).connect(peerId, { reliable: true })
      const timer = setTimeout(() => {
        conn.close()
        reject(new Error('P2P download timed out'))
      }, 30_000)
      conn.on('open', () => void conn.send({ type: 'get', id }))
      conn.on('data', d => {
        clearTimeout(timer)
        conn.close()
        const msg = d as WireMsg
        if (msg.type === 'file') resolve(base64ToBlob(msg.data, msg.mime))
        else reject(new Error('File not available'))
      })
      conn.on('error', err => {
        clearTimeout(timer)
        reject(new Error(`P2P download failed: ${err.type}`))
      })
    })
  }

  mediaActive(): boolean {
    return this.local !== null
  }

  // The share's system audio was left out; see shareAudio.
  get audioNote(): boolean {
    return this.screen?.audioNote ?? false
  }

  async startMedia(muted = false) {
    this.endMedia()
    const mic = await navigator.mediaDevices.getUserMedia({ audio: true }).catch((e: unknown) => {
      throw mediaError(e, 'microphone', 'call')
    })
    for (const track of mic.getAudioTracks()) track.enabled = !muted
    this.muted = muted
    const canvas = document.createElement('canvas')
    canvas.width = 2
    canvas.height = 2
    canvas.getContext('2d')?.fillRect(0, 0, 2, 2)
    const placeholder = canvas.captureStream(1).getVideoTracks()[0] ?? null
    if (placeholder) placeholder.enabled = false
    this.placeholder = placeholder
    this.screenPlaceholder = placeholder?.clone() ?? null
    try {
      const ctx = new AudioContext()
      this.silenceCtx = ctx
      this.silence = ctx.createMediaStreamDestination().stream.getAudioTracks()[0] ?? null
    } catch {
      this.silence = null
    }
    // Without a silent track the screen's audio would get no slot at all; a
    // disabled copy of the mic sends silence just as well.
    if (!this.silence) {
      const quiet = mic.getAudioTracks()[0]?.clone() ?? null
      if (quiet) quiet.enabled = false
      this.silence = quiet
    }
    this.local = new MediaStream(mic.getAudioTracks())
    this.detector.watch('local', this.local)
    this.ensurePeer()
    this.onChange()
  }

  // What we send on each slot. Every slot always carries a track (a disabled
  // placeholder while off), so the call is negotiated once with all four: the
  // mic, the screen's audio, the camera and the screen, in that kind order.
  private trackFor(slot: Slot): MediaStreamTrack | null {
    if (slot === 'mic') return this.local?.getAudioTracks()[0] ?? null
    if (slot === 'screenAudio') return this.screen?.audio ?? this.silence
    const plan = videoPlan(this.cameraTrack, this.screen?.video ?? null, this.remoteLegacy)
    return plan[slot] ?? (slot === 'cam' ? this.placeholder : this.screenPlaceholder)
  }

  private callStream(): MediaStream {
    const order: Slot[] = ['mic', 'screenAudio', 'cam', 'screen']
    return new MediaStream(
      order.map(s => this.trackFor(s)).filter((t): t is MediaStreamTrack => t !== null)
    )
  }

  private transceivers(): Partial<Record<Slot, RTCRtpTransceiver>> {
    const all = this.media?.peerConnection?.getTransceivers() ?? []
    const at = slotLayout(
      all.map(t => t.receiver.track.kind),
      true
    )
    const out: Partial<Record<Slot, RTCRtpTransceiver>> = {}
    for (const [slot, i] of Object.entries(at) as [Slot, number][]) out[slot] = all[i]
    return out
  }

  private place(...slots: Slot[]) {
    const at = this.transceivers()
    for (const slot of slots) {
      const sender = at[slot]?.sender
      const track = this.trackFor(slot)
      if (sender && sender.track !== track) void sender.replaceTrack(track).catch(() => {})
      if (sender && slot === 'screen' && track && track === this.screen?.video)
        void tuneScreen(sender)
    }
  }

  async toggleCamera() {
    if (!this.local) return
    if (this.camOn) {
      this.cameraTrack?.stop()
      this.cameraTrack = null
      this.camView = null
      this.camOn = false
      this.place('cam')
    } else {
      const gen = this.gen
      const cam = (
        await navigator.mediaDevices
          .getUserMedia({ video: { facingMode: 'user' } })
          .catch((e: unknown) => {
            throw mediaError(e, 'camera', 'turn on video')
          })
      ).getVideoTracks()[0]
      if (!cam) throw new Error('No camera available')
      cam.onended = () => {
        if (this.cameraTrack === cam && this.camOn) void this.toggleCamera()
      }
      if (gen !== this.gen || !this.local) {
        cam.stop()
        return
      }
      this.cameraTrack = cam
      this.camView = new MediaStream([cam])
      this.camOn = true
      this.place('cam')
    }
    this.sendCam()
    this.onChange()
  }

  async toggleShare() {
    if (!this.local) return
    if (this.shareOn) return this.stopShare()
    const gen = this.gen
    const capture = await captureScreen()
    if (!capture) return
    if (gen !== this.gen || !this.local) {
      capture.video.stop()
      capture.audio?.stop()
      return
    }
    capture.video.onended = () => {
      if (this.screen === capture) this.stopShare()
    }
    this.screen = capture
    this.screenView = new MediaStream([capture.video])
    this.shareId = nextShareId('p')
    this.shareOn = true
    this.place('cam', 'screen', 'screenAudio')
    this.sendCam()
    this.onChange()
  }

  private stopShare() {
    this.screen?.video.stop()
    this.screen?.audio?.stop()
    this.screen = null
    this.screenView = null
    this.shareId = null
    this.shareOn = false
    this.place('cam', 'screen', 'screenAudio')
    this.sendCam()
    this.onChange()
  }

  // on is whether the camera slot shows something: the camera, or for a
  // 0.2.0 peer, which reads it as "show the video", the screen in its place.
  private sendCam() {
    const { control } = this
    if (control?.open)
      void control.send({
        type: 'cam',
        on: this.camOn || (this.remoteLegacy && this.shareOn),
        share: this.shareOn,
        screen: this.shareOn,
      })
  }

  private setLegacy(legacy: boolean) {
    if (legacy === this.remoteLegacy) return
    this.remoteLegacy = legacy
    this.place('cam', 'screen')
    if (this.shareOn) this.sendCam()
  }

  private attachControl(conn: DataConnection) {
    this.control?.close()
    this.control = conn
    this.setLegacy(false)
    conn.on('open', () => this.sendCam())
    conn.on('data', d => {
      const msg = d as WireMsg
      if (msg?.type !== 'cam' || this.control !== conn) return
      this.setLegacy(!('screen' in msg))
      const screen = msg.screen === true
      if (screen && !this.remoteScreenOn) this.remoteShareId = nextShareId('p')
      if (!screen) this.remoteShareId = null
      this.remoteCamOn = msg.on
      this.remoteScreenOn = screen
      this.onChange()
    })
    conn.on('close', () => {
      if (this.control === conn) {
        this.control = null
        this.remoteCamOn = false
        this.remoteScreenOn = false
        this.remoteShareId = null
        this.onChange()
      }
    })
  }

  dial(peerId: string) {
    if (!this.local) return
    const peer = this.ensurePeer(true)
    this.attach(peer.call(peerId, this.callStream()))
    this.attachControl(peer.connect(peerId, { label: 'call', reliable: true }))
  }

  private answer(call: MediaConnection) {
    if (!this.local) {
      call.close()
      return
    }
    call.answer(this.callStream())
    this.attach(call)
  }

  private attach(call: MediaConnection) {
    this.media?.close()
    this.media = call
    call.on('stream', () => {
      if (this.media !== call) return
      this.hear()
      this.onChange()
    })
    call.on('close', () => {
      if (this.media === call) {
        this.detector.unwatch('remote')
        this.remote = null
        this.remoteScreen = null
        this.onChange()
      }
    })
    call.on('error', err => this.onError(`P2P call failed: ${err.type}`))
  }

  // The remote side's mic and camera make the stream we show and play; its
  // screen and the screen's audio make the other one.
  private hear() {
    const at = this.transceivers()
    const track = (slot: Slot) => at[slot]?.receiver.track ?? null
    const mic = track('mic')
    const fresh = !this.remote
    this.remote = syncStream(this.remote, [mic, track('cam')])
    this.remoteScreen = syncStream(this.remoteScreen, [track('screen'), track('screenAudio')])
    if (fresh && mic) this.detector.watch('remote', new MediaStream([mic]))
  }

  setMuted(muted: boolean) {
    this.muted = muted
    const track = this.local?.getAudioTracks()[0]
    if (track) track.enabled = !muted
    this.onChange()
  }

  endMedia() {
    this.gen += 1
    this.remoteLegacy = false
    this.detector.clear()
    this.media?.close()
    this.media = null
    this.control?.close()
    this.control = null
    this.remoteCamOn = false
    this.remoteScreenOn = false
    this.remoteShareId = null
    this.localSpeaking = false
    this.remoteSpeaking = false
    for (const track of this.local?.getTracks() ?? []) track.stop()
    this.placeholder?.stop()
    this.placeholder = null
    this.screenPlaceholder?.stop()
    this.screenPlaceholder = null
    this.silence?.stop()
    this.silence = null
    void this.silenceCtx?.close().catch(() => {})
    this.silenceCtx = null
    this.cameraTrack?.stop()
    this.cameraTrack = null
    this.screen?.video.stop()
    this.screen?.audio?.stop()
    this.screen = null
    this.camView = null
    this.screenView = null
    this.shareId = null
    this.local = null
    this.remote = null
    this.remoteScreen = null
    this.muted = false
    this.camOn = false
    this.shareOn = false
    this.onChange()
  }
}

export const p2p = new P2pManager()
