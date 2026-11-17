import { home, readLocal } from './instances'
import { useStore } from './store'
import type { Theme } from './types'

// The theme and streamer mode kept in this browser, or null when nothing is readable.
const keptTheme = (): Theme | null => {
  const kept = readLocal('rchat_theme')
  return kept === null ? null : kept === 'light' ? 'light' : 'dark'
}
const keptStreamer = () => {
  const kept = readLocal('rchat_streamer')
  return kept === null ? null : kept === '1'
}

// Puts the kept theme or streamer mode in place; with nothing kept, this tab's stays (dark and
// off at first).
export const restoreTheme = () => {
  const st = useStore.getState()
  st.setTheme(keptTheme() ?? st.theme)
}
export const restoreStreamer = () => {
  const st = useStore.getState()
  st.setStreamer(keptStreamer() ?? st.streamer)
}

// A session kept in this browser for the home instance: a token or a guest visit.
export const keptSession = () =>
  !!(readLocal(home.scoped('rchat_token')) || readLocal(home.scoped('rchat_guest')))

// The first step of every app page: a session of this tab or kept in this browser starts, an
// invite or config link opens signed out, and anything else goes to `toLogin`.
export const startApp = async (toLogin: () => void) => {
  const st = useStore.getState()
  restoreStreamer()
  if (!st.token && !st.guest && !keptSession()) {
    if (st.syncInvite() || st.syncConfigLink()) await st.loadSettings()
    else toLogin()
    return
  }
  await st.bootstrap()
}
