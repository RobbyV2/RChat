// What joins the slot helpers the screens use (`play.ts`, `use_motion.ts`) to the engine, which
// loads only while animations are on. Nothing outside this folder imports it.
import type { PlaySlot, SlotId } from './slots'

export interface Player {
  enter(el: Element, slot: PlaySlot): void
  leave(el: Element, slot: PlaySlot): void
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

export const setPlayer = (next: Player | null) => {
  if (player && player !== next) player.stop()
  player = next
  if (!next) setLive(null)
}
