const CACHE = 'rchat-v1'

self.addEventListener('install', () => self.skipWaiting())

self.addEventListener('activate', event => {
  event.waitUntil(
    caches
      .keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  )
})

self.addEventListener('fetch', event => {
  const { request } = event
  const url = new URL(request.url)
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api')) return
  if (url.pathname.startsWith('/_next/static') || url.pathname.startsWith('/icons')) {
    event.respondWith(
      caches.open(CACHE).then(cache =>
        cache.match(request).then(
          hit =>
            hit ??
            fetch(request).then(res => {
              if (res.ok) cache.put(request, res.clone())
              return res
            })
        )
      )
    )
    return
  }
  if (request.mode === 'navigate') {
    event.respondWith(
      caches.open(CACHE).then(cache =>
        fetch(request)
          .then(res => {
            if (res.ok) cache.put(request, res.clone())
            return res
          })
          .catch(() => cache.match(request).then(hit => hit ?? Response.error()))
      )
    )
  }
})
