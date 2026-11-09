import { minidenticon } from 'minidenticons'
import { hslHex, identiconHue, validColor } from './profile'
import { BANNER_PRESETS, contrast } from './server_colors'
import type { AvatarKind, UserRef } from './types'

const SATURATION = 95
const LIGHTNESS = 45
const DEFAULT_COLOR = '#6750a4'
export const IDENTICON_MIN_CONTRAST = 3
export const IDENTICON_PRESETS = BANNER_PRESETS
export const IDENTICON_DEFAULT_BG = { dark: '#36343b', light: '#e6e0e9' } as const

export const identiconBackground = (kind: AvatarKind, color: string | null | undefined) =>
  kind === 'identicon' && validColor(color) ? color.toLowerCase() : null

export const identiconInk = (username: string, bg: string) => {
  const hue = identiconHue(username)
  for (let step = 0; step <= 100 - LIGHTNESS; step++) {
    const fits = [LIGHTNESS + step, LIGHTNESS - step]
      .filter(light => light >= 0)
      .map(light => hslHex(hue, SATURATION / 100, light / 100))
      .map(color => ({ color, ratio: contrast(color, bg) }))
      .filter(c => c.ratio >= IDENTICON_MIN_CONTRAST)
      .sort((a, b) => b.ratio - a.ratio)
    if (fits.length > 0) return fits[0].color
  }
  return hslHex(hue, SATURATION / 100, 1)
}

export const identiconSvg = (username: string, bg: string | null) => {
  const svg = minidenticon(username, SATURATION, LIGHTNESS)
  return bg ? svg.replace(/fill="[^"]*"/, `fill="${identiconInk(username, bg)}"`) : svg
}

export interface AvatarDraft {
  kind: AvatarKind
  color: string
  background: string | null
}

export const avatarDraft = (
  user: Pick<UserRef, 'avatar_kind' | 'avatar_color'> | null
): AvatarDraft => ({
  kind: user?.avatar_kind ?? 'identicon',
  color:
    user?.avatar_kind === 'color' && validColor(user.avatar_color)
      ? user.avatar_color.toLowerCase()
      : DEFAULT_COLOR,
  background: user ? identiconBackground(user.avatar_kind, user.avatar_color) : null,
})

export const avatarColorFor = (kind: AvatarKind, color: string, background: string | null) =>
  kind === 'color' ? color : (background ?? undefined)
