import { charCount, charsLeft, cleanBio } from './rules'

// A description of an attached image, for people who can't see it. Hosted messages keep it in
// `media.alt`; P2P attachments in `alt`, and an edit may change them through `alts` (by the
// attachment's root hash).

export const ALT_MAX = 1000

const ALT_WARN = 50

export const cleanAlt = cleanBio

export const altError = (text: string) =>
  charCount(cleanAlt(text)) > ALT_MAX
    ? `Image description must be at most ${ALT_MAX} characters`
    : null

export const altAnnouncement = (count: number) => charsLeft(ALT_MAX - count, ALT_WARN)

// A description as it shows: cleaned, at most `ALT_MAX` characters, nothing when blank or not
// text.
export const altText = (x: unknown): string | null => {
  if (typeof x !== 'string') return null
  const text = Array.from(cleanAlt(x)).slice(0, ALT_MAX).join('')
  return text === '' ? null : text
}

// What a send carries: the cleaned description, or nothing.
export const altToSend = (draft: string | undefined) => altText(draft ?? '') ?? undefined

// The descriptions an edit sets, by root hash, read field by field: anything that is not text
// is left out.
export const editAlts = (c: unknown): Record<string, string | null> => {
  if (c === null || typeof c !== 'object') return {}
  const alts = (c as { alts?: unknown }).alts
  if (alts === null || typeof alts !== 'object' || Array.isArray(alts)) return {}
  const out: Record<string, string | null> = {}
  for (const [h, text] of Object.entries(alts as Record<string, unknown>))
    if (typeof text === 'string') out[h] = altText(text)
  return out
}

// A P2P message's attachments with their descriptions as its latest edit leaves them.
export const withAlts = <T extends { h: string; alt?: unknown }>(
  att: readonly T[],
  edit: unknown
): (Omit<T, 'alt'> & { alt?: string })[] => {
  const set = editAlts(edit)
  return att.map(a => {
    const { alt, ...rest } = a
    const text = Object.hasOwn(set, a.h) ? set[a.h] : altText(alt)
    return text === null ? rest : { ...rest, alt: text }
  })
}

// The `alts` of an edit that changes the description of attachment `h` (null removes it).
export const altsEdit = (h: string, text: string) => ({ [h]: altText(text) ?? '' })

export const IMAGE_MIME = /^image\/(png|jpe?g|gif|webp|avif|bmp|svg\+xml)$/i

const IMAGE_NAME = /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i

// Whether a file is an image that shows inline and so can carry a description.
export const describableFile = (name: string, mime: string | null | undefined) =>
  IMAGE_MIME.test(mime ?? '') || IMAGE_NAME.test(name)

// Whether a hosted message's file can carry a description.
export const describable = (
  m: { removed: boolean; mime: string | null; filename: string } | null | undefined
) => !!m && !m.removed && describableFile(m.filename, m.mime)

// The descriptions a P2P edit carries: every image's as it shows now, with `change` applied.
// An edit's descriptions replace the earlier ones, so each edit carries them all.
export const editAltsFor = (
  att: readonly { h: string; name: string; mime: string; alt?: unknown }[],
  change?: { h: string; text: string }
): Record<string, string> | undefined => {
  const images = att.filter(a => describableFile(a.name, a.mime))
  if (!images.length) return undefined
  return Object.fromEntries(
    images.map(a => [a.h, altText(change && a.h === change.h ? change.text : a.alt) ?? ''])
  )
}
