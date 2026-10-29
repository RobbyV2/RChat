'use client'

import { create } from 'zustand'
import {
  autoScrollStep,
  layoutSpan,
  nearestSpan,
  offSide,
  ontoBand,
  slotAt,
  type Box,
  type DropTarget,
  type Slot,
  type Span,
} from '../lib/drag'

export interface DragSpec {
  group: string
  key: string
  zones?: (zone: string) => boolean
  onto?: (key: string) => boolean
  onDrop: (target: DropTarget) => void
}

interface DragView {
  group: string | null
  key: string | null
  zone: string | null
}

export const useDrag = create<DragView>(() => ({ group: null, key: null, zone: null }))

interface Active {
  spec: DragSpec
  el: HTMLElement
  source: HTMLElement
  scope: HTMLElement
  ghost: HTMLElement
  chip: HTMLElement
  line: HTMLElement
  from: string | null
  dx: number
  dy: number
  x: number
  y: number
  target: (DropTarget & Slot) | null
  merge: HTMLElement | null
  frame: number
  abort: () => void
}

let active: Active | null = null
let lifted: HTMLElement | null = null

const STRIP = [
  'data-lifted',
  'data-pressed',
  'data-drag-source',
  'data-drag-key',
  'data-drop-target',
  'id',
  'title',
]

const ghostOf = (el: HTMLElement, rect: DOMRect) => {
  const ghost = document.createElement('div')
  ghost.className = 'drag-ghost'
  ghost.setAttribute('aria-hidden', 'true')
  ghost.style.width = `${rect.width}px`
  ghost.style.height = `${rect.height}px`
  ghost.style.borderRadius = getComputedStyle(el).borderRadius
  const clone = el.cloneNode(true) as HTMLElement
  for (const node of [clone, ...clone.querySelectorAll<HTMLElement>('*')])
    for (const attr of STRIP) node.removeAttribute(attr)
  clone.style.margin = '0'
  clone.style.width = '100%'
  clone.style.height = '100%'
  ghost.append(clone)
  return ghost
}

const zoneOf = (el: Element | null) => el?.closest<HTMLElement>('[data-drop-zone]') ?? null

const itemsIn = (zone: HTMLElement) =>
  [...zone.querySelectorAll<HTMLElement>('[data-drag-key]')].filter(el => zoneOf(el) === zone)

const boxOf = (el: HTMLElement) => {
  const box = el.closest<HTMLElement>('[data-drag-box]')
  return box && zoneOf(box) === zoneOf(el) ? box : el
}

const spanOf = (el: HTMLElement): Span => {
  const { top, bottom } = el.getBoundingClientRect()
  return layoutSpan({ top, bottom }, el.offsetHeight)
}

const boxesIn = (items: HTMLElement[], merges: boolean): Box[] =>
  items.map(el => {
    const box = boxOf(el)
    const { top, bottom } = spanOf(box)
    const own = spanOf(el)
    const onto = merges && el.dataset.dropOnto ? ontoBand(own.top, own.bottom, box !== el) : null
    return { key: el.dataset.dragKey ?? '', top, bottom, onto }
  })

interface Resolved {
  target: (DropTarget & Slot) | null
  zone: HTMLElement | null
  onto: HTMLElement | null
}

const none: Resolved = { target: null, zone: null, onto: null }

const resolve = (a: Active, rect: DOMRect): Resolved => {
  if (offSide(a.x, rect.left, rect.right)) return none
  const zones = [...a.scope.querySelectorAll<HTMLElement>('[data-drop-zone]')].filter(
    z => a.spec.zones?.(z.dataset.dropZone ?? '') ?? true
  )
  if (zones.length === 0) return none
  let probe = zoneOf(document.elementFromPoint(rect.left + rect.width / 2, a.y))
  while (probe && !zones.includes(probe)) probe = zoneOf(probe.parentElement)
  const zone =
    probe ??
    zones[
      nearestSpan(
        zones.map(z => z.getBoundingClientRect()),
        a.y
      )
    ]
  const items = itemsIn(zone)
  const slot = slotAt(boxesIn(items, a.spec.onto !== undefined), a.y, a.spec.key)
  const blocked = slot.onto !== null && !(a.spec.onto?.(slot.onto) ?? false)
  const onto = blocked ? null : (items.find(el => el.dataset.dragKey === slot.onto) ?? null)
  return {
    target: {
      ...slot,
      zone: zone.dataset.dropZone ?? '',
      noop: slot.noop || blocked,
      onto: onto ? slot.onto : null,
    },
    zone,
    onto,
  }
}

const highlight = (a: Active, el: HTMLElement | null) => {
  const next = el && boxOf(el)
  if (next === a.merge) return
  a.merge?.removeAttribute('data-drop-target')
  next?.setAttribute('data-drop-target', '')
  a.merge = next
  a.ghost.toggleAttribute('data-merge', next !== null)
}

