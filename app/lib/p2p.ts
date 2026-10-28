import Peer, { type DataConnection, type MediaConnection } from 'peerjs'
import { backoffDelay } from './backoff'
import { home, writeLocal } from './instances'
import { ice, iceConfig } from './ice'
import { blobs, type BlobWriter } from './platform'
import { Sha256, validSha256 } from './sha256'
import { kindOf, NEUTRAL_TYPE, safeType, SNIFF_BYTES, type PreviewKind } from './sniff'
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
  sha256?: string
  // The message the file was posted with, once the send went through.
  message_id?: number
  // Unix seconds when it was attached; files kept by older versions have none.
  added_at?: number
  // Attached to a message whose send hasn't gone through yet: neither announced nor served, so
  // nobody can learn the id and post it first.
  pending?: boolean
}

// A P2P file this account downloaded and kept, in the blob store under `gotKey`. It is only
// handed out again for the same id, hoster and hash, so a message that reuses an id never
// shows another message's file.
export interface Received {
  id: string
  hoster: string
  sha256: string | null
  message_id: number | null
  size: number
  type: string
  verified: boolean
  at: number
}

export interface Download {
  blob: Blob
  // A recognized passive type (see sniff.ts) or application/octet-stream.
  type: string
  // The bytes matched the hash in the message; false for files from older clients.
  verified: boolean
}

export interface DownloadOpts {
  // From the message: the download stops at this size and must match this hash.
  size: number | null
  sha256: string | null
  // Whose file it is: kept copies are matched on it as well as on the id and hash.
  hoster: string
  messageId?: number | null
  // Only picks the audio player over the video one for a WebM file.
  audio?: boolean
  onProgress?: (got: number, total: number) => void
  signal?: AbortSignal
}

type WireMsg =
  | { type: 'get'; id: string; chunked?: boolean; acks?: boolean }
  | { type: 'file'; id: string; name: string; mime: string; data: string }
  | { type: 'meta'; id: string; mime: string; size: number }
  | { type: 'chunk'; id: string; data: ArrayBuffer | Uint8Array }
  | { type: 'end'; id: string }
  | { type: 'missing'; id: string }
  | { type: 'busy'; id: string }
  | { type: 'ack'; id: string; got: number }
  | { type: 'cam'; on: boolean; share: boolean; screen?: boolean; muted?: boolean }

// Unscoped keys and blob keys from before files were kept per account.
const LEGACY_ID = 'rchat_peer_id'
const LEGACY_FILES = 'rchat_p2p_files'
export const CHUNK_BYTES = 256 * 1024
// Older peers send and ask for a whole file in one message; that stays capped.
export const LEGACY_MAX = 25 * 1024 * 1024
const IDLE_MS = 30_000
const BUFFERED_MAX = 16
// The hoster gives up on a downloader whose buffer hasn't drained for this long, and on any
// transfer slower than SERVE_RATE bytes a second overall, so stalled peers can't hold a slot.
export const STALL_MS = 20_000
const SERVE_BASE_MS = 120_000
const SERVE_RATE = 64 * 1024
export const serveDeadline = (size: number) => SERVE_BASE_MS + (size / SERVE_RATE) * 1000
// A connection that never asks for a file is closed after this long.
const ASK_MS = 15_000
// A downloader that asks with acks reports the bytes it has stored, and the hoster sends at most
// ACK_WINDOW past that, so a slow store slows the transfer instead of filling memory.
export const ACK_WINDOW = 8 * 1024 * 1024
// Received chunks waiting to be written to storage; past this the download stops, so a hoster
// that ignores acks never makes it buffer the file in memory.
export const PENDING_MAX = 32 * 1024 * 1024
// A file announced but not yet posted (the send is still on its way) is never dropped as stale.
const STALE_GRACE_S = 120
// A staged file whose send never finished (the tab closed mid-send) is dropped after this long.
const PENDING_MAX_S = 3600
// The hoster serves this many transfers at once, each peer this many at once and this many
// requests a minute. Peers are told apart by their PeerJS id, which anyone can change, so the
// per-peer limits only slow a client down; they say nothing about who is asking.
// Known limits: the deadline grows with the file size (1 s per 64 KiB), so a slow downloader of
// a big file can hold a slot for a long time; the stall timer resets on any progress, so a
// downloader that acks a trickle of bytes is never cut off as stalled; and a client that
// rotates PeerJS ids can keep taking all SERVE_MAX slots. A per-download token from the server
// is the real fix.
export const SERVE_MAX = 4
export const PEER_SERVE_MAX = 2
export const ASKS_PER_MIN = 12
// Downloaded copies kept per account, oldest dropped first.
const RECEIVED_MAX = 32
const RECEIVED_BYTES = 1024 * 1024 * 1024

