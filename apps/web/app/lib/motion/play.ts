// How a screen animates: it names a slot. `plays` and `playsOn` give an element to the engine as
// it enters, leaves or changes; `look` marks an element the style sheet moves. With animations
// off these are constants and calls that return at once: no state, effect or listener.
import type { RefCallback, RefObject } from 'react'
import type { LookSlot, PlaySlot } from './slots'
import { playerNow } from './wire'

type Other = RefCallback<never> | { current: unknown } | null | undefined

const made = (slot: PlaySlot, behind: boolean): RefCallback<Element> => {
  return el => {
    const player = playerNow()
    if (!el || !player) return
    player.enter(el, slot, behind)
    return () => playerNow()?.leave(el, slot, behind)
  }
}

// `ref` and `also` as one ref.
const joined = (ref: RefCallback<Element>, also: NonNullable<Other>): RefCallback<Element> => {
  const other = also as RefCallback<Element> | RefObject<Element | null>
  return el => {
    const undo = ref(el)
    if (typeof other !== 'function') {
      other.current = el
      return () => {
        if (typeof undo === 'function') undo()
        other.current = null
      }
    }
    const undoOther = other(el)
    return () => {
      if (typeof undo === 'function') undo()
      if (typeof undoOther === 'function') undoOther()
      else other(null)
    }
  }
}

const cached = (
  refs: Map<PlaySlot, RefCallback<Element>>,
  joins: Map<PlaySlot, WeakMap<object, RefCallback<Element>>>,
  behind: boolean
) => {
  return (slot: PlaySlot, also?: Other): RefCallback<Element> => {
    let ref = refs.get(slot)
    if (!ref) {
      ref = made(slot, behind)
      refs.set(slot, ref)
    }
    if (!also) return ref
    let bySlot = joins.get(slot)
    if (!bySlot) {
      bySlot = new WeakMap()
      joins.set(slot, bySlot)
    }
    let both = bySlot.get(also)
    if (!both) {
      both = joined(ref, also)
      bySlot.set(also, both)
    }
    return both
  }
}

// A ref for the element of `slot`: it plays as the element shows, and as it goes where the slot
// has an exit. `also` is another ref the element has.
export const plays = cached(new Map(), new Map(), false)

// A ref for what lies behind the element of `slot` (a scrim, a blur): it fades in step with it.
export const playsBehind = cached(new Map(), new Map(), true)

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
