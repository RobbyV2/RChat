// The one question every effect asks. Pure; the runtime collects the inputs.

export type FxMode = 'off' | 'still' | 'motion'

// The account's Motion setting, shared by animations and fun effects: follow the device (off
// under reduced motion), reduced (effects show still pictures), or play motion anyway.
export type MotionChoice = 'device' | 'still' | 'always'

export interface FxInput {
  // The shown account's instance `fun_effects`; false until its settings have loaded, so
  // nothing plays before.
  instanceOn: boolean
  // The account's master switch, and the effect's own toggle.
  prefsOn: boolean
  kindOn: boolean
  // The server's switch (true outside servers).
  placeOn: boolean
  reducedMotion: boolean
  motion: MotionChoice
  // Battery saver or Save-Data, or a tab whose pre-roll found animation capped (30 fps or
  // slower: iOS Low Power Mode, a 30 Hz panel).
  lowPower: boolean
  // The tab's throttle reached its last step: nothing more this session, until Reset.
  paused?: boolean
  // This device shares a screen in any session (CallGuard).
  sharingScreen: boolean
  pageVisible: boolean
  // Moves the whole UI or follows the pointer (barrel roll, flip, tilt, party drift, the
  // anniversary trail): only ever in full motion.
  wholeUi?: boolean
}

export function fxAllowed(i: FxInput): FxMode {
  if (!i.instanceOn || !i.prefsOn || !i.kindOn || !i.placeOn) return 'off'
  if (i.sharingScreen || !i.pageVisible || i.paused) return 'off'
  // Approved rule: off under reduced motion unless the user turns effects on anyway.
  let mode: FxMode =
    i.motion === 'still' ? 'still' : i.reducedMotion && i.motion === 'device' ? 'off' : 'motion'
  if (mode === 'motion' && i.lowPower) mode = 'still'
  if (i.wholeUi && mode !== 'motion') return 'off'
  return mode
}

// What the settings section says under the switch, or null.
export function heldBackLine(i: FxInput, instance: string): string | null {
  if (!i.instanceOn) return `Fun effects are turned off on ${instance}.`
  if (i.sharingScreen) return 'Paused while you share your screen.'
  // Shown with a Reset button that clears `fx_throttle`.
  if (i.paused) return 'Effects are paused on this device for now.'
  if (i.reducedMotion && i.motion === 'device')
    return 'Your device asks for less motion, so effects are off.'
  if (i.lowPower && i.motion !== 'still')
    return 'Battery saver is on, so effects are still pictures.'
  return null
}
