import { friendActions } from './friends'
import { globalActions, goActions } from './global'
import { placeActions } from './place'
import { defineAction } from './registry'
import { selectionActions } from './selection'
import { settingsActions } from './settings'

let registered = false

// The app's own actions, once. The palette lists them in this order.
export const registerAppActions = () => {
  if (registered) return
  registered = true
  for (const list of [
    selectionActions,
    goActions,
    placeActions,
    globalActions,
    friendActions,
    settingsActions,
  ])
    for (const a of list) defineAction(a)
}
