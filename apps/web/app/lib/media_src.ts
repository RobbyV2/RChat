import { useEffect, useState } from 'react'
import type { AccountSession } from './client/session'
import type { InstanceConnection } from './instances'
import { client } from './client/client'
import { useAccount } from './client/react'
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

export function createMediaSrc(account: AccountSession) {
  const {
    conn,
    lifetime: { live },
  } = account
  const cache = blobCache(60, MEDIA_CACHE_BYTES)
  let generation = 0
  const saves = new Set<AbortController>()
  const { api } = conn
  function mediaModeFor(server: string | undefined): MediaMode {
    // Only the home session owns the page cookie. Even a public URL on the same
    // host could otherwise load with a different account's credential.
    if (!conn.isHome) return 'blob'
    const page = typeof window === 'undefined' ? 'http://localhost/' : window.location.href
    return mediaMode(api.origin(page), new URL(page).origin, api.signedIn(), api.guestMedia(server))
  }
  function key(plain: string, server: string | undefined) {
    return JSON.stringify([generation, conn.origin, server, plain])
  }
  function acquire(plain: string, server?: string) {
    return cache.acquire(key(plain, server), (_, signal) => api.authedBlob(plain, server, signal))
  }
  async function saveMedia(id: string, server: string | undefined, filename: string) {
    const ctrl = new AbortController()
    saves.add(ctrl)
    try {
      const blob = await live(api.mediaBlob(id, server, ctrl.signal))
      if (!ctrl.signal.aborted)
        sharing(account).saveBlob(downloadName(filename), new Blob([blob], { type: NEUTRAL_TYPE }))
    } finally {
      saves.delete(ctrl)
    }
  }
  function clear() {
    ++generation
    cache.clear()
    for (const ctrl of saves) ctrl.abort()
    saves.clear()
  }
  return { key, acquire, clear, saveMedia, mediaModeFor }
}

export const mediaModeFor = (server: string | undefined) =>
  client.shown().media.mediaModeFor(server)
export const forgetMedia = () => client.shown().media.clear()

// The address to show an image from: plain where media loads by URL, else a blob URL.
const useBlobSrc = (
  media: ReturnType<typeof createMediaSrc>,
  plain: string,
  server: string | undefined,
  wanted: boolean,
  fetched = media.mediaModeFor(server) === 'blob'
) => {
  const key = media.key(plain, server)
  const [blob, setBlob] = useState<{ media: typeof media; key: string; url: string | null } | null>(
    null
  )
  useEffect(() => {
    if (!fetched || !wanted) return
    let current = true
    const held = media.acquire(plain, server)
    held.url.then(
      url => current && setBlob({ media, key, url }),
      () => current && setBlob({ media, key, url: null })
    )
    return () => {
      current = false
      held.release()
    }
  }, [fetched, wanted, key, media, plain, server])
  if (!fetched) return plain
  return wanted && blob?.media === media && blob.key === key ? blob.url : undefined
}

export const useMediaSrc = (id: string, server: string | undefined, wanted: boolean) => {
  const { api, media } = useAccount()
  return useBlobSrc(media, api.mediaUrl(id), server, wanted)
}

// Only the primary account on the page's API may display an arbitrary image URL.
function linkedImage(conn: InstanceConnection, src: string, page: string) {
  const origin = conn.api.origin(page)
  const pageOrigin = new URL(page).origin
  const primary = conn.isHome && conn.origin === pageOrigin && origin === pageOrigin
  try {
    const url = new URL(src, primary ? page : origin)
    const href = primary ? src : url.href
    if (url.origin === origin && ['http:', 'https:'].includes(url.protocol))
      return { href, id: conn.api.mediaId(url.href), direct: primary }
    return { href, id: null, direct: false }
  } catch {
    return { href: src, id: null, direct: false }
  }
}

export const useLinkedSrc = (
  src: string | undefined,
  server: string | undefined,
  instanceMessage: boolean,
  previews: boolean
) => {
  const { conn, api, media } = useAccount()
  const link =
    src && instanceMessage
      ? linkedImage(
          conn,
          src,
          typeof window === 'undefined' ? 'http://localhost/' : window.location.href
        )
      : null
  const id = link?.id ?? null
  const fetched = !link?.direct || media.mediaModeFor(server) === 'blob'
  const held = useBlobSrc(media, api.mediaUrl(id ?? ''), server, previews && id !== null, fetched)
  const href = link?.href ?? src
  if (!previews) return { href, shown: null }
  if (id !== null && fetched) return { href, shown: held }
  return { href, shown: link?.direct ? href : null }
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
  const { api, media } = useAccount()
  const src = useBlobSrc(media, path === null ? '' : api.previewUrl(path), server, path !== null)
  return path === null ? null : src
}

export const saveMedia = (id: string, server: string | undefined, filename: string) =>
  client.shown().media.saveMedia(id, server, filename)
