import { altError, altToSend } from '../../alt_text'
import { instanceLabel } from '../../instance_label'
import { writeLocal } from '../../instances'
import { fitContent, LIMITS as EV, type Attachment } from '../content'
import { assemble, EMPTY_VIEW, offText } from '../blobs'
import type { Hashed } from '../hashing'
import { checkedThumb, hashFile, imageFits, previewOf, saveName, UrlCache } from '../files'
import { kindOf, NEUTRAL_TYPE } from '../../sniff'
import { sharing } from '../../platform'
import type { FileView, PendingFile } from './store'
import type { IdentityScope, P2pParts } from './scope'

// The attachments of a message: as many thumbnails as fit, the last ones dropped first.
export const fitAttachments = (body: string, list: Attachment[]): Attachment[] | null =>
  fitContent({ body, att: list })?.att ?? null

export const TOO_MANY_FILES = 'These files have names too long to send in one message.'

export const FILES_MAX_TEXT = `You can attach up to ${EV.att} files to a message.`

export const PREPARING_TEXT = 'Files are still being prepared.'

export function createAttachmentsPart(
  parts: Pick<P2pParts, 'dms' | 'store' | 'account'>,
  scope: IdentityScope
) {
  const state = parts.store
  const { useP2p, p2pHost, readAuto, autoKey } = state

  // ----- Attachments -----

  function channelTextOnly(key: string) {
    const [room, ch] = key.split('#')[0].split('/')
    return !!ch && useP2p.getState().servers[room]?.channels.some(c => c.id === ch && c.text_only)
  }

  const sizes = new Map<string, number>()

  const fileTimers = new Map<string, ReturnType<typeof setTimeout>>()

  const recordOf = (h: string) => {
    const s = parts.dms.dbNow()
    return s ? s.db.get('blobs', h).catch(() => undefined) : Promise.resolve(undefined)
  }

  const refreshFile = async (h: string) => {
    const size = sizes.get(h)
    if (size === undefined) return
    const database = parts.dms.dbNow()
    const rec = await recordOf(h)
    if (database !== parts.dms.dbNow() || !sizes.has(h)) return
    const v = state.dms ? state.dms.blobs.view(h, size) : { ...EMPTY_VIEW, total: size }
    const paused = (!rec?.wanted && v.state === 'none' && state.dms?.paused.get(h)) || null
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

  const scheduleFile = (h: string) => {
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
    useP2p.setState(st => ({
      attaching: { ...st.attaching, [room]: fn(st.attaching[room] ?? []) },
    }))

  const patchPending = (room: string, id: number, patch: Partial<PendingFile>) =>
    setPending(room, list => list.map(p => (p.id === id ? { ...p, ...patch } : p)))

  const clipText = (s: string, chars: number, bytes: number) => {
    let out = Array.from(s).slice(0, chars).join('')
    while (new TextEncoder().encode(out).length > bytes) out = Array.from(out).slice(0, -1).join('')
    return out
  }

  const cleanMime = (t: string) => (/^[\x21-\x7e]{1,127}$/.test(t) ? t : 'application/octet-stream')

  const p2pFiles = {
    // A tile is shown: keep its state current and ask who has it.
    watch(att: Pick<Attachment, 'h' | 'size'>) {
      sizes.set(att.h, att.size)
      void refreshFile(att.h).then(async () => {
        const d = state.dms
        const v = useP2p.getState().files[att.h]
        if (!d || v?.state === 'done' || p2pHost.textOnly()) return
        await d.blobs.availability(att.h).catch(() => 0)
        void refreshFile(att.h)
      })
    },

    async download(att: Attachment) {
      sizes.set(att.h, att.size)
      const d = state.dms
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
      await state.dms?.blobs.cancel(h).catch(() => {})
      void refreshFile(h)
    },

    // The stored file as a URL, for the passive players only (by its sniffed type). Each call is
    // one tile using it until `unuse`.
    url(h: string): Promise<string | null> {
      return urls.use(h, async () => {
        const s = parts.dms.dbNow()
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

    // The stored file's URL while it is live (made by `url` and not dropped since).
    liveUrl: (h: string) => urls.current(h),

    thumb: (thumb: string | undefined) => checkedThumb(thumb, state.limits),

    // Saves a stored file under a safe name, as plain bytes (never opened).
    async save(att: Attachment) {
      const current = parts.dms.currentSession()
      const s = parts.dms.dbNow()
      const blob = s ? await assemble(s.db, att.h).catch(() => null) : null
      if (!current()) return
      if (!blob) return p2pHost.toast('This file is not on this device yet.')
      sharing(scope.owner, current).saveBlob(
        saveName(att.name),
        new Blob([blob], { type: NEUTRAL_TYPE })
      )
    },

    add(room: string, files: File[]) {
      if (p2pHost.textOnly() || channelTextOnly(room) || files.length === 0) return
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
        void previewOf(file, state.limits.files).then(preview =>
          patchPending(room, id, { preview })
        )
      }
    },

    remove: (room: string, id: number) => setPending(room, list => list.filter(p => p.id !== id)),

    toggleSpoiler: (room: string, id: number) =>
      setPending(room, list => list.map(p => (p.id === id ? { ...p, spoiler: !p.spoiler } : p))),

    setAlt: (room: string, id: number, alt: string) =>
      setPending(room, list => list.map(p => (p.id === id ? { ...p, alt } : p))),

    clear: (room: string) => setPending(room, () => []),

    // Keeps the files here and returns them as message attachments; null (with a toast) when they
    // can't go yet.
    async stage(room: string, body: string): Promise<Attachment[] | null> {
      const list = useP2p.getState().attaching[room] ?? []
      const d = state.dms
      if (!list.length || !d) return []
      if (channelTextOnly(room)) {
        p2pHost.toast('Remove the files to send text in this channel.')
        return null
      }
      if (p2pHost.textOnly()) {
        p2pHost.toast(offText(instanceLabel(scope.owner.conn.info, scope.owner.conn.host)))
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
      const tooLong = list.map(p => altError(p.alt ?? '')).find(e => e !== null)
      if (tooLong) {
        p2pHost.toast(tooLong)
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
        const alt = altToSend(p.alt)
        if (alt) a.alt = alt
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
      const u = state.dms ? await state.dms.blobs.usage().catch(() => null) : null
      useP2p.setState({ fileUsage: u })
      return u
    },

    async clearOlder(days: number) {
      const n = (await state.dms?.blobs.clearOlder(days).catch(() => 0)) ?? 0
      for (const h of sizes.keys()) void refreshFile(h)
      await p2pFiles.usage()
      void parts.account.p2p.refreshStorage()
      return n
    },

    readAuto: () => readAuto(useP2p.getState().account),

    writeAuto(patch: Partial<{ dm: number; server: number; daily: number }>) {
      const user = useP2p.getState().account
      if (!user || !scope.current(user)) return
      writeLocal(scope.scoped(autoKey(user)), JSON.stringify({ v: 1, ...readAuto(user), ...patch }))
    },
  }

  scope.onReset(() => {
    for (const timer of fileTimers.values()) clearTimeout(timer)
    fileTimers.clear()
    sizes.clear()
    big.clear()
    urls.clear()
  })
  return { scheduleFile, fitAttachments, TOO_MANY_FILES, FILES_MAX_TEXT, PREPARING_TEXT, p2pFiles }
}
