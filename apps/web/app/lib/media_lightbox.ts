// The image viewer's logic: which shown images a click opens (those of the clicked message's group,
// in order), the shelf of images on screen that it opens from, and how the shown image is zoomed,
// panned and turned. No DOM.

import { fmtSize } from './bytes'
import type { FileMenu } from './file_card'
import type { GroupPlace } from './message_groups'

export type MessageKey = string | number

// An image on screen: `index` is its place among its message's attachments.
export interface Shelved {
  key: string
  message: MessageKey
  index: number
}

// The rows [start, end) of the group around row `at`.
export const groupBounds = (places: readonly GroupPlace[], at: number): [number, number] => {
  let start = at
  while (start > 0 && places[start] && !places[start].first) start--
  let end = at + 1
  while (end < places.length && !places[end].first) end++
  return [start, end]
}

// What a click on `clicked` opens: the shown images of its message's group in the list (`ids` in
// order, with their `places`), by message and then attachment, and where `clicked` is among
// them. Alone when its message isn't in the list. The same attachment shown twice counts once.
export function collectGroupMedia<T extends Shelved>(
  ids: readonly MessageKey[],
  places: readonly GroupPlace[],
  shown: readonly T[],
  clicked: T
): { items: T[]; at: number } {
  const row = ids.indexOf(clicked.message)
  if (row < 0) return { items: [clicked], at: 0 }
  const [start, end] = groupBounds(places, row)
  const rowOf = new Map<MessageKey, number>()
  for (let i = start; i < Math.min(end, ids.length); i++) rowOf.set(ids[i], i)
  const seen = new Set([`${clicked.message}\n${clicked.index}`])
  const items = [clicked]
  for (const e of shown) {
    const id = `${e.message}\n${e.index}`
    if (e.key === clicked.key || !rowOf.has(e.message) || seen.has(id)) continue
    seen.add(id)
    items.push(e)
  }
  items.sort((a, b) => rowOf.get(a.message)! - rowOf.get(b.message)! || a.index - b.index)
  return { items, at: items.indexOf(clicked) }
}

// The open gallery kept to the keys `live` says are on screen: on the same image when it is there,
// else the next one (or the last), and null when none are left.
export function keepLive(
  keys: readonly string[],
  at: number,
  live: (key: string) => boolean
): { keys: string[]; at: number } | null {
  const kept = keys.filter(live)
  if (!kept.length) return null
  const current = keys[at]
  if (current !== undefined && live(current)) return { keys: kept, at: kept.indexOf(current) }
  const after = keys.slice(at + 1).find(live)
  return { keys: kept, at: after === undefined ? kept.length - 1 : kept.indexOf(after) }
}

export type Move = 'prev' | 'next' | 'first' | 'last'

// Where a move goes in a gallery of `count`; it stops at the ends.
export const moveTo = (at: number, count: number, move: Move) => {
  if (count < 1) return 0
  switch (move) {
    case 'prev':
      return Math.max(0, at - 1)
    case 'next':
      return Math.min(count - 1, at + 1)
    case 'first':
      return 0
    case 'last':
      return count - 1
  }
}

// "2 / 5", or null for a gallery of one.
export const counterText = (at: number, count: number) =>
  count > 1 ? `${at + 1} / ${count}` : null

// Everything a shelf holds about an image on screen: which list shows it (`scope`, null outside
// one), the image's own data `item`, and `act`, read when the viewer acts on it.
// `stamp` sums up what the viewer shows of `act`, so a change to it reaches the viewer too.
export interface ShelfEntry<T, A, S extends ShelfScope = ShelfScope> extends Shelved {
  scope: S | null
  item: T
  act: () => A | null
  stamp?: string
}

// A list's messages in order and where each sits in its group, as they are now.
export interface ShelfScope {
  rows: () => { ids: readonly MessageKey[]; places: readonly GroupPlace[] }
}

export interface OpenGallery {
  keys: string[]
  at: number
  // The way the last move went: 1 forward, -1 back, 0 for the image it opened on.
  dir: -1 | 0 | 1
  // Where focus was when it opened, given back when it closes, and the image it opened from.
  back: unknown
  from: string
}

