import { sessionStore } from './instances'

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
