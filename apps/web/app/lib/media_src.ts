import { useEffect, useState, useSyncExternalStore } from 'react'
import type { AccountSession } from './client/session'
import { ownsMediaCookie, MEDIA_COOKIE_CHANGE, type InstanceConnection } from './instances'
import { client } from './client/client'
import { useAccount } from './client/react'
import { headOf } from './p2p'
import { sharing } from './platform'
import { downloadName, NEUTRAL_TYPE, sniff, type PreviewKind } from './sniff'
import { failureMemory } from './video_attachment'
import { time } from './platform/time'
import {
  apiOriginOf,
  blobOf,
  guestMediaOf,
  mediaBlobOf,
  mediaIdOf,
  mediaUrlOf,
  previewUrlOf,
  signedInTo,
} from './asks'

// Media a URL can't load is fetched with the credential in a header and shown from a `blob:`
// URL: a guest's grant never lands in a link, the address bar or history, and an account on an
// API at another origin has no cookie there. Only images and videos recognized from their bytes
// get a typed blob, each where that kind is asked for; anything else is offered as a download.

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
  kind: PreviewKind
  // The bytes a video is expected to hold while it loads.
  hint: number
  // Starts the load, while it waits for room; null once started.
  start: (() => void) | null
  settle: (url: string | null) => void
  // On screen now: it starts before the others that wait.
  urgent: boolean
}

export const MEDIA_CACHE_BYTES = 64 * 1024 * 1024

// Object URLs by media address, least recently used first. Mounted users hold a reference: an
// entry in use is never revoked, a load nobody waits for is aborted, and unused entries are
// revoked while there are more than `keep` or their files hold more than `bytes`. An entry gets a
// URL only when its bytes sniff as the `kind` it was first asked for. Videos in use hold at most
// `bytes` together: one that would pass it waits until others are released, those on screen
// (`urge`) first.
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
    if (e.start) {
      e.start = null
      e.settle(null)
    }
  }

  const trim = () => {
    for (const [id, e] of entries) {
      if (entries.size <= keep && total <= bytes) break
      if (e.users === 0) drop(id, e)
    }
  }

  // Bytes held by videos in use, loaded or loading, but `except`.
  const videoBytes = (except: Entry) => {
    let held = 0
    for (const e of entries.values())
      if (e !== except && e.kind === 'video' && e.users > 0 && !e.start)
        held += e.done ? e.size : e.hint
    return held
  }

  // Starts the waiting loads that have users, those on screen and then the oldest first, while
  // videos keep within `bytes`.
  const admit = () => {
    const waiting = [...entries.values()].filter(e => e.start && e.users > 0)
    for (const e of [...waiting.filter(e => e.urgent), ...waiting.filter(e => !e.urgent)]) {
      if (!e.start) continue
      const held = e.kind === 'video' ? videoBytes(e) : 0
      if (held > 0 && held + e.hint > bytes) continue
      const start = e.start
      e.start = null
      start()
    }
  }

  const acquire = (id: string, load: Load, kind: PreviewKind = 'image', hint = 0) => {
    let e = entries.get(id)
    if (e) entries.delete(id)
    else {
      const ctrl = new AbortController()
      let settle: (url: string | null) => void = () => {}
      let fail: (err: unknown) => void = () => {}
      const made: Entry = {
        url: new Promise<string | null>((resolve, reject) => {
          settle = resolve
          fail = reject
        }),
        users: 0,
        ctrl,
        done: false,
        value: null,
        size: 0,
        kind,
        hint,
        start: null,
        settle: url => settle(url),
        urgent: false,
      }
      made.start = () =>
        void load(id, ctrl.signal)
          .then(async blob => {
            const seen = sniff(await headOf(blob))
            const url =
              seen?.kind === kind
                ? URL.createObjectURL(new Blob([blob], { type: seen.mime }))
                : null
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
          .then(
            url => {
              settle(url)
              admit()
            },
            (err: unknown) => {
              if (entries.get(id) === made) entries.delete(id)
              fail(err)
              admit()
            }
          )
      made.url.catch(() => {})
      e = made
    }
    e.users++
    entries.set(id, e)
    admit()
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
        admit()
      },
    }
  }

  // The URL of a loaded entry without taking it (null when its bytes weren't the kind asked
  // for), or undefined while it isn't loaded.
  const peek = (id: string) => {
    const e = entries.get(id)
    return e?.done ? e.value : undefined
  }

  // Marks an entry as on screen (or not), which lets it start before others that wait.
  const urge = (id: string, on: boolean) => {
    const e = entries.get(id)
    if (!e || e.urgent === on) return
    e.urgent = on
    if (on) admit()
  }

  const clear = () => {
    for (const [id, e] of entries) drop(id, e)
  }

  return { acquire, peek, urge, clear, size: () => entries.size, bytes: () => total }
}