const sameData = (a: object, b: object) => {
  const ka = Object.keys(a)
  if (ka.length !== Object.keys(b).length) return false
  return ka.every(k => (a as Record<string, unknown>)[k] === (b as Record<string, unknown>)[k])
}

// The images on screen of one account, and the gallery open over them. The gallery follows the
// shelf: an image that leaves the screen (its message deleted or unloaded, its list closed)
// leaves the gallery, which closes with the last one, and one of its group that comes on screen
// (loaded late, or a new message) joins it.
export function createShelf<T extends object, A, S extends ShelfScope = ShelfScope>() {
  const entries = new Map<string, ShelfEntry<T, A, S>>()
  let open: OpenGallery | null = null
  let openScope: S | null = null
  let version = 0
  const listeners = new Set<() => void>()
  const changed = () => {
    version++
    for (const l of listeners) l()
  }
  const settle = () => {
    if (!open) return
    const was = open
    const kept = keepLive(was.keys, was.at, k => entries.has(k))
    open = kept && {
      ...kept,
      dir: kept.keys[kept.at] === was.keys[was.at] ? was.dir : 0,
      back: was.back,
      from: was.from,
    }
    if (!open) openScope = null
  }
  // The group of the shown image again, as its list and the shelf are now.
  const regroup = () => {
    const current = open && entries.get(open.keys[open.at])
    if (!open || !openScope || !current) return false
    const scope = openScope
    const pool = [...entries.values()].filter(e => e.scope === scope)
    const { ids, places } = scope.rows()
    const { items } = collectGroupMedia(ids, places, pool, current)
    const keys = items.map(i => i.key)
    if (keys.length === open.keys.length && keys.every((k, i) => k === open?.keys[i])) return false
    open = { ...open, keys, at: keys.indexOf(current.key) }
    return true
  }
  return {
    put(entry: ShelfEntry<T, A, S>) {
      const had = entries.get(entry.key)
      entries.set(entry.key, entry)
      if (!had && openScope !== null && entry.scope === openScope) regroup()
      if (
        had &&
        had.scope === entry.scope &&
        had.message === entry.message &&
        had.index === entry.index &&
        had.stamp === entry.stamp &&
        sameData(had.item, entry.item)
      )
        return
      changed()
    },
    drop(key: string) {
      if (!entries.delete(key)) return
      settle()
      changed()
    },
    entry: (key: string) => entries.get(key),
    // Opens the gallery of the image `key`, false when it isn't on the shelf.
    show(key: string, back: unknown = null) {
      const clicked = entries.get(key)
      if (!clicked) return false
      const { scope } = clicked
      const pool = scope ? [...entries.values()].filter(e => e.scope === scope) : [clicked]
      const { ids, places } = scope ? scope.rows() : { ids: [], places: [] }
      const { items, at } = collectGroupMedia(ids, places, pool, clicked)
      open = { keys: items.map(i => i.key), at, dir: 0, back, from: key }
      openScope = scope
      changed()
      return true
    },
    go(move: Move) {
      if (!open) return
      const at = moveTo(open.at, open.keys.length, move)
      if (at === open.at) return
      open = { ...open, at, dir: at > open.at ? 1 : -1 }
      changed()
    },
    close() {
      if (!open) return
      open = null
      openScope = null
      changed()
    },
    state: () => open,
    version: () => version,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
  }
}

export type Shelf<T extends object, A, S extends ShelfScope = ShelfScope> = ReturnType<
  typeof createShelf<T, A, S>
>

export interface Box {
  w: number
  h: number
}

// The shown image's place: its zoom (`scale`, null to fit the stage), its offset from the stage's
// centre in pixels, and its quarter turns (any integer, so a turn always moves the short way).
export interface View {
  scale: number | null
  x: number
  y: number
  turn: number
}

export const FIT: View = { scale: null, x: 0, y: 0, turn: 0 }

