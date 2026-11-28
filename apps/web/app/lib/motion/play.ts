// How a screen animates: it names a slot. `plays` and `playsOn` give an element to the engine as
// it enters, leaves or changes; `look` marks an element the style sheet moves. With animations
// off these are constants and calls that return at once: no state, effect or listener.
import type { RefCallback } from 'react'
import type { LookSlot, PlaySlot } from './slots'
import { playerNow } from './wire'

const enters = new Map<PlaySlot, RefCallback<Element>>()

// A ref for the element of `slot`: it plays as the element shows, and as it goes where the slot
// has an exit.
export const plays = (slot: PlaySlot): RefCallback<Element> => {
  let ref = enters.get(slot)
  if (!ref) {
    ref = el => {
      const player = playerNow()
      if (!el || !player) return
      player.enter(el, slot)
      return () => playerNow()?.leave(el, slot)
    }
    enters.set(slot, ref)
  }
  return ref
}

const KEPT = 512
const changes = new Map<string, RefCallback<Element>>()

// A ref for the element of `slot` that plays when `key` is another one than the element had: a
// count, a position in a list, the page shown.
export const playsOn = (slot: PlaySlot, key: string | number): RefCallback<Element> => {
  const id = `${slot}\n${typeof key}\n${key}`
  let ref = changes.get(id)
  if (!ref) {
    ref = el => {
      if (el) playerNow()?.change(el, slot, key)
    }
    if (changes.size >= KEPT) changes.clear()
    changes.set(id, ref)
  }
  return ref
}

export const MARK = 'data-motion'
export const STILL = 'data-motion-none'
export const ONLY = 'data-motion-only'

const marks = new Map<string, { readonly [MARK]: string }>()

// The attribute of an element the style sheet moves for these slots.
export const look = (...slots: LookSlot[]): { readonly [MARK]: string } => {
  const id = slots.join(' ')
  let mark = marks.get(id)
  if (!mark) {
    mark = Object.freeze({ [MARK]: id })
    marks.set(id, mark)
  }
  return mark
}

// Nothing in or over this element animates (the composer).
export const still = Object.freeze({ [STILL]: '' })

const only = new Map<PlaySlot, { readonly [ONLY]: string }>()

// Inside this element only `slot` plays (a call's tiles).
export const playsOnly = (slot: PlaySlot): { readonly [ONLY]: string } => {
  let mark = only.get(slot)
  if (!mark) {
    mark = Object.freeze({ [ONLY]: slot })
    only.set(slot, mark)
  }
  return mark
}
