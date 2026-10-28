import Peer, { type DataConnection, type MediaConnection } from 'peerjs'
import { backoffDelay } from './backoff'
import { home, writeLocal } from './instances'
import { ice, iceConfig } from './ice'
import { blobs } from './platform'
import { SpeakingDetector } from './vad'
import { mediaError } from './rules'
import { slotLayout, videoPlan, type Slot } from './negotiation'
import { captureScreen, nextShareId, syncStream, tuneScreen, type ScreenCapture } from './screen'

export interface StoredFile {
  name: string
  mime: string
  size: number
  // Base64 bytes of a file kept by 0.2.x; newer files live in the blob store.
  data?: string
  expires_at: number | null
}

type WireMsg =
  | { type: 'get'; id: string; chunked?: boolean }
  | { type: 'file'; id: string; name: string; mime: string; data: string }
  | { type: 'meta'; id: string; mime: string; size: number }
  | { type: 'chunk'; id: string; data: ArrayBuffer | Uint8Array }
  | { type: 'end'; id: string }
  | { type: 'missing'; id: string }
  | { type: 'cam'; on: boolean; share: boolean; screen?: boolean; muted?: boolean }

const LS_ID = 'rchat_peer_id'
const LS_FILES = 'rchat_p2p_files'
export const CHUNK_BYTES = 256 * 1024
const P2P_MAX_BYTES = 25 * 1024 * 1024
const IDLE_MS = 30_000
const BUFFERED_MAX = 16

const randomHex = (bytes: number) => {
  const buf = new Uint8Array(bytes)
  crypto.getRandomValues(buf)
  return [...buf].map(b => b.toString(16).padStart(2, '0')).join('')
}

export const newP2pId = () => randomHex(16)

export const blobToBase64 = async (blob: Blob) => {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000)
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(bin)
}

export const base64ToBlob = (data: string, mime: string) => {
  const bin = atob(data)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i)
  return new Blob([bytes], { type: mime })
}

// Milliseconds until a file expires, or null when it never does or already has.
export const expiryDelay = (expiresAt: number | null, nowMs: number) => {
  if (expiresAt === null) return null
  const wait = expiresAt * 1000 - nowMs
  return wait > 0 ? Math.min(wait, 2 ** 31 - 1) : null
}

export const unexpired = (expiresAt: number | null, now: number) =>
  expiresAt === null || expiresAt > now

export const servable = (file: StoredFile | null, now: number) =>
  file && unexpired(file.expires_at, now) ? file : null

const pause = (ms: number) => new Promise(r => setTimeout(r, ms))

const buffered = (conn: DataConnection) => (conn as { bufferSize?: number }).bufferSize ?? 0

export class P2pManager {
  private peer: Peer | null = null
  private retry: ReturnType<typeof setTimeout> | null = null
  private iceWatch: (() => void) | null = null
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
  remoteMuted = false
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

  private drop(files: Record<string, StoredFile>, gone: string[]) {
    writeLocal(LS_FILES, JSON.stringify(files))
    this.cached = files
    for (const id of gone)
      void blobs()
        .remove(id)
        .catch(() => {})
  }

  file(id: string): StoredFile | null {
    return this.files()[id] ?? null
  }

  async blob(id: string): Promise<Blob | null> {
    const f = this.file(id)
    if (!f) return null
    if (f.data !== undefined) return base64ToBlob(f.data, f.mime)
    const b = await blobs()
      .get(id)
      .catch(() => null)
    return b && b.type !== f.mime ? new Blob([b], { type: f.mime }) : b
  }

  async storeFile(id: string, file: File, expiresAt: number | null) {
    const full = new Error('Browser storage is full; P2P file could not be kept')
    try {
      await blobs().put(id, file)
    } catch {
      throw full
    }
    const files = { ...this.files() }
    files[id] = {
      name: file.name,
      mime: file.type || 'application/octet-stream',
      size: file.size,
      expires_at: expiresAt,
    }
    try {
      this.write(files)
    } catch {
      void blobs()
        .remove(id)
        .catch(() => {})
      throw full
    }
    this.announce()
  }

  removeFile(id: string) {
    const files = { ...this.files() }
    if (!(id in files)) return
    delete files[id]
    this.drop(files, [id])
    this.announce()
  }

  purgeExpired() {
    const files = { ...this.files() }
    const now = Math.floor(Date.now() / 1000)
    const gone: string[] = []
    for (const [id, f] of Object.entries(files)) {
      if (f.expires_at !== null && f.expires_at <= now) {
        delete files[id]
        gone.push(id)
      }
    }
    if (gone.length) {
      this.drop(files, gone)
      this.announce()
    }
  }

  // Moves files kept as base64 in localStorage by older versions into the blob store.
  private async migrate() {
    for (const [id, f] of Object.entries(this.files())) {
      if (f.data === undefined) continue
      try {
        await blobs().put(id, base64ToBlob(f.data, f.mime))
      } catch {
        return
      }
      const files = { ...this.files() }
      const cur = files[id]
      if (!cur) continue
      files[id] = { name: cur.name, mime: cur.mime, size: cur.size, expires_at: cur.expires_at }
      writeLocal(LS_FILES, JSON.stringify(files))
      this.cached = files
    }
  }

