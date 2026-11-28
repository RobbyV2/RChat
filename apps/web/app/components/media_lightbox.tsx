'use client'

import {
  createContext,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from 'react'
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  EllipsisVertical,
  ExternalLink,
  Forward,
  ImageOff,
  Link2,
  Maximize2,
  RotateCcw,
  RotateCw,
  X,
  ZoomIn,
  ZoomOut,
  type LucideIcon,
} from 'lucide-react'
import { useAccount } from '../lib/client/react'
import type { AccountSession } from '../lib/client/session'
import type { FileMenu } from '../lib/file_card'
import {
  atFit,
  copyFrom,
  counterText,
  createShelf,
  detailText,
  doubleTap,
  FIT,
  fitScale,
  fitsIn,
  MAX_ZOOM,
  menuStamp,
  minZoom,
  panBy,
  pinchView,
  quarter,
  rotateView,
  scaleOf,
  swipeMove,
  toggleZoom,
  zoomAt,
  zoomStep,
  type Box,
  type MessageKey,
  type Move,
  type OpenGallery,
  type Point,
  type Shelf,
  type ShelfEntry,
  type ShelfScope,
  type Tap,
  type View,
} from '../lib/media_lightbox'
import { FUNCTIONAL } from '../lib/motion/functional'
import { beside, plays, playsBehind, playsOn } from '../lib/motion/play'
import { useSlotBlurs, useSlotPlays } from '../lib/motion/use_motion'
import { sharing } from '../lib/platform'
import { useMask } from '../lib/store'
import { AltBadge } from './alt_text'
import { longPress } from './context_menu'
import { useFileMenu } from './file_card'
import { Masked, useEscape } from './ui'
import { Row, Surface, Inset } from './layout'
import { useCopied } from '../lib/use_copied'
import { IconButton, MediaButton } from './controls'
import { notAName, type Said, unnamed } from '../lib/names'

// An image as the viewer shows it. `src` is the address its message shows it from, held while it
// is on screen; `w` and `h` the size its sender gave, until the image tells its own; `placeholder`
// a small preview to show while it loads. `alt` is the attachment's description (`altText`).
export interface LightboxItem {
  src: string
  name: string
  own: boolean
  fileMask: boolean
  size: number | null
  w?: number
  h?: number
  placeholder?: string | null
  alt: string | null
}

// A list whose images open with the others of their message group. `forward` gives what the
// viewer's Forward button runs for a message, read when called, or null where it may not.
// `subscribe` and `version` follow the list as it renders, so the viewer's buttons do too.
export interface LightboxScope extends ShelfScope {
  forward: (message: MessageKey) => ((x: number, y: number) => void) | null
  subscribe: (listener: () => void) => () => void
  version: () => number
}

// What the viewer reads of an image on screen as it is now: its menu, its own button, and its
// bytes for an address whose pixels the page may not read (`readsPixels`).
export interface LightboxAct {
  menu: FileMenu
  button: () => HTMLButtonElement | null
  bytes: (() => Promise<Blob>) | null
}

export type LightboxShelf = Shelf<LightboxItem, LightboxAct, LightboxScope>
type Entry = ShelfEntry<LightboxItem, LightboxAct, LightboxScope>

const shelves = new WeakMap<AccountSession, LightboxShelf>()

// The images `acct` shows now, and the viewer open over them. Only `ViewableImage` puts images
// here, so what the viewer can show is what messages show.
const shelfOf = (acct: AccountSession): LightboxShelf => {
  let shelf = shelves.get(acct)
  if (!shelf) {
    shelf = createShelf<LightboxItem, LightboxAct, LightboxScope>()
    shelves.set(acct, shelf)
  }
  return shelf
}

const ScopeContext = createContext<LightboxScope | null>(null)

