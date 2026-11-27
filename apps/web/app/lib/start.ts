import { storedCredential } from './client/credentials'
import { accountStorage } from './client/keys'
import { awaitingInstance, readLocal } from './instances'
import { client } from './client/client'
import { keptTheme } from './theme/device'

// The streamer mode kept in this browser, or null when nothing is readable.
const keptStreamer = () => {
  const kept = readLocal('rchat_streamer')
  return kept === null ? null : kept === '1'
}

// Puts the kept theme or streamer mode in place; with nothing kept, this tab's stays (dark and
// off at first).
export const restoreTheme = (account = client.shown()) => {
  const st = account.store.getState()
  st.setTheme(keptTheme() ?? st.theme)
}
export const restoreStreamer = (account = client.shown()) => {
  const st = account.store.getState()
  st.setStreamer(keptStreamer() ?? st.streamer)
}

// A session kept in this browser for this connection: a token or a guest visit.
export const keptSession = (conn = client.shown().conn, target?: string | null) =>
  !!(
    storedCredential(conn, client.book.getState(), target) ||
    (typeof target !== 'string' && readLocal(accountStorage(conn).key('rchat_guest')))
  )

// The first step of every app page: a session of this tab or kept in this browser starts, an
// invite or config link opens signed out, and anything else goes to `toLogin`.
export const startApp = async (toLogin: () => void, account = client.shown()) => {
  const st = account.store.getState()
  restoreStreamer(account)
  if (awaitingInstance(account.conn)) {
    toLogin()
    return
  }
  if (!st.token && !st.guest && !keptSession(account.conn, account.credentialTarget)) {
    if (st.syncInvite() || st.syncConfigLink()) await st.loadSettings()
    else toLogin()
    return
  }
  await st.bootstrap()
}
