import { home, writeLocal } from '../../instances'
import { fitContent, LIMITS as EV, type Attachment } from '../event'
import { assemble, EMPTY_VIEW } from '../blobs'
import type { Hashed } from '../hashing'
import { LOCAL } from '../limits'
import { checkedThumb, hashFile, imageFits, previewOf, saveName, UrlCache } from '../files'
import { kindOf, NEUTRAL_TYPE } from '../../sniff'
import { sharing } from '../../platform'
import { dbNow } from './dms'
import { dms, useP2p, p2pHost, readAuto, autoKey, type FileView, type PendingFile } from './store'
import { p2p } from './account'

// ----- Attachments -----

const sizes = new Map<string, number>()

const fileTimers = new Map<string, ReturnType<typeof setTimeout>>()

const recordOf = (h: string) => {
  const s = dbNow()
  return s ? s.db.get('blobs', h).catch(() => undefined) : Promise.resolve(undefined)
}

const refreshFile = async (h: string) => {
  const size = sizes.get(h)
  if (size === undefined) return
  const rec = await recordOf(h)
  const v = dms ? dms.blobs.view(h, size) : { ...EMPTY_VIEW, total: size }
  const paused = (!rec?.wanted && v.state === 'none' && dms?.paused.get(h)) || null
  const next: FileView = rec?.done
    ? {
        ...v,
        state: 'done',
        got: size,
        type: rec.type,
        own: rec.own,
        paused: null,
        tooBig: big.has(h),
      }
    : { ...v, own: false, paused }
  if (!rec?.done) dropUrl(h)
  const cur = useP2p.getState().files[h]
  if (cur && JSON.stringify(cur) === JSON.stringify(next)) return
  useP2p.setState(st => ({ files: { ...st.files, [h]: next } }))
}

export const scheduleFile = (h: string) => {
  if (fileTimers.has(h)) return
  fileTimers.set(
    h,
    setTimeout(() => {
      fileTimers.delete(h)
      void refreshFile(h)
    }, 100)
  )
}

// Object URLs of stored files shown inline (only of types sniffing allows).
const urls = new UrlCache(24)

// Stored images whose header says they are too large to show inline.
const big = new Set<string>()

const dropUrl = (h: string) => urls.drop(h)

let pendingSeq = 0

const setPending = (room: string, fn: (list: PendingFile[]) => PendingFile[]) =>
  useP2p.setState(st => ({ attaching: { ...st.attaching, [room]: fn(st.attaching[room] ?? []) } }))

const patchPending = (room: string, id: number, patch: Partial<PendingFile>) =>
  setPending(room, list => list.map(p => (p.id === id ? { ...p, ...patch } : p)))

const clipText = (s: string, chars: number, bytes: number) => {
  let out = Array.from(s).slice(0, chars).join('')
  while (new TextEncoder().encode(out).length > bytes) out = Array.from(out).slice(0, -1).join('')
  return out
}

const cleanMime = (t: string) => (/^[\x21-\x7e]{1,127}$/.test(t) ? t : 'application/octet-stream')

// The attachments of a message: as many thumbnails as fit, the last ones dropped first.
export const fitAttachments = (body: string, list: Attachment[]): Attachment[] | null =>
  fitContent({ body, att: list })?.att ?? null

export const TOO_MANY_FILES = 'These files have names too long to send in one message.'

export const FILES_MAX_TEXT = `You can attach up to ${EV.att} files to a message.`

export const PREPARING_TEXT = 'Files are still being prepared.'

export const BIG_FILE = LOCAL.files.bigFile