const placeLine = (a: Active, rect: DOMRect, zone: HTMLElement | null) => {
  const t = a.target
  const first = zone && (itemsIn(zone)[0] ?? zone)
  if (!t || t.noop || t.line === null || !first) {
    a.line.hidden = true
    return
  }
  const { left, width } = first.getBoundingClientRect()
  const w = first.offsetWidth
  a.line.hidden = false
  a.line.style.width = `${w}px`
  const y = Math.min(rect.bottom - 2, Math.max(rect.top + 2, t.line))
  a.line.style.transform = `translate(${left + (width - w) / 2}px, ${y}px)`
}

const tick = () => {
  const a = active
  if (!a) return
  if (!a.el.isConnected || !a.scope.isConnected) {
    a.abort()
    return
  }
  a.ghost.style.transform = `translate(${a.x - a.dx}px, ${a.y - a.dy}px)`
  const rect = a.scope.getBoundingClientRect()
  const step = autoScrollStep(a.y, rect.top, rect.bottom)
  if (step !== 0 && !offSide(a.x, rect.left, rect.right)) a.scope.scrollTop += step
  const { target: next, zone: zoneEl, onto } = resolve(a, rect)
  const was = a.target
  a.target = next
  a.ghost.toggleAttribute('data-off', next === null)
  highlight(a, onto)
  const label = onto
    ? onto.dataset.dropOnto
    : next && !next.noop && next.zone !== a.from
      ? zoneEl?.dataset.dropLabel
      : undefined
  a.chip.textContent = label ?? ''
  a.chip.hidden = !label
  placeLine(a, rect, zoneEl)
  const zone = next && !next.noop ? next.zone : null
  if ((was && !was.noop ? was.zone : null) !== zone) useDrag.setState({ zone })
  a.frame = requestAnimationFrame(tick)
}

const onKey = (e: KeyboardEvent) => {
  if (e.key !== 'Escape' || !active) return
  e.preventDefault()
  e.stopPropagation()
  active.abort()
}

const onBlur = () => active?.abort()

export const dnd = {
  blocking: () => lifted !== null || active !== null,
  lift: (el: HTMLElement) => {
    lifted = el
    el.setAttribute('data-lifted', '')
  },
  unlift: () => {
    lifted?.removeAttribute('data-lifted')
    lifted = null
  },
  start: (spec: DragSpec, el: HTMLElement, ox: number, oy: number, abort: () => void) => {
    dnd.finish(false)
    const scope = el.closest<HTMLElement>('[data-drag-scope]')
    if (!scope) return
    const rect = el.getBoundingClientRect()
    const ghost = ghostOf(el, rect)
    ghost.dataset.group = spec.group
    const chip = document.createElement('span')
    chip.className = 'drag-chip'
    chip.hidden = true
    ghost.append(chip)
    const line = document.createElement('div')
    line.className = 'drag-line'
    line.dataset.group = spec.group
    line.hidden = true
    document.body.append(ghost, line)
    const source = boxOf(el)
    source.setAttribute('data-drag-source', '')
    document.documentElement.setAttribute('data-dragging', '')
    window.getSelection()?.removeAllRanges()
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('blur', onBlur)
    active = {
      spec,
      el,
      source,
      scope,
      ghost,
      chip,
      line,
      from: zoneOf(el)?.dataset.dropZone ?? null,
      dx: ox - rect.left,
      dy: oy - rect.top,
      x: ox,
      y: oy,
      target: null,
      merge: null,
      frame: 0,
      abort,
    }
    useDrag.setState({ group: spec.group, key: spec.key, zone: null })
    tick()
  },
  move: (x: number, y: number) => {
    if (!active) return
    active.x = x
    active.y = y
  },
  finish: (commit: boolean) => {
    const a = active
    if (!a) return
    active = null
    cancelAnimationFrame(a.frame)
    window.removeEventListener('keydown', onKey, true)
    window.removeEventListener('blur', onBlur)
    a.ghost.remove()
    a.line.remove()
    a.source.removeAttribute('data-drag-source')
    a.merge?.removeAttribute('data-drop-target')
    document.documentElement.removeAttribute('data-dragging')
    useDrag.setState({ group: null, key: null, zone: null })
    const t = a.target
    if (commit && t && !t.noop) a.spec.onDrop({ zone: t.zone, index: t.index, onto: t.onto })
  },
}

export const dragScope = (el: HTMLElement | null) => {
  if (!el) return
  const onMove = (e: TouchEvent) => {
    if (dnd.blocking() && e.cancelable) e.preventDefault()
  }
  el.setAttribute('data-drag-scope', '')
  el.addEventListener('touchmove', onMove, { passive: false })
  return () => el.removeEventListener('touchmove', onMove)
}