// Room kept around an image that fits.
export const PAD = 16

export const ZOOM_STEPS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4] as const
export const MAX_ZOOM = 4
const EPS = 1e-3

export const quarter = (turn: number) => ((turn % 4) + 4) % 4

// The image's size as turned.
export const turned = (img: Box, turn: number): Box =>
  quarter(turn) % 2 ? { w: img.h, h: img.w } : img

// The zoom that shows all of the image inside the stage, less its padding, and never above 100%.
export const fitScale = (stage: Box, img: Box, turn: number) => {
  const t = turned(img, turn)
  if (t.w <= 0 || t.h <= 0) return 1
  const w = Math.max(1, stage.w - 2 * PAD)
  const h = Math.max(1, stage.h - 2 * PAD)
  return Math.min(1, w / t.w, h / t.h)
}

export const scaleOf = (v: View, stage: Box, img: Box) => v.scale ?? fitScale(stage, img, v.turn)

export const minZoom = (fit: number) => Math.min(ZOOM_STEPS[0], fit)

export const clampZoom = (scale: number, fit: number) =>
  Math.min(MAX_ZOOM, Math.max(minZoom(fit), scale))

export const atFit = (v: View, stage: Box, img: Box) =>
  v.scale === null || Math.abs(v.scale - fitScale(stage, img, v.turn)) < EPS

// Whether all of the image shows, at fit or below: one finger then swipes between images.
export const fitsIn = (v: View, stage: Box, img: Box) =>
  v.scale === null || v.scale <= fitScale(stage, img, v.turn) + EPS

// The offset kept within what lets the image's edges reach the stage's, and centred on an axis
// where the image is smaller than the stage.
export const clampView = (v: View, stage: Box, img: Box): View => {
  const s = scaleOf(v, stage, img)
  const t = turned(img, v.turn)
  const mx = Math.max(0, (t.w * s - stage.w) / 2)
  const my = Math.max(0, (t.h * s - stage.h) / 2)
  const x = Math.min(mx, Math.max(-mx, v.x))
  const y = Math.min(my, Math.max(-my, v.y))
  return x === v.x && y === v.y ? v : { ...v, x, y }
}

export interface Point {
  x: number
  y: number
}

// Zoomed to `next`, keeping the point of the image under `at` (from the stage's centre) where it
// is. Reaching the fit zoom fits again, centred.
export const zoomAt = (
  v: View,
  stage: Box,
  img: Box,
  next: number,
  at: Point = { x: 0, y: 0 }
): View => {
  const fit = fitScale(stage, img, v.turn)
  const n = clampZoom(next, fit)
  if (Math.abs(n - fit) < EPS) return { ...v, scale: null, x: 0, y: 0 }
  const k = n / scaleOf(v, stage, img)
  return clampView(
    { ...v, scale: n, x: at.x - (at.x - v.x) * k, y: at.y - (at.y - v.y) * k },
    stage,
    img
  )
}

// The next zoom step up (`dir` 1) or down (-1) from `scale`; the fit zoom is a step too.
export const stepZoom = (scale: number, dir: 1 | -1, fit: number) => {
  const stops = [...new Set([...ZOOM_STEPS, fit])]
    .filter(s => s >= minZoom(fit) && s <= MAX_ZOOM)
    .sort((a, b) => a - b)
  const next =
    dir > 0 ? stops.find(s => s > scale + EPS) : [...stops].reverse().find(s => s < scale - EPS)
  return next ?? clampZoom(scale, fit)
}

export const zoomStep = (v: View, stage: Box, img: Box, dir: 1 | -1) =>
  zoomAt(v, stage, img, stepZoom(scaleOf(v, stage, img), dir, fitScale(stage, img, v.turn)))

export const panBy = (v: View, stage: Box, img: Box, dx: number, dy: number) =>
  clampView({ ...v, x: v.x + dx, y: v.y + dy }, stage, img)