// Around a message list: `rows` reads its messages and their group places when an image opens.
export function LightboxList({
  rows,
  forward,
  children,
}: {
  rows: LightboxScope['rows']
  forward: LightboxScope['forward']
  children: ReactNode
}) {
  const now = useRef({ rows, forward })
  const [scope] = useState(() => {
    const listeners = new Set<() => void>()
    let version = 0
    return {
      rows: () => now.current.rows(),
      forward: (message: MessageKey) => now.current.forward(message),
      subscribe: (listener: () => void) => {
        listeners.add(listener)
        return () => void listeners.delete(listener)
      },
      version: () => version,
      rendered: () => {
        version++
        for (const l of listeners) l()
      },
    }
  })
  // Before the images below put themselves on the shelf, which reads the rows as they are now.
  useLayoutEffect(() => {
    now.current = { rows, forward }
  })
  useEffect(() => scope.rendered())
  return <ScopeContext.Provider value={scope}>{children}</ScopeContext.Provider>
}

// Copies an image through the platform clipboard, saying how it went.
const copyImage = (acct: AccountSession, image: HTMLImageElement | Promise<Blob> | null) => {
  const told = acct.lifetime.inSession((ok: boolean) => {
    const s = acct.store.getState()
    if (ok) s.showToast('Image copied')
    else s.setError("Couldn't copy image")
  })
  if (!image) return void told(false)
  void sharing(acct).copyImage(image).then(told)
}

// The image's rows that need the platform: opening it on its own, and copying it once it shows
// (`shows`), drawn from `image` where the page may read its pixels, else from its `bytes`.
const platformRows = (
  acct: AccountSession,
  item: LightboxItem,
  shows: boolean,
  image: () => HTMLImageElement | null,
  bytes: (() => Promise<Blob>) | null
): Pick<FileMenu, 'copyImage' | 'original'> => {
  const platform = sharing(acct)
  const from = copyFrom({
    src: item.src,
    name: item.name,
    page: typeof location === 'undefined' ? 'http://localhost/' : location.href,
    shows,
    platform: platform.canCopyImage(),
    bytes: bytes !== null,
  })
  return {
    copyImage:
      from === 'image'
        ? () => copyImage(acct, image())
        : from === 'bytes' && bytes
          ? () => copyImage(acct, bytes())
          : null,
    original: platform.canOpenOriginal(item.src) ? () => platform.openOriginal(item.src) : null,
  }
}

// An image a message shows, the one way into the viewer: rendered only where the message shows
// the image, it puts the image on its account's shelf while mounted, and it draws the image as the
// button that opens the viewer, with its ALT pill and its menu on right-click and long-press
// (none in a row in selection mode). `message` and `index` place it in its list's groups; outside
// a list it opens alone. `menu` is the attachment's menu as it is now, named here as the filter
// shows the name; `bytes` fetch the file for a copy where the page can't read the image's pixels;
// `children` go under it.
export function ViewableImage({
  message,
  index = 0,
  item,
  menu,
  bytes = null,
  width,
  height,
  className,
  data,
  children,
}: {
  message?: MessageKey
  index?: number
  item: LightboxItem
  menu: FileMenu
  bytes?: (() => Promise<Blob>) | null
  width?: number
  height?: number
  className: string
  data?: Record<`data-${string}`, string>
  children?: ReactNode
}) {
  const acct = useAccount()
  const shelf = shelfOf(acct)
  const scope = useContext(ScopeContext)
  const key = useId()
  const buttonRef = useRef<HTMLButtonElement>(null)
  const imgRef = useRef<HTMLImageElement>(null)
  const shown = useMask(item.own, item.fileMask)(item.name)
  const altMask = useMask(item.own)
  const alt = item.alt === null ? null : altMask(item.alt)
  // The address whose image shows, decoded, now.
  const [shows, setShows] = useState<string | null>(null)
  useEffect(() => {
    const img = imgRef.current
    if (img?.complete && img.naturalWidth > 0) setShows(img.currentSrc || item.src)
  }, [item.src])
  const rows = platformRows(acct, item, shows === item.src, () => imgRef.current, bytes)
  const full: FileMenu = { ...menu, name: shown, ...rows }
  const view = () => void shelf.show(key, document.activeElement)
  const open = useFileMenu({ ...full, view })
  const now = (): LightboxAct => ({ menu: full, button: () => buttonRef.current, bytes })
  const live = useRef<LightboxAct>(now())
  useEffect(() => {
    live.current = now()
    shelf.put({
      key,
      scope: message === undefined ? null : scope,
      message: message ?? key,
      index,
      item,
      act: () => live.current,
      stamp: menuStamp(full),
    })
  })
  useEffect(() => () => shelf.drop(key), [shelf, key])
  return (
    <div
      {...(open ? longPress(open) : {})}
      {...data}
      data-image-attachment=""
      className="msg-part w-fit max-w-full"
    >
      <span className="relative block w-fit max-w-full">
        <MediaButton ref={buttonRef} onClick={view} zoom label={notAName(`Open ${shown}`)}>
          <img
            ref={imgRef}
            src={item.src}
            alt={alt ?? shown}
            width={width}
            height={height}
            onLoad={() => setShows(item.src)}
            onError={() => setShows(null)}
            className={className}
          />
        </MediaButton>
        <AltBadge alt={item.alt} own={item.own} />
      </span>
      {children}
    </div>
  )
}

