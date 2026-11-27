import type { AccountSession } from '../client/session'
import type { P2pApp } from '../p2p/app/runtime'
import { displayName } from '../p2p/contacts'
import { conversationPlace, dmPlace, roomPlace, serverPlace, type TabPlace } from '../tab_title'
import { defineFeature } from './feature'
import { fromStore, type Live } from './live'

// What a place is called while it is on screen: its server and channel, or who the conversation
// is with (the app, while that is not known).
export interface Named {
  shown: Live<TabPlace>
}

const same = (a: TabPlace, b: TabPlace) => {
  const x = a as unknown as Record<string, unknown>
  const y = b as unknown as Record<string, unknown>
  const keys = Object.keys(x)
  return keys.length === Object.keys(y).length && keys.every(k => Object.is(x[k], y[k]))
}

const hostedServer = (account: AccountSession, server: string): Named => ({
  shown: fromStore(
    account.store,
    s =>
      serverPlace(
        s,
        server,
        s.view?.kind === 'channel' && s.view.server === server ? s.view.channelId : null
      ),
    same
  ),
})

const hostedDm = (account: AccountSession, dmId: number): Named => ({
  shown: fromStore(account.store, s => dmPlace(s, dmId), same),
})

const peerRoom = (app: P2pApp, room: string): Named => ({
  shown: fromStore(
    app.useP2p,
    s => roomPlace(s, room, s.server?.room === room ? (s.server.ch ?? null) : null),
    same
  ),
})

const peerDm = (app: P2pApp, room: string): Named => ({
  shown: fromStore(
    app.useP2p,
    s => {
      const peer = s.rooms[room]?.peer ?? (s.chat?.room === room ? s.chat.peer : null)
      const contact = peer === null ? undefined : s.contacts.find(c => c.ik === peer)
      return conversationPlace(contact ? displayName(contact) : null)
    },
    same
  ),
})

// The name of a place on screen.
export const named = defineFeature<Named>('named', {
  hostedServer: place => hostedServer(place.account, place.server),
  p2pRoom: place => peerRoom(place.app, place.room),
  hostedDm: place => hostedDm(place.account, place.dmId),
  p2pDm: place => peerDm(place.app, place.room),
})