  ensurePurge() {
    this.purgeExpired()
    void this.migrate()
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
    const peer = new Peer(this.peerId(), { ...home.peer(), config: iceConfig() })
    this.iceWatch ??= ice.onChange(() => {
      if (this.peer && !this.peer.destroyed) this.peer.options.config = iceConfig()
    })
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
      if (err.type === 'unavailable-id') this.taken(peer)
      else console.error('peer', err)
    })
    this.peer = peer
    return peer
  }

  // Another tab holds the stored id: use a fresh one for this tab only, so the
  // other tab keeps its id and this one doesn't retry the taken id forever.
  private taken(peer: Peer) {
    this.id = randomHex(16)
    peer.destroy()
    if (this.peer === peer) this.peer = null
    this.announce()
  }

  private serve(conn: DataConnection) {
    let answered = false
    conn.on('data', d => {
      const msg = d as WireMsg
      if (answered || msg?.type !== 'get' || typeof msg.id !== 'string') return
      answered = true
      void this.send(conn, msg.id, msg.chunked === true).catch(() => conn.close())
    })
  }

  // Chunked for current peers, so a large file streams and only a stall times out; a single
  // base64 message for 0.2.x peers, which ask without chunked.
  private async send(conn: DataConnection, id: string, chunked: boolean) {
    const f = servable(this.file(id), Math.floor(Date.now() / 1000))
    const blob = f ? await this.blob(id) : null
    if (!f || !blob) {
      await conn.send({ type: 'missing', id })
      return
    }
    if (!chunked) {
      const data = f.data ?? (await blobToBase64(blob))
      await conn.send({ type: 'file', id, name: f.name, mime: f.mime, data })
      return
    }
    await conn.send({ type: 'meta', id, mime: f.mime, size: blob.size })
    for (let at = 0; at < blob.size; at += CHUNK_BYTES) {
      while (conn.open && buffered(conn) > BUFFERED_MAX) await pause(20)
      if (!conn.open) return
      const data = await blob.slice(at, at + CHUNK_BYTES).arrayBuffer()
      await conn.send({ type: 'chunk', id, data })
    }
    await conn.send({ type: 'end', id })
  }

  download(peerId: string, id: string, limit = P2P_MAX_BYTES): Promise<Blob> {
    return new Promise((resolve, reject) => {
      const conn = this.ensurePeer(true).connect(peerId, { reliable: true })
      let timer: ReturnType<typeof setTimeout> | null = null
      let meta: { mime: string; size: number } | null = null
      const parts: Uint8Array[] = []
      let got = 0
      const finish = (err: Error | null, blob?: Blob) => {
        if (timer) clearTimeout(timer)
        timer = null
        conn.close()
        if (err) reject(err)
        else if (blob) resolve(blob)
      }
      const idle = () => {
        if (timer) clearTimeout(timer)
        timer = setTimeout(() => finish(new Error('P2P download timed out')), IDLE_MS)
      }
      idle()
      conn.on('open', () => void conn.send({ type: 'get', id, chunked: true }))
      conn.on('data', d => {
        if (!timer) return
        const msg = d as WireMsg
        idle()
        if (msg?.type === 'file') {
          if (typeof msg.data !== 'string' || msg.data.length > Math.ceil(limit / 3) * 4)
            finish(new Error('P2P download failed: file too large'))
          else finish(null, base64ToBlob(msg.data, msg.mime))
        } else if (msg?.type === 'meta') {
          if (!Number.isSafeInteger(msg.size) || msg.size < 0 || msg.size > limit)
            finish(new Error('P2P download failed: file too large'))
          else meta = { mime: msg.mime, size: msg.size }
        } else if (msg?.type === 'chunk' && meta) {
          const data: unknown = msg.data
          if (!(data instanceof ArrayBuffer || data instanceof Uint8Array))
            finish(new Error('P2P download failed: bad data'))
          else if (got + data.byteLength > meta.size)
            finish(new Error('P2P download failed: too much data'))
          else {
            parts.push(data instanceof Uint8Array ? data : new Uint8Array(data))
            got += data.byteLength
          }
        } else if (msg?.type === 'end' && meta) {
          if (got === meta.size) finish(null, new Blob(parts as BlobPart[], { type: meta.mime }))
          else finish(new Error('P2P download failed: incomplete file'))
        } else finish(new Error('File not available'))
      })
      conn.on('close', () => {
        if (timer) finish(new Error('P2P download interrupted'))
      })
      conn.on('error', err => {
        if (timer) finish(new Error(`P2P download failed: ${err.type}`))
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
        muted: this.muted,
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
      this.remoteMuted = msg.muted === true
      this.onChange()
    })
    conn.on('close', () => {
      if (this.control === conn) {
        this.control = null
        this.remoteCamOn = false
        this.remoteScreenOn = false
        this.remoteMuted = false
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
    this.sendCam()
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
    this.remoteMuted = false
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