// What to show of an entry: the URL a component `held` (it holds the entry, so the URL stays
// live), never one the cache only `known` of, which a trim may revoke before it is held. Only the
// cache's word that the bytes are the wrong kind (null) shows at once.
export const shownBlob = (known: string | null | undefined, held: string | null | undefined) =>
  held !== undefined ? held : known === null ? null : undefined

export function createMediaSrc(account: AccountSession) {
  const {
    conn,
    lifetime: { live },
  } = account
  const cache = blobCache(60, MEDIA_CACHE_BYTES)
  let generation = 0
  const saves = new Set<AbortController>()
  function mediaModeFor(server: string | undefined): MediaMode {
    // Only the home session owns the page cookie. Even a public URL on the same
    // host could otherwise load with a different account's credential.
    if (!conn.isHome) return 'blob'
    const page = typeof window === 'undefined' ? 'http://localhost/' : window.location.href
    if (signedInTo(conn) && !ownsMediaCookie(conn)) return 'blob'
    return mediaMode(
      apiOriginOf(conn, page),
      new URL(page).origin,
      signedInTo(conn),
      guestMediaOf(conn, server)
    )
  }

  const listeners = new Set<() => void>()
  let unwatch: (() => void) | undefined
  function subscribe(listener: () => void) {
    listeners.add(listener)
    if (!unwatch && conn.isHome && typeof window !== 'undefined') {
      let owned = ownsMediaCookie(conn)
      const changed = () => {
        owned = ownsMediaCookie(conn)
        for (const cb of listeners) cb()
      }
      const stopStore = account.store.subscribe((state, old) => {
        if (state.token !== old.token || state.guestGrants !== old.guestGrants) changed()
      })
      window.addEventListener('storage', changed)
      window.addEventListener('focus', changed)
      window.addEventListener(MEDIA_COOKIE_CHANGE, changed)
      // Cookie replacement need not emit a CookieStore change event. Check once
      // per mounted home session, including writes by tabs on other page ports.
      const timer = time().every(1000, () => {
        if (!signedInTo(conn)) return
        const current = ownsMediaCookie(conn)
        if (current !== owned) changed()
      })
      unwatch = () => {
        stopStore()
        timer()
        window.removeEventListener('storage', changed)
        window.removeEventListener('focus', changed)
        window.removeEventListener(MEDIA_COOKIE_CHANGE, changed)
      }
    }
    return () => {
      listeners.delete(listener)
      if (!listeners.size) {
        unwatch?.()
        unwatch = undefined
      }
    }
  }
  function key(plain: string, server: string | undefined, kind: PreviewKind = 'image') {
    return JSON.stringify([generation, conn.origin, server, plain, kind])
  }
  function acquire(plain: string, server?: string, kind: PreviewKind = 'image', hint = 0) {
    return cache.acquire(
      key(plain, server, kind),
      (_, signal) => blobOf(conn, plain, server, signal),
      kind,
      hint
    )
  }
  function peek(plain: string, server: string | undefined, kind: PreviewKind = 'image') {
    return cache.peek(key(plain, server, kind))
  }
  function urge(plain: string, server: string | undefined, kind: PreviewKind, on: boolean) {
    cache.urge(key(plain, server, kind), on)
  }
  const videoFailures = failureMemory()
  async function saveMedia(id: string, server: string | undefined, filename: string) {
    const ctrl = new AbortController()
    saves.add(ctrl)
    try {
      const blob = await live(mediaBlobOf(conn, id, server, ctrl.signal))
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
    videoFailures.clear()
  }
  return {
    key,
    acquire,
    peek,
    urge,
    clear,
    saveMedia,
    mediaModeFor,
    subscribe,
    videoFailures,
  }
}

export const mediaModeFor = (server: string | undefined) =>
  client.shown().media.mediaModeFor(server)
export const forgetMedia = () => client.shown().media.clear()

function useMediaMode(media: ReturnType<typeof createMediaSrc>, server: string | undefined) {
  const mode = () => media.mediaModeFor(server)
  return useSyncExternalStore(media.subscribe, mode, mode)
}

// The address to show an image (or `kind`) from: plain where media loads by URL, else a blob URL
// this component holds. Not `wanted`, a fetched file is undefined, or null when its bytes are
// known not to be `kind`. `hint`: the bytes it is expected to hold; `urgent`: it is on
// screen, so it loads before others that wait.
const useBlobSrc = (
  media: ReturnType<typeof createMediaSrc>,
  plain: string,
  server: string | undefined,
  wanted: boolean,
  fetched: boolean,
  kind: PreviewKind = 'image',
  hint = 0,
  urgent = false
) => {
  const key = media.key(plain, server, kind)
  const [blob, setBlob] = useState<{ media: typeof media; key: string; url: string | null } | null>(
    null
  )
  useEffect(() => {
    if (!fetched || !wanted) return
    let current = true
    const held = media.acquire(plain, server, kind, hint)
    held.url.then(
      url => current && setBlob({ media, key, url }),
      () => current && setBlob({ media, key, url: null })
    )
    return () => {
      current = false
      held.release()
      setBlob(null)
    }
  }, [fetched, wanted, key, media, plain, server, kind, hint])
  useEffect(() => {
    if (fetched && wanted) media.urge(plain, server, kind, urgent)
  }, [fetched, wanted, urgent, media, plain, server, kind])
  if (!fetched) return plain
  const known = media.peek(plain, server, kind)
  if (!wanted) return known === null ? null : undefined
  return shownBlob(known, blob?.media === media && blob.key === key ? blob.url : undefined)
}

export const useMediaSrc = (id: string, server: string | undefined, wanted: boolean) => {
  const account = useAccount()
  const { media } = account
  return useBlobSrc(
    media,
    mediaUrlOf(account, id),
    server,
    wanted,
    useMediaMode(media, server) === 'blob'
  )
}

// The address to play an uploaded video of `size` bytes from: plain where media loads by URL,
// else a blob URL of bytes that sniff as a video (null when they don't, undefined while they load
// or aren't `wanted`).
export const useVideoSrc = (
  id: string,
  server: string | undefined,
  wanted: boolean,
  size: number,
  urgent = false
) => {
  const account = useAccount()
  const { media } = account
  const fetched = useMediaMode(media, server) === 'blob'
  return useBlobSrc(media, mediaUrlOf(account, id), server, wanted, fetched, 'video', size, urgent)
}

// Only the primary account on the page's API may display an arbitrary image URL.
function linkedImage(conn: InstanceConnection, src: string, page: string) {
  const origin = apiOriginOf(conn, page)
  const pageOrigin = new URL(page).origin
  const primary = conn.isHome && conn.origin === pageOrigin && origin === pageOrigin
  try {
    const url = new URL(src, primary ? page : origin)
    const href = primary ? src : url.href
    if (url.origin === origin && ['http:', 'https:'].includes(url.protocol))
      return { href, id: mediaIdOf(conn, url.href), direct: primary }
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
  const account = useAccount()
  const { conn, media } = account
  const link =
    src && instanceMessage
      ? linkedImage(
          conn,
          src,
          typeof window === 'undefined' ? 'http://localhost/' : window.location.href
        )
      : null
  const id = link?.id ?? null
  const mode = useMediaMode(media, server)
  const fetched = !link?.direct || mode === 'blob'
  const held = useBlobSrc(
    media,
    mediaUrlOf(account, id ?? ''),
    server,
    previews && id !== null,
    fetched
  )
  const href = link?.href ?? src
  if (!previews) return { href, shown: null }
  if (id !== null && fetched) return { href, shown: held }
  return { href, shown: link?.direct && (!signedInTo(account) || mode === 'url') ? href : null }
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
  const account = useAccount()
  const { media } = account
  const fetched = useMediaMode(media, server) === 'blob'
  const src = useBlobSrc(
    media,
    path === null ? '' : previewUrlOf(account, path),
    server,
    path !== null,
    fetched
  )
  return path === null ? null : src
}

export const saveMedia = (id: string, server: string | undefined, filename: string) =>
  client.shown().media.saveMedia(id, server, filename)