export const MISMATCH = "The file didn't match what was sent and was discarded"
export const NO_ROOM = 'Not enough browser storage for this file'
export const CANCELED = 'Download canceled'
export const SLOW_STORE = 'P2P download failed: storage is too slow'

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

const base64Bytes = (data: string) => {
  const bin = atob(data)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i)
  return bytes
}

export const base64ToBlob = (data: string, mime: string) =>
  new Blob([base64Bytes(data)], { type: mime })

// Milliseconds until a file expires, or null when it never does or already has.
export const expiryDelay = (expiresAt: number | null, nowMs: number) => {
  if (expiresAt === null) return null
  const wait = expiresAt * 1000 - nowMs
  return wait > 0 ? Math.min(wait, 2 ** 31 - 1) : null
}

export const unexpired = (expiresAt: number | null, now: number) =>
  expiresAt === null || expiresAt > now

export const servable = (file: StoredFile | null, now: number) =>
  file && !file.pending && unexpired(file.expires_at, now) ? file : null

const pause = (ms: number) => new Promise(r => setTimeout(r, ms))

const buffered = (conn: DataConnection) => (conn as { bufferSize?: number }).bufferSize ?? 0

const nowS = () => Math.floor(Date.now() / 1000)

const readJson = <T extends object>(key: string): Record<string, T> => {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(key) ?? '{}')
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
    return Object.fromEntries(
      Object.entries(raw).filter(([, v]) => v !== null && typeof v === 'object')
    ) as Record<string, T>
  } catch {
    return {}
  }
}

export const headOf = async (blob: Blob) =>
  new Uint8Array(await blob.slice(0, SNIFF_BYTES).arrayBuffer())

// Object URLs of shown previews (only ever of recognized passive types) by message id, newest
// last; the oldest are revoked past the cap.
export interface Preview {
  url: string
  kind: PreviewKind
}

const previews = new Map<number, Preview>()
const PREVIEWS_MAX = 32

export const previewUrl = (messageId: number) => {
  const p = previews.get(messageId)
  if (p === undefined) return null
  previews.delete(messageId)
  previews.set(messageId, p)
  return p
}

export const keepPreview = (messageId: number, p: Preview) => {
  const old = previews.get(messageId)
  if (old !== undefined && old.url !== p.url) URL.revokeObjectURL(old.url)
  previews.delete(messageId)
  previews.set(messageId, p)
  for (const [key, stale] of previews) {
    if (previews.size <= PREVIEWS_MAX) break
    previews.delete(key)
    URL.revokeObjectURL(stale.url)
  }
}

export const dropPreview = (messageId: number) => {
  const p = previews.get(messageId)
  if (p === undefined) return
  previews.delete(messageId)
  URL.revokeObjectURL(p.url)
}

// Where a downloaded copy is kept: ids are 32 hex characters and hashes 64, so the hoster,
// last, keeps keys of different files apart.
const copyKey = (id: string, hoster: string, sha256: string | null) =>
  `${id}:${sha256 ?? '-'}:${hoster}`

