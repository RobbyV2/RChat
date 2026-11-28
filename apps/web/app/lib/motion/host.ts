// Turns the engine on and off for the shown account's setting. With animations off nothing of the
// engine is loaded or left running.
import { motionMode, type AnimPrefs } from './setting'
import { setPlayer } from './wire'

let asked = 0

export type Load = () => Promise<Pick<typeof import('./start'), 'start'>>
const load: Load = () => import('./start')

export const applyMotion = async (prefs: AnimPrefs, reducedMotion: boolean, from: Load = load) => {
  const turn = ++asked
  const mode = motionMode(prefs, reducedMotion)
  if (mode === 'off') {
    setPlayer(null)
    return
  }
  const { start } = await from()
  if (turn !== asked) return
  setPlayer(start({ style: prefs.style, custom: prefs.custom, reduced: mode === 'reduced' }))
}

export const stopMotion = () => {
  asked++
  setPlayer(null)
}
