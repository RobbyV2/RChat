// What joins the slot helpers the screens use (`play.ts`, `use_motion.ts`) to the engine, which
// loads only while animations are on. Nothing outside this folder imports it.
import type { PlaySlot, SlotId } from './slots'

export interface Player {
  // `behind`: the element lies behind the slot's own (a scrim, a blur) and only fades with it.
  enter(el: Element, slot: PlaySlot, behind?: boolean): void
  leave(el: Element, slot: PlaySlot, behind?: boolean): void
  change(el: Element, slot: PlaySlot, key: string | number): void
  stop(): void
}

const NONE: ReadonlySet<SlotId> = new Set()

let player: Player | null = null
let live = NONE
let blurring = NONE
const watchers = new Set<() => void>()

export const playerNow = () => player

// The slots that move now: none while animations are off or reduced, fewer once the tab runs
// late. Backdrops blur for the same slots until the tab runs late at all.
export const liveNow = () => live
export const blurringNow = () => blurring

export const watchLive = (changed: () => void) => {
  watchers.add(changed)
  return () => void watchers.delete(changed)
}

export const setLive = (
  plays: ReadonlySet<SlotId> | null,
  blurs: ReadonlySet<SlotId> | null = plays
) => {
  live = plays ?? NONE
  blurring = blurs ?? NONE
  for (const w of [...watchers]) w()
}

// Puts `make`'s player in place of the one running, which stops first, so what the new one
// tells the page is not undone.
export const setPlayer = (make: (() => Player) | null) => {
  player?.stop()
  player = null
  if (!make) {
    setLive(null)
    return
  }
  player = make()
}