const validReceived = (r: Received) =>
  typeof r.id === 'string' &&
  typeof r.hoster === 'string' &&
  (r.sha256 === null || typeof r.sha256 === 'string') &&
  typeof r.size === 'number' &&
  typeof r.at === 'number'

const dropPreviews = () => {
  for (const p of previews.values()) URL.revokeObjectURL(p.url)
  previews.clear()
}

export class P2pManager {
  private peer: Peer | null = null
  private retry: ReturnType<typeof setTimeout> | null = null
  private iceWatch: (() => void) | null = null
  private attempt = 0
  private media: MediaConnection | null = null
  private control: DataConnection | null = null
  private purgeTimer: ReturnType<typeof setInterval> | null = null
  // Whose files these are: the account's username, scoped to the instance; null signed out.
  private account: string | null = null
  private cached: Record<string, StoredFile> | null = null
  private legacy: Record<string, StoredFile> | null = null
  private got: Record<string, Received> | null = null
  private id: string | null = null
  private serving = 0
  private servingBy = new Map<string, number>()
  private stallMs = STALL_MS
  private deadlineMs = serveDeadline
  private asks = new Map<string, number[]>()
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

  // Files, downloads and the peer id belong to one account at a time. Switching (or signing
  // out with null) disconnects from the broker and forgets the previous account's state.
  setAccount(username: string | null) {
    const next = username === null ? null : home.scoped(username)
    if (next === this.account) return
    this.disconnect()
    this.account = next
    if (next !== null) writeLocal(LEGACY_ID, null)
  }

  // Signing out: stop serving, leave the broker and delete the downloaded copies.
  signOut() {
    const account = this.account
    if (account !== null) {
      void blobs()
        .clear(`d:${account}:`)
        .catch(() => {})
      writeLocal(this.key('rchat_p2p_got'), null)
    }
    dropPreviews()
    this.disconnect()
    this.account = null
  }

  private disconnect() {
    this.endMedia()
    if (this.retry) clearTimeout(this.retry)
    this.retry = null
    this.peer?.destroy()
    this.peer = null
    this.cached = null
    this.legacy = null
    this.got = null
    this.id = null
    this.asks.clear()
  }

  private key(base: string) {
    return `${base}:${this.account ?? ''}`
  }

  private hostKey(id: string) {
    return `h:${this.account ?? ''}:${id}`
  }

  private gotKey(id: string) {
    return `d:${this.account ?? ''}:${id}`
  }

  peerId(): string {
    if (this.id) return this.id
    const key = this.key('rchat_peer_id')
    let stored: string | null
    try {
      stored = this.account === null ? null : localStorage.getItem(key)
    } catch {
      stored = null
    }
    this.id = stored || randomHex(16)
    if (!stored && this.account !== null) writeLocal(key, this.id)
    return this.id
  }

  files(): Record<string, StoredFile> {
    if (this.account === null) return {}
    this.cached ??= readJson<StoredFile>(this.key('rchat_p2p_files'))
    return this.cached
  }

  // Files kept by versions before per-account storage, until the server says whose they are.
  private legacyFiles(): Record<string, StoredFile> {
    this.legacy ??= readJson<StoredFile>(LEGACY_FILES)
    return this.legacy
  }

  private write(files: Record<string, StoredFile>) {
    if (!writeLocal(this.key('rchat_p2p_files'), JSON.stringify(files)))
      throw new Error('storage write failed')
    this.cached = files
  }

  private drop(files: Record<string, StoredFile>, gone: string[]) {
    writeLocal(this.key('rchat_p2p_files'), JSON.stringify(files))
    this.cached = files
    for (const id of gone)
      void blobs()
        .remove(this.hostKey(id))
        .catch(() => {})
  }

  file(id: string): StoredFile | null {
    return Object.hasOwn(this.files(), id) ? this.files()[id] : null
  }

