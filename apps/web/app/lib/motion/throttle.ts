import { DESKTOP, FxThrottle } from '../fx/particles'

// The tab's one throttle, the same that fun effects step down: late frames while something
// animates step Lively down to Subtle, then to nothing for the tab.
let tab: FxThrottle | null = null
export const tabThrottle = () => (tab ??= new FxThrottle(DESKTOP))

// What a throttle step leaves of the style: step 1 plays Subtle, the steps past it nothing.
export type Step = 'full' | 'calm' | 'none'
export const stepOf = (t: Pick<FxThrottle, 'step'>): Step =>
  t.step === 0 ? 'full' : t.step === 1 ? 'calm' : 'none'
