import type { AccountSession } from '../client/session'
import type { P2pApp } from '../p2p/app/runtime'
import { asMessage, looseNumber } from '../p2p/shown_message'
import { pinPlace } from '../pins'
import { viewKey } from '../view'
import type { Message } from '../types'
import { defineFeature } from './feature'
import { built, type Live } from './live'
import type { P2pList } from './place'

// A pinned message as the list shows it; `key` names it to the place.
export interface Pinned {
  key: string
  message: Message
}

export interface PinsState {
  // Whether the list of the conversation on screen is open.
  open: boolean
  // Null while it loads, or when it could not (`failed`).
  list: Pinned[] | null
  failed: boolean
  place: 'conversation' | 'channel'
  // The server whose member looks and profile cards the authors show; null without one.
  server: string | null
  // Whether authors open a profile card.
  profiles: boolean
}

export interface Pins {
  state: Live<PinsState>
  open: () => void
  close: () => void
  // Closes the list and shows the message in the conversation.
  jump: (key: string) => void
  // Shows a pinned message from the line that announced it.
  show: (key: string) => void
  // Asks, then unpins.
  unpin: (key: string) => void
}

const confirmUnpin = (account: AccountSession, unpin: () => void) =>
  account.store.getState().askConfirm({
    title: 'Unpin Message',
    body: 'Remove this message from the pinned messages?',
    confirm: 'Unpin',
    action: unpin,
  })

const hosted = (account: AccountSession): Pins => {
  const { store } = account
  const scope = () => {
    const { view } = store.getState()
    return view ? viewKey(view) : null
  }
  const state = (initial: boolean) =>
    built(
      () => {
        const s = initial ? store.getInitialState() : store.getState()
        return [s.pins, s.view] as const
      },
      ([pins, view]): PinsState => {
        const key = view ? viewKey(view) : null
        const shown = pins !== null && pins.key === key ? pins : null
        return {
          open: shown !== null,
          list: shown?.list?.map(m => ({ key: String(m.id), message: m })) ?? null,
          failed: shown?.failed ?? false,
          place: pinPlace(key ?? ''),
          server: view?.kind === 'channel' ? view.server : null,
          profiles: true,
        }
      }
    )
  return {
    state: {
      get: state(false),
      initial: state(true),
      subscribe: changed => store.subscribe(changed),
    },
    open: () => store.getState().openPins(),
    close: () => store.getState().closePins(),
    jump: key => {
      const at = scope()
      store.getState().closePins()
      if (at) void store.getState().jumpTo(at, Number(key))
    },
    show: key => {
      const at = scope()
      if (at) void store.getState().openPinned(at, Number(key))
    },
    unpin: key => confirmUnpin(account, () => void store.getState().unpinMessage(Number(key))),
  }
}

const peer = (
  app: P2pApp,
  place: 'conversation' | 'channel',
  list: P2pList | null,
  fallback: P2pList['user']
): Pins => {
  const { useP2p, p2pDm } = app
  const user = list?.user ?? fallback
  const state = (initial: boolean) =>
    built(
      () => {
        const s = initial ? useP2p.getInitialState() : useP2p.getState()
        return [s.pins, s.chat?.room ?? null, s.me] as const
      },
      ([pins, room, me]): PinsState => {
        const shown = pins !== null && pins.room === room ? pins : null
        return {
          open: shown !== null,
          list:
            shown?.list?.map(p => ({
              key: p.id,
              message: asMessage(p, looseNumber(p), 0, user, me ?? ''),
            })) ?? null,
          failed: false,
          place,
          server: null,
          profiles: false,
        }
      }
    )
  return {
    state: {
      get: state(false),
      initial: state(true),
      subscribe: changed => useP2p.subscribe(changed),
    },
    open: () => void p2pDm.openPins(),
    close: () => p2pDm.closePins(),
    jump: key => {
      p2pDm.closePins()
      void p2pDm.jumpTo(key)
    },
    show: key => void p2pDm.jumpTo(key),
    unpin: key => confirmUnpin(app.owner, () => void p2pDm.pin(key, false)),
  }
}

// The pinned messages of the conversation a place has on screen.
export const pins = defineFeature<Pins>('pins', {
  hostedServer: place => hosted(place.account),
  p2pRoom: place =>
    peer(place.app, 'channel', place.list, ik => place.app.memberUser(place.room, ik)),
  hostedDm: place => hosted(place.account),
  p2pDm: place => peer(place.app, 'conversation', place.list, ik => place.app.p2pUser(ik)),
})