  async blob(id: string): Promise<Blob | null> {
    const f = this.file(id)
    if (!f) return null
    if (f.data !== undefined) return base64ToBlob(f.data, NEUTRAL_TYPE)
    return blobs()
      .get(this.hostKey(id))
      .catch(() => null)
  }

  // Keeps a file and hosts it right away.
  async storeFile(id: string, file: File, expiresAt: number | null, sha256?: string) {
    await this.keep(id, file, expiresAt, sha256, false)
    this.announce()
  }

  // Keeps a file for a message that is about to be sent. It is announced and served only once
  // `posted` says the send went through, so its id stays private until the message exists.
  stage(id: string, file: File, expiresAt: number | null, sha256?: string) {
    return this.keep(id, file, expiresAt, sha256, true)
  }

  private async keep(
    id: string,
    file: File,
    expiresAt: number | null,
    sha256: string | undefined,
    pending: boolean
  ) {
    const full = new Error('Browser storage is full; P2P file could not be kept')
    if (this.account === null) throw new Error('Sign in to share P2P files')
    try {
      await blobs().put(this.hostKey(id), file)
    } catch {
      throw full
    }
    const files = { ...this.files() }
    files[id] = {
      name: file.name,
      mime: file.type || NEUTRAL_TYPE,
      size: file.size,
      expires_at: expiresAt,
      ...(sha256 !== undefined ? { sha256 } : {}),
      added_at: nowS(),
      ...(pending ? { pending: true } : {}),
    }
    try {
      this.write(files)
    } catch {
      void blobs()
        .remove(this.hostKey(id))
        .catch(() => {})
      throw full
    }
  }

  // The send went through: the file now follows its message (see removeByMessage).
  posted(id: string, messageId: number) {
    const files = { ...this.files() }
    if (!Object.hasOwn(files, id)) return
    const { pending, ...f } = files[id]
    files[id] = { ...f, message_id: messageId }
    writeLocal(this.key('rchat_p2p_files'), JSON.stringify(files))
    this.cached = files
    if (pending) this.announce()
  }

  removeFile(id: string) {
    const files = { ...this.files() }
    if (!Object.hasOwn(files, id)) return
    const { pending } = files[id]
    delete files[id]
    this.drop(files, [id])
    if (!pending) this.announce()
  }

  // The message (or its attachment) was removed: stop serving the file and drop any copy we
  // downloaded, even when the message isn't loaded here.
  forgetMessage(messageId: number) {
    const files = { ...this.files() }
    const gone = Object.keys(files).filter(id => files[id].message_id === messageId)
    for (const id of gone) delete files[id]
    if (gone.length) {
      this.drop(files, gone)
      this.announce()
    }
    dropPreview(messageId)
    const got = this.received()
    for (const [key, r] of Object.entries(got))
      if (r.message_id === messageId) this.dropReceived(key)
  }

  purgeExpired() {
    const files = { ...this.files() }
    const now = nowS()
    const gone: string[] = []
    for (const [id, f] of Object.entries(files)) {
      const abandoned = f.pending && now - (f.added_at ?? 0) > PENDING_MAX_S
      if (abandoned || (f.expires_at !== null && f.expires_at <= now)) {
        delete files[id]
        gone.push(id)
      }
    }
    if (gone.length) {
      this.drop(files, gone)
      this.announce()
    }
    const legacy = { ...this.legacyFiles() }
    const old = Object.keys(legacy).filter(id => !unexpired(legacy[id].expires_at, now))
    if (old.length) {
      for (const id of old) {
        delete legacy[id]
        void blobs()
          .remove(id)
          .catch(() => {})
      }
      this.saveLegacy(legacy)
    }
  }

  private saveLegacy(legacy: Record<string, StoredFile>) {
    writeLocal(LEGACY_FILES, Object.keys(legacy).length ? JSON.stringify(legacy) : null)
    this.legacy = legacy
  }

