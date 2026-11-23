import type { AccountSession } from './session'

function loadHome(): AccountSession {
  // Load the store on first use when a caller only imports the client.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getHomeSession } = require('../store') as typeof import('../store')
  return getHomeSession()
}

export const client = { shown: loadHome }

export function shownMenu() {
  if (client.shown === loadHome)
    throw new Error('The store is not bound yet: import store.ts first')
  return client.shown().store.menu
}
