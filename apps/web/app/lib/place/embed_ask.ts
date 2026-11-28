import type { Live } from './live'

// Asks the main composer on screen to open the embed builder (the palette's "Create embed"):
// each ask counts one up, and the composer opens the builder when the count changes.
let asks = 0
const subs = new Set<() => void>()

export const embedAsks: Live<number> = {
  get: () => asks,
  initial: () => 0,
  subscribe: changed => {
    subs.add(changed)
    return () => {
      subs.delete(changed)
    }
  },
}

export const askEmbed = () => {
  asks += 1
  for (const changed of subs) changed()
}