  // The server's answer to an announce: which of the `checked` ids are still live attachments
  // of this account. Ours that aren't are removed (unless just attached and maybe still being
  // sent); files kept before per-account storage that are live become this account's.
  async reconcile(live: string[], checked: string[]) {
    if (this.account === null) return
    const alive = new Set(live)
    const now = nowS()
    const files = { ...this.files() }
    const stale = checked.filter(
      id =>
        Object.hasOwn(files, id) &&
        !alive.has(id) &&
        (files[id].added_at === undefined || now - (files[id].added_at ?? 0) > STALE_GRACE_S)
    )
    for (const id of stale) delete files[id]
    if (stale.length) this.drop(files, stale)
    const legacy = { ...this.legacyFiles() }
    const mine = checked.filter(id => Object.hasOwn(legacy, id) && alive.has(id))
    let adopted = 0
    const owner: string = this.account
    for (const id of mine) {
      const f = legacy[id]
      try {
        const blob =
          f.data !== undefined ? base64ToBlob(f.data, NEUTRAL_TYPE) : await blobs().get(id)
        if (!blob || this.account !== owner) return
        await blobs().put(this.hostKey(id), blob)
      } catch {
        continue
      }
      if (this.account !== owner) return
      const next = { ...this.files() }
      next[id] = { name: f.name, mime: f.mime, size: f.size, expires_at: f.expires_at }
      writeLocal(this.key('rchat_p2p_files'), JSON.stringify(next))
      this.cached = next
      delete legacy[id]
      void blobs()
        .remove(id)
        .catch(() => {})
      adopted += 1
    }
    if (adopted) this.saveLegacy(legacy)
    if (stale.length || adopted) this.announce()
  }

  ensurePurge() {
    this.purgeExpired()
    if (!this.purgeTimer) this.purgeTimer = setInterval(() => this.purgeExpired(), 60_000)
  }

