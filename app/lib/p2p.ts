import Peer, { type DataConnection, type MediaConnection } from 'peerjs'
import { backoffDelay } from './backoff'
import { home, writeLocal } from './instances'
import { SpeakingDetector } from './vad'
import { mediaError } from './rules'

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
  | { type: 'cam'; on: boolean; share: boolean }

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

class P2pManager {
  private peer: Peer | null = null
  private retry: ReturnType<typeof setTimeout> | null = null
  private attempt = 0
  private media: MediaConnection | null = null
  private control: DataConnection | null = null
  private purgeTimer: ReturnType<typeof setInterval> | null = null
  private cached: Record<string, StoredFile> | null = null
  private id: string | null = null
  private placeholder: MediaStreamTrack | null = null
  private cameraTrack: MediaStreamTrack | null = null
  private shareTrack: MediaStreamTrack | null = null
  local: MediaStream | null = null
  remote: MediaStream | null = null
  muted = false
  camOn = false
  shareOn = false
  remoteCamOn = false
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
    this.local = new MediaStream(
      placeholder ? [...mic.getAudioTracks(), placeholder] : mic.getAudioTracks()
    )
    this.detector.watch('local', this.local)
    this.ensurePeer()
    this.onChange()
  }

  private swapVideo(track: MediaStreamTrack | null) {
    const { local } = this
    if (!local) return
    for (const t of local.getVideoTracks()) local.removeTrack(t)
    if (track) local.addTrack(track)
    const sender = this.media?.peerConnection
      .getTransceivers()
      .find(t => t.receiver.track.kind === 'video')?.sender
    if (sender) void sender.replaceTrack(track)
  }

  async toggleCamera() {
    if (!this.local) return
    if (this.camOn) {
      this.cameraTrack?.stop()
      this.cameraTrack = null
      this.camOn = false
      if (!this.shareOn) this.swapVideo(this.placeholder)
    } else {
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
      this.cameraTrack = cam
      this.camOn = true
      if (!this.shareOn) this.swapVideo(cam)
    }
    this.sendCam()
    this.onChange()
  }

  async toggleShare() {
    if (!this.local) return
    if (this.shareOn) return this.stopShare()
    const track = (
      await navigator.mediaDevices.getDisplayMedia({ video: true })
    ).getVideoTracks()[0]
    if (!track) throw new Error('No screen track available')
    track.onended = () => {
      if (this.shareTrack === track && this.shareOn) this.stopShare()
    }
    this.shareTrack = track
    this.shareOn = true
    this.swapVideo(track)
    this.sendCam()
    this.onChange()
  }

  private stopShare() {
    this.shareTrack?.stop()
    this.shareTrack = null
    this.shareOn = false
    this.swapVideo(this.camOn ? this.cameraTrack : this.placeholder)
    this.sendCam()
    this.onChange()
  }

  private sendCam() {
    const { control } = this
    if (control?.open)
      void control.send({ type: 'cam', on: this.camOn || this.shareOn, share: this.shareOn })
  }

  private attachControl(conn: DataConnection) {
    this.control?.close()
    this.control = conn
    conn.on('open', () => this.sendCam())
    conn.on('data', d => {
      const msg = d as WireMsg
      if (msg?.type !== 'cam') return
      this.remoteCamOn = msg.on
      this.onChange()
    })
    conn.on('close', () => {
      if (this.control === conn) {
        this.control = null
        this.remoteCamOn = false
        this.onChange()
      }
    })
  }

  dial(peerId: string) {
    const { local } = this
    if (!local) return
    const peer = this.ensurePeer(true)
    this.attach(peer.call(peerId, local))
    this.attachControl(peer.connect(peerId, { label: 'call', reliable: true }))
  }

  private answer(call: MediaConnection) {
    const { local } = this
    if (!local) {
      call.close()
      return
    }
    call.answer(local)
    this.attach(call)
  }

  private attach(call: MediaConnection) {
    this.media?.close()
    this.media = call
    call.on('stream', stream => {
      this.remote = stream
      this.detector.watch('remote', stream)
      this.onChange()
    })
    call.on('close', () => {
      if (this.media === call) {
        this.detector.unwatch('remote')
        this.remote = null
        this.onChange()
      }
    })
    call.on('error', err => this.onError(`P2P call failed: ${err.type}`))
  }

  setMuted(muted: boolean) {
    this.muted = muted
    const track = this.local?.getAudioTracks()[0]
    if (track) track.enabled = !muted
    this.onChange()
  }

  endMedia() {
    this.detector.clear()
    this.media?.close()
    this.media = null
    this.control?.close()
    this.control = null
    this.remoteCamOn = false
    this.localSpeaking = false
    this.remoteSpeaking = false
    for (const track of this.local?.getTracks() ?? []) track.stop()
    this.placeholder?.stop()
    this.placeholder = null
    this.cameraTrack?.stop()
    this.cameraTrack = null
    this.shareTrack?.stop()
    this.shareTrack = null
    this.local = null
    this.remote = null
    this.muted = false
    this.camOn = false
    this.shareOn = false
    this.onChange()
  }
}

export const p2p = new P2pManager()