const focusable = (el: unknown): el is HTMLElement =>
  el instanceof HTMLElement && el.isConnected && el.getClientRects().length > 0

// The viewer of the account around it, while open. Closing gives focus back to where it was, or
// to the image it opened from when that is gone.
export function MediaLightbox() {
  const shelf = shelfOf(useAccount())
  useSyncExternalStore(shelf.subscribe, shelf.version, shelf.version)
  const open = shelf.state()
  const entry = open ? shelf.entry(open.keys[open.at]) : undefined
  const back = useRef<{ el: unknown; from: string } | null>(null)
  useEffect(() => {
    if (open) {
      back.current = { el: open.back, from: open.from }
      return
    }
    const was = back.current
    back.current = null
    if (!was) return
    if (focusable(was.el)) was.el.focus({ preventScroll: true })
    else shelf.entry(was.from)?.act()?.button()?.focus({ preventScroll: true })
  }, [open, shelf])
  if (!open || !entry) return null
  return <LightboxView shelf={shelf} open={open} entry={entry} />
}

const useBox = (ref: RefObject<HTMLElement | null>) => {
  const [box, setBox] = useState<Box | null>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = () =>
      setBox(b =>
        b && b.w === el.clientWidth && b.h === el.clientHeight
          ? b
          : { w: el.clientWidth, h: el.clientHeight }
      )
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const watch = new ResizeObserver(measure)
    watch.observe(el)
    return () => watch.disconnect()
  }, [ref])
  return box
}

const FOCUSABLE = 'button, a[href], [tabindex]:not([tabindex="-1"])'

// Tab and Shift+Tab go round the viewer's controls.
const trapTab = (e: ReactKeyboardEvent, root: HTMLElement | null) => {
  if (!root) return
  const all = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    el => el.getClientRects().length > 0
  )
  if (!all.length) return
  const first = all[0]
  const last = all[all.length - 1]
  const at = document.activeElement
  if (e.shiftKey && (at === first || at === root || !root.contains(at))) {
    e.preventDefault()
    last.focus()
  } else if (!e.shiftKey && (at === last || !root.contains(at))) {
    e.preventDefault()
    first.focus()
  }
}

// An icon button of the bar. One that is off stays focusable, so pressing it to its limit (Zoom
// in up to 400%) keeps focus, and keys, in the viewer.
function BarButton<const L extends string, const T extends string = never>({
  icon: Icon,
  label,
  title,
  onClick,
  disabled = false,
  narrowHidden = false,
}: {
  icon: LucideIcon
  label: Said<L>
  title?: Said<T>
  onClick: (e: ReactMouseEvent<HTMLButtonElement>) => void
  disabled?: boolean
  narrowHidden?: boolean
}) {
  return (
    <IconButton
      place={narrowHidden ? 'max-md:hidden' : undefined}
      aria-disabled={disabled || undefined}
      onClick={e => {
        if (!disabled) onClick(e)
      }}
      icon={Icon}
      label={label}
      tooltip={title === undefined ? unnamed(label) : unnamed(title)}
      size="lg"
    />
  )
}

