import { b64u } from './canonical'
import { hashBlob, type Hashed } from './hashing'
import { thumbBytes } from './blobs'
import { downloadName, GIF_MAX, guessKind, IMAGE_HEAD, imageSize, inlineImageOk } from '../sniff'
import { LIMITS as EV } from './event'
import { LOCAL } from './limits'

// Browser side of P2P attachments: hashing in a worker, thumbnails made by the sender and
// checked again by the receiver, safe download names and free space.

type Job = { done: (h: Hashed) => void; fail: (e: Error) => void; progress?: (n: number) => void }

let worker: Worker | null = null
let seq = 0
const jobs = new Map<number, Job>()

const hashWorker = () => {
  if (worker) return worker
  const w = new Worker(new URL('./p2p.worker.ts', import.meta.url), { type: 'module' })
  w.onmessage = (e: MessageEvent) => {
    const m = e.data as { id: number; progress?: [number, number]; ok?: Hashed; err?: string }
    const job = jobs.get(m.id)
    if (!job) return
    if (m.progress) return job.progress?.(m.progress[1] ? m.progress[0] / m.progress[1] : 1)
    jobs.delete(m.id)
    if (m.ok) job.done(m.ok)
    else job.fail(new Error(m.err ?? "Couldn't read the file"))
  }
  w.onerror = () => {
    for (const j of jobs.values()) j.fail(new Error("Couldn't read the file"))
    jobs.clear()
    worker = null
  }
  worker = w
  return w
}

// Hashes off the main thread where there is a worker; `progress` gets 0..1.
export const hashFile = (file: Blob, progress?: (n: number) => void): Promise<Hashed> => {
  if (typeof window === 'undefined' || typeof Worker === 'undefined')
    return hashBlob(file, (d, t) => progress?.(t ? d / t : 1))
  return new Promise((done, fail) => {
    const id = ++seq
    jobs.set(id, { done, fail, progress })
    try {
      hashWorker().postMessage({ id, file })
    } catch {
      jobs.delete(id)
      void hashBlob(file, (d, t) => progress?.(t ? d / t : 1)).then(done, fail)
    }
  })
}

export interface Preview {
  thumb?: string
  w?: number
  h_px?: number
  dur?: number
}

const SIDE = LOCAL.files.side
const QUALITIES = LOCAL.files.qualities
const TIMEOUT_MS = LOCAL.files.timeoutMs
// Where an image header is looked for (JPEG metadata may come first), and the largest image the
// sender's own preview decodes.
const HEAD_BYTES = LOCAL.files.headBytes
const PREVIEW_PIXELS = LOCAL.files.previewPixels

const withTimeout = <T>(p: Promise<T>, ms = TIMEOUT_MS) =>
  Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error('slow')), ms))])

const jpegOf = async (
  src: CanvasImageSource,
  w: number,
  h: number
): Promise<string | undefined> => {
  const scale = Math.min(1, SIDE / Math.max(w, h))
  const tw = Math.max(1, Math.round(w * scale))
  const th = Math.max(1, Math.round(h * scale))
  for (const q of QUALITIES) {
    let blob: Blob | null
    if (typeof OffscreenCanvas !== 'undefined') {
      const c = new OffscreenCanvas(tw, th)
      const ctx = c.getContext('2d')
      if (!ctx) return undefined
      ctx.drawImage(src, 0, 0, tw, th)
      blob = await c.convertToBlob({ type: 'image/jpeg', quality: q })
    } else {
      const c = document.createElement('canvas')
      c.width = tw
      c.height = th
      const ctx = c.getContext('2d')
      if (!ctx) return undefined
      ctx.drawImage(src, 0, 0, tw, th)
      blob = await new Promise<Blob | null>(r => c.toBlob(r, 'image/jpeg', q))
    }
    if (blob && blob.size <= EV.thumb) return b64u(new Uint8Array(await blob.arrayBuffer()))
  }
  return undefined
}

