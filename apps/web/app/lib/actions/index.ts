import { adminActions } from './admin'
import { cardActions } from './cards'
import { channelActions } from './channel'
import { dmActions } from './dm'
import { folderActions } from './folder'
import { friendActions } from './friends'
import { globalActions, goActions } from './global'
import { memberActions } from './member'
import { embedActions, messageActions } from './message'
import { placeActions } from './place'
import { defineAction } from './registry'
import { selectionActions } from './selection'
import { serverActions } from './server'
import { settingsActions } from './settings'
import { voiceActions } from './voice'

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
    folderActions,
    settingsActions,
    memberActions,
    adminActions,
    dmActions,
    messageActions,
    embedActions,
    serverActions,
    channelActions,
    cardActions,
    voiceActions,
  ])
    for (const a of list) defineAction(a)
}
