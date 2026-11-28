import { parsePic, picWire, type P2pPic } from './p2p/pictures'
import { charCount, charsLeft, cleanBio } from './rules'

// A server's about: a short description and the look of its icon. Hosted servers keep them in
// `description` and `icon_kind`; P2P servers in the `about` register ({text, icon, pic}).

export const ABOUT_MAX = 300

const ABOUT_WARN = 30

export type ServerIconKind = 'letter' | 'identicon'

export const ICON_KINDS: readonly { kind: ServerIconKind; label: string }[] = [
  { kind: 'letter', label: 'Letter' },
  { kind: 'identicon', label: 'Pattern' },
]

export interface ServerAbout {
  text: string | null
  icon: ServerIconKind
  // The uploaded picture of a P2P server, as P2P files. A hosted server's is `icon_image`.
  pic?: P2pPic
}

export const NO_ABOUT: ServerAbout = { text: null, icon: 'letter' }

export const iconKind = (x: unknown): ServerIconKind => (x === 'identicon' ? 'identicon' : 'letter')

export const cleanAbout = cleanBio

export const aboutError = (text: string) =>
  charCount(cleanAbout(text)) > ABOUT_MAX
    ? `Description must be at most ${ABOUT_MAX} characters`
    : null

export const aboutAnnouncement = (count: number) => charsLeft(ABOUT_MAX - count, ABOUT_WARN)

const clipped = (text: string, max: number) => Array.from(text).slice(0, max).join('')

// A description as it shows: cleaned, at most `max` characters, nothing when blank.
export const aboutText = (x: unknown, max = ABOUT_MAX): string | null => {
  if (typeof x !== 'string') return null
  const text = clipped(cleanAbout(x), max)
  return text === '' ? null : text
}

export const hostedAbout = (s: { description?: string | null; icon_kind?: string | null }) => ({
  text: aboutText(s.description),
  icon: iconKind(s.icon_kind),
})

// The `about` register of a P2P server, read field by field: a malformed field reads as unset.
export const p2pAbout = (c: unknown): ServerAbout => {
  if (c === null || typeof c !== 'object' || Array.isArray(c)) return NO_ABOUT
  const r = c as Record<string, unknown>
  const pic = parsePic(r.pic)
  return { text: aboutText(r.text), icon: iconKind(r.icon), ...(pic ? { pic } : {}) }
}

export interface AboutChange {
  text?: string | null
  icon?: ServerIconKind
  // A P2P server's picture: null removes it.
  pic?: P2pPic | null
}

// What a save changes: only the fields that differ from what is saved.
export const aboutChange = (saved: ServerAbout, text: string, icon: ServerIconKind) => {
  const out: AboutChange = {}
  const next = cleanAbout(text) || null
  if (next !== saved.text) out.text = next
  if (icon !== saved.icon) out.icon = icon
  return out.text === undefined && out.icon === undefined ? null : out
}

// The next `about` write: the admitted content with only our fields changed, so fields a
// newer app wrote stay.
export const p2pAboutContent = (
  current: Record<string, unknown> | null,
  change: AboutChange
): Record<string, unknown> => {
  const out: Record<string, unknown> = { ...(current ?? {}) }
  if (change.text !== undefined) {
    if (change.text === null) delete out.text
    else out.text = clipped(cleanAbout(change.text), ABOUT_MAX)
  }
  if (change.icon !== undefined) out.icon = change.icon
  if (change.pic !== undefined) {
    if (change.pic === null) delete out.pic
    else out.pic = picWire(change.pic)
  }
  return out
}

export const hostedAboutPatch = (change: AboutChange) => ({
  ...(change.text !== undefined ? { description: change.text } : {}),
  ...(change.icon !== undefined ? { icon_kind: change.icon } : {}),
})