const mediaMeta = (file: Blob, kind: 'video' | 'audio') =>
  new Promise<Preview>((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const el = document.createElement(kind)
    el.preload = 'metadata'
    el.muted = true
    const done = (p: Preview) => {
      URL.revokeObjectURL(url)
      el.removeAttribute('src')
      el.load()
      resolve(p)
    }
    el.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('no media'))
    }
    el.onloadedmetadata = () => {
      const dur = Number.isFinite(el.duration) ? Math.round(el.duration * 1000) : undefined
      if (kind === 'audio' || !(el instanceof HTMLVideoElement)) return done({ dur })
      const v = el
      v.onseeked = () => {
        void jpegOf(v, v.videoWidth, v.videoHeight)
          .catch(() => undefined)
          .then(thumb =>
            done({ thumb, w: v.videoWidth || undefined, h_px: v.videoHeight || undefined, dur })
          )
      }
      v.currentTime = Math.min(0.5, (v.duration || 1) / 2)
    }
    el.src = url
  })

const dim = (n: number | undefined) =>
  n !== undefined && Number.isSafeInteger(n) && n >= 1 && n <= EV.dims ? n : undefined

// Size, length and a small JPEG preview, made from the file here. What fails is left out.
export const previewOf = async (file: File): Promise<Preview> => {
  const kind = guessKind(file.name) ?? (file.type.startsWith('image/') ? 'image' : null)
  try {
    if (kind === 'image' && typeof createImageBitmap !== 'undefined') {
      // The size from the header first: an image too large to decode safely gets no preview,
      // and the rest is decoded straight to thumbnail size.
      const size = imageSize(new Uint8Array(await file.slice(0, HEAD_BYTES).arrayBuffer()))
      if (!size || size.w < 1 || size.h < 1 || size.w * size.h > PREVIEW_PIXELS) return {}
      const scale = Math.min(1, SIDE / Math.max(size.w, size.h))
      const bmp = await withTimeout(
        createImageBitmap(file, {
          resizeWidth: Math.max(1, Math.round(size.w * scale)),
          resizeHeight: Math.max(1, Math.round(size.h * scale)),
          resizeQuality: 'medium',
        })
      )
      const thumb = await jpegOf(bmp, bmp.width, bmp.height).catch(() => undefined)
      const out = { thumb, w: dim(size.w), h_px: dim(size.h) }
      bmp.close()
      return out
    }
    if (kind === 'video' || kind === 'audio') {
      const p = await withTimeout(mediaMeta(file, kind))
      return { ...p, w: dim(p.w), h_px: dim(p.h_px) }
    }
  } catch {
    // No preview; the file still goes.
  }
  return {}
}

const thumbUrls = new Map<string, Promise<string | null>>()

// A sender's thumbnail is only shown after it checks out here: JPEG bytes of at most 6 KiB whose
// header says at most 1024 px a side (checked before anything is decoded), which the browser
// then decodes, scaled down, as an image. Cached per thumbnail.
export const checkedThumb = (thumb: string | undefined): Promise<string | null> => {
  if (!thumb) return Promise.resolve(null)
  const hit = thumbUrls.get(thumb)
  if (hit) return hit
  const run = (async () => {
    const t = thumbBytes(thumb)
    if (!t || typeof createImageBitmap === 'undefined') return null
    const blob = new Blob([t.bytes as BlobPart], { type: 'image/jpeg' })
    try {
      const scale = Math.min(1, SIDE / Math.max(t.w, t.h))
      const bmp = await withTimeout(
        createImageBitmap(blob, {
          resizeWidth: Math.max(1, Math.round(t.w * scale)),
          resizeHeight: Math.max(1, Math.round(t.h * scale)),
          resizeQuality: 'low',
        }),
        3000
      )
      const ok = bmp.width > 0 && bmp.height > 0
      bmp.close()
      return ok ? URL.createObjectURL(blob) : null
    } catch {
      return null
    }
  })()
  thumbUrls.set(thumb, run)
  if (thumbUrls.size > LOCAL.files.thumbUrls) {
    const [old] = thumbUrls.keys()
    const p = thumbUrls.get(old)
    thumbUrls.delete(old)
    void p?.then(u => u && URL.revokeObjectURL(u))
  }
  return run
}

