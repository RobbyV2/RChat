// The page as the engine sees it, on the real document.
import type { Time } from '../clock'
import type { Page, Place, Shot } from './engine'
import { MARK, ONLY, STILL } from './play'
import type { PlaySlot, SlotId } from './slots'
import { spring } from './spring'
import { SPRINGS } from './tokens'

const STYLE = 'data-motion'
const LOOKS = 'data-motion-slots'
// A copy with more elements than this, or with what a copy can't show, goes without an exit.
const MAX_COPIED = 1500
const UNCOPIED = 'video, canvas, iframe'
const CARRIED = [
  'color',
  'font',
  'letter-spacing',
  'text-align',
  'direction',
  'white-space',
] as const

interface Taken {
  box: DOMRect
  carried: [string, string][]
  scrolls: [number, number][]
}

const GENTLE = '--motion-spring-gentle'
const BOUNCY = '--motion-spring-bouncy'

export const page = (doc: Document, time: Time): Page & { close(): void } => {
  const root = doc.documentElement
  const came = new Set<Node>()
  const went = new Set<Node>()
  let clearing = false
  const note = (records: MutationRecord[]) => {
    for (const r of records) {
      for (const n of r.addedNodes) came.add(n)
      for (const n of r.removedNodes) went.add(n)
    }
    if (clearing || (came.size === 0 && went.size === 0)) return
    clearing = true
    time.after(0, () => {
      clearing = false
      came.clear()
      went.clear()
    })
  }
  const watcher = new MutationObserver(note)
  watcher.observe(doc.body, { childList: true, subtree: true })
  const seen = () => note(watcher.takeRecords())

  return {
    hidden: () => doc.visibilityState === 'hidden',
    open(el: Element, slot: PlaySlot) {
      if (el.closest(`[${STILL}]`)) return false
      const only = el.closest(`[${ONLY}]`)
      return !only || only.getAttribute(ONLY) === slot
    },
    within: (el, other) => other !== el && other.contains(el),
    addedWith(el) {
      seen()
      let found: Element | null = null
      for (let n: Node | null = el; n && n !== doc.body; n = n.parentNode)
        if (came.has(n)) found = n as Element
      return found
    },
    removedWith(el) {
      seen()
      let top: Node = el
      while (top.parentNode) top = top.parentNode
      return went.has(top) ? (top as Element) : null
    },
    lastOfOld(added) {
      const before = added.previousElementSibling
      return !added.nextElementSibling && before !== null && !came.has(before)
    },
    place(el): Place {
      const box = el as HTMLElement
      return { x: box.offsetLeft ?? 0, y: box.offsetTop ?? 0 }
    },
    shoot(el): Shot | null {
      if (el.matches(UNCOPIED) || el.querySelector(UNCOPIED)) return null
      const inside = el.getElementsByTagName('*')
      if (inside.length > MAX_COPIED) return null
      const box = el.getBoundingClientRect()
      if (box.width === 0 || box.height === 0) return null
      if (box.bottom < 0 || box.right < 0) return null
      if (box.top > root.clientHeight || box.left > root.clientWidth) return null
      const style = getComputedStyle(el)
      const scrolls: [number, number][] = []
      for (let i = 0; i < inside.length; i++)
        if (inside[i].scrollTop > 0) scrolls.push([i, inside[i].scrollTop])
      const taken: Taken = {
        box,
        carried: CARRIED.map(name => [name, style.getPropertyValue(name)]),
        scrolls,
      }
      return taken
    },
    ghost(el, shot) {
      const { box, carried, scrolls } = shot as Taken
      const copy = el.cloneNode(true) as HTMLElement
      if (!copy.style) return null
      for (const id of [copy, ...copy.querySelectorAll('[id]')]) id.removeAttribute('id')
      copy.setAttribute('aria-hidden', 'true')
      copy.setAttribute('inert', '')
      copy.removeAttribute(MARK)
      const s = copy.style
      for (const [name, value] of carried) s.setProperty(name, value)
      s.setProperty('position', 'fixed')
      s.setProperty('inset', 'auto')
      s.setProperty('left', `${box.left}px`)
      s.setProperty('top', `${box.top}px`)
      s.setProperty('width', `${box.width}px`)
      s.setProperty('height', `${box.height}px`)
      s.setProperty('max-width', 'none')
      s.setProperty('max-height', 'none')
      s.setProperty('min-width', '0')
      s.setProperty('min-height', '0')
      s.setProperty('margin', '0')
      s.setProperty('box-sizing', 'border-box')
      s.setProperty('pointer-events', 'none')
      s.setProperty('z-index', 'var(--z-index-drag)')
      s.setProperty('animation', 'none')
      doc.body.appendChild(copy)
      const inside = copy.getElementsByTagName('*')
      for (const [i, top] of scrolls) if (inside[i]) inside[i].scrollTop = top
      return copy
    },
    twin(el, inner, ghost) {
      const path: number[] = []
      for (let n = inner; n !== el;) {
        const up = n.parentElement
        if (!up) return null
        path.push(Array.prototype.indexOf.call(up.children, n))
        n = up
      }
      let at: Element | undefined = ghost
      for (let i = path.length - 1; at && i >= 0; i--) at = at.children[path[i]]
      return at ?? null
    },
    drop: ghost => ghost.remove(),
    mark(style, looks: readonly SlotId[]) {
      if (style === null) {
        root.removeAttribute(STYLE)
        root.removeAttribute(LOOKS)
        root.style.removeProperty(GENTLE)
        root.style.removeProperty(BOUNCY)
        return
      }
      root.setAttribute(STYLE, style)
      if (looks.length) root.setAttribute(LOOKS, looks.join(' '))
      else root.removeAttribute(LOOKS)
      root.style.setProperty(
        GENTLE,
        spring(SPRINGS.gentle.stiffness, SPRINGS.gentle.damping).easing
      )
      root.style.setProperty(
        BOUNCY,
        spring(SPRINGS.bouncy.stiffness, SPRINGS.bouncy.damping).easing
      )
    },
    soon: fn => queueMicrotask(fn),
    close() {
      watcher.disconnect()
      came.clear()
      went.clear()
    },
  }
}
