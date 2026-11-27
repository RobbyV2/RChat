import { FRAME_MS, type Time } from '../clock'

// The device's own clock and timers. The globals are read on each call.
export const deviceTime: Time = {
  now: () => Date.now(),
  elapsed: () => performance.now(),
  after(ms, fn) {
    const id = setTimeout(fn, ms)
    return () => clearTimeout(id)
  },
  every(ms, fn) {
    const id = setInterval(fn, ms)
    return () => clearInterval(id)
  },
  frame(fn) {
    if (typeof requestAnimationFrame !== 'function') {
      const id = setTimeout(() => fn(performance.now()), FRAME_MS)
      return () => clearTimeout(id)
    }
    const id = requestAnimationFrame(fn)
    return () => cancelAnimationFrame(id)
  },
  deadline: ms => AbortSignal.timeout(ms),
}

let current: Time = deviceTime

// The time in use: the device's, unless a test registered its own.
export const time = () => current

export const setTime = (next: Time = deviceTime) => {
  current = next
}