  announce() {
    if (this.account === null) return
    this.ensurePeer()
    home.ws.sendVoice({
      type: 'p2p_hosting',
      peer_id: this.peerId(),
      ids: [
        ...Object.entries(this.files())
          .filter(([, f]) => !f.pending)
          .map(([id]) => id),
        ...Object.keys(this.legacyFiles()),
      ],
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

  // Whether `peer` may start another transfer now: a few at a time overall, and a limited
  // number of requests per peer per minute.
  private admit(peer: string) {
    if (this.serving >= SERVE_MAX || (this.servingBy.get(peer) ?? 0) >= PEER_SERVE_MAX) return false
    const now = Date.now()
    const recent = (this.asks.get(peer) ?? []).filter(t => now - t < 60_000)
    if (recent.length >= ASKS_PER_MIN) {
      this.asks.set(peer, recent)
      return false
    }
    recent.push(now)
    this.asks.set(peer, recent)
    if (this.asks.size > 256) {
      for (const [key, times] of this.asks)
        if (!times.some(t => now - t < 60_000)) this.asks.delete(key)
    }
    return true
  }

  // A slot is held from the request until the transfer ends or the connection closes,
  // whichever comes first, so a send stuck on a dead peer still gives its slot back.
  private serve(conn: DataConnection) {
    const peer = String(conn.peer)
    let answered = false
    let held = false
    const release = () => {
      if (!held) return
      held = false
      this.serving -= 1
      const n = (this.servingBy.get(peer) ?? 1) - 1
      if (n > 0) this.servingBy.set(peer, n)
      else this.servingBy.delete(peer)
    }
    const quiet = setTimeout(() => {
      if (!answered) conn.close()
    }, ASK_MS)
    conn.on('close', () => {
      clearTimeout(quiet)
      release()
    })
    // Bytes the downloader stored, or null when it doesn't send acks.
    const flow: { acked: number | null } = { acked: null }
    conn.on('data', d => {
      const msg = d as WireMsg
      if (answered && msg?.type === 'ack' && flow.acked !== null) {
        if (Number.isSafeInteger(msg.got) && msg.got > flow.acked) flow.acked = msg.got
        return
      }
      if (answered || msg?.type !== 'get' || typeof msg.id !== 'string') return
      answered = true
      if (msg.acks === true) flow.acked = 0
      clearTimeout(quiet)
      if (!this.admit(peer)) {
        void Promise.resolve(conn.send({ type: 'busy', id: msg.id })).catch(() => {})
        setTimeout(() => conn.close(), 1000)
        return
      }
      held = true
      this.serving += 1
      this.servingBy.set(peer, (this.servingBy.get(peer) ?? 0) + 1)
      void this.send(conn, msg.id, msg.chunked === true, flow)
        .catch(() => conn.close())
        .finally(release)
    })
  }

  // Chunked for current peers, so a large file streams and only a stall times out; a single
  // base64 message for 0.2.x peers, which ask without chunked. The type sent is what the bytes
  // are recognized as, so older receivers never get an active type from us either.
  private async send(
    conn: DataConnection,
    id: string,
    chunked: boolean,
    flow: { acked: number | null }
  ) {
    const f = servable(this.file(id), nowS())
    const blob = f ? await this.blob(id) : null
    if (!f || !blob || (!chunked && blob.size > LEGACY_MAX)) {
      await conn.send({ type: 'missing', id })
      return
    }
    const mime = safeType(await headOf(blob))
    if (!chunked) {
      const data = f.data ?? (await blobToBase64(blob))
      await conn.send({ type: 'file', id, name: f.name, mime, data })
      return
    }
    const deadline = Date.now() + this.deadlineMs(blob.size)
    const cutoff = setTimeout(() => conn.close(), deadline - Date.now())
    try {
      await conn.send({ type: 'meta', id, mime, size: blob.size })
      for (let at = 0; at < blob.size; at += CHUNK_BYTES) {
        if (!(await this.drained(conn, deadline, () => at - (flow.acked ?? at)))) {
          conn.close()
          return
        }
        const data = await blob.slice(at, at + CHUNK_BYTES).arrayBuffer()
        await conn.send({ type: 'chunk', id, data })
      }
      await conn.send({ type: 'end', id })
    } finally {
      clearTimeout(cutoff)
    }
  }

  // Waits for the downloader to take what was sent (and, with acks, to store all but
  // ACK_WINDOW of it); false when it stopped taking anything for STALL_MS, the transfer ran past
  // its deadline, or the connection closed.
  private async drained(conn: DataConnection, deadline: number, unacked: () => number) {
    let last = [buffered(conn), unacked()]
    let moved = Date.now()
    while (conn.open && (last[0] > BUFFERED_MAX || last[1] > ACK_WINDOW)) {
      const now = Date.now()
      if (now - moved > this.stallMs || now > deadline) return false
      await pause(20)
      const left = [buffered(conn), unacked()]
      if (left[0] < last[0] || left[1] < last[1]) moved = Date.now()
      last = left
    }
    return conn.open && Date.now() <= deadline
  }

  // Kept downloads by copy key. Entries from before copies were matched on their hoster and
  // hash are dropped.
  received(): Record<string, Received> {
    if (this.account === null) return {}
    if (this.got === null) {
      const all = readJson<Received>(this.key('rchat_p2p_got'))
      const old = Object.keys(all).filter(key => !validReceived(all[key]))
      for (const key of old) delete all[key]
      this.got = all
      if (old.length) {
        this.saveReceived(all)
        for (const key of old)
          void blobs()
            .remove(this.gotKey(key))
            .catch(() => {})
      }
    }
    return this.got
  }

  // A kept download of this exact file (same id, hoster and hash), rebuilt with its checked type.
  async receivedFile(id: string, hoster: string, sha256: string | null): Promise<Download | null> {
    const key = copyKey(id, hoster, sha256)
    const got = this.received()
    const r = Object.hasOwn(got, key) ? got[key] : null
    if (!r || r.id !== id || r.hoster !== hoster || r.sha256 !== sha256) return null
    const blob = await blobs()
      .get(this.gotKey(key))
      .catch(() => null)
    if (!blob || blob.size !== r.size) {
      this.dropReceived(key)
      return null
    }
    const type = kindOf(r.type) !== null ? r.type : NEUTRAL_TYPE
    return {
      blob: blob.type === type ? blob : new Blob([blob], { type }),
      type,
      verified: r.verified === true,
    }
  }

  private saveReceived(got: Record<string, Received>) {
    writeLocal(this.key('rchat_p2p_got'), JSON.stringify(got))
    this.got = got
  }

  private dropReceived(key: string) {
    const got = { ...this.received() }
    if (Object.hasOwn(got, key)) {
      const { message_id } = got[key]
      if (message_id !== null) dropPreview(message_id)
      delete got[key]
      this.saveReceived(got)
    }
    void blobs()
      .remove(this.gotKey(key))
      .catch(() => {})
  }

  private keepReceived(key: string, r: Received) {
    const got = { ...this.received(), [key]: r }
    const order = Object.entries(got).sort((a, b) => a[1].at - b[1].at)
    let bytes = order.reduce((n, [, x]) => n + x.size, 0)
    let count = order.length
    for (const [old, x] of order) {
      if (old === key || (count <= RECEIVED_MAX && bytes <= RECEIVED_BYTES)) continue
      delete got[old]
      if (x.message_id !== null) dropPreview(x.message_id)
      void blobs()
        .remove(this.gotKey(old))
        .catch(() => {})
      bytes -= x.size
      count -= 1
    }
    this.saveReceived(got)
  }

  // Fetches a file from its hoster straight into the blob store: stops at the size and hash
  // the message gives (and when storage runs out), never trusts the type the peer sends.
  async download(peerId: string, id: string, opts: DownloadOpts): Promise<Download> {
    const { size, sha256, hoster, signal } = opts
    const account = this.account
    if (account === null) throw new Error('Sign in to download P2P files')
    const limit = size ?? LEGACY_MAX
    if (!Number.isSafeInteger(limit) || limit < 0)
      throw new Error('P2P download failed: file too large')
    const expect = validSha256(sha256) ? sha256 : null
    const copy = copyKey(id, hoster, sha256)
    const room = await blobs()
      .room()
      .catch(() => null)
    if (room !== null && limit > room) throw new Error(NO_ROOM)
    if (signal?.aborted) throw new Error(CANCELED)
    const key = this.gotKey(copy)
    const writer: BlobWriter = await blobs().create(key)
    return new Promise<Download>((resolve, reject) => {
      const conn = this.ensurePeer(true).connect(peerId, { reliable: true })
      const sha = new Sha256()
      const head = new Uint8Array(SNIFF_BYTES)
      let headLen = 0
      let total: number | null = null
      let got = 0
      let state: 'open' | 'ending' | 'done' = 'open'
      let chain: Promise<void> = Promise.resolve()
      // The writes not yet stored, in bytes; bounded by PENDING_MAX.
      let pending = 0
      let stored = 0
      // Set once the file is complete: settles after the writer finished (and the copy was kept).
      let ending: Promise<unknown> | null = null
      let timer: ReturnType<typeof setTimeout> | null = null
      const finish = (err: Error | null, out?: Download) => {
        if (state === 'done') return
        state = 'done'
        if (timer) clearTimeout(timer)
        timer = null
        signal?.removeEventListener('abort', canceled)
        conn.close()
        if (err) {
          void (ending ?? chain)
            .catch(() => {})
            .then(() => writer.abort())
            .then(() => blobs().remove(key))
            .catch(() => {})
          reject(err)
        } else if (out) resolve(out)
      }
      const canceled = () => finish(new Error(CANCELED))
      signal?.addEventListener('abort', canceled)
      const idle = () => {
        if (timer) clearTimeout(timer)
        timer = setTimeout(() => {
          if (state === 'open') finish(new Error('P2P download timed out'))
        }, IDLE_MS)
      }
      const take = (bytes: Uint8Array) => {
        sha.update(bytes)
        if (headLen < SNIFF_BYTES) {
          const part = bytes.subarray(0, SNIFF_BYTES - headLen)
          head.set(part, headLen)
          headLen += part.length
        }
        got += bytes.byteLength
        pending += bytes.byteLength
        if (pending > PENDING_MAX) {
          finish(new Error(SLOW_STORE))
          return
        }
        chain = chain.then(async () => {
          await writer.write(bytes)
          pending -= bytes.byteLength
          stored += bytes.byteLength
          if (state === 'open')
            void Promise.resolve(conn.send({ type: 'ack', id, got: stored })).catch(() => {})
        })
        chain.catch(() => finish(new Error(NO_ROOM)))
        opts.onProgress?.(got, total ?? got)
      }
      const end = () => {
        state = 'ending'
        if (timer) clearTimeout(timer)
        const done = chain.then(async () => {
          if (expect !== null && sha.hex() !== expect) throw new Error(MISMATCH)
          const type = safeType(head.subarray(0, headLen), opts.audio === true)
          const blob = await writer.finish(type)
          if (this.account !== account) throw new Error(CANCELED)
          const verified = expect !== null
          this.keepReceived(copy, {
            id,
            hoster,
            sha256,
            message_id: opts.messageId ?? null,
            size: got,
            type,
            verified,
            at: Date.now(),
          })
          return { blob, type, verified }
        })
        ending = done
        done.then(
          out => {
            if (state === 'done') this.dropReceived(copy)
            else finish(null, out)
          },
          (e: unknown) => finish(e instanceof Error ? e : new Error(String(e)))
        )
      }
      idle()
      conn.on('open', () => void conn.send({ type: 'get', id, chunked: true, acks: true }))
      conn.on('data', d => {
        if (state !== 'open') return
        const msg = d as WireMsg
        idle()
        if (msg?.type === 'file' && total === null) {
          const cap = Math.min(limit, LEGACY_MAX)
          if (typeof msg.data !== 'string' || msg.data.length > Math.ceil(cap / 3) * 4) {
            finish(new Error('P2P download failed: file too large'))
            return
          }
          let bytes: Uint8Array
          try {
            bytes = base64Bytes(msg.data)
          } catch {
            finish(new Error('P2P download failed: bad data'))
            return
          }
          if (bytes.length > cap || (size !== null && bytes.length !== size)) {
            finish(new Error('P2P download failed: wrong size'))
            return
          }
          total = bytes.length
          take(bytes)
          end()
        } else if (msg?.type === 'meta' && total === null) {
          if (!Number.isSafeInteger(msg.size) || msg.size < 0 || msg.size > limit)
            finish(new Error('P2P download failed: file too large'))
          else if (size !== null && msg.size !== size)
            finish(new Error('P2P download failed: wrong size'))
          else total = msg.size
        } else if (msg?.type === 'chunk' && total !== null) {
          const data: unknown = msg.data
          if (!(data instanceof ArrayBuffer || data instanceof Uint8Array))
            finish(new Error('P2P download failed: bad data'))
          else if (got + data.byteLength > total)
            finish(new Error('P2P download failed: too much data'))
          else take(data instanceof Uint8Array ? data : new Uint8Array(data))
        } else if (msg?.type === 'end' && total !== null) {
          if (got === total) end()
          else finish(new Error('P2P download failed: incomplete file'))
        } else if (msg?.type === 'busy') {
          finish(new Error('The sender is busy, try again in a moment'))
        } else finish(new Error('File not available'))
      })
      conn.on('close', () => {
        if (state === 'open') finish(new Error('P2P download interrupted'))
      })
      conn.on('error', err => {
        if (state === 'open') finish(new Error(`P2P download failed: ${err.type}`))
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