export const p2pFiles = {
  // A tile is shown: keep its state current and ask who has it.
  watch(att: Pick<Attachment, 'h' | 'size'>) {
    sizes.set(att.h, att.size)
    void refreshFile(att.h).then(async () => {
      const d = dms
      const v = useP2p.getState().files[att.h]
      if (!d || v?.state === 'done' || p2pHost.textOnly()) return
      await d.blobs.availability(att.h).catch(() => 0)
      void refreshFile(att.h)
    })
  },

  async download(att: Attachment) {
    sizes.set(att.h, att.size)
    const d = dms
    if (!d) return
    d.paused.delete(att.h)
    try {
      await d.blobs.download(att)
    } catch (e) {
      p2pHost.toast(e instanceof Error ? e.message : String(e))
    }
    void refreshFile(att.h)
  },

  async cancel(h: string) {
    await dms?.blobs.cancel(h).catch(() => {})
    void refreshFile(h)
  },

  // The stored file as a URL, for the passive players only (by its sniffed type). Each call is
  // one tile using it until `unuse`.
  url(h: string): Promise<string | null> {
    return urls.use(h, async () => {
      const s = dbNow()
      const blob = s ? await assemble(s.db, h).catch(() => null) : null
      if (!blob || kindOf(blob.type) === null) return null
      if (kindOf(blob.type) === 'image' && !(await imageFits(blob))) {
        big.add(h)
        void refreshFile(h)
        return null
      }
      return URL.createObjectURL(blob)
    })
  },

  unuse: (h: string) => urls.unuse(h),

  thumb: checkedThumb,

  // Saves a stored file under a safe name, as plain bytes (never opened).
  async save(att: Attachment) {
    const s = dbNow()
    const blob = s ? await assemble(s.db, att.h).catch(() => null) : null
    if (!blob) return p2pHost.toast('This file is not on this device yet.')
    sharing().saveBlob(saveName(att.name), new Blob([blob], { type: NEUTRAL_TYPE }))
  },

  add(room: string, files: File[]) {
    if (p2pHost.textOnly() || files.length === 0) return
    const have = useP2p.getState().attaching[room]?.length ?? 0
    const take = files.slice(0, Math.max(0, EV.att - have))
    if (take.length < files.length) p2pHost.toast(FILES_MAX_TEXT)
    for (const file of take) {
      const id = ++pendingSeq
      setPending(room, list => [
        ...list,
        { id, file, spoiler: false, progress: 0, hashed: null, preview: null, error: null },
      ])
      let last = 0
      hashFile(file, n => {
        if (n - last < 0.02 && n < 1) return
        last = n
        patchPending(room, id, { progress: n })
      }).then(
        hashed => patchPending(room, id, { hashed, progress: 1 }),
        () => patchPending(room, id, { error: "Couldn't read this file" })
      )
      void previewOf(file).then(preview => patchPending(room, id, { preview }))
    }
  },

  remove: (room: string, id: number) => setPending(room, list => list.filter(p => p.id !== id)),

  toggleSpoiler: (room: string, id: number) =>
    setPending(room, list => list.map(p => (p.id === id ? { ...p, spoiler: !p.spoiler } : p))),

  clear: (room: string) => setPending(room, () => []),

  // Keeps the files here and returns them as message attachments; null (with a toast) when they
  // can't go yet.
  async stage(room: string, body: string): Promise<Attachment[] | null> {
    const list = useP2p.getState().attaching[room] ?? []
    const d = dms
    if (!list.length || !d) return []
    if (p2pHost.textOnly()) {
      p2pHost.toast('Attachments are turned off on this instance.')
      return null
    }
    if (list.some(p => p.error)) {
      p2pHost.toast('Remove the files that could not be read.')
      return null
    }
    if (list.some(p => !p.hashed || p.preview === null)) {
      p2pHost.toast(PREPARING_TEXT)
      return null
    }
    const seen = new Set<string>()
    const att: Attachment[] = []
    for (const p of list) {
      const hashed = p.hashed as Hashed
      if (seen.has(hashed.h)) continue
      seen.add(hashed.h)
      const a: Attachment = {
        h: hashed.h,
        size: hashed.size,
        blocks: hashed.blocks.length,
        name: clipText(p.file.name.trim() || 'file', EV.attName, EV.attNameBytes) || 'file',
        mime: cleanMime(p.file.type),
      }
      if (p.spoiler) a.spoiler = true
      const pv = p.preview ?? {}
      if (pv.w) a.w = pv.w
      if (pv.h_px) a.h_px = pv.h_px
      if (pv.dur !== undefined) a.dur = pv.dur
      if (pv.thumb) a.thumb = pv.thumb
      att.push(a)
    }
    const fitted = fitAttachments(body, att)
    if (!fitted) {
      p2pHost.toast(TOO_MANY_FILES)
      return null
    }
    try {
      for (const p of list) await d.blobs.putOwn(p.file, p.hashed as Hashed)
    } catch (e) {
      p2pHost.toast(e instanceof Error ? e.message : String(e))
      return null
    }
    return fitted
  },

  async usage() {
    const u = dms ? await dms.blobs.usage().catch(() => null) : null
    useP2p.setState({ fileUsage: u })
    return u
  },

  async clearOlder(days: number) {
    const n = (await dms?.blobs.clearOlder(days).catch(() => 0)) ?? 0
    for (const h of sizes.keys()) void refreshFile(h)
    await p2pFiles.usage()
    void p2p.refreshStorage()
    return n
  },

  readAuto: () => readAuto(useP2p.getState().account),

  writeAuto(patch: Partial<{ dm: number; server: number; daily: number }>) {
    const user = useP2p.getState().account
    if (!user) return
    writeLocal(home.scoped(autoKey(user)), JSON.stringify({ v: 1, ...readAuto(user), ...patch }))
  },
}
