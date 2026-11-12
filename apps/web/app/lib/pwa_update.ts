// When the page reloads for a service worker. The worker takes its pages over as soon as it is
// active (`clients.claim` in `public/sw.js`). On a first visit there was no worker before, so
// nothing is stale and the page stays as it is, with what the user started in it. A worker
// found while another one controls the page is an update: the page reloads once, when the new
// worker is active, to run the new build.
export const updateWatch = () => {
  let reloading = false
  // `controlled`: a worker controlled the page when the new one was found. The result tells,
  // for each state the new worker reaches, whether to reload now.
  return (controlled: boolean) => (state: ServiceWorkerState) => {
    if (!controlled || state !== 'activated' || reloading) return false
    reloading = true
    return true
  }
}

interface Worker {
  state: ServiceWorkerState
  addEventListener: (type: 'statechange', listener: () => void) => void
}

interface Registration {
  installing: Worker | null
  waiting: Worker | null
  addEventListener: (type: 'updatefound', listener: () => void) => void
}

// Watches a registration for updates. A worker already on its way in when the page registered
// (another tab started the update) is watched like one found later. `controlled`: a worker
// controls the page now.
export const trackUpdates = (reg: Registration, controlled: () => boolean, reload: () => void) => {
  const found = updateWatch()
  const seen = new WeakSet<Worker>()
  const watch = (next: Worker | null) => {
    if (!next || seen.has(next)) return
    seen.add(next)
    const reloads = found(controlled())
    next.addEventListener('statechange', () => {
      if (reloads(next.state)) reload()
    })
  }
  watch(reg.installing ?? reg.waiting)
  reg.addEventListener('updatefound', () => watch(reg.installing))
}
