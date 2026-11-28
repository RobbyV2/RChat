import { ManualTime, flush } from '../../clock'
import { deviceTime, setTime } from '../../platform/time'
import { own } from './fixture'

// The runtime's own timer, taken before any test can replace it.
const realTimeout = setTimeout

// Waits until `ok()` holds, however slow the machine is, looking again every 2 ms of device time
// so the checks leave the work they wait for room to run. A wait that never ends fails with
// `what` after `ms`, so it cannot outlive its test.
export const waitUntil = async (
  ok: () => boolean | Promise<boolean>,
  what = 'condition',
  ms = 50_000
) => {
  const end = Date.now() + ms
  while (!(await ok())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await new Promise<void>(done => realTimeout(done, 2))
  }
}

// A clock the test moves by hand, in use until the test (or the file, made outside a test) ends.
// Every session runs on it, also the ones made before. It starts at the device's time, and the
// timers it still holds at the end go on with the device's.
export function testClock(start = Date.now()) {
  const clock = new ManualTime(start)
  setTime(clock)
  active = clock
  return own(clock, () => {
    setTime()
    active = null
    clock.release(deviceTime)
  })
}

let active: ManualTime | null = null

// The test clock in use, if the test set one.
export const activeClock = () => active

export { ManualTime, flush }
