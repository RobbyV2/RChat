import { useEffect, useState } from 'react'
import { api } from './instances'
import { headOf } from './p2p'
import { sharing } from './platform'
import { downloadName, NEUTRAL_TYPE, sniff } from './sniff'

// Media a URL can't load is fetched with the credential in a header and shown from a `blob:`
// URL: a guest's grant never lands in a link, the address bar or history, and an account on an
// API at another origin has no cookie there. Only images recognized from their bytes get a
// typed blob; anything else is offered as a download.

export type MediaMode = 'url' | 'blob'

// `url` where the page's own cookie reaches the API or nothing is needed, `blob` for a guest
// with a grant and for an account whose API is not at the page's origin.
export const mediaMode = (
  apiOrigin: string,
  pageOrigin: string,
  token: boolean,
  grant: boolean
): MediaMode => {
  if (token) return apiOrigin === pageOrigin ? 'url' : 'blob'
  return grant ? 'blob' : 'url'
}

// How the media of `server` (undefined outside servers) loads right now.
export const mediaModeFor = (server: string | undefined) => {
  const page = typeof window === 'undefined' ? 'http://localhost/' : window.location.href
  return mediaMode(api.origin(page), new URL(page).origin, api.signedIn(), api.guestMedia(server))
}

type Load = (id: string, signal: AbortSignal) => Promise<Blob>

interface Entry {
  url: Promise<string | null>
  users: number
  ctrl: AbortController
  done: boolean
  value: string | null
  size: number
}

export const MEDIA_CACHE_BYTES = 64 * 1024 * 1024

// Object URLs by media address, least recently used first. Mounted users hold a reference: an
// entry in use is never revoked, a load nobody waits for is aborted, and unused entries are
// revoked while there are more than `keep` or their images hold more than `bytes`.
export const blobCache = (
  keep: number,
  bytes: number,
  revoke = (url: string) => URL.revokeObjectURL(url)
) => {
  const entries = new Map<string, Entry>()
  let total = 0

  const drop = (id: string, e: Entry) => {
    entries.delete(id)
    total -= e.size
    e.size = 0
    if (e.value) revoke(e.value)
    if (!e.done) e.ctrl.abort()
  }

  const trim = () => {
    for (const [id, e] of entries) {
      if (entries.size <= keep && total <= bytes) break
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
        size: 0,
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
        if (url) {
          made.size = blob.size
          total += blob.size
          trim()
        }
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

  return { acquire, clear, size: () => entries.size, bytes: () => total }
}

const cache = blobCache(60, MEDIA_CACHE_BYTES)

export const forgetMedia = () => cache.clear()

// The address to show an image from: `plain` where media loads by URL, else a `blob:` URL
// (undefined while it loads, null when it failed or the bytes are not an image).
const useBlobSrc = (plain: string, server: string | undefined, wanted: boolean) => {
  const fetched = mediaModeFor(server) === 'blob'
  const [blob, setBlob] = useState<{ key: string; url: string | null } | null>(null)
  useEffect(() => {
    if (!fetched || !wanted) return
    let live = true
    const held = cache.acquire(plain, (_, signal) => api.authedBlob(plain, server, signal))
    held.url.then(
      url => live && setBlob({ key: plain, url }),
      () => live && setBlob({ key: plain, url: null })
    )
    return () => {
      live = false
      held.release()
    }
  }, [fetched, wanted, plain, server])
  if (!fetched) return plain
  return blob?.key === plain ? blob.url : undefined
}

export const useMediaSrc = (id: string, server: string | undefined, wanted: boolean) =>
  useBlobSrc(api.mediaUrl(id), server, wanted)

// An image a message names by address. One of this instance's media files loads like an
// attachment; any other address is shown as it is.
export const useLinkedSrc = (src: string | undefined, server: string | undefined, on: boolean) => {
  const id = src === undefined ? null : api.mediaId(src)
  const held = useBlobSrc(api.mediaUrl(id ?? ''), server, on && id !== null)
  return id === null || mediaModeFor(server) === 'url' ? src : held
}

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
  const src = useBlobSrc(path === null ? '' : api.previewUrl(path), server, path !== null)
  return path === null ? null : src
}

export const saveMedia = async (id: string, server: string | undefined, filename: string) => {
  const blob = await api.mediaBlob(id, server)
  sharing().saveBlob(downloadName(filename), new Blob([blob], { type: NEUTRAL_TYPE }))
}
