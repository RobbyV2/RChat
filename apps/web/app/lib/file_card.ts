// What a file card shows for a file: its kind's icon, its name split from the extension, and when
// it expires. The name and the mime type are the sender's claims: the kind only picks an icon and
// never decides how a file is opened.

import { FileCode, Image as ImageIcon, Play, type LucideIcon } from 'lucide-react'
import type { Target } from './actions/types'
import { fileLang } from './code'
import { expiryText } from './rules'

export type FileKind =
  | 'archive'
  | 'document'
  | 'spreadsheet'
  | 'slides'
  | 'audio'
  | 'video'
  | 'code'
  | 'text'
  | 'image'
  | 'generic'

const EXTENSIONS: [FileKind, string][] = [
  ['archive', 'zip rar 7z tar gz tgz bz2 xz zst iso dmg'],
  ['document', 'pdf doc docx odt rtf pages epub'],
  ['spreadsheet', 'xls xlsx ods csv tsv numbers'],
  ['slides', 'ppt pptx odp key'],
  ['audio', 'mp3 wav flac ogg oga opus m4a aac mid'],
  ['video', 'mp4 webm mov mkv avi m4v'],
  ['image', 'png jpg jpeg gif webp avif bmp svg heic tif tiff'],
  ['text', 'txt md log ini cfg conf'],
  ['code', 'json yaml yml toml xml html sh'],
]

const BY_EXT = new Map(
  EXTENSIONS.flatMap(([kind, list]) => list.split(' ').map(ext => [ext, kind] as const))
)

