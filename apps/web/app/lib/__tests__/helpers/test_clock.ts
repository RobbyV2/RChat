import { ManualTime } from '../../clock'
import { setTime } from '../../platform/time'
import { own } from './fixture'

// A clock the test moves by hand, in use until the test (or the file, made outside a test) ends.
// Sessions made after this call run on it.
export function testClock(start?: number) {
  const clock = new ManualTime(start)
  setTime(clock)
  return own(clock, () => setTime())
}
