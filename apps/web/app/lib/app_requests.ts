import { sessionStore } from './instances'
import { time } from './platform/time'

// What another page of the app (the docs) asks the app to open when it hands the tab back.
export type AppRequest = 'add_instance'

const KEY = 'rchat_app_request'

export const askApp = (request: AppRequest) => sessionStore.setItem(KEY, request)

// The request waiting for the app, once: reading it clears it.
export function takeAppRequest(): AppRequest | null {
  const asked = sessionStore.getItem(KEY)
  if (asked === null) return null
  sessionStore.removeItem(KEY)
  return asked === 'add_instance' ? asked : null
}

// The desktop app's docs open in a window of their own: they ask the app's main window instead,
// which answers when it takes the request.
const CHANNEL = 'rchat_app_requests'
const ANSWER_MS = 500

export function askAppWindow(request: AppRequest): Promise<boolean> {
  if (typeof BroadcastChannel === 'undefined') return Promise.resolve(false)
  const channel = new BroadcastChannel(CHANNEL)
  const id = Math.random().toString(36).slice(2)
  return new Promise(resolve => {
    const done = (taken: boolean) => {
      cancel()
      channel.close()
      resolve(taken)
    }
    const cancel = time().after(ANSWER_MS, () => done(false))
    channel.onmessage = e => {
      if (e.data?.taken === id) done(true)
    }
    channel.postMessage({ request, id })
  })
}

// Takes the requests other windows of this app send; returns the function that stops.
export function answerAppRequests(take: (request: AppRequest) => void) {
  if (typeof BroadcastChannel === 'undefined') return () => {}
  const channel = new BroadcastChannel(CHANNEL)
  channel.onmessage = e => {
    const { request, id } = (e.data ?? {}) as { request?: unknown; id?: unknown }
    if (request !== 'add_instance' || typeof id !== 'string') return
    channel.postMessage({ taken: id })
    take(request)
  }
  return () => channel.close()
}