// The press point of a button, for a menu it opens.
const at = (e: ReactMouseEvent<HTMLElement>) => {
  const r = e.currentTarget.getBoundingClientRect()
  return { x: r.left + r.width / 2, y: r.top }
}

interface Gesture {
  pointers: Map<number, Point>
  start: View
  first: Point
  // Two fingers: their midpoint (from the stage's centre) and distance apart when they landed.
  pinch: { mid: Point; dist: number } | null
  moved: boolean
  // It began at fit, where one finger swipes between images instead of moving the image.
  swipes: boolean
  onImage: boolean
  // A description was open: the tap that closes it leaves the viewer open.
  describing: boolean
  t: number
}

const noWatch = () => () => {}
const noVersion = () => 0

// Layers that may take focus over the viewer: menus, sheets, confirms and other dialogs, and the
// call banner.
const ABOVE =
  '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [data-popover], [data-call-banner]'

const pinchOf = (pointers: Map<number, Point>, centre: Point) => {
  const [a, b] = [...pointers.values()]
  return {
    mid: { x: (a.x + b.x) / 2 - centre.x, y: (a.y + b.y) / 2 - centre.y },
    dist: Math.hypot(a.x - b.x, a.y - b.y),
  }
}

// The open viewer: the image `entry` of the gallery `open`, its bar and its gestures.
export function LightboxView({
  shelf,
  open,
  entry,
}: {
  shelf: LightboxShelf
  open: OpenGallery
  entry: Entry
}) {
  const acct = useAccount()
  const moves = useSlotPlays('lightbox')
  const blurs = useSlotBlurs('lightbox')
  const { item, key } = entry
  const count = open.keys.length
  const shown = useMask(item.own, item.fileMask)(item.name)
  const menu = entry.act()?.menu ?? null
  const { scope, message } = entry
  const listed = useSyncExternalStore(
    scope?.subscribe ?? noWatch,
    scope?.version ?? noVersion,
    noVersion
  )
  // Whether Forward shows follows the list as it renders; pressing it reads the message then.
  const forwards = useMemo(() => scope?.forward(message) != null, [scope, message, listed])
  const close = () => shelf.close()
  const rootRef = useRef<HTMLDivElement>(null)
  const describing = () => !!rootRef.current?.querySelector('[data-alt-text]')
  // Esc with the description open closes only the description (its pill handles that), as the
  // key found it before any handler ran.
  const keepOpen = useRef<Event | null>(null)
  useEffect(() => {
    const note = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && describing()) keepOpen.current = e
    }
    window.addEventListener('keydown', note, true)
    return () => window.removeEventListener('keydown', note, true)
  }, [])
  useEscape(e => {
    if (keepOpen.current !== e) close()
  }, 'dialog')
  const imgRef = useRef<HTMLImageElement>(null)
  const [linkCopied, flashLink] = useCopied()

  // Opening takes focus, and closes the inbox popover it would cover.
  useEffect(() => {
    const root = rootRef.current
    if (root && !root.contains(document.activeElement)) root.focus({ preventScroll: true })
    const s = acct.store.getState()
    if (s.inboxOpen) s.setInboxOpen(false)
  }, [acct])
  // While no layer is above it, focus that lands behind the viewer comes back to it.
  useEffect(() => {
    const keep = (e: FocusEvent) => {
      const root = rootRef.current
      const to = e.target
      if (!root || !(to instanceof Element) || root.contains(to) || to.closest(ABOVE)) return
      root.focus({ preventScroll: true })
    }
    document.addEventListener('focusin', keep)
    return () => document.removeEventListener('focusin', keep)
  }, [])
  const stageRef = useRef<HTMLDivElement>(null)
  const stage = useBox(stageRef)
  const [natural, setNatural] = useState<{ key: string; box: Box } | null>(null)
  const img: Box | null =
    natural?.key === key ? natural.box : item.w && item.h ? { w: item.w, h: item.h } : null
  const [held, setHeld] = useState<{ key: string; view: View }>({ key, view: FIT })
  const view = held.key === key ? held.view : FIT
  const [swipe, setSwipe] = useState(0)
  const [dragging, setDragging] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)
  const altMask = useMask(item.own)
  const alt = item.alt === null ? null : altMask(item.alt)

  const now = useRef({ key, view, stage, img })
  useEffect(() => {
    now.current = { key, view, stage, img }
  })
  const change = (next: (v: View, stage: Box, img: Box) => View) => {
    const { key, view, stage, img } = now.current
    if (!stage || !img) return
    const v = next(view, stage, img)
    now.current = { ...now.current, view: v }
    setHeld({ key, view: v })
  }

  const scale = stage && img ? scaleOf(view, stage, img) : 1
  const fit = stage && img ? fitScale(stage, img, view.turn) : 1
  const fits = !stage || !img || fitsIn(view, stage, img)
  const upright = (!stage || !img || atFit(view, stage, img)) && quarter(view.turn) === 0
  const go = (move: Move) => shelf.go(move)

  // Wheel and trackpad pinch zoom around the pointer, never the page. `change` reads the view
  // as it is now, so the first one serves.
  useEffect(() => {
    const el = stageRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const r = el.getBoundingClientRect()
      const point = { x: e.clientX - r.left - r.width / 2, y: e.clientY - r.top - r.height / 2 }
      const by = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.002))
      change((v, stage, img) => zoomAt(v, stage, img, scaleOf(v, stage, img) * by, point))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  const gesture = useRef<Gesture | null>(null)
  const lastTap = useRef<Tap | null>(null)
  const pointerKind = useRef('mouse')
  const imageRef = useRef<HTMLDivElement>(null)

  const centre = () => {
    const r = stageRef.current?.getBoundingClientRect()
    return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : { x: 0, y: 0 }
  }

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    pointerKind.current = e.pointerType
    if (e.pointerType === 'mouse' && e.button !== 0) return
    if ((e.target as Element).closest('button, [data-alt-badge]')) return
    e.currentTarget.setPointerCapture?.(e.pointerId)
    const point = { x: e.clientX, y: e.clientY }
    const g = gesture.current
    if (!g) {
      gesture.current = {
        pointers: new Map([[e.pointerId, point]]),
        start: now.current.view,
        first: point,
        pinch: null,
        moved: false,
        swipes: fits && count > 1,
        onImage: !!imageRef.current?.contains(e.target as Node),
        describing: describing(),
        t: e.timeStamp,
      }
      return
    }
    g.pointers.set(e.pointerId, point)
    if (g.pointers.size === 2) {
      g.pinch = pinchOf(g.pointers, centre())
      g.start = now.current.view
      g.moved = true
      g.swipes = false
      setSwipe(0)
      setDragging(true)
    }
  }

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const g = gesture.current
    if (!g?.pointers.has(e.pointerId)) return
    g.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (g.pinch && g.pointers.size >= 2) {
      const to = pinchOf(g.pointers, centre())
      const from = g.pinch
      change((_, stage, img) => pinchView(g.start, stage, img, from, to))
      return
    }
    const dx = e.clientX - g.first.x
    const dy = e.clientY - g.first.y
    if (!g.moved && Math.hypot(dx, dy) < 6) return
    if (!g.moved) setDragging(true)
    g.moved = true
    if (g.swipes) setSwipe(dx)
    else change((_, stage, img) => panBy(g.start, stage, img, dx, dy))
  }

  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const g = gesture.current
    if (!g?.pointers.has(e.pointerId)) return
    g.pointers.delete(e.pointerId)
    if (g.pointers.size > 0) {
      if (g.pinch && g.pointers.size === 1) {
        g.pinch = null
        g.start = now.current.view
        g.first = [...g.pointers.values()][0]
        g.swipes = false
      }
      return
    }
    gesture.current = null
    setDragging(false)
    setSwipe(0)
    const cancelled = e.type === 'pointercancel'
    if (g.moved) {
      if (g.swipes && !cancelled) {
        const step = swipeMove(e.clientX - g.first.x, e.clientY - g.first.y)
        if (step) go(step > 0 ? 'next' : 'prev')
      }
      return
    }
    if (cancelled || e.timeStamp - g.t > 450) return
    if (e.pointerType !== 'mouse') {
      const tap = { t: e.timeStamp, x: e.clientX, y: e.clientY }
      if (doubleTap(lastTap.current, tap)) {
        lastTap.current = null
        const c = centre()
        change((v, stage, img) => toggleZoom(v, stage, img, { x: tap.x - c.x, y: tap.y - c.y }))
        return
      }
      lastTap.current = tap
    }
    if (!g.onImage && !g.describing) close()
  }

  const onDoubleClick = (e: ReactMouseEvent<HTMLDivElement>) => {
    if (
      pointerKind.current !== 'mouse' ||
      (e.target as Element).closest('button, [data-alt-badge]')
    )
      return
    const c = centre()
    const point = { x: e.clientX - c.x, y: e.clientY - c.y }
    change((v, stage, img) => toggleZoom(v, stage, img, point))
  }

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Tab') return trapTab(e, rootRef.current)
    if (e.ctrlKey || e.metaKey || e.altKey) return
    switch (e.key) {
      case 'ArrowLeft':
        go('prev')
        break
      case 'ArrowRight':
        go('next')
        break
      case 'Home':
        go('first')
        break
      case 'End':
        go('last')
        break
      case '+':
      case '=':
        change((v, stage, img) => zoomStep(v, stage, img, 1))
        break
      case '-':
      case '_':
        change((v, stage, img) => zoomStep(v, stage, img, -1))
        break
      case '0':
        change(() => FIT)
        break
      default:
        return
    }
    e.preventDefault()
    e.stopPropagation()
  }

  const counter = counterText(open.at, count)
  const detail = detailText(img, item.size, stage && img ? scale : null)
  const verb = menu?.verb ?? 'Download'
  const download = menu?.download ?? null
  const link = menu?.link ?? null
  const placed = stage !== null && img !== null
  const loaded = natural?.key === key
  const broken = failed === key
  const platform = platformRows(
    acct,
    item,
    loaded && !broken,
    () => imgRef.current,
    entry.act()?.bytes ?? null
  )
  const openMenu = useFileMenu({
    name: shown,
    verb,
    download,
    cancel: menu?.cancel ?? null,
    extra: [],
    link,
    remove: menu?.remove ?? null,
    ...platform,
  })
  const box = placed
    ? {
        width: `${img.w}px`,
        height: `${img.h}px`,
        transform: `translate(-50%, -50%) translate(${view.x + swipe}px, ${view.y}px) rotate(${view.turn * 90}deg) scale(${scale})`,
      }
    : undefined
  const name = <Masked text={item.name} file={item.fileMask} own={item.own} />
  const more = (e: ReactMouseEvent<HTMLElement>) => {
    const p = at(e)
    openMenu?.(p.x, p.y)
  }
  const moreButton = (narrowHidden: boolean) =>
    openMenu && (
      <BarButton
        icon={EllipsisVertical}
        label="More options"
        onClick={more}
        narrowHidden={narrowHidden}
      />
    )

  // On phones these sit in the top bar, by Close.
  const outward = (
    <>
      {platform.original && (
        <BarButton icon={ExternalLink} label="Open original" onClick={platform.original} />
      )}
      {link !== null && (
        <BarButton
          icon={linkCopied ? Check : Link2}
          label="Copy link"
          onClick={() =>
            void sharing(acct)
              .copyText(link)
              .then(ok => ok && flashLink())
          }
        />
      )}
    </>
  )
  const tools = (
    <>
      {platform.copyImage && (
        <BarButton icon={Copy} label="Copy image" onClick={platform.copyImage} />
      )}
      {menu?.cancel ? (
        <BarButton icon={X} label="Cancel download" onClick={menu.cancel} />
      ) : (
        <BarButton
          icon={Download}
          label={notAName(verb)}
          title={notAName(`${verb} ${shown}`)}
          disabled={download === null}
          onClick={() => download?.()}
        />
      )}
      <BarButton
        icon={RotateCcw}
        label="Rotate left"
        onClick={() => change((v, stage, img) => rotateView(v, stage, img, -1))}
      />
      <BarButton
        icon={RotateCw}
        label="Rotate right"
        onClick={() => change((v, stage, img) => rotateView(v, stage, img, 1))}
      />
      <BarButton
        icon={Maximize2}
        label="Reset view"
        disabled={upright}
        onClick={() => change(() => FIT)}
      />
      <BarButton
        icon={ZoomIn}
        label="Zoom in"
        disabled={scale >= MAX_ZOOM}
        onClick={() => change((v, stage, img) => zoomStep(v, stage, img, 1))}
      />
      <BarButton
        icon={ZoomOut}
        label="Zoom out"
        disabled={scale <= minZoom(fit)}
        onClick={() => change((v, stage, img) => zoomStep(v, stage, img, -1))}
      />
      {forwards && (
        <BarButton
          icon={Forward}
          label="Forward"
          onClick={e => {
            const p = at(e)
            scope?.forward(message)?.(p.x, p.y)
          }}
        />
      )}
      {moreButton(true)}
    </>
  )

  return (
    <>
      {blurs && (
        <div
          ref={playsBehind('lightbox')}
          aria-hidden
          data-lightbox-blur=""
          className="pointer-events-none fixed inset-x-0 top-app z-lightbox h-app backdrop-blur-md"
        />
      )}
      <div
        ref={playsBehind('lightbox', rootRef)}
        role="dialog"
        aria-modal="true"
        aria-label="Image viewer"
        tabIndex={-1}
        data-media-lightbox=""
        onKeyDown={onKeyDown}
        onContextMenu={e => {
          if (stageRef.current?.contains(e.target as Node)) return
          e.preventDefault()
          const r = (e.target as Element).getBoundingClientRect()
          const keyed = e.clientX === 0 && e.clientY === 0
          openMenu?.(keyed ? r.left + r.width / 2 : e.clientX, keyed ? r.top : e.clientY)
        }}
        className={`fixed inset-x-0 top-app z-lightbox flex h-app flex-col text-on-surface outline-none ${
          blurs ? 'bg-scrim/80' : 'bg-scrim/85'
        }`}
      >
        <Inset
          row
          pad="sm"
          inset="sides"
          gap="sm"
          safe="sides"
          look="h-14 border-b border-outline-variant/40 bg-surface-container-lowest/95"
          place="shrink-0 md:hidden"
        >
          <div className="min-w-0 flex-1">
            <p aria-live="polite" className="truncate text-sm font-medium" title={shown}>
              {counter && <span className="sr-only">{counter} </span>}
              {name}
            </p>
            <p className="truncate text-xs text-on-surface-variant tabular-nums">
              {[counter, detail].filter(Boolean).join(' · ')}
            </p>
          </div>
          {outward}
          {moreButton(false)}
          <BarButton icon={X} label="Close" onClick={close} />
        </Inset>
        <div
          ref={plays('lightbox', stageRef)}
          data-lightbox-stage=""
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onDoubleClick={onDoubleClick}
          {...(openMenu ? longPress(openMenu) : {})}
          className="relative min-h-0 flex-1 touch-none overflow-hidden select-none"
        >
          <div ref={playsOn('lightbox.slide', open.at)} className="absolute inset-0">
            <div key={key} className="absolute inset-0">
              {!loaded && !broken && (
                <Surface
                  role="status"
                  aria-label="Loading image"
                  pad="2xl"
                  row
                  tone="plain"
                  radius="none"
                  justify="center"
                  place="absolute inset-0"
                >
                  {item.placeholder ? (
                    <img
                      src={item.placeholder}
                      alt=""
                      className="max-h-full max-w-full rounded-lg object-contain opacity-80 blur-sm"
                    />
                  ) : (
                    <span
                      className={`size-16 rounded-2xl bg-surface-container-high/60 ${moves ? FUNCTIONAL.pulse : ''}`}
                    />
                  )}
                </Surface>
              )}
              {broken ? (
                <Inset
                  role="alert"
                  pad="2xl"
                  gap="sm"
                  align="center"
                  justify="center"
                  text="sm"
                  ink="strong"
                  look="text-center"
                  place="absolute inset-0"
                >
                  <ImageOff size={32} aria-hidden className="text-on-surface-variant" />
                  Couldn&apos;t load this image
                </Inset>
              ) : (
                <div
                  ref={imageRef}
                  data-lightbox-image=""
                  className={`absolute top-1/2 left-1/2 ${placed && loaded ? '' : 'opacity-0'} ${
                    moves && !dragging ? 'transition-transform duration-150 ease-out' : ''
                  } ${fits ? 'cursor-zoom-in' : dragging ? 'cursor-grabbing' : 'cursor-grab'}`}
                  style={box}
                >
                  <img
                    ref={imgRef}
                    src={item.src}
                    alt={alt ?? shown}
                    draggable={false}
                    onLoad={e => {
                      const { naturalWidth: w, naturalHeight: h } = e.currentTarget
                      setNatural({ key, box: { w: w || 300, h: h || 150 } })
                    }}
                    onError={() => setFailed(key)}
                    className="block h-full w-full max-w-none select-none"
                  />
                </div>
              )}
            </div>
          </div>
          {count > 1 && open.at > 0 && (
            <div className="absolute top-1/2 left-safe-2 z-raised -translate-y-1/2">
              <IconButton
                icon={ChevronLeft}
                label="Previous image"
                onClick={() => go('prev')}
                tone="raised"
                size="xl"
              />
            </div>
          )}
          {count > 1 && open.at < count - 1 && (
            <div className="absolute top-1/2 right-safe-2 z-raised -translate-y-1/2">
              <IconButton
                icon={ChevronRight}
                label="Next image"
                onClick={() => go('next')}
                tone="raised"
                size="xl"
              />
            </div>
          )}
          <AltBadge key={`alt ${key}`} alt={item.alt} own={item.own} up />
        </div>
        <Inset
          row
          pad="sm"
          inset="sides"
          gap="md"
          safe="all"
          look="border-t border-outline-variant/40 bg-surface-container-lowest/95 md:h-12"
          place="shrink-0"
          {...beside('lightbox')}
        >
          <Row gap="3xs" look="max-md:justify-center-safe" place="min-w-0 flex-1 overflow-x-auto">
            <Row gap="3xs" place="max-md:hidden">
              <BarButton icon={X} label="Close" onClick={close} />
              {outward}
            </Row>
            {tools}
          </Row>
          <Row
            gap="sm"
            text="xs"
            ink="muted"
            look="shrink tabular-nums"
            place="min-w-0 max-md:hidden"
          >
            <Row as="span" gap="sm" aria-live="polite">
              {counter && <span className="shrink-0">{counter}</span>}
              <span className="max-w-60 min-w-0 truncate text-on-surface" title={shown}>
                {name}
              </span>
            </Row>
            <span className="shrink-0">{detail}</span>
          </Row>
        </Inset>
      </div>
    </>
  )
}