// A quarter turn (`dir` 1 clockwise), centred; a set zoom stays within the new bounds.
export const rotateView = (v: View, stage: Box, img: Box, dir: 1 | -1): View => {
  const turn = v.turn + dir
  const scale = v.scale === null ? null : clampZoom(v.scale, fitScale(stage, img, turn))
  return clampView({ scale, x: 0, y: 0, turn }, stage, img)
}

// A double click or tap: from fit to 100% (200% for an image that fits at 100%) around `at`,
// else back to fit.
export const toggleZoom = (v: View, stage: Box, img: Box, at: Point): View => {
  if (!atFit(v, stage, img)) return { ...FIT, turn: v.turn }
  return zoomAt(v, stage, img, fitScale(stage, img, v.turn) < 1 ? 1 : 2, at)
}

// Two fingers moved from `from` to `to` (their midpoint from the stage's centre and their
// distance apart): zoomed by how far apart they are now around where they started, and moved
// with them.
export const pinchView = (
  start: View,
  stage: Box,
  img: Box,
  from: { mid: Point; dist: number },
  to: { mid: Point; dist: number }
) => {
  const scale = (scaleOf(start, stage, img) * to.dist) / Math.max(1, from.dist)
  const zoomed = zoomAt(start, stage, img, scale, from.mid)
  return panBy(zoomed, stage, img, to.mid.x - from.mid.x, to.mid.y - from.mid.y)
}

export const SWIPE_PX = 60

// A horizontal swipe of `dx` by `dy` pixels: 1 for the next image (swiped left), -1 for the
// previous one, 0 for neither.
export const swipeMove = (dx: number, dy: number): -1 | 0 | 1 => {
  if (Math.abs(dx) < SWIPE_PX || Math.abs(dx) < 1.5 * Math.abs(dy)) return 0
  return dx < 0 ? 1 : -1
}

export interface Tap {
  t: number
  x: number
  y: number
}

// Whether a tap after `prev` makes a double tap.
export const doubleTap = (prev: Tap | null, tap: Tap) =>
  prev !== null &&
  tap.t - prev.t <= 300 &&
  Math.abs(tap.x - prev.x) <= 24 &&
  Math.abs(tap.y - prev.y) <= 24

export const zoomText = (scale: number) => `${Math.round(scale * 100)}%`

// Whether an image of this name copies as one: an SVG doesn't decode into a bitmap.
export const copiesAsImage = (name: string) => !/\.svg$/i.test(name)

// Whether the page may read the pixels of an image it shows from `src` (at page address `page`):
// its own `blob:` addresses and its own origin. Others it copies from their bytes.
export const readsPixels = (src: string, page: string) => {
  if (src.startsWith('blob:')) return true
  try {
    return new URL(src, page).origin === new URL(page).origin
  } catch {
    return false
  }
}

// Where a copy of an image comes from: its decoded `image` where the page may read its pixels,
// else its fetched `bytes` when there is a way to fetch them; none until the image shows, where
// the platform can't copy images, and for an SVG.
export const copyFrom = (o: {
  src: string
  name: string
  page: string
  shows: boolean
  platform: boolean
  bytes: boolean
}): 'image' | 'bytes' | null => {
  if (!o.shows || !o.platform || !copiesAsImage(o.name)) return null
  if (readsPixels(o.src, o.page)) return 'image'
  return o.bytes ? 'bytes' : null
}

// What the viewer shows of a menu: its main button and Cancel, and the rows it offers.
export const menuStamp = (m: FileMenu) =>
  JSON.stringify([
    m.verb,
    !!m.download,
    !!m.cancel,
    m.link,
    !!m.remove,
    !!m.copyImage,
    !!m.original,
  ])

// What follows the name in the viewer's bar: "1280×720 · 207 KB · 100%", each part when known
// (the zoom once the image is placed).
export const detailText = (img: Box | null, size: number | null, scale: number | null) =>
  [
    img && img.w > 0 && img.h > 0 ? `${img.w}×${img.h}` : null,
    size !== null ? fmtSize(size) : null,
    scale !== null ? zoomText(scale) : null,
  ]
    .filter(part => part !== null)
    .join(' · ')
