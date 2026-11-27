'use client'

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react'
import { Download, X } from 'lucide-react'
import { useAccount } from '../lib/client/react'
import { cardMenu, pct, primaryText, type FileMenuOwn } from '../lib/file_card'
import { useMotionPlays } from '../lib/motion/use_motion'
import { useMask } from '../lib/store'
import {
  NEAR_SETTLE_MS,
  pillClass,
  remembersFailure,
  videoBox,
  watchPlaying,
} from '../lib/video_attachment'
import { longPress } from './context_menu'
import { useFileMenu, type FilePrimary } from './file_card'
import { time } from '../lib/platform/time'
import type { Cancel } from '../lib/clock'

interface VideoProps {
  src: string
  // The name as sent; `own` and `fileMask` pick how the viewer's filter shows it.
  name: string
  primary: FilePrimary
  // A download the pill started, which it then cancels.
  progress?: { got: number; total: number } | null
  onCancel?: () => void
  // The size the sender gave, to hold the video's place before it loads.
  w?: number
  h?: number
  // Its own size once it knows it.
  onBox?: (box: { w: number; h: number }) => void
  data?: Record<`data-${string}`, string>
  // Under the player.
  children?: ReactNode
}

export interface VideoAttachmentProps extends VideoProps {
  own: boolean
  fileMask: boolean
  // What the menu may do besides the pill: start a download (null while none may), copy the
  // instance's address of a file it hosts, and remove the attachment.
  menu: FileMenuOwn
  // Shown instead when the video can't play.
  fallback: ReactNode
  // For bytes already on the device (a `blob:` source): what to remember a failure to play them
  // by, so the card shows from then on, and whether a source is their owner's live URL now.
  // Other failures last for this mount: the next one tries again.
  remember?: { key: string; live: (src: string) => boolean }
  // Whether it plays, in a picture-in-picture window too; false once it is gone.
  onPlaying?: (playing: boolean) => void
  // When it plays to its end.
  onEnded?: () => void
}

const button =
  'flex size-9 items-center justify-center rounded-lg text-on-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:opacity-40 max-md:size-11 pointer-coarse:size-11'

// A ref for a video that tells `onPlaying` whether it plays (in a picture-in-picture window too),
// and false once it is gone, and `onEnded` when it plays to its end.
function usePlaying(
  onPlaying: ((playing: boolean) => void) | undefined,
  onEnded: (() => void) | undefined
) {
  const tell = useRef({ onPlaying, onEnded })
  useEffect(() => {
    tell.current = { onPlaying, onEnded }
  })
  return useCallback((video: HTMLVideoElement | null) => {
    if (!video) return
    return watchPlaying(
      video,
      on => tell.current.onPlaying?.(on),
      () => document.pictureInPictureElement === video,
      () => tell.current.onEnded?.()
    )
  }, [])
}

// A video in a message, hosted or P2P, playing inline with a download pill over its corner and the
// file menu on right-click and long-press, which acts on the video as it is when a row runs. In a
// row in selection mode those open the row's menu instead. A video that fails to play shows
// `fallback`.
export function VideoAttachment({
  own,
  fileMask,
  menu,
  fallback,
  remember,
  onPlaying,
  onEnded,
  ...video
}: VideoAttachmentProps) {
  const { media } = useAccount()
  const shown = useMask(own, fileMask)(video.name)
  const moves = useMotionPlays()
  const open = useFileMenu(cardMenu(shown, { ...video, progress: video.progress ?? null, menu }))
  const videoRef = usePlaying(onPlaying, onEnded)
  const known = () => remember !== undefined && media.videoFailures.has(remember.key)
  const remembered = useSyncExternalStore(media.videoFailures.watch, known, known)
  const [failedSrc, setFailedSrc] = useState<string | null>(null)
  if (remembered || failedSrc === video.src) return fallback
  return (
    <VideoAttachmentBody
      {...video}
      shown={shown}
      moves={moves}
      open={open}
      videoRef={videoRef}
      onError={code =>
        remember && remembersFailure(code, remember.live(video.src))
          ? media.videoFailures.mark(remember.key)
          : setFailedSrc(video.src)
      }
    />
  )
}

