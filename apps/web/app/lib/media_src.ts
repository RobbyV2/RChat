import { useEffect, useState } from 'react'
import { api } from './instances'
import { headOf } from './p2p'
import { sharing } from './platform'
import { downloadName, NEUTRAL_TYPE, sniff } from './sniff'

// Media for guests is fetched with the grant in a header and shown from a `blob:` URL, so the
// grant never lands in a link, the address bar or history. Only images recognized from their
// bytes get a typed blob; anything else is offered as a download.

type Load = (id: string, signal: AbortSignal) => Promise<Blob>

interface Entry {
  url: Promise<string | null>
  users: number
  ctrl: AbortController
  done: boolean
  value: string | null
}

// Object URLs by media id, least recently used first. Mounted users hold a reference: an entry
// in use is never revoked, a load nobody waits for is aborted, and unused entries past `keep`
// are revoked.
export const blobCache = (keep: number, revoke = (url: string) => URL.revokeObjectURL(url)) => {
  const entries = new Map<string, Entry>()

  const drop = (id: string, e: Entry) => {
    entries.delete(id)
    if (e.value) revoke(e.value)
    if (!e.done) e.ctrl.abort()
  }

  const trim = () => {
    for (const [id, e] of entries) {
      if (entries.size <= keep) break
      if (e.users === 0) drop(id, e)
    }
  }

  const acquire = (id: string, load: Load) => {
    let e = entries.get(id)
    if (e) entries.delete(id)
    else {
      const ctrl = new AbortController()
      const made: Entry = {
        url: Promise.resolve(null),
        users: 0,
        ctrl,
        done: false,
        value: null,
      }
      made.url = load(id, ctrl.signal).then(async blob => {
        const seen = sniff(await headOf(blob))
        const url =
          seen?.kind === 'image' ? URL.createObjectURL(new Blob([blob], { type: seen.mime })) : null
        made.done = true
        if (ctrl.signal.aborted) {
          if (url) revoke(url)
          return null
        }
        made.value = url
        return url
      })
      made.url.catch(() => {
        if (entries.get(id) === made) entries.delete(id)
      })
      e = made
    }
    e.users++
    entries.set(id, e)
    trim()
    const held = e
    let live = true
    return {
      url: held.url,
      release: () => {
        if (!live) return
        live = false
        held.users--
        if (held.users > 0 || entries.get(id) !== held) return
        if (!held.done) drop(id, held)
        else trim()
      },
    }
  }

  const clear = () => {
    for (const [id, e] of entries) drop(id, e)
  }

  return { acquire, clear, size: () => entries.size }
}

const cache = blobCache(60)

export const forgetGuestMedia = () => cache.clear()

// The address to show an image from: `plain` for signed-in users, a `blob:` URL for guests
// (undefined while it loads, null when it failed or the bytes are not an image).
const useBlobSrc = (key: string, plain: string, server: string | undefined, wanted: boolean) => {
  const guest = api.guestMedia(server)
  const [blob, setBlob] = useState<{ key: string; url: string | null } | null>(null)
  useEffect(() => {
    if (!guest || !wanted || server === undefined) return
    let live = true
    const held = cache.acquire(key, (_, signal) => api.blobAt(plain, server, signal))
    held.url.then(
      url => live && setBlob({ key, url }),
      () => live && setBlob({ key, url: null })
    )
    return () => {
      live = false
      held.release()
    }
  }, [guest, wanted, key, plain, server])
  if (!guest) return plain
  return blob?.key === key ? blob.url : undefined
}

export const useMediaSrc = (id: string, server: string | undefined, wanted: boolean) =>
  useBlobSrc(id, api.mediaUrl(id), server, wanted)

// Link preview images are served by this instance, which fetched them; the page's image host
// is never contacted. `image_url` must name exactly this preview's path on the instance,
// anything else is never loaded.
export const previewPath = (messageId: number, ord: number, imageUrl: string | null) => {
  if (imageUrl === null) return null
  const m = /^\/api(?:\/v1)?(\/messages\/(\d+)\/embeds\/(\d+)\/image\?v=[0-9a-f]{1,64})$/.exec(
    imageUrl
  )
  if (!m || Number(m[2]) !== messageId || Number(m[3]) !== ord) return null
  return m[1]
}

export const usePreviewSrc = (path: string | null, server: string | undefined) => {
  const url = path === null ? '' : api.previewUrl(path)
  const src = useBlobSrc(`preview:${url}`, url, server, path !== null)
  return path === null ? null : src
}

export const saveGuestMedia = async (id: string, server: string, filename: string) => {
  const blob = await api.mediaBlob(id, server)
  sharing().saveBlob(downloadName(filename), new Blob([blob], { type: NEUTRAL_TYPE }))
}
