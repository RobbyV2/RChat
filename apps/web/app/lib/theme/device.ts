import { readLocal, writeLocal } from '../instances'
import type { Theme } from '../types'

// Where the app keeps this device's theme and streamer mode. The docs site reads and writes the
// same keys.
export const THEME_KEY = 'rchat_theme'
export const STREAMER_KEY = 'rchat_streamer'
// Where the app keeps what this device draws for people (avatar_setting.ts).
export const AVATARS_KEY = 'rchat_avatars'

// The theme a kept value names: light, or dark for any other value; null when nothing is kept.
export const parseTheme = (raw: string | null): Theme | null =>
  raw === null ? null : raw === 'light' ? 'light' : 'dark'

export const keptTheme = () => parseTheme(readLocal(THEME_KEY))

// Shows `theme` on this page.
export function showTheme(theme: Theme) {
  if (typeof document === 'undefined') return
  document.documentElement.dataset.theme = theme
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', theme === 'dark' ? '#141218' : '#fef7ff')
}

// Keeps `theme` as this device's theme and shows it.
export function keepTheme(theme: Theme) {
  writeLocal(THEME_KEY, theme)
  showTheme(theme)
}
