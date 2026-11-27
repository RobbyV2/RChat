import type { AccountSession } from '../client/session'
import { identityScopeKey } from '../p2p/app/host'
import type { P2pApp } from '../p2p/app/runtime'
import { chatKey, chatScope } from '../p2p/app/store'
import { viewKey } from '../view'
import { defineFeature } from './feature'
import { built, type Live } from './live'

// One end of a message list: whether more is stored past it, and whether a page is on its way.
export interface ListEnd {
  more: boolean
  loading: boolean
}

export interface MessagesState {
  // The key the list's scroll position and selection go by; null with no conversation of the
  // place on screen (or a voice channel).
  scope: string | null
  older: ListEnd
  newer: ListEnd
  // Whether a page loads as soon as its end of the list shows; where it does not, a control in
  // the list asks for it.
  pagesOnSight: boolean
}

// The message list of the conversation a place has on screen: where it is in its history, and
// how it moves. Messages are named by `key` (an id as the place writes it).
export interface Messages {
  state: Live<MessagesState>
  loadOlder: () => void
  loadNewer: () => void
  // Shows the message, loading the page around it when it is not in the list.
  jump: (key: string) => void
  toPresent: () => void
  toUnread: () => void
  // Everything up to `lastKey`, the newest message in the list, is read.
  markRead: (lastKey: string) => void
  // Drops the unread line without moving.
  dismissUnread: () => void
}

const NONE: ListEnd = { more: false, loading: false }

const hosted = (account: AccountSession): Messages => {
  const { store } = account
  const scopeOf = (initial: boolean) => {
    const s = initial ? store.getInitialState() : store.getState()
    const v = s.view
    if (!v) return null
    if (v.kind !== 'channel') return viewKey(v)
    const channel = s.servers[v.server]?.channels.find(c => c.id === v.channelId)
    return channel?.kind === 'voice' ? null : viewKey(v)
  }
  const state = (initial: boolean) =>
    built(
      () => {
        const s = initial ? store.getInitialState() : store.getState()
        const key = s.view ? viewKey(s.view) : null
        return [
          scopeOf(initial),
          key ? s.older[key] : undefined,
          key ? s.newer[key] : undefined,
        ] as const
      },
      ([scope, older, newer]): MessagesState => ({
        scope,
        older: { more: older?.more !== false, loading: older?.loading === true },
        newer: { more: newer?.more === true, loading: newer?.loading === true },
        pagesOnSight: true,
      })
    )
  const at = (run: (scope: string) => void) => {
    const scope = scopeOf(false)
    if (scope !== null) run(scope)
  }
  return {
    state: {
      get: state(false),
      initial: state(true),
      subscribe: changed => store.subscribe(changed),
    },
    loadOlder: () => void store.getState().loadOlder(),
    loadNewer: () => void store.getState().loadNewer(),
    jump: key => at(scope => void store.getState().jumpTo(scope, Number(key))),
    toPresent: () => at(scope => void store.getState().jumpToPresent(scope)),
    toUnread: () => void store.getState().jumpToUnread(),
    markRead: lastKey => at(scope => store.getState().markRead(scope, Number(lastKey))),
    dismissUnread: () => at(scope => store.getState().dismissUnread(scope)),
  }
}

const peer = (app: P2pApp, room: string): Messages => {
  const { useP2p, p2pDm } = app
  const shown = (initial: boolean) => {
    const { chat } = initial ? useP2p.getInitialState() : useP2p.getState()
    return chat !== null && chat.room === room ? chat : null
  }
  const state = (initial: boolean) =>
    built(
      () => {
        const chat = shown(initial)
        return [
          chat ? chatScope(chat.room, chat.ch) : null,
          chat?.more === true,
          !!chat?.newer,
          chat?.loading === true,
        ] as const
      },
      ([scope, more, newer, loading]): MessagesState => ({
        scope: scope === null ? null : identityScopeKey(app.localId, scope),
        older: more ? { more, loading: false } : NONE,
        newer: newer ? { more: newer, loading } : NONE,
        pagesOnSight: false,
      })
    )
  const at = (run: (key: string) => void) => {
    const chat = shown(false)
    if (chat) run(chatKey(chat))
  }
  return {
    state: {
      get: state(false),
      initial: state(true),
      subscribe: changed => useP2p.subscribe(changed),
    },
    loadOlder: () => void p2pDm.loadOlderPage(),
    loadNewer: () => void p2pDm.loadNewerPage(),
    jump: key => void p2pDm.jumpTo(key),
    toPresent: () => void p2pDm.toPresent(),
    toUnread: () =>
      void p2pDm.firstUnread().then(first => {
        if (first) void p2pDm.jumpTo(first.id)
      }),
    markRead: () =>
      at(key => {
        if (!shown(false)?.newer) p2pDm.markRead(key)
      }),
    dismissUnread: () => at(key => p2pDm.dismissUnread(key)),
  }
}

// The message list of the conversation a place has on screen.
export const messages = defineFeature<Messages>('messages', {
  hostedServer: place => hosted(place.account),
  p2pRoom: place => peer(place.app, place.room),
  hostedDm: place => hosted(place.account),
  p2pDm: place => peer(place.app, place.room),
})

const own = new WeakMap<AccountSession, Messages>()

// The account's own list, for a pane with no place open.
export const accountMessages = (account: AccountSession): Messages => {
  let known = own.get(account)
  if (!known) {
    known = hosted(account)
    own.set(account, known)
  }
  return known
}