// The player for `shown`, the name as the filter shows it; `moves`: the pill fades in. `open`: its
// menu, none when right-click and long-press belong to the row.
export function VideoAttachmentBody({
  src,
  shown,
  primary,
  progress,
  onCancel,
  w,
  h,
  onBox,
  data,
  children,
  moves,
  open,
  videoRef,
  onError,
}: VideoProps & {
  shown: string
  moves: boolean
  open: ((x: number, y: number) => void) | null
  videoRef?: (video: HTMLVideoElement | null) => void
  // With the media error code.
  onError: (code: number) => void
}) {
  const { label, title } = primaryText(primary.label, shown, primary.hint)
  const box = videoBox(w, h)
  return (
    <div
      {...(open ? longPress(open) : {})}
      {...data}
      data-video-attachment=""
      className="mt-1 w-fit max-w-full"
    >
      <div className="group/video relative isolate w-fit max-w-full overflow-hidden rounded-xl bg-surface-container-lowest">
        <video
          ref={videoRef}
          src={src}
          controls
          preload="metadata"
          playsInline
          aria-label={shown}
          style={box ?? undefined}
          onError={e => onError(e.currentTarget.error?.code ?? 0)}
          onLoadedMetadata={e => {
            const { videoWidth, videoHeight } = e.currentTarget
            if (videoWidth > 0 && videoHeight > 0) onBox?.({ w: videoWidth, h: videoHeight })
          }}
          className="block max-h-80 max-w-full rounded-xl"
        />
        <div className={pillClass(moves)}>
          {progress && onCancel ? (
            <button
              title="Cancel download"
              aria-label="Cancel download"
              onClick={onCancel}
              className={`${button} hover:bg-surface-container-high`}
            >
              <X size={18} />
            </button>
          ) : primary.href !== undefined ? (
            <a
              href={primary.href}
              download={primary.download}
              title={title}
              aria-label={label}
              className={`${button} hover:bg-surface-container-high`}
            >
              <Download size={18} />
            </a>
          ) : (
            <button
              title={title}
              aria-label={label}
              onClick={primary.onClick}
              disabled={primary.disabled}
              className={`${button} enabled:hover:bg-surface-container-high`}
            >
              <Download size={18} />
            </button>
          )}
        </div>
      </div>
      {progress && (
        <p
          role="progressbar"
          aria-label={`Downloading ${shown}`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct(progress)}
          className="mt-1.5 text-xs text-on-surface-variant tabular-nums"
        >
          Downloading {pct(progress)}%
        </p>
      )}
      {children}
    </div>
  )
}

// Where a video will play while it isn't mounted, or while its bytes load (`loading`): its box
// (its own size when known), with the file menu on right-click and long-press.
export function VideoPlaceholder({
  name,
  own,
  fileMask,
  primary,
  menu,
  box,
  loading,
}: {
  name: string
  own: boolean
  fileMask: boolean
  primary: FilePrimary
  menu: FileMenuOwn
  box: { w: number; h: number } | null
  loading: boolean
}) {
  const shown = useMask(own, fileMask)(name)
  const open = useFileMenu(cardMenu(shown, { primary, progress: null, menu }))
  const style = box ? videoBox(box.w, box.h) : null
  return (
    <div
      {...(open ? longPress(open) : {})}
      data-video-waiting=""
      role={loading ? 'status' : 'group'}
      aria-label={loading ? `Loading ${shown}` : shown}
      style={style ?? undefined}
      className={`mt-1 max-w-full rounded-xl bg-surface-container ${loading ? 'motion-safe:animate-pulse' : ''} ${style ? '' : 'aspect-video w-80'}`}
    />
  )
}

const scrollParent = (el: Element) => {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const { overflowY } = getComputedStyle(p)
    if (overflowY === 'auto' || overflowY === 'scroll') return p
  }
  return null
}

// A ref for an element, whether it has stayed within about a screen of its scroll area's view for
// NEAR_SETTLE_MS (so scrolling past doesn't count), and whether it is in that view now; both true
// where that can't be watched.
export function useNearView(): [(el: HTMLElement | null) => void, boolean, boolean] {
  const [el, setEl] = useState<HTMLElement | null>(null)
  const unwatched = typeof IntersectionObserver === 'undefined'
  const [near, setNear] = useState(unwatched)
  const [inView, setInView] = useState(unwatched)
  useEffect(() => {
    if (!el || typeof IntersectionObserver === 'undefined') return
    const root = scrollParent(el)
    let settle: Cancel | undefined
    const watch = (margin: string, set: (on: boolean) => void) => {
      const io = new IntersectionObserver(
        entries => {
          const last = entries.at(-1)
          if (last) set(last.isIntersecting)
        },
        { root, rootMargin: margin }
      )
      io.observe(el)
      return io
    }
    const around = watch('100% 0px', on => {
      settle?.()
      if (on) settle = time().after(NEAR_SETTLE_MS, () => setNear(true))
      else setNear(false)
    })
    const shown = watch('0px', setInView)
    return () => {
      settle?.()
      around.disconnect()
      shown.disconnect()
    }
  }, [el])
  return [setEl, near, inView]
}
