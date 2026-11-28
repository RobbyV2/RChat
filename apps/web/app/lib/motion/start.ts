// Starts the engine on this tab's document. Loaded on demand (`host.ts`).
import { time } from '../platform/time'
import { page } from './dom'
import { Engine, type Config } from './engine'
import { tabThrottle } from './throttle'
import { setLive, type Player } from './wire'

export const start = (config: Config): Player => {
  const on = page(document, time())
  const engine = new Engine(config, on, time(), tabThrottle(), {
    set: (plays, blurs) => setLive(plays, blurs),
  })
  return {
    enter: (el, slot) => engine.enter(el, slot),
    leave: (el, slot) => engine.leave(el, slot),
    change: (el, slot, key) => engine.change(el, slot, key),
    stop() {
      engine.stop()
      on.close()
    },
  }
}
