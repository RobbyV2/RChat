import { MessageRow, type RowHandlers } from '../../../components/message_row'
import { CanFetchContext, RowFiles } from '../../../components/p2p/p2p_chat'
import type { P2pApp } from '../../p2p/app/runtime'
import type { P2pMessage } from '../../p2p/dm'
import { P2pDm } from '../../place/place'
import { PlaceProvider } from '../../place/react'
import { shownOf } from '../../place/shown'
import { rowsAt } from '../../place/use_rows'
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

// A stored P2P message as the conversation with a mutual contact draws it, for the identity `me`.
export function PeerRow({
  app,
  p,
  m,
  first = true,
  last = true,
  me = null,
  timedOut = false,
}: {
  app: P2pApp
  p: P2pMessage
  m: Message
  first?: boolean
  last?: boolean
  me?: string | null
  timedOut?: boolean
}) {
  seedPeer(app, {
    me,
    contacts: [{ ik: 'them', name: 'them', state: 'mutual' }] as never,
    chat: {
      room: 'dm',
      peer: 'them',
      messages: [p],
      more: false,
      loading: false,
      readSeq: 0,
      missed: [],
    },
  })
  const place = P2pDm.open(app, 'dm')
  const row = { ...m, id: shownOf(place).get().num.get(p.id) ?? m.id }
  const flags = rowsAt(place, 'main')
  return (
    <PlaceProvider place={place}>
      <CanFetchContext.Provider value>
        <MessageRow
          m={row}
          first={first}
          last={last}
          divider={false}
          flash={false}
          editing={false}
          {...flags.get().of(row, { timedOut })}
          Files={RowFiles}
          on={NO_HANDLERS}
        />
      </CanFetchContext.Provider>
    </PlaceProvider>
  )
}
