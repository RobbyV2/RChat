// Which attached videos play inline, and how their download pill shows. A file's name and declared
// type are its sender's claims: they only pick the files worth trying. The bytes decide, sniffed
// before a blob URL is made or decoded by the browser from the file's own address, and a video that
// can't play keeps its file card.

import { fileKind } from './file_card'
import type { MediaMode } from './media_src'
import { PREVIEW_MAX } from './sniff'

const VIDEO_EXT = /\.(mp4|m4v|webm|mov)$/i
const VIDEO_TYPES = new Set(['video/mp4', 'video/webm', 'video/quicktime'])

const essence = (mime: string | null) => (mime ?? '').split(';')[0].trim().toLowerCase()

// A file whose kind is video and whose name or declared type is one a browser plays.
export const videoClaim = (filename: string, mime: string | null) =>
  fileKind(filename, mime) === 'video' &&
  (VIDEO_EXT.test(filename) || VIDEO_TYPES.has(essence(mime)))

export interface HostedVideoFile {
  filename: string
  mime: string | null
  size: number | null
  removed: boolean
}

// How an uploaded file plays inline: `url` from its address, `blob` from its bytes fetched with the
// credential (at most PREVIEW_MAX, like a P2P preview), or null to keep its card.
export const hostedVideo = (
  file: HostedVideoFile,
  previews: boolean,
  mode: MediaMode
): MediaMode | null => {
  if (!previews || file.removed || !videoClaim(file.filename, file.mime)) return null
  if (mode === 'blob' && (file.size === null || file.size > PREVIEW_MAX)) return null
  return mode
}

const PILL =
  'absolute top-2 right-2 z-10 flex items-center rounded-xl border border-outline-variant/40 bg-surface-container-highest/90 p-1 shadow-elevation-2 backdrop-blur-sm'
// Shown on hover and keyboard focus (not the focus a click leaves), always on touch and narrow
// screens.
const SHOWN =
  'opacity-0 group-hover/video:opacity-100 group-has-[:focus-visible]/video:opacity-100 max-md:opacity-100 pointer-coarse:opacity-100'
const MOVES =
  'scale-95 transition-[opacity,scale] duration-150 ease-out group-hover/video:scale-100 group-has-[:focus-visible]/video:scale-100 max-md:scale-100 pointer-coarse:scale-100'

// The pill over a video's top right corner; `moves`: with its fade and pop.
export const pillClass = (moves: boolean) =>
  moves ? `${PILL} ${SHOWN} ${MOVES}` : `${PILL} ${SHOWN}`

// Tallest a video is shown, in pixels (`max-h-80`).
export const VIDEO_MAX_H = 320

// The box a video of `w` by `h` pixels takes before it loads: its own size, no taller than
// VIDEO_MAX_H (the player's `max-w-full` keeps it in its column). Null without a size to go by.
export const videoBox = (w: number | undefined, h: number | undefined) => {
  if (!w || !h || w < 1 || h < 1) return null
  const width = Math.round(Math.min(w, (VIDEO_MAX_H * w) / h))
  return { width: `${width}px`, aspectRatio: `${w} / ${h}` }
}

// Fetched videos whose bytes failed to decode, by cache key, so they show their card from then
// on instead of loading again. At most `keep`, the oldest forgotten first.
export const failureMemory = (keep = 500) => {
  const failed = new Set<string>()
  const watchers = new Set<() => void>()
  const tell = () => {
    for (const w of watchers) w()
  }
  return {
    has: (key: string) => failed.has(key),
    mark: (key: string) => {
      if (failed.has(key)) return
      failed.add(key)
      if (failed.size > keep) failed.delete(failed.values().next().value as string)
      tell()
    },
    watch: (changed: () => void) => {
      watchers.add(changed)
      return () => void watchers.delete(changed)
    },
    clear: () => {
      if (!failed.size) return
      failed.clear()
      tell()
    },
  }
}

const PLAY_EVENTS = [
  'play',
  'pause',
  'ended',
  'emptied',
  'enterpictureinpicture',
  'leavepictureinpicture',
]

// Tells `playing` whether `video` plays, in a picture-in-picture window too (`inPip`), as that
// changes, and `ended` when it plays to its end; the returned stop says false.
export const watchPlaying = (
  video: Pick<HTMLVideoElement, 'paused' | 'addEventListener' | 'removeEventListener'>,
  playing: (on: boolean) => void,
  inPip: () => boolean,
  ended: () => void = () => {}
) => {
  const report = () => playing(!video.paused || inPip())
  for (const e of PLAY_EVENTS) video.addEventListener(e, report)
  video.addEventListener('ended', ended)
  return () => {
    for (const e of PLAY_EVENTS) video.removeEventListener(e, report)
    video.removeEventListener('ended', ended)
    playing(false)
  }
}

// The media error codes that say the bytes themselves can't play (MEDIA_ERR_DECODE,
// MEDIA_ERR_SRC_NOT_SUPPORTED), not that loading them failed.
const UNPLAYABLE = new Set([3, 4])

// Whether a video's failure is worth remembering past this mount: the bytes can't play, and the
// source is its owner's live URL now (a revoked one fails the same way).
export const remembersFailure = (code: number, live: boolean) => live && UNPLAYABLE.has(code)

// How long a video stays near the view before it mounts, so scrolling past doesn't load it.
export const NEAR_SETTLE_MS = 200
