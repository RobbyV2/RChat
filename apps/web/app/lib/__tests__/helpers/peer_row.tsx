import { MessageRow, type RowHandlers } from '../../../components/message_row'
import { CanFetchContext, rowOf, type RowRules } from '../../../components/p2p/p2p_chat'
import type { P2pApp } from '../../p2p/app/runtime'
import type { P2pMessage } from '../../p2p/dm'
import { CAN_ALL } from '../../channel_perms'
import { P2pDm } from '../../place/place'
import { PlaceProvider } from '../../place/react'
import { shownOf } from '../../place/shown'
import type { Message } from '../../types'
import { seedPeer } from './peer_place'

export const NO_HANDLERS: RowHandlers = {
  menu: () => {},
  jump: () => {},
  edit: () => {},
  reply: () => {},
  forward: () => {},
  thread: () => {},
  remove: () => {},
}

// A stored P2P message as the conversation that holds it draws it, under `rules` (everything
// allowed unless said).
export function PeerRow({
  app,
  p,
  m,
  first = true,
  last = true,
  rules = {},
}: {
  app: P2pApp
  p: P2pMessage
  m: Message
  first?: boolean
  last?: boolean
  rules?: Partial<RowRules>
}) {
  const all: RowRules = {
    me: null,
    canAct: true,
    timedOut: false,
    held: CAN_ALL,
    threads: false,
    pendingTip: '',
    mayDelete: () => false,
    ...rules,
  }
  seedPeer(app, {
    me: all.me,
    chat: {
      room: 'dm',
      peer: '',
      messages: [p],
      more: false,
      loading: false,
      readSeq: 0,
      missed: [],
    },
  })
  const place = P2pDm.open(app, 'dm')
  const id = shownOf(place).get().num.get(p.id) ?? m.id
  return (
    <PlaceProvider place={place}>
      <CanFetchContext.Provider value={all.canAct}>
        <MessageRow
          m={{ ...m, id }}
          first={first}
          last={last}
          divider={false}
          flash={false}
          editing={false}
          {...rowOf(p, all, app)}
          on={NO_HANDLERS}
        />
      </CanFetchContext.Provider>
    </PlaceProvider>
  )
}
