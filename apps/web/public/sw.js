/* global TransformStream, TextEncoder, crypto, setTimeout, clearTimeout */
const CACHE = 'rchat-v3'

const asset = url => url.pathname.startsWith('/_next/static') || url.pathname.startsWith('/icons')
const html = res => (res.headers.get('content-type') || '').includes('text/html')

self.addEventListener('install', () => self.skipWaiting())

self.addEventListener('activate', event => {
  event.waitUntil(
    caches
      .keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  )
})

// A launched share stays in memory only until its new document collects it.
const shares = new Map()
const fileBytes = 8 * 1024 * 1024
const textBytes = 64 * 1024
// Allow MIME headers and boundaries in addition to the supported content.
const bodyLimit = fileBytes + textBytes + 64 * 1024
const lifetime = 120000
let parsing = 0

class ShareError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

async function readShare(request) {
  const tooLarge = () =>
    new ShareError(
      413,
      'Share is too large. Choose up to 8 files totaling 8 MiB and up to 64 KiB of text.'
    )
  if (Number(request.headers.get('Content-Length')) > bodyLimit) throw tooLarge()
  const type = request.headers.get('Content-Type') || ''
  if (!request.body || !/^multipart\/form-data\s*;/i.test(type))
    throw new ShareError(400, 'Choose text or files and share them to RChat again.')

  let bytes = 0
  const bounded = request.body.pipeThrough(
    new TransformStream({
      transform(chunk, controller) {
        bytes += chunk.byteLength
        if (bytes > bodyLimit) throw tooLarge()
        controller.enqueue(chunk)
      },
    })
  )
  let form
  try {
    form = await new Response(bounded, { headers: { 'Content-Type': type } }).formData()
  } catch (e) {
    if (bytes > bodyLimit) throw tooLarge()
    throw e
  }

  const fields = new Map()
  const files = []
  let size = 0
  for (const [key, value] of form) {
    if (key === 'files' && typeof value !== 'string') {
      if (!value.name && !value.size) continue // empty browser file input
      size += value.size
      if (files.length >= 8 || size > fileBytes) throw tooLarge()
      files.push(value)
    } else if (
      ['title', 'text', 'url'].includes(key) &&
      typeof value === 'string' &&
      !fields.has(key)
    ) {
      if (new TextEncoder().encode(value).length > textBytes) throw tooLarge()
      fields.set(key, value)
    } else throw new ShareError(400, 'Unexpected share field. Choose text or files and try again.')
  }
  const text = [
    ...new Set(['title', 'text', 'url'].map(key => fields.get(key)).filter(v => v?.trim())),
  ].join('\n')
  if (new TextEncoder().encode(text).length > textBytes) throw tooLarge()
  if (!text && !files.length)
    throw new ShareError(400, 'The share is empty. Choose text or files and try again.')
  return { payload: { text, files }, bytes }
}

function expireShares() {
  for (const share of shares.values()) if (Date.now() >= share.expires) share.finish()
}

self.addEventListener('message', event => {
  if (event.data?.kind !== 'receive-share' || !event.ports[0]) return
  expireShares()
  const share = shares.get(event.data.ticket)
  if (share && event.source?.url && new URL(event.source.url).origin === self.location.origin) {
    event.ports[0].postMessage(share.payload)
    share.finish()
  } else event.ports[0].postMessage(null)
})

self.addEventListener('fetch', event => {
  const { request } = event
  const url = new URL(request.url)
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api')) return

  if (request.method === 'POST' && url.pathname === '/share-target/') {
    let release
    const collected = new Promise(resolve => {
      release = resolve
    })
    event.waitUntil(collected)
    event.respondWith(
      (async () => {
        try {
          const busy = () =>
            new ShareError(
              429,
              'RChat has pending shares. Open them or wait two minutes, then try again.'
            )
          if (parsing >= 2) throw busy()
          parsing++
          let result
          try {
            result = await readShare(request)
          } finally {
            parsing--
          }
          expireShares()
          let total = result.bytes
          for (const share of shares.values()) total += share.bytes
          if (shares.size >= 8 || total > 2 * bodyLimit) throw busy()
          const ticket = crypto.randomUUID()
          const timer = setTimeout(() => finish(), lifetime)
          const finish = () => {
            clearTimeout(timer)
            shares.delete(ticket)
            release()
          }
          shares.set(ticket, { ...result, expires: Date.now() + lifetime, finish })
          return Response.redirect(url.origin + '/?receive-share=' + ticket, 303)
        } catch (e) {
          release()
          return new Response(
            e instanceof ShareError
              ? e.message
              : 'Could not read the share. Choose text or files and try again.',
            {
              status: e instanceof ShareError ? e.status : 400,
              headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
            }
          )
        }
      })()
    )
    return
  }
  if (request.method !== 'GET') return
  if (url.pathname === '/widget/' || url.pathname === '/widget') return

  if (asset(url)) {
    event.respondWith(
      caches.open(CACHE).then(async cache => {
        const hit = await cache.match(request)
        if (hit && !html(hit)) return hit
        const res = await fetch(request)
        if (res.ok && !html(res)) cache.put(request, res.clone())
        return res
      })
    )
    return
  }

  if (request.mode === 'navigate') {
    const page = `${url.origin}${url.pathname}`
    event.respondWith(
      caches.open(CACHE).then(cache =>
        fetch(request)
          .then(res => {
            if (res.ok && html(res)) cache.put(page, res.clone())
            return res
          })
          .catch(() => cache.match(page).then(hit => hit ?? Response.error()))
      )
    )
  }
})
