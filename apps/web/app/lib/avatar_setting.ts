import { hslHex, identiconHue, validColor } from './profile'
import type { AvatarKind } from './types'

// What this device draws for people: their pictures, their own built-in avatars, or one
// built-in kind for everyone.
export const AVATAR_MODES = ['pictures', 'builtin', 'identicon', 'color'] as const
export type AvatarMode = (typeof AVATAR_MODES)[number]

export const AVATAR_MODE_LABELS: Record<AvatarMode, string> = {
  pictures: 'Show profile pictures',
  builtin: 'Built-in avatars only',
  identicon: 'Identicons for everyone',
  color: 'Colors for everyone',
}

export const AVATAR_MODE_CHOICES: readonly { value: AvatarMode; label: string }[] = [
  { value: 'pictures', label: 'Pictures' },
  { value: 'builtin', label: 'Built-in avatars' },
  { value: 'identicon', label: 'All identicons' },
  { value: 'color', label: 'All colors' },
]

export const AVATAR_MODE_NOTES: Record<AvatarMode, string> = {
  pictures: 'Uploaded pictures load over the built-in avatars.',
  builtin: 'Everyone shows the identicon or color they chose. No pictures load.',
  identicon: 'Everyone shows an identicon, whatever they chose. No pictures load.',
  color: 'Everyone shows a color, whatever they chose. No pictures load.',
}

// A stored value as a mode: anything else is the default.
export const parseAvatarMode = (raw: unknown): AvatarMode =>
  (AVATAR_MODES as readonly unknown[]).includes(raw) ? (raw as AvatarMode) : 'pictures'

export interface AvatarFacts {
  username: string
  avatar_kind: AvatarKind
  avatar_color: string | null
}

export interface AvatarView {
  // What this device draws.
  mode: AvatarMode
  // Streamer mode hides what can identify people.
  streamer: boolean
  // Whether the place the picture comes from serves pictures.
  served: boolean
}

// The color everyone without one of their own gets when colors are forced: their identicon's.
export const ownColor = (username: string) => hslHex(identiconHue(username), 0.6, 0.45)

// The built-in avatar this device draws for someone: their own, or the forced kind.
export function builtIn(
  person: AvatarFacts,
  mode: AvatarMode
): { kind: AvatarKind; color: string | null } {
  const color = validColor(person.avatar_color) ? person.avatar_color.toLowerCase() : null
  switch (mode) {
    case 'pictures':
    case 'builtin':
      return { kind: person.avatar_kind, color: person.avatar_color }
    case 'identicon':
      return { kind: 'identicon', color: person.avatar_kind === 'identicon' ? color : null }
    case 'color':
      return {
        kind: 'color',
        color: person.avatar_kind === 'color' && color ? color : ownColor(person.username),
      }
  }
}

// Whether pictures are fetched and drawn at all.
export const picturesShown = (view: AvatarView) =>
  view.mode === 'pictures' && !view.streamer && view.served
