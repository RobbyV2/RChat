import { identiconInk } from './identicon'
import { validColor } from './profile'
import type { ServerIconKind } from './server_about'
import { onColor } from './server_colors'

export interface IconLook {
  // The tile's own background, and the ink on it; null keeps the tile's theme colors.
  bg: string | null
  fg: string | null
}

// How a server icon is colored: on the server's color when it has one, with readable ink.
export const iconLook = (kind: ServerIconKind, seed: string, color: string | null | undefined) => {
  const bg = validColor(color) ? color.toLowerCase() : null
  if (!bg) return { bg: null, fg: null }
  return { bg, fg: kind === 'identicon' ? identiconInk(seed, bg) : onColor(bg) }
}
