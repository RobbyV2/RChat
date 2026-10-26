'use client'

import { create } from 'zustand'
import {
  autoScrollStep,
  nearestSpan,
  offSide,
  slotAt,
  type Box,
  type DropTarget,
  type Slot,
} from '../lib/drag'

export interface DragSpec {
  group: string
  key: string
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
  frame: number
  abort: () => void
}

let active: Active | null = null
let lifted: HTMLElement | null = null

const STRIP = ['data-lifted', 'data-pressed', 'data-drag-source', 'data-drag-key', 'id', 'title']

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

const boxesIn = (zone: HTMLElement): Box[] =>
  itemsIn(zone).map(el => {
    const r = el.getBoundingClientRect()
    return { key: el.dataset.dragKey ?? '', top: r.top, bottom: r.bottom }
  })

const resolve = (a: Active, rect: DOMRect): [(DropTarget & Slot) | null, HTMLElement | null] => {
  if (offSide(a.x, rect.left, rect.right)) return [null, null]
  const zones = [...a.scope.querySelectorAll<HTMLElement>('[data-drop-zone]')]
  if (zones.length === 0) return [null, null]
  const probe = zoneOf(document.elementFromPoint(rect.left + rect.width / 2, a.y))
  const zone =
    probe && zones.includes(probe)
      ? probe
      : zones[
          nearestSpan(
            zones.map(z => z.getBoundingClientRect()),
            a.y
          )
        ]
  const slot = slotAt(boxesIn(zone), a.y, a.spec.key)
  return [{ zone: zone.dataset.dropZone ?? '', ...slot }, zone]
}

const placeLine = (a: Active, rect: DOMRect, zone: HTMLElement | null) => {
  const t = a.target
  const box = zone && (itemsIn(zone)[0] ?? zone).getBoundingClientRect()
  if (!t || t.noop || t.line === null || !box) {
    a.line.hidden = true
    return
  }
  a.line.hidden = false
  a.line.style.width = `${box.width}px`
  const y = Math.min(rect.bottom - 2, Math.max(rect.top + 2, t.line))
  a.line.style.transform = `translate(${box.left}px, ${y}px)`
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
  const [next, zoneEl] = resolve(a, rect)
  const was = a.target
  a.target = next
  a.ghost.toggleAttribute('data-off', next === null)
  const label = next && !next.noop && next.zone !== a.from ? zoneEl?.dataset.dropLabel : undefined
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
    const chip = document.createElement('span')
    chip.className = 'drag-chip'
    chip.hidden = true
    ghost.append(chip)
    const line = document.createElement('div')
    line.className = 'drag-line'
    line.dataset.group = spec.group
    line.hidden = true
    document.body.append(ghost, line)
    el.setAttribute('data-drag-source', '')
    document.documentElement.setAttribute('data-dragging', '')
    window.getSelection()?.removeAllRanges()
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('blur', onBlur)
    active = {
      spec,
      el,
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
    a.el.removeAttribute('data-drag-source')
    document.documentElement.removeAttribute('data-dragging')
    useDrag.setState({ group: null, key: null, zone: null })
    const t = a.target
    if (commit && t && !t.noop) a.spec.onDrop({ zone: t.zone, index: t.index })
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