// Extensions a saved file may keep; anything else is saved as `.bin`, so a received file can't
// pass for a program or a web page.
const SAFE_EXT = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'avif',
  'mp4',
  'm4v',
  'webm',
  'mp3',
  'ogg',
  'oga',
  'opus',
  'wav',
  'weba',
  'm4a',
  'flac',
  'txt',
  'md',
  'csv',
  'json',
  'log',
  'pdf',
  'zip',
  '7z',
  'tar',
  'gz',
  'xz',
  'rar',
  'doc',
  'docx',
  'xls',
  'xlsx',
  'ppt',
  'pptx',
  'odt',
  'ods',
  'odp',
  'epub',
  'rtf',
  'mkv',
  'mov',
  'heic',
])

export const saveName = (name: string) => {
  const clean = downloadName(name)
  const m = /^(.*)\.([^.]+)$/.exec(clean)
  if (!m || !m[1]) return `${clean}.bin`
  const ext = m[2].toLowerCase()
  return SAFE_EXT.has(ext) ? clean : `${m[1]}.bin`
}

// Bytes this site may still store, or null when the browser doesn't say.
// A stored image is shown inline only when its header says it is small enough to decode safely
// (sniff.ts inlineImageOk); otherwise it stays a file to save. Nothing is decoded here.
export const imageFits = async (blob: Blob) => {
  try {
    const gif = blob.type === 'image/gif'
    if (gif && blob.size > GIF_MAX) return false
    const n = gif ? blob.size : Math.min(blob.size, IMAGE_HEAD)
    return inlineImageOk(new Uint8Array(await blob.slice(0, n).arrayBuffer()))
  } catch {
    return false
  }
}

export const storageSpace = async (): Promise<{ free: number; quota: number } | null> => {
  try {
    const est = await navigator.storage?.estimate?.()
    if (!est || est.quota === undefined) return null
    return { free: Math.max(0, est.quota - (est.usage ?? 0)), quota: est.quota }
  } catch {
    return null
  }
}

export const freeSpace = async (): Promise<number | null> => (await storageSpace())?.free ?? null

// Object URLs of files shown inline, newest last: past `max`, the oldest that nothing on screen
// uses is revoked; one in use stays until its last user lets go.
export class UrlCache {
  private urls = new Map<string, Promise<string | null>>()
  private refs = new Map<string, number>()

  constructor(
    private max: number,
    private revoke: (url: string) => void = u => URL.revokeObjectURL(u)
  ) {}

  // `make` runs once per file until it is dropped; each call is one user until `unuse`.
  use(h: string, make: () => Promise<string | null>) {
    let hit = this.urls.get(h)
    if (hit) this.urls.delete(h)
    else hit = make()
    this.urls.set(h, hit)
    this.refs.set(h, (this.refs.get(h) ?? 0) + 1)
    this.trim()
    return hit
  }

  unuse(h: string) {
    const n = (this.refs.get(h) ?? 0) - 1
    if (n > 0) this.refs.set(h, n)
    else this.refs.delete(h)
    this.trim()
  }

  // The file is gone: its URL goes, in use or not.
  drop(h: string) {
    const u = this.urls.get(h)
    if (!u) return
    this.urls.delete(h)
    void u.then(x => x && this.revoke(x))
  }

  private trim() {
    for (const h of [...this.urls.keys()]) {
      if (this.urls.size <= this.max) return
      if (!this.refs.get(h)) this.drop(h)
    }
  }
}
