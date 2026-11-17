import { useStore } from '../store'
import { adminActions } from './admin'
import { cardActions } from './cards'
import { channelActions } from './channel'
import { ctxFor } from './ctx'
import { dmActions, dmListActions } from './dm'
import { folderActions } from './folder'
import { friendActions } from './friends'
import { globalActions, goActions } from './global'
import { guestVoiceMenuActions } from './guest_voice'
import { headerActions } from './header'
import { maskedActions } from './masked'
import { memberActions } from './member'
import { itemFor } from './menu'
import { embedActions, messageActions } from './message'
import { p2pChatActions } from './p2p_chat'
import { p2pContactActions } from './p2p_contact'
import { p2pServerActions } from './p2p_server'
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
    dmListActions,
    messageActions,
    embedActions,
    serverActions,
    channelActions,
    cardActions,
    voiceActions,
    guestVoiceMenuActions,
    headerActions,
    p2pContactActions,
    p2pServerActions,
    p2pChatActions,
    maskedActions,
  ])
    for (const a of list) defineAction(a)
}

// The home menus' "Mark all as read" row (`mark_all_read`), for a signed-in account.
export const markAllReadItem = () => {
  registerAppActions()
  return itemFor('mark_all_read', ctxFor(useStore.getState(), { kind: 'home' }, 'menu'))!
}
