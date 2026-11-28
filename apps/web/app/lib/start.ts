import { storedCredential } from './client/credentials'
import { accountStorage } from './client/keys'
import { awaitingInstance, readLocal } from './instances'
import { client } from './client/client'
import { AVATARS_KEY, STREAMER_KEY, keptTheme } from './theme/device'
import { parseAvatarMode } from './avatar_setting'

// The streamer mode kept in this browser, or null when nothing is readable.
const keptStreamer = () => {
  const kept = readLocal(STREAMER_KEY)
  return kept === null ? null : kept === '1'
}

// What this device draws for people, as kept in this browser; null when nothing is readable.
const keptAvatarMode = () => {
  const kept = readLocal(AVATARS_KEY)
  return kept === null ? null : parseAvatarMode(kept)
}

// Puts the kept theme, streamer mode or avatar choice in place; with nothing kept, this tab's
// stays (dark, off and pictures at first).
export const restoreTheme = (account = client.shown()) => {
  const st = account.store.getState()
  st.setTheme(keptTheme() ?? st.theme)
}
export const restoreStreamer = (account = client.shown()) => {
  const st = account.store.getState()
  st.setStreamer(keptStreamer() ?? st.streamer)
  st.setAvatarMode(keptAvatarMode() ?? st.avatarMode)
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