const MIMES: [RegExp, FileKind][] = [
  [/^image\//, 'image'],
  [/^audio\//, 'audio'],
  [/^video\//, 'video'],
  [
    /^application\/(zip|x-zip-compressed|x-7z-compressed|x-rar|x-rar-compressed|vnd\.rar|x-tar|gzip|x-gzip|x-bzip2|x-xz|zstd|x-iso9660-image|x-apple-diskimage)$/,
    'archive',
  ],
  [
    /^application\/(pdf|msword|rtf|epub\+zip|vnd\.oasis\.opendocument\.text|vnd\.openxmlformats-officedocument\.wordprocessingml\.document)$/,
    'document',
  ],
  [
    /^(text\/(csv|tab-separated-values)|application\/(vnd\.ms-excel|vnd\.oasis\.opendocument\.spreadsheet|vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet))$/,
    'spreadsheet',
  ],
  [
    /^application\/(vnd\.ms-powerpoint|vnd\.oasis\.opendocument\.presentation|vnd\.openxmlformats-officedocument\.presentationml\.presentation)$/,
    'slides',
  ],
  [
    /^(application\/(json|xml|javascript|x-sh|x-yaml|yaml|toml)|text\/(html|xml|javascript|css|x-[\w.+-]+))$/,
    'code',
  ],
  [/^text\//, 'text'],
]

const mimeKind = (mime: string): FileKind => {
  const type = mime.split(';')[0].trim().toLowerCase()
  return MIMES.find(([re]) => re.test(type))?.[1] ?? 'generic'
}

// `.tar.gz` and the like count as one extension.
const DOUBLE = /\.tar\.(gz|bz2|xz|zst)$/i
const SINGLE = /\.[A-Za-z0-9]{1,10}$/

// The name's last extension (with its dot, as written) and the rest. Dotfiles, names ending in a
// dot and names that are only an extension have none.
export const splitName = (name: string): { base: string; ext: string } => {
  const m = DOUBLE.exec(name) ?? SINGLE.exec(name)
  if (!m || m.index === 0) return { base: name, ext: '' }
  return { base: name.slice(0, m.index), ext: name.slice(m.index) }
}

// The extension decides; the mime type only when the extension is unknown and says more than
// "some bytes".
export const fileKind = (name: string, mime: string | null): FileKind => {
  const ext = splitName(name).ext.split('.').pop()?.toLowerCase() ?? ''
  const known = BY_EXT.get(ext)
  if (known) return known
  const lang = fileLang(name)
  if (lang !== null) return lang === 'plaintext' || lang === 'markdown' ? 'text' : 'code'
  if (mime && mime.split(';')[0].trim().toLowerCase() !== 'application/octet-stream')
    return mimeKind(mime)
  return 'generic'
}

// `shown` (the name as the viewer's filter shows it, as long as `name`) cut where `name` is:
// [base, shown base, extension, shown extension]. A mask of another length keeps it whole.
export const splitShown = (name: string, shown: string): [string, string, string, string] => {
  const { base, ext } = splitName(name)
  const chars = Array.from(shown)
  if (chars.length !== Array.from(name).length) return [name, shown, '', '']
  const cut = Array.from(base).length
  return [base, chars.slice(0, cut).join(''), ext, chars.slice(cut).join('')]
}

const DAY = 86_400

// The line under a file that expires (seconds since the epoch): "Expired", "Expires in 5 hours"
// within a day, else "Expires on Nov 25, 2029" in the local time zone.
export const expiryLabel = (
  expiresAt: number | null,
  now: number,
  locale?: string
): string | null => {
  if (expiresAt === null) return null
  const left = expiresAt - now
  if (left <= 0) return 'Expired'
  if (left < DAY) return expiryText(left)
  const day = new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', year: 'numeric' })
  return `Expires on ${day.format(expiresAt * 1000)}`
}

// The full local date and time a file expires, for the line's hover title.
export const expiryTitle = (expiresAt: number, locale?: string) =>
  new Intl.DateTimeFormat(locale, { dateStyle: 'full', timeStyle: 'short' }).format(
    expiresAt * 1000
  )

// A download's progress in whole percent.
export const pct = (p: { got: number; total: number } | undefined) =>
  p && p.total > 0 ? Math.min(100, Math.floor((p.got / p.total) * 100)) : 0

// A download button's label and hover title for the shown name; `hint` follows in the title only.
export const primaryText = (verb: 'Download' | 'Save', shown: string, hint?: string) => {
  const label = `${verb} ${shown}`
  return { label, title: hint ? `${label} ${hint}` : label }
}

// A card's button beside its main one, also in its menu. `hint`: words after the label in the
// button's title.
export interface FileExtra {
  kind: 'image' | 'preview' | 'audio' | 'video'
  hint?: string
  run(): void
}

export const EXTRAS: Record<FileExtra['kind'], { label: string; icon: LucideIcon }> = {
  image: { label: 'Show image', icon: ImageIcon },
  preview: { label: 'Show preview', icon: FileCode },
  audio: { label: 'Play audio', icon: Play },
  video: { label: 'Play video', icon: Play },
}

// What a card's menu acts on, as the card is now: `name` as shown, `verb` its main button's
// ("Save" for a P2P file on the device), `download` while one may start, `cancel` while one
// runs, `extra` its other buttons, `link` the instance's address of a file it hosts, `remove`
// takes the attachment off its message for whoever may.
export interface FileMenu {
  name: string
  verb: 'Download' | 'Save'
  download: (() => void) | null
  cancel: (() => void) | null
  extra: FileExtra[]
  link: string | null
  remove: (() => void) | null
}

// What a caller gives a card's or video's menu besides its buttons.
export type FileMenuOwn = Pick<FileMenu, 'download' | 'link'> & { remove?: (() => void) | null }

// The menu of a card showing `shown`: Cancel in place of the download while one runs, and the
// other buttons only while the card shows them.
export const cardMenu = (
  shown: string,
  card: {
    primary: { label: 'Download' | 'Save' }
    progress: { got: number; total: number } | null
    onCancel?: () => void
    extra?: FileExtra[]
    menu: FileMenuOwn
  }
): FileMenu => {
  const cancel = card.progress && card.onCancel ? card.onCancel : null
  return {
    name: shown,
    verb: card.primary.label,
    download: cancel ? null : card.menu.download,
    cancel,
    extra: card.progress ? [] : (card.extra ?? []),
    link: card.menu.link,
    remove: card.menu.remove ?? null,
  }
}

// A card's menu target: `now` reads the card as it is, null once it is gone.
export const fileTarget = (now: () => FileMenu | null): Target => ({ kind: 'file', now })
