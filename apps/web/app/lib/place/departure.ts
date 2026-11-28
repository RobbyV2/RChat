import type { AccountSession } from '../client/session'
import type { P2pApp } from '../p2p/app/runtime'
import { defineFeature, notInDms } from './feature'
import { built, type Live } from './live'

// What the end of a server's settings offers: leaving it, removing what is left of it from this
// device, or deleting it for everyone.
export type DepartureKind = 'leave' | 'forget' | 'delete'

export interface DepartureState {
  // Null while the place is not here.
  kind: DepartureKind | null
  // What the section says above its button.
  line: string
  // What the place is called, for the question.
  name: string
}

export interface Departure {
  state: Live<DepartureState>
  // Asks, then does what `kind` says.
  go: () => void
}

const WAITING: DepartureState = { kind: null, line: '', name: '' }

const DELETE_LINE =
  'Deletes the server with all of its channels and messages for everyone. This cannot be undone.'
const OWNER_LEAVE_LINE =
  'You own this server. If you leave, nobody can rename it, change channels or ban people any more.'
const LEAVE_LINE = 'Someone who can invite has to let you in again.'
const FORGET_LINE =
  "You aren't a member any more. What you have of it stays on this device until you remove it."

const hosted = (account: AccountSession, server: string): Departure => {
  const { store } = account
  const state = (initial: boolean) =>
    built(
      () => [(initial ? store.getInitialState() : store.getState()).servers[server]] as const,
      ([detail]): DepartureState =>
        detail === undefined
          ? WAITING
          : { kind: 'delete', line: DELETE_LINE, name: detail.display_name }
    )
  return {
    state: {
      get: state(false),
      initial: state(true),
      subscribe: changed => store.subscribe(changed),
    },
    go: () => {
      const s = store.getState()
      s.askConfirm({
        title: 'Delete Server',
        body: 'Delete this server for everyone? All of its channels and messages are deleted. This cannot be undone.',
        confirm: 'Delete',
        action: () => {
          store.getState().closeDialog()
          void store.getState().deleteServer(server)
        },
      })
    },
  }
}

const peer = (app: P2pApp, room: string): Departure => {
  const { useP2p, p2pServer, p2p } = app
  const state = (initial: boolean) =>
    built(
      () => {
        const s = initial ? useP2p.getInitialState() : useP2p.getState()
        return [s.servers[room], s.me] as const
      },
      ([v, me]): DepartureState => {
        if (!v) return WAITING
        const inside = v.me === 'join' || v.me === 'invite'
        return inside
          ? { kind: 'leave', line: v.owner === me ? OWNER_LEAVE_LINE : LEAVE_LINE, name: v.name }
          : { kind: 'forget', line: FORGET_LINE, name: v.name }
      }
    )
  const get = state(false)
  return {
    state: {
      get,
      initial: state(true),
      subscribe: changed => useP2p.subscribe(changed),
    },
    go: () => {
      const { kind, name } = get()
      const ask = app.owner.store.getState().askConfirm
      if (kind === 'leave')
        ask({
          title: 'Leave Server',
          body: `Leave ${name}?`,
          confirm: 'Leave',
          action: () => void p2pServer.leave(room),
        })
      else if (kind === 'forget')
        ask({
          title: 'Remove Server',
          body: `Remove ${name} and everything of it from this device?`,
          confirm: 'Remove',
          action: () => {
            p2p.closeDialog()
            void p2pServer.forget(room)
          },
        })
    },
  }
}

// Leaving a server or a room, or deleting it, from the end of its settings.
export const departure = defineFeature<Departure>('departure', {
  hostedServer: place => hosted(place.account, place.server),
  p2pRoom: place => peer(place.app, place.room),
  hostedDm: () => notInDms(),
  p2pDm: () => notInDms(),
})
